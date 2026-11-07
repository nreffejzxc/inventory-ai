# Authentication & User Verification — Architecture

**Status:** approved target architecture. It states rules; implementation status, control status and
open decisions are in
[`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md).

This is the design authority for sign-in, verification, application sessions and credential recovery.
It states *rules*, not history. Behaviour is specified in
[`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md) §29; the dated record of each increment is in
[`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md). The checklist owns the invariant register (§1),
control status (§3), decisions and gates (§§4–6). Where an existing implementation conflicts with a
rule here, the rule wins and the conflict is reported.

---

## 1. Three authority layers

| Layer | Question it answers | Owns |
| --- | --- | --- |
| **Firebase Authentication** | *Who is this person?* | UID, credentials, email-verification state, provider identity, Firebase sessions, Firebase-side revocation |
| **Inventory AI backend / MongoDB** | *What may this person do here?* | User, Business, membership, role, status, permissions, business lifecycle |
| **Inventory AI session + JWT** | *Is this request allowed right now?* | Session identity, revocation, expiry, audit |

The client is never trusted to choose or override `userId`, `businessId`, `role`, OWNER status or
permissions.

### Identity rule

```text
Firebase UID  →  MongoDB User.firebaseUid
```

**Email is never the join key.** No account is linked because an address matches. Linking is explicit
and authenticated (§7).

---

## 2. Authentication flow

```text
Firebase credential
  → Firebase UID + ID token
  → POST /api/auth/firebase/exchange        (once)
  → server verifies the token
  → server loads User by firebaseUid
  → server reads businessId / role / status from MongoDB
  → Inventory AI session + JWT
```

A verified Firebase ID token is an **entry document, not the API bearer**. It is exchanged once and
never accepted as authorization afterwards.

All four roles — OWNER, ADMIN, MANAGER, STAFF — use the same authentication mechanism. Their
differences are entirely in the application's authorization data.

---

## 3. Email verification

Verification happens **before** any `User`, `Business`, JWT or session exists. The gate is the
registration *ordering*, not a flag checked later.

- A six-digit code is generated with a CSPRNG, stored as a keyed digest, bound to the Firebase UID,
  expires, and is consumed on use.
- It is delivered through the provider-agnostic mail boundary (Brevo).
- Confirmation sets Firebase's `email_verified` through the Admin SDK — Firebase remains the authority
  of record.
- MongoDB's own verification field is migration-era duplication and is retired with the rest of the
  legacy path (§10).

Verification proves control of an address. It grants **no** role, business or permission; those are
application decisions.

`requireAuth` is deliberately unmodified by this flow. A verified identity with no `User` row answers
`403 REGISTRATION_REQUIRED`, and registration is the only route that creates one.

### Firebase console settings: verified 2026-11-07

> **Current implementation (AUTH-06, 2026-10-20).** The app's password reset is the six-digit code
> flow in `docs/SYSTEM_SPECIFICATION.md` §29, sent through Brevo. Firebase's password-reset email and
> action-link return chain are **not** on the active path.

The Firebase Admin API (`GET /admin/v2/projects/inventoryai-d0d20/config`) was read on 2026-11-07:

- **Authentication → Settings → Authorized domains** lists `localhost`,
  `inventoryai-d0d20.firebaseapp.com`, `inventoryai-d0d20.web.app` and
  `ai-inventory-l1mi.onrender.com`. The production host is present; no change is needed.
- **Authentication → Templates → Password reset** still uses Firebase's default template and
  callback (`https://inventoryai-d0d20.firebaseapp.com/__/auth/action`). No custom action URL is set.
  That is intentional: the template editor refused writes, and the active six-digit flow does not
  use the Firebase link.

**L-17 is closed as not applicable.** It gated the Firebase emailed-link return path, not AUTH-06.
The server still carries the legacy reset-link code, but the mobile client no longer calls
`sendPasswordResetEmail`; if that Firebase path is reintroduced, L-17 must be reopened and both
console settings revisited.

---

## 4. Token and session contract

```text
JWT claims:  sub, jti, iat, exp, iss, aud          — nothing else authoritative
Session row: userId, jti, deviceLabel, createdAt, lastUsedAt, expiresAt, revokedAt
```

- **No authorization in the token.** Role, business and permissions are re-read from MongoDB per
  request. A forged `role` claim grants nothing.
- **JWT lifetime: 1 hour.** A stolen access token has an hour, not a month.
- **Session absolute cap: 14 days**, anchored at creation. Renewal never moves it; past the cap the
  user authenticates again and gets a new session.
- **At most 20 open sessions per user.** Creating the 21st evicts the **oldest**, so the device in
  hand keeps working. Each eviction is audited `reason: "session-cap"`. Best-effort by design: a
  bound, not a guarantee.
- **Every JWT maps to a live session.** A token whose row is missing, revoked or expired is refused;
  so is a token with no `jti` at all. A new JWT never resurrects a revoked row.
- **Renewal** (`POST /api/auth/renew`): still-valid token, same `jti`, `expiresAt` untouched, client
  single-flight, at most one per 60 s, rate-limited per IP.
- **Expired JWT:** no special long-lived renewal path. The client performs the ordinary Firebase
  exchange again. There is **no custom backend refresh token** — Firebase already holds the identity
  session, and a second long-lived credential would be a second thing to steal.
- **Logout** revokes the session server-side first, then clears locally, then signs out of Firebase. A
  failed Firebase sign-out is retried later; Inventory access is already gone. Sign out everywhere is
  the same route with `{ "all": true }`.

---

## 5. Failure classification

| Class | Examples | Behaviour |
| --- | --- | --- |
| Terminal | Firebase credential revoked, invalid token, account disabled, session revoked/invalidated | sign out or re-authenticate |
| Recoverable | `SESSION_EXPIRED` (token expired, identity still valid) | one controlled renewal, then one exchange |
| Blocked | `BUSINESS_NOT_ACTIVE` | keep the identity, block the workspace |
| Transient | network failure, Firebase or backend outage, timeout, 5xx | **preserve the valid session**, retry later |

**A transient failure must never clear a valid token.** That is a security rule as much as a
correctness one: discarding a session on a network blip signs users out of a working app, and it
teaches them that the app is unreliable.

A malformed, forged or revoked token is **not** "expired" and must never be treated as ordinary
expiration.

### Reactive 401 handling

| Code | Action |
| --- | --- |
| `SESSION_EXPIRED` | recovery: renew, then exchange |
| `SESSION_REVOKED`, `SESSION_INVALIDATED`, `INVALID_TOKEN` | sign out |
| `ACCOUNT_DISABLED` | sign out or blocked state |
| `BUSINESS_NOT_ACTIVE` | keep identity, block workspace |
| `FIREBASE_UNAVAILABLE` | keep session, retry |

Recovery and renewal must not recursively trigger themselves, and only a result belonging to the
current authentication epoch may be applied.

### Concurrency

Logout during renewal must not be undone by a late response · concurrent renewals are single-flight ·
a JWT expiring mid-renewal allows exactly one fallback exchange · a Firebase revocation during
renewal is terminal · stale responses are discarded by epoch.

---

## 6. Password change and reset

Firebase owns the password for every account with a Firebase identity.

**Change** — recent authentication (signed `auth_time`, 300 s, fail-closed) → Firebase updates the
password → the current credential is presented to the backend and verified with revocation checking →
other sessions are revoked → a fresh session is issued. The user is not forced to sign in again:
physical-device testing disproved the theoretical need, so no `getIdToken(true)` and no
`revokeRefreshTokens()` was added for it.

**Reset** — six digits in the app, or the emailed link that returns through the server page. A
Firebase-native reset revokes nothing by itself, which is why the credential-change bridge exists: the
backend records the change and revokes sessions, and that revoke is what ends them. The reset marker
is an optimization and can never be the sole security mechanism.

**Neither flow may reveal whether an address exists.** Requests answer a uniform `202` from every
non-error path.

---

## 7. Linking, unlinking and provisioning

- **Linking** is `POST /api/auth/firebase/link` — authenticated, own account only, provider UID from
  the verified token, never from the body. It writes **only** `firebaseUid` and `emailVerified`. Four
  cases: same identity (idempotent, no write), this account already owns another (refused), the
  identity belongs to another user (refused and audited, never merged), unclaimed (attached). Email
  is compared in none of them.
- **Unlinking does not exist.** It was removed on 2026-10-02 and re-scoped into a password change, so
  no server path can clear a `firebaseUid`. Firebase-side provider unlinking is a client-SDK
  operation the server cannot observe; it is not a security boundary.
- **Provisioning** is by invitation, not by an administrator inventing a password. The invitation
  fixes the tenant and the role; the invitee establishes their own credentials and verifies their own
  address. Accepting requires a verified identity whose address equals the invited one, so the link is
  not a credential. `OWNER` is not invitable and an `ADMIN` cannot invite an `ADMIN`.
- **Facebook** identities without a usable email need an explicit completion flow. This is an open
  decision; inventing an address is not an option.
- **Apple Sign-In is not implemented.** It needs its own approved phase.

---

## 8. Tenant isolation

Authorization flows from trusted state, never from the request:

```text
JWT → session → authenticated User → server-derived businessId → scoped query
```

A client-supplied `businessId` is ignored. A resource belonging to another tenant is indistinguishable
from one that does not exist — a plain `404`. The checklist records the production-dead
`assertBusinessAccess` exception under I-19; real isolation is query scoping.

---

## 9. Rate limiting and error presentation

- **HTTP 429** with a stable application code and `Retry-After`.
- The server's retry timing is authoritative; the client renders it, never hardcodes it.
- Raw provider or backend errors never reach the user. They pass through an operation-aware mapper to
  a message that says what happened, what to do, and when to retry.
- Authentication operations show contextual progress ("Signing you in…"), block duplicate submits,
  and never render long messages in a fixed-height box.

---

## 10. Legacy retirement

Still to come, in this order — none of it is safe to shortcut:

1. Migrate admin-created password accounts to Firebase identities (invitations exist; the migration
   does not).
2. Retire legacy password recovery.
3. Remove the `passwordChangedAt` dependency from `requireAuth`, then its writes, then the field.
4. Remove `passwordHash`, bcrypt verification, `POST /api/auth/login` and `POST /api/auth/register`.
5. Retire duplicate MongoDB verification state.

Until step 1 completes, legacy login is a **migration path**, not a fallback: the client reaches it
only when Firebase reports that no identity answers those credentials — never when Firebase or the
backend failed, because treating an outage as "try the other door" lets anyone who can break Firebase
choose the weaker door.

---

## 11. Invariants

The invariant register is
[`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) §1: one row per invariant,
with where it is enforced. This document explains the design that makes those invariants hold; a new
or changed invariant is recorded in the checklist, not duplicated here.

---

## 12. Where the implementation stands

Control status, decisions and gates are in checklist §§3–6. This document does not keep a second
status table; the checklist is updated from evidence.
