# WALKTHROUGH — the whole project, file by file

Read this before the interview. It is the mental model, the exact request path, what every
file is for, how to run and test each piece, and the questions you are likely to get.

If you only have 10 minutes: read **§0, §2, §4, §5, §10**.

---

## 0. The one-paragraph mental model

There are **two processes and one database**:

- **API** (`src/api.ts`) is a bouncer. It verifies the HMAC, turns the webhook into rows, and
  returns 200. It never calls the LLM or the lab.
- **Worker** (`src/worker.ts`) is the brain. It claims jobs from Postgres, runs the agent,
  calls the lab, and writes replies to an outbox.
- **Postgres** is the source of truth. Dedupe, ordering, rate limits, conversation state and —
  most importantly — **slot ownership** are database facts, not application conventions.

The model can *propose*. The database *decides*. That sentence is the whole design.

---

## 1. The 60-second architecture

```
Meta ──POST /webhook──► API
                         ├─ verify X-Hub-Signature-256 over the raw bytes
                         ├─ parse entry[].changes[].value.messages[]
                         ├─ one SQL statement:
                         │    INSERT inbound ON CONFLICT (wa_message_id) DO NOTHING
                         │    upsert conversation
                         │    bump rate_limits(phone, minute)
                         │    INSERT job  (only if the message was new and under limit)
                         └─ 200 {"status":"ok"}   ← 4–5 ms, no LLM, no lab

Postgres
  inbound_messages  UNIQUE(wa_message_id)              ← durable dedupe
  jobs              SKIP LOCKED queue + lease + one-running-per-conversation
  bookings          UNIQUE(slot_id) WHERE active       ← no double booking
  conversations / messages / llm_usage / handoffs / outbox / rate_limits / lab_calls

Worker
  ├─ claim one job (SKIP LOCKED, skip conversations already running)
  ├─ Agent: system prompt + last 8 turns → LLM → tools → repeat (max 6 steps)
  │    check_slots · book_test · handoff_to_human
  ├─ BookingService: reserve slot in DB → call lab with Idempotency-Key
  ├─ write transcript + outbox (dedupe key = inbound message id)
  └─ outbox loop: WhatsAppSender (mock by default)
```

Two invariants worth memorising:

1. **A `wamid` can create at most one job.** (`UNIQUE(wa_message_id)`)
2. **A slot can have at most one active booking.** (`UNIQUE(slot_id) WHERE status IN ('pending','confirmed')`)

Everything else is resilience around those two facts.

---

## 2. One message, end to end (the path to be able to narrate)

Take: patient sends "I want a CBC tomorrow", then "1".

### Step 1 — HTTP and raw body

`src/http/app.ts` → `buildApp()`

Fastify is created with a **custom JSON parser** (`parseAs: 'buffer'`). It stores the exact
bytes on `request.rawBody` and then parses JSON. Why: Meta signs the raw bytes; re-serialising
the parsed object changes whitespace and breaks the HMAC.

### Step 2 — Verify

`src/whatsapp/signature.ts` → `verifySignature(rawBody, header, secret)`

- Requires `X-Hub-Signature-256: sha256=<64 hex>`.
- Computes `HMAC-SHA256(secret, rawBody)`.
- Compares with `timingSafeEqual`.
- Missing/malformed/wrong → **401**, before any parsing or DB work.

### Step 3 — Parse the Cloud API shape

`src/whatsapp/payload.ts` → `parseWebhookPayload(body)`

Walks `entry[].changes[].value.messages[]`, returns
`{waMessageId, phone, type, text, displayName}`. Status-only events return `[]` (still 200).
Non-text messages get `text: null` so the agent can reply "I can only read text".

### Step 4 — Ingest (the important SQL)

`src/db/repo.ts` → `ingestInbound(input, limitPerMinute)`

One statement, four CTEs:

```sql
WITH ins AS (
  INSERT INTO inbound_messages (wa_message_id, phone, type, text_body, raw)
  VALUES ($1,$2,$3,$4,$5::jsonb)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id
), conv AS (
  INSERT INTO conversations (phone, display_name, last_message_at)
  SELECT $2, $6, now() FROM ins
  ON CONFLICT (phone) DO UPDATE SET last_message_at = now()
  RETURNING id
), rl AS (
  INSERT INTO rate_limits (phone, window_start, count)
  SELECT $2, date_trunc('minute', now()), 1 FROM ins
  ON CONFLICT (phone, window_start) DO UPDATE SET count = rate_limits.count + 1
  RETURNING count
), job AS (
  INSERT INTO jobs (kind, conversation_id, payload, dedupe_key, max_attempts)
  SELECT 'message', conv.id,
         jsonb_build_object('inbound_id', ins.id::text, ...),
         'msg:' || $1, $7
  FROM ins, conv, rl
  WHERE rl.count <= $8
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id
)
SELECT (SELECT id FROM ins), (SELECT id FROM conv), (SELECT count FROM rl), (SELECT id FROM job);
```

Why it is shaped like this:

- If the `wamid` exists, `ins` is empty, so **every** downstream CTE is empty: no duplicate
  conversation touch, no rate-limit bump, no job. The route sees `duplicate: true` and still
  returns 200.
- The rate limit is a **fixed 1-minute window** (`date_trunc('minute', now())`). The third
  message over the limit is stored in `inbound_messages` but no job is created. The route then
  inserts one "slow down" outbox message per phone+minute (dedupe key), so a flood doesn't
  produce a flood of replies.
- The job payload carries the inbound row id, not the whole payload. The worker re-reads it.

Why one statement: fewer round trips, and the duplicate decision is atomic. Ack p99 is 50 ms
across the 1,000-message load run.

### Step 5 — Ack

`app.ts` records `gateway_webhook_duration_seconds`, a rolling ack-latency window, and returns
`200 {"status":"ok"}`. **Never 409 for duplicates** — Meta treats non-2xx as failure and
retries harder.

If the DB is down, the route returns **503** on purpose, so Meta retries later. That is the
one case where a non-200 is correct.

### Step 5.5 — There are **two** HTTP conversations (read this twice)

This is the most common point of confusion, and a likely interview question.

```
Conversation 1 (synchronous, milliseconds)
  Meta ──POST /webhook──► API
  Meta ◄──200 {"status":"ok"}── API        ← this is NOT the patient's reply
                                            it means "I have durably accepted the event"

Conversation 2 (asynchronous, seconds later)
  Worker ──POST graph.facebook.com/.../messages──► Meta ──► patient's phone
```

- The `200` from `/webhook` goes **to Meta**, not to the patient. Meta never shows it to the
  user. It only says "stop retrying this delivery".
- The patient's reply is a **new outbound API call** made later by the worker, from the
  `outbox` table. In this repo it is mocked by default; with `MOCK_WHATSAPP=false` it is the
  real Graph API call.
- That is why the handler can take 3–8 seconds with the real model and the webhook still acks
  in 5 ms. They are different requests, different processes, different clocks.

The timeline for one message:

| Time | What happens | Where |
|---|---|---|
| 0 ms | Meta POSTs the webhook | `POST /webhook` |
| ~1 ms | HMAC verified, payload parsed | `signature.ts`, `payload.ts` |
| ~2–5 ms | Inbound row + conversation + rate limit + job committed **in one SQL statement** | `repo.ingestInbound` |
| ~5 ms | `200 {"status":"ok"}` returned to Meta | `http/app.ts` |
| 5–105 ms | A worker loop polls, claims the job (`status='running'`, lease set) | `repo.claimJob` |
| +50 ms–6 s | Agent runs, tools run, lab is called, booking confirmed | `agent/`, `booking/` |
| same job | Reply text written to `messages` **and** `outbox` | `agent.reply` |
| +0–150 ms | Outbox loop claims the row and sends it | `runtime.outboxLoop` |
| +100 ms–300 ms | Meta delivers the WhatsApp message to the phone | Graph API |

So: **the webhook response is an acknowledgement, not a reply.** If the worker is down, the
job stays `queued` in Postgres and no reply is sent; when the worker starts, it drains the
backlog. Nothing is lost because the job was committed before the 200.

Why not do the work inside `/webhook` and return the reply? Because Meta's timeout is tight,
the LLM and lab are slow/flaky, and Meta retries non-2xx aggressively. Doing the work inline
would turn every lab timeout into a duplicate booking risk and a duplicate reply.

The demo console makes this look synchronous because it **polls**: it POSTs `/dev/simulate`
(which calls the real `/webhook` in-process), gets the ack, then polls
`/api/conversations/:phone` every 1.5 s and renders the transcript from the database. What you
see in the chat panel is the transcript, not the HTTP response of the webhook.

### Step 6 — Claim a job

`src/worker/runtime.ts` starts `WORKER_CONCURRENCY` loops (default 8), one outbox loop, and a
5-second reaper. Each loop calls `claimJob(workerId)` in `repo.ts`:

```sql
WITH candidate AS (
  SELECT j.id FROM jobs j
  WHERE j.status='queued' AND j.run_at <= now() AND j.attempts < j.max_attempts
    AND NOT EXISTS (
      SELECT 1 FROM jobs r
      WHERE r.conversation_id = j.conversation_id AND r.status='running'
    )
  ORDER BY j.run_at, j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs SET status='running', locked_by=$1, locked_at=now(), attempts=attempts+1
FROM candidate WHERE jobs.id=candidate.id
RETURNING ...;
```

Two things to say in the interview:

- `SKIP LOCKED` lets 8 workers claim different jobs without blocking each other.
- The `NOT EXISTS` **and** the partial unique index
  `jobs_one_running_per_conversation` guarantee one running turn per conversation, so
  "book CBC" is processed before "1" even with 8 loops. If two workers race, one UPDATE
  violates the index (23505) and `claimJob` returns `null`; the loop tries again.

### Step 7 — Handle the job

`src/worker/handler.ts` → `handleJob(job, deps)`

1. Load `inbound_messages` by `job.payload.inbound_id` and the conversation.
2. If the conversation is `human` (a person took over), store the message and **do not call
   the LLM**. This is the cost saver and the handoff contract.
3. Otherwise call `Agent.handle(...)`.
4. `completeJob(job.id)`.

If the handler throws, `runtime.ts` calls `failJob(job.id, error, backoff)`:

- attempts < max (6): status `queued`, `run_at = now() + backoff`.
  Backoff: `min(30s, 500ms × 2^(attempt-1))` with ±30% jitter.
- attempts >= max: status `dead`, then `onDeadJob()` creates a handoff and an apology
  outbox message. A dead job is never silent.

### Step 8 — The agent loop

`src/agent/agent.ts` → `Agent.handle(input)`

1. Append the inbound message to `messages` with dedupe key `in:<inboundId>`.
   A retried job cannot duplicate the transcript row.
2. If text is empty → "I can only read text" and return.
3. Load the last 8 user/assistant turns (`repo.getHistory`). Ordering is
   `ORDER BY messages.id DESC LIMIT 8`, then reversed in JS. (This was a real bug — see §11.)
4. Build the prompt: static rules first, then tests, then today's date, then
   `Conversation state JSON`. The static prefix is what a provider cache would hit; dynamic
   state is at the end on purpose.
5. Loop up to `MAX_AGENT_STEPS` (6):
   - Refresh the system message with the latest state (so tool state changes are visible).
   - If `tokens_in + tokens_out + this run > 20,000` → handoff.
   - `client.chat({messages, tools, state})`.
   - Record usage in `llm_usage` and add to the conversation totals.
   - If tool calls: append the assistant tool-call message, run each tool, append a `tool`
     message, persist the tool call to `messages` (for the demo/transcript), save any state
     patch, and continue.
   - If text: that is the reply, break.
   - Empty completion: switch to the deterministic provider once and retry.
   - LLM error: switch to deterministic once; if it fails again, hand off.
   - 2 transient tool failures (`LAB_UNAVAILABLE`, `TOOL_FAILED`) → handoff.
6. If no reply after 6 steps → handoff with an apology.
7. `reply()` writes the assistant message (`out:<inboundId>`) and an outbox row
   (`outbox:<inboundId>`). One reply per inbound message, even across retries.

### Step 9 — Tools

`src/agent/tools.ts` → `runTool(name, args, ctx)`

**`check_slots({test_id, date?})`**

- lowercase + validate `test_id` against the five tests.
- `date` defaults to tomorrow in IST.
- Calls `LabClient.checkSlots`, then filters out slots that our DB already has active
  bookings for (`activeBookedSlotIds`). The lab's availability feed can be stale; **our
  reservation wins**.
- Writes `{test_id, date, offered_slots}` to conversation state and returns the list.

**`book_test({slot_id, patient_name?})`**

- Requires `state.test_id`.
- If `state.booking.status === 'confirmed'`, return the existing booking (no second call).
- `slot_id` must be in `state.offered_slots`.
- **Explicit-choice guard:** the patient's current message must contain a number 1–9, an
  ordinal ("first"), or the exact slot id. ISO dates are stripped first so "2027-01-19"
  does not count as a choice. The model cannot book from "book me a CBC".
- `BookingService.book(...)` (next section).
- On `SLOT_TAKEN`, refresh slots and write them back, so the model can re-offer.
- On success, write `selected_slot` + `booking` to state and return the lab booking id.

**`handoff_to_human({reason})`**

- Inserts a `handoffs` row, sets `conversations.status='human'`, returns `handoff: true`.
  The agent sends the handoff text and stops.

### Step 10 — The booking decision

`src/booking/service.ts` → `BookingService.book(input)`

This is the 25-point section. Narrate it in this order:

1. **Deterministic key**: `sha256(conversationId | slotId | testId)`. Every retry — even
   after a crash — produces the same key.
2. If a **confirmed** booking already exists for that key → return it (`cached: true`). No
   lab call.
3. Otherwise **reserve the slot in our DB** before any HTTP:
   `INSERT INTO bookings (...) VALUES (..., 'pending') ON CONFLICT DO NOTHING`.
   The partial unique indexes on `slot_id` and on `conversation_id` (both `WHERE status IN
   ('pending','confirmed')`) make this the single arbiter.
4. If the insert lost:
   - same key? use that row (retry after crash);
   - same conversation? return the existing booking (idempotent);
   - same slot? `SLOT_TAKEN`, **without calling the lab**;
   - otherwise `LAB_UNAVAILABLE`.
5. Call the lab with `Idempotency-Key: <key>`, 3 attempts, 2 s timeout, exponential backoff.
6. Lab 2xx → update the row to `confirmed` with `lab_booking_id`.
7. Lab 409 → mark `failed` (releases both unique indexes), return `SLOT_TAKEN`.
8. Any other failure/timeout → **reconcile**: `GET /bookings/by-key/<key>`.
   - Found? The lab committed; mark confirmed. This is the committed-then-lost case.
   - Not found? Leave the row `pending`, return `LAB_UNAVAILABLE`. The job will retry with
     the same key. If the job dies, the slot stays reserved and the conversation is handed
     to a human. Releasing a slot the lab *may* have committed is the only way to
     double-book; we never do it automatically.

### Step 11 — Send

`src/worker/runtime.ts` → `outboxLoop()` claims one row with `FOR UPDATE SKIP LOCKED`
(reclaims `sending` rows older than 2 minutes), calls `WhatsAppSender.send`, marks `sent`.
On failure, up to 5 attempts, then `failed`.

`src/whatsapp/sender.ts`:

- `MOCK_WHATSAPP=true` (default): logs and returns a fake id; the row is the delivery record.
- Otherwise: `POST graph.facebook.com/v21.0/<phoneNumberId>/messages` with the token.

At-least-once is the honest delivery semantic; the outbox dedupe key prevents duplicates
from *our* retries. Meta's API has no idempotency key, so a crash after send before mark-sent
could resend — documented as a limitation.

### Step 12 — Metrics

`GET /metrics` is served by the API, but the work happened in the worker. So business metrics
are **gauges computed from Postgres at scrape time** (`src/metrics/snapshot.ts`):
queue depth, job retries, bookings by status, lab calls, LLM calls/tokens/cost, outbox state,
and one row per conversation. Only webhook counters/histograms are process-local, because
only the API sees webhooks.

`?format=json` returns the same plus p50/p95/p99 ack latency from a 5,000-sample ring buffer.

---

## 3. Every file and what it is for

| File | Purpose | Key things inside |
|---|---|---|
| `PLAN.md` | The design doc; **first commit** | Problem, users, architecture, schema, API, cost, failure matrix, milestones |
| `README.md` | Submission entry point | Run steps, architecture, guarantees, load numbers, spend, trade-offs |
| `COST.md` | 1M messages/month model | Assumptions, LLM/infra/WhatsApp tables, sensitivity, actual spend |
| `AI_USAGE.md` | How AI was used | Tools, workflow, bugs found, prompts, spend |
| `VIDEO_SCRIPT.md` | 3–5 min shot list | Timestamps, exact commands, what to say |
| `LOAD_REPORT.md` | Generated by `npm run load` | 1,000 msgs, p99, dedupe, jobs, bookings, 0 double |
| `LLM_PROBE.md` | Generated by `npm run probe` | Which free model emits a valid tool call, quota |
| `load-report.json` | Machine-readable load artifact | Same numbers for tooling |
| `package.json` | Scripts + deps | `dev`, `test`, `test:int`, `load`, `probe`, `migrate` |
| `tsconfig.json` | TS build | NodeNext ESM, strict, `src`/`mock-lab`/`scripts` |
| `vitest.config.ts` | Test env | Points tests at `heydoc_test`, fail rate 0, short backoff |
| `Dockerfile` | Multi-stage build | deps → build → runtime, `npm prune --omit=dev`, non-root `app` |
| `docker-compose.yml` | Whole stack | postgres, migrate, api, worker, mock-lab; healthchecks |
| `.env.example` | All config, no secrets | mock provider, lab knobs, rate limit |
| `.gitignore` | Keeps `.env` out | node_modules, dist, .env, .opencode |
| `.dockerignore` | Slim build context | node_modules, dist, .env |
| `docker/postgres-init.sql` | Creates `heydoc_test` | Only on first volume init |
| `migrations/001_init.sql` | Schema | All tables + the four critical indexes |
| `migrations/002_lab_calls.sql` | Audit table | One row per lab attempt, for metrics |
| `src/config.ts` | Env parsing + defaults | Every knob, `assertProductionSafety` |
| `src/api.ts` | API entry | `buildApp`, listen, graceful shutdown |
| `src/worker.ts` | Worker entry | builds LabClient/BookingService/Agent/WorkerRuntime |
| `src/http/app.ts` | Fastify app | raw-body parser, `/webhook`, `/metrics`, `/api`, `/dev`, `/demo` |
| `src/whatsapp/signature.ts` | HMAC | `signBody`, `verifySignature` (timing-safe) |
| `src/whatsapp/payload.ts` | Cloud API shape | `parseWebhookPayload`, `buildWebhookPayload` (demo/load) |
| `src/whatsapp/sender.ts` | Outbound boundary | mock or real Graph API |
| `src/db/pool.ts` | pg pool | `withTransaction`, close |
| `src/db/migrate.ts` | Migration runner | Forward-only, one transaction per file, `schema_migrations` |
| `src/db/repo.ts` | **The SQL that matters** | ingest, claims, bookings, usage, outbox, metrics queries |
| `src/worker/runtime.ts` | Loops | N job loops, outbox loop, reaper, graceful stop |
| `src/worker/handler.ts` | One job | load rows, human check, agent, complete; dead-job handoff |
| `src/agent/agent.ts` | The loop | history, prompt, 6 steps, fallback, budget, reply |
| `src/agent/prompt.ts` | System prompt | static rules first, dynamic state last |
| `src/agent/tools.ts` | Tools + guards | schemas, `runTool`, explicit choice, stale-slot filter |
| `src/booking/service.ts` | Booking correctness | reservation, idempotency, reconcile, pending policy |
| `src/lab/client.ts` | Lab HTTP | timeouts, retries, 409 vs 5xx, idempotency key |
| `src/lab/tests.ts` | Catalogue | 5 tests, `istDate`, `isTestId` |
| `src/llm/types.ts` | Provider interface | `LlmClient`, messages, tool calls, errors |
| `src/llm/openrouter.ts` | Real provider | model chain, retries, timeouts, usage, cost |
| `src/llm/mock.ts` | Deterministic provider | asks test → slots → books; used by tests/load/fallback |
| `src/llm/pricing.ts` | Cost table | USD per 1M tokens, cached discount |
| `src/llm/budget.ts` | Spend guard | calls/day + USD cap, per process |
| `src/metrics/registry.ts` | Prom registry | metric names, process-local webhook counters |
| `src/metrics/snapshot.ts` | DB gauges | refresh + JSON snapshot |
| `src/metrics/window.ts` | Ring buffer | p50/p95/p99 for ack latency |
| `src/util/backoff.ts` | Retry math | exponential + jitter, `sleep`, percentiles |
| `src/util/ids.ts` | Keys | UUID, booking key, sha256, token estimate, phone mask |
| `src/util/log.ts` | JSON logs | level filter, no secrets |
| `mock-lab/index.ts` | Mock lab entry | listens on :4000 |
| `mock-lab/server.ts` | Fake lab | 20% failure, before/after/timeout, idempotency replay, admin state |
| `scripts/load.ts` | Load test | 1,000 msgs, 20% dupes, per-phone order, report writer |
| `scripts/llm-probe.ts` | Free-model probe | one tool-call request per candidate, quota check |
| `public/index.html` | Operator console | chat, state, metrics, duplicate button (no build step) |
| `tests/unit/*.test.ts` | 19 unit tests | HMAC, payload, backoff/ids, deterministic policy |
| `tests/integration/gateway.test.ts` | 9 integration tests | dedupe race, 1k burst, slot race, commit-then-timeout, lab down, reaper, rate limit |

---

## 4. Database: why each table and constraint exists

### Tables

| Table | Holds | Notes |
|---|---|---|
| `inbound_messages` | Every webhook message | `UNIQUE(wa_message_id)` is the dedupe |
| `conversations` | One row per phone | `state jsonb`, status, cumulative tokens/cost |
| `messages` | Transcript | user/assistant/tool, `dedupe_key` unique |
| `jobs` | Queue | status, attempts, max, run_at, lease, error |
| `bookings` | Reservations | pending/confirmed/failed, lab id, idempotency key |
| `llm_usage` | One row per LLM call | tokens, cached, USD, latency, outcome |
| `rate_limits` | Phone × minute counters | fixed window |
| `handoffs` | Human takeover log | reason + source |
| `lab_calls` | One row per lab attempt | op, outcome, attempt, latency (metrics) |
| `outbox` | Outbound messages | status, dedupe key, attempts, sent_at |

### The indexes that are the design

```sql
-- 1. Dedupe. One message id, ever.
UNIQUE (wa_message_id)                                  -- inbound_messages

-- 2. Ordering. One running turn per conversation, even with N workers.
CREATE UNIQUE INDEX jobs_one_running_per_conversation
  ON jobs (conversation_id) WHERE status = 'running';

-- 3. No double booking. One active booking per slot, globally.
CREATE UNIQUE INDEX bookings_one_active_per_slot
  ON bookings (slot_id) WHERE status IN ('pending','confirmed');

-- 4. One active booking per conversation (patient can't book two tests by accident).
CREATE UNIQUE INDEX bookings_one_active_per_conversation
  ON bookings (conversation_id) WHERE status IN ('pending','confirmed');

-- 5. Retries reuse the key; a failed row releases it for a legitimate retry.
CREATE UNIQUE INDEX bookings_active_idempotency
  ON bookings (idempotency_key) WHERE status IN ('pending','confirmed');

-- 6. A message produces at most one job.
UNIQUE (dedupe_key)                                     -- jobs
```

Why partial indexes: `failed` bookings must not block the slot forever, and a retry after a
failure must be able to reuse the idempotency key. `WHERE status IN ('pending','confirmed')`
does exactly that.

### Conversation state

```json
{
  "test_id": "cbc",
  "date": "2026-11-21",
  "patient_name": "Asha",
  "offered_slots": [{"slot_id": "cbc-2026-11-21-0900", "label": "Sat, 21 Nov, 9:00 am"}],
  "selected_slot": "cbc-2026-11-21-0900",
  "booking": {"id": "...", "status": "confirmed", "lab_booking_id": "lab_0001_...", "slot_id": "..."}
}
```

State is a **cache for the prompt**, not the source of truth. The `bookings` table and the
unique index are the truth. If state is lost, `book_test` reuses the same idempotency key and
returns the existing booking.

---

## 5. The five failure stories (rehearse these)

### A. The same webhook arrives twice

**Protection:** `UNIQUE(wa_message_id)` + `ON CONFLICT DO NOTHING` in `ingestInbound`.
The second request inserts nothing, enqueues nothing, and still returns 200.
**Say:** "Dedupe is a database fact, not an in-memory set, so it survives restarts and works
across API replicas. Returning 200 matters: Meta retries non-2xx and would make the storm worse."

### B. Two patients choose the same 9:00 slot

**Protection:** `bookings_one_active_per_slot`. The first `INSERT ... 'pending'` wins. The
second insert conflicts, `findActiveBookingBySlot` returns the winner, and the loser gets
`SLOT_TAKEN` **without making a lab call**. The agent refreshes the list (excluding our
reservations) and re-offers.
**Say:** "The loser never races at the lab. The database serialises the decision, and the
409 from the lab is only a second line of defence."

### C. The lab commits but the response is lost

**Protection:** the idempotency key + reconciliation.
The key is `sha256(conversationId|slotId|testId)`. The first attempt commits upstream and
times out. The retry sends the **same** key; the lab replays the original booking. If all
retries fail, `findBookingByKey` asks the lab directly before we declare failure.
**Say:** "This is the case naive retries get wrong: retrying is safe only because the key is
stable and the lab is idempotent. Our row stays `pending`; it is never released on ambiguity."

### D. The worker dies mid-job

**Protection:** the job lease + reaper + idempotent side effects.
`claimJob` sets `locked_at`. A job still `running` after 90 s is requeued by
`reapExpiredJobs` (or marked dead if attempts are exhausted). Replay is safe because the
inbound message row is deduped, the booking key is stable, and the outbox keys are per inbound
message. A retried job cannot duplicate the transcript or the reply.
**Say:** "The queue is at-least-once; every effect is idempotent, so effectively once."

### E. The lab is down for the whole job / the LLM dies

- Lab: 3 attempts per call, job backoff (6 attempts, 0.5s→30s), then **dead** → handoff +
  apology. Never silent.
- LLM: model fallback chain, then the deterministic policy. If that also fails, handoff.
  The booking flow does not depend on model intelligence.
**Say:** "The LLM is not in the correctness path. It can propose; the DB and lab contract
decide."

### Bonus: a stale lab availability feed

The lab says 9:00 is free, but our DB has a confirmed booking. `activeBookedSlotIds` filters
it out before the model sees the list. We found this in the Docker demo after resetting only
one side; it is a good story about the DB being authoritative.

---

## 6. Agent design in more detail

### Why the state machine is in code, not the prompt

```
GREETING → SLOTS_OFFERED → CONFIRMING → BOOKED
                │               │
                └── slot taken ─┘ (re-offer)
                └── human / 2 tool failures / token budget → HANDOFF
```

The prompt asks the model to follow it, but the runner enforces it:

- `book_test` requires `state.test_id`, an offered slot, and an explicit user choice.
- One active booking per conversation (DB index).
- 6 steps, 20k tokens, 2 transient tool failures → handoff.
- `handed off` conversations are stored but not sent to the LLM.

### Why the deterministic provider exists

`MockLlmClient` implements the same `LlmClient` interface. It:
- detects a test from text, calls `check_slots`;
- parses "1"/"first" and calls `book_test`;
- detects "human" and calls handoff;
- reports the confirmation and **never books twice**.

It is used for:
1. tests (reproducible, no quota),
2. the 1,000-message load (free, fast, measures our system not OpenRouter),
3. the fallback when the real model errors, truncates, or hits the budget.

It is not a replacement for the real model; it is the floor.

### The real provider

`OpenRouterClient`:
- model chain: primary + fallbacks;
- 2 attempts per model on 429/5xx; `Retry-After`-friendly backoff;
- 30 s timeout;
- OpenAI-style tool calls;
- usage → `estimateCostUsd` (free models = 0);
- budget check before each call (`MAX_LLM_CALLS_PER_DAY`, `MAX_SPEND_USD`).

The probe (`npm run probe`) makes one `check_slots` request per candidate and writes
`LLM_PROBE.md`. At probe time `nvidia/nemotron-3.5-lightning:free` returned a valid
`check_slots` call; two other candidates were 429. That is why the chain exists.

### Prompt/caching choices

- Static rules first, dynamic date/state last → a provider cache can hit the static prefix.
- Last 8 turns only; tool payloads truncated to 2k chars.
- `max_tokens` 800, temperature 0.2.
- The model sees the state JSON every step, so a tool's state patch is visible immediately.

---

## 7. Metrics and cost

### Why the split

The API sees webhooks but not jobs. The worker sees jobs but not webhooks. If you keep
Prometheus counters in each process, `/metrics` lies depending on which process answers.

So:

- **Process-local** (API only): `gateway_webhook_requests_total`,
  `gateway_webhook_duration_seconds`, `gateway_duplicate_messages_total`,
  `gateway_rate_limited_total`, and the ack ring buffer.
- **DB-derived gauges** (any process, refreshed on scrape): queue depth, jobs retried,
  bookings by status, lab calls by op/outcome, LLM calls/tokens/cost/fallbacks, outbox,
  and per-conversation tokens/cost.

`/metrics?format=json` also returns `webhook.ackLatencyMs` percentiles and the conversation
table. That is what the demo console polls.

### Percentiles in plain English (p50 / p95 / p99)

A percentile is a **value**, not a percentage. "p95 = 11.9 ms" means **95% of requests were
at or below 11.9 ms** (and 5% were slower). It answers "how bad is it for the unlucky users?",
which an average cannot.

Take 100 requests:

- 50 finish in **5 ms**
- 45 finish in **10 ms**
- 4 finish in **50 ms**
- 1 finishes in **500 ms**

Sorted, that is: 50×5, then 45×10, then 4×50, then 1×500.

| Metric | Position | Value | Plain English |
|---|---|---|---|
| p50 (median) | 50th | **5 ms** | Half the users are faster than 5 ms |
| p95 | 95th | **10 ms** | 19 out of 20 are at or below 10 ms; 1 in 20 is slower |
| p99 | 99th | **50 ms** | 99 out of 100 are at or below 50 ms; 1 in 100 is slower |
| max | 100th | **500 ms** | The single worst request |
| average | — | 9.95 ms | Looks fine, but hides that one user waited 500 ms |

The one 500 ms request barely moves the average (9.95 ms) but it is exactly what a user
notices, and exactly what triggers a timeout/retry. That is why the assignment's contract is
stated as a tail number: **p99 < 200 ms**, not "average < 200 ms".

How it is computed here (`src/util/backoff.ts` → `percentiles`):

1. Record every latency.
2. Sort ascending.
3. For pX, take index `ceil(X/100 × N) − 1` (0-based). This is "nearest rank". Other tools
   interpolate between neighbours, so numbers can differ by a fraction of a millisecond; the
   meaning is the same.

Our load run: **p50 4.7 ms · p95 11.9 ms · p99 50.0 ms · max 73.9 ms** over 1,000 requests.
That means 990 of 1,000 acks were ≤ 50 ms, and even the worst was 73.9 ms — under the 200 ms
contract with room to spare. The API also keeps a 5,000-sample ring buffer
(`src/metrics/window.ts`) so `/metrics?format=json` can report the same percentiles live.

p60 would just mean "60% of requests are at or below this value". The naming is always
`p` + the percentage.

### Cost

`COST.md` assumes 1M inbound messages, 40% handled without an LLM, 600k LLM turns, 1.6 calls
per turn, 1,200 prompt + 120 completion tokens, cached prefix at 25%.

- Flash-Lite: ~**₹14,500/month** total (~₹9.1k LLM + ₹5.4k infra), ~**₹0.0145/message**.
- Flash: ~₹46k/month.
- Free models: ₹0 LLM but 20 req/min makes them non-production-viable at 0.39 msg/s.
- Actual assignment spend: **₹0.00**.

Budget: `MAX_LLM_CALLS_PER_DAY=45` and `MAX_SPEND_USD=2`; on breach, the agent uses the
deterministic provider. The per-process counter is a limitation; the DB is the reporting
source of truth. Say that honestly if asked.

---

## 8. Run and test everything (commands + expected)

### Start

```bash
cp .env.example .env
docker compose up --build
docker compose ps
```

Expected: `postgres` healthy, `mock-lab` up, `migrate` exited 0, `api`/`worker` up.

### Health / config

```bash
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz
curl -s localhost:3000/dev/config
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/demo
```

Expected: `{"status":"ok"}`, `{"status":"ready"}`, provider `mock`, `200`.

### Meta handshake

```bash
curl -s "localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=abc123"
# abc123
```

Wrong token → 403.

### Signed webhook (manual, no demo shortcut)

```bash
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"919800000001","id":"wamid.manual.1","type":"text","text":{"body":"CBC"}}]}}]}]}'
SIG="sha256=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | awk '{print $2}')"
curl -s -X POST localhost:3000/webhook -H 'content-type: application/json' -H "x-hub-signature-256: $SIG" -d "$BODY"
# {"status":"ok"}
```

Wrong signature → 401. No job is created.

### Demo flow

```bash
curl -s -X POST localhost:3000/dev/simulate -H 'content-type: application/json' \
  -d '{"phone":"919800000001","text":"I want to book a CBC test","clientId":"demo-1"}'
# send the same clientId again → duplicate; no second job
curl -s -X POST localhost:3000/dev/simulate -H 'content-type: application/json' \
  -d '{"phone":"919800000001","text":"1","clientId":"demo-2"}'
curl -s localhost:3000/api/conversations/919800000001
```

Expected: a `tool` row for `check_slots`, an assistant slot list, a `book_test` tool row, a
confirmed booking, and usage tokens.

### Prove dedupe / no double booking in SQL

```bash
docker compose exec -T postgres psql -U heydoc -d heydoc -c "
select (select count(*) from inbound_messages) inbound,
       (select count(*) from jobs) jobs,
       (select count(*) from outbox) outbox;"

docker compose exec -T postgres psql -U heydoc -d heydoc -c "
select slot_id, count(*) from bookings
where status='confirmed' group by 1 having count(*) > 1;"
# 0 rows
```

### Metrics

```bash
curl -s localhost:3000/metrics | head -40
curl -s 'localhost:3000/metrics?format=json' | node -e '...'   # or pipe to jq
```

Look for `gateway_queue_depth`, `gateway_bookings_state`, `gateway_llm_tokens_24h`,
`gateway_conversation_tokens`.

### Tests

```bash
docker compose up -d postgres        # test DB created by the init script
npm run test                         # 19 unit, no DB
npm run test:int                     # 9 integration, real DB + lab
npm run test:all                     # 28
```

Expected: all pass in ~2 s. The integration suite starts its own mock lab on an ephemeral
port, migrates `heydoc_test`, truncates, and tears down.

### Failure simulations

```bash
# 100% lab failure, before commit → retries then handoff (no booking)
LAB_FAIL_RATE=1 LAB_FAIL_MODE=before docker compose up -d --force-recreate mock-lab worker

# committed then response lost → idempotency replay (exactly one booking)
LAB_FAIL_RATE=1 LAB_FAIL_MODE=after_timeout docker compose up -d --force-recreate mock-lab worker
```

The integration tests cover both deterministically; the env knobs are for manual demos.
Reset the lab between runs: `curl -X POST localhost:4000/__admin/reset`.

### Load test

```bash
npm run load
# resets DB + lab, sends 1,000, waits for queue + outbox drain,
# writes LOAD_REPORT.md + load-report.json
```

Expected: 1,000/1,000 200s, p99 well under 200 ms, 200 duplicates, 800 jobs, 100 bookings,
0 double-booked.

### Real model

```bash
# .env: LLM_PROVIDER=openrouter, OPENROUTER_API_KEY=...
docker compose up -d --build api worker
npm run probe     # one request per candidate; writes LLM_PROBE.md
```

Then `/dev/simulate` a conversation. `llm_usage` shows `provider=openrouter`, tokens and
`cost_usd=0` for free models.

### Reset

```bash
curl -X POST localhost:3000/dev/reset
curl -X POST localhost:4000/__admin/reset
```

---

## 9. Code-reading order (if asked to walk the code)

1. `migrations/001_init.sql` — understand the five indexes.
2. `src/db/repo.ts` — `ingestInbound`, `claimJob`, `reserveBooking`, `confirmBooking`.
3. `src/http/app.ts` — the webhook route and the raw-body parser.
4. `src/booking/service.ts` — the reservation/idempotency/reconcile story.
5. `src/agent/tools.ts` — the guards; then `src/agent/agent.ts` — the loop.
6. `src/worker/runtime.ts` + `handler.ts` — loops, retries, dead letters.
7. `src/lab/client.ts` + `mock-lab/server.ts` — retry and replay.
8. `src/metrics/snapshot.ts` — why gauges from the DB.
9. `tests/integration/gateway.test.ts` — the invariants as executable specs.

---

## 10. Interview Q&A (rapid fire)

**Is the worker using cron?**
No. Cron is an OS scheduler that launches a process on a time schedule (minimum resolution
one minute, overlapping runs, cold starts). The worker is a **daemon**: Docker keeps it
running (`restart: unless-stopped`), and inside it there are 8 `jobLoop()` promises plus one
`outboxLoop()` and a `setInterval` reaper. Each loop is `while (!aborted) { claim; if none
sleep(100ms); }`. That is polling, not cron. Worst-case added latency is one poll interval
(~100 ms for jobs, ~150 ms for outbox, 5 s for the lease reaper). The only timer is the
in-process reaper; it is not a scheduled job either.

**Why Postgres instead of Redis/SQS?**
It is already required for state; `SKIP LOCKED` supports multiple consumers; one fewer
service to operate. At 10× with bursty traffic I would move the queue to SQS/Kafka and keep
Postgres for state and bookings. The claim/lease semantics map directly.

**How exactly do you prevent double booking?**
A partial unique index on `bookings(slot_id) WHERE status IN ('pending','confirmed')`.
The slot is reserved in our DB before the lab is called. A second reservation conflicts and
returns `SLOT_TAKEN` without any lab call. The lab 409 is a second line of defence.

**What if the lab commits and the response is lost?**
The idempotency key is `sha256(conversationId|slotId|testId)`, stable across retries and
restarts. We retry with the same key; the lab replays the original booking. If retries
exhaust, we reconcile with `GET /bookings/by-key/<key>` before failing.

**Why never release a pending booking automatically?**
Because the lab may have committed. Releasing it allows a second booking. The safe default is
to hold the slot and hand off to a human; `failed` is only set when the lab returned 409 or
reconciliation proved no booking exists.

**Why return 200 for duplicates?**
Meta treats non-2xx as delivery failure and retries more. The duplicate is already handled by
the unique constraint, so 200 is the correct idempotent acknowledgement. We return 503 only
when our DB is down and we *want* Meta to retry.

**How is per-conversation ordering guaranteed?**
`claimJob` excludes jobs whose conversation has a `running` job, and the partial unique index
`jobs_one_running_per_conversation` is the backstop. Two workers cannot process two turns of
the same conversation concurrently.

**Why not call the LLM in the webhook?**
Meta's timeout is tight and the LLM is slow. The ack path must be one indexed write. The
worker absorbs the latency, and the queue absorbs bursts.

**What stops the model from booking the wrong slot?**
`book_test` validates the slot against `state.offered_slots`; `check_slots` filters slots our
DB has reserved; and the patient's message must contain an explicit choice (number/ordinal/
slot id). The model can propose, not decide.

**What if the LLM returns garbage arguments?**
The OpenRouter client parses `function.arguments` defensively (`{_raw: ...}` on failure), and
the tool validates types and values. Bad args become a tool error the model can correct, not
a crash.

**How do you handle the 20% lab failure?**
Lab client: 3 attempts, 2 s (booking) / 3 s (slots) timeout, exponential backoff with jitter,
same idempotency key.
Job: 6 attempts with 0.5s→30s backoff. Dead-letter → handoff + apology. The load run had 52
retries and zero dead jobs.

**Why is the outbox separate from the transcript?**
The transcript is the source of truth; delivery is retried independently. The outbox has a
dedupe key per inbound message, so a replayed job cannot send a second reply. The agent never
sends inside a transaction.

**How do you track per-conversation cost?**
Every LLM response is written to `llm_usage` with tokens and estimated USD, and the
conversation's cumulative columns are updated in the same statement. `/metrics?format=json`
returns the per-conversation table; Prometheus exposes gauges.

**Why are business metrics gauges instead of counters?**
The API and worker are separate processes, so per-process counters are inconsistent.
Gauges derived from Postgres at scrape time are correct on any API replica. The trade-off is
a few queries per scrape.

**What are the limitations?**
Mock WhatsApp outbound (no credentials); in-memory mock lab; per-process LLM budget; no
automatic reconciliation job for long-pending bookings; at-least-once outbox; no PII
encryption; `DEV_MODE` endpoints must be disabled in production; no distributed tracing.
Say these before the interviewer finds them.

**What would you do next?**
Persistent lab integration + a reconciliation worker for pending bookings; real WhatsApp
credentials and template messages; partition `llm_usage`/`lab_calls` at 10×; move the queue
to SQS/Kafka; add tracing (OpenTelemetry) and alerting on dead jobs/p99; PII redaction.

**What was the hardest bug?**
`ORDER BY id` on a query that selected `id::text` sorted lexicographically ("10" < "9"), so
the agent sometimes read the wrong last message; booking completion was 77% in the load test.
Fix: `ORDER BY messages.id DESC` + reverse in JS. It looked like an LLM bug and was SQL.

**Why does the mock provider exist? Is that cheating?**
No: it is the deterministic floor for tests/load/fallback. The real model was verified end to
end (4 calls, tools, booking, ₹0). Free tiers are 20 rpm, so a 1,000-message run against the
real model would measure OpenRouter's queue, not the gateway.

**How do you verify webhooks?**
HMAC-SHA256 over the raw bytes with the app secret, compared with `timingSafeEqual`. The raw
body is preserved by a custom Fastify parser; re-serialising the JSON breaks the signature.

**What happens if the DB is down?**
Webhook returns 503 (Meta retries), readiness fails, metrics DB gauges are skipped but basic
process metrics remain. The API does not crash.

**How would you add a new tool?**
Add a `ToolDef` to `TOOL_DEFS`, a case in `runTool`, validate args against state, return
`{data, statePatch?}`, and mention it in the system prompt. The agent loop picks it up.

**How would you add a new LLM provider?**
Implement `LlmClient.chat` (returning text, tool calls, usage, cost) and select it in
`src/worker.ts`. Nothing in the agent or tools changes.

---

## 11. Live-extension recipes (the interview may ask)

- **New test type:** add to `src/lab/tests.ts` (`TESTS`) and the mock lab accepts it
  automatically. Prompt lists tests from the constant.
- **New tool (e.g. `reschedule_booking`):** `TOOL_DEFS` + `runTool` case + a repo function
  that updates the booking and releases/claims slots with the same constraints.
- **Sliding-window rate limit:** replace the `rate_limits` fixed-minute PK with a
  `(phone, bucket_second)` table or a Redis ZSET; keep the same "store but no job" policy.
- **Real WhatsApp:** set `MOCK_WHATSAPP=false`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`;
  `WhatsAppSender` already implements the Graph API call.
- **Persistent lab:** point `LAB_URL` at the real service; implement the same
  `/slots`, `/bookings`, `Idempotency-Key`, and `by-key` contract. Add a reconciliation job
  for `pending` bookings older than N minutes.
- **New metric:** add a gauge in `registry.ts`, set it in `refreshDbGauges`, and include it in
  `metricsSnapshot`. Business data should come from SQL, not process memory.

---

## 12. Honest limitations (memorise one sentence each)

1. Outbound WhatsApp is mocked by default; the real Graph API path exists but is untested
   without credentials.
2. The mock lab is in-memory and reset via `/__admin/reset`; a real lab needs persistence and
   a reconciliation endpoint.
3. The LLM budget is per worker process. Multi-worker deployments should move the counter to
   Postgres/Redis.
4. There is no background reconciler for bookings stuck `pending`; the policy is to hold and
   hand off. That is deliberate, but a production system should add a job that asks the lab
   by idempotency key and resolves them.
5. The outbox is at-least-once; a crash after send before mark-sent can resend. Meta has no
   idempotency key, so this is a real edge.
6. `DEV_MODE=true` exposes `/api` and `/dev` without auth. Production sets it false and/or
   uses `ADMIN_TOKEN`.
7. The load test uses the deterministic provider, not the real model, for reproducibility and
   quota reasons; the real model was verified separately.
8. No PII encryption at rest beyond the database's own controls; logs mask phone numbers but
   transcript content is stored as-is.

---

## 13. Demo

`VIDEO_SCRIPT.md` has the 3:45 shot list. The 30-second version:

1. `docker compose up --build`, `docker compose ps`.
2. `/demo`, send "I want to book a CBC test", then "1" → confirmed booking, state panel.
3. "Send duplicate" → duplicates suppressed, no new job (SQL count).
4. `LOAD_REPORT.md` + the double-booking SQL query → 0 rows.
5. `/metrics?format=json` → per-conversation tokens/cost, ₹0.
6. `npm run test:all` → 28 passed.
