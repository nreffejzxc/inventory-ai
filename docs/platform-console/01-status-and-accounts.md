# Platform Operations console — current status and account guide

**Assessed:** 2026-11-18, against production commit `74e4b87` and the console-delivery
commit `282c8d6`; PR #336 is merged and dependency PR #318 is deployed.
**Production:** `https://ai-inventory-l1mi.onrender.com/platform`
**Scope:** the INTERNAL Platform Operations console and API, platform-administrator
authentication, current production data, AI monitoring, and account creation for every
supported platform and tenant role.
**Companion:** for the full account lifecycle, credential inventory, storage and rotation
rules, access/recovery runbook and owner/CEO security checklist, see
[02 — Accounts and credentials](02-accounts-and-credentials.md).
**No deployment or write was made for this assessment.** Production data was read with
index creation disabled; no tenant, platform or audit row was changed. The console
delivery was merged and deployed as `e7ce455`, then the dependency bump deployed as
`74e4b87`; the data below was not re-read after either deploy.

## 1. Bottom line

- The console is **live and access-gated**. `/platform` and `/api/platform/*` return
  `401 PLATFORM_ACCESS_REQUIRED` with a Basic challenge until the shared outer access
  key is supplied. A tenant login cannot open it.
- The console is **read-only**. It has no tenant write, no tenant selector and no
  member-identifying detail. Support tickets are platform-only records.
- The core read paths are implemented and covered by the platform tests. The production
  aggregates are **internally consistent** (the AI totals, movement totals, feedback
  reasons and audit-action totals reconcile; see §3).
- **One counter-scope difference needs explaining.** At assessment, `/api/health`
  reported **58 process-lifetime 5xx responses** (`serverErrors`), while the console's durable
  `ops_error_events` store reported **0 events** in the 7-day window. The 58 were not 58
  missing incidents: the old process counter included intentional
  `/api/health/integrity` 503s while the laptop heartbeat was stale, and that health route
  returns directly rather than through the error handler that writes durable rows. The
  deployed `74e4b87` restarts the process and reports **0 `serverErrors`**; the durable
  store remains the record for application errors.
- Platform authentication is implemented and tested: password → mandatory TOTP
  enrollment; later logins use TOTP, an enrolled WebAuthn key or a recovery code →
  HttpOnly session cookie + CSRF. The sole production SUPERADMIN currently has TOTP,
  **0 registered WebAuthn keys**, and **7 unused recovery codes**.
- Platform accounts are created **only by the operator CLI**, never over HTTP. Tenant
  `OWNER` accounts are created only by verified registration; `ADMIN`, `MANAGER` and
  `STAFF` are created by the OWNER/ADMIN through user management or an invitation.
- **Not re-observed in this pass:** an authenticated browser session and its rendered
  dashboard. That needs the platform password plus TOTP/recovery code or WebAuthn, which
  were not used here. The last recorded production browser proof was at `e218bb0`
  (PLAT-7); the current build is `74e4b87`. This is a verification limitation, not a
  known console defect.

## 2. Feature status

Legend: **Working** = implemented and covered by the current tests; **Working, limited** =
the honest subset is implemented and the missing sources are stated in the console;
**Not available** = deliberately absent; **Not re-observed** = not exercised in this pass.

| Console area | Status | What it actually shows | Limitation |
| --- | --- | --- | --- |
| Outer access gate | **Working** | Basic gate before the console/API; anonymous requests get `401 PLATFORM_ACCESS_REQUIRED`; repeated failures are bounded with `429` and one sampled audit event | One shared key, not a per-person identity or network allowlist |
| Platform sign-in and MFA | **Working, limited** | Password challenge, mandatory TOTP enrollment, optional WebAuthn, recovery codes, HttpOnly cookie, CSRF, origin checks | Current admin has no WebAuthn key; authenticated UI not re-observed in this pass |
| Overview | **Working** | Business/account counts, AI turns and rates, tickets, durable 5xx, provider-reported AI cost | Its “5xx since boot” comes from the process counter and can differ from the durable 5xx card; see §3 |
| Live system status | **Working** | API process, MongoDB connection, uptime, commit, process counters, configuration checks | Process CPU is an average since boot, not host utilisation |
| Infrastructure & API | **Working, limited** | Node memory/RSS, process CPU, `dbStats`, configured integrations | No host CPU/memory pressure, Atlas cluster metrics or live provider probes |
| AI operations | **Working, limited** | Turns, free/paid mix, failovers, retries, empty responses, latency, tokens, provider cost, per-model and outcome tables, daily rows, feedback | No live model health, no current configured-model display, no spend alert/kill switch; cost is provider-reported only |
| Database & storage | **Working, limited** | Connection state, `dbStats`, data/storage/index sizes, 30 s cached latency | No backup status, restore proof, slow-query profiling or connection-pool saturation |
| Mobile app health | **Not available** | An explicit panel saying the Android app reports no crash/install/startup telemetry | No mobile telemetry exists |
| Background jobs | **Not available** | An explicit panel saying there is no durable job/queue store | No job history or queue depth |
| Businesses & inventory | **Working** | Aggregate businesses, accounts, members, products, locations, suppliers, open POs, stock movements, inventory quantity | No tenant name, email, product row, SKU or location; tenant detail is intentionally absent |
| Support center | **Working** | Internal tickets, status workflow, assignment, notes | Tickets carry no tenant/member data; no SLA/on-call automation |
| Errors & incidents | **Working, with current caveat** | Durable `ops_error_events` totals, status/code/route groups, recent events, platform denial/MFA/login counts | The 0 durable events vs 58 process responses is a counter-scope difference; #336 excludes monitoring-only integrity 503s |
| Team management | **Working, limited** | SUPERADMIN list, status, MFA, key count, recovery-code count, disable/enable/delete/remove key; the console prompts for password + TOTP before each lifecycle change | Creating an administrator is CLI-only but writes one `platform.admin.created` audit event; no role-change UI or dual control |
| Deployments & releases | **Working, limited** | Current commit, environment, Node, uptime, boot-observed history | A failed build that never booted is invisible; history starts when this feature was enabled |
| System checks | **Working, limited** | Real configuration predicates: DB, platform auth/MFA, AI, mail, Firebase | Configuration only, not live delivery or provider availability |
| Audit trail | **Working, limited** | Append-only platform sign-ins, MFA, refusals, report reads, lifecycle events | Model append-only, but no immutable external sink, retention decision or raw-DB least-privilege proof |
| Security & access | **Working, limited** | Role, capabilities, MFA state, key count, recovery codes, password change, key registration, five-minute step-up proof for lifecycle changes | Step-up is a fresh session-bound TOTP proof; no second-approver/dual control |
| Deployment boundary | **Partial** | HTTPS/Render edge and the application Basic gate | The URL remains internet-reachable; Render Free cannot attach an inbound IP allowlist |

## 3. Production data accuracy

**Measurement.** On 2026-11-18 at **06:37:22 UTC**, the exact service functions behind
`GET /api/platform/operations` and the monitoring extras were run read-only against
`inventoryai_prod_db`. Index creation/auto-create was disabled. No write was made. The
public health checks were read at **06:36:50–06:36:51 UTC**.

**Production build:** `74e4b87` (deployed 2026-11-18 09:36 UTC), containing the console
delivery at `e7ce455` and the dependency bump. The production data below was measured on
`5016553` before either deploy and was not re-read after the restarts; previous boot
observations were `e7ce455`, `e218bb0` and `56e8c27`.

| Signal | Measured value |
| --- | --- |
| Businesses | **6** total / **6** active / 0 suspended / 0 archived |
| Accounts | **11** total / **9** active |
| Tenants active in the 7-day feature window | **1** |
| Products | **10,119** active / **0** archived |
| Locations | **10** active |
| Suppliers | **185** active |
| Purchase orders | **223** open |
| Inventory records | **20,184** product × location rows |
| Zero-quantity inventory rows | **1,344** |
| Total quantity | **2,474,170** |
| Stock movements (7 days) | **75** — 36 transfer, 22 stock-in, 11 stock-out, 6 adjustment |
| Feedback | **4** total / 0 open / 4 reviewed / 1 up / 3 down |
| Support tickets | **1** total / **1** unresolved (NEW, HIGH) |
| Platform audit events (7 days) | **201** — 1 failed admin login, 29 denied capability checks, 4 MFA failures |
| Platform administrators | **1** SUPERADMIN, ACTIVE, TOTP enrolled, **0** WebAuthn keys, **7** unused recovery codes, 0 active sessions |
| Current deployment | `74e4b87`; history also contains `e7ce455`, `5016553`, `e218bb0` and `56e8c27` |

**Consistency checks that passed**

- AI turns: **86 = 78 ok + 4 degraded + 4 failed**; **36 free + 50 paid = 86**;
  per-model turns **49 + 36 + 1 = 86**; outcomes **78 + 4 + 4 = 86**; the seven daily
  rows sum to **86**.
- Movement counts: **75 = 36 + 22 + 11 + 6**; the inventory page reads the same ledger.
- Feedback: 3 down ratings = 1 `INCORRECT_DATA` + 2 `MISSING_INFORMATION`; the reason
  counts reconcile.
- Audit: the 20 action counts sum to **201**, matching the reported total.
- The console labels its 7-day window as UTC and returns an `asOf` timestamp per request;
  there is no cached AI report (only `dbStats` is cached, for 30 s).

**The 5xx counter-scope difference (current, pre-deploy)**

At 06:36:50 UTC, `GET /api/health` reported:

- `responses: 11,159`
- `byStatusClass["5xx"]: 58`
- `serverErrors: 58`
- `lastServerErrorAt: 2026-11-18T05:47:53.762Z`

The console's durable `ops_error_events` window was **0**. These are two different
measurements, not 58 hidden incidents. `/api/health` publishes a process-lifetime counter
since boot. The old counter includes the intentional `503` from `/api/health/integrity`
when the laptop heartbeat is stale; that route writes its response directly, so it never
passes through the error handler that creates durable `ops_error_events` rows. The durable
store also cannot record a readiness `503` while MongoDB is unreachable, which is why
`/api/health/ready` is the availability signal for that case.

The deployed `74e4b87` build keeps the monitoring-only integrity `503` counted in
`responses` and `byStatusClass`, but not in `serverErrors` or `lastServerErrorAt`. The
deploy restart cleared the 58; future integrity `503`s do not inflate the failure count.
The durable store remains the record for application errors that reach the error handler;
it is not a backfill for the process
counter. Until then, treat “5xx since boot” as a process-lifetime counter and the durable
“5xx errors” card as the incident record for error-handler failures.

**Production health boundary observed**

- `GET /api/health` → **200**, `db: connected`, environment `production`.
- `GET /api/health/ready` → **200**, `db: connected`.
- `GET /api/health/integrity` → **200**, `state: fresh`, `fresh: true`,
  `lastCheckedAt: 2026-11-18T05:49:03.828Z`, `auditStatus: UNCHANGED`, `newCount: 0`,
  `scannedStockIns: 4,896` (observed at 06:31 UTC).
- `/platform` and `/api/platform/status` without the outer key → **401
  `PLATFORM_ACCESS_REQUIRED`**, `Cache-Control: no-store`, Basic challenge.

## 4. AI Assistant monitoring

The platform AI report is built from `ai_turn_metrics`, one durable row per completed
turn, through the same aggregation the tenant's OWNER/ADMIN metrics use. The console
reads a bounded 1–30 day UTC window (the page defaults to 7 days).

| Metric | 7-day production value | How it is produced | Accuracy note |
| --- | --- | --- | --- |
| Turns | **86** | Completed `ai_turn_metrics` rows | Totals reconcile with outcomes and models |
| Success | **78 ok / 4 degraded / 4 failed** (90.7% success) | Stored outcome and degraded flag | “Degraded” is a real answered-but-imperfect state |
| Free / paid | **36 free / 50 paid** | Stored tier | No unknown tier in this window |
| Failovers | **4 turns / 4 failover events** (4.65%) | Stored failover count and flag | Shows fallback activity, not the reason |
| Retries / re-asks | **29 / 15** | Per-turn counters | Operational retries, not member-visible errors |
| Empty responses | **1** | Stored empty-completion flag | One turn needed an empty-response path |
| Simple escalations | **4** | Stored free→paid escalation flag | Free-first routing moved four turns to paid |
| Calls / tool runs | **216 / 99** | Provider and tool counters | Includes tool loops |
| Tokens | **2,454,975** total (2,412,396 in / 42,579 out) | Provider usage | Provider-reported |
| p95 latency | **22,719 ms** | Stored latency percentile | Approximate; the console labels it so |
| Provider cost | **$0.053025** | Provider-reported cost | **82** turns reported, **4 unknown**; no estimate is invented |
| Models | `openai/gpt-oss-20b` 49 turns (4 failed, 4 failovers); `nvidia/nemotron-3.5-lightning:free` 36; `openai/gpt-oss-120b` 1 | Per-model aggregation | Model rows exist only for turns in the window |
| Outcomes | `ok` 78, `AI_UNAVAILABLE` 4, `degraded` 4 | Stored outcome codes | The error table and success count agree |

**What is accurate and current**

- The report is calculated per request from production rows; it is not a static sample.
- The last recorded AI turn in this window was **2026-11-17**; the 2026-11-18 row is
  **0** at measurement time. That is real activity, not a stale cache.
- The model table is usage per model, with tier, failures, failovers, p95 and reported
  cost. It is not a claim that a model is currently reachable.
- Provider cost is explicitly “provider-reported only”; four turns have unknown cost,
  and the console shows that count rather than filling it in.

**What the console does not show**

- The current configured model or model chain. The environment chooses it; the console
  shows the models that actually served turns.
- Live provider/model health. The infrastructure panel reports configuration only.
- A spend budget, threshold alert or paid-fallback kill switch.
- Prompt or answer text. The console is aggregate-only by design; tenant feedback review
  is a separate OWNER/ADMIN surface.

## 5. Authentication and verification

### 5.1 Platform administrators

1. **Outer gate.** The browser supplies the shared `PLATFORM_ACCESS_KEY` through HTTP
   Basic. API clients use `X-Platform-Access-Key` beside a Bearer token. This gate is
   not a person and is not a substitute for the platform login.
2. **Password.** `POST /api/platform/auth/login` checks the local bcrypt credential and
   returns an MFA challenge, **never a session**. A password alone cannot authenticate.
3. **First login / enrollment.** If TOTP is not enrolled, the challenge starts TOTP
   enrollment. The administrator scans the secret and confirms a six-digit code. TOTP is
   mandatory.
4. **Later logins.** TOTP, an enrolled WebAuthn security key, or a one-time recovery code
   completes the login. The production account currently has TOTP and recovery codes but
   **no WebAuthn key**, so WebAuthn is not offered as a login method for it.
5. **Recovery setup is mandatory.** An administrator with zero unused recovery codes is
   restricted by the server to `GET /auth/me`, `GET /auth/csrf`,
   `POST /auth/recovery-codes` and `POST /auth/logout` until codes are generated.
6. **Session.** The console receives an HttpOnly `platform_session` cookie scoped to
   `/api/platform`, plus a readable CSRF cookie. The session token is not exposed to
   JavaScript. Cookie requests require the exact console Origin (or the same-origin GET
   proof) and the `X-Platform-CSRF` header. The access token is short-lived and renewed
   through the same session.
7. **Step-up for lifecycle changes.** Before disable/enable/delete/key removal, the
   console asks for the current password and a TOTP code and calls
   `POST /api/platform/auth/step-up`. The server returns a five-minute proof bound to the
   administrator and the session's `jti`; the console sends it as
   `X-Platform-Step-Up`. The proof is not an access token, and a missing, expired or
   cross-session proof is refused with `403 PLATFORM_STEP_UP_REQUIRED` before the
   lifecycle service runs.
7. **Lockout.** Five failed MFA/recovery/WebAuthn factors in 15 minutes lock the account's
   MFA for 15 minutes. This budget is durable and account-scoped, not per-IP. A successful
   factor clears it. The login and MFA endpoints also have per-IP and per-account limits.

**Current production platform identity state:** one SUPERADMIN, ACTIVE, TOTP enrolled,
0 WebAuthn keys, 7 unused recovery codes, last login 2026-11-18 05:04:31 UTC, 0 active
sessions. The console is therefore protected by password + TOTP (+ recovery codes), not
by a hardware key.

### 5.2 Tenant users

- A new verified Firebase identity registers a **new business** and becomes its **OWNER**.
  Email/password and Google Sign-In are implemented; Facebook and Apple are not.
- An invited person verifies the invited email, creates their Firebase identity, and
  accepts the invitation. The invitation supplies the business and role; the request
  cannot choose them.
- An OWNER/ADMIN can also create a password account directly through `POST /api/users`.
  That account has an `8–72` character password and no Firebase identity; invitations are
  the safer path because the member sets their own credential.
- Tenant sessions are a separate JWT + `jti` session record. A platform token is not
  accepted by tenant routes, and a tenant token is not accepted by platform routes.
- **Disabling a tenant member does not revoke their sessions.** The server refuses the
  member on the next request, but the session rows remain. If the account is re-enabled
  before those sessions expire, an old token can work again. An admin has no route to
  revoke a member’s sessions; the member can use “sign out everywhere.”

### 5.3 Platform capabilities

| Role | Capabilities | What that means in the console |
| --- | --- | --- |
| `READ_ONLY` | `platform.health.read` | Live status/health only; no cross-tenant metrics |
| `SUPPORT` | health, metrics, support, deployments | Overview/AI/business/inventory/errors, support tickets, deployment history |
| `SECURITY` | health, metrics, audit, deployments | Reports and the append-only audit trail; no ticket management or admin lifecycle |
| `SUPERADMIN` | all capabilities | Everything above plus administrator list/disable/enable/delete/key removal |

The server enforces capabilities on every route; the console also hides unavailable
navigation. Hiding is not the control.

### 5.4 Known authentication/security limitations

- **No WebAuthn key is registered** on the sole SUPERADMIN. The account still has
  mandatory TOTP and recovery codes, but not a hardware-bound second factor.
- **The outer gate is a shared secret**, not per-person authentication. The production
  URL is internet-reachable; Render Free cannot attach an inbound IP allowlist. Treat
  the Basic key as an outer door, not network isolation.
- **The recovery-code file is stale.** Seven unused codes remain in the database, but the
  local file does not match them. Rotate the codes with the current password + TOTP (or a
  current recovery code) and store the new set offline; do not rely on the old file.
- **The platform realm is an interim local bcrypt realm.** A dedicated identity provider
  and passkey-first policy remain the approved future boundary.
- **No dual control** is required for disable/enable/delete/key removal. A fresh
  password + TOTP **step-up proof** is required, is bound to the current session and lasts
  five minutes; without it the API returns `403 PLATFORM_STEP_UP_REQUIRED`. The proof is
  stateless, so it can be replayed within its five-minute window by the same session.
  Self-disable/self-delete and the last active SUPERADMIN are still refused, and
  disable/delete/key removal revoke the target's sessions.
- **Audit is append-only in the model**, but there is no external immutable sink,
  retention decision or proof that a raw database role cannot rewrite it.
- **No platform-specific pager.** The console is pull-only; external health probes watch
  the API. A failed platform login/MFA burst is visible in the audit trail but does not
  alert anyone.
- **Per-IP limiters are process-local.** The durable account MFA lock survives restarts;
  the IP budget is per process.

## 6. Account creation and role management

### 6.1 Platform administrators (CLI only)

There is no HTTP route that creates a platform administrator. Creation is an operator
action with a confirmation phrase. The password is read from the environment and is never
printed or written to a file.

All four platform roles use the same credential set: an email address, a 16+ character
password, a TOTP authenticator and recovery codes; a WebAuthn security key is optional.
The outer access key is shared by operators and is not a per-role credential.

**Prerequisites (from the deployment secret store, never committed):**

- `MONGODB_URI` and the intended database name.
- `PLATFORM_ADMIN_JWT_SECRET` — separate platform signing secret.
- `PLATFORM_MFA_ENCRYPTION_KEY` — encrypts TOTP secrets and WebAuthn public keys.
- `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_WEBAUTHN_ORIGIN`, `PLATFORM_WEBAUTHN_RP_ID`.
- `PLATFORM_ACCESS_KEY` — the shared outer-door key required in production.
- For the creation command: `PLATFORM_ADMIN_CONFIRM=create-platform-admin`,
  `PLATFORM_ADMIN_OPERATOR` (recorded on the audit event), `PLATFORM_ADMIN_EMAIL`,
  `PLATFORM_ADMIN_NAME`, `PLATFORM_ADMIN_ROLE`, `PLATFORM_ADMIN_PASSWORD` (16+
  characters). `PLATFORM_ADMIN_GRANT_ID` is optional.

```bash
cd server

# Example: create a SUPPORT administrator.
PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
PLATFORM_ADMIN_EMAIL='<operator-email>' \
PLATFORM_ADMIN_NAME='<display name>' \
PLATFORM_ADMIN_ROLE=SUPPORT \
PLATFORM_ADMIN_PASSWORD='<16+ character password>' \
npm run platform-admin:create
```

When the command targets production, the environment must be production and the second
phrase is required:

```bash
NODE_ENV=production \
PLATFORM_ADMIN_PROD_CONFIRM=CREATE-PLATFORM-ADMIN \
PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
... \
npm run platform-admin:create
```

**First sign-in and verification:**

1. Open `/platform` and satisfy the Basic outer gate.
2. Enter the platform email and password. Expect an MFA enrollment challenge, **not** a
   dashboard.
3. Scan the TOTP secret with an authenticator, confirm a six-digit code, and save the
   recovery codes shown once. The console forces recovery setup if no unused codes
   exist.
4. Check `GET /api/platform/auth/me`: it returns the role, capabilities, MFA state, key
   count and recovery-code count.
5. Prove the role boundary:
   - `READ_ONLY`: `GET /api/platform/status` → 200; `GET /api/platform/operations` → 403.
   - `SUPPORT`: `GET /api/platform/tickets` → 200; `GET /api/platform/audit` → 403.
   - `SECURITY`: `GET /api/platform/audit` → 200; `GET /api/platform/admins` → 403.
   - `SUPERADMIN`: `GET /api/platform/admins` → 200; the team page lists administrators.
6. Confirm the audit trail records the login challenge, MFA enrollment/verification and
   the report read.

**Lifecycle:** a SUPERADMIN can list administrators, disable/enable them, delete them and
remove a WebAuthn key. Each change requires a fresh password + TOTP step-up proof; the
console prompts for it and the API enforces it. Self-disable/self-delete are refused, the
last active SUPERADMIN cannot be removed, and disable/delete/key removal revoke the
target's sessions. There is no role-change endpoint and no creation UI; role changes and
additional provisioning are operator CLI work (the CI-08 improvement).

### 6.2 Tenant roles

| Role | Who creates it | Required credentials | Main permissions |
| --- | --- | --- | --- |
| `OWNER` | The person registers a new verified account; a new business is created with them as OWNER | Verified Firebase identity (email/password or Google) | Everything in the business, including users, audit, AI metrics and business/role controls |
| `ADMIN` | OWNER (direct `POST /api/users` or invitation); an ADMIN cannot create/invite another ADMIN | Direct: email + 8+ character password. Invitation: verified Firebase identity for the invited address | Users, locations, categories, products, suppliers, purchase orders, inventory, dashboard, AI, AI metrics, audit |
| `MANAGER` | OWNER or ADMIN (direct or invitation) | Same as ADMIN | Products, suppliers, purchase orders, inventory, dashboard, AI; no users, audit or AI metrics |
| `STAFF` | OWNER or ADMIN (direct or invitation) | Same as ADMIN | View products/suppliers/orders; receive purchase orders; stock in/out and view inventory history; use the AI assistant |

`OWNER` cannot be created or assigned through the user-management API. It is created only
by registration. The OWNER row is immutable through user management, a user cannot change
their own role/status, and an ADMIN cannot create, invite, modify or assign ADMIN.

**Direct creation (OWNER/ADMIN token):**

```http
POST /api/users
Authorization: Bearer <tenant access token>
Content-Type: application/json

{
  "name": "Store Manager",
  "email": "manager@example.com",
  "password": "<at least 8 characters>",
  "role": "MANAGER"
}
```

The response is the public user row; the password is not returned. The new account can
sign in with the email/password login path. This is a legacy password account, not a
Firebase identity.

**Invitation (preferred):**

```http
POST /api/invitations
Authorization: Bearer <OWNER or ADMIN token>
Content-Type: application/json

{
  "email": "staff@example.com",
  "role": "STAFF"
}
```

The invitation is valid for **7 days**, requires configured transactional mail, and is
withdrawn if the mail cannot be delivered. The invitee must use the same email, verify it,
and create a Firebase identity; the business and role come from the invitation, not from
the acceptance request. Re-inviting the same address replaces the pending token.

**Role and status changes:** `PATCH /api/users/:id` accepts `{"role":"MANAGER"}` or
`{"status":"DISABLED"}` (either may be sent). It requires `users.manage` (OWNER/ADMIN).
A user cannot change their own role/status, the OWNER cannot be modified, and an ADMIN
cannot modify or assign another ADMIN. An OWNER/ADMIN can therefore promote or demote a
MANAGER/STAFF account, but cannot mint or alter an OWNER through this route. Disabling
does not delete existing sessions: access stops at the next request, and re-enabling can
revive an unexpired session.

**Verification procedure for a tenant role:**

1. Sign in as the new account and call `GET /api/auth/me`; confirm the role and business.
2. Confirm the expected boundary:
   - OWNER/ADMIN: `GET /api/users` → 200 and `GET /api/audit` → 200.
   - MANAGER: `GET /api/users` → 403 and `GET /api/audit` → 403; a product write is allowed.
   - STAFF: `GET /api/users` → 403; a product write is refused; a stock-in is allowed.
3. Confirm the user-management audit row (`USER_CREATED`) or the invitation audit row.
4. For an invitation, confirm the invited address is the verified address and the
   resulting user row has the role the invitation carried.
5. Disable a test account with `PATCH /api/users/:id`; there is no admin delete-member
   route. The member may self-delete. Do not use the data-cleanup procedure for a real
   account, and do not leave a shared password in place.

**Credential rules:** never put a password, TOTP secret, recovery code or access key in a
ticket, chat, commit, screenshot or document. The platform password minimum is 16
characters; the tenant password is 8–72 characters. Prefer invitations so the member
chooses their own credential. Store recovery codes offline in the owner's secret store.

## 7. Known issues and next actions

| Priority | Item | Current state |
| --- | --- | --- |
| **P1** | Verify the post-deploy console | `74e4b87` is deployed; health/readiness and the gate/preflight checks pass. An authenticated browser proof after the deploy is still pending |
| **P1** | Register a WebAuthn security key for the sole SUPERADMIN | 0 keys today; TOTP and recovery codes still work |
| **P1** | Rotate the stale recovery-code file | 7 unused codes in the database, but the local file does not match them; use the current password + TOTP/recovery code |
| **P1** | Add an actual network/identity access layer | The URL is internet-reachable; the Basic key is not network isolation |
| **P1** | Dual control for disable/delete/key removal | Step-up proof is implemented; a second SUPERADMIN approver is still open |
| **P1** | Audit retention, export and an immutable sink | Model append-only only; raw database access is not constrained by this repo |
| **P1** | Platform alerting/pager | The console is pull-only; external health probes do not cover login/MFA bursts |
| **P2** | AI spend budget, model-health alerts and a paid-fallback kill switch | The console reports history; it does not alert or stop spend |
| **P2** | Host/Atlas/backup, mobile and job telemetry | Explicitly unavailable; do not read the absent panels as “healthy” |
| **P2** | Administrator creation/role-change UI | Creation and role changes are CLI/database work today |
| **P2** | Authenticated browser re-proof on the current commit | The last recorded proof is `e218bb0`; the current build is `74e4b87` and this pass did not sign in |

## 8. Evidence and limits

- **Code:** the console routes, static shell, platform auth/MFA, capabilities, operations
  and monitoring services in `server/src` and `server/platform-console/public`.
- **Tests:** CI run `44271986057` passed the full server suite **3,161/3,161** (508
  suites) on `282c8d6`; the platform suites (PLAT-2/3/4/7/8/9, OPS-7) are part of that run.
- **Production:** the read-only snapshot in §3 and the public health/auth responses in
  §3 were observed on 2026-11-18. No authenticated browser session, no platform account
  creation and no tenant write were performed for this assessment.
- **Deployment:** PR #336 squash-merged as `e7ce455`; dependency PR #318 then
  squash-merged as `74e4b87`. All five required checks passed on both heads. Production
  `/api/health` reports `74e4b87`, `status: ok`, `db: connected` and **0** `serverErrors`;
  `/api/health/ready` is **200**; `/platform/` and `/api/platform/status` remain **401**;
  the destructive-route preflight is **204** with credentials and `x-platform-step-up`
  allowed.

The console is usable as an aggregate read-only operations surface today. It is not yet a
complete support workspace, not a pager, not a tenant-detail tool and not a substitute for
network isolation. The items in §7 are the gap between “working” and “operationally
complete.”
