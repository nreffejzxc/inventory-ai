# Recommendations from the catalogue — 2026-11-03

The sample questions asked for **trusted brands** and **good-quality products**. This tenant's
catalogue has no brand, model, specification, rating or review field: it holds 1,001 active products
across four categories, and every product name is an adjective plus a noun (**Ultra Detergent**,
**Premium Battery**). AI-43 makes that boundary explicit in the prompt, beside the search rows, and
in the recorded description the assistant can now read.

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android 11 (API 30), `Asia/Manila` (UTC+8), mirrored with
  `scrcpy` over USB
- App: preview build `5500e6be`, versionName `1.0.1`, versionCode 8
- Server: `https://ai-inventory-l1mi.onrender.com`, `GET /api/health` reported commit `94ebe80`,
  environment `production`, database `connected`, **0** server errors
- Account: `jaffy royal kludge`, tenant **royal kludge**
- Catalogue at the check: **1,001** active products; categories **Personal Care, Household, Snacks,
  Beverages**; **835** in stock, **166** low, **58** out of stock; **233,451** units on hand

## Ground truth

The Products screen shows **Ultra Detergent 10990** as Household, unit **box**, selling price
**₱43.80**, minimum stock **91**, description `Seeded row 990 for AI scale testing` —
[`ultra-detergent-10990.png`](ultra-detergent-10990.png). A product search for `oil` returned no
products, and the Categories screen holds only the four categories above.

## The questions, after the deploy

[`vehicle-repairs.png`](vehicle-repairs.png) — *"Do we have any products in our inventory that can be
used for vehicle repairs, including engine oil for oil changes in cars or motorcycles? Also,
recommend some good oil brands that we currently have in our inventory."*

```text
… there are no active products matching those keywords in this business's inventory. The catalogue
only contains items in the categories Personal Care, Household, Snacks and Beverages, and none of
those are engine-oil or automotive-repair products.
Because the inventory does not record any oil-related items, I'm unable to recommend specific oil
brands or models from the data we have. The system also does not store brand names, technical
specifications, or ratings for products …
```

[`cleaning-brands.png`](cleaning-brands.png) — *"What cleaning products do we have? Recommend
effective and trusted brands."* The answer listed Household products whose names suggest cleaning
use, with their real unit, minimum stock and selling price, then said:

```text
Because brand data is not available, I cannot recommend specific "effective or trusted" brands from
the catalogue.
```

[`brand-comparison.png`](brand-comparison.png) — *"Compare the available brands of detergent in our
inventory and explain their differences."*

```text
The product catalogue does not store brand names, model numbers, specifications, ratings, or any
quality labels. The only distinguishing fields are the product name (which includes words like
"Ultra", "Deluxe", "Value", etc.), the unit of measure, price and the minimum-stock threshold.
Because brand data is absent, I cannot compare or explain differences between brands …
```

## What this proves, and what it does not

- **Proves, for this tenant, model and build:** no invented brand or product was offered; the quoted
  product name, category, unit, price and minimum stock match the Products screen; the answer states
  the catalogue gap instead of filling it from outside knowledge.
- **Does not prove model compliance is deterministic.** One phone pass on one model is evidence that
  the prompt and the note travel with the data; the tool boundary is pinned separately by
  `server/test/AI43-recommendation-grounding.test.mjs` (10/10).
- **The data limitation remains.** There is still no brand or specification field, so this tenant
  cannot receive ranked brand recommendations from any assistant. The fix exposes a recorded
  `description` when one carries a fact; these seeded descriptions do not. Adding brand and
  specification fields is a product-schema decision, not a prompt change.
