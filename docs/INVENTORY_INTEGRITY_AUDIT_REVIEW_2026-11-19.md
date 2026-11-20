# Inventory integrity audit review — fixes, crash recovery and ranked next work

**Date:** 2026-11-19
**Scope:** the five audit findings implemented in §27KC, plus the remaining risks visible after
reading the AI catalogue reads, transfer compensation, purchase-order receiving and catalog
write paths. Recommendations only; nothing below was implemented in this pass except the four
fixes named in §1. **Superseded in part by §5:** the ten ranked improvements were implemented
later the same day.

## 1. What this pass fixed

| Finding | Fix | Evidence |
| --- | --- | --- |
| AI cheapest-product ranking used a newest-first page | `findProducts` accepts `sort: "price_asc" \| "price_desc"`; the database sorts every match before paging, and the exact-product fallback is re-ranked with the merged set. | AI-45 price-ranking regression |
| AI showed an unrecorded price as `0`, and price filters included it | AI rows expose `sellingPrice: null` when no positive price is recorded. Price ranking and every price ceiling exclude missing/zero prices. `up to`/`within` include the ceiling; `under`/`below` do not. | AI-45 null-price and inclusive-ceiling regressions |
| In-stock filtering could be lost beside a price rank | `inStockOnly` is applied in the stock merge after the price predicate, and the exact fallback carries it. | AI-45 in-stock + price-rank regression |
| Transfer duplicate-key retry was update-only | The destination retry is now a bounded full upsert, mirroring `stockIn`; a vanished destination row is re-created instead of writing ledger rows without stock. | Phase 19 duplicate-key regression |
| PO receiving could add stock twice after a finalize applied then threw | The receive stores the client `Idempotency-Key` on its claim and receipt. A retry with the same key replays a complete durable receipt, returns `replayed: true`, and never claims or stocks again. A partial receipt or surviving claim is a 409 with the applied lines, not a fresh receive. The mobile receive screen keeps that key across a 5xx, transport failure or `RECEIVE_IN_PROGRESS`, so the retry it offers is the same operation. | Phase 13 apply-then-throw regression |
| Product/reference PATCH could not clear a recorded field | Partial validators distinguish an omitted field (`undefined`, leave alone) from explicit empty/`null` (clear). Product prices clear to the existing DTO default `0`. | Phase 04 clearing regression |
| An archived category could be assigned | Product create/update reject a category whose status is not `ACTIVE` with `CATEGORY_ARCHIVED`. | Phase 04 archived-category regression |
| Catalog POSTs could be retried into duplicates | Product, category, location and supplier creates mount the existing idempotency middleware; mobile product/reference creates send a key and keep it across an ambiguous timeout. | Phase 04 idempotent-create regression |
| A failed audit write after a committed catalog change produced a 500 | Product and reference audit writes are best-effort after commit; the durable change is returned and the trail gap is logged. | Phase 04 audit-failure regression |

## 2. Crash-recovery assessment

### Transfers

A transfer writes three separate things: the source debit, the destination credit, and two
ledger rows plus one audit event. The compensation paths are intentionally in-process and
quantity-anchored. A process crash between those writes can therefore leave:

- source debited, destination not credited, no ledger row; or
- both inventory rows moved, ledger incomplete; or
- one ledger row written, the other missing.

There is no durable in-flight transfer record. The HTTP idempotency key protects a *retry of
the request* after an error response, but it cannot recover a process that died before answering
and before any retry. The next process does not know a transfer was in flight.

**Assessment:** this is an acceptable residual for the current single-instance, low-volume
operation because the inventory rows remain the authoritative quantity and an operator can
reconcile them against the ledger. It is **not** sufficient for multi-instance processing,
high transfer volume, or an audit regime that requires every movement to be accounted for
automatically. The smallest durable improvement is an operation journal: one row written before
the source debit with `PENDING`, updated `APPLIED` after both ledger rows, plus a startup/worker
reconciler that finds stale `PENDING` rows and either completes or reverses them. A full MongoDB
multi-document transaction is the stronger alternative, but it changes the deliberate
single-document/compensation architecture and needs replica-set parity in every environment.
Neither is implemented here.

### Purchase-order receiving

Receiving already has a visible ghost-claim mechanism: a crash after the claim and before the
receipt leaves a pending claim, which blocks over-receiving and appears in the detail response.
The retry replay added in this pass closes the specific ambiguity where the receipt committed but
the response was lost. A crash before the receipt still leaves a claim that requires
cancel-and-recreate; that is visible and safe, but not automatic.

**Assessment:** no additional durable recovery is urgent while the ghost claim is visible and
monitored. The next step, if receiving volume grows, is a stale-claim reaper that verifies whether
the claim's stock-in transaction exists before releasing or finalizing it. Do not delete a stale
claim blindly: that is the one action that could allow a second receipt over an existing movement.

## 3. Ranked additional improvements

Ranked by user impact first, then by implementation risk (lower risk is preferred at the same
impact). These are recommendations, not work completed in this pass.

| Rank | Improvement | User impact | Risk / effort | Why it is next |
| --- | --- | --- | --- | --- |
| 1 | **Make price ranking currency-safe.** Either require one recorded currency for a price ranking, group by currency, or return `mixedCurrency: true` with per-currency ranks. A bare numeric sort across PHP and USD can call a $10 item cheaper than ₱900. | High — a wrong "cheapest" answer is a purchasing decision. | Medium: query/response shape and prompt wording; no data migration. | The new server-side ranking makes the old per-page comparison less wrong, but it also makes a cross-currency rank more authoritative-looking. |
| 2 | **Durable transfer operation journal/reconciler.** Add an operation id and a durable pre-write row; reconcile stale `PENDING` transfers on boot and on a bounded schedule. | High — closes the only remaining silent partial-write window in stock movement. | High: new model, startup hook, compensation tests, multi-instance coordination. | Assessed in §2. Do this before horizontal scaling, not as a rushed schema change. |
| 3 | **Require an idempotency key for PO receive and return a stable receipt/operation id.** The replay gate only works when the client sends the same key. A client that times out and retries with a new key still has no server-side way to identify the logical receipt. | High — removes the remaining retry-dependent double-stock path. | Medium: mobile receive screen must reuse its key (it already has `newIdempotencyKey`), API contract and tests. | The apply-then-throw case is closed; a new-key retry is the residual. Consider making the key mandatory on `/receive` and `/transfer` rather than optional. |
| 4 | **Stale purchase-order claim reaper.** Detect claims older than a bounded age, check for their stock-in transaction, then finalize or release; never release a claim whose movement exists. | Medium-high — converts a manual cancel/recreate recovery into an automatic one. | Medium: a reconciler, idempotent claim-finalize helper, DB tests. | The ghost claim is visible today; this is an operational quality improvement, not a correctness emergency. |
| 5 | **Catalog archive consistency.** Decide whether archiving a category with ACTIVE products is allowed, blocked, or auto-reassigns them; surface archived-category products in the catalog UI. | Medium — avoids a live product pointing at a closed category. | Low-medium: policy decision plus one query/test. | The write-time validation now blocks new assignments, but the archive action itself does not check dependents. |
| 6 | **Reference idempotency end-to-end tests for every resource.** The middleware is mounted on all four creates, but only product create is covered over HTTP. Add category/location/supplier duplicate-delivery cases and a cross-tenant key-isolation case. | Medium — proves the shared route wiring, not just one resource. | Low: tests only. | The middleware is generic, but route wiring and tenant scoping are exactly where a regression silently reappears. |
| 7 | **Catalog audit-gap monitor.** Count committed catalog writes without a matching audit event, or emit a bounded metric when `safeProductAudit`/`safeReferenceAudit` logs a failure. | Medium — the write is safe, but the trail can now be silently incomplete. | Low-medium: structured log/metric and an operator threshold. | Best-effort audit is the right availability trade-off; it needs an observable gap, not a second write path. |
| 8 | **Price-data quality pass.** Report products with no price, zero price, or a price without a currency; give the owner a one-click filter. The AI now says `null` instead of guessing, which makes the underlying gap visible. | Medium — improves both catalogue quality and answer trust. | Low: read-only report and existing screens. | No migration; this is a usability/observability improvement. |
| 9 | **Transfer/receive request fingerprints on the durable receipt.** Store a body fingerprint beside the client key so a key reused with a different body after a 5xx cannot replay a subset. | Low-medium — closes an edge case below normal client behavior. | Low: one extra field and comparison. | The middleware already fingerprints normal deliveries; the service replay path currently trusts the key alone. |
| 10 | **AI ranking tests for tie-breaking and pagination.** Add equal-price rows, a price sort crossing a page boundary, and `hasMore`/`partialNote` assertions. | Low-medium — protects deterministic ordering as the catalogue grows. | Low: tests only. | The new sort is deterministic via `_id`, but only the cheapest-old-row case is pinned today. |

## 4. Verification recorded for this pass

- AI-45: 14 tests, 13 passed and 1 mode-skipped in `TEST_MODE=db`; includes null price, inclusive
  ceiling, price-before-paging, in-stock + rank and old-row regressions.
- Phase 19 transfers: 25/25 passed, including the duplicate-key full-upsert regression.
- Phase 13 receiving: 17/17 passed, including the apply-then-throw replay regression.
- Phase 04 catalog: 23/23 passed, including clearing, archived category, idempotent create and
  post-commit audit failure.
- Server and mobile TypeScript typechecks passed after the code changes.

No production data, deployment, account, permission or environment setting was changed.

## 5. Addendum — the ten improvements were implemented the same day

The ranked list in §3 was approved as one coordinated implementation. The ranking, transfer
journal/reconciler, required receive key, stale-claim reaper, category policy, idempotency and
tenant-isolation coverage, audit-gap monitoring, price-quality report, request fingerprints and
AI tie/currency regressions are now implemented and tested. The operator reference, recovery
semantics and remaining limits are in [`INTEGRITY_RECOVERY.md`](INTEGRITY_RECOVERY.md); the
implementation record is §27KE in `DEVELOPMENT_ROADMAP.md`. Nothing in §2 remains an
unimplemented recommendation, and §3 is retained as the pre-implementation ranking.
