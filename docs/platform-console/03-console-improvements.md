# Platform Operations — console improvement roadmap

**Status:** **RECOMMENDATIONS ONLY.** Nothing in this document authorizes implementation. The
implemented recovery, lockout and lifecycle controls are recorded in
[07 — Security recommendations](07-security-recommendations.md) and
[`SYSTEM_SPECIFICATION.md`](../SYSTEM_SPECIFICATION.md); this page is the next layer of improvements.
The public/wider-operator gate remains [04 — Production readiness](04-production-readiness.md).
The console is now live internally at `/platform` on `e218bb0`. CI-01 (forced recovery ceremony and
break-glass) is implemented in PLAT-7 and deployed (§27IQ, §27IR); CI-07's application-level gate is
implemented but the edge/network-isolation half remains open. `webauthn-e2e` is now a required
`main` check. This page is a ranked, recommendations-only roadmap: it
does not authorize implementation, deploy or expose any new surface. The whole-product ranking and
new-gap assessment is
[`INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md`](../INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md); it consumes this
console-specific list and does not replace or silently promote any item here.

**Reviewed:** 2026-11-17
**Basis:** the Platform Operations records (§27IJ–§27IP), the browser E2E, the production-readiness
review, and the earlier authentication, audit, release-engineering and AI-support records.

## Priority scale

| Priority | Meaning |
| --- | --- |
| **P0** | Finish before the console is reachable by anyone. A missing control is a deployment or recovery risk. |
| **P1** | Finish before support use or a wider operator group. |
| **P2** | Next hardening cycle; valuable once the aggregate-only console is operating. |

## Summary

| ID | Improvement | Security / operational benefit | Why it is worth implementing | Priority |
| --- | --- | --- | --- | --- |
| CI-01 | Forced recovery-code ceremony and a rehearsed break-glass drill | A lost authenticator cannot strand the only administrator; the recovery path is proved before it is needed | PLAT-5 provides codes, but a new administrator can still skip generation. §27D/§27FT established that an unexercised recovery path is not a recovery path | **P0** |
| CI-02 | Step-up authentication and dual control for destructive actions | A stolen live session cannot disable, delete or remove the last keys without a fresh factor and a second approver | §27AUTH-02/03 and the lifecycle tests show that session possession alone is still a high-value capability | **P1** |
| CI-03 | Dedicated platform identity provider and passkey-first policy | Separates the platform realm from local passwords and removes the password-breach blast radius | The interim local bcrypt realm is documented as temporary; a dedicated identity project is the approved target | **P1** |
| CI-04 | Time-bound support grants and tenant-detail gate | Support can answer a customer question without gaining standing cross-tenant access; every grant is reason-bound and audited | The current console deliberately exposes only aggregates. §27II/§27IM show why tenant detail needs an explicit boundary | **P1** |
| CI-05 | Platform security monitoring, alerting and a dedicated incident view | Detects repeated MFA denials, new-origin attempts, destructive lifecycle actions and audit write failures before a human notices | §27BP/§27AR established that a control with no observable failure is not a control; the current console is pull-only | **P1** |
| CI-06 | Audit export, retention policy and an external immutable sink | Protects the trail from database-role accidents and makes retention an owner decision with evidence | The model is append-only, but raw database access can still rewrite it; PLAT-5 adds more high-value events that need preservation | **P1** |
| CI-07 | Deployment-boundary attestation | Proves the real browser origin, HTTPS termination, cookie flags, CORS preflight and non-public listener before announcing availability | §27EZ/§27FN showed that an artifact or a job existing is not proof it is the deployed one | **P0** |
| CI-08 | Administrator provisioning and role-management UI | Makes least-privilege role changes auditable product operations instead of CLI/database work | Creation remains CLI-only and role changes are not exposed. A wider operator group needs a controlled path | **P2** |
| CI-09 | Multi-instance shared limiter and lockout state | Keeps per-IP budgets and MFA lockout effective when the API runs behind more than one process | The account lock is durable in MongoDB; the existing IP limiter store is process-local and documented as such | **P2** |
| CI-10 | Expanded browser automation for recovery and lifecycle flows | Catches a broken recovery path, stale admin row or revoked session before a real lockout | PLAT-5 is covered at the API/database boundary; the E2E currently proves TOTP/WebAuthn only | **P2** |

## Ranked roadmap by value

The order below is the recommended sequence, not a promise. “Value” means the improvement most
reduces the chance of a silent outage, a permanent lockout, a data-loss surprise or an unaccountable
administrative action. Security items that prevent an irreversible outcome come before features that
mostly improve day-to-day convenience.

| Rank | Area | Recommendation | Why this rank | Priority |
| --- | --- | --- | --- | --- |
| 1 | Security / recovery | CI-01 forced recovery-code ceremony and rehearsed break-glass (implemented in PLAT-7) | A lost last factor can permanently strand the console; this is the only item whose failure has no in-product recovery | **P0 — implemented** |
| 2 | Security / access | CI-07 edge attestation and an actual network access layer (the free-plan application gate is implemented; the edge half is not) | The live URL is still internet-reachable. A shared outer key helps, but it is not VPN/IP/identity-aware isolation | **P0 — partial** |
| 3 | Security / incident detection | CI-05 platform security monitoring, alerting and a dedicated incident view | A control whose failures are invisible is not a control. Recovery and lifecycle actions now exist; nobody is alerted when they go wrong | **P1** |
| 4 | Security / audit | CI-06 audit export, retention decision and an external immutable sink | The trail is append-only in the model but not protected from raw database access; the recovery and break-glass events are exactly what an investigation needs | **P1** |
| 5 | Security / admin permissions | CI-02 step-up authentication and dual control for destructive actions | A stolen live session can no longer disable, delete or remove keys without a fresh factor; a second approver is still missing | **P1** |
| 6 | Security / support boundary | CI-04 time-bound support grants and the tenant-detail gate | Support cannot safely answer “what happened to this tenant?” without a reason-bound, expiring read. Never add a standing tenant selector | **P1** |
| 7 | AI monitoring / cost | CI-11 AI cost budget, model-health and spend alerts | AI spend is provider-reported and can fail open; a model outage or a runaway paid fallback is currently visible only after someone reads the report | **P1** |
| 8 | Server reliability | CI-12 performance SLOs, saturation alerts and a degraded-mode drill | The console is a monitoring surface, not a pager. Slow Mongo/DB pools, event-loop saturation and a single-process limiter need measured thresholds and a rehearsed failure response | **P1** |
| 9 | Support tickets | CI-13 ticket SLAs, escalation and a bounded support workspace | The ticket store exists, but without queue ownership, response targets and an escalation path it is a notebook, not support operations | **P1** |
| 10 | Incident monitoring | CI-14 alert routing, on-call ownership, incident timeline and status communication | The console can show a failure after a human looks; production needs an external signal, a named owner and a record of the response | **P1** |
| 11 | Administrator permissions | CI-08 audited provisioning, role change and offboarding UI; retain the last-SUPERADMIN guard | Creation and role changes are still CLI/database work, which is hard to audit and easy to get wrong as the operator group grows | **P2** |
| 12 | Backup / disaster recovery | CI-15 restore drill, RPO/RTO decision, backup verification and a console recovery runbook | A backup that has never been restored is a hope. The platform audit, recovery state and configuration need to survive an application or database loss | **P2** |
| 13 | Security / identity | CI-03 dedicated platform identity provider and passkey-first policy | The local realm is isolated but temporary; central identity reduces password and offboarding risk | **P2** |
| 14 | Security / scale | CI-09 shared limiter and lockout state for multiple instances | Important only when the API is horizontally scaled; the durable account lock already covers the account dimension | **P2** |
| 15 | Verification | CI-10 expanded browser automation for recovery and lifecycle flows | Catches DOM/session regressions in controls a person actually clicks; the forced ceremony is now covered, but lifecycle flows are not | **P2** |

## Detail

### CI-01 — Forced recovery-code ceremony and break-glass drill

**Description.** Require a newly enrolled administrator to generate recovery codes before the first
dashboard is usable, display them once with a saved-codes acknowledgement, and record the generation
in the audit trail. **Implemented in PLAT-7:** the server refuses every protected route until codes
exist, the console forces the ceremony, and a guarded break-glass CLI resets a totally locked-out
administrator. **Remaining recommendation:** a quarterly drill that uses a disposable administrator
to prove the break-glass path without touching production data.

**Security and operational benefits.** Prevents the most likely lockout from becoming permanent;
makes the recovery procedure observable; gives the owner a tested answer when a device is lost.

**Why it matters.** Before PLAT-7 a new administrator could skip generation entirely; the server now
makes that impossible, and the CLI was exercised against a disposable administrator. The project has
repeatedly learned that a capability nobody exercised is not a control (§27D, §27FT, §27AR).

### CI-02 — Step-up and dual control for destructive actions

**Description.** For disable/delete/key removal and recovery-code rotation, require a fresh TOTP or
WebAuthn assertion and, for the most destructive actions, approval by a second SUPERADMIN.

**Current status (2026-11-18).** The step-up half is implemented for disable/enable/delete/key
removal: `POST /api/platform/auth/step-up` re-checks the current password and TOTP, issues a
five-minute, session-bound proof and the three lifecycle routes enforce it server-side. TOTP is
the only accepted step-up factor for now; WebAuthn/recovery-code step-up remains open. A second
SUPERADMIN approver is still open. Recovery-code rotation remains password-only.

**Security and operational benefits.** A stolen cookie or bearer token becomes insufficient for
irreversible actions; every high-impact action acquires two independent human decisions.

**Why it is worth implementing.** The lifecycle routes are correctly capability-gated, but a live
session is still a single bearer of that capability. Step-up is the standard containment for an
administrative console whose actions cannot be undone.

### CI-03 — Dedicated platform identity provider and passkey-first policy

**Description.** Replace the interim local password plus TOTP/WebAuthn realm with a dedicated
identity project, and prefer passkeys while retaining a controlled recovery path.

**Security and operational benefits.** Removes password reuse and bcrypt storage from the platform
realm; centralizes account disablement, session revocation and policy.

**Why it is worth implementing.** The current realm is deliberately isolated but local. The approved
architecture already names the external identity project as a deployment boundary.

### CI-04 — Time-bound support grants and the tenant-detail gate

**Description.** Add a grant object with a requester, reason, tenant, scope, expiry and approver, and
allow tenant-detail reads only while that grant is active. Start with the minimum read needed to
answer a support question; never expose a standing tenant selector.

**Security and operational benefits.** Support can resolve a real customer issue without a permanent
cross-tenant window; the audit trail can answer who saw what and why.

**Why it is worth implementing.** The console is aggregate-only by design. Tenant detail is useful
only after the grant boundary exists; adding it first would repeat the tenant-Operations mistake.

### CI-05 — Platform security monitoring and alerting

**Detail:** the proposed alert catalogue, thresholds, channels, owners and coverage gaps are in
[06 — Security monitoring](06-security-monitoring.md). Planning only.

**Description.** Emit alertable counters for MFA lockout, repeated recovery failures, new console
origins, destructive lifecycle actions and audit write errors; add a SECURITY view with bounded
recent events and a tested incident procedure.

**Security and operational benefits.** Turns the append-only trail into an active control; detects
an attack or a misconfiguration while it is happening rather than during a retrospective.

**Why it is worth implementing.** The existing external health watch proves the server answers, not
that the platform security plane is healthy. A pull-only audit page is not an alert.

### CI-06 — Audit export and an external immutable sink

**Description.** Choose a retention period, export the append-only events to an owner-controlled
immutable store, and document restore/verification. Grant the application a database role that
cannot drop or rewrite the collection.

**Security and operational benefits.** Survives an application bug, a compromised database role or a
retention accident; makes the retention decision auditable.

**Why it is worth implementing.** PLAT-5's lifecycle and recovery events are exactly the records an
investigation would need; a model-level guard is not a substitute for storage permissions.

### CI-07 — Deployment-boundary attestation

**Detail:** the access-layer options and the Cloudflare Access origin-bypass requirement are assessed
in [05 — Access layer](05-access-layer.md). Planning only.

**Description.** Add a pre-announcement proof that checks the real HTTPS origin, HSTS/redirect,
`Set-Cookie` flags, CORS preflight from the console origin, a signed-in read, a recovery-code
generation and a sign-out — against the deployed host, not localhost.

**Security and operational benefits.** Prevents a configuration that looks correct in source from
being exposed with insecure cookies or a reachable listener.

**Why it is worth implementing.** The repository now fails closed on malformed origins, but TLS
termination and network isolation are outside the Node process. §27EZ/§27FN are the precedent:
verify the deployed artifact, not the intention.

### CI-08 — Administrator provisioning and role-management UI

**Description.** Add audited SUPERADMIN creation, role change and invitation/offboarding flows,
keeping the CLI as the bootstrap path and the last-SUPERADMIN guard.

**Security and operational benefits.** Removes ad-hoc database work; makes least-privilege changes
reviewable and reversible.

**Why it is worth implementing.** The current lifecycle covers disable/delete/key removal/password,
but creating an administrator or changing a role still requires operator access.

### CI-09 — Shared limiter and lockout state for multiple instances

**Description.** Move the per-IP limiter store to a shared backend and keep the account lock in a
durable store with atomic transitions. Include a migration/fallback plan for a single instance.

**Security and operational benefits.** Prevents an IP-rotating attacker from multiplying the per-IP
budget by landing on different processes; preserves the account lock across restarts.

**Why it is worth implementing.** The MFA lock is already durable, but the IP limiter is explicitly
process-local. A horizontally scaled deployment must not silently weaken the first layer.

### CI-10 — Expanded browser automation for recovery and lifecycle

**Description.** Extend the existing virtual-authenticator E2E to generate recovery codes, consume
one, re-use it (refused), disable and re-enable an administrator, remove a key and change a password.

**Security and operational benefits.** Proves the console controls a person actually clicks, not only
the service functions beneath them; catches a broken DOM binding or stale session.

**Why it is worth implementing.** The existing E2E already found a real login-state race. The new
recovery and lifecycle surfaces deserve the same executable proof.

### CI-11 — AI cost budget, model-health and spend alerts

**Description.** Add an owner-set daily/monthly budget, alert at a configured fraction, track paid
versus free turns and provider-reported cost, alert when a model is cooling or unusable, and expose
a bounded “why did this cost change?” view. Keep unknown cost unknown; never estimate it into a
budget. Add a kill switch that disables paid fallback without disabling the assistant.

**Security and operational benefits.** A misrouted model or a research loop can spend real money;
a provider outage or a cooling primary can silently move traffic to a paid model. The existing
turn records already carry the facts needed for an honest alert.

**Why it matters.** The console currently reports what happened, not when spending or model health
has crossed a line. Cost and availability are operational controls, not dashboard decoration.

### CI-12 — Server performance SLOs, saturation alerts and a degraded-mode drill

**Description.** Record p50/p95/p99 latency and error rate for the API and the console reads, alert
on Mongo connection-pool saturation, event-loop delay, memory growth, request queueing and the
process-local limiter. Define SLOs for the console and for tenant writes. Rehearse a slow-database
and a single-process restart while the console is live.

**Security and operational benefits.** The health endpoint proves the process is alive, not that it
can answer in time. A monitoring console that depends on the same database must itself degrade
honestly instead of showing a stale or fabricated report.

**Why it matters.** Render's free instance has a small memory/process budget, and the console adds
reads to the same service. A measured threshold prevents a “slow” incident from becoming an outage
that nobody saw coming.

### CI-13 — Ticket SLAs, escalation and a bounded support workspace

**Description.** Add queue ownership, response/resolve targets, priority and due-time calculation,
escalation on breach, canned replies, and a customer-safe timeline. Keep tenant detail behind
CI-04; until then the ticket remains tenant-free. Add a daily open-ticket digest and an audit event
for every assignment/status change.

**Security and operational benefits.** A ticket that is stored but unowned has no operational value.
SLA clocks and escalation make support measurable without giving support standing tenant access.

**Why it matters.** The PLAT-6 ticket workflow is deliberately minimal. The next value is not more
fields; it is knowing which request is late and who owns it.

### CI-14 — Alert routing, on-call ownership, incident timeline and status communication

**Description.** Route the existing health/error signals to an owner-controlled alert channel, name
a primary and backup on-call, open an incident record from an alert, keep a chronological timeline
of actions and decisions, and publish a minimal status message when the tenant service is degraded.
Link the incident to the release and the relevant platform audit events.

**Security and operational benefits.** Detection without a recipient is still an outage. A single
timeline prevents the “what changed?” scramble and makes the post-incident review factual.

**Why it matters.** The external health watch can open an issue, but there is no owned pager,
incident object or communication path. The console should be the source of the record, not the only
place someone might look.

### CI-15 — Restore drill, RPO/RTO and console recovery runbook

**Description.** Choose recovery point/time objectives, verify the Atlas backup and restore path on
a schedule, store the platform signing/MFA/access keys in an owner-controlled secret escrow, and
document restoring the console and its audit trail. Run a restore into a disposable database and
record the observed time and row counts. Include the break-glass CLI in the recovery runbook.

**Security and operational benefits.** A database loss must not erase the audit trail, the
administrator rows or the recovery state. A rehearsed restore turns a disaster into a procedure.

**Why it matters.** The existing backup guide covers the database, but the platform plane adds a
small set of high-value rows and secrets whose loss has no tenant-side equivalent. The drill is the
only proof that the backup can actually be used.

## What is deliberately not here

- No tenant-detail read, support grant, public console exposure or mobile Operations screen is
  approved by this page.
- No recommendation is implemented by this page.
- The aggregate-only console and its current capabilities remain the shipped boundary.
