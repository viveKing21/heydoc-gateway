import type { QueryResultRow } from 'pg';
import { config } from '../config.js';
import { pool, withTransaction } from './pool.js';

export type Direction = 'in' | 'out';
export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type ConversationStatus = 'active' | 'human' | 'closed';
export type BookingStatus = 'pending' | 'confirmed' | 'failed';

export interface OfferedSlot {
  slot_id: string;
  label: string;
  start_at?: string;
}

export interface ConversationState {
  test_id?: string;
  patient_name?: string;
  date?: string;
  offered_slots?: OfferedSlot[];
  selected_slot?: string;
  booking?: {
    id: string;
    status: BookingStatus;
    lab_booking_id?: string | null;
    slot_id?: string;
  };
  last_intent?: string;
  [key: string]: unknown;
}

export interface ConversationRow {
  id: string;
  phone: string;
  display_name: string | null;
  state: ConversationState;
  status: ConversationStatus;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: Direction;
  role: Role;
  content: string | null;
  tool_name: string | null;
  tool_payload: unknown;
  created_at: Date;
}

export interface JobRow {
  id: string;
  kind: string;
  conversation_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface BookingRow {
  id: string;
  conversation_id: string;
  test_id: string;
  slot_id: string;
  patient_name: string | null;
  status: BookingStatus;
  lab_booking_id: string | null;
  idempotency_key: string;
  last_error: string | null;
  created_at: Date;
  confirmed_at: Date | null;
}

export interface IngestInput {
  waMessageId: string;
  phone: string;
  type: string;
  text: string | null;
  displayName?: string;
  raw: unknown;
}

export interface IngestResult {
  duplicate: boolean;
  rateLimited: boolean;
  inboundId: string | null;
  conversationId: string | null;
  jobId: string | null;
  rateCount: number | null;
}

/**
 * The hot path: one statement does dedupe, conversation upsert, rate-limit
 * bump and job enqueue. If the message id already exists, every CTE produces
 * zero rows and the API still returns 200.
 */
export async function ingestInbound(input: IngestInput, limitPerMinute: number): Promise<IngestResult> {
  const { rows } = await poolQuery<{
    inbound_id: string | null;
    conversation_id: string | null;
    rate_count: number | null;
    job_id: string | null;
  }>(
    `
    WITH ins AS (
      INSERT INTO inbound_messages (wa_message_id, phone, type, text_body, raw)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (wa_message_id) DO NOTHING
      RETURNING id
    ), conv AS (
      INSERT INTO conversations (phone, display_name, last_message_at)
      SELECT $2, $6, now() FROM ins
      ON CONFLICT (phone) DO UPDATE SET
        last_message_at = now(),
        display_name = COALESCE(conversations.display_name, EXCLUDED.display_name),
        updated_at = now()
      RETURNING id
    ), rl AS (
      INSERT INTO rate_limits (phone, window_start, count)
      SELECT $2, date_trunc('minute', now()), 1 FROM ins
      ON CONFLICT (phone, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count
    ), job AS (
      INSERT INTO jobs (kind, conversation_id, payload, dedupe_key, max_attempts)
      SELECT 'message', conv.id,
             jsonb_build_object('inbound_id', ins.id::text, 'wa_message_id', $1),
             'msg:' || $1, $7
      FROM ins, conv, rl
      WHERE rl.count <= $8
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    )
    SELECT
      (SELECT id FROM ins) AS inbound_id,
      (SELECT id FROM conv) AS conversation_id,
      (SELECT count FROM rl) AS rate_count,
      (SELECT id FROM job) AS job_id
    `,
    [
      input.waMessageId,
      input.phone,
      input.type,
      input.text,
      JSON.stringify(input.raw),
      input.displayName ?? null,
      config.jobMaxAttempts,
      limitPerMinute,
    ],
  );

  const row = rows[0];
  if (!row || row.inbound_id === null) {
    return {
      duplicate: true,
      rateLimited: false,
      inboundId: null,
      conversationId: row?.conversation_id ?? null,
      jobId: null,
      rateCount: row?.rate_count ?? null,
    };
  }

  const rateCount = row.rate_count === null ? null : Number(row.rate_count);
  const rateLimited = rateCount !== null && rateCount > limitPerMinute;
  return {
    duplicate: false,
    rateLimited,
    inboundId: String(row.inbound_id),
    conversationId: row.conversation_id,
    jobId: row.job_id,
    rateCount,
  };
}

async function poolQuery<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<{ rows: T[] }> {
  return pool.query<T>(text, values);
}

export async function getConversationById(id: string): Promise<ConversationRow | null> {
  const { rows } = await poolQuery<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getConversationByPhone(phone: string): Promise<ConversationRow | null> {
  const { rows } = await poolQuery<ConversationRow>('SELECT * FROM conversations WHERE phone = $1', [phone]);
  return rows[0] ?? null;
}

export async function getInboundMessage(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await poolQuery<Record<string, unknown>>(
    'SELECT * FROM inbound_messages WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export interface AppendMessageInput {
  conversationId: string;
  direction: Direction;
  role: Role;
  content: string | null;
  toolName?: string | null;
  toolPayload?: unknown;
  dedupeKey?: string | null;
}

/** Idempotent append: a replayed job cannot duplicate transcript rows. */
export async function appendMessage(input: AppendMessageInput): Promise<string | null> {
  const { rows } = await poolQuery<{ id: string }>(
    `INSERT INTO messages (conversation_id, direction, role, content, tool_name, tool_payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.conversationId,
      input.direction,
      input.role,
      input.content,
      input.toolName ?? null,
      input.toolPayload === undefined ? null : JSON.stringify(input.toolPayload),
      input.dedupeKey ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

export async function getHistory(conversationId: string, limit = 8): Promise<MessageRow[]> {
  const { rows } = await poolQuery<MessageRow>(
    `SELECT id::text, conversation_id, direction, role, content, tool_name, tool_payload, created_at
     FROM messages
     WHERE conversation_id = $1 AND role IN ('user','assistant') AND content IS NOT NULL
     ORDER BY messages.id DESC LIMIT $2`,
    [conversationId, limit],
  );
  // Reverse in JS: casting the id to text makes an outer SQL ORDER BY
  // lexicographic ("10" < "9"), which silently picks the wrong last message.
  return rows.reverse();
}

export async function getTranscript(conversationId: string, limit = 100): Promise<MessageRow[]> {
  const { rows } = await poolQuery<MessageRow>(
    `SELECT id::text, conversation_id, direction, role, content, tool_name, tool_payload, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY messages.id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function updateConversation(input: {
  id: string;
  state?: ConversationState;
  status?: ConversationStatus;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}): Promise<ConversationRow | null> {
  const { rows } = await poolQuery<ConversationRow>(
    `UPDATE conversations SET
       state = COALESCE($2::jsonb, state),
       status = COALESCE($3, status),
       tokens_in = tokens_in + $4,
       tokens_out = tokens_out + $5,
       cost_usd = cost_usd + $6,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      input.id,
      input.state === undefined ? null : JSON.stringify(input.state),
      input.status ?? null,
      input.tokensIn ?? 0,
      input.tokensOut ?? 0,
      input.costUsd ?? 0,
    ],
  );
  return rows[0] ?? null;
}

// ─── Queue ───────────────────────────────────────────────────────────────────

/**
 * Claim one job. Excludes conversations with a running job so turns are
 * processed in order, and relies on the partial unique index as a backstop.
 * Returns null when another claimant won the same conversation (23505).
 */
export async function claimJob(workerId: string): Promise<JobRow | null> {
  try {
    const { rows } = await poolQuery<JobRow>(
      `
      WITH candidate AS (
        SELECT j.id
        FROM jobs j
        WHERE j.status = 'queued'
          AND j.run_at <= now()
          AND j.attempts < j.max_attempts
          AND NOT EXISTS (
            SELECT 1 FROM jobs r
            WHERE r.conversation_id = j.conversation_id AND r.status = 'running'
          )
        ORDER BY j.run_at ASC, j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
      FROM candidate WHERE jobs.id = candidate.id
      RETURNING jobs.id::text, jobs.kind, jobs.conversation_id, jobs.payload, jobs.attempts, jobs.max_attempts
      `,
      [workerId],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, attempts: Number(row.attempts), max_attempts: Number(row.max_attempts) };
  } catch (err) {
    if (isUniqueViolationLocal(err)) return null;
    throw err;
  }
}

function isUniqueViolationLocal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function completeJob(id: string): Promise<void> {
  await poolQuery(
    `UPDATE jobs SET status='done', finished_at=now(), locked_by=NULL, locked_at=NULL WHERE id=$1`,
    [id],
  );
}

export async function failJob(
  id: string,
  error: string,
  backoffSeconds: number,
): Promise<'queued' | 'dead'> {
  const { rows } = await poolQuery<{ status: string }>(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
       last_error = $2,
       locked_by = NULL,
       locked_at = NULL,
       run_at = CASE WHEN attempts >= max_attempts THEN run_at
                     ELSE now() + make_interval(secs => $3::double precision) END,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE id = $1
     RETURNING status`,
    [id, error.slice(0, 1000), backoffSeconds],
  );
  return (rows[0]?.status as 'queued' | 'dead') ?? 'dead';
}

/** Recover jobs whose worker died mid-flight. */
export async function reapExpiredJobs(leaseSeconds: number): Promise<Array<{ id: string; status: string }>> {
  const { rows } = await poolQuery<{ id: string; status: string }>(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
       locked_by = NULL,
       locked_at = NULL,
       last_error = COALESCE(last_error, 'lease expired'),
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1::double precision)
     RETURNING id::text, status`,
    [leaseSeconds],
  );
  return rows;
}

export async function queueDepth(): Promise<Record<string, number>> {
  const { rows } = await poolQuery<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM jobs GROUP BY status`,
  );
  const out: Record<string, number> = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

// ─── Bookings ────────────────────────────────────────────────────────────────

export async function findActiveBookingByKey(key: string): Promise<BookingRow | null> {
  const { rows } = await poolQuery<BookingRow>(
    `SELECT * FROM bookings WHERE idempotency_key = $1 AND status IN ('pending','confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function findActiveBookingBySlot(slotId: string): Promise<BookingRow | null> {
  const { rows } = await poolQuery<BookingRow>(
    `SELECT * FROM bookings WHERE slot_id = $1 AND status IN ('pending','confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [slotId],
  );
  return rows[0] ?? null;
}

/**
 * Slots we have already reserved or confirmed. The lab's availability feed can
 * be stale (or a different replica); our reservation is authoritative, so the
 * agent must never offer these again.
 */
export async function activeBookedSlotIds(prefix: string): Promise<Set<string>> {
  const { rows } = await poolQuery<{ slot_id: string }>(
    `SELECT slot_id FROM bookings
     WHERE status IN ('pending','confirmed') AND slot_id LIKE $1 || '%'`,
    [prefix],
  );
  return new Set(rows.map((r) => r.slot_id));
}

export async function findActiveBookingForConversation(
  conversationId: string,
): Promise<BookingRow | null> {
  const { rows } = await poolQuery<BookingRow>(
    `SELECT * FROM bookings WHERE conversation_id = $1 AND status IN ('pending','confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/**
 * Reserve the slot before calling the lab. The partial unique index on
 * slot_id is the single arbiter — a second caller cannot even start an
 * HTTP request for a slot that is already pending or confirmed.
 */
export async function reserveBooking(input: {
  conversationId: string;
  testId: string;
  slotId: string;
  patientName?: string | null;
  idempotencyKey: string;
}): Promise<BookingRow | null> {
  const { rows } = await poolQuery<BookingRow>(
    `INSERT INTO bookings (conversation_id, test_id, slot_id, patient_name, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.conversationId, input.testId, input.slotId, input.patientName ?? null, input.idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function confirmBooking(id: string, labBookingId: string): Promise<BookingRow | null> {
  const { rows } = await poolQuery<BookingRow>(
    `UPDATE bookings SET status='confirmed', lab_booking_id=$2, confirmed_at=now(), last_error=NULL
     WHERE id=$1 RETURNING *`,
    [id, labBookingId],
  );
  return rows[0] ?? null;
}

/** Failing releases the slot constraint — only legal when the lab is known
 * not to have committed, or after reconciliation proved it did not. */
export async function failBooking(id: string, reason: string): Promise<void> {
  await poolQuery(
    `UPDATE bookings SET status='failed', last_error=$2 WHERE id=$1 AND status='pending'`,
    [id, reason.slice(0, 1000)],
  );
}

export async function noteBookingError(id: string, error: string): Promise<void> {
  await poolQuery(`UPDATE bookings SET last_error=$2 WHERE id=$1`, [id, error.slice(0, 1000)]);
}

export async function listBookings(limit = 500): Promise<
  Array<BookingRow & { phone: string }>
> {
  const { rows } = await poolQuery<BookingRow & { phone: string }>(
    `SELECT b.*, c.phone FROM bookings b JOIN conversations c ON c.id=b.conversation_id
     ORDER BY b.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// ─── LLM usage ───────────────────────────────────────────────────────────────

export interface LlmUsageInput {
  conversationId: string | null;
  runId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

export async function recordLlmUsage(input: LlmUsageInput): Promise<void> {
  await poolQuery(
    `WITH ins AS (
       INSERT INTO llm_usage
         (conversation_id, run_id, provider, model, prompt_tokens, completion_tokens,
          cached_tokens, cost_usd, latency_ms, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING conversation_id
     )
     UPDATE conversations c SET
       tokens_in = c.tokens_in + $5,
       tokens_out = c.tokens_out + $6,
       cost_usd = c.cost_usd + $8,
       updated_at = now()
     FROM ins WHERE c.id = ins.conversation_id`,
    [
      input.conversationId,
      input.runId,
      input.provider,
      input.model,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens,
      input.costUsd,
      input.latencyMs,
      input.outcome,
    ],
  );
}

export async function dailyLlmTotals(): Promise<{ calls: number; costUsd: number }> {
  const { rows } = await poolQuery<{ calls: number; cost_usd: number }>(
    `SELECT count(*)::int AS calls, COALESCE(SUM(cost_usd),0)::float8 AS cost_usd
     FROM llm_usage WHERE created_at >= date_trunc('day', now())`,
  );
  return { calls: Number(rows[0]?.calls ?? 0), costUsd: Number(rows[0]?.cost_usd ?? 0) };
}

// ─── Handoffs / outbox ───────────────────────────────────────────────────────

export async function createHandoff(input: {
  conversationId: string;
  reason: string;
  source: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO handoffs (conversation_id, reason, source) VALUES ($1,$2,$3)`,
      [input.conversationId, input.reason.slice(0, 1000), input.source],
    );
    await client.query(
      `UPDATE conversations SET status='human', updated_at=now() WHERE id=$1 AND status <> 'closed'`,
      [input.conversationId],
    );
  });
}

export async function insertOutbox(input: {
  conversationId: string | null;
  toPhone: string;
  body: string;
  dedupeKey: string | null;
}): Promise<string | null> {
  const { rows } = await poolQuery<{ id: string }>(
    `INSERT INTO outbox (conversation_id, to_phone, body, dedupe_key)
     VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text`,
    [input.conversationId, input.toPhone, input.body, input.dedupeKey],
  );
  return rows[0]?.id ?? null;
}

export interface OutboxRow {
  id: string;
  conversation_id: string | null;
  to_phone: string;
  body: string;
  attempts: number;
}

export async function claimOutbox(): Promise<OutboxRow | null> {
  const { rows } = await poolQuery<OutboxRow>(
    `WITH candidate AS (
       SELECT id FROM outbox
       WHERE status = 'queued'
          OR (status = 'sending' AND locked_at < now() - interval '2 minutes')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE outbox SET status='sending', locked_at=now(), attempts=attempts+1
     FROM candidate WHERE outbox.id = candidate.id
     RETURNING outbox.id::text, outbox.conversation_id, outbox.to_phone, outbox.body, outbox.attempts`,
  );
  return rows[0] ? { ...rows[0], attempts: Number(rows[0].attempts) } : null;
}

export async function markOutboxSent(id: string): Promise<void> {
  await poolQuery(`UPDATE outbox SET status='sent', sent_at=now(), locked_at=NULL WHERE id=$1`, [id]);
}

export async function markOutboxFailed(id: string, error: string, maxAttempts = 5): Promise<void> {
  await poolQuery(
    `UPDATE outbox SET
       status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
       last_error = $2, locked_at = NULL
     WHERE id = $1`,
    [id, error.slice(0, 1000), maxAttempts],
  );
}

export async function listOutbox(phone?: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  const { rows } = phone
    ? await poolQuery<Record<string, unknown>>(
        `SELECT id::text, to_phone, body, status, attempts, sent_at, created_at
         FROM outbox WHERE to_phone=$1 ORDER BY created_at DESC LIMIT $2`,
        [phone, limit],
      )
    : await poolQuery<Record<string, unknown>>(
        `SELECT id::text, to_phone, body, status, attempts, sent_at, created_at
         FROM outbox ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
  return rows;
}

// ─── Lab call audit (multi-process metrics) ──────────────────────────────────

export async function recordLabCall(input: {
  op: string;
  outcome: string;
  attempt: number;
  latencyMs: number;
}): Promise<void> {
  await poolQuery(
    `INSERT INTO lab_calls (op, outcome, attempt, latency_ms) VALUES ($1,$2,$3,$4)`,
    [input.op, input.outcome, input.attempt, Math.round(input.latencyMs)],
  );
}

export async function bookingsByStatus(): Promise<Record<string, number>> {
  const { rows } = await poolQuery<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM bookings GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

export async function labCalls24h(): Promise<Array<{ op: string; outcome: string; count: number }>> {
  const { rows } = await poolQuery<{ op: string; outcome: string; count: number }>(
    `SELECT op, outcome, count(*)::int AS count FROM lab_calls
     WHERE created_at > now() - interval '24 hours'
     GROUP BY op, outcome`,
  );
  return rows;
}

export async function llmUsage24h(): Promise<{
  calls: number;
  fallbacks: number;
  prompt: number;
  completion: number;
  costUsd: number;
}> {
  const { rows } = await poolQuery<{
    calls: number;
    fallbacks: number;
    prompt: number;
    completion: number;
    cost_usd: number;
  }>(
    `SELECT count(*)::int AS calls,
            count(*) FILTER (WHERE outcome = 'fallback')::int AS fallbacks,
            COALESCE(SUM(prompt_tokens),0)::int AS prompt,
            COALESCE(SUM(completion_tokens),0)::int AS completion,
            COALESCE(SUM(cost_usd),0)::float8 AS cost_usd
     FROM llm_usage WHERE created_at > now() - interval '24 hours'`,
  );
  const r = rows[0];
  return {
    calls: Number(r?.calls ?? 0),
    fallbacks: Number(r?.fallbacks ?? 0),
    prompt: Number(r?.prompt ?? 0),
    completion: Number(r?.completion ?? 0),
    costUsd: Number(r?.cost_usd ?? 0),
  };
}

export async function jobStats(): Promise<{ retried: number; dead: number }> {
  const { rows } = await poolQuery<{ retried: number; dead: number }>(
    `SELECT count(*) FILTER (WHERE attempts > 1)::int AS retried,
            count(*) FILTER (WHERE status = 'dead')::int AS dead
     FROM jobs`,
  );
  const r = rows[0];
  return { retried: Number(r?.retried ?? 0), dead: Number(r?.dead ?? 0) };
}

export async function outboxByStatus(): Promise<Record<string, number>> {
  const { rows } = await poolQuery<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM outbox GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

// ─── Read models for /metrics and /api ───────────────────────────────────────

export async function listConversations(limit = 50): Promise<Array<Record<string, unknown>>> {
  const { rows } = await poolQuery<Record<string, unknown>>(
    `SELECT id::text, phone, display_name, status, tokens_in, tokens_out, cost_usd::float8 AS cost_usd,
            state, last_message_at
     FROM conversations ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getConversationDetail(phone: string): Promise<Record<string, unknown> | null> {
  const conversation = await getConversationByPhone(phone);
  if (!conversation) return null;
  const [messages, bookings, handoffs, usage] = await Promise.all([
    getTranscript(conversation.id, 100),
    poolQuery<BookingRow>(
      `SELECT * FROM bookings WHERE conversation_id=$1 ORDER BY created_at DESC`,
      [conversation.id],
    ),
    poolQuery<Record<string, unknown>>(
      `SELECT id::text, reason, source, created_at FROM handoffs WHERE conversation_id=$1
       ORDER BY created_at DESC`,
      [conversation.id],
    ),
    poolQuery<{ calls: number; prompt: number; completion: number; cost: number }>(
      `SELECT count(*)::int AS calls,
              COALESCE(SUM(prompt_tokens),0)::int AS prompt,
              COALESCE(SUM(completion_tokens),0)::int AS completion,
              COALESCE(SUM(cost_usd),0)::float8 AS cost
       FROM llm_usage WHERE conversation_id=$1`,
      [conversation.id],
    ),
  ]);
  return {
    conversation: { ...conversation, cost_usd: Number(conversation.cost_usd) },
    messages,
    bookings: bookings.rows,
    handoffs: handoffs.rows,
    usage: usage.rows[0] ?? { calls: 0, prompt: 0, completion: 0, cost: 0 },
  };
}

export async function metricsConversations(limit = 500): Promise<
  Array<{ id: string; phone: string; tokens_in: number; tokens_out: number; cost_usd: number; turns: number }>
> {
  const { rows } = await poolQuery<{
    id: string;
    phone: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    turns: number;
  }>(
    `SELECT c.id::text, c.phone, c.tokens_in, c.tokens_out, c.cost_usd::float8 AS cost_usd,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS turns
     FROM conversations c
     WHERE COALESCE(c.last_message_at, c.created_at) > now() - interval '24 hours'
     ORDER BY c.cost_usd DESC, c.last_message_at DESC NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function usageTotals(): Promise<{
  conversations: number;
  confirmed: number;
  pending: number;
  handoffs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}> {
  const { rows } = await poolQuery<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM bookings WHERE status='confirmed') AS confirmed,
       (SELECT count(*)::int FROM bookings WHERE status='pending') AS pending,
       (SELECT count(*)::int FROM handoffs) AS handoffs,
       (SELECT COALESCE(SUM(tokens_in),0)::int FROM conversations) AS tokens_in,
       (SELECT COALESCE(SUM(tokens_out),0)::int FROM conversations) AS tokens_out,
       (SELECT COALESCE(SUM(cost_usd),0)::float8 FROM conversations) AS cost_usd`,
  );
  const r = rows[0] ?? {};
  return {
    conversations: Number(r.conversations ?? 0),
    confirmed: Number(r.confirmed ?? 0),
    pending: Number(r.pending ?? 0),
    handoffs: Number(r.handoffs ?? 0),
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
  };
}
