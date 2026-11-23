# FW-01 import-draft lifecycle and native restart proof — 2026-11-22

**Scope:** local development only. No commit, push, merge, deployment, production database access,
OTA or APK publication. The backend used `inventoryai_dev_db`; the CPH1969 reached it through
`adb reverse tcp:4000 tcp:4000` and Metro through `adb reverse tcp:8081 tcp:8081`.

## Device and build

- Physical device CPH1969 (`PV4DDMIZZLTCIVSK`), 1080x2340 at 480 dpi.
- Development build `com.inventoryai.app`, version **1.0.2** (versionCode **10**).
- A disposable local OWNER account with **0 products** and no locations.
- Server: local `node src/index.ts`, development environment, `inventoryai_dev_db`.
- Metro: `expo start --dev-client --localhost --port 8081`.

## Fixture

`import-resume-verify-300.csv`, 16,850 bytes:

- 300 data rows, names `Resume Verify 001…300`.
- SKUs `RV20261122-001…300`, currency `PHP`.
- Opening location `Resume Warehouse`, quantity `1` per row.

`Resume Warehouse` was created ACTIVE for this run. The file was pushed to
`/sdcard/Download/` and selected through the Android document picker.

## What was observed

1. **Preview:** the phone reported **300 data rows**, **300 products**, **300 opening-stock
   movements** and **300 units**. No products or stock existed yet.
2. **Partial apply:** after the apply started, a database watcher archived `Resume Warehouse` as
   soon as the first products appeared. The receipt became `PARTIAL` under key
   `op-mws30ap3-c61h0sb4698evfcq`, and the phone showed:
   - `Import partly applied`
   - **300 of 300 product row(s) created; 0 opening-stock movement(s) recorded.**
   - the locked picker, **Finish this import first**, **Resume import**, and **Discard saved import**.
3. **Force-stop and relaunch:** `adb shell am force-stop com.inventoryai.app`, then the dev-client
   deep link and `inventoryai://products/import`.
4. **Restore:** the phone showed `import-resume-verify-300.csv`,
   `Saved import · same operation key`, the same `PARTIAL` counts and the same **Resume import**
   action. Server logs after relaunch contained
   `GET /api/products/import/op-mws30ap3-c61h0sb4698evfcq` only — **no dry-run apply request**.
5. **Resume:** `Resume Warehouse` was restored to ACTIVE and **Resume import** was pressed. The
   receipt progressed through `IN_PROGRESS` and reached **COMPLETED** with
   **300/300 products and 300/300 stock movements**. The alert read
   `300 product(s) created; 300 opening-stock movement(s) recorded.`; dismissing it opened Products,
   which listed `Resume Verify 300` and the rest of the rows.

## Database read-back

```text
receipts              1
key                   op-mws30ap3-c61h0sb4698evfcq
status                COMPLETED
createdProducts       300 (300 unique)
stockOperations       300 (300 unique)
failures              0
products              300 (300 unique ids, SKUs and names)
inventory             300 (300 unique product+location pairs)
inventory_transactions 300 (300 unique products, one reference:
                       CSV import: import-resume-verify-300.csv)
```

One receipt and one set of rows: no duplicate catalogue, inventory row or ledger movement. No
`POST /api/products/import` dry run occurred after the relaunch; the saved key drove the status
lookup and the same-key resume.

## Focused checks

- `mobile/__tests__/product-import-draft.test.ts` **5/5** — cold restore, account isolation,
  completion/newer-key protection, seven-day expiry, orphan cleanup.
- `mobile/__tests__/product-import-resume.test.tsx` **7/7** — status-first restore with no dry run,
  PARTIAL counts and locked picker, status-failure Resume, FAILED Discard, account switch, COMPLETED
  cleanup.
- `mobile/__tests__/account-deletion.test.tsx` **9/9** — includes the account-scoped draft purge.
- Mobile focused batch **21/21**; mobile typecheck and focused ESLint pass.
- `PRODUCTS-stock-status-active.test.mjs` **2/2**; server typecheck and focused ESLint pass.
- `git diff --check` passes.

## Cleanup and limits

The 300-row catalogue, its inventory/ledger rows, the `COMPLETED` receipt, `Resume Warehouse`, the
pushed CSV and the local `.smoke` fixture were removed after read-back. The disposable account and
its login were left in place; no production or remote environment was touched.

The proof forced the partial state by archiving the opening location; it did not replay a crash
between an arbitrary product write and its receipt update. Discard, expiry, orphan cleanup and
account-deletion purge were verified by focused tests, not through the device UI. The proof is one
Android build and one account.
