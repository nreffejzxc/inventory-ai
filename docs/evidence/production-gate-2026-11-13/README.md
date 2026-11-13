# Production HTTP 10K gate — P2 blocked (2026-11-13)

**Result: the zero-cost condition failed on both attempts, and the guard stopped each gate.** This is
not a passing 25/25 production gate. It is evidence that the hard stop works, that production
inventory was restored exactly, and that the current production free route is not reliably free.

## Target and dataset

- Target: `https://ai-inventory-l1mi.onrender.com` (Render production), deployed commit
  **`65d9ef1`**, `/api/health` `ok`.
- Disposable tenant: `PERF SEED — AI assistant stress test (do not use)`
  (`6af18628a9a409131a84235b`), owner `perf-seed-ai@example.invalid`.
- Dataset: **10,000 active products / 20,006 inventory rows**, total on-hand **2,446,801**,
  reserved **0**.
- Free allowance before: **936**; after: **909**. No production AI configuration, model order,
  paid-fallback setting or quota setting was changed.

## What happened

The first **11 turns were free and accurate** on
`nvidia/nemotron-3.5-lightning:free`, median 4,149 ms. On turn 12 the service answered with
**`openai/gpt-oss-20b`**, a paid model:

| | |
| --- | --- |
| Question | `stock-SEEDSKU-10` — “How many units … are in stock?” |
| Answer | “Anker 737 Power Bank has 66 units on hand at Main Warehouse.” (correct) |
| Model | `openai/gpt-oss-20b` |
| Estimated cost | **$0.0009919** |
| Guard result | `served by non-free model … aborting before another request` |
| Turns completed | 12 / 25 (11 free, 1 paid, 0 errors, 0 degraded) |

The gate stopped **before turn 13**. The 27 free requests consumed in about 65 seconds are consistent
with the free model's per-minute allowance being exhausted; the service's designed behavior then
escalates a simple turn to the paid primary. That cause is an inference from the timing and free
counter, not a provider error recorded in the row.

The provider usage endpoint's `paidUsage` field did **not** move (`providerPaidUsageDelta: 0`), while
the turn's own token pricing produced the $0.0009919 estimate. The per-turn estimate is the evidence
of a real paid model call; the aggregate counter is not suitable for this single-call check.

## Second attempt — 10-second pacing

After approval to retry with slower pacing, the same gate ran with a **10,000 ms** gap. The first two
turns were free and accurate; turn 3 escalated to **`openai/gpt-oss-20b`** after 22,479 ms:

| | |
| --- | --- |
| Question | `stock-SEEDSKU-1` — “How many units … are in stock?” |
| Model | `openai/gpt-oss-20b` |
| Estimated cost | **$0.00065109** |
| Guard result | `served by non-free model … aborting before another request` |
| Turns completed | 3 / 25 (2 free, 1 paid, 0 errors, 0 degraded) |

The 10-second gap did **not** prevent escalation; this was not solely a per-minute rate problem. The
free model produced no usable result on that turn and the production service's designed escalation
reached the paid primary. The usage endpoint again reported no counter movement
(`providerPaidUsageDelta: 0`, free remaining 909 before and after), while the turn's token pricing
estimated $0.00065109. Total estimated paid cost across both attempts: **$0.00164299**.

No further retry was made. The production app has no request-scoped free-only control, so a
production HTTP gate cannot guarantee zero cost while paid escalation is enabled.

## Restore and cleanup

`finally` restored all **20,006** inventory rows from the pre-run snapshot, then verified every
`quantity` and `reservedQuantity` exactly and re-checked the shape:

```
products=10000 inventoryRows=20006 totalQuantity=2446801 reserved=0
staleBackup=false
freeRemaining=909
```

Both attempts restored and verified the same shape. No tenant, product, account or inventory row was
created or deleted. The only new AI rows are the gates' own conversations/messages in the disposable
PERF SEED tenant. The runner did not modify production AI configuration.

## Artifact

- [`gate-partial.json`](gate-partial.json) — first attempt, 12 rows.
- [`gate-run.txt`](gate-run.txt) — first attempt log, including snapshot, normalization, abort and
  exact restore lines.
- [`preflight-after.json`](preflight-after.json) — first attempt post-run counts and health.
- [`gate-partial-10s.json`](gate-partial-10s.json) — second attempt, 3 rows, 10-second gap.
- [`gate-run-10s.txt`](gate-run-10s.txt) — second attempt log.
- [`preflight-after-10s.json`](preflight-after-10s.json) — second attempt post-run counts and
  health.

## Conclusion

P2 **did not meet the zero-cost condition** and must not be reported as a passing production gate.
The production service still has paid fallback enabled by design; slower pacing did not prevent the
second escalation. A production HTTP gate cannot guarantee zero cost without a request-scoped
free-only control or a paid-disabled preview/staging deployment. Do not change the production
configuration to force this.
