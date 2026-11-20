# Load report — 1,000 WhatsApp messages

Generated: **2026-11-20T07:33:59.669Z** · Target: `http://localhost:3000`
LLM provider: **mock** (`deterministic-policy`) · Lab: **20% failure, 120–700 ms latency**

## Setup

| Parameter | Value |
|---|---|
| Messages sent | **1000** |
| Exact duplicates (same `wamid`) | **200** (20%) |
| Unique messages | **800** |
| Conversations (phones) | **100** |
| In-flight phone lanes | 25 (messages within a phone are sequential) |
| Booking date per phone | unique → no artificial slot contention |

## Results

| Metric | Result |
|---|---|
| HTTP 200 / total | **1000 / 1000** (200: 1000) |
| Ack p50 | **4.6 ms** |
| Ack p95 | **13.8 ms** |
| Ack p99 | **57.3 ms** (contract: < 200 ms) |
| Ack max | 66.7 ms |
| Send phase | 257 ms (3891 req/s) |
| Queue + outbox drain | **16.8 s** (47.7 jobs/s) |
| Duplicates suppressed | **200** |
| Jobs done / dead | **800 / 0** |
| Jobs retried (>1 attempt) | 0 |
| Outbox sent / failed | 800 / 0 |
| Conversations created | 100 |
| Confirmed bookings | **100** |
| Pending (ambiguous lab outcome) | 0 |
| Handoffs | 0 |
| **Double-booked slots** | **0** |
| Lab calls | book:ok=100, slots:error=1, book:retry=27, slots:ok=100, book:error=1, slots:retry=26 |
| LLM calls | 1002 |
| LLM tokens (prompt + completion) | 553728 + 40080 = 593808 |
| **Actual LLM spend** | **₹0.00 ($0.0000)** |
| Equivalent at Gemini 2.5 Flash-Lite | ₹6.28 ($0.0714) |

## What happened

- All 1000 deliveries were acknowledged; 200 reached the database
  as duplicates and were suppressed by `UNIQUE(wa_message_id)` — no duplicate job, no duplicate reply.
- The 800 unique messages produced 800 completed jobs and
  800 outbound messages. The queue drained in 16.8 s
  with 0 dead jobs.
- 100 of 100 conversations ended with a confirmed booking. Each phone
  used a different date, so this run measures throughput, not slot contention.
- **0 slots have more than one confirmed booking.**
- The invariant holds: `UNIQUE(slot_id) WHERE status IN ('pending','confirmed')` plus idempotency keys prevent double booking even when the lab fails 20% of calls.
- 0 booking(s) are pending because the lab outcome was ambiguous after all
  retries. They are intentionally **not** released — releasing a slot the lab may have committed is
  the only path to a double booking.
- 0 rate-limit events at 1,000 messages/min/phone (the production
  default is 20/min). No phone in this run approached the limit.
- The lab was genuinely flaky: book:ok=100, slots:error=1, book:retry=27, slots:ok=100, book:error=1, slots:retry=26. Every one of those failures was
  absorbed by the client's retry policy; no job reached the dead-letter state.

## Why the mock LLM

OpenRouter free models are capped at **20 requests/min** (and 50/day unless the account has
purchased $10+; this account reports 1,000/day). A 1,000-message run against a real model would
therefore be neither reproducible nor a measurement of this system — it would mostly measure
OpenRouter's queue. The load test uses the deterministic provider; the token counts above are
estimates and are priced at real Flash-Lite rates to show what this workload would cost. The
demo conversation uses the real free model.

Artifacts: `load-report.json` (machine-readable) and this file.
