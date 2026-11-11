# 25-question simple-inventory gate against the deployed Render URL (2026-11-10)

This is the deployed counterpart to [the in-process 10,256-product gate](../simple-10k-2026-11-09/README.md).
Every earlier gate called `runAiChat` inside a local process against a disposable development
tenant. This run sent the same 25 question texts to the production server at
`https://ai-inventory-l1mi.onrender.com`, which reported commit `6924c50` and `status: ok`.

## What was different

- **Target.** Render production over HTTPS, not the service function in-process.
- **Dataset.** The existing synthetic `PERF SEED — AI assistant stress test (do not use)` tenant in
  `inventoryai_prod_db`: **10,000** ACTIVE products and **20,006** inventory rows, not the dev
  gate's **10,256** products and **20,539** rows. The 25 question texts are identical; the SKUs and
  expected quantities, and the five restock names, come from the tenant actually being read.
- **Five-low-stock shape.** The production tenant normally has 1,535 products at or below minimum.
  The gate needs exactly five, so all 20,006 inventory quantities were snapshotted, the same
  normalization the evaluator applies to its dev tenant was applied (`SEEDSKU-5000`–`SEEDSKU-5004`
  to zero; every other product to `max(1, minimumStock + 10)` distributed across its rows), and the
  snapshot was restored in `finally`.
- **Authentication.** The app's own production path: Firebase Admin custom token → Firebase ID
  token → `POST /api/auth/firebase/exchange`. No JWT secret was read, and no token was printed.
- **Transport.** HTTP `POST /api/ai/chat`, one request at a time, 1,000 ms gap, 120 s timeout, no
  `conversationId` (each question independent), `timeZone: Asia/Manila`.
- **Model configuration.** Render's deployed chain and reasoning switches, not the local
  `AI_REASONING_*` overrides used by the in-process run.

## Results

| Run (UTC) | Target | Products / rows | Requests | Accurate (gate) | Semantically correct | Free | Paid | Errors | Degraded | Median | p95 | Mean | Estimated cost | Provider paid delta | Duration | Free requests before → after |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-10 08:55 | in-process, dev tenant | 10,256 / 20,539 | 25 | 25 | 25 | 20 | 5 | 0 | 0 | 5,132 ms | 8,284 ms | 5,235.72 ms | $0.003269 | $0.002579 | 155.1 s | 991 → 949 |
| 2026-11-10 10:09 | deployed Render, prod tenant | 10,000 / 20,006 | 25 | 24 | 25 | 21 | 4 | 0 | 0 | 3,933 ms | 6,501 ms | 4,142.36 ms | $0.002957 | $0.002484 | 127.7 s | 933 → 882 |

**Deployed vs in-process:** median **−23.4%**, p95 **−21.5%**, mean **−20.9%**, estimated cost
**−9.5%**, provider-reported paid delta **−3.7%**, wall-clock **−17.7%**. The deployed run used
**51** free requests for 21 free answers; the in-process run used **42** for 20. Four deployed
answers fell back to `openai/gpt-oss-20b`; five did in-process.

These figures are indicative, not a controlled A/B: the datasets differ by 256 products and 533
inventory rows, the production tenant's catalogue and stock values differ, and the deployed run paid
the public-network round trip the in-process run did not.

## The one scored failure is a checker false negative

The gate's written checker scored `exists-absent` as failed:

| Field | Value |
| --- | --- |
| Question | `Do we have the product with SKU SEEDSKU-999999 in our inventory?` |
| Answer | “No product with SKU SEEDSKU-999999 is recorded in your inventory.” |
| Model / tool | `nvidia/nemotron-3.5-lightning:free`, `getProduct` |
| Time / cost | 2,749 ms, $0.000000 |
| Gate reason | `missing a denial` |

The answer is correct: it names the SKU, denies existence, and the turn read `getProduct`. The
`existenceCheck` in `server/scripts/eval-simple-inventory-scale.mjs` recognises “not recorded in
our inventory” but not the sentence form “No product … is recorded in your inventory.” This is the
same family as the earlier “not present in our inventory” false negative, and it is recorded here
rather than fixed: changing the scorer after the run would make this artifact's 24/25 disagree with
the code that produced it. Semantically the deployed gate is **25/25**.

## Restoration

After the run the tenant was restored from the snapshot and re-read:

- 10,000 ACTIVE products, 1,535 products at or below minimum (the pre-run shape).
- `SEEDSKU-0` total **401** — the value measured before the run.
- `SEEDSKU-5000` total **331** — restored from the snapshot.
- The temporary snapshot file was removed after a successful restore.

No tenant, product, account, conversation or inventory row was created or deleted. The only writes
were the temporary quantity changes during the gate, all reversed.

## Artifact

- [`gate-2026-11-10T1012Z.json`](gate-2026-11-10T1012Z.json) — all 25 rows, models, tools, token
  usage, checks, timings, cost estimate, dataset and allowance deltas.

## Verdict

- **Deployed routing works:** all 25 answers were correct and grounded, with 0 errors and 0
  degraded turns on `6924c50`.
- **Free-first is still doing most of the work in production:** 21 of 25 turns were served by
  `nvidia/nemotron-3.5-lightning:free`; 4 escalated to `openai/gpt-oss-20b`.
- **Latency and cost were lower than the in-process sample,** but the dataset and transport differ,
  so this is a direction, not a controlled measurement.
- **Open harness finding:** the absent-SKU denial wording is not recognised by the 10k evaluator's
  checker. The answer itself was right.
