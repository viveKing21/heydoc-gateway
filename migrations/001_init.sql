-- 001_init.sql — schema for the WhatsApp agent gateway.
-- Correctness constraints are deliberate; see PLAN.md §4.

CREATE TABLE inbound_messages (
  id            bigserial PRIMARY KEY,
  wa_message_id text        NOT NULL UNIQUE,
  phone         text        NOT NULL,
  type          text        NOT NULL,
  text_body     text,
  raw           jsonb       NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_messages_by_phone ON inbound_messages (phone, received_at DESC);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE,
  display_name    text,
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','human','closed')),
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_usd        numeric(12,8) NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  role            text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content         text,
  tool_name       text,
  tool_payload    jsonb,
  dedupe_key      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_by_conversation ON messages (conversation_id, id);

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'message',
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 6,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  last_error      text,
  dedupe_key      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX jobs_claimable ON jobs (status, run_at);
-- Ordering backstop: a conversation may have at most one running job, ever.
CREATE UNIQUE INDEX jobs_one_running_per_conversation
  ON jobs (conversation_id) WHERE status = 'running';

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  test_id         text NOT NULL,
  slot_id         text NOT NULL,
  patient_name    text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','failed')),
  lab_booking_id  text,
  idempotency_key text NOT NULL,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz
);
-- THE no-double-booking constraint: one active booking per slot, globally.
CREATE UNIQUE INDEX bookings_one_active_per_slot
  ON bookings (slot_id) WHERE status IN ('pending','confirmed');
-- Retries reuse the same key; failed rows release both constraints.
CREATE UNIQUE INDEX bookings_active_idempotency
  ON bookings (idempotency_key) WHERE status IN ('pending','confirmed');
-- One active booking per conversation: a patient cannot book twice by mistake.
CREATE UNIQUE INDEX bookings_one_active_per_conversation
  ON bookings (conversation_id) WHERE status IN ('pending','confirmed');
CREATE INDEX bookings_by_conversation ON bookings (conversation_id, created_at DESC);

CREATE TABLE llm_usage (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  run_id            uuid NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cached_tokens     integer NOT NULL DEFAULT 0,
  cost_usd          numeric(12,8) NOT NULL DEFAULT 0,
  latency_ms        integer,
  outcome           text NOT NULL DEFAULT 'ok',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_by_conversation ON llm_usage (conversation_id, created_at);
CREATE INDEX llm_usage_by_day ON llm_usage (created_at);

CREATE TABLE rate_limits (
  phone        text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, window_start)
);

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason          text NOT NULL,
  source          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoffs_by_conversation ON handoffs (conversation_id, created_at DESC);

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  to_phone        text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','failed')),
  dedupe_key      text UNIQUE,
  attempts        integer NOT NULL DEFAULT 0,
  locked_at       timestamptz,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (status, created_at);
