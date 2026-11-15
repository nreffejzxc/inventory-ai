# Inventory integrity audit — production, 2026-11-15

The production run of `npm run audit:integrity` after the installed-app transfer checks was **read-only**. It connected with
`autoIndex` and `autoCreate` disabled, performed only `countDocuments` / `aggregate` / `find`, and
did not repair, rewrite or delete any row.

```bash
cd server
node scripts/audit-inventory-integrity.mjs --with-production --format=json
```

## Result

| Measure | Count |
| --- | ---: |
| `STOCK_IN` rows scanned (all history) | **4,889** |
| Orphan `STOCK_IN` rows | **2,517** |
| Unreceipted PO receipt rows | **0** |

The command exits **1** by its own contract whenever it finds a candidate. That is the correct
result here; it is **not** a clean audit and not a test failure.

### Orphans by tenant

| Tenant | Orphan rows |
| --- | ---: |
| `PERF SEED — AI assistant stress test (do not use)` (`6af18628a9a409131a84235b`) | 2,502 |
| `steelseries` (`6aef37412ad6688f871a7bc7`) | 15 |

The test tenant `rak gears` produced **no findings**. The two reporting tenants are synthetic
datasets: the perf tenant is explicitly marked "do not use", and the `steelseries` rows are old
`Shop Front` demo-seed movements (`DEMOSKU-*`, `Seeded movement`) written before the current
write paths. The orphan rule is exact — a ledger row with no inventory row for the same
business/product/location — so these are real candidates in those datasets, not a runtime
regression.

### Orphans by recorded reason

| Reason | Rows |
| --- | ---: |
| `Seeded movement` | 2,231 |
| `Purchase order receipt` | 286 |

The 286 perf-tenant rows with `reason: "Purchase order receipt"` are **not** unreceipted PO
receipts: the unreceipted rule also requires the receiving reason `PO receipt` and a PO-number
reference not referenced by a receipt. The dedicated check found **0** such rows in production.

## What was not done

- No inventory row, ledger row, purchase order or index was created, changed or deleted.
- The audit has no repair flag. Correcting an orphan needs an owner decision; deleting the ledger
  row is not the first response because history is the audit trail.
- The full transaction-level JSON was inspected locally but is not committed: it contains 2,517
  findings and would obscure the summary. [`summary.json`](summary.json) is the committed summary.

## Verification of the audit itself

- `server/test/audit-inventory-integrity.test.mjs` — argument refusals, both pipelines against
  real MongoDB, tenant/cutoff controls, and source scans proving no write call and no Mongoose
  `autoIndex`/`autoCreate` at connect.
- `server/test/phase07a-inventory-compensation.test.mjs` — the duplicate-key retry regression
  (a winning row inserted and removed before the loser retries).
- The installed-app transfer run on the same day is recorded in
  [`docs/evidence/device-runs/2026-11-15T03-54-10-861Z-transfer`](../device-runs/2026-11-15T03-54-10-861Z-transfer).
