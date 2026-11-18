import type { Response } from 'express';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { throwValidation } from '../utils/errors.ts';
import { createPlatformStepUpProof } from '../services/platformStepUp.service.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import ApiError from '../utils/ApiError.ts';

/**
 * SEC-08 — issue a fresh step-up proof after password + TOTP.
 *
 * This route is authenticated but deliberately does not issue a session or
 * extend one. It returns a short-lived proof bound to the caller's session; the
 * destructive route still enforces its own capability and the proof scope.
 */
export async function stepUp(req: PlatformRequest, res: Response) {
  const password = req.body?.password;
  const code = req.body?.code;
  const problems: Array<{ field: string; message: string }> = [];
  if (typeof password !== 'string' || !password) {
    problems.push({ field: 'password', message: 'Current password is required' });
  }
  if (typeof code !== 'string' || !code.trim()) {
    problems.push({ field: 'code', message: 'A six-digit authentication code is required' });
  }
  if (problems.length > 0) throwValidation(problems);

  let result;
  try {
    result = await createPlatformStepUpProof({
      adminId: req.platformAdmin!.id,
      jti: req.platformAuth!.jti,
      password,
      code,
    });
  } catch (err) {
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
      outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
      actor: {
        adminId: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
      reason: err instanceof ApiError ? String(err.code || 'step_up_failed') : 'step_up_failed',
      req,
    });
    throw err;
  }

  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: req.platformAdmin!.id,
      email: req.platformAdmin!.email,
      role: req.platformAdmin!.role,
    },
    metadata: { scope: result.scope, expiresIn: result.expiresIn },
    req,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.status(200).json(result);
}

export default { stepUp };
