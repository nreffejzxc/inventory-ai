# Inventory integrity, recovery and price quality

**Last reviewed:** 2026-11-23
**Scope:** durable transfer journals and reconciliation, the unique transfer-ledger guard and its
migration, the cross-instance recovery lease, PO receive idempotency and request fingerprints,
abandoned receive-claim recovery, the category archive policy, audit-failure monitoring, the
read-only price-quality report, currency-safe AI price ranking, the scheduled operational runner
for the three integrity commands, fail-closed readiness and rollout for the six required indexes
(the three write guards plus the outbox TTL, movement audit-repair and PO receive audit-repair
indexes), the read-only attention triage, receipt retention/recovery, replayable-audit
deduplication, the durable audit outbox used by Product Import, keyed movement completion and PO
receive, and bounded outbox/repair health monitoring. This is the operator and design reference;
§27KG, §27KH, §27KK, §27KZ, §27LE, §27LF, §27LG and §27LI in `DEVELOPMENT_ROADMAP.md` record this
work.

## 1. What is guaranteed

Business writes remain single-document, guarded updates. This work adds durable intent and
proof around them; it does **not** turn multi-document work into a MongoDB transaction.

| Operation | Guarantee | Deliberate limit |
| --- | --- | --- |
| Stock-in / stock-out / adjustment | A keyed movement writes a durable receipt before stock moves. A retry under the same key replays the stored answer, recovers the ledger row, or rolls the missing ledger row forward from the receipt's exact snapshots. A scheduled pass and the dry-run-first operator command use the same proof, and completed receipts are pruned only after retention. | No key means no receipt: older clients and direct service callers keep the transport-only behavior. An outcome that cannot be proven becomes `REQUIRES_ATTENTION` and answers `409 MOVEMENT_REQUIRES_ATTENTION`; neither the pass nor the command deletes it. |
| Stock transfer | A journal is written before stock moves. A stale journal is completed only when both inventory legs and their exact snapshots are present; otherwise the provable side is undone, or the row becomes `REQUIRES_ATTENTION`. | A row changed after the transfer window is never overwritten. Ambiguity is surfaced, not guessed. |
| Transfer ledger uniqueness | The database enforces at most one TRANSFER ledger row per `(businessId, transferOperationId, locationId)` through a unique partial index. Two recovery passes can both try the missing leg; only one insert wins. | The index must be built in each environment. Existing duplicates are a migration decision, not silently deleted. |
| Transfer retry | The same `Idempotency-Key` with the same request replays the stored response. The same key with different product, locations, quantity, reason or reference is `422 IDEMPOTENCY_KEY_REUSED`. | A journal created before this field existed has no fingerprint and is replayed by key alone. |
| PO receiving | The HTTP route requires `Idempotency-Key`. The key is stored on the claim and the receipt, together with a canonical request fingerprint. A matching complete receipt is replayed; a changed request under the same key is `422 IDEMPOTENCY_KEY_REUSED`. | Direct service callers and historical tests may still omit the key. Old receipts without a fingerprint can only be matched by key. |
| Abandoned PO claim | A stale claim is reconciled from its stock-in transaction: a receipted movement releases only the reservation, an exact movement is undone and removed, an untouched claim is released, and anything unprovable is flagged. | A claim whose inventory row moved after its stock-in is not undone. |
| Category archive | Archiving a category with ACTIVE products is refused with `CATEGORY_HAS_ACTIVE_PRODUCTS`; archived products do not block. | The check is not a transaction against a product being created concurrently. |
| Audit write failure | The business write still succeeds. The gap becomes a durable `audit_failures` row with a sanitized class and an `[audit-gap]` log line, retained for 90 days by TTL. | Monitoring is best-effort; if the monitor write also fails, the log is the only record. |
| Replayable audit event | `recordAuditOnce` takes a deterministic, tenant-scoped `dedupeKey`; a unique partial index on `(businessId, dedupeKey)` lets only one concurrent delivery append. The loser reads and returns the winner's row. Product Import, keyed movement completion and PO receive use the durable `audit_outbox`; movement-receipt, transfer and PO-claim recovery use deterministic keys. | Transport-only product/reference/PO create/update/issue/cancel mutations and transfer/PO-claim recovery still call plain `recordAudit` and have no outbox. Historical receipts without the new fences are deliberately skipped. |
| Product currency edit | An ordinary `PATCH /api/products/:id` may only keep the exact recorded code. Replacing it requires `POST /api/products/:id/currency-correction`, a 3–500-character reason and `priceReconfirmed: true`; the change writes `PRODUCT_CURRENCY_CORRECTED` with both codes and the reason. | There is no automatic conversion; the operator must re-check both prices in the replacement currency. The audit write remains best-effort, like other product events. |
| AI price ranking | Ranking happens inside one recorded currency. A named ISO code scopes the comparison; otherwise mixed known currencies, or a known currency plus unrecorded prices, block a single ranking and return the currency groups instead. Ties break by name then `_id`. | Zero and missing prices are excluded from rankings. A currency is not converted. |
| Price quality | The report counts missing price, zero price, missing currency and malformed currency, and samples rows to fix. It never writes. | It checks the ISO-4217 **shape** (three uppercase letters), not the full official code list. |

### 1.1 Replayable-audit deduplication

`server/src/services/audit.service.ts` exports `recordAuditOnce`. It inserts normally and, on a
MongoDB duplicate-key result, reads `{ businessId, dedupeKey }` and returns the committed row. The
index is the arbiter, not a read-before-write check. `AuditLog` declares the key as optional and the
index as unique **partial** on `{ dedupeKey: { $type: 'string' } }`, so ordinary events with no key
and all historical rows remain append-only.

The full replayable-surface inventory, key recipes, adoption order and the outbox design are in
[`AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md`](AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md). Three
producers now converge to **exactly one** audit row after a crash, replay or concurrent delivery:

- **Product Import** writes an `audit_outbox` row before the AuditLog attempt, fences the completed
  receipt with `auditEnqueuedAt`, and a bounded repair scan re-enqueues a completed receipt that
  crashed before the hand-off (or only fences it when a pre-dedupe audit already exists).
- **Keyed movement completion** uses `movement:<receiptId>:completed`. A tracked receipt's
  completion and replay hand off through the outbox; `recoverMovementAudits` repairs a completed
  receipt whose `auditEnqueuedAt` is still null after proving its ledger row.
- **PO receive** uses `po-receive:<poId>:<receiveId>`. One `receiveId` is stamped on every receipt
  finalized by the request; replay and `recoverPoReceiveAudits` rebuild the batch from those
  receipts and enqueue the same key.

Historical receipts without `auditTracked`/`receiveId` are skipped by repair, so a pre-dedupe audit
is never appended twice. Movement-receipt, transfer and PO-claim recovery use deterministic keys,
so concurrent or repeated recovery cannot append a second event; they do not yet have an outbox
for a failed insert.

### 1.1 Outbox and repair health

`server/src/services/auditHealth.service.ts` reads a bounded snapshot after the scheduled recovery
pass. It returns counts and the oldest row age for each `audit_outbox` status, unmarked completed
Product Import, movement and PO receive receipts by producer, and the cumulative repair-pass totals
recorded by that scheduler process. It raises two alert classes:

- **`FAILED` overdue** — a `FAILED` outbox row whose `updatedAt` is older than **15 minutes**.
- **Unmarked receipt overdue** — a completed import/movement/PO receipt with no audit marker whose
  row `updatedAt` is older than **10 minutes**.

The accumulated repair totals live in process memory: they reset when the server restarts, so they
are a liveness signal, not a billing or capacity record. The snapshot is logged as one structured
`auditHealth` line plus `logger.error` alert lines; there is no public health endpoint and no pager.
A row that stops retrying entirely is therefore visible only in the serving host's log, and only
while that host is running. The DB-backed checks are `server/test/AUDIT-HEALTH.test.mjs` and the
relevant cases in `server/test/AUDIT-OUTBOX.test.mjs`.

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
retry replays the resolved outcome.

The recovery pass uses stricter proof than a replay: a ledger row must also match the receipt's
kind, product, location, previous/new quantities and movement quantity. A row that exists but
contradicts the receipt becomes `REQUIRES_ATTENTION`; it is never accepted merely because it
carries the receipt id. The `INVENTORY_WRITTEN` path similarly requires an arithmetically valid
snapshot before it writes the missing ledger row.

Receipt lifecycle:

- an unfinished receipt older than **60 seconds** is abandoned and may be recovered by the
  scheduled pass or the operator command;
- a `REQUIRES_ATTENTION` receipt is reconsidered only through the same proof; a ledger row that
  matches every movement field resolves it, and anything else leaves it visible;
- a `COMPLETED` receipt older than **30 days** is pruned by the operator command only while its
  matching ledger row still exists and still proves the movement; a missing or contradictory row
  blocks pruning instead of erasing the evidence;
- recovery writes `MOVEMENT_RECEIPT_RECOVERED` and retention writes `MOVEMENT_RECEIPT_PRUNED`
  audit events under entity type `STOCK_MOVEMENT_OPERATION`, with the receipt id and ledger id but
  never the idempotency key.

## 3. When recovery runs

`server/src/services/recoveryScheduler.ts` runs one transfer pass, one claim pass, one movement
receipt pass, the movement and PO-receive audit repair sweeps, the Product Import repair sweep and
the audit-outbox flush:

- 30 seconds after a serving process boots;
- every 5 minutes thereafter;
- never in a test process;
- never overlapping within one process;
- stopped before database shutdown.

Only transfer journals and movement receipts older than **60 seconds**, and claims older than
**10 minutes**, are candidates, so a healthy request is not stolen. Audit repair uses the same
60-second grace. A failed pass is logged and does not stop the API. The reapers are bounded to 50
rows per pass; movement and PO audit repair scan **20** rows each, Product Import repair **20**, and
the outbox flush **50**.

Before the reapers run, the pass acquires one MongoDB lease in
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

# Read-only: every status, missing or invalid product currency only.
npm run audit:product-currency
npm run audit:product-currency -- --business=<24-hex-id> --format=json

# Writes only exact recovery actions; prints counts and flags anything unresolved.
npm run recover:integrity
npm run recover:integrity -- --format=json

# Receipt maintenance: dry-run by default; --apply writes proven recovery/pruning.
npm run recover:movement-receipts
npm run recover:movement-receipts -- --with-production --format=json
npm run recover:movement-receipts -- --with-production --apply

# Read-only: REQUIRES_ATTENTION journals and quarantined ledger rows, with evidence.
npm run triage:integrity
npm run triage:integrity -- --business=<24-hex-id> --format=json

# Six required indexes: read-only first; --apply after duplicate review.
npm run migrate:required-indexes
npm run migrate:required-indexes -- --with-production --apply

# Child-process crash injection at the four producer boundaries (test database only).
npm run test:audit-crash

# Specialized transfer duplicate quarantine, then its unique index.
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
| `audit:product-currency` | every product has a valid ISO 4217 code | at least one missing/invalid code | not checked |
| `recover:integrity` | pass ran, no row failed | at least one row failed to reconcile | not checked |
| `recover:movement-receipts` | nothing to do, or an apply left no attention or failure | attention remains, a failure occurred, or a dry run found work | not checked |
| `triage:integrity` | no attention journal, movement receipt or quarantine row | at least one attention/quarantine row | not checked |
| `migrate:required-indexes` | all six required indexes ready, or created and verified | missing/wrong, duplicate-blocked, or failed | not checked |
| `migrate:transfer-ledger-index` | clean, or applied successfully | duplicates need review, or ambiguity blocked apply | not checked |
| `ops:integrity` | command clean, or another run held the lock | finding/attention | NOT CHECKED or runner error |

`recover:integrity` exits 0 when another process holds the recovery lease and the pass is
skipped; this is duplicate-run prevention, not a claim that a different pass succeeded. Its JSON
carries `skipped: "lease-held"` so a scheduler can tell the difference.

`recover:movement-receipts` is a separate, dry-run-first command for the movement receipts. It
does not take the integrity lease: it is an operator maintenance command, while the scheduled pass
holds the shared lease. Use it as follows:

```bash
cd server
npm run recover:movement-receipts -- --with-production
# review the rows, then explicitly apply:
npm run recover:movement-receipts -- --with-production --apply
```

`--older-than-minutes`, `--retention-days`, `--limit` and `--format=json` are bounded options.
The command refuses the test database, requires `MONGODB_URI`, and never touches another tenant's
receipt when `--business=<24-hex-id>` is supplied. A dry run reports `recovered`, `flagged`,
`blocked`, `pruned` and `failed` counts plus each row's evidence, and changes nothing. An apply
writes only the proven recovery/pruning actions and leaves blocked attention unchanged.

The bounded batch is selected in two parts: stale `IN_PROGRESS` / `INVENTORY_WRITTEN` rows first,
then `REQUIRES_ATTENTION` rows only for the remaining slots. An old attention backlog therefore
cannot starve a newer unfinished receipt, while attention rows still appear whenever the batch has
capacity. An apply that flags a previously unfinished row has left attention behind, so it exits
**1** just as a remaining blocked row does.

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

`audit:failures`, `audit:price-quality` and `audit:product-currency` are reports, not repairs.
`audit:product-currency` never assigns a code: verify the product's actual currency, then resolve it
through `POST /api/products/:id/currency-correction` with a reason and price reconfirmation (or the
mobile edit form), or the audited resolver flow in `PRODUCT_CURRENCY.md`. A legacy product with no
valid code must receive one through that correction path before any other edit is accepted;
ordinary `PATCH` refuses a replacement with `CURRENCY_CORRECTION_REQUIRED`. `recover:integrity` writes
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

### 7.3 Fail-closed required-index readiness and rollout

`GET /api/health/ready` checks the database connection **and** all three unique partial indexes that
guard replayable writes. Each must have the exact key order, `unique: true` and partial filter below,
or the endpoint answers `503`:

| Collection | Index | Key | Partial filter | Guards |
| --- | --- | --- | --- | --- |
| `inventory_transactions` | `uniq_transfer_operation_location` | `(businessId, transferOperationId, locationId)` | `{ transferOperationId: { $type: 'objectId' } }` | Two recoverers cannot write the same transfer leg twice. |
| `purchase_orders` | `uniq_purchase_order_request_key` | `(businessId, requestKey)` | `{ requestKey: { $type: 'string' } }` | A crash-safe DRAFT retry cannot create a second order under one key. |
| `audit_logs` | `uniq_audit_business_dedupe_key` | `(businessId, dedupeKey)` | `{ dedupeKey: { $type: 'string' } }` | Concurrent or replayed deliveries append at most one audit row. |

A missing index, a non-unique index, a reordered key, an extra field or a different partial filter
makes the process not ready. The checks run in parallel, each reading `listIndexes` with a
2.5-second bound; they never create, drop or repair an index. The response includes a short `reason`
naming the broken requirement, never a connection string. A database that is down is reported by the
existing connection branch without attempting an index read.

`npm run migrate:required-indexes` is the write path. It is **read-only by default**; without
`--apply` it reports `READY`, `MISSING`, `WRONG_SHAPE` or `FAILED` for each target and changes
nothing. The six targets include the transfer-operation/location, DRAFT request-key and audit
dedupe unique guards, the 30-day partial TTL on `audit_outbox.deliveredAt`, and the movement/PO
receive repair indexes on `(state, auditTracked, auditEnqueuedAt, updatedAt)` and
`(receipts.receiveId, receipts.auditEnqueuedAt, updatedAt)`. The outbox `(status, updatedAt)` triage
index stays declared but is not a readiness target. With `--apply`, each target is handled
independently:

1. list its indexes and accept an exact match;
2. for a unique target, run a duplicate preflight whose `$match` is the index's own partial filter
   and whose `$group` uses every key field; a target with **any** duplicate group becomes
   `BLOCKED_DUPLICATES` and no index is created for it (the TTL and repair indexes are not unique,
   so they skip this preflight);
3. call `createIndex` for that one exact specification and re-inspect it.

It never calls `syncIndexes()`, never drops an index and never deletes a document. Duplicate rows
are a human data decision; resolve them, then run the command again. A conflicting index with the
same key but the wrong options is reported as `FAILED` rather than replaced. Production apply
also requires `REQUIRED_INDEXES_CONFIRM=ENSURE-REQUIRED-INDEXES`; the test database is refused and
exit **2** means the run did not check anything.

The specialized `migrate:transfer-ledger-index` remains the command for quarantining exact
transfer-ledger duplicates. Use `migrate:required-indexes` when any of the other five required
indexes is the gap.
On 2026-11-23 the read-only rollout against `inventoryai_dev_db` reported the transfer index
`READY` and both newer indexes `MISSING`, with exit **1**; it wrote nothing.

## 8. Limitations and remaining risks

- **No multi-document transactions.** A crash can still leave an ambiguous state; the transfer
  journal, movement receipt, claim reaper and their recovery paths make it visible and usually
  repairable, not impossible.
- **The six required indexes must exist in every environment.** Application auto-index is not a
  migration: a database holding duplicate rows will reject a unique build. Run
  `migrate:required-indexes` (read-only first) and resolve any duplicate group before deploying a
  server that expects the guards. The repair indexes are adopted under their existing auto-generated
  names, while the TTL has a declared name; an option mismatch is reported as `WRONG_SHAPE`. This
  pass did not run `--apply` in any environment, and did not inspect or change production.
- **Lease expiry is time-based.** A pass that loses its lease may finish alongside a new owner. The
  unique ledger guard and quantity-anchored recovery keep that safe, and the deterministic recovery
  audit keys (`movement-receipt:*`, `transfer:*:completed`, `po-claim:*`) make the audit insert
  idempotent. The lease reduces duplicate work; it is not the correctness boundary.
- **A flagged movement receipt still needs a person unless proof appears.** Retrying it under the
  same key answers `409 MOVEMENT_REQUIRES_ATTENTION`; `recover:movement-receipts --apply` can
  resolve it only when a matching ledger row or an exact `INVENTORY_WRITTEN` snapshot proves the
  move. An unprovable row remains visible to `triage:integrity`. Completed receipts are pruned
  after 30 days; abandoned and attention rows are never auto-deleted, so a permanently
  unprovable receipt remains until an operator investigates it.
- **Some recovery audit inserts can still fail.** Keyed movement completion, PO receive and
  Product Import now have a durable outbox, but a transfer or PO-claim recovery that crashes or
  cannot insert its audit is still recorded only by `monitorAuditFailure`. Inventory is unaffected.
  Transport-only product/reference/PO mutations remain outside the outbox until they have a durable
  event or revision identity.
- **Alert retries need a later run.** A failed GitHub delivery is durable in local history, but
  nothing wakes the machine to retry it; the next scheduled or manual `--notify` run does. A failed
  history write leaves no retry record. The outbox is local to one scheduler host: two hosts keeping
  separate histories can both comment on the same issue, though the issue title still deduplicates
  the issue itself.
- **Readiness pays one bounded index read per guard.** Every `/ready` request performs six
  parallel `listIndexes` reads after the driver says the database is connected (one timeout bound,
  not six sequential waits). They are read-only, but this is not the zero-I/O local check the
  endpoint used to be.
- **The operational runner is single-host by default.** Its lock is a local file; the recovery
  lease is MongoDB-backed, but the read-only audit locks only suppress duplicate runs on one
  machine. The shipped Windows task wrapper has not been registered in this tranche.
- **Legacy rows lack fingerprints.** Old receipts and transfer journals fall back to key-only
  replay; only rows written after this change carry a fingerprint.
- **Conservative currency block.** The group check ignores `inStockOnly`, so an out-of-stock
  product in another currency can block a ranking even when the in-stock set is single-currency.
  This is deliberately safe; it can be narrowed later. An explicit ISO code in the question scopes
  the comparison and avoids the block when that is the operator's intent.
- **Currency detection is keyword-based.** The assistant recognizes common ISO codes in the
  question and the ₱ sign. It does not convert or infer a currency from a price.
- **Category archive race.** A product created concurrently with the archive check can still
  reference the newly archived category. The next write rejects it.
- **No production verification.** This work was tested against the test database only; no
  production data, deployment, commit or production command was run.

## 9. Verification

`server/test/INTEGRITY-RECOVERY.test.mjs` covers the transfer, claim, receive-key, category, audit-gap
and price-quality DB-backed cases, including the cases below:

- transfer source-only undo, both-leg completion, inexact undo refusal, reused-key fingerprint
  rejection, `REQUIRES_ATTENTION` blocking, both marked and unmarked bad-ledger refusal, a
  `COMPLETED` journal staying terminal without a response, and concurrent recovery appending one
  audit;
- claim stock-in undo, untouched release, moved-row flag, and concurrent recovery of one claim
  appending one audit;
- HTTP-required receive key and changed-request rejection;
- category archive refusal and allowance;
- audit-gap sanitization and tenant scoping;
- price-quality problems and write-free reporting;
- AI price tie order and mixed-currency blocking.

`server/test/currency-required-and-marketplace.test.mjs` additionally covers the ordinary-PATCH
currency refusal, the dedicated correction (including cross-tenant refusal and the audit event),
and the service-level price-comparison guard. Its FX cases cover one provider request for three
simultaneous lookups, a short negative cache that never serves a guessed rate, exponential backoff
and immediate recovery after a successful quote. `server/test/AI45-natural-product-search.test.mjs`
covers mixed/unrecorded currency blocking and an explicit-code-scoped filter and ranking.

`server/test/AUDIT-OUTBOX.test.mjs` covers **9** DB-backed cases: Product Import enqueue/delivery,
stale `SENDING` reclaim, `FAILED` retry, concurrent delivery with one audit row, keyed movement
completion/replay/concurrent recovery, PO receive/replay/concurrent recovery, and the DELIVERED
30-day partial TTL plus the FAILED triage index. The full scheduler, movement-recovery, CLI and
transfer-guard regression set passed **44/44** after the new passes were added.

`server/test/MOVEMENT-RECEIPT-RECOVERY.test.mjs` covers 10 DB-backed cases: a dry run that writes
nothing followed by a ledger-proven apply with an audit row; exact `INVENTORY_WRITTEN` snapshot
recovery; a completed receipt resisting late completion and late inventory-written writes; concurrent
recovery completing once and auditing once; a full batch of old attention rows not starving a newer
unfinished receipt; an unprovable receipt flagged without deletion; attention resolved only by a
matching ledger row while an ambiguous row stays blocked; a contradictory ledger row never resolving
attention; completed-receipt retention with the dry run keeping the row; and a completed receipt
whose ledger proof is missing being kept, not pruned.

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
`server/test/transfer-ledger-index-readiness.test.mjs` (missing and correctly installed TTL/repair
indexes, plus the six-check aggregation); rollout control flow is
`server/test/required-index-rollout.test.mjs`, and the read-only report is
`server/test/triage-integrity.test.mjs`. The combined index/readiness/rollout set passed **42/42 in
8 suites** on 2026-11-23 after this increment. `npm run migrate:required-indexes -- --help`
exited **0**, and the read-only development run named `inventoryai_dev_db` and exited **1** for the
two missing indexes without writing. The related existing suites are Phase 19 transfers, Phase
13 receiving, Phase 04 catalog and inventory idempotency. The complete DB-backed suite is `npm run test:db`; on a constrained Windows host use
`npm run test:db -- --test-concurrency=4` to avoid exhausting the child-process budget.

The replayable-audit dedupe is covered in `server/test/FW01-product-import.test.mjs`: 12 concurrent
same-key `recordAuditOnce` calls leave one row and one id, a second business gets its own row, and two
ordinary keyless `recordAudit` calls remain two rows. The same suite covers terminal import receipts:
late failure transitions, late reservation/stock-progress writes and a failure/completion race all
leave `COMPLETED` intact. On 2026-11-23 `TEST_MODE=db node --test
test/FW01-product-import.test.mjs` passed **17 / 0 fail / 1 parser mode-skip**. The index guard and
backup/restore guard passed **24/24**: `TEST_MODE=db node --test
test/phase-index-integrity.test.mjs test/OPS1-backup-restore.test.mjs`.

`server/test/AUDIT-OUTBOX.test.mjs` covers Product Import's durable hand-off plus movement and PO
receive repair in **10 / 10** DB-backed cases: repair a completed receipt with no outbox row, fence
a pre-dedupe completed import whose legacy audit exists without appending a second one, re-run after
a lost receipt marker without a second audit, deliver an enqueued row after a crash before the
AuditLog insert, reclaim a stale `SENDING` claim after the insert committed, retry a `FAILED` row,
eight concurrent deliveries leaving one audit row and one outbox row, the movement and PO receive
outbox/repair paths, and the declared DELIVERED TTL / FAILED triage indexes. A partial three-line PO
receive that applies two lines is replayed and then recovered eight times concurrently; both
receipts keep one `receiveId` and the tenant keeps exactly one audit containing exactly the two
applied lines. The bounded health snapshot has its own DB-backed suite,
`server/test/AUDIT-HEALTH.test.mjs` (**2 / 2**).

The child-process harness `server/scripts/audit-crash-harness.mjs` kills one process at each of the
four producer boundaries (`import-commit`, `movement-enqueued`, `po-receipt`, `audit-in-flight`)
with exit **86**, then runs the real recovery/delivery path in the parent. It refuses any database
other than `inventoryai_test_db`. `TEST_MODE=db node --test
test/AUDIT-CRASH-HARNESS.test.mjs` passed **1 / 1** with exactly one audit and one `DELIVERED`
outbox row per case. The standalone `npm run test:audit-crash` printed `4/4 boundaries passed`,
with `child exit=86 audits=1` for each case, and exited **0**. The remaining replayable surfaces are
inventoried in
[`AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md`](AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md).
