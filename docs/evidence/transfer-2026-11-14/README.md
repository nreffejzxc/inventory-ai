# Stock-transfer production check — 2026-11-14

Production server **`cb4fcf752c03fe138c8091761f6c2119fb6dfa9c`**. Tenant `rak gears`; existing
product `Phone Smoke Product` (`PHONE-SMOKE-20261115`, minimum stock 2). The source was the
existing designated test location `Phone Smoke Location`; the destination was the new test-only
location `Phone Smoke Location 2`.

This check used the production API, not the phone UI, so it verifies the server's transfer path and
the production data it returns. No operational location was selected.

## Result

| Check | Expected | Observed |
| --- | --- | --- |
| Source before | 3 available | **PASS** — 3 |
| Destination before | No stock | **PASS** — 0 |
| Transfer | Source decreases, destination increases, same total | **PASS** — source `3 → 1`; destination `0 → 2` |
| Source ledger | One `TRANSFER` row, `−2` | **PASS** — previous 3, new 1, quantity 2, `SMOKE-TRANSFER-001` |
| Destination ledger | One `TRANSFER` row, `+2` | **PASS** — previous 0, new 2, quantity 2, same reference |
| No missing/duplicate movements | Exactly two rows for this reference | **PASS** — exactly two; history grew from 6 to 8 |
| Per-location availability | Source 1, destination 2 | **PASS** — both read back exactly |
| Total inventory | Unchanged at 3 | **PASS** — dashboard before 3, after 3 |
| Dashboard health counts | Unchanged | **PASS** — active 1, in stock 1, low 0, out 0 |
| Repeated delivery | Same key replays, no second pair of rows | **PASS** — 201, identical body, history stayed at 8 |
| No negative stock | Both locations non-negative | **PASS** — 1 and 2 |

## Before and transfer

Before the transfer, the product had **3 units** at the source, the destination had no inventory,
Inventory History had **6 movements**, and the dashboard read active **1**, in stock **1**, low
**0**, out **0**, total on-hand **3**.

The destination was created during the first attempt at this check. That attempt stopped at a
`400 VALIDATION_ERROR` before any transfer was applied: the one-off harness sent `undefined` as the
destination id after the location-create response returned `id` instead of `_id`. The destination
was left empty with no ledger history. The harness was corrected to use the returned `id` and the
check was rerun; the rerun reused that same test-only location. This was a harness defect, not a
server defect, and no stock moved during the failed attempt.

The verified transfer was **2 units** from `Phone Smoke Location` to `Phone Smoke Location 2`, with
reason `Production stock-transfer validation` and reference `SMOKE-TRANSFER-001`. The production
response stated:

```text
Source:      3 → 1
Destination: 0 → 2
Reference:   SMOKE-TRANSFER-001
```

The same request was delivered a second time with the same `Idempotency-Key`. It replayed the first
`201` response byte-for-byte and added no ledger rows.

## Both ledgers

Inventory History after the transfer contained **8 movements**, exactly two of them with
`SMOKE-TRANSFER-001`:

| Location | Type | Quantity | Previous | New | Reference |
| --- | --- | --- | --- | --- | --- |
| `Phone Smoke Location` | `TRANSFER` | 2 | 3 | 1 | `SMOKE-TRANSFER-001` |
| `Phone Smoke Location 2` | `TRANSFER` | 2 | 0 | 2 | `SMOKE-TRANSFER-001` |

There were no extra rows, no missing leg and no duplicate reference. The source and destination
rows are correlated by the same reference.

## Per-location availability and dashboard

The post-transfer inventory read-back returned:

- `Phone Smoke Location`: quantity **1**, available **1**;
- `Phone Smoke Location 2`: quantity **2**, available **2**.

The dashboard read active **1**, in stock **1**, low **0**, out **0**, total on-hand **3** — the same
total as before the transfer. This is the expected business-wide total: the transfer moved stock
between locations and did not create or remove any units.

## Production health

`GET /api/health` at 18:05Z reported `status: ok`, `db: connected`, environment `production`,
commit `cb4fcf752c03fe138c8091761f6c2119fb6dfa9c`, **0** server errors and **0** `5xx` responses.
`GET /api/health/ready` returned **200**. Complete bodies: [`health.json`](health.json) and
[`ready.json`](ready.json). The full check output is in [`result.json`](result.json).

## Limits

- The check was driven through the production API, not the phone UI; no app screenshot was captured.
- The destination was created by the first attempted run and reused after its empty preflight; it
  remains an active test-only location with the 2 transferred units.
- Final state: source **1**, destination **2**, total **3**, history **8 movements**.
- No code, configuration, AI model or OTA changed. The test location and transfer data remain as
  evidence.
