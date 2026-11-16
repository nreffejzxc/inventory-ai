/**
 * The last-resort platform-administrator credential reset.
 *
 * This is intentionally reachable only from a guarded operator script, never
 * from an HTTP route. It is for the case where the only administrator has lost
 * the password, every TOTP/WebAuthn factor and every recovery code at once.
 * The operator who can run it already has database and deployment access, so it
 * does not create a new privilege boundary; it restores a known credential and
 * clears every stale factor so the normal login ceremony can start again.
 *
 * It is NOT a way to bypass a disabled account: `status` is left untouched, and
 * a disabled administrator still cannot authenticate afterwards.
 */
import bcrypt from 'bcryptjs';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import { normalizeEmail } from '../utils/validate.ts';
import { PLATFORM_PASSWORD_MIN_LENGTH } from './platformAuth.service.ts';
import { revokeAllPlatformSessionsForAdmin } from './platformSession.service.ts';
import { recordPlatformAudit } from './platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';

const BCRYPT_ROUNDS = 10;

export type BreakGlassInput = {
  email: string;
  newPassword: string;
  operator?: string;
  now?: Date;
};

export async function breakGlassPlatformAdmin({
  email,
  newPassword,
  operator = 'operator-cli',
  now = new Date(),
}: BreakGlassInput) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    throw new ApiError(400, 'A valid platform administrator email is required', 'VALIDATION_ERROR');
  }
  if (typeof newPassword !== 'string' || newPassword.length < PLATFORM_PASSWORD_MIN_LENGTH) {
    throw new ApiError(
      400,
      `The break-glass password must be at least ${PLATFORM_PASSWORD_MIN_LENGTH} characters`,
      'VALIDATION_ERROR',
    );
  }

  const admin = await PlatformAdmin.findOne({ email: normalizedEmail }).select(
    '+passwordHash +recoveryCodes +totpSecretEncrypted +webauthnCredentials +webauthnChallenges',
  );
  if (!admin) {
    throw new ApiError(404, 'No platform administrator uses that email address', 'PLATFORM_ADMIN_NOT_FOUND');
  }

  admin.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  admin.passwordChangedAt = now;
  admin.lastLoginAt = null;
  admin.mfaEnabled = false;
  admin.totpSecretEncrypted = null;
  admin.totpEnrolledAt = null;
  admin.lastTotpCounter = 0;
  // These three are Mongoose document arrays, not plain arrays.
  admin.set('recoveryCodes', []);
  admin.recoveryCodesGeneratedAt = null;
  admin.mfaFailedAttempts = 0;
  admin.mfaFailedWindowStartedAt = null;
  admin.mfaLockedUntil = null;
  admin.set('webauthnCredentials', []);
  admin.set('webauthnChallenges', []);
  await admin.save();

  const revoked = await revokeAllPlatformSessionsForAdmin(admin._id, now);
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.ADMIN_BREAK_GLASS_RESET,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: { email: operator },
    reason: 'operator_cli',
    metadata: {
      targetAdminId: String(admin._id),
      targetEmail: admin.email,
      targetStatus: admin.status,
      sessionsRevoked: revoked.modifiedCount,
    },
  });

  return {
    id: String(admin._id),
    email: admin.email,
    role: admin.role,
    status: admin.status,
    sessionsRevoked: revoked.modifiedCount,
    passwordChangedAt: now.toISOString(),
  };
}
