# AI_USAGE

How this submission was built, what the AI did, what I verified, and what it cost.
The short version: **plan first, mock everything expensive, let tests find the bugs, and
never let a generated number into a doc without running the command that produces it.**

---

## 1. Tooling

| Tool | Where it was used |
|---|---|
| **OpenCode** (agent harness, model `deepseek/deepseek-v4.1-flash-1017` via OpenRouter) | Primary pair: planning, schema, code, tests, docs |
| OpenCode **Plan mode** | Wrote `PLAN.md` before any code; the plan is the first commit by design |
| OpenCode **Code Mode** (JS orchestration of shell/browser tools) | Batched file writes, parallel test/lab/API runs, log inspection |
| Shell (`tsx`, `vitest`, `docker compose`, `psql`, `curl`, `git`) | Every test, load run, invariant query and commit |
| OpenRouter `/api/v1/models` | Queried the live catalogue for free models that advertise tool calling (13 at the time) |
| OpenRouter `/api/v1/key` + `scripts/llm-probe.ts` | Quota check and a one-request tool-call probe per candidate |
| Web fetch of OpenRouter's limits docs | Confirmed the 20 req/min, 50/day (1000/day after $10) free-tier rules |
| Fastify / Postgres / prom-client docs | API shapes and metric types; no code copied |

I did not use Claude Code or Codex on this one; the brief allows any AI tools, and OpenCode
was already configured with the free-model key. No saved skills were used — the workflow
below is the "execution system" instead.

---

## 2. Workflow (the part that matters)

1. **Plan before code.** Wrote `PLAN.md` with the problem, users, failure matrix, schema,
   API contract and cost estimate. Rewrote git history so it is the literal first commit.
   Every later decision points back to a section of that file.
2. **Make the expensive thing mockable.** The deterministic LLM provider implements the same
   `LlmClient` interface as OpenRouter. Tests, the 1,000-message load and all iteration use it,
   so development cost ₹0 and is reproducible. The real model is switched on only for the
   probe and the recorded demo.
3. **Write the invariant as a constraint, not a check.** `UNIQUE(slot_id) WHERE status IN
   ('pending','confirmed')` and `UNIQUE(idempotency_key)` are the no-double-booking design.
   The agent cannot talk its way past them.
4. **Let tests find the bugs.** The integration suite drives the real HTTP app, real Postgres
   and a real Fastify mock lab. It found two bugs I would have shipped (section 4).
5. **One probe, then stop.** Tested three free models once each, picked the one that emitted
   a valid `check_slots` call, and wrote the result to `LLM_PROBE.md` instead of re-probing.
6. **Numbers come from commands.** `LOAD_REPORT.md`, the README table and `COST.md` are
   generated from `npm run load`, `/metrics?format=json`, and `psql` queries. If a number
   changed, the command was re-run, not the sentence edited.

### Context / token discipline

- One source of truth (`PLAN.md`) instead of re-explaining the system in every prompt.
- The mock provider is the default for every loop; no paid or quota-limited call is made
  during coding.
- Targeted `grep`/`sed` over full-file reads; large logs are tailed and filtered.
- The load test runs against the deterministic provider so its 1,000 jobs do not consume the
  free-model quota or measure OpenRouter's queue.
- Real-model calls: ~10 requests total across probe + two demo attempts, ~9.3k prompt and
  ~1.1k completion tokens. All free-tier; **₹0.00**.

---

## 3. What the AI wrote vs what I verified

The AI wrote the first draft of every file — schema, SQL, Fastify app, agent loop, mock lab,
load script, tests and docs. I directed the design, reviewed the diffs, ran the commands, and
made the product calls (Postgres queue over Redis, mock outbound, free model, no frontend).

I personally verified:

- `docker compose up --build` on a clean volume: `api`, `worker`, `mock-lab`, `migrate`,
  Postgres healthy; `/demo`, `/webhook`, `/metrics` reachable.
- `npm run test:all` → **28 passed**.
- `npm run load` → the numbers in `LOAD_REPORT.md` (p99 50.0 ms, 200 duplicates, 800 jobs,
  100 bookings, 0 double-booked).
- `psql` invariant queries: `count(*) > 1` for any confirmed slot returns zero rows; each
  inbound message has exactly one job; every confirmed booking has a lab id.
- The real model: **4 calls, 5,796 prompt + 533 completion tokens, one confirmed booking**;
  the transcript and `llm_usage` rows are in the demo.
- `.env` is gitignored and the key never appears in `git log -p` or any committed file.

I did **not** let the AI claim results it had not produced. When a test failed, the failure
was investigated, not weakened (two examples below).

---

## 4. Bugs the tests caught (and the fix)

### a) Message ordering bug, 77% booking completion

A query selected `id::text` and then `ORDER BY id DESC`. Postgres sorted the **text** alias
(`"10" < "9"`), so the "last 8 turns" were not the last 8. The agent sometimes read the wrong
last user message, and a "1" could be interpreted before the slot list existed.

Fix: `ORDER BY messages.id DESC` (qualified, bigint), then reverse in JS. The 1,000-message
run went from 77% to 100% confirmed bookings. A good reminder that a SQL bug can look like
an LLM bug.

### b) Metrics split across processes

Prometheus counters lived in the worker, `/metrics` was served by the API, so business
metrics read as zero. Fix: derive bookings, lab calls, LLM tokens/cost, queue depth and
per-conversation usage from Postgres at scrape time. This also makes multiple API replicas
consistent — the trade-off is a handful of cheap queries per scrape.

### c) Stale lab availability

During the Docker demo, the DB held a confirmed booking for a slot while the restarted mock
lab reported it as free. The agent re-offered the slot and looped. Fix: filter the lab's
available slots against our active reservations (`activeBookedSlotIds`). Our DB is the
reservation authority; the lab feed can be stale.

---

## 5. Prompts / instructions that worked

- *"Write PLAN.md first: problem, users, architecture, data model, API contract, cost. No
  code until it is committed."* — forced the design conversation before implementation.
- *"The lab fails 20% including after commit. Show me the failure matrix and the exact SQL
  that prevents double booking."* — produced the partial unique indexes and the two-phase
  booking, not just a retry wrapper.
- *"Here is the failing integration test. Find the root cause; do not weaken the assertion."*
  — found the text-vs-bigint ordering bug.
- *"Use the mock LLM for the load; the free quota is 20/min."* — kept the run reproducible
  and the spend at zero.
- *"Every number in the README must come from a command you ran; paste the command."* — the
  load report, metrics and DB counts are traceable.

---

## 6. Guardrails I set for the AI

- No secrets in the repo. The OpenRouter key was copied into `.env` (gitignored) by a script
  that never printed it; `.env.example` contains placeholders only.
- No real patient data. All names, phone numbers and bookings are synthetic.
- No committed result without a run. The load report and cost model are generated.
- No hidden magic: every dashboard number is a SQL query in `src/db/repo.ts` or a metric in
  `src/metrics/`.
- A deterministic fallback means a model outage, quota exhaustion or a bad tool call cannot
  take the booking flow down — the same principle applies to the AI-assisted development:
  the tests are the fallback that catches the model being wrong.

---

## 7. Spend

| Item | Requests | Cost |
|---|---|---|
| Free-model probe | 3 (1 success, 2 provider 429) | $0.00 |
| Real-model demo attempts | ~7 | $0.00 |
| Deterministic load test | 1,002 | $0.00 |
| **Total** | | **₹0.00** |

Equivalent at Gemini 2.5 Flash-Lite: **~₹0.20** for everything above. The ₹500 cap was
respected with a wide margin; the app still enforces `MAX_LLM_CALLS_PER_DAY=45` and
`MAX_SPEND_USD=2` with a deterministic fallback.
