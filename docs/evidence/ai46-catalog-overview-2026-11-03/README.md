# AI-46 — what the catalogue contains, in one grounded read

## What shipped

`getCatalogOverview` returns, for the session's ACTIVE products:

- total active products;
- per-category product counts;
- the number of distinct recorded brands;
- how many products have a recorded brand and how many do not;
- how many products have a recorded description and how many do not.

It deliberately has no stock, price or quality field. `listBrands` now also carries each
sample product's recorded description and the brand's recorded selling-price range, so a
brand comparison can use facts the business entered. The price range is not a value or
quality rating.

Prompt rule 20 sends "what do we carry / how complete is our data" to the overview once;
rule 18 uses the brand descriptions and price range only as recorded facts. The mobile
label is **Catalogue overview**. The catalogue is now 15 read-only tools.

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

## Phone verification — not completed

After the runner restart, `adb devices` returned no device, Windows did not enumerate the
phone, and scrcpy was not running. No phone screenshot or UI result is claimed. The preview
OTA is published; reconnect/unlock the phone and re-run the catalogue question.

## What this does not prove

This tenant has no recorded brands and no automotive products. The overview can report that
gap, but a positive brand recommendation cannot be demonstrated against this live catalogue.
The DB fixture proves the counts and comparison fields. A count is not evidence of quality,
and the overview does not say what is in stock.
