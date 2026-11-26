# Inventory and Dashboard follow-ups — 2026-11-22

**Status:** implemented locally and device-verified in the working tree; **not committed, pushed,
merged or deployed**. The review baseline was commit `c697943` on `fix/fw01-import-resume`; it is not
an ancestor of the current `fix/overview-stock-filters` branch, so its behaviour was ported rather
than merged.

**Scope.** The mobile Inventory screen and Dashboard, plus the `GET /api/inventory` contract. The
small-screen review used the existing CPH1969 captures in
[`evidence/ui-review-2026-11-22/`](evidence/ui-review-2026-11-22/README.md) and the current code. The
four-chip layout was re-captured on the CPH1969 at **360 dp** on 2026-11-22, together with saved
filter restoration, in-place deep links, Reset and the Dashboard route.

## Review of `c697943`

| Area | Finding | Resolution |
| --- | --- | --- |
| Per-location semantics | The row predicate uses each row's availability against its own product's minimum, never a summed product value. Location, search, pagination and tenant scope were covered by tests. | Kept. The port preserves and extends that coverage. |
| API semantics | `needsAttention` was implemented as `available <= minimumStock`, exactly the existing broad `lowStock` predicate. The two chips therefore returned the same rows, and an out row is always also "low" under that predicate. | **Fixed.** Canonical `stockStatus=LOW_STOCK` is `0 < available <= minimumStock`; `OUT_OF_STOCK` is `available <= 0`; `needsAttention` is their union. The legacy broad `lowStock` flag remains for existing clients only. |
| Test quality | The mobile test mocked `{ all: 12, low: 7, out: 2, needsAttention: 9 }`, a shape the server could not produce because Low and Needs attention were identical. | **Fixed.** The screen test now uses the real disjoint semantics, and the server test computes all four counts from one fixture and checks each count against its filtered total. |
| Four chips at 360 dp | The layout wraps instead of shrinking or hiding a choice, but that had not been re-captured on a device. | Kept wrapping; counts are appended to each label. Device re-capture is complete: four counts render in two rows at 360 dp, every chip is 44 dp tall, and the selected state/banner total match the server. |
| Accessibility | Section headings and chip hints were a genuine improvement. | Kept (`SectionHeader` heading role, chip hints, polite live count). |
| Unnecessary code | The named-location effect existed only to write state after mount. | Replaced with a render-time derived id; the port also avoids an unfiltered first request while saved filters load. |

## Shipped in this follow-up

| Area | Change |
| --- | --- |
| API filter | `GET /api/inventory` accepts `stockStatus=LOW_STOCK|OUT_OF_STOCK` and `needsAttention=true`. Low and Out are disjoint; Needs attention is their exact union. Legacy `lowStock` remains broad and `outOfStock` remains row-local. |
| API counts | `includeCounts=true` returns `counts: { all, needsAttention, low, out }` from one scoped aggregate over the same search/location/product/status scope. Each total equals the `total` of the list opened by that choice; counts are independent of the page size. |
| Product-first fix | A request combining a product search/status with Out previously selected the product-first path and silently ignored the out predicate. The row-local predicate is now applied there, and the total and page agree. |
| Inventory screen | Four chips — **All**, **Needs attention**, **Low stock**, **Out of stock** — show the server counts and remain mutually exclusive. The selected banner keeps the API's filtered row total; All/Clear remove the status flag. |
| Dashboard | The existing product-level **View all → Restock list** link is unchanged. A full-width secondary action, **View stock rows needing attention**, opens `/inventory?needsAttention=true` whenever the summary reports low/out stock; it is omitted only when nothing needs attention. If the restock preview fails, the section keeps the summary counts, shows **Restock preview unavailable**, and retains the row-level action instead of disappearing. |
| Persistence | Each account's last location id and status token are stored in SecureStore under a digest of the user id. Route parameters win per dimension, including when a new deep link arrives while the screen is already mounted; an unspecified dimension restores. A saved location absent from the **complete** active list is ignored (All locations) and Reset remains available; an incomplete or failed list load preserves the saved location rather than treating it as deleted. Changing a filter clears the corresponding deep-link params, and **Reset filters** clears both and deletes the stored choice. |
| Search deep link | A `q` route sets the search field on first mount and when it arrives over the already-open screen. A route without `q` does not erase what the person typed. |
| Documentation | This record; the API contract in `SYSTEM_SPECIFICATION.md` §18–§19; roadmap §27KS; the development log. |

## Remaining ranked work

Value is 1–5; effort and risk are 1–5 (lower is better). **Score = 2 × Value − Effort − Risk**.
Nothing below was implemented when this record was written. The 2026-11-23 follow-up (§27LA) later
partly addressed rank 2; ranks 1 and 3–8 remain open.

| Rank | Improvement | Value | Effort | Risk | Score | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | **Act from an attention row.** Stock in, or add to a draft PO, pre-filled with product and location. | 5 | 3 | 3 | 4 | Reuse movement idempotency and existing permissions; stale quantities are the main risk. |
| 2 | **Freshness and loading states.** "Updated just now", a first-load skeleton and a visible retry that keeps prior rows. | 3 | 1 | 1 | 4 | The fetcher already retains prior rows; mostly presentation. |
| 3 | **Per-location Dashboard breakdown.** "Low at 1 of 3 locations" or the worst location beside the aggregate. | 4 | 3 | 2 | 3 | The product-level count can hide a shortage at one branch. Additive, not a replacement. |
| 4 | **Severity ordering.** Out before low, then largest shortfall, with a server-side sort. | 3 | 2 | 1 | 3 | Must stay server-side so pagination remains correct. |
| 5 | **Compact small-screen filters and shortcuts.** Two-across shortcuts or a filter sheet when more choices arrive. | 3 | 2 | 1 | 3 | Recover vertical space without removing STAFF routes or 44 px targets. |
| 6 | **Screen-reader and large-text pass.** TalkBack focus order, count announcements and the largest font. | 3 | 2 | 1 | 3 | The 360 dp visual capture is complete; TalkBack and the largest font still need a device pass. |
| 7 | **Edit minimum stock where it is explained.** Open the permitted product edit from "minimum N". | 4 | 3 | 2 | 3 | Often the correct answer to "why is this low?"; needs audit history. |
| 8 | **Stock-health trend and stocktake.** Seven/30-day counts, then cycle counting from the filtered rows. | 4–5 | 4–5 | 3–4 | 0–3 | Both need separate designs; stocktake depends on FW-03. |

## Acceptance checks used

- A row is filtered and counted with its own availability and its own product's minimum.
- `counts.low + counts.out === counts.needsAttention` on the server fixture.
- Each filtered list's `total` equals its chip count, including search, location, pagination and tenant
  isolation.
- Low never contains an out row; Needs attention contains both; legacy `lowStock` still does.
- Every status choice is mutually exclusive; All and Clear remove the status; Reset removes location
  and status and deletes the saved record.
- Route parameters win over the saved choice per dimension, on first mount and on a later deep link
  into the mounted screen; a later `q` route replaces the search field.
- A saved location is ignored only after every active-location page has loaded and the location is
  absent; a failed page or a total mismatch preserves the saved filter.
- Counts are fetched with the first page of the list response, not by four list requests; later pages
  reuse them.
- The 360 dp four-chip layout was device-captured: no clipping, 44 dp targets, four counts visible,
  and each selected chip's banner total matches its server count.
- The mounted-screen status/location and `q` deep-link transitions, saved-filter relaunch, Reset
  deletion, and Dashboard route were exercised on the CPH1969.
- The §27KX focused regressions cover a saved location on page 2 of **101** active locations, a
  failed page-2 load, and a failed restock preview that still offers the summary-backed row route:
  **3 suites / 15 tests, 0 failures**.

## Verification

- Server attention suite: **2/2 pass**; the archive-safe product stock suite **2/2 pass**; both files
  are registered in `server/scripts/run-tests.mjs`'s DB set.
- Phase 04 inventory regression: **20/20 pass**; stock-query shape guard: **7/7 pass**.
- Mobile focused Jest: **41/41 pass** across five suites (filters/counts, persistence, Overview,
  Dashboard action, paged-list count preservation). Lint and both typechecks pass.
- Server and mobile `tsc --noEmit`: pass.
- CPH1969, `com.inventoryai.app` 1.0.2 (versionCode 10), 1080 px / 480 dpi = **360 dp**: counts
  **622 / 311 / 311 / 0**, two-row wrapping with 44 dp chips, all four taps exercised; Demo Shop
  restored after force-stop; `?needsAttention=true` kept the saved location while changing status;
  a named Warehouse + Out link won both dimensions; Reset returned All / All locations and stayed
  cleared after relaunch; Dashboard row action opened 311 attention rows at All locations. A second
  `?q=Demo` link, delivered while Inventory was already open, changed the field from “Import Verify”
  to “Demo” and showed the matching empty search state.
- `check-docs` passes; the five documentation guard files pass **31/31**.
- No commit, push, merge, deployment or production data.

## Follow-up completion (2026-11-23, §27LA)

This later local session completed the reference-completeness and freshness work that this record
ranked, without changing the historical results above:

- The **complete active-location** rule now extends to every named picker and filter, not only
  Inventory: Movement, Transfer, PO form, Product form, Products/Restock filters and Restock → Draft
  PO. A failed later page preserves the options already read and keeps `complete` false.
- Rank 2 (**Freshness and loading states**) is **partly addressed**. The Dashboard summary, restock
  preview and open orders now have independent `loading`/`ok`/`error` states, timestamps and targeted
  retries; a retry keeps prior data and a failed preview still keeps the summary-backed row action.
  A literal **Updated just now** label and a first-load skeleton remain open.
- Saved or deep-linked locations, categories and PO suppliers are validated against the complete
  ACTIVE list. A missing reference is omitted from a filter/payload with a visible repair; forms block
  submission and a saved Draft PO attempt requires **Start over** rather than replaying an archived
  reference.
- Verification for this extension is in §27LA: mobile typecheck, focused ESLint, **14 suites / 95
  focused tests**, full mobile **125 suites / 1,419 tests**, `check-docs` and the five documentation
  guards **31/31**. No commit, push, merge, deployment or production data.
