import crypto from 'node:crypto';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import {
  PLATFORM_MFA_PURPOSES,
  verifyPlatformMfaToken,
} from '../config/platformJwt.ts';
import {
  PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE,
  assertPlatformChallengeIsCurrent,
  assertPlatformMfaNotLocked,
  completePlatformLogin,
  recordPlatformMfaFailure,
  resetPlatformMfaFailures,
  type PlatformSessionResult,
} from './platformMfa.service.ts';
import { verifyPlatformPassword } from './platformAuth.service.ts';

/**
 * PLAT-5 — one-time platform recovery codes.
 *
 * Recovery codes are a second-factor fallback, not a password reset. They are
 * generated only from an authenticated platform session after re-entering the
 * current password, shown once, stored only as SHA-256 digests, and consumed
 * atomically. A code can open a session only with a valid, short-lived login
 * challenge — it cannot be used as a password or as an access token.
 *
 * The code alphabet excludes ambiguous characters and the code is normalized to
 * uppercase with separators removed. Ten codes are issued at a time; generating
 * a new set invalidates every older code.
 */

export const PLATFORM_RECOVERY_CODE_COUNT = 10;
export const PLATFORM_RECOVERY_CODE_LENGTH = 12;
export const PLATFORM_RECOVERY_INVALID_CODE = 'PLATFORM_RECOVERY_INVALID';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACTIVE = 'ACTIVE';

type AdminWithRecovery = InstanceType<typeof PlatformAdmin> & {
  recoveryCodes?: Array<{ codeHash: string; usedAt?: Date | null }> | null;
  mfaEnabled?: boolean;
  passwordChangedAt?: Date | null;
  mfaLockedUntil?: Date | null;
};

export function normalizeRecoveryCode(value: unknown): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(value: unknown): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(value)).digest('hex');
}

function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < PLATFORM_RECOVERY_CODE_LENGTH; i += 1) {
    raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return raw.match(/.{1,4}/g)?.join('-') || raw;
}

export function generatePlatformRecoveryCodes(): string[] {
  return Array.from({ length: PLATFORM_RECOVERY_CODE_COUNT }, () => newRecoveryCode());
}

export function countUnusedRecoveryCodes(
  codes: Array<{ usedAt?: Date | null }> | null | undefined,
): number {
  return Array.isArray(codes) ? codes.filter((code) => !code.usedAt).length : 0;
}

/**
 * Replace every recovery code for the signed-in administrator. The current
 * password is required again so a stolen session alone cannot mint a permanent
 * second-factor bypass. The plaintext values exist only in this response.
 */
export async function generateRecoveryCodesForAdmin({
  adminId,
  password,
  now = new Date(),
}: {
  adminId: string;
  password: unknown;
  now?: Date;
}) {
  if (typeof password !== 'string' || !password) {
    throw new ApiError(400, 'Current password is required', 'VALIDATION_ERROR');
  }
  const admin = await PlatformAdmin.findById(adminId).select('+passwordHash');
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  if (!(await verifyPlatformPassword(password, admin.passwordHash))) {
    throw new ApiError(401, 'Current password is incorrect', 'PLATFORM_CURRENT_PASSWORD_INVALID');
  }

  const codes = generatePlatformRecoveryCodes();
  const updated = await PlatformAdmin.findOneAndUpdate(
    { _id: admin._id, status: ACTIVE },
    {
      $set: {
        recoveryCodes: codes.map((code) => ({ codeHash: hashRecoveryCode(code), usedAt: null })),
        recoveryCodesGeneratedAt: now,
      },
    },
    { returnDocument: 'after' },
  ).select('+recoveryCodes');
  if (!updated) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  return {
    codes,
    generatedAt: now.toISOString(),
    remaining: countUnusedRecoveryCodes(updated.recoveryCodes),
  };
}

/**
 * Complete a login challenge with a recovery code. The challenge token is
 * verified first, then the administrator's active state, challenge age and MFA
 * lock are checked before the code digest is looked up. The `usedAt` write is
 * an atomic single-document update, so two concurrent submissions of the same
 * code cannot both open a session.
 */
export async function verifyPlatformRecoveryCode({
  mfaToken,
  recoveryCode,
  deviceLabel,
}: {
  mfaToken: string;
  recoveryCode: unknown;
  deviceLabel?: unknown;
}): Promise<PlatformSessionResult & { mfa: { method: 'recovery'; remaining: number } }> {
  const claims = verifyPlatformMfaToken(mfaToken, PLATFORM_MFA_PURPOSES.LOGIN);
  const admin = (await PlatformAdmin.findById(claims.sub).select(
    '+recoveryCodes +webauthnCredentials',
  )) as AdminWithRecovery | null;
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  assertPlatformChallengeIsCurrent(admin, claims.iat);
  if (!admin.mfaEnabled) {
    throw new ApiError(
      409,
      'Multi-factor enrollment is required',
      PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE,
    );
  }
  assertPlatformMfaNotLocked(admin);

  const codeHash = hashRecoveryCode(recoveryCode);
  const candidate = (admin.recoveryCodes ?? []).find(
    (code) => !code.usedAt && code.codeHash === codeHash,
  );
  if (!candidate) {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid recovery code', PLATFORM_RECOVERY_INVALID_CODE);
  }

  const now = new Date();
  const consumed = await PlatformAdmin.findOneAndUpdate(
    {
      _id: admin._id,
      status: ACTIVE,
      recoveryCodes: { $elemMatch: { codeHash, usedAt: null } },
    },
    { $set: { 'recoveryCodes.$.usedAt': now } },
    { returnDocument: 'after' },
  ).select('+recoveryCodes');
  if (!consumed) {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid recovery code', PLATFORM_RECOVERY_INVALID_CODE);
  }

  await resetPlatformMfaFailures(admin._id);
  const session = await completePlatformLogin({ adminId: String(admin._id), deviceLabel });
  return {
    ...session,
    mfa: {
      method: 'recovery',
      remaining: countUnusedRecoveryCodes(consumed.recoveryCodes),
    },
  };
}

export default {
  PLATFORM_RECOVERY_CODE_COUNT,
  PLATFORM_RECOVERY_CODE_LENGTH,
  PLATFORM_RECOVERY_INVALID_CODE,
  normalizeRecoveryCode,
  hashRecoveryCode,
  generatePlatformRecoveryCodes,
  countUnusedRecoveryCodes,
  generateRecoveryCodesForAdmin,
  verifyPlatformRecoveryCode,
};
