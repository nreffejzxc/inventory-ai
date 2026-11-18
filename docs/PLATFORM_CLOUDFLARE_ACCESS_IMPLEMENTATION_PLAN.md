# Platform Access — Cloudflare Access implementation plan

**Status:** **PLANNING ONLY. NO PRODUCTION CHANGE IS AUTHORIZED BY THIS DOCUMENT.** No Cloudflare
account, domain, DNS record, Render custom domain, code path, environment variable, deployment or
WebAuthn migration was performed. The live console remains on `e218bb0` behind the current Basic/key
gate and platform login.

**Reviewed:** 2026-11-17
**Scope:** The `/platform` console and `/api/platform` plane.
**Decision:** Cloudflare Access is the preferred pilot, but only when a controlled domain and origin
JWT validation are available. Without origin validation, the public `onrender.com` URL bypasses the
edge and the migration would add complexity without adding a boundary.

**Parent assessment:** [05 — Access layer](./platform-console/05-access-layer.md).

## 0. Budget gate — no new spend

This plan is **conditional on an already-owned controlled domain**. Inventory AI has no paying users
and the owner's budget is committed to existing tools and living costs. Therefore:

- Do **not** purchase a domain, Cloudflare paid plan, paid log retention, service token plan, Render
  upgrade, certificate or monitoring add-on for this migration.
- The Cloudflare Access free tier (up to 50 users) and the existing Render service are the only
  approved cost basis.
- If no controlled domain already exists, the migration is **deferred**. Keep the current free
  Basic/key gate, platform MFA, recovery codes and console audit.
- A free subdomain without full DNS/NS control is not an acceptable administrator-security origin.
- The implementation plan may be reviewed and prepared now, but no gate below is satisfied by this
  document.

## 1. Why this plan exists

The current outer gate is a shared secret. Cloudflare Access can add a named identity, a deny-by-default
policy and an independent edge log before the application login. The migration is not a DNS-only
change:

- Access protects a **hostname**, not the Render origin.
- The browser origin, API origin, cookies, CORS and WebAuthn RP ID all change when the hostname changes.
- Existing WebAuthn credentials are bound to the old RP ID and will not authenticate on a new one.
- A mistake can lock out the only administrator.

This plan makes the prerequisites, cutover order, rollback and stop conditions explicit before any
work is approved.

## 2. Current state and assumptions

| Item | Current state | Implication |
| --- | --- | --- |
| Public URL | `https://ai-inventory-l1mi.onrender.com/platform` | The Render URL remains publicly reachable even if a custom hostname is added. |
| Outer gate | Basic for the browser; `X-Platform-Access-Key` beside a Bearer token for API clients | Keep it during migration; Access is an additional layer. |
| Platform login | Password + mandatory TOTP or enrolled WebAuthn; HttpOnly session; CSRF; short idle/absolute session | Access does not replace this login. |
| Recovery | Forced recovery-code ceremony; 9 production codes remain after the last recorded drill; break-glass CLI exists | Recovery must be verified before changing the origin. |
| WebAuthn RP | Existing credentials are bound to `ai-inventory-l1mi.onrender.com` (or the configured current RP ID) | They will not work on a new RP ID; re-enrollment is mandatory. |
| Domain | No controlled custom domain is recorded for the platform | Owner must supply or purchase one; this is a decision gate. |
| Render | Free web service; custom domains are supported; no web-service IP allowlist on the free plan | Access + origin validation is the low-cost path. |
| Logs | Access free plan has up to 24 hours of standard log retention | Not a durable investigation store; see §10. |

Assumptions for the plan:

- The owner controls the Cloudflare account and the DNS zone, with MFA on both.
- A custom hostname such as `ops.example.com` is available; **example.com is a placeholder**, not a
  purchased name.
- The console and API can remain on one custom hostname. If they are split, the cookie, CORS,
  WebAuthn and origin configuration must be designed together.
- A second trusted reviewer can be named before production cutover. If not, the owner must explicitly
  accept the single-person migration risk in writing.

## 3. Target architecture

```text
Administrator browser
        |
        | HTTPS + Cloudflare Access identity
        v
Cloudflare edge (Access application; deny by default)
        |
        | proxied CNAME to the Render custom hostname
        v
Render edge / custom hostname
        |
        | Cf-Access-Jwt-Assertion
        v
Express app
  - verify Access JWT first (platform paths only)
  - existing Basic/key gate
  - existing platform password + TOTP/WebAuthn
  - existing capability checks
        |
        v
MongoDB Atlas
```

Machine clients use a Cloudflare **service token** (`CF-Access-Client-Id` and
`CF-Access-Client-Secret`) plus the existing platform access key/Bearer token. They do not use a
human identity.

`/api/health`, `/api/health/live` and `/api/health/ready` remain public for UptimeRobot. They must not
be behind Access and must not require the Access JWT.

## 4. Prerequisites and decision gates

Every gate must be recorded before the next phase. A gate is not satisfied by a verbal approval.

| Gate | Decision or evidence | Owner | Blocks |
| --- | --- | --- | --- |
| **CF-G0 — zero spend** | No domain purchase, plan upgrade, paid log tier or paid add-on is required. If a domain must be bought, this gate fails and the migration stays deferred. | Owner | Everything |
| **CF-G1 — domain** | A controlled domain **already exists**, its registrar and DNS account are known, and the owner approves the exact hostname. Record expiry and renewal owner. | Owner | Everything |
| **CF-G2 — Cloudflare account** | Cloudflare account with MFA, recovery codes stored offline, and no shared login. Record account owner and recovery path. | Owner | Access policy |
| **CF-G3 — Render custom domain** | The exact Render service and custom hostname are recorded; the owner approves adding the custom domain. | Owner + Service Owner | DNS/certificate |
| **CF-G4 — origin validation design** | Security review approves the JWT algorithm, issuer, audience, JWKS source, clock skew and failure response. The code change is separately approved. | Security Reviewer + Service Owner | Any production enforcement |
| **CF-G5 — recovery readiness** | TOTP is enrolled, recovery codes are present offline, break-glass CLI is documented, and the owner can retrieve both. Do not remove the old WebAuthn credential yet. | Platform Owner | Cutover |
| **CF-G6 — rollback rehearsal** | The rollback is exercised in an isolated environment: old origin, old RP ID, old env values and recovery path. | Service Owner + reviewer | Production cutover |
| **CF-G7 — alerting** | Access denials and direct-origin failures have an owner and a delivery channel. See [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md). | Platform Owner | Go-live |

If any gate is missing, the decision is **NO-GO**, not an informal exception.

## 5. Configuration design

Names only; no values are recorded in this document or the repository.

### 5.1 Hostnames

Recommended: one custom hostname serves both the console shell and the platform API, for example
`https://ops.example.com`. This keeps the session cookie same-site and minimizes CORS/WebAuthn
mismatches.

If separate hostnames are required:

- `PLATFORM_CONSOLE_ORIGIN` is the browser shell origin.
- `PLATFORM_API_ORIGIN` is the exact API origin.
- `PLATFORM_WEBAUTHN_ORIGIN` is the console origin.
- `PLATFORM_WEBAUTHN_RP_ID` is the console hostname or a parent domain permitted by WebAuthn.
- The cookie/CORS matrix must be proven in a browser; a successful `curl` is not enough.

### 5.2 Existing values to change after approval

| Variable | Planned meaning | Risk |
| --- | --- | --- |
| `PLATFORM_CONSOLE_ORIGIN` | `https://<approved-console-host>` | Wrong value breaks CORS/CSRF and login |
| `PLATFORM_API_ORIGIN` | Exact API origin | Split-origin cookie/CORS failure |
| `PLATFORM_WEBAUTHN_ORIGIN` | Console origin | Existing WebAuthn credentials become unusable |
| `PLATFORM_WEBAUTHN_RP_ID` | Approved RP ID | Must be a registrable suffix of the origin; wrong value blocks all passkeys |
| `PLATFORM_WEBAUTHN_RP_NAME` | Human-readable platform name | Display only |
| `PLATFORM_ACCESS_KEY` | Keep during and after migration | Do not remove; it is defense in depth |

### 5.3 New origin-verification values (future code change)

The following are **proposed names** for the future implementation; they do not exist today:

| Proposed variable | Purpose |
| --- | --- |
| `PLATFORM_ACCESS_JWT_ISSUER` | Cloudflare Access team/issuer URL |
| `PLATFORM_ACCESS_JWT_AUDIENCE` | The Access application audience tag |
| `PLATFORM_ACCESS_JWKS_URL` | Cloudflare Access certificate/JWKS source |
| `PLATFORM_ACCESS_JWT_REQUIRED` | Explicit fail-closed switch; default must be required in production |
| `PLATFORM_ACCESS_CLOCK_SKEW_SECONDS` | Small bounded skew; not a substitute for correct clocks |

The implementation must refuse to boot a production platform plane with `JWT_REQUIRED` true but no
issuer/audience/JWKS, and must never log the token, client secret or full header.

## 6. Cloudflare configuration sequence

This is a future operator sequence, not an executed change.

1. **Confirm the zone and certificate.** Add the domain to Cloudflare, verify nameservers, enable
   DNSSEC if the registrar supports it, and confirm the Render custom-domain certificate is issued.
   Use Full (strict) TLS; do not use Flexible.
2. **Add the Render custom hostname.** Verify the hostname in Render, wait for certificate issuance,
   and test `https://<host>/api/health` before putting Access in front. The Render `onrender.com` URL
   must still answer independently.
3. **Create the Access application for the exact paths.** Use `/platform*` and `/api/platform*`.
   Do not include `/api/health*`; UptimeRobot must remain able to probe it.
4. **Policy:** deny by default. Allow only the owner identity/group (and a named backup when one
   exists). Require the strongest MFA the identity provider supports. Use a short Access session
   consistent with the platform's 8-hour absolute cap, not a longer one.
5. **Service token:** create a scoped token for the API smoke/monitoring client. Store its secret in
   the owner's secret manager, not in a shell history or repository. Record a rotation date.
6. **Origin validation:** implement and review the JWT check in §7. Keep Access policies and app
   deployment separate so a policy mistake does not silently disable origin verification.
7. **Logging:** record where Access authentication/denial events are visible. On the free plan,
   standard retention is up to 24 hours; capture evidence manually for an incident or budget a paid
   retention/export option.
8. **No permanent bypass.** Do not create an Access “Bypass” policy for `/platform` or
   `/api/platform`. If an emergency requires one, it is a time-boxed, owner-approved incident action
   with a recorded removal time.

## 7. Origin JWT validation contract

The future code must enforce all of the following before any platform route logic:

1. Read only `Cf-Access-Jwt-Assertion`; do not trust `Cf-Access-Authenticated-User-Email` alone.
2. Reject if the header is absent, empty, malformed or has multiple values.
3. Verify the signature against the current Cloudflare Access keys. Cache the keys with a bounded
   lifetime and refresh on an unknown key ID; do not fetch keys per request.
4. Verify the issuer, audience, `exp` and `nbf`, with a small bounded clock skew.
5. Require the expected algorithm; reject `none`, unexpected algorithms and key confusion.
6. Reject a token that is valid for a different Access application/audience.
7. Return a bounded `401`/`403` without echoing the token, claims, keys or validation details.
8. Audit the denial with the action/reason, route, request id and source; never log the token.
9. Apply the check to every `/platform` and `/api/platform` request, including static assets and API
   clients. Exclude only the health endpoints.
10. Fail **closed** in production if the verifier is not configured. A missing verifier must not turn
    the platform into an open origin.

Direct-origin requirement: a request to the Render default URL with no valid Access JWT must be
rejected by the application, even though DNS/Access is not in front of that URL. This is the control
that makes the migration meaningful.

## 8. WebAuthn and origin migration

This is the highest lockout risk in the plan.

**What changes:** WebAuthn credentials are scoped to the RP ID. A credential registered under
`ai-inventory-l1mi.onrender.com` cannot be used on `ops.example.com`; the browser will not release an
assertion for a different RP ID. Changing the host does not migrate the credential.

**Mandatory sequence:**

1. Before cutover, verify the administrator has a working TOTP factor and an offline recovery-code
   set. Do not rely on the old WebAuthn key for the migration window.
2. Keep the old credential rows and old env values intact. Do not delete or overwrite them during the
   transition; they are the rollback path.
3. On the new origin, sign in with password + TOTP.
4. Enroll a **new** WebAuthn credential under the new RP ID. Test it in the same browser and at least
   one other browser/device if available.
5. Enroll a second key if the owner has one. Record the credential label and date, not the key.
6. Verify recovery-code login and logout on the new origin. Verify a foreign-Origin request is still
   refused.
7. Only after a stable observation window (recommended 14 days) may the old credential rows be
   removed, and only if the rollback period has ended or the owner accepts that rollback will rely on
   TOTP/recovery.
8. If the new RP ID cannot be validated, stop and roll back. Do not “fix” it by disabling WebAuthn
   verification or widening the RP ID to an unrelated domain.

**RP ID rule:** use the exact console hostname where possible (for example `ops.example.com`), or a
parent domain that is a valid registrable suffix of that host. Never use an unrelated domain.

## 9. Cutover sequence

| Step | Action | Evidence required | Rollback point |
| --- | --- | --- | --- |
| 0 | Approve gates CF-G1–G7 and record the change window | Signed decision table | No change |
| 1 | Add the Render custom hostname and DNS/CNAME; issue TLS | `https://<host>/api/health` 200, certificate subject/SAN, `onrender.com` still responds | Remove custom domain/DNS |
| 2 | Deploy the origin-verification code with enforcement **off** (or not configured) | Code review + local tests; production remains on the current gate | Re-deploy previous commit |
| 3 | Create the Access app/policy/service token; test with a non-production identity | Access login, denied identity, service-token API smoke, direct-origin still rejected by app | Delete Access app/policy |
| 4 | Verify new-origin password + TOTP; enroll/test new WebAuthn; verify recovery | Browser records, audit rows, recovery count, no console errors | Old origin still works with old RP/credentials |
| 5 | Enable origin JWT enforcement | Direct `onrender.com` platform request 401; missing/expired/wrong-audience token 401; valid Access request passes | Set enforcement off via the approved rollback config/redeploy |
| 6 | Observe 24–72 hours; verify Access denials reach the alert channel | Edge/app logs, alert test, no lockout, health still public | Rollback to step 4 |
| 7 | Record the new baseline, rotate any temporary service token, keep the old credentials until the observation window ends | Signed close-out | Step 4 or 5 |

A production cutover is **NO-GO** if step 4 cannot demonstrate new-origin TOTP + WebAuthn or recovery.

## 10. Rollback procedure

Rollback must be executable by one owner under stress and must not depend on the new edge.

1. **Stop.** Do not delete the old DNS record, old credentials, old env values or the previous
   deployment.
2. **Disable enforcement first** via the approved config switch or redeploy the last known-good
   commit. Confirm the console answers on the old origin.
3. **Remove the Access application/DNS routing** only after the old origin is serving. Do not leave
   the custom hostname pointing at an unverified origin.
4. **Restore the old origin/RP values** (`PLATFORM_*`), keeping the old WebAuthn rows. Verify password
   + TOTP and, if retained, old WebAuthn.
5. **Verify the old URL, cookie flags, CORS/CSRF, recovery and health.** Revoke any temporary Access
   service token.
6. **Record the failed step and the observed error before retrying.** Do not immediately repeat the
   cutover; fix the cause and re-run the isolated acceptance suite.
7. If the old URL is unavailable, use the break-glass CLI only under its documented procedure; do not
   edit database rows manually.

**Rollback is not complete until the old console is reachable and a real browser login succeeds.**

## 11. Acceptance tests before production approval

All tests must be run against the actual custom hostname and the actual Render origin. A local test
alone is insufficient.

| ID | Test | Expected |
| --- | --- | --- |
| CF-A01 | Anonymous `/platform` through the custom hostname | Access challenge/redirect, not the console |
| CF-A02 | Identity not in the Access policy | Access denial; no app session |
| CF-A03 | Owner identity + Access login | Reaches Basic gate, then platform password challenge |
| CF-A04 | Password + TOTP on new origin | Dashboard renders; exact cookie flags; no console errors |
| CF-A05 | New WebAuthn registration and sign-in on new origin | Pass; credential bound to new RP ID |
| CF-A06 | Old WebAuthn credential on new origin | Refused/unavailable; no false success |
| CF-A07 | Recovery-code login on new origin | 200; count decrements; old cookie rejected after logout |
| CF-A08 | Direct `onrender.com` platform path without Access JWT | Application rejects; no console/API data |
| CF-A09 | Missing `Cf-Access-Jwt-Assertion` on custom host | Rejected at the app; bounded response |
| CF-A10 | Bad signature / wrong audience / expired / future token | Rejected; no claims/token in response/log |
| CF-A11 | Service token + existing API key/Bearer | Approved API read only; no human session |
| CF-A12 | `/api/health`, `/ready`, `/live` through the custom host | Public 200/503 as appropriate; no Access/auth required |
| CF-A13 | Foreign Origin / missing CSRF | 403; audit/alert event |
| CF-A14 | Logout and old cookie | 200 then 401 |
| CF-A15 | Access denial / direct-origin attempt alert | Delivered to the approved owner/channel within the target |
| CF-A16 | Rollback rehearsal in isolation | Old origin, old RP, recovery and health all work |
| CF-A17 | No secret leakage | No token, key, cookie, recovery code or Mongo URI in logs/artifacts |
| CF-A18 | Deployed commit and environment | `/api/health` names the approved commit and `production` |

**Negative controls are mandatory.** A test that only proves the happy path does not prove the
boundary; the direct-origin, missing-token and wrong-audience cases must fail visibly.

## 12. Risks and stop conditions

| Risk | Why it matters | Stop/mitigation |
| --- | --- | --- |
| No controlled domain | Access cannot protect a hostname | NO-GO; do not use a temporary unrelated domain |
| Origin check omitted | Access is bypassable via `onrender.com` | NO-GO until enforced and tested |
| WebAuthn lockout | New RP ID invalidates old credentials | TOTP/recovery first; retain old rows; rollback |
| Cookie/CORS split | Login or CSRF fails after host change | One hostname preferred; browser test both |
| Access policy mistake | Owner locked out | Named backup, Access account recovery, break-glass; no permanent bypass |
| Cloudflare outage | Console unavailable even though Render is up | Document availability risk; do not silently bypass; use recovery path |
| Free log retention | Incident evidence disappears after 24h | Capture evidence manually or budget retention |
| Service token leak | Machine API access | Secret manager, scoped token, rotation, revoke |
| DNS/certificate failure | Custom hostname unavailable | Keep old origin; rollback DNS |
| Concurrent tenant API change | Unrelated mobile traffic breaks | Restrict change to platform host/paths; verify tenant health |

**Immediate stop conditions:** any test writes/deletes production data; any direct-origin request
returns platform data; the only administrator cannot complete TOTP/recovery; the rollback path is not
available; a secret appears in a log, screenshot, PR or chat. Stop, preserve logs and ask the owner
before retrying.

## 13. Evidence and close-out

Record in a future implementation record:

- Approved domain/hostname, account owners and gate sign-offs (no secrets).
- Render custom-domain and certificate observations.
- Access application/path/policy identifiers and service-token rotation date (not values).
- The deployed commit, `environment`, `db` and health status.
- Every CF-A test result, including negative controls and the exact failure response class.
- New WebAuthn credential labels/dates and recovery-code count (never codes).
- Rollback rehearsal result and the time to restore the old origin.
- Any accepted residual risk, signed and dated by the owner/reviewer.

## 14. Sources checked

- Cloudflare Access product and plans: <https://www.cloudflare.com/sase/products/access/> and
  <https://www.cloudflare.com/plans/zero-trust-services/>.
- Self-hosted application and origin token validation:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>.
- Service tokens:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>.
- JWT validation:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>.
- Render custom domains and TLS: <https://render.com/docs/custom-domains>.
- Existing provider/security records: [05 — Access layer](./platform-console/05-access-layer.md),
  [04 — Production readiness](./platform-console/04-production-readiness.md).
