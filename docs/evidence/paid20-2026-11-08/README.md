# Live 20-question QA on the owner's phone (2026-11-08)

This report records the rebaselined 20-question matrix against a fresh development business. The
original tenant and its reference products no longer existed, so the seed and expected facts were
regenerated before the run. The verdicts are valid for this baseline, not as a byte-for-byte replay
of the previous dataset.

## Run

- **Tenant:** `rak gears` (development), business `6aee0e2c451a92d902af1190`, owner `6aee0e2c451a92d902af1191` (`jeffernmalinaoqwe@gmail.com`).
- **Seed:** 1,000 ACTIVE products, 241,159 total units, 149 products at/below minimum, 57 out of stock. The original tenant and reference products were absent, so these facts were regenerated from a fresh deterministic seed. This is a **fresh baseline**, not an exact replay of the previous 233,444-unit / 166-low dataset.
- **Device:** `PV4DDMIZZLTCIVSK` (USB), development client loading the current Metro bundle.
- **Model:** `openai/gpt-oss-120b` for all 20 answers. `AI_REASONING=enable`; web search and fetch enabled; paid web search authorized.
- **Completeness:** 20/20 answers; no fallback model, no degraded answer, no prompt mismatch.
- **Verdict:** **14 PASS, 2 PARTIAL, 4 FAIL**.

## Results

| # | ID | Language | Verdict | Evidence |
|---|----|----------|---------|----------|
| 1 | B1 | Bisaya | PASS | 1,000 active products; 241,159 units |
| 2 | B2 | Bisaya | PARTIAL | 149 low correct; second half answered as 69,544 units sold/consumed instead of 57 out-of-stock products |
| 3 | B3 | Bisaya | PASS | Logitech MX Master 3S 10663: Main Warehouse 452, Shop Front 453 |
| 4 | B4 | Bisaya | FAIL | Said Dell UltraSharp U2723QE 10232 was absent; T3 found the same product |
| 5 | B5 | Bisaya | PASS | Keyboards & Mice: 432 products; 104,843 units |
| 6 | B6 | Bisaya | PASS | No vehicle-repair products |
| 7 | B7 | Bisaya | FAIL | Review URLs given with no web tool use; sources unverified; answer was in Tagalog, not Bisaya |
| 8 | T1 | Tagalog | PASS | 1,000 active products; 241,159 units |
| 9 | T2 | Tagalog | PASS | 149 low; 57 out of stock |
| 10 | T3 | Tagalog | PASS | Dell UltraSharp U2723QE 10232: 38,990; 0 units / out of stock |
| 11 | T4 | Tagalog | FAIL | Said no active category "Keyboards and Mice"; stored category is "Keyboards & Mice" |
| 12 | T5 | Tagalog | PASS | Logitech 5,490 / 905; Dell 38,990 / 818 |
| 13 | T6 | Tagalog | PARTIAL | Valid Royal Kludge RK61 at 2,499, but reported 479 units and omitted the suffix; expected 10004 / 218 |
| 14 | T7 | Tagalog | FAIL | Online prices and URLs given with no web tool use; sources unverified |
| 15 | E1 | English | PASS | 12 brands; counts sum to 1,000 |
| 16 | E2 | English | PASS | 1,000 products; 179,016 units at Main Warehouse |
| 17 | E3 | English | PASS | 149 products need restocking; three genuine out-of-stock examples |
| 18 | E4 | English | PASS | Dell UltraSharp U2723QE 10652; 31,893,820 |
| 19 | E5 | English | PASS | Five latest movements; 1,828 total |
| 20 | E6 | English | PASS | LG UltraGear 27GP850-B 10583; 575 units |

## Findings

### 1. Research grounding is still broken (B7, T7) — highest priority

Both research questions produced external review/price URLs **without using a web tool**:

- B7 `toolsUsed: []`
- T7 `toolsUsed: ["findProducts"]`
- The API gate logged `web tools enabled=search,fetch offered=none used=none intent=inventory` for these turns.

The URLs and prices may be real, but they were not read or verified during the turn. B7 also answered in Tagalog despite a Bisaya prompt. This is a direct trust failure: an answer that cites sources must either use the research tools or explicitly say the information is unavailable. The paid-search authorization was never exercised.

### 2. Exact product lookup has a false negative (B4)

B4 asked for **Dell UltraSharp U2723QE 10232** and answered that no such product existed. The product is in the seeded catalog, and **T3 found it** with the same model and phone.

- B4 tools: `findProducts`
- T3 tools: `findProducts`, `searchProducts`, `getInventory`

A `findProducts` miss should fall back to `searchProducts` (and an exact-match check) before the model is allowed to say the product is absent.

### 3. Category alias handling is inconsistent (T4)

T4 asked for the **"Keyboards and Mice"** category. The stored category is **"Keyboards & Mice"**. T4 used only `getStockValue` and declared the category missing. B5 asked for the same category in Bisaya and passed (432 / 104,843) by using `listCategories` plus `getStockValue`.

Normalize `&`/`and` aliases, or require `listCategories` before declaring that a category does not exist.

### 4. B2 wording is ambiguous

B2 asked `pila ang nahurot` ("how many were consumed"). The answer gave **69,544 units sold/consumed** instead of **57 out-of-stock products**. The first half (149 low) was correct, and the Tagalog equivalent T2 answered 57 correctly. This is partly a prompt-wording issue: for the next run, say `pila ka produkto ang wala nay stock`.

### 5. T6 needs a precise expected variant

The model recommended a valid in-stock product under 3,000: **Royal Kludge RK61, 2,499**. However, it reported **479 units** and omitted the numeric suffix, while the expected sample was **Royal Kludge RK61 10004, 218 units**. Either name the SKU in the prompt or accept any in-stock sub-3,000 product; the current expected fact is too specific for the open-ended question.

### 6. Rebaseline caveat

The previous 20-question tenant (`6ae162…`) and its products (Value Notebook, Ultra Padlock, Pro Notebook) no longer existed in `inventoryai_dev_db`. The fresh seed produced:

- 1,000 products, 241,159 units, 149 low, 57 out (current)
- previous reference: 1,000 products, 233,444 units, 166 low, 58 out

The current seed logic does not reproduce the old unit/low counts. Product names, categories, and some expected facts were therefore adapted. The pass/fail result is valid for the fresh baseline, but it is not a byte-for-byte repeat of the old matrix.

## Cost and provider behavior

- OpenRouter usage: **0.757704227 → 0.794550886**, delta **0.036846659** (about **$0.0368**).
- All 20 successful answers came from `openai/gpt-oss-120b`; no fallback, degraded, or prompt-mismatch abort.
- Paid web search was enabled but never used; the cost is model tokens only.
- One preflight B1 attempt failed with HTTP 400 — `Reasoning is mandatory for this endpoint and cannot be disabled.` — because the API had been started with the default `AI_REASONING=disable`. Restarting with `AI_REASONING=enable` fixed it. The failed request produced no answer and is not part of the 20.
- The host caps a synchronous command at 295 seconds. The B2–T2 chunk was interrupted after T2; T3–E6 resumed successfully. All 20 result rows are present.

## Artifacts

- `server/scripts/eval-paid-20-phone.mjs` — updated device/tenant/facts (committed with this report).
- Raw JSON and logs remain in the local, git-ignored `.tmp-paid20/` directory; this report is the committed evidence.
- `.tmp-paid20/facts.json` — seeded facts.
- `.tmp-paid20/summary.json` — merged results with verdicts.
- `.tmp-paid20/run-00.json`, `run-01-10.json`, `run-09-13.json`, `run-14-19.json` — raw per-question results.
- `.tmp-paid20/run-*.log` — runner output.
- The temporary seeder was removed after the run.

## Current environment

- Local API is running on `:4000` with 120b, reasoning enabled, and web tools enabled.
- Metro is running on `:8081`; `adb reverse` has both `8081` and `4000`.
- The development client is installed and signed into **rak gears**. The release/production APK is saved at `/tmp/inventoryai-app.apk`; reinstalling it restores the store build (same signer, app data kept), but it points at production and will need a production session.
- No production data was written; only the dev tenant was reseeded.
- The pre-existing uncommitted currency/restock changes were the working tree used for this run; they remain outside this evidence commit.
