/**
 * Configuration for the INTERNAL Platform Operations security additions.
 *
 * Everything here is separate from tenant authentication. The platform plane
 * has its own JWT secret, its own MFA encryption key, its own WebAuthn relying
 * party and its own console origin. A missing platform security value fails
 * closed; it never falls back to a tenant value.
 */

import crypto from 'node:crypto';

import ApiError from '../utils/ApiError.ts';

export const PLATFORM_SESSION_COOKIE = 'platform_session';
export const PLATFORM_CSRF_COOKIE = 'platform_csrf';
export const PLATFORM_CSRF_HEADER = 'x-platform-csrf';
export const PLATFORM_CONSOLE_HEADER = 'x-platform-console';
export const PLATFORM_SESSION_COOKIE_PATH = '/api/platform';
export const PLATFORM_CSRF_COOKIE_PATH = '/';

/** MFA challenge lifetimes are deliberately very short. */
export const PLATFORM_MFA_ENROLLMENT_TTL_SECONDS = 10 * 60;
export const PLATFORM_MFA_LOGIN_TTL_SECONDS = 5 * 60;
export const PLATFORM_WEBAUTHN_TTL_SECONDS = 5 * 60;

export const PLATFORM_MFA_ISSUER = 'Inventory AI Platform';
export const PLATFORM_WEBAUTHN_RP_NAME = 'Inventory AI Platform';

export const PLATFORM_MFA_NOT_CONFIGURED_CODE = 'PLATFORM_MFA_NOT_CONFIGURED';
export const PLATFORM_MFA_NOT_CONFIGURED_MESSAGE =
  'Platform multi-factor authentication is not configured';

export const PLATFORM_WEBAUTHN_NOT_CONFIGURED_CODE = 'PLATFORM_WEBAUTHN_NOT_CONFIGURED';
export const PLATFORM_WEBAUTHN_NOT_CONFIGURED_MESSAGE =
  'Platform WebAuthn is not configured';

function trimmed(name: string): string {
  return (process.env[name] || '').trim();
}

function loopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Parse a configured browser origin and fail closed on anything that is not a
 * bare http(s) origin. Plain HTTP is accepted only for loopback development;
 * every non-loopback value must be HTTPS. A path, query, fragment or userinfo
 * is refused even when it happens to parse as a URL — WebAuthn's expected
 * origin and a cookie's origin boundary are compared as exact values.
 */
function parsePlatformOrigin(candidate: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ApiError(
      503,
      `${variable} must be a valid http(s) origin`,
      'PLATFORM_ORIGIN_INVALID',
    );
  }
  const loopback = loopbackHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new ApiError(
      503,
      `${variable} must use https outside loopback development`,
      'PLATFORM_ORIGIN_INVALID',
    );
  }
  if (
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new ApiError(
      503,
      `${variable} must be a bare origin without a path, query, fragment or userinfo`,
      'PLATFORM_ORIGIN_INVALID',
    );
  }
  return parsed.origin;
}

/** The console is a browser origin, never a wildcard. */
export function platformConsoleOrigin(): string {
  // `localhost` rather than the IP: a browser treats loopback as a secure
  // context and WebAuthn accepts it as an RP ID, while a raw IP is commonly
  // refused by authenticators. The console listener still binds 127.0.0.1.
  return parsePlatformOrigin(
    trimmed('PLATFORM_CONSOLE_ORIGIN') || 'http://localhost:4100',
    'PLATFORM_CONSOLE_ORIGIN',
  );
}

export function isPlatformConsoleOrigin(origin: unknown): boolean {
  return typeof origin === 'string' && origin.replace(/\/+$/, '') === platformConsoleOrigin();
}

/** True only when the request explicitly identifies itself as the console client. */
export function isPlatformConsoleRequest(headers: { [key: string]: unknown }): boolean {
  return String(headers[PLATFORM_CONSOLE_HEADER] || '').trim() === '1';
}

export function platformCookieSecure(): boolean {
  // A missing NODE_ENV must not silently downgrade a deployed console to a
  // non-Secure cookie. Secure is the default for an unknown environment; only
  // the explicitly local development/test environments may omit it on loopback
  // HTTP. An invalid origin also fails closed (Secure) rather than open.
  const environment = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (environment === 'production') return true;
  try {
    const https = new URL(platformConsoleOrigin()).protocol === 'https:';
    if (https) return true;
    return environment !== 'development' && environment !== 'test';
  } catch {
    return true;
  }
}

export function isPlatformMfaConfigured(): boolean {
  return trimmed('PLATFORM_MFA_ENCRYPTION_KEY').length > 0;
}

export function assertPlatformMfaConfigured(): void {
  if (!isPlatformMfaConfigured()) {
    throw new ApiError(
      503,
      PLATFORM_MFA_NOT_CONFIGURED_MESSAGE,
      PLATFORM_MFA_NOT_CONFIGURED_CODE,
    );
  }
}

/**
 * Derive a 32-byte AES key from the operator's MFA encryption secret.
 *
 * HKDF is used with a fixed, non-secret salt/context so the same operator value
 * always produces the same key on every process. The secret itself never enters
 * a database row.
 */
export function platformMfaEncryptionKey(): Buffer {
  assertPlatformMfaConfigured();
  const secret = trimmed('PLATFORM_MFA_ENCRYPTION_KEY');
  if (secret.length < 32) {
    throw new ApiError(
      503,
      PLATFORM_MFA_NOT_CONFIGURED_MESSAGE,
      PLATFORM_MFA_NOT_CONFIGURED_CODE,
    );
  }
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('inventory-ai-platform-mfa-salt', 'utf8'),
      Buffer.from('inventory-ai-platform-mfa-v1', 'utf8'),
      32,
    ),
  );
}

export type PlatformWebAuthnConfig = {
  rpID: string;
  rpName: string;
  origin: string;
};

/**
 * WebAuthn relying-party configuration. The default is the loopback console;
 * production must set both values and use HTTPS.
 */
export function platformWebAuthnConfig(): PlatformWebAuthnConfig {
  let origin: string;
  try {
    origin = parsePlatformOrigin(
      trimmed('PLATFORM_WEBAUTHN_ORIGIN') || platformConsoleOrigin(),
      'PLATFORM_WEBAUTHN_ORIGIN',
    );
  } catch {
    throw new ApiError(
      503,
      PLATFORM_WEBAUTHN_NOT_CONFIGURED_MESSAGE,
      PLATFORM_WEBAUTHN_NOT_CONFIGURED_CODE,
    );
  }
  const parsed = new URL(origin);
  const rpID = trimmed('PLATFORM_WEBAUTHN_RP_ID') || parsed.hostname;
  if (
    !rpID ||
    rpID.includes('/') ||
    rpID.includes(':') ||
    !/^[a-z0-9.-]+$/i.test(rpID) ||
    (rpID !== parsed.hostname && !parsed.hostname.endsWith(`.${rpID}`))
  ) {
    throw new ApiError(
      503,
      PLATFORM_WEBAUTHN_NOT_CONFIGURED_MESSAGE,
      PLATFORM_WEBAUTHN_NOT_CONFIGURED_CODE,
    );
  }
  return {
    rpID,
    rpName: trimmed('PLATFORM_WEBAUTHN_RP_NAME') || PLATFORM_WEBAUTHN_RP_NAME,
    origin,
  };
}

export default {
  PLATFORM_SESSION_COOKIE,
  PLATFORM_CSRF_COOKIE,
  PLATFORM_CSRF_HEADER,
  PLATFORM_CONSOLE_HEADER,
  PLATFORM_SESSION_COOKIE_PATH,
  PLATFORM_CSRF_COOKIE_PATH,
  PLATFORM_MFA_ENROLLMENT_TTL_SECONDS,
  PLATFORM_MFA_LOGIN_TTL_SECONDS,
  PLATFORM_WEBAUTHN_TTL_SECONDS,
  PLATFORM_MFA_ISSUER,
  platformConsoleOrigin,
  isPlatformConsoleOrigin,
  isPlatformConsoleRequest,
  platformCookieSecure,
  isPlatformMfaConfigured,
  assertPlatformMfaConfigured,
  platformMfaEncryptionKey,
  platformWebAuthnConfig,
};
