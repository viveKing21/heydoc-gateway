import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildLabApp } from '../../mock-lab/server.js';
import { Agent } from '../../src/agent/agent.js';
import { BookingService } from '../../src/booking/service.js';
import { config } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { pool } from '../../src/db/pool.js';
import { ingestInbound, reapExpiredJobs } from '../../src/db/repo.js';
import { istDate } from '../../src/lab/tests.js';
import { LabClient } from '../../src/lab/client.js';
import { MockLlmClient } from '../../src/llm/mock.js';
import { percentiles } from '../../src/util/backoff.js';
import { buildWebhookPayload } from '../../src/whatsapp/payload.js';
import { signBody } from '../../src/whatsapp/signature.js';
import { WhatsAppSender } from '../../src/whatsapp/sender.js';
import { WorkerRuntime } from '../../src/worker/runtime.js';
import { buildApp } from '../../src/http/app.js';

let api: FastifyInstance;
let lab: FastifyInstance;
let labUrl: string;
let worker: WorkerRuntime;
let labClient: LabClient;
let booking: BookingService;

let phoneSeq = 0;
const runId = String(Date.now()).slice(-6);

function nextPhone(): string {
  phoneSeq += 1;
  return `91${runId}${String(phoneSeq).padStart(4, '0')}`;
}

function rawPayload(phone: string, text: string, clientId: string): Buffer {
  return Buffer.from(
    JSON.stringify(
      buildWebhookPayload({
        phone,
        text,
        waMessageId: `wamid.it.${runId}.${clientId}`,
        displayName: 'Test Patient',
      }),
    ),
  );
}

async function postRaw(raw: Buffer) {
  return api.inject({
    method: 'POST',
    url: '/webhook',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(raw, config.appSecret),
    },
  });
}

async function postMessage(phone: string, text: string, clientId: string) {
  return postRaw(rawPayload(phone, text, clientId));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

async function jobCountForPhone(phone: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs j JOIN conversations c ON c.id=j.conversation_id
     WHERE c.phone=$1`,
    [phone],
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE outbox, handoffs, llm_usage, lab_calls, bookings, messages, jobs,
     inbound_messages, rate_limits, conversations RESTART IDENTITY CASCADE`,
  );

  lab = buildLabApp({ failRate: 0, failMode: 'none', minLatencyMs: 0, maxLatencyMs: 0 });
  await lab.listen({ port: 0, host: '127.0.0.1' });
  const address = lab.server.address() as AddressInfo;
  labUrl = `http://127.0.0.1:${address.port}`;

  api = await buildApp();
  labClient = new LabClient({
    baseUrl: labUrl,
    timeoutMs: 1_000,
    slotsTimeoutMs: 1_000,
    maxAttempts: 3,
    backoffBaseMs: 5,
  });
  booking = new BookingService(labClient);
  const agent = new Agent({
    llm: new MockLlmClient(),
    fallback: new MockLlmClient(),
    lab: labClient,
    booking,
  });
  worker = new WorkerRuntime(
    { agent, sender: new WhatsAppSender() },
    { concurrency: 6, pollIntervalMs: 20, outboxPollIntervalMs: 20 },
  );
  worker.start();
});

afterAll(async () => {
  await worker.stop();
  await api.close();
  await lab.close();
  await pool.end();
});

describe('webhook ingest', () => {
  it('acks a concurrent duplicate pair once and enqueues one job', async () => {
    const phone = nextPhone();
    const raw = rawPayload(phone, 'I want a CBC test', 'dedupe-1');

    const [first, second] = await Promise.all([postRaw(raw), postRaw(raw)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const inbound = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM inbound_messages WHERE phone=$1',
      [phone],
    );
    expect(Number(inbound.rows[0]?.n)).toBe(1);
    expect(await jobCountForPhone(phone)).toBe(1);

    await waitFor(async () => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE to_phone=$1 AND status='sent'`,
        [phone],
      );
      return Number(rows[0]?.n) === 1;
    });

    const metrics = await api.inject({ method: 'GET', url: '/metrics?format=json' });
    const body = metrics.json() as { webhook: { duplicates: number } };
    expect(body.webhook.duplicates).toBeGreaterThanOrEqual(1);

    const conversation = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE phone=$1`,
      [phone],
    );
    expect(Number(conversation.rows[0]?.n)).toBe(1);
  });

  it('enforces the per-phone rate limit without dropping the inbound row', async () => {
    const phone = nextPhone();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await ingestInbound(
          {
            waMessageId: `wamid.rl.${runId}.${i}`,
            phone,
            type: 'text',
            text: 'hello',
            raw: {},
          },
          2,
        ),
      );
    }
    expect(results.map((r) => r.duplicate)).toEqual([false, false, false]);
    expect(results.map((r) => r.rateLimited)).toEqual([false, false, true]);
    expect(await jobCountForPhone(phone)).toBe(2);

    const inbound = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM inbound_messages WHERE phone=$1',
      [phone],
    );
    expect(Number(inbound.rows[0]?.n)).toBe(3);
  });

  it('rejects a bad signature and a malformed payload', async () => {
    const raw = rawPayload(nextPhone(), 'hello', 'sig');
    const bad = await api.inject({
      method: 'POST',
      url: '/webhook',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    });
    expect(bad.statusCode).toBe(401);

    const malformed = Buffer.from('{"not":"an envelope"}');
    const res = await postRaw(malformed);
    expect(res.statusCode).toBe(400);
  });
});

describe('1,000-message burst', () => {
  it('acks under 200 ms, dedupes exactly, drains the queue and never double-books', async () => {
    const PHONES = 100;
    const PER_PHONE = 8;
    const DUPLICATES = 200;

    const phones = Array.from({ length: PHONES }, (_, i) =>
      `91${runId}${String(1000 + i).padStart(4, '0')}`,
    );

    // Per-conversation order is preserved, like WhatsApp delivery; different
    // phones are interleaved. Shuffling *within* a phone would make "1" arrive
    // before the slot list and is not a realistic delivery pattern.
    const blocks: Buffer[][] = [];
    for (let i = 0; i < PHONES; i++) {
      const phone = phones[i]!;
      // Unique booking date per phone → no artificial slot contention.
      const date = istDate(1 + i);
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
      blocks.push(texts.map((text, j) => rawPayload(phone, text, `${i}-${j}`)));
    }

    // 200 exact duplicate deliveries: same body, same wamid, placed right
    // after the original in that phone's stream.
    for (let i = 0; i < DUPLICATES; i++) {
      const phoneIndex = Math.floor(Math.random() * PHONES);
      const block = blocks[phoneIndex]!;
      const at = Math.floor(Math.random() * block.length);
      block.splice(at + 1, 0, Buffer.from(block[at]!));
    }

    const total = blocks.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(1_000);

    const latencies: number[] = [];
    const statuses: number[] = [];
    let cursor = 0;
    // One lane per phone-in-flight, messages sequential within a phone. This
    // matches WhatsApp delivery: different conversations are concurrent, a
    // single conversation arrives in order. Firing a phone's messages in
    // parallel would let "1" overtake the slot list, which is not a realistic
    // client and would test the wrong invariant.
    const lanes = Array.from({ length: 25 }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= blocks.length) return;
        for (const raw of blocks[index]!) {
          const started = Date.now();
          const res = await postRaw(raw);
          latencies.push(Date.now() - started);
          statuses.push(res.statusCode);
        }
      }
    });
    await Promise.all(lanes);

    expect(statuses).toHaveLength(1_000);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const p = percentiles(latencies);
    // The contract is p99 < 200 ms. Print it in the failure message for the report.
    expect(p.p99, `ack p99=${p.p99.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms`).toBeLessThan(200);

    await waitFor(async () => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs j JOIN conversations c ON c.id=j.conversation_id
         WHERE c.phone = ANY($1::text[]) AND j.status IN ('queued','running')`,
        [phones],
      );
      return Number(rows[0]?.n) === 0;
    }, 120_000);

    const jobs = await pool.query<{ status: string; n: number }>(
      `SELECT j.status, count(*)::int AS n FROM jobs j
       JOIN conversations c ON c.id=j.conversation_id
       WHERE c.phone = ANY($1::text[]) GROUP BY j.status`,
      [phones],
    );
    const done = Number(jobs.rows.find((r) => r.status === 'done')?.n ?? 0);
    const dead = Number(jobs.rows.find((r) => r.status === 'dead')?.n ?? 0);
    expect(done).toBe(800);
    expect(dead).toBe(0);

    // Jobs finish before delivery: the outbox is intentionally decoupled.
    await waitFor(async () => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox
         WHERE to_phone = ANY($1::text[]) AND status='sent'`,
        [phones],
      );
      return Number(rows[0]?.n) === 800;
    }, 30_000);

    const outbox = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE to_phone = ANY($1::text[]) AND status='sent'`,
      [phones],
    );
    expect(Number(outbox.rows[0]?.n)).toBe(800);

    const confirmed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings b JOIN conversations c ON c.id=b.conversation_id
       WHERE c.phone = ANY($1::text[]) AND b.status='confirmed'`,
      [phones],
    );
    expect(Number(confirmed.rows[0]?.n)).toBe(100);

    const doubleBooked = await pool.query<{ slot_id: string; n: number }>(
      `SELECT slot_id, count(*)::int AS n FROM bookings
       WHERE status='confirmed' GROUP BY slot_id HAVING count(*) > 1`,
    );
    expect(doubleBooked.rows).toHaveLength(0);

    const metrics = await api.inject({ method: 'GET', url: '/metrics?format=json' });
    const body = metrics.json() as {
      webhook: { duplicates: number; ackLatencyMs: { p99: number } };
      queue: Record<string, number>;
      bookings: Record<string, number>;
      llm: { calls: number; tokens: { prompt: number }; costUsd: number };
      conversations: Array<{ tokensIn: number; costUsd: number }>;
    };
    expect(body.webhook.duplicates).toBeGreaterThanOrEqual(200);
    expect(body.webhook.ackLatencyMs.p99).toBeLessThan(200);
    expect(body.queue.queued).toBe(0);
    expect(body.queue.running).toBe(0);
    expect(body.bookings.confirmed).toBeGreaterThanOrEqual(100);
    expect(body.llm.calls).toBeGreaterThanOrEqual(800);
    expect(body.llm.tokens.prompt).toBeGreaterThan(0);
    expect(body.conversations.some((c) => c.tokensIn > 0)).toBe(true);
  }, 180_000);
});

describe('no double booking', () => {
  it('allows exactly one winner when 10 conversations race for one slot', async () => {
    const slotId = `race-${runId}-0900`;
    const conversationIds = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const { rows } = await pool.query<{ id: string }>(
          'INSERT INTO conversations (phone) VALUES ($1) RETURNING id',
          [nextPhone()],
        );
        return rows[0]!.id;
      }),
    );

    const results = await Promise.all(
      conversationIds.map((conversationId) =>
        booking.book({ conversationId, testId: 'cbc', slotId, patientName: 'Race Patient' }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === 'SLOT_TAKEN')).toHaveLength(9);

    const confirmed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings WHERE slot_id=$1 AND status='confirmed'`,
      [slotId],
    );
    expect(Number(confirmed.rows[0]?.n)).toBe(1);

    const labState = (await fetch(`${labUrl}/__admin/state`).then((r) => r.json())) as {
      bookings: Array<{ slot_id: string }>;
    };
    expect(labState.bookings.filter((b) => b.slot_id === slotId)).toHaveLength(1);
  });

  it('recovers a committed booking when the lab response is lost (idempotency key)', async () => {
    const timeoutLab = buildLabApp({
      failRate: 1,
      failMode: 'after_timeout',
      afterTimeoutMs: 400,
      minLatencyMs: 0,
      maxLatencyMs: 0,
    });
    await timeoutLab.listen({ port: 0, host: '127.0.0.1' });
    const address = timeoutLab.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const client = new LabClient({
        baseUrl,
        timeoutMs: 150,
        maxAttempts: 2,
        backoffBaseMs: 5,
      });
      const service = new BookingService(client);
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO conversations (phone) VALUES ($1) RETURNING id',
        [nextPhone()],
      );
      const conversationId = rows[0]!.id;
      const slotId = `timeout-${runId}-1000`;

      const result = await service.book({ conversationId, testId: 'cbc', slotId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');

      const state = (await fetch(`${baseUrl}/__admin/state`).then((r) => r.json())) as {
        bookings: Array<{ slot_id: string }>;
        counters: { afterCommitFailures: number };
      };
      expect(state.bookings.filter((b) => b.slot_id === slotId)).toHaveLength(1);
      expect(state.counters.afterCommitFailures).toBeGreaterThanOrEqual(1);

      const db = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings WHERE slot_id=$1 AND status='confirmed'`,
        [slotId],
      );
      expect(Number(db.rows[0]?.n)).toBe(1);
    } finally {
      await timeoutLab.close();
    }
  });

  it('keeps the reservation when the lab is unreachable, and reuses the same row', async () => {
    const deadClient = new LabClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 100,
      maxAttempts: 1,
    });
    const service = new BookingService(deadClient);
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO conversations (phone) VALUES ($1) RETURNING id',
      [nextPhone()],
    );
    const conversationId = rows[0]!.id;
    const slotId = `dead-${runId}-1100`;

    const first = await service.book({ conversationId, testId: 'cbc', slotId });
    const second = await service.book({ conversationId, testId: 'cbc', slotId });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('LAB_UNAVAILABLE');

    const db = await pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM bookings WHERE slot_id=$1 GROUP BY status`,
      [slotId],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.status).toBe('pending');
    expect(Number(db.rows[0]?.n)).toBe(1);
  });
});

describe('worker failure handling', () => {
  it('requeues a job whose worker lease expired', async () => {
    const { rows: convRows } = await pool.query<{ id: string }>(
      'INSERT INTO conversations (phone) VALUES ($1) RETURNING id',
      [nextPhone()],
    );
    const conversationId = convRows[0]!.id;
    const { rows: jobRows } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (conversation_id, status, attempts, max_attempts, locked_by, locked_at, payload)
       VALUES ($1, 'running', 1, 3, 'dead-worker', now() - interval '10 seconds', '{}'::jsonb)
       RETURNING id`,
      [conversationId],
    );
    const jobId = jobRows[0]!.id;

    const requeued = await reapExpiredJobs(1);
    expect(requeued.some((j) => j.id === jobId && j.status === 'queued')).toBe(true);

    await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [
        jobId,
      ]);
      return rows[0]?.status === 'done';
    });
  });

  it('acks and hides dev endpoints when DEV_MODE is true (test config)', async () => {
    const res = await api.inject({ method: 'GET', url: '/dev/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { provider: string; mockWhatsApp: boolean };
    expect(body.provider).toBe('mock');
    expect(body.mockWhatsApp).toBe(true);
  });
});
