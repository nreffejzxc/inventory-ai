# Platform Admin — architecture and implementation

**Status:** PLAT-1/PLAT-2/PLAT-3 IMPLEMENTED IN THE WORKING TREE (uncommitted, not deployed, not
publicly exposed). The separate platform identity realm, session boundary, capability catalogue,
dedicated console, mandatory TOTP/WebAuthn and append-only platform audit trail exist and are tested.
Support grants, tenant-detail reads and a hosted dedicated identity project remain future gates.

**Date:** 2026-11-16

**Audience:** the Inventory AI owner, support team and developers. This is **not** a feature for
business OWNER/ADMIN users and adds no tenant navigation, screen or permission.

---

## 1. Why this cannot be a tenant role

`OWNER` is the highest authority **inside one business**. It is not authority over the platform.
A platform operator needs to see service health and, in future, information belonging to a business
they do not own. Giving that power to `OWNER`, adding a fifth tenant role, or letting a tenant JWT
reach a support route would collapse the boundary every tenant authorization rule depends on:

- tenant isolation is enforced from the authenticated `businessId`;
- an `OWNER` is the person whose data is being protected;
- a platform operator who can mint or borrow a tenant session defeats audit attribution;
- a tenant role change must never grant cross-business reach.

The platform plane therefore has its **own identity table, credential, signing secret, issuer,
audience, session collection, MFA state, audit trail and capability catalogue**. The two systems
share no bearer credential.

The rejected first draft — a tenant-scoped `GET /api/operations` behind `operations.view` and a
mobile Operations screen — was removed before commit. It was the wrong audience and the wrong trust
boundary.

---

## 2. Identity realm

`PlatformAdmin` (`platform_admins`) is keyed by email and holds a local bcrypt credential.

- No `businessId`.
- No tenant `role` (`OWNER`/`ADMIN`/`MANAGER`/`STAFF`).
- No tenant `User` row is created, linked or modified.
- `status` is `ACTIVE` or `DISABLED`; a disabled row can never authenticate.
- `passwordChangedAt` invalidates tokens and MFA challenges minted before a credential change.
- MFA state: `mfaEnabled`, encrypted TOTP secret (select:false), `totpEnrolledAt`,
  `lastTotpCounter`, and an encrypted WebAuthn credential array.

This is a **dedicated platform identity realm** in the only sense this repository can provision and
test: a separate collection with no relationship to tenant authentication. An external dedicated
Firebase (or other hosted) identity project is a deployment decision and is **not** claimed to exist.
No tenant Firebase project is consulted by this plane.

A tenant password is invalid here, and a platform password is invalid on `/api/auth/login`. A tenant
token fails platform signature/issuer/audience verification; a platform token fails tenant
verification.

---

## 3. Tokens, sessions and MFA

### 3.1 Access tokens and sessions

| Property | Implemented value |
| --- | --- |
| Transport | `Authorization: Bearer`, or HttpOnly console cookie |
| Signing secret | `PLATFORM_ADMIN_JWT_SECRET` (must differ from `JWT_SECRET`) |
| Issuer | `inventory-ai-platform` (fixed constant) |
| Access audience | `platform-admin` (fixed constant) |
| Access-token lifetime | 15 minutes |
| Session idle timeout | 15 minutes since `lastUsedAt` |
| Session absolute cap | 8 hours, never extended by renewal |
| Renewal | `POST /api/platform/auth/renew` for the SAME `jti`; no new row |
| Revocation | per session (`logout`); disabling the admin refuses the next request |
| Storage | `platform_admin_sessions`, separate from tenant `sessions` |

`requirePlatformAdmin` verifies the token, reloads the `PlatformAdmin` row, checks status,
credential age and the live platform session, then attaches `req.platformAdmin` and
`req.platformAuth`. It never reads or writes `req.user`.

### 3.2 Mandatory MFA

A password check returns **only** a purpose-bound challenge:

- first login with no confirmed TOTP: `mfaEnrollmentRequired` + an enrollment token;
- later login: `mfaRequired` + a login token and the available methods (`totp`, optionally
  `webauthn`).

No access token, cookie or session row exists until a second factor succeeds.

| Property | Value |
| --- | --- |
| TOTP | RFC 6238, SHA-1, 6 digits, 30-second step, ±1 step clock window |
| Replay | atomic `lastTotpCounter` advance; the same code is refused |
| Secret at rest | AES-256-GCM (`v1.<iv>.<tag>.<ciphertext>`, base64url), HKDF-derived key |
| Encryption key | `PLATFORM_MFA_ENCRYPTION_KEY`, required when the platform plane is configured |
| Enrollment secret | shown once to the enrolling browser, never stored in a JWT |
| WebAuthn | registration only inside an authenticated session; user verification required; counter advanced; login challenge hash consumed once |
| Challenge tokens | separate audience `platform-admin-mfa`, explicit purpose, 5–10 minute lifetime |

Challenge tokens cannot authenticate `/api/platform/operations`: that middleware verifies the access
audience. A purpose-bound token for one step cannot be used for another. MFA endpoints are
rate-limited per IP; the TOTP window is small and the replay guard makes repeated submissions of an
accepted code fail.

A missing `PLATFORM_MFA_ENCRYPTION_KEY` fails closed with `503 PLATFORM_MFA_NOT_CONFIGURED` **before**
the password is checked, so a misconfigured deployment cannot become a credential oracle.

### 3.3 WebAuthn relying party

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLATFORM_WEBAUTHN_ORIGIN` | `PLATFORM_CONSOLE_ORIGIN` | Exact expected assertion/attestation origin |
| `PLATFORM_WEBAUTHN_RP_ID` | hostname of that origin | Relying-party ID |
| `PLATFORM_WEBAUTHN_RP_NAME` | `Inventory AI Platform` | User-visible RP name |

Registration and authentication use `@simplewebauthn/server` 13.3.3, `attestationType: 'none'`,
`userVerification: 'required'`. Stored public keys are encrypted with the same MFA key. A credential
can be registered only for the authenticated administrator; a malformed response is refused.

A login challenge is stored on the administrator row as a SHA-256 hash with its expiry (the row keeps
at most 10). Accepting an assertion is one atomic update that **pulls that challenge** and advances the
credential counter. A captured assertion therefore cannot open a second session, including on an
authenticator whose counter is always 0; the second request matches no challenge and is refused.

**Verification limit:** this repository's automated tests exercise options, authenticated access and
malformed-response refusal. A completed assertion requires a real browser and authenticator and is
**not** claimed as automated coverage.

---

## 4. Capabilities

`server/src/constants/platformRoles.ts` is a catalogue separate from `constants/roles.ts`.

| Capability | Purpose | READ_ONLY | SUPPORT | SECURITY | SUPERADMIN |
| --- | --- | :---: | :---: | :---: | :---: |
| `platform.health.read` | service/build/database posture | ✓ | ✓ | ✓ | ✓ |
| `platform.metrics.read` | cross-tenant operations report |  | ✓ | ✓ | ✓ |
| `platform.audit.read` | platform audit trail |  |  | ✓ | ✓ |
| `platform.admin.manage` | administrator management (not built) |  |  |  | ✓ |

Authorization is read from the `PlatformAdmin` row on **every** request, never from the token. A
demotion or disable therefore takes effect on the next call with the same token. A capability
refusal is written to the audit trail with the actor, missing capability and route.

---

## 5. API and console

Mounted separately at `/api/platform`; no tenant router imports it.

```text
POST /api/platform/auth/login                      public, rate-limited; password -> challenge
POST /api/platform/auth/mfa/enroll/start           public; enrollment challenge -> TOTP secret
POST /api/platform/auth/mfa/enroll/confirm         public; challenge + TOTP -> first session
POST /api/platform/auth/mfa/verify                 public; login challenge + TOTP -> session
POST /api/platform/auth/mfa/webauthn/options       public; login challenge -> assertion options
POST /api/platform/auth/mfa/webauthn/verify        public; assertion -> session
POST /api/platform/auth/webauthn/register/options  authenticated; registration options
POST /api/platform/auth/webauthn/register/verify   authenticated; store credential
POST /api/platform/auth/renew                      authenticated; new token, same session
POST /api/platform/auth/logout                     authenticated; end session
GET  /api/platform/auth/csrf                       authenticated cookie session; rotate CSRF
GET  /api/platform/auth/me                         authenticated; strict administrator DTO
GET  /api/platform/operations                      platform.metrics.read; ?days=1..30
GET  /api/platform/audit                           platform.audit.read; bounded, newest first
```

Every response carries `Cache-Control: no-store`, including 401/403/503 answers.

### 5.1 Console session

The console is a **separate static Express listener** in `server/platform-console/`:

```sh
cd server
npm run platform-console       # defaults to http://localhost:4100
```

It serves `index.html`, `styles.css`, `app.js` and a generated `config.js`; it does not connect to
MongoDB, proxy API calls or hold a credential. The browser calls the API directly with
`credentials: 'include'`.

| Property | Value |
| --- | --- |
| Session cookie | `platform_session`, HttpOnly, SameSite=Strict, Path `/api/platform`, Secure in production |
| CSRF cookie | `platform_csrf`, readable by the console, SameSite=Strict, Path `/` |
| CSRF header | `X-Platform-CSRF` must equal the cookie on every cookie-authenticated request |
| Origin | exact `PLATFORM_CONSOLE_ORIGIN` required for cookie auth; no Origin or another origin is refused |
| Token exposure | the console response omits the bearer token; API clients still receive it |
| CORS | exact configured origins only, with credentials; never `*` |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; connect-src <API>; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` |
| Other headers | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin |
| Storage | no `localStorage`, `sessionStorage` or JavaScript-readable access token |

`SameSite=Strict` is the second layer; Origin + double-submit CSRF is the primary one. The console's
`X-Platform-Console: 1` header identifies it for the cookie response shape; the server refuses that
header when the Origin is not the configured console origin.

When the console and API are different origins (for example `ops.example.com` and
`api.example.com`), the console's JavaScript cannot read the API host's readable CSRF cookie. After a
reload it calls `GET /api/platform/auth/csrf`, which requires the existing HttpOnly session and the
exact console Origin, rotates the CSRF value and returns it in the response. It is GET-only and
creates no session; every other cookie-auth request still requires the double-submit header. The two
origins must be **same-site** (the same registrable domain, or loopback) because the session cookie is
`SameSite=Strict`; a console on an unrelated domain would not receive the API cookie at all.

The console UI contains:

- sign-in, mandatory TOTP enrollment (manual key, one-time display) and MFA verification;
- WebAuthn verification as an alternative after a key is registered;
- the platform-wide operations report, recent issues, AI daily buckets and feature presence;
- the append-only audit trail (only when the role holds `platform.audit.read`);
- security status and security-key registration.

### 5.2 Data scope

`GET /api/platform/operations` returns **aggregates only**:

- `service` — build, environment, database state, uptime and the OPS-2 counters.
- `platform` — business counts by status, account counts, tenants active in the window.
- `ai` — turns, clean/degraded/failed, success rate, failover rate, p95, provider-cost provenance,
  daily buckets.
- `feedback` — all-time rating totals, the window's up/down counts and DOWN reasons.
- `usage` — distinct active members, feature presence, product/location/supplier/PO/ledger counts.
- `issues` — 5xx count, affected-tenant count, by-code and by-route groups, bounded recent rows.

There is **no `businessId` parameter**. The service signature has no tenant selector, so a routing
or query mistake cannot turn the report into a tenant-detail endpoint. The response contains no
business name, member name, email, user id, product row, feedback note, prompt or answer.

Individual AI ratings across tenants are **not** exposed by this endpoint. A platform feedback inbox
is future work and requires an explicit support-access decision because a rating row is tenant data.

---

## 6. Append-only audit trail

`PlatformAuditLog` (`platform_audit_events`) is a separate collection with no TTL and no
`businessId`/tenant `userId`.

Recorded actions:

- login failure, MFA challenge, MFA enrollment start/confirm/failure, MFA verification/failure;
- WebAuthn registration start/success/failure, WebAuthn login start/success/failure;
- capability denial (`ACCESS_DENIED`) with the missing capability and requested route;
- operations report read, audit trail read, session renewal, logout.

Each event carries the actor (when known), role, capability, outcome, reason, method, normalized-ish
route, request id, IP and truncated user agent. It never carries a password, hash, token, TOTP code,
WebAuthn assertion, request body, tenant id or tenant data. A failed login may carry the submitted
address for investigation; the password is never written.

**Append-only at the model layer.** Mongoose update/replace/delete hooks throw
`Platform audit events are append-only`, including `updateOne`, `updateMany`, `findOneAndUpdate`,
`findOneAndReplace`, `replaceOne`, `findOneAndDelete`, `deleteOne`, `deleteMany`, and saving a loaded
document. Retention is an operator decision; there is no automatic expiry.

**Read access.** `GET /api/platform/audit` requires `platform.audit.read`, held by SECURITY and
SUPERADMIN only. `?limit=1..100`, optional `before` ISO timestamp, `action` and `outcome` are
accepted; the read itself is recorded. SUPPORT and READ_ONLY are refused, and that refusal is
recorded.

The model guard is a **model-level** control, not a substitute for database permissions. An operator
with raw database access can still alter rows; production should grant the application a role that
cannot drop the collection and should export/retain it per the monitoring runbook.

---

## 7. Durable stores preserved

The platform report reads the stores added by OPS-8; their shape and retention are unchanged:

| Collection | One row | Retention | Tenant teardown |
| --- | --- | --- | --- |
| `ops_error_events` | one 5xx: status, code, method, normalized route, optional businessId | 90-day TTL | removed |
| `ops_feature_usage` | one member/feature/UTC day | 90-day TTL | removed |

The 5xx row still contains no message, stack, body, query, header, token or user id. The feature row
still contains no path, method, request id, resource id, IP or account name. Both writers remain
best-effort and fire-and-forget.

---

## 8. Code map

| Piece | File |
| --- | --- |
| Platform roles/capabilities | `server/src/constants/platformRoles.ts` |
| Platform JWT plane | `server/src/config/platformJwt.ts` |
| MFA/WebAuthn/console config | `server/src/config/platformSecurity.ts` |
| Administrator model | `server/src/models/platformAdmin.model.ts` |
| Session model | `server/src/models/platformAdminSession.model.ts` |
| Audit model | `server/src/models/platformAuditLog.model.ts` |
| Audit action catalogue | `server/src/constants/platformAudit.ts` |
| Credentials/login | `server/src/services/platformAuth.service.ts` |
| Session lifecycle | `server/src/services/platformSession.service.ts` |
| TOTP / vault | `server/src/services/platformMfa/totp.ts`, `secretVault.ts` |
| MFA flows | `server/src/services/platformMfa.service.ts` |
| WebAuthn | `server/src/services/platformWebAuthn.service.ts` |
| Audit writer/reader | `server/src/services/platformAudit.service.ts` |
| Cross-tenant report | `server/src/services/platformOperations.service.ts` |
| Auth middleware | `server/src/middlewares/platformAuthenticate.ts` |
| Capability gate | `server/src/middlewares/platformAuthorize.ts` |
| Routes | `server/src/routes/platform.routes.ts` |
| Controllers | `server/src/controllers/platformAuth.controller.ts`, `platformMfa.controller.ts`, `platformAudit.controller.ts`, `platformOperations.controller.ts` |
| Cookie helpers | `server/src/utils/platformCookies.ts` |
| Console | `server/platform-console/server.ts`, `public/` |
| Bootstrap | `server/scripts/create-platform-admin.mjs` |
| Tests | `server/test/OPS7-platform-operations.test.mjs`, `PLAT2-platform-console.test.mjs`, `PLAT3-platform-security.test.mjs` |

---

## 9. Security invariants

1. **A tenant token never authenticates a platform route.** Different secret, issuer, audience and
   session table. OWNER, ADMIN, MANAGER and STAFF receive `401 PLATFORM_INVALID_TOKEN`.
2. **A platform token never authenticates a tenant route.** `requireAuth` verifies the tenant secret
   and refuses it as `401 INVALID_TOKEN`.
3. **No tenant role or permission is consulted.** `requirePlatformCapability` reads the platform
   catalogue only.
4. **No tenant selector exists.** `businessId` in a query string is ignored, and the service has no
   parameter for it.
5. **Capabilities and status are re-read from the database per request.** A role change or disable
   applies immediately to an existing token.
6. **Password alone is not a login.** No session is created before TOTP/WebAuthn succeeds.
7. **TOTP is single-use and encrypted at rest.** A replayed counter is refused; no plaintext secret
   is stored.
8. **Cookie auth is Origin- and CSRF-bound.** Only the exact console origin with a matching header
   and cookie is accepted; Bearer clients remain exempt.
9. **The console never receives a bearer token.** It uses an HttpOnly cookie; the CSRF value is the
   only browser-readable secret, and it is not a credential by itself.
10. **The audit trail is append-only at the model layer.** Update/delete/save-existing throw.
11. **Only SECURITY and SUPERADMIN read audit events.** SUPPORT and READ_ONLY are refused and the
    refusal is recorded.
12. **The console has no tenant data path and no MongoDB connection.**
13. **The platform plane fails closed.** Without `PLATFORM_ADMIN_JWT_SECRET` the API answers
    `503 PLATFORM_AUTH_NOT_CONFIGURED`; without `PLATFORM_MFA_ENCRYPTION_KEY` login answers
    `503 PLATFORM_MFA_NOT_CONFIGURED`. There is no fallback to `JWT_SECRET`.
14. **Production configuration refuses weak/shared secrets.** Both platform secrets must be at least
    32 characters and must not equal each other or `JWT_SECRET`.
15. **No customer-facing surface remains.** The tenant route, permission, mobile tile, screen, stack
    entry, API helper and RBAC mirror entry are removed.

Test evidence:

- `OPS7-platform-operations.test.mjs` — denial matrix, both-direction token rejection, capability
  gating, fail-closed configuration, same-token demotion/disable, logout revocation, cross-tenant
  aggregation, ignored tenant selector, no-PII response, preserved durable writers, mandatory MFA.
- `PLAT2-platform-console.test.mjs` — strict CSP, no inline script/style/handlers, origin-only
  config, traversal refusal, RFC 6238 TOTP vectors, replay refusal, AES-GCM tamper rejection.
- `PLAT3-platform-security.test.mjs` — password-only returns no session, encrypted single-use TOTP,
  cookie flags, exact Origin + CSRF enforcement, Bearer exemption, audit writes, append-only model
  guards, SECURITY/SUPERADMIN read access, WebAuthn challenge boundaries.

---

## 10. Threat model (current implementation)

| Threat | Control | Residual risk |
| --- | --- | --- |
| Tenant OWNER/ADMIN tries to reach platform data | Separate secret/issuer/audience/session table; tenant tokens refused | A future routing mistake must fail closed; tests prove both directions |
| Platform token replayed to tenant API | Tenant middleware verifies the tenant secret and issuer/audience | Same routing-mistake risk, tested |
| Stolen platform password | Mandatory TOTP/WebAuthn before any session; rate-limited login; generic failure | Password + one factor; a stolen enrolled authenticator remains a risk |
| Stolen platform token | 15-minute expiry, 15-minute idle, 8-hour cap, per-session revocation | A live session can act until revoked |
| Stolen session cookie | HttpOnly, SameSite=Strict, exact Origin + CSRF header | Local malware/browser compromise is out of scope |
| CSRF from a foreign origin | Origin must equal `PLATFORM_CONSOLE_ORIGIN`; CSRF header must match cookie | Misconfigured origin is a deployment error; validation refuses malformed values |
| XSS in the console | Strict CSP, no inline scripts/styles, no third-party origins, no token in JS | A dependency in `app.js` is static and reviewed; no CDN |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | None |
| Disabled/demoted administrator keeps access | Role and status reloaded per request | None beyond database compromise |
| Insider reads cross-tenant data | Report is aggregate-only; audit read is SECURITY/SUPERADMIN | Aggregate counts can still reveal platform scale; tenant detail needs a future grant design |
| Insider alters audit history | Model-level immutable guards | Raw database access can still alter rows; database permissions/export are deployment controls |
| Platform secret reused with tenant secret | Production boot refuses equality; separate env vars | Operator must set distinct values |
| Replay of a TOTP code | Atomic counter advances on first use; later submissions fail | A code observed before first use is a race the counter closes only after use |
| Replay of a WebAuthn assertion | Challenge hash is consumed in the same atomic update as the counter; a second copy matches nothing | A challenge issued but never used expires from the stored set and the signed token expires |
| WebAuthn credential theft | User verification required; counter advanced; encrypted public key at rest | A stolen unlocked authenticator remains a risk |
| Audit gap | Every sensitive action writes `platform_audit_events`; login failures and denials included | A database outage cannot record the event; the request log remains |

---

## 11. Not implemented — remaining gates

1. **External dedicated identity project.** The platform realm is separate, but no external hosted
   Firebase/identity project is configured. A real project and its credentials are an owner/deploy
   action; until then this is a local platform credential realm.
2. **Support grants and tenant detail.** No `SupportGrant`, two-person approval, owner notification
   or tenant-detail read. The operations report is aggregate-only by design.
3. **Break-glass.** No emergency path; none should be added without a two-person procedure and
   alerting.
4. **Completed WebAuthn assertion in automation.** Requires a real browser/authenticator; options
   and rejection paths are tested, the success path is not automated.
5. **Production deployment.** The console, API changes and docs are uncommitted and undeployed by
   instruction. No public exposure has occurred.

Until gates 1–3 are closed, this plane is an internal/development capability, not a production
support console. The owner explicitly required no public deployment until the security requirements
are implemented and verified; implementation and local verification are complete, deployment is not.

---

## 12. Data model

```text
PlatformAdmin
  _id, email (unique), name, passwordHash (select:false), role,
  status (ACTIVE|DISABLED), passwordChangedAt, lastLoginAt,
  mfaEnabled, totpSecretEncrypted (select:false), totpEnrolledAt,
  lastTotpCounter, webauthnCredentials[] (select:false; credentialId,
  publicKeyEncrypted, counter, transports, label, createdAt, lastUsedAt),
  webauthnChallenges (select:false: challengeHash, expiresAt),
  createdAt, updatedAt
  -- no businessId, no tenant role

PlatformAdminSession
  _id, adminId, jti (unique), deviceLabel, lastUsedAt,
  revokedAt, expiresAt (8h), createdAt, updatedAt
  -- TTL on expiresAt

PlatformAuditLog
  _id, action (closed catalogue), outcome (SUCCESS|DENIED|FAILURE),
  actorAdminId, actorEmail, actorRole, capability, reason,
  method, route, requestId, ip, userAgent, metadata, createdAt
  -- append-only model guards; no TTL; no tenant scope
```

Future (not implemented): `SupportGrant`.

---

## 13. Rollout gates

**Gate A — local API foundation (done in the working tree).**
Separate realm, capabilities, sessions, cross-tenant aggregate, denial matrix and fail-closed
configuration are implemented and tested. Not committed or deployed.

**Gate B — production identity (partially closed).**
Mandatory TOTP and WebAuthn support are implemented. The external dedicated identity project is not
provisioned. Recovery codes and a documented disable/rotate procedure are still deployment work.

**Gate C — operator console (closed in the working tree).**
Dedicated origin, HttpOnly/Secure/SameSite session cookie, CSRF token, strict CSP, no third-party
script, no browser token storage, and a signed-out 401 on every API.

**Gate D — platform audit (closed in the working tree).**
Append-only trail for login, denial, report read, audit read, MFA/WebAuthn changes and logout, with
bounded read access for SECURITY/SUPERADMIN.

**Gate E — support detail (open).**
A time-bounded, reason-bound, two-person-approved grant before any tenant-detail or
member-identifying read, with owner notification and audit at issue and use.

No gate may be skipped because the console is “internal”.

---

## 14. Owner decisions still required

1. The external dedicated identity project and its credentials, if the current separate realm is to
   be linked to one.
2. Whether WebAuthn-only is acceptable later or TOTP must remain a fallback.
3. Platform audit retention and who holds SECURITY/SUPERADMIN at launch.
4. Whether the first console may see member names/emails at all, or only aggregate counts.
5. Whether a platform feedback inbox is approved, and under which support-access model.
6. The owner-notification channel for any future support grant.
7. When (if ever) to commit, deploy and expose the console; nothing has been published.
