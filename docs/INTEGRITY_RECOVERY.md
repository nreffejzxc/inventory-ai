# Inventory integrity, recovery and price quality

**Last reviewed:** 2026-11-19
**Scope:** durable transfer journals and reconciliation, the unique transfer-ledger guard and its
migration, the cross-instance recovery lease, PO receive idempotency and request fingerprints,
abandoned receive-claim recovery, the category archive policy, audit-failure monitoring, the
read-only price-quality report, currency-safe AI price ranking, the scheduled operational runner
for the three integrity commands, fail-closed readiness for the unique ledger index, and the
read-only attention triage. This is the operator and design reference; §27KG and §27KH in
`DEVELOPMENT_ROADMAP.md` record this tranche.

## 1. What is guaranteed

Business writes remain single-document, guarded updates. This work adds durable intent and
proof around them; it does **not** turn multi-document work into a MongoDB transaction.

| Operation | Guarantee | Deliberate limit |
| --- | --- | --- |
| Stock-in / stock-out / adjustment | A keyed movement writes a durable receipt before stock moves. A retry under the same key replays the stored answer, recovers the ledger row, or rolls the missing ledger row forward from the receipt's exact snapshots. | No key means no receipt: older clients and direct service callers keep the transport-only behavior. An outcome that cannot be proven becomes `REQUIRES_ATTENTION` and answers `409 MOVEMENT_REQUIRES_ATTENTION`. |
| Stock transfer | A journal is written before stock moves. A stale journal is completed only when both inventory legs and their exact snapshots are present; otherwise the provable side is undone, or the row becomes `REQUIRES_ATTENTION`. | A row changed after the transfer window is never overwritten. Ambiguity is surfaced, not guessed. |
| Transfer ledger uniqueness | The database enforces at most one TRANSFER ledger row per `(businessId, transferOperationId, locationId)` through a unique partial index. Two recovery passes can both try the missing leg; only one insert wins. | The index must be built in each environment. Existing duplicates are a migration decision, not silently deleted. |
| Transfer retry | The same `Idempotency-Key` with the same request replays the stored response. The same key with different product, locations, quantity, reason or reference is `422 IDEMPOTENCY_KEY_REUSED`. | A journal created before this field existed has no fingerprint and is replayed by key alone. |
| PO receiving | The HTTP route requires `Idempotency-Key`. The key is stored on the claim and the receipt, together with a canonical request fingerprint. A matching complete receipt is replayed; a changed request under the same key is `422 IDEMPOTENCY_KEY_REUSED`. | Direct service callers and historical tests may still omit the key. Old receipts without a fingerprint can only be matched by key. |
| Abandoned PO claim | A stale claim is reconciled from its stock-in transaction: a receipted movement releases only the reservation, an exact movement is undone and removed, an untouched claim is released, and anything unprovable is flagged. | A claim whose inventory row moved after its stock-in is not undone. |
| Category archive | Archiving a category with ACTIVE products is refused with `CATEGORY_HAS_ACTIVE_PRODUCTS`; archived products do not block. | The check is not a transaction against a product being created concurrently. |
| Audit write failure | The business write still succeeds. The gap becomes a durable `audit_failures` row with a sanitized class and an `[audit-gap]` log line, retained for 90 days by TTL. | Monitoring is best-effort; if the monitor write also fails, the log is the only record. |
| AI price ranking | Ranking happens inside one recorded currency. Mixed known currencies, or a known currency plus unrecorded prices, block a single ranking and return the currency groups instead. Ties break by name then `_id`. | Zero and missing prices are excluded from rankings. A currency is not converted. |
| Price quality | The report counts missing price, zero price, missing currency and malformed currency, and samples rows to fix. It never writes. | It checks the ISO-4217 **shape** (three uppercase letters), not the full official code list. |

## 2. Transfer journal

Model: `stock_transfer_operations` (`server/src/models/stockTransferOperation.model.ts`).

States:

| State | Meaning |
| --- | --- |
| `PREPARED` | Intent written; no inventory change confirmed. |
| `SOURCE_DEBITED` | Source decrement confirmed. |
| `DESTINATION_CREDITED` | Destination increment confirmed. |
| `LEDGER_WRITTEN` | Both TRANSFER ledger rows exist. |
| `COMPLETED` | Both rows exist, markers are cleared and the response is stored. |
| `COMPENSATED` | Inventory was restored after a clean failure or exact undo. |
| `FAILED` | The request failed before recovery proved the final state. |
| `REQUIRES_ATTENTION` | Recovery could not prove a safe finish or undo. |

Every inventory row touched by a transfer temporarily carries the operation id in
`transferOperationIds`. That marker is written by the same atomic update as the quantity, so it
survives a process death that happens before the journal records the row id. Each leg stores its
previous and new quantity. The journal is operational evidence, not a stock ledger: inventory
remains the quantity source of truth and `inventory_transactions` remains the movement record.

`recoverTransferOperation()` proves the state in this order:

1. No marker and no ledger row: mark `COMPENSATED` (nothing moved).
2. No marker but both ledger rows: mark `COMPLETED` (a late observation of durable work).
3. Both markers and exact recorded quantities: roll the ledger forward, clear markers, record a
   recovery audit, and mark `COMPLETED`.
4. Source marker only: undo the source only while it still holds the exact post-debit quantity,
   then mark `COMPENSATED`; otherwise flag.
5. Destination marker without a source marker: flag.
6. Any existing ledger row whose location, product, quantity, previous quantity or new quantity
   does not match the journal: flag instead of accepting the pair.

Roll-forward is idempotent per location. A ledger row is created only when that location has no
row for the operation, and a duplicate-key loss is re-read rather than treated as a failure.

The database guard is `uniq_transfer_operation_location` on
`(businessId, transferOperationId, locationId)`. It is **partial** on
`transferOperationId: { $type: 'objectId' }`, so ordinary stock movements without an operation id
are not treated as duplicate nulls. If two recovery passes observe the same missing leg, one insert
wins and the loser accepts the winner only after re-reading it and checking the journal's snapshot.

Existing databases must run `npm run migrate:transfer-ledger-index` before the new server binary is
deployed. The command is read-only by default. `--apply` refuses every ambiguous duplicate group
before changing anything; exact copies are copied to `inventory_transaction_quarantine` and only
then removed, and the index is built and verified. See §7.1.

### 2.1 Stock movement receipts

Model: `stock_movement_operations` (`server/src/models/stockMovementOperation.model.ts`). It is
unique per `(businessId, requestKey)` and is written only when the request carries an
`Idempotency-Key`. Transfers keep their own journal and PO receiving its own claim/receipt; they do
not use this row. A movement without a key is unchanged.

| State | Meaning |
| --- | --- |
| `IN_PROGRESS` | The receipt exists; no inventory change is confirmed. |
| `INVENTORY_WRITTEN` | The inventory row was changed; the ledger row is not confirmed. |
| `COMPLETED` | The ledger row exists and the exact response is stored. |
| `REQUIRES_ATTENTION` | Recovery cannot prove whether stock moved; a person decides. |

The receipt stores the request fingerprint, the exact product/location/quantity/text fields, the
inventory row id, previous and new quantities, the ledger row id, the stored response and the
stock-in `createdRow` flag. The ledger remains the truth: stock is read from `inventory`, completed
movements from `inventory_transactions`. A retry proves the outcome in this order:

1. a stored `COMPLETED` response — exactly what the first delivery returned;
2. the named ledger row, or a row carrying the receipt id in `movementOperationId`;
3. `INVENTORY_WRITTEN` plus an inventory row still exactly at `newQuantity` — write the missing
   ledger row from the receipt's snapshots; the partial unique
   `(businessId, movementOperationId)` index makes two recoverers safe;
4. anything else — mark `REQUIRES_ATTENTION` and answer `409 MOVEMENT_REQUIRES_ATTENTION`, never
   re-apply the movement.

A verified compensation deletes the receipt so a corrected retry starts cleanly. An unverified
failure keeps it. The same key with a different fingerprint is `422 IDEMPOTENCY_KEY_REUSED`. The
client keeps its stored key on the attention answer; support resolves the receipt, and the next
retry replays the resolved outcome. Receipts have no TTL or reaper yet: a `REQUIRES_ATTENTION` row
stays until a person resolves it, and completed rows remain as operational evidence.

## 3. When recovery runs

`server/src/services/recoveryScheduler.ts` runs one transfer pass and one claim pass:

- 30 seconds after a serving process boots;
- every 5 minutes thereafter;
- never in a test process;
- never overlapping within one process;
- stopped before database shutdown.

Only transfer journals older than **60 seconds** and claims older than **10 minutes** are
candidates, so a healthy request is not stolen. A failed pass is logged and does not stop the API.
The reapers are bounded to 50 rows per pass.

Before either reaper runs, the pass acquires one MongoDB lease in
`integrity_recovery_leases` (fixed id `integrity-recovery`, default 10-minute expiry, renewed
while the pass runs). A second serving instance gets no lease and returns `skipped: lease-held`
rather than scanning the same rows. An expired lease is taken over immediately, so a crashed owner
does not wait for the TTL monitor. Release is scoped to the owner's token, so a stale process
cannot release a newer owner's lease. The lease reduces duplicate work and duplicate recovery
audits; it is not the correctness boundary — the guarded inventory updates and the unique ledger
index remain safe even if a lease is lost mid-pass.

## 4. Transfer and receive request identities

- Receiving: `POST /api/purchase-orders/:id/receive` returns
  `400 IDEMPOTENCY_KEY_REQUIRED` without the header. `validateReceive` runs next, then the
  service stores the key and a SHA-256 fingerprint of the canonical sorted lines, reference and
  purchase order.
- Receiving retry: the method first looks for the client's own receipts on the PO. A complete
  match is replayed; a partial match is `409 RECEIVE_CONFLICT` with the applied lines so the
  client cannot silently continue; a changed fingerprint is `422`.
- A key with a claim but no receipt means the prior attempt never finalized. The service refuses
  with `409 RECEIVE_IN_PROGRESS` rather than guessing whether stock moved.
- Transfers: the journal stores the key and a fingerprint over business, product, both
  locations, quantity, reason and reference. A `REQUIRES_ATTENTION` journal blocks a fresh
  transfer under the same key with `409 TRANSFER_REQUIRES_ATTENTION`.

The mobile client supplies a key for transfers and PO receiving. It keeps that key across a
transport failure, a 5xx and `RECEIVE_IN_PROGRESS`, and drops it when the server returns a
definite answer or a report of partially applied work.

## 5. Abandoned PO claim phases

A claim is created before stock moves and carries `CLAIMED`, then `MOVED` after the stock-in, or
`REQUIRES_ATTENTION`. The receiving stock-in transaction carries the claim id. The reaper:

1. A receipt references the transaction: release only the redundant reservation; never move stock.
2. A transaction exists and the inventory row still equals its `newQuantity`: restore
   `previousQuantity`, delete the transaction and its stock-in audit, release the claim, and
   record `PURCHASE_ORDER_CLAIM_RECOVERED`.
3. No transaction: release the reservation.
4. No transaction but the claim says `MOVED`: flag it.
5. A row moved after the stock-in: flag it.

## 6. Category archive policy

A category is refused while it has ACTIVE products. Archived products may keep the category as
historical grouping, so they do not block. `CATEGORY_HAS_ACTIVE_PRODUCTS` names the count; the
operator must move or archive those products first. Restoring a category remains available.

## 7. Commands

All commands follow the repository database rule: development by default, production only
with `--with-production`, and the test database is refused.

```bash
cd C:/Users/jeffe/inventory-ai/server

# Read-only: audit gaps, counts, action and tenant breakdown.
npm run audit:failures -- --days=30
npm run audit:failures -- --business=<24-hex-id> --format=json

# Read-only: price quality for ACTIVE products.
npm run audit:price-quality
npm run audit:price-quality -- --business=<24-hex-id> --format=json

# Writes only exact recovery actions; prints counts and flags anything unresolved.
npm run recover:integrity
npm run recover:integrity -- --format=json

# Read-only: REQUIRES_ATTENTION journals and quarantined ledger rows, with evidence.
npm run triage:integrity
npm run triage:integrity -- --business=<24-hex-id> --format=json

# Migration: read-only preflight first, then apply after review.
npm run migrate:transfer-ledger-index -- --with-production
npm run migrate:transfer-ledger-index -- --with-production --apply

# Scheduler-facing wrapper: one command per lock, optional GitHub issue alert.
npm run ops:integrity -- --command=audit:failures --with-production --notify
npm run ops:integrity -- --command=audit:price-quality --with-production --notify
npm run ops:integrity -- --command=recover:integrity --with-production --notify
```

| Command | Exit 0 | Exit 1 | Exit 2 |
| --- | --- | --- | --- |
| `audit:failures` | no failures in the window | at least one gap | not checked (arguments, connection, wrong database) |
| `audit:price-quality` | no price problem | at least one problem | not checked |
| `recover:integrity` | pass ran, no row failed | at least one row failed to reconcile | not checked |
| `triage:integrity` | no attention journal, movement receipt or quarantine row | at least one attention/quarantine row | not checked |
| `migrate:transfer-ledger-index` | clean, or applied successfully | duplicates need review, or ambiguity blocked apply | not checked |
| `ops:integrity` | command clean, or another run held the lock | finding/attention | NOT CHECKED or runner error |

`recover:integrity` exits 0 when another process holds the recovery lease and the pass is
skipped; this is duplicate-run prevention, not a claim that a different pass succeeded. Its JSON
carries `skipped: "lease-held"` so a scheduler can tell the difference.

`ops:integrity` runs the existing command as a child, preserves its 0/1/2 distinction, and never
turns a NOT CHECKED result into a data finding. It acquires one lock file per command under the
history directory; a lock older than 30 minutes is stale and may be taken over. A duplicate run
exits 0 without touching history or alerts. With `--notify` (production only), it opens, updates or
closes one GitHub issue per command, deduplicated by a stable signature of the result. Raw child
output and connection strings are not put in the issue.

A failed GitHub create, comment or close is written to the latest history as an undelivered alert
(`notification.undelivered` plus `notificationPending`) before the runner exits. The next
`--notify` run retries it even when the child's status and signature are unchanged. A recovery that
posted its comment but failed to close resumes at the close, so the comment is not duplicated. A
run without `--notify` carries the pending record forward instead of erasing it. If the history
write itself fails, the delivery cannot be retried automatically: the error is printed and the
next successful run recomputes the signature from GitHub's open issues.

`audit:failures` and `audit:price-quality` are reports, not repairs. `recover:integrity` writes
only the actions in §2 and §5. A `REQUIRES_ATTENTION` row stays in the database for manual
investigation; there is no automatic unflag command. `triage:integrity` is the read-only view for
that investigation. Its database reads live in `server/scripts/lib/triage-read.mjs`, separate from
the CLI's arguments and exit code. A DB-backed test seeds a real `REQUIRES_ATTENTION` transfer and a
quarantined ledger row, asserts the exact reason, snapshot, ledger and `keptId` evidence, and
compares every touched collection before and after to prove the read changed nothing.

### 7.1 Transfer-ledger index migration

The migration preflights before it writes:

1. groups TRANSFER rows by `(businessId, transferOperationId, locationId)`;
2. classifies a group **exact** only when product, quantity, before/after quantities, reason,
   reference, PO claim and user all agree (row id and timestamps are not movement);
3. refuses the whole run if any group is ambiguous — no quarantine, delete or index build;
4. writes every exact duplicate to `inventory_transaction_quarantine` by original `_id`, then
   deletes it only if its movement fields still match the quarantined copy;
5. builds `uniq_transfer_operation_location` and verifies that the database now reports it unique.

The preflight is safe on production. `--apply` on production additionally requires
`TRANSFER_LEDGER_MIGRATION_CONFIRM=MIGRATE-TRANSFER-LEDGER` in the environment. A crash between
quarantine and delete is repeatable: the quarantine upsert uses the original id, so a second run
does not create a second copy. A retry also compares the existing quarantine copy with the current
row; if they differ, nothing is deleted. Nothing in inventory, the transfer journal or an unrelated
ledger row is modified.

The scan matches the index predicate — any row carrying a real `transferOperationId`, not only
`type: 'TRANSFER'` — so a stray row cannot make the index build fail after duplicates were removed.
Two further guards block before any write: reaching `--limit` (the operator must raise it so the
whole collection is inspected) and an existing same-key index that is not unique and partial (drop
or rebuild it after review).

Run the read-only preflight first. A `BLOCKED` report names the reason, the duplicate groups and
their differing fields; resolve those by hand before applying.

### 7.2 Read-only attention triage

```bash
npm run triage:integrity
npm run triage:integrity -- --with-production --business=<24-hex-id> --limit=500 --format=json
```

`triage:integrity` lists three evidence sets in one report:

- stock-transfer journals whose state is `REQUIRES_ATTENTION`, with `failure`, caller `reason`,
  product/location names, source and destination row ids and before/after snapshots, and every
  ledger row carrying the operation id;
- stock-in/stock-out/adjustment receipts whose state is `REQUIRES_ATTENTION`, with the request
  key, kind, product/location, quantity, before/after snapshots, inventory row and ledger row ids
  and the failure. The request key is shown because retrying under a new key could apply a second
  movement;
- rows in `inventory_transaction_quarantine`, with `quarantineReason`, `quarantinedAt`, the original
  ledger row id, `keptId`, the operation id and the movement fields.

It connects with `autoIndex: false` and `autoCreate: false` and issues reads only. There is no
`--fix`, `--apply` or `--repair`: a row is printed for a human, never changed. Exit 1 means at
least one row needs attention, not that the command repaired anything. Use the documented
`recover:integrity` actions only when they are provably safe; an ambiguous row is resolved by hand.

### 7.3 Fail-closed ledger-index readiness

`GET /api/health/ready` checks the database connection **and** the exact transfer-ledger index on
every request. The index must have all of the following or the endpoint answers `503`:

- the key `(businessId, transferOperationId, locationId)` in that order;
- `unique: true`;
- the partial filter `{ transferOperationId: { $type: 'objectId' } }`, with no extra fields.

A missing index, a non-unique index, a reordered key or a different partial filter makes the
process not ready. The check reads `listIndexes` with a 2.5-second bound; it never creates, drops or
repairs an index. The response includes a short `reason` naming the broken requirement, never a
connection string. A database that is down is reported by the existing connection branch without
attempting the index read.

## 8. Limitations and remaining risks

- **No multi-document transactions.** A crash can still leave an ambiguous state; the transfer
  journal, movement receipt, claim reaper and their recovery paths make it visible and usually
  repairable, not impossible.
- **The index must exist in every environment.** Application auto-index is not a migration: a
  database holding duplicate rows will reject the unique build. Run the preflight and apply before
  deploying a server that expects the guard. This pass did not run either command against
  production.
- **Lease expiry is time-based.** A pass that loses its lease may finish alongside a new owner. The
  unique ledger guard and quantity-anchored recovery keep that safe, but a duplicate recovery audit
  can still be written. The lease reduces this window; it does not make the audit idempotent.
- **A flagged movement receipt needs a person.** Retrying it under the same key answers `409
  MOVEMENT_REQUIRES_ATTENTION`; there is no unflag or repair command. `triage:integrity` prints the
  receipt and its evidence. Completed and abandoned receipts have no TTL or reaper yet, so the
  collection grows with keyed movements.
- **Recovery audit can duplicate.** If a process died after writing the recovery audit but before
  marking `COMPLETED`, the next pass writes a second audit event. Inventory is unaffected.
- **Alert retries need a later run.** A failed GitHub delivery is durable in local history, but
  nothing wakes the machine to retry it; the next scheduled or manual `--notify` run does. A failed
  history write leaves no retry record. The outbox is local to one scheduler host: two hosts keeping
  separate histories can both comment on the same issue, though the issue title still deduplicates
  the issue itself.
- **Readiness pays one index read.** Every `/ready` request performs a `listIndexes` after the
  driver says the database is connected. It is bounded and read-only, but it is not the zero-I/O
  local check the endpoint used to be.
- **The operational runner is single-host by default.** Its lock is a local file; the recovery
  lease is MongoDB-backed, but the read-only audit locks only suppress duplicate runs on one
  machine. The shipped Windows task wrapper has not been registered in this tranche.
- **Legacy rows lack fingerprints.** Old receipts and transfer journals fall back to key-only
  replay; only rows written after this change carry a fingerprint.
- **Conservative currency block.** The group check ignores `inStockOnly`, so an out-of-stock
  product in another currency can block a ranking even when the in-stock set is single-currency.
  This is deliberately safe; it can be narrowed later.
- **Currency detection is keyword-based.** The assistant recognizes common ISO codes in the
  question and the ₱ sign. It does not convert or infer a currency from a price.
- **Category archive race.** A product created concurrently with the archive check can still
  reference the newly archived category. The next write rejects it.
- **No production verification.** This work was tested against the test database only; no
  production data, deployment, commit or production command was run.

## 9. Verification

`server/test/INTEGRITY-RECOVERY.test.mjs` covers 17 DB-backed cases:

- transfer source-only undo, both-leg completion, inexact undo refusal, reused-key fingerprint
  rejection, `REQUIRES_ATTENTION` blocking, and both marked and unmarked bad-ledger refusal;
- claim stock-in undo, untouched release and moved-row flag;
- HTTP-required receive key and changed-request rejection;
- category archive refusal and allowance;
- audit-gap sanitization and tenant scoping;
- price-quality problems and write-free reporting;
- AI price tie order and mixed-currency blocking.

`server/test/TLI-transfer-ledger-guard.test.mjs` covers the new guard in 5 DB-backed cases:

- the unique `(businessId, transferOperationId, locationId)` rejection against the real index;
- ordinary movements without an operation id remaining outside the partial index;
- lease ownership, renewal, stale takeover and owner-scoped release;
- a whole recovery pass being skipped while another owner holds the lease;
- a disposable-database migration that refuses ambiguous duplicates before any write, quarantines
  exact copies, removes only those copies and builds the unique partial index.

`server/test/INVENTORY-IDEMPOTENCY.test.mjs` covers the durable stock-movement receipt in its
DB-backed cases: replay after the transport record is gone, recovery of a ledger row left by a
crash, stock-out and adjustment replay, a changed movement under the same key, the stored
`createdRow` flag, and the `REQUIRES_ATTENTION` refusal. `server/test/triage-integrity.test.mjs`
covers the receipt's read-only triage row.

The focused checks are `npm run typecheck` and
`TEST_MODE=db node --test test/INTEGRITY-RECOVERY.test.mjs test/TLI-transfer-ledger-guard.test.mjs`
in `server/`. The operational runner's pure policy is `server/test/ops-integrity.test.mjs`; its CLI retry path is
`server/test/ops-integrity-cli.test.mjs`. Index readiness is
`server/test/transfer-ledger-index-readiness.test.mjs`, and the read-only report is
`server/test/triage-integrity.test.mjs`. The related existing suites are Phase 19 transfers, Phase
13 receiving, Phase 04 catalog and inventory idempotency. The complete DB-backed suite is `npm run test:db`; on a constrained Windows host use
`npm run test:db -- --test-concurrency=4` to avoid exhausting the child-process budget.
