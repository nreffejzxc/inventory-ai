# AI-45 — a natural product question, and the turn that stopped looping

**Question asked on the phone:** *"Do we have engine oils suitable for cars and
motorcycles? Recommend the best brands currently available."*

## First attempt — the defect

On `aae32ea` the assistant called `findProducts`, then `listCategories`, then repeated
one-word product searches, and exhausted the six-step tool budget:

> I could not finish that request within the allowed number of steps. Please try a more
> specific question.

The provenance chip named **Find products · Categories · Product search**. The data was
right — there are no automotive products — but the turn never delivered the answer.
Screenshot: [`first-loop-failure.png`](first-loop-failure.png).

## Fix

A no-match `findProducts` result now carries:

- the **ACTIVE categories**, so the model does not need a separate `listCategories` call;
- an explicit **stop instruction**: do not run another search for this question; answer
  with the empty result and the categories.

Prompt rules 17 and 19 say `findProducts` does the category + word check in one call, and
that a no-match result is terminal. No iteration cap was raised; the turn now finishes in
fewer calls. PR #139.

## Retest — the same question on `e1af99c`

> I searched the catalogue for engine-oil-related products using the terms "engine oil"
> and "motor oil." No matching products were found.
>
> The business's active categories are: Personal Care, Household, Snacks, Beverages.
>
> Because there are no engine-oil items in the records, I cannot recommend any brands or
> report stock levels for this product type.

Provenance: **Product discovery**. This is the honest answer for this tenant, and it is
natural: it names the search, shows what the catalogue does contain, and refuses the
unsupported brand/stock claim. Screenshot: [`natural-answer.png`](natural-answer.png).

## What the tests prove

`AI45-natural-product-search.test.mjs` **8/8** (3 unit + 5 DB):

- a synonym the product name does not use (`engine oil`) still finds `Motor Oil 10W-40`;
- a term recorded only in the description (`petrol cars`) finds the row;
- several terms are alternatives, and `inStockOnly` drops the out-of-stock row;
- a no-match page carries the categories and the stop guidance;
- category filtering uses the exact-name resolution.

AI-43 and AI-2 guards pass; AI-18's page guard passes. PR #138 merged as `aae32ea`;
PR #139 merged as `e1af99c`; all four checks were green on both. Production health reports
`e1af99c`, database `connected`, **0** server errors. Preview OTA `5d89b55b` carries the
`Product discovery` label.

## What this does not prove

- This tenant still has **no automotive products**, so the phone verifies honest absence,
  not a positive engine-oil recommendation. The positive path is covered by the DB fixture.
- `findProducts` is discovery, not a quality ranking; it compares only recorded brand,
  description, price, unit and stock. The tenant has no specifications or quality ratings.
