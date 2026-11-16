import type { Response } from 'express';

import { listPlatformAudit } from '../services/platformAudit.service.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES, PLATFORM_AUDIT_ACTION_VALUES } from '../constants/platformAudit.ts';
import { throwValidation } from '../utils/errors.ts';
import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';

/**
 * GET /api/platform/audit — the append-only platform audit trail.
 *
 * Requires `platform.audit.read` (SECURITY and SUPERADMIN only; SUPPORT and
 * READ_ONLY are refused by the route guard, and that refusal is itself audited).
 * The read is bounded to 100 rows per page and is itself recorded.
 */

const VALID_OUTCOMES = new Set(['SUCCESS', 'DENIED', 'FAILURE']);

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throwValidation([{ field: 'limit', message: 'limit must be an integer from 1 to 100' }]);
  }
  return parsed;
}

function optionalQueryString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

const platformAuditController = {
  async list(req: PlatformRequest, res: Response) {
    const limit = parseLimit(req.query.limit);
    const before = optionalQueryString(req.query.before);
    if (before) {
      const parsed = new Date(before);
      if (!Number.isFinite(parsed.getTime())) {
        throwValidation([{ field: 'before', message: 'before must be an ISO timestamp' }]);
      }
    }
    const action = optionalQueryString(req.query.action);
    if (action && !PLATFORM_AUDIT_ACTION_VALUES.includes(action)) {
      throwValidation([{ field: 'action', message: 'Unknown audit action' }]);
    }
    const outcome = optionalQueryString(req.query.outcome);
    if (outcome && !VALID_OUTCOMES.has(outcome)) {
      throwValidation([{ field: 'outcome', message: 'outcome must be SUCCESS, DENIED or FAILURE' }]);
    }

    const result = await listPlatformAudit({ limit, before, action, outcome });
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.AUDIT_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: {
        adminId: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
      capability: 'platform.audit.read',
      metadata: {
        returned: result.events.length,
        hasMore: result.hasMore,
        action: action ?? null,
        outcome: outcome ?? null,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json(result);
  },
};

export default platformAuditController;
