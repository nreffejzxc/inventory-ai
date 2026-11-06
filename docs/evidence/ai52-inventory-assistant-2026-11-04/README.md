# Inventory AI assistant — realistic question pass on the owner's phone (2026-11-04)

Every question below was typed on the OPPO `PV4DDMIZZLTCIVSK` phone, mirrored to the laptop with
scrcpy so the run could be watched live, and driven with `adb` input. The screenshots in this
directory are the phone's own frames (`adb exec-out screencap`).

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android, screen 1080×2400, time zone `Asia/Manila` (UTC+8)
- App: development client (`npx expo start --dev-client`), Metro on `8081`
- API: local development server on `http://127.0.0.1:4000`, reached from the phone through
  `adb reverse tcp:4000`
- Tenant: business `6ae164357b1cce3d75857a35`, user `6ae164367b1cce3d75857a36` (OWNER)
- Database: `inventoryai_dev_db`
- Catalogue used by the questions: **Keychron K8 Pro** — PHP 6,990, 4 units; **Royal Kludge
  RK61** — PHP 2,499, 7 units
- Model: `AI_PROVIDER=openrouter`, `nvidia/nemotron-3.5-lightning:free`, 1200 output tokens.
  `AI_ALLOW_PAID_WEB_SEARCH=false`, so all research used the free keyless search path.

## Questions and what came back

| # | Question (as typed) | Tools the assistant ran | Result | Screenshot |
|---|---|---|---|---|
| 1 | What keyboards do we sell? | `searchProducts` | Both keyboards listed with correct stock and prices | `01-keyboard-list.png` |
| 2 | Is the K8 Pro worth its price compared to online prices? | `searchProducts`, `researchMarketPrices` | **Failed** before the fix: "no online price confirmed" — no listing found | `02-price-compare.png` |
| 3 | Is the Royal Kludge RK61 reliable? What do reviews say? | `searchProducts`, `researchInventoryProducts` | Honest "no review data available" answer; stock and price still correct | `03-rk61-reliability.png` |
| 4 | Is the K8 Pro worth its price compared to online prices? (retry after the retry logic was added) | `searchProducts`, `researchMarketPrices` | Still no verified price that turn — the engine answered with unrelated results | `04-price-compare-retry.png` |
| 5 | How does our K8 Pro price compare to what online stores charge? | `findProducts`, `researchMarketPrices` | **Prices resolved**: DataBlitz ₱5,195, Keychron PH ₱6,000, keychron.com US$59.99–99.99; USD deliberately not converted | `05-price-compare-debug.png`, `06-price-compare-top.png` |
| 6 | What should I restock this week? | `getReorderNeededProducts` | "No ACTIVE products flagged for restocking" with the restock-list action | `07-restock.png` |
| 7 | Which of our keyboards has the best reviews? I want to recommend one to a customer. | none this turn | Answer built from earlier research in the same chat: K8 Pro snippets flagged as snippet-level evidence with named concerns, RK61 "no review data" | `08-best-reviews.png`, `09-best-reviews-top.png` |
| 8 | Which of our keyboards has the best reviews? | none this turn | Same answer, repeated from the conversation instead of re-running the tool | `10-best-reviews-retry.png` |
| 9 | Do we have any out of stock items? | `getOutOfStockProducts` | "0 products at zero or below" — correct | `11-out-of-stock.png` |
| 10 | Do we sell the Logitech MX Master 3 mouse? | `searchProducts` | "Not in your active catalog", zero matches, no invention | `12-non-stock-product.png` |
| 11 | A customer has 3000 pesos. Which keyboard should I offer? | none this turn | Recommends the RK61 at PHP 2,499 with 7 units in stock, mentions the K8 Pro only as the pricier step up — all figures match the catalogue | `13-budget-recommendation.png` |

Server-side turn log (`.tmp-ai52-server.log`, development API) confirmed the tool sequence and the
latency of each turn: 4–26 s per answer, 1–2 tool rounds.

## What was wrong, and what was measured

### 1. The keyless search engine returns junk for some answers, and the junk is random per call

Measured on 2026-11-04 with repeated rounds of the same queries:

- Query shapes ending in `review` (`"Keychron K8 Pro" review`, `"Royal Kludge RK61" review`):
  **6 of 6** runs returned six relevant sources each.
- Query shapes ending in `reliability` or `quality`: unrelated pages (zhihu, ChatGPT GitHub topics,
  YouTube, royal.uk) on repeated rounds.
- The identical query `Keychron K8 Pro price` returned DataBlitz/keychron.com/keychron.ph on one
  call and nothing usable on the next. That is what produced the phone's "no online price" answer
  in turns 2 and 4.
- A burst probe of 16 consecutive searches (4 queries × 4 rounds) returned **6 of 6 relevant
  sources every time**, so this is a transient bad answer, not rate limiting or a broken parser.

**Fix.** Both research paths now spend one extra call on the anchored query shape that measured
well when the engine answered but nothing relevant came back:

- `server/src/services/ai/webResearch.ts` — `searchFallback()` tracks whether the engine answered
  at all (`answered`); if it did and the sources were unusable, it re-runs the anchored
  `<name> review` query once before giving up. A non-answering engine still short-circuits, so a
  blocked engine does not cost an extra request.
- `server/src/services/ai/marketPrices.ts` — `searchSubjectPricesFree()` repeats the anchored
  `<name> price` query once when the first attempt produced no verified listing.
  `searchedQueries` still lists each distinct query once.

### 2. The model reused an old research failure instead of retrying

In turns 7–8 and 11 the assistant answered from tool output earlier in the conversation and made
**no tool call at all** (log: `toolRuns=0`). The facts happened to be correct, but a stale
`available:false` from an earlier turn was being treated as "this product has no reviews". Turn 7
also printed the internal reason code `SEARCH_UNAVAILABLE` to the owner.

**Fix.** Rule 21 of the system prompt (`server/src/services/ai/ai.service.ts`) now says that a
research call that failed earlier is not proof reviews do not exist, that a fresh question should
re-run `researchInventoryProducts`, and that an unavailable result must be described in plain
words — never with `available:false`, `SEARCH_UNAVAILABLE` or `NO_SOURCES`.

### 3. Tests

- `server/test/AI52-search-and-price-fixes.test.mjs` — two new cases, nine in total:
  "a junk answer is retried, because the junk is random per call" (research answers from rtings
  after three junk answers, asserting four search calls) and the price equivalent (a listing after
  two junk answers, asserting three searches over two distinct queries).
- `server/test/AI49-market-price-research.test.mjs` — the "free page without a price produces no
  listing and no estimate" expectation moves from 2 to 3 free searches and page fetches, matching
  the new retry. The outcome guarantees are unchanged: no invented listing, no paid request, and the
  retry repeats the same query rather than adding a third distinct one.

## Verification

- `cd server && npx tsc --noEmit` — clean.
- `cd server && node scripts/run-tests.mjs unit` — 1761 tests, **1700 pass, 0 fail**, 61 skipped.
- In-process checks of the same code paths the tools call: reviews resolved for both products
  (rtings, tomshardware, switchandclick/verdict); RK61 prices ₱2,595 and ₱2,795 from DataBlitz;
  K8 Pro prices from DataBlitz ₱5,195, keychron.com $74.99/$99.99/$59.99/$79.99, keychron.ph ₱6,000.

## Known limitations

- The free engine's bad answers are transient and unpredictable: after the fix, one phone price
  turn still returned nothing usable and answered honestly (turn 4), while the next one resolved
  three listings (turn 5). The failure direction is safe — the assistant says the price could not
  be confirmed instead of estimating — but a user may need to ask again.
- In a long conversation the assistant may answer from research it already ran instead of calling
  the tool again (turns 7–8, 11). Each of those answers matched the recorded data on the phone, but
  no fresh external lookup was made in that turn.
- The free model occasionally burns its whole output budget producing nothing; those turns were
  retried and are counted in the "turn outcome" log lines, not hidden.

Nothing in this pass was committed, pushed or deployed; the changes are in the working tree.
