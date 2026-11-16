/**
 * The dedicated INTERNAL Platform Operations console.
 *
 * This is a SEPARATE static server, not a subtree of the mobile API and not a
 * tenant feature. It serves three assets and one generated configuration file;
 * it never connects to MongoDB, never holds a credential and never proxies an
 * API call. The browser talks to the platform API directly, with credentials,
 * from this exact origin.
 *
 * STRICT CSP: no inline scripts, no inline styles, no third-party origins. The
 * only permitted connection is the configured API origin. `frame-ancestors
 * 'none'` and `X-Frame-Options: DENY` prevent clickjacking; the console is
 * never embedded anywhere.
 *
 * LOOPBACK BY DEFAULT. `PLATFORM_CONSOLE_HOST` defaults to 127.0.0.1 so a local
 * run cannot be reached from another machine by accident. A production host
 * must set the host and origin explicitly and serve it over HTTPS.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import 'dotenv/config';
import express from 'express';

const DEFAULT_PORT = 4100;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_API_ORIGIN = 'http://localhost:4000';
const DEFAULT_CONSOLE_ORIGIN = 'http://localhost:4100';

function validOrigin(value: string | undefined, fallback: string): string {
  const candidate = (value || fallback).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('https');
    }
    if (
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('origin');
    }
    return parsed.origin;
  } catch {
    throw new Error(`Invalid console origin: ${candidate}`);
  }
}

function escapeForScript(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function createConsoleApp({
  apiOrigin = process.env.PLATFORM_API_ORIGIN,
  consoleOrigin = process.env.PLATFORM_CONSOLE_ORIGIN,
  publicDir = path.join(import.meta.dirname, 'public'),
} = {}) {
  const api = validOrigin(apiOrigin, DEFAULT_API_ORIGIN);
  const consoleUrl = validOrigin(consoleOrigin, DEFAULT_CONSOLE_ORIGIN);

  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src ${api}`,
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "manifest-src 'self'",
      "worker-src 'none'",
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/config.js', (_req, res) => {
    const body = `window.__PLATFORM_CONSOLE__ = Object.freeze(${escapeForScript(
      JSON.stringify({ apiOrigin: api, consoleOrigin: consoleUrl }),
    )});\n`;
    res.type('application/javascript').send(body);
  });

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      dotfiles: 'deny',
      etag: false,
      lastModified: false,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  // Only the console root is a document. Unknown paths are a plain 404, not an
  // SPA fallback that might one day serve an unexpected asset.
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  return { app, apiOrigin: api, consoleOrigin: consoleUrl };
}

export function startPlatformConsole() {
  const port = Number(process.env.PLATFORM_CONSOLE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PLATFORM_CONSOLE_PORT must be an integer from 1 to 65535');
  }
  const host = (process.env.PLATFORM_CONSOLE_HOST || DEFAULT_HOST).trim();
  const { app, apiOrigin, consoleOrigin } = createConsoleApp();
  const server = app.listen(port, host, () => {
    console.log(`[platform-console] listening on ${consoleOrigin}`);
    console.log(`[platform-console] API origin: ${apiOrigin}`);
    console.log('[platform-console] loopback-only by default; do not expose without HTTPS');
  });
  return server;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startPlatformConsole();
}

export default { createConsoleApp, startPlatformConsole };
