# Security improvements beyond PLAT-21

**Companion ranking:** [09 — Remaining security priorities](09-remaining-security-priorities.md)
ranks these NS items alongside the remaining SEC items and newer ideas. It is also
recommendations only.

**Status:** **RECOMMENDATIONS ONLY, EXCEPT NS-05 AND THE NS-02 AUDIT SLICE.** NS-05 was
implemented on 2026-11-18 (the outer-gate failure limiter and sampled denial audit are in
the code and PLAT-7). The NS-02 audit portion was implemented on 2026-11-18 (CLI creation
writes one `platform.admin.created` event). Address verification and activation remain
unimplemented. Nothing else here authorizes code, configuration, a notification, a drill,
a database operation, a deployment or a paid service.

**Reviewed:** 2026-11-18
**Basis:** the current implementation at `5016553`, PR #336 at `6f61e11`, the production
snapshot in [01 — Status and accounts](01-status-and-accounts.md),
the full project conversation, and the existing SEC-01–12, CI-01–15, TS-01–06, NX-01–07,
NY-01–07 and NZ-01–07 records.

## 1. Scope

This is the **additive** tranche after PLAT-21. It looks for controls that the earlier
reviews did not already own. It does not repeat an existing recommendation, re-open a
closed one, or promote a planning item into implementation.

| Existing item | Why it is not repeated here |
| --- | --- |
| SEC-01/SEC-02/SEC-03, CI-01 | Recovery codes, break-glass, administrator lifecycle and MFA attempt budgets are implemented or tracked |
| SEC-05/CI-06, NY-05 | Audit retention, export, database least privilege and internal tamper evidence are tracked |
| SEC-06/SEC-08/SEC-10, CI-02/CI-04/CI-08 | Support grants, dual control and the administrator UI are tracked; the SEC-08 step-up proof for destructive lifecycle actions shipped in PLAT-27 |
| SEC-07/CI-03 | A dedicated platform identity provider and passkey-first policy are tracked |
| SEC-09/CI-05/CI-14 | Platform security alerting, routing and on-call ownership are tracked |
| SEC-11/CI-10 | Browser-E2E reproducibility and expanded recovery/lifecycle automation are tracked |
| SEC-12, TS-02/TS-04 | Access recertification, posture review and rotation drills are tracked |
| TS-01/TS-05 | Tenant security notifications and tenant MFA/step-up are tracked |
| TS-03, IA-15 | Cross-tenant AI canary and prompt-injection review are tracked |
| NX-01 | Sensitive-data map, log redaction and the cross-sink canary are tracked |
| NX-03 | The non-AI cross-tenant authorization matrix is tracked |
| NZ-01–NZ-07, NY-01–NY-07 | CodeQL, dependency review, rollback drill, workflow audit, Android privacy, policy drift, App Check and the NY tranche are tracked |
| PR-03, PR-04, PR-09 | Network isolation, secret rotation and audit least privilege are already open gates |

The seven items below are **new relative to those records**. Several are deliberately
small extensions of an existing control; none replaces it.

## 2. Ranking

Scored 1–5 on six equally weighted criteria, maximum 30:

1. **Impact** — how much a real compromise or failure is reduced.
2. **Likelihood** — how plausible it is with the current system.
3. **Blast radius** — how many tenants, administrators or records are affected.
4. **Free feasibility** — 5 means existing tools and no paid service.
5. **Business value** — trust, support readiness or contractual value.
6. **Time to value** — 5 means days, 3 means weeks, 1 means a project.

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total | Effort | Priority |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | **NS-01** | Breach screening for new and changed passwords | 5 | 4 | 4 | 5 | 4 | 4 | **26** | M | **P1** |
| 2 | **NS-03** | Versioned rotation for platform signing and MFA-encryption keys | 5 | 2 | 5 | 5 | 4 | 3 | **24** | M | **P1** |
| 3 | **NS-02** | Make the operator CLI an audited, verified privileged surface | 4 | 3 | 4 | 5 | 3 | 5 | **24** | S | **P1 — audit implemented** |
| 4 | **NS-04** | Platform session inventory and targeted revocation | 4 | 2 | 4 | 5 | 3 | 4 | **22** | S/M | **P2** |
| 5 | **NS-07** | AI web-egress boundary and prompt-injection canary | 4 | 2 | 4 | 5 | 3 | 3 | **21** | M | **P2** |
| 6 | **NS-05** | Anti-automation and audit for the outer access gate | 3 | 2 | 3 | 5 | 3 | 5 | **21** | S | **P2 — implemented** |
| 7 | **NS-06** | Self-service platform factor rotation | 3 | 2 | 4 | 5 | 3 | 3 | **20** | M | **P2** |

Ties are broken by impact, then blast radius, then speed. The order is a recommendation,
not an authorization.

## 3. Recommendations

### NS-01 — Breach screening for new and changed passwords

**Gap.** Tenant passwords are only length-checked (**8–72 characters**); platform
passwords are only length-checked (**16+ characters**). Neither path checks whether the
chosen password has appeared in a known breach. A credential-stuffing attempt against a
tenant OWNER/ADMIN therefore succeeds on a password that is long enough but publicly
known.

**What to add.** On registration, password reset and password change, check the candidate
against a breached-password corpus using a **k-anonymity** lookup (only the first five
characters of a SHA-1 hash leave the server; never the password, email or full hash).
Reject a match with a clear, non-enumerating message and suggest a generated passphrase.
Apply the same rule to platform password changes and first-login enrollment. Choose and
document the provider-outage policy: fail open with a visible degraded alert, or fail
closed for platform administrators only.

**Why it matters.** The login limiters and MFA stop guessing, but they do not stop a
correct credential that is already in a breach dump. Tenant accounts have no second
factor (TS-05 is deferred), so the password is the only barrier for STAFF/MANAGER and one
of two for OWNER/ADMIN. This is a direct, low-cost reduction in account-takeover risk.

**Free path.** The public Have I Been Pwned range API is free for this use; a small local
blocklist is a fallback. No new paid service is required. Do not send the password or
email to the API; do not log the hash prefix or the result beyond a counter.

**Acceptance.** A known-breached password is rejected at registration, reset and change; a
strong random password is accepted; the API receives only a five-character SHA-1 prefix;
no password or full hash appears in logs, audit or errors; a provider outage follows the
recorded policy; the check cannot be bypassed by the legacy password path.

**Dependencies.** None. It touches the shared password validator and the auth service;
it does not change the session or MFA design.

---

### NS-03 — Versioned rotation for platform signing and MFA-encryption keys

**Gap.** `PLATFORM_MFA_ENCRYPTION_KEY` is a single secret; TOTP secrets are stored as
`v1.<iv>.<tag>.<ciphertext>` and decrypted with that one key. `PLATFORM_ADMIN_JWT_SECRET`
is also a single secret, and platform tokens carry no key id. Rotating either value
currently means replacing the environment and restarting: existing TOTP secrets become
undecryptable, or every platform session is invalidated with no staged rollover. PR-04
records this as an open readiness gate.

**What to add.** A key ring, not a second hard-coded secret:

- JWT: add a `kid` header; verify against the active and a bounded previous key; sign new
  tokens with the active key. Retire the previous key only after the longest session
  lifetime has passed.
- MFA envelope: add a key id to the envelope (for example `v2.<kid>.<iv>.<tag>.<ciphertext>`),
  decrypt with the matching key, and **re-encrypt with the active key after a successful
  login**. Keep old keys until every record has been re-encrypted or the account is
  re-enrolled.
- Access key: accept the previous and current `PLATFORM_ACCESS_KEY` during an overlap
  window, record the rotation, then remove the old value.

**Why it matters.** A leaked signing key can mint platform tokens; a leaked MFA key can
decrypt every enrolled TOTP secret. The current only recovery is break-glass, which
clears factors and forces re-enrollment. A planned rotation turns a compromise or a
routine hygiene requirement into an operation that does not strand the sole administrator
or silently break every session.

**Free path.** Existing crypto and configuration; no KMS purchase is required for this
step. An external secret manager can be a later option.

**Acceptance.** A token signed with the previous key still verifies during overlap and
fails after retirement; a TOTP record encrypted with the previous key decrypts and is
re-encrypted on the next successful login; a new login uses the active key; the rotation
is audited; no secret value is printed; a rollback restores the previous state without
resetting factors.

**Dependencies.** PR-04 (rotation procedure) and SEC-12 (drill). This item supplies the
mechanism those records currently lack.

---

### NS-02 — Make the operator CLI an audited, verified privileged surface (audit portion implemented 2026-11-18)

**Gap.** `npm run platform-admin:create` writes a `PlatformAdmin` row directly through
`createPlatformAdminAccount`; it did not write a platform audit event, and the address is
still accepted without proof of ownership. The HTTP lifecycle routes are audited, but the
one path that can create a SUPERADMIN was outside that trail. A typo, a departed operator
or a local compromise left no product-visible record of who created the account or which
address was verified.

**Implemented (audit portion).** The CLI now requires `PLATFORM_ADMIN_OPERATOR` and writes
exactly one `platform.admin.created` event with the operator identity (actor email), the
source (`cli`), the target email, target role and optional `PLATFORM_ADMIN_GRANT_ID`. A
duplicate or failed creation writes no success event. PLAT-7 asserts the single event,
its fields, the absence of the password and the duplicate case. The console audit view is
available to SECURITY/SUPERADMIN.

**Still to add (address activation, not implemented).** A one-time activation code sent to
the target address before the account can authenticate; keep the row `PENDING` until the
address proves control. The bootstrap first administrator may use a documented break-glass
exception, still audited. Keep the confirmation phrases; add a second approver for
production creation once a second SUPERADMIN exists. Record break-glass resets and role
changes in the same trail; a database-only change remains outside the application and must
be called out in the incident record.

**Why it matters.** Accountability is the control that survives a compromised operator
account. SEC-02/SEC-10 require audited lifecycle operations, but the creation path is the
one that establishes the identity in the first place. Email proof also prevents a
typo-squatted or wrong address from becoming a privileged login.

**Free path.** Existing audit collection, Brevo mail and CLI; no new service.

**Acceptance.** The audit slice is met: a CLI creation writes exactly one event with the
operator/source/target/grant, a duplicate is refused, the event is readable by
SECURITY/SUPERADMIN, no password/TOTP/recovery material is recorded, and a failed creation
writes no false success event. Address activation remains required before this item is
fully closed: an unverified address must not sign in and a verified address must.

**Dependencies.** SEC-02/SEC-10 (lifecycle and four-eyes design). The activation flow
remains the next step.

---

### NS-04 — Platform session inventory and targeted revocation

**Gap.** Platform sessions have `deviceLabel`, timestamps and `jti`, and the lifecycle
routes can disable/delete an administrator, which revokes **all** of that administrator's
sessions. There is no route or console view that lists an administrator's active sessions
or revokes one session. The team page shows a session count only indirectly; a stolen
cookie can remain valid for the 8-hour absolute / 15-minute idle window with no way to
identify and cut off that one device.

**What to add.** A SUPERADMIN-only, audited session inventory:

- `GET /api/platform/admins/:id/sessions` returns bounded, non-secret metadata: device
  label, created, last used, expiry, and a short session id — never the `jti` or token.
- `DELETE /api/platform/admins/:id/sessions/:sessionId` revokes exactly that session;
  the current session is refused or explicitly confirmed, and the last-session rule is
  documented.
- The team view shows “N active sessions” and a per-session revoke action.
- A self-service “sign out my other sessions” action uses the same service.

**Why it matters.** SEC-02 covers the all-or-nothing lifecycle. The missing middle is the
common incident response step: “this one device is lost; keep the others.” It also makes
the session cap and idle timeout observable instead of a promise.

**Free path.** Existing `platform_admin_sessions` collection and UI; no new store.

**Acceptance.** A second session appears in the list; revoking it makes its next request
401 and leaves the first session working; the token/jti is never returned; a foreign
administrator cannot list or revoke another's sessions; the action is audited; disabling
the account still revokes all sessions.

**Dependencies.** None beyond the existing platform capability model.

---

### NS-07 — AI web-egress boundary and prompt-injection canary

**Gap.** The assistant can use OpenRouter **native web search and web fetch** when those
switches are enabled. The provider executes those tools; the server sends the tenant's
inventory context to the model and cannot inspect the model-authored search query before
it leaves. A prompt injection embedded in a product name, supplier note or other tenant
text could ask the model to place business data into a web query. The existing TS-03
canary proves cross-tenant *reads*; IA-15 reviews prompt injection; neither proves an
**egress** boundary.

**What to add.** Decide the policy before widening web research:

- Prefer **server-mediated** web tools (the existing `freeWeb` path) for turns that contain
  tenant data, because those calls can be URL-validated, query-capped and logged safely.
  Provider-native tools remain for public, non-tenant research only.
- Add a per-turn egress budget and a redaction/deny check for credential-shaped strings,
  canary markers and obvious tenant identifiers in any server-mediated query.
- Add a synthetic canary tenant whose product name contains a prompt-injection instruction;
  assert the canary never appears in an outbound web query, provider request log or answer
  to another tenant.
- Record the tool name, query hash and result count — not the raw query or result body.

**Why it matters.** The AI is read-only, but read access plus an outbound web channel is
still an exfiltration path. This is a lower-likelihood issue than account takeover, but
its blast radius is tenant data and it is not covered by the current isolation tests.

**Free path.** Existing AI tool layer, provider boundary and local canary fixtures; no
new vendor. This is a design and test change, not a paid DLP product.

**Acceptance.** A poisoned canary product cannot cause its marker to appear in an outbound
query; provider-native tools are unavailable on tenant-data turns (or the residual risk is
explicitly accepted); a normal research turn still works; the canary fails when the
boundary is deliberately removed; no raw prompt/query is logged.

**Dependencies.** Confirm the production `AI_WEB_SEARCH`/`AI_WEB_FETCH` values first. If
both are disabled, this is a design gate for the next enablement, not a live exposure.

---

### NS-05 — Anti-automation and audit for the outer access gate (implemented 2026-11-18)

**Gap.** `platformAccessGate` checked the shared Basic key with a timing-safe comparison,
but it had no rate limiter and wrote no audit event. A wrong key returned the same 401 and
stopped before the platform audit. Repeated guesses, scanners and a distributed attempt
were therefore invisible in the product. The key is high-entropy, so brute force is
unlikely; the missing control was detection and bounding, not the secrecy of the key.

**Implemented.** The gate now counts failed key checks in a bounded window and returns
`429 PLATFORM_ACCESS_RATE_LIMITED` with `Retry-After` after the budget. A correct key is
checked before the limiter, so a legitimate operator is never locked out. The first
failure from an address in each window writes one sampled
`platform.access.gate_denied` event; it records the source address, route and time but
never the supplied key. The budgets are process-local and configurable with
`PLATFORM_ACCESS_GATE_WINDOW_MS` (default 15 minutes),
`PLATFORM_ACCESS_GATE_MAX_FAILURES` (default 20 per address) and
`PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES` (default 200 per process).

**Why it matters.** The URL is internet-reachable on the free plan; the gate is the first
control. An unlogged 401 is not evidence of an attack, and an unbounded loop is a cheap
way to fill the host log or probe the key. Sampling avoids turning the audit trail into a
scanner-driven write amplifier.

**Verification.** PLAT-7 proves three bounded 401s, the fourth request as 429 with
`Retry-After`, a valid key still reaching platform authentication during the window, and
exactly one audit row with no key material. It also proves that after the global cap a
new source address gets no bucket, no extra audit row and no growth beyond the cap; the
state resets with the window. `tsc --noEmit` passes.

**Remaining.** Alert delivery and ownership are still SEC-09; the limiter is process-local
and the shared-store item is CI-09. Neither prevents the limiter or audit from shipping.

**Acceptance.** Wrong keys produce bounded 401s until the per-address or global budget is
reached, then 429 with `Retry-After`; after the global cap no new buckets or audit rows
are created; a correct key still works during the window; one sampled audit row is
written per address with no key material; a normal login is unaffected; the limiter is
documented as process-local. Alert delivery remains open.

---

### NS-06 — Self-service platform factor rotation

**Gap.** A platform administrator can add/remove a WebAuthn key and regenerate recovery
codes, but TOTP has no rotation path after initial enrollment. The only way to replace a
TOTP secret is break-glass, which clears every factor and forces re-enrollment. This makes
routine hygiene, a suspected authenticator compromise, or a device migration unnecessarily
disruptive.

**What to add.** A step-up-protected TOTP re-enrollment:

- Start requires the current password **and** an existing TOTP/WebAuthn factor; confirm
  requires a code from the new secret.
- Do not remove the old secret until the new one is confirmed; keep the last-factor guard.
- Revoke other sessions after rotation; write `PLATFORM_MFA_TOTP_ROTATED`; show the new
  recovery-code state (rotation does not silently consume codes).
- Offer the same flow for a new security key; removal already exists.

**Why it matters.** Factor rotation is a basic containment action after a lost or cloned
authenticator. Forcing the sole SUPERADMIN through break-glass for a routine change
discourages rotation and increases the chance of a lockout during an incident.

**Free path.** Existing TOTP service, encryption envelope and console; no new service.

**Acceptance.** A new secret is confirmed before the old one is removed; a wrong new code
leaves the old factor working; other sessions are revoked; the last factor cannot be
removed; the event is audited; the console shows the new enrollment state.

**Dependencies.** SEC-08 step-up; the current login factor proof can be reused.

## 4. Recommended sequence

The ranking measures security value; the sequence below is the practical order.

**First, low-regret quick wins (days):**

1. **NS-02** — audit the CLI creation path (implemented 2026-11-18) and add address
   verification. The audit closes an accountability gap with no new vendor; activation is
   the remaining half.
2. **NS-05** — implemented 2026-11-18. Bound and sampled outer-gate failures now produce a
   visible event; alert delivery remains SEC-09.
3. **NS-01** — add breach screening to the shared password validator. It is the highest
   direct reduction in tenant account takeover.

**Then, the high-value infrastructure item (weeks):**

4. **NS-03** — key-versioned rotation. Do this before the next credential-rotation drill;
   it is the difference between a routine rotation and a forced break-glass.

**Then, the operational controls:**

5. **NS-04** — session inventory and one-device revocation.
6. **NS-06** — TOTP rotation.
7. **NS-07** — AI egress boundary, after confirming the production web-tool switches.

## 5. What not to do

- Do not weaken the separate platform JWT secret, mandatory MFA, exact-Origin cookie
  check, CSRF double-submit, per-account MFA lock or forced recovery ceremony.
- Do not add tenant detail to the aggregate console; SEC-06/CI-04 remains the gate.
- Do not send a password, email or full hash to a breach-check API; do not log the result
  with the account.
- Do not rotate the MFA key by replacing it and restarting; that makes existing TOTP
  secrets unreadable.
- Do not treat a green CI run as a security proof. The `webauthn-e2e` job failed once on
  2026-11-18 and passed on rerun; the failure is recorded in §27JG, and SEC-11 remains the
  durability item.

## 6. Current evidence

- PR #336 is **CLEAN** at `6f61e11`: `server`, `mobile`, `secret-guard`,
  `attribution-guard` and `webauthn-e2e` all pass. The first `webauthn-e2e` attempt failed
  in the third password step with `VALIDATION_ERROR`; the same script passed locally and
  on a rerun of the failed job. No code was changed to obtain the pass.
- **NS-05 was implemented after this review, on 2026-11-18:** the gate limiter, 429 path and
  sampled `platform.access.gate_denied` event are in the working tree and PLAT-7. This is
  local code only; no deployment, merge or production configuration change was made.
- Production is `5016553`; no deployment or merge is part of this record.
- The code citations for each gap are in the item above and were read from the working
  tree, not inferred from a dashboard.

## 7. Related records

- [01 — Status and accounts](01-status-and-accounts.md) —
  the measured console status and account paths.
- [07 — Security recommendations](07-security-recommendations.md) — SEC-01–SEC-12.
- [03 — Console improvements](./03-console-improvements.md) — CI-01–CI-15.
- [`PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md`](../PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md) — TS-01–TS-06.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md`](../PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md) — NY-01–NY-07.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NY07.md`](../PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NY07.md) — NZ-01–NZ-07.
- [04 — Production readiness](04-production-readiness.md) — PR-03, PR-04, PR-09.
