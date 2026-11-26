# Audit deduplication for replayable writes

**Date:** 2026-11-23
**Status:** Shared dedupe writer implemented. FW-01 product import, movement-receipt recovery,
transfer recovery (and the synchronous transfer audit) and PO-claim recovery are wired. Product
Import, keyed movement completion and PO receive now use the durable audit outbox with crash
repair. `DELIVERED` outbox rows expire after 30 days; `FAILED` rows are retained and retried. The
six readiness indexes (including the TTL and repair indexes), the bounded health snapshot and the
four-boundary child-process crash harness are implemented (§27LI). The remaining
product/reference/PO transport-only mutations are designed but not yet wired.
**Related:** §27KZ and §27LI in [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md), the restore drill in
[`PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md`](PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md), and the
recovery guarantees in [`INTEGRITY_RECOVERY.md`](INTEGRITY_RECOVERY.md).

## 1. The two failure windows

A replayable operation has two different audit problems, and fixing one does not fix the other.

1. **A duplicate audit row.** The business write commits, the audit row commits, but the response or
   the operation's terminal marker is lost. A retry/recovery pass repeats the event. The business
   state is still correct, but the trail now says the same thing twice.
2. **A missing audit row.** The business write and its terminal marker commit, but the audit insert
   fails or the process dies before it. The operation now replays from the terminal marker and never
   returns to the audit step. The trail silently lacks the event.

The shared dedupe key below closes the first window. Product Import, keyed movement completion and
PO receive also close the second with a durable outbox plus a receipt-marker repair sweep; the other
recovery jobs use deterministic keys but still rely on the existing audit-gap monitor instead of an
outbox.

## 2. Inventory of replayable surfaces

“Replayable” means the same logical operation can execute again after a lost response, a recovery
pass, or a duplicate delivery. The audit guarantee is only as strong as the durable gate in the
second column.

| Surface | Durable replay gate today | Duplicate-audit exposure | Candidate key |
| --- | --- | --- | --- |
| FW-01 product import | `ProductImport` unique `(businessId, key)`; `COMPLETED` is a conditional single-winner transition; one finalizer enqueues `PRODUCTS_IMPORTED`. | **Closed both ways.** Late failure/progress transitions cannot reopen the receipt; the audit is enqueued before insertion, and a repair sweep finds completed receipts with no `auditEnqueuedAt`. | `product-import:<receiptId>:completed` — **wired + outbox** |
| Keyed stock in/out/adjustment | `StockMovementOperation` receipt; unique ledger partial index on `(businessId, movementOperationId)`; retry replays the stored response. | **Closed both ways for new receipts.** Completion hands the `INVENTORY_*` event to the outbox; retry and repair use the same key. Historical receipts without `auditTracked` are skipped rather than replayed. | `movement:<receiptId>:completed` — **wired + outbox** |
| Stock transfer | `StockTransferOperation` journal; unique transfer ledger index per operation/location; guarded snapshots. | The synchronous and recovery audit can both run for one journal. | `transfer:<operationId>:completed` — **wired** |
| PO receive | Claim plus receive receipt with request fingerprint; replay returns the stored outcome. | **Closed both ways for new receipts.** Every finalized line carries the request's `receiveId`; the batch audit is enqueued under that id, and a replay/repair reuses it. Historical keyed receipts without `receiveId` are skipped. | `po-receive:<poId>:<receiveId>` — **wired + outbox** |
| PO-claim recovery | Stale claims are reconciled from the stock-in; each claim can have only one recovery outcome. | Two recovery passes that read the same claim can both audit the same release/undo. | `po-claim:<poId>:<claimId>:recovered` — **wired** |
| PO create/update/issue/cancel | HTTP `Idempotency-Key` record only; no service-level receipt. | A lost response usually leaves an in-progress record rather than re-running the service, but a replay outside that middleware can append a second audit row. | `purchase-order:<poId>:<action>:<revision-or-eventId>` |
| Product create/update/currency correction | HTTP idempotency only. | Same as purchase orders; the business row and its audit are separate writes. | `product:<productId>:<event>:<revision>` |
| Reference create/update | HTTP idempotency only. | Same as products. | `reference:<entityType>:<entityId>:<event>:<revision>` |
| Account, session, invitation and password-reset events | One-time tokens, session ids, or explicit lifecycle transitions. | Low replay exposure; a duplicated event would still be misleading. | `session:<sessionId>:<event>`, `invitation:<id>:<event>` where the event is genuinely once-only |
| Movement/transfer/PO-claim recovery jobs | The same journal/receipt gates as their operation. | **Highest exposure:** these are designed to run repeatedly. All three now use deterministic keys. | The operation/recovery keys above |

### Complete `recordAudit` callsite coverage

The grouped matrix above is the design view. The source scan that produced it covered every current
`recordAudit` caller: `accountDeletion`, `firebaseAuth`, `firebaseLink`, `invitations`,
`passwordReset`, `passwordResetCode/confirm`, `product`, `productCurrencyResolution`,
`productImport`, `purchase-orders`, `purchaseOrderClaimRecovery`, `session`, `reference`,
`stockMovementReceiptRecovery`, `stockTransferRecovery`, `users` and `inventory`. Their exposure is:

| Caller group | Replay exposure | Current state |
| --- | --- | --- |
| `productImport` | Completion finalizer and lost-response retry | **Keyed and terminal** |
| `inventory`, `stockTransferRecovery` | Movement/transfer recovery can repeat an audit after a crash | High; **wired** (`movement:*:completed`, `movement-receipt:*`, `transfer:*:completed`) |
| `purchase-orders`, `purchaseOrderClaimRecovery` | Receive/recovery can repeat an audit; transport-only mutations can re-run outside the middleware | **Receive wired + outbox**; **PO-claim recovery wired**; create/update/issue/cancel still transport-only |
| `stockMovementReceiptRecovery` | Recovered/pruned event can repeat between audit and receipt delete | High; **wired** |
| `product`, `reference` | HTTP idempotency only; a committed row whose response was lost can be re-driven | Medium; needs a revision/event id |
| `productCurrencyResolution` | Background resolution can retry after its audit | Medium; needs the product revision or resolution id |
| `session`, `users`, `invitations`, `firebaseAuth`, `firebaseLink`, `accountDeletion`, `passwordReset`, `passwordResetCode/confirm` | Mostly one-time tokens or lifecycle transitions; a retried route can still duplicate a session/identity/invitation event | Low; key only where the event is genuinely once-only |

`recordPlatformAudit` writes a different, append-only platform collection. It is outside this
tenant-audit index and remains unprotected against a replayed administrative request; platform
step-up/recovery actions need their own review before a key is chosen. `monitorAuditFailure` writes
`audit_failures`, not an audit event, and is intentionally not deduped here.

### What is already protected

- Product import completion uses `product-import:<receiptId>:completed`, the durable outbox and the
  `auditEnqueuedAt` repair fence.
- Keyed movement completion uses `movement:<receiptId>:completed`, the outbox and the
  `auditEnqueuedAt`/`auditTracked` fence. A replay of a completed receipt repairs the same event.
- PO receive uses `po-receive:<poId>:<receiveId>`, the outbox and the receipt-level
  `auditEnqueuedAt` fence. Every line finalized by one request shares its `receiveId`.
- Movement-receipt recovery uses `movement-receipt:<receiptId>:recovered` and `:pruned`.
- Transfer recovery and the synchronous transfer path share `transfer:<operationId>:completed`.
- PO-claim recovery uses `po-claim:<poId>:<claimId>:recovered` for all three outcomes.
- `DELIVERED` outbox rows have a 30-day TTL on `deliveredAt`; `FAILED` rows have no `deliveredAt`
  and are therefore outside that TTL.
- The audit key is tenant-scoped. Two businesses can use the same opaque value without colliding.
- `recordAudit` remains append-only for ordinary events and for historical callers with no key.

### What is not protected

- Transport-only product/reference/PO create/update/issue/cancel mutations still call plain
  `recordAudit` and remain inventoried rather than wired. They need a durable revision/event id before
  a safe key exists.
- PO receive still writes the `INVENTORY_STOCK_IN` audit for its stock-in through the normal unkeyed
  movement path. Only the aggregate `PURCHASE_ORDER_RECEIVED` event is outboxed.
- Historical receipts (no `auditTracked`/`receiveId`) are deliberately skipped by repair scans, so a
  pre-change missing audit is not reconstructed automatically.

## 3. Shared design

### 3.1 `recordAuditOnce`

`server/src/services/audit.service.ts` exports:

```ts
recordAuditOnce({ businessId, userId, action, entityType, entityId, metadata, dedupeKey })
```

It attempts the normal insert. If MongoDB returns duplicate-key `11000`, it reads
`{ businessId, dedupeKey }` and returns the winner's row. If no such row exists, it rethrows the
original error rather than hiding a constraint it does not understand.

The database, not a read-then-write check, is the arbiter. That is what makes concurrent deliveries
safe: both may attempt the insert, but only one can commit.

### 3.2 Schema and index

`AuditLog` now carries an optional `dedupeKey` (trimmed, maximum 200 characters) and declares:

```ts
auditLogSchema.index(
  { businessId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
```

The partial filter is load-bearing. Older rows and ordinary events have no `dedupeKey`; without it,
the unique index would treat every missing field as a duplicate `null` and refuse the second ordinary
audit event in a business.

The index must exist in every environment. It is one of the three guards `/api/health/ready`
requires; a missing, non-unique, reordered or differently-filtered index makes the process unready.
`npm run migrate:required-indexes` is the read-only-by-default rollout: it refuses duplicate
`(businessId, dedupeKey)` groups before creating anything, uses targeted `createIndex`, and never
drops an index or deletes a document. Mongoose's normal automatic index build is not a deployment
guarantee. `server/test/phase-index-integrity.test.mjs` proves the declared key and partial filter
reached the database after `Model.init()`.

### 3.3 Key rules

- Derive the key from a durable id and a once-only event, never from a random request id or a
  timestamp.
- Include the business only if the key is not already scoped by the indexed `businessId`; the index
  scopes it, so the stored key can stay short.
- Do not reuse one key for two legitimate events. A product edited twice needs two revisions or two
  distinct event ids; a recovery that can legitimately happen twice needs a distinct event name.
- Keep the key under 200 characters. Do not put row contents, an email address, a token or an error
  message in it.
- A deduped event returns the first row unchanged. It does not update metadata from the later
  delivery; the first committed event is the evidence.

## 4. Adoption order

1. **FW-01 product import — done.** It has the strongest existing durable gate and the clearest
   finalizer.
2. **Recovery jobs — done 2026-11-23.** Movement receipt recovery, transfer recovery and PO-claim
   recovery use keys at their existing terminal guards, with concurrent regression tests.
3. **Keyed movements and PO receive — done 2026-11-23.** Both now enqueue beside their durable
   receipt/terminal write; the synchronous transfer audit is also keyed.
4. **Transport-only product/reference/PO mutations.** These need a service-level revision or event id
   before a safe key exists. Do not key them from the HTTP request body alone: two legitimate edits
   could share a body.

## 5. Missing-audit outbox (three producers)

Deduplication cannot repair a crash between the business commit and the audit insert. Product
Import, keyed movement completion and PO receive now write a durable `audit_outbox` row before the
AuditLog attempt and mark the durable receipt once that row exists.

### 5.1 Lifecycle

Model: `server/src/models/auditOutbox.model.ts`, collection `audit_outbox`.

| State | Meaning |
| --- | --- |
| `PENDING` | Enqueued and due for a delivery attempt. |
| `SENDING` | Claimed by one worker. A claim older than 60 seconds is reclaimable, so a crash cannot strand the row. |
| `DELIVERED` | The AuditLog row exists (or existed already under the same key). |
| `FAILED` | The last attempt failed. It remains eligible for retry after bounded backoff; this is a visible retry state, not a terminal gap. |

The unique `(businessId, dedupeKey)` index makes enqueue idempotent. `enqueueAndDeliverAudit` first
creates or finds that row, then claims one worker with an atomic `PENDING/FAILED -> SENDING` update.
`recordAuditOnce` inserts or returns the existing audit row. The worker then stores `DELIVERED`. Only
the error class is retained in `lastError`; no message, URI, token or row content is stored.

`flushAuditOutbox` selects due `PENDING`/`FAILED` rows and stale `SENDING` claims, bounded by `limit`,
and delivers each through the same claim. `runIntegrityRecoveryPass` runs the movement and PO audit
repair sweeps, the Product Import repair sweep and a 50-row flush. Two hosts therefore cannot deliver
one row at the same time, and a crash at any point leaves a reclaimable row.

### 5.2 Retention and abandoned `FAILED` rows

`DELIVERED` rows have a partial TTL index on `deliveredAt` with a fixed **30-day** retention. The
AuditLog row is the durable governance record; the outbox row is its delivery receipt and is no
longer needed after that window. A `FAILED` row has no `deliveredAt`, so it is outside the TTL by
construction.

`FAILED` is not terminal. The flusher retries it with capped exponential backoff (maximum five
minutes). An “abandoned” `FAILED` row is one whose age or attempt count has exceeded its operator
threshold; it is **retained**, not deleted, because the row is the only durable evidence that an
audit is missing. Triage is explicit:

1. Read `{status: 'FAILED'}` ordered by `updatedAt` using the triage index; inspect only `lastError`,
   which is an error class, never the upstream message.
2. Fix the dependency (database, permissions, malformed payload) and let the normal flusher retry.
3. If the event can never be delivered, record an explicit operator resolution; do not delete the
   row as a cleanup shortcut and do not append a hand-written AuditLog row under the same key.
4. Escalate a repeated failure to the follow-up backlog rather than widening the TTL: extending
   retention cannot turn a missing audit into a delivered one.

### 5.3 Product Import crash windows

1. The receipt becomes `COMPLETED`.
2. `enqueueAndDeliverProductImportAudit` creates the outbox row, then sets
   `ProductImport.auditEnqueuedAt`.
3. It attempts delivery. A failure leaves `PENDING`/`FAILED` work for the flusher.

`recoverProductImportAudits` scans completed receipts whose `auditEnqueuedAt` is still null and are
older than the bounded grace window; it fences one whose pre-dedupe audit already exists. This closes
a crash between step 1 and step 2. Re-enqueueing is safe because the outbox key and the AuditLog key
are identical. A crash after the AuditLog insert but before `DELIVERED` is also safe: the audit key
returns the existing row and the outbox is then marked delivered.

The normal import response never becomes a 500 because of audit delivery. A failed enqueue is written
to `audit_failures` and logged; the repair sweep retries it later.

### 5.4 Keyed movement completion

`StockMovementOperation` gains `auditTracked` and `auditEnqueuedAt`. New receipts are created with
`auditTracked: true`; historical receipts without it keep the old plain `recordAudit` path and are
never replayed by the repair scan. For a tracked receipt, `recordMovement` skips its direct audit and
`completeMovementReceipt` (or a replay of an already-completed receipt) calls
`enqueueAndDeliverMovementAudit` with `movement:<receiptId>:completed`.

1. The ledger row and `COMPLETED` receipt are durable.
2. The outbox row is created, then `auditEnqueuedAt` is set.
3. Delivery is attempted. A crash before step 2 is repaired by `recoverMovementAudits`, which finds
   a tracked `COMPLETED` receipt with no marker, proves the ledger row by
   `inventoryTransactionId`/`movementOperationId`, and re-enqueues the same key.

A retry of the same idempotency key replays the stored response and also attempts the hand-off, so a
lost acknowledgement can repair the audit without a second movement.

### 5.5 PO receive

Each new receive operation gets a `receiveId` for the whole batch. Every finalized receipt line stores
it; `po-receive:<poId>:<receiveId>` is the audit key. The normal batch finalizer and the partial-batch
`throwPartial` path both call `enqueueAndDeliverPoReceiveAudit`, which writes the outbox row and then
marks every receipt with that `receiveId`.

1. One or more receipt lines are durable on the PO; the PO may still be `OPEN`.
2. The batch outbox row exists, then each receipt's `auditEnqueuedAt` is set.
3. Delivery is attempted. A crash before step 2 is repaired by `recoverPoReceiveAudits`, which groups
   unmarked receipts by `receiveId` and rebuilds one event from their line snapshots.

A replay with the same receive key finds the stored receipts and re-attempts their hand-off before
returning the replay. Historical keyed receipts without `receiveId` are skipped, so a pre-dedupe
receive audit is never duplicated. A partial batch is one event; the recovery metadata may use the
current PO status rather than the status at the original crash, because the PO document is the
authoritative state and the event's receipt lines are unchanged.

The guarantee for all three producers is **exactly one** audit row after recovery converges, and at
most one during any in-flight window. The other recovery jobs use deterministic keys but do not yet
enqueue an outbox row; a failed insert there is still recorded by `monitorAuditFailure`.

### 5.6 Retention, readiness and health

The model exports three index specifications beside the unique dedupe index: a 30-day partial TTL on
`deliveredAt` where `status = DELIVERED`, and a repair triage index on `(status, updatedAt)`.
Movement and PO receipts export their own repair indexes, on
`(state, auditTracked, auditEnqueuedAt, updatedAt)` and
`(receipts.receiveId, receipts.auditEnqueuedAt, updatedAt)`. The readiness gate and
`migrate:required-indexes` check all six required indexes: the three unique guards, the TTL and both
producer repair indexes. The status triage index remains declared but is not a readiness target.
Non-unique specifications skip duplicate preflight in the rollout. The scheduled
recovery pass records cumulative repair totals and logs a bounded `auditHealth` snapshot: counts and
oldest age by outbox status, unmarked completed receipts by producer, `FAILED` rows older than 15
minutes and unmarked receipts older than 10 minutes. The child-process harness
(`server/scripts/audit-crash-harness.mjs`) covers `import-commit`, `movement-enqueued`, `po-receipt`
and `audit-in-flight`, exiting **86** before normal hand-off; the parent then runs real repair and
delivery against `inventoryai_test_db` and asserts one audit and one `DELIVERED` row per case.

## 6. Verification

| Check | Result |
| --- | --- |
| `cd server && npm run typecheck` | pass |
| Focused ESLint on audit/import/model/test files | pass, 0 errors / 0 warnings |
| `TEST_MODE=db node --test test/AUDIT-OUTBOX.test.mjs` | **9 pass, 0 fail**: six Product Import cases, keyed movement completion/replay/concurrent delivery/recovery, PO receive/replay/concurrent recovery, and the DELIVERED TTL/FAILED triage index |
| `TEST_MODE=db node --test test/DEMO2-tenant-ai-teardown.test.mjs test/FW01-product-import.test.mjs` | **25 pass, 0 fail, 1 parser mode-skip**; DEMO-2 **8/8** with `product_imports: 17`, FW-01 **17 pass / 1 skip** |
| `TEST_MODE=db node --test test/phase13-receiving.test.mjs test/phase-index-integrity.test.mjs` | **31/31 pass**: receiving **17/17**, index integrity **14/14** including the declared/database TTL comparison |
| `TEST_MODE=db node --test test/INTEGRITY-RECOVERY.test.mjs test/MOVEMENT-RECEIPT-RECOVERY.test.mjs test/MOVEMENT-RECEIPT-CLI.test.mjs test/TLI-transfer-ledger-guard.test.mjs` | **44/44 pass, 10 suites, 0 fail/skip/todo**: scheduler, movement-recovery, CLI and transfer-guard regressions after the new repair passes |
| Concurrent audit test | Same-key `recordAuditOnce` calls and repeated outbox delivery produce **one** audit row; the same key in a second business produces its own row |
| Terminal receipt tests | late `PARTIAL`/`FAILED`/`IN_PROGRESS` transitions return `null`; late reservation/stock-progress writes cannot change a completed receipt's arrays; concurrent failure/completion ends `COMPLETED` |

## 7. Remaining risks

- The new repair sweeps are bounded (20 rows per scheduled pass) and run only in the serving
  process's recovery pass. A host that never starts a scheduler or runs recovery leaves the row for
  the next manual/automated pass; the outbox row itself is already durable once enqueued.
- `DELIVERED` TTL and the new repair indexes are created by automatic index building. A deployment
  that disables `autoIndex` must apply them explicitly; the local index-integrity suite catches the
  miss locally, but production deployment is not automatically a migration.
- Transport-only product/reference/PO create/update/issue/cancel mutations still use plain
  `recordAudit`; they need a durable revision/event id before an outbox key is safe.
- Historical movement and PO receipts without `auditTracked`/`receiveId` are deliberately skipped by
  repair. A pre-change missing audit remains a reconciliation task, not an automatic repair.
- The movement repair sweep depends on the ledger row (`inventoryTransactionId` or
  `movementOperationId`). A missing or contradictory ledger row is reported and left for a human;
  the receipt is never deleted to make the scan pass.
- The PO recovery event is reconstructed from receipt lines. It proves the applied lines and the
  action, but the `partial`/`status` metadata can reflect the current PO rather than the instant of
  the crash; the receipt and ledger remain the authoritative evidence.
- Keys are only as good as their derivation. A key that changes between two deliveries of the same
  logical event gives no protection, and a key reused for two real events loses one.
- The complete server suite was not rerun in this increment; only the focused suites above were.
