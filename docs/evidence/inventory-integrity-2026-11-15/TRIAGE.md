# Triage of the 2,517 orphan `STOCK_IN` findings

**Status:** read-only investigation complete; **no row was deleted or repaired**. This document is a
remediation *plan* that requires separate owner approval before any write.

The production audit at 2026-11-15T04:45:59Z scanned **4,891** `STOCK_IN` rows and reported
**2,517 orphan rows** and **0 unreceipted PO receipts**. Every orphan belongs to one of two synthetic
tenants; the production test tenant `rak gears` has none.

| Tenant | Orphan rows | Why it is synthetic |
| --- | ---: | --- |
| `PERF SEED — AI assistant stress test (do not use)` (`6af18628a9a409131a84235b`) | **2,502** | Dataset explicitly marked *do not use*; 2,216 rows are `SEED-*` seeded movements and 286 are `PO-*` purchase-order receipts written by the bulk seeders. |
| `steelseries` (`6aef37412ad6688f871a7bc7`) | **15** | Old demo-seed movements: every row is `DEMO-*`, `Seeded movement`, at `Shop Front`, written 2026-08-28 through 2026-11-06. |

## What was checked

- **Identity and scope.** All 2,517 rows are `STOCK_IN`; their `businessId`, `productId` and
  `locationId` all resolve to records that still exist. No row belongs to `rak gears`.
- **Who wrote them.** The transaction `userId` values are the two tenant owners only. No unknown
  account, API caller, or second tenant appears.
- **Reference shape.** 2,216 PERF rows use `SEED-<product>-<movement>`; 286 use `PO-SEED-*`; all 15
  SteelSeries rows use `DEMO-*`. None uses a runtime reference such as `PHONE-TRF-*`, a smoke-test
  reference, or an idempotency key.
- **The 286 PO rows are not unreceipted.** Their references resolve to 186 purchase orders, and every
  one of the 286 transaction ids is referenced by a receipt line on its order. The audit's separate
  unreceipted-PO check correctly reports **0**. They are orphans because the exact
  business/product/location inventory row is absent, not because a receipt is missing.
- **The products are not deleted.** The 2,502 PERF orphans touch 4,318 distinct products; all 4,318
  have inventory rows somewhere in the tenant (8,609 inventory rows in total). The 15 SteelSeries
  rows touch 57 products with 84 inventory rows elsewhere.
- **The locations are real.** PERF rows are split across `Cold Room` (1,113), `Overflow Store` (999)
  and `Shop Front` (390); SteelSeries rows are all at `Shop Front`.
- **The shape is the seeder's, not a write-path failure.** The seeders create inventory rows for a
  product/location pair, then create a separate history stream whose location is chosen independently
  for each movement (`server/scripts/seed/lib.mjs` and `server/scripts/seed-perf-data.mjs`). A random
  history row therefore often has no matching inventory row *by construction*. The rows predate the
  current audit and are not produced by the stock-in retry or transfer paths.

## What this means

These are **historical synthetic fixtures**, not evidence of an operator losing stock. Deleting the
ledger rows would make the audit quieter without making the demo/perf datasets more correct, and it
would remove history that explains the dataset. Adding inventory rows to match them would invent
stock that never existed. Neither action is justified by the evidence.

## Options, in order of preference

### 1. Keep them as accepted history and monitor only new findings — recommended

No data change. The monitor baseline names these 2,517 rows; a scheduled run alerts only when a new
finding appears. If the synthetic tenant is no longer wanted at all, retire the **whole tenant** with
the existing approved cleanup command, after a backup and explicit confirmation — not by deleting
individual ledger rows.

### 2. Retire the synthetic tenants through the existing whole-tenant cleanup

This is a separate, destructive operation. It needs a fresh backup, owner approval naming the tenant,
the existing cleanup phrase(s), and a fresh audit afterwards. It must not be combined with this
monitor and must not touch `rak gears`. The relevant commands are `npm run cleanup:perf-tenant` and
`npm run cleanup:demo-tenant`; their guards are documented in Guide 6.

### 3. Row-level deletion — not recommended

Only if the owner explicitly decides the ledger rows themselves must go. The plan would be:

1. Take a `mongodump` backup and record its manifest hash.
2. Export the exact `_id` list for the approved tenant and count; independently re-run the audit and
   compare the list with `summary.json`/the baseline.
3. Dry-run the deletion against a copy and prove `rak gears` is unchanged.
4. Obtain written approval naming the tenant and the exact count (2,502 or 15).
5. Delete only by `_id` within that tenant; never `deleteMany({ type: 'STOCK_IN' })` and never a
   pattern that could cross tenants.
6. Re-run `audit:integrity` (expected 0 for that tenant), `audit:duplicates`, and the `rak gears`
   inventory/ledger read-back; restore from backup if any differs.

The monitor and this document do **not** authorize step 5. Step 5 is deliberately absent from the
codebase.

## Evidence and reproducibility

- Full read-only audit command: `cd server && node scripts/audit-inventory-integrity.mjs --with-production --format=json`.
- The transaction-level JSON was inspected locally; it is not committed because it contains 2,517 rows.
  The committed `summary.json` records the counts, tenants and reasons.
- The monitor baseline is `docs/evidence/inventory-integrity-monitor/baseline.json`; its 2,517 ids
  match this triage exactly.
- The same facts can be re-derived with the read-only `audit:integrity:monitor` run; it never opens a
  database of its own and never writes inventory.

## Approval gate

**No deletion or repair is approved by this document.** The recommended next action is to leave the
rows in place, keep them in the baseline, and review any *new* finding the scheduled monitor reports.
Any cleanup of the two synthetic tenants needs its own written approval and a backup first.
