# PR #364 follow-up improvements — ranked (2026-11-22)

**Purpose.** This is a recommendation record, not an implementation plan. It ranks the work worth
doing after PR #364, including the archive-safe stock-status guard and cross-restart import draft
added locally in this batch. The original ranking was written before implementation; the status note
below records the ranks that have since been closed locally.

**Basis.** PR #364 delivered resumable bulk product import with a durable server receipt, a status
endpoint, persisted operation keys for inventory writes, and visible Overview/Inventory stock
filters. The gaps below come from that implementation, the device runs on 2026-11-22, and the
remaining items in `FW_01_BULK_IMPORT_IMPLEMENTATION.md` and
`INVENTORY_DASHBOARD_FOLLOWUPS_2026-11-22.md`.

## Ranked improvements

| Rank | Improvement | Type | Why it matters | Effort |
| --- | --- | --- | --- | --- |
| 1 | **Make durable resume a shared contract for every long write**, starting with the Restock → Draft PO flow | New — **implemented locally 2026-11-22** | Imports now survive a restart; a Draft PO attempt did not. A restart followed by the same selection could create a second DRAFT because its key was screen-session scoped. The account-scoped "attempt + payload" store now restores the exact body/key, blocks a new attempt when that read fails, and reuses the same key after an ambiguous response. The same key-mismatch guard is shared with the import draft. | M |
| 2 | **Finish the import draft lifecycle**: explicit Discard, age-based expiry, orphan cleanup, and purge on account deletion (ordinary sign-out preserves the draft for resume) | New | Persisting a CSV introduces state the old screen never had. A draft can now outlive its useful receipt, sit behind an invalid file with the picker locked, or retain product data after the owner leaves. Expiry, a visible Discard action, and account-deletion cleanup make the feature predictable and privacy-safe. | S–M |
| 3 | **Make import failures repairable**: export/copy the row-error CSV, jump to the reported line, and revalidate the edited file under the same operation key | New | The server reports partial imports and up to 40 visible errors, but a 300-row file with one bad SKU still leaves the operator to reconstruct the fix by hand. A machine-readable error file and a same-key resubmit path turn a support conversation into a self-service correction. | M |
| 4 | **Keep import progress alive outside the screen**: a Products banner/notification when a receipt is still running, and a resume prompt after the phone is locked or the app is backgrounded | New | Real imports have taken roughly four minutes for 300 rows. Polling stops when the screen unmounts, so the operator can lose sight of a successful import and start another. A small global "import in progress" state would make the existing durable receipt visible where the operator already is. | M |
| 5 | **Give import receipts a retention and observability story**: prune completed/failed receipts after a bounded period, publish counts/durations/failure rates, and alert on stuck `IN_PROGRESS` rows | New | `product_imports` has no TTL today. Receipts carry product ids and opening-stock evidence, so unbounded growth is both storage and support debt. Aggregates also make slow imports and rising partial rates visible before users report them. | M |
| 6 | **Measure and improve import throughput** with bounded concurrency and progress by committed row, without weakening same-key replay | Carried | The 300-row device runs took minutes, and the route permits 512 KiB / thousands of rows. Before changing the write loop, measure validation vs product create vs opening stock; then batch only the safe stages and keep the receipt as the source of truth. | M–L |
| 7 | **Make an unfinished import discoverable across devices**: owner-visible recent imports with status and counts, not only a device-local key | New | The operation key lives on one phone. A reinstall, a device loss, or a second owner cannot see that an import is `PARTIAL` or `IN_PROGRESS`, even though the server has the receipt. A read-only owner view would close that blind spot without exposing the CSV. | M |
| 8 | **Decide and test the archive policy for every stock filter**: `stockStatus` is ACTIVE-only now; legacy `lowStock`/`outOfStock` can still be combined with `status=ARCHIVED`; assistant tools have their own gates | New | The guard added here closes the canonical direct-API hole, but it deliberately leaves legacy behavior unchanged. That is a compatibility decision, not a complete policy. A small matrix across `q`, category, location, legacy flags, assistant tools, and archived products would make the boundary explicit and prevent a future filter from reopening it. | S |
| 9 | **Handle preview-to-apply drift explicitly**: show which rows changed or disappeared between dry run and apply, and offer a same-key retry after the operator re-previews | New | Validation and apply are separate requests by design. A product created by a colleague in between can turn a valid preview into a partial apply; the receipt preserves safety, but the screen does not explain the delta. A focused diff would make the existing recovery path understandable. | M |
| 10 | **Add a native end-to-end proof for import restart**: force-stop after apply, relaunch, restore the CSV/key, and finish the same receipt on a device | Carried | The new unit and screen tests mock SecureStore and the file system. They prove the logic, not Android/iOS file survival, picker behavior, or app-sandbox permissions after a real force-stop. | S–M |
| 11 | **Lift the Draft PO 100-row selection cap** with paging and cross-page selection | Carried | The draft-order screen intentionally caps the restock list at 100 rows. A larger real tenant would have to split one replenishment decision into several drafts, which makes the order harder to review and easy to duplicate. | M |

**Status (2026-11-22, later session).** Ranks **1, 2 and 10 are implemented and verified locally.**
Rank 1 now stores the exact Restock payload and operation key account-scoped in SecureStore, restores
them on a cold reopen, refuses to mint a new key after a failed storage read, and resends the stored
snapshot unchanged under the same key. The server route now also requires `Idempotency-Key`; an
ambiguous response is resumed instead of creating a second DRAFT. Rank 2 has status-first restore
(the server receipt decides resume, not a fresh dry run), a confirmed **Discard saved import**
action, a seven-day draft expiry, orphan-file/metadata cleanup, and account-deletion purge. Draft
cleanup also distinguishes a failed SecureStore read from missing/corrupt/expired metadata, so a
transient failure cannot delete a valid CSV. Rank 10 is device-proven twice, most recently with a
300-row partial receipt: after a real force-stop and relaunch the same CSV/key restored, and the
same-key resume finished 300/300 products and 300/300 stock movements with one receipt and no
duplicate products, inventory rows or ledger entries. The remaining ranks are unchanged.

## Recommended order

1. **Ranks 1–2 are closed locally.** They removed the duplicate and stale-state paths created by the
   new persistence without changing the import loop.
2. **Ranks 3 and 4 next.** They address the two failure modes operators actually hit: a file that
   needs one correction, and a long import that outlives the screen.
3. **Ranks 5–6 together.** Measure and retain before optimizing; otherwise a throughput change cannot
   be shown to improve the right stage.
4. **Ranks 7–11 as capacity allows.** Rank 8 is a short policy/test task and can be pulled forward if
   archived-product behavior becomes a support question.

## Explicitly not proposed

- No change to the server receipt's same-key replay or the canonical stock definitions.
- No raw CSV storage on the server.
- No automatic retry that could apply a different file under the same key.
- No new database, queue, or hosted service for these improvements.
