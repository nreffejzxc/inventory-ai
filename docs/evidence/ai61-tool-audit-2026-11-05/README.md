# Assistant tool audit: dead stock, scope and the wide-read correction (2026-11-05)

Every question below was typed on the OPPO `PV4DDMIZZLTCIVSK` phone, mirrored to the laptop with
`scrcpy`, and driven with `adb` input. The phone's frames were captured with
`adb exec-out screencap`.

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android, screen 1080×2400, time zone `Asia/Manila` (UTC+8)
- App: development client (`npx expo start --dev-client`), Metro on `8081`
- API: local development server on `http://localhost:4000`, reached from the phone through
  `adb reverse tcp:4000` (and `tcp:8081` for Metro)
- Database: `inventoryai_dev_db`
- Model: `nvidia/nemotron-3.5-lightning:free`, `AI_ALLOW_PAID_WEB_SEARCH=false`

Two tenants were used, and the difference matters for the transcripts:

| When | Tenant | Data |
|---|---|---|
| 7:22–7:33 PM | `6ae164357b1cce3d75857a35` | 11 ACTIVE products; locations Phone Test Shelf, Front Counter, Store Room |
| 11:01–11:10 PM | `6aec9853d59e2724654c3ed7` | 135 ACTIVE products; locations Main Warehouse, Shop Front (seeded for this pass: `seed --plan=demo --total=600`) |

The 11-product tenant is where the earlier AI-54…AI-71 evidence was gathered; it is too small to
exercise paging and per-location dead stock, so the AI-72 re-verification ran on the seeded
135-product tenant.

## What changed in this pass

| # | Symptom measured on the device | Fix | Where |
|---|---|---|---|
| AI-61…AI-69 | (earlier in the series — grounding, empty-window and partial-page guards) | see `docs/evidence/ai54-60-grounded-answers-2026-11-05` and the follow-ups | `ai.service.ts`, `answerCompletion.ts` |
| AI-70 | Revenue stated as recorded fact | Server appends the qualification inside the answer cap | `answerCompletion.ts` |
| AI-71 | "What has never sold?" had no tool of its own, so the model compared lists by hand and both missed products and mislabelled stock movements | `getProductsNeverSold` — the server compares the whole catalogue against the whole ledger; `excludeIds` added to `productService.listWithStock` | `tools.ts`, `product.service.ts` |
| AI-72 | A business-wide question answered inside last turn's shelf, and a wide read narrated as that shelf | `location`/`locationId` are removed from the tool call **before it runs** when the question names the whole business and does not name that place; the answer is then relabelled to "across all locations" if it still names the place | `ai.service.ts`, `answerCompletion.ts` |
| AI-73 | "Any dead stock…" routed to the low-stock tool, so the answer listed rows reading "Stock-out count 1" | The tool CALLS are rewritten before they run: a low-stock read on a dead-stock question becomes the dead-stock read; a dead-stock question with no read gets one; a mixed question keeps both | `ai.service.ts`, `answerCompletion.ts` |
| AI-74 | A draft the server discarded, or an answer it rewrote, stayed in the bubble until `done` — 51 s of it at 7:32 PM | The turn emits a `reset` event whenever a guard rewrites or discards streamed text; the chat clears the bubble on it, and the stored answer is replayed before `done` | `ai.service.ts`, `ai.controller.ts`, `AiChat.tsx`, `lib/api.ts` |

Two smaller changes belong to AI-71 but were driven by the same audit:

- The empty dead-stock page explains itself (`emptyReason: 'everyProductHasMoved'`). On the phone
  `count: 0` had been read as "no stock-outs at all", which is the opposite of what an empty
  dead-stock page means.
- The tool description now carries the everyday vocabulary ("dead stock", "not selling", "unsold",
  "stale stock", "zero sales") and an explicit "NOT for low stock or out of stock" contrast.

## AI-72 — the retry that had to be replaced

The first implementation asked the model to re-read without a location when a read in the turn was
scoped to a place the question did not name. It fired on the phone and made the turn worse:

> **7:32 PM, "What has never left the store at all?"** — guard logged
> `business-wide question answered with a read scoped to Front Counter — asking for the wide read
> (attempt 2)`; the turn ran **6 iterations / 51 s**, and the stored answer still began *"no
> products that have never left the store at all"* — while five products had never moved. The live
> stream showed all three attempts concatenated in one bubble before the `done` payload replaced it.

Re-asking spends the step budget and lets the model answer from the stale page, so the correction
moved in front of the call: the arguments are stripped, the first read is already wide, and no
second turn is needed. Measured on the seeded tenant:

| Turn | Guard lines in the API log | Iterations / time | Answer |
|---|---|---|---|
| 11:02, after "Any dead stock at the Main Warehouse" | `dropped the location "Main Warehouse" carried over from an earlier turn` | 3 / 20.2 s | 59 products — the correct business-wide count — but introduced as **"at Main Warehouse"**, whose own count is 92 |
| 11:09, same follow-up after the relabel | `dropped the location …` then `business-wide answer still named Main Warehouse — relabelled to all locations` | 3 / 22.6 s | **"Dead stock across all locations … 59 items"**, table header "Available", no place named |

The 11:02 sentence is why the relabel exists: the figures were right and the scope sentence was
false, and a member reading "59 at Main Warehouse" would compare it with the 92 the same shelf
actually holds. The rewrite is literal and runs for a place the turn itself removed
(`at <place>` → `across all locations`; a bare leftover name → `all locations`).

The relabel is not limited to a dropped argument. A model can carry a place over from the
conversation without ever passing it to a tool, and then there is nothing to strip — the 11:02
answer is exactly that shape. `scopedPlaceIn()` takes the business's own ACTIVE location names and
asks one question of the answer: is exactly one of them used as a scope (`at <place>`, with or
without "the") in an answer to a business-wide question? One is a false scope and is relabelled;
two or more is a per-location breakdown ("at Main Warehouse 40, at Shop Front 19") and is left
alone; a place the question names is left alone. The lookup is wrapped so a database failure never
costs the member the answer.

On the phone at 11:35 PM, *"What has never left the store at all?"* fired the new check —
`business-wide answer scoped to Main Warehouse that the turn never read — relabelled to all
locations` — and the stored answer reads **"59 products across all locations have never had a
recorded stock-out"**, with no place name anywhere in it.

## AI-73 — dead-stock questions read the dead-stock tool

The routing is a request in the prompt, not a guarantee: at 11:01 and 11:07 PM the exact phrase
**"Any dead stock at the Main Warehouse"** (no question mark) was answered from
`getLowStockProducts`, and the answer listed shortages with a "Stock-out count 1" column — the
opposite of dead stock — while the same phrase *with* a question mark routed correctly at 11:10.
Asking the model again cannot close that, so the calls are rewritten before they execute:

- a `getLowStockProducts` / `getOutOfStockProducts` / `getReorderNeededProducts` call on a
dead-stock question becomes `getProductsNeverSold` with the same `location`/`locationId`/`from`
  (and `limit` clamped to the tool's 25-row cap);
- a dead-stock question that asked for no tool at all gets one dead-stock read, scoped from the
  arguments it did use;
- a **mixed** question ("dead stock and low stock") keeps both reads, because dropping the
  low-stock half would be wrong in the other direction;
- a turn that already read `getProductsNeverSold` is never rewritten.

On the device after the change: 11:22 PM **"Any dead stock at the Main Warehouse"** returned
**92 products** at that shelf in 6.2 s with no low-stock framing; 11:23 PM the mixed question ran
both tools (31 low-stock rows, page 20 with `hasMore`, plus the 92-product dead-stock total). The
model happened to route correctly in both turns, so the rewrite did not need to fire — the log line
`dead-stock question — reads routed to getProductsNeverSold` stays silent until a turn misroutes,
and the rewrite itself is pinned by unit tests.

## AI-74 — the screen never keeps a replaced answer

The stream writes the model's words, but the stored answer is not the same string: status
constants are humanised, `<br>` is removed, a false place label is relabelled, the revenue
qualification is appended, a cut-off unit is trimmed, and a draft with no read behind it is thrown
away and re-asked. Until `done` arrived the member could keep reading the version the server had
already replaced — at 7:32 PM that was 51 s of a draft the guard had discarded.

The server now sends `reset` before the replacement, and the client clears the bubble on it:

- `runAiChat` takes `onTextReset`, tracks the text currently on screen, and calls it when a guard
  rewrites the stored answer or a draft is discarded for a re-ask — including narration streamed
  during a tool round, which is never part of the answer.
- The stored answer is then replayed as deltas before `done`, so the screen never waits on a blank
  bubble for persistence.
- `done` remains the authority: the reset only closes the window in which the replaced version
  stayed visible.

Measured on the phone at 5:14 AM, *"How much revenue did we make this week?"* — the log shows
`clearing streamed text — a no-tool draft was discarded for a re-ask`, then the revenue
qualification appended, then `clearing streamed text — the answer changed after it was streamed`;
the final bubble is the qualified answer (screenshot `ai74-revenue-stream-reset.png`), with none of
the discarded draft left in it.

## Ground truth, read from the database

Seeded review tenant `6aec9853d59e2724654c3ed7`, `inventory_transactions` with `type: 'STOCK_OUT'`:

- 135 ACTIVE products; 76 have at least one stock-out anywhere; **59 have never moved**
  (business-wide)
- Main Warehouse: 92 never sold there (any stock), 80 of the 120 products stocked there
- Shop Front: 47 never sold there, of 63 stocked

The 11-product tenant, measured at 7:22 PM: 11 ACTIVE, 6 with a stock-out anywhere, **5 never
moved**; at Front Counter 0 dead stock (`soldProductCount 6`).

## Device transcripts

| Time | Question | Tool | Result |
|---|---|---|---|
| 7:22 | "Any dead stock at the Front Counter?" | `getProductsNeverSold` | "no dead stock — every active product stocked there has at least one recorded stock-out" (correct) |
| 7:23 | "What is not selling right now?" | `getLowStockProducts` → `getProductsNeverSold` | inherited Front Counter, truthful but narrower than the question |
| 7:25 | "What has never left the store at all?" | `getProductsNeverSold` | answered inside Front Counter — the AI-72 defect |
| 7:32 | same, with the retry guard | `getLowStockProducts`, `getInventoryHistory`, `getProductsNeverSold` | 6 iterations / 51 s, false "no products … at all" — retry replaced |
| 11:01 | "Any dead stock at the Main Warehouse" (no question mark) | `getLowStockProducts` | **mislabelled**: low-stock rows carry "Stock-out count 1" under a dead-stock question |
| 11:02 | "What has never left the store at all?" | `getProductsNeverSold` (location stripped) | 59, but labelled "at Main Warehouse" |
| 11:07 | "Any dead stock at the Main Warehouse" (no question mark) | `getLowStockProducts` | same misroute, 15 rows + "16 more products" |
| 11:09 | "What has never left the store at all?" | `getProductsNeverSold` (location stripped, answer relabelled) | "Dead stock across all locations … 59 items", 3 iterations / 22.6 s |
| 11:10 | "Any dead stock at the Main Warehouse?" (with question mark) | `getProductsNeverSold` | 92 products scoped to the shelf, paging explained — correct |
| 11:22 | "Any dead stock at the Main Warehouse" (no question mark, the phrase that misrouted) | `getProductsNeverSold` | 92 products at the shelf, no low-stock framing, 6.2 s |
| 11:23 | "Show dead stock and also low stock at the Main Warehouse" | `getLowStockProducts` + `getProductsNeverSold` | both: 31 low-stock rows (page 20, `hasMore: true`) and the 92-product dead-stock total |
| 11:35 | "What has never left the store at all?" | `getProductsNeverSold` | 59 across all locations; the new scope check relabelled a Main Warehouse label the turn never read |
| 5:14 AM | "How much revenue did we make this week?" | `getInventoryHistory` | qualified estimate; the stream was cleared twice — a discarded no-tool draft, then the appended qualification |

## Checks run

- `npx tsc --noEmit` — exit 0
- `node --test test/AI72-business-wide-scope.test.mjs` — 9/9 (predicate, arg-strip behaviour
  pinned through `relabelBusinessWideScope`, punctuation and case, untouched answers, and the
  scope detection: one place relabelled, a two-location breakdown and a bare mention left alone)
- `node --test test/AI73-dead-stock-routing.test.mjs` — 6/6 (wording recognised, stock-level
  wording left alone, replacement keeps the scope, a missing read is added, a mixed question keeps
  both, a correct turn is untouched)
- `TEST_MODE=db node --test test/AI71-products-never-sold.test.mjs` — 5/5, including the empty-page
  explanation
- `TEST_MODE=unit node --test test/AI40-ai-streaming.test.mjs` — 14 pass / 0 fail (AI-74: a
  rewritten answer resets once, the stored answer is replayed, and the existing streaming cases
  still hold)
- `TEST_MODE=db node --test test/AI40-ai-streaming.test.mjs` — 6 pass / 0 fail (the wire carries
  `reset` before `done`, and a failed turn still persists nothing)
- mobile `npx tsc --noEmit` — exit 0; `npx jest ai40-chat-stream-transport.test.ts
  ai40-assistant-streaming.test.tsx` — 17/17
- API restarted for each device pass and polled with `GET /api/health/live` before typing

## Findings left open

1. **Device sessions are fragile.** The app lost its session twice during this pass and the
   "Continue with saved account" entry opened a different tenant (1,000 products) than the one with
   the test history. A dedicated review login — `ai-review-20261105@example.invalid`, tenant
   `6aec9853d59e2724654c3ed7`, created for this pass — made the ground truth exact. That tenant is
   disposable and can be removed with the demo-account cleanup command.

Nothing was committed, pushed, deployed or sent over the air.
