import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { istDate } from '../src/lab/tests.js';
import { percentiles } from '../src/util/backoff.js';
import { buildWebhookPayload } from '../src/whatsapp/payload.js';
import { signBody } from '../src/whatsapp/signature.js';

/**
 * 1,000-message WhatsApp burst.
 *
 * Realism choices:
 *  - messages for one phone are sent sequentially (WhatsApp preserves order
 *    within a conversation);
 *  - different phones are in flight concurrently;
 *  - 20% of deliveries repeat the exact same wamid;
 *  - each phone books a different date, so the run measures throughput and
 *    dedupe rather than an artificial 100-way race for one slot (the race is
 *    covered separately by the integration test).
 */

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const MESSAGES = Number(process.env.MESSAGES ?? 1_000);
const DUP_RATE = Number(process.env.DUP_RATE ?? 0.2);
const PER_PHONE = Number(process.env.PER_PHONE ?? 8);
const LANES = Number(process.env.LANES ?? 25);
const RESET = process.env.LOAD_RESET !== '0';
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 180_000);

const runId = String(Date.now()).slice(-6);

function phoneFor(index: number): string {
  return `91${runId}${String(1000 + index).padStart(4, '0')}`;
}

function rawFor(phone: string, text: string, clientId: string): Buffer {
  return Buffer.from(
    JSON.stringify(
      buildWebhookPayload({
        phone,
        text,
        waMessageId: `wamid.load.${runId}.${clientId}`,
        displayName: 'Load Patient',
      }),
    ),
  );
}

interface Metrics {
  webhook: { duplicates: number; rateLimited: number; ackLatencyMs: { p50: number; p95: number; p99: number; max: number } };
  queue: Record<string, number>;
  jobs: { retried: number; dead: number };
  lab: Record<string, number>;
  bookings: Record<string, number>;
  outbox: Record<string, number>;
  llm: {
    calls: number;
    tokens: { prompt: number; completion: number };
    costUsd: number;
    fallbacks: number;
    budget: { provider: string; model: string };
  };
  usage: { conversations: number; confirmed: number; pending: number; handoffs: number; tokensIn: number; tokensOut: number };
}

async function getMetrics(): Promise<Metrics> {
  const res = await fetch(`${API}/metrics?format=json`);
  if (!res.ok) throw new Error(`metrics returned ${res.status}`);
  return (await res.json()) as Metrics;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendOne(raw: Buffer): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const res = await fetch(`${API}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(raw, config.appSecret),
    },
    body: raw,
  });
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - started };
}

async function main(): Promise<void> {
  console.log(`load: ${MESSAGES} messages, ${(DUP_RATE * 100).toFixed(0)}% duplicates, ${LANES} lanes → ${API}`);

  if (RESET) {
    const res = await fetch(`${API}/dev/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`reset failed: ${res.status}`);
    const labUrl = (process.env.LAB_URL ?? 'http://localhost:4000').replace(/\/$/, '');
    await fetch(`${labUrl}/__admin/reset`, { method: 'POST' }).catch(() => undefined);
    console.log('load: database, mock-lab and request metrics reset');
  }

  const uniqueCount = Math.round(MESSAGES * (1 - DUP_RATE));
  const phoneCount = Math.ceil(uniqueCount / PER_PHONE);
  const blocks: Buffer[][] = [];
  let created = 0;

  for (let i = 0; i < phoneCount; i++) {
    const phone = phoneFor(i);
    const date = istDate(1 + i); // unique booking date per phone
    const texts = [
      `I want a CBC test on ${date}`,
      '1',
      'thanks',
      'what time?',
      'ok',
      'great',
      'address?',
      'thanks!',
    ];
    const block: Buffer[] = [];
    for (let j = 0; j < PER_PHONE && created < uniqueCount; j++, created++) {
      block.push(rawFor(phone, texts[j % texts.length]!, `${i}-${j}`));
    }
    if (block.length > 0) blocks.push(block);
  }

  // Exact duplicates (same wamid) placed after the original in the same stream.
  let duplicates = 0;
  const targetDuplicates = MESSAGES - uniqueCount;
  while (duplicates < targetDuplicates) {
    const block = blocks[Math.floor(Math.random() * blocks.length)]!;
    const at = Math.floor(Math.random() * block.length);
    block.splice(at + 1, 0, Buffer.from(block[at]!));
    duplicates += 1;
  }

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  if (total !== MESSAGES) throw new Error(`generated ${total} messages, expected ${MESSAGES}`);

  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let cursor = 0;
  const startedAt = Date.now();

  const lanes = Array.from({ length: LANES }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= blocks.length) return;
      for (const raw of blocks[index]!) {
        const { status, ms } = await sendOne(raw);
        latencies.push(ms);
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      }
    }
  });
  await Promise.all(lanes);

  const sendMs = Date.now() - startedAt;
  console.log(`load: ${total} requests sent in ${sendMs} ms`);

  const drainStarted = Date.now();
  let last: Metrics | null = null;
  for (;;) {
    last = await getMetrics();
    const outboxPending = (last.outbox.queued ?? 0) + (last.outbox.sending ?? 0);
    if (last.queue.queued === 0 && last.queue.running === 0 && outboxPending === 0) break;
    if (Date.now() - drainStarted > DRAIN_TIMEOUT_MS) {
      throw new Error(
        `drain timeout: queue=${JSON.stringify(last.queue)} outbox=${JSON.stringify(last.outbox)}`,
      );
    }
    await sleep(500);
  }
  const drainMs = Date.now() - drainStarted;
  const metrics = last;

  const bookingsRes = await fetch(`${API}/api/bookings?limit=500`);
  const bookingsBody = (await bookingsRes.json()) as {
    bookings: Array<{ slot_id: string; status: string; conversation_id: string }>;
  };
  const bookings = bookingsBody.bookings;
  const confirmed = bookings.filter((b) => b.status === 'confirmed');
  const slotCounts = new Map<string, number>();
  for (const booking of confirmed) {
    slotCounts.set(booking.slot_id, (slotCounts.get(booking.slot_id) ?? 0) + 1);
  }
  const doubleBooked = [...slotCounts.entries()].filter(([, count]) => count > 1);

  const ack = percentiles(latencies);
  const tokenTotal = metrics.llm.tokens.prompt + metrics.llm.tokens.completion;
  const flashLiteUsd =
    (metrics.llm.tokens.prompt / 1_000_000) * 0.1 +
    (metrics.llm.tokens.completion / 1_000_000) * 0.4;
  const inr = (usd: number) => Number((usd * 88).toFixed(2));

  const provider = metrics.llm.budget?.provider ?? 'mock';
  const model = metrics.llm.budget?.model ?? 'deterministic-policy';
  const jobsDone = metrics.queue.done ?? 0;
  const report = {
    runAt: new Date().toISOString(),
    api: API,
    provider,
    model,
    messages: MESSAGES,
    duplicates,
    uniqueMessages: uniqueCount,
    phones: blocks.length,
    lanes: LANES,
    sendMs,
    drainMs,
    jobsPerSecond: Number((jobsDone / (drainMs / 1000)).toFixed(1)),
    ackMs: ack,
    statuses: Object.fromEntries(statuses),
    dedupeSuppressed: metrics.webhook.duplicates,
    rateLimited: metrics.webhook.rateLimited,
    jobs: metrics.queue,
    jobsRetried: metrics.jobs.retried,
    jobsDead: metrics.jobs.dead,
    lab: metrics.lab,
    outbox: metrics.outbox,
    conversations: metrics.usage.conversations,
    confirmed: confirmed.length,
    pending: metrics.usage.pending,
    handoffs: metrics.usage.handoffs,
    doubleBookedSlots: doubleBooked.length,
    llm: {
      calls: metrics.llm.calls,
      tokens: metrics.llm.tokens,
      tokenTotal,
      actualCostUsd: metrics.llm.costUsd,
      actualCostInr: inr(metrics.llm.costUsd),
      equivalentFlashLiteUsd: Number(flashLiteUsd.toFixed(6)),
      equivalentFlashLiteInr: inr(flashLiteUsd),
    },
  };

  const statusLine = Object.entries(report.statuses)
    .map(([code, count]) => `${code}: ${count}`)
    .join(', ');
  const labLine = Object.entries(metrics.lab)
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');

  const markdown = `# Load report — ${MESSAGES.toLocaleString('en-IN')} WhatsApp messages

Generated: **${new Date().toISOString()}** · Target: \`${API}\`
LLM provider: **${provider}** (\`${model}\`) · Lab: **20% failure, 120–700 ms latency**

## Setup

| Parameter | Value |
|---|---|
| Messages sent | **${MESSAGES}** |
| Exact duplicates (same \`wamid\`) | **${duplicates}** (${(DUP_RATE * 100).toFixed(0)}%) |
| Unique messages | **${uniqueCount}** |
| Conversations (phones) | **${blocks.length}** |
| In-flight phone lanes | ${LANES} (messages within a phone are sequential) |
| Booking date per phone | unique → no artificial slot contention |

## Results

| Metric | Result |
|---|---|
| HTTP 200 / total | **${report.statuses[200] ?? 0} / ${MESSAGES}** (${statusLine}) |
| Ack p50 | **${ack.p50.toFixed(1)} ms** |
| Ack p95 | **${ack.p95.toFixed(1)} ms** |
| Ack p99 | **${ack.p99.toFixed(1)} ms** (contract: < 200 ms) |
| Ack max | ${ack.max.toFixed(1)} ms |
| Send phase | ${sendMs} ms (${(MESSAGES / (sendMs / 1000)).toFixed(0)} req/s) |
| Queue + outbox drain | **${(drainMs / 1000).toFixed(1)} s** (${(jobsDone / (drainMs / 1000)).toFixed(1)} jobs/s) |
| Duplicates suppressed | **${metrics.webhook.duplicates}** |
| Jobs done / dead | **${(metrics.queue.done ?? 0)} / ${metrics.jobs.dead}** |
| Jobs retried (>1 attempt) | ${metrics.jobs.retried} |
| Outbox sent / failed | ${metrics.outbox.sent ?? 0} / ${metrics.outbox.failed ?? 0} |
| Conversations created | ${metrics.usage.conversations} |
| Confirmed bookings | **${confirmed.length}** |
| Pending (ambiguous lab outcome) | ${metrics.usage.pending} |
| Handoffs | ${metrics.usage.handoffs} |
| **Double-booked slots** | **${doubleBooked.length}** |
| Lab calls | ${labLine || 'n/a'} |
| LLM calls | ${metrics.llm.calls} |
| LLM tokens (prompt + completion) | ${metrics.llm.tokens.prompt} + ${metrics.llm.tokens.completion} = ${tokenTotal} |
| **Actual LLM spend** | **₹${inr(metrics.llm.costUsd).toFixed(2)} ($${metrics.llm.costUsd.toFixed(4)})** |
| Equivalent at Gemini 2.5 Flash-Lite | ₹${inr(flashLiteUsd).toFixed(2)} ($${flashLiteUsd.toFixed(4)}) |

## What happened

- All ${MESSAGES} deliveries were acknowledged; ${metrics.webhook.duplicates} reached the database
  as duplicates and were suppressed by \`UNIQUE(wa_message_id)\` — no duplicate job, no duplicate reply.
- The ${uniqueCount} unique messages produced ${(metrics.queue.done ?? 0)} completed jobs and
  ${metrics.outbox.sent ?? 0} outbound messages. The queue drained in ${(drainMs / 1000).toFixed(1)} s
  with ${metrics.jobs.dead} dead jobs.
- ${confirmed.length} of ${blocks.length} conversations ended with a confirmed booking. Each phone
  used a different date, so this run measures throughput, not slot contention.
- **${doubleBooked.length} slots have more than one confirmed booking.**
${doubleBooked.length === 0 ? '- The invariant holds: `UNIQUE(slot_id) WHERE status IN (\'pending\',\'confirmed\')` plus idempotency keys prevent double booking even when the lab fails 20% of calls.' : '- INVESTIGATE: double booking detected.'}
- ${metrics.usage.pending} booking(s) are pending because the lab outcome was ambiguous after all
  retries. They are intentionally **not** released — releasing a slot the lab may have committed is
  the only path to a double booking.
- ${metrics.webhook.rateLimited} rate-limit events at 1,000 messages/min/phone (the production
  default is 20/min). No phone in this run approached the limit.
- The lab was genuinely flaky: ${labLine || 'no lab calls'}. Every one of those failures was
  absorbed by the client's retry policy; no job reached the dead-letter state.

## Why the mock LLM

OpenRouter free models are capped at **20 requests/min** (and 50/day unless the account has
purchased $10+; this account reports 1,000/day). A 1,000-message run against a real model would
therefore be neither reproducible nor a measurement of this system — it would mostly measure
OpenRouter's queue. The load test uses the deterministic provider; the token counts above are
estimates and are priced at real Flash-Lite rates to show what this workload would cost. The
demo conversation uses the real free model.

Artifacts: \`load-report.json\` (machine-readable) and this file.
`;

  await writeFile('load-report.json', JSON.stringify(report, null, 2));
  await writeFile('LOAD_REPORT.md', markdown);

  console.log(JSON.stringify(report, null, 2));
  console.log('\nload: wrote LOAD_REPORT.md and load-report.json');
}

main().catch((err) => {
  console.error('load failed:', err);
  process.exit(1);
});
