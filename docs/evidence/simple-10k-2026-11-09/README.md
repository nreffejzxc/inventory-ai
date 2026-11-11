# 10,256-product simple-inventory gate (2026-11-10)

This report records the production-scale gate for the AI-99 resumable evaluator. The evaluator
creates a deterministic disposable tenant in `inventoryai_dev_db` — 10,256 ACTIVE products,
20,539 inventory rows, 20,593 transactions, three locations, four categories, and five products
at or below minimum — asks 25 simple-inventory questions, checkpoints each completed request, and
removes the tenant in `finally`. The script refuses every database except the development
database. **No production data or production server was used.**

## Results

| Run (UTC) | Requests | Accurate | Free | Paid | Errors | Median | p95 | Estimated cost | Free remaining before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-09 15:19:01 | 25 | 25 | 4 | 21 | 0 | 6,706 ms | 13,253 ms | $0.01413951 | 12 → 0 |
| 2026-11-09 19:38:13 | 25 | 24 | 0 | 25 | 0 | 4,252 ms | 12,175 ms | $0.01672445 | 0 → 0 |
| 2026-11-09 19:48:00 | 25 | 24 | 0 | 24 | 1 | 4,519.5 ms | 8,071 ms | unknown | 0 → 0 |

The 15:19 artifact was already present in the workspace when this run began. Its configuration
matches the same 10,256-product seed and model chain; it is included for context, not as a fresh
execution. The 19:38 and 19:48 runs were executed for this record.

The 19:48 artifact is complete but its total cost is deliberately `unknown`: 24 answered rows
cost $0.01582547 in total, while the one failed row has no provider cost. The authoritative
account delta for that run is **$0.029593753** (paid usage $1.017035355 → $1.046629108). The
19:38 provider delta was **$0.027882885** (paid usage $0.98408932 → $1.011972205), against an
estimated row total of $0.01672445. The provider delta is higher than the token estimate; it is
the number to use for spend.

## What the runs show

### Free-first service

The 15:19 artifact started with **12** free requests remaining and served **4** answers on
`nvidia/nemotron-3.5-lightning:free` before the allowance reached zero. Its remaining 21 answers
used the paid primary. That is direct evidence that the free-first route can serve this dataset
when the allowance is available.

Both fresh runs started with **0/1000** free requests remaining and ended at zero. Every answered
question therefore used `openai/gpt-oss-20b`; no free-served request was possible. The fresh
runs do not re-prove free service.

### Checker false negative — corrected

The 19:38 gate scored 24/25. Its only "failure" was the absent-SKU question:

> **Answer:** “No, the SKU SEEDSKU-999999 is not present in our inventory.”
> **Expected:** absent
> **Old check:** `missing a denial`

The answer is correct, but `existenceCheck` only recognised “not in our inventory”, not “not
present in our inventory.” The evaluator now accepts both forms. This is a harness correction,
not a weakening of the answer check. The 19:48 gate passed `exists-absent` with the corrected
parser.

### Real failure — output limit

The corrected 19:48 gate scored 24/25 with one genuine error:

| Field | Value |
| --- | --- |
| Question | `How many units of the product with SKU SEEDSKU-0 are in stock?` |
| Expected | 75 units |
| Result | `AiOutputLimit` after 23,374 ms |
| Answer | empty |
| Model / tools / usage | none recorded |
| Cost | unknown |

This is a real model reliability finding, not a parser artifact. It is intermittent: the same
question passed in the 19:38 run, and the 15:19 run had no errors. It is not fixed by this
record.

## Configuration

- **Dataset:** size 10,256, seed 1, development database `inventoryai_dev_db`.
- **Gate:** 25 requests, concurrency 1, 1,000 ms gap, service transport.
- **Models:** primary `openai/gpt-oss-20b`; free candidate
  `nvidia/nemotron-3.5-lightning:free`.
- **Command:**

  ```bash
  cd server
  SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true NODE_ENV=development \
    npm run eval:simple-10k -- --phase=gate
  ```

- **Cleanup:** `findSeedTenantIds()` returned `[]` after the fresh runs. The checkpoint was
  removed when each completed phase wrote its artifact.

## Artifacts

- [`gate-2026-11-09T1519Z.json`](gate-2026-11-09T1519Z.json) — pre-existing 25/25 run, 4 free.
- [`gate-2026-11-09T1938Z.json`](gate-2026-11-09T1938Z.json) — first fresh run, checker false
  negative.
- [`gate-2026-11-09T1948Z.json`](gate-2026-11-09T1948Z.json) — corrected run, one real
  `AiOutputLimit`.

## Verdict

- **Answered accuracy:** 24/24 answered requests in the corrected run; 25/25 in the 15:19
  artifact.
- **Free-first service:** demonstrated by the 15:19 artifact (4 free), not by either fresh run
  because the allowance was already at 0/1000.
- **Reliability:** one real `AiOutputLimit` out of 25 is an open finding.
- **Production impact:** none; this is a disposable development-tenant evaluation, not
  production traffic.
