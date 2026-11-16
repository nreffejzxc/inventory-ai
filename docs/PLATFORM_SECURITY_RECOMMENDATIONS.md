# Platform Operations — future security recommendations

**Status:** **RECOMMENDATIONS ONLY.** Nothing in this document authorizes an implementation in the
review step that produced it. Each item states what to improve, why it is necessary, the security
benefit and its priority. The readiness gate that consumes these priorities is
[`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md).

**Reviewed:** 2026-11-16
**Basis:** the PLAT-1/PLAT-2/PLAT-3 commits (`d02a549`, `ff80b12`, `af6e3dd`, `75d7c35`), the fresh
review (`40f2758`), the browser E2E, and the project's earlier authentication, rate-limit, audit and
release-engineering records. No code or deployment is part of this list.

## Priority scale

| Priority | Meaning |
| --- | --- |
| **P0** | Close before the console is reachable by anyone. A missing control here is a lockout, credential, audit or deployment-boundary risk. |
| **P1** | Close before support use or a wider operator group. These are containment and accountability controls. |
| **P2** | Next hardening cycle; valuable, but the current aggregate-only console can run without it. |

## What the project history adds

This list is not only a review of the platform commits. Earlier records supply the failure modes it
is trying to prevent:

- **AUTH-04/AUTH-06** established uniform responses, cooldowns and bounded verification attempts for
  pre-session flows. The platform MFA routes need the same account-scoped discipline, not only an IP
  bucket.
- **AUTH-02/AUTH-03** established short-lived tokens, server-side sessions and a session cap. A
  platform session must not become a longer-lived exception; sensitive actions need step-up.
- **AI-117** showed why a support-facing preview needs an explicit business boundary and a bounded
  excerpt. The platform plane should keep the same no-tenant-detail rule until Gate E exists.
- **§27FN/§27EZ** showed that a build id is a pointer, not a copy, and that an artifact can be the
  wrong commit. The readiness checklist treats the console artifact and CI run as claims to verify,
  not as proof because a job exists.
- **§27BP/§27AR** showed that a guard which cannot fail is not a guard. The CI browser job, the
  cleanup count and the CORS regression test are written to fail visibly.
- **§27D/§27FT/§27FU** established that mail timing, confirmation phrases and target guards are part
  of security. The production checklist applies the same “observe the result, do not assume it” rule
  to HTTPS, cookies and audit retention.

## Summary

| ID | Recommendation | Priority |
| --- | --- | --- |
| SEC-01 | Recovery codes and a break-glass procedure | **P0** |
| SEC-02 | Administrator lifecycle: change, disable, delete and key removal | **P0** |
| SEC-03 | Per-account MFA attempt budget and challenge invalidation | **P0** |
| SEC-04 | Fail-closed production deployment guard | **P0** |
| SEC-05 | Audit retention, export and database least privilege | **P0** |
| SEC-06 | Support grants and tenant-detail gating | **P1** |
| SEC-07 | Dedicated platform identity provider and passkey policy | **P1** |
| SEC-08 | Step-up authentication and dual control for sensitive actions | **P1** |
| SEC-09 | Security-event monitoring and alerting | **P1** |
| SEC-10 | Administrator management UI/API with four-eyes controls | **P1** |
| SEC-11 | CI/browser proof hardening and reproducibility | **P2** |
| SEC-12 | Periodic access review, offboarding and rotation drills | **P2** |

---

## P0 — before any exposure

### SEC-01 — Recovery codes and break-glass

**What to improve.** Add one-time recovery codes at MFA enrollment, stored only as hashes, shown once
and replaceable. Add a documented break-glass procedure that does not require editing MongoDB rows:
an operator-held recovery credential, a second enrolled security key, or a signed recovery approval
with an audit entry.

**Why it is necessary.** Today a lost TOTP device and all security keys make the only SUPERADMIN
unable to authenticate. The only current recovery is direct database surgery, which bypasses the
application's audit and capability model. The architecture already lists recovery codes and a
disable/rotate procedure as Gate B work.

**Security benefit.** Restores availability without weakening the second factor, makes recovery
auditable, and prevents an emergency from becoming an unlogged database change.

**Priority.** **P0.** This is the first item because it is both a lockout risk and an audit gap.

### SEC-02 — Administrator lifecycle

**What to improve.** Add audited operations to change a platform administrator password, disable and
re-enable an administrator, delete an administrator, rename or remove a WebAuthn credential, and
revoke all of that administrator's sessions. Decide whether these are CLI commands, a SUPERADMIN-only
API, or both. Every operation must write the platform audit trail and must invalidate the affected
sessions and outstanding tokens.

**Why it is necessary.** `platform-admin:create` is the only lifecycle command. A compromised or
departed administrator cannot be rotated through the product; the current answer is a database edit
or a new deployment secret. `platform.admin.manage` is declared but unbound, so the capability
catalogue promises a control that no route implements.

**Security benefit.** Shortens the window in which a stolen credential is useful, supports offboarding
and incident response, and makes privileged changes attributable.

**Priority.** **P0.** A console that cannot revoke its own administrators is not production-ready.

### SEC-03 — Per-account MFA attempt budget and challenge invalidation

**What to improve.** Add an account/challenge-scoped budget for TOTP and WebAuthn verification. A
wrong TOTP should consume a bounded attempt count; after the cap, the challenge is invalidated and a
new password step is required. Keep the existing per-IP limiter as a second layer. Do not key the
budget on a client-supplied email or administrator id; derive it from the signed challenge or the
resolved account.

**Why it is necessary.** The login route has an account limiter, but the five MFA/WebAuthn challenge
routes use only a per-IP limiter. A stolen challenge token has a six-digit TOTP and a five-minute
lifetime. An attacker with rotating addresses is bounded only by the per-IP bucket, and a wrong code
does not reduce the remaining guesses on that challenge. The route comment claiming the shared
account budgets cover MFA is inaccurate.

**Security benefit.** Makes the second factor meaningfully rate-limited against distributed guessing
and ensures a failed challenge cannot be retried indefinitely.

**Priority.** **P0.** The password is compromiseable; the second factor must not be guessable at an
unbounded rate.

### SEC-04 — Fail-closed production deployment guard

**What to improve.** Make a production platform deployment refuse to start the console or API unless:
the console and API origins are explicit HTTPS origins; `PLATFORM_CONSOLE_ORIGIN` is set; the
WebAuthn origin has no path, query or fragment and shares the intended RP ID; the console listener is
not bound to a public interface without an approved edge; and `NODE_ENV` is exactly `production`.
Derive cookie security from the actual HTTPS origin as a backstop, not only from `NODE_ENV`.
Enforce the same HTTPS rule in the standalone console server, not only in documentation.

**Why it is necessary.** The API's production validator now requires a console origin, but the
console server does not enforce HTTPS, and a missing `NODE_ENV` changes cookie behavior. CORS and the
platform's browser boundary depend on exact origins; a loopback default in a production process is a
configuration trap, not a safe fallback. The architecture also requires the console and API to be
same-site because the session cookie is `SameSite=Strict`.

**Security benefit.** Turns documentation into a boot-time invariant, prevents a cleartext console
or non-secure cookie from being served by accident, and makes the same-site constraint explicit
before an operator chooses hostnames.

**Priority.** **P0.** A deployment-boundary control must fail closed before the first request.

### SEC-05 — Audit retention, export and database least privilege

**What to improve.** Record the owner's retention period, export or archive the platform audit trail
to storage outside the application database, and grant the application a database role that can
append/read but not drop or rewrite the audit collection. Add a verification that the export exists
and is readable; document the restore procedure.

**Why it is necessary.** The Mongoose guards are real but only protect the application path. Anyone
with raw database access can alter or drop `platform_audit_events`, and the collection intentionally
has no TTL. The readiness checklist cannot call the trail append-only until the database role and
retention decision exist.

**Security benefit.** Provides tamper evidence, preserves investigations after an application
compromise, and satisfies the owner's retention and audit-readiness obligation.

**Priority.** **P0.** The audit trail is the evidence for every other control.

---

## P1 — before support use or a wider operator group

### SEC-06 — Support grants and tenant-detail gating

**What to improve.** Implement Gate E: a time-bounded, reason-bound, two-person-approved support
grant before any tenant-detail or member-identifying read, with owner notification and audit at issue
and use. Keep the current aggregate report separate from any grant-scoped surface.

**Why it is necessary.** The current console deliberately has no tenant selector and no PII. The next
operational step — helping a specific tenant — would otherwise turn a platform-wide aggregate reader
into an unrestricted cross-tenant data viewer. The architecture names this as an open gate.

**Security benefit.** Enforces least privilege and accountability at the point where support access
becomes sensitive; makes the owner's notification and approval part of the control.

**Priority.** **P1.** Required before support use, not before the aggregate console itself.

### SEC-07 — Dedicated platform identity provider and passkey policy

**What to improve.** Decide whether the separate platform realm should be linked to a dedicated
external identity project, and set the long-term factor policy: WebAuthn-only, TOTP fallback, or
both. If an external provider is adopted, keep authorization in MongoDB and resolve the platform
administrator by a stable provider subject, never by email.

**Why it is necessary.** The current platform realm is an interim local identity. The project's
Firebase architecture already established the separation between identity proof and MongoDB
authorization; the platform plane should not become the exception. An external provider also makes
central deprovisioning and suspicious-login controls available.

**Security benefit.** Reduces credential-handling scope, improves deprovisioning, and supports a
stronger phishing-resistant factor policy without changing the platform capability model.

**Priority.** **P1.** A gate for the production identity decision, not an immediate code change.

### SEC-08 — Step-up authentication and dual control for sensitive actions

**What to improve.** Require a fresh factor check before high-impact actions (administrator
management, audit export, support-grant issuance, future tenant-detail access) and require a second
approver for the highest-risk actions. Keep the normal console session for read-only aggregate work.

**Why it is necessary.** A platform session has an eight-hour absolute cap and a fifteen-minute idle
timeout, but once open it can read the audit trail and operations report. As sensitive actions grow,
session possession alone should not authorize them. The project's support-grant design already calls
for two-person approval.

**Security benefit.** Limits the blast radius of a stolen session and makes irreversible or
cross-tenant actions deliberately harder.

**Priority.** **P1.** Pair with SEC-06 and SEC-10.

### SEC-09 — Security-event monitoring and alerting

**What to improve.** Alert on repeated platform login failures, MFA failures, capability denials,
foreign-Origin refusals, audit reads, new WebAuthn registrations and administrator status changes.
Define thresholds and an on-call destination. Include the platform audit trail and the API logs in
the same incident procedure as the existing production health watch.

**Why it is necessary.** The audit trail records events, but a record nobody reads is not detection.
The project has a five-minute production health watch and an incident runbook; the platform plane
needs the equivalent for authentication and authorization events.

**Security benefit.** Shortens detection and containment, and gives the owner evidence during a
review.

**Priority.** **P1.** Required before a wider operator group relies on the console.

### SEC-10 — Administrator management UI/API with four-eyes controls

**What to improve.** Bind `platform.admin.manage` to an explicit SUPERADMIN-only surface for the
lifecycle operations in SEC-02, with confirmation, audit and an optional second approver. Do not
allow self-approval for disabling or deleting the last SUPERADMIN, and do not allow an administrator
to remove their own last factor without a recovery path.

**Why it is necessary.** The capability exists in the catalogue but no route implements it. CLI-only
administration is acceptable for a single operator, but it becomes an operational and audit gap as
soon as there is more than one administrator.

**Security benefit.** Makes privileged changes reviewable in the product and reduces the chance of
an accidental lockout.

**Priority.** **P1.** Build after SEC-02 defines the operations and SEC-01 provides recovery.

---

## P2 — next hardening cycle

### SEC-11 — CI/browser proof hardening and reproducibility

**What to improve.** Keep the new `webauthn-e2e` CI job, but make the browser dependency explicit and
reproducible: verify the Chrome version, record the fixed or dynamically allocated API/console/CDP
ports, and add a second browser only if the project can support it. Add a static workflow check
(actionlint or an equivalent) so a malformed workflow cannot silently stop running. Keep the manual
`npm run test:webauthn-e2e` procedure documented as the fallback.

**Why it is necessary.** The browser proof is now automatic, but a hosted-runner image change can
move Chrome or remove a dependency. Fixed ports are acceptable in a dedicated job; they are not
acceptable if the job later runs concurrently on one machine. The E2E caught a real console mount
defect and a cleanup defect, so its failure must be visible, not skipped.

**Security benefit.** Preserves the only end-to-end proof of the WebAuthn origin/challenge path and
prevents a green CI run from meaning less than it claims.

**Priority.** **P2.** The job exists; this is durability, not a new boundary.

### SEC-12 — Periodic access review, offboarding and rotation drills

**What to improve.** Schedule a recurring review of platform administrators, their roles, their
enrolled factors and their sessions. Define an offboarding checklist and run a credential-rotation
drill that proves the old secret/token no longer works and the audit trail records the change.

**Why it is necessary.** PLAT-1/PLAT-2 established strong initial boundaries, but long-lived
administrators and factors drift. The project has repeatedly learned that an untested recovery or
rotation path is not a control. A drill also catches a missing lifecycle operation before an incident.

**Security benefit.** Keeps the real administrator set equal to the intended one and proves the
emergency procedures work before they are needed.

**Priority.** **P2.** Operational hygiene that should follow the P0/P1 controls.

---

## What this list deliberately does not recommend

- It does not recommend weakening the separate platform JWT secret, the mandatory MFA rule, the
  exact-Origin cookie check or the CSRF double-submit.
- It does not recommend exposing the console publicly to avoid a VPN or identity-aware proxy.
- It does not recommend replacing the application-level audit guards with a promise; the database
  permission and export are additions, not a reason to remove the guards.
- It does not recommend adding tenant detail to the current aggregate report. That requires SEC-06.
