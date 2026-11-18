# Security, reliability and documentation improvements beyond TS-06 and IA-45

**Status:** **BRAINSTORMING, EVALUATION AND RECOMMENDATIONS ONLY.** Nothing here authorizes code,
configuration, a production change, a notification, a deployment or a paid service.

**Reviewed:** 2026-11-17
**Basis:** the complete project conversation and roadmap, IA-01-IA-45, TS-01-TS-06, SEC-01-SEC-12,
the platform monitoring/readiness records, the current production state at `e218bb0`, and the
existing mail, audit, session and rate-limit boundaries.

## 1. Scope and exclusions

This is the **next** tranche after the tenant-security review. It concentrates on failure behaviour,
delivery durability, security review discipline and documentation verifiability. It does not repeat:

| Existing item | Why it is excluded here |
| --- | --- |
| IA-01 / IA-02 / IA-03 | Access layer, platform alerting and audit export |
| IA-04 / IA-19 / IA-35 | Restore/index drill, backup fidelity and recovery freshness |
| IA-06 / SEC-08 | Platform-admin step-up and dual control |
| IA-08 / IA-31 / IA-37 | SLOs, performance budgets and query-plan watch |
| IA-15 / TS-03 | AI evaluation and tenant-isolation canary |
| IA-16 | Multi-instance shared rate-limit/lockout store |
| IA-34 / IA-38 | API contract drift and minimum client version |
| IA-39 / IA-44 | Tenant export and owner activity log |
| IA-40 | Provider readiness probe |
| TS-01 | Tenant security notifications |
| TS-02 | Tenant access recertification |
| TS-04 | Owner security posture scorecard |
| TS-05 | Tenant MFA/step-up |
| TS-06 | Mail-domain anti-spoofing |
| SEC-09 / SEC-12 | Platform alerts and platform access review |

## 2. Method

Each item is scored **1-5** on six equally weighted criteria, maximum **30**:

1. **Impact** - how much a failure, exposure or recurring documentation error is reduced.
2. **Likelihood** - how likely the failure is with the current system.
3. **Blast radius** - how many tenants, users or operational decisions are affected.
4. **Free feasibility** - existing resources and low effort score 5; a new paid dependency scores 1.
5. **Business value** - customer trust, support quality or operational confidence.
6. **Time to value** - 5 means usable in days.

Ties are broken by impact, then likelihood, then free feasibility. The order is a recommendation, not
an authorization.

## 3. Ranked recommendations

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **RD-01** | Dependency outage behaviour matrix and drill | 5 | 4 | 4 | 5 | 4 | 4 | **26** |
| 2 | **RD-03** | Security review gate for new routes and AI tools | 4 | 4 | 4 | 5 | 4 | 4 | **25** |
| 3 | **RD-02** | Transactional notification outbox | 5 | 4 | 4 | 4 | 4 | 3 | **24** |
| 4 | **RD-04** | Tenant-scoped abuse/fairness budgets | 4 | 4 | 3 | 4 | 4 | 3 | **22** |
| 5 | **RD-05** | Runtime configuration drift report | 4 | 3 | 3 | 5 | 3 | 4 | **22** |
| 6 | **RD-06** | Documentation command index and verification | 3 | 3 | 3 | 5 | 3 | 4 | **21** |

### Rank 1 - RD-01 Dependency outage behaviour matrix and drill

**What.** Write a small matrix for MongoDB Atlas, Firebase Admin, Brevo and the AI provider: what
users see, which actions remain safe, which fail closed, what the operator does, and how recovery is
detected. Run a local fault-injection drill against disposable stubs before changing production.

**Plan:** [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) - matrix,
cross-dependency ordering, user-visible codes, local drill D1-D9 and acceptance checks.

**Why it matters.** `/api/health` proves the process and database; it does not prove a login, mail or
assistant turn will behave honestly when one dependency is down. IA-40 would detect a dead provider;
this defines what the product does in the meantime. The project has real examples of a green process
with a broken dependency and of a retry path that needed a measured failure.

**Benefit.** Predictable customer behaviour, fewer “unknown error” support tickets and a tested
degradation story. **Risk:** a matrix that is never exercised becomes fiction; keep a small local
drill and date the result.

**Free approach.** Existing local stubs, tests and disposable fake credentials; no paid chaos
service.

**Acceptance.** Each dependency has a named user-visible state; a forced outage produces that state;
the API does not claim success when mail/AI is unavailable; recovery is recorded; no production fault
injection.

### Rank 2 - RD-03 Security review gate for new routes and AI tools

**What.** Add a short, required review checklist to the PR/phase process for any new authenticated
route, AI tool, file export, admin operation or outbound mail path: tenant scope, role check, input
validation, rate limit, audit event, data exposure, failure mode and test. Keep it in the repository;
do not add a paid workflow product.

**Why it matters.** The project has strong existing controls, but each new surface can quietly omit
one of them. The support-grant, export, notification and AI-tool work all cross tenant boundaries.
A five-minute gate at design/review time is cheaper than a post-release audit.

**Benefit.** Consistent reviews, fewer repeat findings and a durable record of why a control exists.
**Risk:** checklist theatre; require evidence (test name or file) for each item and keep it short.

**Free approach.** Existing PR template/documentation and review process; no new service.

**Acceptance.** A new route/tool cannot be marked ready without the checklist; a deliberately
incomplete review is rejected; the checklist names the tenant/auth/rate/audit tests; no production
change.

### Rank 3 - RD-02 Transactional notification outbox

**What.** For auth, invitation and future tenant-security mail, write an outbox row in the same
durable flow as the action, then deliver asynchronously with idempotency, bounded retry and a
dead-letter state. Never send inside the database transaction; never retry forever.

**Why it matters.** TS-01 makes security events visible, but a notification that is lost on a Brevo
blip is worse than no promise. Existing auth mail is sometimes awaited and sometimes detached; a
single outbox gives all transactional mail one failure model. It also prevents a provider timeout
from becoming a user-visible auth failure.

**Benefit.** At-least-once delivery with a bounded failure story, less duplicate mail and a clear
operator queue. **Risk:** an outbox adds a worker/claim path; test duplicate delivery and poison
messages, and keep the feature behind a flag.

**Free approach.** Existing MongoDB and mail boundary; no queue SaaS. This is a reliability
dependency for TS-01, not a second notification feature.

**Acceptance.** A simulated provider failure leaves the action successful and one pending row; a
retry succeeds without a duplicate; three failures become dead-letter; a second worker cannot double
send; no token or body is logged.

### Rank 4 - RD-04 Tenant-scoped abuse/fairness budgets

**What.** Add per-tenant and per-account budgets for expensive shared resources (AI turns, outbound
mail, exports, large reports), separate from the existing per-IP auth limiters. A noisy tenant should
not exhaust a free provider allowance for everyone else. Start with counters and alerts before hard
refusals.

**Why it matters.** IA-16 covers a multi-instance limiter, not fairness between tenants. Free tiers
are shared, and a single compromised or runaway account can consume AI quota or mail reputation. The
platform's per-IP limits do not distinguish a legitimate large tenant from abuse.

**Benefit.** Predictable cost, fair service and a bounded blast radius for one tenant. **Risk:** a
shared store is needed when the API scales; do not pretend process-local counters are durable.
Document the limit and the override path.

**Free approach.** Existing rate-limit patterns and MongoDB counters; no paid quota service.

**Acceptance.** Tenant A cannot consume tenant B's budget; the limit is visible in a safe aggregate;
an owner override is audited; a single-instance deployment documents its process-local limitation;
no tenant detail is exposed.

### Rank 5 - RD-05 Runtime configuration drift report

**What.** A read-only startup or scheduled report compares the **names** of required production
environment variables and readiness flags against `.env.example` and the deployment manifest. Report
missing, extra or unsafe combinations without printing values. Link the report to the existing
platform readiness checks.

**Why it matters.** Production configuration is a security boundary: origin, cookie, proxy, mail,
Firebase and AI settings all fail differently. A variable can be renamed or omitted while the service
still boots. Existing validators catch some production combinations, but there is no drift view.

**Benefit.** Earlier detection of a configuration regression and a safer deploy review. **Risk:** a
report can leak values; output names/status only and never fetch secret values.

**Free approach.** Existing config validation, `.env.example`, Render environment metadata and a
repository script; no paid configuration service.

**Acceptance.** A missing required name is reported before traffic; a deliberately extra/unsafe name
is flagged; no value appears in the output; the report is read-only; production health remains
unaffected.

### Rank 6 - RD-06 Documentation command index and verification

**What.** Maintain a small index of the read-only operational commands used in guides (health checks,
database checks, log queries, PDF regeneration) and add a cheap check that every referenced script,
path and flag still exists. Do not execute destructive commands; verify structure and dry-run/help
output only.

**Why it matters.** The docs guards catch links, route counts and stale figures, but not a command
that was renamed or a flag that no longer exists. A runbook that fails at 2 a.m. is worse than no
runbook. The checklist renderer is the first command worth covering.

**Benefit.** Fewer broken procedures, faster onboarding and a maintained bridge between prose and
code. **Risk:** an index can drift; generate entries from script metadata where possible and review
on the existing cadence.

**Free approach.** Existing Node scripts, `--help` output and docs CI; no paid documentation tool.

**Acceptance.** Each indexed command resolves; a removed script or renamed flag fails the check; no
destructive command is executed; the index states its scope and last review date.

## 4. Recommended order after the current work

The two-contact notification test remains the prerequisite for security-alert activation. After
that, and after the TS-01 plan is approved separately:

1. **RD-01** - define what an outage should look like before adding more automation.
2. **RD-03** - make the review gate routine before the next route/tool is built.
3. **RD-02** - make transactional notification delivery durable before TS-01 relies on it.
4. **RD-04** - add fairness counters before a noisy tenant becomes a cost incident.
5. **RD-05** - make configuration drift visible.
6. **RD-06** - keep the runbooks executable as the documentation set grows.

## 5. What is deliberately not proposed

- No paid chaos-engineering, observability, queue, documentation or GRC service.
- No production fault injection, notification, alert activation, deployment or database operation.
- No replacement of the existing audit trail, rate limiters, docs guards or restore plan; these are
  additions where the current controls have a specific gap.

## 6. Related records

- [`PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md`](PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md) - TS-01-TS-06.
- [`PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md`](PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md) - TS-01 plan.
- [`INVENTORY_AI_MULTI_CRITERIA_RANKING.md`](INVENTORY_AI_MULTI_CRITERIA_RANKING.md) - IA-01-IA-45.
- [07 — Security recommendations](./platform-console/07-security-recommendations.md) - SEC-01-SEC-12.
- [04 — Production readiness](./platform-console/04-production-readiness.md) - existing readiness gates.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md) - the next
  ranked tranche (NX-01-NX-07) beyond this document.
