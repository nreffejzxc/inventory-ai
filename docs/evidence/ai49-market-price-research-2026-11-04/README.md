# AI-49 — market-price research stress pass (2026-11-04)

**Scope.** A disposable development tenant seeded from `server/scripts/demo/fixture.mjs` (14 products,
22 stock rows) was asked six realistic inventory questions. Production inventory, `server/.env`, the
configured model order, and the deployed 60-second/1,200-token budgets were not changed.

**Model override used for the live pass.** `nvidia/nemotron-3-ultra-550b-a55b:free` as a
process-local primary, with a 3,000-token output budget and a 120-second turn deadline. This is the
deployment's configured fallback, not a new production default.

**Testing cost guard (added after the pass).** The two live evaluation scripts now refuse any model id
that does not end in `:free` unless `AI_TEST_ALLOW_PAID_MODELS=true`, and refuse web-research
questions unless `AI_TEST_ALLOW_PAID_SEARCH=true`. The second guard is separate on purpose:
OpenRouter's web plugin is billed at about **$0.007 per search** even when the model is free, and that
charge is not covered by the free-model daily request allowance. Q3–Q6 of this pass used the plugin;
Q1–Q2 did not. The signed-in Logs page later provided the rows (see Cost audit below); the local
inference key alone could not (`GET /api/v1/activity` returns 403 without a management key).

## Deterministic checks

| Check | Result |
| --- | --- |
| `npm run typecheck` (server) | pass |
| `npm run lint` (server) | pass |
| `npm run test:unit` (server) | **1,676 pass, 0 fail, 60 skipped** (1,736 tests) |
| `TEST_MODE=unit node --test test/AI49-market-price-research.test.mjs` | **13 pass, 0 fail, 1 intentional DB skip** |
| `TEST_MODE=db node --test test/AI49-market-price-research.test.mjs` | **2 pass, 0 fail, 1 unit skip** |
| AI-47 research suite | **13 unit + 3 DB** (one new paid-search gate test) |
| Mixed-suite coverage | AI-47 and AI-49 now run in the standard `npm run test:unit` set; both paid-search gate tests are present in that run. |

The price tests cover: price extraction from cited page text only; exact `priceText`; brand/model and
variant rejection; discount/shipping/zero rejection; marketplace recognition; public-URL and
deduplication rules; no estimate when no price is visible; quota refusal; tenant binding; and the
prompt/tool contract.

## Live pass (disposable tenant, 2026-11-04)

| Question | Time | Tools | Result |
| --- | ---: | --- | --- |
| Q1 computer parts/peripherals | 23.1 s | `findProducts` | Named 9 peripherals and 8 brands; explicitly said no internal components |
| Q2 keyboard/mouse brands and stock | 26.3 s | `findProducts` | Correct brands, products and units |
| Q3 mechanical-keyboard review/recommendation | 60.7 s | `findProducts`, `researchInventoryProducts` | Recommended only a stocked keyboard; cited review sources; said Razer had no sourced findings |
| Q4 K8 Pro/RK61 price comparison | 59.8 s | `findProducts`, `researchMarketPrices` | Cited Keychron PH, Game One, PriceMe, iTech and Bermor; stated no verified Shopee/Lazada/Amazon price |
| Q5 good value under 10,000 | 76.3 s | `findProducts`, `researchInventoryProducts` | Seven priced products under the threshold; recorded price/stock kept separate from snippets |
| Q6 MX Master 3S reliability | 49.1 s | `searchProducts`, `researchInventoryProducts` | Said the evidence was professional-review snippets, not owner reviews; cited three URLs |

**Q4 excerpt.** The recorded K8 Pro price was set against cited listings of **₱5,195–₱5,895** and the
RK61 against **₱1,995–₱2,369**. The answer did not invent a marketplace price:

> The tool searched Shopee Philippines, Lazada Philippines, Amazon and other cited retailers. The
> verified listings it returned are from other Philippine retailers; no verified price from Shopee,
> Lazada or Amazon itself appeared in the results.

**Q5 retest.** After the stricter publication-URL rule was added, a second Q5 run spent six tool
rounds and hit the 120-second deadline. The first Q5 run (recorded above) completed; the broad
multi-product value question is therefore not stable on every attempt. This is a model/tool-loop
limitation, not a failure of the individual inventory, research or price tools.

## Cost audit (OpenRouter Logs, 2026-11-04)

The signed-in OpenRouter **Logs** view for the past 24 hours held **31 generations** from the
`inventoryai` app. Every generation used a free model: **29** `Nemotron 3 Ultra (free)` and **2**
`LFM2.5-2.6B (free)`. Fifteen rows cost **$0.007 each**, totaling **$0.105**; every other row cost
**$0.00**. The $0.007 rows are the OpenRouter **web-plugin searches**, not model tokens. That is the
credit deduction. The local inference key cannot read `/api/v1/activity` (403: management key
required); these rows came from the signed-in Logs page.

**Runtime gate (after the pass).** `AI_ALLOW_PAID_WEB_SEARCH` now defaults to **false** in
`aiConfig()`. Review research uses the free DuckDuckGo HTML fallback, and price research uses
the keyless free path without an OpenRouter request. Set it to true only with owner approval. The test
harnesses also refuse every model id that does not end in `:free` unless
`AI_TEST_ALLOW_PAID_MODELS=true`.

## Direct marketplace probes

| Marketplace | Observation |
| --- | --- |
| Shopee | Search API returned HTTP **403** (`error:90309999`); product page returned an anti-bot shell with no title, price or JSON-LD price |
| Lazada | Product page's `Product`/`AggregateOffer` JSON-LD had availability and URL but **no price value**; the one peso amount on the page was not attributable to the exact product |
| Amazon | The target ASIN's `corePrice_desktop` block was empty; search results contained unrelated sponsored prices |

The tool therefore does not scrape a number from a marketplace page whose page does not expose a
verifiable price. It reports the marketplace as unavailable and returns prices only from cited
retailer pages that name the recorded product.

## Performance follow-up (2026-11-04)

Four brand groups and three price products now run at once. The price result returns only each
citation's title and URL; the 2,500-character page body stays inside the extractor. Q4 fell from
**59.8 s** on the first pass (and **91.4 s** in a provider-variable rerun) to **47.5 s**, with 36.2 s
of provider time and 11,001 input tokens. Q3 measured **60.0 s** with the ultra research override and
**67.1 s** with the default liquid research model (10.3 s tool time; 56.9 s final generation). The
final model, not search, is now the dominant cost.

## Phone readability check

scrcpy mirrored the connected CPH1969. The installed preview app (version 1.0.1, build 8) rendered the
dashboard and the AI Assistant composer clearly at phone width. That build carries the older
JavaScript, so the new specifications section and AI-49 price answer were not present. Expo Go 58
loaded the new bundle but stopped at `NativeRNFBTurboApp is not registered`; a development build or an
approved preview OTA is required for a visual check of the new UI. No new production AI query was
sent before approval.

## Free research path (2026-11-04)

The default path uses **no OpenRouter web plugin and no paid search API**. It combines keyless
DuckDuckGo HTML results (with a second user-agent and DuckDuckGo Lite retry), an optional
self-hosted SearXNG JSON endpoint through `AI_FREE_SEARCH_URL`, and direct public result pages.
Page fetches are bounded to 9 seconds, 1.5 MB and three redirects, and private/link-local URLs and
DNS answers are refused. A price becomes a listing only when the recorded brand and a model token
appear beside the exact price text; `priceSource` says whether it came from a public page or a
search-result snippet. A live free lookup found Keychron PH at **₱6,000.00** for the Keychron K8
Pro in **2.3 s** with no paid route.

Alternatives rejected for this default: Brave Search API (card required and metered), Google Custom
Search (closing to new users and billing above the free cap), Mojeek (card required), and commercial
price APIs (trial credits, then paid). There is deliberately **no paid fallback**.

## Remaining limitations

- **Budget.** Research-heavy turns fit the 120-second evaluation deadline but not the deployed
  60-second/1,200-token default. Q3 took 60.7 s, Q5 76.3 s, and the Q5 retest 120 s. No production
  budget was changed.
- **Currency.** `Product` has no currency field. The prompt forbids adding a symbol or converting the
  recorded price; Q5 followed that, while Q1/Q4 still inferred `₱` because the tenant's seeded
  prices are illustrative Philippine pesos. A recorded currency is the durable fix.
- **Marketplace coverage.** No direct Shopee, Lazada or Amazon price was verified in this pass.
  The cited listings are other Philippine retailers and a comparison site.
- **Web evidence.** Findings can be search-result snippets rather than full reviews; the answers say
  so where the tool marked them that way.
- **Q5 stability.** The second run timed out after repeated research calls. A hard per-turn research
  cap, or a faster model/deadline, is required before calling broad value questions reliable.

## Artifacts

- `server/src/services/ai/marketPrices.ts` — citation-only price research.
- `server/src/services/ai/tools.ts` — `researchMarketPrices`, tenant-bound and read-only.
- `server/test/AI49-market-price-research.test.mjs` — unit and DB suites.
- `server/scripts/eval-ai-stress.mjs` — disposable-tenant stress harness. Its results are written to
  the git-ignored `server/.tmp-ai-stress-results.json`; the disposable tenant is removed afterward.
