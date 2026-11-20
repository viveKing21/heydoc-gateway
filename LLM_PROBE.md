# LLM probe — OpenRouter free models

Run: **2026-11-20T07:31:40.901Z**
Free-tier quota before probe: 0/1000 used, 1000 remaining

One request per model, asking it to call `check_slots`.

| Model | HTTP | Latency | Tool call | Args | Tokens (in/out) |
|---|---|---|---|---|---|
| `nvidia/nemotron-3.5-lightning:free` | 200 | 1235 ms | check_slots | `{"test_id":"CBC"}` | 287/58 |
| `inclusionai/ling-3.2-flash:free` | 429 | 648 ms | — | `null` | 0/0 |
| `google/gemma-4-31b-it:free` | 429 | 145 ms | — | `null` | 0/0 |

**Selected:** `nvidia/nemotron-3.5-lightning:free` — the first model that emitted a valid tool call.

Note: free-tier limits are 20 requests/minute and 50 requests/day without a $10 lifetime top-up.
This account reports a 1,000/day limit (`is_free_tier: false`).
