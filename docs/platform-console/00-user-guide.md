# Internal Operations & Monitoring Console — user guide

**Reviewed:** 2026-11-19 against the repository implementation and the public production
endpoints.
**Production:** <https://ai-inventory-l1mi.onrender.com/platform>
**Audience:** the owner/CEO, Superadmins, support personnel and developers who need
read-only operational access.
**Shorter version:** the console is an internal, aggregate operations surface. It is
**not** a tenant administration screen, a pager or a deployment tool.

> **No secrets in this guide.** Never paste a password, TOTP code, recovery code, session
> cookie, CSRF token or the shared outer access key into a document, ticket or chat.

## The short version

- Access needs **two layers**: the shared outer access key and a **separate platform
  account** with MFA. A tenant login cannot open the console.
- The four platform roles are `READ_ONLY`, `SUPPORT`, `SECURITY` and `SUPERADMIN`.
- Platform accounts are created **only by the operator CLI**. There is no signup page and
  no “Add administrator” button.
- Tenant data is **aggregate only**: no tenant names, member emails, products or rows.
- Support tickets and administrator lifecycle actions are **platform-only writes**. The
  console cannot change tenant data.
- There is **no `DEVELOPER` role**. Choose the least-privileged existing role.
- There is no platform pager, no tenant-detail support grant and no network allowlist.

## 1. Access and sign-in

### 1.1 What you need

1. The production URL above.
2. The **shared outer access key** and its username from the owner or operator who
   manages the deployment. The username is `PLATFORM_ACCESS_USER` (default: `platform`);
   the key is at least 32 characters.
3. Your own platform email and password. Never use another person’s account.
4. An authenticator app for TOTP. A registered WebAuthn security key is optional. An
   unused recovery code is the fallback if TOTP and every security key are unavailable.

The outer key is one shared door, not a person. It does not replace the platform password
or MFA.

### 1.2 First sign-in

1. Open the console URL. The browser shows an HTTP Basic prompt **before** the console
   page.
2. Enter the outer access username and shared access key. A wrong key returns `401
   PLATFORM_ACCESS_REQUIRED`; repeated failures are rate-limited with `429`.
3. Enter your platform email and password. A password alone never opens a session; it
   returns an MFA challenge.
4. On a new account, scan the TOTP secret/QR with your authenticator and enter the
   six-digit code. TOTP enrollment is mandatory.
5. The console then forces recovery-code setup. Re-enter your current password, generate
   the codes, save all **ten** codes offline in two separate secure places, tick the
   saved-code confirmation, and continue.
6. You are now in the console. The account is not fully usable until it has at least one
   unused recovery code; the server enforces this, not just the page.

### 1.3 Later sign-ins

- Enter the outer key, email and password.
- Complete the challenge with TOTP, an already-registered WebAuthn security key, or one
  unused recovery code.
- If your account has no WebAuthn key, the security-key option is not offered.
- A recovery code is **single-use**. Generate a new set before the last one is spent.

### 1.4 Sessions and sign-out

- The browser session uses an HttpOnly cookie and a CSRF token; the access token is not
  readable by page JavaScript.
- The access token lasts **15 minutes**, the session has a **15-minute idle timeout** and
  an **8-hour absolute cap**. Renewal does not extend the 8-hour cap.
- Use **Sign out** when finished, especially on a shared computer.
- A password change, platform disable/delete, or removal of a security key revokes the
  affected platform sessions.

### 1.5 If sign-in fails

| Symptom | What to do |
| --- | --- |
| Basic prompt repeats or `401 PLATFORM_ACCESS_REQUIRED` | Recheck the shared key and `PLATFORM_ACCESS_USER` with the owner. Do not guess repeatedly. |
| `Invalid email or password` | Check the address and password. If the password is lost, use break-glass; there is no self-service platform password reset. |
| Password accepted, but no MFA method works | Check the authenticator clock and try the next TOTP code. If no method works, use a recovery code; if none remain, break-glass. |
| `Too many verification attempts` | Five failed factors in 15 minutes lock MFA for 15 minutes. Wait; do not keep trying. |
| `Session expired` | Sign in again. A 15-minute idle gap or the 8-hour cap ends the session. |
| `403` on a section | Your role lacks that capability. See §3 and §4; do not request `SUPERADMIN` unless the job truly requires administrator management. |
| Account disabled | A Superadmin must re-enable it. Break-glass does **not** re-enable a disabled account. |

### 1.6 Local development (optional)

The console is also served locally from the API at `http://localhost:4000/platform` when
the server is running. A separate loopback-only static server is available with
`cd server && npm run platform-console`; it defaults to `http://localhost:4100` and the
API at `http://localhost:4000`. Local platform configuration and a local platform account
are required. Never expose the loopback listener directly.

## 2. Superadmin account

### 2.1 What a Superadmin is

`SUPERADMIN` holds every platform capability:

- health and operational metrics;
- support tickets and deployment history;
- the platform audit trail;
- the administrator roster and lifecycle actions.

Only a Superadmin can open **Team management** and disable, enable, delete an
administrator, or remove a WebAuthn key. This is the highest platform role; it is not a
tenant role and does not make the person a member of any business.

### 2.2 Create the first Superadmin

There is **no HTTP create route and no creation button**. Use the guarded operator CLI
from `server/`, in a private shell with the deployment’s platform secrets already
configured.

Prerequisites (names only; values stay in the secret store):

- `MONGODB_URI` and the intended database name;
- `PLATFORM_ADMIN_JWT_SECRET`;
- `PLATFORM_MFA_ENCRYPTION_KEY`;
- `PLATFORM_ACCESS_KEY`, `PLATFORM_ACCESS_USER`;
- `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_WEBAUTHN_ORIGIN`,
  `PLATFORM_WEBAUTHN_RP_ID`.

Command shape:

```bash
cd server

PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
PLATFORM_ADMIN_EMAIL='<admin email>' \
PLATFORM_ADMIN_NAME='<display name>' \
PLATFORM_ADMIN_ROLE=SUPERADMIN \
PLATFORM_ADMIN_PASSWORD='<16+ character password>' \
npm run platform-admin:create
```

For production, also set `NODE_ENV=production` and
`PLATFORM_ADMIN_PROD_CONFIRM=CREATE-PLATFORM-ADMIN`. The command prints the new
administrator’s id, email and role; it never prints the password or hash. The password is
read from the environment and should be cleared from the shell afterwards. Use a
password-manager-generated password of at least 16 characters.

`PLATFORM_ADMIN_OPERATOR` is required and is recorded on the single
`platform.admin.created` audit event. `PLATFORM_ADMIN_GRANT_ID` is optional.

### 2.3 First login and hardening

1. Sign in as described in §1.2.
2. Complete TOTP enrollment.
3. Generate and save the ten recovery codes offline.
4. Open **Security & access**:
   - check the role and capabilities;
   - register a primary WebAuthn security key, then a backup key if available;
   - confirm the recovery-code count;
   - change the initial password if it was not created in your password manager.
5. Add a second trusted Superadmin if continuity matters. The server protects the last
   active Superadmin, but it cannot provide a second person.

WebAuthn is optional but recommended. Up to **10** security keys can be registered; user
verification is required. Removing a key revokes that administrator’s sessions.

### 2.4 Manage the team

Open **Team management** (Superadmin only). The page lists administrators with role,
status, MFA state, key count and recovery-code count.

| Action | Result |
| --- | --- |
| Disable | Immediately revokes the target’s platform sessions; the account cannot sign in. |
| Enable | Makes a disabled account usable again. |
| Delete | Permanently removes the administrator and their sessions. |
| Remove key | Removes one WebAuthn key and revokes the target’s sessions. |

Destructive actions require a fresh **password + TOTP step-up** in the dialog; the proof
lasts five minutes and is bound to your session. The server refuses a missing or expired
proof. You cannot disable or delete yourself, and the last active Superadmin cannot be
disabled or deleted.

There is **no role-change endpoint and no role-change button**. To change a role, create a
new account with the intended role, verify it, then disable or delete the old account.
Keep at least one active Superadmin throughout.

### 2.5 Lockout and break-glass

Break-glass is the last resort for a totally locked-out administrator. It is an operator
script, not a web reset. It requires database/deployment access, the exact resolved
database name and a new password.

```bash
cd server

PLATFORM_BREAK_GLASS_CONFIRM=reset-platform-admin \
PLATFORM_BREAK_GLASS_DB='<resolved database name>' \
PLATFORM_BREAK_GLASS_EMAIL='<administrator email>' \
PLATFORM_BREAK_GLASS_PASSWORD='<new 16+ character password>' \
PLATFORM_BREAK_GLASS_OPERATOR='<operator label>' \
npm run platform-admin:break-glass
```

Production additionally requires
`PLATFORM_BREAK_GLASS_PROD_CONFIRM=BREAK-GLASS-PLATFORM-ADMIN` and
`NODE_ENV=production`. The reset clears TOTP, WebAuthn keys, recovery codes, the MFA lock
and every platform session. It leaves the role and status unchanged, so a disabled
administrator stays disabled.

After break-glass: sign in with the new password, re-enroll TOTP, save the new ten
recovery codes, register keys again, and review the audit trail. Do not use break-glass as
a routine password reset; it removes every factor and is a security event.

## 3. Support team accounts

### 3.1 Are separate accounts supported?

**Yes.** Each support person should have a separate platform account with the `SUPPORT`
role. There is no shared support login and no UI/HTTP account creation; a Superadmin or
operator creates each account with the CLI.

```bash
cd server

PLATFORM_ADMIN_CONFIRM=create-platform-admin \
PLATFORM_ADMIN_OPERATOR='<your identity>' \
PLATFORM_ADMIN_EMAIL='<support person email>' \
PLATFORM_ADMIN_NAME='<display name>' \
PLATFORM_ADMIN_ROLE=SUPPORT \
PLATFORM_ADMIN_PASSWORD='<16+ character password>' \
npm run platform-admin:create
```

The new person completes TOTP and recovery-code setup on first sign-in. Give them the
shared outer access key through an approved channel; never give them another person’s
password, TOTP secret or recovery codes.

### 3.2 What a Support account can do

`SUPPORT` has health, metrics, support and deployment-read capabilities:

- Operations overview and aggregate AI/business/inventory/error reports;
- live status, infrastructure, database/storage and system checks;
- support ticket queue: create, read, assign, change status/priority, and add internal
  notes;
- deployment/build history;
- their own **Security & access** page.

A Support account **cannot**:

- read the platform audit trail;
- open Team management or change administrators;
- read tenant names, member emails, product rows, SKUs or locations;
- read or change tenant inventory/member data;
- deploy code or change production configuration.

### 3.3 Least privilege for support

- Use `SUPPORT` for service-desk and investigation work.
- Use `READ_ONLY` if the person only needs health/status.
- Do not give support staff `SUPERADMIN` “for convenience.”
- Do not create one shared support account. Named accounts are what make the audit trail
  useful and make offboarding possible.
- Support tickets are internal, tenant-free records. Do not paste tenant personal data
  into a ticket.

## 4. Developer accounts

### 4.1 Is there a developer role?

**No.** The implementation has no `DEVELOPER` platform role and no developer-specific
permission set. A platform administrator is one of `READ_ONLY`, `SUPPORT`, `SECURITY` or
`SUPERADMIN`.

Developer access should be mapped to the work:

| Work | Recommended role | Reason |
| --- | --- | --- |
| Watch health/deploy status only | `READ_ONLY` | Health and own security only; no cross-tenant metrics. |
| Investigate aggregate errors, AI usage, deployments, tickets | `SUPPORT` | Operational reports and support workflow; no audit or team management. |
| Security review and audit evidence | `SECURITY` | Metrics, deployments and audit; no ticket management or administrator lifecycle. |
| Manage platform administrators | `SUPERADMIN` only if unavoidable | Full control; reserve for the smallest number of owners. |

A developer who needs to **deploy** uses the repository/Render/GitHub workflow, not the
console. The console only **reports** the current commit and boot history; it has no
deploy, rollback or environment-change button.

Create a developer account the same way, with the chosen role:

```bash
PLATFORM_ADMIN_ROLE=SUPPORT npm run platform-admin:create
# or READ_ONLY / SECURITY; use SUPERADMIN only with owner approval
```

There is no role-change route. Create a replacement account with the correct role, verify
it, then disable/delete the old one. Do not share a developer account across people.

## 5. Daily operations

### 5.1 The console sections

| Section | What it is for | Who can use it |
| --- | --- | --- |
| **Operations overview** | Platform counts, AI turns, tickets, recent issues | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Live system status** | API/readiness, process, database state, commit, uptime | All four roles |
| **Infrastructure & API** | Node memory/RSS, process CPU, `dbStats`, integration configuration | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **AI operations** | Turns, free/paid mix, retries, failovers, latency, tokens, provider-reported cost, models/outcomes | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Database & storage** | Connection, data/storage/index sizes, cached `dbStats` latency | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Mobile app health** | Explicitly says no mobile crash/install/startup telemetry exists | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Background jobs** | Explicitly says there is no durable job/queue history | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Businesses & tenants** | Aggregate business/account/member/inventory counts; no tenant detail | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Inventory analytics** | Aggregate movement and inventory counts; no rows | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Support center** | Internal ticket queue, assignment, status/priority and notes | `SUPPORT`, `SUPERADMIN` |
| **Errors & incidents** | Durable 5xx totals, groups and recent events; no request bodies | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **Deployments & releases** | Current commit and boot-observed history | `SUPPORT`, `SECURITY`, `SUPERADMIN` |
| **System checks & reports** | Configuration predicates for DB, platform auth/MFA, AI, mail and Firebase | All four roles |
| **Audit trail** | Sign-ins, MFA events, denials, report reads and lifecycle events | `SECURITY`, `SUPERADMIN` |
| **Team management** | Administrator roster and lifecycle actions | `SUPERADMIN` |
| **Security & access** | Your role, MFA, keys, recovery codes and password | All four roles |

The console labels unavailable sources instead of estimating them. Do not read an empty
mobile/jobs panel as “healthy”; read it as “not instrumented.”

### 5.2 A safe daily routine

1. **Overview** — check open tickets, AI failures/retries and recent issues.
2. **Live system status** — confirm API/database readiness and the deployed commit.
3. **Errors & incidents** — review durable 5xx events and platform denials.
4. **Support center** — triage new tickets, assign an owner, update status and add notes.
5. **Deployments & releases** — after a release, confirm the expected commit is serving.
6. **Audit trail** — weekly (or after any administrator/MFA event) for `SECURITY` and
   `SUPERADMIN`.
7. **Team management** — monthly: review active administrators, roles, MFA and keys;
   disable leavers immediately.

### 5.3 Tenant management boundary

The console does **not** manage tenants. It has no tenant selector, no tenant detail, no
member accounts and no tenant write. Tenant `OWNER`/`ADMIN` work stays in the mobile app
and tenant API. Support tickets are internal platform records and are not linked to a
tenant or member.

If a support case needs tenant detail, it is **not available in this build**. Do not add
tenant names, emails or product data to a console ticket, and do not use a database edit
as a workaround.

### 5.4 What is not available

- Mobile crash/install/startup telemetry.
- Durable background-job or queue history.
- Live AI provider/model health, a spend alert or a paid-fallback kill switch.
- Database backup/restore status, slow-query profiling or connection-pool saturation.
- A platform pager; the console is pull-only.
- Tenant-detail support access, dual control or an immutable external audit sink.
- Network isolation beyond the shared outer key; the URL is internet-reachable.

## 6. Security rules

1. **One person, one account.** Never share a platform login or MFA factor.
2. **Use the least role.** `READ_ONLY` for health, `SUPPORT` for service desk,
   `SECURITY` for audit, `SUPERADMIN` only for administrator management.
3. **Protect the password.** Use a unique 16+ character password in a password manager;
   never reuse a tenant or personal password.
4. **Keep TOTP separate.** Put the authenticator on a device separate from the main
   workstation. Never send a TOTP code to another person.
5. **Register two security keys** where possible: a primary and a backup stored
   separately. Keys are optional, but they are stronger than TOTP alone.
6. **Recovery codes are spare keys.** Ten single-use codes; store them offline in two
   places. Regenerating invalidates every old code. Do not trust an old file: check the
   current count and regenerate through **Security & access**.
7. **Protect the outer key.** It is shared, not personal. Give it only to people who need
   the console; never put it in the repository, chat, ticket, screenshot or email.
8. **Step-up before lifecycle changes.** Disable/enable/delete/key removal require fresh
   password + TOTP. This is not dual control; one Superadmin can perform the action.
9. **Sign out and review.** Use sign-out, keep the audit trail under review, and remove a
   leaver’s account, keys and sessions the same day. Disabling a platform account revokes
   its platform sessions.
10. **Do not put tenant data in the console.** The platform surface is aggregate-only.

### Recovery quick reference

| Situation | Recovery |
| --- | --- |
| Lost TOTP device, recovery codes available | Sign in with a recovery code. Generate a new set; replacing TOTP itself requires break-glass. |
| Lost security key, TOTP available | Sign in with TOTP. A Superadmin removes the lost key; add a replacement first. |
| Lost recovery codes, TOTP/key available | Sign in normally; regenerate the ten codes with the current password and store them offline. |
| Forgotten password, factors available | Break-glass. There is no self-service platform password reset. |
| No factors and no password | Break-glass with database/deployment access. |
| Outer key lost | Retrieve it from the deployment secret store; if it may have leaked, rotate it and restart the service. |
| MFA locked | Wait 15 minutes; repeated attempts do not speed it up. |
| Account disabled | Another active Superadmin enables it. Break-glass does not override status. |

## 7. Verification, limitations and source of truth

**Checked against the implementation:** platform roles and capabilities
(`server/src/constants/platformRoles.ts`), route capabilities
(`server/src/routes/platform.routes.ts`), platform authentication and sessions
(`server/src/services/platformAuth.service.ts`, `platformSession.service.ts`), mandatory
TOTP and recovery (`platformMfa.service.ts`, `platformRecovery.service.ts`), WebAuthn
key limit, administrator lifecycle guards (`platformAdminLifecycle.service.ts`), the
break-glass CLI, and the console’s 16 sections (`server/platform-console/public/`).

**Production read-only check (2026-11-19):** `/api/health` returned 200 with `db:
connected`, environment `production`, commit `f95b5e4`, and zero process server errors;
`/api/health/ready` returned 200. `/platform/` and `/api/platform/status` without the
outer key returned `401 PLATFORM_ACCESS_REQUIRED` with a Basic challenge and
`Cache-Control: no-store`. This confirms the gate and health posture only.

**Not verified in this review:** an authenticated browser session on production, the
current administrator count/roles/MFA state, the current recovery-code file, or a live
break-glass/WebAuthn/recovery login. No password, OTP, recovery code, cookie, key or
production account was used. The dated snapshots in
[`01 — Status and accounts`](01-status-and-accounts.md) and
[`02 — Accounts and credentials`](02-accounts-and-credentials.md) remain evidence of
what was measured earlier, not live guarantees.

**Known limitations:** no network allowlist; the outer gate is a shared secret; no
platform pager; no dual control; the audit trail is append-only in the application model
but has no immutable external sink or retention decision; the platform password realm is
an interim local bcrypt realm; and no tenant-detail support grant exists. See
[`04 — Production readiness`](04-production-readiness.md) for the gate status.

**If this guide and the code disagree, the code wins.** Update this guide when a role,
route, screen or recovery procedure changes.
