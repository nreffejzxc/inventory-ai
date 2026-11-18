import type { NextFunction, Response } from 'express';

import ApiError from '../utils/ApiError.ts';
import type { PlatformRequest } from './platformAuthenticate.ts';
import {
  PLATFORM_STEP_UP_HEADER,
  PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE,
} from '../config/platformSecurity.ts';
import { verifyPlatformStepUpToken } from '../config/platformJwt.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';

/**
 * SEC-08 — reject a destructive platform action unless it carries a fresh,
 * session-bound step-up proof.
 *
 * The proof is checked here, on the server, after authentication and the
 * capability gate. A console that forgets the header cannot perform the action;
 * hiding a button is not the control. The proof token is never written to the
 * audit trail or a log.
 */

export const PLATFORM_STEP_UP_REQUIRED_CODE = 'PLATFORM_STEP_UP_REQUIRED';

function actor(req: PlatformRequest) {
  return req.platformAdmin
    ? {
        adminId: req.platformAdmin.id,
        email: req.platformAdmin.email,
        role: req.platformAdmin.role,
      }
    : null;
}

function refusalReason(err: unknown): string {
  if (err instanceof ApiError) return String(err.code || 'step_up_invalid');
  if (err instanceof Error && err.name === 'TokenExpiredError') return 'step_up_expired';
  return 'step_up_invalid';
}

export function requirePlatformStepUp(scope = PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE) {
  return async (req: PlatformRequest, _res: Response, next: NextFunction) => {
    if (!req.platformAdmin || !req.platformAuth) {
      return next(new ApiError(401, 'Platform authentication required', 'PLATFORM_AUTH_REQUIRED'));
    }

    const header = req.headers[PLATFORM_STEP_UP_HEADER];
    try {
      if (typeof header !== 'string' || !header.trim()) {
        throw new ApiError(401, 'Step-up proof required', 'PLATFORM_STEP_UP_MISSING');
      }
      verifyPlatformStepUpToken(header.trim(), {
        adminId: req.platformAdmin.id,
        jti: req.platformAuth.jti,
        scope,
      });
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.STEP_UP_USED,
        outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { scope },
        req,
      });
      return next();
    } catch (err) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.STEP_UP_REQUIRED,
        outcome: PLATFORM_AUDIT_OUTCOMES.DENIED,
        actor: actor(req),
        capability: 'platform.admin.manage',
        reason: refusalReason(err),
        metadata: { scope },
        req,
      });
      return next(
        new ApiError(
          403,
          'Step-up authentication required for this platform action',
          PLATFORM_STEP_UP_REQUIRED_CODE,
        ),
      );
    }
  };
}

export default requirePlatformStepUp;
