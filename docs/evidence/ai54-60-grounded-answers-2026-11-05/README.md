# Grounded answers: prices, scoped totals and the no-tool guard (2026-11-05)

Every question below was typed on the OPPO `PV4DDMIZZLTCIVSK` phone, mirrored to the laptop, and
driven with `adb` input. The screenshots in this directory are the phone's own frames
(`adb exec-out screencap`).

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android, screen 1080×2400, time zone `Asia/Manila` (UTC+8)
- App: development client (`npx expo start --dev-client`), Metro on `8081`
- API: local development server on `http://127.0.0.1:4000`, reached from the phone through
  `adb reverse tcp:4000`
- Tenant: business `6ae164357b1cce3d75857a35`, database `inventoryai_dev_db`
- One location, **Phone Test Shelf**; categories **Laptops** (2 products, 3 units) and
  **Keyboards** (3 products, 23 units). Whole-shelf value **PHP 383,426 / 5 products / 26 units**
- Model: `AI_PROVIDER=openrouter`, `nvidia/nemotron-3.5-lightning:free`, 1200 output tokens,
  `AI_ALLOW_PAID_WEB_SEARCH=false`

## What changed

Each fix closed a place where the model had no grounded figure to read, so the only way to answer
was to invent one. The prompts were not the problem: every symptom below was reproduced with a
prompt already telling the model not to guess.

| # | Symptom measured on the device | Fix | Where |
|---|---|---|---|
| AI-54 | Free reasoning tokens were spent before every answer, costing seconds | Reasoning is off by default | `ai.service.ts` |
| AI-55 | "What did we sell?" answered from the catalogue, not from transactions | Rule requiring sales/history answers to come from movements | system prompt |
| AI-56 | `<br>` and other HTML reached the member as literal characters | `normaliseAnswerMarkup()` strips tags, decodes the five entities a model actually emits | `answerCompletion.ts` |
| AI-57 | "What is our stock worth?" had no tool at all | `getStockValue` tool + `productService.stockValue` — the server computes the total | `tools.ts`, `product.service.ts` |
| AI-58 | **A recorded product's price was invented**: answer said PHP 45,000 for the Alienware recorded at 139,995 | `getInventory` rows now carry `sellingPrice`/`currency`; rule 28 | `inventory.service.ts`, `tools.ts` |
| AI-59 | "What is this shelf worth?" would have needed the model to add up rows itself | `getStockValue` takes `locationId`/`location` and `categoryId`/`category`, filters **both** the products and the totals, and reports its `scope`; rule 29 | `product.service.ts`, `tools.ts` |
| AI-60 | **A whole answer invented** (see below) | The turn loop refuses a figure-bearing answer from a turn that ran no tool, and re-asks once | `ai.service.ts`, `answerCompletion.ts` |

AI-60 is the one worth reading in full, because it is the first fix in this series that is not a
new gate in front of the model but a check *after* it has spoken:

> **Measured 4:29 PM.** In a conversation that had just priced the keyboards, the question
> "How much is the Phone Test Shelf worth" was answered in 1.2 s with a turn line reading
> `outcome=ok calls=1 toolRuns=0 tools=none` — no tool was called at all — and the answer was
> "The Phone Test Shelf is worth **PHP 18,500** at the recorded selling price. It holds **25
> units** on hand, each valued at **PHP 740**." The shelf actually held 26 units worth PHP
> 383,426. Every number was invented, and nothing in the answer or the screen distinguished it
> from the grounded answers above it.

`statesRecordedFigure()` detects a currency code or symbol followed by a digit, or a
thousands-grouped number (`383,426`), in the text the member will see. When such an answer comes
from a turn with `toolRuns === 0`, the text is discarded, one user-role nudge is pushed asking for
the tool that records it, and the loop continues — once per turn (`groundingRetry`), and never on
the last, tool-less round where a retry could only restate. An answer that reads as prose
("I could not find a location named …"), a greeting or a capability question passes straight
through, because a false positive costs the member a whole round.

## Verification on the phone

Same conversation, same question, typed again at 4:37 PM after the guard was running:

- Turn line: `[ai] answer stated figures with no tool read — asking the model for the data`, then
  `outcome=ok total=7106ms calls=3 toolMs=230ms toolRuns=1 tools=getStockValue`
  — the guard fired exactly once, the re-ask read the data, and the turn finished normally.
- Answer: "The Phone Test Shelf inventory is worth **PHP 383,426** at the recorded selling price.
  That totals **26 units** across **5 products** (no unpriced items)."
- Per-model arithmetic in the same answer, checked by hand:
  2 × 89,995 = 179,990 · 1 × 139,995 = 139,995 · 4 × 6,990 = 27,960 · 12 × 1,499 = 17,988 ·
  7 × 2,499 = 17,493 — and those five sum to 383,426 exactly.
- Footer chip: `Read: Stock value`.
- `02-before-and-after-same-question.png` holds both answers in one frame: the invented 4:29 PM
  answer above the corrected 4:37 PM one, same question.

Other answers verified on the device in this pass:

| Question | Answer | Turn line |
|---|---|---|
| "What price is recorded for the Alienware and what is that stock worth right now" | PHP 139,995 per unit; PHP 383,426 / 5 products / 26 units | 5.6 s, `calls=3 toolRuns=2` |
| "How much are all our keyboards worth" | PHP 63,441 / 3 products / 23 units (27,960 + 17,988 + 17,493) | 4.0 s, `calls=2 toolRuns=1` |
| "How much is the Phone Test Shelf worth" (before AI-60) | invented PHP 18,500 / 25 units | 1.2 s, `calls=1 toolRuns=0` |
| "How much is the Phone Test Shelf worth" (after AI-60) | PHP 383,426 / 26 units / 5 products | 7.1 s, `calls=3 toolRuns=1` |
| "How much is the Main Warehouse worth" (no such location) | "I don't see a location named … The only active location is Phone Test Shelf", no figure | — |

The scoped totals were also checked directly against the database, not only through the model:
whole shelf 383,426 / 5 / 26; location "Phone Test Shelf" 383,426; Keyboards 63,441 (3, 23);
Laptops 319,985 (2, 3); and 63,441 + 319,985 = 383,426.

## Checks

```
npx tsc --noEmit                        # exit 0
node scripts/run-tests.mjs unit         # 1806 tests, 1745 pass, 0 fail, 61 skipped
```

New tests: `test/AI57-stock-value.test.mjs`, `test/AI58-row-price.test.mjs`,
`test/AI59-scoped-stock-value.test.mjs`, `test/AI60-ungrounded-figure.test.mjs` (6 cases,
including the verbatim 4:29 PM answer and the prose that must **not** trigger a re-ask).

One existing expectation had to be corrected rather than relaxed: the AI-30 cooldown suite's
fixture answered "You hold 49,217 units." with no tool read, so the guard re-asked and the suite
saw a second provider call (`[FALLBACK, FALLBACK]`). The fixture now answers without a figure,
which is what that suite is measuring; its assertions are unchanged.

## Known limits

- **AI-60 only catches a turn that read nothing.** A wrong figure *after* a real tool read is a
  different, rarer failure and is not detected; a stricter rule (every stated figure must appear
  in a tool payload) would misfire on rounding, separators and `PHP` versus `₱`.
- **Sales and movement questions are still unverified on the device**: the development tenant has
  0 `inventorytransactions` rows and 0 purchase orders, so a non-empty answer cannot be produced.
  The paths are covered by unit tests only.
