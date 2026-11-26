# Whole-project follow-up review — 2026-11-22

**Status:** assessment only. This document does not authorize implementation, a production change, a
deployment or a paid service. It ranks what is worth doing next; nothing below is implemented.

**Basis:** the full local server and mobile suites from §27KW, the current source, the
2026-11-22 import and Inventory/Dashboard records, the PR #364 ranking, the whole-product assessment,
the security/platform roadmaps, and the focused Inventory location/dashboard fixes in §27KX. The
counts and evidence for those fixes are in [`DEVELOPMENT_LOG.md`](DEVELOPMENT_LOG.md).

**Revision note.** The first revision ranked the import-audit race and the existing operational
gaps. This revision records the two fixes completed in §27KX and adds the reference-pagination,
reference-lifecycle and dashboard-freshness ideas those fixes exposed. The **2026-11-23** revision
records the import-restore guard, the server-side DRAFT request-key fence and the emulator
force-stop/same-key proof in §27LB; the ranking below is unchanged, and item 7 is now the next step
because that proof is still manual.

**Method.** Ranking favours work that prevents an irreversible outcome (data loss, lockout, silent
security failure, duplicate business records) before work that improves convenience, then weighs the
operator/customer impact and the smallest dependency that must be cleared first. Effort is S/M/L.

## Ranked follow-ups

| Rank | Recommendation | Why it is worth doing now | Effort | Existing map |
| ---: | --- | --- | --- | --- |
| 1 | **Prove a real restore and set RPO/RTO.** Back up the actual tier, restore into a disposable database, compare row counts and ledger totals, and record how long it took. | A backup that has never been restored is a hope. The deployed Atlas tier has no provider backups, the helper has only passed scratch tests, and a database loss is the one failure this product cannot reconstruct from logs. | M | IA-04; OPS-1 |
| 2 | **Deliver security alerts to a named owner and backup.** Route platform audit, outer-gate refusals, audit-write gaps and repeated 5xx to a channel with an acknowledgement path. | The audit trail is pull-only and the GitHub schedule is not the active watch. A break-glass use, administrator change or gate attack can complete before anyone opens the console. | M | IA-02/IA-10; SEC-09/CI-05 |
| 3 | **Make audit writes exactly-once and failure-durable for every replayable write.** Give each success event a stable deduplication key or outbox row; use the same key on same-key and concurrent service retries. | The direct service test found two import finalizers both writing `PRODUCTS_IMPORTED` and returning `201`. Import now has a single-winner receipt transition, but other audit paths and the import audit-failure path are not proved. Duplicate or missing evidence undermines dispute history. | M | New; extends NX-02/IA-03 |
| 4 | **Make durable resume a shared contract for long writes**, starting with Restock → Draft PO. | A restart while a Draft PO request is ambiguous can create a second DRAFT because the key is screen-session scoped. This is a duplicate-business-record path, not a cosmetic retry. | M | PR #364 rank 1 |
| 5 | **Make reference pagination complete in every picker and resolver**, not only Inventory's saved-location check. Reuse the complete/all-pages contract for locations, categories and suppliers, and add an exact-name server lookup where a page cannot guarantee a match. | Inventory now fetches every active-location page before judging a saved id, but Movement, Transfer, PO, Product and Restock pickers still read one 100-row page. A valid location on page 2 is simply absent from those forms, and exact-name links can fail to resolve. The failure grows silently as a tenant adds references. | M | New; extends §27KX |
| 6 | **Bound and recover import execution.** Add a per-tenant concurrent-import limit or queue, a stale-`IN_PROGRESS` supervisor, and an explicit cancel path. | The route protects one key for ten minutes but different keys can run at once with no tenant-wide cap; a free 512 MB instance can be saturated, and a lost device/key can leave a receipt running forever. | M | New |
| 7 | **Make import failures repairable and progress persistent outside the screen.** Export/copy the row-error CSV, jump to the line, revalidate under the same key, show a banner for a running receipt, and explain preview-to-apply drift. | A 300-row file that needs one correction still becomes manual reconstruction, and the screen stops polling when unmounted. An operator can lose sight of a successful import and start another. | M | PR #364 ranks 3, 4 and 9 |
| 8 | **Validate reference lifecycle everywhere a saved id can outlive its record.** Resolve archived/deleted locations and categories in Draft POs, saved drafts, filters, imports and deep links, and offer a repair choice instead of a dead end. | Inventory now preserves a saved location until the active list is complete, but the rest of the app still stores raw ids. An archived location can make a Draft PO unissuable, and another picker may show no explanation for the missing value. | M | New; extends §27KX |
| 9 | **Put a global ceiling and kill switch on AI spend.** Add a durable daily/monthly budget, an operator switch that disables paid fallback, and alerting on provider spend and model health. | The simple-inventory paid budget is process-local, other paid paths are not covered by a global cap, and a restart resets the guard. A runaway provider bill is an avoidable business risk. | M | IA-05 |
| 10 | **Close the highest-value assistant accuracy gaps:** catalogue-wide run-out ranking and deterministic two-product/current-versus-minimum comparisons. | These are common operational questions that still leave arithmetic or ranking to the model. One bounded aggregate and labelled comparison read would make them exact without adding a write path. | M | AI roadmap ranks 2–3 |
| 11 | **Make the release path real.** Produce a fresh Play AAB, download and retain it, install the store-signed build, and finish the legacy-password migration needed to retire the old login. | The earlier AAB records point at deleted artifacts, Play App Signing and a store-installed build are unproven, and real customers cannot arrive through a supportable identity path while legacy accounts remain. | M/L | IA-09; AUTH migration |
| 12 | **Give import receipts a retention and cross-device story.** Prune completed/failed receipts after a bounded period, show an owner the recent receipts with status and counts, and alert on stuck rows. | `product_imports` has no TTL, the operation key lives on one phone, and a reinstall or second owner cannot see a `PARTIAL` receipt. The receipt is evidence and support context, but should not grow forever. | M | PR #364 ranks 5 and 7 |
| 13 | **Give the Dashboard a partial-data contract instead of three independent fetches.** Return summary, restock preview and open POs with a generated-at marker and per-section status, or add per-section retry/refresh. | The new fallback keeps the attention route when the preview fails, but the three requests can still disagree and the summary can be newer than the rows. One contract would remove contradictory numbers and this class of silent-section failure. | M | New; extends §27KX |
| 14 | **Add tenant data export and verify retention/deletion.** Export products, locations, inventory and movement history in a bounded, audited job; decide retention for audit/feedback/operations rows and verify account deletion removes what it claims. | Import exists without an equivalent exit path. A business needs portability for trust and offboarding, and the current deletion path is best-effort for the local import draft. | M | IA-39/IA-18 |
| 15 | **Add mobile crash/install telemetry and a redacted support diagnostic.** Record app version, device class, route and a safe request reference; never include product data or credentials. | Support is blind to the most common customer failure mode, and the console explicitly says mobile telemetry is unavailable. Start with a free tier and a narrow field allowlist. | S/M | IA-11 |

## Newly surfaced by this review

1. **The active-location list was judged from one page.** `useActiveRef` loaded only page 1, while
   Inventory treated `!loading` as proof that a saved location no longer existed. A tenant with more
   than 100 active locations would silently lose a valid saved filter; a failed fetch looked the
   same as an empty list. The fix adds an explicit `complete` flag, fetches every page for Inventory,
   and only clears the saved id when the last page has been confirmed. The focused regression covers
   a 101-location list and a failed page-2 read.
2. **The Dashboard hid its own escape route when the optional preview failed.** The summary already
   had low/out counts, but the whole Needs attention section was tied to `restock`, so a preview
   failure removed even the row-level route. The new fallback renders the summary counts and keeps
   the `inventory?needsAttention=true` action; a focused test fails the preview request and verifies
   the route.
3. **The same first-page assumption remains in other pickers.** Movement, Transfer, PO, Product and
   Restock screens still use the default single-page reference load. The fix is intentionally local
   to Inventory; a shared all-pages resolver is the next step.
4. **Reference lifecycle is still a client-side convention.** Inventory can now distinguish
   "not found/completed" from "could not confirm", but other drafts and saved forms still trust raw
   ids and have no repair path when a location or category is archived.
5. **The Dashboard has no shared freshness contract.** The fallback is safe, but a later summary
   refresh and an older preview can still show different pictures. A generated-at/per-section
   contract would make the relationship explicit.

## Existing recommendations that deserve more weight

- **Restore and alerting are prerequisites, not infrastructure polish.** They are the only ranked
  items that address an outcome no later feature can undo.
- **Complete reference data is an operational correctness issue.** A hidden location is not merely
  inconvenient: it can prevent a stock movement or make a valid saved filter look deleted.
- **Tenant data export is not a nice-to-have once import exists.** The asymmetry is visible to a
  customer and is easier to design before real data arrives.
- **Mobile telemetry is a support gate, not analytics.** A redacted crash/install signal is enough to
  stop guessing about common failures.

## Deliberately lower

- **Archive-filter policy matrix** (PR #364 rank 8): small and useful, but compatibility semantics
  rather than an immediate failure.
- **Import throughput** (rank 6): measure first; the current 300-row runs complete and correctness is
  more important than speed until real tenants import larger files.
- **Draft PO 100-row cap** (rank 11): only matters once a real restock list exceeds one page.
- **Recently-used location ordering and a larger picker sheet**: convenient, but not before every
  picker can see the complete list.
- **TalkBack/large-text pass and smaller-screen polish**: valuable accessibility work, but below the
  irreversible-risk items and best done together with the next mobile usability pass.
- **Remaining dependency advisories**: currently unreachable from runtime; forcing versions is worse
  than the residual risk.

## What not to do next

- Do not add tenant-detail reads or a support selector before a reason-bound, expiring support grant.
- Do not add more AI answer shapes before the global spend/kill-switch guard and the quality corpus.
- Do not treat the append-only Mongoose guard as immutable storage or a backup.
- Do not implement Cloudflare Access or another edge as a DNS-only change; origin validation and a
  real test are part of the boundary.

## 2026-11-23 revision after §27LA and the import/Draft PO guards

This revision keeps the historical ranking above and records what has since landed locally: complete
reference pagination and lifecycle repair (§27LA), the sectioned Dashboard contract (§27LA), the
import-draft temporary-read guard, and the durable `requestKey` on Restock → Draft PO. Ranks 4, 5, 8
and 13 above are therefore no longer open as written. Rank 4 still needs a physical force-stop proof.

The remaining list is re-ranked for the next planning cycle. It deliberately excludes features we
have already built and does not authorize implementation.

| Rank | Recommendation | Why it is worth doing now | Effort | Risk |
| ---: | --- | --- | --- | --- |
| 1 | **Prove restore on the real tier and publish RPO/RTO.** Back up the deployed database, restore into an isolated database, verify counts/ledger/indexes and record restore time and data-loss window. | The synthetic drill proved the scripts, not the provider tier, indexes or a real recovery. No later feature can undo a lost tenant database. | M | High |
| 2 | **Deliver security alerts to a named owner and backup.** Route break-glass use, outer-gate refusals, audit-write gaps and repeated 5xx to a channel with acknowledgement and escalation. | The audit trail is pull-only. A compromise can complete before anyone opens the console. | M | High |
| 3 | **Make audit success records exactly-once and failure-durable with an outbox or pending-audit row.** Adopt the shared dedupe primitive on movements, transfers, receives and recoveries, then close the crash-after-business-write gap. | Duplicate or missing evidence undermines disputes, reconciliation and the new request-key guarantees. Product import is the only surface currently using the dedupe key. | M | High |
| 4 | **Add a schema/index rollout gate and readiness check.** Version required indexes, fail startup or readiness when the DRAFT `(businessId, requestKey)` or audit dedupe indexes are missing, and document the migration path. | The new crash-safe DRAFT fence is only as strong as its unique index. `createIndex` from an application start is not a deployment guarantee, and a missing index can silently restore the duplicate-DRAFT window. | S/M | High |
| 5 | **Put a global AI spend ceiling and operator kill switch in place.** Durable daily/monthly budget, provider-spend alerts and one switch that disables paid fallback across processes. | The simple-inventory budget is process-local; a restart resets it and other paid paths are outside it. A runaway bill is an avoidable business risk. | M | High |
| 6 | **Add a reference snapshot + delta endpoint.** Return all active locations/categories/suppliers/products with `generatedAt`, `version` or `updatedSince`, then let pickers/page guards consume one cursor instead of ~100 serial requests. | Every all-pages picker is safe but slow at 10,000 products, and the Dashboard still has independent per-section timestamps. One versioned read removes both scaling and cross-section skew. | M | Medium |
| 7 | **Automate the device crash/restart proof.** A Maestro/Detox flow (or equivalent) that forces a stop after the request is observed, relaunches, resumes, captures the key and asserts one DRAFT should run against a disposable backend on every release candidate. | The 2026-11-23 emulator proof confirmed the same key and one DRAFT, but it was run by hand. The guarantees are otherwise covered by unit/DB tests, the manual proof is easy to skip, and an ambiguous-response regression can reappear without a failing CI signal. | M | Medium |
| 8 | **Build cycle counting and stocktake.** Freeze a location or selection, count against expected quantity, record variance and post audited adjustments through the existing movement ledger. | This is the largest missing inventory-control workflow: today an operator can adjust stock but cannot run a defensible count, and shrink/error investigations remain manual. | L | High |
| 9 | **Deliver low-stock alerts with per-tenant rules.** Email or push a daily digest / threshold event for products at or below minimum, with location scope, snooze, owner recipients and a link back to the filtered rows. | The Dashboard is pull-only. A stockout is discovered only when someone opens the app; alerting is the highest-value operational feature not already in the product. | M | Medium |
| 10 | **Speed up receiving with barcode scanning, partial receipts and discrepancy capture.** Scan a PO line, receive available quantity, record damaged/short units and show outstanding lines. | Receiving is a warehouse-floor task; typing product lines is slow and error-prone. The ledger and claim-first receive already provide the correctness substrate. | M | Medium |
| 11 | **Add tenant data export and verified retention/deletion.** Bounded, audited export of products, locations, inventory, movements and POs; document retention for audit/feedback/operations data and verify account deletion. | Import exists without an equivalent exit path. Portability and offboarding are trust requirements, and retention is easier to settle before larger tenants arrive. | M | Medium |
| 12 | **Add approval thresholds for high-risk changes.** Require a second role for large adjustments, transfers or purchase orders above a configured value, with an audited approve/reject step. | Role permissions currently decide who can act, not how large an action may be. A single manager can move or order an unbounded amount. | L | High |
| 13 | **Add redacted mobile crash/install telemetry and a support diagnostic.** Record app version, device class, route, request reference and a safe error code; never product data or credentials. | Support is blind to the most common customer failure mode. Start with a narrow allowlist and a free tier before considering analytics. | S/M | Medium |
| 14 | **Build an offline-first movement queue for stock in/out.** Persist intent locally, replay with the existing idempotency keys, and show pending/settled/failed states across restarts. | Warehouse connectivity is intermittent; the app currently requires a live request for every movement. This is valuable but should follow the smaller correctness and observability work. | L | High |

### Newly surfaced or changed since the last ranking

1. **The DRAFT key is now durable, but its index is a deployment dependency.** The server replays an
   existing DRAFT even when the HTTP claim was lost, but the unique `(businessId, requestKey)` index
   must exist in every environment. Application-start index creation is not an adequate migration or
   readiness proof.
2. **Ambiguous-response testing is still manual.** The stack now has the right durable primitives,
   but the only physical force-stop proof is a procedure. The next release-candidate gate should run
   it automatically against a disposable database.
3. **Complete reference reads moved the bottleneck from correctness to latency.** Every picker now
   reads all pages serially; a versioned snapshot/delta endpoint is the structural fix, not a larger
   timeout.
4. **The Dashboard contract is sectioned, not atomic.** Per-section retries and timestamps are
   better than the old fire-and-forget sequence, but a generated-at server snapshot remains the only
   way to guarantee that summary, preview and open orders describe the same instant.
5. **The import restore guard now distinguishes a temporary read failure from a missing draft.** The
   operator is blocked until the saved attempt can be verified; the remaining import work is
   execution bounds, cross-device visibility and a repair path for failed rows, not restart safety.

### Deliberately not next

- A literal “Updated just now” label or a first-load skeleton: useful, but below the data-integrity
  and operational items above.
- More AI answer shapes before the global spend ceiling and accuracy corpus.
- Import throughput tuning before a measured large-file run.
- Recently-used picker ordering or compact-filter polish before the versioned reference endpoint.
