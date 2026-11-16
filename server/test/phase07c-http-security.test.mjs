// Phase 07C — HTTP security hardening.
//
// H6: helmet security headers on every response + X-Powered-By suppressed.
// L2: explicit JSON body-size limit (oversized -> clean 413; malformed -> clean
//     400; neither leaks content or a stack trace, even in development).
// M3: explicit CORS allow-list (allow-listed origin -> ACAO = that origin, never
//     '*'; no-Origin native mobile unaffected; disallowed origin -> no grant).
// M4: trust-proxy behavior — default (0) ignores spoofed X-Forwarded-For so the
//     per-IP login limiter binds on the direct peer; numeric hop count (1) makes
//     the limiter see real forwarded client IPs.
//
// Integration tests over the real shipped app (createApp factory) + MongoDB.
// DB-independent tests (headers, body limit, most CORS) always run; tests that
// need a real authenticated session / login lookup are DB-required and FAIL
// loudly when MongoDB is unreachable (Phase 07F / M9). NOTE: server/.env sets
// NODE_ENV=development, so
// generic errorHandler responses append a dev-only `stack` — exact key-set
// assertions are therefore applied ONLY to the body-limit responses, which the
// handler's Phase 07C mapping answers with a fixed shape before the generic path.

import 'dotenv/config';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { issueSessionToken } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import Business from '../src/models/business.model.ts';
import User from '../src/models/user.model.ts';
import Session from '../src/models/session.model.ts';
import { createApp } from '../src/app.ts';

const dbOk = await ensureDb();

let seq = 0;
const unique = (prefix) => `${prefix}-${Date.now()}-${seq++}`;
const PASSWORD = 'Password123!';
const createdBusinessIds = [];
const createdUserIds = [];
const trackBusiness = (id) => id && createdBusinessIds.push(String(id));
const trackUser = (id) => id && createdUserIds.push(String(id));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startApp(options) {
  const app = createApp(options);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Low-level request: raw string body + arbitrary headers (Origin, XFF, ...). */
async function request(baseUrl, { method = 'GET', path, token, body, extraHeaders = {} }) {
  const headers = { ...extraHeaders, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, header: (name) => res.headers.get(name) };
}

/** Failed login (unknown email -> 401 INVALID_CREDENTIALS) with an optional spoofed XFF. */
async function failedLogin(baseUrl, email, xff) {
  return request(baseUrl, {
    method: 'POST',
    path: '/api/auth/login',
    body: JSON.stringify({ email, password: 'wrong-password' }),
    extraHeaders: xff ? { 'x-forwarded-for': xff } : {},
  });
}

const headersPresent = (r) => ({
  'strict-transport-security': r.header('strict-transport-security'),
  'x-content-type-options': r.header('x-content-type-options'),
  'x-frame-options': r.header('x-frame-options'),
  'referrer-policy': r.header('referrer-policy'),
  'cross-origin-opener-policy': r.header('cross-origin-opener-policy'),
  'cross-origin-resource-policy': r.header('cross-origin-resource-policy'),
});

function assertSecurityHeaders(r, label) {
  const h = headersPresent(r);
  for (const [name, value] of Object.entries(h)) {
    assert.ok(value, `${label}: expected header ${name} to be present`);
  }
  assert.equal(r.header('x-content-type-options'), 'nosniff', `${label}: nosniff`);
  // H6: framework + document-oriented controls must not leak through.
  assert.equal(r.header('x-powered-by'), null, `${label}: no X-Powered-By`);
  assert.equal(r.header('content-security-policy'), null, `${label}: no CSP (JSON API)`);
  assert.equal(r.header('cross-origin-embedder-policy'), null, `${label}: no COEP (JSON API)`);
}

// ---------------------------------------------------------------------------
// H6 — security headers / X-Powered-By
// ---------------------------------------------------------------------------
describe('H6 security headers (Phase 07C)', () => {
  let baseUrl;
  let stop;
  before(async () => {
    const s = await startApp();
    baseUrl = s.baseUrl;
    stop = s.close;
  });
  after(async () => {
    if (stop) await stop();
  });

  // DB-free cases below always run; the authenticated case needs MongoDB and is
  // registered through dbSuite (fails loudly when MongoDB is unreachable).
  unitSuite('H6 security headers — DB-free cases (Phase 07C)', () => {
    it('health endpoint carries helmet headers and no X-Powered-By', async () => {
    const res = await request(baseUrl, { path: '/api/health' });
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, 'GET /api/health');
  });

  it('service-info endpoint carries the same hardening', async () => {
    const res = await request(baseUrl, { path: '/' });
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, 'GET /');
  });

  it('unknown routes keep their structured 404 under the new middleware', async () => {
    const res = await request(baseUrl, { path: '/api/does-not-exist' });
    assert.equal(res.status, 404);
    assert.equal(res.json?.error, 'Not Found');
    assertSecurityHeaders(res, '404');
  });

    // 2026-10-23 security audit — auth responses must not be storable.
    //
    // A body under /api/auth can carry an access token, a reset authorization or a
    // fact about an account, so an intermediary (proxy, corporate TLS inspector, a
    // browser that later learns CORS) must not be allowed to keep it. The reset LINK
    // page already sets this for itself; this pins the JSON API's mount-point rule.
    //
    // `no-store` rather than `no-cache`: the latter PERMITS storage. The control below
    // matters as much as the assertion — a directive applied to the whole API would
    // silently change every other response, so the non-auth route is asserted to be
    // untouched.
    it('auth responses are no-store, and the directive is scoped to /api/auth', async () => {
      const auth = await request(baseUrl, { path: '/api/auth/me' });
      assert.equal(auth.status, 401, 'a tokenless /me is a normal 401');
      assert.equal(auth.header('cache-control'), 'no-store');
      assert.equal(auth.header('pragma'), 'no-cache');

      const health = await request(baseUrl, { path: '/api/health' });
      assert.equal(health.status, 200);
      assert.equal(
        health.header('cache-control'),
        null,
        'the auth caching rule must not leak onto every API response'
      );
    });

  }); // end unitSuite DB-free cases

  dbSuite('H6 security headers — authenticated case (Phase 07C)', dbOk, () => {
    it('authenticated endpoint works and stays hardened', async () => {
      const owner = await seedOwner();
      const res = await request(baseUrl, { path: '/api/auth/me', token: owner.token });
      assert.equal(res.status, 200);
      assert.equal(res.json?.user?.id, owner.userId);
      assertSecurityHeaders(res, 'GET /api/auth/me');
    });
  });
});

// ---------------------------------------------------------------------------
// L2 — explicit JSON body-size limit
// ---------------------------------------------------------------------------
unitSuite('L2 JSON body limit (Phase 07C)', () => {
  // Tiny explicit limit so oversized tests are fast and deterministic.
  let baseUrl;
  let stop;
  before(async () => {
    const s = await startApp({ jsonBodyLimit: '1kb' });
    baseUrl = s.baseUrl;
    stop = s.close;
  });
  after(async () => {
    if (stop) await stop();
  });

  it('small valid JSON reaches route validation (no false rejection)', async () => {
    const res = await request(baseUrl, {
      method: 'POST',
      path: '/api/auth/login',
      body: '{}',
    });
    // Parsed fine and reached the login validator (no DB needed for the shape).
    assert.equal(res.status, 400);
    assert.equal(res.json?.code, 'VALIDATION_ERROR');
  });

  it('malformed JSON is rejected cleanly with a fixed shape (no stack, no echo)', async () => {
    const res = await request(baseUrl, {
      method: 'POST',
      path: '/api/auth/login',
      body: '{"email":"marker-leak@example.com","password":',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.json ?? {}).sort(), ['code', 'error']);
    assert.equal(res.json.code, 'INVALID_JSON');
    assert.equal(res.json.error, 'Request body is not valid JSON');
    // Never echoes the offending content or a stack trace.
    assert.ok(!res.json.error.includes('marker-leak'));
    assert.ok(!res.json.error.includes('at '));
  });

  it('oversized JSON is rejected with a clean 413 (no stack)', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(3000) });
    assert.ok(Buffer.byteLength(big) > 1024, 'fixture must exceed the 1kb limit');
    const res = await request(baseUrl, {
      method: 'POST',
      path: '/api/auth/login',
      body: big,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(Object.keys(res.json ?? {}).sort(), ['code', 'error']);
    assert.equal(res.json.code, 'BODY_TOO_LARGE');
    assert.equal(res.json.error, 'Request body exceeds the allowed size');
  });
});

// ---------------------------------------------------------------------------
// M3 — explicit CORS allow-list
// ---------------------------------------------------------------------------
describe('M3 CORS allow-list (Phase 07C)', () => {
  const ALLOWED = 'https://admin.example.test';
  let baseUrl;
  let stop;
  before(async () => {
    const s = await startApp({ corsOrigins: [ALLOWED] });
    baseUrl = s.baseUrl;
    stop = s.close;
  });
  after(async () => {
    if (stop) await stop();
  });

  // DB-free cases below always run; the authenticated case needs MongoDB and is
  // registered through dbSuite (fails loudly when MongoDB is unreachable).
  unitSuite('M3 CORS allow-list — DB-free cases (Phase 07C)', () => {
    it('allow-listed origin gets a grant for that exact origin (never *)', async () => {
    const res = await request(baseUrl, { path: '/api/health', extraHeaders: { origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(res.header('access-control-allow-origin'), ALLOWED);
  });

  it('no-Origin (native mobile) requests pass through with no CORS headers', async () => {
    const res = await request(baseUrl, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.header('access-control-allow-origin'), null);
  });

  it('a disallowed origin is NOT granted CORS access', async () => {
    const res = await request(baseUrl, {
      path: '/api/health',
      extraHeaders: { origin: 'https://evil.example.net' },
    });
    // Server still serves the request (CORS is browser-enforced), but no grant.
    assert.equal(res.status, 200);
    assert.equal(res.header('access-control-allow-origin'), null);
  });

  it('an allow-listed preflight is answered safely with the exact origin', async () => {
    const res = await request(baseUrl, {
      method: 'OPTIONS',
      path: '/api/auth/login',
      extraHeaders: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.header('access-control-allow-origin'), ALLOWED);
    assert.match(res.header('access-control-allow-methods'), /POST/);
    assert.equal(res.header('access-control-allow-headers'), 'content-type');
  });

  it('reflects the requested headers on an allow-listed preflight (PLAT-2 regression)', async () => {
    // Platform calls use X-Platform-CSRF. The CORS layer must reflect whatever
    // the browser requests, not pin one static list that can drift from the
    // console's headers.
    const res = await request(baseUrl, {
      method: 'OPTIONS',
      path: '/api/platform/auth/me',
      extraHeaders: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-platform-csrf, x-platform-console',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.header('access-control-allow-origin'), ALLOWED);
    assert.equal(res.header('access-control-allow-headers'), 'x-platform-csrf, x-platform-console');
  });

  it('a disallowed preflight is not granted any CORS headers', async () => {
    const res = await request(baseUrl, {
      method: 'OPTIONS',
      path: '/api/auth/login',
      extraHeaders: {
        origin: 'https://evil.example.net',
        'access-control-request-method': 'POST',
      },
    });
    // cors grants nothing, so Express's automatic OPTIONS answer (200 + Allow,
    // no Access-Control-* headers) is what comes back — and crucially NO ACAO,
    // so a browser from this origin is blocked from reading anything.
    assert.equal(res.header('access-control-allow-origin'), null);
    assert.equal(res.header('access-control-allow-methods'), null);
    assert.equal(res.header('access-control-allow-headers'), null);
    assert.equal(res.status, 200);
  });

  }); // end unitSuite DB-free cases

  dbSuite('M3 CORS allow-list — authenticated case (Phase 07C)', dbOk, () => {
    it('authenticated API usage reflects only allow-listed origins (never *)', async () => {
      const owner = await seedOwner();
      const allowed = await request(baseUrl, {
        path: '/api/auth/me',
        token: owner.token,
        extraHeaders: { origin: ALLOWED },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.header('access-control-allow-origin'), ALLOWED);

      const evil = await request(baseUrl, {
        path: '/api/auth/me',
        token: owner.token,
        extraHeaders: { origin: 'https://evil.example.net' },
      });
      // Authentication still enforced server-side (200 with a valid JWT), but
      // the browser gets no grant — CORS never weakens auth.
      assert.equal(evil.status, 200);
      assert.equal(evil.header('access-control-allow-origin'), null);
    });
  });
});

// ---------------------------------------------------------------------------
// M4 — trust-proxy: spoofed X-Forwarded-For vs the login rate limiter
// ---------------------------------------------------------------------------
dbSuite('M4 trust proxy (Phase 07C)', dbOk, () => {
  // Small per-IP cap so the spray limiter trips within a few requests; loginMax
  // stays high so the account limiter never interferes.
  const authLimits = { loginMax: 1000, loginIpMax: 2 };

  it('default (trust 0): spoofed X-Forwarded-For cannot bypass the per-IP limiter', async () => {
    const { baseUrl, close } = await startApp({ trustProxy: 0, authLimits });
    try {
      const email = `${unique('p07c')}@example.com`;
      const ips = ['203.0.113.10', '203.0.113.11', '203.0.113.12']; // distinct spoofs
      const results = [];
      for (const xff of ips) {
        results.push(await failedLogin(baseUrl, email, xff));
      }
      const statuses = results.map((r) => r.status);
      // All requests land on the direct peer (127.0.0.1): the third crosses the
      // per-IP cap and is blocked — regardless of the spoofed header. Never a
      // 500 (forwarded headers are deliberately ignored, not mis-handled).
      assert.deepEqual(statuses, [401, 401, 429]);
      assert.equal(results[2].json.code, 'LOGIN_RATE_LIMITED');
    } finally {
      await close();
    }
  });

  it('numeric trust (1): limiter keys on the real forwarded client IP', async () => {
    const { baseUrl, close } = await startApp({ trustProxy: 1, authLimits });
    try {
      // Distinct forwarded IPs -> distinct buckets -> each stays under the cap.
      const emailA = `${unique('p07c')}@example.com`;
      const distinct = [];
      for (const xff of ['203.0.113.20', '203.0.113.21', '203.0.113.22']) {
        distinct.push(await failedLogin(baseUrl, emailA, xff));
      }
      assert.deepEqual(
        distinct.map((r) => r.status),
        [401, 401, 401],
        'one client cannot burn another client bucket'
      );

      // The SAME forwarded IP -> same bucket -> the limiter still trips.
      const emailB = `${unique('p07c')}@example.com`;
      const same = [];
      for (let i = 0; i < 3; i++) {
        same.push(await failedLogin(baseUrl, emailB, '203.0.113.30'));
      }
      assert.deepEqual(
        same.map((r) => r.status),
        [401, 401, 429],
        'limiter stays active and binds per forwarded IP when trusted'
      );
      assert.equal(same[2].json.code, 'LOGIN_RATE_LIMITED');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Seed a real OWNER (ACTIVE business + user) directly for authenticated calls.
// ---------------------------------------------------------------------------
async function seedOwner() {
  const business = await Business.create({ name: unique('Biz07C') });
  trackBusiness(business._id);
  const user = await User.create({
    businessId: business._id,
    name: unique('U07C'),
    email: `${unique('p07c')}@example.com`,
    passwordHash: bcrypt.hashSync(PASSWORD, 10),
    role: 'OWNER',
    status: 'ACTIVE',
  });
  trackUser(user._id);
  return {
    userId: String(user._id),
    token: await issueSessionToken(user._id),
  };
}

after(async () => {
  if (dbOk) {
    if (createdBusinessIds.length) {
      await Business.deleteMany({ _id: { $in: createdBusinessIds } }).catch(() => {});
    }
    if (createdUserIds.length) {
      // Phase 26A: sessions carry no businessId, so they are cleared by userId.
      await Session.deleteMany({ userId: { $in: createdUserIds } }).catch(() => {});
      await User.deleteMany({ _id: { $in: createdUserIds } }).catch(() => {});
    }
  }
  await disconnectDb();
});
