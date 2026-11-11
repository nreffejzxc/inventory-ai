# Deployed 10K simple-inventory gate rerun — 2026-11-11

## Run

| Field | Value |
| --- | --- |
| Window | 2026-11-11 17:57–18:01 UTC (local 01:57–02:01) |
| Target | `https://ai-inventory-l1mi.onrender.com` |
| Deployed commit | `c3bd692` |
| Dataset | `PERF SEED — AI assistant stress test (do not use)` |
| Shape | 10,000 ACTIVE products / 20,006 inventory rows / 5 restock products |
| Low SKUs | `SEEDSKU-5000` … `SEEDSKU-5004` |
| Requests | 25 sequential `/api/ai/chat` questions, 1 s gap, 120 s timeout |
| Written checker | **24/25** |
| Semantically correct | **25/25** |
| Errors | **0** |
| Degraded | **0** |
| Paid answers | **0** |
| Free answers | **25** |
| Estimated cost | **$0.000000** |
| Latency | median **7,102 ms**, p95 **17,724 ms**, mean **7,520.76 ms**, max **18,332 ms** |

All 25 answers were served by `nvidia/nemotron-3.5-lightning:free`.

## The one written-checker miss

The only failure is the known absent-SKU checker false negative:

| Field | Value |
| --- | --- |
| Question | `Do we have the product with SKU SEEDSKU-999999 in our inventory?` |
| Answer | “No product with SKU SEEDSKU-999999 was found in your inventory.” |
| Tool | `getProduct` |
| Model | `nvidia/nemotron-3.5-lightning:free` |
| Checker reason | `missing a denial` |
| Error / degraded | none / none |

The answer is correct: it names the SKU, denies that the product exists, and the turn performed the
required product read. The evaluator's denial regex does not recognise the “No product … was found”
form; the 2026-11-10 deployed gate hit the same false negative with a different wording. This is a
test-checker defect, not an inventory-answer regression. The artifact therefore records 24/25 while
the semantic result is 25/25.

## Output-limit check

Render was filtered to `AI model hit its output limit` for the last hour during the run. It returned
**No matching logs**; the artifact also records 0 `AiOutputLimit` errors and 0 degraded answers. The
only output-limit-related line in the prior window was the owner-only production drill, not a gate
turn. Screenshot: [`render-no-output-limit.png`](render-no-output-limit.png).

## Restoration

The runner snapshotted all 20,006 inventory quantities before normalization. The shell wrapper hit
its 295-second command limit at the end of answer 25, before the harness's `finally` block ran, so
the backup remained and the final artifact lacks `RESULTS` and allowance fields. That is a harness
runner timeout, not a tenant or answer failure.

I restored from the retained snapshot with a read-only-verified bulk update. The verification output:

```json
{"snapshotRows":20006,"modified":0,"actualRows":20006,"activeProducts":10000,"expectedLow":1535,"actualLow":1535,"SEEDSKU_0":401,"SEEDSKU_5000":331}
```

The backup was removed only after that match. The tenant is back to its pre-run shape: 10,000
ACTIVE products, 20,006 rows, 1,535 products at or below minimum, `SEEDSKU-0 = 401`, and
`SEEDSKU-5000 = 331`. No tenant, product, account or conversation was created or deleted.

## Artifact

- [`gate-2026-11-11T1801Z.json`](gate-2026-11-11T1801Z.json) — all 25 rows, answers, model, tools,
  checks, token usage and timings. It is the complete per-row artifact written after question 25;
  the process was killed before the post-loop allowance and `RESULTS` fields were added.
- [`gate-run.log`](gate-run.txt) — the 25 progress lines and the runner setup. No token or
  credential is present.
- [`restore-verification.txt`](restore-verification.txt) — the verified post-run shape.
