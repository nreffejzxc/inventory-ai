# AI-51 — full tool audit: defects found, fixes, and recommendations (2026-11-04)

**Scope.** Every tool the assistant can call was exercised against real data: the eleven database/catalog
tools (`findProducts`, `searchProducts`, `getProduct`, `getInventory`, `listCategories`, `listBrands`,
`stockMovements`, `inventoryValuation`, `lowStock`, `outOfStock`, `expiringSoon`) and the two research
tools (`researchMarketPrices`, `researchInventoryProducts`). Database results were compared with raw Mongo
aggregates on a disposable development tenant; the research tools were run against the live public web
with `AI_ALLOW_PAID_WEB_SEARCH=false`, so no paid search or model spend was possible. No production
inventory, `server/.env`, model order or deployed budget was touched.

## Defects found and fixed

| # | Defect | Fix | Proof |
| --- | --- | --- | --- |
| 1 | The model could repeat the same tool call with identical arguments until the step budget ran out, producing a turn with no answer. | `ai.service.ts` keys each call (`name` + canonical arguments), returns a `repeatNotice` pointing at the earlier result, and stops offering tools once the answer round starts. | `server/test/AI50-ai-tool-loop-and-currency.test.mjs` |
| 2 | Prices were recorded with no currency, so ₱6,990 and $6,990 were indistinguishable in answers, brand ranges and totals. | `Product.currency` is an optional ISO-4217 field (null = unknown), validated, persisted, exposed through the API, sent to the model, and editable in the mobile product form. | AI-50 suite + live `listBrands` returning `currency: "PHP"` |
| 3 | Research notes claimed the catalogue had no currency field, and the marketplace list was a fixed constant reported as if it had been checked. | `RECORDED_PRICE_NOTE` rewritten; results now carry `searchedQueries`, `checkedMarketplaces` and `targetedMarketplaces` derived from the sources actually read. | `AI51-tool-audit-fixes.test.mjs` (pin tests), live result listing only `keychron.ph` |
| 4 | Scraped text kept HTML entities (`&amp;`, `&#8211;`, `&nbsp;`), so product titles and snippets reached the model as `Keychron K8 Pro QMK&#47;VIA`. | `decodeHtmlEntities` in `freeWeb.ts`, applied by `cleanSearchText`, the price cleaner and the research cleaner. | entity unit tests + live decoded title (`–` en dash) |
| 5 | `searchProducts` only matched name/brand/SKU/barcode, so "keyboard" found nothing even though two products record "mechanical keyboard" in their description. | Fallback match on description/specifications, with `matchedOn` and a note that these are possible, not confirmed, matches. | AI-51 DB assertions + live run (`count: 2`, `matchedOn: [description, specifications]`) |
| 6 | Brand summaries averaged prices across currencies and returned one bare `priceRange`. | Per-currency `priceRanges`, `currencies`, and `mixedCurrency: true` with a null `priceRange`. | live `listBrands` (PHP ranges) + mixed-currency DB test |
| 7 | Single-product research was keyed to the brand, so a K8 Pro query returned findings about sibling models. | Findings are keyed to the product; the brand-qualified retry is labelled brand-level with a qualifier sentence. | live run: genuine K8 Pro reviews only |
| 8 | Market-price search spent its four page fetches on category/tag pages, which quote many products' prices, and retried a search that had already timed out or been refused. | `productPageHint` ranks product-detail URLs first and skips listing pages before the fetch budget; the brand retry runs only after a search that actually answered. | new `productPageHint` unit test; live result ₱6,000.00 from keychron.ph in one query |
| 9 | The chat empty state offered only stock questions, hiding the research capability. | Welcome copy mentions web research; a price-research starter chip added. | mobile jest (`ai24`, `ai9`) |
| 10 | A research answer's own source links reached the screen as markup — `[Keychron Philippines product page](https://keychron.ph/…)` and `<https://techpickstream.com/…>` — so the one thing that makes a researched price checkable could not be opened. | `parseInline` now produces an `href` span for `[label](https://…)` and `<https://…>` (http(s) only, so `javascript:` stays text); the renderer draws it as an underlined link and opens it with `Linking`, falling back to an alert with the address. | `mobile/__tests__/assistant-parser-edges.test.ts` (5 link cases) + device screenshots below |

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (server) | pass |
| `node scripts/run-tests.mjs unit` | **1,751 tests, 1,690 pass, 0 fail, 61 skipped** |
| `TEST_MODE=db node --test test/AI51-tool-audit-fixes.test.mjs` | **5 pass, 0 fail, 1 unit skip** |
| `TEST_MODE=unit node --test test/AI49-market-price-research.test.mjs` | **13 pass, 0 fail** |
| `npx tsc --noEmit` + jest `ai24`, `ai9` (mobile) | pass, 17 tests |
| `npx tsc --noEmit` + jest `assistant-parser-edges`, `ai2`, `ai4`, `assistant-real-answers`, `assistant-markdown-invariant` (mobile) | pass, 79 tests — 5 of them the new link cases |
| Live `researchMarketPrices` (K8 Pro) | `available: true`, `₱6,000.00`, keychron.ph, one query, honest `checkedMarketplaces` |
| Live `researchInventoryProducts` (K8 Pro) | product-kind finding from three K8 Pro reviews |
| Live `searchProducts` / `listBrands` / `getInventory` / `stockMovements` / `inventoryValuation` / `lowStock` / `outOfStock` / `expiringSoon` | matched raw Mongo aggregates; cross-tenant ids refused |

## Device verification (Android, mirror + screenshots)

Every scenario was run on the physical phone through the dev build (`adb reverse` to the local API on :4000 and
Metro on :8081), not on a simulator, so the screenshots below are the app as the member sees it.

| Scenario | Asked | Result |
| --- | --- | --- |
| S1 | "Do the store sell any keyboards?" | Both keyboards listed with stock and `Price (PHP)` — the currency field added in this increment reaches the answer. `s1-keyboards-found.jpg` |
| S2 | "What do our keyboards cost online?" | Honest "unable to retrieve current online prices", no invented listing for either product, then the recorded PHP prices. This is the expected free-path limit, not a defect — see below. `s2-category-price-honest-no-listings.jpg` |
| S3 | "How much does the Keychron K8 Pro sell for online?" | `₱6,000.00 on keychron.ph — Keychron Philippines product page (public-page source, retrieved 2026-11-04)`, beside the recorded PHP 6,990. The `productPageHint` fix (defect 8) proven end to end. `s3-single-product-price-found-before-link-fix.jpg` shows the link still as raw markup; `s3-link-rendered-after-fix.jpg` is the same answer after defect 10 was fixed. |
| S4 | "What do reviews say about the Keychron K8 Pro?" | Research cards quoting three real review sources with the exact snippet each one returned. `s4-review-sources.jpg`; `s4-source-url-tappable.jpg` shows a card URL rendered as a link, and `s4-link-opens-chrome.jpg` is Chrome on the rtings.com review after tapping it — press → `Linking` → browser verified on device. |

S2 deserves a precise explanation because it looks like a regression and is not one. A category-level price question
matches marketplace pages, and the retailers that dominate the results (Shopee, Lazada) render their prices in
JavaScript, so the fetched HTML carries no price to quote. The tool therefore returns `available: false` rather
than quoting a category listing's "from ₱X" banner as a product price. Asking about one model (S3) is what the free
path can answer, which is why the model's follow-up and the empty-state chip both name a product.

Two behaviours are limitations of the free path, not defects: several retailers (Shopee, Lazada, keychron.com)
render prices in JavaScript or refuse automated fetches, so a product may legitimately return
`available: false` with `NO_PRICE_FOUND`; and free search result order varies between runs, so a price found
in one run may need the brand-qualified retry in the next.

## Recommended improvements (not implemented)

Ordered by value per unit of risk.

1. **Paging for capped list tools.** `findProducts`, `searchProducts`, `stockMovements` and the other list
   tools return one page of up to 25–50 rows. A question like "which of our 300 products have not moved this
   quarter?" gets a truncated list with no way to continue. Add `offset`/`cursor` plus a `hasMore` cursor hint
   and let the assistant page until the question is answered.
2. **Category and brand empty states.** `searchProducts` returning nothing should also say which categories and
   brands do have products ("no match in Keyboards; the catalogue holds 12 categories"), so the model can
   redirect the member instead of reporting an empty catalogue.
3. **Retailer-priority page fetching.** Keep a small allowlist of hosts known to render prices server-side per
   country (Shopee/Lazada product pages are client-rendered; official brand stores usually are not) and fetch
   those first, with the current hint ranking as the fallback.
4. **Price history instead of one snapshot.** Store each verified listing with its retrieval time so a second
   question can say "the last three checks saw ₱6,000, ₱6,200, ₱6,000" and flag a real price change rather than
   re-searching from zero.
5. **Low-stock urgency from sales velocity.** `lowStock` currently ranks by quantity. Adding days-of-cover from
   recent outgoing movements would let the assistant say "4 left, sells ~2/day, out in about 2 days" — the most
   actionable inventory sentence it could produce.
6. **Research scope confirmation.** Before spending the free-search budget on a broad request ("research our
   suppliers"), ask which products to price or review; the tool already caps at three products, so a quick
   confirm avoids a partial answer.
7. **Snippet-level spec extraction.** `researchInventoryProducts` returns snippets; extracting specs into
   fields (switch type, layout, capacity) with the source URL per field would let the assistant compare a
   recorded specification with what reviewers report.
