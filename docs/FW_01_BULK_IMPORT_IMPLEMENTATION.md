# FW-01 — Bulk CSV import and restock-to-draft-order: implementation record

**Status:** the CSV import path is committed on PR **#364** (`fix/overview-stock-filters`) and was
exercised on a physical Android development build on 2026-11-22 (section 4); it is **not merged,
deployed or OTA-published**. The draft purchase-order section remains local-only and is not part of
that PR. Its 2026-11-23 force-stop proof was run on an Android **emulator** development build after
the physical phone disconnected; section 4 and the evidence folder name the limitation explicitly. Open follow-up work is tracked in [`BACKLOG.md`](BACKLOG.md) §3.
**Date:** 2026-11-21; timeout/resume follow-up 2026-11-22; concurrency/partial-device follow-up
2026-11-22; import-draft lifecycle follow-up 2026-11-22; cleanup-read guard and durable Draft PO
resume 2026-11-22; import restore guard, durable DRAFT request key and device force-stop proof
2026-11-23.

---

## 1. Bulk product import

### API

```text
POST /api/products/import        OWNER or ADMIN
Body: { fileName: string, csv: string, dryRun: boolean }
Apply headers: Idempotency-Key: op-…

GET  /api/products/import/:key   OWNER or ADMIN
```

- `dryRun: true` validates and returns the row summary; it writes no product, no stock, no receipt.
- `dryRun: false` requires a valid `Idempotency-Key`. A retry with the same key and the same payload
  replays the stored result instead of creating a second catalogue.
- `GET /api/products/import/:key` returns the durable receipt's `status`, `fileName`, `totalRows`,
  created-product count, opening-stock count/units and row failures. It is scoped to the authenticated
  business and is `Cache-Control: no-store`; an unknown key and another tenant's key both answer
  `404 IMPORT_NOT_FOUND`. The mobile client polls it after an ambiguous timeout instead of blindly
  retrying.
- OWNER/ADMIN is deliberately narrower than `products.manage`. The check is server-side
  (`products.import`, held by OWNER and ADMIN), independent of the mobile button.
- Errors use the existing API envelope. Validation returns `422 IMPORT_VALIDATION_FAILED` with
  `errors: [{ line, field, message }]` and a matching `fields` list the mobile client already renders.
  An applied-then-stopped import returns `409 IMPORT_PARTIAL` with the lines already created and the
  exact rows still needing attention.

### Bounds and file format

- Maximum 512 KiB, 500 data rows and 30 columns. Because JSON escaping can expand the CSV,
  `POST /api/products/import` uses a dedicated 2 MiB transport body cap; every other route keeps the
  configured global cap (100 KiB by default), and the import validator still enforces 512 KiB.
- Dependency-free RFC 4180 parser: BOM, CRLF, quoted fields, escaped quotes and embedded newlines
  are supported; an unterminated quote or an over-limit file is refused with a line number.
- Required headers: `name`, `currency`.
- Optional headers: `sku`, `barcode`, `brand`, `description`, `specifications`, `category`, `unit`,
  `costPrice`, `sellingPrice`, `minimumStock`, `openingLocation`, `openingQuantity`, `imageUrl`.
- `currency` must be an ISO 4217 tender code; the importer uses the same product-currency contract as
  the ordinary create route.
- `openingLocation` and `openingQuantity` are one location+quantity pair per product row. An opening
  quantity without a matching location, a non-positive quantity, or an unknown location is a row error.
- Duplicate SKUs/barcodes are checked within the file and against the existing tenant. Archived
  products still own their SKU/barcode, so an import cannot collide with them silently.

### Write path and failure semantics

1. Validate every row first. A validation failure returns `422` and writes nothing.
2. Resolve categories and opening-stock locations inside the authenticated business only.
3. Reserve a deterministic product id in the receipt, then create the product through
   `productService.create` with per-product audit disabled. If the process dies between the receipt
   reservation and the product write, the same-key retry sees the reservation and creates that exact
   id; a lost create acknowledgement is checked against the same id. Receipt reservations use
   `$addToSet`, so a concurrent or lost-acknowledgement delivery of the same line cannot append a
   second copy of the reservation. One import-level `PRODUCTS_IMPORTED` audit is recorded after the
   file completes, using the shared `recordAuditOnce` key and the single-winner completion described
   below.
4. Apply opening stock through `inventoryService.stockIn` using a deterministic per-line receipt key.
   Each quantity has a stock transaction; no negative stock is possible. The receipt's stock marker
   also uses `$addToSet` for the same duplicate-progress reason.
5. The durable `product_imports` receipt stores the key, file name, created products, stock operations,
   failures and result. It is unique on `(businessId, key)`.
6. The import route's transport idempotency claim is held for **ten minutes**, not the default 60
   seconds. A 500-row import can run for several minutes; taking over its claim at 60 seconds would
   let a timeout retry start a second writer while the first was still creating products. A genuinely
   abandoned claim is still recoverable after the longer window.

Products are archive-only, so a runtime failure after some creates cannot delete what already exists.
The response is explicitly `IMPORT_PARTIAL`; retrying with the same key resumes only the missing
products and opening-stock lines. A validation error before any write remains a clean all-or-nothing
refusal. If a same-key retry no longer validates after earlier rows landed (for example because
another product claimed a later SKU), the response is `409 IMPORT_PARTIAL` with the completed
products and stock markers; it is never reported as “nothing was written.” This is the documented
partial-failure contract, not a silent success.

### Audit

`PRODUCTS_IMPORTED` / entity `PRODUCT_IMPORT` contains the file name, row counts, created product count,
opening-stock count and operator. It does **not** contain row contents, credentials or the raw CSV.
The audit carries `dedupeKey = product-import:<receiptId>:completed` and is written through
`recordAuditOnce`, so a concurrent finalizer or a recovery retry cannot append the same event twice.
The key is scoped to the business by a unique partial index.

The completion path also writes a durable `audit_outbox` row before the AuditLog insert and stores
`ProductImport.auditEnqueuedAt` once that row exists. A crash before the outbox write leaves a
completed receipt with no marker; a bounded `recoverProductImportAudits` scan re-enqueues it with the
same key. A crash after the outbox write leaves `PENDING`/`FAILED` work that `flushAuditOutbox`
retries; a stale `SENDING` claim is reclaimed after 60 seconds. This closes both the duplicate and
the missing-audit windows. The import response is never changed to a failure by an audit outage.

---

## 2. Draft purchase order from the restock list

### API

```text
POST /api/purchase-orders/from-restock     purchase-orders.manage
Body: {
  supplierId,
  locationId,
  items: [{ productId, availableQuantity, minimumStock }],
  notes?
}
Idempotency-Key required
```

- The header is enforced by the controller. A request without it answers `400
  IDEMPOTENCY_KEY_REQUIRED` before validation or any write; the key is the duplicate guard, not an
  optional retry convenience.
- The server re-reads the location-scoped restock list before creating anything.
- It computes the replenishment quantity from the current availability and the product's minimum; the
  client's quantities are **expected values**, not the source of the order quantity.
- If a row has moved, is no longer at/below its minimum, or its availability/minimum changed from the
  submitted snapshot, the request is refused with `409 RESTOCK_ROWS_STALE` and per-row `fields`.
  The mobile screen refreshes the list rather than submitting old numbers.
- Exactly one purchase order is created, always in `DRAFT`. There is no issue, send, mail, PDF or
  supplier-facing action in this path.
- A same-key retry replays the stored `DRAFT` order. The key and a canonical payload fingerprint are
  stored on the DRAFT, protected by a unique partial `(businessId, requestKey)` index. The service
  checks that durable row before allocating a PO number, so a retry still replays the DRAFT when the
  HTTP idempotency claim was lost after commit but before the response was recorded. Reusing the key
  with a different body answers `422 IDEMPOTENCY_KEY_REUSED`. A different key is a new request:
  because creating a draft does not move stock, the same rows can still be below their minimum and a
  second draft can be created. The server does not claim uniqueness on a restock selection; the
  client's operation key is the duplicate guard.

### Mobile

- `restock.tsx` shows **Create draft PO** to `purchase-orders.manage` users.
- `purchase-orders/from-restock.tsx` selects one supplier and one receiving location, loads that
  location's restock rows, allows per-row selection, and submits the selection. It shows a maximum of
  100 rows and states when more rows were omitted; narrowing the list is the supported path for a
  larger restock set.
- The screen never offers issue/send. Its footer says the order is created as a draft only.
- A stale-row answer clears the screen's operation key and refreshes the rows; resetting a changed
  selection is intentional.
- Before the first request, the screen persists the exact server body, operation key and timestamp in
  SecureStore under a digest of the account id (`lib/restockPurchaseOrderDraft.ts`). The stored body
  is authoritative: a resume never recomputes quantities from the current rows. Editing an
  unresolved attempt would change the request behind the same key, so supplier, location and row
  selection are locked until it is resolved or explicitly discarded.
- A cold reopen restores that record before the form is usable. **Resume draft creation** resends the
  identical body with the same key; a success clears the expected key and opens the new DRAFT. This
  removes the restart duplicate path where the old screen-session key was forgotten.
- A definite 4xx that ends the operation clears the expected key. An ambiguous timeout, 5xx or
  `IDEMPOTENT_REQUEST_IN_PROGRESS` keeps it. If the SecureStore read itself fails, the screen does
  **not** treat that as “no attempt”: it blocks draft creation and offers **Check saved attempt
  again**, because minting a new key there could create a second DRAFT.
- **Start over** confirms, checks Purchase orders first, removes the local saved record with its
  expected key, and returns to an empty selection. It never deletes a DRAFT on the server.

---

## 3. Mobile file import

- `mobile/app/(app)/products/import.tsx` uses `expo-document-picker` and `expo-file-system/legacy` to
  read a bounded CSV, requests a dry run first, shows the summary or the row errors, and only then
  offers **Import products**.
- Only OWNER/ADMIN sees the entry point (`canImportProducts`), matching the server role gate.
- The operation key is reused while the same selected file is retried. After an ambiguous timeout
  or 5xx the screen keeps the file and key, locks the picker, shows a progress card from
  `GET /api/products/import/:key`, and offers **Resume import**. A definite 4xx ends the attempt and
  re-enables the picker; `IDEMPOTENT_REQUEST_IN_PROGRESS` keeps it.
- If the status lookup answers `404` (the request never reached the receipt), the screen says so and
  offers the same-key resume instead of creating a new key.
- Before applying, the screen persists the file name, CSV and operation key. The metadata and key sit
  in SecureStore under a digest of the authenticated user id; the CSV sits in an account-digest
  app-sandbox directory (`lib/productImportDraft.ts`) because SecureStore is not a safe container for
  a 512 KiB file. **A new key is not sent when that save fails**; a restored key is already durable.
  A cold start restores the file and key, then asks `GET /api/products/import/:key`
  before offering any action. **The receipt controls resume, not a fresh dry run.** `PARTIAL` shows its
  recorded counts and **Resume import**; `IN_PROGRESS` polls; `COMPLETED` clears the draft and opens
  Products; `FAILED` shows the failures and a confirmed **Discard saved import**; a `404` or a failed
  status lookup keeps the same-key Resume visible with a plain explanation. Rows already applied can
  look like duplicate SKUs to a new dry run, so a dry run is not allowed to decide whether a saved key
  can resume. Clearing takes the expected key, so a late completion cannot delete a newer attempt. If
  the completed clear still fails after one retry, the screen keeps **Resume import** and explains that
  the local copy remains; it does not silently navigate.
- Draft lifecycle: each saved draft records `savedAt`; drafts older than **seven days** expire on load
  or mount cleanup. Cleanup also removes unreferenced CSV files and unreadable/expired metadata for the
  current account only. **Discard saved import** is available whenever a key is locked; it confirms,
  removes the device copy and operation key, and leaves the server receipt unchanged. Account deletion
  clears the account-scoped draft directory before sign-out. Ordinary sign-out preserves the draft
  for the same account, which is the point of cross-restart resume.
- A temporary SecureStore or CSV read failure is reported as `error`, not as `missing`. The screen
  keeps a **Check saved import again** action and disables the picker until the saved attempt can be
  verified; it never starts a new key merely because the keychain was locked or the file was briefly
  unreadable. Cleanup already aborts on the same states, and account deletion purges the CSV first, so
  this guard does not weaken either path. A genuinely absent, corrupt or expired draft still restores
  as `missing` and unlocks the picker.
- After an account switch the import workbench is remounted under the new account id, so the previous
  account's file, key, progress and in-flight poll cannot remain on screen. The saved draft is still
  account-digest scoped on disk; no other account can load or clear it.
- One completed import has one finalizer. The receipt's `COMPLETED` transition is a conditional
  single-winner claim; concurrent same-key service calls that both reach the end return one `201` and
  one replay, and only the winner appends `PRODUCTS_IMPORTED`. The loser reads the durable result
  instead of writing a second audit event.
- `expo-document-picker` and `expo-file-system` are native modules. Both are Expo SDK-pinned; the
  manifest uses the installed SDK's ranges and `.github/dependabot.yml` refuses routine updates to
  them, so they move only with a deliberate SDK upgrade. A development build containing both was
  installed on the physical phone for the 2026-11-22 device run (section 4); no OTA or APK was
  published.

---

## 4. Verification actually run

| Check | Result |
| --- | --- |
| PR #364 `cd server && npm run typecheck` | pass after integrating the import path with the stock-filter branch |
| PR #364 focused ESLint on changed server files | pass |
| `TEST_MODE=db node --test test/FW01-product-import.test.mjs` | **17 pass / 0 fail / 1 parser mode-skip**; includes a >100 KiB CSV proving the route transport cap, durable-receipt replay with the transport row removed, a reserved product id recovered after the receipt landed before the create, a retry that fails validation after a completed row returning `409 IMPORT_PARTIAL`, tenant/RBAC status checks, a 90-second-old import claim that is **not** taken over, the concurrent same-key HTTP regression, the terminal-receipt and late-progress regressions, the shared audit-dedupe race, and the direct service-level audit regression below |
| Concurrent same-key regression (2026-11-22) | **40 concurrent** duplicate calls to the receipt reservation and to the stock-progress write leave exactly **one** entry in each array; **2 parallel HTTP deliveries** of one 8-row file leave one `COMPLETED` receipt with 8 unique created lines/ids and 8 stock lines, 8 products, 8 inventory rows and 8 ledger transactions, and a transport-row-free replay stays at 8. A deliberate temporary change from `$addToSet` to `$push` made the focused helper test fail (**40 !== 1**); restoring it passed **1/1**. |
| Direct service-level audit regression (2026-11-22; hardened 2026-11-23) | An already-applied receipt was reset to `IN_PROGRESS` and two direct `productImportService.apply` calls raced with the same key and no transport row. Before the fix both calls returned **201** and wrote **two** `PRODUCTS_IMPORTED` audit rows. Receipt completion is now a conditional single-winner (`status: { $ne: 'COMPLETED' }`); one call returns **201**, the other **200 replayed**, and the database has **one** audit row, **one** completed receipt, two products, two inventory rows and two ledger rows. The audit row carries the deterministic `product-import:<receiptId>:completed` key. The full focused file is **17 pass / 0 fail / 1 mode-skip**. |
| Terminal receipt and late progress (2026-11-23) | Late `PARTIAL`, `FAILED` and `IN_PROGRESS` writes return `null` and leave `COMPLETED` plus its result/finishedAt intact. The product-reservation `$pull`, reservation `$addToSet` and stock-progress `$addToSet` all require `status != COMPLETED`, so a late writer cannot change the completed receipt's arrays. `receiptAfterCompletion` fails closed with `409 IMPORT_RECEIPT_STATE_CHANGED` if the receipt is absent or no longer completed instead of replaying a malformed result. |
| Shared audit dedupe (2026-11-23) | `recordAuditOnce` with 12 concurrent same-key calls leaves exactly one row and one id. The same key in a second business writes a second row. Two ordinary `recordAudit` calls with no key remain two rows. `AuditLog` declares a unique partial index on `(businessId, dedupeKey)`; `phase-index-integrity` and `OPS1` pass **24/24**. |
| Durable audit outbox (2026-11-23; extended) | `server/test/AUDIT-OUTBOX.test.mjs` **10/10**: completed-receipt repair, legacy-audit fence without duplication, re-run after a lost `auditEnqueuedAt`, crash-before-insert delivery, stale `SENDING` reclaim after the audit committed, `FAILED` retry, eight concurrent deliveries leaving one `audit_outbox` and one `AuditLog` row, movement and PO receive repair, a partial two-of-three-line PO replay plus concurrent recovery with one audit, and the declared DELIVERED TTL / FAILED triage indexes. |
| `TEST_MODE=db node --test test/FW01-draft-po-from-restock.test.mjs` | **6/6 pass**, including an explicit zero unit cost preserved on the draft line, a lost HTTP claim replayed from the DRAFT's own key, the unique request-key index, and a changed body refused with `422 IDEMPOTENCY_KEY_REUSED` |
| Draft PO force-stop and same-key resume (2026-11-23, emulator) | The debug development build submitted key `op-mwsquuwv-w7fgh5se445ud204`; a watcher force-stopped `com.inventoryai` at **04:06:48Z** as the request was logged. Cold relaunch restored the saved attempt with both rows selected; **Resume draft creation** sent the **same key and body** at **04:09:00.827Z**, got **201** at **04:09:01.094Z**, and `inventoryai_test_db` held exactly **one** DRAFT, `PO-0001` (3 × Gadget, 5 × Widget). No duplicate order or line. The physical CPH1969 was unavailable, so this is explicitly emulator evidence: [`evidence/draft-po-force-stop-2026-11-23`](evidence/draft-po-force-stop-2026-11-23/README.md). |
| Durable Draft PO resume (2026-11-22) | `restock-purchase-order-draft` **3/3** (cold restore and no raw account id, account isolation plus late-clear protection, read failure distinct from missing) and `draft-po-from-restock-resume` **3/3** (read failure blocks and retries, stored snapshot wins over changed rows, ambiguous 5xx restores the same key after reopen and clears only on success). Restock screen routing **2/2**; focused mobile batch **35/35**. |
| `cd mobile && npm run typecheck` | pass |
| Mobile screen/flow, 2026-11-22 | Development APK `888d0228-0a9b-42cc-b32c-a0b91cb3c0f4` (1.0.2, versionCode 10) installed with `adb install -r`; picker, both previews, apply and the partial retry were exercised |
| Invalid CSV on the phone | 422 `IMPORT_VALIDATION_FAILED`, "Nothing was written", the row error and a request reference shown; server log 422 |
| Valid CSV on the phone | Preview 3 products / 3 opening-stock movements / 10 units; apply returned 201; alert "3 product(s) created; 3 opening-stock movement(s) recorded." |
| Partial retry on the phone | A 300-row import with a SKU conflict injected after validation produced a `PARTIAL` receipt (299 created, 0 stock, line 301); after the SKU was freed, the same file and key resumed to `COMPLETED` 300 created / 300 stock, and the replayed response showed "300 product(s) created; 300 opening-stock movement(s) recorded." The apply outlived the client timeout; the screen kept the key and the retry resumed. |
| Timeout → live progress on the phone (2026-11-22 follow-up) | A fresh 300-row file (`import-resume-1795341399.csv`, unique SKU prefix) previewed 300 products / 300 movements / 300 units. The apply at **09:59:54 UTC** outlived the 15 s budget; the screen showed the timeout message, locked the picker and polled `GET /api/products/import/op-mwro142n-rdl9ra4vw7e9hf1z`. The captured state at **10:00:16 UTC** was **84/300 products, 0 stock**; it completed at **10:04:28 UTC** with **300/300** and the alert "300 product(s) created; 300 opening-stock movement(s) recorded." Database proof: **300** products with the run prefix, **300** opening-stock transactions, receipt `COMPLETED` with 300 created / 300 stock — no duplicate. Screenshots: `evidence/fw01-device-resume-2026-11-22`. |
| Repeat 300-row import on `f143252` (2026-11-22) | A second fresh 300-row file (`import-verify-1795349900.csv`, 42,427 bytes, new SKU prefix) was imported on the exact commit. Preview **300/300/300** at **11:50:49 UTC**; apply started **11:51:26 UTC**, timed out, progressed from **111/300 with 0 stock** to **300/300**, and completed by **11:54:32 UTC**. Receipt `COMPLETED` 300 created / 300 stock; **300 products, 300 unique SKUs, 300 transactions**, zero duplicate SKUs/products/receipt stock lines, and **0/300 deterministic-id mismatches** against `sha256("product-import:<receipt>:<line>").slice(0,24)`. Focused DB suite on `f143252` **9 pass / 0 fail / 1 mode-skip**; the current branch adds the partial-validation test and runs **10 pass / 0 fail / 1 mode-skip**. Evidence: `evidence/fw01-f143252-reimport-2026-11-22`. |
| Route inventory / authorization after the status and draft routes | `phase-docs-route-inventory` **11/11**; route count is **130 / 73 gated / 24 authenticated / 33 public / 0 role-gated** |
| Q68 stress assertions | `node --test test/ai-stress-assertions.test.mjs` **21/21**; the expectation now derives LOW/OUT from the fixture summary instead of hard-coding the old count |
| Import draft/resume tests (2026-11-22, extended 2026-11-23) | `product-import-draft` **9/9** (cold restore, account isolation, completion/newer-key protection, seven-day expiry, orphan cleanup without another account, transient cleanup preservation, an unreadable attempt distinguished from missing, metadata-delete purge, failed-purge metadata retention) and `product-import-resume` **12/12** (status-first restore with no dry run; restored PARTIAL counts and locked picker; status-lookup failure still offers Resume; FAILED receipt offers Discard; account switch clears the previous file; restored COMPLETED clears; a temporary read failure blocks the picker and Retry verifies the saved attempt before Resume; Retry confirming no draft unlocks a new import; a new-key save failure sends nothing; completed cleanup retries and keeps a truthful Resume state). Account-deletion screen **10/10** includes the draft purge assertion. The three focused mobile suites pass **31/31**; mobile typecheck and ESLint pass. |
| Import-draft lifecycle device proof (2026-11-22) | A disposable local owner account (0 products) previewed a 300-row file with 300 opening-stock rows at `Resume Warehouse`. A watcher archived that location as soon as product creation began. The phone showed **300 of 300 product rows created; 0 opening-stock movements**, the `IMPORT_PARTIAL` message, the locked picker and key `op-mws30ap3-c61h0sb4698evfcq`. A real `am force-stop` and dev-client relaunch restored `import-resume-verify-300.csv`, the saved key and the same partial counts; server requests after relaunch were `GET /api/products/import/op-mws30ap3-c61h0sb4698evfcq` only, with **no dry-run apply**. After `Resume Warehouse` was restored, **Resume import** completed **300/300 products and 300/300 stock movements**. Database read-back: **one** receipt (`COMPLETED`, 300 created, 300 stock, 0 failures), 300 unique created/stock receipt lines, 300 unique products/SKUs/names, 300 inventory rows (300 unique product+location pairs), and 300 ledger transactions (300 unique products, one reference). No duplicate. Evidence: `evidence/fw01-lifecycle-resume-2026-11-22`. |
| Partial import across a native force-stop (2026-11-22) | A 24-row file with 12 rows at Demo Warehouse and 12 at Demo Shop previewed cleanly. After the receipt appeared, Demo Shop was archived during product creation; the phone showed **24 of 24 product rows created; 12 opening-stock movements recorded**, the red `IMPORT_PARTIAL` message, **Finish this import first**, and a disabled picker. Force-stop and relaunch restored `partial-stock.csv` and the same key from SecureStore/sandbox; the partial counts reappeared, and **Resume import** remained available even though the restored dry run then failed on the archived location. This run predates the receipt-first change below: at that time restore still dry-ran; the current implementation does not dry-run on restore at all. After Demo Shop was restored, that same-key resume completed **24/24 products and 24/24 stock movements**. Database read-back: one `COMPLETED` receipt, **24 unique created lines/ids**, **24 unique stock lines**, **24 products**, **24 inventory rows**, **24 ledger transactions**, and `result.createdCount=24/openingStockCount=24/openingStockUnits=24`; no duplicate. |
| Earlier local-stack complete mobile suite (before PR #364 integration) | **114 suites / 1,337 tests pass** after the import and Draft PO changes and the Expo pin correction |
| Earlier local-stack complete server suite (before PR #364 integration) | **3,351 tests / 541 suites: 3,349 pass, 2 fail, 0 skipped**. Both failures were `OPS7` PLAT-1 fixed-window assertions immediately after the runner logged a lost MongoDB connection; an isolated `TEST_MODE=db` rerun passed **14/16 with 2 mode skips and 0 failures**. No FW-01 route or receipt assertion failed. The PR #364 focused import and filter checks are recorded in `DEVELOPMENT_LOG.md`. |

The parser suite is registered for the full (non-db) run. The focused DB suites cover tenant scope,
dry-run no-write, duplicate/row errors, one-key replay, opening stock, stale restock rejection, one
DRAFT order and no issue/send side effect. No production data, deployment or OTA/APK publish occurred.

---

## 5. Remaining work

1. ~~Build and install a native client and exercise the picker, preview, apply and partial retry~~ done
   on 2026-11-22. ~~A long import outlives the mobile request timeout, so it needs a status endpoint
   or a progress/resume UX instead of a bare timeout message~~ addressed by the status endpoint and
   polling/resume flow; the follow-up device run is recorded in section 4.
2. Merge the server work. The import path is now on PR #364; the earlier local-stack complete suite was run on 2026-11-22: **3,351 tests, 3,349 pass, 2 fail**.
   Both failures were `OPS7` PLAT-1 aggregation assertions immediately after a lost MongoDB connection;
   the same file passed **14/16 with 2 mode skips** when rerun alone, so this is a harness/environment
   sensitivity rather than an FW-01 regression. The earlier two audit-label gaps are fixed (parity
   **8/8**) and Q68 is fixed (**21/21**). The focused FW-01 suite passes **13/13 database tests with
   one mode-skipped parser suite**, including recovery of a product reservation that outlived its
   create, concurrent duplicate same-key deliveries, and the direct service-level audit race.
3. Import CSV/key persistence and its lifecycle are implemented for the product import (status-first
   restore, temporary-read guard, Discard, seven-day expiry, orphan cleanup, account-deletion purge).
   The Draft PO attempt is durable and account-scoped, and the server now replays the DRAFT from its
   own `requestKey` if the HTTP claim is lost. The 2026-11-23 force-stop proof is recorded in section 4;
   it is emulator evidence because the physical phone was unavailable, not a phone proof.
   The remaining ranked work is in [`BACKLOG.md`](BACKLOG.md) §3.
4. No action needed for the mobile draft order's 100-row cap until a real tenant's restock list exceeds
   one page; then add pagination/selection across pages.
