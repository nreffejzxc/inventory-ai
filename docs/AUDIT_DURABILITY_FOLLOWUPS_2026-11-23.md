# Audit durability and retention — ranked follow-ups

**Date:** 2026-11-23
**Status:** Implementation record for ranks 1–3, planning for the rest. The six required indexes now
include the `audit_outbox` TTL and both repair indexes in the readiness gate and
`migrate:required-indexes` (§27LI); the bounded health snapshot and child-process crash harness also
shipped in §27LI. Ranks 4–11 remain unimplemented.
**Context:** The durable audit outbox now covers Product Import, keyed stock movement completion and
PO receive. `DELIVERED` rows have a 30-day TTL; abandoned `FAILED` rows are retained and retried.
The implementation and verification are recorded in §27LF of
[`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) and the design is in
[`AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md`](AUDIT_DEDUPLICATION_DESIGN_2026-11-23.md).

This list ranks the next improvements by the size of the correctness, operational or governance gap
they close, not by how interesting they are to build. Effort is a rough local estimate.

**Local result (2026-11-23).** Ranks 1–3 were implemented and tested only on this machine: six-index
readiness and rollout checks (42/42 across the focused index/readiness/rollout suites), a health
snapshot with a 15-minute `FAILED` and 10-minute unmarked-receipt threshold (2/2), and a
four-boundary child-process harness proving one audit and one `DELIVERED` outbox row per case (1/1).
No index was applied, no deployment was made and no production database was inspected.

## Ranking summary

| Rank | Improvement | Impact | Effort | Why it is ranked here |
| --- | --- | --- | --- | --- |
| 1 | Production index/TTL rollout gate — **done locally (§27LI)** | High | S–M | The new retention and repair scans only work if the indexes exist in the deployed database. |
| 2 | Outbox and repair-lag alerting — **done locally (§27LI)** | High | S–M | A `FAILED` row is currently visible only to someone reading logs or the collection. |
| 3 | Real crash-injection proof at every producer boundary — **done locally (§27LI)** | High | M | The tests simulate the crash window; process death is the behaviour that actually matters. |
| 4 | Schema-derived tenant-teardown coverage guard | High | S | `product_imports` was found missing; the next new `businessId` collection will repeat it. |
| 5 | Automated `FAILED` triage and escalation | High | M | Indefinite retry is safe for evidence, but without an owner a permanently broken row is invisible. |
| 6 | Outbox the remaining durable finalizers | High | L | PO create/update/issue/cancel, product/reference edits and claim recovery still have missing-audit windows. |
| 7 | Audit chain or tamper-evident sealing | Medium–High | L | Presence is now stronger; integrity of the stored trail against edits/deletes is not. |
| 8 | Unified retention policy for receipts and diagnostics | Medium–High | M | TTLs are currently per-collection and easy to miss; restore size and privacy depend on them. |
| 9 | Versioned outbox event contract | Medium | S–M | The outbox stores free-form metadata; a later shape change can make old rows ambiguous. |
| 10 | Multi-process and clock-skew delivery test | Medium | M | Claims, stale-`SENDING` reclaim and TTL all assume a shared clock and one winner. |
| 11 | Historical audit-gap reconciliation | Medium | M | Legacy receipts are deliberately skipped by the repair fences, so old gaps remain unknown. |
| 12 | Audit metadata/PII contract tests | Medium | S | New producers copy metadata; a future field could put sensitive data in the trail. |
| 13 | Outbox-aware backup and restore drill | Medium | M | A restored outbox must either deliver or be explicitly retired; TTL state must survive. |
| 14 | Flusher throughput/backpressure limits | Medium | S–M | A large `FAILED` backlog can consume every bounded pass and delay new events. |
| 15 | Operator CLI/console for outbox triage | Medium | M | Recovery currently requires database knowledge; a safe retry/inspect path would reduce mistakes. |
| 16 | Cold archival before retention deletion | Low–Medium | M | Compliance may need the delivery receipt after the 30-day TTL; an archive sink is not designed. |
| 17 | Mobile/offline audit intent | Low–Medium | L | Offline retries can lose the local intent to audit even when the server write is durable. |
| 18 | Key lifecycle and reuse tests | Low–Medium | S | Receipt keys are unique per durable scope, but key reuse after the middleware TTL is only partially covered. |

## The top eight, in detail

### 1. Production index/TTL rollout gate

**What:** Add the new `audit_outbox` TTL index, the movement audit-repair index and the PO receipt
repair scan to the deployment/index rollout procedure. Extend readiness or a startup diagnostic to
report a missing retention index (not only the three unique write guards).

**Why it matters:** The local suite asserts that Mongoose's `init()` built the indexes. That is not a
deployment migration. If production has automatic index building disabled, or the index build is
still running, `DELIVERED` rows never expire and the repair scans fall back to collection scans. A
missing TTL is silent in exactly the way the index-integrity suite exists to catch locally.

**Risk if skipped:** Unbounded outbox growth, slower recovery, and a false belief that retention is
active because the model declares it.

**Effort:** S–M. Reuse the existing index-readiness pattern; do not make writes depend on the TTL.

### 2. Outbox and repair-lag alerting

**What:** Export or log counts by status and age: `PENDING`, `SENDING`, `DELIVERED`, `FAILED`, oldest
`FAILED`, oldest unmarked completed receipt, and the repair pass's `scanned/enqueued/delivered/failed`
totals. Alert when a `FAILED` row exceeds an age or attempt threshold, or when a repair pass keeps
finding the same receipt.

**Why it matters:** The outbox guarantees durability only if somebody notices when delivery never
converges. Today a failed audit leaves a console line and an `audit_failures` row; there is no
paging owner, no age query, and no distinction between a transient dependency outage and a payload
that will never be accepted. The new `{status, updatedAt}` index makes the age query cheap but does
not schedule the alert.

**Risk if skipped:** A missing audit can survive indefinitely while the UI and normal tests remain
green.

**Effort:** S–M. The index and status fields already exist; the work is the metric/alert contract and
a named owner.

### 3. Real crash-injection proof at every producer boundary

**What:** Add a test seam or harness that kills a child process at four points: after the business
commit and before `enqueueAuditOnce`; after enqueue and before `auditEnqueuedAt`; after audit insert
and before `DELIVERED`; and during a concurrent second delivery. Run it for Product Import, keyed
movement completion and PO receive.

**Why it matters:** The current tests simulate the missing hand-off by deleting the audit/outbox rows
and unsetting the marker. That proves the recovery function can reconstruct the event, but not that
the normal path wrote the marker in the right order or that a reconnect after process death sees the
same state. A process-kill test is the only direct evidence for the crash window the outbox exists
for.

**Risk if skipped:** A future refactor can move the marker before the outbox write, or complete the
receipt before the hand-off, and the suite may still pass.

**Effort:** M. Reuse the existing child-process and database-reset patterns; do not add a second
durability mechanism.

### 4. Schema-derived tenant-teardown coverage guard

**What:** Build a test that enumerates every model with a `businessId` field (and the account-scoped
collections reached through users) and compares it with `TENANT_TEARDOWN_PLAN` or an explicit
platform-only allowlist. Make a newly added tenant collection fail the suite until it is classified.

**Why it matters:** `product_imports` was a real gap found by inspection, not by the suite. The
current DEMO-2 fixture only catches collections someone remembered to seed. A new model can be added
with `businessId` and every current test stays green while a tenant deletion leaves rows behind.

**Risk if skipped:** Another silent teardown leak, especially likely as outbox/receipt collections
multiply.

**Effort:** S. The plan and model barrel already exist; the main decision is the platform-only
allowlist for genuinely non-tenant rows.

### 5. Automated `FAILED` triage and escalation

**What:** Define an operator runbook and a bounded triage query for rows whose `FAILED` age or
attempts exceed a threshold: inspect only `lastError` (a class, not an upstream message), fix the
dependency, let the normal flusher retry, and only then consider an explicit audited resolution.
Never delete a `FAILED` row as a cleanup shortcut.

**Why it matters:** `FAILED` is deliberately outside the TTL, which is correct, but “retained
forever” is not a policy by itself. Without escalation, a permanently failing event is both a
missing audit and a row that consumes the bounded flusher budget forever. The policy should state
who owns it, how long it may remain, and what evidence an operator records.

**Risk if skipped:** An audit gap becomes permanent operational noise; someone may “fix” it by
deleting the row, which destroys the only durable evidence of the gap.

**Effort:** M. The age index and status model exist; the work is ownership, thresholds and a safe
operator surface.

### 6. Outbox the remaining durable finalizers

**What:** Bring PO create/update/issue/cancel, product/reference mutations and the remaining
recovery paths onto the same outbox once each has a durable revision or event id. Do not key a
transport-only mutation from its request body: two legitimate edits can share a body.

**Why it matters:** The design inventory already names these surfaces. They can still commit a
business change and lose the audit insert, and dedupe keys alone cannot repair a missing row. This
is the largest remaining coverage gap after the three producers added here.

**Risk if skipped:** The next incident is likely on a PO state change or a product edit, not on the
paths that now have a recovery fence.

**Effort:** L. Each surface needs a durable event identity before the outbox key is safe.

### 7. Audit chain or tamper-evident sealing

**What:** Add a hash chain over audit rows (or periodic signed batches) so deletion or alteration of
an existing row is detectable, with an operator verification command.

**Why it matters:** Deduplication answers “was this event appended twice?” The outbox answers “was it
appended at all?” Neither answers “was the stored history changed afterwards?” The trail is used for
governance, so integrity against a direct database edit is a different guarantee.

**Risk if skipped:** A privileged operator or a compromised process can rewrite history without
detection; no current test covers this.

**Effort:** L. Decide the threat model and key custody before choosing a chain design.

### 8. Unified retention policy for receipts and diagnostics

**What:** Put every receipt and diagnostic collection on one documented retention table: Product
Import receipts, movement receipts, PO receipts/claims, `audit_outbox`, `audit_failures`, ops events
and metrics. State the owner, the deletion mechanism, the legal/operational reason and the restore
implication.

**Why it matters:** The new 30-day outbox TTL is bounded but local. Other collections already have
ad hoc windows (movement receipts 30 days, audit failures 90 days, ops rows 90 days), and some
receipts have no TTL at all. A restore or privacy request needs one answer, not an archaeology
exercise.

**Risk if skipped:** Unbounded growth, inconsistent deletion, and a restore that brings back rows a
policy says should already be gone.

**Effort:** M. Mostly policy plus small schema/test changes; coordinate with backup/restore.

## Additional ideas worth keeping

### 9. Versioned outbox event contract

Store a small `eventVersion` and validate required `metadata` fields at enqueue. Today the outbox
accepts `Mixed` metadata, so a later producer change can make old rows ambiguous or unsafe. A
version also lets a future delivery step migrate or reject an old shape deliberately. Effort S–M.

### 10. Multi-process and clock-skew delivery test

Run two server processes against one database and deliver the same outbox row, with their clocks
deliberately offset around the 60-second stale claim. The unique key and atomic claim should still
produce one audit per event. This also exercises the recovery lease, not just the in-process
function. Effort M.

### 11. Historical audit-gap reconciliation

The Product Import fence skips a legacy receipt whose pre-dedupe audit already exists; movement and
PO recovery skip historical receipts with no `auditTracked`/`receiveId`. That is correct for
avoiding duplicates, but it means old gaps are not measured. Add a one-time read-only reconciliation
report that compares receipts/ledger rows with audit keys and lists unmatched events for human
review. Do not auto-append historical rows. Effort M.

### 12. Audit metadata/PII contract tests

Add a source-level and test-level contract for audit metadata: allowed keys, no tokens, no email
addresses, no raw CSV rows, no upstream error messages. The new movement and PO events copy fields
from existing audit calls; a future “add the invoice PDF” field could leak content into the trail.
Effort S.

### 13. Outbox-aware backup and restore drill

The existing restore drill verifies counts and BSON types. Extend it to include `audit_outbox`: a
`PENDING`/`FAILED` row restored into the test database must be deliverable under the same dedupe key,
and a restored `DELIVERED` row must not create a second audit. Also verify the TTL index exists after
restore. Effort M.

### 14. Flusher throughput and backpressure limits

A single 50-row pass can be consumed by an old `FAILED` backlog, delaying newer events. Add metrics
for queue age, a fair selection policy (for example oldest due rows plus a reserved share for new
`PENDING`), and a documented maximum retry budget per pass. Do not make delivery unbounded. Effort
S–M.

### 15. Operator CLI/console for outbox triage

Provide a read-only list and a deliberate retry action for one dedupe key, with the same
tenant-scoped authorization and audit trail as other operator tools. The current recovery is a
service call plus direct database knowledge, which is both error-prone and hard to prove. Effort M.

### 16. Cold archival before retention deletion

If governance needs delivery evidence beyond 30 days, add an export/archive sink before the TTL
window closes. The AuditLog itself remains; the question is whether the outbox’s delivery receipt
must also be retained. Decide this with the retention owner rather than extending the TTL by
default. Effort M.

### 17. Mobile/offline audit intent

The mobile client already persists operation keys across a cold start for draft and import retries.
If it later queues other mutations offline, define whether the queued intent or the server receipt is
the audit source, and how a locally abandoned intent is recorded. This is not needed for the current
server-side outbox, but it is the next place a “member saw success” and “server has an audit” can
diverge. Effort L.

### 18. Key lifecycle and reuse tests

Add focused tests for receipt-key reuse after the transport idempotency record expires: same key and
same fingerprint should replay; same key with a different body should refuse; a new legitimate
operation needs a new key. PO receive and keyed movement already have durable keys, but the
cross-window cases are not all pinned in one suite. Effort S.

## Recommended next three

1. **Production index/TTL rollout gate** — the new retention is not real until it is deployed and
   verified in the target database.
2. **Outbox/repair-lag alerting** — makes both the new paths and the existing Product Import path
   observable to an owner.
3. **Real crash-injection proof** — turns the strongest local claim (“exactly one audit after a
   crash”) from simulated deletion into observed process death.

The tenant-teardown coverage guard is a close fourth because it is small and directly prevents the
class of omission found in this session.

## Explicit non-goals

- No production data, configuration, deployment or index change was made for this document.
- No follow-up here is implemented by the §27LF change set.
- The outbox is not a replacement for the AuditLog; it is a delivery mechanism. Retention of the
  outbox must never delete the audit row it delivered.
