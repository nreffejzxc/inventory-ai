import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import {
  PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE,
  PLATFORM_STEP_UP_TTL_SECONDS,
} from '../config/platformSecurity.ts';
import {
  platformTokenExpiresAt,
  signPlatformStepUpToken,
} from '../config/platformJwt.ts';
import { verifyPlatformPassword } from './platformAuth.service.ts';
import {
  assertPlatformMfaNotLocked,
  recordPlatformMfaFailure,
  resetPlatformMfaFailures,
  PLATFORM_MFA_CODE_ALREADY_USED,
} from './platformMfa.service.ts';
import { decryptPlatformSecret } from './platformMfa/secretVault.ts';
import { verifyTotp } from './platformMfa/totp.ts';

/**
 * SEC-08 — fresh-factor proof for platform lifecycle actions.
 *
 * A platform session proves which administrator signed in, not that the person
 * holding the session is still present. This service re-checks the current
 * password and a TOTP code, advances the same replay counter used by login, and
 * returns a short-lived proof bound to the authenticated session. It never
 * creates a session, changes a credential, or returns a password/code.
 */

const ACTIVE = 'ACTIVE';

type StepUpAdmin = InstanceType<typeof PlatformAdmin> & {
  passwordHash?: string | null;
  totpSecretEncrypted?: string | null;
  mfaEnabled?: boolean;
  lastTotpCounter?: number;
  mfaLockedUntil?: Date | null;
};

export type PlatformStepUpProof = {
  stepUpToken: string;
  tokenExpiresAt: string | null;
  expiresIn: number;
  scope: string;
};

export async function createPlatformStepUpProof({
  adminId,
  jti,
  password,
  code,
  now = new Date(),
}: {
  adminId: string;
  jti: string;
  password: string;
  code: string;
  now?: Date;
}): Promise<PlatformStepUpProof> {
  if (typeof jti !== 'string' || !jti) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  if (typeof password !== 'string' || !password) {
    throw new ApiError(400, 'Current password is required', 'VALIDATION_ERROR');
  }
  if (typeof code !== 'string' || !code.trim()) {
    throw new ApiError(400, 'An authentication code is required', 'VALIDATION_ERROR');
  }

  const admin = (await PlatformAdmin.findById(adminId).select(
    'status passwordHash mfaEnabled lastTotpCounter mfaLockedUntil +totpSecretEncrypted',
  )) as StepUpAdmin | null;
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  if (!(await verifyPlatformPassword(password, admin.passwordHash))) {
    throw new ApiError(401, 'Current password is incorrect', 'PLATFORM_CURRENT_PASSWORD_INVALID');
  }
  if (!admin.mfaEnabled || !admin.totpSecretEncrypted) {
    throw new ApiError(
      409,
      'Multi-factor enrollment is required',
      'PLATFORM_MFA_ENROLLMENT_REQUIRED',
    );
  }
  assertPlatformMfaNotLocked(admin, now);

  const verification = verifyTotp(decryptPlatformSecret(admin.totpSecretEncrypted), code, {
    lastUsedCounter: admin.lastTotpCounter ?? 0,
  });
  if (!verification.valid) {
    if (verification.alreadyUsed) {
      // This is a correct code whose step has already been spent (most often by
      // the login that created this session). Do not call it invalid and do
      // not count it as a failed factor: the next authenticator step is what
      // the person needs.
      throw new ApiError(
        409,
        'That authentication code was already used. Wait for the next code and try again.',
        PLATFORM_MFA_CODE_ALREADY_USED,
      );
    }
    await recordPlatformMfaFailure(admin._id, now);
    throw new ApiError(401, 'Invalid authentication code', 'PLATFORM_MFA_INVALID');
  }

  // Spend the counter atomically. Two simultaneous proofs cannot both consume
  // the same TOTP step, and a step already used at login is refused.
  const advanced = await PlatformAdmin.updateOne(
    {
      _id: admin._id,
      status: ACTIVE,
      lastTotpCounter: { $lt: verification.counter },
    },
    { $set: { lastTotpCounter: verification.counter } },
  );
  if (advanced.modifiedCount !== 1) {
    await recordPlatformMfaFailure(admin._id, now);
    throw new ApiError(401, 'Invalid authentication code', 'PLATFORM_MFA_INVALID');
  }
  await resetPlatformMfaFailures(admin._id);

  const stepUpToken = signPlatformStepUpToken(
    String(admin._id),
    jti,
    PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE,
    PLATFORM_STEP_UP_TTL_SECONDS,
  );
  return {
    stepUpToken,
    tokenExpiresAt: platformTokenExpiresAt(stepUpToken),
    expiresIn: PLATFORM_STEP_UP_TTL_SECONDS,
    scope: PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE,
  };
}

export default {
  createPlatformStepUpProof,
};
