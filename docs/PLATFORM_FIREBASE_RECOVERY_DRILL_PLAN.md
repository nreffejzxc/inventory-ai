# Firebase authentication recovery drill plan

**Status:** **PLANNING ONLY. NO DRILL HAS BEEN RUN. NO PRODUCTION CHANGE IS AUTHORIZED.** This plan was
safety-reviewed on 2026-11-17; the review corrected the project-recovery window, key-revocation
timing, emulator statement and network-failure method below.
**Reviewed:** 2026-11-17
**Budget:** **$0 incremental.** A separate Firebase **Spark (free)** project, the local API and a
disposable local/test MongoDB are sufficient. No paid Firebase plan, paid Render service or paid
support plan is required.

This plan tests whether Inventory AI can recover when Firebase Authentication is unavailable, when
its Admin credential is rejected, or when the Firebase project itself is inaccessible. Firebase is the
identity authority; Inventory AI issues its own application session only after Firebase verifies an
ID token.

## 1. What must not break

The drill exists to prove these rules, not to discover them for the first time:

| Rule | Current implementation |
| --- | --- |
| Firebase authenticates; Inventory AI authorizes | `POST /api/auth/firebase/exchange` verifies the ID token, then loads `User` by `firebaseUid`; role/business come from MongoDB |
| A transient Firebase failure preserves a valid Inventory session | `FIREBASE_UNAVAILABLE` is a 503, not a 401; the mobile client treats it as transient |
| A rejected credential is not an outage | `FIREBASE_TOKEN_INVALID` is terminal for that credential; the client may ask the user to sign in again |
| A missing/broken server credential is an operator fault | `FIREBASE_NOT_CONFIGURED` is a distinct 503 code |
| No fallback to the legacy password door during a Firebase outage | The legacy path is a migration path, never an outage fallback |
| Health is not Firebase health | `/api/health` never verifies a Firebase token; a green health check proves nothing about Firebase |
| No token, service-account key or recovery code reaches a log | Error reasons are allowlisted; the Admin app does not log |

Authoritative code and contracts:

- [`server/src/services/firebase/tokenVerifier.ts`](../server/src/services/firebase/tokenVerifier.ts)
- [`server/src/services/firebase/firebaseErrors.ts`](../server/src/services/firebase/firebaseErrors.ts)
- [`server/src/services/firebase/adminApp.ts`](../server/src/services/firebase/adminApp.ts)
- [`server/src/controllers/firebaseAuth.controller.ts`](../server/src/controllers/firebaseAuth.controller.ts)
- [`FIREBASE_CREDENTIAL_RUNBOOK.md`](FIREBASE_CREDENTIAL_RUNBOOK.md)
- [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md)

## 2. Drill shape

### A. Tabletop first (no credentials, no network)

30–45 minutes, with the owner and the named backup (Cucumber, contact details in the owner's private
record). Walk through:

1. Firebase is down; a signed-in user's app cannot renew. What does the user see?
2. A new sign-in gets 503 `FIREBASE_UNAVAILABLE`. Is the existing session preserved?
3. A service-account key is revoked. Which code is returned, and which alert should fire?
4. The Firebase project is inaccessible to the owner. What can be recovered, and what cannot?
5. The owner's Google account is unavailable. Who can restore access, and from where?

The tabletop produces decisions and gaps only; it is not evidence that a live recovery works.

### B. Isolated live drill (free project, local API)

Use a **separate free Firebase project** created for testing. Never point the drill at
`inventoryai-d0d20` or at the production database.

| Component | Drill value |
| --- | --- |
| Firebase project | A separate **Spark** project, e.g. `inventoryai-auth-drill`, owned by the owner |
| Firebase users | Disposable test identities only; no customer address or real password |
| Server | Local API from this repository, test environment |
| Database | A disposable local/test MongoDB (`inventoryai_test_db` or equivalent), never `inventoryai_prod_db` |
| Credential | The drill project's service-account JSON, held only in the local ignored environment |
| Client | Local API origin; no production build or production session |
| Render / Atlas / Cloudflare | **Not touched** |

The current server has no Firebase Auth emulator path. The Admin SDK itself supports an Auth emulator
through `FIREBASE_AUTH_EMULATOR_HOST`, but this server's Admin app requires a service account and has
no emulator configuration; adopting the emulator would require a separately approved test-only
configuration change. A separate free **Spark** project is therefore the $0 path used here because it
exercises the real Admin SDK, real token verification and real key revocation. Firebase Spark project
creation has a limited quota, and a project marked for deletion still counts toward that quota during
the 30-day recovery window.

### C. Real-provider failure cases that are safe to create

In the drill project only:

1. **Revoked key** — create a second key first, then delete the first. Restart the local API process
   (clearing the Admin SDK's in-memory OAuth token) and verify the old credential fails closed. A
   deleted key can appear to work briefly because an already-minted Google OAuth access token remains
   valid until it expires (typically up to one hour); a delayed success is not proof the deleted key
   is still accepted. Do not delete the only remaining key.
2. **Disabled test user** — disable a disposable Firebase user; verify the exchange is terminal for
   that credential and does not damage an unrelated valid application session.
3. **Deleted test user** — delete a disposable identity; verify `auth/user-not-found` is terminal and
   does not become a 500.
4. **Expired/revoked ID token** — use the SDK/client to obtain a token, then revoke or expire it; verify
   `FIREBASE_TOKEN_INVALID`, never `FIREBASE_UNAVAILABLE`.
5. **Missing server credential** — start the local API with the variable absent; verify
   `FIREBASE_NOT_CONFIGURED` (503), and that startup still succeeds.
6. **Malformed credential** — use an unparseable JSON/PEM in the isolated environment; verify fail-closed
   `FIREBASE_NOT_CONFIGURED`, no key material in the response or log.
7. **Controlled transient failure** — use the existing verifier seam
   (`setFirebaseIdTokenVerifier`) to throw `FirebaseUnavailableError` and prove the controller and
   client keep a valid session. Do **not** change a host firewall, DNS, proxy or network adapter to
   simulate a Google outage: those changes are system-wide, can break the owner's other work, and are
   not isolated to the API process. If a real transport test is required, use a dedicated disposable
   environment with process-scoped egress control and no production credentials; if that environment
   is unavailable, record transport failure as **unproven** rather than altering this machine.
8. **Recovery** — restore the valid drill credential, restart only the local API, and prove:
   - a new exchange succeeds;
   - an existing valid Inventory session still works;
   - no production process, database or secret was used.

Do not simulate an outage by changing production DNS, Render settings, the production Firebase
project, or the real service-account key.

## 3. Recovery procedures

### 3.1 Firebase/Google is transiently unavailable

1. Confirm the scope: Firebase Status Dashboard, Google Cloud status, and whether other Google
   services are affected.
2. Do **not** rotate a credential or change the auth path merely because requests are failing.
3. Confirm the API is returning 503 `FIREBASE_UNAVAILABLE` and that the mobile client keeps a valid
   session. New sign-ins may wait; existing sessions continue until their normal expiry.
4. Record the start/end time, affected routes, error code, request IDs and user impact.
5. When Google recovers, retry a test exchange and a renewal; close the incident only after both
   succeed.
6. If the outage is prolonged, communicate honestly: new sign-in is unavailable; existing sessions
   are preserved; no password fallback is enabled. No paid plan is required to wait out an outage.

### 3.2 The service-account key is rejected or compromised

Follow [`FIREBASE_CREDENTIAL_RUNBOOK.md`](FIREBASE_CREDENTIAL_RUNBOOK.md), in this order:

1. Create a new key in the **correct** project; do not delete the old one yet.
2. Put the new JSON in the local ignored environment and run `npm run verify:firebase` until
   `VERIFIED`.
3. Update the deployment environment only with separate approval; the free Render plan has no
   pre-deploy hook, so local verification is the gate.
4. Sign in once, confirm a new session row, then delete the old key.
5. Delete local `.env` backups after verification.
6. Record the key id (not the key) and the verification result.

If the old key is compromised, containment (disable/delete it) may need to precede the normal
overlap; record that deviation and accept a short sign-in outage rather than leaving a live stolen key.

### 3.3 The Firebase project is inaccessible or deleted

1. Distinguish **owner access loss** from **project deletion**. Project deletion is not immediate
   permanence: a project owner can restore a deleted project from the Google Cloud console during a
   **30-day recovery window**. After that window the project and its resources are permanently
   deleted and cannot be recovered. The billing association is not automatically reinstated, and some
   resources may be deleted sooner than the project itself. A restore is not a backup: see
   [Google Cloud project deletion](https://cloud.google.com/resource-manager/docs/delete-restore-projects)
   and [Firebase project deletion](https://support.google.com/firebase/answer/9137886).
2. For owner-access loss, use the documented Google account recovery path and the owner's offline
   recovery codes. Do not create a replacement project as an emergency identity provider.
3. If the project still exists but the owner cannot reach it, restore Google account access first;
   then verify project IAM and the Admin key.
4. If the project is deleted, a project owner should attempt the Google Cloud **Restore** action within
   30 days. If the window has passed, there is no Inventory AI-side recovery of Firebase identities.
   The application data may remain, but users cannot authenticate through Firebase. Record this as a
   platform-level loss and do not silently re-create accounts or bypass the identity boundary.
5. A separate free drill project is for testing only; it is not a hot standby and must never be
   presented as one. Project recovery is a provider action, not a tested Inventory AI backup.

### 3.4 The owner's Google account is unavailable

- Use the existing 2-Step Verification recovery path and offline backup codes.
- The named backup, **Cucumber**, must be able to open the incident record without the owner's
  device; that person is **not** given the owner's password or recovery codes. The contact test is
  still pending, so this recovery path is not yet proven.
- GitHub/Render access recovery is separate from Google/Firebase access. Do not merge the recovery
  paths or create a second owner to work around a temporary lockout.

## 4. Evidence to collect

Evidence is text and metadata; never collect a token, private key, password, TOTP code, recovery code
or full request body.

| Evidence | Where to record |
| --- | --- |
| Date, operator, environment and git commit | Drill record / GitHub issue |
| Firebase project id **only** (no key) | Drill record |
| Scenario, expected class, observed HTTP status and application code | Test matrix |
| Server log line with `reason` allowlist value, no token/identity | Redacted excerpt |
| Request id and timestamps | Drill record |
| Whether an existing Inventory session survived | Pass/fail, with route and result |
| Whether a new exchange succeeded after recovery | Pass/fail, with redacted response status |
| Credential verification result (`VERIFIED`/`FAILED`) | Drill record, key id only |
| Any production contact | Must be “none”; if not, stop and escalate |

The evidence should let a reviewer answer: *did a transient failure stay transient, did a terminal
credential stay terminal, and did recovery restore the real path without touching production?*

## 5. Stop conditions

Stop immediately and do not “finish the test” if any of these occur:

- The drill points at `inventoryai-d0d20`, `inventoryai_prod_db`, the Render service or a customer
  account.
- A real user's token, password, recovery code or personal data appears in a command, log or issue.
- A service-account private key is printed, pasted into chat, or written outside the ignored local
  environment.
- The drill requires a paid Firebase tier, paid Render plan, paid support or a new domain.
- The isolated project cannot be distinguished from production.
- A key/project deletion would remove the only rollback path.
- The drill proposes a host-wide firewall, DNS, proxy or network-adapter change; use the verifier seam
  or a dedicated process-scoped environment instead.
- The local API starts with production `MONGODB_URI` or production `FIREBASE_*` values.
- Evidence cannot be captured without exposing a credential.
- Recovery fails twice for the same reason and the cause is not understood.

A stopped drill is a successful safety outcome. Record why it stopped.

## 6. Acceptance tests

| # | Test | Expected evidence |
| --- | --- | --- |
| FB-D1 | Health endpoint is green while Firebase is unconfigured | `/api/health` 200; no claim that Firebase works |
| FB-D2 | Missing service account | 503 `FIREBASE_NOT_CONFIGURED`; startup succeeds |
| FB-D3 | Malformed service account | 503 `FIREBASE_NOT_CONFIGURED`; no key in response/log |
| FB-D4 | Revoked drill key, after local restart | 503 `FIREBASE_NOT_CONFIGURED`/`FIREBASE_UNAVAILABLE` as observed; no 500; no delayed-success misreading |
| FB-D5 | Disabled drill user | terminal `FIREBASE_TOKEN_INVALID`; unrelated session unaffected |
| FB-D6 | Deleted drill user | terminal `FIREBASE_TOKEN_INVALID`; no 500 |
| FB-D7 | Expired/revoked drill ID token | terminal `FIREBASE_TOKEN_INVALID`; no session damage |
| FB-D8 | Controlled transient failure (verifier seam, or isolated process-scoped transport) | 503 `FIREBASE_UNAVAILABLE`; existing session preserved; no host-wide network change |
| FB-D9 | Client sees `FIREBASE_UNAVAILABLE` | no sign-out; retry message; session retained |
| FB-D10 | Restore valid drill credential | new exchange 200; existing session still valid |
| FB-D11 | Re-run normal sign-in | session row created in the **test** database only |
| FB-D12 | Secret scan of evidence | no token/key/password/recovery code |
| FB-D13 | Production check after drill | production commit/health unchanged; no production request made by the drill |
| FB-D14 | Tabletop decisions | backup acknowledges; both-contact test is recorded; project-recovery owner and 30-day restore limit understood |

## 7. Rollback and cleanup

- Restore the local environment's previous Firebase test credential, or remove it if it was created
  only for the drill.
- Delete the drill project's disposable users and the extra test key; keep exactly one live key in the
  drill project until deletion.
- Stop the local API; delete the disposable test database only after evidence is captured.
- Remove temporary firewall/proxy rules.
- Delete any local credential backup created for the drill after verification.
- Keep the drill record and redacted evidence; do not keep live credentials.
- Confirm production `/api/health` and serving commit are unchanged.

## 8. What this plan does not authorize

- No production Firebase setting, user, key, project or IAM change.
- No Render, Atlas, Cloudflare or domain change.
- No application code or test change.
- No paid Firebase/Render/support plan.
- No claim that recovery has been proven until the drill is executed and evidence is recorded.

## 9. Related

- [`FIREBASE_CREDENTIAL_RUNBOOK.md`](FIREBASE_CREDENTIAL_RUNBOOK.md) — credential creation, verification,
  rotation and failure reading.
- [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) — owner account and provider recovery
  anchors.
- [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) — primary/backup accountability.
- [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md)
  — transient-vs-terminal rules and session contract.
