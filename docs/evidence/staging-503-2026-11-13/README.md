# Staging 10K gate and provider-503 drill — 2026-11-13

**Status.** Both checks passed. The 25-question simple-inventory gate ran with the paid fallback
disabled and spent **$0.000000**; the provider-boundary drill returned a real HTTP `503` for the
ordinary primary, the free fallback answered with its inventory tool, and a pass-through control
turn then used the primary normally. No production database, configuration, quota, model order or
deployment was changed.

## Why this is staging

The production gate could not be made zero-cost without weakening production's paid fallback, and
the owner chose not to do that. A Render preview was not available (no Render API credentials), so
this ran as an isolated loopback HTTP process against the development database:

- gate tenant: `6af74f801f2f46d5506554c2`, `PERF SEED — AI assistant stress test (do not use)`
- hardened-drill tenant: `6af75498f7d87d784c49db49` (reseeded once to verify the hardened drill)
- owner: `perf-seed-ai@example.invalid`, Firebase-linked
- data: 10,000 active products / 20,006 inventory rows / 2,446,801 units on hand
- process: `NODE_ENV=development`, `MONGODB_DB_NAME=inventoryai_dev_db`, port 4000
- paid disable: **`AI_SIMPLE_PAID_DAILY_BUDGET_USD=0` on this process only**. This is a test
  condition, not a product restriction; the production configuration still has the full paid
  fallback and the complete model chain.

The seed guard deliberately permits only the development and production databases; no attempt was
made to create or weaken a `inventoryai_staging_db` guard.

## 10K simple-inventory gate

`server/scripts/perf/deployed-gate.mjs` in `GATE_TARGET=staging` mode ran 25 questions at a 10 s gap
against `http://127.0.0.1:4000`. The paid budget was `$0`, so any paid escalation would have failed
the turn rather than spending money.

| Measure | Result |
| --- | --- |
| Requests answered | **25 / 25** |
| Accurate | **25 / 25** |
| Free-served | **25 / 25** |
| Paid-served | **0** |
| Errors / degraded | **0 / 0** |
| Total cost | **$0.000000** |
| Median | **4,569 ms** |
| p95 | **8,059 ms** |
| Provider paid usage | unchanged at `1.211761734` |
| Free requests | **902 → 847** |
| Inventory restore | **20,006 rows**, exact quantities and reservations |

The 25 turns used 55 free requests because some turns re-asked for the required shortage read. The
run completed in 363,781 ms. Evidence: [`staging-gate.json`](staging-gate.json),
[`staging-gate.txt`](staging-gate.txt); seed log: [`staging-seed.txt`](staging-seed.txt).

After the run, a read-only check re-read the tenant as 10,000 products / 20,006 inventory rows /
2,446,801 units / 0 reserved: [`preflight-after.json`](preflight-after.json).

## Provider-wide HTTP 503 drill

The drill used a loopback proxy at the provider boundary (port 5055) so the server received a real
HTTP response, not an injected application error. The proxy forwarded `/api/v1/models` normally and
returned `503` only for `openai/gpt-oss-20b` on its model-bearing request path. The server's paid
budget remained `$0`; the ordinary route was allowed to make its normal primary/free transition.

| Turn | Model | Result |
| --- | --- | --- |
| Failover turn | `openai/gpt-oss-20b` → `nvidia/nemotron-3.5-lightning:free` | **201**, `getStockValue`, no degradation |
| Control turn after pass-through | `openai/gpt-oss-20b` | **201**, `getStockValue`, normal primary |

The server log records exactly one bounded failover:

```text
AI model call ... model=openai/gpt-oss-20b ... turn=67eb063d
AI provider openrouter upstream HTTP 503
AI failover attempt=1 model=openai/gpt-oss-20b -> nvidia/nemotron-3.5-lightning:free reason=HTTP 503 remaining=59993ms
AI turn outcome=ok ... calls=3 attempts=3 ... failovers=1 ... cost=$0.000000 ... model=nvidia/nemotron-3.5-lightning:free ... turn=67eb063d
```

The fallback answered `Your inventory is worth PHP 49,991,557,115 ... 10,000 products ...
2,446,801 units ... No products are unpriced`, grounded in `getStockValue`. The proxy counted
**one** failed request and nine forwarded requests; it did not retry the primary in a loop. After
the proxy was switched to pass-through, the control turn answered on `openai/gpt-oss-20b` for
**$0.000349**, so the failure did not leave the model circuit open in a way that blocks a recovered
provider.

**Test-harness correction.** The first probe was invalid: the proxy only inspected
`/chat/completions`, while OpenRouter's Anthropic-compatible request uses `/api/v1/messages`. The
primary therefore answered normally instead of receiving a `503`, at **$0.000388**. The proxy was
corrected to inspect both model-bearing paths. The first corrected run then passed, but its drill
still used a simple-route question, so it would have accepted a free answer without a `503`; the
drill was hardened to require exactly **one new** proxy failure and its default question now routes
to the ordinary primary. The disposable tenant was reseeded once, and the hardened run above passed
with `failedRequests: 1`. Combined staging paid cost (invalid probe, first control, hardened
control) is **$0.001103**; the 25-turn gate itself was **$0**.

Evidence: [`p3-drill.txt`](p3-drill.txt), [`p3-proxy.txt`](p3-proxy.txt),
[`p3-server.txt`](p3-server.txt).

## Cleanup

The staging processes on ports 4000, 4001 and 5055 were stopped after the evidence was copied. The
gate tenant was removed first (**44,575** documents), then the hardened-drill tenant was removed
(**44,455** documents); both cleanups verified **0** remaining. The final cleanup log:

```text
[cleanup:perf-tenant] OK — removed 44455 document(s); verification found 0 remaining.
[cleanup:perf-tenant] kept: the Firebase identity for perf-seed-ai@example.invalid
```

No production data was touched. Evidence: [`staging-cleanup.txt`](staging-cleanup.txt); reseed:
[`staging-reseed.txt`](staging-reseed.txt).

## Limits

- This is a loopback staging process on the development database, not the hosted Render preview.
  It does not prove Render routing, cold starts, or hosted network behavior.
- The gate is sequential at concurrency 1; the P4 concurrency test remains unrun.
- The P3 drill is one model-specific 503, not a sustained provider-wide outage or a global
  breaker-threshold test. It proves the real HTTP path, bounded fallback, tool grounding and
  recovery after pass-through.
- The hardened drill asserts exactly one new proxy failure, so a simple-route answer can no longer
  pass without a real `503`.
- Production's zero-cost gate remains unachieved and should not be pursued by disabling its paid
  fallback.
