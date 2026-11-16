import bcrypt from 'bcryptjs';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import { normalizeEmail } from '../utils/validate.ts';
import { revokeAllPlatformSessionsForAdmin } from './platformSession.service.ts';
import {
  isPlatformRole,
  platformCapabilitiesFor,
  PLATFORM_ROLES,
} from '../constants/platformRoles.ts';
import {
  isPlatformAuthConfigured,
  signPlatformAccessToken,
  signPlatformMfaToken,
  PLATFORM_JWT_EXPIRES_IN,
  PLATFORM_MFA_PURPOSES,
  platformTokenExpiresAt,
} from '../config/platformJwt.ts';
import {
  assertPlatformMfaConfigured,
  PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
  PLATFORM_MFA_LOGIN_TTL_SECONDS,
} from '../config/platformSecurity.ts';

/**
 * PLAT-1 — platform administrator credentials and login.
 *
 * THIS IS A SEPARATE CREDENTIAL REALM. It reads `platform_admins` only; it never
 * loads a tenant `User`, never calls `assertActiveBusiness`, and never mints a
 * token with the tenant secret. A tenant password is not valid here and a
 * platform password is not valid on `/api/auth/login`.
 *
 * The interim credential is a local bcrypt password because the approved target
 * realm (dedicated Firebase project + mandatory WebAuthn/TOTP) cannot be
 * provisioned from this repository. That limitation is recorded in the platform
 * architecture document and is a release gate, not an implementation detail to
 * be forgotten: this plane must not be exposed publicly until the stronger
 * identity controls exist.
 */

const BCRYPT_ROUNDS = 10;
export const PLATFORM_PASSWORD_MIN_LENGTH = 16;
const ACTIVE = 'ACTIVE';

/**
 * Timing equalizer, never a credential. Compared against when an address is
 * unknown or an account has no hash, and the result is discarded; the guard
 * below refuses the login whenever the stored hash is absent, so the known
 * placeholder string can never authenticate.
 */
const DUMMY_HASH = bcrypt.hashSync('platform-timing-equalizer-placeholder', BCRYPT_ROUNDS);

export async function verifyPlatformPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  const hash = storedHash || null;
  const matches = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return hash !== null && matches;
}

export const PLATFORM_INVALID_CREDENTIALS_CODE = 'PLATFORM_INVALID_CREDENTIALS';
export const PLATFORM_INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

export type PublicPlatformAdmin = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
  mfaEnabled: boolean;
  webauthnCredentialCount: number;
  webauthnKeys: Array<{
    id: string;
    label: string;
    createdAt: string | null;
    lastUsedAt: string | null;
  }>;
  recoveryCodesRemaining: number;
};

/** The strict DTO the platform API returns. Never includes a hash or a session id. */
export function toPublicPlatformAdmin(
  admin: InstanceType<typeof PlatformAdmin>,
): PublicPlatformAdmin {
  return {
    id: String(admin._id),
    email: admin.email,
    name: admin.name,
    role: admin.role,
    status: admin.status,
    capabilities: platformCapabilitiesFor(admin.role),
    mfaEnabled: Boolean(admin.mfaEnabled),
    webauthnCredentialCount: Array.isArray(admin.webauthnCredentials)
      ? admin.webauthnCredentials.length
      : 0,
    webauthnKeys: Array.isArray(admin.webauthnCredentials)
      ? admin.webauthnCredentials.map((credential) => ({
          id: credential.credentialId,
          label: credential.label || 'Security key',
          createdAt: credential.createdAt ? credential.createdAt.toISOString() : null,
          lastUsedAt: credential.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
        }))
      : [],
    recoveryCodesRemaining: Array.isArray(admin.recoveryCodes)
      ? admin.recoveryCodes.filter((code) => !code.usedAt).length
      : 0,
  };
}

type CreatePlatformAdminInput = {
  email: unknown;
  name: unknown;
  password: unknown;
  role?: unknown;
};

/**
 * Create one platform administrator. Used by the bootstrap script and tests —
 * deliberately NOT exposed over HTTP. There is no self-service platform signup.
 */
export async function createPlatformAdminAccount({
  email,
  name,
  password,
  role = PLATFORM_ROLES.SUPERADMIN,
}: CreatePlatformAdminInput) {
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    throw new ApiError(400, 'A valid email address is required', 'VALIDATION_ERROR');
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new ApiError(400, 'A name is required', 'VALIDATION_ERROR');
  }
  if (typeof password !== 'string' || password.length < PLATFORM_PASSWORD_MIN_LENGTH) {
    throw new ApiError(
      400,
      `A platform administrator password must be at least ${PLATFORM_PASSWORD_MIN_LENGTH} characters`,
      'VALIDATION_ERROR',
    );
  }
  if (!isPlatformRole(role)) {
    throw new ApiError(400, 'Unknown platform role', 'VALIDATION_ERROR');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    return await PlatformAdmin.create({
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      role,
      status: ACTIVE,
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 11000) {
      throw new ApiError(
        409,
        'A platform administrator already uses that email address',
        'PLATFORM_ADMIN_EXISTS',
      );
    }
    throw err;
  }
}

type LoginInput = {
  email: unknown;
  password: unknown;
  deviceLabel?: unknown;
};

export type PlatformLoginChallenge =
  | {
      mfaEnrollmentRequired: true;
      mfaRequired: false;
      enrollmentToken: string;
      expiresIn: number;
      admin: PublicPlatformAdmin;
    }
  | {
      mfaEnrollmentRequired: false;
      mfaRequired: true;
      mfaToken: string;
      expiresIn: number;
      methods: Array<'totp' | 'webauthn' | 'recovery'>;
      admin: PublicPlatformAdmin;
    };

/**
 * Verify a platform credential and return an MFA challenge — NEVER a session.
 *
 * Every credential failure — unknown address, no stored hash, wrong password,
 * disabled account — answers the SAME 401. A platform login must not be an
 * oracle for which administrator addresses exist or which are disabled.
 *
 * MFA is mandatory: a password alone is not a login. On the first successful
 * password check the caller receives an enrollment challenge; on later logins
 * a login challenge that accepts TOTP or an enrolled WebAuthn credential.
 */
export async function loginPlatformAdmin({
  email,
  password,
}: LoginInput): Promise<PlatformLoginChallenge> {
  // Fail closed BEFORE looking at the credential. Otherwise an unconfigured
  // deployment would answer 401 for a wrong password and 503 for a right one,
  // turning a misconfiguration into a credential oracle.
  if (!isPlatformAuthConfigured()) {
    throw new ApiError(
      503,
      'Platform operations authentication is not configured',
      'PLATFORM_AUTH_NOT_CONFIGURED',
    );
  }
  // Password login is meaningless without the ability to complete MFA. Refuse
  // before checking the password for the same anti-oracle reason.
  assertPlatformMfaConfigured();

  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  const candidate = typeof password === 'string' ? password : '';

  const admin = normalizedEmail
          ? await PlatformAdmin.findOne({ email: normalizedEmail }).select(
        '+passwordHash +totpSecretEncrypted +webauthnCredentials +recoveryCodes',
      )
    : null;
  const matches = await verifyPlatformPassword(candidate, admin?.passwordHash);
  if (!admin || !matches || admin.status !== ACTIVE) {
    throw new ApiError(
      401,
      PLATFORM_INVALID_CREDENTIALS_MESSAGE,
      PLATFORM_INVALID_CREDENTIALS_CODE,
    );
  }

  if (!admin.mfaEnabled || !admin.totpSecretEncrypted) {
    return {
      mfaEnrollmentRequired: true,
      mfaRequired: false,
      enrollmentToken: signPlatformMfaToken(
        admin._id,
        PLATFORM_MFA_PURPOSES.ENROLL,
        PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
      ),
      expiresIn: PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
      admin: toPublicPlatformAdmin(admin),
    };
  }

  const methods: Array<'totp' | 'webauthn' | 'recovery'> = ['totp'];
  if ((admin.webauthnCredentials?.length ?? 0) > 0) methods.push('webauthn');
  if ((admin.recoveryCodes ?? []).some((code) => !code.usedAt)) methods.push('recovery');
  return {
    mfaEnrollmentRequired: false,
    mfaRequired: true,
    mfaToken: signPlatformMfaToken(
      admin._id,
      PLATFORM_MFA_PURPOSES.LOGIN,
      PLATFORM_MFA_LOGIN_TTL_SECONDS,
    ),
    expiresIn: PLATFORM_MFA_LOGIN_TTL_SECONDS,
    methods,
    admin: toPublicPlatformAdmin(admin),
  };
}

/**
 * Change the signed-in administrator's own password after proving the current
 * one. All platform sessions are revoked, including the caller's: a credential
 * change must not leave an old token able to read the platform plane. The
 * console clears its cookies when it receives this response.
 */
export async function changePlatformAdminPassword({
  adminId,
  currentPassword,
  newPassword,
  now = new Date(),
}: {
  adminId: string;
  currentPassword: unknown;
  newPassword: unknown;
  now?: Date;
}) {
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new ApiError(400, 'Current password is required', 'VALIDATION_ERROR');
  }
  if (typeof newPassword !== 'string' || newPassword.length < PLATFORM_PASSWORD_MIN_LENGTH) {
    throw new ApiError(
      400,
      `A platform administrator password must be at least ${PLATFORM_PASSWORD_MIN_LENGTH} characters`,
      'VALIDATION_ERROR',
    );
  }
  if (currentPassword === newPassword) {
    throw new ApiError(
      400,
      'The new password must be different from the current password',
      'VALIDATION_ERROR',
    );
  }

  const admin = await PlatformAdmin.findById(adminId).select('+passwordHash');
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  if (!(await verifyPlatformPassword(currentPassword, admin.passwordHash))) {
    throw new ApiError(401, 'Current password is incorrect', 'PLATFORM_CURRENT_PASSWORD_INVALID');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const updated = await PlatformAdmin.findOneAndUpdate(
    { _id: admin._id, status: ACTIVE },
    { $set: { passwordHash, passwordChangedAt: now } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  const revoked = await revokeAllPlatformSessionsForAdmin(admin._id, now);
  return { changedAt: now.toISOString(), sessionsRevoked: revoked.modifiedCount };
}

/**
 * Mint a fresh token for the SAME session. The absolute cap is not moved and no
 * session row is created, so renewal cannot make a platform session immortal.
 */
export function renewPlatformToken(adminId: string, jti: string) {
  const token = signPlatformAccessToken(adminId, jti);
  return {
    token,
    tokenType: 'Bearer' as const,
    expiresIn: PLATFORM_JWT_EXPIRES_IN,
    tokenExpiresAt: platformTokenExpiresAt(token),
  };
}

export default {
  PLATFORM_INVALID_CREDENTIALS_CODE,
  PLATFORM_INVALID_CREDENTIALS_MESSAGE,
  toPublicPlatformAdmin,
  createPlatformAdminAccount,
  loginPlatformAdmin,
  changePlatformAdminPassword,
  renewPlatformToken,
};
