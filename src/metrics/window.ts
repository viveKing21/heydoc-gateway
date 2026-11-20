import { percentiles } from '../util/backoff.js';

/** Bounded ring buffer of ack latencies for JSON percentiles. */
export class WindowStats {
  private values: number[] = [];

  constructor(private readonly capacity = 5_000) {}

  add(value: number): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  reset(): void {
    this.values = [];
  }

  snapshot(): { count: number; p50: number; p95: number; p99: number; max: number; avg: number } {
    const p = percentiles(this.values);
    return { count: this.values.length, ...p };
  }
}
