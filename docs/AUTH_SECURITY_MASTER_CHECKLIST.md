# Inventory AI — Authentication & Security

**What this is.** The single page to read before changing anything that touches sign-in, sessions,
verification, recovery or authorization. It states the security invariants (what must stay true), the
one-line status of each control, and every decision or external gate that is still open.

**What it is not.** It authorises no work, changes no code, and is not a history. Dated records and
their measurements live in [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) (`27…` records);
behaviour is specified in [`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md). The architecture
this file checks against is
[`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md).

**Status legend.** `[✓]` done and verified · `[~]` done, not externally verified · `[ ]` not
implemented · `[⛔]` blocked by something outside the repository · `[⏸]` deferred by decision ·
`[—]` considered and not applicable.

*Last reconciled 2026-11-06 against `main`. "Implemented" ≠ "verified on a phone"; "planned" ≠
"authorised".*

---

## 1. Security invariants

Non-negotiable. A change that breaks one is a defect, not a trade-off. This is the single invariant
register; the architecture document explains the design and points here.

| # | Invariant | Where it is enforced |
| --- | --- | --- |
| I-1 | **Firebase is the identity provider** — who this person is. | `services/firebase/*`, exchange route |
| I-2 | **MongoDB is the application authority** — `userId`, `businessId`, `role`, `status`, permissions, plan. | `models/user.model.ts`; `middlewares/authenticate.ts` reloads per request |
| I-3 | **The Inventory AI JWT is the API bearer.** A Firebase ID token is exchanged **once** and never becomes the bearer. | `services/firebaseAuth.service.ts`; `config/jwt.ts` |
| I-4 | **The server derives** `userId`/`businessId`/`role`/`status`; the client never supplies them. | `authenticate.ts`; `phase24-runtime-authorization-matrix` |
| I-5 | **The client cannot choose** business, role, status or Firebase linkage. | `firebaseLink.service.ts` returns only `{problems, idToken}` |
| I-6 | **Tenant isolation is server-side**; every business-owned query is scoped by a server-derived `businessId`. | query scoping; refusals are a plain 404 |
| I-7 | **Email is not an identity key.** No automatic linking on an address match. | exchange resolves by `firebaseUid` only |
| I-8 | **`firebaseUid` is read only from a verified token payload.** | `services/firebase/tokenVerifier.ts` |
| I-9 | **`firebaseUid` is unique and sparse** (sparse is mandatory for legacy accounts). | `user.model.ts` |
| I-10 | **A Firebase-linked user has no second password door** — legacy login refuses `403 FIREBASE_SIGN_IN_REQUIRED` *after* password and status, before any session write. | `auth.service.ts` |
| I-11 | **A token with no, invalid, revoked or expired `jti` is refused.** | `session.service.ts`; `authenticate.ts` |
| I-12 | **`passwordChangedAt` invalidates earlier tokens** (`SESSION_INVALIDATED`). | `authenticate.ts` |
| I-13 | **Sensitive credential changes require recent authentication** (`auth_time`, 300 s, fail-closed). | `constants/firebase.ts` |
| I-14 | **Linking is authenticated, own-account only, email never a join key**, conflicts refused with one 409. | `firebaseLink.service.ts` |
| I-15 | **Unlinking writes a new credential in the same transition** — no zero-method account. *(The unlink operation itself was removed; see §4, O-1.)* | retired with the operation |
| I-16 | **No cross-business movement** — a link writes only `firebaseUid` and `emailVerified`, never `businessId`, `role` or `status`. | `firebaseLink.service.ts` |
| I-17 | **No credential in a log** — no password, Firebase token, JWT, `jti`, reset code, invitation token or secret. Audit rows omit them. | `mail/*`, `audit.service.ts`, Phase 08A logger |
| I-18 | **A disabled user cannot authenticate or use a protected route.** | `authenticate.ts` status check |
| I-19 | **A suspended or archived business blocks access**; it is a workspace state, not a token failure. | `assertActiveBusiness` |
| I-20 | **OWNER is protected** — never created or assigned through the API, immutable, no self role/status change, ADMIN cannot create or modify another ADMIN. | `users.service.ts`, `constants/roles.ts` |
| I-21 | **Every security decision is backend-authoritative**; the mobile permission mirror is presentation only. | `middlewares/authorize.ts` |
| I-22 | **At most 20 open sessions per user** (`MAX_ACTIVE_SESSIONS_PER_USER`). Creation evicts the **oldest**, so the device in hand keeps working; each eviction is audited `reason: "session-cap"`; best-effort by design. | `session.service.ts` |
| I-23 | **An invitation is not a credential.** Acceptance requires a verified identity whose address equals the invited one; only the token's SHA-256 digest is stored; tenant and role come from the invitation row, never the request. | `invitations.service.ts`, `firebaseAuth.service.ts` |
| I-24 | **Account deletion removes personal data, not the tenant's ledger.** A business whose last member leaves closes with them. | `accountDeletion.service.ts`, `tenantTeardown.service.ts` |
| I-25 | **A revoked Firebase credential cannot create a session.** Revocation is checked at exchange. | `firebaseAuth.service.ts`; revocation check |
| I-26 | **An unverified identity cannot obtain a session.** Registration provisions only after verification. | `firebaseAuth.service.ts`; `tokenVerifier.ts` |
| I-27 | **Raw authentication errors are never exposed.** They pass through the operation-aware mapper. | auth error mapper; auth controllers |
| I-28 | **Server-provided retry timing is authoritative.** The client renders `Retry-After`; it never invents one. | `middlewares/rateLimit.ts`; `mobile/lib/client.ts` |
| I-29 | **A transient failure preserves a valid session.** Only a server refusal signs out. | `mobile/lib/auth.tsx`; authentication epoch |
| I-30 | **Every role uses the same authentication mechanism.** Differences are authorization data only. | `authenticate.ts`; role matrix |

> **I-19 note.** `utils/businessAccess.ts` `assertBusinessAccess` is production-dead (no `src/`
> importer). Real isolation is `businessId` scoping returning 404. Left in place.

---

## 2. Identity and session model

The design is owned by
[`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md)
§§1–10. It defines the authority layers, exchange, verification, token/session contract, failure
classes, password and recovery rules, linking, tenant isolation and legacy retirement. This checklist
records the invariants and controls that test that design; it does not restate the model.

---

## 3. Control status

| Area | Status | Note |
| --- | --- | --- |
| Registration (Firebase) | `[✓]` | identity → 6-digit code → verification → server provisioning as OWNER |
| Registration (invitation) | `[✓]` | tenant and role from the invitation row; OWNER/ADMIN escalation refused; one live link per address |
| Email/password login | `[✓]` | two limiters, generic 401, disabled-user 403 |
| Google sign-in | `[~]` | native, verified end-to-end for an **existing** account on Android; the new-identity path is environment-blocked |
| Account linking | `[✓]` | server boundary; conflicts 409 |
| Account unlinking | `[—]` | **removed** — re-scoped into a password change |
| Email verification | `[✓]` | live acceptance on Brevo 2026-10-04 |
| Password change | `[✓]` | recent-auth gate; other sessions revoked; a fresh session is issued |
| Password recovery | `[✓]` | six-digit code in the app; link path needs console setting L-17 |
| Session revocation | `[✓]` | per session, everywhere, and on credential change |
| Session cap | `[✓]` | 20 open sessions, oldest evicted, audited |
| RBAC | `[✓]` | catalogue + role matrix; route classification and a runtime four-role matrix are guarded |
| Tenant isolation | `[✓]` | server-derived `businessId`; ~15 behavioural tests |
| Audit trail | `[✓]` | write path since Phase 04; read-only viewer, OWNER/ADMIN |
| Rate limiting | `[~]` | login, register, verification, reset, renewal, invitation, AI; **in-memory per process** (E3) |
| Sensitive-logging hygiene | `[✓]` | guarded by source tests; RNFirebase PII log patched and verified in the shipped dex and on a device |
| MFA | `[ ]` | deferred |
| Security notifications | `[ ]` | deferred |
| Firebase → Mongo disable sync | `[ ]` | revocation is checked at verification; no mirroring |
| Monitoring / incident runbook | `[ ]` | no repository-specified integration or runbook |

---

## 4. Owner decisions

Resolved decisions are not reopened without new repository evidence.

| # | Decision | State |
| --- | --- | --- |
| O-1 | Unlink policy and last-method protection | **Policy B resolved; operation removed.** No reachable path clears `firebaseUid`; the residual (Firebase's own provider set) stays open |
| O-3 | Is `emailVerified` enforced? | Resolved and **implemented**: the gate is the registration ordering plus a verify screen; `requireAuth` untouched |
| O-5 | Facebook identities without a usable email | **Open** — blocks Facebook Login |
| O-6 | Remedy for the unhealable orphan identity | **Open** — blocks legacy migration |
| O-8 | Does Firebase take over recovery? | Resolved — yes; shipped as AUTH-06 |
| O-10 | Invitation-based onboarding | **Shipped 2026-10-25** (roadmap §27FB). Still open: migrating admin-created password accounts before legacy login can be retired |
| O-11 | Expo Go policy | Open and moot — the dev-client requirement forfeited it |

Also resolved, unchanged: O-2 inert-hash behaviour, O-4 RNFirebase M1, O-7 EAS build-time
configuration injection, and O-9 the credential-change revocation bridge.

---

## 5. Deferred and accepted risk

| Item | Status | Reason |
| --- | --- | --- |
| B1 — reset-mail timing term | `[⏸]` | accepted for V1, partially mitigated, not closed |
| B2 — distributed reset-mail flooding | `[⏸]` | needs a shared store; deferred with E3 |
| E3 — in-memory limiter stores | `[⏸]` | per-process; a restart or a second instance resets a bucket. Production runs one instance and sets `TRUST_PROXY` |
| MFA, security notifications | `[⏸]` | future scope, unscheduled |
| V4 SaaS / billing | `[⏸]` | out of V1 scope |
| Two mobile dependency advisories | `[⏸]` | no safe upgrade exists; see [`SECURITY_DEPENDENCY_DECISIONS.md`](SECURITY_DEPENDENCY_DECISIONS.md) |

---

## 6. Open gates

| Gate | Requirement | Status | Blocker |
| --- | --- | --- | --- |
| P-1 | Native Firebase config files never committed | `[✓]` | EAS injects them |
| P-2 | Google Sign-In library pinned | `[✓]` | `@react-native-google-signin/google-signin@16.1.5` |
| P-3 | `compileSdk`/`targetSdk` ≥ dependencies | `[✓]` measured | built manifest: 36 / 24 / 36 |
| P-4 | Keychain survival across reinstall | `[⛔]` | device-time test not run |
| P-5 | Firebase console state | `[~]` | Android satisfied; **iOS app not registered** |
| P-6 | iOS build capability | `[⛔]` | no macOS host |
| L-17 | Password-reset *Customize action URL* set to `https://ai-inventory-l1mi.onrender.com/auth/reset` | `[ ]` **open** | console-only; gates the emailed-link path |
| New-identity Google sign-in | `REGISTRATION_REQUIRED` outcome | `[~]` | device consent cache |

An empty iOS column is an environment limit, not a choice: report it as unverified rather than
assumed.

---

## 7. Production posture

| Item | State |
| --- | --- |
| Secrets | environment only; `.env` never committed; production fails fast on a missing one |
| Sessions | `jti` rows, revocation, 14-day cap, 20-session bound |
| Audit | trail plus read-only viewer |
| Backups | `backup:db` writes a manifest with per-file SHA-256 and refuses a corrupt restore; tested on a scratch database, but a **full restore on the real tier has never been observed** (§27DH) |
| Monitoring | `GET /health/live` and `/ready`; an outside watcher reads the pulse (§27DI) |
| Dependency guard | `scripts/check-secrets.mjs` in CI, every rule with a canary |
| Open | iOS; Play release not made; OTA code signing blocked by plan (§27FN) |

---

## 8. Protected working-tree entries

Five paths are protected by the project's change-safety rules. The check is **manual** — git blob
hashes, immune to CRLF normalisation; no automated verifier exists. All five are committed and equal
to `HEAD`.

```text
7a6580985611418d785163d73582af887f7c90a6  mobile/eas.json
377ffab6936f6474f101ffd8df92b8e16f077b83  server/src/services/ai/providers/http.ts
07601c7ab31009263d0045f20a9b940539184094  server/test/phase06-ai-wire.test.mjs
12627bae19ec693bd8d609ac00bd57b602139dce  docs/superpowers/plans/2026-09-11-phase-18c-core-list-screens.md
347bcc1365939bed92879f00d781f63f71cf670e  docs/superpowers/plans/2026-09-11-phase-18e-secondary-screens.md
```

**Refreshed 2026-11-06.** `mobile/eas.json` gained the `production-apk` profile required by the
release guides; the other four still match. Every value now equals `HEAD`. Verify with `git hash-object <path>`
against `git rev-parse HEAD:<path>`; the hashes are a record of *what is committed*, not a rule that
the files can never change.

Before meaningful work: inspect branch, `HEAD`, `git status --porcelain`, and these five. After:
re-check them, run the required checks, and commit only approved work. Never `reset`, `restore`,
`clean`, `stash`, force-push, rewrite history, rebase or merge without explicit approval.

---

> **Maintenance.** On any auth/security change: update the affected row from evidence, never from
> intent; do not mark code-only work as externally verified; do not promote deferred work into the
> current sprint. If requested work conflicts with an invariant or an open decision here, **stop and
> report the conflict**.
