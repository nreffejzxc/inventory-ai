/**
 * The free-plan access gate in front of the Platform Operations console.
 *
 * Render's free plan cannot attach an inbound IP allowlist to a web service —
 * that is a Scale/Enterprise feature. This middleware is the free equivalent:
 * when `PLATFORM_ACCESS_KEY` is set, every `/platform` and `/api/platform`
 * request must also carry HTTP Basic credentials, before the platform login is
 * even reachable. Production validation refuses to boot when the platform
 * plane is configured without this key, so the gate cannot silently disappear.
 *
 * This is deliberately a SHARED access gate, not an identity. The administrator
 * password, TOTP and WebAuthn still protect the console; the access key only
 * stops an anonymous visitor or scanner at the outer door. It is not a
 * substitute for network-level isolation, which remains a later hosting upgrade.
 */
import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export const PLATFORM_ACCESS_REQUIRED_CODE = 'PLATFORM_ACCESS_REQUIRED';
export const PLATFORM_ACCESS_KEY_MIN_LENGTH = 32;

/**
 * API clients carry a platform Bearer token in `Authorization`, so they cannot
 * also send Basic there. This header carries the same shared gate key beside the
 * Bearer token; the browser console uses the standard Basic challenge instead.
 */
export const PLATFORM_ACCESS_HEADER = 'x-platform-access-key';

export function platformAccessKey(): string {
  const value = process.env.PLATFORM_ACCESS_KEY;
  return typeof value === 'string' ? value.trim() : '';
}

export function platformAccessUser(): string {
  const value = process.env.PLATFORM_ACCESS_USER;
  return typeof value === 'string' && value.trim() ? value.trim() : 'platform';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Parse one Basic credential pair. Only the first colon separates the user from
 * the key (the generated key is base64url and contains none), and a malformed
 * header is simply a missing credential.
 */
export function parsePlatformBasicAuth(
  header: string | undefined,
): { user: string; key: string } | null {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  return { user: decoded.slice(0, separator), key: decoded.slice(separator + 1) };
}

export default function platformAccessGate(req: Request, res: Response, next: NextFunction) {
  const configuredKey = platformAccessKey();
  // Local development and the test suite run without this gate. Production
  // validation makes the key mandatory for a configured platform plane.
  if (!configuredKey) {
    next();
    return;
  }

  // A CORS preflight never carries credentials and reveals nothing. Letting it
  // through keeps the platform API usable from an explicitly allowed console
  // origin; the actual request is still gated below.
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  const supplied = parsePlatformBasicAuth(req.headers.authorization);
  const headerKey = req.headers[PLATFORM_ACCESS_HEADER];
  const headerAllowed =
    typeof headerKey === 'string' && headerKey.length > 0 && safeEqual(headerKey, configuredKey);
  if (
    !headerAllowed &&
    (!supplied ||
      !safeEqual(supplied.user, platformAccessUser()) ||
      !safeEqual(supplied.key, configuredKey))
  ) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Platform Operations", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({
      error: 'Platform access key required',
      code: PLATFORM_ACCESS_REQUIRED_CODE,
    });
    return;
  }

  next();
}
