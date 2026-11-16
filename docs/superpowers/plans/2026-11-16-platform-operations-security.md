# Platform Operations Security — Implementation Plan

**Status:** Approved by the owner on 2026-11-16. Implementation in progress. Not deployed.

**Scope:** the three approved next steps for the INTERNAL Platform Operations plane:

1. A dedicated console origin with HttpOnly cookies, CSRF and strict CSP.
2. An append-only platform audit log, readable only by SECURITY and SUPERADMIN.
3. Mandatory MFA (TOTP always; WebAuthn as an enrolled alternative) and a platform identity realm
   that does not depend on tenant accounts.

**Non-goals:** no tenant authentication change, no tenant Operations screen, no public deployment,
no OTA.

## Architecture

- **Console:** a separate Express static server in `server/platform-console/`, bound to loopback by
  default. It serves only HTML/CSS/JS; it never talks to MongoDB and never holds a credential. The
  browser calls `/api/platform` directly with `credentials: include`.
- **Cookie session:** the API sets an HttpOnly `platform_session` cookie containing the short-lived
  platform JWT, plus a readable `platform_csrf` cookie. Cookie-authenticated requests require an
  exact console `Origin` and a constant-time CSRF header/cookie match. Bearer API clients are
  unchanged and require no CSRF.
- **Audit:** `platform_audit_events` is a separate collection with model-level update/delete guards.
  Login, denied access, report reads, audit reads, logout, renew, MFA changes and WebAuthn changes
  are recorded. The read route requires `platform.audit.read`.
- **MFA:** password login returns only a short-lived MFA challenge. A first login enrolls TOTP; a
  confirmed TOTP secret is encrypted with `PLATFORM_MFA_ENCRYPTION_KEY`. Subsequent logins accept
  TOTP, or a WebAuthn assertion once a credential is registered. WebAuthn registration is available
  only inside an authenticated platform session.
- **Identity realm:** `platform_admins` remains a separate identity store with no `businessId` and
  no tenant role. The external dedicated identity project is a deployment configuration boundary;
  no tenant Firebase project is consulted by this plane.

## Tasks

1. Add the platform identity/MFA/audit config validation and models.
2. Add TOTP primitives, encryption vault, MFA challenge tokens and session completion.
3. Add WebAuthn registration/authentication with `@simplewebauthn/server`.
4. Add the audit writer, append-only model and read controller.
5. Add cookie/CSRF helpers and extend platform authentication.
6. Mount the new routes; update route inventory.
7. Add the dedicated console server and static UI.
8. Add the security tests and adapt the existing platform suite.
9. Update all documentation, run focused and full checks, report unverified browser/real
   authenticator behavior.

## Commands

- `cd server && TEST_MODE=db LOG_REQUESTS=0 node --test test/OPS7-platform-operations.test.mjs`
- `cd server && npx tsc --noEmit`
- `cd server && npx eslint <changed files>`
- `cd mobile && npx tsc --noEmit && npx jest --silent`
- `node scripts/check-docs.mjs`
