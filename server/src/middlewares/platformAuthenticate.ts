import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import ApiError from '../utils/ApiError.ts';
import {
  isPlatformAuthConfigured,
  verifyPlatformAccessToken,
} from '../config/platformJwt.ts';
import { platformCapabilitiesFor } from '../constants/platformRoles.ts';
import {
  findPlatformSessionByJti,
  platformSessionState,
  touchPlatformSession,
  PLATFORM_SESSION_EXPIRED_CODE,
  PLATFORM_SESSION_EXPIRED_MESSAGE,
  PLATFORM_SESSION_REVOKED_CODE,
  PLATFORM_SESSION_REVOKED_MESSAGE,
} from '../services/platformSession.service.ts';
import {
  PLATFORM_CSRF_COOKIE,
  PLATFORM_CSRF_HEADER,
  PLATFORM_SESSION_COOKIE,
  isPlatformConsoleOrigin,
} from '../config/platformSecurity.ts';
import { readPlatformCookie } from '../utils/platformCookies.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';

/**
 * PLAT-1/PLAT-2 — platform authentication.
 *
 * This is the ONLY middleware that may attach a platform principal. It has
 * nothing in common with `requireAuth`:
 *
 *   * it verifies a token signed with `PLATFORM_ADMIN_JWT_SECRET`, and only for
 *     issuer `inventory-ai-platform` / audience `platform-admin`;
 *   * it loads a `PlatformAdmin`, never a tenant `User`;
 *   * it checks a `platform_admin_sessions` row, never a tenant `sessions` row;
 *   * it never reads or sets `req.user`, so a platform request can never satisfy
 *     a tenant route's `requireAuth`/`requirePermission` gate even if it somehow
 *     reached one.
 *
 * TWO CREDENTIAL CARRIERS:
 *   * `Authorization: Bearer <platform token>` — API clients. No CSRF is needed
 *     because a browser does not attach this header automatically.
 *   * `platform_session` HttpOnly cookie — the dedicated console. Cookie auth is
 *     accepted ONLY from the exact configured console origin and ONLY with an
 *     `X-Platform-CSRF` header matching the readable `platform_csrf` cookie.
 *     That pair defeats a cross-site form/fetch even if the browser sends the
 *     HttpOnly cookie; `SameSite=Strict` is the second layer.
 *
 * REJECTION CODES
 *   PLATFORM_AUTH_REQUIRED          no bearer token and no session cookie
 *   PLATFORM_AUTH_NOT_CONFIGURED    the platform secret is unset (503)
 *   PLATFORM_CSRF_ORIGIN            cookie auth from a foreign/missing Origin
 *   PLATFORM_CSRF_INVALID           missing or mismatched CSRF header
 *   PLATFORM_INVALID_TOKEN          forged / tenant / expired / wrong issuer or audience
 *   PLATFORM_ACCOUNT_DISABLED       the administrator row is not ACTIVE
 *   PLATFORM_SESSION_INVALIDATED    the credential changed after the token was minted
 *   PLATFORM_SESSION_REVOKED        no such session, or it was ended
 *   PLATFORM_SESSION_EXPIRED        idle or absolute lifetime passed
 */

export type PlatformPrincipal = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
  mfaEnabled: boolean;
  webauthnCredentialCount: number;
};

export type PlatformRequest = Request & {
  platformAdmin?: PlatformPrincipal;
  platformAuth?: { sessionId: string; jti: string; mode: 'bearer' | 'cookie' };
};

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hasBearerHeader(req: Request): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.length > 0;
}

function extractToken(req: Request): { token: string; mode: 'bearer' | 'cookie' } | null {
  if (hasBearerHeader(req)) {
    const [scheme, token] = String(req.headers.authorization).split(' ');
    if (scheme !== 'Bearer' || !token) return null;
    return { token, mode: 'bearer' };
  }
  const cookie = readPlatformCookie(req, PLATFORM_SESSION_COOKIE);
  if (!cookie) return null;
  return { token: cookie, mode: 'cookie' };
}

function assertConsoleCsrf(req: Request): void {
  if (!isPlatformConsoleOrigin(req.headers.origin)) {
    throw new ApiError(
      403,
      'Platform cookie requests must come from the configured console origin',
      'PLATFORM_CSRF_ORIGIN',
    );
  }
  // The console is a separate origin and cannot read a cookie set on the API
  // host. This one GET only issues a fresh CSRF value from an already-valid
  // cookie session; it is state-changing only in that cookie and is itself
  // protected by the exact Origin and SameSite=Strict. Every other platform
  // request still needs the double-submit header.
  if (
    req.method === 'GET' &&
    new URL(req.originalUrl, 'http://platform.invalid').pathname === '/api/platform/auth/csrf'
  ) {
    return;
  }
  const cookie = readPlatformCookie(req, PLATFORM_CSRF_COOKIE);
  const header = req.headers[PLATFORM_CSRF_HEADER];
  if (!cookie || typeof header !== 'string' || !header || !safeEqual(cookie, header)) {
    throw new ApiError(
      403,
      'Platform request is missing a valid CSRF token',
      'PLATFORM_CSRF_INVALID',
    );
  }
}

async function deny(
  req: PlatformRequest,
  _error: ApiError,
  reason: string,
  actor?: { id?: string; email?: string; role?: string } | null,
): Promise<void> {
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.ACCESS_DENIED,
    outcome: PLATFORM_AUDIT_OUTCOMES.DENIED,
    actor: actor
      ? { adminId: actor.id ?? null, email: actor.email ?? null, role: actor.role ?? null }
      : null,
    reason,
    req,
  });
}

export async function requirePlatformAdmin(
  req: PlatformRequest,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (!isPlatformAuthConfigured()) {
      throw new ApiError(
        503,
        'Platform operations authentication is not configured',
        'PLATFORM_AUTH_NOT_CONFIGURED',
      );
    }

    const extracted = extractToken(req);
    if (!extracted) {
      await deny(req, new ApiError(401, 'Platform authentication required', 'PLATFORM_AUTH_REQUIRED'), 'auth_required');
      throw new ApiError(401, 'Platform authentication required', 'PLATFORM_AUTH_REQUIRED');
    }

    if (extracted.mode === 'cookie') {
      try {
        assertConsoleCsrf(req);
      } catch (err) {
        if (err instanceof ApiError) {
          await deny(req, err, String(err.code || 'csrf_failed').toLowerCase());
        }
        throw err;
      }
    }

    let payload;
    try {
      payload = verifyPlatformAccessToken(extracted.token);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const error = new ApiError(401, 'Invalid platform token', 'PLATFORM_INVALID_TOKEN');
      await deny(req, error, 'invalid_token');
      throw error;
    }

    const adminId = payload?.sub;
    if (!adminId || !mongoose.isValidObjectId(adminId)) {
      const error = new ApiError(401, 'Invalid platform token', 'PLATFORM_INVALID_TOKEN');
      await deny(req, error, 'invalid_token');
      throw error;
    }
    const jti = payload?.jti;
    if (typeof jti !== 'string' || jti.length === 0) {
      const error = new ApiError(401, 'Invalid platform token', 'PLATFORM_INVALID_TOKEN');
      await deny(req, error, 'invalid_token');
      throw error;
    }

    const admin = await PlatformAdmin.findById(adminId).select(
      'name email role status passwordChangedAt mfaEnabled +webauthnCredentials',
    );
    if (!admin) {
      const error = new ApiError(401, 'Invalid platform token', 'PLATFORM_INVALID_TOKEN');
      await deny(req, error, 'invalid_token');
      throw error;
    }
    if (admin.status !== 'ACTIVE') {
      const error = new ApiError(
        403,
        'This platform administrator is disabled',
        'PLATFORM_ACCOUNT_DISABLED',
      );
      await deny(req, error, 'account_disabled', {
        id: String(admin._id),
        email: admin.email,
        role: admin.role,
      });
      throw error;
    }
    if (admin.passwordChangedAt) {
      const changedAtSec = Math.floor(admin.passwordChangedAt.getTime() / 1000);
      if ((payload?.iat ?? 0) < changedAtSec) {
        const error = new ApiError(
          401,
          'Platform session invalidated — please sign in again',
          'PLATFORM_SESSION_INVALIDATED',
        );
        await deny(req, error, 'session_invalidated', {
          id: String(admin._id),
          email: admin.email,
          role: admin.role,
        });
        throw error;
      }
    }

    const session = await findPlatformSessionByJti(jti);
    if (!session || String(session.adminId) !== String(admin._id)) {
      const error = new ApiError(
        401,
        PLATFORM_SESSION_REVOKED_MESSAGE,
        PLATFORM_SESSION_REVOKED_CODE,
      );
      await deny(req, error, 'session_revoked', {
        id: String(admin._id),
        email: admin.email,
        role: admin.role,
      });
      throw error;
    }
    const state = platformSessionState(session);
    if (state === 'revoked') {
      const error = new ApiError(
        401,
        PLATFORM_SESSION_REVOKED_MESSAGE,
        PLATFORM_SESSION_REVOKED_CODE,
      );
      await deny(req, error, 'session_revoked', {
        id: String(admin._id),
        email: admin.email,
        role: admin.role,
      });
      throw error;
    }
    if (state === 'expired') {
      const error = new ApiError(
        401,
        PLATFORM_SESSION_EXPIRED_MESSAGE,
        PLATFORM_SESSION_EXPIRED_CODE,
      );
      await deny(req, error, 'session_expired', {
        id: String(admin._id),
        email: admin.email,
        role: admin.role,
      });
      throw error;
    }

    await touchPlatformSession(session);

    req.platformAdmin = {
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
    };
    req.platformAuth = { sessionId: String(session._id), jti, mode: extracted.mode };
    return next();
  } catch (err) {
    return next(err);
  }
}

export default requirePlatformAdmin;
