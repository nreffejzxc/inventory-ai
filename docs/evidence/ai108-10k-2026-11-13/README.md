# AI-108 — absent-SKU checker fix and the 10,256-product gate (2026-11-13)

This run corrected the evaluator's denial wording and then ran the approved 25-question gate against
a disposable 10,256-product tenant in the **development** database. It did not use production
credentials, the production database or production AI configuration.

## Checker fix

The 2026-11-12 deployed gate answered the absent-SKU question correctly:

> No product with SKU SEEDSKU-999999 was found in your inventory.

The evaluator's denial regex did not recognise the `No product … was found in your inventory` form,
so the artifact recorded `missing a denial` and 24/25. The checker now lives in
[`answerCheckers.mjs`](../../../server/scripts/perf/answerCheckers.mjs) and the 10k evaluator imports
it. The denial rule accepts:

- `No product … was found in your inventory.` (the 2026-11-12 wording);
- `not present in our inventory` (the 2026-11-10 wording);
- `not recorded in the catalogue`, `not found`, `we don't have`, and the existing forms.

It deliberately does **not** treat a negative stock sentence (`No product is out of stock; every
product is in stock.`) as a denial of existence, and a plain non-answer still fails. The focused
suite [`AI108-absent-sku-checker.test.mjs`](../../../server/test/AI108-absent-sku-checker.test.mjs)
passed **6/6** before the gate.

The gate's own absent answer in this run was:

> No, we don't have a product with that SKU in our inventory.

That wording was already accepted by the old rule. The regression proof for the previously failing
wording is the focused suite, not this run's answer.

## Gate scope and monitoring

- Database: `inventoryai_dev_db` only. The evaluator's `assertSafeTarget` refuses any other target.
- Tenant: the evaluator's own deterministic `seed:perf --size=10256 --seed=1` tenant; **10,256
  products**, **20,539 inventory rows**, 20,593 transactions, exactly five restock products.
- Transport: `service`, no HTTP API and no device.
- Models: `nvidia/nemotron-3.5-lightning:free` for the primary, research and fallback slots.
  Web search and web fetch were disabled. No paid model was selected.
- Command:

  ```bash
  cd server
  AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free \
  AI_RESEARCH_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free \
  AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free \
  AI_WEB_SEARCH=disable AI_WEB_FETCH=disable \
  SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true NODE_ENV=development \
    npm run eval:simple-10k -- --phase=gate --out=.tmp-simple-inventory-scale-gate-ai108.json
  ```

- The host's 295-second command ceiling cut the shell wrapper off, but the runner continued in the
  background and wrote the complete artifact. The artifact's `startedAt`/`finishedAt` are
  `2026-11-13T16:38:33.300Z` / `2026-11-13T16:41:45.175Z`; the progress log names every question,
  model, duration and cost.

## Result

| Field | Value |
| --- | --- |
| Requests | **25** |
| Written check | **25/25** |
| Accurate answers | **25/25** |
| Errors | **0** |
| Degraded | **0** |
| Free-served | **25** |
| Paid-served | **0** |
| Cost | **$0.000000** |
| Median / p95 | **3,835 ms / 31,580 ms** |
| Mean / max | **6,703.4 ms / 38,361 ms** |
| Free allowance | **997 → 948** (49 free requests) |

Every question was answered by `nvidia/nemotron-3.5-lightning:free`. The absent-SKU row used
`getProduct` and passed; the restock count and list rows used the reorder tool and passed.

Artifact: [`gate-2026-11-13T1638Z.json`](gate-2026-11-13T1638Z.json). Progress log:
[`gate-run.txt`](gate-run.txt).

## Restore and cleanup

The evaluator snapshotted inventory quantities before the run and removes its seed tenant in
`finally`. After the runner finished, `findSeedTenantIds()` returned **0**; the seed business, owner
and its rows are gone. The first cleanup check ran while the detached runner was still deleting rows
and correctly stopped on the guard's half-state (marker name present, owner row already gone); the
second check after cleanup returned zero. No other tenant, product, account, conversation or
production row was touched.

The artifact stays under ignored `server/.tmp-*` and the log under ignored `server/.scratch/`; the
copies in this directory are the retained evidence.

## Limits

- This is a **local service-transport** gate, not a deployed-Render run. Production still serves
  `705d192`; no deployment or OTA was made by this task. The deployed gate's 24/25 artifact remains
  the deployed measurement until the corrected evaluator is deployed and rerun there.
- The run used the free model only; it does not re-measure the paid route.
- The 295-second shell ceiling detached the runner from the shell. The artifact and cleanup were
  verified independently, but the shell's own exit status is not available for this run.
