# Product currency and verified conversions

This document records the operational workflow behind the ISO 4217 product-currency rule and the
marketplace conversion boundary. The API and model are authoritative; this is the operator-facing
procedure.

## What is enforced

- A new product must carry a valid active-tender ISO 4217 code such as `PHP`, `USD` or `GBP`.
- `PATCH /api/products/:id` may omit `currency` only while the stored row already has an exact valid
  code. It can never clear the field, and an edit of a legacy row with no valid code must supply one.
- A price is never given a currency from its symbol, locale, tenant, marketplace or magnitude. A
  bare `$` remains `unknown` unless the marketplace itself proves a country-specific dollar.
- The assistant sees `sellingPrice` and `currency`; cost price stays internal accounting data.
- A marketplace conversion is attached only when the server fetched a dated ECB reference rate and
  the listing's currency and the recorded currency both match that pair.

The accepted list is in `server/src/constants/currencies.ts`; the mobile picker mirrors it in
`mobile/lib/currencies.ts`, and the regression suite fails if the lists drift.

## 1. Audit legacy rows (read-only)

```bash
cd server
npm run audit:product-currency
npm run audit:product-currency -- --format=json
npm run audit:product-currency -- --business=<24-hex-id>
```

The command is read-only, covers every product status, and exits:

- `0` — every product has a valid code;
- `1` — at least one row needs attention;
- `2` — not checked (bad arguments, no connection, test database or unreachable MongoDB).

The text report prints the first 50 samples. The JSON report carries the same sample set plus the
currency distribution. Neither output is a repair.

## 2. Prepare human-approved evidence

For a complete tenant set, print a review template (read-only):

```bash
cd server
npm run resolve:product-currency -- --template --business=<24-hex-id> --out=currency-review.json
```

The template includes only rows whose code is missing, empty or not an exact accepted code. Each row
starts with `expectedName` filled and `currency`/`evidence` blank. A human must:

1. verify the actual currency against a source (supplier invoice, signed price list, bank/contract
   record or another reviewable document);
2. fill `reviewedBy`, `reviewedAt` and `source` at the top level;
3. fill `currency` and the specific `evidence` note for every row;
4. remove any row that cannot be verified.

Do not infer a currency from a price, a symbol, a locale, a marketplace or the tenant's country.
`expectedName` is a typo guard; the resolver refuses a row whose recorded name does not match it.

The accepted shape is:

```json
{
  "version": 1,
  "businessId": "64f000000000000000000001",
  "reviewedBy": "Owner name / role",
  "reviewedAt": "2026-11-20T10:00:00.000Z",
  "source": "Supplier invoice pack 2026-11-19",
  "entries": [
    {
      "productId": "64f000000000000000000002",
      "expectedName": "Recorded product name",
      "currency": "PHP",
      "evidence": "Invoice INV-100 line 1"
    }
  ]
}
```

Validation rejects a missing approval, a non-ISO code, a duplicate product id, a blank evidence note
and more than 5,000 entries. The database is not consulted until the file validates.

## 3. Dry run, then apply

```bash
cd server
npm run resolve:product-currency -- --evidence=currency-review.json
npm run resolve:product-currency -- --evidence=currency-review.json --apply
```

The dry run is the default and writes nothing. `--apply` performs one conditional, PATCH-like update
per row. Production writes additionally require:

```bash
RESOLVE_PROD_CONFIRM=RESOLVE-PRODUCTION-CURRENCY
```

The test database is always refused.

### Idempotency and conflicts

| Current row | Requested code | Result |
| --- | --- | --- |
| missing / empty / malformed | valid, different from any valid value | `RESOLVED` on `--apply`, one `PRODUCT_UPDATED` audit row |
| already the requested exact code | same | `ALREADY_RESOLVED`, no write, no second audit row |
| a different exact valid code | any other code | `CONFLICT`, nothing overwritten |
| another tenant's product id | any | `NOT_FOUND`, nothing read outside the evidence tenant |
| name differs from `expectedName` | any | `NAME_MISMATCH`, nothing written |

The update filter re-checks that the row is still legacy, so a concurrent human edit wins. Rerunning
the same approved file is safe: resolved rows are no-ops and no duplicate audit events are written.

Every actual change writes an audit event with `updated: ["currency"]`, the previous and new code,
`reason: "legacy-currency-resolution"`, the evidence note and the reviewer/source metadata. Audit
writes are best-effort after the currency commit, matching the product service: a failed audit write
is logged and monitored as an audit gap, and the report marks that row with `[AUDIT GAP]`.

Exit codes are `0` when there is nothing unresolved, `1` when rows conflict or need review (including
a dry run that would change rows), and `2` when the command was not checked.

## 4. Exchange-rate cache and conversion availability

`server/src/services/ai/exchangeRates.ts` uses the keyless Frankfurter mirror of ECB daily reference
rates. It has no fallback rate.

- A verified quote is cached per `from:to` pair for **6 hours**.
- Every cache hit re-validates the ECB `rateDate`. A quote older than **7 days** is discarded, never
  served; the resolver then tries a fresh fetch. The seven-day window covers weekends and a normal
  public-holiday gap while still refusing an old rate.
- A malformed date, a date too far in the future, a pair mismatch, an HTTP/network failure, a
  missing rate or a non-positive rate returns `null`.
- Only a single unambiguous listing price with a proven currency is convertible. Unknown/mixed
  listing currency, ambiguous multiple prices and a mismatched pair remain `currency-unverified`,
  `price-ambiguous` or `rate-unavailable`.
- A null conversion is reported as “no verified rate was available”; it is never replaced by a
  guessed number.

Monitoring is process-local since boot. `exchangeRateAvailability()` returns request, cache-hit,
verified, stale and unavailable counts, the last verified date, and the last failure kind. Every
failure emits one structured `[exchange-rates]` warning with the pair and reason, never a credential
or response body. The counters are not a cluster-wide metric and are not a readiness gate: an ECB
outage must not make the inventory service fail readiness.

## 5. Verification

```bash
cd server
npm run typecheck
TEST_MODE=unit node --test test/currency-required-and-marketplace.test.mjs
TEST_MODE=db node --test test/currency-required-and-marketplace.test.mjs
```

The DB suite covers dry-run no-write behavior, a single audited resolution, rerun idempotency,
valid-code conflicts, cross-tenant refusal, name mismatches and evidence validation. The unit suite
covers cache reuse, expiry, stale dates, missing rates, malformed pairs and network failure.

No production data, migration or deployment is part of this workflow. A real resolution run needs a
reviewed file and the explicit production confirmation above.
