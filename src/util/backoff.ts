/**
 * Exponential backoff with jitter.
 *
 * attempt 1 → base, attempt 2 → base*factor, ... capped, then ±jitter.
 * The jitter is symmetric so the expected value stays at the raw delay; this
 * avoids synchronised retry storms after a lab outage.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  factor = 2,
  capMs = 30_000,
  jitter = 0.3,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = Math.min(capMs, baseMs * Math.pow(factor, safeAttempt - 1));
  const delta = raw * jitter;
  const value = raw - delta + Math.random() * 2 * delta;
  return Math.max(0, Math.round(value));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Percentiles over a sorted copy. Returns zeros for an empty sample. */
export function percentiles(values: number[]): { p50: number; p95: number; p99: number; max: number; avg: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]!, avg: sum / sorted.length };
}
