/**
 * Cookie helpers for the platform console session.
 *
 * The session token is HttpOnly. The CSRF token is intentionally readable by the
 * console so it can echo it in `X-Platform-CSRF`; neither cookie is readable by
 * a tenant origin, and both are host-only, SameSite=Strict and Secure in
 * production.
 */

import type { Request, Response } from 'express';

import {
  PLATFORM_CSRF_COOKIE,
  PLATFORM_CSRF_COOKIE_PATH,
  PLATFORM_SESSION_COOKIE,
  PLATFORM_SESSION_COOKIE_PATH,
  platformCookieSecure,
} from '../config/platformSecurity.ts';

type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAge?: number;
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function readPlatformCookie(req: Request, name: string): string {
  return parseCookies(req.headers.cookie)[name] || '';
}

function serialize(name: string, value: string, options: CookieOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.path) segments.push(`Path=${options.path}`);
  if (typeof options.maxAge === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) segments.push('HttpOnly');
  if (options.secure) segments.push('Secure');
  segments.push(`SameSite=${options.sameSite || 'Strict'}`);
  return segments.join('; ');
}

export function setPlatformSessionCookies(
  res: Response,
  session: { token: string; csrfToken: string; expiresIn: number },
): void {
  const maxAge = Math.max(1, Math.floor(session.expiresIn));
  res.append(
    'Set-Cookie',
    serialize(PLATFORM_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: platformCookieSecure(),
      sameSite: 'Strict',
      path: PLATFORM_SESSION_COOKIE_PATH,
      maxAge,
    }),
  );
  res.append(
    'Set-Cookie',
    serialize(PLATFORM_CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      secure: platformCookieSecure(),
      sameSite: 'Strict',
      path: PLATFORM_CSRF_COOKIE_PATH,
      maxAge,
    }),
  );
}

export function setPlatformCsrfCookie(res: Response, csrfToken: string, maxAge: number): void {
  res.append(
    'Set-Cookie',
    serialize(PLATFORM_CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: platformCookieSecure(),
      sameSite: 'Strict',
      path: PLATFORM_CSRF_COOKIE_PATH,
      maxAge: Math.max(1, Math.floor(maxAge)),
    }),
  );
}

export function clearPlatformSessionCookies(res: Response): void {
  res.append(
    'Set-Cookie',
    serialize(PLATFORM_SESSION_COOKIE, '', {
      httpOnly: true,
      secure: platformCookieSecure(),
      sameSite: 'Strict',
      path: PLATFORM_SESSION_COOKIE_PATH,
      maxAge: 0,
    }),
  );
  res.append(
    'Set-Cookie',
    serialize(PLATFORM_CSRF_COOKIE, '', {
      httpOnly: false,
      secure: platformCookieSecure(),
      sameSite: 'Strict',
      path: PLATFORM_CSRF_COOKIE_PATH,
      maxAge: 0,
    }),
  );
}

export default {
  parseCookies,
  readPlatformCookie,
  setPlatformSessionCookies,
  setPlatformCsrfCookie,
  clearPlatformSessionCookies,
};
