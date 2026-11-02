# AI-44 — recorded brands, and the honest empty state

**What this proves.** The assistant can answer "what brands do we carry?" from a real
product field — not from an adjective in a product name. The phone in this tenant has no
brands recorded, so the answer shown here is the honest empty state; the positive case is
pinned against a real MongoDB fixture in `server/test/AI44-brand-lookup.test.mjs`.

## The change

- Product gains an optional `brand` field (trimmed, max 80 characters) through the model,
  DTO, create/update API, mobile product form, product detail and product list.
- The existing product search `q` now matches brand as well as name, SKU and barcode.
- New read-only tool `listBrands` aggregates ACTIVE products by recorded brand, with the
  product count, categories and at most three sample product names. It accepts an optional
  exact category name or category id, and an optional brand substring. It deliberately does
  **not** report stock; `searchProducts`/`getProduct`/`getInventory` answer that next question.
- Prompt rule 16 treats brand as recorded data and distinguishes `null` ("no brand recorded")
  from "no such brand"; rule 18 routes brand questions to `listBrands`.
- The AI-43 grounding note was updated: the catalogue now has a brand field, a missing brand
  is `null`, and a description remains free text rather than a specification field.

## Evidence

[`brands-empty.png`](brands-empty.png) — the phone's answer against production `a99aed7`,
after preview OTA `ecff412c-1312-4901-9686-7cc8d397b7c7`:

> No brands are currently recorded for the active products in your inventory — brand is an
> optional field, and none of the active items have a brand on file.

The provenance chip reads **Read: Brands**. This is the correct answer for this tenant: the
1,001 seeded products carry no brand values yet. The tool was reached, the prompt did not
invent a brand, and the empty result was explained as "not recorded", not "no brands exist".

## What the tests prove

`AI44-brand-lookup.test.mjs` **7/7** (2 unit + 5 DB):

- `searchProducts` matches a recorded brand and returns it beside the row.
- `listBrands` aggregates two products under one brand, with its category and sample names.
- The exact category-name filter resolves and returns both brands in that category.
- A no-match brand page says no brand is recorded.
- `getProduct` returns a recorded brand and `null` for an unbranded product.

AI-43 **10/10**; the AI-2 read-only table guard passes; the OpenRouter all-tools turn runs
all **13** tools including `listBrands`. CI's full server suite and all four required checks
were green on PR #136. Server `tsc --noEmit`, ESLint, mobile typecheck and mobile lint are
clean.

## What this does not prove

- This tenant has **no recorded brands**, so the phone shows the empty state, not a positive
  brand summary. The DB fixture covers the positive path.
- `listBrands` reports brand presence and product counts, not on-hand stock.
- Brand is optional. A product without one is not counted, and a missing value must never be
  read as proof that the business does not stock that brand.
