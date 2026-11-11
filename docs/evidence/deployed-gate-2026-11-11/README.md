# Deployed 10K simple-inventory gate — 2026-11-11

This reruns the deployed counterpart to `eval-simple-inventory-scale.mjs --phase=gate` against the
production Render URL at commit `3b275df57b590dd4e5edab2690f5387589b10d11`. It uses the existing
synthetic `PERF SEED — AI assistant stress test (do not use)` tenant (`6af18628a9a409131a84235b`) in
`inventoryai_prod_db`: **10,000 ACTIVE products / 20,006 inventory rows**. Authentication is the
app's own Firebase custom-token → ID-token → `/api/auth/firebase/exchange` path; no JWT secret and
no token were printed.

## Run

| Field | Value |
| --- | --- |
| Window (UTC) | 2026-11-11 16:31:25 → 16:34:14 |
| Target | `https://ai-inventory-l1mi.onrender.com` |
| Deployed commit | `3b275df` |
| Requests | 25 sequential `/api/ai/chat` questions |
| Dataset shape | 10,000 products, 20,006 rows, exactly 5 restock products |
| Low SKUs | `SEEDSKU-5000` … `SEEDSKU-5004` |
| Result | **25/25 accurate**, **25 free-served**, 0 paid, **0 errors**, **0 degraded** |
| Latency | median **4,932 ms**, p95 **10,549 ms**, mean 5,788.92 ms, min 2,790 ms, max 11,754 ms |
| Estimated cost | **$0.000000** |
| Free allowance | 969 → 928 remaining (41 free requests for 25 answers, including retries/re-asks) |

Every answer was served by `nvidia/nemotron-3.5-lightning:free`. The provider paid-usage reading
moved by **$0.00182764** during the same window, but the concurrent paid long-thread phone turns
account for that; none of the gate's 25 requests used a paid model.

## Output-limit check

Render's application logs were searched for `AI model hit its output limit` over the run window. The
only matching line in the last hour is the earlier **11:53:13 PM** event on `turn=e4570da9`; **no
output-limit event was logged during the gate run**. The gate also recorded zero `AiOutputLimit`
errors and zero degraded answers. This removes the one intermittent `AiOutputLimit` occurrence that
had remained from the previous gate.

## Restoration

The runner snapshotted all 20,006 inventory rows before normalization, applied the five-low-stock
shape for the run, and restored the snapshot in `finally`:

```text
[deployed-gate] restored 20006 inventory row(s) from the snapshot
[deployed-gate] RESULTS 25/25 accurate, free=25, paid=0, errors=0, degraded=0,
  median=4932ms, p95=10549ms, cost=$0.000000
EXIT:0
```

The temporary `.tmp-deployed-gate-inventory-backup.json` was removed after the restore. A
read-only re-read of the tenant confirmed the restored shape (10,000 ACTIVE products / 20,006 rows /
1,535 products at or below minimum, `SEEDSKU-0 = 401`, `SEEDSKU-5000 = 331`), matching the pre-run
production shape.

## Artifact

- [`gate-2026-11-11T1634Z.json`](gate-2026-11-11T1634Z.json) — all 25 rows, answers, models, tools,
  checks, token usage, timings, dataset and allowance deltas.
