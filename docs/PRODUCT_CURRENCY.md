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

The template is capped at **5,000 rows**. If more unresolved rows exist, the command still writes a
valid template but prints a `WARNING: review template truncated at 5,000 rows` line to stderr.
Resolve that batch, then rerun `--template` for the next one. Never treat a truncated template as a
complete review of the tenant.

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
or response body. The same snapshot is published by `GET /api/health` under `exchangeRates`, beside
the OPS-2 response counters. It contains aggregate process state only — no tenant, product, request,
URL or provider body. Its `status` is `unused`, `available`, `degraded` or `unavailable`. The
counters are not a cluster-wide metric and are not a readiness gate:
`/api/health/ready` and `/api/health/live` do not read them, and an ECB outage must not make the
inventory service fail readiness. No conversion path or fallback rule changes because this field is
published.

## 5. Verification

```bash
cd server
npm run typecheck
TEST_MODE=unit node --test test/currency-required-and-marketplace.test.mjs
TEST_MODE=db node --test test/currency-required-and-marketplace.test.mjs
TEST_MODE=unit node --test test/CURRENCY-RESOLVER-CLI.test.mjs
TEST_MODE=unit node --test test/phase07d-production-config.test.mjs
```

The DB suite covers dry-run no-write behavior, a single audited resolution, rerun idempotency,
valid-code conflicts, cross-tenant refusal, name mismatches and evidence validation. It also creates
**5,001** real unresolved rows and proves the read returns exactly **5,000**, sets
`truncated: true` and excludes the extra probe row. The unit suite covers cache reuse, expiry, stale
dates, missing rates, malformed pairs and network failure. The resolver CLI suite is database-free
and covers template output (including the 5,000-row warning),
dry-run, explicit apply, invalid arguments, test-database refusal, connection/evidence failures,
production confirmation and the documented `0/1/2` exits. The focused health suite proves the
`exchangeRates` snapshot is present on `/api/health` while `/ready` and `/live` remain unchanged.

## 6. Ranked follow-up opportunities (not implemented)

These are proposals for a later increment. None are implemented by §27KL. Rank is value against
effort and operational risk; dependencies name the work that must land first. Six extend the §27KJ
list (durable telemetry, conversion provenance, resumable batches, price effective dates, anomaly
advice and audited bulk updates); the other six re-rank items already named there.

| Rank | Improvement | Benefit | Dependency / guard |
| --- | --- | --- | --- |
| 1 | **Durable, cross-instance rate health and alerting.** Persist the availability counters and alert when verified rates stop arriving. | A restart currently erases the only evidence, and one instance can fail while another stays healthy. | A small metrics store or aggregate, retention and an alert owner. Keep the signal informational; never gate readiness or invent a fallback rate. |
| 2 | **Conversion provenance on every converted listing.** Store the rate pair, provider, ECB rate date and the exact fetched value alongside the displayed conversion. | An operator can reproduce why a price was converted after the six-hour cache expires, and can audit a later correction. | A schema addition and a backfill decision for existing listings; keep the current “only dated ECB reference” rule. |
| 3 | **Resumable review batches and conflict triage.** Track the 5,000-row template batches, their reviewer, remaining rows and conflicts in an operator queue. | The current cap is safe but manual; large tenants need to know which batch is next and what was rejected. | A durable review-status store, tenant-scoped audit events and a bounded operator UI/API. Never auto-fill a currency. |
| 4 | **Price review queue with provenance and effective dates.** Give cost/selling prices a reviewed-at, source note and effective date, and surface stale or unverified rows. | Detects old or unapproved prices before they affect margins and analytics. | Price schema/versioning, migration and a review UI. Do not infer a price from a marketplace listing. |
| 5 | **Currency-safe CSV and bulk import validation.** Require an explicit currency column on imports and reject mixed-currency or bare-price rows with row-level errors. | Bulk entry is the easiest way to bypass the create/PATCH rule; validation keeps the invariant at the boundary. | An import contract and preview/error report; the server remains authoritative. |
| 6 | **Server-owned currency metadata endpoint.** Expose code, English name, symbol and minor-unit exponent from one server list. | Removes the mobile/server list-drift risk and gives every client one source for display rules. | An API contract and mobile adoption; no exchange-rate lookup is involved. |
| 7 | **Currency change history and controlled correction.** Make a currency correction a versioned event with previous/new value, reason, reviewer and an explicit rollback path. | Today the audit event records the change, but operators cannot easily review or reverse a mistaken resolution later. | A history query and retention policy; corrections must stay separate from normal product edits. |
| 8 | **Marketplace evidence hardening.** Prefer JSON-LD product/seller/variant fields, record the match method and flag listings whose evidence is stale. | Reduces wrong product matches and therefore wrong converted prices. | Parser/fixture work, fetch timeouts and cache limits; ambiguous evidence must remain unverified. |
| 9 | **Verified provider failover with a circuit breaker.** Add a second dated reference-rate source only when it meets the same provenance rules, with explicit source labelling. | Keeps conversion available during a Frankfurter/ECB outage without guessing. | A reviewed provider contract, parser tests and a new no-fallback policy. This is deliberately last because it expands the trust boundary. |
| 10 | **Advisory price anomaly detection.** Flag unusual cost/selling changes against product and category history for human review. | Catches typos and accidental decimal shifts earlier. | Enough history, a tenant-scoped baseline and false-positive review. Advisory only; never auto-edit a price. |
| 11 | **Explicit no-sum multi-currency analytics.** Report stock value by currency with the rate date and refuse to add unlike currencies into one total. | Prevents a headline total from silently mixing currencies. | Reporting queries and labels; reuse the existing conversion/provenance rules rather than a new rate cache. |
| 12 | **Audited bulk price updates with a currency guard.** Allow a reviewed batch price change while requiring the row's currency and a concurrency check. | Makes legitimate corrections efficient without weakening the one-row audit trail. | A bulk API, optimistic version checks and per-row audit; no currency inference. |

No production data, migration or deployment is part of this workflow. A real resolution run needs a
reviewed file and the explicit production confirmation above.
