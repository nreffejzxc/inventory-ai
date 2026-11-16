import crypto from 'node:crypto';

import type { Request, Response } from 'express';

import {
  loginPlatformAdmin,
  renewPlatformToken,
  type PublicPlatformAdmin,
} from '../services/platformAuth.service.ts';
import { revokePlatformSessionByJti } from '../services/platformSession.service.ts';
import { throwValidation } from '../utils/errors.ts';
import {
  clearPlatformSessionCookies,
  setPlatformCsrfCookie,
  setPlatformSessionCookies,
} from '../utils/platformCookies.ts';
import {
  isPlatformConsoleOrigin,
  isPlatformConsoleRequest,
} from '../config/platformSecurity.ts';
import ApiError from '../utils/ApiError.ts';
import { normalizeEmail } from '../utils/validate.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';

/**
 * PLAT-1/PLAT-2 — the platform authentication surface.
 *
 * Password login never returns an access token: it returns an MFA enrollment or
 * login challenge. Only the MFA/WebAuthn controllers create a session.
 *
 * The console is identified by `X-Platform-Console: 1` and receives an HttpOnly
 * session cookie plus a readable CSRF cookie. Its response deliberately omits
 * the bearer token, so the token exists in exactly one place the browser cannot
 * read. API clients keep the original Bearer response and need no CSRF.
 */

type SessionResult = {
  token: string;
  tokenType: 'Bearer';
  expiresIn: string;
  tokenExpiresAt: string | null;
  sessionExpiresAt: Date;
  admin: PublicPlatformAdmin;
  session: { id: string; expiresAt: Date };
};

const CONSOLE_TOKEN_TTL_SECONDS = 15 * 60;

export function newPlatformCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function assertConsoleRequestAllowed(req: Request): boolean {
  const consoleRequest = isPlatformConsoleRequest(req.headers);
  if (consoleRequest && !isPlatformConsoleOrigin(req.headers.origin)) {
    throw new ApiError(
      403,
      'The platform console must use its configured origin',
      'PLATFORM_ORIGIN_INVALID',
    );
  }
  return consoleRequest;
}

/**
 * Shape a completed login either as a console cookie response or a Bearer API
 * response. Shared by TOTP and WebAuthn completion.
 */
export function sendPlatformSession(
  req: Request,
  res: Response,
  result: SessionResult,
  mfa?: unknown,
): Response {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (assertConsoleRequestAllowed(req)) {
    const csrfToken = newPlatformCsrfToken();
    setPlatformSessionCookies(res, {
      token: result.token,
      csrfToken,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
    });
    return res.status(200).json({
      transport: 'cookie',
      csrfToken,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
      tokenExpiresAt: result.tokenExpiresAt,
      sessionExpiresAt: result.sessionExpiresAt,
      admin: result.admin,
      ...(mfa ? { mfa } : {}),
    });
  }
  return res.status(200).json({
    transport: 'bearer',
    token: result.token,
    tokenType: result.tokenType,
    expiresIn: result.expiresIn,
    tokenExpiresAt: result.tokenExpiresAt,
    sessionExpiresAt: result.sessionExpiresAt,
    admin: result.admin,
    ...(mfa ? { mfa } : {}),
  });
}

/** POST /api/platform/auth/login — password -> MFA challenge, never a session. */
export async function login(req: PlatformRequest, res: Response) {
  const body = req.body ?? {};
  const problems: Array<{ field: string; message: string }> = [];
  if (typeof body.email !== 'string' || !body.email.trim()) {
    problems.push({ field: 'email', message: 'Email is required' });
  }
  if (typeof body.password !== 'string' || !body.password) {
    problems.push({ field: 'password', message: 'Password is required' });
  }
  if (problems.length > 0) throwValidation(problems);

  let result;
  try {
    result = await loginPlatformAdmin({
      email: body.email,
      password: body.password,
    });
  } catch (err) {
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.LOGIN_FAILED,
      outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
      actor: {
        email: typeof body.email === 'string' ? normalizeEmail(body.email) : null,
      },
      reason: err instanceof ApiError ? String(err.code || 'login_failed') : 'login_failed',
      req,
    });
    throw err;
  }

  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.LOGIN_MFA_CHALLENGED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
    },
    reason: result.mfaEnrollmentRequired ? 'mfa_enrollment_required' : 'mfa_required',
    req,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.status(200).json(result);
}

/** POST /api/platform/auth/renew — fresh token for the SAME session. */
export async function renew(req: PlatformRequest, res: Response) {
  const renewed = renewPlatformToken(req.platformAdmin!.id, req.platformAuth!.jti);
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.SESSION_RENEWED,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: req.platformAdmin!.id,
      email: req.platformAdmin!.email,
      role: req.platformAdmin!.role,
    },
    req,
  });

  if (req.platformAuth!.mode === 'cookie') {
    const csrfToken = newPlatformCsrfToken();
    setPlatformSessionCookies(res, {
      token: renewed.token,
      csrfToken,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      transport: 'cookie',
      csrfToken,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
      tokenExpiresAt: renewed.tokenExpiresAt,
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ...renewed, transport: 'bearer' });
}

/** POST /api/platform/auth/logout — ends the current session and clears cookies. */
export async function logout(req: PlatformRequest, res: Response) {
  await revokePlatformSessionByJti({
    adminId: req.platformAdmin!.id,
    jti: req.platformAuth!.jti,
  });
  await recordPlatformAudit({
    action: PLATFORM_AUDIT_ACTIONS.LOGOUT,
    outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
    actor: {
      adminId: req.platformAdmin!.id,
      email: req.platformAdmin!.email,
      role: req.platformAdmin!.role,
    },
    req,
  });
  clearPlatformSessionCookies(res);
  return res.status(200).json({ message: 'Signed out' });
}

/**
 * GET /api/platform/auth/csrf — rotate and return the CSRF value for an existing
 * cookie session. Needed when the console is a different origin from the API:
 * the browser stores the API's `platform_csrf` cookie but the console's JS
 * cannot read it. The exact console Origin and SameSite=Strict still apply, and
 * the route is GET-only; every other cookie-auth request requires the header.
 */
export async function csrf(req: PlatformRequest, res: Response) {
  if (req.platformAuth!.mode !== 'cookie') {
    throw new ApiError(400, 'CSRF bootstrap is for the console cookie session', 'PLATFORM_COOKIE_REQUIRED');
  }
  const csrfToken = newPlatformCsrfToken();
  setPlatformCsrfCookie(res, csrfToken, CONSOLE_TOKEN_TTL_SECONDS);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ csrfToken });
}

/** GET /api/platform/auth/me — the server-authoritative platform principal. */
export async function me(req: PlatformRequest, res: Response) {
  return res.status(200).json({
    admin: req.platformAdmin,
    transport: req.platformAuth!.mode,
    ...(req.platformAuth!.mode === 'cookie' ? { csrfCookieName: 'platform_csrf' } : {}),
  });
}

export default { login, renew, logout, me, csrf, sendPlatformSession };
