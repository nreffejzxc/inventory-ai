# Dashboard freshness, reference lifecycle and History follow-ups — 2026-11-23

**Status:** implemented locally and verified with focused checks; **not committed, pushed, merged or
deployed**. No production data or configuration was read or changed. This record also contains ranked
recommendations; rank 3 is now implemented locally under §27LG, and the others remain
recommendations.

**Scope.** Review the four recent Dashboard/reference changes, simplify the freshness and reference
lifecycle code, expose the summary's last-read time, make each secondary Dashboard retry independent,
read every active-reference page in History's filters, and rank the next improvements. This is the
local follow-up to §27LA.

## Review findings and corrections

| Area | Finding | Correction |
| --- | --- | --- |
| Dashboard section type | Every section carried `updatedAt`, but only the summary interface ever displayed it. The restock and open-order timestamps were dead state that still caused writes and test noise. | `DashboardSection` now holds only `data`, `state` and `error`. `DashboardSummarySection` adds the one displayed `updatedAt`. |
| Dashboard retry dependency | A `summaryRef` mirrored the whole summary solely so a restock retry could recover the attention count. That was a second source of truth that could disagree with rendered state. | Removed. `reloadRestock` derives the count from the current summary data and `reload` passes the just-loaded summary's count. Section sequence guards and session-error handling are unchanged. |
| Dashboard stale state | The summary error banner said “pull to retry” although pressing it retried. A successful section retry already cleared its error; the test suite did not assert the retry control disappeared or that the other section was untouched. | The summary now shows **Last updated** from its accepted response; the stale banner says **tap to retry**. Focused assertions cover the timestamp, cleared retry controls, and that retrying the restock preview does not call the summary or open-order loader (and vice versa). |
| Reference pagination | `useActiveRef` preferred `ceil(total / requestedLimit)` over the server's `totalPages`. If a server applied a smaller page size, the loop stopped early, left rows unseen and reported `complete: false` with no way to finish. | Prefer `totalPages`, fall back to the total only when the page count is absent, and decide `complete` once after the loop. A focused test uses three pages with `limit: 100` to pin the server-capped case. |
| History named location | Resolving a name-only route param used `setState` directly in an effect and a “resolved once” ref. It passed ESLint only if the effect was suppressed, and clearing the field could be undone by a later render. | The effective location id is derived from the complete active list until the person chooses or clears a location. No effect, no ref, and an explicit clear stays cleared. Saved ids still take precedence over the name. |
| History filters | Product and location pickers read only page 1, so a saved id/name after row 100 was absent from the trigger and options. | Both now use `useActiveRef(..., { allPages: true })`; the source guard includes History. |
| Unused lifecycle helper | `useCatalogOptions` had no callers and duplicated the pair of `useActiveRef` calls screens already make. | Removed. `useActiveRef` and `referenceAvailability` remain the only reference-lifecycle entry points. |

## Implemented behavior

- The Dashboard summary shows `Last updated {date and time}` beneath the greeting. The timestamp is
  the client's time when the accepted summary response arrived; stale data keeps the old timestamp and
  is separately marked by the warning banner.
- A summary refresh clears the summary error and starts the dependent sections afresh. A full reload
  may still read all sections, as pull-to-refresh is the explicit whole-screen action.
- Each secondary failure keeps its own retry. Retrying the restock preview calls only
  `productsApi.reorder`; retrying purchase orders calls only `purchaseOrdersApi.list`. A successful
  retry clears its error/retry UI and leaves the other section's data and request count alone.
- The restock timestamp and open-order timestamp are gone. They can return only with a visible
  per-section freshness treatment; storing them without a reader was the defect.
- `useActiveRef` still preserves already-read pages after a later-page failure, keeps `complete` false,
  deduplicates ids and discards superseded responses.
- History's product/location options include page-two rows. A saved id on page two remains selected
  and in the `inventoryApi.history` query, and a route-supplied location name is resolved from the
  complete list.

## Verification

- Focused Jest, command
  `npx jest __tests__/dashboard-freshness.test.tsx __tests__/reference-pagination.test.tsx __tests__/history-filters.test.tsx --runInBand --silent`:
  **3 suites / 18 tests, 18 passed, 0 failed**.
  - Dashboard freshness: 2/2.
  - History page-two filters and named-location resolution: 2/2.
  - Reference pagination/availability/call-site guard: 14/14.
- `npm run typecheck`: passed.
- Focused ESLint over the two screens, two hooks and three test files: **0 errors / 0 warnings**.
- No device run, visual review, screenshot, full mobile suite or production check was made.

## Limitations

- The summary freshness time is client receipt time, not a server `generatedAt`; clock skew and network
  delay are not represented. The three Dashboard reads still describe three different instants.
- History reads every active page serially. A very large catalogue is correct but can take many
  requests before an option or a name-only filter resolves.
- History does not surface `complete` or a retry when an active-reference page fails. It keeps the
  partial options and the saved id request, but a person cannot tell that an option may be missing.
- Active-reference lists omit archived products/locations. A historical filter that arrives with only
  an id and no display name may therefore have no label, even though the history query still uses it.

## Ranked follow-ups

Value, effort and risk are scored 1–5; the score `2 × Value − Effort − Risk` is a sizing aid, not
the sort key. Ranking first protects irreversible outcomes, then operational correctness, then
operational value and speed. **None of these is implemented.**

| Rank | Improvement | Why it matters | V | E | R | Score |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | **Prove restore on the deployed database tier and publish RPO/RTO.** Restore into an isolated database, compare counts, on-hand totals, ledger nets and required indexes, and record the elapsed time and data-loss window. | A synthetic restore proved the scripts, not Atlas, the production indexes or the real recovery window. No later feature can undo a lost tenant database. | 5 | 3 | 5 | 2 |
| 2 | **Deliver security and integrity alerts to a named owner and backup.** Route break-glass use, outer-gate refusals, audit-write gaps, repeated 5xx and stuck recovery receipts to a channel with acknowledgement and escalation. | Monitoring is still pull-only. An administrator compromise or gate attack can finish before anyone opens the console. | 5 | 3 | 4 | 3 |
| 3 | **Add a schema/index rollout and readiness gate.** Version required indexes, fail readiness when the DRAFT `(businessId, requestKey)`, audit dedupe or transfer-ledger indexes are missing, and document the migration path. **Implemented locally 2026-11-23 (§27LG); production apply not run.** | The crash-safe duplicate fences are only as strong as their unique indexes. Application-start index creation is not a deployment guarantee. | 5 | 2 | 4 | 4 |
| 4 | **Make audit success records exactly-once and failure-durable beyond Product Import.** Adopt the outbox/dedupe primitive for movements, transfers, receives and recovery jobs, including the crash-after-business-write window. | Missing or duplicate evidence undermines disputes and the request-key guarantees the product now advertises. | 4 | 3 | 4 | 1 |
| 5 | **Put a durable global ceiling and kill switch on AI spend.** Enforce a daily/monthly budget across processes and provide one operator switch for paid fallback. | The current simple-inventory budget is process-local and resets on restart; other paid paths are outside it. A runaway provider bill is avoidable. | 5 | 3 | 4 | 3 |
| 6 | **Add a versioned reference snapshot/delta endpoint.** Return all active references with `generatedAt` and `version`/`updatedSince` so pickers consume one cursor instead of roughly 100 serial requests. | Complete pagination moved the bottleneck from hidden rows to latency. One versioned read also gives every picker one coherent reference generation. | 4 | 3 | 3 | 2 |
| 7 | **Complete the History filter lifecycle.** Surface an incomplete/failed active-reference read with Retry, keep the saved id visible, and resolve archived historical product/location names through a read-only exact lookup. | History is where archived records should remain understandable. Today a page-two failure is silent, and an id-only archived filter can have no label even though it still scopes the request. **New.** | 4 | 2 | 2 | 4 |
| 8 | **Deliver low-stock alerts with per-tenant rules.** Email or push a daily digest or threshold event with location scope, recipients and a link back to the filtered rows. | The Dashboard is pull-only; a stockout is discovered only when someone opens the app. This is the highest-value operational feature not already present. | 5 | 3 | 3 | 4 |
| 9 | **Automate the device crash/restart proof.** Run force-stop, relaunch, same-key resume and one-record assertions against a disposable backend on each release candidate. | The DRAFT and import guarantees have unit/DB coverage, but the only end-to-end proof is still a manual emulator or phone procedure that is easy to skip. | 4 | 3 | 2 | 3 |
| 10 | **Persist History filters per account.** Save type/product/location behind route parameters, with an explicit Reset, matching Inventory's pattern. | Audit and reconciliation are recurring tasks, and reconstructing the same filters after every app restart wastes operator time. Route params must still win. **New.** | 3 | 1 | 1 | 4 |
| 11 | **Build cycle counting and stocktake.** Freeze a location or selection, count against expected quantity, record variance and post audited adjustments through the movement ledger. | Adjustments exist, but there is no defensible count or shrink investigation. This is the largest missing inventory-control workflow; it needs its own design. | 5 | 4 | 4 | 2 |
| 12 | **Add tenant data export and verified retention/deletion.** Provide a bounded, audited export of products, locations, inventory, movements and POs; document retention and verify deletion. | Import exists without an equivalent exit path. Portability and offboarding are trust requirements, and retention decisions get harder once real data arrives. | 4 | 3 | 3 | 2 |
| 13 | **Add approval thresholds for high-risk changes.** Require a second role for large adjustments, transfers or orders above a configured value, with an audited approve/reject step. | Roles decide who may act, not how large an action may be. One manager can currently move or order an unbounded amount. | 4 | 3 | 4 | 1 |
| 14 | **Add a redacted mobile crash/install diagnostic.** Record app version, device class, route, request reference and a safe error code; never product data or credentials. | Support is blind to the most common customer failure mode. Start with a narrow allowlist and a free tier. | 3 | 2 | 2 | 2 |
| 15 | **Make Dashboard freshness relative and age-aware.** Show “Updated just now / 2 min ago”, refresh the label on a timer, and mark data older than a chosen threshold. | The new absolute timestamp is accurate but requires mental arithmetic and can silently age while the screen remains open. This is small polish, not a data-integrity fix. **New.** | 2 | 1 | 1 | 2 |
| 16 | **Add an offline-first movement queue.** Persist stock-in/out intent, replay with the existing idempotency keys and show pending/settled/failed across restarts. | Warehouse connectivity is intermittent and every movement currently requires a live request. Valuable, but it depends on the smaller correctness and observability work above. | 4 | 4 | 4 | 0 |

### Newly surfaced by this review

1. **History has no incomplete-list repair.** All pages are now read, but History ignores
   `useActiveRef`'s `complete` and `reload` fields. A failed page leaves usable partial options with
   no warning or retry, and an id-only archived filter can have no label even though it still scopes
   the query. This is rank 7.
2. **History filters do not survive a restart.** Inventory persists its location/status choice per
   account, while History rebuilds type/product/location solely from route parameters. Recurring
   audit work has to be reconstructed each time. This is rank 10.
3. **`complete` still depends on pagination metadata.** Preferring `totalPages` fixes the
   server-capped page-size case, but an endpoint that omits both `totalPages` and `total` can never
   prove a list complete. A versioned snapshot or a tested pagination-metadata contract would remove
   that dependency; it is folded into rank 6.
4. **The new absolute timestamp still ages on screen.** It is correct when rendered, but a Dashboard
   left open for hours has no relative label or age threshold. This is rank 15.

### Recommended order

1. **Ranks 1–3** are the prerequisites: restore proof, alert delivery and index readiness. Each closes
   an outcome the application cannot repair later.
2. **Ranks 4–6** finish the durability and scale story: audit coverage, AI spend control and one
   versioned reference read.
3. **Ranks 7–10** make the new reference and history behavior understandable and repeatable: repair
   incomplete/archived History filters, add low-stock alerts, automate the restart proof and persist
   History filters.
4. **Ranks 11–16** are operational capacity and polish; schedule them only after the gates above.

### Explicitly not next

- A first-load Dashboard skeleton by itself: useful, but it does not correct stale data or a
  contradictory section.
- More AI answer shapes before the global spend ceiling and quality corpus.
- Import throughput tuning before a measured large-file run.
- Recently-used picker ordering before the versioned reference endpoint.
- Forcing dependency versions to silence advisories that are unreachable from runtime code.
