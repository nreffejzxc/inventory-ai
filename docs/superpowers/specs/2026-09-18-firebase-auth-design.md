# Firebase Authentication — Architecture & Console Runbook

**Phase:** 32A
**Date:** 2026-09-18
**Status:** Design — awaiting owner review. **No implementation is authorised by this document.**
**Scope:** Documentation only. This phase changes no source code, no dependency, no configuration,
no environment variable, no database record, and no authentication behaviour.

> **Current status (2026-10-26).** These paragraphs are the design record, and the scope line above
> describes **Phase 32A** only. **Option B** (§5) is the shipped architecture: Firebase proves identity,
> Mongo `User` decides authorization, and a verified Firebase ID token is exchanged **once** for an
> ordinary Inventory AI JWT. Where sections disagree, the **latest dated note wins** — each one is
> appended in place rather than overwritten, so the delta stays visible.
>
> **What is current, and what shipped since this was written:**
>
> | Feature | State |
> | --- | --- |
> | Email/password via native SDK (M1) | **Shipped** (§21, §14A.9, §12 note) |
> | Google Sign-In (native) | **Shipped, device-verified 2026-10-24** (roadmap §27EY) |
> | Six-digit email verification | **Shipped** as a custom code flow, AUTH-04 (§27Y) — not Firebase's link |
> | Password reset by six-digit code | **Shipped** AUTH-06 (§27DY) |
> | Invitations / joining a business | **Shipped 2026-10-25** (§27FB–§27FD) |
> | Server-side account **linking** route | **Implemented** (§14B) but **no mobile surface** — unreachable from the app |
> | Account **unlinking** | **Removed** (Phase A / F-1, §27AA). §14B's unlink plans and the 32L records are void |
> | Facebook Login, Apple Sign-In | **Not implemented**; each needs an owner-approved phase |
> | Legacy password login (pre-Firebase accounts) | **Still live**; cannot be retired until those accounts migrate |
> | §14C Firebase-only architecture | **Locked design, NOT implemented** — no `REMOVE` item has been done |
>
> The **only** architecture narrative that describes the code as it runs today is
> [`docs/AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](../../AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md);
> the live guarantee list is [`docs/AUTH_SECURITY_MASTER_CHECKLIST.md`](../../AUTH_SECURITY_MASTER_CHECKLIST.md).
> §2 below is the **pre-Firebase baseline** and §2.6 is the route inventory a guard reads — keep it
> exact. Treat §§3–13 as the design that was approved, not as a description of the current tree.

---

# 1. Purpose

This document specifies how Firebase Authentication will be introduced into Inventory AI as an
**external identity provider**, while the existing MongoDB `User` + JWT + `Session` system remains the
application's authentication and session layer.

It exists because Phase 32 is the first phase to touch authentication since Phase 03, and the
authentication stack has since acquired properties that are easy to destroy by accident: real
server-side session revocation (Phase 26A), a cross-layer RBAC contract pinned in both directions
(Phases 22–24), and a password-recovery path with its own mail layer and token store (Phases 26B/27).
The purpose of writing the design down first is to make explicit **which of those properties are
preserved, which are adapted, and which are at risk** before a single line of code is written.

The owner has selected **Option B** (§5). This document records that decision and its consequences.
It does not reopen it.

---

# 2. Current authentication architecture (as implemented)

Everything in this section describes code that exists today and was read directly from the
repository while writing this document. Nothing here is aspirational.

> **Updated by Phase 32F (2026-09-20).** This section is the **pre-Firebase** baseline as Phase 32A
> recorded it. Phases 32B–32E have since changed two things it states, marked inline below: the three
> additive `users` fields, and `passwordHash` becoming optional. The superseded wording is kept beside
> the correction rather than overwritten, so the delta stays visible.

## 2.1 Identity — MongoDB `users` collection

`server/src/models/user.model.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| `businessId` | ObjectId → `Business` | **required**, indexed. The tenant key. |
| `name` | String | **required**, trimmed |
| `email` | String | **required**, `unique`, lowercased, trimmed, regex-validated. A single global person identity — login is platform-wide, not per-business. |
| `passwordHash` | String | **`required: false`** (Phase 32B — was `required`), `select: false` — never returned by default |
| `firebaseUid` | String | **added by Phase 32B.** `unique`, **`sparse: true`**. At most one account per Firebase identity; any number may have none. Sparse is mandatory — the index cannot be built once two accounts lack the field. |
| `emailVerified` | Boolean | **added by Phase 32B.** `default: false`, persisted from the verified Firebase token claim and **not enforced** — no authorization decision reads it. |
| `role` | String | enum `OWNER` \| `ADMIN` \| `MANAGER` \| `STAFF`, default `STAFF` |
| `status` | String | enum `ACTIVE` \| `DISABLED`, default `ACTIVE` |
| `passwordChangedAt` | Date | default `null`; the Phase 15 token-invalidation anchor |

Indexes: `{businessId, role}`, `{businessId, status}`, `{businessId, createdAt: -1, _id: -1}`,
plus the unique index on `email` and the **sparse unique index on `firebaseUid`**.

Credentials are bcrypt via `bcryptjs` at `BCRYPT_ROUNDS = 10`
(`server/src/services/auth.service.ts`). The hash is produced in exactly two places:
`registerBusinessOwner()` and the admin-side create in `server/src/services/users.service.ts`. An
account created through Firebase receives **no hash at all** — the API accepts no password on that
path — which is why `required` had to become `false` in Phase 32B.

## 2.2 Session — MongoDB `sessions` collection

`server/src/models/session.model.ts`. Added by Phase 26A.

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId → `User` | required — scopes the row to its owner |
| `jti` | String | required, **unique** — the token's `jti` claim |
| `deviceLabel` | String | cosmetic only; normalized and capped, never used in a decision |
| `lastUsedAt` | Date | default `null`; "opened but not used yet" |
| `revokedAt` | Date | default `null`. **Not a hard delete** — a revoked row is kept so it cannot be silently re-created |
| `expiresAt` | Date | required; mirrors the token's own `exp` |

Indexes: `{userId, revokedAt}` for the liveness/list query, and a TTL index on `{expiresAt}` with
`expireAfterSeconds: 0`. The TTL sweep is eventual (~60s), so the liveness query filters on
`expiresAt` itself and never depends on the sweep having run.

**The row carries no authorization data — no role, no `businessId`.** That is deliberate: role and
tenant context are reloaded from the `User` on every request, so a stale session row can never widen
what its owner may do.

## 2.3 Token — HS256 JWT

`server/src/config/jwt.ts`.

```ts
export type AccessTokenClaims = { sub?: string; jti?: string; iat?: number; exp?: number };
export function signAccessToken(userId: unknown, jti: string): string
export function verifyAccessToken(token: string): AccessTokenClaims
export function decodeAccessToken(token: string): AccessTokenClaims | null
```

- `sub` = the MongoDB `User._id`.
- `jti` = the id of the `sessions` row the token names. **Mandatory, and a required argument rather
  than a default** — a caller that forgets it fails loudly at mint time instead of silently producing
  an unrevocable token.
- **Role and business are never claims.** The token is deliberately narrower than jsonwebtoken's own
  `JwtPayload` (which carries an `[key: string]: any` index signature under which a typo like
  `payload.jit` type-checks as `any`).
- Algorithm pinned to `HS256` on both sign and verify.
- Lifetime from `JWT_EXPIRES_IN` (default `7d`).

## 2.4 The authentication choke point

`server/src/middlewares/authenticate.ts` — `requireAuth`. Every protected request traverses these
checks **in this order**:

| # | Check | Failure |
| --- | --- | --- |
| 1 | `Bearer` scheme and a token are present | 401 `AUTH_REQUIRED` |
| 2 | `verifyAccessToken` (HS256 pinned) | 401 `INVALID_TOKEN` |
| 3 | `sub` is a valid ObjectId | 401 `INVALID_TOKEN` |
| 4 | `jti` is a non-empty string — **every pre-26A token dies here** | 401 `INVALID_TOKEN` |
| 5 | `User.findById(...).select('name email role status businessId passwordChangedAt')` | 401 `AUTH_REQUIRED` |
| 6 | `status === 'ACTIVE'` | 403 `ACCOUNT_DISABLED` |
| 7 | `iat >= floor(passwordChangedAt / 1000)` (strict `<` rejects) | 401 `SESSION_INVALIDATED` |
| 8 | `findActiveSessionByJti(jti)` exists **and** `session.userId === user._id` | 401 `SESSION_REVOKED` |
| 9 | `assertActiveBusiness(user.businessId)` | 403 — business missing / `SUSPENDED` / `ARCHIVED` |
| 10 | `touchSession(session)` — best-effort, after every rejection point | — |

It then attaches:

```ts
req.user = { id, businessId, name, email, role, status }   // businessId + role ALWAYS from the DB
req.auth = { sessionId, jti }                              // separate, so the public user DTO is unchanged
```

`passwordHash` is never loaded here.

## 2.5 Authorization

`server/src/middlewares/authorize.ts` exports `requirePermission(permission)` and
`requireRole(...roles)`, both reading only `req.user.role` and both running **after** `requireAuth`.

`server/src/constants/roles.ts` holds the catalogue: 4 roles (`OWNER`, `ADMIN`, `MANAGER`, `STAFF`),
**21 permission keys**, the `ROLE_PERMISSIONS` matrix, `hasPermission(role, permission)`, and
`CATALOGUE_ONLY_PERMISSIONS` = `business.manage`, `roles.manage`, `transactions.view` (granted to
roles but implemented by no endpoint — metadata for the regression guard only, never imported by
`authorize.ts`).

`mobile/lib/permissions.ts` re-declares the whole catalogue and matrix, and Phase 23 pins the mirror
to the server copy in lock-step, comparing roles, all 21 keys **and values**, and every role's grant
set.

## 2.6 Route inventory

Phase 23 classifies **86 routes**: **51 permission-gated**, **14 authenticated**, **21 public**, **0 role-gated**. The `PUBLIC` and `AUTHENTICATED` buckets are explicit lists that each carry a
written reason; a route in no bucket fails the guard, and a declared exemption that has stopped being
true also fails. The guard deliberately asserts **no route count** — a route is *declared* or it is not,
and the number is derived from the declarations — so the figure above is pinned separately, by
`server/test/phase-docs-route-inventory.test.mjs`, which reads this section and the router sources and
fails if the two disagree.

> **Updated by Phase 32F (2026-09-20).** Phase 32A recorded this as "60 routes: 47 gated, 7
> authenticated, 6 public". Phase 26A added three authenticated routes, Phase 26B-3 added two public
> ones and **Phase 32C added the two Firebase public routes below** — 47 + 10 + 10 = 67, the total as
> of Phase 32F. The gated tier is unchanged at 47 throughout, which is the property that matters: no
> provider work has added or moved a permission-gated route.
>
> **Phase 32H added one authenticated route, `POST /api/auth/firebase/link`** (§14B.1) —
> 47 + 11 + 10 = **68**, the total as of Phase 32H (not current — see the 2026-10-12 correction below). *(Corrected 2026-09-22, documentation only, no behaviour
> change: the 67 figure was correct through Phase 32C and was not updated when Phase 32H added the
> authenticated link route.)*
>
> **Corrected 2026-10-12 — this inventory was four routes stale.** AUTH-03 (`POST /api/auth/renew`),
> AUTH-04 (`POST /api/auth/email-verification/request` and `/confirm`) and the N-4 credential-change
> bridge (`POST /api/auth/credentials-changed`) all shipped **after** the last edit above, so this
> section said **68** where the mounted set is **72**: **47 permission-gated**, **13 authenticated**,
> **12 public**, **0 role-gated**. The figure is now measured from the route declarations in
> `server/src/routes/*.ts` and the app-level registrations in `server/src/app.ts` by
> `server/test/phase-docs-route-inventory.test.mjs`, which fails if this section and the code disagree. The **gated** tier is still **47** — the property the note above cares about —
> so no provider, session or recovery work has added or moved a permission-gated route.
>
> **AUTH-05 (2026-10-20) added one public route, `GET /auth/reset`** — 47 + 13 + 13 = **73**. It is the
> landing page Firebase's password-reset email points at, mounted outside `/api` because it is an HTML
> page read by a phone's browser rather than a JSON endpoint (see `server/src/pages/resetPasswordLink.ts`).
> It is public for the reason recovery is public: the person using it has no usable password. It
> authorizes nothing — it forwards a one-time code to the app, which redeems it with Firebase. The
> **gated** tier is still **47**.
>
> **AUTH-06 (2026-10-20) added two public routes, `POST /api/auth/password-reset/code` and
> `POST /api/auth/password-reset/confirm`** — 47 + 13 + 15 = **75**. They are the in-app six-digit
> code flow that replaces Firebase's browser reset as the primary journey, because the project's
> email-template editor refused every write (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`), so a reset email
> whose destination we choose could not be configured at all. Both are public for the reason
> recovery is public, and **neither creates a session**: a completed reset ends every existing one
> and asks the person to sign in with the password they just chose. The **gated** tier is still
> **47** — no permission-gated route has been added or moved by any of this work.

> **AUTH-06 two-step recovery (2026-10-22) added one public route,
> `POST /api/auth/password-reset/verify`** — 47 + 13 + 16 = **76**. The flow now proves the emailed
> code on one screen and takes the new password on the next, so "the code was checked" has to
> survive the navigation. It does so as a short-lived, single-use **reset authorization** minted by
> `/verify` and spent by `/confirm`; `/confirm` reads no code and no address, so the second screen
> cannot be navigated into. The route is public for the same reason the other two are, issues no
> session, and shares the confirm limiter with `/confirm` so both steps draw on one per-IP budget.
> The **gated** tier is still **47**.
>
> **Account deletion (2026-10-24) added one authenticated route, `DELETE /api/auth/me`, and one
> public page, `GET /account-deletion`** — 47 + 14 + 18 = **79**. The page is the web address
> Google Play's data-deletion policy requires, so it is public by requirement: somebody who cannot
> sign in has to be able to read how to delete the account. It reads no request data and performs
> no I/O. It deletes the CALLER'S OWN account (`req.user.id`, never an id from the
> request), refuses unless the account is re-authenticated and is not a business's last active
> owner, and answers `{ deleted: true }`. It names no permission for the same reason
> `POST /api/auth/logout` does not: the subject is the caller's own account, and a capability that
> governed "what you may do to others" would be the wrong instrument for it. The **gated** tier was
> still **47** at that point.
>
> **Terms of Use (2026-10-25) added one public page, `GET /terms`** — 47 + 14 + 19 = **80**. It is
> the second half of the same store requirement the privacy policy answers: the listing and the app
> point at a policy describing data handling, and at terms describing what the service asks of the
> person and what they may expect of it. Mounted outside `/api` and public for the same reason as
> `/privacy` and `/account-deletion` — an HTML page read in a browser, readable before an account
> exists. Like those two it reads no request data, performs no I/O and has no branch that can fail,
> and it is linked from both of them so the three pages cannot describe three different products.
> The **gated** tier was still **47** at that point.
>
> **Invitation-based onboarding (2026-10-25) added three permission-gated routes and two public ones —
> 80 + 3 gated + 2 public = **85** (50 permission-gated, 14 authenticated, 21 public, 0 role-gated).**
> `GET` and `POST /api/invitations` and `DELETE /api/invitations/:id` are bound to `users.manage`, the
> permission that already governs membership: an invitation adds a member, and a separate key would
> create a role that may invite yet not manage. **This is the first change to the gated tier since the
> Phase 23 contract was written** (47 → 50); the other four auth, recovery and legal-page increments
> left it untouched. The two public ones are `GET /api/auth/invitation?token=…` (what an invitation
> offers, read before any account exists) and `GET /invite` (the page an invitation email's button
> opens, which forwards the token to the app's own scheme and redeems nothing). The token is a QUERY
> parameter, never a path segment, so it cannot reach the access log, which records the path only.
> None of the five designs an authorization input: the tenant and role come from the invitation row,
> the inviter from `req.user`, and the invitee from a VERIFIED Firebase identity whose address must
> equal the invited one.
>
> **AI-102 (2026-11-10) added one permission-gated route — 85 + 1 gated = **86** (51
> permission-gated, 14 authenticated, 21 public, 0 role-gated).** `GET /api/ai/metrics` binds the new
> `ai.metrics.view` capability, granted only to OWNER and ADMIN. It is the first addition after the
> invitation increment and is counted by the same route-inventory guard.

The auth surface (`server/src/routes/auth.routes.ts`):

| Method | Path | Chain |
| --- | --- | --- |
| POST | `/api/auth/register` | register limiter → controller |
| POST | `/api/auth/login` | account limiter → IP limiter → controller |
| POST | `/api/auth/forgot-password` | account limiter → IP limiter → controller |
| POST | `/api/auth/reset-password` | confirm limiter → controller |
| POST | `/api/auth/password-reset/code` | account limiter → IP limiter → controller |
| POST | `/api/auth/password-reset/verify` | confirm limiter → controller (AUTH-06 step one; mints the reset authorization) |
| POST | `/api/auth/password-reset/confirm` | confirm limiter → controller (AUTH-06 step two; spends the authorization, reads no code) |
| POST | `/api/auth/firebase/exchange` | firebase exchange limiter → controller |
| POST | `/api/auth/firebase/register` | firebase register limiter → controller |
| GET | `/api/auth/me` | `requireAuth` |
| PATCH | `/api/auth/me` | `requireAuth` |
| DELETE | `/api/auth/me` | `requireAuth` → account-deletion limiter → controller |
| POST | `/api/auth/change-password` | `requireAuth` |
| POST | `/api/auth/logout` | `requireAuth` (sign-out-everywhere is this route with `{all:true}`) |
| GET | `/api/auth/sessions` | `requireAuth` |
| DELETE | `/api/auth/sessions/:id` | `requireAuth` |
| POST | `/api/auth/firebase/link` | `requireAuth` (Phase 32H) |
| POST | `/api/auth/email-verification/request` | email-verification request limiter → controller (**pre-session**, Firebase-authenticated; AUTH-04-C) |
| POST | `/api/auth/email-verification/confirm` | email-verification confirm limiter → controller (**pre-session**, Firebase-authenticated; AUTH-04-C) |
| POST | `/api/auth/renew` | `requireAuth` → session-renew limiter → controller (AUTH-03) |
| POST | `/api/auth/credentials-changed` | `requireAuth` (the N-4 credential-change bridge) |

Both Firebase routes are **public** and declared with their reasons in the Phase 23 guard: a caller
exchanging an ID token holds no Inventory AI JWT by definition, which is what the exchange exists to
remedy, and registration assigns `businessId` and `role` server-side. **Neither takes a provider
identity from the request body** — the UID comes from the verified token (§14A, R-2).

Rate limiting lives in `server/src/middlewares/rateLimit.ts`. The two **login** limiters are the only
ones carrying `skipSuccessfulRequests: true`. The three recovery limiters deliberately **omit** it,
because the success path and the silent no-op are both a 202 — skipping 2xx would disable the limiter
entirely. Both facts are guarded by tests. All limiter stores are **in-memory and per-process**
(a known, accepted limitation recorded as E3).

## 2.7 Mobile session layer

`mobile/lib/auth.tsx` — `AuthProvider` / `useSession()`, exposing
`{ user, token, status, signIn, signUp, signOut, signOutEverywhere, refresh, clearSession }`.

- The **JWT is the only thing persisted**, in `expo-secure-store` under
  `TOKEN_KEY = 'inventoryai.auth.token'`.
- The user object is **always re-fetched** from `GET /api/auth/me` on boot — never restored from a
  cache — so role/status/businessId reflect the server.
- `lib/client.ts` attaches `Authorization: Bearer <token>` and, on a 401/403 from a request that
  **carried** a token, invokes a single `sessionLostHandler` registered by `AuthProvider`. That one
  place decides what a refused token means; no screen re-derives it.
- `(app)/_layout.tsx` renders nothing while `status === 'loading'`, then `<Redirect href="/login" />`
  unless `signedIn`.
- Route files are **TypeScript** (`.tsx`/`.ts`), `tsconfig.json` present, `npm run typecheck` =
  `tsc --noEmit`. *(CLAUDE.md §2 still records "JavaScript" — stale.)*

## 2.8 Password recovery (Phases 26B / 27)

Provider-agnostic mail boundary at `server/src/services/mail/` reached through `isMailConfigured()`,
`mailProviderName()` and `sendPasswordResetEmail({to, resetUrl, expiresInMinutes})`. The transport is
selected by `MAIL_PROVIDER`; **Brevo is the only built-in transport, the one configured in development
and production** (the Resend transport was removed on 2026-10-20). A `password_reset_tokens` collection stores `userId`, `tokenHash`,
`expiresAt`, `usedAt` and nothing else — the raw 32-byte token is emailed and **never persisted**.
Single use is one conditional `findOneAndUpdate`; `usedAt` is never unset (fail-closed). Two public
routes, `MAIL_NOT_CONFIGURED` as a **pre-lookup** 503, a uniform 202 on every non-error path, and
Phase 28's detached (unawaited) send. Mobile has `/forgot-password` and `/reset-password` screens and
the custom scheme `inventoryai://reset-password`.

## 2.9 Mobile build configuration (Phase 30A)

- Expo SDK `~57.0.23`, React Native `0.86.3`, React `19.2.3`, `expo-dev-client ~57.0.19`.
- `app.json`: `scheme: "inventoryai"`, `ios.bundleIdentifier` and `android.package` both
  `com.inventoryai.app`, plugins `expo-router`, `expo-secure-store`, `expo-camera`. **No
  `googleServicesFile` anywhere.**
- `eas.json`: profiles `development` (dev client, internal, APK), `ios-simulator`, `preview`,
  `production`; `cli.appVersionSource: "remote"`; **no `channel` key**; `expo-updates` deliberately
  not installed.
- EAS project `@jeffernqwes-team/inventory-ai`, id `607eca05-1175-43ed-86a0-1829e91c9531`.
- **No EAS build, submit or prebuild has ever been executed.** The Phase 30A foundation is statically
  validated only.

---

# 3. Proposed Firebase architecture

Firebase Authentication becomes the **external identity provider**. Inventory AI's existing JWT +
`Session` remains the **application session**. The Firebase ID token is used exactly once, to obtain
an application session, and never becomes the API credential.

## 3.1 Data-flow diagram

```text
  ┌──────────────────────────────────────────────────────────────┐
  │  Expo app (mobile)                                           │
  │                                                              │
  │   login.tsx / register.tsx / Google button                   │
  │        │                                                     │
  │        ├─ email + password ──► Firebase SDK sign-in          │
  │        └─ Google account   ──► Firebase SDK sign-in          │
  └────────┬─────────────────────────────────────────────────────┘
           │
           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Firebase Authentication  (external, Google-operated)        │
  │   owns: password storage, password verification,             │
  │         email verification state, Google federation,         │
  │         the token-signing keys                               │
  └────────┬─────────────────────────────────────────────────────┘
           │  Firebase ID token  (JWT signed by Google, ~1h)
           │  ── short-lived ── used ONCE ── never an API credential
           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  POST /api/auth/firebase/exchange   { idToken, deviceLabel }  │
  │  PUBLIC route — no requireAuth (the caller has no session yet)│
  │                                                              │
  │   1. rate limiter                                            │
  │   2. firebase-admin  verifyIdToken(idToken)                  │
  │        → signature, exp, issuer, audience(projectId)         │
  │        → { uid, email, email_verified, sign_in_provider }    │
  │   3. User.findOne({ firebaseUid: uid })                      │
  │        └─ null → 200 REGISTRATION_REQUIRED  (not a 404)      │
  │   4. user.status === 'ACTIVE'   else 403 ACCOUNT_DISABLED    │
  │   5. assertActiveBusiness(user.businessId)                   │
  │   6. newSessionId() → signAccessToken(user._id, jti)         │
  │      createSessionForToken(...)        ← Phase 26A, unchanged│
  │   7. → { token, user: toPublicUser(user) }                   │
  └────────┬─────────────────────────────────────────────────────┘
           │  Inventory AI access token  (HS256, 7d, ours)
           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Mobile stores it in SecureStore under the SAME key          │
  │  'inventoryai.auth.token'  — no mobile storage change        │
  └────────┬─────────────────────────────────────────────────────┘
           │  Authorization: Bearer <app JWT>
           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  requireAuth  →  requirePermission  →  controller            │
  │  server/src/middlewares/authenticate.ts                      │
  │  ── ZERO LINES CHANGED BY PHASE 32 ──                        │
  └────────┬─────────────────────────────────────────────────────┘
           │
           ├──► MongoDB   (businessId from the User record, never the client)
           └──► AI service → controlled tools → MongoDB
```

## 3.2 What Firebase owns, and what it does not

| Concern | Owner after Phase 32 |
| --- | --- |
| Password storage and verification | **Firebase** (for Firebase-native accounts; legacy hash retained during migration) |
| Email + password sign-in | **Firebase** |
| Google federation | **Firebase** |
| Email verification *state* | **Firebase** |
| ID token signing / refresh | **Firebase** |
| **Application** session issuance | **Inventory AI** |
| **Session revocation** (per-device and all-device) | **Inventory AI** |
| **Role, permission, RBAC** | **Inventory AI** — nothing migrates to Firebase |
| **Tenant (`businessId`) isolation** | **Inventory AI** |
| Business lifecycle (`ACTIVE`/`SUSPENDED`/`ARCHIVED`) | **Inventory AI** |
| Audit trail | **Inventory AI** |
| Business/user records | **MongoDB** — Firebase is not the application datastore |

**Firestore is not introduced.** Firebase is used for identity only.

---

# 4. Non-negotiable invariants

These hold for every phase of 32 and are the acceptance criteria for the design.

1. **The Firebase ID token is never an API credential.** It is accepted at exactly one route, which
   exchanges it. No other route, middleware or service may verify or trust it.
2. **`requireAuth` is unchanged.** Check order, error codes (`AUTH_REQUIRED`, `INVALID_TOKEN`,
   `ACCOUNT_DISABLED`, `SESSION_INVALIDATED`, `SESSION_REVOKED`) and the `req.user` / `req.auth`
   shapes stay byte-identical. Phases 23 and 24 pin all three.
3. **`businessId` comes from the MongoDB `User` record.** Never from a request body, query parameter,
   header, or token claim.
4. **`firebaseUid` is read only from `verifyIdToken`'s verified payload.** A `firebaseUid` in a
   request body is ignored — and a test must prove it is ignored (§15).
5. **`role` and `permission` are never accepted from the client and never stored in Firebase.**
6. **Nothing about RBAC changes.** 4 roles, 21 permission keys and their exact values,
   `ROLE_PERMISSIONS`, `CATALOGUE_ONLY_PERMISSIONS`, and the mobile mirror all stay as they are.
7. **No password, hash, ID token or service-account credential is ever logged or returned.**
8. **The legacy password path is not removed or weakened** (§10).
9. **`assertActiveBusiness` still runs on every authenticated request.**
10. **Every pre-existing protected route keeps working, unchanged.**

---

# 5. Option B rationale

Three architectures were evaluated against this codebase specifically.

## Option A — Firebase completely replaces the current mechanism

Delete `sessions`, `session.service.ts`, `jwt.ts` and all of Phase 26A; the mobile client sends the
Firebase ID token as the `Bearer` credential and `requireAuth` verifies it with the Admin SDK.

**Rejected.** It removes per-device revocation, sign-out-everywhere, the Active Sessions screen and
`SESSION_INVALIDATED`; revocation degrades to either `verifyIdToken(token, true)` — a network
round-trip to Google **on every request** — or up to an hour of unchecked staleness. It still requires
the MongoDB lookup for role and `businessId`, so it is *more* work per request, not less. It breaks
the Phase 03/14A/26A/26B suites wholesale, since they mint and assert application JWTs. Net effect: a
**security downgrade** traded for less code.

## Option C — Firebase ID tokens used directly for API authentication

As A, but retaining the MongoDB user mapping. Identical revocation weakness. Firebase ID tokens live
~1h, so the client must call `getIdToken()` before requests and the expired-token path becomes
load-bearing on every screen. It still discards the session layer, for no compensating gain.

## Option B — Firebase is the identity provider; the existing JWT + Session is the application session ✅

**Selected.**

Why it is correct *for this repository*:

- **It preserves the strongest security asset in the codebase.** Phase 26A's session layer provides
  immediate, per-device, server-enforced revocation — a granularity Firebase does not offer. A and C
  trade it away; B keeps it and gains federated identity on top.
- **The blast radius is one new public route and one new service.** `requireAuth` changes by zero
  lines. All 47 permission-gated routes, all 4 roles, all 21 permission keys, the `businessId`
  derivation, the Phase 23 route classification and every RBAC / tenant-isolation test are untouched.
- **Authorization stays database-derived and per-request** — the Phase 03/24 property that a stale
  credential can never widen what its holder may do.
- **Failure isolation is favourable.** If Firebase is unreachable, new sign-ins fail but every
  outstanding application JWT keeps working: users already signed in stay productive.
- **No role/permission knowledge enters Firebase**, satisfying the requirement not to duplicate the
  business/role/permission system.

**Accepted trade-offs, stated plainly:**

- Two credentials exist on the device — Firebase's refresh token (in Firebase's own storage) and our
  application JWT (in SecureStore). **Logout must clear both**, or a surviving Firebase session
  silently re-exchanges.
- An application JWT (7d) outlives the Firebase ID token (~1h). That is safe because authorization is
  re-derived per request and revocation is ours — but it means a *deleted Firebase account* does not
  take effect until the application JWT expires or is revoked.
- Firebase becomes a dependency of the **login path** (not of request serving).

---

# 6. Security boundaries

```text
  UNTRUSTED                         │  TRUST BOUNDARY            │  TRUSTED
  ──────────────────────────────────┼────────────────────────────┼──────────────────────────
  Firebase ID token (from client)   │  verifyIdToken()           │  { uid, email, … }
  deviceLabel (from client)         │  normalizeDeviceLabel()    │  cosmetic label only
  ──────────────────────────────────┼────────────────────────────┼──────────────────────────
  businessId in any request         │  ── ignored entirely ──    │  User.businessId
  role / permission in any request  │  ── ignored entirely ──    │  User.role
  firebaseUid in a request body     │  ── ignored entirely ──    │  verified token payload
  ──────────────────────────────────┼────────────────────────────┼──────────────────────────
  Firebase Admin credentials        │  ── server process only ── │  never in the app bundle
```

**The exchange route is the only place a Firebase identity enters the system.** It is the single
point at which an external, Google-signed assertion becomes an Inventory AI session, and it is
therefore the only place that needs Firebase-specific security reasoning.

**Why the exchange is not a token-minting oracle.** It mints a session only for a `uid` that
`verifyIdToken` has cryptographically attested *and* that resolves to an existing, `ACTIVE` MongoDB
user in an `ACTIVE` business. An attacker who cannot produce a valid Google-signed ID token gets
nothing; an attacker who can produce one gets exactly the account that token names — which is the
definition of correct federated authentication.

**What deliberately does not happen server-side.** The server never sees or stores a password for
Firebase-native accounts, never calls Firebase on the request path of a normal API call, and never
consults Firebase to authorize a request. Authorization remains a local, database-derived decision.

---

# 7. Firebase ↔ MongoDB identity mapping

## 7.1 Mapping rule

`firebaseUid` is the join key between a Firebase identity and a MongoDB `User`. It is written **once**,
at first association, from the verified `uid` in the ID token, and is thereafter immutable through
normal application flows.

```
Firebase uid  ──1:1──►  users.firebaseUid  ──►  users.businessId, users.role, users.status
   │                                                    │
   └── owns: password, email verification,              └── owns: RBAC, tenant, lifecycle
       Google federation, token signing
```

`email` is also unique on both sides, but it is **not** the join key: it is mutable on the Firebase
side and it is the field involved in credential-collision handling (§16.2). The `uid` is stable and
provider-independent, which is what makes Google, email/password and any future provider converge on
one MongoDB record.

## 7.2 Schema changes

Minimum necessary — three fields on `users`, and nothing else.

```ts
// server/src/models/user.model.ts
firebaseUid:   { type: String, unique: true, sparse: true, index: true },  // NEW
emailVerified: { type: Boolean, default: false },                          // NEW
passwordHash:  { required: false, select: false },                         // CHANGED: still select:false
```

**`sparse: true` is mandatory, not decorative.** A plain `unique` index treats a missing value as
`null`, so the *second* legacy user without a `firebaseUid` would collide with the first. This is the
single easiest way to break the migration, and it fails as a duplicate-key error at insert time on a
record that has nothing to do with Firebase.

**`emailVerified` is persisted because `requireAuth` never sees an ID token.** The application JWT is
the session credential, so any Firebase claim that must be enforceable *per request* has to be
mirrored into MongoDB — the same pattern `role` and `status` already follow. **Persisting it does not
enforce it** (§14.2): in Phase 32 nothing reads this field to make a decision. It is written so that a
future, separately-approved phase can read it without a second migration.

**`passwordHash.required: false`** because Firebase owns passwords for new accounts. **The field is
not removed** — it is the rollback path (§11) and the legacy login credential (§10).

**`photoURL` is deliberately not added.** Firebase can supply one for Google accounts, but no screen
renders an avatar. An unconsumed field is dead weight (CLAUDE.md §8).

## 7.3 Field mapping at first association

| Firebase | MongoDB | Rule |
| --- | --- | --- |
| `uid` | `firebaseUid` | verbatim, from the verified payload only |
| `email` | `email` | already `unique` + lowercased; Firebase emails are already normalized |
| `email_verified` | `emailVerified` | mirrored, **not enforced** in Phase 32 |
| `name` / `displayName` | `name` | `name` is **required** on the model — a Google account with an empty `displayName` must fall back to the local-part of the email, or the write fails validation |
| — | `businessId`, `role`, `status` | **never** from Firebase; assigned by Inventory AI |

## 7.4 Lifecycle cases

| Case | Behaviour |
| --- | --- |
| **First Google sign-in, known email, no `firebaseUid`** | Depends on the account-linking decision (§14.4). Without a decision, Firebase raises `auth/account-exists-with-different-credential` and the flow must handle it explicitly rather than surfacing a raw error. |
| **First Google sign-in, no MongoDB user at all** | `REGISTRATION_REQUIRED` — the client routes to the business-signup screen. **Not a 404**: the identity is valid, it simply has no tenant yet. |
| **First email/password login** | The MongoDB user was created at registration (§8.2), so the exchange succeeds directly. |
| **Duplicate email at registration** | Firebase rejects client-side with `auth/email-already-in-use`. No regression: today's `POST /api/auth/register` returns 409 `EMAIL_IN_USE`, so enumeration resistance is unchanged. |
| **Disabled user** | `status !== 'ACTIVE'` → 403 `ACCOUNT_DISABLED`. Unchanged; the gate is server-side and Firebase knows nothing about it. |
| **Suspended/archived business** | `assertActiveBusiness` → 403. Unchanged. |
| **Firebase user deleted, MongoDB user alive** | The application JWT stays valid until it expires (≤7d) or is revoked. Reconciliation is an operational concern, not an in-request check — a per-request Firebase lookup would put Google on the hot path of every API call, which this design explicitly refuses. |
| **MongoDB user deleted, Firebase user alive** | `User.findById` → `null` → 401 `AUTH_REQUIRED`. Unchanged. |
| **Admin creates a user (Phase 14A)** | Credential creation must also happen in Firebase. **Owner decision** (§14.3). |
| **`firebaseUid` already linked to a different MongoDB user** | The unique index rejects the write. Treat as a hard error and audit it — this is the signature of a compromised or misconfigured mapping, never something to auto-resolve. |

---

# 8. Session lifecycle

## 8.1 Obtaining a session

Unchanged in shape from a password login — the exchange reuses **the same two calls**:

```ts
const jti   = newSessionId();
const token = signAccessToken(user._id, jti);
const session = await createSessionForToken({ userId: user._id, businessId: user.businessId, token, deviceLabel });
return { token, user, session };
```

Because the session row is created by the same function as today, `expiresAt`, `deviceLabel`
normalization and the TTL index all behave identically. The client receives `{ token, user }` in the
same envelope as `POST /api/auth/login`, so the mobile session layer needs no new parsing.

## 8.2 Registration sequence

```text
1. client   Firebase createUserWithEmailAndPassword(email, password)
              └─ failure: nothing has happened server-side; surface the Firebase error
2. client   updateProfile({ displayName: name })
3. client   POST /api/auth/firebase/register { businessName, name, idToken }
4. server   verifyIdToken → uid, email
              create Business + OWNER User with firebaseUid   (mirrors registerBusinessOwner)
              → 201, no token (matching today's register, which issues none)
5. client   POST /api/auth/firebase/exchange → session
```

**Failure mode, handled rather than ignored.** If step 3 or 4 fails, an orphan Firebase account
exists with no MongoDB user. This is intrinsic to federated registration and cannot be eliminated
client-side. It is made **self-healing**: the exchange answers `REGISTRATION_REQUIRED` for a valid
identity with no MongoDB record, so the user retries signup and the orphan is adopted. The
alternative — deleting the Firebase account client-side on failure — is racy and leaves the user with
no account at all if the delete also fails.

## 8.3 Ending a session

| Action | Firebase | Inventory AI |
| --- | --- | --- |
| Sign out (this device) | `firebaseSignOut()` | `POST /api/auth/logout` → revoke this session row |
| Sign out everywhere | `firebaseSignOut()` | `POST /api/auth/logout {all:true}` → revoke **all** rows |
| Session revoked elsewhere | — | Next request → 401 `SESSION_REVOKED` → existing `sessionLostHandler` clears local state |
| Application JWT expires | — | 401 → client re-exchanges a fresh ID token, or returns to login |

**Both halves are required.** Clearing only the application session leaves a live Firebase refresh
token on the device that can mint a new ID token and silently re-establish a session. Clearing only
Firebase leaves an application JWT that keeps working until it expires.

`logout {all:true}` must reach **both** systems, or "sign out everywhere" becomes a claim the system
does not honour — a direct contradiction of Phase 26A's purpose.

## 8.4 Re-exchange

When the application JWT is expired or revoked and a Firebase session is still live, the client can
obtain a fresh ID token and exchange again without a password prompt. This is the intended recovery
path and it is why the exchange endpoint must remain public and idempotent with respect to session
creation.

---

# 9. Migration strategy

Existing users hold bcrypt hashes and have no Firebase account. **No bulk migration is part of
Phase 32's implementation scope.** This section documents the strategy for a later phase and names
its risks.

## 9.1 Lazy migration (the recorded strategy)

1. **Keep `POST /api/auth/login` and `users.passwordHash` alive throughout Phase 32.** On a successful
   legacy password login, the server creates the Firebase user with the same password via
   `admin.auth().createUser()` and writes `firebaseUid`. Users migrate as they sign in.
2. Everyone who never signs in again is migrated by a later bulk import, or simply remains on the
   legacy path until it is retired.
3. Retirement of the legacy path is its own explicitly-approved increment, after the population on it
   is measured to be zero or acceptably small.

## 9.2 Why lazy first

- **Zero downtime, zero lockout.** No maintenance window, and no user is ever unable to sign in.
- **No new credential exposure.** The server already receives the plaintext password on this path
  today; forwarding it to `admin.auth().createUser()` adds no new disclosure.
- **It is the rollback story.** Because the legacy path is retained, reverting the mobile build leaves
  every pre-existing user able to sign in.

## 9.3 Risks of the bulk import (for the later phase)

- **bcrypt compatibility is UNVERIFIED** (§18, gate 1). If `auth:import` cannot consume our rounds-10
  hashes, big-bang migration is impossible and lazy migration becomes the only route. **If this gate
  fails, the documented fallback is lazy migration plus a forced-reset campaign** — which is a
  user-visible cost the owner must weigh before committing to it.
- **Duplicate-identifier behaviour.** Firebase's import does not check for `uid`/`email` collisions: a
  colliding `uid` *replaces* an existing user, and other duplicated fields *create an additional
  user*. An import file must therefore be generated and diffed against the live project, never
  blindly uploaded.
- **Ordering.** If the Mongo-side `firebaseUid` backfill and the Firebase import disagree, some users
  end up with an ID token that resolves to no `User` — surfacing as `REGISTRATION_REQUIRED` for an
  existing account, which is confusing but recoverable.
- **Password-change invalidation.** Imported users' `passwordChangedAt` semantics change (§14.7).

---

# 10. The legacy path is preserved

Phase 32 **does not** remove, weaken, disable or gate any of the following:

- `POST /api/auth/login` and its two rate limiters
- `users.passwordHash` and `passwordChangedAt`
- `registerBusinessOwner()` as the business-creation path
- `POST /api/auth/change-password`
- Phases 26B/27's forgot/reset endpoints, mail layer and mobile screens
- `config/jwt.ts`, `session.service.ts`, `authenticate.ts`, `authorize.ts`, `constants/roles.ts`

Two sign-in paths coexist by design for the duration of the migration. The consequence — that a user
whose password was changed through one system is unaffected in the other — is exactly why the
password-authority question (§14.1) had to be decided rather than allowed to persist unstated. **It was
decided by Phase 32E; see the amendment below and §14.1.**

**Amended by Phase 32E (2026-09-20) — one exception, and its scope.** `POST /api/auth/login` is now
**gated for Firebase-linked accounts**: `loginWithPassword` refuses with `403 FIREBASE_SIGN_IN_REQUIRED`
once the account carries a `firebaseUid` — after the password comparison and the status check, and
before `assertActiveBusiness` and the session write (`server/src/services/auth.service.ts`). Every other
item in the list above is untouched, and the route behaves exactly as it always has for every account
that has no `firebaseUid` — which is every account in production today, because no shipped code writes a
`firebaseUid` onto an account that retains a `passwordHash`. The exception exists because such an
account would otherwise hold two independently valid credentials that nothing keeps in step. Its
rollback consequence is recorded in §11; the decision it closes is §14.1.

---

# 11. Rollback strategy

| Phase | Reversibility |
| --- | --- |
| 32B (Admin SDK + verifier) | **Fully additive.** No route, no mobile change. Revert the commit; nothing else moved. |
| 32C (exchange + register routes) | **Additive routes.** Revert; legacy login is untouched and still the only path the app uses. |
| 32D / 32E (mobile) | **Revert the mobile build.** Old builds keep working because §10 keeps password login alive for every account without a `firebaseUid`. **This is the property that makes the whole plan reversible, and it depends entirely on not retiring the legacy path early** — see the Phase 32E qualification below. |
| 32E (schema) | **Additive fields with safe defaults.** `firebaseUid` sparse-unique and `emailVerified: false` are inert if the code reverts. No down-migration needed. |
| 32G (cutover) | Clean for every pre-existing user. **One-way for accounts created after cutover** — they have no `passwordHash` and cannot use the legacy path. |

**Phase 32E qualification (2026-09-20) — reverting the mobile build is no longer sufficient on its own
for a Firebase-linked account.** Because `loginWithPassword` now refuses an account carrying a
`firebaseUid` (§10), a reverted build — which has no Firebase path at all — cannot sign such an account
in: it posts to `POST /api/auth/login` and receives `403 FIREBASE_SIGN_IN_REQUIRED`. Rollback therefore
requires **reverting the server behaviour as well, or disabling the guard explicitly**; the mobile build
alone is not enough. This qualification is inert today, because no account is linked; it becomes live the
moment a migration phase begins writing `firebaseUid` onto password accounts (the 32G row below), and it
is that phase which must record the runbook step.

**The single one-way door.** Accounts registered through Firebase after cutover exist only in
Firebase. Rolling back the server to a password-only world locks those accounts out until Firebase is
re-enabled or they complete a reset. This must be stated in the operational runbook before 32G runs,
and it is the reason the cutover phase must not be scheduled until the Firebase path has been
exercised in production for a meaningful period.

**Never deleted during Phase 32:** `passwordHash`, `config/jwt.ts`, `session.service.ts`,
`POST /api/auth/login`. Retirement is a separate, approved increment.

---

# 12. M1 vs M2 — mobile integration paths

> **UPDATE — 2026-09-24 (additive; nothing below is removed).** The mobile integration
> path has since been **decided**: **M1 (React Native Firebase) is approved**, together with the
> Firebase **P2 durable-persistence** decision. That decision **supersedes the Phase 32D
> `inMemoryPersistence` requirement** and is recorded in
> [`2026-09-24-rnfirebase-p2-persistence-decision.md`](./2026-09-24-rnfirebase-p2-persistence-decision.md).
> The comparison table and rationale below remain the M1-vs-M2 analysis exactly as written. Read `O-4`
> and `O-7` in §14A.5 as resolved, and `O-11` (Expo Go) as forfeited as a consequence of choosing M1.
> The chosen Google Sign-In library is `@react-native-google-signin/google-signin@16.1.5`, and the two
> native configuration files are supplied by **EAS build-time injection** rather than committed.

Both are documented because the choice is an owner decision (§14.5) and it is not reversible cheaply
once native configuration exists.

| | **M1 — React Native Firebase** | **M2 — `firebase` JS SDK** |
| --- | --- | --- |
| Packages | `@react-native-firebase/app`, `@react-native-firebase/auth` | `firebase` (v12+ for current Expo SDKs) |
| Google Sign-In | `@react-native-google-signin/google-signin` (native) | `expo-auth-session` (system browser) |
| **Expo Go** | **Impossible** — confirmed by Expo's own documentation: React Native Firebase "requires custom native code and cannot be used with Expo Go" | **Works** |
| Development build | **Required** | Not required |
| Native config | `google-services.json`, `GoogleService-Info.plist`, SHA-1/SHA-256, `iosUrlScheme` | None |
| Google UX | Native account sheet | Browser round-trip; subject to Google's embedded-webview policy if implemented incorrectly |
| EAS impact | **Forces the first EAS build in this project's history** | None |

> **Cross-reference added 2026-09-25 (Phase F1).** The choice this table presents was **made in
> practice, and M2 is now CLOSED as superseded** rather than pending: the shipped implementation is
> **M1** (native SDKs), and Phase F1 deleted M2's browser machinery — the `expo-auth-session` import,
> `acquireGoogleIdToken`, its Google discovery constants, `googleRedirectUri()` and the `firebase` JS
> SDK dependency itself. The comparison above is historical and is left unedited. See **§14A.9**.
| Config-plugin burden | Firebase + Google Sign-In + `expo-build-properties` | None |
| Ongoing dev speed | Dev build rebuild required for native changes | `expo start` as today |

**Alignment note.** M1 matches where Phase 30A already points — `expo-dev-client` is installed and
four EAS profiles are defined, though no build has been produced. **M2 is materially lower-risk, needs
no EAS build, and keeps the current inner loop intact**, at the cost of a browser-based Google flow.

**Either way, the server side and the application-session design are identical.** This decision
affects only how the mobile client obtains an ID token.

---

# 13. Firebase Console setup checklist

Nothing in this section has been performed. It is a runbook.

## 13.1 Client-safe configuration

These values ship inside the app bundle. Per Firebase's own threat model they are **project
identifiers, not secrets** — but see §14.6 for the storage decision.

- [ ] Create the Firebase project.
- [ ] Add an **Android** app with package `com.inventoryai.app`.
- [ ] Add an **iOS** app with bundle id `com.inventoryai.app`.
- [ ] Authentication → Sign-in method → enable **Email/Password**.
- [ ] Authentication → Sign-in method → enable **Google**.
- [ ] Confirm the authorized domains list (`*.firebaseapp.com`, `*.web.app` are automatic). No custom
      domain is required while there is no web client.
- [ ] Download `google-services.json` (Android) and `GoogleService-Info.plist` (iOS).
- [ ] Record the iOS `REVERSED_CLIENT_ID` for the URL-scheme configuration.
- [ ] Register Android **SHA-1 and SHA-256** fingerprints.

## 13.2 Server-only credentials

- [ ] Project settings → Service accounts → **Generate new private key**.
- [ ] Store the resulting JSON as a server-side secret only (§14.6 storage strategy).
- [ ] **Never** place it in the mobile app, in git, in an EAS plaintext variable, or in chat.

## 13.3 The Android fingerprint bootstrap (two builds)

EAS owns the Android keystore, and **the keystore does not exist until the first build runs.** The
sequence is therefore unavoidably two builds, and this is worth budgeting for:

```text
1. eas build --profile development   ← creates the EAS-managed keystore
2. eas credentials                    ← read the keystore, compute SHA-1 / SHA-256
3. Firebase Console                   ← register both fingerprints
4. Firebase Console                   ← download a FRESH google-services.json  (required:
                                        the existing one predates the fingerprint)
5. eas build --profile development   ← second build, now with a working Google flow
```

Google Sign-In **cannot** work before step 5. A local debug build additionally needs the debug
keystore's SHA-1 registered, and a Play-distributed build needs the Play App Signing SHA-1.

---

# 14. Owner decisions

This section is the **decision register**. It records what was once undecided, so nothing could be
settled silently in code. The current state of every entry, and the register of decisions the owner
approved in Phase 32F, are in **§14A** immediately below; the per-item history that follows here is
kept in place rather than deleted, so the question each entry answered stays readable.

**Status after Phase 32F (2026-09-20):** the register is now split explicitly between **resolved**
decisions and **open** ones — see §14A, which is authoritative for the current state. In summary:
14.1 (password authority), 14.4 (linking policy) and 14.9 (lazy migration) are **resolved**; 14.3 is
**partly resolved** (invitation-based onboarding is the approved direction, its implementation is
open); 14.10 is **resolved** by the mobile TypeScript migration, which post-dated this document; and
14.2, 14.5, 14.6, 14.7 and 14.8 remain **open**. No entry was removed, and no implementation-specific
detail is marked resolved.

**14.1 Password-reset authority. — PARTLY RESOLVED by Phase 32E (2026-09-20).**

**Resolved:** *for a Firebase-linked account, Firebase is the password authority, and the retained
bcrypt hash is not a second way in.* `loginWithPassword` refuses a `firebaseUid`-bearing account with
`403 FIREBASE_SIGN_IN_REQUIRED` (§10), and the client copy — "This account signs in with Firebase. Enter
your Firebase password to continue." — deliberately names the **credential** rather than a control,
because 32E signs in through one email/password form for both paths. This was settled with the owner as
part of Phase 32E rather than left open, because an account holding two credentials that nothing keeps
in step is a bypass, not an open question.

**Consequence, recorded rather than glossed:** for a linked account, `POST /api/auth/change-password`
and the 26B/27 reset flow no longer change the credential that actually authenticates the user — the
Firebase password does, so a user who changes their password there is still admitted by their previous
Firebase password. This is inert today (no account is linked, and no shipped code links one) and becomes
live in the phase that starts writing `firebaseUid` onto password accounts. It is a residual risk this
decision accepts, not one it resolves; whichever phase retires the legacy path must settle it.

> **RESOLVED 2026-09-29 (Phase 32N — see §14C, L-3/L-11).** The question this paragraph leaves open
> has been answered: **Firebase takes over the recovery flow**, and the 26B/27 artefacts are to be
> removed in a later, separately-approved step. The paragraph below is the Phase 32E/32F record and is
> left verbatim; note that its "nothing is removed now" clause is still literally true. The new
> constraint this decision introduces — that a client-side reset never reaches the server, so
> `passwordChangedAt` would not fire — is designed in **§14C.3**, which is the resolution of O-9.

**Still open:** does Firebase take over `POST /api/auth/forgot-password` and
`POST /api/auth/reset-password`, displacing Phase 26B/27's mail layer, token store and two
mobile screens? Running both is possible but means a password can be reset through one system and not
the other. If Firebase takes over: are the 26B/27 artefacts deleted, archived, or left in place? The
project's conventions forbid silent deletion — **and nothing is removed now: the 26B/27 endpoints, mail
layer, token store and both mobile screens remain exactly as they shipped, and no change to them is
implied by the decision above.** *Related UX question:* Firebase's default reset link is hosted, which
would replace the in-app `inventoryai://reset-password` flow unless `ActionCodeSettings` is configured
for a custom action URL. This choice also closes or preserves the B1/B2/E3 risk records in roadmap
§27B/§27D/§27E.

> **Answered in practice, 2026-10-20 (AUTH-05, roadmap §27DX).** `ActionCodeSettings` is **not** the
> mechanism: a custom-scheme continue URL is refused by this project (`auth/unauthorized-domain`, measured
> live, no mail generated), so the send now passes **no** settings at all and the link's destination is the
> project's password-reset template — which points at this server's public `GET /auth/reset` page. That
> page hands the one-time `oobCode` to `inventoryai://reset-password`, so the in-app flow is preserved
> **without** a custom action URL that the client can request, and Firebase's hosted page stays as the
> fallback for a phone without the app. The sentence above is left verbatim as the historical record.

**14.2 Email-verification enforcement.** `emailVerified` is persisted but **not** enforced in
Phase 32. Enforcing it later is a behaviour change: today `signUp` logs the owner straight in, so
gating API access on verification would strand new users on a screen the app does not yet have.

**14.3 Admin-created users (Phase 14A). — PARTLY RESOLVED by Phase 32F (2026-09-20).**

**Resolved (direction):** the owner has approved **invitation-based onboarding** as the intended
mechanism, rather than having the creator establish another person's Firebase password. An invitation
is bound to the intended business and role, the invitee authenticates with an allowed Firebase
provider, the server validates the invitation, and `businessId` and `role` are assigned **server-side**
from the invitation — never from the invitee's request. The creator's own password is therefore never
another person's credential, which removes the weakest part of the original options below.

**Still open (implementation):** the invitation model, its lifetime and single-use semantics, the
route surface, revocation, whether an invitation may change business, and how it interacts with the
existing `users.manage` create route — which **still exists and still accepts a password**, unchanged.
**No invitation model, route, service or screen exists**, and none may be added without an approved
phase.

The original question is retained below so the reasoning stays readable: when an ADMIN creates a user
over `users.manage`, does the server create the Firebase account with the ADMIN-typed password
(minimum change — the mobile `UserForm` already collects one), or does Firebase send an invite /
password-reset email (better UX, but `password` becomes optional in the API contract)? The invitation
direction answers the *intent*; the shipped route has not been changed to match it.

**14.4 Google account linking. — RESOLVED by Phase 32F (2026-09-20).**

**Resolved: the system does NOT link automatically.** When a provider identity's email matches an
existing password account, the identities are **not** merged. **Email is not an account-linking join
key**, and authenticating a provider identity is **not** proof of ownership of an existing Inventory
AI account. The server stays **UID-authoritative**.

The reasoning, recorded rather than asserted: if an identity asserting `john@example.com` were merged
into an existing `john@example.com` account on the strength of the address, then anyone able to obtain
a provider account bearing a victim's address would receive that victim's session — their `businessId`,
their role, and their entire tenant's data. A provider that does not verify addresses, or that permits
an address to be changed later, makes that reachable in practice. Firebase's own default here is to
raise `auth/account-exists-with-different-credential`, which is the same refusal.

**Linking is instead an explicit account operation** (§14A, "Safe account linking"), performed by an
already-authenticated user, with the provider UID taken from the verified credential and never from a
request body. **Linking during a sign-in attempt requires an explicit ownership/recovery proof flow**
before it may attach to an existing account. **Neither flow is implemented.**

The original question is retained below: does the system link automatically, require a prior password
sign-in to prove ownership, or refuse? The answer is *refuse the automatic path*, and require proof on
any explicit path — but the phase that implements it is not this one.

**14.5 M1 vs M2** (§12).

**14.6 `google-services.json` / `GoogleService-Info.plist` storage.** Commit them deliberately with
written reasoning, or inject them at build time via EAS file environment variables? The latter forces
`app.json` → `app.config.js` so `googleServicesFile` can read from the environment — a structural
change to a file Phase 30A established as the single source of native configuration. Note also that
`.easignore` **replaces** `.gitignore` rather than adding to it, so any ignore change must be applied
to both.

**14.7 `passwordChangedAt` semantics for Firebase-native accounts.** Our server never learns that a
Firebase-native user changed their password, so **`SESSION_INVALIDATED` does not fire for them** — a
stolen application JWT is no longer killed by a password change, only by sign-out-everywhere
(Phase 26A). This is a genuine reduction in a security property that Phase 15 deliberately built, and
it requires explicit acceptance or a compensating design.

**14.8 Expo Go.** M1 forfeits Expo Go for day-to-day development. This affects every future mobile
phase, not just Phase 32.

**14.9 Acceptance of lazy migration — CONFIRMED by Phase 32F (2026-09-20).** That
`POST /api/auth/login` and `passwordHash` survive all of Phase 32 (§9, §10). Re-confirmed with the
qualification below, which remains binding.

**14.10 Documentation reconciliation. — RESOLVED (not by a phase).**

CLAUDE.md §2 recorded the mobile stack as "JavaScript" while the app is TypeScript. This was
unrelated to Firebase, and it has since been corrected by the mobile TypeScript migration: CLAUDE.md
§2 now reads **TypeScript** for the mobile stack, alongside the server's completed TypeScript
campaign. No action remains. Retained here only so the entry is not silently dropped from the register.

---

# 14A. Phase 32F — Multi-provider decision record

**Phase:** 32F
**Date:** 2026-09-20
**Scope:** Documentation only. This phase changes no source code, no dependency, no package manifest,
no environment variable, no database record, no schema, no route, no authentication behaviour, no
payment code, and creates no EAS build.

This section is **authoritative for the current state of the multi-provider architecture**. It records
the owner's decisions, separates what is **resolved** from what remains **open or future**, and states
plainly what is **not implemented**. It does not authorise implementation of anything.

## 14A.1 Architecture — Firebase as identity provider

Firebase Authentication is the **identity provider**. It answers *who is this person?* — nothing more.
The Inventory AI backend answers *which Inventory AI account and business does this person belong to,
and what are they allowed to do?*

MongoDB / Inventory AI remains authoritative for: `userId`, `businessId`, `role`, account status,
permissions, business status, subscription/billing state, application sessions, and audit records.
**Firebase UID is an identity linkage field, not an authorization source.**

| Method | Status |
| --- | --- |
| Email/password via Firebase Authentication | **Implemented** (32B–32E) |
| Google via Firebase Authentication | **Implemented** (Phase C, native `@react-native-google-signin/google-signin`) — existing-account Android flow **E2E verified 2026-09-26**; the new-identity `REGISTRATION_REQUIRED` path is ENVIRONMENT-BLOCKED |
| Facebook via Firebase Authentication | **Approved · NOT implemented** |
| Apple Sign-In | **Future scope · NOT part of the current implementation** |

## 14A.2 Security boundary

The following are **server-controlled** and are never read from the mobile client: `businessId`,
`role`, `status`, Firebase linkage, permissions, and subscription/business access. This is the
existing Phase 03 / 14A / 22–24 contract, restated here because the provider work is where it would be
most tempting to widen.

- Firebase ID tokens are accepted **only** at the exchange boundary.
- A Firebase ID token **must not** become the application's long-lived API bearer credential.
- The backend exchanges a verified ID token for the existing Inventory AI JWT/session model.
- **One unified Inventory AI session representation** exists regardless of provider. There are **no
  provider-specific session types**, and **no provider field may be added to the session model** merely
  because Google and Facebook are being added.

## 14A.3 Resolved decisions (approved by the owner, Phase 32F)

Each is a decision that was open and is now settled. **"Resolved" means the policy is decided — not
that any code implements it.**

| # | Decision | Consequence |
| --- | --- | --- |
| **R-1** | **Password authority for Firebase-linked accounts.** Firebase is the authority; the retained bcrypt hash is **not** a second authentication door. `loginWithPassword` continues to refuse with `403 FIREBASE_SIGN_IN_REQUIRED`. | The §14.1 guard is **retained unchanged** and must not be removed or weakened. |
| **R-2** | **Provider identity is never trusted from the request body.** A provider UID is taken only from the verified Firebase credential/token. | Same standing as `businessId`, `role` and `status`. |
| **R-3** | **A Firebase ID token is exchanged and does not become the application's bearer credential.** | Option B, unchanged. |
| **R-4** | **Email is not an identity-linking join key.** A provider identity is never linked to an existing account solely because the email matches. | Binds every future provider phase. |
| **R-5** | **Lazy migration on successful legacy password login is accepted** (§9.1). | Subject to the §10 qualification and the §16.6 binding constraint. |
| **R-6** | **Email / Firebase UID collision handling follows the existing documented behaviour** (§7.4): email → `409 EMAIL_IN_USE`; UID → **hard error**, never auto-resolved. | Already implemented; unchanged. |
| **R-7** | **Sessions remain provider-neutral.** | No schema change; no provider field on `sessions`. |
| **R-8** | **Account linking requires explicit ownership proof.** | A sign-in is evidence about an identity, not about an account. |
| **R-9** | **Provider linking must not silently happen based on email equality.** | Auto-linking on an address match is **prohibited**. |
| **R-10** | **Facebook missing-email cases require explicit handling.** Never invent an email; never derive one from the Facebook UID; require email completion before creating the user. | Binds the future Facebook phase. |
| **R-11** | **Subscription ownership is business-level, not Firebase-user-level.** | A change of Owner or provider must not transfer, destroy or recreate a business subscription. |

**R-2, R-4, R-7, R-8, R-9, R-10 and R-11 are new decisions recorded by this phase.** R-1, R-3 and
R-6 restate decisions already in force; R-5 confirms §14.9. Recording them here does not change any
behaviour: **none of the eleven is implemented by this phase**, and four of them (R-4, R-8, R-9, R-10)
constrain phases that do not exist yet.

## 14A.4 The linking policy, in full

**Prohibited:** linking a provider identity to an existing Inventory AI account because the email
addresses match. **Email is not an account-linking join key.** Authenticating a provider identity is
**not** equivalent to proving ownership of an existing Inventory AI account.

**Approved design for explicit linking** — an operation performed by an **already-authenticated**
Inventory AI user:

```text
Inventory AI authenticated session
        ↓
user explicitly chooses "Connect Google" / "Connect Facebook"
        ↓
provider authentication
        ↓
verified Firebase credential
        ↓
Firebase account linking
        ↓
the existing Inventory AI account is unchanged
        ↓
businessId / role / status remain authoritative
```

**Approved constraint on linking during sign-in:** it must require an **explicit ownership/recovery
proof flow** before it may attach a provider to an existing account. A user who signs in with a
provider whose address matches an existing account is **not** thereby shown that account.

**Not implemented:** there is no link route, no unlink route, no linking service, no provider field on
any model, and no ownership-proof flow. **This phase implements none of it.** (Recorded by Phase 32F
and accurate as of it. **Phase 32H later added the link *route* and the linking service — see §14B.**
There is still no unlink route, no provider field on any model, and no ownership-proof flow beyond the
authenticated session itself; the statement above is left as the Phase 32F record rather than
rewritten.)

## 14A.5 Open decisions (not resolved — do not settle these in code)

| # | Open question | Blocks |
| --- | --- | --- |
| **O-1** | The **unlink policy** and last-authentication-method protection, accounting for both Firebase's own provider set and the app-side `firebaseUid` password refusal. — **RESOLVED FOR THE SERVER-SIDE PATH 2026-09-26 (Phase 32L):** the policy is **Policy B** (an account may leave Firebase authority only by establishing a new local password in the same transition), so the server-side last-authentication-method invariant holds structurally and the `firebaseUid` password refusal is never the only remaining method. **Residual, recorded and NOT closed:** Firebase's own provider set is a client-side operation this server cannot observe. See `docs/DEVELOPMENT_ROADMAP.md` §27Q. | ~~Any unlink capability~~ — set as **Policy B**; the server-side capability shipped in Phase 32L. **Annotated 2026-10-01 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`):** the server-side capability is **REMOVED**, not deprecated — the route, its service and its two audit actions are gone from the committed tree, and the operation was re-scoped into a credential change; the residual above stays recorded rather than closed. See `CLAUDE.md` and `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` §8. |
| **O-2** | The **linked-account disposition** of `change-password` and the 26B/27 reset flow, which today would change an inert hash and revoke every session as a side effect. | Any phase that writes `firebaseUid` onto password accounts |
| **O-3** | Whether **`emailVerified` is enforced** (§14.2). — **DIRECTION LOCKED 2026-09-29 (Phase 32N, §14C, L-6/L-7):** an email/password user must have a **verified email before entering the main app**, and a Google user is verified **according to Firebase's signed `email_verified` claim**, not because the provider is Google. **The enforcement *mechanics* are RESOLVED 2026-09-29 (Phase 32O, §14C.9):** the gate is the **registration ordering** plus a **client verify screen**, and **`requireAuth` is deliberately not modified**, so the Phase 23/24 authorization order and status codes are preserved; an unverified Google identity is **refused**, not merely warned; resend is **native Firebase Auth**; and the stale `User.emailVerified` problem is **bounded, not eliminated**. Fifteen registration decisions (**RG-1…RG-15**) and the audit gaps **D-5…D-9** are recorded there. *(This row is the Phase 32N record and is annotated rather than rewritten.)* | Provider sign-in relying on a provider-asserted address |
| **O-4** | **M1 vs M2** (§14.5). — **RESOLVED 2026-09-24:** **M1 (React Native Firebase)** approved, with P2 durable persistence; see [`2026-09-24-rnfirebase-p2-persistence-decision.md`](./2026-09-24-rnfirebase-p2-persistence-decision.md). | All Google/Facebook mobile work |
| **O-5** | The **Facebook missing-email onboarding flow** — the policy is R-10, the flow is undecided. | Facebook Login |
| **O-6** | The **remedy, if any, for the unhealable orphan** (§16.6). | The legacy migration/linking phase |
| **O-7** | **`google-services.json` / `GoogleService-Info.plist` storage** (§14.6). — **RESOLVED 2026-09-24:** **EAS build-time injection**; the files are **not committed** to the repository unless a later explicit owner decision changes this. See [`2026-09-24-rnfirebase-p2-persistence-decision.md`](./2026-09-24-rnfirebase-p2-persistence-decision.md) §8.1. | Native provider configuration |
| **O-8** | Whether **Firebase takes over the password reset flow**, and the disposition of the 26B/27 artefacts if it does (§14.1, still open). — **RESOLVED 2026-09-29 (Phase 32N, §14C, L-3 + L-11):** **Firebase takes over recovery.** The 26B/27 endpoints, the reset-token model and the Resend mail layer are to be **removed** in a later, separately-approved step (N-7); their *disposition* (deleted vs archived) remains OPEN as **OD-5**, because project convention forbids silent deletion. **Nothing is removed now** — every one of those artefacts still exists and still works. | Password recovery |
| **O-9** | **`passwordChangedAt` semantics for Firebase-native accounts** (§14.7) — `SESSION_INVALIDATED` does not fire for them. — **RESOLVED (design) 2026-09-29 (Phase 32N, §14C.3):** the compensating design is the **credential-change / session-revocation bridge**, `POST /api/auth/credentials-changed` — authenticated, bound to the verified uid **and** a fresh signed `auth_time`, stamping `passwordChangedAt` and revoking every session, with the re-exchange ordered *after* it so the new session survives (L-14/L-15/L-16). **The endpoint is NOT implemented**; its name is OPEN as OD-1 and its test obligations are recorded in §14C.3.5. | Explicit acceptance or a compensating design |
| **O-10** | **Invitation implementation** — model, lifetime, single-use semantics, routes, revocation (§14.3). — **DIRECTION LOCKED, IMPLEMENTATION OPEN 2026-09-29 (Phase 32N, §14C, L-12):** invitation-based Firebase onboarding **replaces** admin-created password accounts. This is now a **hard prerequisite of retiring the legacy path**, not a follow-up to it: `server/src/services/users.service.ts` `create` writes a bcrypt `passwordHash` and **no `firebaseUid`**, so once legacy login is removed such an account has no way in at all. See §14C.6 **N-9**. | Invitation onboarding |
| **O-11** | **Expo Go policy** (§14.8), which M1 would forfeit. | Every future mobile phase |

## 14A.6 Unverified gates (unchanged)

Neither is settled by this phase, and both gate **later** work rather than this one:

1. **Firebase `auth:import` bcrypt support** — decides whether a bulk migration is possible at all.
2. **React Native Firebase + Expo SDK 57 config-plugin configuration** — decides whether M1 is viable.

## 14A.7 Implementation status (stated so it cannot be assumed)

- **Google Sign-In: NOT started.** No provider SDK, no OAuth client, no route, no screen.
  *(**Superseded 2026-09-26 (Phase C):** native Google Sign-In **is implemented** — the
  `@react-native-google-signin/google-signin` provider SDK is installed and the existing-account
  Android flow is **E2E verified**; the new-identity `REGISTRATION_REQUIRED` path is
  ENVIRONMENT-BLOCKED. This sentence is the Phase 32F record and is not rewritten.)*
- **Facebook Login: NOT started.** Same.
- **Apple Sign-In: future scope**, not scheduled.
- **Account linking: NOT implemented. Account unlinking: NOT implemented.** (**Superseded in part by
  §14B** — as of Phase 32H the server-side linking *boundary* is implemented, and as of **Phase 32L**
  (`POST /api/auth/firebase/unlink`, Policy B — specification §29, roadmap §27Q) the server-side
  **unlinking** boundary is implemented too. Every provider-side statement in this section still holds:
  no provider screen, no ownership-proof flow beyond the authenticated session, and Firebase-side
  provider linking/unlinking remains a client-SDK operation the server cannot observe. The sentence
  above is the Phase 32F record and is not rewritten.)
  *(**Annotated 2026-10-01 — `Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`:** the Phase 32L
  server-side **unlinking** boundary named above was **REMOVED**, not deprecated — the route, its service
  and its two audit actions are gone from the committed tree, and the operation was re-scoped into a
  credential change, so no reachable path clears `firebaseUid`. The provider-side statements above still
  hold, and the Policy B measurements remain valid history. See the Phase F-1 correction in `CLAUDE.md` and
  `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` §8.)*
- **Invitations: NOT implemented.** The `users.manage` create route still exists unchanged.
- **No provider SDK is installed** on either platform. *(**Superseded 2026-09-26 (Phases B–C):** the
  native Firebase (`@react-native-firebase/*`) and Google Sign-In provider SDKs are installed. The
  Phase 32F record is not rewritten.)*
- **No EAS build, submit or prebuild has been created.** The first EAS development build remains a
  **prerequisite** for validating the selected mobile provider integration path; until it exists, no
  provider integration has been tested — and none is claimed to have been. (**Superseded by Phase 32G**,
  which produced one; the claim that no *provider* integration has been tested still holds.)
- **The Firebase exchange is unchanged**: it verifies the ID token, uses the verified UID, resolves by
  `firebaseUid`, **never by email**, rejects an unknown UID with the existing registration-required
  behaviour, applies the existing user/business status checks, and mints the existing JWT/session.

## 14A.8 Phase E — session-reconciliation decisions (2026-09-25)

Owner decisions taken after the Phase D native migration, when the remaining
JavaScript-SDK confirmation paths were gone and the durable/Inventory split could be
examined as a whole. **D-E1, D-E2 and D-E5 are implemented; D-E3 and D-E4 are
ACCEPTED FOR V1 and implemented by nothing** — they record that the current behaviour
is the intended behaviour, so no later phase treats it as unfinished.

**D-E1 — a failed native Firebase sign-out is CONSUMED, not discarded.**
`signOutOfFirebase()` has always been total and has always REPORTED whether the durable
native session could be ended; nothing read that boolean, so a failure left a persisted
Firebase credential on a device whose Inventory AI session had already ended, with no
signal at all. The outcome is now consumed: a `false` is recorded as a one-bit
`firebaseSignOutPending` marker in secure storage, and a later launch that resolves to
**signed out** retries the sign-out. Two constraints shape it. There is deliberately
**no user-facing error**, because a failed Firebase sign-out offers a person no action
and describes a credential they cannot see. And Inventory AI sign-out **still completes
whatever Firebase does** — the Firebase step runs last and cannot throw, so the marker
can never be a precondition for the local sign-out. No token, uid, password, hash,
native error text or secret is stored or logged: the marker is one bit meaning "Firebase
may still hold a session on this device".

**D-E2 — boot cleanup is EXPLICIT, and is never duplicated.** A boot that restored a
stored Inventory AI JWT and had it refused ended the durable Firebase session only
because the centralized `sessionLostHandler` happened to be registered before the boot
effect ran — a guarantee that rested on React effect ordering rather than on anything
stated. The boot path now performs the cleanup itself. It does not duplicate the
handler's work: `lib/client.ts` reports a token-bearing 401/403 to the handler
*synchronously*, before the refused request is rethrown, so by the time the boot catch
runs a single flag says whether the centralized path already owns this refusal and the
boot path acts only when it does not. **The centralized session-loss behaviour is
unchanged** — it remains the one place a refused token is interpreted, and it remains
the owner of the Firebase sign-out for every refusal that travels through the
transport. This is not a second session-loss mechanism; it is the same cleanup, made
explicit for the one caller that could previously rely on ordering.

**D-E3 — the post-unlink Firebase identity. ACCEPTED FOR V1.** Unlinking detaches the
MongoDB mapping only: the Firebase identity itself remains in Firebase, because
provider unlinking is a client-side Firebase operation and the server has no part in it
(§14B.4). A later sign-in with that detached identity therefore authenticates with
Firebase and resolves by `firebaseUid` to **no MongoDB user**, so the exchange answers
`REGISTRATION_REQUIRED` (§8.2) — which is a **new-business onboarding** path, not a
route back into the account that was unlinked. This is accepted rather than fixed. It is
**not an account takeover**: the exchange is UID-authoritative and never matches by
email, so no existing tenant is reachable through a detached uid. It is **not a
lockout**: the unlinked account keeps working through the new local password Policy B
established in the same transition. The consequence to state plainly is the surprising
one — the old Firebase credential can create a *second* Inventory AI business. Related,
but distinct, from the pre-link orphan of §16.6: that one is an identity created for an
existing account and never linked to it, whereas this is an identity that was linked and
then deliberately detached. **No code change, no schema change, and this does not settle
`O-1`, `O-2` or `O-6`.** *(**Update 2026-10-07 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`):** the risk this note
accepts is now **unreachable** — the unlink capability was **removed and re-scoped** into a credential
change (roadmap §27AA, §14B.6), so **no reachable path detaches a Firebase mapping** and the detached-identity
scenario described above cannot arise. The paragraphs above are the accepted record and are not rewritten.)*

**D-E4 — other devices' Firebase sessions. ACCEPTED FOR V1.** "Sign out everywhere"
revokes **every Inventory AI session** the user holds, on every device, in one call —
the server owns those. It **cannot** end the durable native Firebase session on another
device: that session lives in that device's own store, the server holds no handle on it,
and nothing is pushed to a client. The other device therefore stops being able to act
immediately (its JWT is dead server-side) but its Firebase session ends only when it next
makes a request and the centralized handler clears it. **No architecture change**: the
alternative would be a server-side Firebase revocation or a push channel, neither of
which exists and neither of which is proposed here. The residual to state plainly is that
a device the app is never opened on keeps a durable Firebase credential indefinitely —
which grants nothing on its own, because a durable Firebase session never becomes an
Inventory AI session (§14A.2, §16.7).

**D-E5 — a stale persistence comment corrected.** `app/register-firebase.tsx` justified
its cold-start refusal with "`inMemoryPersistence` (Phase 32D) means a restart has no
Firebase user at all". That premise is false under owner decision P2, which supersedes
the Phase 32D pin: a restart **can** restore a native `currentUser`. The refusal itself
was always correct and still is — the in-memory `firebaseRegistrationRequired` flag, not
Firebase state, is what authorizes that screen — so only the recorded reason was
corrected, and it now states the durable-persistence reality and that a restored
`currentUser` never becomes an Inventory AI session.

**Documentation observation, recorded rather than corrected (§16.7).** §16.7 is the
Phase 32A record and closes with "*or the client re-exchanges silently if a Firebase
session remains*". The shipped client does **not** do that: there is no automatic
exchange anywhere, boot consults only the stored Inventory AI JWT, and a durable Firebase
`currentUser` grants no session by itself. The clause is superseded by implementation and
is left as the historical record it is; the accurate statement is the one above.

## 14A.9 Phase F1 — the Firebase JS SDK and browser OAuth path are REMOVED (2026-09-25)

Phase F — the cleanup the earlier phases kept deferring — was split by the owner into two
controlled phases (**G-1**). **Phase F1 is pure JavaScript and changes no native surface**; **Phase
F2**, separately approved, removes the Expo browser dependencies, the `expo-web-browser` plugin, the
second `expo.scheme` entry and is the phase that requires a new native build. This section records
what F1 removed and, more importantly, the decisions that authorised removing it.

**The JS-SDK boundary is gone, and two imports had to move first.** `mobile/lib/firebase.ts` was the
only module in the app that imported `firebase/app` and `firebase/auth`. Phase B/C/D moved every
authentication off it, but two modules still imported `isFirebaseConfigured` **from it** purely
because that is where the re-export lived — `lib/auth.tsx` and `lib/firebase-native.ts`. Because
`lib/firebase.ts` carried top-level static SDK imports, asking that boolean pulled the entire
JavaScript SDK into those modules' bundle graph. The function has always been defined, SDK-free, in
`lib/config.ts`; F1 redirected both imports there and only then deleted the module and the `firebase`
dependency. **This ordering is the phase's one real hazard**: deleting the module first would have
left `isFirebaseConfigured` undefined, and the native gate — `isNativeFirebaseConfigured()`, which is
the same predicate — would have thrown for every Firebase and Google sign-in.

**The browser OAuth mechanism is gone with it.** Removed from `lib/firebase-auth.ts`: the
`expo-auth-session` import block, `acquireGoogleIdToken` (the authorization-code + PKCE helper Phase D
left unreferenced), its Google discovery constants (`GOOGLE_DISCOVERY`, `GOOGLE_SCOPES`), the
`GoogleIdTokenOutcome` type, and `googleRedirectUri()` (**G-5** — removed with the helper rather than
retained as a dead export). Nothing was reaching any of them: since Phase C the sign-in authenticates
natively and since Phase D the disconnect confirmation does too. **No behaviour moved with them** —
the outcome unions, the codes, the message table, the legacy-fallback rules and the unlink policy are
byte-identical, and `confirmFirebaseSignIn` still produces the fresh `auth_time` the server's 300-second
rule requires.

**The three negative browser-seam guards were replaced, not deleted (G-4).** Three suites had asserted
`expect(mockPromptAsync).not.toHaveBeenCalled()` and peers — the claim that kept a retained-but-unused
helper provably unreachable. With the helper gone those assertions had nothing to describe, so the
claim is now made **once, structurally, at the level that matters after a removal**:
`mobile/__tests__/phaseF1-retired-dependency-guard.test.ts` proves that no module under `lib/` or
`app/` imports `firebase`, `firebase/app`, `firebase/auth`, `expo-auth-session` or
`expo-web-browser`, that `lib/firebase.ts` is absent, and that `package.json` declares no `firebase`
dependency while still declaring the three native packages that replaced it. That is strictly stronger
than the three assertions it supersedes, which each covered one function's behaviour. The guard strips
comments before reading, because this module documents its own removals by name, and it proves its own
extraction with positive controls so an empty or mis-pathed read cannot pass.

**G-2 — the old JS-SDK rollback target is accepted as gone.** Until F1, `lib/firebase.ts`, the browser
helper and the still-installed `firebase` package were a one-commit rollback from the Phase B/C/D
native migration; Phase D's own record said the browser code was kept partly for that reason. F1
removes that target deliberately. **Git history is the rollback mechanism** — the branch point
`f15995e` and the merge commit `fa87941` are published, so `git revert`/`git checkout` reaches the
pre-F1 state without the dead code being carried forward indefinitely.

**G-6 — M2 is CLOSED as superseded by the shipped M1 architecture.** §12's mobile-integration table,
`docs/SYSTEM_SPECIFICATION.md` §M1-vs-M2 and the roadmap's M2 note all presented native SDKs (M1) and
the `expo-auth-session` system-browser flow (M2) as an open choice. The shipped implementation is
**M1**: `@react-native-google-signin/google-signin` performs the consent, and F1 deletes M2's browser
machinery. The M2 option is therefore **not pending** and no future phase may treat it as a live
alternative for the providers already shipped. It is closed **as superseded** rather than as
rejected; the historical statements are preserved in place with dated cross-references (**G-7**), not
rewritten.

**What F1 deliberately did NOT remove, and why.** The three native packages and their `app.json`
plugins (they are what authenticates now); `EXPO_PUBLIC_FIREBASE_*` and `isFirebaseConfigured()` in
`lib/config.ts` (the native gate); the `EXPO_PUBLIC_GOOGLE_*` client IDs and `googleClientId()`;
the `inventoryai` scheme (the Phase 27 `inventoryai://reset-password` deep link);
`android.package`/`ios.bundleIdentifier` = `com.inventoryai.app`; and
**`app/+native-intent.ts` with its suite**, which is retained until F2 because the scheme entry whose
callback it intercepts (`com.inventoryai.app:/oauthredirect`) is not removed until F2 — keeping the
interceptor while the scheme exists is the stricter ordering. The server's `firebase-admin` stack is a
separate subsystem and was not touched.

**Verification.** `npm test` **30 suites / 423 tests, 0 failures**; `tsc --noEmit` and `eslint .`
clean; the server suite unchanged (no server file was touched). **F1 is verified on the EXISTING
Phase 32G development build**, because it removes no native module — a *superset* of native modules
still runs the new JavaScript. **F2 is the phase that needs a new build**, and iOS remains
`[EXTERNAL VERIFICATION REQUIRED]`.

**A finding that must be stated precisely: the JS SDK is no longer a dependency of this project, but
it is NOT absent from the installed tree.** `@react-native-firebase/app@26.4.0` — which this project
keeps on purpose, because it is what authenticates now — declares `"firebase": "12.17.1"` as a **hard
dependency**. npm therefore does not remove the package; it de-hoists it to
`node_modules/@react-native-firebase/app/node_modules/firebase`, and `npm ls firebase` still resolves
(a nested `firebase@12.17.1`). What F1 removed is the **duplicate, hoisted copy application code was
importing** (the direct `firebase@^12.19.0`, together with 45 packages of its own `@firebase/*`
subtrees). The nested copy is RNFirebase's internal dependency and is **unreachable from application
code**, which is the fact `npx expo export`/Metro resolution and the import guard both rest on: no
module under `lib/` or `app/` names it, so nothing bundles it. Anyone re-reading this later should not
expect `npm ls firebase` to be empty and should not read its output as "the removal did not work".

## 14A.10 Phase F2 — the native surface is reduced: the browser dependencies, the plugin, the second scheme and the redirect hook are REMOVED (2026-09-25)

Phase F2 is the second half of the **G-1** split and the only half that changes the **native surface**, which
is why the owner required a separate approval for it and why it is the phase that needs a new development
build. Unlike F1 it needed no preparatory step: by the time F2 began, nothing in the app reached anything it
removes. F2 was implemented in six approved sub-steps (**F2.1–F2.6**) with two verification steps (**F2.7**,
**F2.8**), each reported and accepted before the next began.

**F2.1 — the three browser packages leave the manifest.** `expo-auth-session ~57.0.12`, `expo-web-browser
~57.0.3` and `expo-crypto ~57.0.3` were removed as direct dependencies (`mobile/package.json` 24 → 21) and,
with them, `expo-application` — which was never a top-level package but lived at
`node_modules/expo-auth-session/node_modules/expo-application`, so npm pruned it naturally with its only
dependent rather than by hand. The lockfile diff is a **pure deletion (0 added / 49 removed)** with no version
churn and no unrelated package touched. **`expo-linking` deliberately stays**: it is a dependency of
`expo-router`, and it is asserted present precisely so that "delete every `expo-*` entry" cannot satisfy the
guard.

**F2.2 — the plugin leaves atomically with the package (F-1).** `app.json` declared `"expo-web-browser"` in
its plugin list, and removing the package while keeping the entry is not a warning but a hard failure —
`resolvePluginForModule` throws before any native mod runs. This was **measured, not assumed**: with F2.1
applied and F2.2 not yet, `npx expo config` **failed on the plugin**, which is the intermediate state the
owner accepted in advance. F2.2 removes the entry (plugins 7 → 6) and public config resolution returns. The
pair is now asserted on **both** sides.

**F2.3 — only the second scheme is removed (G-3).** `expo.scheme` goes `["inventoryai", "com.inventoryai.app"]`
→ `["inventoryai"]`. The retired entry, `android.package` and `ios.bundleIdentifier` are the **same literal
string**, so the plausible break is a search-and-replace that takes the two identifiers with it; both were kept
and both are asserted. `inventoryai` is kept because it is Phase 27's `inventoryai://reset-password`, so the
password-recovery deep link is unaffected.

**F2.4 / F2.5 — the redirect hook and its suite are deleted.** With the second scheme gone,
`com.inventoryai.app:/oauthredirect` has **no producer**: no configured scheme can deliver it, and the hook's
entire subject — Expo Router's spurious "Unmatched Route" over the login screen (Phase 32I-Z) — is
unreachable. `app/+native-intent.ts` (118 lines) and `__tests__/native-intent-oauth-callback.test.ts`
(126 lines, its 9 cases) are therefore removed. A module that is merely *unreferenced* is one import away
from returning, so the guard asserts the **file and the suite are absent** *and* that nothing under `lib/` or
`app/` still names the hook.

**F2.6 — the last uncovered surface, and a claim that had to be corrected rather than extended.** F1 read the
**source**, F2.1 the **manifest**, F2.2/F2.3 the **Expo config**, F2.4/F2.5 the **filesystem**. The remaining
surface is the **lockfile**: `package.json` says what the project asks for, but `npm ci` installs from
`package-lock.json`, and a resolver walks the installed tree. Writing the obvious assertion would have produced
a guard that can never pass, because **`firebase` is still in the tree**. F2.6 therefore asserts
**reachability, not absence**: the lockfile's root package declares none of the four retired packages; none is
**hoisted** at `node_modules/<name>`; any surviving occurrence must be **nested inside a package this phase
keeps**; and the kept packages must remain hoisted.

**The Firebase dependency boundary, restated exactly as verified. This is the invariant Phase F enforces, and
it is NOT "the JS SDK is absent".**

- **The root `firebase` dependency is removed** — `mobile/package.json` declares it in neither
  `dependencies`, `devDependencies` nor `optionalDependencies`, and the lockfile's root package agrees.
- **`firebase` is not hoisted** — there is no `node_modules/firebase`, in the lockfile or on disk.
- **`@react-native-firebase/app@26.4.0` legitimately retains `firebase@12.17.1` nested under its own
  dependency tree**, at `node_modules/@react-native-firebase/app/node_modules/firebase`, because RNFirebase
  declares it as a hard dependency. `npm ls firebase` therefore still resolves. **`@react-native-firebase/app`
  was not removed, altered or downgraded** — it is what authenticates.
- **The enforced invariant is resolvability from shipped code:** no module under `mobile/lib/` or `mobile/app/`
  can resolve or import the bare Firebase JS SDK, because resolution walks up from the importing file and there
  is no entry at the mobile root. That is what makes the F1 import scan *enforceable* rather than aspirational,
  and it is a stronger property than a test — the resolver itself refuses.
- **It is never to be claimed that the Firebase JS SDK is absent everywhere in `node_modules`.** It is not, and
  it cannot be while RNFirebase is installed. A future reader who runs `npm ls firebase` and sees a nested
  `firebase@12.17.1` is looking at the expected state, not at a failed removal.

**Verification, and what it does and does not cover.**

- `npx expo config --type public` — **exit 0**, stderr empty: `scheme ["inventoryai"]` (1),
  `android.package` / `ios.bundleIdentifier` both `com.inventoryai.app`, **6 plugins** (`expo-router`,
  `expo-secure-store`, `expo-camera`, `@react-native-firebase/app`, `@react-native-firebase/auth`,
  `@react-native-google-signin/google-signin`).
- **`npx expo config --type prebuild` — exit 0, which nothing before F2 had established.** It applies the
  config plugins' static config, so it exercises the plugin graph more deeply than `--type public`; six plugins
  now resolve with no plugin error on either path.
- **`npx expo config --type introspect` — still exit 1, and the sole remaining error is blocker B-1**:
  `[ios.infoPlist]: withIosInfoPlistBaseMod: ENOENT: no such file or directory, open
  '…/mobile/GoogleService-Info.plist'`, raised by the google-signin plugin's `getGoogleSignInReversedClientId`
  reading `ios.googleServicesFile`. This is the same blocker F2.0 identified and every F2 step reconfirmed;
  the `PluginError` count is 0 and no retired name appears anywhere in the output. **No plist was created and
  no native value was invented.**
- `npm install` (F2.7) is a true no-op: `package.json` and `package-lock.json` are **byte-identical before and
  after** (`a002328b…`, `f46bc21e…`), so the manifest, the lockfile and the installed tree agree.
- Retired-surface search over `mobile/lib/` + `mobile/app/` — **zero executable references** to
  `expo-auth-session`, `expo-web-browser`, `expo-crypto`, `AuthSession`, `openAuthSessionAsync`,
  `makeRedirectUri`, `useAuthRequest`, `promptAsync`, `native-intent`, `redirectSystemPath`, `oauthredirect`
  or `com.inventoryai.app`. The ten surviving text mentions (`expo-auth-session`, `googleRedirectUri`,
  `acquireGoogleIdToken`) are **all inside comments** recording the removal, and two `GOOGLE_SCOPES` hits are a
  **substring false positive** on the live `NATIVE_GOOGLE_SCOPES` constant in `lib/firebase-native.ts`.
- **Guard 59 → 77 cases**; **mobile suite 30 suites / 423 tests → 29 suites / 432 tests**. The suite count
  drops by exactly the deleted suite, and the test total is **+9 net** from two additions and two subtractions
  that must be read together: **+4** (F2.1), **+2** (F2.2), **+2** (F2.3), **−9** (F2.5's deleted cases),
  **−1** (the F1 block's per-file `it.each` walks `app/`, so deleting a file there removes one of its own
  cases), **+4** (F2.4/F2.5), **+7** (F2.6). `tsc --noEmit` and `eslint .` are clean throughout.
- **Every new assertion was proven able to fail before being trusted.** F2.4/F2.5: two injected probes (a
  `lib/` module naming the hook, and a recreated `app/+native-intent.ts`) → **2 failed**; probes removed →
  green. F2.6: three lockfile mutations (root declares `expo-web-browser`; `expo-crypto` hoisted; `firebase`
  nested under a non-kept package) → **3 failed**; lockfile then restored **byte-identically** to `f46bc21e…`.

**What F2 does NOT verify, and what remains.** F2 removes a native module, a native config plugin, a URL scheme
and an Android intent-filter, so **the existing Phase 32G development build cannot prove the reduced surface**
— risk **F-3** from the moment F2 was planned. Every F2 result above is therefore **config-verified, not
native-verified**; `introspect` is blocked by B-1 and the host is Windows, so the native consequences land with
the **F2.9 development build**, the only remaining F2 step. **iOS is still `[EXTERNAL VERIFICATION REQUIRED]`
(F-6)** — no iOS build exists for this project and none can be produced on this host.

**F2.9's target is decided: the LOCAL LAN BACKEND, not Render.** The development build must reach an API it can
actually talk to, and the Render service is a free-tier instance with cold starts; `mobile/lib/config.ts` would
otherwise fall back to the emulator-only `http://10.0.2.2:4000`. `EXPO_PUBLIC_API_URL` is therefore to be pointed
at the host's LAN address for the F2.9 run. The `development` profile still declares no `env`, so this is a
build/run-time decision and not a committed value.

**Carried forward, unchanged.** The **Render free-tier cold-start limitation** is accepted as a known V1 QA
limitation, with no plan or instance change proposed or made. The **F1 device smoke test remains deferred** —
the test device had no LAN route to the host, and a pre-existing unresponsive Metro process on port 8081 forced
a secondary port; neither condition is touched by F2.

## 14A.11 Phase F2.9 — the EAS development build and the Android runtime/native verification (2026-09-25)

Phase F2.9 is the step §14A.10 left open, and it closes the **F-3** and **F-6** verification gaps for Android. It
is an **EAS build plus a runtime verification**, and — like every other step in Phase F — it changed no source or
configuration file.

**The build.** `eas build --profile development --platform android` produced build
**`f3038fa1-1cab-476e-b0f9-d6a9178f955b`**, status **`FINISHED`**, profile **`development`**, platform
**Android** (`distribution: internal`, `android.buildType: apk`), created `2026-09-25T14:34:03Z` and finished
`2026-09-25T15:27:59Z` (≈40 min EAS free-tier queue + ≈12 min build). The EAS-managed keystore was **reused,
not created** (`Build Credentials 84JNqqnITp`), and the version code was minted server-side, so `app.json` was
never dirtied. Artifact:
`https://expo.dev/artifacts/eas/20nq60ekWSx40s8u9Cm_Y3mzjXhxpU8yOEmfe7X_qco.apk`. The build record displays
`gitCommitHash: 2ec35b8a…` (Phase F1) — **and that display is misleading**: EAS Build uploads the **working
directory**, not the commit (expo/eas-cli issue #3831: "*EAS just uploads your working directory as is*").

**The working tree is proven, not assumed, to be what was built — and this is the finding that makes the whole
verification valid.** The new build's fingerprint is **`d16abc4e7df419812e73598db676985be3606dc7`**, and
`eas fingerprint:generate --platform android` run on the current working tree returns **exactly the same hash**.
Because F2 removed dependencies from `package.json` and changed `app.json` — both fingerprint inputs — a build
of committed HEAD would necessarily have hashed differently. The uncommitted F2 tree is therefore what EAS
compiled, so F2.9 verifies **F2** rather than its predecessor.

**The runtime verification.** The APK installed successfully on the Android emulator **`emulator-5554`** (AVD
`InventoryAI`; **SDK 35**, **x86_64**), as an in-place upgrade over the 2026-09-24 build. The app **launched
successfully** — `ReactNativeJS: Running "main"`, `ExpoModulesCore ✅ JSI interop was installed` — and the
**`FATAL EXCEPTION` / `AndroidRuntime: FATAL` count for the whole session was 0**. The login screen rendered in
full (`Welcome back`, `Email *`, `Password *`, `Sign In`, `Forgot password?`, `Continue with Google`,
`New to Inventory AI? Create an account`).

**The F2 native surface is Android-runtime VERIFIED**, on four independent kinds of evidence:

- **Registered schemes** (installed-package dump): `com.inventoryai.app` is **absent**. The app's own scheme is
  `inventoryai`, alongside only framework/dev-client schemes contributed by Expo and the Google Sign-In
  libraries (`exp+inventory-ai`, `expo-dev-launcher`, `genericidp`, `recaptcha`).
- **Intent resolution:** `inventoryai://reset-password?token=…` **resolves to
  `com.inventoryai.app.MainActivity` and renders the full "Set a new password" screen**, so the retained Phase 27
  recovery route works at runtime. `com.inventoryai.app:/oauthredirect` answers **"unable to resolve Intent"**
  and `am start` fails outright — the retired callback is **unresolvable at the OS level**, and no browser or
  WebView opened.
- **APK dex inspection:** `expo/modules/webbrowser` **0**, `WebBrowserModule` **0** and `oauthredirect` **0**,
  while the kept native modules remain — `expo/modules/securestore` 139, `expo/modules/camera` 469,
  `io/invertase/firebase` 210, `com/reactnativegooglesignin` 50 and `com/google/firebase` 1276. **RNFirebase and
  native Google Sign-In remain**, and no `expo-web-browser` native surface survives in the artifact.
- **A real local-backend round trip:** submitting the login screen's "Send reset link" rendered **"Password
  reset is temporarily unavailable. Please try again later."** — which is
  `server/src/controllers/passwordReset.controller.ts`'s `MAIL_NOT_CONFIGURED_MESSAGE`, returned as the designed
  pre-lookup **503**, and which exists **nowhere** in the mobile app. The client therefore reached the backend
  and rendered the server's own copy. **Render was not used** at any point.

**The API/runtime nuance, recorded because the two paths differ.** The **EAS-built APK** itself carries the
expected development configuration behaviour around `http://10.0.2.2:4000` — the `development` profile declares
no `env`, and `.env` is excluded from the archive by `.easignore`. But a development build **loads its
JavaScript from a local Metro bundler**, and Metro loads the local `.env`, so the path actually exercised during
verification used the **private LAN backend address** rather than the emulator alias. Both are **local**, and
**neither is Render** (`onrender.com` appears 0 times). The build's stated target decision — local backend, not
Render — is satisfied on both paths; the private address is deliberately not reproduced in this document.

**Authentication status — the distinction is preserved, and no PASS is manufactured.** F2 changed **no
authentication logic**, and the following are **pre-existing environment limitations, not F2 failures**:

- **Email/password — PARTIAL.** The path **executes**: logcat shows the native Firebase SDK receiving
  `signInWithEmailAndPassword` (the Phase 32E Firebase-first flow). It failed with `lib/firebase-auth.ts`'s
  `DEFAULT_FAILURE_MESSAGE`, and the client correctly **did not fall back** to the legacy password route — the
  designed no-downgrade property. A successful sign-in requires a **live Firebase project and valid
  credentials**, neither of which this environment has ever had.
- **Native Google Sign-In — BLOCKED.** The native module is present and the button renders
  (`RNGoogleSigninButtonViewManager`), but the consent flow requires a live Firebase project.
- **Firebase → backend exchange — BLOCKED** (it needs a Firebase ID token).
- **Inventory AI JWT/session — BLOCKED** (it depends on the two above).
- **Firebase logout / session teardown — BLOCKED**, because no authenticated session can be created for it to
  tear down.

**iOS remains `[EXTERNAL VERIFICATION REQUIRED]`.** No iOS build can be produced on this Windows host, so the
`ios-simulator` profile stays unexercised. F-6 is unchanged and is **not** closed by F2.9.

**Provenance — what the verification did and did not touch.** During runtime verification **no source or
configuration file was changed**, **no EAS environment variable was changed**, **no Firebase service file was
created locally**, **no API URL was changed**, and **no commit or push occurred**; all five protected
working-tree files were unchanged before, during and after. Verification used a Metro bundler started on a spare
port because the pre-existing Metro on 8081 was unresponsive and the one on 8082 was unreachable — **neither
process was killed**. A physical device was attached to the host for the whole run and was **not** used: every
command targeted `emulator-5554` explicitly.

**EAS build-history correction (append-only; no historical record is rewritten).** EAS's own list holds **six**
Android builds, all `FINISHED`, of which **five** are `development`. Two of them —
**`28b9a4e2-406e-4269-bc98-12da3454b58c`** (2026-09-22, commit `6bac86e`) and
**`3cd7fae4-66d8-48be-88d0-a305b86c8c93`** (2026-09-24, commit `9917447`) — do not appear in the phase records
held at the time of this audit. Phase 32G's "three Android builds" was accurate as of 2026-09-20; F2.9 is
therefore the **sixth** Android build and the **fifth** development-profile build, not the fourth. Earlier
statements are **superseded, not rewritten**.

**Superseded statements.** §14A.10, `docs/DEVELOPMENT_ROADMAP.md` §27O and the `CLAUDE.md` Phase F2
cross-reference each recorded that **F2.9 had not been created** and that F2 was therefore config-verified only.
Those statements were true when written and are **superseded by this section** — the F2.9 EAS build and the
Android runtime verification above. They are preserved as the historical record they are.

---

## 14B. Phase 32H — the server-side linking boundary (implemented)

Phase 32H implements the **server half** of §14A.4 and deliberately nothing else. The question it
answers is exactly one: *may this authenticated Inventory AI account carry this verified Firebase
identity?* The provider half — obtaining a Google or Facebook credential, and Firebase's own
`linkWithCredential` against the signed-in Firebase user — is performed by the **Firebase client SDK**
and is not a server operation at all. No fake server-side provider-linking call was invented to
"complete" it.

### 14B.1 The route

```text
POST /api/auth/firebase/link          AUTHENTICATED (requireAuth + controller, no permission)
body:  { idToken }                    -> 200 { linked: boolean, user }
```

`validateFirebaseLink` reads `idToken` and **returns only `{ problems, idToken }`**, which is the
structural half of the whole design: the handler holds no variable that could carry a client-supplied
`userId`, `businessId`, `firebaseUid`, `role` or `status`, so those keys are inert rather than
validated-and-rejected. There is no check that could be deleted.

- **The account is `req.user.id`** — put there by `requireAuth` from the MongoDB document the caller's
  own session resolves to. The authenticated session *is* the ownership proof (§14A.4); requiring it
  is not a convenience, it is the evidence that was missing in the exchange's email-collision refusal.
- **The identity is `verifyFirebaseIdToken(idToken).uid`** — narrowed from a token whose signature
  Google verified. It is never read from the body.
- **`businessId` comes from `req.user`**, and the service never writes the field, so the route can
  neither reach across tenants nor move an account between them.
- **No rate limiter.** No authenticated route in the application is rate-limited today; adding one
  would mean a new limiter factory and config entry, which is out of this phase's scope. The route is
  bounded by the session it requires.

### 14B.2 The four lifecycle cases, in the order that matters

Decided in `server/src/services/firebaseLink.service.ts`. CASE A and CASE D are answered from the
**account's own** `firebaseUid` before the identity is looked up at all, so an account that already
owns an identity never has its own mapping queried, compared or replaced.

| Case | Condition | Outcome |
| --- | --- | --- |
| **A** | same identity, same account | **Idempotent success.** `linked: false`. No write, and **no audit row** — recording an event that did not happen is a false trail. |
| **D** | this account already owns a *different* identity | `409 FIREBASE_IDENTITY_CONFLICT`. Never silently replaced: swapping the mapping would hand the incoming account's holder a sign-in to this user. Decided before the lookup, so it costs no query. |
| **B** | the identity belongs to *another* MongoDB user | `409 FIREBASE_IDENTITY_CONFLICT`. **Never merged, never transferred.** The account that holds it keeps it untouched. |
| **C** | the identity belongs to nobody | Attached — safe only because the caller has already proved they own this account. |

**The email is never a join key in any of the four.** It is not compared against the account's, not
used to find an account, and not used to resolve a conflict. R-4/R-9 in force — and it is what makes
R-10 work: a provider that supplies no address links exactly as well as one that does.

**Concurrency is the database's problem, not the check's.** Attachment is ONE conditional update
(`{ _id, firebaseUid: null }` — which matches null or absent), so a second link racing the first
matches nothing rather than replacing an identity set microseconds earlier. The `firebaseUid` unique
index is the last line of defence behind the CASE B pre-check: the loser of a race sees E11000 and is
mapped to the *same* conflict, because reporting it as anything else would be the "auto-resolve a
compromised mapping" behaviour §7.4 forbids. A lost race re-reads and re-dispatches to CASE A or CASE D
rather than assuming.

### 14B.3 Error and audit hygiene

- **One `409` for CASE B and CASE D**, one code (`FIREBASE_IDENTITY_CONFLICT`), one generic message
  naming no account, tenant, role or Firebase UID. Telling the two apart would describe a mapping the
  caller may not be entitled to see.
- **The conflicting UID never enters the audit row.** The audit viewer is readable by every ADMIN of
  the business, and in CASE B that UID may name a person in a *different* tenant. The audit records a
  `reason` from a closed set; the UID goes to the server-side structured log, which no tenant can read
  — the standing `firebase_identity_collision` precedent.
- **The success row records `{ passwordCredentialRetained: boolean }`** and no UID. That flag is
  informational only: it marks the exact state whose `change-password` / reset disposition is O-2
  below, so an operator investigating has a start point.
- **A refused link does not revoke sessions.** Revoking would not undo the link (the attacker simply
  signs in again), so it would be behaviour invented for no security benefit.
- Two audit actions were added: `FIREBASE_IDENTITY_LINKED` and `FIREBASE_IDENTITY_LINK_CONFLICT`. The
  brief's other candidates — attempted cross-business linking, attempted role manipulation,
  unauthenticated linking — have **no emission site and cannot have one**: the payload carries no
  `businessId` or `role` to attempt them with, and `requireAuth` refuses an unauthenticated caller
  before any handler, so there is no `businessId` in scope to attribute a row to. Inventing rows for
  them would mean recording events the code cannot produce.

### 14B.4 What is deliberately NOT in Phase 32H

Google Sign-In UI · Facebook Login UI · Apple Sign-In · provider SDKs (none installed) · OAuth redirect
flows · Expo provider configuration changes · provider buttons · invitation UI · payment or
subscription changes · bulk Firebase migration · `auth:import` · unlink (any form) · any change to the
Firebase exchange contract · any weakening of the §14.1 password-authority guard.

### 14B.5 §15 finding — the password reset / `change-password` defect

**Inspected, documented, and deliberately not changed.** For an account carrying a `firebaseUid`, the
§14.1 guard means the retained bcrypt hash no longer authenticates anyone. Consequences, stated
exactly:

| Endpoint | Behaviour on a linked account |
| --- | --- |
| `POST /api/auth/change-password` | Validates the *current* password against the bcrypt hash, writes a new hash, stamps `passwordChangedAt` — which revokes every session. The user is signed out and the credential that authenticates them (Firebase's) is untouched. Reports success. |
| `POST /api/auth/forgot-password` / `reset-password` | Mails a link and rewrites the bcrypt hash. Same outcome: a successful-looking reset that does not change what signs the user in. |

**Whether the linking boundary interacts with this defect: it does, and only by making the population
reachable.** Before Phase 32H no code path wrote `firebaseUid` onto an existing password account, so
the state was theoretical. It now exists. **No behaviour was changed**, because the brief forbids
inventing a new password-reset policy and the disposition is already recorded as open (O-2). Changing
these endpoints without deciding the policy would settle by accident what is meant to be decided on
purpose. **O-2 is escalated by this phase from "blocks a future phase" to "a live defect", and the
final decision remains a separate explicit hardening item.**

### 14B.6 §16 finding — unlink and last-authentication-method

**Nothing was implemented and nothing was changed.** Unlinking remains client-side Firebase-only, the
server still cannot observe it, and Firebase's "last provider" protection is still unaware of a
retained `passwordHash` — so an account can be password-linked (Firebase refuses no unlink that matters
here) only insofar as Firebase's own rules allow. **O-1 is unchanged and still open**, and Phase 32L
remains the phase that owns it. Phase 32H added no unlink route, no unlink service and no unlink
audit action.

> **Superseded 2026-09-26 (Phase 32L — see `docs/DEVELOPMENT_ROADMAP.md` §27Q).** This subsection is the
> Phase 32H record and is not rewritten. Phase 32L subsequently shipped the unlink capability it records
> as absent — `POST /api/auth/firebase/unlink`, `requireAuth` + controller with no permission — under
> **Policy B**, which is the last-authentication-method invariant made structural: an account may leave
> Firebase authority only by establishing a **new local password in the same transition**, and the
> retained hash is replaced rather than re-enabled. **The "Firebase refuses the last provider" premise in
> this subsection was also refuted by runtime measurement, and the two measurements are separate facts:**
> the **last-provider** measurement saw the unlink **succeed on the account's final provider and leave the
> Firebase account with zero providers** — the refutation — while the separate **390-second** measurement
> saw a provider unlink **accepted** at an authentication age where `updatePassword` was **refused**, a
> finding about *recency*. That is why the protection is enforced **server-side and never delegated to
> Firebase**. `O-1`'s row in §14A.5 carries the same dated annotation.

> **Superseded again 2026-10-01 (Phase A / F-1 — `6e2252f`).** The capability the note above records as
> shipped **no longer exists**: `POST /api/auth/firebase/unlink`, `firebaseUnlink.service.ts`, the controller
> handler, the payload validator, both audit actions and the mobile API wrapper were **removed, not
> deprecated**, and the operation was re-scoped into a **credential change** (Firebase `updatePassword` →
> the credentials-changed bridge). The measurements that note records — the last-provider refutation and the
> 390-second recency finding — remain historical facts about Firebase and are **not** rewritten; Policy B's
> *server-side* unlink path is simply no longer reachable, because the path is gone. See
> `CLAUDE.md`'s committed Phase F-1 correction and `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` §8.

### 14B.7 Verification

`server/test/phase32h-firebase-linking.test.mjs` — one unit suite (no database) and one DB-backed
suite over the real `app.ts`, **25 tests**, registered in `MIXED` in `scripts/run-tests.mjs`. The
brief's twelve required invariants are covered, including the ones that are easy to assert vacuously:
the payload returns only `{problems, idToken}`; a planted identity/tenant/role is inert; the token
email is never compared; CASE B and CASE D are indistinguishable to the caller; a rejected Firebase
token is a **400** and the caller's session survives it; an unconfigured server answers 503; the §14.1
guard is intact and is made *live* by linking; and two accounts racing for one identity produce exactly
one winner. `phase23-authorization-contract.test.mjs` declares the new route in its `AUTHENTICATED`
bucket.

**Every assertion was proven able to fail before being trusted**, by a mutation pass over the service,
the controller and the validator: seven mutations — removing each of the two doubly-enforced guards
(CASE D, CASE B), flipping the link route's 400 to a 401, making email a join key, adding the UID to
the success audit row, making CASE A non-idempotent, and making the validator return a client-supplied
`businessId` — were each applied to a pristine copy and each produced a red test. Two of those were
**doubly enforced** and only fell when *both* layers were removed: CASE D by the guard and by the
conditional update's `firebaseUid: null` filter, CASE B by the pre-check and by the unique index's
E11000. That is a finding worth keeping: removing either layer alone leaves the property intact, which
is what "defence in depth" means here rather than a redundancy to be tidied away.

---

# 14C. Firebase-Only Authentication Architecture (DESIGN LOCKED, NOT IMPLEMENTED)

**Recorded 2026-09-29. Documentation only.** No code, dependency, schema, environment variable,
Firebase Console setting, EAS configuration or deployment change was made for this record, and none
may be inferred from it.

**Phase identifier.** This record uses **Phase 32N**. The number is *assigned by this section* rather
than inherited from a pre-existing schedule — `32M` is not a phase in this repository, and the
`*(planned)*` rows in §21 are left exactly as they stand. If the owner prefers another identifier the
record is renumbered rather than split.

**What this section is, and what it is not.** Everything above (§§14/14A/14B) records an *additive*
migration: Firebase was added beside a working legacy password path, and that path was deliberately
preserved (§10) as the rollback mechanism. This section records the **opposite direction — the
deliberate retirement of the legacy path**. It is a decision record, and **nothing named here as
REMOVE has been removed**: every endpoint, service, model, screen and mail module it lists still
exists and still behaves exactly as §§14.1, 14B.5 and the roadmap describe.

**Premise fixed by the owner, and its consequences.** All current MongoDB users are **mocked
development/test data**. **No legacy-user migration, backward-compatibility layer or bulk
`auth:import` is designed, and none is to be built.** Two consequences are deliberate and are recorded
rather than discovered later: §9.3 (bulk-import risks) and **§18 Gate 1** (`auth:import` bcrypt
support) cease to be live concerns; and the unhealable-orphan problem (§16.6, **O-6**) does not arise
for this population, because no pre-Firebase identity has to be reconciled with a Firebase one.

---

## 14C.1 The locked decisions

Nineteen decisions are locked by the owner. They are numbered so tests, phases and future audits can
cite them individually.

| # | Decision |
| --- | --- |
| **L-1** | **Firebase owns Email/Password authentication.** |
| **L-2** | **Firebase owns Google authentication.** |
| **L-3** | **Firebase owns password reset/recovery.** |
| **L-4** | **Firebase owns email verification.** |
| **L-5** | **Firebase owns password changes.** |
| **L-6** | **Email/password users must have a verified email before entering the main app.** |
| **L-7** | **Google users are treated as verified according to Firebase's identity state** — i.e. the signed `email_verified` claim, **not** "Google is always verified". A Google identity whose claim is false is **not** verified. |
| **L-8** | **The Inventory AI JWT + server-side session MUST remain.** Firebase does not replace backend authorization or session management. |
| **L-9** | **MongoDB remains authoritative for `businessId`, `role`, `status`, permissions, business lifecycle and tenant isolation.** |
| **L-10** | **Legacy bcrypt login and register will eventually be removed.** |
| **L-11** | **Custom password-reset tokens, the reset endpoints and the mail infrastructure behind them will eventually be removed.** |
| **L-12** | **Admin-created password accounts must eventually be replaced by invitation-based Firebase onboarding.** |
| **L-13** | **The Inventory-specific Firebase link/unlink lifecycle should eventually be removed or re-scoped.** Firebase-native provider linking may remain where appropriate. **Done in part, 2026-10-01 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`):** the server-side **unlink** half was **removed and re-scoped** into a credential change (roadmap §27AA); the link route and the Firebase-side provider linking remain as this item describes. |
| **L-14** | **Before Firebase-native password recovery or change-password ships, a secure credential-change notification/revocation bridge must be designed** so a Firebase password change can invalidate existing Inventory AI sessions. Design: **§14C.3**. |
| **L-15** | **The bridge must not trust an arbitrary Firebase UID from the client.** It must be authenticated and securely tied to the verified Firebase identity. |
| **L-16** | **The bridge must avoid immediately invalidating the newly created Inventory AI session after a credential change.** |
| **L-17** | **Firebase action-link/deep-link routing using the existing `inventoryai` scheme must be verified on a real device against a live Firebase project** before recovery is considered complete. Protocol: **§14C.4**. |
| **L-18** | **Business authorization must not be moved into Firebase custom claims as the primary authority.** |
| **L-19** | **Review the current `checkRevoked = false` verification behaviour** and document whether it should remain or change, with the security and operational tradeoff. Review: **§14C.5**. **RESOLVED — the review's recommendation was not adopted:** **AUTH-01** sets `checkRevoked: true`, per the approved target architecture §9/§10. §14C.5 is retained as the review record; see its supersession note. |

**The word "eventually" is load-bearing in L-10 to L-13.** None of these is a removal instruction for a
single phase, and the project's conventions forbid silent deletion (§14B.5, §16.6). Each removal is a
separate, approvable step with its own test reconciliation — see §14C.6.

---

## 14C.2 The target architecture, and the one line that actually moves

```text
Mobile ── Firebase SDK ──► Firebase Auth   (email/password · Google · reset · verification · password change)
   │
   └── POST /api/auth/firebase/exchange     ← the ONLY session entry point
            │
            ▼
   Firebase Admin verify  — 5-field narrowed identity
                            (uid, email, emailVerified, signInProvider, authTime)
            │
            ▼
   MongoDB User  — businessId · role · status · permissions · business lifecycle   ← UNCHANGED AUTHORITY
            │
            ▼
   Inventory AI JWT + server-side session (mandatory `jti`)                         ← UNCHANGED, load-bearing
            │
            ▼
   requireAuth → RBAC → tenant isolation → route
```

| Concern | Owner after migration | Moves? |
| --- | --- | --- |
| Password / email / provider identity | Firebase | — (already true for a Firebase-linked account) |
| `userId`, `businessId`, `role`, `status`, permissions | MongoDB, server-derived | **No** |
| Tenant isolation, business lifecycle, billing | MongoDB, server-derived | **No** |
| API bearer credential, revocation, sessions | Inventory AI JWT + `sessions` | **No** |
| **Password *change* notification to Inventory AI** | **Inventory AI — new bridge** | **NEW (§14C.3)** |

### Why L-8 is not negotiable, in one paragraph

`server/src/middlewares/authenticate.ts` is the single authentication choke point, and it does four
things Firebase does not and cannot: it loads the `User` from MongoDB **on every request**, so a `role`
or `status` change takes effect on an already-issued token (the Phase 24 effect proof); it refuses a
token whose `jti` names no live `sessions` row (Phase 26A per-device revocation); it compares the
token's `iat` against `passwordChangedAt` and answers `401 SESSION_INVALIDATED`; and it calls
`assertActiveBusiness`. Because the Firebase ID token is never the API bearer credential (`checkRevoked` is `true` as of **AUTH-01** — §14C.5), Firebase **cannot** revoke an
Inventory AI session — disabling or deleting a Firebase user does not stop their API access. MongoDB
`status` does. Deleting the session layer would delete revocation itself.

### L-18 in force

**No Firebase custom claim is introduced, read or trusted.** `businessId`, `role` and `status` continue
to come from the loaded MongoDB `User` document. A claim would be a *second* authority free to
disagree with the first, and it would have to be re-synchronised on every role change, every status
change and every ADMIN↔ADMIN restriction Phase 14A enforces — a new class of failure in exchange for
nothing. `firebaseUid` remains an **identity linkage field, not an authorization source**.

---

## 14C.3 The credential-change / session-revocation bridge (L-14, L-15, L-16)

### 14C.3.1 The problem, stated exactly

A Firebase-native password reset (`confirmPasswordReset`) and a Firebase-native password change
(`updatePassword`) both complete **entirely inside Firebase**, on the client. The Inventory AI server
never observes either. Four facts then combine into a real defect rather than a tidiness issue:

1. `passwordChangedAt` is the **only** mechanism that invalidates existing Inventory AI sessions on a
   credential change (`middlewares/authenticate.ts`: `iat < changedAtSec → 401 SESSION_INVALIDATED`).
2. A Firebase-native reset or change never stamps it.
3. Firebase cannot invalidate Inventory AI sessions by itself: the ID token is never the bearer credential, and `checkRevoked` (now `true` — **AUTH-01**, §14C.5) consults revocation at verification without ending an Inventory AI session.
4. `sessions` rows are only revoked by an explicit call.

**Result without a bridge: every session that existed before the password change survives it** —
including a session an attacker opened with the compromised password. That inverts the purpose of the
reset. Today's 26B/27 flow does not have this hole precisely because it stamps `passwordChangedAt` and
calls `revokeAllSessions` on the server. **This is the open item O-9 becoming live**, and L-14
forbids shipping Firebase-native recovery before it is designed.

> **Added 2026-09-29 (Phase 32P — §14C.3.8).** The *reachability* consequence of these facts — that the
> primary password-**reset** flow begins with **no** Inventory AI session and therefore cannot call a
> `requireAuth` route at all — is **D2**, and it is now **RESOLVED**: the reset path establishes a
> **recovery-context session** through the public exchange, calls the bridge, and then re-exchanges to a
> final session. This paragraph is the original record and is **not** rewritten.

### 14C.3.2 The proposed endpoint

**`POST /api/auth/credentials-changed`** — **AUTHENTICATED** (`requireAuth` + controller), **no
permission**.

Self-service, for the same reason `POST /api/auth/logout`, `GET /api/auth/sessions` and
`DELETE /api/auth/sessions/:id` carry none (Phase 26A): the subject is `req.user.id`, the caller's own
account, and no catalogue key can express "may acknowledge a change to my own credential" without
inventing an authorization concept the catalogue does not have. It is the same shape
`POST /api/auth/firebase/link` uses in Phase 32H.

Request body: `{ idToken }` — a **fresh Firebase ID token**, taken from the live Firebase session that
the credential change just produced. The validator returns only `{ problems, idToken }`; it returns no
`userId`, no `businessId`, no `firebaseUid` and no `role`, so a body carrying any of them is **inert by
construction** rather than validated and rejected — the Phase 32H argument, reused deliberately rather
than re-derived.

Response: `{ changedAt }`. Never a uid, never a session, never a token.

### 14C.3.3 The check order, and why each position is load-bearing

1. **Verify the ID token** — `verifyFirebaseIdToken(idToken)`, the only place an identity enters. A
   rejected token is a **`400`**, not a `401` (Phase 32H's rule): `mobile/lib/client.ts` treats a
   `401` **or** `403` on a token-bearing request as session loss, so a bad *Firebase* credential must
   not sign the user out of Inventory AI.
2. **Load the caller's account** — `User.findById(req.user.id)`. The account is never named by the
   request.
3. **★ Bind the identity to the account (L-15).** The verified uid **must equal** `user.firebaseUid`.
   On mismatch: refuse with a `409` carrying one generic code and a message that names no account,
   tenant, role or uid — and **write nothing**. Without this step the endpoint would let any caller
   holding *some* Firebase identity revoke *someone else's* Inventory AI sessions. This is Phase 32L's
   STEP 4 mismatch rule, reused.
4. **★ Require a recent authentication (L-15, second half).** `authTimeIsFresh(identity.authTime, now)`
   and `FIREBASE_REAUTH_WINDOW_SECONDS` (300 s) from `server/src/constants/firebase.ts`, checked from
   the **signed `auth_time` claim** and never from `iat`. A credential change is by definition a recent
   authentication, so an honest client always satisfies this; a long-lived stolen token does not. The
   check **fails closed** on an absent claim. Nothing has been mutated at this point.
5. **Acknowledge the change** — stamp `passwordChangedAt = now` and call
   `revokeAllSessions({ userId, businessId, now })`, exactly the two things 26B-2's
   `resetPassword` and Phase 32L's unlink already do. `revokeAllSessions` closes the same-second hole
   that the integer-second `passwordChangedAt` comparison cannot, and keeps `GET /api/auth/sessions`
   honest.
6. **Audit, best-effort**, through the existing `recordAudit` path: one action, and metadata carrying
   `{ reason: 'credential_changed' }` and **nothing else**. No uid — the audit viewer is readable by
   every ADMIN of the business, the standing 32H/32L precedent. No token, no password, no hash.

**This is why L-15 is satisfied twice over, by two independent facts.** The caller must hold a live
Inventory AI session **and** present a verified Firebase credential whose `auth_time` is inside the
window **and** whose uid is the one already attached to that session's account. No single stolen
artefact satisfies all three, and no value the client can type is one of them.

### 14C.3.4 Ordering — and why L-16 forces it

The naive ordering is broken. If the bridge stamps `passwordChangedAt` and revokes everything while
the client is still holding the session it just used, **that session dies instantly** and the user is
thrown back to Login immediately after changing their password — the exact outcome L-16 forbids.

The correct order is **bridge first, then exchange**, and it is *forced by the existing code* rather
than merely asserted:

```text
1. Firebase        confirmPasswordReset()  or  updatePassword()          credential actually changes
2. Inventory AI    POST /api/auth/credentials-changed  { idToken }       requireAuth, using the OLD session
3.                  → passwordChangedAt = now ; revokeAllSessions()      every session dies
4. Inventory AI    POST /api/auth/firebase/exchange    { idToken }       PUBLIC — needs no session at all
5.                  → new Inventory AI JWT whose iat >= changedAtSec      the ONE live session
6. Client           replaces its stored session                          user stays signed in
```

Three properties make this work, and none of them is a coincidence:

- **Step 2 is still admitted** because `requireAuth` rejects only tokens minted **strictly before** the
  stamp (`iat < changedAtSec`), and the stamp happens *inside* step 2. The request that performs the
  change is therefore never self-defeating.
- **Step 4 needs no session.** `POST /api/auth/firebase/exchange` is a **PUBLIC** route with no
  `requireAuth`, so the revocation in step 3 cannot block it. This is why the existing exchange is the
  right re-entry point and why no second session-minting path is needed.
- **Step 5 is automatically valid.** A token minted after the stamp has `iat >= changedAtSec` and is
  never caught by the comparison. The same property 26B-2 already relies on when it tells a reset user
  to sign in again.

**The bridge therefore composes with sign-out-everywhere instead of fighting it** — and it costs no
password, because the Firebase session is still live and the exchange needs only the ID token.

### 14C.3.5 Idempotency, and the one hazard this design adds

**Semantics: the endpoint is a statement about the credential, not an imperative, and it is *not* a
retryable idempotent call.**

- The *effect* is idempotent in the state it produces: after step 3 the account has a stamped
  `passwordChangedAt` and zero live sessions, and a second call produces the same state again.
- A second call is **not** a harmless no-op, and pretending otherwise would be wrong. It stamps a
  *later* time and revokes everything again — so a replay *after* step 4 would kill the brand-new
  session too. Named: `POST /credentials-changed` is sent **exactly once per credential change**, and a
  client that sends it twice is claiming the credential changed twice. That is honest rather than
  clever, and it is the rule the implementing phase must write down.

**★ The hazard, recorded rather than hidden.** If step 2's response is lost and the client retries it,
that retry arrives with the **old** token, whose `iat` is now strictly earlier than the
`passwordChangedAt` stamped by the first attempt — so `requireAuth` answers `401 SESSION_INVALIDATED`.
The correct recovery is **not** to retry step 2. It is to treat `401 SESSION_INVALIDATED` from this
endpoint as **success-equivalent** ("the change was already acknowledged") and proceed to step 4,
because the acknowledgement is already durable and the only thing still missing is a fresh session.
**This is the single subtle rule this design adds, and it must be pinned by a test in the implementing
phase** — one that forces the first-attempt response to be dropped and asserts the client reaches step
5 signed in.

### 14C.3.6 Alternatives considered, and why they were rejected

| Option | Why not |
| --- | --- |
| **Public endpoint keyed only on a verified ID token** | Collapses a stolen Firebase credential into an Inventory AI **denial-of-service** against that account, because a fresh ID token for an account would be enough to kill its sessions. It also contradicts L-15's intent: a Firebase identity alone is **not** sufficient authority over an Inventory AI session. |
| **A Firebase Cloud Function / Admin-SDK trigger on credential change** | Requires deploying a Functions runtime — a new infrastructure surface with its own secrets, cost and operational model — which this repository has never had and no phase authorises. It also cannot be verified offline. |
| **Do nothing; rely on Firebase-side revocation** | Impossible: an ID token is never the API bearer credential, so `requireAuth` never sees one — and `checkRevoked` (now `true`, **AUTH-01**) consults revocation at verification, which still revokes no Inventory AI session. |
| **Drop `passwordChangedAt` and accept long-lived sessions after a reset** | Directly contradicts L-14 and the purpose of a reset. Would have to be an explicit owner acceptance, and it is not proposed. |

### 14C.3.7 What the bridge deliberately does NOT do

- It does **not** change the credential. Firebase did, before step 2.
- It never reads, compares or uses `email`.
- It writes exactly two things — `passwordChangedAt` and the `sessions` rows through
  `revokeAllSessions`. It **cannot** move an account between businesses, change a role or change a
  status, because no code path writes those fields.
- It does **not** attempt to report *which* credential changed (password vs provider). A client is not
  a trustworthy source for that and Firebase does not hand the server such a fact, so claiming to know
  would be inventing one.
- It is **not** the user's manual "sign out everywhere". `POST /logout` with `{ all: true }` and
  `DELETE /sessions/:id` (Phase 26A) remain exactly as they are; the bridge is the **automatic**
  consequence of a credential change.
- **No rate limiter.** This follows the project's standing rule that **no authenticated route is
  limited** (recorded for Phase 32H's link route and Phase 32L's unlink route). The endpoint is bounded
  instead by the 300 s freshness window, a live session, and a uid that must already be attached to
  that session's account. Recorded explicitly so a future auditor does not read the absence as an
  oversight.

### 14C.3.8 The recovery-context caller — ★ D2 RESOLVED (2026-09-29)

**The gap, stated exactly (D2).** §14C.3.2 and §14C.3.3 require the bridge to be called under
`requireAuth` — by a caller holding a **live Inventory AI session** — and that requirement is correct
for the in-app password *change*, where the caller is signed in. It is **unsatisfiable in the primary
password-*reset* flow**: `forgot-password` and `reset-password` are **PUBLIC** screens outside `(app)`,
the reset completes entirely inside Firebase, and the reset screen calls `clearSession()` before
returning to Login (Phase 27, N-3). So at the instant the password has actually changed the caller
holds **no** session and **cannot reach the bridge** — which means a Firebase-native reset would revoke
**nothing**, leaving every prior session (including one an attacker opened with the compromised
password) alive. That is precisely the hole §14C.3.1 exists to close, and until this record the design
did not say how the reset path escapes it. **This is D2. It was raised in the N-4 preflight, it was
previously undocumented anywhere in this repository, and it is now closed for the primary reset flow.**

**The resolution is not to relax the bridge's authentication, but to establish an authenticated context
first.** The owner-approved recovery sequence is locked as follows — and every step uses an endpoint
that already exists or is already designed:

```text
1  Mobile        Forgot Password (PUBLIC screen, outside (app))
2  Firebase      sendPasswordResetEmail → the user opens the emailed link
3  Firebase      confirmPasswordReset(oobCode, newPassword)     credential changes INSIDE Firebase
4  Mobile        signed out; local session cleared; back to Login   (Phase 27 / N-3)
5  Mobile        user signs in AGAIN with the NEW password → a FRESH Firebase ID token,
                 carrying a fresh signed `auth_time`
6  Inventory AI  POST /api/auth/firebase/exchange  { idToken }   PUBLIC
                 → the RECOVERY-CONTEXT session (temporary, by design)
7  Inventory AI  POST /api/auth/credentials-changed  { freshIdToken }
                 requireAuth (the step-6 session) → uid binding → 300 s `auth_time` freshness
                 → passwordChangedAt = now  ;  revokeAllSessions()
                 → ALL sessions die, INCLUDING the step-6 session
8  Inventory AI  POST /api/auth/firebase/exchange  { idToken }   PUBLIC
                 → the FINAL session: a new JWT whose iat >= changedAtSec
9  Client        stores the FINAL session; the user is signed in and the old sessions are gone
```

**Step 5 is load-bearing in two independent ways, and neither is decorative.** It is what produces the
**fresh signed `auth_time`** that §14C.3.3 step 4 demands (a stale pre-reset token would be refused
`409 FIREBASE_REAUTHENTICATION_REQUIRED`), and it is what re-establishes the **Firebase session** the
exchange consumes. A reset does **not** sign the user in — `confirmPasswordReset` changes the credential
and nothing else — so the sequence must include an explicit sign-in with the new password, which is
exactly what makes the bridge reachable.

**Temporary versus final session — the distinction IS required.** Because a reset begins with no
session at all, the bridge must first be *given* one:

- **The recovery-context session (step 6)** is an ordinary Inventory AI JWT plus its `sessions` row,
minted by the **existing PUBLIC exchange** from the post-reset Firebase token. It is **temporary by
design**, it is **expected to be revoked by step 7**, and **no client may treat it as the user's final
session or present it afterwards**. It is *not* a new kind of session: **no "recovery" flag, no new
field, no new model** — the distinction lives in the **flow**, not in the schema, which is why §20's
frozen session surface is untouched by this record.
- **The final session (step 8)** is the only session that survives the flow, and it is valid precisely
because it is minted **after** the stamp (`iat >= changedAtSec`) — the same property §14C.3.4 already
relies on.
- **Neither of them is a Firebase ID token.** The ID token is the *credential presented to* the exchange
and to the bridge; it is never the bearer credential of an ordinary Inventory AI API call.

**Why the old sessions cannot accidentally survive the recovery flow.** Two independent mechanisms,
both already in the design, and **D2 changes neither**:

1. `revokeAllSessions({ userId, businessId, now })` is an **unconditional `updateMany({ userId,
   revokedAt: null })`** with **no caller exception** — it revokes the recovery-context session *and*
   every pre-reset session, including one an attacker opened. The new session cannot be spared, and must
   not be.
2. `passwordChangedAt = now` is a **second, independent** mechanism: `requireAuth` refuses any token
   minted **strictly before** the stamp, so even a `sessions` row that somehow survived could not be
   used. Answering `401 SESSION_INVALIDATED` here is the check working, not a failure.

Because of (1), **the flow is complete only after step 8.** A client that stops at step 7 has revoked
everything *and* signed itself out — a **loud, recoverable** state (sign in again; the exchange needs
only an ID token), never a silent one. And the client must **not** skip step 7 on the grounds that it
already holds a session after step 6: the step-6 session is an **artefact of the recovery**, not
evidence that revocation is unnecessary.

**Two operational notes, recorded so they are not rediscovered as defects.**

- **The 300 s freshness window is not widened for recovery.** If the user takes longer than
  `FIREBASE_REAUTH_WINDOW_SECONDS` between step 5 and step 7, the bridge refuses
  `409 FIREBASE_REAUTHENTICATION_REQUIRED`; the correct response is to sign in again, never to relax the
  window.
- **The lost-response hazard now also covers the recovery case.** If step 7's response is lost and the
  client retries it, the retry arrives with the step-6 token, whose `iat` is now strictly earlier than
  the stamp, and is answered `401 SESSION_INVALIDATED` — which per §14C.3.5 is
  **success-equivalent** ("already acknowledged"), so the client proceeds to step 8 rather than retrying
  step 7. **This rule is unchanged and still must be pinned by a test in the implementing phase.**

**D2 does not reopen anything below.** The following are restated as still binding, not newly decided:

- **`passwordChangedAt` and `revokeAllSessions()` remain part of the N-4 invariant.** Both writes, in
  that order, exactly as §14C.3.3 step 5. D2 adds, removes and reorders **nothing**.
- **A Firebase ID token is NOT the application's permanent API credential** (§14C.2, L-8, R-3). It is
  exchanged **once** and used as *input* here; `requireAuth` never sees one.
- **The normal Firebase UID → MongoDB `User` mapping remains authoritative.** The binding is unchanged:
  `verifyFirebaseIdToken(idToken).uid` must equal `User.findById(req.user.id).firebaseUid` — no email
  join, no client-supplied `userId`/`businessId`/`role`/`status`. Recovery changes the credential; it
  changes nothing about who is authorized.
- **No public, unauthenticated `credentials-changed` endpoint is introduced.** D2 is solved by
  establishing an authenticated context **first**, never by relaxing authentication on the bridge.
  §14C.3.6's rejection of a public endpoint keyed only on a verified ID token **stands unchanged**: it
  would collapse a stolen Firebase credential into an Inventory AI denial-of-service and contradicts
  L-15.
- **No Firebase Cloud Function or Admin-SDK trigger is introduced.** §14C.3.6's rejection **stands
  unchanged** — a Functions runtime is a new infrastructure surface with its own secrets, cost and
  operational model that this repository has never had and no phase authorises. D2 is resolved entirely
  inside the existing client + REST architecture.

**★ The one thing this record does NOT decide — named (OD-9) rather than chosen silently.** How the
client knows, at the post-reset sign-in, that it must run steps 7–8 is **not** settled here. It is a
bounded implementation question with hard constraints, and picking one now would be inventing policy:
any trigger must **not** be a public/unauthenticated route (above); must **not** let a client-supplied
value steer a bridge call against an account (the account is always `req.user.id`); must **not** mint a
session outside `POST /api/auth/firebase/exchange`; must **not** add a field to `sessions` or `User`
without a separately-approved phase (§20); and must make skipping the bridge **impossible or
detectable**, so a reset can never silently leave sessions alive. Recorded as **OD-9** in §14C.7.
**★ RESOLVED 2026-09-29 (Phase 32Q, §14C.3.9):** the trigger is the **durable, non-secret recovery
marker** — **M-1…M-10** — which satisfies every constraint above. This paragraph is the Phase 32P
record and is not rewritten.

### 14C.3.9 The recovery marker — OD-9 LOCKED (2026-09-29)

**Documentation only (Phase 32Q).** No code, test, schema, dependency, environment variable, Firebase
Console setting, EAS configuration or deployment change was made for this record.

**What it resolves.** §14C.3.8 closed D2's architecture and left exactly one question open, named
**OD-9**: how the client knows, at the post-reset sign-in, that it must run the bridge. It is **LOCKED**
below, as **M-1…M-10**, so tests and future audits can cite each individually.

**M-1 — OD-9 is a durable, non-secret recovery marker.** `expo-secure-store`, key
**`inventoryai.auth.passwordResetPending`**, holding **only an account fingerprint** (a hash of the
reset account's email). It stores **no password, no `oobCode`, no Firebase ID token, no Inventory AI
JWT, no `userId`, no `businessId`, no `role` and no tenant data** — the marker is a **flow selector,
never a credential**, and it must never be treated as proof of identity or authorization.

**M-2 — the marker is created with `verifyPasswordResetCode(oobCode)`.** The installed native SDK
supports it on **Android and iOS** (`verifyPasswordResetCode(auth, code): Promise<string>`, resolving
the account's **email**), and verification-then-confirmation with the same code is the documented
reset handling. The email is **memory-only**: it is used for the automatic sign-in and to compute the
marker fingerprint, and it **never becomes an authorization source** — the server continues to derive
the account exclusively from `requireAuth → req.user.id → Mongo User → firebaseUid`.

**M-3 — F1 automatic recovery is APPROVED.** The locked sequence:

```text
verifyPasswordResetCode(oobCode)  →  write marker  →  confirmPasswordReset(oobCode, newPassword)
   →  signInWithEmail(email, newPassword)          ← the source of the fresh signed `auth_time`
   →  temporary PUBLIC exchange  →  POST /api/auth/credentials-changed
   →  passwordChangedAt = now  +  revokeAllSessions()
   →  FINAL PUBLIC exchange  →  applySession(final)
```

**M-4 — the temporary session is a local variable.** It is held only in memory, **never persisted,
never passed to `applySession`, never navigated with and never placed in route parameters**. It needs
no explicit cleanup: `revokeAllSessions()` revokes it together with every other active session, because
it is an unconditional `updateMany({ userId, revokedAt: null })` with **no caller exception**.

**M-5 — `401 SESSION_INVALIDATED` is success-equivalent.** After a previously successful bridge it
means "the change was already acknowledged": **clear the marker and continue to the final exchange**.
This is §14C.3.5's rule, now also covering the recovery path.

**M-6 — marker lifecycle, locked.**

| Stage | Rule |
| --- | --- |
| **Create** | **Before the password-change operation**, so an interruption at any later point still closes D2. |
| **Clear** | After a successful bridge acknowledgement, and on `401 SESSION_INVALIDATED`. |
| **Keep** | On `409 FIREBASE_REAUTHENTICATION_REQUIRED` and on a **transport failure** — revocation is still owed, and the next sign-in is the retry. |
| **Mismatch** | **Never consumed on a fingerprint mismatch** — a different account signing in on the same device must neither run the bridge nor lose the marker. |
| **Legacy** | The **legacy `?token=` recovery must never create it**: that server flow already stamps `passwordChangedAt` and calls `revokeAllSessions`, so a marker there would cause a redundant second revocation. |

**M-7 — one limitation, documented and not to be overstated.** A reset completed on **Device A**,
followed by the **first** password sign-in on **Device B**, **cannot be detected by this client-local
marker**, so no bridge runs there. **OD-9 must not be described as a universal cross-device revocation
guarantee:** it closes D2 for the device that completed the recovery and for that device's later
sign-ins, and it covers every interruption state **on that device**.

**M-8 — Option E is DEFERRED, and nothing of it is introduced here.** Server-side derivation from
Firebase's `passwordUpdatedAt` (an Admin read plus a new `User` field, compared at exchange) would
close the M-7 limitation — but it is a **partial N-4 redesign**: it adds a Mongo field, a Google round
trip on the sign-in path and a fail-open/fail-closed decision, and it would make the bridge largely
redundant. **No such field is added, no Admin lookup is added, and no part of it is introduced by this
phase.** It is recorded as a **separate future owner decision** — **OD-10** in §14C.7.

**M-9 — the N-4 architecture is unchanged.** `requireAuth`, `passwordChangedAt` semantics,
`revokeAllSessions()` semantics, the UID→Mongo `User` mapping, Mongo business/role authority, the
ordinary session schema and the JWT/session architecture all stay exactly as they are. **No new
session type and no new session field** is introduced: the temporary session is structurally an
ordinary session, and the marker lives on the **client**, never on `sessions`.

**M-10 — L-17 remains the end-to-end gate, with one added requirement.** Real Firebase reset-email
delivery and deep-link completion on a device is still the **hard prerequisite for the end-to-end
claim** (it does not block implementation, which is offline-testable). **Added to that gate:** the live
test must also confirm that **`verifyPasswordResetCode()` returns the correct email and does not
consume the reset code** — the one genuinely new runtime dependency this design introduces. If
verification ever proved destructive the failure is **safe and retryable**, because
`confirmPasswordReset` would answer `auth/invalid-action-code`, which the reset screen already renders
as "invalid or has expired".

**One correction to earlier reasoning, recorded so it is not lost.** The fresh `auth_time` the bridge
reads comes from the **real credential authentication** in M-3's sign-in — **not** from a token
refresh. `mobile/lib/firebase-auth.ts` states it in place: `getIdToken(true)` re-mints a token and
moves `iat`, but **leaves `auth_time` alone**, so a forced refresh is **not** a confirmation and must
never be substituted for the sign-in.

---

## 14C.4 The action-link / deep-link live-test requirement (L-17)

**L-17 forbids declaring recovery complete on static reasoning alone.** The SDK support is confirmed
from the **installed** package (`@react-native-firebase/auth@26.4.0`) rather than assumed:

| Capability | Evidence |
| --- | --- |
| `sendPasswordResetEmail(auth, email, actionCodeSettings?)` | `lib/index.ts:1248` |
| `confirmPasswordReset(auth, oobCode, newPassword)` | `lib/index.ts:1071` |
| `verifyPasswordResetCode(auth, code)` | `lib/index.ts:1522` |
| `applyActionCode` / `checkActionCode` | `lib/index.ts:1036` / `:1061` |
| `sendEmailVerification(user, actionCodeSettings?)` | `lib/index.ts:1742` |
| `updatePassword(user, newPassword)` | `lib/index.ts:1773` |
| `ActionCodeSettings { url, handleCodeInApp, android.packageName, iOS.bundleId, … }` | `lib/types/auth.ts:344` |
| `ActionCodeURL` (parses `oobCode` from a link) | `lib/ActionCodeURL.ts:148` |

**The gate that remains UNVERIFIED, and it is not a code question.** Whether Firebase's **hosted
action handler** honours `handleCodeInApp` for a **password reset** and hands the `oobCode` to a
**custom scheme** is server-side Firebase behaviour configured partly in the **Firebase Console**. No
repository evidence can settle it, and reading the type declarations cannot either. It must be
measured.

**The live test, to be performed in the implementing phase before recovery is called complete:**

1. `sendPasswordResetEmail` with `ActionCodeSettings { url: 'inventoryai://reset-password',
   handleCodeInApp: true, android: { packageName: 'com.inventoryai.app', installApp: true },
   iOS: { bundleId: 'com.inventoryai.app' } }`.
2. Confirm on a **real device against a live Firebase project** that the emailed link returns control
   to the app and delivers the `oobCode` to the reset screen.
3. Confirm the **email template** (sender, subject, body) is the intended one — that is **Firebase
   Console** configuration, an external surface this repository does not hold.
4. Confirm the `oobCode` is never rendered, never logged, and never copied into navigation; that an
   expired or already-used code surfaces as the fixed client copy rather than a raw SDK message; and
   that a second link arriving while the screen is mounted resets the form.
5. Confirm the Android side against the **proven precedent**: Phase F2.9 already runtime-verified that
   `inventoryai://reset-password` renders on a real Android development build.

**If custom-scheme delivery fails the test, the fallback is a hosted continue URL** (Universal Links /
Android App Links), which Phase 27 deliberately deferred and which needs a web domain plus association
files — a **new infrastructure dependency** that must be an explicit owner decision, never an
improvisation. **iOS cannot be verified on the current Windows host and remains
`[EXTERNAL VERIFICATION REQUIRED]`.**

---

> **Added 2026-09-29 (Phase 32Q).** The gate gains one requirement for the N-4 recovery flow: the live
> device test must also confirm that **`verifyPasswordResetCode()` returns the correct account email
> and does not consume the reset code** (§14C.3.9 M-2/M-10). L-17 itself is otherwise unchanged and
> **still OPEN**.

### 14C.4.1 N-2 test result (2026-09-29) — the app side is VERIFIED, the Firebase email side is NOT

**What was tested.** The `InventoryAI` AVD (`emulator-5554`, SDK 35, x86_64) was booted and the
**installed development build** `com.inventoryai.app` (versionName 1.0.0, versionCode 1, targetSdk 36,
`lastUpdateTime 2026-09-25 15:43` — the **Phase F2.9** build `f3038fa1-…`) was exercised. No build was
created, no configuration was changed, and no real reset `oobCode` was ever obtained, used or recorded
— only clearly-labelled placeholders.

| # | Probe | Observed result |
| --- | --- | --- |
| 1 | Package/activity resolution of `inventoryai://reset-password` | **Resolves to `com.inventoryai.app/.MainActivity`** (`match=0x208000`, `isDefault=true`) |
| 2 | Control: the retired `com.inventoryai.app:/oauthredirect` | **`No activity found`** — still unresolvable, confirming F2.9 |
| 3 | `am start -a VIEW -c BROWSABLE -d "inventoryai://reset-password?oobCode=PLACEHOLDER"` | **Status: ok**, delivered in-app to `MainActivity`, which became `topResumedActivity`. **No browser opened. No Firebase error. No crash.** |
| 4 | Screen after probe 3 | **`Link incomplete` / `This reset link is missing its token.` / `Request a new link`** |
| 5 | Positive control: `…?token=PLACEHOLDER` | **The reset form rendered** — `Set a new password`, `New password *`, `Confirm new password *`, `Min 8 characters` |
| 6 | Negative control: `inventoryai://` with no route | The **login screen** rendered (`Welcome back`, `Sign In`, `Continue with Google`, `Forget password?`) |

**PASS for the app side.** `inventoryai` reaches the app, **expo-router routes it to `/reset-password`**,
and **a query parameter is read and accepted** — proven by the positive control, which drove the screen
into its form branch rather than its missing-token branch. The placeholder was never rendered, which is
the token-hygiene property Phase 27 established and still holds.

**★ The finding N-3 must carry.** Probe 3 and probe 5 differ **only in the parameter name**, and they
land on different branches of the same screen: the current `app/reset-password.tsx` reads
**`params.token`**, so a Firebase-native link carrying **`?oobCode=`** renders
**"Link incomplete"**. **Router-level `inventoryai://reset-password?oobCode=…` delivery does NOT by
itself reach the form** — N-3 must change the screen to read `oobCode` (and/or parse it via the SDK's
`ActionCodeURL`), or every Firebase reset link will dead-end one screen short of working. This is a
genuine, reproducible observation rather than an inference.

**What this test does NOT prove, and must not be read as proving.** Every probe above injected the URL
**directly at the OS level with `am start`**. It therefore proves the **receiving** end and says nothing
about the **sending** end. Still **UNVERIFIED**:

1. **Whether Firebase's reset email actually contains a custom-scheme URL.** The email is composed by
   **Firebase's servers** from the template configured in the **Firebase Console**. It was never
   generated, received or read in this test.
2. **Whether Firebase's hosted action handler consumes the link first** rather than handing control to
   the app — the specific behaviour `handleCodeInApp` is meant to change, and the specific thing this
gate exists to settle.
3. **Any Firebase error path**, including what an expired or already-used `oobCode` produces, and
   whether a Firebase error surfaces as a browser page or as an app-branchable error.
4. **Anything Google/provider-specific.** No provider was exercised.

**Why it could not be completed, stated exactly.** The test requires an **email inbox** to receive the
reset message and a **Firebase Console session** to configure and confirm the action-code settings
(§14C.4 header rule 6, and the owner's requirement to use a dedicated development account). This agent
has access to neither: there is **no `firebase` CLI and no `gcloud` CLI on this host**, no Console
credential, and no mailbox access. The reset email was therefore **never triggered** — not because it
failed, but because the link it would produce cannot be retrieved here. **No success was simulated.**

**Therefore L-17 is only HALF satisfied.** *"Firebase action-link/deep-link routing using the existing
`inventoryai` scheme must be verified on a real device against a live Firebase project before recovery
is considered complete."* — the **real device** half is now verified (on an **emulator**, not physical
hardware; see below); the **live Firebase project** half is **still UNVERIFIED**, and the gate
**remains open**. **N-3 must not be started on the strength of this result alone.**

**Android emulator vs physical device — recorded, because the difference is real, and corrected.**
Every runtime observation above is from the `InventoryAI` **emulator** on this Windows host. A physical
device **was** attached later in the same session (`PV4DDMIZZLTCIVSK`, an **OPPO CPH1969**, Android 11 /
**SDK 30**, **arm64-v8a**), but it **could not be used**: `com.inventoryai.app` is **not installed** on
it, and **no APK exists** in the repository or on this host to install. Producing one would require an
`eas build` or an `expo prebuild`+Gradle build, both of which this phase forbids — so the run was
**not** repeated there, and the result above **must be read as emulator-only**. A physical-device run
additionally needs `EXPO_PUBLIC_API_URL` pointed at the host's LAN address, since the `development`
profile sets no `env`.

**iOS remains `[EXTERNAL VERIFICATION REQUIRED]`, with nothing verified.** No iOS build exists for this
project, none can be produced on this Windows host, and no iOS run was attempted. Specifically
unverified for iOS: that the `inventoryai` scheme is registered at all after the F2 change to a
single-entry `expo.scheme`; that a URL reaching the app routes to `/reset-password`; and — the reason
iOS needs its own live test rather than an Android result being extended to it — that **any** Firebase
action-link delivery works on a platform where the project has configured **no** Universal Links, no
associated domains and no Apple Team/App Site Association file.

**No Firebase Console configuration was changed, and none was read.** The settings the test will
require are named in §14C.4 above (the action-code / custom action URL configuration and the email
template) and remain **unconfirmed**.

**A hosted continue-URL fallback is NOT yet indicated.** It appears necessary only if the Firebase-side
probes fail, and they were never performed. It therefore stays documented as §14C.4 already records it
— a **new infrastructure dependency needing an explicit owner decision** — and **no fallback was
implemented or prototyped**. **No application-code change of any kind was made in N-2.**

### 14C.4.2 N-3 implementation record (2026-09-29) — the client half ships, and the gate stays OPEN

**What shipped, and it is mobile only.** The Firebase-native recovery path, additively as the N-3 row
requires. The Phase 1 verb guard was **deliberately relaxed for exactly one verb**
(`sendPasswordResetEmail`; `confirmPasswordReset` was never in that map), the boundary gained the two
operations plus the `ActionCodeSettings` this section's live test names, the classification layer gained
two outcome-typed wrappers, `forgot-password` became Firebase-first with the custom endpoint as its
**unconfigured-build** fallback, and `reset-password` now chooses its flow from the parameter present —
`?oobCode=` is redeemed by Firebase, `?token=` still goes to `POST /api/auth/reset-password`. **The
26B/27 stack is untouched**: both routes, the controller, the service, the token model, the whole mail
layer and their suites all still exist and still work. **N-7 is what removes them, not this.**

**TWO VERBS, NOT THE FOUR THE ROW NAMES, AND THE DIFFERENCE IS RECORDED.** The N-3 row lists four
`firebase-native.ts` verbs. Only two have a consumer in this flow: `sendPasswordResetEmail` and
`confirmPasswordReset`. `verifyPasswordResetCode` and `applyActionCode` were **not** added, because
nothing in the flow would call them and CLAUDE.md §8 forbids dead code — an unusable code is already
surfaced as `confirmPasswordReset`'s own ordinary `invalid-code` outcome, so the pre-verification the
plan imagined would have bought a second network round trip and a third screen state for nothing. If a
later phase needs either verb, it adds it then.

**The screen stopped asserting the thing that is unverified.** Its success body said the link "opens the
Inventory AI app directly", which is true **only if** Firebase honours the custom-scheme settings —
that is precisely this gate — so it now reads "Open the link to choose a new password." A sentence a
user reads is not the place to assert an unmeasured behaviour.

**Two properties are implemented rather than intended.** *Enumeration resistance moves into the
client*: `auth/user-not-found` and `auth/user-disabled` are answered as **SENT**, because with
Firebase's email-enumeration protection OFF those codes identify an address, and reporting them as a
failure would rebuild the oracle the uniform 202 exists to prevent (checklist F-3). *The confirmation
has no fallback*: an action code is a Firebase credential, so a failed redemption can never license a
call to the custom endpoint — and the classification layer imports no API module at all, so such a
branch would have to add an import first. The gate's **own** error surface is named too:
`auth/invalid-continue-uri` and `auth/unauthorized-continue-uri` are matched by shape and answered with
a configuration sentence rather than "please try again", because if this project does not accept
`inventoryai://reset-password` as a continue URL then retrying cannot help and the operator has to act.

**★ What the first pass could not verify.** No Firebase reset email was generated,
received or inspected, and no live Firebase project was exercised — **the runtime section below records what a later pass DID observe on a device, and which parts of that remain unproven.**
The delivery half of the test — items 3, 6 and 7 — remains **BLOCKED** on the same external access N-2 lacked (no Console
credential, no mailbox, no `firebase`/`gcloud` CLI), because whether the address received anything can only be learned from its inbox.
**L-17 remains OPEN — NARROWED by the runtime result below, not resolved — and N-4 must not be started as
though the Firebase-side half had been proven.** iOS remains `[EXTERNAL VERIFICATION REQUIRED]`.

**One N-2 statement is superseded by observation, and it is annotating rather than rewriting.** N-2
recorded that the attached physical device had no build installed and that no APK existed to install.
At N-3 time `com.inventoryai.app` **is** installed on `PV4DDMIZZLTCIVSK` (CPH1969, SDK 30;
`firstInstallTime = lastUpdateTime = 2026-09-29 13:04:10`) and APKs are present under `mobile/.smoke/` — but that build was
**NOT** a development build. It was the **`preview`** APK (`4160dee1-369e-4266-956b-746de824bc8c`, commit `4ca36c6`), a release build that embeds its bundle — which is
why the first attempt to run this code on it changed nothing: its `flags` carried **no `DEBUGGABLE`**, `run-as` and the dev menu were refused, no dev-launcher activity
existed, and it was 126 MB against 258 MB for the development APKs — so **Metro could not drive it** and it kept
rendering the pre-N-3 bundle. `mobile/.smoke/f2-9-development.apk` was then installed over it **by owner decision**, and the runtime results below come from that build.

**★ N-3 RUNTIME RESULT (2026-09-29, physical device, live Firebase project, `jeffern1233@owner.com`).** The
development build was installed, Metro served the N-3 working tree into it
(`Android Bundled … expo-router/entry.js`, 1591 modules), and the following were OBSERVED, not inferred:

| Probe | Observed |
| --- | --- |
| `inventoryai://reset-password?oobCode=<placeholder>` | **The reset form renders** (`Set a new password`, both fields). The pre-N-3 bundle answered *"Link incomplete / missing its token"* — **F-8 is CLOSED on the client side, on a device.** |
| `inventoryai://reset-password?token=<placeholder>` | The same form renders — the legacy 26B/27 path is intact on the same build. |
| `inventoryai://forgot-password` → Send for the test address | `Auth: sendPasswordResetEmail` → `FirebaseAuth: Password reset request …` → **`sendPasswordResetEmail:onComplete:success`**; the screen showed *"Check your email"*, the fixed enumeration-resistant sentence and the new body copy. |
| `confirmPasswordReset` with an obviously fake code | `FirebaseAuthActionCodeException: The out of band code is invalid…` → the screen showed **"This reset link is invalid or has expired. Request a new one."** |

**What that settles, and what it does not.** The project **accepted the custom-scheme
`ActionCodeSettings`** — there was no `auth/*-continue-uri` rejection — so the configuration question
moved from "unknown" to "accepted by the API", and the confirmation classification is now
runtime-proven end to end. **It does NOT settle whether the email was delivered or what its link
contains:** `onComplete:success` is returned even for an address with no account under
email-enumeration protection, and the screen **deliberately cannot** distinguish "sent" from "no such
account". The inbox is the only instrument that can, and there is none here. So whether the emailed
link actually returns to the app carrying the code — the remaining half of L-17 — is **still
UNVERIFIED**, items 6 and 7 (a real password change and the resulting sign-in) are **still blocked**,
and **the gate is NARROWED, NOT CLOSED.**

**Device state left behind, recorded so it is not a surprise.** The CPH1969 now carries the F2.9
**development** build instead of the `preview` build `4160dee1-…`; that preview APK can be reinstalled
from `https://expo.dev/artifacts/eas/gjFMvYd2HTe5T8jJPqr-78y8iUOgJA49N8Vxj4NykQU.apk`. Metro was left
running on `:8081` because it is what loads this code, **no source, configuration or Firebase Console
setting was changed by the run**, no new EAS build was created, and the device's temporary UI dumps were
removed.

---

### 14C.4.3 The recovery-request failure investigation (2026-09-29) — one real defect, and the limit of what the client could tell anyone

**What prompted it.** A device report: `jeffern123@owner.com` appeared to complete a recovery request
while **every other address**, including a working Gmail, answered the single generic sentence
`Unable to send the reset link. Please try again.` The concern behind the report was that legacy
MongoDB accounts cannot use Firebase recovery. The investigation below separates what is true from
what was assumed, and it changed **two client files only** — no server file, route, permission,
schema, dependency, environment variable or Firebase Console setting was touched, and the locked
architecture of §14C is unaffected.

**What was MEASURED, not inferred.** Every row is reproducible from the repository.

| # | Observation | How it was established |
| --- | --- | --- |
| 1 | A configured build takes the **Firebase** request path, so the 26B endpoint is unreachable in it | the served development bundle inlines the project id, i.e. `isNativeFirebaseConfigured()` is `true`; `app/forgot-password.tsx` reaches `POST /api/auth/forgot-password` only on `legacyFallback`, which that gate alone licenses |
| 2 | `accounts:sendOobCode` answers **HTTP 200 for an address with no account at all** | called the project's own endpoint with the app's exact parameters (`requestType=PASSWORD_RESET`, `continueUrl=inventoryai://reset-password`, `canHandleCodeInApp`, `androidPackageName`, `androidInstallApp`) — `200` + `GetOobConfirmationCodeResponse` |
| 3 | The same call is genuinely validated, so that `200` is meaningful | `email="not-an-email"` answers **`400 INVALID_EMAIL`** |
| 4 | ⇒ **email-enumeration protection is ON for `inventoryai-d0d20`** | with it OFF, row 2's unknown address would answer `EMAIL_NOT_FOUND` instead of `200` |
| 5 | The **26B endpoint cannot send mail in production**, for any address | a live call to the deployed backend answers `{"error":"Password reset is temporarily unavailable. Please try again later.","code":"MAIL_NOT_CONFIGURED"}` — **HTTP 503**, because that check runs *before* the account lookup |
| 6 | **The native SDK does not normalise `EMAIL_NOT_FOUND`** | `NativeRNFBTurboAuth.getJSError` lowercases and de-hyphenates whatever code it was handed and rewrites only the codes it names explicitly; `EMAIL_NOT_FOUND` is not among them, so it reaches JavaScript as **`auth/email-not-found`** — a spelling the JavaScript SDK never produces, because it maps the same server code onto `auth/user-not-found` |

**Defect 1 — `auth/email-not-found` was unclassified (FIXED).** `INDISTINGUISHABLE_CODES` listed
`auth/user-not-found` and **not its native spelling**, and the two are the same server fact. The
consequence is precisely the reported split: a real Firebase account's send resolves and is reported
as *sent*, while an address with no Firebase identity throws a code the module had no wording for and
falls to the generic sentence. **That is a wrong message and a rebuilt enumeration oracle at once** —
only addresses that exist reach the success state — and it lands on exactly the population this flow
is supposed to help, since "no Firebase identity for this address" is an ordinary state here (see the
legacy account below). Fixed by listing `auth/email-not-found` in `INDISTINGUISHABLE_CODES` **and** in
`INVALID_ACTION_CODE_CODES`, so a request and the redemption of its link cannot disagree about which
links are dead. **Nothing is weakened:** the code is answered `sent`, which is the same answer
Firebase's own enumeration protection gives the same address (row 2).

**Defect 2 — the client threw the code away (FIXED).** Every failure was reduced to safe copy while the
decided code was discarded at the moment it became the only thing worth knowing, so four different
causes rendered identically on a device and this investigation had to be done by reading the
platform's error mapping by hand. `app/forgot-password.tsx` now renders a **second, `__DEV__`-only**
element naming the **source and the code** — `Diagnostic (dev only) — firebase: auth/email-not-found`,
or `server: MAIL_NOT_CONFIGURED`, and `(no code)` when a failure was not a Firebase rejection at all.
The person's sentence is **byte-identical with and without it**, the element does not exist in a
release bundle, and it cannot carry an address, a token, a password or an SDK message. Guarded by
`phaseN3-recovery-screens.test.tsx` (which asserts both the unchanged copy and the diagnostic,
including the server case) and pinned in source by the N-3 suite, whose `__DEV__` gate assertion is
the production half of the claim that a Jest run cannot render.

**One honest limit.** The exact code observed on the device **was not recoverable after the fact**,
because defect 2 meant it was never recorded anywhere. Defect 1 is the only account-dependent code in
the installed mapping that produces the reported split, and it is fixed on its merits rather than on
that inference; defect 2 is what makes any survivor observable on the next run rather than a matter of
theory.

**The legacy Mongo-only account, stated plainly.** A user who exists in MongoDB and **not** in Firebase
has **no password authority to exercise**: with enumeration protection ON the request answers `200`
and **nothing is sent**, the screen shows the fixed sentence, and there is neither an error nor an
email. **This is not an implementation bug and no code is changed for it.** Worse, and separately
recorded: even an account that acquires a Firebase identity still carries no `firebaseUid`, so the
exchange answers `REGISTRATION_REQUIRED` and the legacy login is refused `FIREBASE_SIGN_IN_REQUIRED` —
such an account is **unreachable until an operator gives it an identity**. **No auto-linking on an
email match** (§14A.3/R-7), **no migration, no restoration of the 26B/27 reset path**, and Firebase
**remains the password authority**. An account's existence is deliberately **not** disclosed to the
caller, so the remedy is the invitation path (**L-12 / N-9**), not a hint on this screen.

**Environment finding from the same session (recorded here because it was part of the report; NOT a
Firebase matter).** *(Corrected 2026-10-07: this passage previously said `MONGODB_DB_NAME` was empty and
that development therefore resolved to `inventoryai_dev_db`. The working tree says otherwise.)*
`server/.env` sets `NODE_ENV=development` **with `MONGODB_DB_NAME=inventoryai_test_db` set explicitly**,
so the development server resolves to the **test** database: the resolver's rule is *a test run always
uses the test database; otherwise an explicit `MONGODB_DB_NAME` wins; otherwise `NODE_ENV` decides* —
and this value is explicit. `inventoryai_dev_db` has therefore **never been used**, which is why a
read-only listing of the cluster shows `inventoryai_prod_db` and `inventoryai_test_db` — the two
environments something has actually written to — and **no `inventoryai_dev_db`, and no legacy
`inventory_ai`**. MongoDB creates a database on first write, so an environment that has never been used
against the cluster is **absent rather than broken**; nothing was changed to make it appear.
**Operational consequence:** local development and `npm run test:db` currently resolve to the **same**
database, so run the DB-backed suite with the development server stopped (the test run itself remains
fail-closed by name to `inventoryai_test_db`). *(The collection counts above were 14 when this was
written; **AUTH-04 added the 15th — `email_verification_challenges`** — so the first `db` run after it
creates that collection's indexes.)*

---

## 14C.5 `checkRevoked = false` — review and recommendation (L-19) — **SUPERSEDED BY AUTH-01: the shipped behaviour is `true` (see the block below)**

> **SUPERSEDED BY AUTH-01 (recorded 2026-10-07). The shipped behaviour is `checkRevoked: true`.**
> `services/firebase/tokenVerifier.ts` calls `auth.verifyIdToken(idToken, /* checkRevoked */ true)`,
> which the **approved target architecture §9/§10** requires (*"Firebase revocation checking is a
> security boundary"*). **The review below is retained unrewritten and is NOT current policy.** What
> changed and what did not: a Firebase-side disable/delete **is** consulted at every verification
> (exchange, renewal and the AUTH-04 pre-session routes); it **still does not end a live Inventory AI
> session**, because the ID token is never the bearer credential, so MongoDB `status`,
> `passwordChangedAt` and the `sessions` row remain the enforcement points. The availability cost the
> review names is the accepted trade-off; the failure is classified as transient
> (`FIREBASE_UNAVAILABLE` → `503` on authenticated routes) and never as a credential rejection.

**Historical behaviour at the time of this review.** `services/firebase/tokenVerifier.ts` passed
`checkRevoked: false`. The consequence was stated in its own comment: **a Firebase account disabled or
deleted on Google's side still verified**, so Firebase-side revocation was not enforced at exchange
time.

**Recommendation: KEEP `false` for V1.** The reasoning, and it turns on L-9 rather than on
convenience:

| Consideration | `false` (keep) | `true` (change) |
| --- | --- | --- |
| Authority | MongoDB `status`, checked **per request** by `requireAuth` — immediate, and already the enforcement point L-9 names | Adds a second, weaker authority that can disagree with the first |
| Availability | The exchange is a local signature verification plus two indexed lookups | Adds a **network round trip to Google on every exchange**, and fails closed when Google is unreachable — turning a Google outage into a total sign-in outage for a system whose authority is MongoDB anyway |
| Revocation of an existing session | Achieved by `status`, `passwordChangedAt`, and the `sessions` row — all MongoDB | **Not achieved.** `requireAuth` never sees a Firebase token, so a Firebase-side disable still does not end a live Inventory AI session |
| Cost of getting it wrong | A Firebase-side disable is not honoured at exchange — a real but **narrow** gap, closed operationally by MongoDB `status` | A Google outage blocks all sign-in; a revocation check that still cannot revoke |

**Therefore this review recommended that `checkRevoked` STAYS `false`** unless a future,
separately-approved phase establishes that **Firebase-side** disable/delete must take effect at
exchange. **That recommendation was not adopted: AUTH-01 sets it `true`** (see the supersession note
above), and the condition it names is not what drove the change — the approved target architecture
§9/§10 requires revocation checking outright. Should that happen, the change is one
flag plus a documented availability cost, and it must be accompanied by an explicit decision about what
"Google unreachable" means for sign-in. **Changing it would not remove the need for §14C.3**: the
bridge exists precisely because revocation of an Inventory AI session lives in MongoDB, not in
Firebase.

**The gap that remains either way, stated so it is not mistaken for coverage.** Disabling a user in
**Firebase only** does not stop their existing Inventory AI session, and never will while Firebase is
not the bearer credential. **The operational control is MongoDB `status`.** This is the reason L-8 and
L-9 exist.

---

## 14C.6 Implementation dependency and order plan

Each step is separately approvable, separately verifiable, and **removes nothing the previous step
still depends on**. The ordering constraint that dominates the whole plan: **add before remove**, so a
capability is never briefly absent between two phases.

| Step | Scope | Depends on | Removes |
| --- | --- | --- | --- |
| **N-1** | **Decision record only (this section).** Lock L-1…L-19; amend §14A.5; reconcile the specification, checklist, roadmap, README and CLAUDE.md. | — | nothing |
| **N-2** | **Action-link live test (§14C.4)**, performed first because it can invalidate the mobile half of the plan. Live Firebase project + real device. **PARTIALLY DONE 2026-09-29 (§14C.4.1): the Android app/OS side is VERIFIED; the Firebase email side is NOT — the gate stays open.** | N-1, a live Firebase project | nothing |
| **N-3** | **Mobile Firebase-native recovery, additive.** Add the four `firebase-native.ts` verbs (**which requires relaxing the Phase 1 `FORBIDDEN` verb map deliberately** — see below); add `sendPasswordResetEmail` + `confirmPasswordReset` + the `oobCode` reset screen; configure `ActionCodeSettings`. **The 26B/27 server path stays up.** — **DONE 2026-09-29 (client half, §14C.4.2): TWO verbs, not four (the other two would have been dead code); the Firebase side remains UNVERIFIED, so the gate stays OPEN.** | N-2 | nothing |
| **N-4** | **The revocation bridge (§14C.3).** `POST /api/auth/credentials-changed`, its validator, service, controller, audit action, the `phase23` `AUTHENTICATED` declaration, and the `401 SESSION_INVALIDATED`-is-success rule pinned by test. **D2 — the reset-path caller — is now RESOLVED (§14C.3.8, 2026-09-29):** the recovery flow establishes a temporary **recovery-context session** through the public exchange, calls the bridge (which revokes **all** sessions, including that one), and re-exchanges to a **final** session. The bridge's authentication is **not** relaxed. **Its trigger is now LOCKED (§14C.3.9, 2026-09-29 — OD-9 resolved, M-1…M-10);** the bridge itself is still **not implemented**, and its name and payload shape remain **OD-1**. | N-1 | nothing |
| **N-5** | **Firebase-native change-password + email verification.** `updatePassword` calling N-4; `sendEmailVerification`; `reload()`; a verify-email screen; the L-6/L-7 gate. Reconcile `authMethods` and the Profile screen. **Its mechanics are now DECIDED (2026-09-29, §14C.9 — OD-3 resolved): the registration ordering, the verify screen, the client gate instead of a `requireAuth` change, and the selected deep-link return with its hosted-page fallback.** Its **delivery** half is still gated by **B-2/L-17**, and a forced token refresh is required for RG-9. | N-4 | nothing |
| **N-6** | **Retire the legacy password path.** Remove `/login`, `/register`, `loginWithPassword`, `registerBusinessOwner`, the `FIREBASE_SIGN_IN_REQUIRED` guard, their limiters, `authMethodsFor`, and the legacy branches in `lib/auth.tsx` (L-10). | N-5 | legacy login + register |
| **N-7** | **Retire the custom recovery stack.** The two reset routes, controller, service, token model, the **entire mail layer** (password recovery is its only production consumer), the six mail env names, and the 26B/27 test suites (L-11). | N-3, N-4 | 26B/27 + mail layer |
| **N-8** | **Re-scope the identity lifecycle.** `/firebase/link` and `/firebase/unlink`, `firebaseLink.service.ts`, `firebaseUnlink.service.ts`, `constants/firebase.ts`, `disconnect-firebase.tsx`, `confirmFirebaseSignIn`, `connectFirebase` (L-13). — **server-side unlink portion DONE 2026-10-01 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9**):** `/firebase/unlink` and `firebaseUnlink.service.ts` are **removed** from the committed tree and the operation re-scoped into a credential change (roadmap §27AA); what remains of N-8 is the **link** side and the Firebase-side provider surface. | N-1, **OD-2** | link/unlink (Policy B has no destination) |
| **N-9** | **Invitation-based onboarding (L-12).** Replaces `users.service.ts` `create`, which today writes a bcrypt `passwordHash` and **no `firebaseUid`** and therefore produces an account nobody can sign into once the legacy path is gone. | **O-10**, and **must land with or before N-6** | admin-created passwords |
| **N-10** | **Final verification.** Full server suite + `test:unit` + `test:db`, mobile Jest, `typecheck`, `lint`, an Android development build; iOS deferred to macOS; documentation close-out with historical records left intact. | all | — |

**★ N-9 is the step most likely to be sequenced wrongly, and it is the one that breaks real users.**
`server/src/services/users.service.ts` `create` hashes a password into `passwordHash` and writes **no
`firebaseUid`** (L144–L152). Under L-10 such an account has no way in at all. **L-12 and O-10 are
therefore a hard prerequisite of N-6, not a follow-up to it.**

**★ N-3's guard change must be explicit.**
`mobile/__tests__/phase1-rnfirebase-foundation.test.ts` currently *forbids* `sendPasswordResetEmail`,
`sendSignInLinkToEmail`, `updateEmail(`, `verifyBeforeUpdateEmail(` and `deleteUser(` inside the n
ative boundary. N-3 and N-5 legitimately need three of those. Moving them out of the `FORBIDDEN` map
is **part of the work**, not an inconvenience: the guard exists so that "not yet" cannot drift into
"accidentally", and changing it is how a phase declares the verbs it now owns.

**Coexistence is a transition state, not a destination.** While N-4 to N-7 are in flight, both reset
systems can exist — and the recorded warning stands unchanged: *"Running both is possible but means a
password can be reset through one system and not the other."* The plan closes in a definite direction
(L-3, L-11) rather than settling into permanent dual operation.

---

## 14C.7 Open decisions and blockers

| # | Item | Kind |
| --- | --- | --- |
| **OD-1** | The bridge's exact endpoint name and payload shape. `POST /api/auth/credentials-changed` with `{ idToken }` is proposed; the semantics of §14C.3 are the substance and the name is not. | Decision |
| **OD-2** | **Does unlink survive at all?** Policy B exists to move an account **from Firebase to a local password**. Firebase-only removes the destination. Options: remove unlink entirely; re-scope it to provider changes only; or keep a client-side "disconnect Google" the server cannot observe. **Blocks N-8.** — **PARTLY ANSWERED 2026-10-01 (Phase A / F-1):** the server-side ability to unlink was **removed outright** (`6e2252f`) and the operation re-scoped into a credential change, so the "remove unlink entirely" option is what shipped at the server; what stays open is the Firebase-side provider unlink the server cannot observe. | Decision |
| **OD-3** | **`emailVerified` enforcement mechanics (L-6, L-7).** — **RESOLVED 2026-09-29 (Phase 32O, §14C.9).** The gate is the **registration ordering** — no tenant, no account and no session exist until the email is verified — plus a **client verify screen** for the signed-in-but-unverified identity; **`requireAuth` is deliberately NOT modified (RG-7)**, so the Phase 23/24 authorization order and status-code contract are preserved; an unverified Google identity is **refused**, not merely warned (RG-11); resend is **native Firebase Auth** (RG-12); and the stale `User.emailVerified` problem (F-6) is **bounded rather than eliminated** — the gate applies at registration time and no per-request Firebase check is added (RG-10). The fifteen registration decisions are **RG-1…RG-15**, and audit gaps **D-5…D-9** are closed there. **This resolves O-3, and it is a behaviour change** (§14.2) — of the registration flow only. | **RESOLVED (§14C.9)** |
| **OD-4** | **O-10, the invitation model** — model, lifetime, single-use semantics, route surface, revocation, and how it replaces `users.manage` create. **Blocks N-9 (and therefore N-6).** | Decision, already open |
| **OD-5** | **The 26B/27 artefact disposition** on removal: deleted, or archived. Project convention forbids silent deletion. | Decision |
| **OD-6** | **Does `POST /api/auth/firebase/link` survive?** Every account carries a `firebaseUid` after this migration, so it has no job — but it is the only server-observable record that an identity was *attached* rather than *created*, which has audit value. | Decision |
| **OD-7** | **Is `/register` removed outright, or left for an unconfigured build?** Today `signUp` uses the legacy route when `isFirebaseConfigured()` is false. Removing it means an unconfigured build cannot register at all — possibly correct, but a deliberate choice. | Decision |
| **OD-8** | **Facebook (O-5) and Apple** are outside L-1…L-19. The missing-email onboarding flow and Apple's future scope are untouched by this design. | Decision, already open |
| **OD-9** | **The recovery-flow bridge trigger** — how the client knows, at the post-reset sign-in, that it must run the D2 sequence's steps 7–8 (§14C.3.8). — **LOCKED 2026-09-29 (Phase 32Q, §14C.3.9):** a **durable non-secret recovery marker** in `expo-secure-store` under `inventoryai.auth.passwordResetPending`, holding **only an account fingerprint**, created with `verifyPasswordResetCode(oobCode)` (email **memory-only**, never an authorization source), with **F1 automatic recovery approved** and the lifecycle, the temporary-session rule and the `401 SESSION_INVALIDATED` success-equivalence fixed as **M-1…M-10**. **Known limitation:** a reset on one device followed by the first sign-in on **another** is **not** detectable by this marker (**M-7**), so OD-9 is **not** a universal cross-device revocation guarantee. **Option E** (server-side `passwordUpdatedAt` derivation) is **DEFERRED as a separate owner decision** (**M-8**) and nothing of it is introduced. | **RESOLVED (§14C.3.9)** |
| **OD-10** | **Option E — server-side detection of a Firebase credential change (the residue M-8 leaves).** Deriving Firebase's `passwordUpdatedAt` and comparing it during `/api/auth/firebase/exchange` would close **OD-9's device-local limitation (M-7)** — a reset completed on one device followed by the first password sign-in on another — and would make the bridge largely redundant. It needs an Admin lookup on the exchange path plus a new `User` field, and a fail-open/fail-closed decision, so it is a **partial N-4 redesign**, not a refinement. **Nothing of it is introduced** by Phase 32Q; it is raised as its own decision rather than folded into OD-9. | **Decision, deferred — not blocking N-4 as designed** |
| **B-1** | **No live Firebase project has ever been exercised** for any of Phases 32B–32L. Every one of them is offline/seam-verified. | Blocker (environment) |
| **B-2** | **The action-link return leg (§14C.4) is UNVERIFIED** and gates N-3. — **PARTIALLY NARROWED 2026-09-29 (§14C.4.1):** the **Android app/OS side is VERIFIED** (`inventoryai://reset-password` resolves to the app, routes to the screen, and a query parameter is read) **and the `token`-vs-`oobCode` mismatch was found**; the **Firebase email side is still UNVERIFIED** because no inbox or Console access exists, so the gate **stays open**. | Blocker (external) |
| **B-3** | **iOS cannot be built or verified on the current Windows host.** `[EXTERNAL VERIFICATION REQUIRED]`. | Blocker (hardware) |
| **B-4** | **The mobile Jest configuration mocks nothing Firebase-related** (§19). Any test touching `lib/auth.tsx` changes in the same commit as the rewiring. | Blocker (test infrastructure) |
| **B-5** | **`test:db` and the full suite must be re-run** in each implementing step; several guards fail by *declaration* (the Phase 23 route classifier) and must change in the same commit as the route they describe. | Blocker (verification) |

**Items this migration closes:** **O-8** (Firebase takes over the reset flow — L-3, L-11), **O-9**
(`passwordChangedAt` for Firebase-native accounts — L-14, §14C.3), **O-3** (resolved outright —
OD-3's mechanics are decided in **§14C.9**, 2026-09-29), and **§18 Gate 1** / **O-6** for the mocked
population.

**Items this migration does not touch:** **O-5** (Facebook), **O-10** (invitations — its *direction* is
L-12, its *implementation* is still open), **O-11** (Expo Go).

**One recorded simplification worth keeping:** deleting the password-recovery endpoints deletes the
subject matter of **B2** (distributed reset-mail flooding of one address), which was DEFERRED TO V4 as
shared-infrastructure work. **E3** (in-memory, per-process limiter stores) **survives** for the
remaining login/exchange limiters. No shared store is introduced by this migration in either
direction.

---

## 14C.8 What this section does NOT authorise

- **No implementation.** Nothing in L-1…L-19 or N-1…N-10 is authorised to be built by this record.
  N-1 is the record itself; **Phase B (N-2 onward) requires explicit owner approval**.
- **No Firebase Console change** — no provider toggles, no email-template edits, no `ActionCodeSettings`
  registration, no test users.
- **No change to §20's frozen surface.** `authenticate.ts`, `constants/roles.ts`, the mobile RBAC
  mirror, `session.service.ts`, `session.model.ts`, `config/jwt.ts`, the global error envelope and the
  client-facing error codes all stay exactly as they are. **L-8 is an instruction to preserve them.**
- **No weakening of the §14.1 guard and no change to the exchange contract** while the legacy path
  still exists. The guard is removed by N-6 *with* the route it protects, never before it.
- **No claim that any of Phases 32B–32L is verified against a live Firebase project** (B-1), and no
  claim that the action-link flow works (B-2).
- **No historical record is rewritten.** §14.1, §14A.5, §14B.5, §14B.6, §18 and the roadmap's phase
  records keep their original wording; this section supersedes them by being later, and each is
  annotated rather than edited.

---

## 14C.9 The registration and email-verification flow (L-6/L-7 mechanics — OD-3 RESOLVED)

**Recorded 2026-09-29 (Phase 32O). Documentation only.** No application, mobile or server source, test,
dependency, schema, environment variable, Firebase Console setting, EAS configuration or deployment
change was made for this record, and none may be inferred from it. It is the durable home of the
**read-only registration/sign-up audit** performed the same day, which was reported in conversation but
previously unwritten.

**Phase identifier.** `32O` is assigned **by this section**, exactly as §14C's `32N` is; if the owner
prefers another identifier the record is renumbered rather than split.

**What it is, and what it is not.** §14C locked the *direction* (L-1…L-19) and §14C.3 designed the
bridge; **§14C.7 left OD-3 — the `emailVerified` enforcement mechanics (L-6, L-7) — OPEN.** This
section **resolves OD-3** and records the **registration order** L-6 makes necessary. It changes no
decision in L-1…L-19 and no row of §14C.3.

### The fifteen locked registration decisions (RG-1…RG-15)

| # | Decision |
| --- | --- |
| **RG-1** | **The registration order is fixed, and the order is the mechanism:** Firebase Email/Password account → **verification email sent** → the user verifies → `reload()` confirms `emailVerified === true` → **only then** Inventory AI creates the MongoDB `User` **and** `Business` → the user becomes **OWNER** → Inventory AI JWT + server session → main app. |
| **RG-2** | **No Inventory AI JWT or server session exists before email verification.** The *absence of a session* is the primary server-side gate — not a check inside a route. |
| **RG-3** | **Neither the MongoDB `User` nor the `Business` is created before email verification.** Nothing is provisioned for an unverified identity, so there is no half-registered tenant to clean up and no tenant-less state to reason about. |
| **RG-4** | **`User` + `Business` creation stay fused.** No tenant-less MongoDB `User` state is introduced and **`User.businessId` remains required** (audit gap **D-5**). |
| **RG-5** | **Firebase UID is the only Firebase→MongoDB identity join key.** Email is **never** an identity join key — not for lookup, not for collision resolution, not for linking — restating and re-binding **R-4** and §7.4 for the registration path. |
| **RG-6** | **MongoDB remains authoritative** for `businessId`, `role`, `status`, permissions and business lifecycle (L-9, unchanged). |
| **RG-7** | **`requireAuth` is NOT modified for the registration verification gate.** The existing Phase 23/24 authorization order, error codes and status-code invariants are preserved exactly. |
| **RG-8** | **Verification is required before entering the main Inventory AI application for the new Firebase registration flow** — L-6 in force for this flow. |
| **RG-9** | **After verification the app must call Firebase `reload()` and obtain a *fresh* Firebase ID token** before completing Inventory AI registration or session creation (audit gap **D-6**). A cached token must not carry the pre-verification claim into the exchange. |
| **RG-10** | **`emailVerified: true` is persisted in MongoDB after verified registration.** Firebase remains the identity/verification authority, and **the server must not call Firebase on every normal API request.** |
| **RG-11** | **Google registration follows the Firebase `email_verified` claim** (L-7). Verification is **never** assumed from the provider name. |
| **RG-12** | **Resend-verification uses the existing native Firebase Auth boundary where possible.** No custom verification-token or mail system is introduced. If a backend resend route is technically required, that is an **explicit follow-up decision**, not part of this record (audit gap **D-7**). **⛔ SUPERSEDED 2026-10-02 by §14C.10 (AUTH-04):** email verification is a **custom 6-digit Inventory AI code delivered by Resend**, and the native Firebase verification email/resend is retired in the client flow. This row is preserved as the historical record and is **not** rewritten. |
| **RG-13** | **Verification-link return behaviour is selected below** (audit gap **D-8**): the Inventory AI return/deep-link flow is preferred where it can be implemented safely with the existing Firebase/native-link architecture, and a Firebase-hosted verification page followed by app `reload()` is the recorded fallback. **Neither is implemented now.** **⛔ SUPERSEDED 2026-10-02 by §14C.10 (AUTH-04):** the verification-link return question is **moot** — AUTH-04 uses a 6-digit code, not a verification link. This row is preserved as the historical record and is **not** rewritten. |
| **RG-14** | **The legacy `/api/auth/register` / bcrypt registration path remains transitional until N-6** (audit gap **D-9**). The new Firebase flow is **not** weakened to accommodate it, and **universal** email-verification enforcement becomes possible only after the legacy registration path is retired. |
| **RG-15** | **Nothing here introduces** Firebase custom claims, Firestore, tenant-less users, email-based account linking, a new authentication provider architecture, or new mail infrastructure. |

### Where the gate lives — the resolution of OD-3

**Enforcement is the ordering, plus one client screen.** L-6/L-7 are satisfied by RG-1/RG-2/RG-3 — no
tenant, no account and no session exist until the email is verified — together with a **client-side verify
screen** for the in-between state: an authenticated Firebase identity that has not yet verified is held
on that screen and may resend (RG-12).

**Why it is deliberately *not* a `requireAuth` check (RG-7).** Putting the gate inside the single
authentication choke point would (a) change the Phase 23/24 authorization order and the status-code
contract §20 freezes, and (b) strand **every already-shipped client**, because a server-side check cannot
be deployed in lockstep with the builds it would reject. The gate is therefore **structural** — nothing
exists to authenticate against — rather than a conditional inside an existing route. This is the
"client gate vs server gate" half of OD-3, and it is a **behaviour change of the registration flow
only**: no existing route's outcome changes.

**What an unverified user may reach.** Nothing but the verification surface. There is no `Business`, no
`User`, hence no session, no token, and therefore no authenticated route at all (RG-2/RG-3).

**Google (L-7, RG-11).** An unverified Google identity is **not** treated as verified — it is refused by
the same gate, not merely warned.

**The staleness problem (finding F-6) is bounded, not solved.** `User.emailVerified` is written **only**
at exchange/link/register time, so it is stale between those events. This record adds **no** per-request
Firebase check (RG-10 forbids it) and **no** `requireAuth` comparison (RG-7 forbids it). The consequence
is stated so it is not mistaken for coverage: **the gate is enforced at registration time, and a later
Firebase-side change to verification state is not reflected on an existing session.** A per-request
refresh would be a separately-approved change to the frozen §20 surface.

### Verification-link return behaviour (RG-13, audit gap D-8)

Two shapes were on the table; **one is selected and the other is recorded as the fallback.** Neither is
implemented by this record.

**Selected — the Inventory AI return/deep-link flow.** It needs **no new infrastructure**: the app
registers exactly one scheme (`inventoryai`), and Expo Router maps a scheme path to a route with **no
per-path native configuration**. Phase F2.9 runtime-verified that `inventoryai://reset-password`
resolves to the app **and** routes to the screen, and the Phase N-3 device run showed the live project
**accepting** a custom-scheme `ActionCodeSettings` (`inventoryai://reset-password`,
`handleCodeInApp: true`). An N-5 verification link is the same mechanism on a different path (e.g.
`inventoryai://verify-email`), so it inherits a proven receiving end and a proven settings shape.

**Recorded fallback — the Firebase-hosted verification page, then app `reload()`.** It needs **no**
`ActionCodeSettings` and no continue-URL acceptance at all, and RG-9's `reload()` + fresh-token step
behaves identically whether the link was opened in the app or in a browser. It is the safer shape
exactly where the primary is weakest.

**The caveat that must travel with the selection.** The primary inherits **L-17's open gate**: the
*mobile/OS* half of Firebase action-link delivery is verified, but the **Firebase email half has never
been exercised** — no inbox, no Console access (§14C.4.1) — so whether the emailed link actually
returns to the app carrying a code remains **UNVERIFIED**. For N-3 that was tolerable because the legacy
recovery path still covered the capability; for registration there is **no equivalent fallback for an
unverified user**, which is why the hosted page is recorded as a live alternative rather than
discarded. **The delivery half must be measured against a live project before the flow is claimed to
work.**

### The audit gaps this record closes

| Gap | Resolution |
| --- | --- |
| **D-5** | `User.businessId` stays **required**; `User` + `Business` remain fused after verification — **RG-4**, with RG-3 making the fusion structural rather than a rule. |
| **D-6** | **Firebase `reload()` + a fresh ID token** is the verification refresh mechanism for registration — **RG-9**. |
| **D-7** | **Resend is native Firebase Auth** unless a backend route is later proven necessary; a backend resend route is an explicit follow-up, not part of this record — **RG-12**. |
| **D-8** | The **verification-link return behaviour is selected** in place, with the alternative recorded and the L-17 caveat attached — **RG-13** and the subsection above. |
| **D-9** | **Legacy registration is transitional**; the new Firebase flow follows the verification requirement; **N-6 retires the legacy path**, and only then does universal enforcement become possible — **RG-14**. |
| **OD-3** | **DECIDED 2026-09-29 by this section** — the gate is the registration ordering plus a client verify screen, `requireAuth` is untouched, an unverified Google identity is refused, and the F-6 staleness is bounded rather than eliminated. |

### Today, versus after this record is implemented

| Step | Today (shipped) | After (N-5) |
| --- | --- | --- |
| Account creation | `register.tsx` → `signUp()` → `ensureFirebaseAccount` → `nativeCreateUserWithEmail` | same |
| Verification email | **never sent** | sent (**RG-1**) |
| MongoDB `Business` + `User` | created **immediately** by `POST /api/auth/firebase/register` (`registerBusinessFromFirebase`), OWNER, ACTIVE, one step | **not created** until verified (**RG-3**) |
| Verification state | persisted only, **never enforced** — `firebaseAuth.service.ts` says so in place | required before entry (**RG-8**) |
| Session | minted immediately by `POST /api/auth/firebase/exchange`; the user is inside `(app)` | only after verification (**RG-2**) |
| Verify screen | **does not exist** — `mobile/app/` holds `index`, `login`, `register`, `register-firebase`, `forgot-password`, `reset-password` | new screen (**RG-8**) |
| `(app)` gate | `status !== 'signedIn' ⇒ /login` — **no verification gate** | unchanged **plus** the verify screen (**RG-7**) |

### One implementation note recorded from source (so a future implementer does not assume it)

`sendEmailVerification` and `reload` are **not** in the Phase 1 `FORBIDDEN` verb map
(`mobile/__tests__/phase1-rnfirebase-foundation.test.ts`) — that map forbids `sendSignInLinkToEmail`, the
auth-state listeners, `setPersistence`, `reauthenticateWith`, `deleteUser(`, `updateEmail(`,
`verifyBeforeUpdateEmail(`, `linkWithCredential` and `unlink(` — so **N-5 does not need the N-3-style
relaxation** for those two verbs. **RG-9 is not satisfied by the boundary as it stands, however:**
`nativeCurrentIdToken()` calls `user.getIdToken()` with **no argument**, which returns the cached token
and refreshes only near expiry, so a token minted *before* verification can still carry
`email_verified: false`. A **forced refresh** (`getIdToken(true)`) is the shape RG-9 requires, and that
is a change to the boundary module, not to the guard.

### What §14C.9 does NOT authorise

- **No implementation.** No route, service, validator, controller, screen, model, migration, guard
  change or test may be added on the strength of this record. **N-5 remains unauthorised**, and its
  prerequisites (§14C.6: **N-4 first**; **B-2/L-17** for the delivery half) are unchanged.
- **No change to `requireAuth`, `constants/roles.ts`, the mobile RBAC mirror, `session.service.ts` /
  `session.model.ts`, `config/jwt.ts`, the global error envelope or any client-facing error code** —
  RG-7 and §20 preserve them.
- **No removal** of the legacy `/api/auth/register` path or its bcrypt hashing (RG-14), and none of the
  26B/27 recovery stack; their retirement remains N-6/N-7.
- **No Firebase Console change** — no action-code template edit, no authorized-domain or continue-URL
  registration.
- **No new dependency, schema field, index or environment variable.** `emailVerified` already exists on
  the `users` model (Phase 32B) and is **persisted but not enforced** today; this record says what
  changes that, not how.
- **No claim that any of it is verified, or even implemented.** The flow described here **does not exist
  in the shipped code**, and its delivery half is gated by an **externally blocked** live-test
  requirement (B-2).
- **No historical record is rewritten.** §14.2, §14A.5, §14C.6, §14C.7 and the roadmap keep their
  original wording; each is annotated rather than edited.

---

## 14C.10 AUTH-04 — the custom 6-digit email-verification code flow (SUPERSEDES the §14C.9 link/resend mechanism)

**Recorded 2026-10-02. Documentation only.** No application, mobile or server source, test, dependency,
schema, index, environment variable, Firebase Console setting, EAS configuration or deployment change
was made for this record, and none may be inferred from it. It records a **product/architecture decision
already taken** and supersedes the *mechanism* of **§14C.9 RG-9 / RG-12 / RG-13** — the Firebase
verification-link email and its native resend. It changes no other decision in L-1…L-19.

**What changes, and what does not.** The superseded direction was *"Firebase sends the verification
email; the user opens a Firebase link; the app reloads and reads the signed claim."* The new direction
is *"Inventory AI originates a 6-digit code, emails it itself through the provider-agnostic mail
boundary (Brevo), verifies it itself, and only
then sets Firebase's own verification state through the Admin SDK."* **Firebase remains the identity
provider and the authority of record** for the final `email_verified` state; **MongoDB remains
authoritative** for `businessId`, `role`, `status`, permissions and lifecycle; **`requireAuth` is not
modified.**

### Preserved, unchanged (restated, not newly decided)

Firebase UID is the only Firebase→MongoDB join key and **email is never a join key** (**RG-5**);
MongoDB authority (**RG-6**); `requireAuth` untouched — the gate is **structural** (no tenant, no
account and no session exist before verification) rather than a check inside the choke point
(**RG-7**, §20); verification is decided from the Firebase **claim**, never the provider name
(**RG-11**); no custom claims, no Cloud Function, no custom long-lived refresh token, no email-based
linking (**RG-15**); and no new `User`/`sessions` field, session type or session surface is introduced.

### The locked AUTH-04 design

| # | Decision |
| --- | --- |
| **AD-1** | **6-digit code, CSPRNG** — six decimal digits from a cryptographically secure source. |
| **AD-2** | **HMAC-SHA256, domain-separated** — `codeHmac = HMAC(pepper, "code:" + code)` and `emailHmac = HMAC(pepper, "email:" + normalizeEmail(email))`. Plain SHA-256 is never used and the two domains cannot be confused. |
| **AD-3** | **`EMAIL_VERIFICATION_CODE_PEPPER` is required.** Missing/empty/malformed ⇒ **503 `EMAIL_VERIFICATION_NOT_CONFIGURED`**, with **no unkeyed fallback**; production **fail-fast** joins `validateProductionConfig` when the flow is configured. |
| **AD-4** | **No plaintext secrets at rest or in logs** — the code, `codeHmac`, `emailHmac` and the pepper are never stored in plaintext, never returned, and never logged. |
| **AD-5** | **Challenge collection `email_verification_challenges`** — `uid`, `codeHmac`, `emailHmac`, `lastSentAt`, `expiresAt`, `attempts`, `usedAt`, `createdAt`. Stores **no** plaintext code, email, token or pepper. |
| **AD-6** | **UID-bound challenge, one active per uid** — a **unique `{uid}` index** (supersede in place, not a partial "unused" index) plus a **TTL `{expiresAt}` index for cleanup only**; expiry is additionally enforced in every predicate, so a delayed sweep can never widen a window. |
| **AD-7** | **10-minute expiry.** |
| **AD-8** | **5 attempts maximum.** A correct code **reserves/consumes** an attempt atomically; an already-verified identity short-circuits **before** any reservation. |
| **AD-9** | **60-second server-enforced resend cooldown**, anchored on `lastSentAt`. |
| **AD-10** | **Atomic supersession** — a new request replaces the prior challenge in place through one cooldown-predicated conditional update (`codeHmac`/`emailHmac`/`expiresAt` replaced, `attempts: 0`, `usedAt: null`, `lastSentAt: now`). |
| **AD-11** | **Atomic attempt reservation** — `findOneAndUpdate({ uid, usedAt: null, expiresAt: { $gt: now }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } })`; already-verified/expired/invalid are refused before or by the predicate. |
| **AD-12** | **Write-first, consume-second; fail-closed single use** — the Firebase Admin write runs first, then a conditional `findOneAndUpdate({ _id, usedAt: null }, { $set: { usedAt: now } })` consumes the challenge. If the Firebase write fails, `usedAt` is **not** set; **no branch ever unsets `usedAt`**. |
| **AD-13** | **Concurrency-safe confirmation** — two concurrent valid confirmations may both reach the idempotent Admin write, but only one `usedAt` transition occurs; repeats are idempotent and do not overwrite state. No distributed locking. |
| **AD-14** | **Already-verified idempotency** — an identity whose Firebase `email_verified` is already true short-circuits to success without minting, reserving or consuming anything. |
| **AD-15** | **Firebase Admin bridge** — the only new Firebase write capability is `updateUser(uid, { emailVerified: true })`. The **uid comes only from the verified Firebase ID token**, never from a client-supplied field. Admin initialization stays centralized in `services/firebase/adminApp.ts`; the bridge is expected under `services/firebase/` with a test seam mirroring `setFirebaseIdTokenVerifier`. |
| **AD-16** | **Email is delivered by Inventory AI through the provider-agnostic mail boundary**, not by Firebase's verification email — extending `services/mail/` with a template and `sendEmailVerificationEmail`. **Brevo is the provider used in development and production, and the one used for the AUTH-04-G live acceptance (2026-10-04).** |
| **AD-17** | **Mail/config failure semantics** — (A) missing/invalid mail or pepper configuration fails **before** a code is minted and leaves any existing challenge **untouched**; (B) a mail delivery failure after the challenge is created leaves the **new** challenge current, does **not** restore the old one, applies **no rollback**, keeps the **cooldown in force**, and returns a stable error (`EMAIL_VERIFICATION_MAIL_FAILED`). |
| **AD-18** | **Structured logging by explicit allowlist** — only fixed event names (`email_verification_code_requested`, `email_verification_completed`, `email_verification_failed`, `email_verification_bridge_failed`); no code, `codeHmac`, `emailHmac`, email, pepper, Firebase ID token, password or raw body/provider payload is ever logged. |
| **AD-19** | **Rate limiting** — new limiter factories in `middlewares/rateLimit.ts`, registered in `routes/auth.routes.ts`, using the existing draft-7 `limitResponse()` so `Retry-After` is emitted; code `EMAIL_VERIFICATION_RATE_LIMITED`. Stores remain in-memory/per-process (**E3**, deferred to V4). |

### The AUTH-04 API contract

Two **pre-session Firebase-authenticated** endpoints — never described as "public routes" (they require a
Firebase ID token), and requiring **no** Inventory session and **no** `requireAuth`:

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /api/auth/email-verification/request` | `{ idToken }` | verifies the Firebase ID token, then mints and mails a code |
| `POST /api/auth/email-verification/confirm` | `{ idToken, code }` | verifies the Firebase ID token, checks the code, then bridges `emailVerified = true` |

The validator returns only `{ problems, idToken[, code] }`, so a body carrying `uid`, `email`, `userId`,
`businessId`, `role` or `status` is **inert by construction**. Firebase ID token verification uses the
existing `verifyFirebaseIdToken` boundary (`checkRevoked: true`, issuer/audience asserted). **Confirmation
creates no Inventory session or JWT** — the session is still created only by
`POST /api/auth/firebase/exchange`.

### AUTH-04 error semantics

| Condition | Status / code |
| --- | --- |
| Invalid / expired / revoked Firebase token | 400 `FIREBASE_TOKEN_INVALID` (never 401 — the client's session-loss rule acts on 401/403) |
| Firebase not configured | 503 `FIREBASE_NOT_CONFIGURED` |
| Firebase unreachable | 503 `FIREBASE_UNAVAILABLE` |
| Admin `auth/user-not-found` / `auth/user-disabled` | 400 `FIREBASE_TOKEN_INVALID` |
| Admin `auth/invalid-credential` | 503 `FIREBASE_NOT_CONFIGURED` |
| Other Admin write failure | 503 `FIREBASE_UNAVAILABLE` |
| Invalid / expired / exhausted code | 400 `INVALID_VERIFICATION_CODE` |
| Missing / invalid pepper | 503 `EMAIL_VERIFICATION_NOT_CONFIGURED` |
| Rate limited | 429 `EMAIL_VERIFICATION_RATE_LIMITED` |
| Mail delivery failure after a challenge is current | 503 `EMAIL_VERIFICATION_MAIL_FAILED` (stable) |

### The mobile flow

```
Firebase account creation
→ request verification code
→ email received
→ user enters 6 digits
→ confirm code
→ Firebase emailVerified = true
→ reload / force-refresh the Firebase identity
→ firebaseRegister
→ firebaseExchange
→ Inventory AI session
→ authenticated app
```

Required behaviours: wrong code · expired code · exhausted attempts · resend cooldown · rate limiting
(`Retry-After`) · network interruption · transient backend failure · **app restart while unverified** ·
already-verified idempotency — each mapping to the AD-14/AD-17/AD-19 contracts.

**★ Open decision — restart while unverified.** `firebaseOnboarding` is **in-memory**, while native
Firebase persistence is **durable**. After an app restart, an identity signed in to Firebase but
unverified does **not** re-arm the verification screen and currently falls through to login/register.
**This is the one remaining mobile UX decision and MUST be resolved before AUTH-04-F.** It is recorded
here explicitly rather than invented: the candidate behaviour (re-request is always safe; confirm is
already idempotent via AD-14; the server holds no client-controlled identity, so a restart cannot steer
it) is available, but **no rule is chosen by this record.**

### What §14C.10 does NOT authorise, and cannot be inferred from it

- **No implementation (as of the 2026-10-02 record).** No route, service, validator, controller, screen,
  model, index, migration, dependency, environment variable, Firebase Console change or test was added
  or authorised by this record. **⛔ SUPERSEDED 2026-10-04 (AUTH-04-H):** AUTH-04-A through AUTH-04-F
  are now **shipped**, **AUTH-04-G PASSED its live acceptance gate (2026-10-04, Brevo)**, and AUTH-04-H
  is the documentation close-out. The sentence is preserved as the historical record.
- **No change to `requireAuth`, `constants/roles.ts`, the mobile RBAC mirror, `session.service.ts` /
  `session.model.ts`, `config/jwt.ts`, the global error envelope or any client-facing error code.**
- **No removal** of the existing Firebase verification-link implementation yet (that is AUTH-04-F), and
  no removal of the legacy registration path or the 26B/27 recovery stack. **⛔ SUPERSEDED 2026-10-04:**
  AUTH-04-F **shipped**, and the Firebase verification-link flow is no longer the current client path.
- **No rewrite of history** — §14C.9's RG rows are annotated in place and preserved; this section
  supersedes only the *mechanism* it names.
- **No claim that any of it is implemented or verified (as of 2026-10-02).** The flow described here did
  not exist in the shipped code at that time, and the Firebase Admin `updateUser` permission and live
  mail delivery were **UNVERIFIED**. **⛔ SUPERSEDED 2026-10-04 (AUTH-04-G/H):** the flow **is shipped**,
  and the live gate **PASSED on Brevo** — request HTTP 200 with the exact success envelope, Brevo
  `sent` → `delivered`, confirmation HTTP 200 with `Email verified.`, Firebase `emailVerified` false →
  true, and the Mongo challenge consumed. `updateUser` was exercised live. Physical-device mobile
  acceptance remains as recorded for AUTH-04-F.

---

# 15. Rate limiting considerations

The exchange endpoint is a **public** route that mints sessions, making it the highest-value target
introduced by Phase 32.

- **It must be rate limited from the day it ships**, reusing the existing limiter factories in
  `server/src/middlewares/rateLimit.ts` rather than adding a new mechanism.
- **`skipSuccessfulRequests` must be OMITTED.** The same reasoning the recovery limiters already
  document applies: a successful exchange is a 2xx, and skipping 2xx would exempt precisely the
  traffic the limiter exists to bound. The option appears only on the two Phase 07B login limiters,
  and both facts are guarded by tests.
- **A `verifyIdToken` call is not free.** Google's verification is a cryptographic check against
  cached public keys, but an unthrottled endpoint still lets an attacker force work.
- **Two buckets are worth having**, mirroring the login design: a per-IP cap (address rotation
  backstop) and, if a stable key exists, a per-identity cap. Note that the identity is unknown until
  *after* verification, so an identity-keyed bucket necessarily costs one verification first.
- **The `REGISTRATION_REQUIRED` path must be counted, not skipped.** It is a legitimate outcome but
  also an enumeration surface for "which Firebase identities exist".
- **Limiter stores remain in-memory and per-process** (E3, deferred to V4). Phase 32 does not change
  that, and must not claim protection it does not have: behind more than one instance, limits are
  per-instance.
- **Route classification.** Two new public routes take the Phase 23 inventory from **60 → 62 routes**
  and **6 → 8 public**. `phase23-authorization-contract.test.mjs` **must be updated in the same
  commit** with a written reason for each, and it will fail until it is. That guard asserts bucket
  *membership*, not counts, so it fails on the declaration, which is the intended design.

---

# 16. Failure scenarios

## 16.1 Firebase unreachable or returning errors

| Situation | Outcome |
| --- | --- |
| Firebase down, user already signed in | **Unaffected.** Application JWTs are ours; every API call works. This is a property of Option B. |
| Firebase down, user signing in | Sign-in fails with a retryable error. No session is created. |
| Firebase slow | Bounded by an explicit timeout, mirroring `MAIL_REQUEST_TIMEOUT_MS`'s precedent. |
| Misconfigured project id (audience mismatch) | **Every** verification fails. The most likely misconfiguration, and it fails closed and loudly. |

## 16.2 Verification failures (all 401, never 500)

Expired token · invalid signature · wrong issuer · wrong audience · malformed token · token from a
different Firebase project. Each must map to a distinct, **server-side-logged**, client-safe message.
A 500 here would leak that verification was attempted and failed internally.

## 16.3 Identity resolves to no MongoDB user

`REGISTRATION_REQUIRED` — a normal outcome for a valid identity with no tenant, **not** an error
status. It is what makes orphaned federated registrations self-healing (§8.2).

## 16.4 Identity resolves to a disabled or suspended principal

403 `ACCOUNT_DISABLED` / 403 from `assertActiveBusiness` — identical to today's password login, so a
disabled user cannot bypass the gate by switching sign-in method.

## 16.5 Credential collision

A Google sign-in whose email matches an existing password account. Without the §14.4 decision this
raises `auth/account-exists-with-different-credential`. **It must be handled explicitly; surfacing a
raw Firebase error string to the user is not acceptable.**

## 16.6 Orphaned Firebase account

**The recoverable case.** Registration step 4 fails after step 1 succeeded. Recovered by
`REGISTRATION_REQUIRED` (§8.2): the retry adopts the existing identity. For email/password that adoption
requires the **same password**, so it proves the caller owns the credential rather than merely knowing
the address.

**The unhealable case — KNOWN LIMITATION, no fix implemented (recorded by Phase 32E, 2026-09-20).**
A **legacy MongoDB account** (a `User` with a `passwordHash` and no `firebaseUid`) can have a Firebase
identity created for the same email without ever being linked to it:

1. Someone registers on the mobile client with that email. Step 1 creates the Firebase identity —
   Firebase knows nothing about the MongoDB user, so this succeeds.
2. `POST /api/auth/firebase/register` finds `User.exists({ email })` and answers `409 EMAIL_IN_USE`
   (account linking is refused, not implemented — `server/src/services/firebaseAuth.service.ts`).
3. The Firebase identity is left orphaned.

The §8.2 self-healing path does **not** apply: `exchangeFirebaseSession` resolves a user by
`firebaseUid` **only, never by email**, so that identity can never resolve to the existing MongoDB
account, and every retried registration fails its pre-check the same way. The orphan is permanent.

**What it is not.** Not an account takeover and not a lockout. Because the exchange never matches by
email, the holder of the orphaned identity receives `REGISTRATION_REQUIRED` rather than a session; and
the legacy account is unaffected — it carries no `firebaseUid`, so the §10 guard does not fire and its
password login keeps working.

**Why no fix is implemented here.** Client-side deletion of the Firebase account on failure is rejected
by §8.2 as racy, and a server-side pre-check would be a new public route requiring its own Phase 23
authorization classification — neither belongs in this increment. The limitation is recorded so that the
migration/linking phase owns it.

**Binding constraint on the migration/linking phase.** When lazy link-on-login (§9.1) creates the
Firebase user for an existing account via `admin.auth().createUser()`, it will receive
`auth/email-already-exists` for exactly these addresses. That outcome **MUST NOT be allowed to fail the
legacy password login** — a user would otherwise be locked out of their own account by a Firebase
identity they never created. The linking phase must handle the collision explicitly (for example by
adopting the existing identity once the credential is proven) rather than treating it as a login error.

## 16.7 Client-side session desynchronization

The application JWT is revoked but the Firebase session is live. The next request returns 401
`SESSION_REVOKED`, the existing `sessionLostHandler` clears local state, and the user signs in again —
or the client re-exchanges silently if a Firebase session remains. **Both paths must be exercised in
the emulator smoke (Phase 32H); neither is unit-testable.**

## 16.8 Service-account key misconfiguration on Render

A PEM stored through a web UI routinely loses its real newlines. This fails at startup, not at first
login, and the mitigation is a single base64 `FIREBASE_SERVICE_ACCOUNT_JSON` variable instead of three
separate ones (§17).

---

# 17. Required configuration

## 17.1 Server secrets (never in the app, never in git)

```
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

**Recommended instead of the three above:** a single base64-encoded
`FIREBASE_SERVICE_ACCOUNT_JSON`, which eliminates the newline-mangling failure class entirely.

Production fail-fast joins the existing `validateProductionConfig` contract: if any Firebase variable
is set, all required ones must be present and the key must parse — and the error message names only
the **variable**, never the value, matching the existing convention. In development and test these
checks stay lenient so the server still boots without Firebase configured.

`server/.env.example` gains these names with comments and **no values**.

## 17.2 Mobile configuration

**M1:** no new environment variables. Configuration arrives through the native files referenced by
`app.json`'s `googleServicesFile`, plus the iOS URL scheme. New plugins are required in `app.json`
(Firebase, Google Sign-In, and `expo-build-properties` for the iOS static-framework requirement).

**M2:** `EXPO_PUBLIC_FIREBASE_*` variables (apiKey, authDomain, projectId, appId, …) added to
`mobile/.env.example` with names only.

**Either path preserves:** `scheme: "inventoryai"`, both platforms' `com.inventoryai.app` identifier,
`extra.eas.projectId`, `owner`, and the existing `expo-router` / `expo-secure-store` / `expo-camera`
plugins.

---

# 18. Verification gates (UNVERIFIED)

Two facts are load-bearing for Phase 32 and **could not be verified** while writing this document.
The authoritative documentation pages returned truncated content, and neither fact may be asserted
from memory. **Both must be resolved before the phases that depend on them are planned in detail.**

> **Reconciled 2026-09-29 (Phase 32N).** Gate 1 below is **no longer live for the current
> population.** The owner has fixed that all current MongoDB users are **mocked development/test data**
> and that **no legacy-user migration or bulk `auth:import` is to be built** (§14C). Gate 1 would only
> matter again if a real pre-Firebase population ever had to be migrated, and this note does not settle
> it — it records that the dependent work is not planned. **Gate 2 has since been OBSERVED satisfied in
> practice** by the Phase F2.9 EAS development build and the Phase 32G build, which compiled, installed
> and ran the config-plugin-resolved native surface. The original wording is preserved below and is not
> rewritten.

**Gate 1 — Firebase `auth:import` support for our existing bcrypt hashes. Status: UNVERIFIED.**
The Admin SDK import page's visible content listed only `HMAC_SHA256`, `SCRYPT` and `STANDARD_SCRYPT`;
a bcrypt entry was not present in the retrieved excerpt, and the CLI page returned navigation chrome
rather than its article body. Our hashes are `bcryptjs` rounds 10.

- *Affects:* §9.3 bulk migration only. **Lazy migration is unaffected.**
- *If it fails:* bulk import is impossible; the fallback is lazy migration plus a forced-reset
  campaign, whose user-visible cost the owner must accept.
- *How to settle it:* `firebase auth:import --help` against the pinned CLI version, plus the CLI
  reference's article body — **not** a summary.

**Gate 2 — the exact React Native Firebase Expo config-plugin configuration for Expo SDK 57.
Status: UNVERIFIED.**
Expo's own guide names `@react-native-firebase/app` and confirms the Expo Go incompatibility, but it
carries no `app.json` snippet, no `googleServicesFile` key placement, and no `expo-build-properties`
settings; it defers to rnfirebase.io, whose `/auth/usage` page returned the plain-React-Native path
without Expo detail. The per-service auth package name and the plugin options are therefore unconfirmed
for SDK 57.

- *Affects:* §12 M1, §13.1 and §17.2 — i.e. **any phase that touches native mobile configuration.**
- *How to settle it:* the rnfirebase.io Expo page, plus `npx expo config --type introspect`, which
  reports the *resolved* native surface after plugin auto-discovery and is the only check that sees
  plugins contributed by installed modules. **It requires no build.**

**A third item, not a gate but a constraint:** Phase 30A records that **no EAS build has ever been
executed**. M1 therefore forces the project's first EAS build, its first keystore, and the two-build
fingerprint bootstrap (§13.3). Any M1 schedule must carry that risk.

---

# 19. Testing strategy

| Area | Kind | Notes |
| --- | --- | --- |
| Expired / invalid-signature / wrong-audience / malformed ID token | Unit, stubbed verifier | No Firebase project required |
| Unknown uid → `REGISTRATION_REQUIRED` | DB-backed | Not a 404 |
| Disabled user, unknown MongoDB user | DB-backed | Must match today's codes exactly |
| **`firebaseUid` in the request body is ignored** | DB-backed | **Mandatory** — without it the central security claim is untested |
| `firebaseUid` sparse-unique: two legacy users with no uid both insert | DB-backed | The §7.2 trap |
| Exchange mints a session usable by all 47 gated routes | DB-backed | Proves the two layers compose |
| **RBAC + tenant isolation + cross-business attempts** | **Reuse Phase 24's matrix, untouched** | Its expectations are derived from `hasPermission`, so it must stay green without edits |
| Route classification 60 → 62, 6 → 8 public | DB-free | `phase23-…` updated in the same commit |
| Rate limiting on the exchange route | DB-backed | Including that `skipSuccessfulRequests` is absent |
| Registration sequence and the orphan path | DB-backed | |
| Google Sign-In | **Emulator smoke only** | Not unit-testable |
| Persisted session across app restart | **Emulator smoke only** | |
| Logout clears **both** credentials | **Emulator smoke only** | The two-credential trap |
| Silent re-exchange after JWT expiry | **Emulator smoke only** | |
| Legacy login still works (regression) | DB-backed | The rollback property, asserted |

**Constraint:** the mobile suite currently mocks nothing Firebase-related; M1 requires mocking the
native module in `jest.config.js`, and any test touching `lib/auth.tsx` must be updated in the same
commit as the rewire.

---

# 20. What must NOT change

- `server/src/middlewares/authenticate.ts` — check order, error codes, `req.user`/`req.auth` shapes
- `server/src/constants/roles.ts` — 4 roles, 21 permission keys **and their exact values**,
  `ROLE_PERMISSIONS`, `CATALOGUE_ONLY_PERMISSIONS`
- `mobile/lib/permissions.ts` — the Phase 23 mirror stays in lock-step with the server
- The Phase 23 route classification — new routes are **declared**, never exempted
- `businessId` derived from the MongoDB `User`; never from a body, query, or header
- The global 404/error envelope `{error, message}` carrying **no** `code`
- Client-facing codes the mobile app branches on: `ACCOUNT_DISABLED`, `SESSION_REVOKED`,
  `SESSION_INVALIDATED`, `INVALID_TOKEN`, `AUTH_REQUIRED`, `EMAIL_IN_USE`, `INVALID_CREDENTIALS`
- `server/src/services/session.service.ts` and `models/session.model.ts`
- `server/src/config/jwt.ts`
- Phase 21's archive-only product invariant and the AI read-only boundary
- `assertBusinessAccess` — production-dead, byte-identical (Phase 24 pinned its inertness)
- No secret in git; `.env.example` carries names only

**Added by Phase 32F (§14A) — the multi-provider invariants.** These bind every future provider phase
and are listed here so they sit with the rest of the frozen surface:

- **The Firebase exchange stays UID-authoritative.** It resolves a user by `firebaseUid` and **never by
  email**; an unresolved UID keeps the existing registration-required behaviour.
- **The `firebaseUid` login guard stays.** `loginWithPassword` continues to refuse a linked account
  with `403 FIREBASE_SIGN_IN_REQUIRED`, in the same position (after the password comparison and the
  status check, before the session write). It is not to be removed or weakened.
- **Sessions stay provider-neutral.** `models/session.model.ts` gains **no provider field** and no
  provider-specific session type may be introduced.
- **`businessId`, `role`, `status`, Firebase linkage, permissions and subscription access are
  server-controlled** and are never read from the mobile client.
- **Email is not an account-linking join key.** No provider identity may be linked to an existing
  account because the addresses match (§14A.4).
- **Subscription ownership is business-level**, never keyed to a Firebase UID.
- **The 4 roles, 21 permission keys, `ROLE_PERMISSIONS` and the Phase 23 mobile mirror are unchanged**
  by any provider work.

---

# 21. Phase outline (not authorised by this document)

Recorded for sequencing only. **The dependency order differs from the original brief**: the server
exchange endpoint must exist before any mobile work, because mobile has nothing to exchange against
otherwise.

| Phase | Scope | Depends on |
| --- | --- | --- |
| **32A** | This document. Documentation only. | — |
| **32B** ✅ | **Shipped.** Server Admin SDK: dependency, `config/firebase.ts`, verifier wrapper, env + fail-fast, `firebaseUid` / `emailVerified` / `passwordHash.required:false`, `.env.example`. **No routes.** Gate 1 not required. | 32A approval, Gate 2 if native config changes |
| **32C** ✅ | **Shipped.** Exchange + registration routes, service, limiters, Phase 23 classifier update. | 32B |
| **32D** ✅ | **Shipped.** Firebase JS SDK boundary on mobile: `mobile/lib/firebase.ts`, the SDK version, initialization order, the `inMemoryPersistence` decision and the `EXPO_PUBLIC_FIREBASE_*` gate. Infrastructure only — no screen reached Firebase. | 32C |
| **32E** ✅ | **Shipped.** Firebase email/password authentication flow: Firebase-first sign-in, the legacy fallback confined to the two codes that mean "no Firebase identity answers to these credentials", `ensureFirebaseAccount`'s orphan adoption, and the server-side `firebaseUid` login guard (§10, §11, §14.1). | 32D |
| **32F** ✅ | **Shipped as something other than this table planned** — see the note below. Decision record and documentation close-out: the eleven resolved owner decisions (§14A.3), the linking policy (§14A.4), the open register (§14A.5), and reconciliation of the specification, README, roadmap and CLAUDE.md. **Documentation only — no code, schema, dependency, route, configuration, payment or EAS change.** | 32E |
| *(deferred)* | Google Sign-In: fingerprints, URL scheme, the second build, credential-collision handling. **A later phase, still not numbered.** §14.4 is now **resolved** (§14A, R-4/R-8/R-9): no automatic linking, and explicit linking requires ownership proof. Still requires **§14.5 (M1 vs M2)** and the first EAS build. | — |
| *(planned)* | MongoDB sync: `firebaseUid` backfill, admin-created users, reconciliation. **This was the row this table called "32F"; the number has since been used for the decision record above, so this work is now unnumbered.** | 32E, §14.3 |
| *(planned)* | Migration/compat: legacy path retained, lazy link-on-login, bulk import **if Gate 1 permits**. | Gate 1, §14.7, §14.9 |
| *(planned)* | Test suites + emulator smoke. | Migration phase |
| *(planned)* | Production readiness: Render secrets, monitoring, runbook, rollback rehearsal. | Test phase |

**Reconciled 2026-09-20 (Phase 32E).** This table is the **plan** Phase 32A recorded, not the shipped
sequence, and the two diverged deliberately. The mobile work was re-split by the owner as it shipped:
**32D** became the Firebase client boundary and **32E** became the email/password flow plus the
legacy-path guard, while **Google Sign-In moved to a later, unnumbered phase** and is not part of
either. Rows for unbuilt phases (32F–32I) are left as planned rather than renumbered, so this remains a
plan and not a second, competing schedule. The shipped record is
`docs/DEVELOPMENT_ROADMAP.md` **§27H**.

**Reconciled 2026-09-29 (Phase 32N).** The owner has since locked a **different direction** from the
one this table plans: rather than migrating the existing population forward, the legacy password path
is to be **retired** (L-10, L-11) on the fixed premise that all current users are mocked development
data. The resulting sequence is recorded as **N-1…N-10 in §14C.6** and is **not** a renumbering of this
table — the `*(planned)*` rows remain the Phase 32A plan and are neither built nor cancelled by the
record. **Phase 32N (N-1) is documentation only, and no step beyond it is authorised.**

**Reconciled again 2026-09-20 (Phase 32F).** The owner reassigned the number **32F** to the
multi-provider **decision record and documentation close-out** (§14A), which is not the "MongoDB sync"
row this table planned for it. Rather than renumber the unbuilt rows — which would silently restate a
plan as a schedule — the planned rows above are now marked *(planned)* and left in their original
order, and the note is the record of the change. **No phase beyond 32F is authorised**, the planned
rows are not a commitment to build in that order, and the decision record does not authorise any of
them. The shipped record is `docs/DEVELOPMENT_ROADMAP.md` **§27I**.

---

# 22. Definition of Done — Phase 32A

- This design document exists at `docs/superpowers/specs/2026-09-18-firebase-auth-design.md`.
- Option B is recorded as the selected architecture, with A and C documented as rejected and why.
- Every non-negotiable invariant is stated (§4) and every preserved subsystem is named (§10).
- The two unverifiable facts are marked **UNVERIFIED** with a concrete route to settling each (§18).
- The ten open owner decisions are listed without being silently resolved (§14).
- `docs/DEVELOPMENT_ROADMAP.md` references this document (§3 Phase Overview and §27G).
- **No source code, dependency, package manifest, environment variable, database record, Firebase
  project, EAS/Render configuration, commit or push is changed.**
