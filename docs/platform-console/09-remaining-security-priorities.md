# 09 — Remaining console security priorities

**Status:** recommendations only. Nothing in this document authorizes an implementation,
configuration change, notification, drill, deployment or paid service. It is a ranking to
choose from, not a work order.

**Reviewed:** 2026-11-18, after PLAT-24, PLAT-25 and the audit portion of NS-02.
**Scope:** the `/platform` console, `/api/platform` plane, platform administrators,
platform sessions, the operator CLI and the platform audit trail.

The original lists remain authoritative for their own items:

- [07 — Security recommendations](07-security-recommendations.md) — SEC-01–SEC-12, the
  original P0–P2 console security list.
- [08 — Security roadmap](08-security-roadmap.md) — NS-01–NS-07, additive after PLAT-21.
- [03 — Console improvements](03-console-improvements.md) — the broader CI list.

This page answers a different question: **given what is already implemented, what is worth
doing next, and why?** It includes four ideas that were not in those lists: a signed
one-time creation grant, audit hash-chain evidence, CLI secret-input hardening and a
two-person break-glass share. They are marked **NEW**. None is implemented.

## 1. What is already closed

The ranking should not re-open controls that already work:

| Control | Current state |
| --- | --- |
| Console exposure | Basic outer gate plus process-local failure bounding and sampled denial audit (PLAT-25). |
| Platform login | Password, mandatory TOTP enrollment, optional WebAuthn, hashed one-time recovery codes, durable account-scoped MFA lockout, password change and break-glass recovery (PLAT-2/PLAT-7). |
| Platform sessions | Short-lived bearer sessions with idle and absolute limits; logout; all-session revocation on disable/delete/password change. |
| Administrator lifecycle | List, disable/enable, delete and WebAuthn-key removal; destructive changes require a fresh, session-bound step-up proof (PLAT-27); last-SUPERADMIN guard; audited lifecycle routes (PLAT-20, SEC-02). |
| Creation accountability | CLI-only creation; exactly one `platform.admin.created` event with operator identity, source, target role and target email (PLAT-26). |
| Audit trail | Append-only at the model layer; no TTL; readable by SECURITY/SUPERADMIN; no password, token, TOTP code or recovery code recorded. |
| Tenant boundary | The console exposes aggregate operations data only. There is no tenant selector, tenant name, member email or product row. |

The remaining risk is therefore mostly **containment, proof and recovery**, not the basic
login ceremony or the tenant read boundary.

## 2. Ranking method

Scored against the current console, not a hypothetical future product:

1. **Risk reduction** — how much a realistic compromise, mistake or incident is reduced.
2. **Reach** — how many administrators, sessions or privileged actions are affected.
3. **Recoverability** — whether the control helps during an incident, not only before one.
4. **Effort** — S (days), M (weeks), L (a project).
5. **Dependency** — whether it can ship without another unapproved control.

A high rank means the work removes a real gap in the current surface. It does not mean the
work is authorized or that it should displace a production incident.

## 3. Ranked priorities

| Rank | Recommendation | Status | Risk reduced | Effort | First dependency |
| ---: | --- | --- | --- | --- | --- |
| 1 | **SEC-08 step-up proof for destructive platform actions** | Step-up shipped; dual control open | A stolen bearer session alone can disable/delete administrators or remove a security key; re-proving password + factor sharply limits that blast radius | M | Existing login factors |
| 2 | **NS-04 platform session inventory and targeted revocation** | Open | A lost device or stolen token cannot be cut off without ending every session for that administrator | S/M | Existing session collection |
| 3 | **NS-02B address activation for CLI-created administrators** | Partially implemented | An account exists immediately at an address that was never proven; activation closes the remaining privileged-creation gap | S/M | Existing mail path; break-glass exception |
| 4 | **NEW — signed, one-time creation grant** | New | The operator identity on `platform.admin.created` is currently self-asserted; a signed, expiring, single-use grant makes the approver verifiable | M | Step-up (rank 1) and a grant-issuing route |
| 5 | **NS-03 versioned key rotation** | Open | A signing-key or MFA-encryption-key compromise currently forces an all-at-once replacement; staged rotation makes recovery possible without losing factors | M | Existing key/secret plumbing |
| 6 | **NEW extension to SEC-05 — audit tamper evidence, retention and export** | Open/New | Append-only model guards application mistakes, not a database operator; a hash chain plus a periodic digest makes deletion or rewriting detectable | M/L | Database least privilege (PR-09) |
| 7 | **NEW extension to SEC-09 — owned alerts for rare high-risk events** | Open/New | Admin creation, break-glass, destructive lifecycle actions and denial spikes are visible only if someone reads the audit page | S | A named recipient and delivery channel |
| 8 | **NS-01 breach screening for new and changed passwords** | Open | A long-but-breached password is still accepted; k-anonymity screening reduces credential stuffing | M | None |
| 9 | **SEC-06 / CI-04 support grants and tenant-detail gate** | Open | The current aggregate console is safe because it has no tenant detail; any future support workspace needs a reason-bound, expiring read | M/L | An explicit support-detail requirement; do not add tenant detail before this |
| 10 | **NS-06 self-service TOTP rotation** | Open | Replacing a lost or cloned authenticator currently requires break-glass, which clears every factor | M | Step-up (rank 1) |
| 11 | **NEW — CLI secret-input hardening** | New | The bootstrap password is passed through the environment and may survive in shell history or a process environment; a no-echo prompt or file descriptor reduces that exposure | S | None; keep the existing confirmations |
| 12 | **CI-09 shared outer-gate limiter** | Open | The PLAT-25 limiter is process-local; multiple instances each get a fresh global budget | M | A shared store; not needed for the current single-instance deployment |
| 13 | **SEC-07 mandatory WebAuthn policy for SUPERADMIN** | Open | Phishing resistance is stronger than TOTP, but a mandate today risks locking out the sole administrator with zero enrolled keys | M/L | At least two enrolled keys, recovery proof and a staged policy |

Ties were broken by immediate incident value. Rank 13 is deliberately last despite its
strong theoretical benefit: the operational preconditions do not exist yet.

## 4. What each priority actually buys

### 1. Step-up proof for destructive actions (SEC-08)

**Gap.** A platform session proves that the administrator signed in, not that the person
holding the token right now is that administrator. The lifecycle routes currently accept
`PATCH /admins/:id/status`, `DELETE /admins/:id` and
`DELETE /admins/:id/webauthn/:credentialId` with the session capability alone. A stolen
session can disable a colleague, remove a security key or delete an account before the
theft is noticed. The last-SUPERADMIN guard prevents deleting the final superadmin, but it
does not protect the other administrators or their factors.

**Action.** Require a recent password plus TOTP/WebAuthn proof for a bounded window before
these actions, and re-check it at the service layer, not only in the browser. Apply the
same proof to a future role-change route and to any route that issues a creation grant
(rank 4). Audit both the step-up and the action; a failed step-up must not mutate state.

**Done when.** A valid session without fresh proof receives a distinct 403; fresh proof
allows the action within its window; the proof expires; the action and its step-up are
separately auditable; a stolen token cannot remove another administrator's key.

**Implemented step-up half (PLAT-27, 2026-11-18).** `POST /api/platform/auth/step-up` verifies
the current password and TOTP and returns a five-minute proof bound to the caller's session
(`jti`) and the `platform.admin.lifecycle` scope. `PATCH /admins/:id/status`,
`DELETE /admins/:id` and `DELETE /admins/:id/webauthn/:credentialId` enforce it server-side
after the capability check and before the controller, returning
`403 PLATFORM_STEP_UP_REQUIRED` for a missing, expired, wrong-session or wrong-scope proof.
The proof is stateless and replayable within its five-minute window; it is not accepted as an
access token. Issuance, failures, refusals and use are audited without passwords, TOTP codes
or proof tokens. The remaining SEC-08 work is a second approver (dual control).

**Why rank 1.** It reduces the blast radius of the most likely serious console incident —
session theft — without waiting for a new service or a database migration.

### 2. Session inventory and targeted revocation (NS-04)

**Gap.** Sessions carry a device label, timestamps and a `jti`, but there is no route or
console view that lists them. The only revocation is all-or-nothing through
disable/delete/password change. The 8-hour absolute and 15-minute idle windows are good
bounds, but they are not an incident-response tool.

**Action.** Add a SUPERADMIN-only, audited list of bounded session metadata and a revoke
one-session action. Never return the token or `jti`; use a short opaque session id. Refuse
or explicitly confirm revoking the current session. Show active session counts on the team
page. Add “sign out my other sessions” using the same service.

**Done when.** A second session appears and can be revoked independently; its next request
is 401 while the first still works; cross-administrator access is denied; the action is
audited; account disable still revokes all sessions.

### 3. Address activation for CLI-created administrators (NS-02B)

**Gap.** The CLI now records who created the account, but the account is active at an
address that was never proven. A typo, a stale alias or a deliberately supplied address
creates a privileged identity whose owner is unverified. The operator-chosen password
limits immediate misuse, but it does not make the address correct, and it does not satisfy
the lifecycle proof that the HTTP-created accounts will need.

**Action.** Create the account in `PENDING`, send a one-time activation code to the target
address, and allow authentication only after the code is confirmed. Hash the code, bind it
to the account and address, expire it quickly, rate-limit attempts and make it single-use.
Keep a documented, audited break-glass exception for the first SUPERADMIN so a mail outage
cannot strand the only operator. Do not add a public create route.

**Done when.** An unactivated account cannot authenticate; a valid code activates it once;
an expired, reused or wrong-address code fails; the activation is audited; the break-glass
path is explicit and audited; no code or token is logged.

**Why not rank 1.** The CLI already requires server access, an explicit confirmation and a
password, so this is a correctness and accountability gap rather than an unauthenticated
entry point. It is still the smallest remaining privileged-creation gap.

### 4. Signed, one-time creation grant (NEW)

**Gap.** `PLATFORM_ADMIN_OPERATOR` is a free-text identity. The audit event is only as
trustworthy as the person typing it. An operator with local access can create an account
and enter someone else's identity, so the trail proves that a creation happened, not who
approved it. The NS-02 design called for an “operator identity supplied through a
short-lived SUPERADMIN-issued grant”; only the self-asserted input shipped.

**Action.** Add an authenticated, step-up-protected route that issues a short-lived grant
for a specific target email, role and optional expiry, bound to the issuing SUPERADMIN and
a nonce. Sign it with a dedicated key, store only its id/hash and one-time-use state, and
record the issuance in the audit trail. The CLI verifies the signature, target, role,
expiry and unused state before creating the account, then consumes it. The resulting
`platform.admin.created` event carries the grant id and the verified issuer, not only a
typed string. A lost or stolen local shell cannot mint a grant without the issuer's
step-up proof.

**Done when.** A grant cannot be reused or retargeted; an expired or tampered grant is
refused; the CLI event names the verified issuer and grant; the issuing route is audited;
a grant issued for one role cannot create another; the signing key is not the administrator
JWT key.

**Why this is new.** 07/08 describe the desired grant but not an offline-verifiable,
single-use format or the separation from the JWT signing key. This is also the natural
consumer of the step-up from rank 1.

### 5. Versioned rotation for signing and MFA-encryption keys (NS-03)

**Gap.** A single `PLATFORM_ADMIN_JWT_SECRET` signs every platform token, and a single
`PLATFORM_MFA_ENCRYPTION_KEY` decrypts every TOTP secret. Replacing either today
invalidates every session or makes existing factors undecryptable. That discourages
rotation precisely when a key may be compromised.

**Action.** Add a key id to tokens and to the MFA envelope. Verify with the active and a
bounded previous key, sign/encrypt with the active key, and re-encrypt factors after a
successful login. Retire the previous signing key after the longest session lifetime.
Document overlap, rollback and the moment the old key is destroyed. Rotate the outer access
key and other console secrets under the same runbook.

**Done when.** An old token verifies during overlap and fails after retirement; an old
factor decrypts and is re-encrypted; new logins use the active key; rotation is audited;
no secret value is printed; rollback does not reset factors.

### 6. Audit tamper evidence, retention and export (NEW extension to SEC-05)

**Gap.** The model rejects `updateOne`/`deleteMany`, and there is no TTL, but an operator
with raw database access can still alter or delete rows. The model's own comment says this
is a guard against application mistakes, not a substitute for database permissions. There
is also no retention decision or export path beyond the audit page/API.

**Action.** Keep PR-09's least-privilege database role as the primary control. Add a
per-event sequence and hash chain (each row includes the previous hash), so a deleted or
rewritten middle row is detectable. Periodically export a signed digest of the chain head
and count to an owner-controlled location. Define retention in days, who can export, and
how an export is verified. Do not make the chain the only copy; the database remains
authoritative.

**Done when.** Removing or editing a row breaks verification at the next digest; export is
bounded and access-controlled; the retention decision is recorded; a restore drill can
verify the chain; the application cannot rewrite history.

### 7. Owned alerts for rare high-risk events (NEW extension to SEC-09)

**Gap.** The console has an audit page, but no alert delivery or named recipient. A
creation, break-glass reset, destructive lifecycle action or repeated gate denial can sit
unread. Security monitoring is a plan, not an operating control.

**Action.** Pick one owned channel and a named recipient first. Alert on a short list of
rare, high-signal events: `platform.admin.created`, break-glass/reset, administrator
disable/delete/key removal, grant issuance and a sustained denial or MFA-lockout spike.
Include the event id and a safe link, never a password, token, TOTP code or recovery code.
Record delivery success/failure and add a quarterly test. Do not page on every 401.

**Done when.** A synthetic creation reaches the named recipient; the alert contains no
secret; a delivery failure is visible; the recipient and escalation path are documented;
the alert test is repeatable.

### 8. Breach screening for new and changed passwords (NS-01)

**Gap.** Platform passwords are length-checked (16+) but not checked against known breach
corpora. Length is not entropy; a long reused password can still be correct in a dump.

**Action.** Use a k-anonymity range lookup on registration, reset, change and platform
first-login enrollment. Send only the five-character SHA-1 prefix; never the password,
email or full hash. Reject a match with a non-enumerating message. Decide and document the
provider-outage policy; fail closed for platform administrators, with a visible degraded
state, rather than silently accepting a known-breached password.

**Done when.** A known-breached password is rejected at every entry path; a random strong
password passes; logs/audit contain no password material; the outage policy is tested; the
legacy password path cannot bypass the check.

### 9. Support grants and the tenant-detail gate (SEC-06 / CI-04)

**Gap.** This is a **future-use gate**, not a current exposure: the console deliberately
shows aggregate data only. The danger is the next well-meaning change that adds a tenant
selector or member email without a support boundary. Support cannot investigate a specific
tenant safely under the current model.

**Action.** Before any tenant-detail or member-identifying read, require a reason-bound,
time-bound grant approved by the tenant/owner, with owner notification, audit at issue and
use, automatic expiry, and a read-only minimum scope. Never add a standing tenant
selector. Keep the aggregate report as the default.

**Done when.** A grant is required for every detail read; it expires; the tenant/owner is
notified; every use is audited; a foreign administrator cannot approve or use another
tenant's grant; the console still works with no grant.

### 10. Self-service TOTP rotation (NS-06)

**Gap.** TOTP has no rotation path after enrollment. Replacing an authenticator means
break-glass, which clears every factor and forces re-enrollment. That discourages routine
rotation and makes a lost device more disruptive than necessary.

**Action.** Start with the current password plus an existing factor; confirm with a code
from the new secret before removing the old one; revoke other sessions; preserve the
last-factor guard; audit the rotation. Do not silently consume recovery codes.

**Done when.** A wrong new code leaves the old factor working; the old secret is removed
only after confirmation; other sessions are revoked; the event is audited; the last factor
cannot be removed.

### 11. CLI secret-input hardening (NEW)

**Gap.** The bootstrap password is read from `PLATFORM_ADMIN_PASSWORD`. Inline environment
assignments can remain in shell history, and a process environment is readable by the same
local account. The confirmation phrases reduce accidents but not local disclosure.

**Action.** Support a no-echo interactive prompt or a file descriptor / permission-checked
file as the preferred input, keep environment input for CI only, and refuse a world-readable
password file. Clear the variable after use where the platform allows it. Do not print the
password or include it in an error, audit event or crash report. Keep the existing
confirmation phrases and operator requirement.

**Done when.** The documented path does not require the password in shell history; a
world-readable file is refused; the password never appears in logs/audit; the CI path still
works; the creation event and tests are unchanged.

### 12. Shared outer-gate failure budget (CI-09)

**Gap.** PLAT-25 is process-local by design. On a multi-instance deployment each instance
has its own global budget, so a distributed attempt gets more total capacity than the
documented cap suggests.

**Action.** Move the counters to the project's existing shared store only when the
deployment actually runs multiple instances. Preserve the valid-key-first behavior, the
one-audit-per-source-per-window sampling and the global stop on new buckets. Do not add a
new paid service for a single-instance deployment.

**Done when.** The cap is shared across instances; a valid key still works; audit volume
stays bounded; a store outage follows a documented fail-open/fail-closed policy.

### 13. Mandatory WebAuthn for SUPERADMIN (SEC-07)

**Gap.** TOTP is mandatory, WebAuthn is optional. TOTP is phishable; a passkey is stronger.
But the current production state has one SUPERADMIN and zero enrolled keys. A mandate now
could lock out the only operator.

**Action.** Do not mandate until at least two security keys are enrolled, recovery is
proven, and a staged enrollment window exists. Then require a passkey for SUPERADMIN
step-up and new-device sign-in while keeping TOTP as a fallback for a documented transition.
**Done when.** A SUPERADMIN can enroll two keys, recover with a key, and is never locked out
by a lost single device; the policy is visible in the console and audited.

## 5. New ideas worth keeping on the list

These are the genuinely new additions from this review, separate from the existing SEC/NS
items:

1. **Signed one-time creation grant** (rank 4) — turns a typed operator name into a
   verifiable approval and makes the audit event useful during an investigation.
2. **Audit hash chain plus a periodic signed digest** (rank 6) — detects database-level
   deletion or rewriting that the append-only model cannot.
3. **CLI password from a no-echo prompt or protected descriptor** (rank 11) — removes the
   most common local leak path without changing the creation ceremony.
4. **Two-person break-glass share** — split the recovery secret into two shares held by
   different people, require both to reset factors, and audit the reconstruction. This
   addresses the sole-SUPERADMIN availability risk without direct database surgery. It is
   not ranked above the table because it needs an ownership and custody process first, but
   it is a better long-term answer than a single operator-held reset secret.

## 6. Recommended order

The ranking is by value; the practical order is by dependency and smallest safe change:

1. **NS-02B activation**, because PLAT-26 already changed the creation path and the
   remaining half is bounded. Keep the break-glass exception explicit. Do not add tenant
   detail or a public create route.
2. **SEC-08 step-up** is implemented on lifecycle actions; reuse the same proof for the signed
   grant. Dual control remains the next SEC-08 piece.
3. **NS-04 session inventory**, so the new step-up and revocation controls are observable.
4. **Signed creation grant**, once step-up exists and the issuer route can be audited.
5. **NS-03 key rotation**, before the next secret-rotation drill.
6. **Audit chain/digest and one owned alert channel**, which make the preceding work
   verifiable during an incident.
7. **NS-01 breach screening**, **NS-06 TOTP rotation**, **CLI secret input**, **CI-09** and
   **SEC-06 support grants** as capacity allows. SEC-07 waits for the key/recovery
   preconditions.

## 7. Deliberately not next

- **No HTTP administrator-creation route.** The CLI is the deliberate bootstrap surface;
  keep it that way.
- **No tenant detail in the aggregate console.** SEC-06/CI-04 is the gate.
- **No role-change UI before activation, step-up and audit are in place.** A role change is
  a privilege escalation; it needs the same controls as creation and deletion.
- **No new paid identity, logging or secret service.** The existing MongoDB audit,
  TOTP/WebAuthn, mail path and process environment cover the ranked items.
- **No change to PR #336 or the production deployment as part of this review.** These are
  recommendations only; the owner chooses what to implement and when.
