# AI-106 low-stock share production validation — 2026-11-11

## The live answer

Against production Render commit `47ad058` (PR #236), the OPPO `CPH1969` asked:

> How many products are low on stock what is their total value and what percentage of total
> inventory value is that

The answer was:

> The total recorded value of the 19 low-stock items is 1,633,025. That is 0.47% of the total
> recorded stock value of 346,118,013.

- **Ref:** `cb84331e`
- **Screenshot:** [`low-stock-share.png`](low-stock-share.png)
- **Result:** 19 distinct low-stock products, PHP 1,633,025 low-stock value, PHP 346,118,013 total
  inventory value, 0.47%. The earlier 41-row answer was not repeated.

## Why the earlier answer said 41 rows

The earlier turn read a paged inventory listing and counted the returned rows as products. Those
rows are stock records, not a complete, distinct product set, so the numerator could include more
rows than there are low-stock products and the denominator could come from a different or
incomplete read. Presenting a percentage from that partial set made the answer look precise while
it was not supported by a complete product-level total.

The fix is deterministic rather than another model prompt:

- A low-stock count/value/share question routes to `getLowStockProducts` with a limit of 50, so the
  set is product-level and complete for this tenant.
- `getStockValue` supplies only the total-inventory-value denominator.
- The percentage is computed only when the low-stock set is complete and the numerator and
  denominator use the same currency. A paged `getInventory` row count is never used as the product
  count.

## Regression coverage

- `server/test/AI106-finalizer-detail-preservation.test.mjs` — 11/11 focused tests cover the
  `19 / 1,633,025` detail preservation, the low-stock share route, the incomplete-set guard, and the
  no-paged-row counting rule.
- Full unit suite after the fix: **1,990 passed, 0 failed, 62 skipped**.
- Typecheck and lint were clean.
- PR #236 was squash-merged as `47ad058`; the drill follow-up was later deployed as `c3bd692`.
