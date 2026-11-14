# Staging sustained provider-wide 503 — 2026-11-13

**Status.** PASS. Three consecutive ordinary AI turns hit a real HTTP `503` from the provider proxy
for **every model in the configured chain**. Each turn ended with one bounded `502 AI_UNAVAILABLE`
response after exactly **three provider attempts** (the paid primary and both free fallbacks), with
no retry loop and no partial answer. Two turns after the proxy was restored answered normally and
quoted the tool's exact stock value. No production configuration or production data was touched.

## What was failed

The ordinary chain for this deployment is:

```text
openai/gpt-oss-20b (paid primary)
  -> nvidia/nemotron-3.5-lightning:free
  -> nvidia/nemotron-3-ultra-550b-a55b:free
```

The proxy failed all three at the chat boundary. The app's public failure is `502 AI_UNAVAILABLE`
(the clean API mapping for an upstream outage); the proxy genuinely returned `503` for every attempt.
The separate research model (`openai/gpt-oss-120b`) is not part of an ordinary value turn and was not
used here; research routing was covered in the advanced evaluation.

## Outage results

| Request | Public result | Provider attempts | Duration |
| --- | --- | ---: | ---: |
| 1 | `502 AI_UNAVAILABLE` | 3 | 486 ms |
| 2 | `502 AI_UNAVAILABLE` | 3 | 441 ms |
| 3 | `502 AI_UNAVAILABLE` | 3 | 448 ms |

- **9 failed provider requests total**, exactly 3 per turn.
- `failovers=2` per turn; the walk moved forward only and did not bounce back to a failed model.
- No `201`, no empty successful answer, no retry loop, no message persisted from the failed turns.
- Health counters: `5xx` delta **3**, `serverErrors` delta **3**, one per failed turn.
- The failed response body is the same bounded sentence every time: *“The AI service is temporarily
  unavailable. Please try again in a moment.”*

## Recovery results

After `POST /__control/pass`:

| Request | Result | Model | Tool | Duration |
| --- | --- | --- | --- | ---: |
| 1 | `201` | `openai/gpt-oss-20b` | `getStockValue` | 7.3 s |
| 2 | `201` | `openai/gpt-oss-20b` | `getStockValue` | 5.8 s |

Both answers were identical:

> The total stock value at the recorded selling price is **49,991,557,115**.

Ground truth from `productService.stockValue` for the tenant: **49,991,557,115**, 10,000 products,
2,446,801 units, 0 unpriced products. The recovery turns added **0** new `5xx`; staging provider cost
was **$0.001296** (`$0.000952 + $0.000344`).

## The bug this drill found and fixed

The first recovery pair returned two different totals for the identical question:

```text
49,991,557,115
49,991,571,115
```

Both claimed the same 10,000 products and 2,446,801 units. The true tool total is **49,991,557,115**;
the second was a model arithmetic/copy error of **14,000**. A total-only stock-value question had no
deterministic finalizer, so the model's draft was shipped verbatim.

Fix in this branch (AI-107): `totalStockValueAnswer` now quotes `getStockValue.totalValue` for a
business-wide total-only question and appends the tool's unpriced-product count. It deliberately
does not run for a scoped read (a location/category summary) or a mixed-currency total, and it is
skipped when the question asks for another fact. A focused test covers the exact 49,991,557,115 value
and the unpriced note. After the fix, both recovery turns returned the exact total.

The first recovery attempt also failed because the **test proxy** forwarded `/v1/messages` to
`https://openrouter.ai` instead of `https://openrouter.ai/api`; that was a proxy configuration error,
not an application failure. The corrected proxy forwarded both recovery turns normally.

## Staging-only settings

- `AI_MODEL_FAILURE_THRESHOLD=99` kept the per-process breaker from opening during the three-turn
  burst, so every turn exercised the full bounded chain (3 attempts). Production keeps the configured
  default of 5.
- `AI_MODEL_HEALTH_TTL_MS=1` prevented the test proxy's encoded health-probe 404s from holding the free
  models out of selection. That 404 is a test-proxy artifact; production's default is 31 minutes.
- The proxy runs only on loopback (`127.0.0.1:5055`) and never logs authorization headers or prompts.
- No production environment variable, deployment, or real tenant data was changed.

## Evidence

- [`result.json`](result.json) — pass summary, per-turn statuses, attempts, health deltas, proxy state
- [`drill.txt`](drill.txt) — final clean outage and recovery run
- [`pre-fix-recovery-drill.txt`](pre-fix-recovery-drill.txt) — the pre-AI-107 recovery pair that
  returned 49,991,557,115 and 49,991,571,115 for the same question
- [`server.txt`](server.txt) — bounded `calls=3 failovers=2` failure lines, exact recovery values,
  finalizer warnings and settled costs
- [`proxy.txt`](proxy.txt) — real `503` per model, then forwarded recovery requests

`result.json`’s proxy counter is cumulative: an earlier recovery attempt was made before the
proxy’s upstream base was corrected, and this run’s per-turn `proxyFailedDelta` values are the
ones that show the three attempts per request (9 total).

## Limits

- The outage lasted three requests, not minutes. It proves the bounded path and recovery, not a
  long-duration outage or multi-instance behavior.
- The breaker threshold was deliberately raised for this drill; the production breaker's open/fail-fast
  behavior is a separate policy and was not exercised here.
- The app's public status is `502 AI_UNAVAILABLE`, not the proxy's raw `503`; that mapping is existing
  production behavior.
- One process, one tenant; no load or failover across server instances. The shared tenant cleanup
  and its **0 remaining** verification are in
  [`staging-ai-reliability-cleanup-2026-11-13`](../staging-ai-reliability-cleanup-2026-11-13/README.md).
