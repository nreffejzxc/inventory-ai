# Inventory AI — open work register

**What this file is.** The one place open, unshipped work is listed. It replaces the nineteen separate
ranking, assessment and follow-up documents that accumulated between 2026-11-17 and 2026-11-23
(`*_FOLLOWUPS_*`, `*_ASSESSMENT*`, `*_RANKING*`, `PLATFORM_NEXT_IMPROVEMENTS_*`, the platform security
notification set, the FW implementation plans and the console recommendation pages), each of which
carried a subset of the same items forward.

**How to use it.** Pick the smallest item that moves the current goal; nothing here is a work queue.
An entry authorises no work by itself — `CLAUDE.md` §6.2 does. When an item ships, delete its row and
let the roadmap record be the evidence; do not rewrite this file as a history.

**Conventions.** *Effort* is S (hours), M (a day), L (several days), XL (a project). *Origin* names the
identifier the item had before consolidation, so a roadmap record can still be found by it. Items the
retired documents already marked implemented (CSV import, Draft PO resume, audit outbox for imports,
movements and PO receive, six-index readiness, FW-07 request references, step-up for destructive admin
actions, the row-status counts and filter persistence) are **not** repeated here.

---

## 1. Release, operations and continuity

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| OPS-1 | Prove a restore on the deployed database tier and publish RPO/RTO | The only measured restore is a synthetic 16-document drill (5.1 s RTO, 4.9 s RPO). A backup that has never been restored on the real tier is a hope, not a plan. | M | IA-04, RD-01 |
| OPS-2 | Deliver security and integrity alerts to a named owner and a named backup | Audit events exist and nobody is notified. Break-glass use, outer-gate refusals or an administrator change stay invisible until somebody opens the console. | M | IA-02, TS-01 |
| OPS-3 | Put a durable global ceiling and operator kill switch on AI spend | Paid fallback can run without a global cap; runaway spend or a model outage is found only by reading the report. | M | IA-05 |
| OPS-4 | Make the release path real: a retained Play AAB, an installed production build, and the iOS decision | No real customer can arrive without a store release and a supportable identity path. | L | IA-09 |
| OPS-5 | Add SLOs, saturation alerts and a degraded-mode drill | Health proves the process is alive, not that it answers in time. The console shares the small instance it monitors. | M | IA-08 |
| OPS-6 | Route incidents with an owner, a timeline and a status path | Detection without a recipient is still an outage. The health watch can open an issue; nothing owns it. | M | IA-10 |
| OPS-7 | Keep the platform secret escrow current | Platform keys have no escrow path, so restoring the database would not restore the ability to run the service. | S–M | IA-04 |
| OPS-8 | Extend tenant data export and verify retention/deletion | Import exists with no equivalent exit; portability and offboarding are trust requirements. | L | IA-14 |
| OPS-9 | Practice the Firebase outage/recovery drill and record both acknowledgements | The plan was written and never run; an untested recovery path is a document, not a capability. | M | PLAT-10–PLAT-14 |

## 2. Data integrity and audit

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| INT-1 | Extend exactly-once, failure-durable audit to every remaining replayable writer | Product import, keyed movements and PO receive have the outbox; a retried route elsewhere can still duplicate or lose an event. | M | AUDIT-DUR-3 |
| INT-2 | Add a tamper-evident seal (hash chain or signed batches) over audit rows | Presence is stronger than before; integrity against an edit or delete is not. | L | AUDIT-DUR-7 |
| INT-3 | Check TTL effectiveness and archive before retention deletion | A 30-day TTL on delivered outbox rows is declared, not measured; compliance may need the receipt after it expires. | S–M | AUDIT-DUR-13, 16 |
| INT-4 | Add a versioned reference snapshot/delta endpoint | Every picker re-reads all pages; a `generation` token plus a delta would cut requests and make completeness provable. | M | PROJ-6 |
| INT-5 | Add a tenant-scope query guard at the model boundary | `businessId` is enforced by convention at every call site; one missing filter is a cross-tenant read. | L | FW-02 |
| INT-6 | Add a cross-tenant route matrix test | Authorization is pinned per role; a foreign-`businessId` request per route is not. | M | NX-03 |
| INT-7 | Decide and enforce the catalogue archive policy for categories with ACTIVE products | Archiving a parent leaves active children; the refusal exists on create but not as a stated policy everywhere. | S–M | AUD-5 |
| INT-8 | Price-data quality pass and a resolution path | Products with no price, zero price or a missing currency are reported by a read-only audit and never resolved. | M | AUD-8 |
| INT-9 | Add approval thresholds for high-risk changes | A second role for large adjustments, receives and deletions makes the worst mistake two-person. | M | DASH-13 |
| INT-10 | Build cycle counting / stocktake sessions | Freeze a location or selection, count against expected, and produce an adjustment with evidence — the missing inventory-accuracy primitive. | L | FW-03 |
| INT-11 | Add an offline-first movement queue | Stock in/out intent persisted locally and replayed with the existing key contract would make a dead zone survivable. | L | DASH-16 |

## 3. Import, purchase orders and receiving

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| IMP-1 | Make import failures repairable: export the row-error CSV, jump to the line, resubmit under the same key | A 300-row file with one bad SKU still leaves the operator reconstructing the fix by hand. | M | PR364-3 |
| IMP-2 | Keep import progress alive outside the screen | Polling stops when the screen unmounts, so a four-minute import can be lost from sight and started again. | M | PR364-4 |
| IMP-3 | Give import receipts retention and observability | `product_imports` has no TTL; counts, durations and stuck `IN_PROGRESS` rows are unmeasured. | M | PR364-5 |
| IMP-4 | Measure and improve import throughput without weakening same-key replay | 300 rows took minutes; measure validation, create and opening stock separately before batching anything. | M–L | PR364-6 |
| IMP-5 | Make an unfinished import discoverable on another device | The draft is device-local; an owner on a second phone cannot see or finish it. | M | PR364-7 |
| IMP-6 | Handle preview-to-apply drift explicitly | Show which rows changed or disappeared between dry run and apply instead of a generic validation refusal. | M | PR364-9 |
| IMP-7 | Bound concurrent imports per tenant | Two owners can start two large imports against one catalogue with nothing but the key contract between them. | M | PROJ-6 |
| IMP-8 | Lift the Draft PO 100-row selection cap | Paging and cross-page selection would let a real restock become one order. | M | PR364-11 |
| IMP-9 | Transmit purchase orders to the supplier (FW-04) | Orders stop at DRAFT/OPEN with no delivery path; PDF plus mail attachment are prerequisites. | L | FW-04 |
| IMP-10 | Add supplier replenishment terms | Lead time, minimum order and pack size are the inputs a restock decision still guesses. | M | FW-05 |
| IMP-11 | Link stock-movement reversal | Corrections are new movements; a linked reversal would keep the audit story readable. | M | FW-06 |
| IMP-12 | Speed up receiving with scanning, partial receipts and discrepancy capture | Receiving is the slowest real-world step and the one most likely to be entered wrong later. | L | DASH-10 |
| IMP-13 | Deliver low-stock alerts with per-tenant rules | The dashboard shows the state; nobody is told when it changes. | M | DASH-8 |

## 4. Mobile experience

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| MOB-1 | Show a per-location stock breakdown on the Dashboard | "Low at 1 of 3 locations" answers the question the single number raises. | M | DASH-3 |
| MOB-2 | Order attention rows by severity server-side | Out before low, then largest shortfall, so the first row is the worst one. | S–M | DASH-4 |
| MOB-3 | Edit minimum stock where it is explained | The screen quotes "minimum N" and offers no way to correct it. | S | DASH-7 |
| MOB-4 | Compact the filter row for small screens | Four chips plus two selectors crowd a 360 dp screen. | S | DASH-5 |
| MOB-5 | Make freshness relative and age-aware | "Updated just now / 2 min ago" plus a refresh affordance beats an absolute timestamp. | S | DASH-15 |
| MOB-6 | Complete the History filter lifecycle | Surface an incomplete or failed reference read instead of silently narrowing the list. | M | DASH-7 |
| MOB-7 | Persist History filters per account | Inventory already restores its filters; History resets on every launch. | S–M | DASH-10 |
| MOB-8 | Add stock-health trend and stocktake entry points | Seven/30-day counts turn a snapshot into a direction. | M | DASH-8 |
| MOB-9 | Add redacted crash/install telemetry and a support diagnostic | App version, device class, route and request reference would replace a screenshot conversation. | M | DASH-14 |

## 5. AI assistant

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| AI-1 | Catalogue-wide run-out ranking | The coverage tool answers one product; "which products will run out first" needs one bounded aggregate. | M | IA-20 |
| AI-2 | Two-product and current-versus-minimum comparison | One scoped read that labels both sides removes an arithmetic answer nobody can check. | S–M | IA-22 |
| AI-3 | Answer provenance and a scope envelope | Every answer states the data as-of, the population and the filters it used. | M | PD-01 |
| AI-4 | Pre-answer data-quality gate | Refuse or qualify a price/stock-value/coverage answer when the underlying data is incomplete. | M | PD-02 |
| AI-5 | Unit-of-measure and pack metadata | "12" is ambiguous when a pack, a case and a piece all exist. | M | PD-04 |
| AI-6 | Coverage evidence and confidence gate | A coverage estimate from two movements should say so rather than present a number. | M | AIC-1 |
| AI-7 | Days-to-minimum and reorder trigger | Turns a quantity into a date, which is what a buyer acts on. | M | AIC-2 |
| AI-8 | Stockout-censored demand correction | Days at zero stock hide demand; the estimate is biased without it. | M | AIC-4 |
| AI-9 | Outlier-resistant estimator | Trim or flag one-off bulk issues, damage and write-offs. | M | AIC-5 |
| AI-10 | Intermittent-demand handling | Slow movers need a different estimator, not a worse average. | M | AIC-6 |
| AI-11 | Transfer-aware location coverage | A location-scoped answer should say when stock is available elsewhere. | M | AIC-7 |
| AI-12 | Coverage outcome ledger and backtesting | Record redacted inputs and estimates so accuracy can be judged later. | L | AIC-8 |
| AI-13 | Supplier/PO-aware restock | Include lead time, inbound ETA and minimum order in the recommendation. | L | AIC-9 |
| AI-14 | Controlled stock-out reason codes | Distinguish sale, internal use, damage and write-off instead of one silent deduction. | M | AIC-10 |

## 6. Platform and security

| # | Item | Why it matters | Effort | Origin |
|---|---|---|---|---|
| SEC-1 | Put a controlled identity-aware access layer in front of the console | The console is public and the shared key is not per-person; this needs an owned domain. | M | IA-01 |
| SEC-2 | Time-bound support grants and the tenant-detail gate | Support cannot answer "what happened to this tenant?" without a reason-bound, expiring read. | M | IA-07 |
| SEC-3 | Add access recertification | Roles and accounts have no periodic re-approval, so stale access persists silently. | M | TS-02 |
| SEC-4 | Add an AI isolation canary | A cheap automated probe that a prompt cannot reach another tenant's data. | M | TS-03 |
| SEC-5 | Publish a security posture scorecard | One number per control turns a checklist into something that can regress visibly. | M | TS-04 |
| SEC-6 | Offer tenant MFA | Platform administrators have TOTP/WebAuthn; business members have a password only. | L | TS-05 |
| SEC-7 | Add mail-domain anti-spoofing (SPF, DKIM, DMARC) | Verification codes are the account-recovery root; a spoofable domain undercuts them. | S–M | TS-06 |
| SEC-8 | Add the sensitive-data log canary (C1–C14) | The redaction boundary is designed and unproven against real log output. | M | NX-01 |
| SEC-9 | Add CodeQL or an equivalent static scan | Dependency review is gated; first-party code has no static analysis gate. | S–M | NY-01 |
| SEC-10 | Audit the workflows themselves | Action pins, permissions and triggers are guarded; the threat model behind them is not written down. | M | NY-04 |
| SEC-11 | Decide on App Check | The mobile client is an unauthenticated transport until it signs in. | M | NY-07 |
| SEC-12 | Add AI provider data-handling attestation | What the provider retains is a compliance question the project has never answered in writing. | S | NY-05 |
| SEC-13 | Add a release-artifact secret/PII scan | APKs and bundles are built and published without a scan of their contents. | M | NY-06 |
| SEC-14 | Version and rotate the platform access key | One shared key has no version, no rotation date and no owner per use. | M | PLAT-22 |
| SEC-15 | Add session inventory and revocation for administrators | Sessions can be revoked per user; an operator cannot list and end them. | M | PLAT-22 |
| SEC-16 | Add password-breach screening | Password policy checks shape, not whether the password is already public. | S–M | PLAT-22 |
| SEC-17 | Add anti-automation to the outer gate | Per-address and global budgets exist; a distributed attempt still looks like normal traffic. | M | PLAT-22 |
| SEC-18 | Add factor rotation and recovery-code reissue | Enrolment is forced once; rotation has no path. | M | PLAT-22 |
| SEC-19 | Finish audited operator address activation | The CLI records creation; assigning an address is still unimplemented. | M | PLAT-26 |
| SEC-20 | Run the two-contact notification test and activate alerts | The procedure, checklist and evidence record were prepared and never executed. | S | PLAT-13–PLAT-14 |
| SEC-21 | Check runbook and external-link freshness on a schedule | Stale procedures are worse than none; nothing currently notices. | S | NY-05 |
