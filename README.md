# HeyDoc WhatsApp Agent Gateway

A backend for a diagnostics lab that takes test bookings on WhatsApp: signed webhooks,
durable queueing, an LLM agent with tools, and a booking path that **cannot double-book**,
even when the lab API is slow and fails 20% of the time.

Built for the HeyDoc AI take-home. The first commit is [`PLAN.md`](./PLAN.md); the design
there is the one implemented here.

| | |
|---|---|
| **Ack latency** | p50 **4.6 ms**, p95 **13.8 ms**, p99 **57 ms** over 1,000 messages |
| **Dedupe** | 200 / 200 duplicate deliveries suppressed, one job per message |
| **No double booking** | 0 across a 10-way slot race and a 1,000-message run |
| **Failure handling** | 20% lab errors absorbed; 0 dead jobs, 0 double bookings |
| **Actual LLM spend** | **₹0.00** (OpenRouter free model; full flow verified) |
| **Tests** | 28 passing (unit + integration against real Postgres and the mock lab) |

---

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000/demo | Operator console (chat simulator + live state + metrics) |
| http://localhost:3000/metrics | Prometheus text (add `?format=json` for the JSON view) |
| http://localhost:3000/healthz · /readyz | Liveness / DB readiness |
| http://localhost:4000/__admin/state | Mock lab's internal bookings and counters |

First boot takes ~20 s (image + migrations). The default provider is the deterministic
mock, so **no API key is needed** and nothing costs money. To use the real free model:

```bash
# .env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

Then `docker compose up -d --build worker api`. The demo badge changes to `openrouter`.

### Try the flow

In `/demo`, send `I want to book a CBC test`, wait for the slot list, then send `1`.
The right-hand panel shows the agent's state, tool calls, booking row, tokens and cost.
Press **Send duplicate** to fire the exact same `wamid` again: the webhook still returns
200, but `duplicates blocked` increments and no second job or reply is created.

Reset between demos (dev only):

```bash
curl -X POST localhost:3000/dev/reset
curl -X POST localhost:4000/__admin/reset
```

---

## Architecture

```
Meta / load script / demo
        │  POST /webhook  (raw-body HMAC, X-Hub-Signature-256)
        ▼
  api (Fastify, stateless)
   └─ ONE SQL statement: inbound INSERT ON CONFLICT DO NOTHING
      + conversation upsert + rate-limit bump + job enqueue
   └─ 200 {"status":"ok"}       ← no LLM, no lab call on this thread

  Postgres 16
   ├─ inbound_messages     UNIQUE(wa_message_id)        ← durable dedupe
   ├─ jobs                 SKIP LOCKED queue + lease + one-running-per-conversation index
   ├─ bookings             UNIQUE(slot_id) WHERE active ← the no-double-booking guarantee
   ├─ conversations / messages / llm_usage / handoffs / outbox
   └─ rate_limits / lab_calls

  worker (N loops, same image)
   ├─ claim: FOR UPDATE SKIP LOCKED, excludes conversations with a running job
   ├─ agent: max 6 steps, 20k token budget, state in Postgres
   │    tools: check_slots · book_test · handoff_to_human
   ├─ lab client: timeout, 3 attempts, exponential backoff + jitter, Idempotency-Key
   └─ outbox sender (mock WhatsApp by default; real Graph API if configured)
```

**Why Postgres as the queue:** it is already required for conversation state, and it removes
Redis from the critical path. `SKIP LOCKED` gives multi-consumer safety; a partial unique index
(`jobs_one_running_per_conversation`) enforces one running turn per conversation, so messages
are processed in order even with 8 worker loops.

**Why the database decides bookings:** the LLM can propose, but it cannot create a booking.
The slot is reserved with `INSERT … ON CONFLICT DO NOTHING` against a partial unique index
before the lab is called. If the lab times out after committing, the retry carries the same
`Idempotency-Key`, and the mock lab (like a real one) replays the original booking.

### Request path and failure matrix

| Failure | Behaviour |
|---|---|
| Duplicate webhook | `ON CONFLICT (wa_message_id)` → no job, still `200` (never 409; Meta retries harder on non-2xx) |
| Burst | Ack is one indexed write; 1,000 messages sent in 257 ms, p99 57 ms |
| Lab 500 / timeout **before** commit | Retry 3× with backoff; then the agent re-offers or retries in the tool loop |
| Lab committed, response lost | Retry with the same key; lab replays the booking; DB marks it confirmed once |
| Two patients, same slot | Partial unique index: one reservation, one `SLOT_TAKEN`, zero lab calls from the loser |
| Worker crash | Lease expires (90 s), job requeued; all side effects are idempotent |
| All attempts fail | Job dead-letters, conversation handed to a human, patient gets an apology |
| LLM 429 / dead model / quota | Model fallback chain, then the deterministic policy; the booking still completes |

The one deliberately conservative choice: an **ambiguous** lab outcome leaves the booking
`pending` instead of releasing the slot. Releasing a slot the lab may have committed is the
only way to double-book, so a human reconciles instead.

---

## API

| Endpoint | Notes |
|---|---|
| `GET /webhook` | Meta verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| `POST /webhook` | Signature required. `200` accepted/duplicate/status event; `401` bad signature; `400` malformed; `503` DB unavailable (Meta retries) |
| `GET /metrics` | Prometheus text by default; `?format=json` for the JSON summary incl. per-conversation tokens/cost |
| `GET /api/conversations` · `/api/conversations/:phone` | Transcript, state, bookings, handoffs, usage |
| `GET /api/bookings` | For invariant checks |
| `GET /dev/outbox?phone=` | Mock WhatsApp delivery log |
| `POST /dev/simulate` | Builds a Cloud-API payload, signs it, calls the real `/webhook` |
| `POST /dev/reset` | Truncate business tables (dev only) |
| `GET /demo` | Operator console |

`/api/*` and `/dev/*` are only mounted when `DEV_MODE=true`. In production, require
`ADMIN_TOKEN` at the edge or leave `DEV_MODE=false`.

### Metrics (all derived from Postgres at scrape time)

Because API and worker are separate processes, business metrics are **gauges read from the
database**, so any API replica reports the same numbers:

```
gateway_webhook_requests_total{status}        gateway_webhook_duration_seconds
gateway_duplicate_messages_total               gateway_rate_limited_total
gateway_queue_depth{status}                    gateway_jobs_retried_24h
gateway_bookings_state{status}                 gateway_lab_calls_24h{op,outcome}
gateway_llm_calls_24h                          gateway_llm_tokens_24h{kind}
gateway_llm_cost_usd_24h                       gateway_llm_fallbacks_24h
gateway_conversation_tokens{conversation,phone,kind}
gateway_conversation_cost_usd{conversation,phone}
gateway_outbox_state{status}                   gateway_state_{conversations,confirmed_bookings,handoffs}
```

`/metrics?format=json` also returns `webhook.ackLatencyMs.p50/p95/p99` (a 5k-sample ring
buffer), the per-conversation table, queue depth and the LLM daily budget.

---

## Load test — 1,000 messages, 20% duplicates

`npm run load` (also documented in [`LOAD_REPORT.md`](./LOAD_REPORT.md), raw data in
`load-report.json`). 100 phones × 8 messages, 200 exact duplicate `wamid`s, 25 phones in
flight, messages within a phone sequential (realistic WhatsApp ordering), each phone on a
different date so the run measures throughput rather than artificial slot contention.

| Metric | Result |
|---|---|
| HTTP 200 | **1,000 / 1,000** |
| Ack p50 / p95 / p99 / max | **4.6 / 13.8 / 57.3 / 66.7 ms** |
| Send phase | 257 ms (~3,900 req/s) |
| Queue + outbox drained | 16.8 s (47.7 jobs/s) |
| Duplicates suppressed | **200** |
| Jobs done / dead | **800 / 0** |
| Confirmed bookings | **100** |
| **Double-booked slots** | **0** |
| Lab failures absorbed | 26 slot retries + 27 booking retries, 1 exhausted attempt per op retried by the agent |
| Actual LLM spend | **₹0.00** (mock provider) |
| Equivalent at Gemini 2.5 Flash-Lite | ₹6.28 for the run |

The run uses the deterministic provider on purpose: free-model limits (20 req/min) make a
1,000-message run non-reproducible and would measure OpenRouter's queue, not this gateway.
Token counts are estimates and priced at real Flash-Lite rates in the report.

---

## Tests

```bash
docker compose up -d postgres      # test DB is created by the init script
npm run test:all                   # 28 tests
npm run test                       # unit only (no DB)
npm run test:int                   # integration (real Postgres + real mock-lab)
```

Coverage of the scored failure modes:

- HMAC: valid, wrong secret, wrong length, malformed header, missing raw body.
- Concurrent duplicate pair → one inbound row, one job, one reply.
- 1,000-message burst → p99 < 200 ms, exactly 800 jobs, 800 replies, 0 dead, 100 bookings, 0 double-booked slots.
- 10 conversations race for one slot → exactly 1 confirmed, 9 `SLOT_TAKEN`, lab has 1 booking.
- Lab commits then times out → retry with the same key → exactly 1 confirmed booking.
- Lab unreachable → reservation stays `pending`, subsequent attempts reuse the same row (never released).
- Expired worker lease → job requeued and completed.
- Rate limit → messages stored, jobs suppressed past the limit.
- Agent state: test detection, slot choice, handoff, no second booking.

Two bugs were found by these tests and fixed:

1. `ORDER BY id` in a query that selected `id::text` sorted message IDs lexicographically
   (`"10" < "9"`), so the agent sometimes read the wrong "last user message". Fixed by
   ordering on `messages.id` and reversing in JS. The 1,000-message run went from 77% to
   100% booking completion.
2. Business counters lived in the worker process while `/metrics` was served by the API
   process. Moved them to DB-derived gauges, which also makes multiple API replicas consistent.

---

## Real LLM, and what it cost

Default is `LLM_PROVIDER=mock` (deterministic policy, zero quota, used by tests/load).
For the real path:

- OpenRouter free model `nvidia/nemotron-3.5-lightning:free` (tool calling verified by
  [`scripts/llm-probe.ts`](./scripts/llm-probe.ts); see [`LLM_PROBE.md`](./LLM_PROBE.md)).
- Fallback chain: `inclusionai/ling-3.2-flash:free`, `google/gemma-4-31b-it:free`,
  `openrouter/free`. Two of those were 429 at probe time, which is exactly why the chain
  exists.
- The real model completed a full booking: **4 calls, 5,796 prompt + 533 completion tokens,
  0 failures**. The deterministic fallback caught one truncated 300-token completion before
  the token cap was raised to 800 — visible in `llm_usage` as `outcome='fallback'`.
- **Actual spend: ₹0.00.** At Gemini 2.5 Flash-Lite rates the demo run is ~₹0.07.
  The ₹500 budget is enforced twice: `MAX_LLM_CALLS_PER_DAY` and `MAX_SPEND_USD`, both
  circuit-breaking to the deterministic policy. The in-process cap is per worker; the DB
  is the reporting source of truth.

The model cannot break correctness: tool arguments are validated against conversation state,
`book_test` requires an explicit slot choice in the patient's message, and the booking is
guarded by the database.

---

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` or `openrouter` |
| `LLM_MODEL` / `LLM_FALLBACKS` | free models | Model chain |
| `MAX_LLM_CALLS_PER_DAY` / `MAX_SPEND_USD` | 45 / 2 | Hard circuit breakers |
| `RATE_LIMIT_PER_MINUTE` | 20 | Per phone; over-limit messages are stored but not processed |
| `LAB_FAIL_RATE` / `LAB_FAIL_MODE` | 0.2 / mixed | Mock lab hostility (`before`, `after`, `after_timeout`, `none`) |
| `LAB_MIN_LATENCY_MS` / `MAX` | 120 / 700 | Lab latency |
| `MOCK_WHATSAPP` | true | Mock sender writes to `outbox`; real Graph API if false + token |
| `WORKER_CONCURRENCY` | 8 | Parallel job loops (per-conversation ordering preserved) |
| `DEV_MODE` | true | Mounts `/api`, `/dev`, `/demo`; set false in production |

---

## Repo layout

```
PLAN.md                 first commit: problem, architecture, data model, API, cost
migrations/             forward-only SQL, applied by a transactional runner
src/api.ts              Fastify HTTP process
src/worker.ts           worker process (same image, different command)
src/http/app.ts          webhook, metrics, operator API, demo simulator
src/db/repo.ts          the SQL that matters: dedupe, queue, bookings, usage
src/agent/              prompt, tool schemas + guards, agent loop
src/booking/service.ts  two-phase reservation + idempotent lab call + reconciliation
src/lab/client.ts       retries, timeouts, idempotency keys
src/llm/                provider interface, OpenRouter client, deterministic policy, budget
src/metrics/            prom-client registry, DB-derived snapshot
mock-lab/               20%-failure lab with idempotency replay and after-commit failures
scripts/load.ts         1,000-message load generator + report
scripts/llm-probe.ts    one-shot free-model tool-calling probe
tests/                  19 unit + 9 integration tests
public/index.html       operator console (vanilla, no build)
```

---

## Trade-offs and next steps

- **Postgres queue over Kafka/Redis:** right for this scale and one fewer service; at 10×
  the burst rate I would move the queue to SQS/Kafka and keep Postgres for state.
- **Mock WhatsApp outbound:** no credentials were available and none may be committed. The
  sender is a real Graph API implementation behind `MOCK_WHATSAPP`; the outbox table is the
  seam.
- **Mock lab is in-memory:** it is a test double, reset with `/__admin/reset`. A real
  integration would persist its own state and expose a reconciliation endpoint.
- **Free-model quality:** the deterministic policy is not a crutch, it is the floor. Weak
  models get schema-validated tools and explicit-choice guards; the happy path still works.
- **Deployment:** `docker compose up` is the build artifact (the brief allows "a deployed
  link or build"). No card was available for Fly/Render. The production shape is the same
  image three times: `migrate`, `api`, `worker`, plus managed Postgres — no code changes.
- **`DEV_MODE`**: the demo API is intentionally open on localhost. Production should set
  `DEV_MODE=false` and put `/api/*` behind SSO or `ADMIN_TOKEN`.

---

## Submission checklist

- [x] Public repo, first commit is `PLAN.md`
- [x] `docker compose up` runs API + worker + Postgres + mock lab
- [x] Signed webhook, dedupe by message ID, ack p99 < 200 ms
- [x] Postgres conversation state, LLM tool calling, retries/backoff, no double booking
- [x] Per-conversation tokens/cost at `/metrics`, per-phone rate limit
- [x] 1,000-message load run with 20% duplicates + [`LOAD_REPORT.md`](./LOAD_REPORT.md)
- [x] [`COST.md`](./COST.md) at 1M messages/month
- [x] [`AI_USAGE.md`](./AI_USAGE.md), actual spend **₹0.00**
- [ ] 3–5 minute video — script in [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md)

Synthetic data only. No patient data, no API keys in the repo (`.env` is gitignored;
`.env.example` has placeholders).
