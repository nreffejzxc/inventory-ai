# AI-46 — what the catalogue contains, in one grounded read

## What shipped

`getCatalogOverview` returns, for the session's ACTIVE products:

- total active products;
- per-category product counts;
- the number of distinct recorded brands;
- how many products have a recorded brand and how many do not;
- how many products have a recorded description and how many do not.

It deliberately has no stock, price or quality field. `listBrands` also carries each sample
product's recorded description and the brand's recorded selling-price range, so a brand
comparison can use facts the business entered. The price range is not a value or quality
rating.

Prompt rule 20 sends "what do we carry / how complete is our data" to the overview once;
rule 18 uses the brand descriptions and price range only as recorded facts. The catalogue is
now 15 read-only tools. The app's explicit label is **Catalogue overview**; the installed
build showed the humanised fallback **Catalog overview**.

## Verification

- `server/test/AI46-catalog-overview.test.mjs` **4/4** (2 unit + 2 DB): coverage counts,
  category breakdown, brand/description gaps, brand price range and sample descriptions.
- AI-44 **7/7** and AI-45 **8/8** still pass; phase06 **18/18**; AI-2 and AI-18 guards pass.
- The OpenRouter full-catalogue workload executes all **15** tools in one turn.
- Server and mobile `tsc --noEmit` clean; mobile tool-label suite **8/8**.
- PR #141 merged as **`96bc659`** with all four checks green.
- Production `/api/health` reports `96bc659`, database `connected`, **0** server errors.
- Preview OTA `12c6435d` is published.

The first full-suite run found two integration mirrors that the focused tests did not:
a stray prompt comma, and the OpenRouter all-tools list missing `getCatalogOverview`.
Both were fixed before the green run.

## Phone verification — completed

After the phone reconnected and the owner signed in, this question was asked in a new chat:

> What does our catalogue contain, and how complete is the brand data?

The answer on the installed preview build:

> Your active catalogue holds **1 004 products** spread across **5 categories**:
>
> - Household — 252 products
> - Personal Care — 251 products
> - Beverages — 250 products
> - Snacks — 250 products
> - Uncategorised — 1 product
>
> **Brand data:** **3 distinct brands** are recorded across the whole catalogue. Only **3
> products** have a brand assigned; the remaining **1 001 products** have no brand on file.
>
> **Description coverage:** **1 000 products** have a recorded description; **4** do not.
>
> So the catalogue is large, but brand information is sparse — just three brands for a
> small subset of items, and most products lack a brand entirely.

Provenance: **Catalog overview**. It used one read, reported no invented products, brands or
stock, and made no quality claim. Screenshots:
[`catalog-question.png`](catalog-question.png) and [`catalog-answer.png`](catalog-answer.png).

The exact counts are the production data at the time of the test; they can move as products
are added or edited. The category list includes one uncategorised product, which is why the
tool reports five category rows although four named categories were expected.

## What this does not prove

The tenant records only three brand values and no automotive products. The overview can
report that gap, but a positive brand recommendation cannot be demonstrated against this
live catalogue; the DB fixture proves the comparison fields. A count is not evidence of
quality, and the overview does not say what is in stock.
