# Five implementation plans — FW-04, FW-07, FW-05, reversal and supplier terms

**Status:** planning only for FW-04, FW-05, linked reversal and supplier terms. **FW-07 is implemented
mobile-only in §27KD (2026-11-19); this document remains its approved plan.** Nothing else in this
document authorizes code, a schema change, a migration, a production data or configuration change,
an email, or a deployment.

**Reviewed:** 2026-11-19.
**Basis:** the tree at `c2685eb`; the unmerged FW review in PR #355 at `2e7a528`
(`docs/PLATFORM_NEXT_IMPROVEMENTS_BEYOND_DEV09.md`); and the code paths cited below.
**Authority:** `docs/SYSTEM_SPECIFICATION.md` remains the behaviour authority. This document records
plans and the code facts those plans must respect.

> **FW-04 correction.** PR #355's FW-04 text says "ISSUED" and "partially received orders". Neither is
> a purchase-order status in this tree. The actual statuses are `DRAFT`, `OPEN`, `RECEIVED` and
> `CANCELED`; a partial receipt stays `OPEN`; and there is no PDF generator or mail-attachment
> capability to reuse. Section 1 is the corrected scope and supersedes that paragraph. PR #355 should
> not be merged with the uncorrected FW-04 text.

## 0. What the review established

| Claim in the earlier review | Code fact in this tree |
| --- | --- |
| A PO can be `ISSUED` | `PURCHASE_ORDER_STATUSES` is `['DRAFT', 'OPEN', 'RECEIVED', 'CANCELED']` (`server/src/models/purchaseOrder.model.ts`). `issue()` moves `DRAFT → OPEN` and records `PURCHASE_ORDER_ISSUED`; the status itself is `OPEN`. |
| A PO can be `PARTIALLY_RECEIVED` | No such status. `receive()` accepts only `OPEN`; each line increments `quantityReceived` and `quantityCommitted`; the order remains `OPEN` until every line is complete, then flips to `RECEIVED`. A partial receive is therefore `status: 'OPEN'` plus at least one `quantityReceived > 0`. |
| A server PDF can be generated | No PDF library, generator, template, `res.download`, `res.attachment` or `res.sendFile` exists in `server/src/`. |
| The mail boundary can attach a document | `MailMessage` is exactly `{ to, subject, text, html }` (`server/src/services/mail/providers/index.ts`), and the Brevo payload sends only `sender`, `to`, `subject`, `htmlContent` and `textContent` (`brevoProvider.ts`). There is no attachment field. |
| Reversal is a delete/undo of a ledger row | There is no public reversal path. `purchase-orders.service.ts` has an internal, receipt-specific `undoStockInMovement` used only to compensate a lost finalize; it deletes the row/transaction/audit and is not a general feature. |

These facts change FW-04 from a small route into a dependency-bearing change, and they make the
reversal plan a new compensating-ledger design rather than an "undo" button.

## 1. FW-04 — Purchase-order transmission (corrected)

### 1.1 Goal and non-goals

**Goal.** From an `OPEN` purchase order — including one that has been partly received — generate a
bounded PDF of the stored order and email it to the supplier's stored address through the existing
Brevo boundary. Record the recipient, time and provider message id on the order. Resending is an
explicit action.

**Non-goals.** No new PO status, no automatic status change, no supplier response inference, no
automatic ordering, no supplier portal, no storing the PDF, no sending from an unconfirmed client
address, and no change to receiving.

### 1.2 Current code facts the implementation must use

- Status values and transitions are in `server/src/models/purchaseOrder.model.ts` and
  `purchase-orders.service.ts`. `issue()` is `DRAFT → OPEN`; `receive()` rejects `DRAFT` with
  `PO_NOT_ISSUED`, rejects `RECEIVED` and `CANCELED`, and accepts only `OPEN`.
- `itemPublic()` and `totalsOf()` already compute ordered, received, remaining and estimated cost from
  the stored lines. The PDF must use those stored values, not a client body.
- `purchaseOrderSchema` currently has `items`, `receipts` and `claims`; there is no transmission
  record.
- The supplier is loaded by `fetchPo()` with `name` and `status` only. `email` is stored on the
  supplier model (`supplier.model.ts`) and is optional; `validateSupplier()` validates it when present.
  The implementation must add `email` to that projection (and to the send path's supplier read); it is
  not available in the current DTO.
- `recordPoAudit()` records a PO event but deliberately swallows an audit failure after a durable PO
  change. The transmission record must follow the same rule.
- `idempotent()` exists and is already used on PO create and receive. It is appropriate for a send
  request, but it is not a substitute for a unique data guard because the external send is not
  transactional with MongoDB.

### 1.3 Eligibility and recipient rules

1. Load the PO with `{ _id, businessId }` — never a client business id.
2. Allow only `status === 'OPEN'`.
   - `DRAFT` → `409 PO_NOT_OPEN` ("Issue the purchase order before sending it").
   - `RECEIVED` → `409 PO_ALREADY_RECEIVED`.
   - `CANCELED` → `409 PO_CANCELED`.
3. A partially received order is allowed because it is still `OPEN`. The PDF states the ordered,
   received and remaining quantities per line. Do not invent an `ISSUED` or `PARTIALLY_RECEIVED`
   status to make this check readable.
4. Use the supplier's stored `email`; do not accept an arbitrary `to` from the client. If it is empty
   → `409 SUPPLIER_EMAIL_MISSING`; if it fails the same `EMAIL_RE` used by `validateSupplier()` →
   `409 SUPPLIER_EMAIL_INVALID`. The address is displayed in the confirmation UI before sending.
5. An archived supplier does **not** block sending an existing open order; the order was validly
   created before archiving. The UI shows "Archived supplier" and the send still uses the stored
   address. Re-validating with `assertOperationalSupplier()` would wrongly turn archive into a
   transmission failure. New orders still cannot use an archived supplier.

### 1.4 Data additions

Add an append-only `transmissions` array to the purchase order:

```text
transmissions: [{
  sentAt: Date,              // server time, after the provider returns a message id
  userId: ObjectId,          // the authenticated sender
  to: String,                // supplier address actually used
  messageId: String,         // provider message id (nullable only if the provider omitted one)
  kind: 'INITIAL' | 'RESEND',
  partial: Boolean,          // true when any quantityReceived > 0 at send time
  itemCount: Number,
  quantityOrdered: Number,
  quantityReceived: Number,
  quantityRemaining: Number
}]
```

No new status. The array is history; the latest entry is the displayed "last sent" record. Do not
store the PDF bytes or a generated link. Keep the address out of application logs; the PO record is
the authoritative place for it.

Add `PURCHASE_ORDER_SENT` to `AUDIT_ACTIONS` and audit with the PO entity, `number`, `messageId`,
`kind`, `partial`, `itemCount` and `supplierId`. Do not put the address or PDF content in the audit
metadata.

### 1.5 API and permissions

`POST /api/purchase-orders/:id/send`

- `requireAuth`, `requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE)`; sending is a procurement
  action, not a receiving action. `STAFF` does not hold this permission.
- `idempotent()` on the route; the mobile client sends one stable key per explicit send action.
- No recipient in the body. The only accepted body is absent or `{}`.
- Response: the updated PO detail plus the new transmission (or `{ po, transmission }`; choose one
  and pin it in the contract test). A send failure returns a stable `409`/`502`/`503` and leaves the PO
  unchanged.
- Add a small per-user send limiter beside the route. The exact window is a review decision; a
  reasonable starting point is 10 sends per 15 minutes per authenticated user, with the provider's
  own errors still surfaced. Do not add a new environment variable unless the limiter needs to be
  tuned in production.

### 1.6 PDF generation — a prerequisite, not an existing capability

There is no PDF generator. The implementation needs **all** of the following before the route can
ship:

1. **A PDF writer.** The project has no PDF dependency. A pure-JavaScript writer such as `pdf-lib`
   is the smallest fit for a table of text; it is a new server dependency and needs the normal
   dependency-review approval. Do not add it as part of this documentation phase.
2. **A font that covers tenant names.** `pdf-lib`'s standard Helvetica is WinAnsi-only; a product or
   supplier name outside that encoding would throw or be silently replaced. Either bundle a licensed
   Unicode font (for example Noto Sans, OFL) with the necessary font-kit support, or make the
   documented scope "ASCII-only PDF" and reject/flags unsupported text. The recommended choice is a
   bundled font; silently replacing characters is not acceptable for a purchasing document.
3. **A bounded renderer.** `validatePurchaseOrder()` already caps a PO at 200 items
   (`PO_ITEMS_MAX = 200`). The renderer must paginate up to that cap, cap the generated bytes at
   1 MiB, and return `409 PO_TOO_LARGE_TO_SEND` rather than exhausting memory. No images, no remote
   assets, no HTML rendering service.
4. **A tested layout.** Header: PO number, issue date, supplier name/contact/address fields that are
   stored, ship-to location, expected date. Table: product, SKU, ordered, received, remaining, unit
   cost, line total. Totals: ordered quantity, received quantity, remaining quantity, estimated cost,
   and the currency caveat if line currencies are not stored (the PO has unit costs but no currency
   field; do not invent one). Footer: page number and "Generated by Inventory AI".
5. **A clear partial-receipt presentation.** For an `OPEN` order with receipts, the PDF must say
   "Partially received" and show the remaining quantities; sending the original quantities alone
   would invite a supplier to deliver the whole order again.

If any of these cannot be approved, the honest fallback is an HTML order email (no PDF) with a
renamed scope; it is not "FW-04 complete". Do not ship a PDF that silently drops non-ASCII text or a
send path that cannot record what was sent.

### 1.7 Mail attachment support — also missing

Extend the mail boundary, not the Brevo call site:

```text
MailAttachment { filename: string; contentBase64: string; contentType: 'application/pdf' }
MailMessage { to, subject, text, html, attachments?: MailAttachment[] }
```

- The Brevo provider maps the one attachment to Brevo's `attachment` array
  (`name`, `content`); no other provider is added.
- Enforce exactly one attachment, PDF only, decoded size at most 1 MiB before the provider call.
- Keep the existing request timeout and safe error mapping. `MailNotConfigured` becomes
  `503 PO_EMAIL_NOT_CONFIGURED`; `MailDeliveryError` becomes `502 PO_SEND_FAILED`; never relay the
  provider body or the recipient address in the error.
- Add the fake provider capture in tests; no live email is sent by the automated suite.

### 1.8 Send flow and failure handling

1. Load and validate the PO and supplier address.
2. Render the PDF in memory from the stored lines.
3. Send through `selectProvider().send()` with the single attachment.
4. On success, append the `transmissions` entry to the PO with a tenant-scoped update
   (`{ _id, businessId }`). Do not include `status: 'OPEN'` in that update: a concurrent receive may
   legitimately flip the order while the email is in flight, and the send still happened. The status
   check at step 1 decides eligibility; the record must not be lost because the order moved on.
5. Return the fresh PO detail.

- A failure before the provider returns leaves the PO unchanged and writes no success audit.
- If the provider returns an id but the PO update fails, the email has already been sent. Log a
  reconciliation line with the PO id and message id only (no address, no PDF), return
  `500 PO_SEND_RECORD_FAILED`, and document that a retry could send twice. This is the unavoidable
  consequence of an external side effect without a distributed transaction; do not claim atomicity.
- Resending appends a new `RESEND` entry; it never rewrites the first entry.
- A concurrent send with a different idempotency key can both pass the status check. Use a
  short-lived per-PO claim (`sending` timestamp/actor) or a conditional update that appends only when
  no entry newer than N seconds exists; choose one and test it. The simple acceptance rule is: one
  successful send per explicit user action, and a 409 `PO_SEND_IN_PROGRESS` for a concurrent one.

### 1.9 Tests

**Unit (no database):**

- `DRAFT` → `PO_NOT_OPEN`; `OPEN` → allowed; `OPEN` with partial receipts → allowed; `RECEIVED` and
  `CANCELED` → their stable codes.
- Missing, invalid and archived-supplier email cases.
- PDF model: ordered/received/remaining values, totals, 200-line cap, 1 MiB cap, pagination, a
  non-ASCII product name, and a partially received order's "remaining" column.
- Mail message contains exactly one PDF attachment; no address is logged; provider failure leaves the
  PO write uncalled.
- Audit metadata has no address or PDF bytes.
- Permission and limiter wiring; cross-tenant id returns 404.

**Database-backed:**

- Create → issue → partial receive → send: PO stays `OPEN`, quantities are unchanged, one transmission
  is appended, one `PURCHASE_ORDER_SENT` audit exists.
- A second send appends a `RESEND`; a failed send appends nothing.
- Concurrent sends with different keys: one succeeds and one gets the documented 409; no duplicate
  email in the fake provider.
- The existing receive/claim/finalize/undo tests still pass unchanged.

**Manual/PDF review:** generate one PDF with ASCII data and one with a non-ASCII product name, open
both, and confirm the text and page count. This is a visual check, not a substitute for the automated
size/layout tests.

### 1.10 Rollback

- Remove/disable the route and the mobile action; revert the server commit. The additive
  `transmissions` field can remain in stored documents without affecting old code.
- Revert the mail-interface change and the PDF dependency together. No migration down is needed.
- The mobile action can be removed by OTA if the server route is disabled; old clients simply do not
  see it.
- No PO status or quantity is changed by this feature, so rollback cannot corrupt inventory.

### 1.11 Acceptance

- Only `OPEN` orders, including partially received ones, can be sent.
- The PDF shows the stored lines and accurately distinguishes ordered, received and remaining.
- The recipient is the stored supplier address, visible before send.
- A send failure leaves the order unchanged and returns a stable error.
- Success is recorded once on the PO and once in audit; resend is explicit.
- No address or PDF appears in application logs; attachment size is bounded.
- A documented crash-after-send failure is visible and does not claim a false success.

## 2. FW-07 — Request reference in mobile error details

**Implementation status (2026-11-19):** implemented mobile-only in §27KD. The scope limit below was
kept: form-level `Alert`/`Banner` surfaces still show only their message, and extending them is a
ranked follow-up rather than part of this increment.

### 2.1 Current code facts

- `requestId` middleware sets `req.requestId`, returns `X-Request-ID` on every response, and accepts a
  client value only when it is ≤128 characters and matches `/^[A-Za-z0-9._:-]+$/`
  (`server/src/middlewares/requestId.ts`).
- CORS already exposes `X-Request-ID` (`server/src/middlewares/cors.ts`).
- `httpLogger` logs `requestId`, method, path, status, user id and `durationMs` on response finish.
- `mobile/lib/client.ts` reads `Retry-After` into `ApiError.retryAfter`, but never reads
  `X-Request-ID`; `ApiError` has no request-id field.
- `mobile/components/ListState.tsx` owns the shared `ErrorState`; `ListScreen` renders it for list
  loads. Form errors often use `errorText()` in a `Banner` or `Alert`, which are separate surfaces.

### 2.2 Design

1. Add `requestId: string | null` to `ApiError`, default `null`.
2. In `apiFetchAttempt`, after `res` exists and before the error is thrown, read the header with a
   helper that applies the server's own safety rules:
   - missing/blank/over-128/non-matching → `null`;
   - never synthesize an id;
   - never log the id or the response body.
3. Set `error.requestId` on every non-2xx response, including validation, auth and rate-limit
   failures. Network failures (`status: 0`) have no response and therefore `null`.
4. Add `errorRequestId(err: unknown): string | null` beside `errorText` in `ListState.tsx`.
5. Add a small `RequestReference` component:
   - renders only when `requestId` is non-null;
   - text `Reference: <id>` with `selectable` and a copy action using React Native `Clipboard`;
   - copy confirmation is local and short-lived; no analytics, no storage;
   - testIDs `request-reference` and `request-reference-copy`.
6. Extend `ErrorState` with an optional `requestId` prop. `ListScreen` derives it from its `error`
   prop, so every list screen gets it without a per-screen change. Update the direct `ErrorState`
   callers (dashboard, products, purchase orders, receive, edit screens) in the same PR.
7. Success screens, AI answer details and the session-loss handler are unchanged. This is error
   presentation only, not a diagnostic dump.

**Scope limit to state explicitly:** form-level `Alert`/`Banner` surfaces that call `errorText()`
still show only the message. Extending every form is a follow-up; do not pretend the reference is
everywhere unless those surfaces are also changed.

### 2.3 Tests

Mobile Jest:

- `apiFetch` with `X-Request-ID: abc-123` on a 400 → `ApiError.requestId === 'abc-123'`.
- Header absent → `null`; blank, >128, spaces/CRLF or other unsafe characters → `null`.
- A network rejection/timeout → `null` (no invented id).
- A successful response does not require a reference and does not render one.
- `ErrorState` renders the reference only with a value; copy calls `Clipboard.setString` with the
  exact id; no token, body, email or tenant data is present.
- A malformed `fetch` stub with no `headers` still produces the normal `ApiError` (the error path must
  not throw while reading the header).
- Existing error-copy, auth and list tests remain green.

### 2.4 Rollback

Mobile-only. Revert the client/component change or publish the previous OTA bundle. The server header
and CORS exposure already exist and need no rollback. No data or schema change.

### 2.5 Acceptance

- A failed request shows the server's returned reference in the shared error details.
- The reference is copyable and absent when the server did not return a safe one.
- No id is invented, logged, persisted or attached to a success state.
- The change is presentation-only and cannot alter authorization or retry behaviour.

## 3. FW-05 — Deadline for non-AI database work

### 3.1 Current facts and the baseline problem

- `server/src/config/db.ts` sets `bufferTimeoutMS = 1500` and a boot `serverSelectionTimeoutMS`; it
  does **not** set `maxTimeMS`. A query that is slow after the connection is ready is unbounded.
- `errorHandler` maps database-down errors to `503 DB_UNAVAILABLE`; it has no mapping for a
  `MaxTimeMSExpired` / `MongoExecutionTimeoutError` (error code 50), so a query timeout would become a
  generic 500 with an internal message.
- `httpLogger` records `durationMs` per completed request, but no p95 aggregate exists. It logs
  `req.path`, which includes ids, so it cannot be grouped into route percentiles as written.
- `operationalCounters.serverErrors` and the durable 5xx store already count 5xx responses;
  `MONITORING.md` defines the AI latency alert but not a non-AI route budget.
- The only route-level latency evidence is dated point measurement, not p95:
  - `GET /api/inventory`: 922 ms unfiltered at 50 000 products; `q`/status pages 1 561/1 019 ms after
    the product-first fix; `lowStock` 3 801 ms; location-filtered 100–226 ms on a 100 143-row tenant.
  - AI turn p95 values (4 990 ms, 8 059 ms and 22 719 ms in different windows) are **AI**, not a
    non-AI baseline.
  - There is no standing p95 for `GET /api/products/reorder`, `GET /api/dashboard`, the write routes,
    authentication or the platform console.

**Therefore step 0 is a measurement phase.** Do not choose one global `maxTimeMS` from these point
numbers.

### 3.2 Baseline capture

1. Add the matched route pattern to the existing `http` log line:
   `route: req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'`. Keep `path` for detail;
   never log the query string.
2. Add a dependency-free `server/scripts/measure-http-latency.mjs` that reads JSONL `type: "http"`
   records and reports, per `method + route`:
   `samples`, `p50`, `p95`, `p99`, `max`, `status5xx`, and the observation window. It must refuse to
   report a percentile below a stated minimum sample count (for example 100) and must label a
   local-seed run as local, never production.
3. Capture **7 consecutive days** from the production access log if it is retained. If it is not,
   capture a fixed local run against the existing seeded perf tenant and record that limitation
   explicitly. Do not call a local run "production".
4. Record the table in the implementation PR (and the eventual guide) with the date, commit and
   sample count. This is the baseline the budgets are derived from.

The plan's budget table is intentionally not filled in here; filling it without samples would be the
same mistake the earlier review made about PO statuses.

### 3.3 Budget policy and route exceptions

After the table exists:

- Start from `budget = clamp(roundUpTo500ms(3 × p95), 1000 ms, 15000 ms)` per route or route group.
- A route with fewer than 100 samples inherits its group's budget, not a made-up individual number.
- Raise a budget only with a measured reason; lower it only after a clean load check.
- Keep the budgets in one reviewed table in code, not scattered string literals.

| Route group | Treatment |
| --- | --- |
| `POST /api/ai/chat` and AI tool queries | **Exempt** (`maxTimeMS: 0` / no deadline). The existing 60 s turn deadline and provider-attempt timeout are the outer bounds; adding a DB deadline inside them would change the AI error contract. |
| `/api/health`, `/api/health/live`, `/api/health/ready` | **Exempt.** Monitoring must answer promptly and uses the existing readiness state; `/api/health/integrity` keeps its existing 503 monitoring semantics and is excluded from `serverErrors`. |
| Inventory/product/PO list and detail reads | Enforce the measured budget. These are the routes the incident risk is about. |
| Dashboard, reorder, stock-value and other aggregations | Enforce a higher measured budget; do not exempt a report merely because it is an aggregation. |
| Inventory and PO writes | Enforce a measured budget. A timeout must not be reported as a successful movement; the existing compensation paths remain. |
| Auth, sessions and platform routes | Enforce a measured budget; bcrypt/Firebase time is outside MongoDB and is not covered by `maxTimeMS`. |
| Future export/report routes | Explicit opt-out in the table until a bounded streaming design exists. There are no export routes today. |

### 3.4 Implementation shape

A request-scoped deadline is needed because a single connection-level value cannot exempt the AI path
while enforcing a different value for inventory reads.

1. Add `server/src/config/dbDeadline.ts`:
   - `AsyncLocalStorage<{ maxTimeMS: number | null; route: string }>`;
   - `runWithDbDeadline(context, next)`;
   - `currentDbDeadline()`.
2. Attach `dbDeadline('route-key')` as the **first handler on each route or route group**, keyed by
   the reviewed table. A global pre-route middleware cannot read `req.route` before Express has matched
   the route, so it cannot pick a per-route budget reliably; do not pretend it can. Use a small route
   wrapper or group middleware so a new route cannot silently omit its entry. A route with no key
   fails the route-table test. No context (scripts, tests, background jobs) means "no change".
3. Register one Mongoose plugin before models are compiled. For `find`, `findOne`,
   `findOneAndUpdate`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `countDocuments`,
   `distinct` and `aggregate`, set `maxTimeMS` from the context **only when the query did not already
   set one**. An explicit `maxTimeMS: 0` always wins. Aggregations use
   `this.options.maxTimeMS`; queries use `setOptions`.
4. Do not use `mongoose.set('maxTimeMS', …)` alone: it cannot express per-route exceptions and would
   apply the AI path's queries to the same value.
5. `maxTimeMS` bounds server-side query/update/delete execution, not connection acquisition, network
   time, write-concern waiting or a `save()`/insert. Keep `bufferTimeoutMS` for the disconnected
   queue and state this boundary in the monitoring documentation; do not claim every write is covered.
6. The existing inventory compensation and PO claim/finalize paths are unchanged. A timed-out write
   must follow the same "no success response unless the write is durable" rule; the error handler
   returns a retryable 503, not a 200.

### 3.5 Timeout mapping, logging and counters

Add `isDatabaseTimeoutError(err)` beside `isDatabaseDownError()`:

- `MongoServerError` with `code === 50` or `codeName === 'MaxTimeMSExpired'`;
- `MongoExecutionTimeoutError` by name;
- do not classify a generic network error as a timeout.

In `errorHandler`, before the generic 5xx path:

```text
503 DB_TIMEOUT
"The request took too long to complete. Please retry."
```

- Log `type: "db_timeout"` with `requestId`, method, matched route (not the concrete path if it
  contains an id), `maxTimeMS`, and the request duration. Never log the query, filter, collection
  contents, stack or recipient data.
- Call `persistServerError(req, 503, 'DB_TIMEOUT')` so the durable 5xx store and
  `serverErrors` see it. This is an operational failure, not a validation result.
- Do not reuse `504 AI_TIMEOUT`; that code is part of the assistant contract. 503 is the retryable
  dependency/deadline answer for non-AI work.

`httpLogger` adds `route` and `dbMaxTimeMs` from `res.locals` (the deadline middleware writes it
there); reading `AsyncLocalStorage` in a `finish` listener registered before the deadline would not
see the request context. `httpLogger` does not add query text.

### 3.6 Tests

- **Unit:** route table selects the expected budget/exemption; context with no value leaves queries
  unchanged; plugin sets `maxTimeMS` on a find, a count and an aggregate; explicit `maxTimeMS: 0` is
  preserved; no context is preserved; auth/health/AI routes are exempt.
- **Error mapping:** code 50, `MaxTimeMSExpired`, and the named execution-timeout error become 503
  `DB_TIMEOUT`; a generic 500 does not; the response has no stack or raw message; one durable 5xx row
  and one counter increment occur.
- **Database-backed:** a deliberately slow query (test-only, bounded, skipped when the server
  disallows the construct) is cut off inside its budget; a normal indexed read is unaffected. Assert
  the option and the error path even if the live timeout cannot run on every CI host.
- **Load check:** replay the fixed route set against the seeded fixture before/after enforcement;
  normal routes complete inside their budgets, p95 does not regress beyond the agreed tolerance, and
  no AI turn changes its status/latency contract.
- **Docs/ops:** the baseline table and budget table are dated; `MONITORING.md` explains how to read a
  `DB_TIMEOUT` and that a route budget is not a guarantee of query completion after the client has
  gone away.

### 3.7 Rollout and rollback

Rollout is staged:

1. Measure and publish the baseline; no enforcement.
2. Add the plugin/context and log "would exceed" without failing, for one observation window.
3. Enforce on inventory/product/PO reads only; compare p95 and 5xx.
4. Enforce on writes and aggregations; leave AI/health exempt.
5. Only then consider a default for new routes; new routes must be added to the table deliberately.

Rollback: set the enforcement switch/environment value to disabled (the plan should include one, e.g.
`DB_DEADLINE_ENFORCE=0`), or revert the plugin/middleware commit. There is no schema or data change.
The plugin has no effect on a process with no request context. Removing it immediately restores the
unbounded behaviour; the logs and the budget table remain useful evidence.

### 3.8 Acceptance

- A deliberately slow non-AI query is cut off inside its configured budget and mapped to 503
  `DB_TIMEOUT` without internal detail.
- Normal routes do not regress in the load check; the p95 baseline is recorded and dated.
- The AI turn deadline/error contract, health endpoints and `/api/health/integrity` semantics are
  unchanged.
- The timeout is visible in the request log, the 5xx counter and the durable 5xx store, and is not a
  generic 500.

## 4. Linked stock-movement reversal

### 4.1 Goal and non-goals

**Goal.** Let an authorized user reverse one recorded `STOCK_IN`, `STOCK_OUT` or `ADJUSTMENT` by
creating a linked compensating ledger row, with a required reason and an audit event. The original's
movement fields are never edited or deleted; exactly one link field (`reversedBy`) records the
reversal.

**Non-goals.** No transfer-leg reversal (a transfer is a paired event), no PO receipt reversal (the
PO receipt/quantity counters must stay consistent), no edit/delete of history, no silent correction,
no automatic reversal, and no reversal of a reversal.

### 4.2 Current facts

- `InventoryTransaction` stores type, quantity, previousQuantity, newQuantity, reason, reference,
  userId, timestamps. The four types are `STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT`, `TRANSFER`.
- Inventory quantity changes are single-document atomic updates with quantity-anchored compensation
  (`inventory.service.ts`); there is no multi-document transaction.
- A transfer writes two `TRANSFER` rows correlated by `reference` and one `INVENTORY_TRANSFERRED`
  audit. A single leg cannot be reversed without breaking the pair.
- A PO receipt is a `STOCK_IN` with `reason: 'PO receipt'` and the PO number as `reference`; the PO
  receipt stores the exact `inventoryTransactionId`. Reversing it would leave `quantityReceived`,
  `receipts`, claims and the ledger disagreeing.
- `purchase-orders.service.ts` has an internal `undoStockInMovement` for a failed finalize. It deletes
  the row/transaction/audit and is not reusable for a user-facing reversal.
- `INVENTORY_STOCK_IN`, `INVENTORY_STOCK_OUT`, `INVENTORY_ADJUSTED` and `INVENTORY_TRANSFERRED` are
  the existing audit actions; there is no reversal action.

### 4.3 Ledger design

Add two optional fields to `InventoryTransaction`:

```text
reversalOf: ObjectId | null   // on the new compensating row: the original transaction
reversedBy: ObjectId | null   // on the original row: the compensating transaction
```

- The compensating row uses `type: 'ADJUSTMENT'`. Do **not** add a fifth movement type in this
  increment: the §15 enum, dashboard totals, AI history filters and existing tests stay stable.
  The `reversalOf` link is what makes it a reversal; `transactionPublic()` exposes both fields and the
  UI labels it "Reversal", not "Adjustment".
- Add a unique partial index on `{ businessId: 1, reversalOf: 1 }` for documents where `reversalOf`
  is an ObjectId. The database, not a read-then-write check, is the final guard against two reversals.
  The business id keeps the guard tenant-scoped even though ObjectIds are globally unique.
- Add `INVENTORY_REVERSED` to `AUDIT_ACTIONS`; the audit entity is `INVENTORY_TRANSACTION`, with the
  original id and the reversal id in metadata.

The reversal transaction's values:

| Original type | `previousQuantity` | `newQuantity` | `quantity` | Inventory update |
| --- | --- | --- | --- | --- |
| `STOCK_IN` | current row quantity | current − original.quantity | original.quantity | `$inc: -quantity` |
| `STOCK_OUT` | current row quantity | current + original.quantity | original.quantity | `$inc: +quantity` |
| `ADJUSTMENT` | current row quantity | original.previousQuantity | abs(current − target) | `$set: target` |

`reason` is required (3–500 characters, trimmed) and becomes `Reversal: <reason>` or the user's
reason with a separate `reversalOf`; do not leave it blank. `reference` may copy the original
reference for context, but `reversalOf` is the authoritative link.

### 4.4 Safety guards

Reject with stable 409 codes before any write:

1. `TRANSACTION_NOT_FOUND` (404) unless `{ _id, businessId }` matches.
2. `REVERSAL_NOT_SUPPORTED_FOR_TRANSFER` for `type === 'TRANSFER'`. A transfer needs a paired reverse
   operation; that is a separate plan.
3. `REVERSAL_NOT_SUPPORTED_FOR_PO_RECEIPT` when a purchase order's receipt line names this exact
   transaction id
   (`PurchaseOrder.exists({ businessId, 'receipts.lines.inventoryTransactionId': txn._id })`).
   Do not exclude a stock-in merely because its reference looks like a PO number; only the receipt
   link is authoritative.
4. `REVERSAL_OF_REVERSAL_NOT_SUPPORTED` when `txn.reversalOf` is set.
5. `ALREADY_REVERSED` when a reversal row with `reversalOf: txn._id` already exists.
   `REVERSAL_IN_PROGRESS` when `txn.reversedBy` is set but that row is missing (the crash window in
   §4.5). Do not report a missing row as success, and do not create a second one.
6. `REVERSAL_NOT_LATEST` when any later transaction exists for the same product and location. Use the
   latest row's id, not only a timestamp comparison, so same-millisecond writes are safe. This
   prevents reversing an old movement when a later movement has returned the quantity to a
   coincidentally equal value.
7. `REVERSAL_CONFLICT` when the inventory row is missing, its current quantity is not exactly the
   original `newQuantity`, or the target would be below `reservedQuantity`. No partial adjustment.
8. Archived product/location: allow the correction while the inventory row still exists. Archiving is
   not deletion and the row remains; blocking the correction would leave a known error uncorrectable.
   Document this exception in the endpoint's tests.

### 4.5 Claim, write and compensation

The endpoint is `POST /api/inventory/transactions/:id/reverse`, gated by
`PERMISSIONS.INVENTORY_MANAGE` (OWNER/ADMIN/MANAGER; `STAFF` is refused) and `idempotent()`.

Use the existing single-document + compensation architecture:

1. Generate `reversalId`; atomically claim the original:
   `findOneAndUpdate({ _id, businessId, reversedBy: null, reversalOf: null }, { $set: { reversedBy: reversalId } })`.
   A null result means already reversed or not found.
2. Create the reversal transaction with `_id: reversalId`, `reversalOf: original._id`, type
   `ADJUSTMENT`, and the table values above. Use `InventoryTransaction.create()` here, not
   `recordMovement()`: `recordMovement()` applies the stock change itself and would double-apply it.
   If this create fails, clear the claim only while it still equals `reversalId`; never clear a claim
   another attempt now owns. The unique `reversalOf` index is the final guard.
3. Apply the inventory update with the exact guard
   `{ _id: row._id, businessId, productId, locationId, quantity: original.newQuantity }` and the
   operation from the table. If it matches nothing, read the row once:
   - already at the target → treat the stock step as applied (a retry);
   - otherwise → delete the reversal row, clear the claim, and return `409 REVERSAL_CONFLICT`.
4. Record `INVENTORY_REVERSED` with the original and reversal ids. An audit failure is logged and does
   not remove a durable movement, matching `recordMovement`.
5. Return the original and reversal public rows.

**Crash residual.** There is no multi-document transaction. A crash can leave the claim (`reversedBy`)
and/or the reversal row before the stock or audit step. The link makes the partial attempt visible; a
retry must not double-apply. Do not claim the operation is crash-atomic. Add one reconciliation query
(tests only at first) for a `reversedBy` with no matching `reversalOf` row or a stock/ledger mismatch,
and document it in the implementation PR. If a safer resumable state is required, add an explicit
state field rather than hiding the window.

### 4.6 API and UI

- Add `reversalOf` and `reversedBy` to `transactionPublic()` and the history DTO. The original row
  shows "Reversed"; the compensating row shows "Reversal of …".
- History screen: an action on eligible rows only (`STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT`, not
  reversed, not a reversal, not a PO receipt, not a transfer). Confirmation requires a reason and
  warns that it creates a new record; it never edits the original.
- Do not show the action on transfer legs or PO receipts. Explain why in the row's expanded details.
- The assistant's history tool may keep returning the row as `ADJUSTMENT`; add `reversalOf` to its
  output and update the prompt so it does not call a reversal a sale, receipt or ordinary adjustment.

### 4.7 Tests

**Unit:**

- Table math for stock-in, stock-out and adjustment; zero/negative guards; reserved quantity guard.
- Every exclusion: transfer, PO receipt (linked), reversal-of-reversal, already reversed, not latest,
  stale/current mismatch, missing row, cross-tenant, archived product/location.
- Reason required and length-bounded; permission/route binding; exact audit action.
- Public DTO includes the link and does not expose unrelated fields.

**Database-backed:**

- Stock-in reversal restores the prior quantity; stock-out reversal adds it back; adjustment reversal
  restores the prior quantity.
- Original transaction and its audit are unchanged; exactly one reversal row and one audit exist.
- Concurrent double reversal: one succeeds, one gets 409, and the row quantity changes once.
- A later transaction at the same product/location blocks reversal even when the quantity has
  returned to the original `newQuantity`.
- A PO receipt and a transfer leg are refused with their specific codes; existing PO receive and
  transfer tests remain green.
- Quota/index integrity: the new partial unique index is declared and built by the normal index
  process; no production migration is run in this planning phase.

### 4.8 Rollback

- Hide the mobile action and disable/remove the route; revert the server commit.
- The additive `reversalOf`/`reversedBy` fields and the partial index can remain; existing rows are
  unaffected. If the index must be removed, do it as a reviewed index change, not an application
  cascade.
- No original transaction is edited or deleted, so rollback cannot change stock. Existing reversal
  rows remain valid history if the feature is withdrawn.

### 4.9 Acceptance

- One eligible movement can be reversed exactly once by an authorized user with a reason.
- The original's movement fields are untouched and only `reversedBy` is set; the new row is linked
  and audited; the row quantity is correct and never negative.
- Transfers and PO receipts are refused with actionable codes; no paired or receipt state is
  corrupted.
- A concurrent or stale attempt changes nothing and returns 409.
- History and the assistant can tell a reversal from an ordinary adjustment.

## 5. Supplier replenishment terms

### 5.1 Goal and the missing bridge

**Goal.** Store optional supplier replenishment terms — lead time, minimum order quantity and order
multiple — and use the quantity terms to show a suggested order quantity on the restock list. The
terms are advisory; nothing is ordered automatically.

**Missing bridge.** The current product has no supplier link. A supplier-level MOQ cannot be applied
to a product's shortfall without knowing which supplier supplies that product. The minimal additive
change is an optional `preferredSupplierId` on `Product`. Without it, terms can only be displayed on
the supplier record; they cannot honestly drive a per-product calculation.

### 5.2 Fields

On `Supplier` (all optional; absent means "not configured"):

| Field | Type | Validation |
| --- | --- | --- |
| `leadTimeDays` | integer | 0–365; 0 means same-day/unknown; absent means not configured |
| `minimumOrderQuantity` | integer | ≥1; absent means no minimum |
| `orderMultiple` | integer | ≥1; absent means no multiple |

On `Product`:

| Field | Type | Validation |
| --- | --- | --- |
| `preferredSupplierId` | ObjectId ref Supplier, optional | same business; must be ACTIVE when set; archived suppliers are rejected on write |

No supplier name/address is copied onto the product. The supplier record remains authoritative.
No index is required for the page-level restock read (suppliers are fetched by the page's ids); add a
`{ businessId, preferredSupplierId }` index only if a later "products by supplier" filter needs it.

### 5.3 Calculation

Keep `unitsBelowMinimum` exactly as it is: the gap to the product's configured minimum, `null` when
no minimum exists. It is not a recommended order quantity.

Add `suggestedOrderQuantity` to a restock row only when the product has a preferred supplier and at
least one quantity term is configured:

```text
shortfall = unitsBelowMinimum
q = max(shortfall, minimumOrderQuantity ?? 1)
if orderMultiple > 1: q = ceil(q / orderMultiple) * orderMultiple
suggestedOrderQuantity = q
```

- `shortfall` 0 → 0 (nothing to order).
- No preferred supplier or no terms → `null`; do not pretend the raw gap is a recommendation.
- The whole-set `totalUnitsBelowMinimum` stays the raw gap total. Do not sum rounded suggestions
  across suppliers; that would mix packaging rules and overstate the order.
- `leadTimeDays` is display-only in this increment. Without a consumption/velocity figure there is no
  honest way to turn lead time into a quantity; do not invent a forecast. Show it beside the
  supplier and use it for operator judgment.
- If the preferred supplier is archived after assignment, keep the link and display the archived
  state; do not silently drop the terms or reassign. New assignments require ACTIVE.

### 5.4 API and persistence

- `supplier.model.ts`: add the three optional numbers with integer/min/max validators.
- `validateSupplier()`: parse the three fields with `optionalNumber(value, field, { min, max,
  integer: true })` (the real signature is `(value, field, opts)`, not `(value, opts)`). For a PATCH
  that clears a term, accept an explicit `null` and preserve it as a clear signal; the current shared
  parser collapses `null`/`''` to `undefined`, and `reference.service.update()` ignores `undefined`,
  so a plain blank would silently fail to clear. Add a supplier-specific nullable number parser or
  make the reference update treat an explicit null as a clear; test both.
- `reference.service.ts`: add the fields to the `supplierService` `fields` list so `toPublic()` and
  the generic create/update path carry them. The existing audit records only changed field names.
- `product.model.ts`: add `preferredSupplierId`. `validateProduct()` accepts an optional object id;
  add a nullable form so a PATCH can clear it (same blank-vs-absent issue).
- `product.service.ts`: validate the preferred supplier belongs to the business and is ACTIVE on
  create/update; include `preferredSupplierId` (and the resolved supplier only where needed) in the
  product DTO. Do not add a supplier join to every product list; the restock read attaches it to the
  page.
- `listReorder()`: after `hydrateStockPage()`, fetch the page's distinct preferred suppliers in one
  business-scoped query and attach `supplier: { id, name, status, leadTimeDays, minimumOrderQuantity,
  orderMultiple }` and `suggestedOrderQuantity` per row. The page is bounded (20/25 rows), so this is
  one extra indexed read, not a join over the tenant.
- `GET /api/products/reorder` and the AI `getReorderNeededProducts` tool use the same service, so
  both surfaces agree. Update the AI prompt's restock rule: `unitsBelowMinimum` is the gap;
  `suggestedOrderQuantity` is rounded by supplier terms and is still not an order.

### 5.5 UI

- Supplier create/edit (`mobile/components/RefManage.tsx` via `suppliers.tsx`): add three optional
  number fields with `keyboardType="number-pad"`, labels that state "optional", and clearing support.
  The shared form currently forwards strings; the server parses them, but the clear path must send
  `null`, not an empty string.
- Supplier row: add compact meta such as `7-day lead · MOQ 10 · multiple 6` only for configured values.
- Product form (`mobile/components/ProductForm.tsx`): add an optional "Preferred supplier" select
  using the existing `useActiveRef` supplier list; include it in `ProductInput` and the edit
  initialiser; send `null` to clear.
- Restock row (`mobile/app/(app)/restock.tsx`): when present, show `Suggested order 24 · Supplier X ·
  7-day lead time`. Do not imply the order exists. If no terms, keep the current "N below minimum"
  text and show nothing else.
- Product detail may show the preferred supplier and terms as read-only fields; that is optional and
  should not delay the restock value.

### 5.6 Migration and rollout

- Additive schema only: optional supplier fields and an optional product reference. No backfill and
  no data rewrite. Existing suppliers read as "not configured"; existing products read as "no
  preferred supplier".
- No new collection and no required migration command. Declare the fields in the models; the normal
  index/field deployment path applies. Do not run a production migration in the planning phase.
- Deploy the server first; old mobile clients ignore the added fields. Then publish the mobile OTA
  for the forms and restock labels. No feature flag is required because every field is optional and
  the calculation falls back to `null`/the existing text.
- If the supplier terms are wrong, editing them changes future suggestions only; already-created
  POs and suggestions are not rewritten.

### 5.7 Tests

- Supplier validator/DTO: create with all terms, partial terms, absent terms; reject negative,
  non-integer, >365 lead time, zero MOQ/multiple; update one field; clear each with `null` and prove
  the stored value is gone.
- Tenant isolation: supplier/product from another business is rejected; archived supplier is
  rejected on new assignment; an existing archived-supplier link still renders.
- Product validator/service: create with no supplier, with an active supplier, with an archived or
  foreign supplier; clear with `null`; product DTO shape.
- Calculation unit table: no terms, MOQ only, multiple only, both, shortfall 0, shortfall below MOQ,
  shortfall not a multiple, exact multiple; `null` when no preferred supplier.
- `listReorder` DB test: terms attached only to the page, `totalUnitsBelowMinimum` unchanged,
  one supplier read for the page, archived supplier flagged, no supplier join over the whole tenant.
- AI tool test: the restock result carries the fields and the prompt distinguishes gap from
  suggestion.
- Mobile Jest: supplier form serializes/clears numeric fields, product form sends/clears the preferred
  supplier, restock row renders the suggestion only when present.
- Existing restock, product, supplier and AI restock tests remain green.

### 5.8 Rollback

- Revert the server fields and the restock attachment; additive stored values can remain without
  affecting old code. Revert/OTA the mobile form and restock labels.
- No data migration to undo; no existing quantity, PO or movement is changed by the feature.
- If the preferred-supplier link is withdrawn, products simply return to "no preferred supplier";
  supplier terms remain stored but unused.

### 5.9 Acceptance

- Supplier terms are optional and clearable; invalid values are rejected server-side.
- A product can optionally name one active supplier in the same business.
- The restock list shows a suggested quantity only when the terms support one, and the raw gap is
  never relabelled as a recommendation.
- The calculation is one page-level supplier read, not a tenant-wide join; totals remain raw gaps.
- No automatic PO, email, stock movement or supplier action occurs.

## 6. Recommended implementation order

The items are independent, but this order minimizes rework and keeps the riskiest cross-cutting change
last.

| Order | Item | Effort | Why here |
| ---: | --- | --- | --- |
| 1 | **FW-07 — request reference** | S | No schema, no server change, immediate support value. It can ship while the larger plans are reviewed. |
| 2 | **Linked stock-movement reversal** | M/L | Highest inventory-integrity value. The additive link/index and the guard tests should land before operators acquire a correction habit. Does not depend on the other items. |
| 3 | **Supplier replenishment terms** | M | Additive and independently useful. It changes the restock row shape and the product/supplier forms, so it should precede the FW-05 baseline (which must measure the final route set). |
| 4 | **FW-04 — PO transmission** | M | Needs a new PDF/font dependency, an attachment-capable mail boundary and a security/reputation review. Keep it after the lower-risk additive work. |
| 5 | **FW-05 — non-AI database deadline** | M/L | Measurement-first and cross-cutting. It must baseline the routes after items 2–4 exist; enforcing it earlier would measure a tree that is about to change. |

FW-07 and the reversal plan can run in parallel if two streams are available; FW-04's dependency
review can run in parallel with supplier terms. FW-05 should not start enforcement until the other
merged routes are stable.

## 7. Documentation and verification for this planning phase

This document is the only new authority. It changes no source, schema, test, environment, account,
database or deployment. The implementation phases must update:

- `docs/SYSTEM_SPECIFICATION.md` for the new PO transmission fields/route, reversal semantics and
  supplier/product fields;
- the relevant guides (purchase orders, inventory history, suppliers/restock) and `docs/README.md`;
- `MONITORING.md` for `DB_TIMEOUT` and the route-budget baseline;
- the roadmap with a new dated record and the log with the actual checks run.

For this phase, verification is documentation-only: `node scripts/check-docs.mjs`, the docs tests,
and `git diff --check`. No code test, database test, PDF render, email send or production check is
claimed.
