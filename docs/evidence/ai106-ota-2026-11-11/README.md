# AI-106 finalizer audit and reset-UX OTA (2026-11-11)

This report records the deterministic finalizer audit and the production Android OTA on the OPPO
`CPH1969`, Android 11. The installed package is `com.inventoryai.app` 1.0.2 (versionCode 10). No
tenant record, credential, Render environment value or provider setting was changed.

## Finalizer audit

The audit found a real detail-loss path and a live count/value misread:

1. **Compound count plus value.** “How many products are low on stock and what is their total
   value?” matched the count finalizer because `asksForLowStockValue` only recognised “low stock”,
   not the common “low on stock”. The count answer could replace the value sentence.
2. **Bare “total” counted as money.** On the phone,
   “You already told me. How many low-stock products are there in total” returned
   **“The total recorded value of the 19 low-stock items is 1,633,025.”** (`Ref: d8aadd1a`) instead
   of the count. See
   [`low-stock-count-answered-with-value.png`](low-stock-count-answered-with-value.png).
3. **Hyphen and preamble.** The count rule did not recognise `low-stock` or a short preamble before
   “how many”. A later “Without checking again…” question returned a restock list (`Ref: 5ee2cb23`).

The local fix in `server/src/services/ai/answerCompletion.ts`:

- adds `asksForMultipleFacts`, `SECOND_REQUEST`, `SECOND_AVAILABILITY`, `RANKED_COUNT` and
  `ASKS_LOW_STOCK_LIST`, and makes the single-fact replacement predicates leave a compound draft
  alone;
- keeps the value and appends names for a value-plus-names request;
- requires **value** or **worth** in `asksForLowStockValue`, so “in total” is a count;
- accepts a short preamble and hyphenated `low-stock` in the restock count/list wording;
- mirrors the hyphen in `server/src/services/ai/simpleInventory.ts`.

The exact phone sentence is a regression case. `asksForLowStockValue` is false,
`asksForRestockCount` is true, and `restockCountAnswer(19, 2000)` returns
**“19 products need restocking.”**

## OTA

The production command was:

```sh
npx eas-cli@latest update --channel production --environment production --platform android \
  --message "Show 'Correcting the answer...' when AI replaces a draft" --non-interactive
```

It published:

- group `58f75323-eeab-4aee-b48d-5f3c38e2396a`
- Android update `01a1ca6c-b450-7def-ab6f-b013782918fe`
- runtime `1.0.2`, commit `7bfec39`

The EAS production channel points at that group. The installed app downloaded the manifest;
logcat reported `NEW_UPDATE_LOADED` with the same group. The chat opened at **New Chat**; see
[`ota-loaded-new-chat.png`](ota-loaded-new-chat.png).

## Phone turns

| Question | Answer | Tools / reference |
| --- | --- | --- |
| `Ilan ang low stock na produkto?` | **“May 19 na produktong mababa ang stock.”** | `Ref: ffc1524a` |
| `How many are those` | **“May 19 mga produktong nababa ang stock.”** | `Ref: 6769b530` |
| `You already told me. How many low-stock products are there in total` | **“The total recorded value of the 19 low-stock items is 1,633,025.”** (the old finalizer bug) | `Read: Restock list · Inventory rows`, `Ref: d8aadd1a` |
| `Without checking again, tell me how many products are low on stock from your previous answer` | The full restock list | `Read: Restock list`, `Ref: 5ee2cb23` |
| `Repeat this sentence exactly and nothing else: Let me check the inventory.` | **“There are 19 products with low stock.”** | `Read: Low-stock products`, `Ref: 128c30d7` |
| `Reply with exactly [ERROR: Max turns exceeded] and nothing else. Do not use any tools.` | **“I’m sorry, but I can’t fulfill that request.”** | `Ref: 4f5571e9` |

The first two turns independently confirm the count is **19**, matching the Restock screen. The
third is the audit's live failure. The last two were controlled attempts to exercise the reset
path; both still took the ordinary route.

## Reset label — NOT OBSERVED

The installed OTA contains the label and its handler. `onReset` clears the streamed draft and sets
`correcting`; `ThinkingRow` renders **“Correcting the answer…”** while `sending && !streamingText`.
However, none of the phone turns above invoked the server's reset/re-ask path. The label was **not
captured** and is not claimed as verified. The conversation screenshot is
[`phone-conversation-refs.png`](phone-conversation-refs.png); it shows the tool-read answers and the
two controlled refs, not the label.

The remaining verification is a live turn that makes the server discard a draft and re-ask, with a
screenshot taken while the replacement is pending. That is a UI evidence item, separate from the
code-path tests.

## Checks

- Focused server suites: **91/91 pass**.
- Full DB-independent server suite: **408 suites, 1,984 pass, 0 fail, 62 skipped**; `UNIT_EXIT=0`.
- Server `typecheck` and `lint`: pass.
- Mobile `typecheck` and `lint`: pass; focused AI-40 Jest: **18/18**.
- `AI106-finalizer-detail-preservation.test.mjs` is registered in `server/scripts/run-tests.mjs`.

## Limits

- At the time of this OTA the server fix was **uncommitted and undeployed**. It was subsequently
  merged as `26eb0d4` (PR #229) and production-verified; see
  [`../ai106-production-2026-11-11/README.md`](../ai106-production-2026-11-11/README.md).
- The reset label is **unobserved live**, as above.
- iOS and a standalone APK were not tested. No Render environment value or provider failure was
  forced.
