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

import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';

export const PLATFORM_ACCESS_REQUIRED_CODE = 'PLATFORM_ACCESS_REQUIRED';
export const PLATFORM_ACCESS_RATE_LIMITED_CODE = 'PLATFORM_ACCESS_RATE_LIMITED';
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

export type PlatformAccessGateLimits = {
  windowMs: number;
  maxFailures: number;
  globalMaxFailures: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read the failure budget at request time so tests and operators can tune it. */
export function platformAccessGateLimits(): PlatformAccessGateLimits {
  return {
    windowMs: positiveInt(process.env.PLATFORM_ACCESS_GATE_WINDOW_MS, 15 * 60 * 1000),
    maxFailures: positiveInt(process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES, 20),
    globalMaxFailures: positiveInt(
      process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES,
      200,
    ),
  };
}

/**
 * One failure window governs both dimensions, so an address needs only its
 * count. The map is cleared whenever the window resets and can never grow past
 * the global failure cap.
 */
const failuresByAddress = new Map<string, number>();
let globalFailures = 0;
let globalResetAt = 0;

/** Reset the process-local failure windows. Exported for deterministic tests. */
export function resetPlatformAccessGateLimiter(): void {
  failuresByAddress.clear();
  globalFailures = 0;
  globalResetAt = 0;
}

/** Test-only visibility into the bounded state. Never exposed by the server. */
export function platformAccessGateStateForTests(): {
  trackedAddresses: number;
  globalFailures: number;
} {
  return { trackedAddresses: failuresByAddress.size, globalFailures };
}

function failureAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function registerGateFailure(address: string, now: number, limits: PlatformAccessGateLimits) {
  if (globalResetAt <= now) {
    failuresByAddress.clear();
    globalFailures = 0;
    globalResetAt = now + limits.windowMs;
  }

  // Once the shared budget is exhausted, stop creating per-address state and
  // stop writing audit rows. A valid key was already accepted above this path.
  if (globalFailures >= limits.globalMaxFailures) {
    return {
      limited: true,
      shouldAudit: false,
      retryAfterSeconds: Math.max(1, Math.ceil((globalResetAt - now) / 1000)),
      failures: 0,
    };
  }

  const failures = (failuresByAddress.get(address) ?? 0) + 1;
  failuresByAddress.set(address, failures);
  globalFailures += 1;

  return {
    limited: failures > limits.maxFailures,
    shouldAudit: failures === 1,
    retryAfterSeconds: Math.max(1, Math.ceil((globalResetAt - now) / 1000)),
    failures,
  };
}

async function recordGateDenial(
  req: Request,
  result: ReturnType<typeof registerGateFailure>,
): Promise<void> {
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.ACCESS_GATE_DENIED,
    outcome: PLATFORM_AUDIT_OUTCOMES.DENIED,
    reason: 'outer_access_gate',
    metadata: {
      gate: 'basic',
      limited: result.limited,
      failuresInWindow: result.failures,
    },
    req,
  });
}

export default async function platformAccessGate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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
  const suppliedKeyIsValid =
    headerAllowed ||
    Boolean(
      supplied &&
        safeEqual(supplied.user, platformAccessUser()) &&
        safeEqual(supplied.key, configuredKey),
    );

  if (!suppliedKeyIsValid) {
    const result = registerGateFailure(
      failureAddress(req),
      Date.now(),
      platformAccessGateLimits(),
    );
    if (result.shouldAudit) await recordGateDenial(req, result);

    res.setHeader('WWW-Authenticate', 'Basic realm="Platform Operations", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    if (result.limited) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many platform access key failures',
        code: PLATFORM_ACCESS_RATE_LIMITED_CODE,
      });
      return;
    }

    res.status(401).json({
      error: 'Platform access key required',
      code: PLATFORM_ACCESS_REQUIRED_CODE,
    });
    return;
  }

  next();
}
