import type { Response } from 'express';
import mongoose from 'mongoose';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { invalidId, throwValidation } from '../utils/errors.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import {
  deletePlatformAdmin,
  listPlatformAdmins,
  removePlatformWebAuthnKey,
  setPlatformAdminStatus,
} from '../services/platformAdminLifecycle.service.ts';
import ApiError from '../utils/ApiError.ts';

/**
 * PLAT-5 — administrator lifecycle endpoints.
 *
 * Every route here is mounted behind `requirePlatformAdmin` and the
 * `platform.admin.manage` capability. The target id is an ObjectId parameter,
 * never a capability, role or tenant claim. The service enforces the two
 * last-resort protections (no self-disable/delete and no removal of the last
 * active SUPERADMIN); the controller only validates shape and writes the audit
 * entry.
 */

function requireTargetId(req: PlatformRequest): string {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) invalidId();
  return id;
}

function actor(req: PlatformRequest) {
  return {
    adminId: req.platformAdmin!.id,
    email: req.platformAdmin!.email,
    role: req.platformAdmin!.role,
  };
}

async function auditFailure(
  req: PlatformRequest,
  action: string,
  err: unknown,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordPlatformAudit({
    action,
    outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
    actor: actor(req),
    capability: 'platform.admin.manage',
    reason: err instanceof ApiError ? String(err.code || 'admin_operation_failed') : 'admin_operation_failed',
    metadata,
    req,
  });
}

const platformAdminController = {
  async list(req: PlatformRequest, res: Response) {
    const admins = await listPlatformAdmins();
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_LISTED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: { returned: admins.length },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ admins });
  },

  async status(req: PlatformRequest, res: Response) {
    const targetId = requireTargetId(req);
    const status = req.body?.status;
    if (status !== 'ACTIVE' && status !== 'DISABLED') {
      throwValidation([{ field: 'status', message: 'status must be ACTIVE or DISABLED' }]);
    }
    let result;
    try {
      result = await setPlatformAdminStatus({
        actorId: req.platformAdmin!.id,
        targetId,
        status,
      });
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.ADMIN_STATUS_CHANGED, err, {
        targetAdminId: targetId,
        requestedStatus: status,
      });
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_STATUS_CHANGED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: {
        targetAdminId: result.admin.id,
        targetEmail: result.admin.email,
        status: result.admin.status,
        sessionsRevoked: result.sessionsRevoked,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  },

  async remove(req: PlatformRequest, res: Response) {
    const targetId = requireTargetId(req);
    let result;
    try {
      result = await deletePlatformAdmin({
        actorId: req.platformAdmin!.id,
        targetId,
      });
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.ADMIN_DELETED, err, {
        targetAdminId: targetId,
      });
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_DELETED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: { ...result.deleted, deletedAt: result.deletedAt },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  },

  async removeKey(req: PlatformRequest, res: Response) {
    const targetId = requireTargetId(req);
    const credentialId = String(req.params.credentialId || '').trim();
    if (!credentialId) {
      throwValidation([{ field: 'credentialId', message: 'A credential id is required' }]);
    }
    let result;
    try {
      result = await removePlatformWebAuthnKey({
        actorId: req.platformAdmin!.id,
        targetId,
        credentialId,
      });
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.WEBAUTHN_KEY_REMOVED, err, {
        targetAdminId: targetId,
        credentialId,
      });
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.WEBAUTHN_KEY_REMOVED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: {
        targetAdminId: targetId,
        credentialId: result.credentialId,
        label: result.label,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  },
};

export default platformAdminController;
