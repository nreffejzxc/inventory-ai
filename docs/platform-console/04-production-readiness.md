# Platform Operations — production readiness

**Status:** **LIVE, INTERNAL RELEASE — GATES REMAIN OPEN.** The console is served at
`https://ai-inventory-l1mi.onrender.com/platform` under the separate platform administrator login.
The console delivery was deployed at `e7ce455`; the last full authenticated proof was on `74e4b87`, and public production health reported `f95b5e4` on 2026-11-19. PLAT-7's forced recovery-code ceremony,
the application-level outer access gate and the break-glass reset remain in place. The production
service supplies `PLATFORM_ACCESS_KEY`;
the administrator generated 10 recovery codes from zero and 9 remain after the production recovery
drill. The forced browser ceremony itself is exercised locally by the PLAT7 browser E2E. Network isolation (PR-03), audit retention/database least privilege (PR-09) and
named security review (PR-15) remain open or residual. The owner requested production availability;
the residual exposure is recorded here rather than treated as closed.

**Reviewed:** 2026-11-19 (public health/gate recheck; the authenticated evidence below remains dated 2026-11-17/18)
**Scope:** the INTERNAL `/api/platform` plane and `server/platform-console/`, including the
same-origin `/platform` shell and the PLAT-6 operations surface. This does not authorize a tenant
feature or tenant-detail reads. The production deployment is the API service's own origin; the
outer access gate and platform login are the current controls, and PR-03 network isolation is still
open.

**Legend**

| Status | Meaning |
| --- | --- |
| **READY** | The repository contains the control and the cited check passed. Deployment still needs the operator action in the same row. |
| **PARTIAL** | A control exists but a named gap remains. |
| **OPEN** | Not implemented or not proven; do not expose until closed or explicitly accepted by the owner. |
| **BLOCKED** | Needs an owner decision, an external identity project, or another prerequisite outside this repository. |

---

## 1. What the review has already established

- The platform plane is a separate identity realm: `platform_admins` has no `businessId` or tenant
  role; its JWT secret, issuer and audience are separate from the tenant plane.
- Platform login is password plus mandatory TOTP or an enrolled WebAuthn key. A password alone
  returns only a challenge.
- The console uses an HttpOnly `platform_session` cookie, a readable `platform_csrf` cookie and a
  matching `X-Platform-CSRF` header; cookie requests also require the exact console Origin.
- The audit collection has application-level append-only guards and no TTL.
- The four original platform commits are `d02a549`, `ff80b12`, `af6e3dd` and `75d7c35`. The fresh
  review is `40f2758`; it removes dead helpers, gates the console CORS origin on a configured
  platform plane, requires an explicit production console origin and makes the browser E2E cleanup
  fail closed.
- The browser E2E passes locally: TOTP enrollment, WebAuthn registration, WebAuthn sign-in, replay
  refusal and tampered-assertion refusal, with zero leftover administrator, session or audit rows.
- PLAT-5 adds one-time recovery codes (hashed, single-use, generated only after re-entering the
  current password), a durable account-scoped five-failure MFA lock shared across IPs, self-service
  password change with full session revocation, and SUPERADMIN disable/delete/key-removal lifecycle
  operations with self and last-SUPERADMIN protections.
- Non-loopback console and WebAuthn origins must be bare HTTPS origins; a missing `NODE_ENV` no
  longer downgrades the session cookie to non-Secure.
- The CI workflow has a dedicated `webauthn-e2e` job. On PR #315, run `43946639285` completed
  every job green: `webauthn-e2e` in 48 s, `server` in 3 m 5 s, `mobile`, `attribution-guard` and
  `secret-guard`.
- PLAT-6 adds the operator surface behind the existing platform boundary: a health-only status
  route, an expanded operations report (AI model/outcome/token breakdowns, support/inventory/security
  aggregates), boot-observed deployment history, support ticket workflow/notes, and same-origin
  `/platform` assets with a strict CSP. No tenant-detail read was added. All new routes remain behind
  platform authentication and a platform capability; support tickets contain no tenant id or member
  data.
- PLAT-6 also fixes the same-origin browser case: a same-origin GET omits `Origin`, so the API now
  accepts it only with `X-Platform-Console: 1` and `Sec-Fetch-Site: same-origin`, while every other
  cookie request still requires the exact configured Origin and every request still requires the
  CSRF header.
- PLAT-7 makes recovery setup mandatory: a signed-in administrator with no unused recovery codes is
  restricted by the server to `/auth/me`, `/auth/csrf`, `/auth/recovery-codes` and `/auth/logout`;
  every other route answers `403 PLATFORM_RECOVERY_SETUP_REQUIRED`. The console shows the forced
  ceremony and requires a saved-code acknowledgement. A guarded `platform-admin:break-glass`
  command resets a totally locked-out administrator, clears every factor and session, and writes an
  `ADMIN_BREAK_GLASS_RESET` audit event. Render's free plan cannot attach an inbound IP allowlist;
  `PLATFORM_ACCESS_KEY` is the available free application-level gate, required by production
  validation, in front of `/platform` and `/api/platform` (Basic for the browser,
  `X-Platform-Access-Key` beside a Bearer token for API clients).
- PLAT-7's controls were proven at `e218bb0` and remain deployed within `e7ce455`. Anonymous `/platform/` and `/api/platform/status` return 401
  `PLATFORM_ACCESS_REQUIRED` with a Basic challenge and `no-store`; Basic returns the shell as 200
  HTML with the strict CSP; a wrong key returns the same 401, and the correct key without a platform
  session returns 401 `PLATFORM_AUTH_REQUIRED`. A real browser completed password + TOTP, rendered
  the dashboard's 16 sections and signed out with no console errors. The API smoke observed the
  production cookie flags, status/operations/deployments/tickets/audit reads, a foreign-Origin
  refusal (403   `PLATFORM_CSRF_ORIGIN`) and a 401 after logout. The administrator generated 10 recovery codes
  from zero; a separate recovery-code login returned 200 with 9 remaining, then logout 200 and old
  cookie 401.

## 2. Go/no-go checklist

| ID | Requirement | Status | Evidence or action |
| --- | --- | --- | --- |
| PR-01 | API and console are served only over HTTPS, on the intended hostnames, with a valid certificate and an HTTP-to-HTTPS redirect. | **READY (managed edge)** | The Render edge terminates TLS with HSTS and redirects `http://ai-inventory-l1mi.onrender.com/platform/` to `https://` with a 301. The listener itself still relies on the managed edge; do not expose port 4100 directly. |
| PR-02 | `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_API_ORIGIN`, `PLATFORM_WEBAUTHN_ORIGIN` and `PLATFORM_WEBAUTHN_RP_ID` are exact, explicit production values. | **READY** | The four exact production values are set on the Render service; the production preflight reflected the exact console origin, and the browser same-origin login/MFA flow succeeded. The WebAuthn login origin was not exercised against a hardware key on production. |
| PR-03 | The console is not publicly reachable without an additional access layer (VPN, identity-aware proxy, IP allowlist or equivalent). | **PARTIAL** | Render's free plan cannot attach inbound IP rules (a Scale/Enterprise feature). PLAT-7 adds a mandatory application-level Basic gate (`PLATFORM_ACCESS_KEY`) in front of `/platform` and `/api/platform`, but the URL is still internet-reachable and the gate is shared-secret protection, not network isolation. A paid edge/IP layer or an identity-aware proxy remains the stronger future control. |
| PR-04 | Platform credentials are stored in the deployment's secret store, are distinct from every tenant secret, and have a documented rotation and recovery procedure. | **OPEN** | `PLATFORM_ADMIN_JWT_SECRET` and `PLATFORM_MFA_ENCRYPTION_KEY` are separate; rotation currently means updating the environment and restarting. There is no console-driven rotation. |
| PR-05 | The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and Path `/api/platform`; the CSRF cookie is readable but not a credential by itself; CORS grants credentials only to exact origins. | **READY** | `PLAT3` cookie/CORS checks pass, and the production `Set-Cookie` headers were observed with those exact flags. The preflight returns the exact console origin, credentials enabled, and the allowed
`X-Platform-CSRF`/`X-Platform-Console`/`X-Platform-Step-Up` headers. |
| PR-06 | Both TOTP and WebAuthn are exercised in a real browser, and recovery codes, a second security key and a break-glass procedure exist. | **READY** | PLAT-7 makes the first-login recovery-code ceremony mandatory and server-enforced. `PLAT7` proves the forced denial, generation, recovery-code login and replay refusal; the guarded break-glass service/CLI was exercised against a disposable test administrator (old password false, new password true, every factor cleared, zero sessions). The browser E2E completes TOTP, the later sign-in and WebAuthn; enrolling a second hardware key remains an operator step, not an automated proof. |
| PR-07 | Named administrators, least-privilege roles, password change, disable/delete, WebAuthn-key removal and offboarding are available and audited. | **READY** in code | PLAT-5 adds a password-change route, SUPERADMIN list/disable/enable/delete, and WebAuthn-key removal, all audited and covered by PLAT4. Creation remains CLI-only by design; role changes remain a deployment/CLI operation. |
| PR-08 | Login, MFA and challenge endpoints have account-scoped and IP-scoped attempt budgets; a failed MFA challenge has a bounded number of attempts. | **READY** in code | `/auth/login` has the account and IP login limiters. Every TOTP, WebAuthn and recovery-code failure now spends a durable account-scoped budget; five failures in 15 minutes lock MFA for 15 minutes, independent of the caller's IP. PLAT4 proves that the fifth TOTP failure, and separately the fifth WebAuthn failure, lock the account and the next attempt is refused with `429 PLATFORM_MFA_RATE_LIMITED`. |
| PR-09 | Audit retention is an owner decision; the audit trail is exported or backed up, and the application's database role cannot drop or rewrite it. | **OPEN** | The Mongoose model refuses mutations, but raw database access can alter rows. There is no TTL and no automatic export. Grant a least-privilege database role and record the retention period. |
| PR-10 | The console exposes only the approved aggregate data and no tenant-detail or member-identifying read. | **READY** for the current surface | The operations report is cross-tenant aggregate with no tenant selector or PII. Do not add member names, emails or tenant detail without the support-grant gate. |
| PR-11 | A time-bounded, reason-bound, approved support grant exists before any tenant-detail read. | **BLOCKED** | Gate E in the platform architecture is not implemented. This is a prerequisite for support use, not for the current aggregate report. |
| PR-12 | The browser WebAuthn proof runs in CI, and the full server suite, CORS checks, docs guards and type/lint checks pass on the event being exposed. | **READY** | CI run `43961123024` passed all five jobs on PR #317: `server` in 2 m 56 s (**3,146 tests / 505 suites, 0 failed, 0 skipped**), `webauthn-e2e` in 50 s, `mobile`, `attribution-guard` and `secret-guard`. `main` now requires all five contexts, with strict and enforce-admins. A temporary negative PR (#319) with a deliberately failing `webauthn-e2e` and passing `server`/`mobile`/guards returned `mergeStateStatus: BLOCKED`, and the merge attempt was refused; it was closed without merging. |
| PR-13 | Health checks, platform login/MFA/denial alerts, an incident runbook and a tested rollback exist. | **OPEN** | The API has the standard health endpoints and the audit trail records denials. There is no platform-specific pager or dashboard, and no tested console rollback. |
| PR-14 | A deployment sequence proves the actual production origin, cookie flags, CORS preflight, sign-in, audit read and sign-out before announcing availability. | **READY** | The sequence was observed at `e218bb0`: outer-gate 401/challenge, Basic shell 200, password challenge, TOTP completion in Chrome, `Set-Cookie` flags, authenticated status/operations/deployments/tickets/audit, recovery-code generation (0 → 10), recovery-code login, foreign-Origin refusal, sign-out and a 401 on the old cookie. A second named reviewer and edge isolation remain under PR-03/PR-15. |
| PR-15 | The owner and a security reviewer sign off with names, date and accepted residual risks. | **OPEN** | Record the sign-off in §5. |

## 3. Blocking findings

These are the items that must be closed, or explicitly accepted in writing by the owner, before the
console is reachable by anyone outside the operator's machine.

1. **Recovery is now mandatory and exercised.** PLAT-7 forces recovery-code generation on first
   login, restricts every other route until it is complete, and ships a tested break-glass reset.
   The production operator must complete the ceremony once after deployment and store the codes
   offline; losing them still leaves the guarded operator CLI as the last resort.
2. **The deployment boundary is still partly documentation-led.** The application-level Basic gate
   is not an edge allowlist. HTTPS termination, network isolation and the console listener's public
   reachability remain reverse-proxy/hosting responsibilities. Prove them at the actual deployment
   boundary; a free Render service cannot attach inbound IP rules.
3. **Audit retention and database least privilege remain open.** The model is append-only, but raw
   database access can still rewrite or drop the collection; there is no TTL decision or export.
4. **Support grants remain blocked.** No tenant-detail read may be added until Gate E exists. Do
   not treat the aggregate report as permission to read tenant data.
5. **The external identity project is still a future gate.** The interim local password realm is
   isolated and tested, but it is not the approved long-term identity boundary.

## 4. Required deployment sequence

Run each step and record the observed result; a step that cannot be observed is not complete.

### 4.1 Preflight configuration

Use placeholders only; the values come from the deployment's secret store.

```text
NODE_ENV=production
PLATFORM_ADMIN_JWT_SECRET=<separate platform signing secret>
PLATFORM_MFA_ENCRYPTION_KEY=<separate MFA key>
PLATFORM_CONSOLE_ORIGIN=https://<console-host>
PLATFORM_API_ORIGIN=https://<api-host>
PLATFORM_WEBAUTHN_ORIGIN=https://<console-host>
PLATFORM_WEBAUTHN_RP_ID=<console-host without scheme or port>
PLATFORM_CONSOLE_HOST=127.0.0.1
PLATFORM_CONSOLE_PORT=4100
PLATFORM_ACCESS_KEY=<long random shared outer-door key>
PLATFORM_ACCESS_USER=platform
```

The console and API must be same-site for the `SameSite=Strict` session cookie. A console on an
unrelated registrable domain will not receive the API cookie even though CORS permits the origin.
If they are on different same-site hosts, verify the CSRF bootstrap after a reload.

### 4.2 Expose only through the reviewed edge

- Set `PLATFORM_ACCESS_KEY` before deploying; production validation refuses a configured platform
  plane without it. The browser asks for the Basic credential before the platform login, and API
  clients send `X-Platform-Access-Key` beside their Bearer token.
- Put the console behind the approved VPN, identity-aware proxy or IP allowlist when the hosting
  plan supports one. On Render's free plan the application-level gate is the available layer, not
  network isolation.
- Terminate TLS at the edge, redirect HTTP to HTTPS, and do not publish the console listener port.
- Keep the API's CORS allow-list exact; the platform console origin is added only when
  `PLATFORM_ADMIN_JWT_SECRET` is configured.
- Add HSTS at the edge only after the HTTPS origin is proven.

### 4.3 Smoke proof

1. `GET /api/health` and `GET /api/health/ready` return the expected production posture.
2. An `OPTIONS` preflight from the exact console origin returns that origin and reflects the
   requested `X-Platform-CSRF` / `X-Platform-Console` headers.
3. A password-only login returns a challenge and **no** session.
4. TOTP and WebAuthn each complete a real browser login; inspect the `Set-Cookie` flags.
5. A replay of the successful assertion is refused; a tampered assertion is refused and `/auth/me`
   has no session.
6. A cookie request from a foreign Origin, or without the CSRF header, is refused.
7. The audit read requires SECURITY/SUPERADMIN; a lower role is refused and the refusal is audited.
8. The console signs out; the old cookie is no longer accepted.
9. The test administrator and any test rows are removed; verify zero leftovers.

### 4.4 Rollback

There is no admin self-service disable yet. The safe rollback is: stop the console listener, remove
its edge route, rotate `PLATFORM_ADMIN_JWT_SECRET` (which invalidates every platform access token),
and keep the audit rows for investigation. Do not delete the audit collection as a rollback step.

### 4.5 Same-origin PLAT-6 production smoke

Run against the deployed `https://ai-inventory-l1mi.onrender.com` origin. Record the observed
commit, status codes and the platform route responses; never paste a cookie, CSRF value, password,
TOTP code or recovery code.

1. `GET /api/health` and `GET /api/health/ready` return `200`, production posture and the deployed
   commit.
2. `GET /platform/` without the access credential returns `401` with a Basic challenge and
   `PLATFORM_ACCESS_REQUIRED`; with the credential it returns `200` HTML with `connect-src 'self'`,
   `frame-ancestors 'none'` and `Cache-Control: no-store`. `GET /platform/app.js`,
   `/platform/config.js` and `/platform/styles.css` return `200` with the expected content types
   when the credential is supplied.
3. `POST /api/platform/auth/login` with a password returns an MFA challenge, not a session. A fresh
   administrator gets `mfaEnrollmentRequired: true`; an enrolled one gets `mfaRequired: true`.
4. A completed TOTP enrollment or verification sets `platform_session` (HttpOnly, Secure,
   SameSite=Strict, Path `/api/platform`) and `platform_csrf` (readable, Secure).
5. Authenticated `GET /api/platform/status`, `/operations`, `/deployments`, `/tickets` and `/audit`
   return `200` for a SUPERADMIN after recovery setup is complete. Before generating recovery codes,
   the same reads return `403 PLATFORM_RECOVERY_SETUP_REQUIRED`; generating codes in the forced
   console view unlocks them. A ticket create/read/note test removes or leaves only explicitly
   labelled internal data; no tenant row is touched.
6. A cookie request with a foreign or missing Origin is refused; a same-origin GET without Origin
   is accepted only with `X-Platform-Console: 1`, `Sec-Fetch-Site: same-origin` and the CSRF header.
7. Sign out clears both cookies. Any test administrator created for the smoke is removed after the
   test; the bootstrap administrator remains. Save the bootstrap administrator's recovery codes in
   the owner-controlled offline location; never put them in the repository or a chat.
8. Bearer API clients supply `X-Platform-Access-Key`; a request with neither Basic nor that header
   returns `401 PLATFORM_ACCESS_REQUIRED` before platform authentication is reached.

**Observed 2026-11-17 at `e218bb0`:** health 200 (`production`, `db: connected`); anonymous
`/platform/` and `/api/platform/status` 401 `PLATFORM_ACCESS_REQUIRED` with a Basic challenge and
`no-store`; Basic shell 200 with the strict CSP; wrong key 401; correct key without a session 401
`PLATFORM_AUTH_REQUIRED`; password + TOTP login 200; status/operations/deployments/tickets/audit
200; recovery-code generation 10; recovery-code login 200 with 9 remaining; foreign Origin 403;
logout 200; old cookie 401. A separate real-browser run completed the same login in Chrome, showed
the dashboard's 16 sections, and signed out with no console errors. No tenant row was read or written.

## 5. Sign-off

| Role | Name | Date | Accepted residual risks / notes |
| --- | --- | --- | --- |
| Owner |  |  |  |
| Security reviewer |  |  |  |

## 6. Verification evidence and limitations

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (review changes) | pass |
| ESLint on changed files | pass |
| `PLAT2-platform-console.test.mjs` | **9/9** |
| `PLAT3-platform-security.test.mjs` | **12/12** |
| `phase07c-http-security.test.mjs` | **17/17** |
| `npm run test:webauthn-e2e` | pass locally, including fail-closed cleanup; CI run `43946639285` passed in 48 s |
| Full server suite | CI run `43961123024`: **3,146 tests / 505 suites, 3,146 passed, 0 failed, 0 skipped, 0 todo** (118 s) |
| CI jobs | run `43961123024`: `server`, `mobile`, `webauthn-e2e`, `attribution-guard` and `secret-guard` all pass |
| Production smoke | `e218bb0`; outer-gate 401/challenge, Basic shell 200, wrong key 401, valid key without session 401; browser password + TOTP + 16-section dashboard + sign-out; recovery-code generation 10; recovery-code login with 9 remaining; status/operations/deployments/tickets, cookie flags, foreign-Origin 403, logout 200, old cookie 401 |

The browser test uses headless Chrome/Edge and fixed configurable ports (API 4400, console 4100,
CDP 9333). If CI cannot launch a browser, run `cd server && npm run test:webauthn-e2e` on a machine
with Chrome and record the output; do not substitute a unit test for the browser proof.

The checklist is a gate, not a deployment authorization. The console is deployed and public health
reported `f95b5e4` on 2026-11-19; the last full authenticated proof was `74e4b87`. The owner's
production-availability decision stands and the open gates above remain open.
