import { Router } from 'express';

import requirePlatformAdmin from '../middlewares/platformAuthenticate.ts';
import { requirePlatformCapability } from '../middlewares/platformAuthorize.ts';
import platformAuthController from '../controllers/platformAuth.controller.ts';
import platformMfaController from '../controllers/platformMfa.controller.ts';
import platformAuditController from '../controllers/platformAudit.controller.ts';
import platformOperationsController from '../controllers/platformOperations.controller.ts';
import platformSupportController from '../controllers/platformSupport.controller.ts';
import platformDeploymentsController from '../controllers/platformDeployments.controller.ts';
import platformAdminController from '../controllers/platformAdmin.controller.ts';
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
 *   POST /auth/mfa/recovery       public, login challenge + recovery code -> session
 *   POST /auth/mfa/webauthn/options public, login challenge -> assertion options
 *   POST /auth/mfa/webauthn/verify  public, assertion -> session
 *   POST /auth/webauthn/register/options authenticated, registration options
 *   POST /auth/webauthn/register/verify  authenticated, stores credential
 *   POST /auth/password        authenticated, current password -> all sessions revoked
 *   POST /auth/recovery-codes  authenticated, current password -> one-time codes
 *   GET  /admins       requires `platform.admin.manage`.
 *   PATCH /admins/:id/status  requires `platform.admin.manage`.
 *   DELETE /admins/:id         requires `platform.admin.manage`.
 *   DELETE /admins/:id/webauthn/:credentialId requires `platform.admin.manage`.
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

// MFA challenge endpoints have TWO independent budgets:
//   * this per-IP limiter, which bounds a single source; and
//   * the durable account-scoped failure window in platformMfa.service.ts,
//     which is shared across IPs. The second is the one that stops an
//     attacker rotating addresses against a six-digit code. A challenge token
//     is not guessable; the submitted factor is.
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
  '/auth/mfa/recovery',
  createLoginIpLimiter({ loginIpMax: 30 }),
  platformMfaController.recoveryLogin,
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
router.post(
  '/auth/password',
  requirePlatformAdmin,
  createLoginIpLimiter({ loginIpMax: 10 }),
  platformAuthController.changePassword,
);
router.post(
  '/auth/recovery-codes',
  requirePlatformAdmin,
  createLoginIpLimiter({ loginIpMax: 10 }),
  platformAuthController.recoveryCodes,
);
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
  '/admins',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.ADMIN_MANAGE),
  platformAdminController.list,
);
router.patch(
  '/admins/:id/status',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.ADMIN_MANAGE),
  platformAdminController.status,
);
router.delete(
  '/admins/:id',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.ADMIN_MANAGE),
  platformAdminController.remove,
);
router.delete(
  '/admins/:id/webauthn/:credentialId',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.ADMIN_MANAGE),
  platformAdminController.removeKey,
);

router.get(
  '/status',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.HEALTH_READ),
  platformOperationsController.status,
);
router.get(
  '/operations',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.METRICS_READ),
  platformOperationsController.summary,
);
router.get(
  '/deployments',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.DEPLOYMENTS_READ),
  platformDeploymentsController.list,
);
router.get(
  '/tickets',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.list,
);
router.get(
  '/tickets/assignees',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.assignees,
);
router.post(
  '/tickets',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.create,
);
router.get(
  '/tickets/:id',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.get,
);
router.patch(
  '/tickets/:id',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.update,
);
router.post(
  '/tickets/:id/notes',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.SUPPORT_MANAGE),
  platformSupportController.note,
);
router.get(
  '/audit',
  requirePlatformAdmin,
  requirePlatformCapability(PLATFORM_CAPABILITIES.AUDIT_READ),
  platformAuditController.list,
);

export default router;
