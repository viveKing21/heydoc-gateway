import { describe, expect, it } from 'vitest';
import { backoffMs, percentiles } from '../../src/util/backoff.js';
import { bookingIdempotencyKey } from '../../src/util/ids.js';

describe('backoff', () => {
  it('grows exponentially and stays within the jitter envelope', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const raw = Math.min(30_000, 500 * Math.pow(2, attempt - 1));
      for (let i = 0; i < 50; i++) {
        const delay = backoffMs(attempt, 500, 2, 30_000, 0.3);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(raw * 0.7) - 1);
        expect(delay).toBeLessThanOrEqual(Math.ceil(raw * 1.3) + 1);
      }
    }
  });

  it('caps at the ceiling', () => {
    for (let i = 0; i < 100; i++) {
      expect(backoffMs(30, 500, 2, 5_000, 0.3)).toBeLessThanOrEqual(6_500);
    }
  });

  it('percentiles handle empty and ordered samples', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, avg: 0 });
    const p = percentiles([1, 2, 3, 4, 5]);
    expect(p.p50).toBe(3);
    expect(p.max).toBe(5);
  });
});

describe('booking idempotency key', () => {
  it('is stable for the same conversation, slot and test', () => {
    const a = bookingIdempotencyKey('conv-1', 'slot-1', 'cbc');
    const b = bookingIdempotencyKey('conv-1', 'slot-1', 'cbc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = bookingIdempotencyKey('conv-1', 'slot-1', 'cbc');
    expect(bookingIdempotencyKey('conv-2', 'slot-1', 'cbc')).not.toBe(base);
    expect(bookingIdempotencyKey('conv-1', 'slot-2', 'cbc')).not.toBe(base);
    expect(bookingIdempotencyKey('conv-1', 'slot-1', 'lipid')).not.toBe(base);
  });
});
