# FW-01 — Bulk CSV import and restock-to-draft-order: implementation record

**Status:** the CSV import path is committed on PR **#364** (`fix/overview-stock-filters`) and was
exercised on a physical Android development build on 2026-11-22 (section 4); it is **not merged,
deployed or OTA-published**. The draft purchase-order section remains local-only and is not part of
that PR. Planning and acceptance criteria remain in
[`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_DEV09.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_DEV09.md) §FW-01.
**Date:** 2026-11-21; timeout/resume follow-up 2026-11-22.

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
   file completes.
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

- The server re-reads the location-scoped restock list before creating anything.
- It computes the replenishment quantity from the current availability and the product's minimum; the
  client's quantities are **expected values**, not the source of the order quantity.
- If a row has moved, is no longer at/below its minimum, or its availability/minimum changed from the
  submitted snapshot, the request is refused with `409 RESTOCK_ROWS_STALE` and per-row `fields`.
  The mobile screen refreshes the list rather than submitting old numbers.
- Exactly one purchase order is created, always in `DRAFT`. There is no issue, send, mail, PDF or
  supplier-facing action in this path.
- A same-key retry replays the stored `DRAFT` order. A different key is a new request: because
  creating a draft does not move stock, the same rows can still be below their minimum and a second
  draft can be created. The server does not claim uniqueness on a restock selection; the client's
  operation key is the duplicate guard.

### Mobile

- `restock.tsx` shows **Create draft PO** to `purchase-orders.manage` users.
- `purchase-orders/from-restock.tsx` selects one supplier and one receiving location, loads that
  location's restock rows, allows per-row selection, and submits the selection. It shows a maximum of
  100 rows and states when more rows were omitted; narrowing the list is the supported path for a
  larger restock set.
- The screen never offers issue/send. Its footer says the order is created as a draft only.
- A stale-row answer clears the screen's operation key and refreshes the rows; resetting a changed
  selection is intentional.
- After an ambiguous timeout or 5xx, the screen keeps the key and locks the supplier, location and
  row selection. Only **Retry draft creation** can be pressed, so the retry fingerprint still matches
  the operation that may have landed. A definite 4xx clears the key; `IDEMPOTENT_REQUEST_IN_PROGRESS`
  does not.
- The draft attempt key lives for the screen session. A restart followed by selecting the same rows
  can create a second DRAFT; durable cross-restart resume still needs a persisted key for this kind.
  The server protects an in-flight retry with the same key.

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
- The operation key is not persisted in the device's Pending Operations store: the server receipt is
  the durable replay guard, and a fresh app launch cannot resume an import that has no stored request.
  This is a deliberate scope limit.
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
| `TEST_MODE=db node --test test/FW01-product-import.test.mjs` | **10/10 pass, 1 mode-skipped** parser suite; includes a >100 KiB CSV proving the route transport cap, durable-receipt replay with the transport row removed, a reserved product id recovered after the receipt landed before the create, a retry that fails validation after a completed row returning `409 IMPORT_PARTIAL`, tenant/RBAC status checks and a 90-second-old import claim that is **not** taken over |
| `TEST_MODE=db node --test test/FW01-draft-po-from-restock.test.mjs` | **5/5 pass**, including an explicit zero unit cost preserved on the draft line |
| `cd mobile && npm run typecheck` | pass |
| Mobile screen/flow, 2026-11-22 | Development APK `888d0228-0a9b-42cc-b32c-a0b91cb3c0f4` (1.0.2, versionCode 10) installed with `adb install -r`; picker, both previews, apply and the partial retry were exercised |
| Invalid CSV on the phone | 422 `IMPORT_VALIDATION_FAILED`, "Nothing was written", the row error and a request reference shown; server log 422 |
| Valid CSV on the phone | Preview 3 products / 3 opening-stock movements / 10 units; apply returned 201; alert "3 product(s) created; 3 opening-stock movement(s) recorded." |
| Partial retry on the phone | A 300-row import with a SKU conflict injected after validation produced a `PARTIAL` receipt (299 created, 0 stock, line 301); after the SKU was freed, the same file and key resumed to `COMPLETED` 300 created / 300 stock, and the replayed response showed "300 product(s) created; 300 opening-stock movement(s) recorded." The apply outlived the client timeout; the screen kept the key and the retry resumed. |
| Timeout → live progress on the phone (2026-11-22 follow-up) | A fresh 300-row file (`import-resume-1795341399.csv`, unique SKU prefix) previewed 300 products / 300 movements / 300 units. The apply at **09:59:54 UTC** outlived the 15 s budget; the screen showed the timeout message, locked the picker and polled `GET /api/products/import/op-mwro142n-rdl9ra4vw7e9hf1z`. The captured state at **10:00:16 UTC** was **84/300 products, 0 stock**; it completed at **10:04:28 UTC** with **300/300** and the alert "300 product(s) created; 300 opening-stock movement(s) recorded." Database proof: **300** products with the run prefix, **300** opening-stock transactions, receipt `COMPLETED` with 300 created / 300 stock — no duplicate. Screenshots: [`evidence/fw01-device-resume-2026-11-22`](evidence/fw01-device-resume-2026-11-22/README.md). |
| Repeat 300-row import on `f143252` (2026-11-22) | A second fresh 300-row file (`import-verify-1795349900.csv`, 42,427 bytes, new SKU prefix) was imported on the exact commit. Preview **300/300/300** at **11:50:49 UTC**; apply started **11:51:26 UTC**, timed out, progressed from **111/300 with 0 stock** to **300/300**, and completed by **11:54:32 UTC**. Receipt `COMPLETED` 300 created / 300 stock; **300 products, 300 unique SKUs, 300 transactions**, zero duplicate SKUs/products/receipt stock lines, and **0/300 deterministic-id mismatches** against `sha256("product-import:<receipt>:<line>").slice(0,24)`. Focused DB suite on `f143252` **9 pass / 0 fail / 1 mode-skip**; the current branch adds the partial-validation test and runs **10 pass / 0 fail / 1 mode-skip**. Evidence: [`evidence/fw01-f143252-reimport-2026-11-22`](evidence/fw01-f143252-reimport-2026-11-22/README.md). |
| Route inventory / authorization after the status route | `phase-docs-route-inventory` **11/11**; PR #364 route count is **129 / 72 gated / 24 authenticated / 33 public / 0 role-gated** |
| Q68 stress assertions | `node --test test/ai-stress-assertions.test.mjs` **21/21**; the expectation now derives LOW/OUT from the fixture summary instead of hard-coding the old count |
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
   **8/8**) and Q68 is fixed (**21/21**). The focused FW-01 suite passes **9/9 database tests with one
   mode-skipped parser suite**, including recovery of a product reservation that outlived its create.
3. Persisting import/draft-attempt keys in the existing account-scoped Pending Operations store is
   still future work. The import status endpoint now makes cross-restart resume technically possible,
   but the selected CSV itself is not retained across a restart.
4. No action needed for the mobile draft order's 100-row cap until a real tenant's restock list exceeds
   one page; then add pagination/selection across pages.
