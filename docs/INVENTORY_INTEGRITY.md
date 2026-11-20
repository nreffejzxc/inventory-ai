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

The production run after the installed-app checks (2026-11-15) scanned 4,891 `STOCK_IN` rows and found 2,517 orphans and 0
unreceipted PO receipts. It exited 1 because findings exist; `rak gears` was clean. The breakdown,
scope and interpretation are in
[`evidence/inventory-integrity-2026-11-15`](evidence/inventory-integrity-2026-11-15/README.md).
The read-only provenance triage and the separately approved remediation options are in
[`TRIAGE.md`](evidence/inventory-integrity-2026-11-15/TRIAGE.md); **no row has been deleted or repaired.**

Exit codes follow the repository convention:

| Code | Meaning |
| --- | --- |
| `0` | Ran to completion; neither finding is present. |
| `1` | Ran to completion; at least one candidate was found. |
| `2` | **NOT CHECKED** — bad arguments, no connection string, the test database, or an unreachable database. Nothing is known. |

## Scheduled read-only monitoring

`npm run audit:integrity:monitor` runs the same audit, compares the findings with an explicitly
accepted baseline, records a local history, and can open one GitHub issue when a **new** finding
appears. It is still read-only: it never writes inventory, ledger, purchase-order or index data.

```bash
cd server
npm run audit:integrity:monitor -- --with-production --format=json   # check, no alert
npm run audit:integrity:monitor -- --with-production --notify        # check + issue alert
node scripts/monitor-inventory-integrity.mjs --with-production --accept-baseline  # after review
```

The installed Windows task is `InventoryAI Inventory Integrity Audit`: daily at **07:30 local**, with
`StartWhenAvailable`. The wrapper is `scripts/run-integrity-audit.ps1`; register it with
`scripts/register-integrity-audit-scheduler.ps1`. Its local history is
`%LOCALAPPDATA%\InventoryAI\integrity-audit\` (`latest.json`, `latest.md`, `history.jsonl`), and the
task log is beside it. The baseline is
[`evidence/inventory-integrity-monitor/baseline.json`](evidence/inventory-integrity-monitor/baseline.json);
the 2,517 known seed findings were accepted after triage, and a normal run reports **UNCHANGED / 0
new**. A new finding opens `[inventory-integrity] New findings detected`; the issue is updated only
when the new set changes and closed after recovery.

**Limits.** The trigger is a current-user Windows task, not a hosted pager: it runs only while this
user is signed in and the laptop is awake and online. The audit itself remains read-only. The only
write is one operational heartbeat document, made by a separate writer after a completed run; it
never touches inventory, ledger, purchase-order, product, location, user or baseline data.

**Related operational checks.** `audit:failures` reports committed writes whose audit row is
missing; `audit:price-quality` reports unusable price data; `audit:product-currency` lists every
product whose ISO 4217 code is missing or invalid without writing a value (resolve it only through a
verified explicit PATCH); `recover:integrity` performs
only exact, quantity-anchored journal recovery. They are scheduled through `ops:integrity` with a
lock per command and one GitHub issue alert per command; a failed GitHub delivery is persisted and
retried on the next run. `triage:integrity` is the read-only operator view of
`REQUIRES_ATTENTION` journals, keyed movement receipts and quarantined ledger rows, with reasons
and evidence. The unique
transfer-ledger index is a migration prerequisite: `npm run migrate:transfer-ledger-index` is
read-only until `--apply`, and a duplicate group is refused rather than guessed. The same exact
index is now a readiness requirement: `/api/health/ready` answers `503` if it is missing or wrong. The full semantics and limits are in
[`INTEGRITY_RECOVERY.md`](INTEGRITY_RECOVERY.md); the schedule is in
[`MONITORING.md`](MONITORING.md).

### Hosted freshness

The daily task publishes the latest aggregate result to one document in
`integrity_monitor_heartbeats`. The public endpoint `GET /api/health/integrity` returns **200** only
while that heartbeat is fresh (at most **26 hours** old and marked `UNCHANGED` or `NEW_FINDINGS`);
it returns **503** for a missing, stale, malformed or `NOT CHECKED` heartbeat. It publishes the
timestamp, age, audit status and aggregate counts only — no tenant, product, location or user data.
An UptimeRobot HTTP monitor, `Inventory AI integrity freshness` (id 804681164), checks it every five
minutes, so a stopped laptop becomes visible even when the laptop's own logs cannot be read.

This is a metadata write, not an audit write: `server/scripts/write-integrity-heartbeat.mjs` is the
only writer, and the audit and monitor source guards still refuse any inventory or ledger write.

GitHub's own `schedule` trigger has never fired for this repository, so no workflow cron is used.
The baseline is an acceptance of known candidates, not a repair.

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
- `server/test/inventory-integrity-monitor.test.mjs` — the baseline/comparison contract, new versus
  resolved rows, a missing baseline treated as all-new, malformed baselines refused, the once-per-set
  issue policy, and a source scan proving the monitor never opens a database itself.
- `server/test/phase07a-inventory-compensation.test.mjs` — the duplicate-key retry regression: a
  winning first stock-in inserts a row, then its compensation removes it before the loser retries; the
  loser must retry the full upsert and leave both the row and its ledger row, never a ledger-only
  movement.
