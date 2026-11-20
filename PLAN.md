# PLAN — HeyDoc WhatsApp Agent Gateway

> Take-home for HeyDoc AI (Backend Engineer). This document is the first commit by design:
> problem, users, architecture, data model, API contract and cost estimate come before code.

**Author:** Vivek Sharma
**Clock start:** Fri 20 Nov 2026, 12:49 IST · **Deadline:** Sat 21 Nov 2026, 12:49 IST
**LLM budget:** ₹500 cap → actual spend target **₹0** (OpenRouter free tier + deterministic mock for load)

---

## 1. Problem

A diagnostics lab takes test bookings over WhatsApp. Meta delivers webhooks in bursts, retries
aggressively, and sometimes delivers the same message twice. The lab's booking API is slow
(p95 ~1 s) and fails ~20% of the time — including failures that happen **after** the booking was
committed upstream. A double-booked patient is a real-world harm: a slot, a phlebotomist and a
patient's morning are wasted, and the lab's calendar is now lying.

The gateway must therefore be:

1. **Fast to acknowledge** — Meta expects a 2xx quickly; slow acks cause retries and duplicate
   deliveries. Target: p99 < 200 ms at burst.
2. **Idempotent end to end** — duplicate webhooks, worker crashes and mid-flight retries must not
   create duplicate work or duplicate bookings.
3. **Conversational** — an LLM agent with tools (`check_slots`, `book_test`, `handoff_to_human`)
   keeps context in Postgres across turns.
4. **Observable and cheap** — per-conversation token/cost accounting, queue and latency metrics,
   and a cost model that survives 1 M messages/month.

### Users

| User | Need |
|---|---|
| **Patient** (WhatsApp) | Book a lab test in a few messages, get a clear confirmation or a human. |
| **Lab operator** | Never double-book; see handoffs and the day's bookings. |
| **HeyDoc engineer (on-call)** | Know within seconds whether acks are slow, the queue is stuck, the lab is failing, or spend is drifting. |

### Goals

- WhatsApp Cloud API-shaped webhook with HMAC signature verification and dedupe by `wamid`.
- Durable queue in Postgres, worker with retries/backoff, per-conversation ordering.
- LLM tool-calling agent with deterministic guards; state in Postgres.
- **No double booking under any failure**, enforced by database constraints, not application code.
- Per-phone rate limit, per-conversation token/cost metrics at `/metrics`.
- `docker compose up` runs everything; 1,000-message load test with duplicates and a written report.
- Cost model at 1 M messages/month.

### Non-goals (explicitly out of scope for 24 h)

- Real outbound WhatsApp delivery (no credentials; a mock sender writes to an `outbox` table).
- Multi-tenant routing, lab onboarding, payments, reminders, media messages.
- A production frontend. A small read-only operator console is included only as a demo aid.
- Horizontal autoscaling beyond what compose demonstrates (the design allows it; see §10).

---

## 2. Architecture

```
                          ┌──────────────────────────────────────────────┐
 Meta Cloud API           │  api (Fastify, stateless, N replicas)        │
 (or load script /        │                                              │
  demo console)  ──POST──►  POST /webhook                              │
                          │   1. verify X-Hub-Signature-256 (raw body)   │
                          │   2. parse payload → messages[]              │
                          │   3. ONE SQL statement:                      │
                          │        INSERT inbound ON CONFLICT DO NOTHING │
                          │        upsert conversation                   │
                          │        bump rate-limit counter               │
                          │        INSERT job if new & under limit       │
                          │   4. 200 {"status":"ok"}   (no LLM, no lab)  │
                          └───────────────┬──────────────────────────────┘
                                          │
                    ┌─────────────────────▼─────────────────────┐
                    │ Postgres 16                               │
                    │  inbound_messages  UNIQUE(wa_message_id)  │
                    │  conversations / messages                 │
                    │  jobs  (SKIP LOCKED queue + lease)        │
                    │  bookings  UNIQUE(slot) WHERE active      │
                    │  llm_usage / rate_limits / handoffs       │
                    │  outbox                                   │
                    └───────┬───────────────────────┬───────────┘
                            │ claim                 │ poll
                    ┌───────▼────────┐      ┌───────▼─────────┐
                    │ worker         │      │ outbox sender   │
                    │  N loops       │      │ (mock WhatsApp) │
                    │  agent loop    │      └─────────────────┘
                    │  tools ────────┼──► mock-lab (Fastify)
                    │  LLM ──────────┼──► OpenRouter free model
                    └────────────────┘      (or deterministic mock)

  GET /metrics  ── Prometheus text (default) or JSON (?format=json)
  GET /demo     ── static operator console (DEV_MODE only)
```

### Why these choices

| Decision | Rationale |
|---|---|
| **Postgres as queue** (`FOR UPDATE SKIP LOCKED`) | Already required for state; removes Redis from the critical path. One less container, one less failure mode. Per-conversation ordering is expressible in SQL. |
| **Stateless API** | The ack path is a signature check + one indexed insert. Scales horizontally; no in-memory dedupe that dies with the process. |
| **Dedupe in the database** | `UNIQUE(wa_message_id)` is the only dedupe that survives restarts, redeploys and multiple API replicas. |
| **Two-phase booking** (reserve in our DB → call lab) | The slot uniqueness constraint is ours, so two conversations can never both call the lab for the same slot. |
| **Idempotency-Key on every lab write** | Handles the worst case: lab committed, response lost. Retry returns the original booking. |
| **LLM optional** | Free-tier limits (20 rpm, 50 rpd) and flaky free models must not break the product. A deterministic responder implements the same interface and is the default in tests/load. |
| **Outbox pattern** | The agent never sends inside a DB transaction; sends are retried independently, and the transcript is committed before delivery. |

---

## 3. Request lifecycle

1. **Verify.** HMAC-SHA256 over the *raw* body with `WHATSAPP_APP_SECRET`; compare with
   `X-Hub-Signature-256: sha256=<hex>` using `timingSafeEqual`. Missing/invalid → 401. We reject
   before parsing body fields.
2. **Ingest (one statement).**
   - `INSERT INTO inbound_messages ... ON CONFLICT (wa_message_id) DO NOTHING`
   - upsert `conversations(phone)` and bump `last_message_at`
   - `INSERT INTO rate_limits(phone, window_start, count) ... ON CONFLICT DO UPDATE count+1`
   - if the message was new **and** under the rate limit: insert a `jobs` row with
     `dedupe_key = 'msg:<inbound_id>'`.
   - Duplicate → no job, still 200. Over limit → no job, one throttling notice per minute.
3. **Ack.** `200 {"status":"ok"}`. Nothing else happens on the request thread.
4. **Claim.** Worker runs `N` loops; each loop claims one job with `FOR UPDATE SKIP LOCKED`,
   excluding conversations that already have a running job. A partial unique index is the backstop.
5. **Agent.** Load conversation + last 8 turns. Up to 6 LLM/tool steps. Every tool call is
   validated against state, and the booking path is guarded by DB constraints.
6. **Persist + send.** Transcript and state commit, outbox row inserted, sender poller delivers
   (mock: mark sent). On success the job is `done`; on transient failure it is requeued with
   exponential backoff; after `max_attempts` it is `dead`, the conversation is handed off, and the
   patient gets an apology instead of silence.

---

## 4. Data model

Postgres 16. All timestamps `timestamptz`. `gen_random_uuid()` for ids.

```sql
CREATE TABLE inbound_messages (
  id            bigserial PRIMARY KEY,
  wa_message_id text        NOT NULL UNIQUE,      -- dedupe lives here
  phone         text        NOT NULL,
  type          text        NOT NULL,             -- text | image | audio | ...
  text_body     text,
  raw           jsonb       NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE,
  display_name    text,
  state           jsonb NOT NULL DEFAULT '{}',    -- test_id, offered_slots, selected_slot, booking
  status          text NOT NULL DEFAULT 'active'  -- active | human | closed
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
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_by_conversation ON messages (conversation_id, id);

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'message',  -- message | (reserved) reconcile
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL DEFAULT '{}',
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
CREATE UNIQUE INDEX jobs_one_running_per_conversation
  ON jobs (conversation_id) WHERE status = 'running';   -- ordering backstop

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
-- THE no-double-booking constraint. A slot can have at most one active
-- (pending or confirmed) booking across the entire system.
CREATE UNIQUE INDEX bookings_one_active_per_slot
  ON bookings (slot_id) WHERE status IN ('pending','confirmed');
-- Retries reuse the key; a failed row releases both constraints.
CREATE UNIQUE INDEX bookings_active_idempotency
  ON bookings (idempotency_key) WHERE status IN ('pending','confirmed');

CREATE TABLE llm_usage (
  id              bigserial PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  run_id          uuid NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  prompt_tokens   integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cached_tokens   integer NOT NULL DEFAULT 0,
  cost_usd        numeric(12,8) NOT NULL DEFAULT 0,
  latency_ms      integer,
  outcome         text NOT NULL DEFAULT 'ok',      -- ok | error | fallback | budget_blocked
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_by_conversation ON llm_usage (conversation_id, created_at);

CREATE TABLE rate_limits (
  phone        text NOT NULL,
  window_start timestamptz NOT NULL,               -- date_trunc('minute', now())
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, window_start)
);

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason          text NOT NULL,
  source          text NOT NULL,                   -- agent | budget | retry_exhausted
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  to_phone        text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','failed')),
  dedupe_key      text UNIQUE,                     -- idempotent sends
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (status, created_at);
```

### Conversation state (JSONB)

```json
{
  "test_id": "cbc",
  "patient_name": "Asha",
  "offered_slots": [{"slot_id":"cbc-2026-11-21-0900","label":"Sat 21 Nov, 9:00 AM"}],
  "selected_slot": "cbc-2026-11-21-0900",
  "booking": {"id":"…","status":"confirmed","lab_booking_id":"lab_…"},
  "last_intent": "book_test"
}
```

State is written only by the worker, inside the job lease. The partial unique index makes concurrent
writers impossible for the same conversation.

---

## 5. API contract

### `GET /webhook` — Meta verification handshake

| Query | Rule |
|---|---|
| `hub.mode=subscribe` | required |
| `hub.verify_token` | must equal `WHATSAPP_VERIFY_TOKEN` |
| `hub.challenge` | echoed as `text/plain` |

`200` + challenge on success, `403` otherwise.

### `POST /webhook` — inbound events

Headers: `X-Hub-Signature-256: sha256=<hmac>` (required), `Content-Type: application/json`.

Request (abridged WhatsApp Cloud API shape):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WABA_ID",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15550001111", "phone_number_id": "PNID"},
        "contacts": [{"profile": {"name": "Asha"}, "wa_id": "919800000001"}],
        "messages": [{
          "from": "919800000001",
          "id": "wamid.HBgM…",
          "timestamp": "1763640000",
          "type": "text",
          "text": {"body": "I'd like a CBC tomorrow"}
        }]
      }
    }]
  }]
}
```

Responses:

| Code | Body | When |
|---|---|---|
| `200` | `{"status":"ok"}` | accepted, duplicate, ignored status event, or rate-limited (still acked) |
| `400` | `{"error":"malformed payload"}` | body is not valid JSON / missing `entry` |
| `401` | `{"error":"invalid signature"}` | missing/mismatched HMAC |

**Never 409 for duplicates** — Meta treats non-2xx as failure and retries harder.
Contract: *accept once, process once*.

### `GET /metrics`

Default: Prometheus text. `?format=json` or `Accept: application/json`: JSON summary including
`conversations[]` with per-conversation tokens, cost, turns, bookings.

Metrics exposed:

```
gateway_webhook_requests_total{status}
gateway_webhook_duration_seconds_bucket / _sum / _count     (ack latency)
gateway_duplicate_messages_total
gateway_rate_limited_total
gateway_jobs_total{outcome="done|retried|dead"}
gateway_queue_depth{status="queued|running|dead"}
gateway_job_duration_seconds
gateway_lab_calls_total{op="slots|book",outcome}
gateway_lab_retries_total
gateway_bookings_total{status="confirmed|slot_taken|failed"}
gateway_llm_calls_total{provider,model,outcome}
gateway_llm_tokens_total{kind="prompt|completion"}
gateway_llm_cost_usd_total
gateway_llm_fallback_total
gateway_conversation_tokens{conversation,phone,kind}
gateway_conversation_cost_usd{conversation,phone}
```

### Operational

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | process liveness, no DB |
| `GET /readyz` | DB `SELECT 1`, 503 if unavailable |
| `GET /api/conversations` | last 50 conversations with state/usage (demo/ops) |
| `GET /api/conversations/:phone` | transcript + state + bookings + per-conv usage |
| `GET /api/bookings` | bookings with slot/status (invariant checks) |
| `GET /dev/outbox?phone=` | mock WhatsApp delivery log (DEV_MODE) |
| `POST /dev/simulate` | builds a signed payload and calls the real webhook in-process (DEV_MODE) |
| `GET /demo` | operator console (DEV_MODE) |

`/api/*` and `/dev/*` are disabled when `DEV_MODE=false`; a real deployment must put them behind
the lab's SSO/VPN. They expose synthetic data only.

---

## 6. Failure matrix — the 25-point section

| # | Failure | What happens | Why it is safe |
|---|---|---|---|
| 1 | Same webhook delivered twice (Meta retry) | Second insert conflicts, no job, 200 returned | `UNIQUE(wa_message_id)`; dedupe is durable, not in-memory |
| 2 | Burst of 1,000 webhooks | Ack path only does one indexed write; queue absorbs it | No LLM/lab call on the request thread; `FOR UPDATE SKIP LOCKED` |
| 3 | Lab times out **after** committing | Client retries with the same `Idempotency-Key`; lab replays the booking | Idempotency key stored on the booking row; mock lab dedupes by key |
| 4 | Two patients pick the same slot simultaneously | First inserts `pending`; second violates `bookings_one_active_per_slot` and gets `SLOT_TAKEN` without calling the lab | DB partial unique index is the arbiter |
| 5 | Worker crashes mid-job | Lease expires; reaper requeues; replay reuses the same idempotency key | Side effects are idempotent; state is committed only at the end |
| 6 | Lab is down for a whole job | Job-level exponential backoff, then dead + human handoff | No silent loss; bounded attempts |
| 7 | LLM key exhausted / free tier 429 / model deprecates | Retry, then fall back to the next free model, then to the deterministic responder | Agent still completes the booking; metric `gateway_llm_fallback_total` increments |
| 8 | LLM goes off-script (bad slot, hallucinated id) | Tool validates against `state.offered_slots` and DB; returns typed error to model | Model intelligence is not part of the correctness proof |
| 9 | Phone floods the gateway | Rate limit suppresses jobs; one throttle notice per minute | Protects LLM spend and the lab API |
| 10 | Spend cap reached | Circuit breaker flips to mock/deterministic responder | Hard ceiling, reported in metrics |

### Retry policy

| Layer | Attempts | Backoff | Timeout | Notes |
|---|---|---|---|---|
| Lab `check_slots` | 3 | 250 ms × 3ⁿ ± jitter | 3 s | Retries 5xx/timeouts; not 4xx |
| Lab `book_test` | 3 | 300 ms × 3ⁿ ± jitter | 2 s | **Same** idempotency key on every attempt |
| Job | 6 | 0.5 s × 2ⁿ, capped 30 s, ±30% | — | `run_at` scheduled; dead-letter → handoff |
| LLM call | 3 | 500 ms × 2ⁿ, honour `Retry-After` | 30 s | Model fallback chain, then deterministic |
| Outbox send | 5 | 1 s × 2ⁿ | 10 s | At-least-once delivery; dedupe key per message |

Jitter is full-ish (±50% for lab, ±30% for jobs) to avoid thundering herds after an outage.

### Ambiguous lab outcome (the hard case)

```
worker: INSERT pending booking (slot reserved, key K) → COMMIT
worker: POST /bookings {Idempotency-Key: K} ──► lab commits, response times out
worker: retry with K ─────────────────────────► lab returns the SAME booking
worker: UPDATE booking SET confirmed, lab_id  → COMMIT
```

If all retries fail, `GET /bookings/by-key/K` reconciles before declaring failure. A pending
booking is never released while the lab might have committed; releasing is the only way to
double-book, so the default is to keep the reservation and hand off to a human.

---

## 7. Agent design

### Tools (JSON Schema, OpenAI tool-call format)

| Tool | Input | Behaviour |
|---|---|---|
| `check_slots` | `{test_id, date?}` | `GET /slots`; writes `test_id`/`offered_slots` to state; returns available slots with human labels and ids |
| `book_test` | `{slot_id, patient_name?}` | Validates `slot_id ∈ state.offered_slots`; reserves in DB; calls lab with idempotency key; returns `CONFIRMED`, `SLOT_TAKEN` (+ fresh slots) or `RETRY_LATER` |
| `handoff_to_human` | `{reason}` | Sets conversation `human`, writes handoff, sends "a colleague will take over" |

### State machine (guards around the model)

```
GREETING ──test chosen──► SLOTS_OFFERED ──slot chosen──► CONFIRMING ──► BOOKED
    │                          │                              │
    │                          └──slot taken──────────────────┘ (re-offer)
    └──asks for human / 2 tool failures / token budget────────► HANDOFF
```

The LLM chooses intent and arguments. The runner owns the transitions and enforces:
- `book_test` is impossible unless the slot was offered in this conversation.
- One active booking per conversation; a second `book_test` returns the existing booking.
- Max 6 model steps per turn, max 20k tokens per conversation, max 3 turns of tool errors.
- `HANDOFF` is terminal for automation; later messages are stored but not answered by the LLM.

### Prompt and context budget

- System prompt: role, today's date, lab's tests, state JSON, hard rules. Cached (static prefix).
- History: last 8 turns, tool payloads truncated to 500 chars.
- `max_tokens`: 300 per turn; temperature 0.2.
- Target: ≤ 2.5k prompt tokens per turn; cached prefix cuts effective input cost.

### Model choice and fallback

- Default in dev/test/load: `LLM_PROVIDER=mock` (deterministic, zero quota, zero cost).
- Demo: OpenRouter free models (`:free`), primary `nvidia/nemotron-3.5-lightning:free`, fallbacks
  `inclusionai/ling-3.2-flash:free`, `google/gemma-4-31b-it:free`, `openrouter/free`.
- Free tier reality: **20 req/min, 50 req/day** without a $10 lifetime top-up. The demo needs
  ~25 calls, so this is sufficient *only* if iteration uses the mock. `MAX_LLM_CALLS_PER_DAY`
  (default 45) is enforced in code; when hit, the deterministic responder takes over.
- Weak models are expected: tool JSON is validated, errors are returned as text for the model to
  self-correct, and the deterministic path can finish the booking if the model never emits a tool.

### Why the LLM is not in the correctness path

The model can only *propose*. Slot availability, idempotency, reservation and confirmation are
database operations with constraints. A hallucinating model can annoy a patient; it cannot
double-book one.

---

## 8. Cost estimate

### Assumptions (1 M messages/month)

- 1 M inbound user messages ≈ 33 k/day ≈ 0.39 msg/s average, 1 k-message bursts.
- 1.35 LLM calls per message on average; 45% of turns are handled by deterministic flows
  (menu, confirmation, duplicates, rate-limited) → **600 k LLM calls/month**.
- ~1,200 prompt tokens (cached system+tools ~800) and ~120 completion tokens per call.

### LLM (INR at ₹88/USD)

| Model | $/M in | $/M out | Monthly USD | Monthly INR |
|---|---|---|---|---|
| OpenRouter free (`:free`) | 0 | 0 | 0 | **₹0** (rate-limited; not production-viable) |
| Gemini 2.5 Flash-Lite | 0.10 | 0.40 | ~$101 | **~₹8,900** |
| Gemini 2.5 Flash | 0.30 | 2.50 | ~$396 | **~₹34,800** |
| GPT-4.1-mini class | 0.40 | 1.60 | ~$403 | **~₹35,500** |

With 50% prompt caching on the static prefix, Flash-Lite lands near **₹7,000–9,000/month**.

### Infra (1 M msgs/month, single region)

| Item | Spec | USD/mo | INR/mo |
|---|---|---|---|
| API | 1 vCPU / 1 GB, 2 instances | $24 | ₹2,100 |
| Worker | 1 vCPU / 1 GB | $12 | ₹1,050 |
| Postgres | managed, 2 GB + backups | $20 | ₹1,760 |
| Logs/metrics/egress | — | $5 | ₹440 |
| **Infra total** | | **~$61** | **~₹5,400** |

### WhatsApp

Service conversations inside the 24-hour user-initiated window are free. This flow is entirely
user-initiated, so WhatsApp message fees are **₹0**. Proactive templates (reminders) would add
roughly ₹0.10–0.15 per message and are out of scope.

**Total at 1 M messages/month: ~₹12,400–14,400 (Flash-Lite)**, ≈ **₹0.012–0.015 per message**.
Detailed sensitivity analysis and the free-tier dev budget live in `COST.md`.

---

## 9. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | HMAC verify (good/bad/missing), payload parse (text, statuses, malformed), backoff/jitter bounds, idempotency-key stability, mock-LLM decisions | Vitest, no DB |
| Integration | Webhook → job → agent → booking, against real Postgres and the real mock-lab | Vitest + a throwaway test database |
| Failure | Lab 20% failure; 100% failure; timeout-after-commit; worker lease expiry; concurrent same-slot bookings | Deterministic lab modes (`FAIL_RATE`, `FAIL_MODE`) |
| Invariants | `count(confirmed bookings per slot) ≤ 1`; `count(jobs per inbound) = 1`; no job without inbound; no confirmed booking without a lab id | SQL assertions after each scenario |
| Load | 1,000 messages, 20% duplicates, concurrency 50, mock LLM (₹0) | `scripts/load.ts`; writes `LOAD_REPORT.md` |
| Manual | 3–5 min video: happy path, duplicate proof, slot race, lab failure, metrics/cost | `VIDEO_SCRIPT.md` |

The load test is deliberately run with the mock LLM: real free-tier calls (50/day) would make the
test non-repeatable and the result would measure OpenRouter's queue, not ours. The report states
this and includes the equivalent token/cost projection from `llm_usage`-shaped mock usage.

---

## 10. Deployment and operations

- **Local:** `docker compose up` → Postgres, migrations, API :3000, worker, mock-lab :4000,
  demo console at `/demo`.
- **Production shape:** API replicas behind a load balancer; worker replicas (the queue is
  multi-consumer safe); managed Postgres with PITR; secrets from the platform's secret store.
- **Scaling:** ack path is O(1) writes; workers scale by adding replicas. Per-conversation
  ordering is preserved by the claim query + partial unique index. At 1 M/month the average load
  is trivial; burst capacity is the design target.
- **Alerting:** `queue_depth{queued} > 500 for 2 min`, `webhook p99 > 200 ms`, `dead > 0`,
  `lab_calls{outcome=error} > 20% for 5 min`, `llm_cost_usd` daily > budget.
- **Security:** HMAC on every request; raw-body verification; secrets only in env; `/api` and
  `/dev` disabled outside dev; no patient data beyond synthetic fixtures; logs redact phone
  numbers to last 4 digits where possible.

---

## 11. Milestones (24 h)

| Window | Deliverable |
|---|---|
| 0:00–0:45 | PLAN.md (this file), history reset so this is commit #1 |
| 0:45–3:00 | Schema/migrations, webhook (HMAC, dedupe, rate limit), Postgres queue, unit tests |
| 3:00–6:00 | Worker, agent loop, tools, mock-lab, deterministic LLM, integration tests |
| 6:00–9:00 | Booking correctness (reservation, idempotency, reconciliation), failure/chaos tests |
| 9:00–11:00 | Metrics (Prometheus + JSON), per-conversation tokens/cost, cost circuit breaker |
| 11:00–13:00 | Load script, 1,000-message run, LOAD_REPORT.md |
| 13:00–15:00 | Dockerfile/compose, demo console, README, COST.md, AI_USAGE.md |
| 15:00–17:00 | Deploy attempt (free tier) or recorded compose build, video script + recording |
| 17:00–20:00 | Buffer: fix findings, polish, final submission |

---

## 12. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Free-model quota (50/day) exhausted before the demo | Medium | Mock by default; probe once; `MAX_LLM_CALLS_PER_DAY`; scripted fallback |
| Free model cannot do tool calls reliably | Medium | Probe 3 candidates; validate tool JSON; deterministic responder fallback |
| macOS Docker build slow / daemon down | Medium | Single multi-stage image, alpine, build cache; start Docker early |
| Double booking via a subtle race | Low | DB constraints + concurrency test that asserts exactly one confirmed per slot |
| Time lost to a demo UI | Low | Console is explicitly last; core first, video can use curl |
| No LLM key / no card for deployment | High | Mock provider works end-to-end; compose is the graded artifact; HF Spaces optional |

---

## 13. What "done" means

- `docker compose up` from a clean clone serves `/webhook`, `/metrics`, `/demo`, and processes
  messages end to end without any paid service.
- 1,000-message load run: p99 ack < 200 ms, duplicates suppressed exactly, queue drained,
  **zero double bookings**, report committed.
- Tests cover the four correctness failures (duplicate, timeout-after-commit, slot race, crash).
- README states run steps, architecture, invariants and **actual ₹ spend**.
- COST.md models 1 M messages/month with sensitivity.
- AI_USAGE.md is a truthful log of tools, prompts and what was verified.
