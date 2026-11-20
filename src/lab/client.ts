import { config } from '../config.js';
import { recordLabCall } from '../db/repo.js';
import { backoffMs, sleep } from '../util/backoff.js';
import { log } from '../util/log.js';

export interface LabSlot {
  slot_id: string;
  label: string;
  start_at?: string;
  available?: boolean;
}

export interface LabBooking {
  booking_id: string;
  slot_id: string;
  test_id: string;
  patient_name: string;
  status: string;
  created_at: string;
}

export type LabErrorKind = 'timeout' | 'network' | 'http' | 'slot_taken';

export class LabError extends Error {
  readonly kind: LabErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: LabErrorKind, message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'LabError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? kind !== 'slot_taken';
  }
}

export interface LabClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  slotsTimeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
}

/**
 * HTTP client for the lab. Every write carries an Idempotency-Key and every
 * transient failure is retried with that same key — that is the contract that
 * makes "committed upstream, response lost" safe.
 */
export class LabClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly slotsTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;

  constructor(options: LabClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? config.lab.url).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? config.lab.timeoutMs;
    this.slotsTimeoutMs = options.slotsTimeoutMs ?? config.lab.slotsTimeoutMs;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? config.lab.maxAttempts);
    this.backoffBaseMs = options.backoffBaseMs ?? config.lab.backoffBaseMs;
  }

  async checkSlots(testId: string, date: string): Promise<LabSlot[]> {
    const qs = new URLSearchParams({ test_id: testId, date });
    const body = await this.withRetry('slots', this.slotsTimeoutMs, async () => {
      const res = await this.request(`/slots?${qs.toString()}`, { method: 'GET' }, this.slotsTimeoutMs);
      if (!res.ok) throw this.httpError(res.status);
      return (await res.json()) as { slots?: LabSlot[] };
    });
    return Array.isArray(body.slots) ? body.slots : [];
  }

  async createBooking(
    input: { slot_id: string; test_id: string; patient_name: string },
    idempotencyKey: string,
  ): Promise<LabBooking> {
    return this.withRetry('book', this.timeoutMs, async () => {
      const res = await this.request(
        '/bookings',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(input),
        },
        this.timeoutMs,
      );
      if (res.status === 409) throw new LabError('slot_taken', 'slot already booked', { status: 409, retryable: false });
      if (!res.ok) throw this.httpError(res.status);
      return (await res.json()) as LabBooking;
    });
  }

  /** Reconcile an ambiguous booking. Never retried: one answer is enough. */
  async findBookingByKey(idempotencyKey: string): Promise<LabBooking | null> {
    try {
      const res = await this.request(
        `/bookings/by-key/${encodeURIComponent(idempotencyKey)}`,
        { method: 'GET' },
        this.timeoutMs,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw this.httpError(res.status);
      return (await res.json()) as LabBooking;
    } catch (err) {
      log.warn('lab reconciliation failed', { error: (err as Error).message });
      return null;
    }
  }

  private async withRetry<T>(op: 'slots' | 'book', timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now();
      try {
        const result = await fn();
        void recordLabCall({ op, outcome: 'ok', attempt, latencyMs: Date.now() - started }).catch(
          () => undefined,
        );
        return result;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof LabError ? err.retryable : true;
        const isLast = attempt === this.maxAttempts;
        void recordLabCall({
          op,
          outcome: isLast || !retryable ? 'error' : 'retry',
          attempt,
          latencyMs: Date.now() - started,
        }).catch(() => undefined);
        if (!retryable || isLast) break;
        const delay = backoffMs(attempt, this.backoffBaseMs, 3, Math.min(5_000, timeoutMs * 2), 0.5);
        log.warn('lab call retrying', { op, attempt, delayMs: delay, error: (err as Error).message });
        await sleep(delay);
      }
    }
    throw lastError instanceof LabError
      ? lastError
      : new LabError('network', (lastError as Error)?.message ?? 'lab request failed');
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LabError('timeout', `lab request timed out after ${timeoutMs}ms`);
      }
      throw new LabError('network', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number): LabError {
    const retryable = status >= 500 || status === 408 || status === 429;
    return new LabError('http', `lab returned ${status}`, { status, retryable });
  }
}
