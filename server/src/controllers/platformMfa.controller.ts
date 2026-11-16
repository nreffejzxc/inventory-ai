import type { Response } from 'express';

import {
  confirmPlatformMfaEnrollment,
  verifyPlatformMfaLogin,
  startPlatformMfaEnrollment,
} from '../services/platformMfa.service.ts';
import { verifyPlatformRecoveryCode } from '../services/platformRecovery.service.ts';
import {
  beginPlatformWebAuthnLogin,
  beginPlatformWebAuthnRegistration,
  finishPlatformWebAuthnLogin,
  finishPlatformWebAuthnRegistration,
} from '../services/platformWebAuthn.service.ts';
import { throwValidation } from '../utils/errors.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import { sendPlatformSession } from './platformAuth.controller.ts';
import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import ApiError from '../utils/ApiError.ts';

/**
 * PLAT-2/PLAT-3 — MFA and WebAuthn endpoints.
 *
 * Challenge endpoints are public because the caller has not authenticated yet;
 * they accept only a short-lived, purpose-bound challenge token. A password
 * alone cannot produce one. Registration endpoints require a platform session.
 */

function requireString(value: unknown, field: string, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throwValidation([{ field, message }]);
  }
  return (value as string).trim();
}

async function auditFailure(
  req: PlatformRequest,
  action: string,
  reason: string,
  actor?: { id?: string; email?: string; role?: string },
): Promise<void> {
  await recordPlatformAudit({
    action,
    outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
    actor: actor
      ? { adminId: actor.id ?? null, email: actor.email ?? null, role: actor.role ?? null }
      : null,
    reason,
    req,
  });
}

/** POST /api/platform/auth/mfa/enroll/start */
export async function startEnrollment(req: PlatformRequest, res: Response) {
  const enrollmentToken = requireString(
    req.body?.enrollmentToken,
    'enrollmentToken',
    'An enrollment challenge is required',
  );
  let result;
  try {
    result = await startPlatformMfaEnrollment({ enrollmentToken });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.MFA_ENROLLMENT_FAILED,
      err instanceof ApiError ? String(err.code || 'mfa_enrollment_failed') : 'mfa_enrollment_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    req,
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

/** POST /api/platform/auth/mfa/enroll/confirm */
export async function confirmEnrollment(req: PlatformRequest, res: Response) {
  const enrollmentToken = requireString(
    req.body?.enrollmentToken,
    'enrollmentToken',
    'An enrollment challenge is required',
  );
  const code = requireString(req.body?.code, 'code', 'A six-digit authentication code is required');
  let result;
  try {
    result = await confirmPlatformMfaEnrollment({
      enrollmentToken,
      code,
      deviceLabel: req.body?.deviceLabel,
    });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.MFA_ENROLLMENT_FAILED,
      err instanceof ApiError ? String(err.code || 'mfa_enrollment_failed') : 'mfa_enrollment_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.MFA_ENROLLED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    req,
  });
  return sendPlatformSession(req, res, result, result.mfa);
}

/** POST /api/platform/auth/mfa/verify */
export async function verifyLogin(req: PlatformRequest, res: Response) {
  const mfaToken = requireString(req.body?.mfaToken, 'mfaToken', 'A login challenge is required');
  const code = requireString(req.body?.code, 'code', 'A six-digit authentication code is required');
  let result;
  try {
    result = await verifyPlatformMfaLogin({
      mfaToken,
      code,
      deviceLabel: req.body?.deviceLabel,
    });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.MFA_FAILED,
      err instanceof ApiError ? String(err.code || 'mfa_failed') : 'mfa_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.MFA_VERIFIED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    metadata: { method: 'totp' },
    req,
  });
  return sendPlatformSession(req, res, result, result.mfa);
}

/** POST /api/platform/auth/mfa/recovery — a one-time recovery code. */
export async function recoveryLogin(req: PlatformRequest, res: Response) {
  const mfaToken = requireString(req.body?.mfaToken, 'mfaToken', 'A login challenge is required');
  const recoveryCode = requireString(
    req.body?.recoveryCode,
    'recoveryCode',
    'A recovery code is required',
  );
  let result;
  try {
    result = await verifyPlatformRecoveryCode({
      mfaToken,
      recoveryCode,
      deviceLabel: req.body?.deviceLabel,
    });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.RECOVERY_CODE_FAILED,
      err instanceof ApiError ? String(err.code || 'recovery_code_failed') : 'recovery_code_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.RECOVERY_CODE_SUCCEEDED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    metadata: { method: 'recovery', remaining: result.mfa.remaining },
    req,
  });
  return sendPlatformSession(req, res, result, result.mfa);
}

/** POST /api/platform/auth/mfa/webauthn/options — an existing login challenge. */
export async function webAuthnLoginOptions(req: PlatformRequest, res: Response) {
  const mfaToken = requireString(req.body?.mfaToken, 'mfaToken', 'A login challenge is required');
  let result;
  try {
    result = await beginPlatformWebAuthnLogin({ mfaToken });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_LOGIN_FAILED,
      err instanceof ApiError ? String(err.code || 'webauthn_login_failed') : 'webauthn_login_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.WEBAUTHN_LOGIN_STARTED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    reason: 'challenge_issued',
    req,
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

/** POST /api/platform/auth/mfa/webauthn/verify */
export async function webAuthnLoginVerify(req: PlatformRequest, res: Response) {
  const authenticationToken = requireString(
    req.body?.authenticationToken,
    'authenticationToken',
    'A WebAuthn challenge is required',
  );
  if (!req.body?.response || typeof req.body.response !== 'object') {
    throwValidation([{ field: 'response', message: 'A WebAuthn assertion is required' }]);
  }
  let result;
  try {
    result = await finishPlatformWebAuthnLogin({
      authenticationToken,
      response: req.body.response,
      deviceLabel: req.body.deviceLabel,
    });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_LOGIN_FAILED,
      err instanceof ApiError ? String(err.code || 'webauthn_login_failed') : 'webauthn_login_failed',
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.WEBAUTHN_LOGIN_SUCCEEDED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    metadata: { method: 'webauthn' },
    req,
  });
  return sendPlatformSession(req, res, result, result.mfa);
}

/** POST /api/platform/auth/webauthn/register/options — authenticated. */
export async function webAuthnRegisterOptions(req: PlatformRequest, res: Response) {
  let result;
  try {
    result = await beginPlatformWebAuthnRegistration({ adminId: req.platformAdmin!.id });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_REGISTRATION_FAILED,
      err instanceof ApiError
        ? String(err.code || 'webauthn_registration_failed')
        : 'webauthn_registration_failed',
      {
        id: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.WEBAUTHN_REGISTRATION_STARTED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: req.platformAdmin!.id,
      email: req.platformAdmin!.email,
      role: req.platformAdmin!.role,
    },
    reason: 'challenge_issued',
    req,
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

/** POST /api/platform/auth/webauthn/register/verify — authenticated. */
export async function webAuthnRegisterVerify(req: PlatformRequest, res: Response) {
  const registrationToken = requireString(
    req.body?.registrationToken,
    'registrationToken',
    'A WebAuthn registration challenge is required',
  );
  if (!req.body?.response || typeof req.body.response !== 'object') {
    throwValidation([{ field: 'response', message: 'A WebAuthn attestation is required' }]);
  }
  let result;
  try {
    result = await finishPlatformWebAuthnRegistration({
      adminId: req.platformAdmin!.id,
      registrationToken,
      response: req.body.response,
      label: req.body.label,
    });
  } catch (err) {
    await auditFailure(
      req,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_REGISTRATION_FAILED,
      err instanceof ApiError
        ? String(err.code || 'webauthn_registration_failed')
        : 'webauthn_registration_failed',
      {
        id: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
    );
    throw err;
  }
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.WEBAUTHN_REGISTERED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: req.platformAdmin!.id,
      email: req.platformAdmin!.email,
      role: req.platformAdmin!.role,
    },
    metadata: { label: result.label },
    req,
  });
  return res.status(200).json(result);
}

export default {
  startEnrollment,
  confirmEnrollment,
  verifyLogin,
  recoveryLogin,
  webAuthnLoginOptions,
  webAuthnLoginVerify,
  webAuthnRegisterOptions,
  webAuthnRegisterVerify,
};
