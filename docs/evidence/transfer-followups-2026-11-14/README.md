# Reverse and refused transfers — 2026-11-14

Production server **`cb4fcf752c03fe138c8091761f6c2119fb6dfa9c`**. Tenant `rak gears`; product
`Phone Smoke Product` (`PHONE-SMOKE-20261115`, minimum stock 2). Only the two test locations were
used: `Phone Smoke Location` (source) and `Phone Smoke Location 2` (test-only destination).

This check used the production API, not the phone UI.

## Result

| Check | Expected | Observed |
| --- | --- | --- |
| Reverse transfer | Destination `2 → 0`; source `1 → 3` | **PASS** — both quantities and both response fields correct |
| Reverse ledgers | Exactly two `TRANSFER` rows, one per location | **PASS** — history grew from 8 to **10**; two rows share `SMOKE-TRANSFER-002` |
| Reverse total | Still 3 | **PASS** — dashboard total 3 before and after |
| Reverse duplicate delivery | Same key replays; no extra rows | **PASS** — `201`, same source and destination transaction ids, history stayed 10 |
| Same-location transfer | Refused; no stock change, no ledger row | **PASS** — `400 VALIDATION_ERROR`, `toLocationId must differ from fromLocationId` |
| Over-quantity transfer | Refused; no stock change, no ledger row | **PASS** — `409 INSUFFICIENT_STOCK` |
| Final stock | Source 3, destination 0, total 3 | **PASS** — exactly that |
| No negative stock | Both locations non-negative | **PASS** — 3 and 0 |

## Reverse transfer

Before the reverse, the source held **1** and the destination held **2**. A 2-unit transfer from
`Phone Smoke Location 2` back to `Phone Smoke Location` used reason
`Production reverse stock-transfer validation` and reference `SMOKE-TRANSFER-002`:

```text
Phone Smoke Location 2: 2 → 0
Phone Smoke Location:   1 → 3
Total:                  3 → 3
```

The same request was delivered a second time with the same idempotency key. It replayed the first
`201` response, including both transaction ids, and did not add any stock or ledger row.

Both ledger entries for `SMOKE-TRANSFER-002` were present:

| Location | Type | Quantity | Previous | New | Reference |
| --- | --- | --- | --- | --- | --- |
| `Phone Smoke Location 2` | `TRANSFER` | 2 | 2 | 0 | `SMOKE-TRANSFER-002` |
| `Phone Smoke Location` | `TRANSFER` | 2 | 1 | 3 | `SMOKE-TRANSFER-002` |

The dashboard stayed active **1**, in stock **1**, low **0**, out **0**, total on-hand **3**.

## Invalid transfers

**Same location.** A 1-unit transfer from `Phone Smoke Location` to itself was rejected with
`400 VALIDATION_ERROR`; the field error was on `toLocationId`:

> toLocationId must differ from fromLocationId

**Over quantity.** With **3 units** at the source, a 4-unit transfer to the destination was rejected
with `409 INSUFFICIENT_STOCK`.

Neither request changed source or destination quantity, and neither added a ledger row. History
stayed at **10** and the dashboard stayed at total **3**.

## Permanent integration coverage

The DB-backed transfer idempotency case in
[`server/test/INVENTORY-IDEMPOTENCY.test.mjs`](../../../server/test/INVENTORY-IDEMPOTENCY.test.mjs)
now pins the same behavior permanently:

- source decreases by exactly the moved quantity;
- destination increases by exactly the moved quantity;
- exactly two `TRANSFER` rows exist, one per location, with the correct previous/new arithmetic;
- both response transaction ids are replayed under the duplicate delivery;
- history does not grow on the second delivery;
- the source plus destination total is unchanged.

Focused command and result:

```bash
cd server
TEST_MODE=db node --test --test-name-pattern="writes both legs once" \
  test/INVENTORY-IDEMPOTENCY.test.mjs
```

**1 pass, 0 fail.** Full output: [`focused-test.log`](focused-test.log). ESLint on the test file
exited 0. The complete idempotency suite was also run: **10 pass, 0 fail**
([`idempotency-suite.log`](idempotency-suite.log)). The existing Phase 19 suite still covers the
same-location and insufficient-stock refusal paths.

## Production health

`GET /api/health` at 18:16Z reported `status: ok`, `db: connected`, environment `production`,
commit `cb4fcf752c03fe138c8091761f6c2119fb6dfa9c`, **0** server errors and **0** `5xx` responses.
`GET /api/health/ready` returned **200**. Complete bodies: [`health.json`](health.json) and
[`ready.json`](ready.json). Full production check output: [`result.json`](result.json).

## Limits

- Production checks were API-driven; no phone UI screenshot was captured.
- The focused test ran against `inventoryai_test_db`, not production.
- Final production fixture: source **3**, destination **0**, total **3**, history **10 movements**.
- The test-only destination remains active with no stock.
- No server runtime code, configuration, AI model or OTA changed; the permanent change is the test file.
