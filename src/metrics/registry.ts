import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { WindowStats } from './window.js';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'heydoc-gateway' });

const gauge = (name: string, help: string, labelNames: string[] = []) =>
  new Gauge({ name, help, labelNames, registers: [registry] });

/**
 * Design note: the API and worker are separate processes. Per-process counters
 * would make /metrics depend on which replica answered, so business metrics
 * are derived from Postgres at scrape time and exposed as gauges. Only
 * request-path counters (which really do live in the API) are process-local.
 */
export const metrics = {
  webhookRequests: new Counter({
    name: 'gateway_webhook_requests_total',
    help: 'Webhook requests by HTTP status',
    labelNames: ['status'],
    registers: [registry],
  }),
  webhookDuration: new Histogram({
    name: 'gateway_webhook_duration_seconds',
    help: 'Time from request start to 200 response',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1],
    registers: [registry],
  }),
  duplicateMessages: new Counter({
    name: 'gateway_duplicate_messages_total',
    help: 'Webhook messages suppressed by wamid dedupe',
    registers: [registry],
  }),
  rateLimited: new Counter({
    name: 'gateway_rate_limited_total',
    help: 'Messages dropped by the per-phone rate limit',
    registers: [registry],
  }),

  queueDepth: gauge('gateway_queue_depth', 'Jobs by status', ['status']),
  jobsRetried24h: gauge('gateway_jobs_retried_24h', 'Jobs that needed more than one attempt'),
  bookingsState: gauge('gateway_bookings_state', 'Bookings by status', ['status']),
  labCalls24h: gauge('gateway_lab_calls_24h', 'Lab API attempts in the last 24 hours', [
    'op',
    'outcome',
  ]),
  llmCalls24h: gauge('gateway_llm_calls_24h', 'LLM calls in the last 24 hours'),
  llmFallbacks24h: gauge('gateway_llm_fallbacks_24h', 'Turns served by the fallback provider'),
  llmTokens24h: gauge('gateway_llm_tokens_24h', 'LLM tokens in the last 24 hours', ['kind']),
  llmCostUsd24h: gauge('gateway_llm_cost_usd_24h', 'Estimated LLM spend in the last 24 hours'),
  outboxState: gauge('gateway_outbox_state', 'Outbound messages by status', ['status']),

  conversationTokens: gauge('gateway_conversation_tokens', 'Tokens per conversation', [
    'conversation',
    'phone',
    'kind',
  ]),
  conversationCost: gauge('gateway_conversation_cost_usd', 'Estimated cost per conversation', [
    'conversation',
    'phone',
  ]),

  stateConversations: gauge('gateway_state_conversations', 'Conversations in the database'),
  stateConfirmedBookings: gauge('gateway_state_confirmed_bookings', 'Confirmed bookings'),
  statePendingBookings: gauge('gateway_state_pending_bookings', 'Pending bookings'),
  stateHandoffs: gauge('gateway_state_handoffs', 'Human handoffs'),

  ackLatency: new WindowStats(5_000),
};

export type PromMetric = {
  name: string;
  type: string;
  values: Array<{ labels: Record<string, string | number>; value: number }>;
};

export async function prometheusJson(): Promise<PromMetric[]> {
  return (await registry.getMetricsAsJSON()) as unknown as PromMetric[];
}

export function metricTotal(source: PromMetric[], name: string): number {
  const metric = source.find((m) => m.name === name);
  return metric ? metric.values.reduce((sum, v) => sum + Number(v.value || 0), 0) : 0;
}

export function metricBreakdown(
  source: PromMetric[],
  name: string,
  labelKeys: string[],
): Record<string, number> {
  const metric = source.find((m) => m.name === name);
  const out: Record<string, number> = {};
  if (!metric) return out;
  for (const v of metric.values) {
    const key = labelKeys.map((k) => String(v.labels[k] ?? '')).filter(Boolean).join(':') || 'total';
    out[key] = (out[key] ?? 0) + Number(v.value || 0);
  }
  return out;
}
