import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  getConversationDetail,
  ingestInbound,
  insertOutbox,
  listBookings,
  listConversations,
  listOutbox,
} from '../db/repo.js';
import { metrics, registry } from '../metrics/registry.js';
import { metricsSnapshot, refreshDbGauges } from '../metrics/snapshot.js';
import { buildWebhookPayload, parseWebhookPayload } from '../whatsapp/payload.js';
import { SIGNATURE_HEADER, signBody, verifySignature } from '../whatsapp/signature.js';
import { log } from '../util/log.js';
import { newId } from '../util/ids.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
}

const THROTTLE_TEXT =
  "You're sending messages faster than I can keep up. Please wait a minute and try again.";

function clampLimit(value: unknown, fallback = 50): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function isPhone(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8,15}$/.test(value);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Request-level info logs are noise at 1k msg/s; warnings/errors stay.
    logger: options.logger ? { level: 'warn' } : false,
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  // We need the exact bytes Meta signed; re-serialising the parsed JSON breaks HMAC.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'heydoc-gateway' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      return reply.code(503).send({ status: 'not-ready', error: (err as Error).message });
    }
  });

  // ── Meta verification handshake ───────────────────────────────────────────
  app.get('/webhook', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token === config.verifyToken) {
      return reply.type('text/plain').send(challenge ?? '');
    }
    return reply.code(403).send({ error: 'verification failed' });
  });

  // ── Inbound webhook: verify, dedupe, enqueue, ack ─────────────────────────
  app.post('/webhook', async (request, reply) => {
    const started = process.hrtime.bigint();
    const signature = request.headers[SIGNATURE_HEADER];

    if (!verifySignature(request.rawBody, signature, config.appSecret)) {
      metrics.webhookRequests.inc({ status: '401' });
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const body = request.body as { entry?: unknown; object?: unknown } | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) {
      metrics.webhookRequests.inc({ status: '400' });
      return reply.code(400).send({ error: 'malformed payload' });
    }

    const events = parseWebhookPayload(body);
    let duplicates = 0;
    let rateLimited = 0;

    try {
      for (const event of events) {
        const result = await ingestInbound(
          {
            waMessageId: event.waMessageId,
            phone: event.phone,
            type: event.type,
            text: event.text,
            ...(event.displayName ? { displayName: event.displayName } : {}),
            raw: body,
          },
          config.rateLimitPerMinute,
        );

        if (result.duplicate) {
          duplicates += 1;
          metrics.duplicateMessages.inc();
          continue;
        }

        if (result.rateLimited) {
          rateLimited += 1;
          metrics.rateLimited.inc();
          const bucket = new Date().toISOString().slice(0, 16);
          await insertOutbox({
            conversationId: result.conversationId,
            toPhone: event.phone,
            body: THROTTLE_TEXT,
            dedupeKey: `throttle:${event.phone}:${bucket}`,
          });
        }
      }
    } catch (err) {
      log.error('webhook ingest failed', {
        error: (err as Error).message,
        messages: events.length,
      });
      metrics.webhookRequests.inc({ status: '503' });
      // Meta retries on 5xx, which is exactly what we want when the DB is down.
      return reply.code(503).send({ error: 'temporarily unavailable' });
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    metrics.ackLatency.add(elapsedMs);
    metrics.webhookDuration.observe(elapsedMs / 1_000);
    metrics.webhookRequests.inc({ status: '200' });

    if (duplicates > 0 || rateLimited > 0) {
      log.info('webhook dedupe/limit', { received: events.length, duplicates, rateLimited });
    }

    return reply.code(200).send({ status: 'ok' });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────
  app.get('/metrics', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const wantsJson =
      query.format === 'json' ||
      (query.format === undefined && (request.headers.accept ?? '').includes('application/json'));

    if (wantsJson) {
      return reply.send(await metricsSnapshot());
    }

    try {
      await refreshDbGauges();
    } catch (err) {
      log.warn('metrics db gauges unavailable', { error: (err as Error).message });
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return reply.send(await registry.metrics());
  });

  // ── Operator/demo API ─────────────────────────────────────────────────────
  await app.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
      if (config.devMode) return;
      if (!config.adminToken) {
        return reply.code(503).send({ error: 'admin API disabled' });
      }
      if (request.headers['x-admin-token'] !== config.adminToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });

    api.get('/conversations', async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return { conversations: await listConversations(clampLimit(query.limit)) };
    });

    api.get('/conversations/:phone', async (request, reply) => {
      const { phone } = request.params as { phone: string };
      const detail = await getConversationDetail(phone);
      if (!detail) return reply.code(404).send({ error: 'not found' });
      return detail;
    });

    api.get('/bookings', async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return { bookings: await listBookings(clampLimit(query.limit, 200)) };
    });
  }, { prefix: '/api' });

  // ── Dev-only simulator and console ────────────────────────────────────────
  if (config.devMode) {
    app.get('/demo', async (_request, reply) => {
      try {
        const html = await readFile(path.resolve(process.cwd(), 'public/index.html'), 'utf8');
        return reply.type('text/html; charset=utf-8').send(html);
      } catch {
        return reply.code(404).send({ error: 'demo console not found' });
      }
    });

    app.get('/dev/config', async () => ({
      provider: config.llm.provider,
      model: config.llm.model,
      mockWhatsApp: config.mockWhatsApp,
      devMode: config.devMode,
      rateLimitPerMinute: config.rateLimitPerMinute,
    }));

    // Demo/load hygiene only. Never registered when DEV_MODE=false.
    app.post('/dev/reset', async (_request, reply) => {
      await pool.query(
        `TRUNCATE outbox, handoffs, llm_usage, lab_calls, bookings, messages, jobs,
         inbound_messages, rate_limits, conversations RESTART IDENTITY CASCADE`,
      );
      metrics.ackLatency.reset();
      metrics.webhookRequests.reset();
      metrics.webhookDuration.reset();
      metrics.duplicateMessages.reset();
      metrics.rateLimited.reset();
      return reply.send({ status: 'reset' });
    });

    app.get('/dev/outbox', async (request) => {
      const query = request.query as Record<string, string | undefined>;
      const phone = isPhone(query.phone) ? query.phone : undefined;
      return { messages: await listOutbox(phone, clampLimit(query.limit, 100)) };
    });

    app.post('/dev/simulate', async (request, reply) => {
      const body = (request.body ?? {}) as { phone?: unknown; text?: unknown; clientId?: unknown };
      if (!isPhone(body.phone)) {
        return reply.code(400).send({ error: 'phone must be 8–15 digits' });
      }
      if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > 1_000) {
        return reply.code(400).send({ error: 'text must be 1–1000 characters' });
      }
      const clientId =
        typeof body.clientId === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(body.clientId)
          ? body.clientId
          : newId();

      const waMessageId = `wamid.demo.${clientId}`;
      const payload = buildWebhookPayload({
        phone: body.phone,
        text: body.text,
        waMessageId,
        displayName: 'Demo Patient',
      });
      const raw = Buffer.from(JSON.stringify(payload));
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signBody(raw, config.appSecret),
        },
      });

      return reply.send({
        statusCode: response.statusCode,
        waMessageId,
        clientId,
      });
    });
  }

  return app;
}
