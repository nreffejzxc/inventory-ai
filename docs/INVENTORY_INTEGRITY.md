# Inventory integrity audit

`npm run audit:integrity` is a **read-only** report of two shapes the app cannot show:

| Finding | Meaning | Why it matters |
| --- | --- | --- |
| **Orphan STOCK_IN** | A `STOCK_IN` ledger row has no inventory row for the same business/product/location. | History says stock arrived, but there is no shelf quantity to support it. |
| **Unreceipted PO receipt** | A `STOCK_IN` with `reason: "PO receipt"` and a PO-number `reference` is not referenced by any receipt on that purchase order. | Receiving claims first, moves stock second and finalizes the receipt third. A finalize that throws is deliberately left uncompensated because it may have applied. This is the visible signature of that ambiguous failure. |

A finding is a **candidate for review**, not proof of intent. A manual stock-in can use a PO-like
reference, and an inventory row can be removed by an operator. The audit never repairs, rewrites or
deletes anything and has no `--fix` flag.

## Running it

Run from `server/`:

```bash
npm run audit:integrity                         # development database, all history
npm run audit:integrity -- --with-production    # production database, all history
npm run audit:integrity -- --business=<24-hex>  # one tenant
npm run audit:integrity -- --days=30            # bounded history
npm run audit:integrity -- --format=json        # machine-readable
```

The database is a fixed choice: development by default, production only with
`--with-production`. A free-form `--database=` is refused, and the test database is refused because
`npm test` owns it. Nothing is read without a connection string, and `--with-production` is the only
way this command can point at production. Both read-only CLIs connect with Mongoose `autoIndex` and
`autoCreate` disabled, so merely connecting cannot build an index.

The production run after the installed-app checks (2026-11-15) scanned 4,889 `STOCK_IN` rows and found 2,517 orphans and 0
unreceipted PO receipts. It exited 1 because findings exist; `rak gears` was clean. The breakdown,
scope and interpretation are in
[`evidence/inventory-integrity-2026-11-15`](evidence/inventory-integrity-2026-11-15/README.md).

Exit codes follow the repository convention:

| Code | Meaning |
| --- | --- |
| `0` | Ran to completion; neither finding is present. |
| `1` | Ran to completion; at least one candidate was found. |
| `2` | **NOT CHECKED** — bad arguments, no connection string, the test database, or an unreachable database. Nothing is known. |

## How the two checks work

- **Orphan** — a `$lookup` from each `STOCK_IN` to the exact `(businessId, productId, locationId)`
  inventory row; only rows whose lookup is empty are reported.
- **Unreceipted PO receipt** — a `$lookup` to the purchase order with the same `businessId` and
  `number`, flattening every embedded receipt line's `inventoryTransactionId`; the transaction is
  reported only when none of those receipt ids is its own `_id`. This is why a finalize that applied
  despite throwing is **not** reported: its receipt references the movement.

Both queries are tenant-scoped when `--business` is used and honour `--days`; the history default is
`all`, because an orphan from last year is still an orphan.

## What to do with a finding

1. Read the transaction id, product, location, quantity and timestamp.
2. For an orphan, check whether the inventory row was removed by a later operation or whether the
   movement should never have survived. Do **not** delete the ledger row as a first response — history
   is the audit trail.
3. For an unreceipted PO receipt, open the PO and inspect `pendingClaims` and its receipts. A movement
   that is genuinely on the shelf but has no receipt may need a human reconciliation decision; a
   movement that is not on the shelf is the failure the stock-in compensation paths are designed to
   prevent.
4. Record the decision and evidence. This command deliberately does not offer an automated repair.

The related duplicate-history audit is `npm run audit:duplicates`; it answers a different question
(one request applied twice) and is also read-only.

## Tests

- `server/test/audit-inventory-integrity.test.mjs` — argument refusals, both pipeline shapes, real
  MongoDB fixtures (normal receipt, unreceipted PO stock-in, orphan controls, tenant/cutoff scoping),
  the report, and a source scan that fails if either file grows a write call.
- `server/test/phase07a-inventory-compensation.test.mjs` — the duplicate-key retry regression: a
  winning first stock-in inserts a row, then its compensation removes it before the loser retries; the
  loser must retry the full upsert and leave both the row and its ledger row, never a ledger-only
  movement.
