import Fastify, { type FastifyInstance } from 'fastify';
import { istDate, TESTS } from '../src/lab/tests.js';

export type FailMode = 'mixed' | 'before' | 'after' | 'after_timeout' | 'none';

export interface LabOptions {
  failRate?: number;
  failMode?: FailMode;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  seed?: number;
  afterTimeoutMs?: number;
}

interface Booking {
  booking_id: string;
  slot_id: string;
  test_id: string;
  patient_name: string;
  status: 'confirmed';
  created_at: string;
  idempotency_key: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelFor(date: string, hour: number): string {
  const iso = `${date}T${String(hour).padStart(2, '0')}:00:00+05:30`;
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${day}, ${time}`;
}

/**
 * Mock diagnostics-lab API.
 *
 * Deliberately hostile: configurable latency and a 20% failure rate, split
 * between "failed before commit" and "committed, then the response failed".
 * The latter is the case that catches naive retry logic.
 */
export function buildLabApp(options: LabOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const failRate = options.failRate ?? Number(process.env.LAB_FAIL_RATE ?? 0.2);
  const failMode = options.failMode ?? ((process.env.LAB_FAIL_MODE as FailMode) ?? 'mixed');
  const minLatency = options.minLatencyMs ?? Number(process.env.LAB_MIN_LATENCY_MS ?? 120);
  const maxLatency = options.maxLatencyMs ?? Number(process.env.LAB_MAX_LATENCY_MS ?? 700);
  const seed = options.seed ?? (process.env.LAB_SEED ? Number(process.env.LAB_SEED) : undefined);
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const afterTimeoutMs = options.afterTimeoutMs ?? 3_000;

  const byKey = new Map<string, Booking>();
  const bySlot = new Map<string, string>();
  let counter = 0;
  let requests = 0;
  let failures = 0;
  let afterCommitFailures = 0;

  const latency = async (): Promise<void> => {
    const ms = minLatency + rng() * Math.max(0, maxLatency - minLatency);
    if (ms > 0) await sleep(ms);
  };

  const shouldFail = (): boolean => failMode !== 'none' && rng() < failRate;

  app.get('/healthz', async () => ({ status: 'ok', bookings: byKey.size }));

  app.get('/slots', async (request, reply) => {
    requests += 1;
    await latency();
    if (shouldFail() && (failMode === 'before' || failMode === 'mixed')) {
      failures += 1;
      return reply.code(503).send({ error: 'slot service unavailable', code: 'LAB_UNAVAILABLE' });
    }
    const query = request.query as Record<string, string | undefined>;
    const testId = query.test_id ?? 'cbc';
    const date = query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : istDate(1);
    const slots = [9, 10, 11, 12, 14, 15, 16, 17].map((hour) => {
      const slotId = `${testId}-${date}-${String(hour).padStart(2, '0')}00`;
      return {
        slot_id: slotId,
        label: labelFor(date, hour),
        start_at: `${date}T${String(hour).padStart(2, '0')}:00:00+05:30`,
        available: !bySlot.has(slotId),
      };
    });
    return { test_id: testId, date, slots };
  });

  app.post('/bookings', async (request, reply) => {
    requests += 1;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      return reply.code(400).send({ error: 'Idempotency-Key header is required' });
    }

    // Replay BEFORE latency/failure injection: a retry of a committed booking
    // must always get the original answer.
    const existing = byKey.get(key);
    if (existing) {
      return reply.code(200).send(existing);
    }

    const body = (request.body ?? {}) as {
      slot_id?: unknown;
      test_id?: unknown;
      patient_name?: unknown;
    };
    if (typeof body.slot_id !== 'string' || typeof body.test_id !== 'string') {
      return reply.code(400).send({ error: 'slot_id and test_id are required' });
    }
    if (!TESTS.some((t) => t.id === body.test_id)) {
      return reply.code(422).send({ error: 'unknown test_id' });
    }

    const slotOwner = bySlot.get(body.slot_id);
    if (slotOwner !== undefined && slotOwner !== key) {
      return reply.code(409).send({ error: 'slot taken', code: 'SLOT_TAKEN' });
    }

    await latency();
    const fail = shouldFail();
    const afterCommit =
      fail &&
      (failMode === 'after' ||
        failMode === 'after_timeout' ||
        (failMode === 'mixed' && rng() < 0.5));

    if (fail && !afterCommit) {
      failures += 1;
      return reply.code(503).send({ error: 'booking service unavailable', code: 'LAB_UNAVAILABLE' });
    }

    const booking: Booking = {
      booking_id: `lab_${String(++counter).padStart(4, '0')}_${key.slice(0, 8)}`,
      slot_id: body.slot_id,
      test_id: body.test_id,
      patient_name:
        typeof body.patient_name === 'string' && body.patient_name ? body.patient_name : 'Patient',
      status: 'confirmed',
      created_at: new Date().toISOString(),
      idempotency_key: key,
    };
    byKey.set(key, booking);
    bySlot.set(body.slot_id, key);

    if (afterCommit) {
      afterCommitFailures += 1;
      if (failMode === 'after_timeout') {
        // Committed, but the response arrives after the client's timeout.
        await sleep(afterTimeoutMs);
        return reply.code(201).send(booking);
      }
      return reply
        .code(500)
        .send({ error: 'committed but the response failed', booking_id: booking.booking_id });
    }

    return reply.code(201).send(booking);
  });

  app.get('/bookings/by-key/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const booking = byKey.get(key);
    if (!booking) return reply.code(404).send({ error: 'not found' });
    return booking;
  });

  app.get('/__admin/state', async () => ({
    bookings: [...byKey.values()],
    slots: Object.fromEntries(bySlot),
    counters: { requests, failures, afterCommitFailures },
  }));

  app.post('/__admin/reset', async () => {
    byKey.clear();
    bySlot.clear();
    counter = 0;
    requests = 0;
    failures = 0;
    afterCommitFailures = 0;
    return { status: 'reset' };
  });

  return app;
}
