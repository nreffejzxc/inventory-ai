# Brand sites, marketplaces and social sources — research pass on the owner's phone (2026-11-04)

Every question below was typed on the OPPO `PV4DDMIZZLTCIVSK` phone, mirrored to the laptop with
scrcpy so the run could be watched live, and driven with `adb` input. The screenshots in this
directory are the phone's own frames (`adb exec-out screencap`).

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android, screen 1080×2400, time zone `Asia/Manila` (UTC+8)
- App: development client (`npx expo start --dev-client`), Metro on `8081`
- API: local development server on `http://127.0.0.1:4000`, reached from the phone through
  `adb reverse tcp:4000`
- Tenant: business `6ae164357b1cce3d75857a35`, user `6ae164367b1cce3d75857a36` (OWNER)
- Database: `inventoryai_dev_db`
- Catalogue used by the questions: **Redragon K552 Kumara** — PHP 1,499; **ASUS ROG Strix G16
  (2024)** — PHP 89,995; **Alienware m16 R2** — PHP 139,995, SKU `AW-M16R2-4070`, 1 available,
  minimum 1 (so the restock list flags it as Low)
- Model: `AI_PROVIDER=openrouter`, `nvidia/nemotron-3.5-lightning:free`, 1200 output tokens.
  `AI_ALLOW_PAID_WEB_SEARCH=false`, so all research used the free keyless search path.

## Questions and what came back

| # | Question (as typed) | Tools the assistant ran | Result | Screenshot |
|---|---|---|---|---|
| 1 | How does our Redragon K552 compare with what it costs online? | `findProducts`, `researchMarketPrices` | Catalogue facts quoted exactly (PHP 1,499, stock), online listings quoted only where a price was actually parsed | `01-compare-k552.png`, `01b-compare-k552-prices.png`, `01c-compare-k552-listings.png` |
| 2 | What is the newest ROG Strix G16 and does it change anything we stock? | `findProducts`, `researchInventoryProducts` (`specifications` focus) | Official ASUS ROG page for the current model year quoted as the source | `02-g16-official-site-updates.png`, `02b-g16-official-site-updates.png`, `02c-g16-updates-budget.png` |
| 3 | Do reviewers say the Alienware m16 R2 is reliable? | `findProducts`, `researchInventoryProducts` | Review-level claims tied to named sources; the assistant says plainly where it has only snippet evidence | `03-alienware-reviews-social.png` |
| 4 | What does a named shop charge for the m16 R2? | `findProducts`, `researchMarketPrices` with the shop named in `stores` | The named store is queried directly and reported in `storeChecks`; no price is invented when the shop page is JS-only | `04-rkgaming-shopee.png`, `04b-named-stores.png` |
| 5 | Compare our m16 R2 with what people say about it on social media | `findProducts`, `researchInventoryProducts` | Social results used only as "what people say" evidence, never as prices | `05-social-comparison.png` |
| 6 | Check Amazon and Lazada for the m16 R2 and tell me whether we are priced well | `researchInventoryProducts`, `researchMarketPrices` | **Failed before the fix**: a carousel card's price was reported as this listing's price (see finding 1) | `06-amazon-lazada-verify.png` |
| 7 | Same question, after the price-extraction fix | `findProducts`, `researchInventoryProducts`, `researchMarketPrices` | Both marketplaces reported as reached with no matching listing, a third-party price quoted with an explicit caveat, and the affordability verdict stated as "I cannot verify" (`out=954`) | `07-amazon-lazada-after-caro-fix.png` |
| 8 | Same question again, checking the answer's wording | same tools | Same honest verdict, plus the Lazada tag page named as `(no matching product)`; no tool field names in the prose (`out=571`) | `08-amazon-lazada-plain-wording.png` |
| 9 | On the official Alienware site what does it list for the Alienware m16 R2 and is there a newer Alienware model than the one we stock | `findProducts`, `researchInventoryProducts` | Official Dell/Alienware pages quoted with links (specs page, m16 R2 page, Dell USA page) and the "newer model" part answered as not found rather than guessed; answer hit the output cap, and the app said so | `09-alienware-site-specs.png` |
| 10 | Which products are low on stock? (after the API restart) | `getReorderNeededProducts` | Correct: Alienware m16 R2, 1 pcs, Low, with the restock-list link (`out=207`) | `10-after-restart-low-stock.png` |

Server-side turn log (`.tmp-ai53-server.log`, development API) confirmed the tool sequence, the
outcome and the latency of each turn: 6–25 s per answer, 1–3 model calls, 0–2 tool rounds.

## What was wrong, and what was measured

### 1. A carousel card's price was reported as the listing's price

The Amazon page for the m16 R2 (`dp/B0DB8L32X1`) states each price **twice**: once as glued,
off-screen text (`PHP71,20336`) and once as a split pair (`PHP 71,203` followed by `36`). The
number that turned up as "the price of the m16 R2" — **PHP 71,203** — belongs to a different
product in the "N offers from" carousel, whose card links `dp/B0BXFKXG6N`.

**Fix** (`server/src/services/ai/marketPrices.ts`, `extractPrices`): every `offers? from` block is
read for the first amount that follows it, and any candidate whose digits prefix-match that amount
in either direction is dropped before the numeric parse. Measured check:

```
extractPrices('4.1 out of 5 stars 315 4 offers from PHP71,20336 PHP 71,203 36 Alienware X16 R2…')
  -> []                       // before: [{ amount: 71203, … }]
```

Covered by `server/test/AI53-real-world-research.test.mjs`
("another item's offers from block is not this listing's price").

### 2. The answer quoted the tool's own field names

A frame from the earlier pass showed `storeChecks` / `listings: []` fragments in the prose. The
answer prompt now states the rule in plain language (rule 23 in
`server/src/services/ai/ai.service.ts`): say *"the Amazon pages were read and showed no listing
for this model"*, never the field name, and keep field names out of any notes table. Frames `07`
and `08` are the before/after of that on the device.

### 3. A turn could spend its whole output budget twice and answer nothing (found in this pass)

Question 9's first attempt came back with **no answer at all**:

```
[ai:openrouter] output limit reached with nothing usable (model=nvidia/nemotron-3.5-lightning:free, maxTokens=1200, stop=max_tokens)
[ai] output limit reached with no content — resending the request once model=… out=1200
[ai:openrouter] output limit reached with nothing usable (…)
[ai] turn outcome=AI_OUTPUT_LIMIT total=18399ms calls=2 toolRuns=0 tools=none empty=1 out=1200
```

The AI-52 retry resends the **identical** request, which at temperature 0 mostly re-spends the
budget on the same preamble. **Fix**: the retry now adds one brevity instruction ("at most one
tool call, with a short query, or a direct answer under 120 words"), so the resent turn is a
different request; if it still fails, the limit is reported exactly as before. Covered by
`server/test/AI10-output-limit-not-an-outage.test.mjs`
("the retry asks for brevity instead of resending the identical request").

### 4. Product-update questions needed their own research focus

Dropping the model year from the update query is what surfaces the official current-year page; a
member-named shop is queried through the `stores` parameter and reported through `storeChecks`
rather than being inferred from search snippets.

## Limitations this pass could not remove

- **Shopee and Lazada publish prices with JavaScript.** Their HTML carries no parseable amount, so
  those two marketplaces are reported as reached with no matching listing rather than guessed at
  (frames `07`, `08`).
- **Some retailers answer `403` behind Cloudflare**, and several Philippine shops carry neither of
  the games-store SKUs; `rkgamingstore.com` stocks Royal Kludge, not Redragon.
- **The free keyless search engine throttles and occasionally returns junk**; the anchored-query
  fallback added in AI-52 reduces but does not remove that.
- **The 1200-token answer cap is deliberate** (`aiConfig.ts`). Long brand questions (`09`) reach it;
  the app shows "This answer hit the length limit…" instead of pretending the answer is complete.
- **Spec values can be cut inside a snippet** — the model reports what the source said and marks it
  as snippet-level evidence.
- **The installed development build still rendered the raw "What the tool found" JSON chip** for
  tool calls (`storeChecks`, `listings: []`). CORRECTION (2026-11-05): that claim was wrong — the
  chip text is built in this repository, by `mobile/lib/toolLabels.ts` (`toolTrace`/`toolLabel`),
  which maps each tool to a member-facing label and falls back to a humanised name rather than raw
  JSON. Nothing needed to change outside the repo; what the current build shows for a tool turn is
  the `Read: Stock value` style footer (see `../ai54-60-grounded-answers-2026-11-05/`).

## Verification run after the fixes

```
cd server && node scripts/run-tests.mjs unit   -> 1780 tests, 1719 pass, 0 fail, 61 skipped (36 s)
cd server && npx tsc --noEmit                  -> clean
```

The API was restarted on the new code before frame `10`; nothing was committed, pushed, deployed or
sent over the air.
