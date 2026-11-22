# FW-01 import timeout, status and resume — device evidence (2026-11-22)

**Scope:** local development only. No push, deployment, OTA or APK publication, and no
production database access. The backend used `inventoryai_dev_db`; the phone reached it
through `adb reverse tcp:4000 tcp:4000` and Metro through `adb reverse tcp:8081 tcp:8081`.

## Device and build

- Physical device `192.168.1.4:5555` (CPH1969).
- Development build `com.inventoryai.app`, version **1.0.2** (versionCode **10**), EAS build
  `888d0228-0a9b-42cc-b32c-a0b91cb3c0f4`.
- Signed in as `demo-preview@example.invalid` (OWNER of the demo tenant).
- Server: local `node src/index.ts`, development environment, database connected.
- Metro: `expo start --dev-client --localhost --port 8081 --clear`.

## Fixture

`import-resume-1795341399.csv`, pushed to `/sdcard/Download/`:

- **300 data rows**, 24,959 bytes.
- Names `Resume Batch 1795341399 001…300`.
- SKUs `RT1795341399-001…300` (unique prefix chosen for this run).
- Category `Keyboards & Mice`, currency `PHP`, opening location `Demo Warehouse`,
  opening quantity `1`.

## What was observed

1. **Preview:** the phone reported 300 data rows and
   **300 products / 300 opening-stock movements / 300 units** ready to import. No write
   had occurred at this point.
2. **Apply:** the request was started at **09:59:54 UTC**. The warm client budget is 15 s,
   so the client stopped waiting while the server continued.
3. **Timeout state:** the screen showed
   “The request timed out before the server answered. The import may still be running;
   progress will appear below, or press Resume import to finish the same file.”
   The file remained selected, **Choose a different CSV** became **Finish this import
   first** and was disabled, and the key was retained.
4. **Progress:** the screen switched to **Import in progress** and polled
   `GET /api/products/import/:key`. The captured state at **10:00:16 UTC** was
   **84 of 300 product rows created; 0 opening-stock movements**. The server logged the
   status requests (200) every ~3 s.
5. **Completion:** the screen reached **300 of 300 product rows created; 300
   opening-stock movements** and displayed **“300 product(s) created; 300 opening-stock
   movement(s) recorded.”** The final status poll was at **10:04:28 UTC**.
6. **After OK:** the Products screen rendered the imported rows, starting with SKU
   `RT1795341399-300`, and the picker was usable again.

## Duplicate check

Direct database count after completion:

```text
products     300   (businessId of the demo tenant, sku /^RT1795341399-/)
transactions 300   (reference "CSV import: import-resume-1795341399.csv")
receipt      COMPLETED, totalRows 300, createdProducts 300,
             stockOperations 300, result.createdCount 300,
             result.openingStockCount 300
```

No second import key or second catalogue was created. The focused FW-01 database suite
additionally deletes the transport idempotency row and replays the same key, proving the
durable receipt returns the original result without inserting products or transactions
again (`server/test/FW01-product-import.test.mjs`).

## Screenshots

- [`11-preview-small.png`](11-preview-small.png) — 300-row preview, ready to import.
- [`12-progress-small.png`](12-progress-small.png) — timeout message, locked picker and
  **84 of 300** progress.
- [`13-complete-small.png`](13-complete-small.png) — 300/300 completion alert.
- [`14-products-small.png`](14-products-small.png) — imported products in the catalogue.

## Limits

- The run used the local development backend, not production or a hosted deployment.
- A fresh app launch does not retain the selected CSV, so the status endpoint can support
  cross-restart resume only after the file/key are persisted; that is still future work.
- The draft-PO screen's ambiguous-retry lock was typechecked and its server suite passed,
  but it was not exercised on this device in this run.
