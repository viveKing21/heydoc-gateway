# COST — 1 million messages/month

All figures are **projections** for a production workload, not bills. The actual spend for
this assignment is **₹0.00** (section 6). INR uses ₹88 = $1.

---

## 1. Workload model

| Assumption | Value |
|---|---|
| Inbound messages / month | **1,000,000** |
| Peak shape | 0.39 msg/s average, 1,000-message bursts |
| Turns handled without an LLM call | 40% (menu, duplicates, rate-limited, human-owned, confirmations) |
| LLM-handled turns | 600,000 |
| LLM calls per turn | 1.6 (one tool call + one final answer; some turns are single-call) |
| **LLM calls / month** | **960,000** |
| Prompt tokens per call | 1,200 (800 static/cached, 400 fresh) |
| Completion tokens per call | 120 |
| Cache treatment | static system prompt cached at 25% of the input rate |

The 40% deterministic share is not a trick: a booking flow already sends slot lists,
confirmations and duplicate deliveries without needing a model. The agent is reserved for
understanding and choosing, which is where it adds value.

---

## 2. LLM cost

Prices are per 1M tokens, verified against the providers' public pricing at build time.
Cached input is billed at 25% of input.

| Model | $ in / out | Calls | Monthly USD | Monthly INR | ₹ / message |
|---|---|---|---|---|---|
| OpenRouter `:free` | 0 / 0 | 960k | **$0** | **₹0** | ₹0 |
| Gemini 2.5 Flash-Lite | 0.10 / 0.40 | 960k | **$103.68** | **₹9,124** | ₹0.0091 |
| Gemini 2.5 Flash | 0.30 / 2.50 | 960k | **$460.80** | **₹40,550** | ₹0.0406 |
| GPT-4.1-mini class | 0.40 / 1.60 | 960k | **$414.72** | **₹36,495** | ₹0.0365 |

**No caching** (worst case, if the provider ignores the cache):

| Model | Monthly USD | Monthly INR |
|---|---|---|
| Gemini 2.5 Flash-Lite | $161.28 | ₹14,193 |
| Gemini 2.5 Flash | $633.60 | ₹55,757 |
| GPT-4.1-mini class | $645.12 | ₹56,771 |

**If every message used the LLM** (1.6M calls, no deterministic routing):
Flash-Lite $172.80 cached / $268.80 uncached → ₹15,206 / ₹23,654. This is the ceiling;
the 40% routing saves ~40%.

Free models are **not** production-viable at this volume: 20 requests/minute is ~864k/month,
already below the 960k call estimate, and provider capacity is best-effort (two of three
candidates returned 429 during the probe). They are ideal for the demo and tests.

---

## 3. Infrastructure

| Item | Spec | USD/mo | INR/mo |
|---|---|---|---|
| API | 2 × 1 vCPU / 1 GB (stateless, behind a LB) | $24 | ₹2,112 |
| Worker | 1 × 1 vCPU / 1 GB, 8 concurrent job loops | $12 | ₹1,056 |
| Postgres | managed, 2 GB RAM, 20 GB disk, PITR backups | $20 | ₹1,760 |
| Logs, metrics, egress | 30-day retention | $5 | ₹440 |
| **Total** | | **$61** | **₹5,368** |

The worker is deliberately small: the load test sustained **47.7 jobs/s** on one process with
8 loops, while the average production rate is 0.39 msg/s. The burst is absorbed by the queue,
not by over-provisioning.

No Redis. No Kafka. The queue is Postgres, which is already required for state.

---

## 4. WhatsApp

The flow is entirely **user-initiated**, so replies inside the 24-hour customer service
window are free under Meta's service-conversation pricing. **₹0** for this workload.

If the lab later adds proactive reminders (appointment templates), those are billed per
message; at India utility-template rates of roughly ₹0.10–0.15, 1M reminders/month would add
**₹1.0–1.5 lakh/month**. Out of scope here and called out so the number is not a surprise.
Always confirm current rates with the lab's BSP — Meta changes pricing.

---

## 5. Total

| Configuration | Infra | LLM | **Total / month** | ₹ / message |
|---|---|---|---|---|
| **Free models** (demo/test only) | ₹5,368 | ₹0 | **₹5,368** | ₹0.0054 |
| **Flash-Lite** (recommended) | ₹5,368 | ₹9,124 | **₹14,492** | **₹0.0145** |
| Flash-Lite, no cache | ₹5,368 | ₹14,193 | ₹19,561 | ₹0.0196 |
| Flash | ₹5,368 | ₹40,550 | ₹45,918 | ₹0.0459 |
| GPT-4.1-mini class | ₹5,368 | ₹36,495 | ₹41,863 | ₹0.0419 |

**Recommendation: Gemini 2.5 Flash-Lite at ~₹14.5k/month**, or ~₹0.087 per 6-message
conversation. The infra is ~37% of the bill at this scale; at 3M messages/month the LLM
dominates and prompt caching + rules-first routing matter much more.

### Where the money actually goes

At Flash-Lite, 960k calls × 1,200 prompt tokens = **1.15B input tokens**, vs 115M output
tokens. Input is 63% of the LLM bill even at one-third the price per token. The two highest
leverage optimisations are:

1. **Cache the static prefix** (system prompt + tool schemas + test catalogue). Already
   structured for it: static text first, dynamic state last.
2. **Trim history to 8 turns and tool payloads to 2k chars.** Already implemented.

A third — route classification to a tiny model and booking to a larger one — is not worth
the complexity at this volume; one model is easier to reason about.

---

## 6. Actual spend for this assignment

| Item | Amount |
|---|---|
| OpenRouter free probe (1 tool-call request) | $0.00 |
| Full real-model demo (4 calls, 5,796 prompt + 533 completion tokens) | $0.00 |
| Load test (1,002 calls, deterministic provider) | $0.00 |
| Infra (local Docker) | $0.00 |
| **Total actually paid** | **₹0.00** |

At Gemini 2.5 Flash-Lite prices, the demo's 6,329 tokens would have cost
**$0.00079 ≈ ₹0.07**. The ₹500 cap was never at risk; the app still enforces
`MAX_LLM_CALLS_PER_DAY=45` and `MAX_SPEND_USD=2` and falls back to the deterministic policy,
so a runaway loop cannot spend more than the cap even on a paid model.

---

## 7. At 10× (10M messages/month)

- Partition `llm_usage` and `lab_calls` by month; they are append-only and the current
  indexes are time-based.
- Move the job queue to SQS/Kafka (Postgres `SKIP LOCKED` is fine at 1M, but 10M with
  bursts is a different I/O profile); keep Postgres for conversation state and bookings.
- Batch non-urgent LLM calls and add provider-side prompt caching if the model supports it.
- Keep the deterministic routing: it is the cheapest token you will ever not spend.

Estimated at 10M: infra ~₹18–22k (larger Postgres + 3 workers), LLM ~₹90k at Flash-Lite,
total **~₹1.1 lakh/month**, ~₹0.011/message — sub-linear because the fixed infra is amortised.
