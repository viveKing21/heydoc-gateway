# VIDEO — 3–5 minute walkthrough

Target: **3:45**. Record at 1280×720+, editor font ≥ 14 pt, terminal and browser only.
Close anything containing `.env` or the API key.

Pre-flight:

```bash
cp .env.example .env                 # mock provider (₹0, deterministic) by default
docker compose up -d --build
curl -X POST localhost:3000/dev/reset
curl -X POST localhost:4000/__admin/reset
open http://localhost:3000/demo
```

If you want the real model on camera, set `LLM_PROVIDER=openrouter` + key in `.env` and
`docker compose up -d worker api`. Have the mock fallback ready: if the free model is slow,
the deterministic policy still completes the booking — say that out loud, it is a feature.

---

## 0:00–0:25 — What and why

**Show:** repo root, `PLAN.md` open at the architecture section.

**Say:**
> "This is a WhatsApp gateway for a diagnostics lab. Webhooks arrive in bursts and twice,
> and the lab API is slow and fails 20% of the time. Nobody may be double-booked.
> The design is in PLAN.md, which is the first commit by design. The short version: the
> webhook only verifies, dedupes and queues — it never calls the LLM or the lab. The worker
> does the agent loop. And the no-double-booking guarantee is a Postgres constraint, not
> agent logic."

## 0:25–0:50 — Architecture in one breath

**Show:** the ASCII diagram in `README.md` (zoom).

**Say:**
> "One SQL statement on the ack path: insert the message with a unique WhatsApp ID, upsert
> the conversation, bump the rate limit, enqueue a job. Duplicate message ID means no job.
> The worker claims with `SKIP LOCKED` and one-running-job-per-conversation, runs the agent
> with three tools, and reserves the slot in our database before it ever calls the lab.
> If the lab times out after committing, the retry carries the same idempotency key and the
> lab replays the booking."

## 0:50–1:20 — It runs

**Show:** terminal.

```bash
docker compose ps
```

Point at `api`, `worker`, `mock-lab`, `postgres`, `migrate` (exited 0). Then open
`http://localhost:3000/demo`.

**Say:**
> "One command: api, worker, mock lab, Postgres, migrations. The default LLM is deterministic,
> so this demo costs nothing. The badge shows the provider."

## 1:20–2:00 — Happy path

**Show:** `/demo`, phone `919800000001`.

1. Send `I want to book a CBC test`.
2. Wait — the right panel shows `check_slots`, six slots, state JSON, tokens.
3. Send `1`.
4. Show the confirmation reply and the booking row (`confirmed`, slot `...-0900`, lab id).

**Say:**
> "The model chose the tool; the tool validated the slot against the conversation state.
> The booking went through the reservation first. Note the state panel: test, offered slots,
> selected slot, booking, and per-conversation tokens and cost — that is what `/metrics`
> exposes for every conversation."

## 2:00–2:30 — Duplicate proof

**Show:** click **Send duplicate**. Then run:

```bash
docker compose exec -T postgres psql -U heydoc -d heydoc \
  -c "select (select count(*) from inbound_messages) inbound, (select count(*) from jobs) jobs, (select count(*) from outbox) outbox;"
```

Expected: `inbound 3, jobs 3, outbox 3` (two real messages + the duplicate still stored once;
the duplicate did **not** add a job). Point at `duplicates blocked` in the metrics panel.

**Say:**
> "Same `wamid`, same signature, second 200. The unique constraint suppressed it: no second
> job, no second reply. This is the failure Meta creates when it doesn't get a fast 200 —
> and we always return 200 for duplicates, never 409."

## 2:30–3:00 — Failure proof

**Show:** `LOAD_REPORT.md` (top table), then the double-booking query:

```bash
docker compose exec -T postgres psql -U heydoc -d heydoc \
  -c "select slot_id, count(*) from bookings where status='confirmed' group by slot_id having count(*) > 1;"
```

Expected: zero rows. Point at `1,000 / 1,000`, `p99 57.3 ms`, `200 duplicates`,
`800 jobs`, `100 bookings`, `0 double-booked`.

**Say:**
> "The load run had 20% lab failures: 26 slot retries and 27 booking retries, zero dead jobs.
> The invariant query is empty. Two defenses: a partial unique index on the slot, and an
> idempotency key that survives a committed-but-lost response. The integration test also
> races ten conversations for one slot and asserts exactly one winner."

## 3:00–3:25 — Metrics and cost

**Show:** `http://localhost:3000/metrics?format=json` in a second tab; expand `llm`,
`webhook`, `queue`, and one `conversations` entry. Then `COST.md` table.

**Say:**
> "Because the API and worker are separate processes, business metrics are read from Postgres
> at scrape time: queue depth, retries, bookings, lab calls, tokens and cost per conversation.
> The demo's actual spend is zero — free model — and COST.md projects one million messages at
> about ₹14,500 a month on Flash-Lite, or one and a half paise per message. The 40% of turns
> that don't need a model are the cheapest tokens."

## 3:25–3:45 — Tests and what I'd change

**Show:** `npm run test:all` output (28 passed).

**Say:**
> "Twenty-eight tests against real Postgres and the real mock lab: duplicate race, 1,000
> messages, 10-way slot race, commit-then-timeout, unreachable lab, expired worker lease,
> rate limit. The tests found two real bugs: a text-vs-bigint ordering bug that dropped
> booking completion to 77%, and metrics split across processes.
> What I'd do next: real WhatsApp credentials, a persistent lab integration with a
> reconciliation endpoint, and partition the usage tables at 10× scale. The build is
> `docker compose up`; the production shape is the same image three times — migrate, api,
> worker — plus managed Postgres."

---

## Backup shots (if something is slow)

- If the real model is slow: switch to `LLM_PROVIDER=mock` and say the deterministic path is
  the floor; show `llm_usage` rows from the earlier real run if needed.
- If the demo phone already has a booking: reset both DB and lab (commands above) and use a
  fresh phone.
- If Docker is still building: start with `docker compose ps` from a pre-built stack; do not
  record the build.
- Show the idempotency key in the DB if you want one more proof:
  `select status, slot_id, left(idempotency_key, 12) from bookings;`
