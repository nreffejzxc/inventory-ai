# Inventory AI — multi-criteria improvement ranking

**Status:** **BRAINSTORMING AND PRIORITIZATION ONLY. NO IMPLEMENTATION IS AUTHORIZED.**
**Reviewed:** 2026-11-17
**Budget:** **$0 incremental.** Every idea below can be evaluated or delivered with existing free
tiers, local tooling, repository records and the owner's time. No paid subscription, domain purchase
or paid support plan is proposed.

This page reviews the existing roadmap and the free-first plans, then ranks the additive opportunities
against seven criteria:

1. **Security** — reduces the chance or impact of unauthorized access, credential loss or data exposure.
2. **Reliability** — improves recovery, availability, correctness or failure containment.
3. **Performance** — improves latency, startup, throughput or resource use.
4. **User experience** — makes the product clearer, faster to learn or less frustrating.
5. **AI capabilities** — improves the assistant's usefulness, safety or evaluation.
6. **Operational efficiency** — reduces manual work, support load or operator risk.
7. **Business value** — improves readiness for a paying customer, retention or revenue.

Scores are **1–5 per criterion, equal weight**, maximum 35. Equal weighting is deliberate: it avoids
hiding a weak security/reliability item behind a strong business score. Ties are broken by security,
then reliability, then business value. A low score is not a rejection; it means “later, or only with
evidence.”

## 1. What is already covered

- [`INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md`](INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md) — `IA-01`–`IA-18`.
- [`INVENTORY_AI_FOLLOWUP_ASSESSMENT.md`](INVENTORY_AI_FOLLOWUP_ASSESSMENT.md) — `IA-19`–`IA-29`.
- [`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) — the eight assistant
  improvements.
- The Cloudflare, alert-ownership and restore plans delivered in the previous planning package.

This page does **not** re-open those decisions. It adds four candidates that are not represented by
an existing ID (IA-30–IA-33), scores the combined additive set, then adds four more candidates from
the second review (IA-34–IA-37) on the same scale.

| New ID | Candidate | Why it is not already covered |
| --- | --- | --- |
| **IA-30** | Support knowledge base and in-app help | Support is mentioned as a role/SLA, but there is no self-service content or help surface |
| **IA-31** | Performance budgets and regression watch | Existing work measures specific paths; there is no standing p95/startup budget with a free regression check |
| **IA-32** | Preventive inventory data-quality guards | `INVENTORY_INTEGRITY.md` audits orphan stock; duplicate SKU/barcode and invalid quantity prevention is not a roadmap item |
| **IA-33** | Feature-flag / kill-switch registry | AI has a model switch; there is no general, audited way to disable a risky feature without a deploy |

Deliberately excluded as duplicates: access (`IA-01`), alert ownership (`IA-02`), audit export
(`IA-03`), AI budget (`IA-05`), support grants (`IA-07`), release readiness (`IA-09`), crash telemetry
(`IA-11`), AI evaluation (`IA-15`), retention/deletion (`IA-18`), Cloudflare/restore plans, ticket SLA
(`CI-13`/`CI-14`) and the existing assistant roadmap.

## 2. Ranked additive set

| Rank | ID | Candidate | Sec | Rel | Perf | UX | AI | Ops | Biz | Total | Why it matters / benefit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **IA-23** | Mobile offline/read-only resilience | 2 | 5 | 4 | 5 | 1 | 2 | 4 | **23** | Stock work happens in poor-signal areas; an honest last-known read prevents blank screens and silent failed writes. |
| 2 | **IA-20** | Firebase outage/recovery drill | 4 | 5 | 1 | 3 | 1 | 4 | 4 | **22** | Firebase can block every new sign-in while the API looks healthy; a tested recovery path is required before customers rely on it. |
| 3 | **IA-25** | First-customer onboarding/trial checklist | 2 | 3 | 3 | 5 | 1 | 3 | 5 | **22** | A store install is not a successful onboarding; a repeatable first-run path reduces early churn and support load. |
| 4 | **IA-19** | Backup index/collection-option manifest | 5 | 5 | 2 | 1 | 1 | 4 | 3 | **21** | A document-only restore can look complete while unique/partial indexes and validators are missing; this is a recovery-integrity fix. |
| 5 | **IA-21** | Auth-email deliverability and bounce watch | 3 | 5 | 1 | 4 | 1 | 3 | 4 | **21** | Verification and reset codes are useless if Brevo silently degrades; a free daily count catches onboarding failure early. |
| 6 | **IA-31** | Performance budgets and regression watch | 1 | 4 | 5 | 4 | 1 | 3 | 3 | **21** | Without a p95/startup budget, performance regressions reach users as “the app is slow” with no early signal. |
| 7 | **IA-22** | AI conversation retention/redaction | 4 | 3 | 1 | 2 | 4 | 3 | 3 | **20** | Prompts and answers can contain prices, suppliers or personal text; a documented retention/redaction rule is a privacy boundary. |
| 8 | **IA-32** | Preventive data-quality guards | 2 | 4 | 2 | 4 | 1 | 3 | 4 | **20** | Duplicate SKUs/barcodes and invalid quantities corrupt the inventory story before any report can be trusted. |
| 9 | **IA-30** | Support knowledge base / in-app help | 1 | 3 | 1 | 4 | 1 | 5 | 4 | **19** | The owner is the only support path; free self-service answers reduce repeat interruptions and make onboarding more independent. |
| 10 | **IA-24** | Free-tier quota/cost watch | 2 | 4 | 1 | 2 | 1 | 5 | 3 | **18** | A free-tier ceiling can look like an outage and an overage can create an unexpected bill; a weekly check is free. |
| 11 | **IA-27** | SBOM and dependency provenance | 5 | 3 | 1 | 1 | 1 | 4 | 2 | **17** | A generated SBOM makes the next dependency incident or release audit faster without a paid service. |
| 12 | **IA-33** | Feature-flag / kill-switch registry | 3 | 4 | 1 | 1 | 1 | 4 | 3 | **17** | A bounded, audited switch can contain a failing AI/import/notification feature without an emergency deploy. |
| 13 | **IA-28** | Privacy-safe tenant adoption signals | 2 | 2 | 2 | 2 | 1 | 4 | 4 | **17** | Aggregate activation counts show whether onboarding works without exposing tenant detail. |
| 14 | **IA-26** | Accessibility/localization QA | 1 | 2 | 2 | 5 | 1 | 2 | 4 | **17** | Inventory work is one-handed and often non-English; a recurring free QA pass protects the existing design/language investment. |
| 15 | **IA-29** | Data-residency/compliance decision | 4 | 2 | 1 | 1 | 1 | 3 | 3 | **15** | A written provider/region decision prevents accidental architecture and answers a future customer question cheaply. |

### 2.1 New candidates from the second review (IA-34–IA-37)

These are additional to IA-19–IA-33 and were not part of the earlier ranking. They are scored on the
same seven criteria and equal-weight scale.

| New rank | ID | Candidate | Sec | Rel | Perf | UX | AI | Ops | Biz | Total | Placement if inserted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **IA-34** | API contract-drift gate | 2 | 4 | 3 | 4 | 1 | 4 | 3 | **21** | Joint 4th–8th (21/35) |
| 2 | **IA-37** | Query-plan/index regression watch | 2 | 4 | 5 | 3 | 1 | 4 | 2 | **21** | Joint 4th–8th (21/35) |
| 3 | **IA-35** | Recovery/rotation freshness attestation | 5 | 4 | 1 | 1 | 1 | 5 | 3 | **20** | Joint 9th–12th (20/35) |
| 4 | **IA-36** | Incident communication templates | 2 | 4 | 1 | 3 | 1 | 4 | 5 | **20** | Joint 9th–12th (20/35) |

**Why these are not duplicates.** IA-34 is not the §2.6 route inventory: it compares the server's
actual response/error contract with the mobile client's expectations. IA-35 is not the initial
contact registration: it checks that recovery codes, key age and both contact paths stay current. IA-36
is not ticket SLA/incident routing: it prepares the customer-facing message. IA-37 is not IA-31's API
p95 budget: it checks database plan/index regressions directly.

### Rank groups

- **Protect recovery and first use (top 6):** IA-23, IA-20, IA-25, IA-19, IA-21, IA-31. These are
  close enough that the order should move with evidence; security/reliability ties put IA-20 and
  IA-19 ahead of a pure UX item.
- **Establish privacy and data trust (next):** IA-22, IA-32, IA-30.
- **Operate within free limits (weekly):** IA-24, IA-33, IA-27.
- **New 21-point band:** IA-34 (API contract) and IA-37 (query plans) join IA-19, IA-21 and IA-31;
  the tie-break favours security/business, not novelty.
- **New 20-point band:** IA-35 (recovery freshness) and IA-36 (incident messaging) join IA-22 and
  IA-32; IA-35 outranks IA-22 on security, and IA-36 outranks IA-32 on business value.
- **Later, when customers or evidence exist:** IA-28, IA-26, IA-29.

## 3. What each new idea would do

### IA-34 — API contract-drift gate

**Opportunity.** Keep a small, versioned snapshot of the mobile client's required request/response
fields and error codes, and compare it with the server contract in CI. Fail or flag when a field,
status, code or auth/tenant shape changes without a deliberate client update.

**Why it matters.** The app and server are separate release surfaces. A server rename can look like a
network error on an installed phone that cannot be updated immediately. Auth, business and role fields
are especially costly because a mismatch can look like a sign-in or permission failure.

**Benefit.** Catches a breaking contract before release, shortens incident diagnosis and protects older
installed builds. **Risk:** a snapshot can become a second source of truth; derive it from tests or
types and review changes rather than hand-maintaining prose.

**Acceptance.** A deliberate field/status change fails or flags the check with the exact contract
location; an additive compatible field passes; the check needs no paid service.

**Free approach.** Existing tests and CI; a checked-in contract fixture; no new vendor.

### IA-35 — Recovery/rotation freshness attestation

**Opportunity.** A monthly, dated checklist that confirms recovery codes still exist in the offline
store, the backup contact still receives a test, the Firebase Admin key age/ID is known, and the
runbook links resolve. Open a GitHub issue on a miss; do not store the codes in the repository.

**Why it matters.** Security controls decay silently: a code is used, a contact changes, a key ages, a
runbook link rots. The owner is the only operator, so an untested recovery path is a single point of
failure even when the documents are accurate.

**Benefit.** Turns “we have a runbook” into evidence that it still works; catches contact/key drift
before an incident. **Risk:** the checklist itself must not collect secrets or personal contact details.

**Acceptance.** A dated attestation exists; a deliberately broken test link/contact produces a visible
issue; no code, key or private contact value is written to the repo.

**Free approach.** Existing GitHub issues, calendar reminder and local checklist; no paid service.

### IA-36 — Incident communication templates

**Opportunity.** Prewrite short, honest messages for an authentication outage, a verified data issue,
planned maintenance and recovery, with placeholders only for time/scope. Keep them in the repository
without customer data.

**Why it matters.** During an incident, improvised wording can overpromise, leak detail or blame the
wrong component. A template keeps the message consistent with the actual failure class and the
no-fallback rule. It also gives the named backup a ready starting point.

**Benefit.** Faster, calmer communication and less reputational risk; no paid status-page service
required for the first customers. **Risk:** stale templates; review after each incident.

**Acceptance.** Templates cover sign-in unavailable, data concern, maintenance and recovery; each says
what is known, what is not, and when the next update will come; no template contains a secret or tenant
data.

**Free approach.** Repository documents and GitHub issues; no paid helpdesk or status page.

### IA-37 — Query-plan/index regression watch

**Opportunity.** Run `explain` on a fixed set of the most important inventory/query paths against a
representative local fixture, record the winning plan and flag a new collection scan or a lost index.
Keep it separate from the API p95 budget (IA-31).

**Why it matters.** The existing index-integrity guard proves declarations and builds; it does not prove
the optimizer still chooses the intended plan after a query or data-shape change. A plan regression can
make a healthy endpoint become slow at the worst time.

**Benefit.** Early warning before customer-visible latency; makes index decisions evidence-based.
**Risk:** plans vary by data distribution and MongoDB version; pin the fixture/version and treat a
change as a prompt to investigate, not an automatic production rollback.

**Acceptance.** A known indexed query reports the intended index; a deliberately dropped index/plan
change is detected; the check stores no tenant data and is reproducible locally.

**Free approach.** Existing MongoDB/local fixtures and scripts; no paid APM.

### IA-30 — Support knowledge base and in-app help

**Opportunity.** A small set of free, versioned answers for the failures that generate support: sign-in
and verification delay, invitation not received, first stock-in, barcode not found, offline read-only,
and how to contact the owner. Link it from the app and the repository; no helpdesk subscription.

**Why it matters.** The owner is the primary and only support path. Repeating the same answer is
expensive and makes the product feel unfinished. A short, accurate help surface also gives the future
backup contact something to point to instead of improvising.

**Benefit.** Fewer interruptions, faster onboarding and a consistent answer when the owner is
unavailable. **Risk:** stale help is worse than no help; every article needs an owner and review date.

**Acceptance.** Every article is reachable from the app or a stable free page, matches the current
build, contains no credential/tenant data, and is reviewed with the onboarding checklist.

### IA-31 — Performance budgets and regression watch

**Opportunity.** Set simple budgets using existing measurements: API p95 for the main read/write
routes, cold-start and first-render time on the target Android device, and assistant first-token
latency. Record the baseline in the repository and fail or flag a regression in the existing free CI
where the measurement is deterministic.

**Why it matters.** Free-tier CPU and a mobile network make performance a reliability issue, not a
polish item. Without a baseline, “it feels slow” arrives only after a customer complains. Paid APM is
not needed for a few bounded measurements.

**Benefit.** Earlier regression detection, honest capacity expectations and a measurable release gate.
**Risk:** flaky CI timing creates noise; only deterministic local/deployed measurements should gate.

**Acceptance.** A dated baseline exists for each budget; a deliberately slow fixture fails or flags
the check; the measurement is reproducible and stores no tenant data.

### IA-32 — Preventive inventory data-quality guards

**Opportunity.** Prevent duplicate SKU/barcode values, negative or impossible quantities, and
references to archived locations/products at write time, with a clear correction message. Keep the
existing read-only orphan audit as the detective control.

**Why it matters.** Inventory AI's value depends on the numbers being trustworthy. A duplicate scan
or a negative quantity can silently corrupt stock, purchasing and the assistant's answers; fixing it
after the fact costs more than refusing the write.

**Benefit.** Fewer bad records, more trustworthy reports and less support time. **Risk:** over-strict
validation can block a legitimate correction; scope it to invariants, not workflow preference.

**Acceptance.** A test fixture with a duplicate barcode, duplicate SKU and negative quantity is refused
with a bounded error; valid corrections still work; no existing valid record is rewritten.

### IA-33 — Feature-flag / kill-switch registry

**Opportunity.** A small owner-controlled registry for disabling a risky runtime feature (AI turn,
bulk import, notification send) without a deploy, with the reason, actor and time audited. Default
must be “enabled” for existing behavior; a flag must never bypass authorization or turn a security
control off.

**Why it matters.** The current AI kill switch is model-specific. A general switch contains a failing
feature quickly while preserving the rest of the app, which matters when the owner is the only
operator. It is not a substitute for a rollback or an access control.

**Benefit.** Faster containment and less deploy pressure. **Risk:** flag sprawl and stale switches;
limit the set, expire them and audit changes. Do not introduce a paid flag service.

**Acceptance.** An owner can disable and re-enable one feature, the change is audited, unauthorized
callers cannot change it, and the disabled path fails closed with a bounded message.

## 4. Recommended sequence after the approved work

The owner has approved the sequence: **security alert accountability → Firebase recovery → future
improvement planning.** This ranking does not displace that sequence. Once the first two are recorded:

1. **IA-19** — finish restore fidelity before trusting a restore.
2. **IA-23** — make the phone honest when the network is gone.
3. **IA-25** — run a real first-customer onboarding before inviting one.
4. **IA-21** — watch auth-email delivery.
5. **IA-31** — set the performance baseline while the system is small.
6. **IA-22 / IA-32** — set the AI privacy rule and inventory invariants.
7. **IA-30 / IA-24 / IA-33 / IA-27** — operate the free baseline.
8. **IA-34 / IA-37** — add the contract and query-plan checks while the system is small.
9. **IA-35 / IA-36** — make recovery freshness and incident messaging routine.
10. **IA-28 / IA-26 / IA-29** — revisit when customers, team or contracts exist.

The order is close enough that the owner may swap adjacent items when a concrete failure or customer
need provides better evidence. It is a planning recommendation, not an authorization.

## 5. What remains deferred

Paid domain purchase, Cloudflare paid log retention, Tailscale Standard, Render Scale/Enterprise,
paid pager/on-call, paid Atlas backup tier, paid observability/DLP/email/analytics/helpdesk and paid
identity support remain deferred until recurring revenue or a measured free-tier ceiling makes them
necessary. No item above requires them.

## 6. Sources

- [`INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md`](INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md) — IA-01–IA-18.
- [`INVENTORY_AI_FOLLOWUP_ASSESSMENT.md`](INVENTORY_AI_FOLLOWUP_ASSESSMENT.md) — IA-19–IA-29.
- [`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) — assistant roadmap.
- [`PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md`](PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md) — restore/index gap.
- [`PLATFORM_FIREBASE_RECOVERY_DRILL_PLAN.md`](PLATFORM_FIREBASE_RECOVERY_DRILL_PLAN.md) — identity recovery.
- [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) — primary/backup accountability.
- [`INVENTORY_INTEGRITY.md`](INVENTORY_INTEGRITY.md) — existing orphan-stock audit.
