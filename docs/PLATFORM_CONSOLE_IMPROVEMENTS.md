# Platform Operations — console improvement roadmap

**Status:** **RECOMMENDATIONS ONLY.** Nothing in this document authorizes implementation. The
implemented recovery, lockout and lifecycle controls are recorded in
[`PLATFORM_SECURITY_RECOMMENDATIONS.md`](PLATFORM_SECURITY_RECOMMENDATIONS.md) and
[`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md); this page is the next layer of improvements.
The pre-exposure gate remains [`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md).

**Reviewed:** 2026-11-16
**Basis:** the Platform Operations records (§27IJ–§27IO), the browser E2E, the production-readiness
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

## Detail

### CI-01 — Forced recovery-code ceremony and break-glass drill

**Description.** Require a newly enrolled administrator to generate recovery codes before the first
dashboard is usable, display them once with a copy/download acknowledgement, and record the
acknowledgement in the audit trail. Add a quarterly drill that uses a disposable administrator to
prove the break-glass path without touching production data.

**Security and operational benefits.** Prevents the most likely lockout from becoming permanent;
makes the recovery procedure observable; gives the owner a tested answer when a device is lost.

**Why it is worth implementing.** PLAT-5 gives every administrator a recovery path, but an
administrator who never visits the Security page still has none. The project has repeatedly learned
that a capability nobody exercised is not a control (§27D, §27FT, §27AR).

### CI-02 — Step-up and dual control for destructive actions

**Description.** For disable/delete/key removal and recovery-code rotation, require a fresh TOTP or
WebAuthn assertion and, for the most destructive actions, approval by a second SUPERADMIN.

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

## What is deliberately not here

- No tenant-detail read, support grant, public console exposure or mobile Operations screen is
  approved by this page.
- No recommendation is implemented by this page.
- The aggregate-only console and its current capabilities remain the shipped boundary.
