import { config } from '../config.js';
import { llmBudget } from '../llm/budget.js';
import {
  bookingsByStatus,
  dailyLlmTotals,
  jobStats,
  labCalls24h,
  llmUsage24h,
  metricsConversations,
  outboxByStatus,
  queueDepth,
  usageTotals,
} from '../db/repo.js';
import {
  metricBreakdown,
  metricTotal,
  metrics,
  prometheusJson,
  type PromMetric,
} from './registry.js';

export interface LabCallCount {
  op: string;
  outcome: string;
  count: number;
}

export interface DbGauges {
  queue: Record<string, number>;
  usage: Awaited<ReturnType<typeof usageTotals>>;
  conversations: Awaited<ReturnType<typeof metricsConversations>>;
  bookings: Record<string, number>;
  labCalls: LabCallCount[];
  llm: Awaited<ReturnType<typeof llmUsage24h>>;
  jobs: Awaited<ReturnType<typeof jobStats>>;
  outbox: Record<string, number>;
}

/**
 * Refresh every DB-backed gauge. Called on scrape, so a restarted API replica
 * reports the same numbers as the worker that actually did the work.
 */
export async function refreshDbGauges(): Promise<DbGauges> {
  const [queue, usage, conversations, bookings, labCalls, llm, jobs, outbox] = await Promise.all([
    queueDepth(),
    usageTotals(),
    metricsConversations(500),
    bookingsByStatus(),
    labCalls24h(),
    llmUsage24h(),
    jobStats(),
    outboxByStatus(),
  ]);

  metrics.queueDepth.reset();
  for (const [status, count] of Object.entries(queue)) {
    metrics.queueDepth.set({ status }, count);
  }

  metrics.bookingsState.reset();
  for (const [status, count] of Object.entries(bookings)) {
    metrics.bookingsState.set({ status }, count);
  }

  metrics.labCalls24h.reset();
  for (const call of labCalls) {
    metrics.labCalls24h.set({ op: call.op, outcome: call.outcome }, call.count);
  }

  metrics.llmCalls24h.set(llm.calls);
  metrics.llmFallbacks24h.set(llm.fallbacks);
  metrics.llmTokens24h.set({ kind: 'prompt' }, llm.prompt);
  metrics.llmTokens24h.set({ kind: 'completion' }, llm.completion);
  metrics.llmCostUsd24h.set(llm.costUsd);
  metrics.jobsRetried24h.set(jobs.retried);

  metrics.outboxState.reset();
  for (const [status, count] of Object.entries(outbox)) {
    metrics.outboxState.set({ status }, count);
  }

  metrics.conversationTokens.reset();
  metrics.conversationCost.reset();
  for (const c of conversations) {
    const labels = { conversation: c.id.slice(0, 8), phone: c.phone };
    metrics.conversationTokens.set({ ...labels, kind: 'in' }, c.tokens_in);
    metrics.conversationTokens.set({ ...labels, kind: 'out' }, c.tokens_out);
    metrics.conversationCost.set(labels, c.cost_usd);
  }

  metrics.stateConversations.set(usage.conversations);
  metrics.stateConfirmedBookings.set(usage.confirmed);
  metrics.statePendingBookings.set(usage.pending);
  metrics.stateHandoffs.set(usage.handoffs);

  return { queue, usage, conversations, bookings, labCalls, llm, jobs, outbox };
}

export async function metricsSnapshot(): Promise<Record<string, unknown>> {
  const gauges = await refreshDbGauges();
  const prom: PromMetric[] = await prometheusJson();
  const dailyLlm = await dailyLlmTotals();

  const lab: Record<string, number> = {};
  for (const call of gauges.labCalls) {
    lab[`${call.op}:${call.outcome}`] = call.count;
  }
  const labRetries = gauges.labCalls
    .filter((c) => c.outcome === 'retry')
    .reduce((sum, c) => sum + c.count, 0);

  return {
    generatedAt: new Date().toISOString(),
    webhook: {
      requests: metricBreakdown(prom, 'gateway_webhook_requests_total', ['status']),
      duplicates: metricTotal(prom, 'gateway_duplicate_messages_total'),
      rateLimited: metricTotal(prom, 'gateway_rate_limited_total'),
      ackLatencyMs: metrics.ackLatency.snapshot(),
    },
    queue: gauges.queue,
    jobs: { retried: gauges.jobs.retried, dead: gauges.jobs.dead },
    lab,
    labRetries,
    bookings: gauges.bookings,
    outbox: gauges.outbox,
    llm: {
      calls: gauges.llm.calls,
      fallbacks: gauges.llm.fallbacks,
      tokens: { prompt: gauges.llm.prompt, completion: gauges.llm.completion },
      costUsd: Number(gauges.llm.costUsd.toFixed(6)),
      budget: {
        ...llmBudget.state(),
        // DB is authoritative across API/worker processes; the in-process
        // counter only enforces the cap for this worker.
        calls: dailyLlm.calls,
        costUsd: Number(dailyLlm.costUsd.toFixed(6)),
        provider: config.llm.provider,
        model: config.llm.provider === 'mock' ? 'deterministic-policy' : config.llm.model,
      },
    },
    usage: gauges.usage,
    conversations: gauges.conversations.map((c) => ({
      id: c.id,
      phone: c.phone,
      tokensIn: c.tokens_in,
      tokensOut: c.tokens_out,
      costUsd: c.cost_usd,
      turns: c.turns,
    })),
  };
}
