import { Router } from 'express';

import requirePlatformAdmin from '../middlewares/platformAuthenticate.ts';
import { requirePlatformCapability } from '../middlewares/platformAuthorize.ts';
import platformAuthController from '../controllers/platformAuth.controller.ts';
import platformMfaController from '../controllers/platformMfa.controller.ts';
import platformAuditController from '../controllers/platformAudit.controller.ts';
import platformOperationsController from '../controllers/platformOperations.controller.ts';
import { PLATFORM_CAPABILITIES } from '../constants/platformRoles.ts';
import {
  createLoginAccountLimiter,
  createLoginIpLimiter,
  resetLoginAccountBucketOnSuccess,
} from '../middlewares/rateLimit.ts';

/**
 * PLAT-1 — the Platform Operations API. Mounted at `/api/platform`.
 *
 * WHY A SEPARATE ROUTER. It is not a subtree of any tenant router, it imports no
 * tenant permission catalogue, and it is guarded only by
 * `requirePlatformAdmin` / `requirePlatformCapability`. A tenant `Authorization`
 * token is refused here at signature verification; a platform token is refused
 * by `requireAuth` on every tenant route because the two planes use different
 * secrets, issuers and audiences.
 *
 * CREDENTIAL ENDPOINTS AND THEIR LIMITS
 *   POST /auth/login   public (it is how a token is obtained) and limited by the
 *                      shared login limiters. A successful login clears the
 *                      account bucket, exactly as tenant login does.
 *   POST /auth/renew   authenticated; mints a token for the SAME session.
 *   POST /auth/logout  authenticated; ends the current session.
 *   GET  /auth/csrf    authenticated cookie session; rotates the CSRF value
 *   GET  /auth/me      authenticated; returns the principal.
 *   POST /auth/mfa/enroll/start   public, enrollment challenge only
 *   POST /auth/mfa/enroll/confirm public, enrollment challenge + TOTP -> session
 *   POST /auth/mfa/verify         public, login challenge + TOTP -> session
 *   POST /auth/mfa/webauthn/options public, login challenge -> assertion options
 *   POST /auth/mfa/webauthn/verify  public, assertion -> session
 *   POST /auth/webauthn/register/options authenticated, registration options
 *   POST /auth/webauthn/register/verify  authenticated, stores credential
 *   GET  /operations   requires `platform.metrics.read`.
 *   GET  /audit        requires `platform.audit.read` (SECURITY/SUPERADMIN).
 *
 * No route writes tenant data, accepts a tenant id, or creates a tenant session.
 */

const router = Router();

// Every platform response — including 401/403/503 — is internal and must never
// be stored by an intermediary. Mounted before the routes so it also applies to
// error responses produced by the guards.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// The tenant login limiters key on the submitted address and the caller's IP,
// neither of which is tenant-specific, so they are the right budget here rather
// than a second policy that could drift. A platform account gets a tighter
// failed-attempt cap than the tenant default.
const loginAccountLimiter = createLoginAccountLimiter({ loginMax: 5 });
router.post(
  '/auth/login',
  loginAccountLimiter,
  createLoginIpLimiter({ loginIpMax: 30 }),
  resetLoginAccountBucketOnSuccess(loginAccountLimiter),
  platformAuthController.login,
);

// MFA challenge endpoints. The shared login account/ip budgets also cover them:
// a challenge token is not guessable, but the submitted code is six digits and
// must not be brute-forceable at an unbounded rate. The mfa token itself is the
// only accepted input; no email/password is read here.
const mfaIpLimiter = createLoginIpLimiter({ loginIpMax: 30 });
router.post(
  '/auth/mfa/enroll/start',
  mfaIpLimiter,
  platformMfaController.startEnrollment,
);
router.post(
  '/auth/mfa/enroll/confirm',
  createLoginIpLimiter({ loginIpMax: 30 }),
  platformMfaController.confirmEnrollment,
);
router.post(
  '/auth/mfa/verify',
  createLoginIpLimiter({ loginIpMax: 30 }),
  platformMfaController.verifyLogin,
);
router.post(
  '/auth/mfa/webauthn/options',
  createLoginIpLimiter({ loginIpMax: 30 }),
  platformMfaController.webAuthnLoginOptions,
);
router.post(
  '/auth/mfa/webauthn/verify',
  createLoginIpLimiter({ loginIpMax: 30 }),
  platformMfaController.webAuthnLoginVerify,
);

router.post('/auth/renew', requirePlatformAdmin, platformAuthController.renew);
router.post('/auth/logout', requirePlatformAdmin, platformAuthController.logout);
router.get('/auth/csrf', requirePlatformAdmin, platformAuthController.csrf);
router.get('/auth/me', requirePlatformAdmin, platformAuthController.me);

// WebAuthn registration is available only inside an authenticated platform
// session, so a stolen password cannot enroll an attacker's key.
router.post(
  '/auth/webauthn/register/options',
  requirePlatformAdmin,
  platformMfaController.webAuthnRegisterOptions,
);
router.post(
  '/auth/webauthn/register/verify',
  requirePlatformAdmin,
  platformMfaController.webAuthnRegisterVerify,
);

router.get(
  '/operations',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.METRICS_READ),
  platformOperationsController.summary,
);
router.get(
  '/audit',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.AUDIT_READ),
  platformAuditController.list,
);

export default router;
