// PLAT-2 — the dedicated console's security contract, and the MFA primitives.
//
// WHAT IS PINNED:
//   * the console is a separate listener whose CSP allows only its own scripts
//     and the configured API origin — no inline script/style, no unsafe-eval,
//     no framing, no third-party connection;
//   * the HTML contains no inline event handlers or style attributes, and the
//     generated config carries origins only;
//   * TOTP matches RFC 6238 vectors, rejects malformed input and refuses a
//     replayed counter;
//   * the MFA vault encrypts/decrypts with AES-GCM and rejects tampering.

process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-mfa-key-0123456789abcdef0123456789abcdef';

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { createConsoleApp } from '../platform-console/server.ts';
import { createApp } from '../src/app.ts';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  verifyTotp,
} from '../src/services/platformMfa/totp.ts';
import {
  decryptPlatformSecret,
  encryptPlatformSecret,
} from '../src/services/platformMfa/secretVault.ts';

const API_ORIGIN = 'http://127.0.0.1:4000';
const CONSOLE_ORIGIN = 'http://127.0.0.1:4100';

async function withConsole(fn) {
  const { app } = createConsoleApp({
    apiOrigin: API_ORIGIN,
    consoleOrigin: CONSOLE_ORIGIN,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

unitSuite('PLAT-2 console origin and CSP', () => {
  it('serves a strict CSP with only the API origin connectable', async () => {
    await withConsole(async (base) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/html/);
      const csp = response.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /style-src 'self'/);
      assert.match(csp, new RegExp(`connect-src ${API_ORIGIN.replace(/[.]/g, '\\.')}`));
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /base-uri 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.equal(csp.includes("'unsafe-inline'"), false);
      assert.equal(csp.includes("'unsafe-eval'"), false);
      assert.equal(csp.includes('*'), false);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  });

  it('contains no inline script, inline style or event-handler attribute', async () => {
    await withConsole(async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'inline script found');
      assert.equal(/<style[\s>]/i.test(html), false, 'inline style block found');
      assert.equal(/\sstyle\s*=/i.test(html), false, 'style attribute found');
      assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline event handler found');
      // The only scripts are the generated config and the external app bundle.
      const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
      assert.deepEqual(scripts, ['/config.js', '/app.js']);
    });
  });

  it('publishes only origins in config.js', async () => {
    await withConsole(async (base) => {
      const response = await fetch(`${base}/config.js`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.match(body, /apiOrigin/);
      assert.match(body, /127\.0\.0\.1:4000/);
      assert.match(body, /127\.0\.0\.1:4100/);
      assert.equal(body.includes('JWT_SECRET'), false);
      assert.equal(body.includes('MFA_ENCRYPTION'), false);
      assert.equal(body.includes('mongodb'), false);

      // The config is an origin; the app must append the API mount itself. The
      // browser E2E caught this when the console requested /auth/login instead
      // of /api/platform/auth/login and the server answered 404.
      const appJs = await (await fetch(`${base}/app.js`)).text();
      assert.match(appJs, /\/api\/platform/);
      assert.match(appJs, /API = String\(config\.apiOrigin[\s\S]*?\+ '\/api\/platform'/);
    });
  });

  it('returns a plain 404 for unknown and traversal paths', async () => {
    await withConsole(async (base) => {
      const missing = await fetch(`${base}/not-a-page`);
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type') || '', /text\/plain/);
      const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
      assert.equal(traversal.status, 404);
      const body = await traversal.text();
      assert.equal(body.includes('"scripts"'), false);
    });
  });
});

unitSuite('PLAT-6 same-origin console mount', () => {
  it('serves the console shell under /platform with rewritten assets and self-only CSP', async () => {
    const app = createApp({ requestLogging: false });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(`${base}/platform`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') || '', /connect-src 'self'/);
      assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      const html = await page.text();
      assert.match(html, /src="\/platform\/config\.js"/);
      assert.match(html, /src="\/platform\/app\.js"/);
      assert.match(html, /href="\/platform\/styles\.css"/);

      const config = await (await fetch(`${base}/platform/config.js`)).text();
      assert.match(config, /apiOrigin/);
      assert.equal(config.includes('JWT_SECRET'), false);
      assert.equal(config.includes('MFA_ENCRYPTION'), false);

      const missing = await fetch(`${base}/platform/not-a-page`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

unitSuite('PLAT-2 TOTP primitives', () => {
  // RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  it('round-trips base32 and computes the RFC vectors', () => {
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
    assert.equal(generateTotp(RFC_SECRET, 1), '287082'); // 59 s, 8-digit 94287082
    assert.equal(generateTotp(RFC_SECRET, 1111111109 / 30 | 0), '081804');
    assert.equal(generateTotp(RFC_SECRET, Math.floor(1234567890 / 30)), '005924');
  });

  it('accepts a one-step clock window and rejects malformed input', () => {
    const nowMs = 59_000;
    const counter = 1;
    const code = generateTotp(RFC_SECRET, counter);
    assert.equal(verifyTotp(RFC_SECRET, code, { nowMs }).valid, true);
    assert.equal(verifyTotp(RFC_SECRET, code, { nowMs: nowMs + 30_000 }).valid, true);
    assert.equal(verifyTotp(RFC_SECRET, code, { nowMs: nowMs + 90_000 }).valid, false);
    assert.equal(verifyTotp(RFC_SECRET, '12345', { nowMs }).valid, false);
    assert.equal(verifyTotp(RFC_SECRET, 'abcdef', { nowMs }).valid, false);
    assert.equal(verifyTotp(RFC_SECRET, '', { nowMs }).valid, false);
  });

  it('refuses a replayed counter', () => {
    const code = generateTotp(RFC_SECRET, 1);
    const first = verifyTotp(RFC_SECRET, code, { nowMs: 59_000, lastUsedCounter: 0 });
    assert.equal(first.valid, true);
    assert.equal(first.counter, 1);
    const replay = verifyTotp(RFC_SECRET, code, { nowMs: 59_000, lastUsedCounter: 1 });
    assert.equal(replay.valid, false);
  });
});

unitSuite('PLAT-2 MFA vault', () => {
  it('encrypts with a random IV and decrypts exactly', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const first = encryptPlatformSecret(secret);
    const second = encryptPlatformSecret(secret);
    assert.notEqual(first, second, 'each envelope must use a fresh IV');
    assert.match(first, /^v1\./);
    assert.equal(first.includes(secret), false);
    assert.equal(decryptPlatformSecret(first), secret);
    assert.equal(decryptPlatformSecret(second), secret);
  });

  it('rejects a tampered envelope instead of returning bytes', () => {
    const envelope = encryptPlatformSecret('JBSWY3DPEHPK3PXP');
    const parts = envelope.split('.');
    const tampered = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + 'AA'].join('.');
    assert.throws(() => decryptPlatformSecret(tampered), /Stored platform secret is invalid/);
    assert.throws(() => decryptPlatformSecret('not-an-envelope'), /Stored platform secret is invalid/);
  });
});
