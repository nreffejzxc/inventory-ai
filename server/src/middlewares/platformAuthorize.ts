import type { NextFunction, Response } from 'express';

import ApiError from '../utils/ApiError.ts';
import { platformHasCapability } from '../constants/platformRoles.ts';
import type { PlatformRequest } from './platformAuthenticate.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';

/**
 * PLAT-1/PLAT-2 — platform capability gate.
 *
 * Must run AFTER `requirePlatformAdmin`, which sets `req.platformAdmin` from the
 * database. The capability is never read from the token or a cached claim, so a
 * role change takes effect on the very next request.
 *
 * A refusal is itself audited with the actor, the missing capability and the
 * requested route, so a SUPPORT account probing the audit trail leaves a record.
 * The middleware never records the token or any request body.
 */
export function requirePlatformCapability(capability: string) {
  return async (req: PlatformRequest, _res: Response, next: NextFunction) => {
    if (!req.platformAdmin) {
      return next(
        new ApiError(401, 'Platform authentication required', 'PLATFORM_AUTH_REQUIRED'),
      );
    }
    if (!platformHasCapability(req.platformAdmin.role, capability)) {
      const error = new ApiError(403, 'Platform capability required', 'PLATFORM_FORBIDDEN');
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.ACCESS_DENIED,
        outcome: PLATFORM_AUDIT_OUTCOMES.DENIED,
        actor: {
          adminId: req.platformAdmin.id,
          email: req.platformAdmin.email,
          role: req.platformAdmin.role,
        },
        capability,
        reason: 'capability_missing',
        req,
      });
      return next(error);
    }
    return next();
  };
}

export default { requirePlatformCapability };
