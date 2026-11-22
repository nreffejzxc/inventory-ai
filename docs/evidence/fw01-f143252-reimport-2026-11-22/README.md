# FW-01 repeat 300-row import on `f143252` — device evidence (2026-11-22)

**Scope:** local development only. No push, deployment, OTA or APK publication, and no
production database access. The working tree was checked out at
`f14325298a07d4bdd4744a0d08e981dc0d30aa98` before this run. The backend used
`inventoryai_dev_db`; the phone reached it through `adb reverse tcp:4000 tcp:4000` and Metro
through `adb reverse tcp:8081 tcp:8081`.

## Device and build

- Physical device `PV4DDMIZZLTCIVSK` (CPH1969).
- Development build `com.inventoryai.app`, version **1.0.2** (versionCode **10**), EAS build
  `888d0228-0a9b-42cc-b32c-a0b91cb3c0f4`.
- Signed in as `demo-preview@example.invalid` (OWNER of the demo tenant).
- Server: `node src/index.ts` at `f143252`, development environment, database connected.
- Metro: `expo start --dev-client --localhost --port 8081 --clear`.

## Fixture

`import-verify-1795349900.csv`, pushed to `/sdcard/Download/`:

- **300 data rows**, 42,427 bytes.
- Names `Import Verify 1795349900 001…300`.
- SKUs `IV1795349900-001…300` (a fresh unique prefix, not used by the earlier 300-row run).
- Category `Keyboards & Mice`, currency `PHP`, opening location `Demo Warehouse`,
  opening quantity `1`, minimum stock `2`.

## What was observed

1. **Preview** at **11:50:49 UTC**: **300 data rows**, **300 products / 300 opening-stock
   movements / 300 units** ready to import. The preview `POST /api/products/import` returned
   **200**; no write is made by a dry run.
2. **Apply** tapped at **11:51:26 UTC**. The client stopped waiting after its 15 s budget while
   the server continued. The screen showed the timeout explanation, kept the file selected,
   replaced **Choose a different CSV** with **Finish this import first**, and switched to
   **Import in progress** with the same operation key.
3. **Progress** was polled from `GET /api/products/import/op-mwrs0iql-rb4b11wlmawo73v5`.
   The first captured state was **111 of 300 product rows created; 0 opening-stock movements**
   (first poll **11:51:41 UTC**). The saved progress screenshot shows **169 of 300** at the moment
   it was captured; at **11:52:32 UTC** the screen read **300 of 300 product rows created;
   33 opening-stock movements**.
4. **Completion**: the screen reached **“Import complete — 300 product(s) created; 300
   opening-stock movement(s) recorded.”** The final status poll was **11:54:32 UTC**; the apply
   started at 11:51:26, so it took roughly **3 minutes** end to end.

Screenshots:

- [`01-preview.png`](01-preview.png) — 300-row preview, ready to import.
- [`02-progress-timeout.png`](02-progress-timeout.png) — timeout message, locked picker,
  and **169/300** product progress.
- [`03-complete.png`](03-complete.png) — 300/300 completion alert.

## Deterministic-ID and duplicate proof

Read directly from `inventoryai_dev_db` after the run:

```json
{
  "receipt": {
    "id": "6b02d73e261dce601dce7497",
    "status": "COMPLETED",
    "totalRows": 300,
    "createdProducts": 300,
    "stockOperations": 300,
    "result": {
      "dryRun": false,
      "fileName": "import-verify-1795349900.csv",
      "totalRows": 300,
      "createdCount": 300,
      "openingStockCount": 300,
      "openingStockUnits": 300
    }
  },
  "products": 300,
  "uniqueSkus": 300,
  "duplicateSkus": 0,
  "transactions": 300,
  "duplicateTransactionProducts": 0,
  "duplicateReceiptStockLines": 0,
  "deterministicIdMismatches": 0
}
```

The check recomputed every expected id as
`sha256("product-import:" + receipt._id + ":" + line).slice(0, 24)` for lines **2…301** and
required the product `_id`, the receipt's `createdProducts` reservation, and the recomputed
value to agree. All **300** agreed; the first and last were
`c94b1f9a5b6e113b45a089a4` (line 2, SKU `IV1795349900-001`) and
`6296a01bc3860e48d726c0f4` (line 301, SKU `IV1795349900-300`). The receipt stock markers had
300 distinct line numbers, the 300 opening-stock transactions had 300 distinct products, and no
SKU appeared twice.

The focused DB suite was also run against `f143252`:

```text
TEST_MODE=db node --test test/FW01-product-import.test.mjs
tests 10, suites 2, pass 9, fail 0, skipped 1 (the parser suite's DB mode skip)
```

It includes **“applies products and opening stock once, then replays from the durable
receipt”** (the transport idempotency row is deleted before the replay) and **“recovers a
reserved product row when the receipt landed before the create”**. Those tests exercise the
crash/lost-ack recovery paths; this device run itself did not crash mid-apply.

## Limits

- This was one successful 300-row run on a local development backend, not a production or hosted
  deployment.
- The device run did not inject a crash or a partial failure. Recovery after a lost create
  acknowledgement is covered by the focused test above, not by killing the server during this
  device run.
- A fresh app launch does not retain the selected CSV or operation key; cross-restart resume
  remains future work.
