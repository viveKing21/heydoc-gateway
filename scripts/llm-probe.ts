import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';

/**
 * One-shot capability probe for free OpenRouter models.
 *
 * Costs nothing but counts against the free-tier quota (20 req/min,
 * 50 req/day without a $10 lifetime top-up). It makes one tool-call request
 * per candidate and reports which models actually emit a valid tool call.
 */

const key = config.llm.apiKey;
if (!key) {
  console.log('OPENROUTER_API_KEY is empty — skipping probe. The app runs on the mock provider.');
  process.exit(0);
}

const base = config.llm.baseUrl.replace(/\/$/, '');
const candidates = [
  ...new Set(
    (process.env.LLM_PROBE_MODELS
      ? process.env.LLM_PROBE_MODELS.split(',')
      : [
          config.llm.model,
          'inclusionai/ling-3.2-flash:free',
          'google/gemma-4-31b-it:free',
        ]
    )
      .map((m) => m.trim())
      .filter(Boolean),
  ),
];

const tool = {
  type: 'function',
  function: {
    name: 'check_slots',
    description: 'List available lab slots for a test.',
    parameters: {
      type: 'object',
      properties: { test_id: { type: 'string' } },
      required: ['test_id'],
    },
  },
};

interface ProbeResult {
  model: string;
  status: number;
  latencyMs: number;
  toolCall: string | null;
  args: unknown;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
}

async function keyInfo(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${base}/key`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Record<string, unknown> };
    return body.data ?? null;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function probe(model: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/viveKing21/heydoc-gateway',
        'x-title': 'HeyDoc WhatsApp Gateway',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: "I'd like to book a CBC test tomorrow. Check which slots are free.",
          },
        ],
        tools: [tool],
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 200,
      }),
    });
    clearTimeout(timer);
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    return {
      model,
      status: res.status,
      latencyMs: Date.now() - started,
      toolCall: call?.function?.name ?? null,
      args: call?.function?.arguments ? safeParse(call.function.arguments) : null,
      promptTokens: Number(data.usage?.prompt_tokens ?? 0),
      completionTokens: Number(data.usage?.completion_tokens ?? 0),
      error: res.ok ? (data.error?.message ?? null) : (data.error?.message ?? `HTTP ${res.status}`),
    };
  } catch (err) {
    return {
      model,
      status: 0,
      latencyMs: Date.now() - started,
      toolCall: null,
      args: null,
      promptTokens: 0,
      completionTokens: 0,
      error: (err as Error).message,
    };
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const info = await keyInfo();
const quota = info?.['free_model_daily_requests'] as
  | { used?: number; limit?: number; remaining?: number }
  | undefined;

console.log('OpenRouter key quota:', JSON.stringify({ quota, isFreeTier: info?.is_free_tier }, null, 2));

const results: ProbeResult[] = [];
for (const model of candidates) {
  process.stdout.write(`probing ${model} ... `);
  const result = await probe(model);
  results.push(result);
  console.log(
    `${result.status} · ${result.latencyMs} ms · tool=${result.toolCall ?? 'none'}${result.error ? ` · ${result.error}` : ''}`,
  );
}

const passing = results.filter((r) => r.toolCall === 'check_slots');
const selected = passing[0]?.model ?? null;

const lines = [
  '# LLM probe — OpenRouter free models',
  '',
  `Run: **${new Date().toISOString()}**`,
  `Free-tier quota before probe: ${quota ? `${quota.used ?? '?'}/${quota.limit ?? '?'} used, ${quota.remaining ?? '?'} remaining` : 'unavailable'}`,
  '',
  'One request per model, asking it to call `check_slots`.',
  '',
  '| Model | HTTP | Latency | Tool call | Args | Tokens (in/out) |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| \`${r.model}\` | ${r.status} | ${r.latencyMs} ms | ${r.toolCall ?? '—'} | \`${JSON.stringify(r.args)}\` | ${r.promptTokens}/${r.completionTokens} |`,
  ),
  '',
  selected
    ? `**Selected:** \`${selected}\` — the first model that emitted a valid tool call.`
    : '**No candidate emitted a tool call.** Set `LLM_PROVIDER=mock`; the deterministic policy handles the flow.',
  '',
  'Note: free-tier limits are 20 requests/minute and 50 requests/day without a $10 lifetime top-up.',
  '',
];

await writeFile('LLM_PROBE.md', lines.join('\n'));
console.log(`\nprobe: wrote LLM_PROBE.md (selected: ${selected ?? 'none'})`);
