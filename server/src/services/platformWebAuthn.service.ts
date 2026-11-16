/**
 * PLAT-3 — WebAuthn for platform administrators.
 *
 * TOTP is the mandatory first factor after the password. WebAuthn is an
 * additional enrolled method and an alternative to TOTP at login; it cannot be
 * used before TOTP enrollment. Registration requires an authenticated platform
 * session, so a stolen password alone cannot enroll a credential.
 *
 * Challenges are carried in short-lived, purpose-bound MFA tokens. They are
 * verified against the configured relying-party origin, and the user must be
 * verified (`requireUserVerification: true`) — a bare key touch is not enough.
 */

import crypto from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import {
  PLATFORM_MFA_PURPOSES,
  signPlatformMfaToken,
  verifyPlatformMfaToken,
} from '../config/platformJwt.ts';
import {
  PLATFORM_WEBAUTHN_TTL_SECONDS,
  platformWebAuthnConfig,
} from '../config/platformSecurity.ts';
import {
  decryptPlatformCredential,
  encryptPlatformCredential,
} from './platformMfa/secretVault.ts';
import {
  assertPlatformMfaNotLocked,
  completePlatformLogin,
  recordPlatformMfaFailure,
  resetPlatformMfaFailures,
  type PlatformSessionResult,
} from './platformMfa.service.ts';

const ACTIVE = 'ACTIVE';

type StoredCredential = {
  credentialId: string;
  publicKeyEncrypted: string;
  counter: number;
  transports?: string[];
  label?: string;
  createdAt?: Date;
  lastUsedAt?: Date | null;
};

type StoredChallenge = {
  challengeHash: string;
  expiresAt: Date;
};

type AdminWithCredentials = InstanceType<typeof PlatformAdmin> & {
  webauthnCredentials?: StoredCredential[] | null;
  webauthnChallenges?: StoredChallenge[] | null;
};

function challengeHash(challenge: string): string {
  return crypto.createHash('sha256').update(challenge).digest('hex');
}

export const PLATFORM_WEBAUTHN_NO_CREDENTIALS_CODE = 'PLATFORM_WEBAUTHN_NO_CREDENTIALS';
export const PLATFORM_WEBAUTHN_INVALID_CODE = 'PLATFORM_WEBAUTHN_INVALID';

function transports(value: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set([
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ]);
  return value
    .filter((item): item is string => typeof item === 'string' && allowed.has(item))
    .slice(0, 8) as AuthenticatorTransportFuture[];
}

function userIDFor(adminId: string): Uint8Array<ArrayBuffer> {
  const raw = Buffer.from(String(adminId), 'utf8');
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  output.set(raw);
  return output;
}

async function loadActiveAdmin(adminId: string): Promise<AdminWithCredentials> {
  const admin = (await PlatformAdmin.findById(adminId).select(
    '+webauthnCredentials +webauthnChallenges',
  )) as AdminWithCredentials | null;
  if (!admin || admin.status !== ACTIVE) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  return admin;
}

/** Registration is only available inside an authenticated platform session. */
export async function beginPlatformWebAuthnRegistration({
  adminId,
}: {
  adminId: string;
}) {
  const config = platformWebAuthnConfig();
  const admin = await loadActiveAdmin(adminId);
  const existing = admin.webauthnCredentials ?? [];
  if (existing.length >= 10) {
    throw new ApiError(
      409,
      'The maximum number of platform security keys is already registered',
      'PLATFORM_WEBAUTHN_LIMIT',
    );
  }
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: admin.email,
    userDisplayName: admin.name,
    userID: userIDFor(String(admin._id)),
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    timeout: PLATFORM_WEBAUTHN_TTL_SECONDS * 1000,
  });
  return {
    options,
    registrationToken: signPlatformMfaToken(
      admin._id,
      PLATFORM_MFA_PURPOSES.WEBAUTHN_REGISTER,
      PLATFORM_WEBAUTHN_TTL_SECONDS,
      { challenge: options.challenge },
    ),
    expiresIn: PLATFORM_WEBAUTHN_TTL_SECONDS,
  };
}

export async function finishPlatformWebAuthnRegistration({
  adminId,
  registrationToken,
  response,
  label,
}: {
  adminId: string;
  registrationToken: string;
  response: RegistrationResponseJSON;
  label?: unknown;
}) {
  const config = platformWebAuthnConfig();
  const claims = verifyPlatformMfaToken(
    registrationToken,
    PLATFORM_MFA_PURPOSES.WEBAUTHN_REGISTER,
  );
  if (claims.sub !== String(adminId)) {
    throw new ApiError(403, 'Platform capability required', 'PLATFORM_FORBIDDEN');
  }
  if (!claims.challenge) {
    throw new ApiError(400, 'Invalid registration challenge', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  if (!response || typeof response !== 'object') {
    throw new ApiError(400, 'Invalid registration response', PLATFORM_WEBAUTHN_INVALID_CODE);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new ApiError(400, 'Invalid registration response', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  if (!verification.verified) {
    throw new ApiError(400, 'Invalid registration response', PLATFORM_WEBAUTHN_INVALID_CODE);
  }

  const { credential } = verification.registrationInfo;
  const safeLabel =
    typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : 'Security key';
  const result = await PlatformAdmin.updateOne(
    {
      _id: adminId,
      status: ACTIVE,
      'webauthnCredentials.credentialId': { $ne: credential.id },
    },
    {
      $push: {
        webauthnCredentials: {
          credentialId: credential.id,
          publicKeyEncrypted: encryptPlatformCredential(credential.publicKey),
          counter: credential.counter,
          transports: transports(credential.transports),
          label: safeLabel,
          createdAt: new Date(),
          lastUsedAt: null,
        },
      },
    },
  );
  if (result.modifiedCount !== 1) {
    throw new ApiError(
      409,
      'That security key is already registered',
      PLATFORM_WEBAUTHN_INVALID_CODE,
    );
  }

  return {
    registered: true,
    credentialId: credential.id,
    label: safeLabel,
  };
}

/** Begin a WebAuthn assertion for an existing login challenge. */
export async function beginPlatformWebAuthnLogin({ mfaToken }: { mfaToken: string }) {
  const config = platformWebAuthnConfig();
  const claims = verifyPlatformMfaToken(mfaToken, PLATFORM_MFA_PURPOSES.LOGIN);
  const admin = await loadActiveAdmin(claims.sub!);
  assertPlatformMfaNotLocked(admin);
  const credentials = admin.webauthnCredentials ?? [];
  if (credentials.length === 0) {
    throw new ApiError(
      400,
      'No security key is registered for this platform administrator',
      PLATFORM_WEBAUTHN_NO_CREDENTIALS_CODE,
    );
  }
  if (!admin.mfaEnabled) {
    throw new ApiError(
      409,
      'Multi-factor enrollment is required',
      'PLATFORM_MFA_ENROLLMENT_REQUIRED',
    );
  }
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential.transports),
    })),
    userVerification: 'required',
    timeout: PLATFORM_WEBAUTHN_TTL_SECONDS * 1000,
  });
  const stored = await PlatformAdmin.updateOne(
    { _id: admin._id, status: ACTIVE },
    {
      $push: {
        webauthnChallenges: {
          $each: [
            {
              challengeHash: challengeHash(options.challenge),
              expiresAt: new Date(Date.now() + PLATFORM_WEBAUTHN_TTL_SECONDS * 1000),
            },
          ],
          // Bound the array without making an attacker with the password able
          // to evict a challenge a legitimate login is about to use: both
          // write to the tail, and the legitimate one is the newest.
          $slice: -10,
        },
      },
    },
  );
  if (stored.matchedCount !== 1) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_INVALID_TOKEN');
  }
  return {
    options,
    authenticationToken: signPlatformMfaToken(
      admin._id,
      PLATFORM_MFA_PURPOSES.WEBAUTHN_LOGIN,
      PLATFORM_WEBAUTHN_TTL_SECONDS,
      { challenge: options.challenge },
    ),
    expiresIn: PLATFORM_WEBAUTHN_TTL_SECONDS,
  };
}

/** Verify an assertion, advance the counter and open the platform session. */
export async function finishPlatformWebAuthnLogin({
  authenticationToken,
  response,
  deviceLabel,
}: {
  authenticationToken: string;
  response: AuthenticationResponseJSON;
  deviceLabel?: unknown;
}): Promise<PlatformSessionResult & { mfa: { method: 'webauthn' } }> {
  const config = platformWebAuthnConfig();
  const claims = verifyPlatformMfaToken(
    authenticationToken,
    PLATFORM_MFA_PURPOSES.WEBAUTHN_LOGIN,
  );
  if (!claims.challenge) {
    throw new ApiError(400, 'Invalid authentication challenge', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    throw new ApiError(400, 'Invalid authentication response', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  const admin = await loadActiveAdmin(claims.sub!);
  assertPlatformMfaNotLocked(admin);
  const credential = (admin.webauthnCredentials ?? []).find(
    (candidate) => candidate.credentialId === response.id,
  );
  if (!credential) {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid security key', PLATFORM_WEBAUTHN_INVALID_CODE);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: decryptPlatformCredential(credential.publicKeyEncrypted),
        counter: credential.counter,
        transports: transports(credential.transports),
      },
    });
  } catch {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid security key', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  if (!verification.verified) {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid security key', PLATFORM_WEBAUTHN_INVALID_CODE);
  }

  const now = new Date();
  // One atomic update both consumes the one-time challenge and advances the
  // signature counter. Two simultaneous copies of the same assertion therefore
  // cannot both open a session: the loser matches no challenge and is refused.
  const consumed = await PlatformAdmin.updateOne(
    {
      _id: admin._id,
      status: ACTIVE,
      'webauthnCredentials.credentialId': credential.credentialId,
      webauthnChallenges: {
        $elemMatch: {
          challengeHash: challengeHash(claims.challenge),
          expiresAt: { $gt: now },
        },
      },
    },
    {
      $set: {
        'webauthnCredentials.$[credential].counter': verification.authenticationInfo.newCounter,
        'webauthnCredentials.$[credential].lastUsedAt': now,
      },
      $pull: {
        webauthnChallenges: { challengeHash: challengeHash(claims.challenge) },
      },
    },
    { arrayFilters: [{ 'credential.credentialId': credential.credentialId }] },
  );
  if (consumed.modifiedCount !== 1) {
    await recordPlatformMfaFailure(admin._id);
    throw new ApiError(401, 'Invalid security key', PLATFORM_WEBAUTHN_INVALID_CODE);
  }
  await resetPlatformMfaFailures(admin._id);

  const session = await completePlatformLogin({ adminId: String(admin._id), deviceLabel });
  return { ...session, mfa: { method: 'webauthn' } };
}

export default {
  PLATFORM_WEBAUTHN_NO_CREDENTIALS_CODE,
  PLATFORM_WEBAUTHN_INVALID_CODE,
  beginPlatformWebAuthnRegistration,
  finishPlatformWebAuthnRegistration,
  beginPlatformWebAuthnLogin,
  finishPlatformWebAuthnLogin,
};
