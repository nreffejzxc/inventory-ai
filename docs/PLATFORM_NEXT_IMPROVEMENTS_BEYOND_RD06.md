# Security, reliability and documentation improvements beyond RD-06

**Status:** **BRAINSTORMING, EVALUATION AND RECOMMENDATIONS ONLY.** Nothing here authorizes code,
configuration, a notification, an alert, a deployment or a paid service.

**Reviewed:** 2026-11-17
**Basis:** the full project conversation and roadmap, IA-01-IA-45, TS-01-TS-06, SEC-01-SEC-12,
RD-01-RD-06, the monitoring/readiness records, and the current production state at `e218bb0`.

## 1. Scope

This is the tranche **after** RD-01-RD-06. It looks for gaps that survive the earlier reviews:
sensitive-data visibility, retry-safe writes, cross-tenant route proof, emergency switches,
incident learning, dependency rollback and external security-header drift.

It deliberately does not repeat:

| Existing item | Why it is excluded here |
| --- | --- |
| IA-01-IA-03 | Access layer, platform alerting, audit export/retention |
| IA-04 / IA-19 / IA-35 | Restore/index drill, backup fidelity, recovery freshness |
| IA-06 / SEC-08 | Platform step-up and dual control |
| IA-08 / IA-31 / IA-37 | SLOs, performance budgets, query-plan watch |
| IA-15 / TS-03 | AI evaluation and tenant-isolation canary |
| IA-16 | Multi-instance shared rate-limit/lockout store |
| IA-22 | AI conversation retention/redaction |
| IA-27 | SBOM and dependency provenance |
| IA-34 / IA-38 | API contract drift and minimum client version |
| IA-36 | Incident communication templates |
| IA-39 / IA-41 / IA-44 | Tenant export, support bundle, owner activity log |
| IA-40 | Provider readiness probe |
| SEC-09 / SEC-12 | Platform alerts and access review |
| TS-01-TS-06 | Tenant security notifications through mail anti-spoofing |
| RD-01 | Dependency outage matrix and local drill |
| RD-02 | Transactional notification outbox |
| RD-03 | Security review gate for new routes/tools |
| RD-04 | Tenant-scoped abuse/fairness budgets |
| RD-05 | Runtime configuration drift report |
| RD-06 | Documentation command index and verification |

## 2. Method

Each item is scored **1-5** on six equally weighted criteria, maximum **30**:

1. **Impact** - how much a real failure, exposure or repeated operational error is reduced.
2. **Likelihood** - how likely the problem is with the current system.
3. **Blast radius** - how many tenants, users, records or decisions are affected.
4. **Free feasibility** - existing resources, tests and local tools score 5.
5. **Business value** - customer trust, support quality or operational confidence.
6. **Time to value** - 5 means days, 3 means weeks, 1 means a project.

Ties are broken by impact, then likelihood, then free feasibility. The order is a recommendation,
not an authorization.

## 3. Ranked recommendations

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **NX-01** | Sensitive-data map and log-redaction canary | 5 | 4 | 5 | 5 | 4 | 4 | **27** |
| 2 | **NX-02** | Idempotency coverage for remaining writes | 5 | 4 | 4 | 5 | 4 | 4 | **26** |
| 3 | **NX-03** | Cross-tenant authorization matrix for non-AI routes | 5 | 4 | 4 | 4 | 4 | 4 | **25** |
| 4 | **NX-04** | Feature-flag and emergency-switch registry | 4 | 3 | 4 | 5 | 4 | 4 | **24** |
| 5 | **NX-05** | Incident tabletop and postmortem template | 4 | 3 | 4 | 5 | 3 | 4 | **23** |
| 6 | **NX-06** | Last-known-good dependency rollback rehearsal | 4 | 3 | 3 | 5 | 3 | 4 | **22** |
| 7 | **NX-07** | Security-header and cookie drift probe | 3 | 3 | 3 | 5 | 3 | 4 | **21** |

### Rank 1 - NX-01 Sensitive-data map and log-redaction canary

**What.** Maintain one inventory of where personal or sensitive data can appear: user name/email,
Firebase uid, session `jti`, reset/verification tokens, IP/user-agent, audit metadata, AI prompts and
answers, mail addresses, support evidence and backups. For each entry name the storage, retention,
access path and the log/error-redaction rule. Add a local canary suite that runs representative
failures and asserts that a planted token, email and uid do not appear in captured logs or HTTP
bodies.

**Design:** [`PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md`](PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md) —
the full field map, approved appearances, concrete code findings, the C1–C14 canary and acceptance checks.

**Why it matters.** The project has strong individual controls: the mail layer discards provider
text, the AI layer uses safe error types, the mobile PII log is patched, and the docs warn about
redaction. What is missing is one map that proves the controls agree across every path, plus a test
that a future log line cannot quietly add a secret. IA-22 is AI retention, IA-41 is a support bundle
and ISS-02 is a mobile log; none is the whole-product map.

**Benefit.** Lower privacy exposure, faster incident triage and a reusable review input for new
routes and AI tools. **Risk:** a map can become a document nobody updates; make the canary test the
enforcement and review the map with the existing 90-day cadence.

**Free approach.** Existing source boundaries, test harness, log capture and documentation guards. No
data-discovery SaaS and no production log export.

**Acceptance.** Every listed field has an owner and a storage/retention statement; a planted secret
in a representative failure does not appear in a captured log or response; adding an unredacted
field fails the canary; the map contains no actual secret or private contact detail.

**Exclusions.** IA-22 (AI retention), IA-41 (support bundle), ISS-02 (mobile log), SEC-05 (audit
retention) and any paid DLP service.

### Rank 2 - NX-02 Idempotency coverage for remaining writes

**What.** Build a route-by-route matrix of state-changing requests: does the client send an
`Idempotency-Key`, does the middleware claim/replay it, what is the duplicate outcome, and what
happens after a timeout with an unknown result? The four inventory movement routes and purchase-order
create/receive already accept a key. Extend the decision to products, categories, locations,
suppliers, users, invitations and settings, using the existing middleware rather than a second
mechanism.

**Why it matters.** A database or network timeout can leave the client unsure whether a create or
update committed. Retrying a stock movement is protected today; retrying a product create or an
invitation can produce a duplicate or a confusing conflict. RD-01 records ambiguous writes; this
item makes the retry contract explicit instead of leaving each caller to guess.

**Benefit.** Fewer duplicate records, safer client retries and a clear post-outage reconciliation
story. **Risk:** an idempotency key is not a licence to replay forever; define the TTL, conflict and
in-progress answers and keep the existing 24-hour record.

**Free approach.** Existing `idempotent()` middleware, MongoDB unique index and tests. No queue or
paid dedupe service.

**Acceptance.** Every mutating route is classified as keyed or deliberately not keyed; keyed routes
replay the first answer without a second write; reuse with a different body is refused; an
in-progress duplicate gets the bounded conflict; the matrix is linked from the route inventory.

**Exclusions.** RD-02 (notification outbox), IA-16 (shared limiter store) and a general event bus.

### Rank 3 - NX-03 Cross-tenant authorization matrix for non-AI routes

**What.** Generate a table of every authenticated route, the roles allowed, the object ownership
check used, and the test that proves tenant A cannot read or mutate tenant B's object. Cover reads,
writes, exports, invitations, support grants, audit reads and platform-adjacent routes. Keep AI
output isolation in TS-03 and keep this focused on HTTP object authorization.

**Why it matters.** The route inventory proves the route exists and its gate type; individual suites
prove their own feature. A single matrix exposes a route that is authenticated but forgets the
`businessId` filter, or a new role that gains a route without an isolation test. This is the
authorization counterpart to TS-03's AI canary and RD-03's future review gate.

**Benefit.** A missing tenant filter becomes visible before release, and a reviewer can see the
whole surface at once. **Risk:** the matrix can claim coverage a test does not actually exercise;
require a test name or file per row.

**Free approach.** Existing route inventory, test harness, two synthetic tenants and local database.
No paid authorization scanner.

**Acceptance.** Every authenticated route has a row; every row names the ownership check and a
passing two-tenant test; a deliberately removed `businessId` filter fails the matrix; no production
tenant data is used.

**Exclusions.** TS-03 (AI output isolation), RD-03 (review gate for new routes) and IA-15 (AI
evaluation).

### Rank 4 - NX-04 Feature-flag and emergency-switch registry

**What.** A single registry of operational switches: AI assistant, web tools, mail, notifications,
platform access, paid escalation, health watchdog and any future feature flag. For each record the
owner, default, storage (environment or database), safe/unsafe states, rollout order, kill-switch
procedure and the test that proves the off state.

**Why it matters.** Several controls are already switches: an empty `AI_PROVIDER` disables the
assistant, `MAIL_PROVIDER` empty disables mail, web capabilities default off, and future TS-01
notifications will default off. The knowledge is spread across env templates, code and runbooks. A
single registry makes an emergency "turn it off" decision fast and prevents a flag from being left
on after an incident.

**Benefit.** Faster containment, safer rollouts and fewer config surprises. **Risk:** a registry can
drift; generate the names from the environment schema where possible and use RD-05's drift report as
the enforcement.

**Free approach.** Existing config validation, `.env.example`, tests and docs. No feature-flag SaaS.

**Acceptance.** Each switch has one canonical name and owner; the off state is tested; an unknown
switch or a value outside its declared states is rejected; the registry contains names/status only,
never values.

**Exclusions.** RD-05 (runtime drift), RD-02 (outbox enablement) and IA-16 (shared limiter state).

### Rank 5 - NX-05 Incident tabletop and postmortem template

**What.** Run a short, dated tabletop for one realistic scenario (MongoDB loss, Firebase outage,
Brevo outage or a suspected tenant-data exposure) using the existing monitoring and dependency
matrix. Produce a postmortem template with timeline, impact, detection, root cause, what went well,
what failed, evidence links and owned follow-ups. Store it as a record, not a live status page.

**Why it matters.** IA-36 prepares customer-facing wording, and the monitoring plan defines severity
and escalation; neither is a rehearsal of the decisions the owner must make with partial information.
A tabletop tests the runbook without an outage, and a postmortem template prevents an incident review
from becoming an unstructured chat.

**Benefit.** Faster, more consistent incident response and a durable learning loop. **Risk:** a
tabletop that never happens is worse than none; schedule it and record the date, even if the result
is "gaps found".

**Free approach.** Existing runbooks, monitoring plan, contact record and a local scenario. No paid
incident tool.

**Acceptance.** One dated tabletop is recorded; every decision has an owner; gaps become owned
follow-ups; the postmortem template has no place for secrets or private contact details; no
production action or notification is performed.

**Exclusions.** IA-36 (message templates), IA-10/CI-14 (routing/on-call), RD-01 (dependency matrix)
and any paid pager.

### Rank 6 - NX-06 Last-known-good dependency rollback rehearsal

**What.** For one dependency update or provider change, rehearse a local rollback to the last known
good lockfile/configuration: restore the previous lockfile, install with the existing package
manager, run the focused build/tests and record the result. Keep the last-known-good reference and
the commands in a short runbook.

**Why it matters.** IA-27 generates an SBOM and provenance snapshot; IA-38 handles contract drift.
Neither proves that the project can actually return to the previous dependency set after a bad
upgrade. A rehearsed rollback turns "pin it and hope" into a measured recovery path.

**Benefit.** Shorter dependency-incident recovery and confidence in the lockfile. **Risk:** the
rehearsal must use a disposable branch/worktree and must not rewrite the committed lockfile
carelessly; keep the change out of production.

**Free approach.** Existing lockfiles, local package cache and CI-equivalent commands. No paid
artifact store.

**Acceptance.** A previous lockfile is restored locally; install and the focused suite pass; the
working tree is returned to the committed state; the runbook names the last-known-good commit and
the exact commands; no production dependency is changed.

**Exclusions.** IA-27 (SBOM), SECURITY_DEPENDENCY_DECISIONS (advisory disposition) and a general
release-management platform.

### Rank 7 - NX-07 Security-header and cookie drift probe

**What.** Add a small read-only check that compares the deployed response headers and cookie flags
against the documented production values: HSTS, CSP, `X-Content-Type-Options`, frame policy,
referrer policy, CORS origins and the platform session cookie's `HttpOnly`/`Secure`/`SameSite`/Path.
Run it manually or from an existing free scheduler.

**Why it matters.** PR-02/PR-05 were verified at deployment, but a proxy, host or configuration change
can silently weaken a header later. The project already has a production health watch; a header
drift check is a cheap complement that does not read tenant data.

**Benefit.** Earlier detection of a security regression and a concrete deployment check. **Risk:** a
header check can be noisy or target the wrong origin; pin the exact URLs and treat a network failure
as "not checked", not as a pass.

**Free approach.** `curl`/Node `fetch`, existing docs and the current scheduler. No paid scanner or
external dashboard.

**Acceptance.** The expected values are documented once; a deliberately altered header or cookie
flag is detected; a network failure is reported as inconclusive; no credential, token or tenant data
is sent or printed; the probe is read-only.

**Exclusions.** PR-02/PR-05 (the one-time production verification), IA-01 (access layer) and a paid
external attack-surface scanner.

## 4. Recommended order

After the current fixes and RD-01's local drill:

1. **NX-01** - know where sensitive data can appear before adding more surfaces.
2. **NX-02** - make retry behaviour explicit before the next outage exercise.
3. **NX-03** - prove the tenant boundary across the whole HTTP surface.
4. **NX-04** - make the emergency switches findable.
5. **NX-05** - rehearse the response once, then keep the template.
6. **NX-06** - prove a dependency rollback before it is needed.
7. **NX-07** - add the cheap external drift check last.

## 5. What is deliberately not proposed

- No paid DLP, feature-flag, incident, SBOM, scanner or observability service.
- No production fault injection, notification, alert activation, deployment or database write.
- No replacement for the existing audit trail, rate limiters, docs guards, restore plan or TS/RD
  work; these are gaps those items do not cover.

## 6. Related records

- [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) - RD-01 local drill.
- [`PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md`](PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md) - RD-01-RD-06.
- [`PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md`](PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md) - TS-01.
- [`PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md`](PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md) - TS-01-TS-06.
- [`INVENTORY_AI_MULTI_CRITERIA_RANKING.md`](INVENTORY_AI_MULTI_CRITERIA_RANKING.md) - IA-19-IA-45.
- [07 — Security recommendations](./platform-console/07-security-recommendations.md) - SEC-01-SEC-12.
