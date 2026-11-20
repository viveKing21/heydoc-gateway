# Load report — 1,000 WhatsApp messages

Generated: **2026-11-20T07:37:18.198Z** · Target: `http://localhost:3000`
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
| Ack p50 | **4.7 ms** |
| Ack p95 | **11.9 ms** |
| Ack p99 | **50.0 ms** (contract: < 200 ms) |
| Ack max | 73.9 ms |
| Send phase | 259 ms (3861 req/s) |
| Queue + outbox drain | **16.3 s** (49.1 jobs/s) |
| Duplicates suppressed | **200** |
| Jobs done / dead | **800 / 0** |
| Jobs retried (>1 attempt) | 0 |
| Outbox sent / failed | 800 / 0 |
| Conversations created | 100 |
| Confirmed bookings | **100** |
| Pending (ambiguous lab outcome) | 0 |
| Handoffs | 0 |
| **Double-booked slots** | **0** |
| Lab calls | book:retry=32, slots:ok=100, slots:retry=20, book:ok=100 |
| LLM calls | 1000 |
| LLM tokens (prompt + completion) | 552879 + 40000 = 592879 |
| **Actual LLM spend** | **₹0.00 ($0.0000)** |
| Equivalent at Gemini 2.5 Flash-Lite | ₹6.27 ($0.0713) |

## What happened

- All 1000 deliveries were acknowledged; 200 reached the database
  as duplicates and were suppressed by `UNIQUE(wa_message_id)` — no duplicate job, no duplicate reply.
- The 800 unique messages produced 800 completed jobs and
  800 outbound messages. The queue drained in 16.3 s
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
- The lab was genuinely flaky: book:retry=32, slots:ok=100, slots:retry=20, book:ok=100. Every one of those failures was
  absorbed by the client's retry policy; no job reached the dead-letter state.

## Why the mock LLM

OpenRouter free models are capped at **20 requests/min** (and 50/day unless the account has
purchased $10+; this account reports 1,000/day). A 1,000-message run against a real model would
therefore be neither reproducible nor a measurement of this system — it would mostly measure
OpenRouter's queue. The load test uses the deterministic provider; the token counts above are
estimates and are priced at real Flash-Lite rates to show what this workload would cost. The
demo conversation uses the real free model.

Artifacts: `load-report.json` (machine-readable) and this file.
