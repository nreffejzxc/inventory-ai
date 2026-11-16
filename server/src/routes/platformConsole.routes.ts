import { readFileSync } from 'node:fs';
import path from 'node:path';

import express, { Router } from 'express';

import { platformConsoleOrigin } from '../config/platformSecurity.ts';

const PUBLIC_DIR = path.join(import.meta.dirname, '../../platform-console/public');

function escapeForScript(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function originFor(req: { protocol: string; get(name: string): string | undefined }): string {
  try {
    const raw = `${req.protocol}://${req.get('host') || ''}`;
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    return parsed.origin;
  } catch {
    return platformConsoleOrigin();
  }
}

function securityHeaders(res: import('express').Response): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "manifest-src 'self'",
      "worker-src 'none'",
    ].join('; '),
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * PLAT-6 — the console served from the API's own origin at `/platform`.
 *
 * This is still a dedicated internal interface, not a tenant page. It shares an
 * origin only because the existing Render service is the infrastructure the
 * project already pays for; the API still requires the separate platform
 * identity, cookie, CSRF header and capability. Serving the static shell here is
 * what makes a production console possible without a second paid service.
 *
 * The assets remain the same files the loopback console server uses. Their HTML
 * references are root-absolute, so the document response rewrites only those
 * three paths to this mount. No inline script, style or event handler is added.
 */
const router = Router();

router.use((_req, res, next) => {
  securityHeaders(res);
  next();
});

router.get('/config.js', (req, res) => {
  const origin = originFor(req);
  const body = `window.__PLATFORM_CONSOLE__ = Object.freeze(${escapeForScript(
    JSON.stringify({ apiOrigin: origin, consoleOrigin: origin, sameOrigin: true }),
  )});\n`;
  res.type('application/javascript').send(body);
});

router.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: 'deny',
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders(res: import('express').Response) {
      res.setHeader('Cache-Control', 'no-store');
    },
  }),
);

router.get('/', (_req, res) => {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replaceAll('href="/styles.css"', 'href="/platform/styles.css"')
    .replaceAll('src="/config.js"', 'src="/platform/config.js"')
    .replaceAll('src="/app.js"', 'src="/platform/app.js"');
  res.type('html').send(html);
});

router.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

export default router;