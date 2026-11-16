import PlatformAdmin from '../models/platformAdmin.model.ts';
import PlatformAdminSession from '../models/platformAdminSession.model.ts';
import ApiError from '../utils/ApiError.ts';
import { PLATFORM_ROLES } from '../constants/platformRoles.ts';
import {
  toPublicPlatformAdmin,
  type PublicPlatformAdmin,
} from './platformAuth.service.ts';
import { revokeAllPlatformSessionsForAdmin } from './platformSession.service.ts';

/**
 * PLAT-5 — platform administrator lifecycle.
 *
 * These operations are deliberately administrative rather than self-service:
 * they require `platform.admin.manage` (SUPERADMIN) at the route. Two safety
 * rules are enforced here, not only in the console:
 *
 *   1. an administrator cannot disable or delete their own row; and
 *   2. the last ACTIVE SUPERADMIN cannot be disabled or deleted.
 *
 * Both rules prevent the plane from being locked out by a single click. Every
 * state change revokes the target's sessions immediately, so a disabled or
 * deleted administrator cannot keep using an already-issued token.
 */

const ACTIVE = 'ACTIVE';
const DISABLED = 'DISABLED';

export const PLATFORM_ADMIN_NOT_FOUND_CODE = 'PLATFORM_ADMIN_NOT_FOUND';
export const PLATFORM_ADMIN_SELF_PROTECTED_CODE = 'PLATFORM_ADMIN_SELF_PROTECTED';
export const PLATFORM_ADMIN_LAST_SUPERADMIN_CODE = 'PLATFORM_ADMIN_LAST_SUPERADMIN';
export const PLATFORM_WEBAUTHN_KEY_NOT_FOUND_CODE = 'PLATFORM_WEBAUTHN_KEY_NOT_FOUND';

type TargetAdmin = InstanceType<typeof PlatformAdmin> & {
  webauthnCredentials?: Array<{
    credentialId: string;
    label?: string;
  }> | null;
  recoveryCodes?: Array<{ codeHash: string; usedAt?: Date | null }> | null;
};

async function loadTarget(targetId: string): Promise<TargetAdmin> {
  const target = (await PlatformAdmin.findById(targetId).select(
    '+webauthnCredentials +recoveryCodes',
  )) as TargetAdmin | null;
  if (!target) {
    throw new ApiError(404, 'Platform administrator not found', PLATFORM_ADMIN_NOT_FOUND_CODE);
  }
  return target;
}

async function assertNotLastActiveSuperadmin(target: TargetAdmin): Promise<void> {
  if (target.role !== PLATFORM_ROLES.SUPERADMIN || target.status !== ACTIVE) return;
  const otherSuperadmins = await PlatformAdmin.countDocuments({
    _id: { $ne: target._id },
    role: PLATFORM_ROLES.SUPERADMIN,
    status: ACTIVE,
  });
  if (otherSuperadmins === 0) {
    throw new ApiError(
      409,
      'The last active SUPERADMIN cannot be disabled or deleted',
      PLATFORM_ADMIN_LAST_SUPERADMIN_CODE,
    );
  }
}

export async function listPlatformAdmins(): Promise<PublicPlatformAdmin[]> {
  const admins = (await PlatformAdmin.find()
    .select('+webauthnCredentials +recoveryCodes')
    .sort({ email: 1 })) as TargetAdmin[];
  return admins.map((admin) => toPublicPlatformAdmin(admin));
}

export async function setPlatformAdminStatus({
  actorId,
  targetId,
  status,
  now = new Date(),
}: {
  actorId: string;
  targetId: string;
  status: unknown;
  now?: Date;
}) {
  if (status !== ACTIVE && status !== DISABLED) {
    throw new ApiError(400, 'status must be ACTIVE or DISABLED', 'VALIDATION_ERROR');
  }
  if (String(actorId) === String(targetId) && status === DISABLED) {
    throw new ApiError(
      409,
      'You cannot disable your own platform administrator account',
      PLATFORM_ADMIN_SELF_PROTECTED_CODE,
    );
  }
  const target = await loadTarget(targetId);
  if (status === DISABLED) await assertNotLastActiveSuperadmin(target);

  const updated = (await PlatformAdmin.findOneAndUpdate(
    { _id: target._id },
    { $set: { status } },
    { returnDocument: 'after' },
  ).select('+webauthnCredentials +recoveryCodes')) as TargetAdmin | null;
  if (!updated) {
    throw new ApiError(404, 'Platform administrator not found', PLATFORM_ADMIN_NOT_FOUND_CODE);
  }
  const revoked = status === DISABLED ? await revokeAllPlatformSessionsForAdmin(target._id, now) : null;
  return {
    admin: toPublicPlatformAdmin(updated),
    sessionsRevoked: revoked?.modifiedCount ?? 0,
  };
}

export async function deletePlatformAdmin({
  actorId,
  targetId,
  now = new Date(),
}: {
  actorId: string;
  targetId: string;
  now?: Date;
}) {
  if (String(actorId) === String(targetId)) {
    throw new ApiError(
      409,
      'You cannot delete your own platform administrator account',
      PLATFORM_ADMIN_SELF_PROTECTED_CODE,
    );
  }
  const target = await loadTarget(targetId);
  await assertNotLastActiveSuperadmin(target);

  await PlatformAdminSession.deleteMany({ adminId: target._id });
  const deleted = await PlatformAdmin.deleteOne({ _id: target._id });
  if (deleted.deletedCount !== 1) {
    throw new ApiError(404, 'Platform administrator not found', PLATFORM_ADMIN_NOT_FOUND_CODE);
  }
  return {
    deleted: {
      id: String(target._id),
      email: target.email,
      role: target.role,
      status: target.status,
    },
    deletedAt: now.toISOString(),
  };
}

export async function removePlatformWebAuthnKey({
  actorId,
  targetId,
  credentialId,
  now = new Date(),
}: {
  actorId?: string;
  targetId: string;
  credentialId: string;
  now?: Date;
}) {
  const target = await loadTarget(targetId);
  const key = (target.webauthnCredentials ?? []).find(
    (credential) => credential.credentialId === credentialId,
  );
  if (!key) {
    throw new ApiError(
      404,
      'Platform security key not found',
      PLATFORM_WEBAUTHN_KEY_NOT_FOUND_CODE,
    );
  }
  const removed = await PlatformAdmin.updateOne(
    { _id: target._id, status: ACTIVE, 'webauthnCredentials.credentialId': credentialId },
    { $pull: { webauthnCredentials: { credentialId } } },
  );
  if (removed.modifiedCount !== 1) {
    throw new ApiError(
      404,
      'Platform security key not found',
      PLATFORM_WEBAUTHN_KEY_NOT_FOUND_CODE,
    );
  }
  await revokeAllPlatformSessionsForAdmin(target._id, now);
  return {
    removed: true,
    credentialId,
    label: key.label || 'Security key',
    admin: { id: String(target._id), email: target.email },
    actorId: actorId || null,
  };
}

export default {
  PLATFORM_ADMIN_NOT_FOUND_CODE,
  PLATFORM_ADMIN_SELF_PROTECTED_CODE,
  PLATFORM_ADMIN_LAST_SUPERADMIN_CODE,
  PLATFORM_WEBAUTHN_KEY_NOT_FOUND_CODE,
  listPlatformAdmins,
  setPlatformAdminStatus,
  deletePlatformAdmin,
  removePlatformWebAuthnKey,
};
