import jwt from 'jsonwebtoken';

import ApiError from '../utils/ApiError.ts';

/**
 * Platform Operations — a JWT plane that is SEPARATE from tenant access tokens.
 *
 * WHY A SECOND SECRET AND A SECOND AUDIENCE. The tenant plane signs with
 * `JWT_SECRET` and validates `issuer=inventory-ai`, `audience=inventory-ai-api`.
 * A platform token is signed with `PLATFORM_ADMIN_JWT_SECRET` and validates
 * `issuer=inventory-ai-platform`, `audience=platform-admin`. All three differ,
 * so a tenant token cannot verify here even if a routing mistake mounts a
 * platform route behind the tenant middleware — and a platform token cannot
 * verify on any tenant route.
 *
 * The issuer and audience are FIXED CONSTANTS rather than environment variables.
 * That is deliberate: an operator cannot accidentally set them equal to the
 * tenant values (or to each other) and collapse the boundary. Only the secret is
 * configuration, and it is never allowed to equal the tenant secret (see
 * config/validateConfig.ts).
 *
 * FAIL CLOSED, NEVER FALL BACK. If `PLATFORM_ADMIN_JWT_SECRET` is unset, the
 * platform endpoints answer 503 `PLATFORM_AUTH_NOT_CONFIGURED`. There is no
 * fallback to `JWT_SECRET`: a fallback would make every tenant deployment a
 * platform deployment by accident, which is the exact boundary this module
 * exists to keep.
 */

export const PLATFORM_JWT_ISSUER = 'inventory-ai-platform';
export const PLATFORM_JWT_AUDIENCE = 'platform-admin';
export const PLATFORM_MFA_AUDIENCE = 'platform-admin-mfa';
export const PLATFORM_JWT_ALGORITHM = 'HS256';

export const PLATFORM_MFA_PURPOSES = Object.freeze({
  ENROLL: 'mfa-enroll',
  LOGIN: 'mfa-login',
  WEBAUTHN_LOGIN: 'webauthn-login',
  WEBAUTHN_REGISTER: 'webauthn-register',
});

/**
 * Access-token lifetime. Short on purpose: the server-side platform session is
 * the durable half (8-hour absolute cap, 15-minute idle timeout) and this token
 * only has to outlive a working interval. `POST /api/platform/auth/renew` mints
 * a fresh token for the SAME session without extending the session cap.
 */
export const PLATFORM_JWT_EXPIRES_IN = '15m';

export type PlatformTokenClaims = {
  sub?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
};

export type PlatformMfaClaims = PlatformTokenClaims & {
  purpose?: string;
  challenge?: string;
};

function configuredSecret(): string {
  return (process.env.PLATFORM_ADMIN_JWT_SECRET || '').trim();
}

export function isPlatformAuthConfigured(): boolean {
  return Boolean(configuredSecret());
}

function platformSecret(): string {
  const secret = configuredSecret();
  if (!secret) {
    throw new ApiError(
      503,
      'Platform operations authentication is not configured',
      'PLATFORM_AUTH_NOT_CONFIGURED',
    );
  }
  return secret;
}

/** Sign a platform access token. `jti` is mandatory and names a session row. */
export function signPlatformAccessToken(adminId: unknown, jti: string): string {
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new ApiError(
      500,
      'A session id is required to sign a platform access token',
      'PLATFORM_SESSION_ID_REQUIRED',
    );
  }
  return jwt.sign({ sub: String(adminId), jti }, platformSecret(), {
    algorithm: PLATFORM_JWT_ALGORITHM,
    expiresIn: PLATFORM_JWT_EXPIRES_IN,
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_JWT_AUDIENCE,
  });
}

/**
 * Verify a platform token. Signature, algorithm, expiry, issuer and audience are
 * all enforced by jsonwebtoken; a tenant token fails on the secret first, and a
 * token minted for another application fails on issuer/audience.
 */
export function verifyPlatformAccessToken(token: string): PlatformTokenClaims {
  return jwt.verify(token, platformSecret(), {
    algorithms: [PLATFORM_JWT_ALGORITHM],
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_JWT_AUDIENCE,
  }) as PlatformTokenClaims;
}

/**
 * Read the claims of an ALREADY-TRUSTED token without verifying it. Used right
 * after signing, to read back the `jti` the library embedded. Never use this to
 * authenticate a request: `verifyPlatformAccessToken` is the only entry point
 * for an untrusted token.
 */
export function decodePlatformAccessToken(token: string): PlatformTokenClaims | null {
  return jwt.decode(token) as PlatformTokenClaims | null;
}

/**
 * Sign a short-lived MFA or WebAuthn challenge token.
 *
 * These are NOT access tokens: they use a different audience, carry an explicit
 * purpose, and `verifyPlatformMfaToken` refuses a normal platform access token
 * as well as a token minted for a different step. A challenge token cannot
 * authenticate `/api/platform/operations` because `requirePlatformAdmin`
 * verifies the access-token audience, not this one.
 */
export function signPlatformMfaToken(
  adminId: unknown,
  purpose: string,
  expiresInSeconds: number,
  extra: { challenge?: string } = {},
): string {
  return jwt.sign(
    {
      sub: String(adminId),
      purpose,
      ...(extra.challenge ? { challenge: extra.challenge } : {}),
    },
    platformSecret(),
    {
      algorithm: PLATFORM_JWT_ALGORITHM,
      expiresIn: expiresInSeconds,
      issuer: PLATFORM_JWT_ISSUER,
      audience: PLATFORM_MFA_AUDIENCE,
    },
  );
}

export function verifyPlatformMfaToken(
  token: string,
  expectedPurpose: string,
): PlatformMfaClaims {
  const claims = jwt.verify(token, platformSecret(), {
    algorithms: [PLATFORM_JWT_ALGORITHM],
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_MFA_AUDIENCE,
  }) as PlatformMfaClaims;
  if (claims.purpose !== expectedPurpose || !claims.sub) {
    throw new ApiError(401, 'Invalid platform challenge', 'PLATFORM_CHALLENGE_INVALID');
  }
  return claims;
}

/** Absolute expiry of a just-signed token, for the login/renew response. */
export function platformTokenExpiresAt(token: string): string | null {
  const payload = jwt.decode(token) as PlatformTokenClaims | null;
  if (typeof payload?.exp !== 'number') return null;
  return new Date(payload.exp * 1000).toISOString();
}

export default {
  PLATFORM_JWT_ISSUER,
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_MFA_AUDIENCE,
  PLATFORM_JWT_EXPIRES_IN,
  PLATFORM_MFA_PURPOSES,
  isPlatformAuthConfigured,
  signPlatformAccessToken,
  verifyPlatformAccessToken,
  signPlatformMfaToken,
  verifyPlatformMfaToken,
  decodePlatformAccessToken,
  platformTokenExpiresAt,
};
