import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import PlatformAdminGuard from '../models/platformAdminGuard.model.ts';
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
 * they require `platform.admin.manage` (SUPERADMIN) at the route. Three safety
 * rules are enforced here, not only in the console:
 *
 *   1. an administrator cannot disable or delete their own row;
 *   2. the last ACTIVE SUPERADMIN cannot be disabled or deleted; and
 *   3. every operation that can REDUCE the active SUPERADMIN count — a disable
 *      or a delete — applies rule 2 under an exclusive lease, so two concurrent
 *      requests cannot both observe "another SUPERADMIN exists" and commit.
 *
 * Rule 3 is the fix for a real interleaving: `countDocuments` followed by
 * `findOneAndUpdate`/`deleteOne` is two operations, and with two ACTIVE
 * SUPERADMINs each request excludes only its own target, sees the other, and
 * proceeds. The count and the write now happen while holding `PLATFORM_GUARD_ID`
 * in `platform_admin_guards`; the lease's conditional update is atomic in
 * MongoDB, and its expiry lets a crashed holder be replaced.
 *
 * ENABLING an administrator takes no lease: it can only preserve or increase the
 * number of ACTIVE SUPERADMINs, so it cannot participate in the lockout race and
 * must not queue behind an unrelated disable.
 *
 * Every state change revokes the target's sessions immediately, so a disabled or
 * deleted administrator cannot keep using an already-issued token.
 */

const ACTIVE = 'ACTIVE';
const DISABLED = 'DISABLED';

const GUARD_ID = 'last-active-superadmin';
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

export const PLATFORM_ADMIN_NOT_FOUND_CODE = 'PLATFORM_ADMIN_NOT_FOUND';
export const PLATFORM_ADMIN_SELF_PROTECTED_CODE = 'PLATFORM_ADMIN_SELF_PROTECTED';
export const PLATFORM_ADMIN_LAST_SUPERADMIN_CODE = 'PLATFORM_ADMIN_LAST_SUPERADMIN';
export const PLATFORM_ADMIN_MUTATION_IN_PROGRESS_CODE = 'PLATFORM_ADMIN_MUTATION_IN_PROGRESS';
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

function isDuplicateKey(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { code?: unknown }).code === 11000,
  );
}

/**
 * Take the administrator-mutation lease, or fail with a retryable 409 after
 * `LOCK_WAIT_MS`. The returned release function is idempotent and safe to call
 * when the lease has already expired; a failed release never masks the result of
 * the operation it guarded.
 */
async function acquireAdminMutationLock(): Promise<() => Promise<void>> {
  const token = randomUUID();

  // First use creates the singleton. Two processes may race here; the loser's
  // duplicate-key error means the winner's row already exists, which is exactly
  // the state the conditional update below needs.
  try {
    await PlatformAdminGuard.updateOne(
      { _id: GUARD_ID },
      { $setOnInsert: { lockToken: null, lockExpiresAt: null } },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const now = new Date();
    let held = null;
    try {
      held = await PlatformAdminGuard.findOneAndUpdate(
        {
          _id: GUARD_ID,
          $or: [{ lockToken: null }, { lockExpiresAt: { $lte: now } }],
        },
        {
          $set: {
            lockToken: token,
            lockExpiresAt: new Date(now.getTime() + LOCK_TTL_MS),
          },
        },
        { returnDocument: 'after' },
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }

    if (held && held.lockToken === token) {
      return async () => {
        try {
          await PlatformAdminGuard.updateOne(
            { _id: GUARD_ID, lockToken: token },
            { $set: { lockToken: null, lockExpiresAt: null } },
          );
        } catch {
          // The lease expires on its own, so a failed release cannot deadlock
          // the plane; swallowing it also keeps the guarded operation's result.
        }
      };
    }

    if (Date.now() >= deadline) {
      throw new ApiError(
        409,
        'Another platform administrator change is in progress; retry shortly',
        PLATFORM_ADMIN_MUTATION_IN_PROGRESS_CODE,
      );
    }
    await delay(LOCK_POLL_MS);
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

  // Only a disable can reduce the active SUPERADMIN count. Enabling is
  // deliberately lock-free: it cannot create the lockout this guard prevents,
  // and making it wait behind a disable would add contention for no safety.
  const release = status === DISABLED ? await acquireAdminMutationLock() : null;
  try {
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
    const revoked =
      status === DISABLED ? await revokeAllPlatformSessionsForAdmin(target._id, now) : null;
    return {
      admin: toPublicPlatformAdmin(updated),
      sessionsRevoked: revoked?.modifiedCount ?? 0,
    };
  } finally {
    if (release) await release();
  }
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

  const release = await acquireAdminMutationLock();
  try {
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
  } finally {
    await release();
  }
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
  PLATFORM_ADMIN_MUTATION_IN_PROGRESS_CODE,
  PLATFORM_WEBAUTHN_KEY_NOT_FOUND_CODE,
  listPlatformAdmins,
  setPlatformAdminStatus,
  deletePlatformAdmin,
  removePlatformWebAuthnKey,
};
