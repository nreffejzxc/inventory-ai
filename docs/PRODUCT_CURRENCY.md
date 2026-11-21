# Product currency and verified conversions

This document records the operational workflow behind the ISO 4217 product-currency rule and the
marketplace conversion boundary. The API and model are authoritative; this is the operator-facing
procedure.

## What is enforced

- A new product must carry a valid active-tender ISO 4217 code such as `PHP`, `USD` or `GBP`.
- `PATCH /api/products/:id` may omit `currency` while the stored row already has an exact valid
  code, and may repeat that same code. It cannot clear the field, and it cannot replace the code:
  an actual change is refused with `CURRENCY_CORRECTION_REQUIRED`. A legacy row with no valid code
  is resolved through the correction endpoint below, not an ordinary edit.
- A currency replacement uses `POST /api/products/:id/currency-correction` with the replacement
  code, a reason of 3–500 characters and the literal `"priceReconfirmed": true`. The endpoint may
  save corrected product fields (including prices) in the same operation and records
  `PRODUCT_CURRENCY_CORRECTED` with `previousCurrency`, `currency`, `reason`, `priceReconfirmed`
  and the changed fields. There is no automatic conversion and no inferred price.
- A price is never given a currency from its symbol, locale, tenant, marketplace or magnitude. A
  bare `$` remains `unknown` unless the marketplace itself proves a country-specific dollar.
- The assistant sees `sellingPrice` and `currency`; cost price stays internal accounting data.
- A marketplace conversion is attached only when the server fetched a dated ECB reference rate and
  the listing's currency and the recorded currency both match that pair.

The accepted list is in `server/src/constants/currencies.ts`; the mobile picker mirrors it in
`mobile/lib/currencies.ts`, and the regression suite fails if the lists drift.

### Controlled currency correction

An ordinary edit is currency-neutral. The dedicated correction is the only path that may change a
recorded code, and it requires the operator to re-check both stored prices against the replacement
currency before saving:

```http
POST /api/products/64f000000000000000000002/currency-correction
Authorization: Bearer <token>
Content-Type: application/json

{
  "currency": "USD",
  "costPrice": 12.5,
  "sellingPrice": 19.99,
  "reason": "Supplier invoice INV-100 is denominated in USD; both prices were rechecked",
  "priceReconfirmed": true
}
```

The route requires `products.manage` (OWNER, ADMIN or MANAGER) and is tenant-scoped. A correction
that repeats the existing code is refused with `CURRENCY_CORRECTION_NOT_APPLICABLE`; a missing
reason or reconfirmation is a field validation error. The mobile edit form detects a changed picker
value, collects the reason and shows the reconfirmation checkbox before calling this endpoint. The
resolver flow in §2–§3 remains the audited bulk path for legacy rows and writes its own
`PRODUCT_UPDATED` evidence per row.

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
- Concurrent lookups for the same pair share one in-flight provider request. A caller that joins a
  request is counted as `coalescedRequests`; it cannot start a duplicate fetch or record a second
  failure for one outage.
- A failure is negatively cached for **30 seconds**, doubling on repeated failures up to **5
  minutes**. During that window the pair returns `null` without calling the provider. A successful
  quote deletes the negative entry, so recovery is immediate; the cache is bounded to 256 pairs.
- A malformed date, a date too far in the future, a pair mismatch, an HTTP/network failure, a
  missing rate or a non-positive rate returns `null`.
- Only a single unambiguous listing price with a proven currency is convertible. Unknown/mixed
  listing currency, ambiguous multiple prices and a mismatched pair remain `currency-unverified`,
  `price-ambiguous` or `rate-unavailable`.
- A null conversion is reported as “no verified rate was available”; it is never replaced by a
  guessed number.

Monitoring is process-local since boot. `exchangeRateAvailability()` returns request, cache-hit,
negative-cache-hit, coalesced-request, verified, stale and unavailable counts, the last verified
date, and the last failure kind. Every failure emits one structured `[exchange-rates]` warning with
the pair and reason, never a credential or response body. The same snapshot is published by
`GET /api/health` under `exchangeRates`, beside the OPS-2 response counters. It contains aggregate
process state only — no tenant, product, request, URL or provider body. Its `status` is `unused`,
`available`, `degraded` or `unavailable`. The counters are not a cluster-wide metric and are not a
readiness gate:
`/api/health/ready` and `/api/health/live` do not read them, and an ECB outage must not make the
inventory service fail readiness. No conversion path or fallback rule changes because this field is
published.

### Product-list price sorting and filters

The ordinary product list (`GET /api/products`) does not accept a price sort or a price ceiling, so
it cannot compare raw numbers across currencies. Price comparisons are the assistant's
`findProducts` tool. That tool groups matching prices by their exact recorded ISO code (including a
`null` group for legacy rows) before ranking or applying a ceiling:

- a named ISO code scopes the comparison to that one currency;
- otherwise one unambiguous recorded currency is used automatically;
- mixed known currencies, or a known currency plus unrecorded prices, refuse the comparison and
  return `priceRankBlocked` / `priceFilterBlocked` with the observed `priceCurrencies` groups;
- a search with no matching products returns a plain empty result ("No products matched this search"), not a currency refusal;
- matches whose prices are all unrecorded return an empty blocked result rather than a zero or a guessed price.

Unrecorded prices are never ranked as zero. The same rule applies to the AI result rows and to the
underlying service guard that refuses a price sort or ceiling without exactly one recorded
currency. There is no conversion between product currencies in this path.

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
dates, missing rates, malformed pairs, network failure, single-flight coalescing, negative caching
and exponential recovery. The correction API is covered for a blocked ordinary change, a same-code
ordinary edit, a cross-tenant correction, the required reason/reconfirmation and the audit event.
The resolver CLI suite is database-free
and covers template output (including the 5,000-row warning),
dry-run, explicit apply, invalid arguments, test-database refusal, connection/evidence failures,
production confirmation and the documented `0/1/2` exits. The focused health suite proves the
`exchangeRates` snapshot is present on `/api/health` while `/ready` and `/live` remain unchanged.

**Complete-suite verification (2026-11-20).** After the 5,001-row case was added,
`npm test -- --test-concurrency=2` passed **3,314/3,314 tests across 538 suites**, with **0
failures, 0 skips and 0 cancelled**, exit **0**, duration **1,826,533.4359 ms**. The cap case itself
passed in **6,859.8979 ms**. The log recorded **107** transient `MongoDB connection lost` notices and
**106** reconnect messages, but **zero** `MongooseServerSelectionError` entries and no failed
assertions; the suite completed normally. No production data was read or written.

**Complete-suite verification (2026-11-21).** After the client/tool corrections described in §6,
`npm test -- --test-concurrency=2` passed **3,334/3,334 tests across 538 suites**, with **0 failures,
0 skips and 0 cancelled**, exit **0**, duration **1,877,787.3521 ms**. The first pass had one failure:
the AI-18 page-return count guard expected 17 and found 18 after the new empty-result path; the guard
was updated and the complete suite rerun. The log recorded **107** transient `MongoDB connection
lost` notices and **0** `MongooseServerSelectionError` entries. Server and mobile typecheck and the
focused mobile form tests (**6/6**) passed. No production data was read or written.

## 6. Ranked follow-up opportunities (reviewed 2026-11-20)

The explicit currency-change ceremony, currency-aware product sorting/filtering and bounded FX
single-flight/negative cache/backoff are now **implemented** (§27KR). The rows below preserve the
original proposal wording for traceability; rows marked **Implemented** are no longer open, and the
remaining rows are still proposals. Rank is value against effort and operational risk; dependencies
name the work that must land first. Six extend the §27KJ
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

### 2026-11-20 follow-up review — new ideas and revised order

The full-suite pass closed the verification gap. A code review found two concrete integrity gaps and
four additive ideas that were not in the original twelve. Rows 1, 2 and 5 are now implemented; the
remaining rows are still proposals.

| Rank | Improvement | Value | Dependency / guard |
| --- | --- | --- | --- |
| 1 | **Implemented (2026-11-20) — explicit currency-change ceremony.** A dedicated correction action records previous/new code, reason and explicit price reconfirmation; ordinary product edits are currency-neutral. | `PATCH` can no longer set a new code and a price together. The correction writes `PRODUCT_CURRENCY_CORRECTED` with the previous value and reason. | Product API, mobile edit flow and audit action; no automatic conversion or inferred price. |
| 2 | **Implemented (2026-11-20) — currency-aware product-list sort and price filter.** Comparisons group by recorded currency, refuse mixed/unrecorded groups and accept an explicit code. | A price ceiling or ranking no longer compares PHP with USD or with an unrecorded price. The ordinary list has no raw price sort; the AI tool carries the guarded comparison. | Assistant list tool, service guard and mobile form correction; no schema change and no silent conversion. |
| 3 | **Durable FX health and alerting (existing #1).** Persist availability/failure counts and alert when verified rates stop arriving. | Counters reset on restart and one instance can fail while another is healthy; an outage currently has no outside signal. | A small durable metrics store, retention and an alert owner; never a readiness gate or fallback rate. |
| 4 | **Conversion provenance snapshot (existing #2).** Store rate pair, provider, ECB date and exact value with each converted listing. | Reproduces why a displayed conversion existed after the cache expires; supports correction and audit. | Schema addition and a backfill decision; only dated ECB references. |
| 5 | **Implemented (2026-11-20) — FX single-flight, negative cache and bounded backoff.** Concurrent requests for one pair are coalesced; failures are cached for 30 seconds and back off exponentially to 5 minutes; success clears the negative entry. | A failed pair is no longer retried by every listing, and concurrent lookups no longer duplicate provider work. Verified quotes remain the only served values. | `exchangeRates` service and tests; short expiry, bounded failure cache, no stale quote served, explicit failure telemetry. |
| 6 | **Risk-ranked unresolved queue and resumable batches (existing #3, extended).** Rank legacy rows by active status, inventory value and price exposure, and track each 5,000-row batch, reviewer and conflicts. | The cap is safe but manual; operators need to know which batch matters first and what remains, rather than spending a batch on inactive low-value rows. | Durable review-status store, tenant-scoped audit, bounded operator API/UI; never auto-fill a currency. |
| 7 | **Money representation in minor units or Decimal128 (new).** Store prices and converted values as integer minor units or a decimal type, with the ISO exponent as display metadata. | JavaScript `Number` totals and conversions can accumulate rounding drift; a currency workflow should make exact minor-unit arithmetic the default. | Schema/model migration, DTO and mobile formatting, conversion arithmetic tests. This is larger than a display change. |
| 8 | **Currency-aware import and export (existing #5, extended).** Require a currency column on import and include code plus grouped totals on export; refuse cross-currency sums. | Bulk entry and downloaded reports are the easiest ways to bypass the boundary or present a misleading total. | Import contract/preview, export format and row-level errors; server remains authoritative. |
| 9 | **Supplier and purchase-order currency alignment (new).** Record supplier quote/PO currency and compare it with the product currency before receiving; a mismatch needs explicit review. | Purchasing can otherwise bring in stock under a different currency without the price/stock-value history making that clear. | Supplier/PO schema and receiving flow; no automatic conversion and no guessed supplier terms. |
| 10 | **Price review queue with effective dates (existing #4).** Add reviewed-at, source, effective date and a stale/unverified queue. | Detects old or unapproved prices before they affect margins, restock decisions and analytics. | Price versioning, migration and a review surface; never infer a price from a marketplace listing. |

The currency-change ceremony, currency-aware sorting/filtering and FX single-flight/negative cache
are implemented. The remaining new candidates are risk-ranked batches, minor-unit money
representation and supplier/PO alignment. Existing metadata, change-history, marketplace-evidence,
provider-failover, anomaly, multi-currency-analytics and audited-bulk-update items remain lower in
the original table. A tenant
default currency for the create form is a possible P3 convenience, but it must prefill only; the
server must never infer a code from the tenant.

No production data, migration or deployment is part of this workflow. A real resolution run needs a
reviewed file and the explicit production confirmation above.

### 2026-11-21 code-review pass — ranked next steps

The uncommitted currency changes were reviewed, typechecked and exercised by the complete server
suite. The review corrected two client/tool mismatches without changing the server contract: the
mobile edit form now sends `reason` and `priceReconfirmed` as top-level fields (the documented
endpoint shape) instead of a nested `currencyCorrection` object, and a price-ranked search with no
matches now returns a plain empty result instead of a currency-ambiguity note. Both safeguards are
unchanged. The items below are proposals only; none is implemented.

| Rank | Improvement | New? | Value | Dependency / guard |
| ---: | --- | --- | --- | --- |
| 1 | **Immutable currency and unit-price snapshots on purchase orders and stock movements.** Store the currency and the price actually used when the PO line or movement is created. | **New** | `unitCost` has no currency today, and inventory transactions store no price at all. Historical cost and stock-value reporting therefore depends on the product's *current* code, which a later correction reinterprets. | PO/inventory schema and migration; new writes snapshot, historical rows stay unknown rather than guessed. |
| 2 | **Dependency-aware currency-correction guard.** Detect open purchase orders, in-flight transfers or active marketplace listings that reference the product and require an explicit acknowledgement before the code changes. | **New** | A correction reinterprets every stored price number; downstream documents created under the old code can become misleading unless the operator confirms their treatment. | Existing PO/transfer/listing reads in the correction service; acknowledgement is audited, never automatic conversion. |
| 3 | **Durable, cross-instance FX health and alerting.** Persist the availability counters and alert when verified rates stop arriving. | Existing #1 | A restart erases the only evidence, and one instance can fail while another stays healthy. | A small metrics store, retention and an alert owner; never a readiness gate or fallback rate. |
| 4 | **FX rate age bands on every converted value.** Label the verified quote as fresh (≤24 h), recent (≤3 days) or old (≤7 days), with its exact rate date. | **New** | A seven-day-old rate currently looks identical to yesterday's; a visible band lets a reader discount a near-expiry conversion without changing the no-fallback rule. | Existing quote fields and cache; the band is display/selection metadata, never a new rate source. |
| 5 | **Correction evidence reference.** Let the correction record a supplier invoice, PO number or document reference alongside the reason. | **New** | The audit proves who/why but not what was checked; a bounded reference makes a later review reproducible. | Audit metadata only; validate length, never store a credential or attachment. |
| 6 | **Conversion rounding and display policy.** Define the rounding mode, minor-unit display and total-consistency rule. | **New** | Two conversions of the same amount can currently differ by display rounding, and a rounded total may not equal the sum of rounded rows. | A shared helper and tests; pairs with minor-unit/Decimal128 storage but is useful before it. |
| 7 | **Opt-in cross-currency comparison with provenance.** Rank or compare converted values only when a verified dated rate exists, showing both native and converted amounts plus the rate date. | **New** | Today cross-currency ranking is refused entirely; a labelled conversion would answer the question without ever silently adding unlike currencies. | Explicit user intent, one verified quote per pair, visible provenance; no fallback rate and no silent total. |
| 8 | **Supplier and purchase-order currency alignment.** Record the supplier quote/PO currency and compare it with the product currency before receiving. | Existing (2026-11-20 #9) | Purchasing can bring stock in under a different currency without the price history making that clear. | Supplier/PO schema and receiving flow; mismatch needs explicit review, never an inferred conversion. |
| 9 | **Money representation in minor units or Decimal128.** Store prices and converted values as integer minor units or a decimal type, with the ISO exponent as display metadata. | Existing (2026-11-20 #7) | `Number` totals and conversions can accumulate rounding drift. | Schema/model migration, DTO and mobile formatting; larger than a display change. |
| 10 | **Risk-ranked unresolved queue and resumable batches.** Rank legacy rows by active status, inventory value and price exposure, and track each 5,000-row batch, reviewer and conflicts. | Existing (2026-11-20 #6) | The cap is safe but manual; operators need to know which batch matters first and what remains. | Durable review-status store, tenant-scoped audit, bounded operator API/UI; never auto-fill a currency. |
| 11 | **Server-owned currency metadata endpoint.** Expose code, English name, symbol and minor-unit exponent from one server list. | Existing #6 | Removes mobile/server list drift and gives every client one source for display rules. | API contract and mobile adoption; no exchange-rate lookup involved. |
| 12 | **Audited bulk price updates with a currency guard.** Allow a reviewed batch price change while requiring the row's currency and a concurrency check. | Existing #12 | Makes legitimate corrections efficient without weakening the one-row audit trail. | Bulk API, optimistic version checks and per-row audit; no currency inference. |

**Why this order.** Snapshotting what was actually paid (1) and guarding corrections that affect open
documents (2) protect the meaning of historical money; without them a later FX or reporting feature
inherits ambiguous data. FX reliability (3–4) and correction evidence/rounding (5–6) are smaller,
self-contained additions. Converted comparison (7) and supplier alignment (8) expand what the system
answers and must wait for explicit provenance. Money representation (9) is the largest schema change
and is ranked below the controls that prevent new ambiguity.
