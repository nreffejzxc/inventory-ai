# Future improvements beyond DEV-09

**Status:** recommendations only, except **FW-07**, which shipped after this review. Nothing here
authorizes code, a schema change, a deployment, a dependency, a notification or a paid service.

**Reviewed:** 2026-11-19; completion note added 2026-11-21.
**Basis:** the tree at `3587e71`, the last 200 GitHub Actions runs, the open Dependabot alert set at
that date, the production health response, and the existing ranked records IA-01–IA-45, TS-01–TS-06,
RD-01–RD-06, NX-01–NX-07, NY-01–NY-07, NZ-01–NZ-07, SEC-01–SEC-12 and NS-01–NS-07.

## 1. What the review found

**CI is healthy.** `ci` accounts for 163 of the last 200 runs: 95 pull requests, 64 pushes and 4
manual dispatches, with 25 failures. They are pull-request iterations, one deliberate
negative-control scratch PR that was closed unmerged, and four merge heads from 2026-11-16–18.
Each merge-head failure was followed by a later green `main` run, and the latest `main` run
(`44472781110` at `3587e71`) is green. In that run `server` took 3m40s, `mobile` 1m22s, `webauthn-e2e` 52s,
`compose-mongo` 31s, and the two guard jobs finished in seconds. The sample contains no unexplained
recurring infrastructure failure, so adding more checks is not the highest-value next step.

**Dependencies are clean.** The Dependabot alert API returned **0 open alerts** at review. Routine
updates are grouped weekly, and security updates now have a separate group per supported ecosystem
(DEV-10, §27JZ). Issue #32 still tracks the deferred TypeScript 7 upgrade.

**Production is healthy at the reviewed commit.** `/api/health` reported `status: ok`,
`db: connected`, environment `production`, 4,111 responses and **0** `5xx` since boot.

**Security and reliability are already densely ranked.** The existing records cover platform access,
alerting, session revocation, restore drills, dependency review, CodeQL, tenant security notices,
API-contract drift (IA-34), query-plan drift (IA-37) and support diagnostics (IA-41). Re-scoring them
would add noise, so they are carried forward in §5 rather than re-proposed.

**The largest uncovered value is operational completeness.** A business can record stock movements,
transfers, purchase orders and an audit trail, but it cannot quickly load an existing catalogue,
reconcile a physical count, or send an issued purchase order to a supplier. Those are product gaps,
not CI gaps. Two engineering controls — a tenant-scope query guard and a database deadline — are also
not owned by an earlier item.

## 2. What is not repeated

| Existing item | Why it is not proposed again |
| --- | --- |
| IA-34 API contract-drift gate | Owns mobile/server field, status and error-code drift. |
| IA-37 Query-plan/index watch | Owns plan regressions on a fixed fixture. |
| IA-38 Minimum supported app version | Owns the client retirement boundary. |
| IA-39 Tenant data export | Owns self-service portability and its audit. |
| IA-41 Redacted support diagnostics | Owns the support bundle; FW-07 is the smallest first step. |
| NZ-01 CodeQL | Owns code-level static analysis. |
| NS-04 Platform session inventory | Owns targeted revocation of a platform session. |
| IA-04 / restore-drill plan | Owns backup and restore evidence. |
| DEV-08 runner pin and scheduled WebAuthn repeat | Already ranked and still open. |

## 3. Method

Each item is scored on **value** (1–5: how much a real business, security boundary or support path
improves), **urgency** (High/Medium/Low: whether the next release needs it), **effort** (S: days,
M: weeks, L: a project) and **maintenance risk** (what can break later). Ties are broken by value,
then by the smaller risk. The order is a recommendation, not an authorization, and no item is a
prerequisite for another.

## 4. Ranked new work

| Rank | ID | Recommendation | Domain | Value | Urgency | Effort | Maintenance risk |
| ---: | --- | --- | --- | ---: | --- | --- | --- |
| 1 | **FW-01** | Bulk catalogue and opening-stock import (CSV) | Onboarding | 5 | High | M | Low–medium |
| 2 | **FW-02** | Tenant-scope query guard at the model boundary | Security | 5 | Medium | L | High |
| 3 | **FW-03** | Stocktake / cycle-count sessions | Inventory accuracy | 5 | Medium | L | High |
| 4 | **FW-04** | Purchase-order transmission to the supplier | Procurement | 3 | Medium | M | Low |
| 5 | **FW-05** | Deadline for non-AI database work | Reliability | 3 | Low | M | Medium |
| 6 | **FW-06** | Digest-pinned MongoDB image | Supply chain | 2 | Low | S | Medium |
| 7 | **FW-07** | Request reference in mobile error details — **implemented 2026-11-19, §27KD** | Support | 2 | Low | S | Low |

### FW-01 — Bulk catalogue and opening-stock import

**What.** An OWNER or ADMIN uploads a CSV of products and, optionally, opening quantities per
location. The server validates the whole file first (dry run), reports every bad row with its line
number, rejects duplicate SKUs or barcodes inside the file and against the tenant, then creates
products and opening stock in one bounded operation. A repeat with the same idempotency key must not
duplicate anything; one audit event records the file name, row counts and the operator.

**Why it matters.** Entering a real catalogue by hand is the slowest part of onboarding, and the
existing seed commands are operator tooling, not a customer feature. A business with hundreds of SKUs
cannot reach a useful first day without an import path.

**Benefit.** Same-day onboarding, fewer transcription errors and a reviewable failure report instead
of a silent partial import.

**Acceptance.** Only the caller's business is written; a dry run changes nothing; invalid rows never
produce a silent partial write; a repeated import is idempotent; every opening quantity has a stock
transaction; no negative stock; the audit event contains no row contents.

**Risk.** This is a new bulk write path and therefore a tenant-isolation and inventory-integrity
surface. It needs strict validation, bounds on file size and row count, and a clear partial-failure
contract. It also increases the value of FW-02.

**Free approach.** Existing MongoDB, validators, audit trail and mobile file picker; no new vendor.

### FW-02 — Tenant-scope query guard at the model boundary

**What.** Make a missing `businessId` fail at the data boundary for tenant-owned collections, not
only in route tests. Start with a test-time Mongoose plugin or query wrapper that rejects
`find`/`findOne`/`update*`/`delete*`/`count*` without a tenant filter, plus an explicit allowlist for
platform-wide jobs. Cover aggregation pipelines with a companion check, because a `$match` sits
outside the query filter. Fail closed in tests; do not start in warn-only mode.

**Why it matters.** The cross-tenant route matrix (NX-03) proves the routes it knows. A new service
method that forgets `businessId` can pass every route test that does not exercise that branch. The
data layer is the last place where the omission is still cheap to catch.

**Benefit.** Defence in depth for every existing and future tenant feature, including FW-01 and FW-03;
a missing filter becomes a red test instead of a review miss.

**Acceptance.** A deliberately unscoped query fails in the guard's own test; an allowlisted platform
query passes; correctly scoped code is unchanged; the suite shows no new N+1 or measurable slowdown;
aggregation coverage has a positive and negative control.

**Risk.** High. Mongoose middleware can surprise on `findOneAndUpdate`, discriminator models and
system jobs, and a global plugin can break boot or hide a legitimate platform query. Stage it as a
test-only guard first, then decide whether to enforce it at runtime.

**Free approach.** Existing Mongoose and test harness; no new dependency.

### FW-03 — Stocktake / cycle-count sessions

**What.** A count session selects a location and optional category, snapshots the expected
quantities, accepts counted quantities, and produces a variance report. Approval posts one
`ADJUSTMENT` per differing product with the count reference as the reason. A session can be paused,
resumed or abandoned; abandoning changes no stock. Posting is role-gated and audited.

**Why it matters.** Today a correction is an individual adjustment. There is no supported way to
reconcile a shelf count, so drift is found late and corrections are ad hoc. Counts are the control
that makes the inventory story trustworthy.

**Benefit.** Accuracy, shrink detection, evidence for an owner review and a natural reason to use the
audit trail.

**Acceptance.** A count cannot post twice; an abandoned session leaves stock untouched; every posted
difference creates a transaction and an audit event; a concurrent movement is either refused or
handled by a documented rule; no negative stock; tenant scope is enforced.

**Risk.** High. Stock can move during a count, a snapshot can go stale, and a large session can create
many adjustments. The freeze/allow-movement policy and the approval boundary must be specified before
code.

**Free approach.** Existing inventory, transaction and audit models; no new service.

### FW-04 — Purchase-order transmission to the supplier

**What.** From an ISSUED purchase order, generate a bounded PDF and email it to the supplier through
the existing Brevo boundary, recording the recipient and sent time on the order. Resend is explicit;
nothing is ordered automatically and no supplier response is inferred.

**Why it matters.** The purchase-order lifecycle currently ends at “issued” inside the app. The
supplier still needs a document, so the operator exports or retypes it.

**Benefit.** Completes the procurement loop, reduces transcription errors and leaves a record of what
was sent and when.

**Acceptance.** Only ISSUED or partially received orders can be sent; the PDF contains the stored
lines and totals; the recipient is validated and visible; a send failure leaves the order unchanged
and reports a stable error; the send is audited and rate-limited; no supplier data appears in logs.

**Risk.** Outbound mail reputation and mistyped supplier addresses; reuse the existing provider,
limiter and bounce handling. Keep the attachment small, or send a bounded link if the provider’s
attachment limit is a constraint.

**Free approach.** Existing Brevo mail boundary and purchase-order data.

### FW-05 — Deadline for non-AI database work

**What.** Apply a per-query `maxTimeMS` budget to non-AI reads and writes, with explicit exceptions
for reports, exports and the AI tool path, and map a timeout to a stable 503/504 that reveals no
internals. Record the timeout in the request log and the 5xx counter.

**Why it matters.** The service runs on one small Render instance. IA-31 measures latency and IA-37
watches plans, but neither stops a single runaway query from occupying a connection or the event loop
at runtime.

**Benefit.** Fast failure for one request instead of degradation for every tenant, plus a clear
signal that a query needs an index or a narrower predicate.

**Acceptance.** A deliberately slow query is cut off inside its budget; normal routes are unaffected
in a load check; the AI turn deadline and its error contract are unchanged; the timeout is observable
without a stack trace.

**Risk.** A legitimate large aggregation can fail. Budgets must be per route, measured against the
current p95, and rolled out with an exception list rather than one global number.

**Free approach.** Mongoose query options and the existing logger and counters.

### FW-06 — Digest-pinned MongoDB image

**What.** Pin the `mongo:7.0.48` image by digest in `compose.yaml` and both CI service blocks while
keeping the readable tag, and update all three together. The workflow invariant guard continues to
check tag parity; a new check or a documented step records digest parity.

**Why it matters.** A tag is mutable. The current pin prevents an unexpected minor jump but not a
re-pushed tag. The database image is the largest third-party build input in CI.

**Benefit.** An immutable test database input and a smaller supply-chain window.

**Risk.** Medium maintenance: Dependabot may not move a digest pin automatically, so a patch update
becomes a deliberate three-file change. That is the trade-off, not a defect.

**Free approach.** Docker image digest from the registry; no new service.

### FW-07 — Request reference in mobile error details (implemented 2026-11-19)

**Status.** Shipped in §27KD. `ApiError.requestId` is read from a validated `X-Request-ID`, and the
shared error states show a selectable, copyable reference with a short local confirmation. The text
below is the original proposal, retained for traceability.

**What.** Read the server's `X-Request-ID` response header in `mobile/lib/client.ts`, keep it on
`ApiError`, and show a short “Reference: …” line with a copy action in the error details for failed
requests. Fall back to the existing message when the header is absent.

**Why it matters.** The server already generates or safely echoes the ID and returns it on every
response, but a member cannot see it. Support therefore asks for a time and a screenshot instead of
one exact log key.

**Benefit.** One identifier links a report to the server log line, shortening diagnosis without a new
support tool.

**Acceptance.** A failed request shows the returned ID; the value is copyable; no ID is invented when
the header is missing; no token, body or tenant data is shown or logged; success screens are unchanged.

**Risk.** Low. This is presentation only; do not turn it into a general diagnostic dump.

**Free approach.** Existing server header and CORS exposure.

## 5. Carry-forward items, not re-scored

These are already ranked elsewhere and remain open. They are listed so this review is complete, not
because they are new.

| Item | Source | State | Why it still matters |
| --- | --- | --- | --- |
| CodeQL code scanning | NZ-01 | Not enabled | The highest existing code-level control; needs a baseline triage. |
| Platform session inventory and targeted revocation | NS-04 | Open | A stolen platform session can only be cut off by ending every session. |
| Executed restore drill | IA-04 / restore-drill plan | Planned, not executed | An untested backup is a hope. |
| Runner image pin (`ubuntu-24.04`) | DEV-08 #3 | Open | Removes a moving build input. |
| Scheduled WebAuthn repeat | DEV-08 #6 | Open | Catches browser-factor flakiness outside the merge gate. |
| API contract-drift gate | IA-34 | Open | The closest existing item to a release compatibility gate. |
| Query-plan/index watch | IA-37 | Open | Complements FW-05's runtime deadline. |

## 6. Deliberately not proposed

- **Dependabot cooldown configuration** — GitHub applies a three-day cooldown to version updates by
  default and exempts security updates; an explicit value would add little.
- **Merge queue** — the repository is user-owned and the ruleset API answers HTTP 422 (§27JT).
- **Paid APM, status page or paging service** — no budget; the free health watch and console cover
  the current need.
- **AI write tools** — the assistant stays read-only.
- **Tenant detail in the platform console** — not before SEC-06's reason-bound support grant.
- **Automatic dependency merging, self-hosted runners or a broad rewrite** — more maintenance than
  value at this size.
