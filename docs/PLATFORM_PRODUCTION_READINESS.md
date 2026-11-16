# Platform Operations — production readiness

**Status:** **NOT READY TO EXPOSE.** The implementation is committed and locally verified, but the
gate is not closed until every **P0** item in
[`PLATFORM_SECURITY_RECOMMENDATIONS.md`](PLATFORM_SECURITY_RECOMMENDATIONS.md) and every **OPEN**
item below has an owner and evidence.

**Reviewed:** 2026-11-16
**Scope:** the INTERNAL `/api/platform` plane and `server/platform-console/`. This does not authorize
a tenant feature, a public console, or a deployment. Nothing here has been pushed or deployed.

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
- The CI workflow now has a dedicated `webauthn-e2e` job. Its first GitHub run has **not** been
  observed because this work was not pushed.

## 2. Go/no-go checklist

| ID | Requirement | Status | Evidence or action |
| --- | --- | --- | --- |
| PR-01 | API and console are served only over HTTPS, on the intended hostnames, with a valid certificate and an HTTP-to-HTTPS redirect. | **OPEN** | The console server does not enforce HTTPS itself. Terminate TLS at a reviewed reverse proxy and block plain HTTP before the listener. |
| PR-02 | `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_API_ORIGIN`, `PLATFORM_WEBAUTHN_ORIGIN` and `PLATFORM_WEBAUTHN_RP_ID` are exact, explicit production values. | **PARTIAL** | Production validation now requires `PLATFORM_CONSOLE_ORIGIN` when the platform secret is set, and both the validator and runtime reject a WebAuthn origin with a path, query, fragment or userinfo. The four values still need a deployment review and proof on the real origin. |
| PR-03 | The console is not publicly reachable without an additional access layer (VPN, identity-aware proxy, IP allowlist or equivalent). | **OPEN** | The listener binds `127.0.0.1` by default but can be changed with `PLATFORM_CONSOLE_HOST`. Put it behind an authenticated proxy; do not expose port 4100 directly. |
| PR-04 | Platform credentials are stored in the deployment's secret store, are distinct from every tenant secret, and have a documented rotation and recovery procedure. | **OPEN** | `PLATFORM_ADMIN_JWT_SECRET` and `PLATFORM_MFA_ENCRYPTION_KEY` are separate; rotation currently means updating the environment and restarting. There is no console-driven rotation. |
| PR-05 | The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and Path `/api/platform`; the CSRF cookie is readable but not a credential by itself; CORS grants credentials only to exact origins. | **READY** in code | `PLAT3` cookie/CORS checks pass. `Secure` is set in production, for any HTTPS console origin, and for an unknown `NODE_ENV`; only an explicit development/test environment on loopback HTTP may omit it. Verify the actual `Set-Cookie` headers on the production origin before exposing. |
| PR-06 | Both TOTP and WebAuthn are exercised in a real browser, and recovery codes, a second security key and a break-glass procedure exist. | **PARTIAL** | Browser E2E passes. One-time recovery codes are implemented and tested, and multiple security keys can be enrolled. The break-glass runbook and a mandatory first-login code-generation step are still required before exposure. |
| PR-07 | Named administrators, least-privilege roles, password change, disable/delete, WebAuthn-key removal and offboarding are available and audited. | **READY** in code | PLAT-5 adds a password-change route, SUPERADMIN list/disable/enable/delete, and WebAuthn-key removal, all audited and covered by PLAT4. Creation remains CLI-only by design; role changes remain a deployment/CLI operation. |
| PR-08 | Login, MFA and challenge endpoints have account-scoped and IP-scoped attempt budgets; a failed MFA challenge has a bounded number of attempts. | **READY** in code | `/auth/login` has the account and IP login limiters. Every TOTP, WebAuthn and recovery-code failure now spends a durable account-scoped budget; five failures in 15 minutes lock MFA for 15 minutes, independent of the caller's IP. PLAT4 proves that the fifth TOTP failure, and separately the fifth WebAuthn failure, lock the account and the next attempt is refused with `429 PLATFORM_MFA_RATE_LIMITED`. |
| PR-09 | Audit retention is an owner decision; the audit trail is exported or backed up, and the application's database role cannot drop or rewrite it. | **OPEN** | The Mongoose model refuses mutations, but raw database access can alter rows. There is no TTL and no automatic export. Grant a least-privilege database role and record the retention period. |
| PR-10 | The console exposes only the approved aggregate data and no tenant-detail or member-identifying read. | **READY** for the current surface | The operations report is cross-tenant aggregate with no tenant selector or PII. Do not add member names, emails or tenant detail without the support-grant gate. |
| PR-11 | A time-bounded, reason-bound, approved support grant exists before any tenant-detail read. | **BLOCKED** | Gate E in the platform architecture is not implemented. This is a prerequisite for support use, not for the current aggregate report. |
| PR-12 | The browser WebAuthn proof runs in CI, and the full server suite, CORS checks, docs guards and type/lint checks pass on the event being exposed. | **PARTIAL** | The `webauthn-e2e` job is in `.github/workflows/ci.yml` but is not yet a branch-protection-required check; observe its first green GitHub run and add it to the required set. The local focused suites and E2E pass, and the full server suite is **3,135 passed / 0 failed / 0 skipped / 501 suites** after the lifecycle additions. The CI job itself is still unobserved and not a required check. |
| PR-13 | Health checks, platform login/MFA/denial alerts, an incident runbook and a tested rollback exist. | **OPEN** | The API has the standard health endpoints and the audit trail records denials. There is no platform-specific pager or dashboard, and no tested console rollback. |
| PR-14 | A deployment sequence proves the actual production origin, cookie flags, CORS preflight, sign-in, audit read and sign-out before announcing availability. | **OPEN** | Use §4 below. A local `curl` or a successful build is not this proof. |
| PR-15 | The owner and a security reviewer sign off with names, date and accepted residual risks. | **OPEN** | Record the sign-off in §5. |

## 3. Blocking findings

These are the items that must be closed, or explicitly accepted in writing by the owner, before the
console is reachable by anyone outside the operator's machine.

1. **Recovery is available but not yet mandatory or rehearsed.** A new administrator must generate
   recovery codes from the Security page; there is no forced first-login generation or documented
   break-glass drill. Add both before exposure.
2. **The deployment boundary is still partly documentation-led.** Non-loopback origins and cookie
   flags now fail closed, but HTTPS termination, network isolation and the console listener's public
   reachability are reverse-proxy responsibilities. Prove them at the actual deployment boundary.
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
```

The console and API must be same-site for the `SameSite=Strict` session cookie. A console on an
unrelated registrable domain will not receive the API cookie even though CORS permits the origin.
If they are on different same-site hosts, verify the CSRF bootstrap after a reload.

### 4.2 Expose only through the reviewed edge

- Put the console behind the approved VPN, identity-aware proxy or IP allowlist.
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
| `npm run test:webauthn-e2e` | pass, including fail-closed cleanup; a `CI=true` run also passes after a harness race fix |
| Full server suite | **not rerun after the latest review edits**; the last pre-review run was 3,121/3,121 |
| CI `webauthn-e2e` job | added but **not observed on GitHub**; no push was made |

The browser test uses headless Chrome/Edge and fixed configurable ports (API 4400, console 4100,
CDP 9333). If CI cannot launch a browser, run `cd server && npm run test:webauthn-e2e` on a machine
with Chrome and record the output; do not substitute a unit test for the browser proof.

The checklist is a gate, not a deployment authorization. This repository has not been pushed or
deployed.
