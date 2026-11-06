# AI-48 — Recorded specifications and a real seed catalogue

## What shipped

`Product.specifications` is an optional, trimmed string capped at **1,000 characters**. It is
validated on create and update, returned in the product DTO, accepted by the mobile form, and
displayed on product detail. `findProducts` searches it as recorded text and returns it;
`getProduct` returns the full value. The assistant is told to compare recorded specifications,
never infer one from a description or name, and state plainly when a product has no recorded fact.

`server/scripts/seed/catalog.mjs` is the shared source for both seeders:

| Category | Products |
| --- | --- |
| Keyboards & Mice | Logitech MX Keys S, Keychron K8 Pro, ASUS ROG Strix Flare II Animate, Razer BlackWidow V4 Pro, Royal Kludge RK61, Logitech MX Master 3S |
| Audio | Sony WH-1000XM5, SteelSeries Arctis Nova 7 |
| Displays | Dell UltraSharp U2723QE, LG UltraGear 27GP850-B |
| Accessories | Anker 737 Power Bank, Samsung T7 Shield 1TB, Logitech C920s HD Pro Webcam, Elgato Stream Deck MK.2 |

Each row carries a brand, category, description, manufacturer specifications and a source URL.
Uncertain numbers were omitted rather than invented. Selling prices are illustrative seeded values,
not current market quotes. The demo fixture keeps one product with no inventory row, three
low-stock products (including that one) and several products held at two locations.

## Verification

- `server/test/AI48-product-specifications.test.mjs` — **4 unit + 3 DB** passing. It covers
  validation and the 1,000-character limit, prompt/tool descriptions, safe JSON quoting into the
  research prompt, create/get/update, specification search and the full detail payload.
- `server/test/SEED1-real-catalog.test.mjs` — **2 unit + 1 DB** passing. It checks the curated rows,
  the demo fixture, and that `seedTenant` writes 23 real specification-bearing products with no
  placeholder names.
- `server/test/AI47-inventory-web-research.test.mjs` — **12 unit + 3 DB** passing after the research
  subject gained the specification field.
- `server/test/DEMO1-demo-tenant.test.mjs` — **22/22** passing with the new fixture.
- Server `npm run typecheck` / `npm run lint` and mobile `npm run typecheck` / `npm run lint` are
  clean.
- Full unit run: **1,650 pass, 0 fail, 58 intentional DB skips**. The issue-record scan no longer
  reads git-ignored local artifacts (`.tmp-*`, `.cloud-attachments`, `.scratch`, `logs`), so a stale
  scratch copy of the suite can no longer be reported as a citation.

## Live trial on a disposable tenant

A development-only disposable business was seeded with the 14 demo products and 22 inventory rows.
The harness is `server/scripts/eval-ai48.mjs`; it refuses any database other than the development
database and removes every row it creates in a `finally` block.

### Configured primary

`nvidia/nemotron-3.5-lightning:free`:

- Comparison turn: `findProducts` succeeded (222 ms of tool time), then the second provider call
  consumed the remaining turn budget. `AI_TIMEOUT` at **60,004 ms**.
- Research turn: `findProducts` and `researchInventoryProducts` ran, then the model spent the whole
  **1,200-token** output budget before answering (`AI_OUTPUT_LIMIT`).

### Evaluation-only faster model

`liquid/lfm-2.5-2.6b:free` answered the comparison in **5.3 s** using `findProducts` and
`getProduct`. It correctly reported:

- RK61: 60%, 61 keys, Bluetooth 5.1 / 2.4 GHz / USB-C, 32 units (10 in Demo Shop, 22 in Demo
  Warehouse).
- K8 Pro: 80% TKL, 87 keys, hot-swappable Gateron G Pro, PBT OSA, 4,000 mAh, 6 units.

It then hit the same 1,200-token cap before writing its recommendation (`OUTPUT_LIMIT`, 28
characters trimmed). The follow-up research turn was refused upstream with HTTP **429**; that run
ended there.

The override was process-local (`AI_MODEL_OPENROUTER=... node scripts/eval-ai48.mjs`). The project's
configured primary and fallback were not changed, and no production request was made.

### Completed on the configured fallback

`nvidia/nemotron-3-ultra-550b-a55b:free` — the deployment's configured fallback — was then used as a
process-local primary with an evaluation-only output budget of 3,000 tokens and a 120-second turn
deadline. Both questions completed against the same disposable tenant.

- **Comparison:** `findProducts`, **30.5 s**, 1,102 output tokens. It set the RK61's 60%/61-key
  layout, tri-mode connectivity, 32 units and ₱2,499 against the K8 Pro's 80% TKL/87-key layout,
  hot-swappable Gateron G Pro switches, PBT OSA keycaps, 4,000 mAh battery, 6 units and ₱6,990. It
  marked the RK61's battery, keycaps and firmware as “Not recorded” rather than guessing, and
  recommended the RK61 only for the small-desk use its recorded description and layout support.
- **Research:** `findProducts` + `researchInventoryProducts`, **84.8 s**, 2,045 output tokens. It
  listed the four mechanical keyboards in stock, kept each product's recorded specifications
  separate from search-result snippets, cited the URLs the tool returned, stated that no snippets
  came back for Keychron or ASUS, and recommended the K8 Pro for an office on its recorded facts —
  explicitly noting that the recommendation rested on catalogue data, not missing web evidence.

At the deployment defaults (60 s, 1,200 output tokens) the comparison fits, but the research turn
does not: it measured 84.8 s and 2,045 output tokens. The larger budget was process-local
(`AI_MAX_OUTPUT_TOKENS=3000 AI_TURN_DEADLINE_MS=120000 AI_MODEL_OPENROUTER=...`); `server/.env`, the
configured primary/fallback order and production were not changed.

## What remains unproven

- A complete research turn within the deployment's default 60 s/1,200-token budget; the measured
  turn needs more, and no production budget was changed.
- Any claim originating from the web beyond its cited snippet; research remains external evidence,
  not an inventory record.
- Phone rendering of the specifications field or the new release note. No OTA or APK was published.
- That the chosen illustrative prices correspond to the current market; they are seed data only.
