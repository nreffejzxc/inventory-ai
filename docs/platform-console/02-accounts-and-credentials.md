# Platform accounts, credentials and access — owner/CEO guide

**Assessed:** 2026-11-19 against the current implementation; public production health
reported `f95b5e4`. The last full account snapshot was measured on 2026-11-18 against
`50165538ba7b0bdd949ca65fcfbe5fded0669138` and was **not re-read** on 2026-11-19.
**Start here:** [00 — User guide](00-user-guide.md) for the short operational path.
**Companion to:** [01 — Status and accounts](01-status-and-accounts.md).
That guide covers console status and measured production data; this one is the practical
reference for accounts, credentials, access and recovery.
**Scope:** the internal Platform Operations console and API, the tenant roles that sit
beside it, every credential the implementation creates or requires, and the owner/CEO
security routine.
**No deployment, account creation, credential rotation or production write was made for
this guide.**

> **The short version.** The console has two separate identity realms. Platform roles are
> `READ_ONLY`, `SUPPORT`, `SECURITY` and `SUPERADMIN`; no tenant role can open the console.
> Platform login requires the shared outer access key, a platform password, and a second
> factor (TOTP, a WebAuthn security key, or a one-time recovery code). There is **no PIN,
> no biometric app lock, no SMS OTP, and no tenant MFA**. Platform accounts are created
> only by the operator CLI. Tenant owners are created only by verified registration;
> tenant admins can invite or directly create `ADMIN`, `MANAGER` and `STAFF`, but cannot
> delete them. The **last recorded** production platform account state (2026-11-18) was
> TOTP, **0 WebAuthn keys** and **7 unused recovery codes**; its local recovery-code file
> was stale. That snapshot was not re-read on 2026-11-19. Check the live count in
> **Security & access** and replace any uncertain code set; those are the first owner
> actions in §6.

---

## 1. Roles and console access

### 1.1 Two separate realms

| Realm | Who | Where it works | Can it open `/platform`? |
| --- | --- | --- | --- |
| Platform | Platform administrators | Platform Operations console and `/api/platform` | Yes, according to platform role |
| Tenant | Business `OWNER`, `ADMIN`, `MANAGER`, `STAFF` | Mobile app and tenant `/api/*` routes | **No** |

A tenant `OWNER` is the highest authority inside one business, not a platform operator.
A platform `SUPERADMIN` has no tenant role and does not become a member of a business.
The two token systems, session stores and permission catalogues are separate.

### 1.2 Platform roles

Platform roles are fixed at account creation. There is no HTTP route or console control
to change a role.

| Role | Purpose | Capabilities | Practical meaning |
| --- | --- | --- | --- |
| `READ_ONLY` | Health-only observer | `platform.health.read` | Live status and system checks only; no cross-tenant metrics |
| `SUPPORT` | Service desk and operations | health, metrics, support, deployments | Sees operational aggregates and manages support tickets; no audit or team management |
| `SECURITY` | Security review | health, metrics, audit, deployments | Sees operational aggregates and the audit trail; no support tickets or team management |
| `SUPERADMIN` | Platform owner/lead operator | all capabilities | Everything, including support, audit and administrator lifecycle |

`SUPERADMIN` is the only role that can disable, enable, delete an administrator or remove
a WebAuthn key. It is also the only role that can see the Team management section.

### 1.3 Which platform role can open which console section

**Yes** means the section is available; **No** means the console hides it and the API
refuses the underlying capability. Hiding the navigation is not the security control; the
server enforces the capability on every route.

| Console section | `READ_ONLY` | `SUPPORT` | `SECURITY` | `SUPERADMIN` |
| --- | --- | --- | --- | --- |
| Operations overview | No | Yes | Yes | Yes |
| Live system status | Yes | Yes | Yes | Yes |
| Infrastructure & API | No | Yes | Yes | Yes |
| AI operations | No | Yes | Yes | Yes |
| Database & storage | No | Yes | Yes | Yes |
| Mobile app health | No | Yes | Yes | Yes |
| Background jobs | No | Yes | Yes | Yes |
| Businesses & tenants | No | Yes | Yes | Yes |
| Inventory analytics | No | Yes | Yes | Yes |
| Support center | No | Yes | No | Yes |
| Errors & incidents | No | Yes | Yes | Yes |
| Deployments & releases | No | Yes | Yes | Yes |
| System checks & reports | Yes | Yes | Yes | Yes |
| Security & access (own account) | Yes | Yes | Yes | Yes |
| Audit trail | No | No | Yes | Yes |
| Team management | No | No | No | Yes |

All four roles can open **Security & access** for their own password, recovery codes and
security keys. Only `SUPERADMIN` can use **Team management** against another administrator.

### 1.4 Tenant roles and permissions

Tenant roles are included because the owner must manage both realms, but they are not
console roles. Their permissions apply to the mobile app and tenant API.

| Capability | `OWNER` | `ADMIN` | `MANAGER` | `STAFF` |
| --- | --- | --- | --- | --- |
| Users and invitations | Yes | Yes, except other admins | No | No |
| Locations and categories | Yes | Yes | No | No |
| Products | Manage | Manage | Manage | View |
| Suppliers | Manage | Manage | Manage | View |
| Purchase orders | Manage | Manage | Manage | View and receive |
| Inventory | Manage | Manage | Manage | View; stock in/out; history |
| Dashboard | Yes | Yes | Yes | No |
| AI assistant | Yes | Yes | Yes | Yes |
| AI metrics | Yes | Yes | No | No |
| Audit trail | Yes | Yes | No | No |

**Rules that matter:**

- `OWNER` is created only by verified registration. It cannot be invited, created through
  the users API, or assigned by a role change.
- `OWNER` cannot be modified by the member-management API. There is **no ownership
  transfer endpoint** in this build.
- Only `OWNER` can assign `ADMIN`. An `ADMIN` cannot create, invite, modify or promote
  another `ADMIN`.
- Nobody can change their own role or status. A role change is read by the server on the
  next request; it does not create a new token.
- Disabling a tenant member keeps the row. There is **no admin delete-member route**.

---

## 2. Account management

### 2.1 Create a platform administrator

Platform accounts are created **only** by the operator CLI. There is no HTTP create route
and no “Add administrator” button.

```bash
cd server

PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
PLATFORM_ADMIN_EMAIL='<operator-email>' \
PLATFORM_ADMIN_NAME='<display name>' \
PLATFORM_ADMIN_ROLE=SUPPORT \
PLATFORM_ADMIN_PASSWORD='<16+ character password>' \
npm run platform-admin:create
```

In production, add the second confirmation:

```bash
NODE_ENV=production \
PLATFORM_ADMIN_PROD_CONFIRM=CREATE-PLATFORM-ADMIN \
PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
... \
npm run platform-admin:create
```

**Before running it:** set the command in a private shell, not a shared terminal. The
password is read from the environment and is never printed, written to a file or stored in
the repository. Clear the shell after the command. Use a password manager-generated
password of at least 16 characters; keeping it within 72 bytes avoids bcrypt truncation.

**What creation does and does not do:**

- It writes exactly one `platform.admin.created` audit event with the operator identity,
  source (`cli`), target email, role and optional grant id. The supplied password, hash,
  TOTP secret and recovery codes are never recorded.
- It creates the account with the chosen role. The CLI does not generate a temporary
  password; the operator chooses the password.
- There is no email activation or email-verification step for a platform account. Access
  is controlled by the CLI-created credential and first-login MFA enrollment.
- The new administrator must sign in, enroll TOTP, save the recovery codes and register a
  WebAuthn key. A password alone never opens the console.
- There is no role-change endpoint. To change a role, create a new account with the
  intended role, verify it, then disable or delete the old account. Keep at least one
  active `SUPERADMIN` throughout.

### 2.2 Manage a platform administrator

The Team management section (or the corresponding `/api/platform/admins` routes) supports:

| Action | How | Safety rule |
| --- | --- | --- |
| List administrators | Team page or `GET /api/platform/admins` | `SUPERADMIN` only |
| Disable | `PATCH /api/platform/admins/:id/status` with `DISABLED` | Requires a fresh step-up proof; cannot disable yourself; cannot disable the last active `SUPERADMIN` |
| Enable | Same route with `ACTIVE` | Requires a fresh step-up proof; a disabled account does not become usable until enabled |
| Delete | `DELETE /api/platform/admins/:id` | Requires a fresh step-up proof; cannot delete yourself; cannot delete the last active `SUPERADMIN`; it is permanent |
| Remove a security key | `DELETE /api/platform/admins/:id/webauthn/:credentialId` | Requires a fresh step-up proof; removes one key and revokes that administrator’s sessions |
| Change own password | Security & access | Requires the current password; revokes **all** platform sessions |
| Regenerate recovery codes | Security & access | Requires the current password; invalidates every old code |
| Add a security key | Security & access | Up to 10 keys; user verification is required |

**Step-up proof.** The console asks for the current password and a TOTP code before any
lifecycle change in the table and sends the resulting five-minute proof in
`X-Platform-Step-Up`. Step-up currently accepts the mandatory TOTP factor only; a WebAuthn
or recovery-code step-up is not implemented, so an administrator who has lost TOTP must
restore it (or use another SUPERADMIN) before changing a lifecycle row. If the code just used
to sign in is entered again, the API answers `409 PLATFORM_MFA_CODE_ALREADY_USED` and asks for
the next code; it does not call that valid code invalid and does not count it as a failed
factor. A session without that proof receives
`403 PLATFORM_STEP_UP_REQUIRED`; the API enforces the check, so a hidden or modified console
cannot skip it. The proof is bound to the administrator and session and cannot be used as
an access token. It is stateless, so the same session can replay it within its five-minute
window; losing the session ends its usefulness.

**Disable first, delete later.** Disabling immediately revokes the administrator’s platform
sessions. Deleting removes the administrator row and its sessions. Both actions are audited.
A disabled account keeps its role and factors but cannot authenticate.

**No shared platform accounts.** Each administrator needs their own email address and
their own factors. Sharing a password or a TOTP secret destroys the audit trail and makes
“disable the leaver” impossible without locking everyone out.

### 2.3 Create a tenant account

| Path | Who can use it | What happens | Role |
| --- | --- | --- | --- |
| Verified registration | A new person | Firebase email/password or Google identity; a six-digit email code verifies the address; a new business is created | `OWNER` |
| Invitation | `OWNER` or `ADMIN` | Invite by email; the invitee verifies the address, creates a Firebase identity and accepts | `ADMIN`, `MANAGER` or `STAFF` |
| Direct user creation | `OWNER` or `ADMIN` | `POST /api/users` creates a password account immediately | `ADMIN`, `MANAGER` or `STAFF` |

**Invitations are the safer default.** The invitation is bound to the invited email, lasts
**7 days**, carries a single-use token, and is consumed at acceptance. Re-inviting the same
address replaces the pending link, so the old link stops working. Revoke a pending
invitation with `DELETE /api/invitations/:id`. `OWNER` cannot be invited, and an email that
already belongs to any Inventory AI account cannot be invited into another business.

**Direct creation** is available but sets the initial password on the member’s behalf.
The password must be 8–72 characters. There is no forced first-login password change, so
hand the password over through a secure channel and ask the member to change it. Prefer an
invitation unless the member cannot use email.

### 2.4 Manage, disable and remove a tenant account

| Action | Supported? | Procedure |
| --- | --- | --- |
| Change name | Yes | The member changes their own name; admins cannot edit another member’s name |
| Change role | Yes | `PATCH /api/users/:id`; `OWNER` can assign `ADMIN`/`MANAGER`/`STAFF`; an `ADMIN` can assign `MANAGER`/`STAFF`; `OWNER` cannot be assigned |
| Disable | Yes | `PATCH /api/users/:id` with `status: DISABLED`; the member is refused on the next request. Existing sessions are **not** deleted |
| Re-enable | Yes | Same route with `status: ACTIVE` |
| Delete another member | **No** | There is no admin delete-member route |
| Delete own account | Yes | `DELETE /api/auth/me` with `confirmation: DELETE` and either the current password or a Firebase ID token |
| Transfer ownership | **No** | No ownership-transfer endpoint exists |

**Session caveat:** disabling a tenant account changes its status but does not revoke its
existing session rows. Access is refused at the next request, but if the account is
re-enabled before those sessions expire, an old token can work again. There is no admin
route to revoke a member’s sessions; the member can use “sign out everywhere.” Delete or
password reset when the intent is permanent revocation.

**What self-deletion does:** the account becomes a tombstone, its Firebase identity is
deleted, its sessions and AI conversations are removed, its email is replaced with a
non-routable placeholder, and audit rows are anonymized. Historical inventory, purchase
orders and movements remain because other members may rely on them.

**Owner deletion is special:**

- If the caller is the only active member and is the `OWNER`, the whole business is closed
  and its tenant data is removed.
- If other active members remain and there is no other active `OWNER`, deletion is refused
  with `409 LAST_OWNER_TRANSFER_REQUIRED`.
- Since there is no ownership-transfer endpoint, this build cannot complete an owner
  handover through the app. Plan that gap before an owner leaves; do not promise a
  transfer that the software does not implement.

### 2.5 Account-management rules

1. One person, one account. Never share a platform or tenant login.
2. Least privilege: use `READ_ONLY`, `SUPPORT` or `SECURITY` for day-to-day work; reserve
   `SUPERADMIN` for the few people who must manage administrators.
3. Disable before deleting. Disabling is reversible and blocks the next request; deletion
   is permanent. Disabling alone does not remove existing tenant sessions.
4. Keep at least two active `SUPERADMIN` accounts if continuity matters. The server
   prevents disabling or deleting the last one, but a single administrator has no
   in-app recovery partner.
5. Remove a leaver’s platform account, WebAuthn keys and tenant membership on the same
   day. Platform disable revokes platform sessions; for tenant accounts, have the member
   sign out everywhere or reset the password, because disable does not revoke sessions.
6. Review the platform administrator list and each tenant’s `OWNER`/`ADMIN` list at least
   monthly.

---

## 3. Generated codes, keys and credentials

### 3.1 How to read the tables

- **Shown once** means the plaintext is displayed only at creation. The server keeps a
  hash or ciphertext, not a recoverable copy.
- **Server-side only** means the value belongs in the hosting secret store
  (Render Environment/Secret), never in the repository, a mobile build, a support ticket,
  chat or an email.
- **Revoke** means make the credential unusable; **rotate** means replace it with a new
  value and retire the old one.

### 3.2 Platform account credentials

| Credential | What it is for | Created and shown | Store it securely | Regenerate / revoke |
| --- | --- | --- | --- | --- |
| Platform password | First factor for the platform login | Chosen at CLI creation; never shown by the app | Password manager; never reused for a tenant or personal account | Change in Security & access (current password required). All platform sessions are revoked. Forgotten password requires break-glass; there is no self-service reset |
| TOTP secret / QR | Six-digit time-based second factor | Generated at first login or enrollment; QR/secret shown once | Authenticator app on a device separate from the main workstation; server keeps it encrypted | No rotation UI. A lost/replaced authenticator is cleared by break-glass, then re-enrolled |
| Recovery codes | One-time fallback when TOTP or a security key is unavailable | 10 codes, generated after re-entering the current password; shown once | Offline, in two separate secure locations; not in the repository, chat or ordinary cloud notes | Regenerate in Security & access. A new set invalidates every old code; each code works once |
| WebAuthn security key | Phishing-resistant second factor | Registered from an authenticated session; the private key stays on the authenticator | Primary and backup hardware keys, stored separately; the server stores the public key, credential ID and counter encrypted | Add a replacement before removing a lost key. Up to 10 keys. Removing a key revokes that administrator’s sessions |
| Platform session cookie + access token | Keeps a signed-in browser session | Issued after all factors succeed; not shown as a copyable code | HttpOnly `platform_session` cookie; never copy it or place it in local storage | 15-minute access token; 8-hour absolute session; 15-minute idle timeout. Logout, password change, disable, delete, key removal or break-glass revokes it |
| CSRF token | Proves a state-changing request came from the console | Issued with the session; readable by the console | Browser cookie `platform_csrf`; sent as `X-Platform-CSRF`; not a standalone login credential | Reissued with the session; cleared on logout |
| MFA challenge token | Short-lived proof that the password step succeeded | Issued after the password; not a session | Browser memory only; never share or save | 5 minutes for login, 10 minutes for enrollment; purpose-bound; expires |
| WebAuthn challenge | One-time challenge for key registration or assertion | Created by the server during the ceremony | Browser/authenticator handles it; server stores only a hash | 5 minutes; single-use; no manual revoke |
| Shared outer access key | Gate in front of `/platform` and `/api/platform` | Generated by the operator, not by the app; at least 32 characters | Render secret store and the owner’s password manager; only operators who need the console | No automatic expiry. Change the Render value and restart; every operator then needs the new key |

### 3.3 Tenant account and verification credentials

| Credential | What it is for | Created and shown | Store it securely | Regenerate / revoke |
| --- | --- | --- | --- | --- |
| Tenant password | First factor for a local or Firebase email/password account | Chosen by the member, or set by an admin for a direct account; never shown by the app | Member’s password manager; admins must not retain it | Member changes it (all sessions revoked) or uses the email reset code. Reset codes are not a platform credential |
| Firebase identity / Google Sign-In | Tenant identity provider | Created or linked by the member through Firebase | Protected by the member’s Google/Firebase account and its MFA | Managed at Firebase/Google, not in the Inventory AI console |
| Email verification code | Proves the member controls the invited/registered address | 6 digits, emailed; valid 10 minutes; 5 attempts; 60-second resend cooldown | The member’s email inbox; never forward or paste into chat | Expires; request a new code. A new code supersedes the old one |
| Invitation token | Lets the invited address join the correct business and role | 64-character token in the emailed link; valid 7 days; stored only as a hash | The invitation email; do not forward it | Accept once, revoke it, or re-invite. Re-inviting replaces the token and invalidates the old link |
| Password reset code | Proves control of the account email before a password reset | 6 digits, emailed; valid 10 minutes; 5 attempts; 60-second resend cooldown | The member’s email inbox; never share | Expires; request a new code. A new code supersedes any outstanding reset authorization |
| Reset authorization token | One-time authorization for the new-password step | Returned only after the reset code is verified; valid 15 minutes | Kept in the app’s memory for that screen; never saved or shared | Single-use; expires; a new reset code supersedes it. A completed reset revokes all tenant sessions |
| Tenant session JWT | Bearer token for the mobile app | Issued after Firebase/local authentication; not shown to the member | Expo SecureStore on the device (Android Keystore/iOS Keychain); never in logs or chat | 1-hour access token, 14-day absolute session, maximum 20 sessions; logout, revoke, password change/reset ends it |
| Session record (`jti`) | Server-side record that makes the JWT revocable | Created with the session; never returned to the client | MongoDB session collection; scoped to the user and business | Revoked by logout, “sign out everywhere”, one-session revocation, password change/reset, account delete or teardown. Tenant disable blocks at the next request but leaves rows in place |
| Firebase ID token | Proves a Firebase identity to the server | Issued by Firebase after sign-in; short-lived | Native Firebase SDK/memory; never used as an Inventory AI API bearer token | Exchange for an Inventory AI session; obtain a fresh token for re-authentication. There is no Inventory AI copy to rotate |
| Tenant deletion confirmation | Prevents an accidental account deletion | The fixed word `DELETE` | Not a secret; entered by the member | Not rotatable; changes only with a code change |

### 3.4 Server and operator secrets

These are not account credentials, but losing them can expose every account or break
login. They belong in the Render secret store; keep an offline record of who can read them.

| Secret | What it protects | Store it securely | Rotate / revoke and effect |
| --- | --- | --- | --- |
| `PLATFORM_ACCESS_KEY` | Shared outer gate before platform login | Render + owner password manager | Change Render value and restart. All operators need the new key. The old key stops working immediately after restart |
| `PLATFORM_ADMIN_JWT_SECRET` | Signs platform access and MFA challenge tokens | Render; separate from every tenant secret | Rotate on suspected signing-key exposure. All platform sessions and challenges become invalid; administrators sign in again |
| `PLATFORM_MFA_ENCRYPTION_KEY` | Encrypts TOTP secrets and WebAuthn public keys at rest | Render; restricted to the owner/operator | **Do not rotate casually.** The current build has no versioned key ring; replacing it makes existing TOTP secrets unreadable. Break-glass and re-enrollment are required. Plan this with NS-03 before rotating |
| `JWT_SECRET` | Signs tenant access tokens | Render; never equal to a platform secret | Rotate on suspected exposure. All tenant sessions become invalid; members sign in again. There is no staged rotation |
| `EMAIL_VERIFICATION_CODE_PEPPER` | Keys the HMAC for email-verification codes and password-reset codes and authorizations | Render; at least 32 characters | Rotate on suspected exposure. Outstanding verification/reset codes and reset authorizations stop working; users request new ones. Existing passwords and sessions are not changed |
| `MONGODB_URI` | Database connection, including the database user’s password | Render; never in a client or the repository | Rotate the database user in Atlas, update Render, restart, verify health. Treat the old URI as compromised until removed |
| Firebase service-account private key | Server-side Firebase Admin access | Render; never in the mobile app or repository | Create a new key in Firebase, update Render, restart, verify, then delete the old key. A leaked key can mint Firebase identities |
| Brevo API key | Sends verification, reset and invitation email | Render | Rotate in Brevo, update Render, restart, send a test. A leaked key can send mail as Inventory AI |
| OpenRouter API key | Pays for AI model calls | Render | Rotate in OpenRouter, update Render, restart, verify. A leaked key can spend the owner’s credits |
| `PLATFORM_ADMIN_PASSWORD` / `PLATFORM_BREAK_GLASS_PASSWORD` | Transient password input for the CLI | Shell environment only; never a file or shell history | Clear after use. Choose 16+ characters. These are inputs, not stored application secrets |
| Confirmation phrases | Prevent accidental CLI actions | Internal runbook; not secret | Fixed in code: `create-platform-admin`, `CREATE-PLATFORM-ADMIN`, `reset-platform-admin`, `BREAK-GLASS-PLATFORM-ADMIN`. They are not authentication and do not replace MFA |
| `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_WEBAUTHN_ORIGIN`, `PLATFORM_WEBAUTHN_RP_ID` | Browser origin and WebAuthn relying-party identity | Render configuration | Not secrets, but part of the trust boundary. Changing them can invalidate cookies and make existing security keys unusable; re-register keys after a planned change |

**NS-05 gate budget.** `PLATFORM_ACCESS_GATE_WINDOW_MS` (default 15 minutes),
`PLATFORM_ACCESS_GATE_MAX_FAILURES` (default 20 per address) and
`PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES` (default 200 per process) bound repeated
wrong outer keys. These are configuration, not credentials. A valid key is checked before
the budget and still works after a burst; the first failure per address in a window writes
one sampled audit event without the key. Once the global cap is reached, the gate returns
429 without creating another per-address bucket or audit row; the shared window and its
state are cleared when the window resets. The limiter is process-local.
| Firebase web configuration | Public Firebase project identifiers | Mobile build/config | Public identifiers, not an Admin credential. They grant no server privileges; do not confuse them with the service-account private key |

### 3.5 What does not exist

Do not create, promise or document these as features:

- No PIN and no biometric app lock. The mobile app stores its JWT in SecureStore; it does
  not ask for a PIN, fingerprint or face unlock.
- No SMS OTP and no push OTP.
- No tenant TOTP, tenant WebAuthn, tenant recovery codes or tenant MFA.
- No platform self-service password reset. Break-glass is the only reset.
- No platform account creation UI and no platform role-change route.
- No per-tenant API keys.
- No IP allowlist or network isolation on the current Render free plan. The shared access
  key is the only outer gate.
- No immutable external audit sink and no platform pager.
- No tenant ownership-transfer endpoint and no admin delete-member endpoint.
- No TOTP rotation UI and no platform session list with one-device revocation.
- No dual control on platform disable/delete/key removal. A fresh password + TOTP
  step-up proof is required, but one administrator still makes the decision.

A hardware security key can have its own device PIN or biometric check. That is managed by
the authenticator or operating system, not by Inventory AI. The application itself does not
store or verify a PIN.

---

## 4. Authentication and verification

### 4.1 Method matrix

| Method | Platform console | Tenant app | Notes |
| --- | --- | --- | --- |
| Password | Yes, local bcrypt credential, 16+ characters | Yes, Firebase email/password; legacy local password still exists | Platform password alone never creates a session |
| Google Sign-In | No | Yes | Firebase identity; no platform Google login |
| TOTP (authenticator app) | Yes, mandatory | No | 6 digits, 30-second step, ±1 step, replay-protected |
| WebAuthn security key | Yes, optional after TOTP is enrolled; up to 10 | No | User verification required; private key stays on the authenticator |
| Recovery codes | Yes, 10 single-use codes | No | A second-factor fallback, not a password reset |
| Email verification code | No | Yes, at registration/invitation | 6 digits, 10 minutes, 5 attempts |
| Password reset code | No; platform uses break-glass | Yes | 6 digits, 10 minutes, 5 attempts; then a 15-minute reset authorization |
| Invitation link | No | Yes, for `ADMIN`/`MANAGER`/`STAFF` | 7-day, email-bound, single-use token |
| SMS OTP | No | No | Not implemented |
| PIN | No | No | Not implemented |
| Biometric app lock | No | No | Not implemented |
| SSO / SAML | No | No | Not implemented |
| Security questions | No | No | Not implemented |

### 4.2 Platform login, step by step

1. Open `https://ai-inventory-l1mi.onrender.com/platform` over HTTPS.
2. The browser shows an HTTP Basic prompt. Enter the shared access username (default
   `platform`, unless `PLATFORM_ACCESS_USER` was changed) and the
   `PLATFORM_ACCESS_KEY`.
3. Enter the platform administrator email and password. A correct password returns an MFA
   challenge, **not** a dashboard.
4. On the first login, or if TOTP is not enrolled, scan the TOTP secret and confirm a
   six-digit code. Enrollment is mandatory.
5. If no unused recovery codes exist, the server restricts the account until a new set is
   generated. Save the ten codes offline before continuing.
6. On later logins, complete the challenge with TOTP, a registered WebAuthn security key,
   or one recovery code.
7. The console receives an HttpOnly `platform_session` cookie scoped to `/api/platform`,
   plus the readable `platform_csrf` cookie. State-changing requests must send the exact
   console origin and `X-Platform-CSRF`.
8. The access token is 15 minutes; the session has an 8-hour absolute cap and a 15-minute
   idle timeout. A renewal keeps the same session and cannot extend the 8-hour cap.

**Why the outer gate is not enough:** the access key is shared by operators and is not a
person. Password + MFA still decide who the administrator is. Never treat the Basic prompt
as the login.

### 4.3 Platform MFA details

- **TOTP:** 6 digits, 30-second step, SHA-1, one step of clock tolerance in either
  direction. A successfully used counter cannot be replayed.
- **Recovery codes:** 10 codes per set, 12 characters from an unambiguous alphabet,
  displayed as `XXXX-XXXX-XXXX`. The server stores SHA-256 digests, not the codes. Each code
  is single-use. Generating a new set invalidates every old code.
- **WebAuthn:** up to 10 keys. Registration requires an authenticated session. Login
  requires user verification, checks the stored signature counter and consumes the
  challenge once. The private key never leaves the authenticator. Removing a key revokes
  that administrator’s sessions.
- **Lockout:** five failed MFA/recovery/WebAuthn factors in 15 minutes lock MFA for 15
  minutes. The lock is account-scoped and durable, not per-IP. A successful factor clears
  it.
- **Challenge lifetimes:** 5 minutes for login, 10 minutes for enrollment, 5 minutes for a
  WebAuthn ceremony. These are not sessions.

### 4.4 Tenant login and verification

- A new person signs in with Firebase email/password or Google. A Firebase identity that
  has no Inventory AI account is routed to registration.
- Registration requires a six-digit email verification code: 10 minutes, five attempts,
  60-second resend cooldown. The verified address becomes the business `OWNER`.
- An invited person verifies the invited address, creates a Firebase identity and accepts
  the invitation. The invitation supplies the business and role; the request cannot choose
  them.
- A password reset uses a six-digit emailed code, then a 15-minute one-time authorization
  to set the new password. Every tenant session is revoked after the change.
- Tenant sessions are 1-hour JWTs inside a 14-day absolute session, with at most 20 active
  sessions. The oldest sessions are revoked beyond that cap.
- There is no tenant second factor beyond the password/Google account. The owner cannot
  enable TOTP, WebAuthn or recovery codes for a tenant member.

---

## 5. Platform access and recovery

### 5.1 Normal access

**Prerequisites:**

- The console URL and the shared access key.
- A platform administrator email and password.
- TOTP on an authenticator, a registered WebAuthn security key, or an unused recovery
  code.
- The ten recovery codes, stored offline.

**API access:** API clients send the shared key in `X-Platform-Access-Key` and the platform
access token as a Bearer token. Browser console requests use the cookies and CSRF header.
There is no separate platform API key per administrator.

### 5.2 If access fails

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Basic prompt repeats or `401 PLATFORM_ACCESS_REQUIRED` | Wrong/missing outer key, or wrong access username | Retrieve the key from Render; confirm `PLATFORM_ACCESS_USER`; use the exact key. Do not guess repeatedly |
| “Invalid email or password” | Wrong password, wrong email, or disabled account | Confirm the account is `ACTIVE` in Team management. If the password is lost, use break-glass; there is no self-service reset |
| Password accepted but no MFA methods | TOTP not enrolled, or factor state is incomplete | Complete TOTP enrollment. If the state is broken, break-glass and re-enroll |
| TOTP rejected | Clock drift, wrong account, or replayed code | Check the device clock; wait for the next code; do not reuse an old code |
| Security key rejected | Wrong key, cancelled user verification, origin mismatch, or key removed | Try TOTP or a recovery code; use the key registered for this exact console origin |
| “Too many verification attempts” | Five MFA failures in 15 minutes | Wait 15 minutes. Do not keep trying; the lock is deliberate |
| Session expired or revoked | 15-minute idle, 8-hour cap, password change, disable/delete, or key removal | Sign in again. If it was revoked by an administrator, ask why before re-entering |
| `403` on a section | The role lacks that capability | Use the role matrix in §1.3; do not ask for a higher role unless the job requires it |
| Disabled account | An administrator disabled it | A `SUPERADMIN` must enable it. Break-glass does **not** re-enable a disabled account |
| Lost all factors and the password | No usable TOTP, key or recovery code | Use break-glass, if you have server/database access |

### 5.3 Break-glass: the last resort

Break-glass is an operator script, not an HTTP route. It requires database access, the
resolved database name, the target email and a new password. It clears the password
factors, TOTP, WebAuthn keys, recovery codes, MFA lock and every platform session. It
leaves the role and status unchanged.

From `server`, set the guarded inputs in a private shell:

```bash
PLATFORM_BREAK_GLASS_CONFIRM=reset-platform-admin \
PLATFORM_BREAK_GLASS_DB='<resolved database name>' \
PLATFORM_BREAK_GLASS_EMAIL='<administrator email>' \
PLATFORM_BREAK_GLASS_PASSWORD='<new 16+ character password>' \
PLATFORM_BREAK_GLASS_OPERATOR='<operator label>' \
npm run platform-admin:break-glass
```

Production additionally requires:

```bash
PLATFORM_BREAK_GLASS_PROD_CONFIRM=BREAK-GLASS-PLATFORM-ADMIN
```

The script refuses if the confirmation phrase is missing, the named database does not
match the resolved database, the email is missing, or the new password is missing. It
prints the target id, email, role and status, and the number of sessions revoked — never a
password or hash.

**After break-glass:**

1. Sign in with the new password. The account has no TOTP, keys or recovery codes.
2. Enroll TOTP and confirm a code.
3. Save the new ten recovery codes offline.
4. Register the primary WebAuthn key, then the backup key.
5. Check the audit trail for the reset and any preceding failures.

**Do not use break-glass as a routine password reset.** It removes every factor, so it is
also a security event. A disabled administrator stays disabled; another active
`SUPERADMIN` must enable the account first.

### 5.4 Recovery limits

- **No self-service platform password reset.** A forgotten password with working factors
  still requires break-glass.
- **No TOTP rotation UI.** Replacing a lost authenticator requires break-glass and
  re-enrollment.
- **No ownership transfer for tenant businesses.** An `OWNER` who must leave cannot hand
  the business to another member through the current API.
- **No admin delete-member route.** Disable the member; only the member can self-delete.
- **No platform session list.** Sessions can be revoked only by logout, password change,
  disable/delete, key removal or break-glass.
- **No provider recovery from inside Inventory AI.** If the Render, Atlas, Firebase, Brevo
  or OpenRouter owner account is lost, recover it with that provider. Inventory AI cannot
  reset provider access.

---

## 6. Owner/CEO security guide

### 6.1 Do these first

The **last recorded** production state (2026-11-18) had one platform `SUPERADMIN` with TOTP,
**0 WebAuthn keys** and **7 unused recovery codes**; the local recovery-code file was
stale. Check the live count in **Security & access** before relying on those values. In
this order:

1. **Register two WebAuthn security keys.** Use a primary and a backup, stored separately.
   A hardware key makes phishing much harder than TOTP alone.
2. **Regenerate the recovery codes.** Use the current password in Security & access. Save
   the new ten codes offline, confirm the old file is destroyed, and record the date.
3. **Confirm the outer access key.** It must be at least 32 characters, stored in Render
   and in your password manager. If anyone who knew it has left, rotate it and restart.
4. **Add a second trusted `SUPERADMIN` or document a tested break-glass path.** One
   administrator is a continuity risk. The server protects the last one, but it cannot give
   you a second person.
5. **Protect the provider accounts.** Render, MongoDB Atlas, Firebase, Brevo, OpenRouter and
   the source repository should each have MFA, a owner-controlled recovery address and no
   shared logins.
6. **Review tenant `OWNER` and `ADMIN` accounts.** Tenant MFA does not exist, so a tenant
   owner password is the tenant’s main protection.

### 6.2 Critical responsibilities

| Responsibility | What good looks like | Cadence |
| --- | --- | --- |
| Platform identity ownership | Named administrators, no shared accounts, one backup `SUPERADMIN` | On every join/leave; review monthly |
| Outer-gate control | Key only in Render and the owner password manager; rotate on exposure or operator change | Quarterly and on change |
| Strong platform MFA | TOTP plus two hardware keys; recovery codes offline | Keys on setup; codes quarterly |
| Recovery readiness | Codes stored in two places; break-glass procedure known and access to Render/Atlas confirmed | Test the procedure quarterly; do not consume the only code |
| Server-secret custody | Secrets only in Render; no repository, chat, ticket or email copies | Review access quarterly |
| Least privilege | `SUPERADMIN` only for administrator management; `SUPPORT`/`SECURITY`/`READ_ONLY` for daily work | Review monthly |
| Tenant access review | Every business has a known `OWNER`; `ADMIN` list is current; leavers disabled | Monthly |
| Monitoring and audit | Review sign-ins, MFA failures, denials, admin changes, key/recovery changes and password changes | Weekly; deep review monthly |
| Incident readiness | Contacts, provider access, backup/restore and a written first hour | Quarterly drill |
| Vendor continuity | Provider owner accounts and payment methods are current | Quarterly |

### 6.3 Account protection rules

- Use a unique platform password of at least 16 characters. Never reuse a tenant password,
  email password or personal password.
- Put the platform password in a reputable password manager. Do not rely on browser-saved
  passwords on a shared device.
- Keep TOTP on a device separate from the laptop used for the console. Do not store the
  TOTP secret in a screenshot, email or chat.
- Register two hardware keys. Keep the backup key in a different physical location from the
  primary key.
- Treat recovery codes as spare keys: offline, two copies, never in the repository or a
  ticket. Each code works once; regenerate the set when the count is low or the file is
  stale.
- Never share your password, a TOTP code, a recovery code, a session cookie or a CSRF
  token. Each support operator needs **their own account** and the shared outer access key;
  never share an individual's credentials or factors.
- Separate your platform identity from your tenant `OWNER` identity. Use a different email
  and password where practical; a tenant compromise must not become a platform compromise.
- Keep the operating system, browser, password manager and authenticator updated. Use
  full-disk encryption and a screen lock.
- Verify the URL before typing the access key. The Basic prompt is a phishing target; a
  lookalike origin can collect the shared key and password.
- Do not use the console on a public or shared computer. If you must, use a private window,
  sign out, and never save the Basic credentials.

### 6.4 Recovery readiness

| Situation | Correct recovery |
| --- | --- |
| Lost TOTP device, recovery codes available | Sign in with a recovery code, then regenerate recovery codes and add/repair keys. Replacing TOTP itself requires break-glass |
| Lost security key, TOTP available | Sign in with TOTP; a `SUPERADMIN` removes the lost key in Team management. Add the replacement first |
| Lost recovery codes, TOTP/key available | Sign in normally; regenerate the ten codes with the current password and store them offline |
| Forgotten password, factors available | Break-glass. Factors do not substitute for the first factor |
| No factors and no password | Break-glass, with server/database access |
| Outer access key lost | Retrieve it from Render. If it may have leaked, rotate it in Render and restart |
| MFA locked for 15 minutes | Wait. Repeated attempts extend the bad experience, not the lock |
| Disabled platform account | Another active `SUPERADMIN` enables it; break-glass does not |
| Render/Atlas/Firebase/Brevo/OpenRouter access lost | Use that provider’s owner recovery. Inventory AI has no provider-reset path |
| Tenant member forgot password | Send the six-digit reset code from the app; no admin can read the password |
| Tenant member left | Disable the account. There is no admin delete; the member self-deletes if required |
| Tenant owner left | No transfer endpoint exists. Resolve the gap before it happens; do not attempt an unsupported database edit |

### 6.5 Incident response

**Suspected platform compromise:**

1. If the account is not yours, a `SUPERADMIN` disables it. That revokes its sessions.
2. Change the password and regenerate recovery codes. Remove unknown WebAuthn keys.
3. If the outer key may be exposed, rotate `PLATFORM_ACCESS_KEY` and restart.
4. If signing or MFA-encryption keys may be exposed, follow the rotation warnings in §3.4.
   Do not rotate the MFA-encryption key without a re-enrollment plan.
5. Review platform audit events for sign-ins, failed MFA, denials, admin changes, key
   changes and password changes. Preserve the evidence before cleanup.
6. Notify the named security contact and record what happened, when, and what was rotated.

**Suspected tenant compromise:**

1. Disable the member immediately; the next request is refused, but existing sessions are
   not deleted.
2. Have the member reset the password; all tenant sessions are revoked. If the account
   must be re-enabled, reset first: an unexpired session can work again after re-enable.
3. Review tenant audit and inventory activity for unauthorized changes.
4. If the tenant `OWNER` is compromised, treat the whole business as exposed; there is no
   tenant MFA to contain it.
5. Notify the business owner through a verified channel, not through the compromised
   account.

**Lost device:**

- Platform phone with TOTP: use a recovery code or security key; regenerate codes; plan a
  break-glass re-enrollment if TOTP must move.
- Platform hardware key: remove it; add the backup key; keep TOTP as the fallback.
- Laptop with an active session: change the password and revoke sessions; do not wait for
  the 8-hour cap.

### 6.6 Tenant security responsibilities

- Tenant `OWNER` and `ADMIN` accounts are high-value because the platform console cannot
  protect a tenant’s own login. There is no tenant MFA; use strong unique passwords and
  Google account protection.
- Prefer invitations over admin-set passwords. The member chooses their own password and
  the invitation is bound to their email.
- Disable leavers the same day. The account status is checked on every request, but
  disable does not delete sessions; have the member sign out everywhere or reset the
  password so an old token cannot work after re-enable.
- Do not send tenant names, emails, product rows or support details into the platform
  console. The console is intentionally aggregate-only.
- Do not ask a tenant member for their password, Firebase token or recovery code. None of
  those are support credentials.
- Remember that a tenant `OWNER` cannot be removed or transferred by an admin. The current
  build has no ownership-transfer path; plan succession before it is urgent.

### 6.7 Important precautions

- The Basic access key is a shared door, not a person and not MFA. It does not replace
  password + second factor.
- The console URL is internet-reachable. Render Free cannot attach an inbound IP allowlist.
  Do not describe it as network-isolated.
- The platform audit trail is append-only in the application model, but it has no external
  immutable sink. Preserve exports and restrict raw database access.
- Platform notifications are pull-only. A failed login or MFA burst is recorded but does
  not page anyone.
- The platform password has no self-service reset. Break-glass is powerful and should be
  logged, authorized and followed by full re-enrollment.
- `PLATFORM_MFA_ENCRYPTION_KEY` rotation is destructive in the current build. Do not rotate
  it as a routine hygiene step.
- Do not create a PIN, SMS OTP, tenant MFA or per-tenant API key because a guide or a
  ticket says one exists. It does not.
- Do not put secrets in chat, email, tickets, screenshots or source control. If a secret
  may have been exposed, rotate it; deleting the message is not enough.

### 6.8 Owner checklist

- [ ] Platform URL and outer access key are in the password manager.
- [ ] Two WebAuthn keys are registered and stored separately.
- [ ] TOTP is on a device separate from the main workstation.
- [ ] Ten recovery codes are offline in two locations; the stale file is destroyed.
- [ ] A second trusted `SUPERADMIN` exists, or break-glass access is tested and documented.
- [ ] Render, Atlas, Firebase, Brevo, OpenRouter and repository accounts have MFA.
- [ ] No platform or tenant account is shared.
- [ ] Platform administrators are reviewed monthly; tenant owners/admins monthly.
- [ ] Leavers are disabled; platform sessions are revoked and tenant sessions are ended
      by sign-out-everywhere or password reset the same day.
- [ ] Audit review is weekly; a deeper review is monthly.
- [ ] Break-glass and database restore have a written, tested procedure.
- [ ] The team knows that there is no PIN, SMS OTP or tenant MFA.

---

## 7. Evidence and limits

**Verified from the implementation:** platform roles and capabilities; the console
section-to-capability mapping; CLI-only platform creation; disable/enable/delete and
WebAuthn-key removal with self and last-`SUPERADMIN` guards; session revocation; TOTP,
recovery-code, WebAuthn and MFA-lock behavior; break-glass; tenant role rules; tenant
invitation, verification, reset and self-deletion behavior; server-secret names and
purposes.

**Not verified in this pass:** an authenticated production browser session, live
administrator/key/recovery-code counts, a break-glass run, a production recovery-code
rotation, a WebAuthn registration, or a tenant account creation. The last recorded
production account had no WebAuthn key and a stale local recovery file; do not treat that
as current. No credential, secret or recovery code is recorded in this guide.

**Current implementation limits:** no PIN/biometric app lock, no SMS OTP, no tenant MFA,
no self-service platform password reset, no platform role-change route, no platform
session inventory, no dual control, no tenant ownership transfer, no admin delete-member
route, no immutable audit sink, no platform pager and no network allowlist. Step-up proof
for destructive lifecycle actions is implemented; WebAuthn/recovery-code step-up is not.
