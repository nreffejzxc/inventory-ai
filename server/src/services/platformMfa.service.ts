import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import {
  PLATFORM_MFA_PURPOSES,
  signPlatformMfaToken,
  verifyPlatformMfaToken,
  signPlatformAccessToken,
  platformTokenExpiresAt,
  PLATFORM_JWT_EXPIRES_IN,
} from '../config/platformJwt.ts';
import {
  assertPlatformMfaConfigured,
  PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
  PLATFORM_MFA_ISSUER,
} from '../config/platformSecurity.ts';
import { createPlatformSessionForToken, newPlatformSessionId } from './platformSession.service.ts';
import { decryptPlatformSecret, encryptPlatformSecret } from './platformMfa/secretVault.ts';
import { generateTotpSecret, totpUri, verifyTotp } from './platformMfa/totp.ts';
import type { PublicPlatformAdmin } from './platformAuth.service.ts';
import { toPublicPlatformAdmin } from './platformAuth.service.ts';

/**
 * PLAT-2 — mandatory platform multi-factor authentication.
 *
 * Password verification alone never returns an access token. It returns either
 * an enrollment challenge (first login) or a login challenge; only a confirmed
 * TOTP code or a WebAuthn assertion creates a platform session. Challenge tokens
 * are signed for a different audience and an explicit purpose, so they cannot
 * authenticate any `/api/platform` route.
 */

export const PLATFORM_MFA_INVALID_CODE = 'PLATFORM_MFA_INVALID';
export const PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE = 'PLATFORM_MFA_ENROLLMENT_REQUIRED';
export const PLATFORM_MFA_ALREADY_ENROLLED_CODE = 'PLATFORM_MFA_ALREADY_ENROLLED';

const ACTIVE = 'ACTIVE';

type AdminWithMfa = InstanceType<typeof PlatformAdmin> & {
  totpSecretEncrypted?: string | null;
  webauthnCredentials?: Array<{
    credentialId: string;
    counter: number;
    transports?: string[];
    label?: string;
    lastUsedAt?: Date | null;
  }> | null;
};

function assertActive(admin: AdminWithMfa | null): asserts admin is AdminWithMfa {
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
}

function assertChallengeIsCurrent(admin: AdminWithMfa, issuedAt: number | undefined): void {
  if (admin.passwordChangedAt) {
    const changedAt = Math.floor(admin.passwordChangedAt.getTime() / 1000);
    if ((issuedAt ?? 0) < changedAt) {
      throw new ApiError(
        401,
        'Platform authentication challenge expired — please sign in again',
        'PLATFORM_CHALLENGE_INVALID',
      );
    }
  }
}

export type PlatformSessionResult = {
  token: string;
  tokenType: 'Bearer';
  expiresIn: string;
  tokenExpiresAt: string | null;
  sessionExpiresAt: Date;
  admin: PublicPlatformAdmin;
  session: { id: string; expiresAt: Date };
};

/**
 * Finish a login after MFA. This is the only path that creates a platform
 * session, and it re-reads the administrator so a disable or a password change
 * during the five-minute challenge is honored.
 */
export async function completePlatformLogin({
  adminId,
  deviceLabel,
}: {
  adminId: string;
  deviceLabel?: unknown;
}): Promise<PlatformSessionResult> {
  const admin = (await PlatformAdmin.findById(adminId)) as AdminWithMfa | null;
  assertActive(admin);
  const jti = newPlatformSessionId();
  const token = signPlatformAccessToken(admin._id, jti);
  const session = await createPlatformSessionForToken({
    adminId: admin._id,
    token,
    deviceLabel,
  });
  await PlatformAdmin.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
  return {
    token,
    tokenType: 'Bearer',
    expiresIn: PLATFORM_JWT_EXPIRES_IN,
    tokenExpiresAt: platformTokenExpiresAt(token),
    sessionExpiresAt: session.expiresAt,
    admin: toPublicPlatformAdmin(admin),
    session: { id: String(session._id), expiresAt: session.expiresAt },
  };
}

export type EnrollmentStartResult = {
  enrollmentToken: string;
  expiresIn: number;
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
  admin: PublicPlatformAdmin;
};

/**
 * Begin TOTP enrollment. The secret is generated, encrypted and stored on the
 * administrator row immediately; the challenge token names the row, not the
 * secret, so the secret never travels in a JWT. Starting again before
 * confirmation replaces the pending secret (the previous one has never been
 * accepted as a second factor).
 */
export async function startPlatformMfaEnrollment({
  enrollmentToken,
}: {
  enrollmentToken: string;
}): Promise<EnrollmentStartResult> {
  assertPlatformMfaConfigured();
  const claims = verifyPlatformMfaToken(enrollmentToken, PLATFORM_MFA_PURPOSES.ENROLL);
  const admin = (await PlatformAdmin.findById(claims.sub).select(
    '+totpSecretEncrypted',
  )) as AdminWithMfa | null;
  assertActive(admin);
  assertChallengeIsCurrent(admin, claims.iat);
  if (admin.mfaEnabled) {
    throw new ApiError(
      409,
      'This platform administrator already has multi-factor authentication',
      PLATFORM_MFA_ALREADY_ENROLLED_CODE,
    );
  }

  const secret = generateTotpSecret();
  await PlatformAdmin.updateOne(
    { _id: admin._id, status: ACTIVE },
    {
      $set: {
        totpSecretEncrypted: encryptPlatformSecret(secret),
        totpEnrolledAt: null,
        mfaEnabled: false,
      },
    },
  );

  const fresh = await PlatformAdmin.findById(admin._id);
  assertActive(fresh);
  return {
    enrollmentToken: signPlatformMfaToken(
      admin._id,
      PLATFORM_MFA_PURPOSES.ENROLL,
      PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
    ),
    expiresIn: PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
    secret,
    otpauthUrl: totpUri({ secret, accountName: admin.email, issuer: PLATFORM_MFA_ISSUER }),
    issuer: PLATFORM_MFA_ISSUER,
    accountName: admin.email,
    admin: toPublicPlatformAdmin(fresh),
  };
}

export type MfaVerifyResult = PlatformSessionResult & {
  mfa: { method: 'totp'; enrolledAt: string | null };
};

/**
 * Confirm the first TOTP code. Only this path sets `mfaEnabled`. The atomic
 * filter makes two simultaneous confirmations impossible: the second one finds
 * `mfaEnabled` already true and is rejected as a stale challenge.
 */
export async function confirmPlatformMfaEnrollment({
  enrollmentToken,
  code,
  deviceLabel,
}: {
  enrollmentToken: string;
  code: string;
  deviceLabel?: unknown;
}): Promise<MfaVerifyResult> {
  assertPlatformMfaConfigured();
  const claims = verifyPlatformMfaToken(enrollmentToken, PLATFORM_MFA_PURPOSES.ENROLL);
  const admin = (await PlatformAdmin.findById(claims.sub).select(
    '+totpSecretEncrypted',
  )) as AdminWithMfa | null;
  assertActive(admin);
  assertChallengeIsCurrent(admin, claims.iat);
  if (admin.mfaEnabled) {
    throw new ApiError(
      409,
      'This platform administrator already has multi-factor authentication',
      PLATFORM_MFA_ALREADY_ENROLLED_CODE,
    );
  }
  if (!admin.totpSecretEncrypted) {
    throw new ApiError(
      409,
      'Start multi-factor enrollment again',
      PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE,
    );
  }

  const verification = verifyTotp(decryptPlatformSecret(admin.totpSecretEncrypted), code, {
    lastUsedCounter: 0,
  });
  if (!verification.valid) {
    throw new ApiError(401, 'Invalid authentication code', PLATFORM_MFA_INVALID_CODE);
  }

  const now = new Date();
  const updated = await PlatformAdmin.findOneAndUpdate(
    {
      _id: admin._id,
      status: ACTIVE,
      mfaEnabled: false,
      lastTotpCounter: { $lt: verification.counter },
    },
    {
      $set: {
        mfaEnabled: true,
        totpEnrolledAt: now,
        lastTotpCounter: verification.counter,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new ApiError(401, 'Invalid authentication code', PLATFORM_MFA_INVALID_CODE);
  }

  const session = await completePlatformLogin({ adminId: String(admin._id), deviceLabel });
  return {
    ...session,
    mfa: { method: 'totp', enrolledAt: now.toISOString() },
  };
}

/** Verify a TOTP code for an existing MFA enrollment and open a session. */
export async function verifyPlatformMfaLogin({
  mfaToken,
  code,
  deviceLabel,
}: {
  mfaToken: string;
  code: string;
  deviceLabel?: unknown;
}): Promise<MfaVerifyResult> {
  assertPlatformMfaConfigured();
  const claims = verifyPlatformMfaToken(mfaToken, PLATFORM_MFA_PURPOSES.LOGIN);
  const admin = (await PlatformAdmin.findById(claims.sub).select(
    '+totpSecretEncrypted +webauthnCredentials',
  )) as AdminWithMfa | null;
  assertActive(admin);
  assertChallengeIsCurrent(admin, claims.iat);
  if (!admin.mfaEnabled || !admin.totpSecretEncrypted) {
    throw new ApiError(
      409,
      'Multi-factor enrollment is required',
      PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE,
    );
  }

  const verification = verifyTotp(decryptPlatformSecret(admin.totpSecretEncrypted), code, {
    lastUsedCounter: admin.lastTotpCounter ?? 0,
  });
  if (!verification.valid) {
    throw new ApiError(401, 'Invalid authentication code', PLATFORM_MFA_INVALID_CODE);
  }

  // Atomic replay guard. A code accepted by another request in the same step
  // has already advanced lastTotpCounter, so this update matches nothing.
  const updated = await PlatformAdmin.findOneAndUpdate(
    {
      _id: admin._id,
      status: ACTIVE,
      lastTotpCounter: { $lt: verification.counter },
    },
    { $set: { lastTotpCounter: verification.counter } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new ApiError(401, 'Invalid authentication code', PLATFORM_MFA_INVALID_CODE);
  }

  const session = await completePlatformLogin({ adminId: String(admin._id), deviceLabel });
  return {
    ...session,
    mfa: { method: 'totp', enrolledAt: admin.totpEnrolledAt?.toISOString() ?? null },
  };
}

export default {
  PLATFORM_MFA_INVALID_CODE,
  PLATFORM_MFA_ENROLLMENT_REQUIRED_CODE,
  PLATFORM_MFA_ALREADY_ENROLLED_CODE,
  startPlatformMfaEnrollment,
  confirmPlatformMfaEnrollment,
  verifyPlatformMfaLogin,
  completePlatformLogin,
};
