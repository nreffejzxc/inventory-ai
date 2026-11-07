// Phase 07B — Auth + tenant security hardening.
//
// H1: POST /api/auth/login and POST /api/auth/register are rate limited
//     (login: per IP + normalized email, strict, only FAILED attempts count;
//     register: per IP, every attempt counts), with 429 responses in the
//     project's { error, code } shape that never leak internal details.
//     Tests build each case its own fresh app with tiny explicit limits, so no
//     run waits on real-world windows and state never leaks between cases.
// H2: Business.status is security-relevant. SUSPENDED / ARCHIVED / deleted
//     businesses cannot log in AND immediately revoke existing JWTs
//     (requireAuth), while ACTIVE tenants behave exactly as before.
//
// Integration tests over the real shipped routers + MongoDB (DB-backed; fails
// loudly when the database is unreachable — Phase 07F / M9). NOTE: server/.env
// sets NODE_ENV=development,
// so errorHandler appends a dev-only `stack` to ApiError responses routed
// through it (production strips it) — key-set assertions are therefore applied
// ONLY to the rate-limiters' own 429 bodies, which bypass errorHandler.

import 'dotenv/config';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import mongoose from 'mongoose';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { issueSessionToken } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Business from '../src/models/business.model.ts';
import User from '../src/models/user.model.ts';
import Product from '../src/models/product.model.ts';
import Session from '../src/models/session.model.ts';

import { createAuthRouter } from '../src/routes/auth.routes.ts';
import categoryRoutes from '../src/routes/categories.routes.ts';
import locationRoutes from '../src/routes/locations.routes.ts';
import productRoutes from '../src/routes/products.routes.ts';
import notFound from '../src/middlewares/notFound.ts';
import errorHandler from '../src/middlewares/errorHandler.ts';

const { ObjectId } = mongoose;

// ---------------------------------------------------------------------------
// Shipped-router composition (mirrors src/app.js for the endpoints under test).
// `limits` lets a case build the auth router with small, explicit rate limits;
// omitted, production defaults apply.
// ---------------------------------------------------------------------------
function buildApp({ limits } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ limits }));
  app.use('/api/categories', categoryRoutes);
  app.use('/api/locations', locationRoutes);
  app.use('/api/products', productRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

async function startApp(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Setup / helpers
// ---------------------------------------------------------------------------
const dbOk = await ensureDb();

let seq = 0;
const unique = (prefix) => `${prefix}-${Date.now()}-${seq++}`;
const uniqueEmail = () => `${unique('p07b')}@example.com`;

const PASSWORD = 'Password123!';
const createdBusinessIds = [];
const createdUserIds = [];
const createdProductIds = [];
const trackBusiness = (id) => id && createdBusinessIds.push(String(id));
const trackUser = (id) => id && createdUserIds.push(String(id));
const trackProduct = (id) => id && createdProductIds.push(String(id));

async function api(baseUrl, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {
    status: res.status,
    json,
    header: (name) => res.headers.get(name),
  };
}

/** Create a Business + user directly in the DB (bypasses /register). */
async function seedBusinessUser({ role = 'OWNER' } = {}) {
  const business = await Business.create({ name: unique('Biz07B') });
  trackBusiness(business._id);
  const email = uniqueEmail();
  const user = await User.create({
    businessId: business._id,
    name: unique('U07B'),
    email,
    passwordHash: bcrypt.hashSync(PASSWORD, 10),
    role,
    status: 'ACTIVE',
  });
  trackUser(user._id);
  return {
    business,
    businessId: String(business._id),
    userId: String(user._id),
    email,
    password: PASSWORD,
    token: await issueSessionToken(user._id),
  };
}

async function registerViaHttp(baseUrl) {
  const res = await api(baseUrl, 'POST', '/api/auth/register', {
    body: {
      businessName: unique('RegBiz'),
      name: unique('RegUser'),
      email: uniqueEmail(),
      password: PASSWORD,
    },
  });
  trackBusiness(res.json?.business?.id);
  trackUser(res.json?.user?.id);
  return res;
}

// ---------------------------------------------------------------------------
// Leak assertions.
// Real credentials / hashes / secrets must never appear in ANY response. Note
// that dev-mode errorHandler stack traces are project-wide, pre-existing
// behavior (production strips them) and are NOT secrets, so no blanket
// "stack"-text scan is applied.
// ---------------------------------------------------------------------------
const SECRET_NEEDLES = [
  'passwordHash',
  '$2a$', // bcrypt hashes
  '$2b$',
  'jwtSecret',
  'mongodb+srv',
  'sk-ant', // Anthropic key prefix
];

function assertNoSecrets(body, extraNeedles = []) {
  const serialized = JSON.stringify(body);
  for (const needle of [...SECRET_NEEDLES, ...extraNeedles]) {
    assert.equal(serialized.includes(needle), false, `response must not contain "${needle}"`);
  }
}

/**
 * Rate-limit 429s are written directly by the limiter's own handler (they never
 * pass through errorHandler), so the body is EXACTLY the safe { error, code }
 * shape — assert that precisely, plus the limiter's Retry-After header.
 */
function assertRateLimitBlock(res, code) {
  assert.equal(res.status, 429);
  assert.equal(res.json.code, code);
  assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0);
  assert.deepEqual(Object.keys(res.json).sort(), ['code', 'error']);
  assertNoSecrets(res.json);
  assert.ok(
    res.header('retry-after'),
    'rate-limited responses carry a Retry-After header'
  );
}

after(async () => {
  if (dbOk) {
    const bizIds = createdBusinessIds.map((x) => new ObjectId(x));
    const db = mongoose.connection.db;
    const deleteByBusiness = async (collection) => {
      if (!bizIds.length) return;
      try {
        await db.collection(collection).deleteMany({ businessId: { $in: bizIds } });
      } catch {
        /* best effort */
      }
    };
    await deleteByBusiness('inventory_transactions');
    await deleteByBusiness('inventory');
    await deleteByBusiness('products');
    await deleteByBusiness('categories');
    await deleteByBusiness('locations');
    await deleteByBusiness('audit_logs');
    if (bizIds.length) {
      await Business.deleteMany({ _id: { $in: bizIds } }).catch(() => {});
    }
    if (createdUserIds.length) {
      // Phase 26A: sessions are user-owned (no businessId), so they are cleared
      // by userId alongside the users.
      await Session.deleteMany({
        userId: { $in: createdUserIds.map((x) => new ObjectId(x)) },
      }).catch(() => {});
      await User.deleteMany({
        _id: { $in: createdUserIds.map((x) => new ObjectId(x)) },
      }).catch(() => {});
    }
    if (createdProductIds.length) {
      await Product.deleteMany({
        _id: { $in: createdProductIds.map((x) => new ObjectId(x)) },
      }).catch(() => {});
    }
  }
  await disconnectDb();
});

const BUSINESS_NOT_ACTIVE_ERROR =
  'This business is not active. Contact an administrator.';

// ---------------------------------------------------------------------------
// H2 — business status enforcement at login and on existing JWTs.
// One app (production default limits) reused across these cases; every seeded
// account is distinct, so the default per-IP caps are never approached.
// ---------------------------------------------------------------------------
dbSuite('Phase 07B — H2 business status enforcement (login + existing JWT)', dbOk, () => {
  let serverCtx;
  let url;

  before(async () => {
    if (dbOk) {
      serverCtx = await startApp(buildApp());
      url = serverCtx.baseUrl;
    }
  });

  after(async () => {
    if (serverCtx) await serverCtx.close();
  });

  it('ACTIVE business: login succeeds and protected endpoints work', async () => {
    const seed = await seedBusinessUser();
    const login = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(login.status, 200);
    assert.ok(login.json.token);
    assert.equal(login.json.tokenType, 'Bearer');
    assert.equal(login.json.user.id, seed.userId);
    assertNoSecrets(login.json);

    const me = await api(url, 'GET', '/api/auth/me', { token: login.json.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.id, seed.userId);
    assert.equal(me.json.user.businessId, seed.businessId);

    const products = await api(url, 'GET', '/api/products', { token: login.json.token });
    assert.equal(products.status, 200);
    assert.ok(Array.isArray(products.json.items));
  });

  it('SUSPENDED business: login is rejected and an existing JWT is revoked', async () => {
    const seed = await seedBusinessUser();
    const before2 = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(before2.status, 200, 'login works while the business is ACTIVE');
    const oldToken = before2.json.token;

    await Business.updateOne({ _id: seed.business._id }, { status: 'SUSPENDED' });

    const login = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, 'BUSINESS_NOT_ACTIVE');
    assert.equal(login.json.error, BUSINESS_NOT_ACTIVE_ERROR);
    assertNoSecrets(login.json);
    // No business metadata in the rejection.
    assert.equal(JSON.stringify(login.json).includes(seed.business.name), false);

    // A JWT minted while ACTIVE is dead the moment the tenant is suspended.
    for (const path of ['/api/auth/me', '/api/products']) {
      const res = await api(url, 'GET', path, { token: oldToken });
      assert.equal(res.status, 403, `${path} must reject a token of a SUSPENDED business`);
      assert.equal(res.json.code, 'BUSINESS_NOT_ACTIVE');
      assert.equal(res.json.error, BUSINESS_NOT_ACTIVE_ERROR);
      assertNoSecrets(res.json);
    }
  });

  it('ARCHIVED business: login is rejected and an existing JWT is revoked', async () => {
    const seed = await seedBusinessUser();
    const before2 = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(before2.status, 200);
    const oldToken = before2.json.token;

    await Business.updateOne({ _id: seed.business._id }, { status: 'ARCHIVED' });

    const login = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, 'BUSINESS_NOT_ACTIVE');
    assert.equal(login.json.error, BUSINESS_NOT_ACTIVE_ERROR);

    const me = await api(url, 'GET', '/api/auth/me', { token: oldToken });
    assert.equal(me.status, 403);
    assert.equal(me.json.code, 'BUSINESS_NOT_ACTIVE');
    assert.equal(me.json.error, BUSINESS_NOT_ACTIVE_ERROR);
    assertNoSecrets(me.json);
  });

  it('missing business (deleted): fails safely with the same generic error, nothing leaks', async () => {
    const seed = await seedBusinessUser();
    const before2 = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(before2.status, 200);
    const oldToken = before2.json.token;

    await Business.deleteOne({ _id: seed.business._id });

    const login = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, 'BUSINESS_NOT_ACTIVE');
    // Identical message to SUSPENDED/ARCHIVED — a caller cannot distinguish the
    // tenant's state from the response, and no business name/email surfaces.
    assert.equal(login.json.error, BUSINESS_NOT_ACTIVE_ERROR);
    assertNoSecrets(login.json, [seed.business.name, seed.email]);

    const me = await api(url, 'GET', '/api/auth/me', { token: oldToken });
    assert.equal(me.status, 403);
    assert.equal(me.json.code, 'BUSINESS_NOT_ACTIVE');
    assert.equal(me.json.error, BUSINESS_NOT_ACTIVE_ERROR);
    assertNoSecrets(me.json, [seed.business.name, seed.email]);
  });

  it('DISABLED users stay blocked (user check is independent of the business check)', async () => {
    const seed = await seedBusinessUser();
    const before2 = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(before2.status, 200);
    const oldToken = before2.json.token;

    await User.updateOne({ _id: seed.userId }, { status: 'DISABLED' });

    const login = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: seed.password },
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, 'ACCOUNT_DISABLED');

    const me = await api(url, 'GET', '/api/auth/me', { token: oldToken });
    assert.equal(me.status, 403);
    assert.equal(me.json.code, 'ACCOUNT_DISABLED');
  });

  it('wrong password / unknown email both return the same generic 401 (no account enumeration)', async () => {
    const seed = await seedBusinessUser();
    const wrongKnown = await api(url, 'POST', '/api/auth/login', {
      body: { email: seed.email, password: 'WrongPass123!' },
    });
    assert.equal(wrongKnown.status, 401);
    assert.equal(wrongKnown.json.code, 'INVALID_CREDENTIALS');
    assert.equal(wrongKnown.json.error, 'Invalid email or password');
    assertNoSecrets(wrongKnown.json, [seed.email]);

    const wrongUnknown = await api(url, 'POST', '/api/auth/login', {
      body: { email: `${unique('nobody')}@example.com`, password: 'WrongPass123!' },
    });
    assert.equal(wrongUnknown.status, 401);
    assert.equal(wrongUnknown.json.code, 'INVALID_CREDENTIALS');
    assert.equal(wrongUnknown.json.error, 'Invalid email or password');
    // Identical generic response whether or not the account exists.
    assert.equal(wrongUnknown.json.code, wrongKnown.json.code);
    assert.equal(wrongUnknown.json.error, wrongKnown.json.error);
  });

  it('OWNER / ADMIN / MANAGER / STAFF still work per their permissions in an ACTIVE business', async () => {
    const business = await Business.create({ name: unique('BizRoles') });
    trackBusiness(business._id);

    const roles = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'];
    const sessions = {};
    for (const role of roles) {
      const email = uniqueEmail();
      const user = await User.create({
        businessId: business._id,
        name: unique(role),
        email,
        passwordHash: bcrypt.hashSync(PASSWORD, 10),
        role,
        status: 'ACTIVE',
      });
      trackUser(user._id);
      const login = await api(url, 'POST', '/api/auth/login', {
        body: { email, password: PASSWORD },
      });
      assert.equal(login.status, 200, `${role} login`);
      sessions[role] = login.json.token;

      const me = await api(url, 'GET', '/api/auth/me', { token: sessions[role] });
      assert.equal(me.status, 200, `${role} /me`);
      assert.equal(me.json.user.role, role);
    }

    // Anyone authenticated can list; only products.manage roles can create.
    for (const role of roles) {
      const list = await api(url, 'GET', '/api/products', { token: sessions[role] });
      assert.equal(list.status, 200, `${role} list`);
      const create = await api(url, 'POST', '/api/products', {
        token: sessions[role],
        body: { name: unique('Prod') },
      });
      if (role === 'STAFF') {
        assert.equal(create.status, 403, 'STAFF must not create products');
        assert.equal(create.json.code, 'FORBIDDEN');
      } else {
        assert.equal(create.status, 201, `${role} create`);
        trackProduct(create.json.id);
      }
    }
  });

  it('cross-business isolation is intact (a product of another business is never visible)', async () => {
    const a = await seedBusinessUser();
    const b = await seedBusinessUser();
    const created = await api(url, 'POST', '/api/products', {
      token: b.token,
      body: { name: unique('ProdB') },
    });
    assert.equal(created.status, 201);
    trackProduct(created.json.id);

    const cross = await api(url, 'GET', `/api/products/${created.json.id}`, {
      token: a.token,
    });
    assert.equal(cross.status, 404, 'Business A must not read Business B product');

    const listA = await api(url, 'GET', '/api/products', { token: a.token });
    assert.equal(listA.status, 200);
    assert.equal(listA.json.total, 0, 'Business A sees none of Business B products');
  });
});

// ---------------------------------------------------------------------------
// H1 — authentication rate limiting.
// Every case builds a FRESH app so each limiter starts with an empty store;
// tiny windows/limits keep every case fast and deterministic.
// ---------------------------------------------------------------------------
dbSuite('Phase 07B — H1 authentication rate limiting', dbOk, () => {
  const build = async (limits, fn) => {
    const ctx = await startApp(buildApp({ limits }));
    try {
      await fn(ctx.baseUrl);
    } finally {
      await ctx.close();
    }
  };

  it('normal login succeeds when under the limit and never returns a hash', async () => {
    await build({ loginWindowMs: 60000, loginMax: 3, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      const res = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: seed.password },
      });
      assert.equal(res.status, 200);
      assert.ok(res.json.token);
      assertNoSecrets(res.json);
    });
  });

  it('repeated failed logins eventually return a safe 429 (brute-force lock)', async () => {
    await build({ loginWindowMs: 60000, loginMax: 3, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      for (let i = 0; i < 3; i++) {
        const res = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assert.equal(res.status, 401, `attempt ${i + 1} is still a normal 401`);
        assert.equal(res.json.code, 'INVALID_CREDENTIALS');
      }
      // The fourth attempt — even with the CORRECT password — is blocked.
      const blocked = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: seed.password },
      });
      assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');
    });
  });

  it('successful logins never consume the budget (legitimate users are not locked out)', async () => {
    await build({ loginWindowMs: 60000, loginMax: 3, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      for (let i = 0; i < 6; i++) {
        const res = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: seed.password },
        });
        assert.equal(res.status, 200, `successful login ${i + 1} is not rate limited`);
      }
    });
  });

  it('login recovers once the window elapses (short window, no long waits)', async () => {
    const windowMs = 1100;
    await build({ loginWindowMs: windowMs, loginMax: 2, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      for (let i = 0; i < 2; i++) {
        const res = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assert.equal(res.status, 401);
      }
      const blocked = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: 'WrongPass123!' },
      });
      assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');

      // After the window passes, a legitimate login succeeds again.
      await new Promise((resolve) => setTimeout(resolve, windowMs + 400));
      const recovered = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: seed.password },
      });
      assert.equal(recovered.status, 200, 'login works after the window resets');
    });
  });

  it('skipSuccessfulRequests survives a window reset on the per-IP bucket', async () => {
    // The IP bucket is the one login limiter a success is never allowed to clear
    // (resetLoginAccountBucketOnSuccess touches only the account bucket), so it is
    // where `skipSuccessfulRequests` itself is observable across a boundary. The
    // failure budget must be the FULL loginIpMax in the fresh window: a success
    // charged to it would make the second post-reset failure a 429, and an undo
    // that crossed the boundary would push the lock out to a fourth.
    const windowMs = 900;
    await build(
      { loginWindowMs: 60000, loginMax: 100, loginIpWindowMs: windowMs, loginIpMax: 2 },
      async (url2) => {
        const seed = await seedBusinessUser();

        for (let i = 0; i < 2; i++) {
          const res = await api(url2, 'POST', '/api/auth/login', {
            body: { email: seed.email, password: 'WrongPass123!' },
          });
          assert.equal(res.status, 401, `first-window failure ${i + 1}`);
        }
        const locked = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assertRateLimitBlock(locked, 'LOGIN_RATE_LIMITED');

        // Cross the boundary. This 2xx lands in the FRESH window and is skipped
        // there, so it must leave that window's failure budget untouched.
        await new Promise((resolve) => setTimeout(resolve, windowMs + 400));
        const ok = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: seed.password },
        });
        assert.equal(ok.status, 200, 'the fresh window admits the legitimate login');

        for (let i = 0; i < 2; i++) {
          const res = await api(url2, 'POST', '/api/auth/login', {
            body: { email: seed.email, password: 'WrongPass123!' },
          });
          assert.equal(res.status, 401, `post-reset failure ${i + 1} is a normal 401`);
        }
        // Exactly loginIpMax failures, then the lock — no credit lost to the
        // success and none gained by a decrement crossing the boundary.
        const relocked = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assertRateLimitBlock(relocked, 'LOGIN_RATE_LIMITED');
      }
    );
  });

  it('rate limiting is scoped per normalized account+IP: another account is not blocked', async () => {
    await build({ loginWindowMs: 60000, loginMax: 3, loginIpMax: 100 }, async (url2) => {
      const locked = await seedBusinessUser();
      const other = await seedBusinessUser();
      for (let i = 0; i < 3; i++) {
        await api(url2, 'POST', '/api/auth/login', {
          body: { email: locked.email, password: 'WrongPass123!' },
        });
      }
      const blocked = await api(url2, 'POST', '/api/auth/login', {
        body: { email: locked.email, password: locked.password },
      });
      assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');

      const otherLogin = await api(url2, 'POST', '/api/auth/login', {
        body: { email: other.email, password: other.password },
      });
      assert.equal(otherLogin.status, 200, 'a different account is not rate limited');
    });
  });

  it('login rate limit keys on the NORMALIZED email (case/whitespace cannot bypass)', async () => {
    await build({ loginWindowMs: 60000, loginMax: 2, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      // Two failures with the canonical email exhaust the account budget.
      for (let i = 0; i < 2; i++) {
        await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
      }
      // Re-submitting with different case/spacing maps to the SAME bucket.
      const casing = await api(url2, 'POST', '/api/auth/login', {
        body: {
          email: `  ${seed.email.toUpperCase()}  `,
          password: seed.password,
        },
      });
      assertRateLimitBlock(casing, 'LOGIN_RATE_LIMITED');
    });
  });

  // -------------------------------------------------------------------------
  // Issue 2 — a SUCCESSFUL login clears the account bucket it belongs to.
  //
  // `skipSuccessfulRequests` alone only undoes the successful request's OWN
  // increment, so failures the same account had already accumulated used to
  // survive a correct password. The reset closes that, and these two cases pin
  // both halves of the boundary: the account bucket IS cleared, and the IP
  // bucket is NOT.
  // -------------------------------------------------------------------------

  it('a successful login clears the account bucket (failures do not survive it)', async () => {
    await build({ loginWindowMs: 60000, loginMax: 3, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      // Two failures spend two of the three credits.
      for (let i = 0; i < 2; i++) {
        const res = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assert.equal(res.status, 401);
      }
      // A correct password proves the account's owner is present, so its bucket
      // starts empty afterwards.
      const ok = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: seed.password },
      });
      assert.equal(ok.status, 200);
      // THREE more failures must all be ordinary 401s. Without the reset the
      // second of them is already a 429 (two leftovers plus its own increment).
      for (let i = 0; i < 3; i++) {
        const res = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'WrongPass123!' },
        });
        assert.equal(res.status, 401, 'post-reset attempt ' + (i + 1) + ' is still a normal 401');
      }
      // The fourth after the reset is the lock, exactly as it would be from cold.
      const blocked = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: 'WrongPass123!' },
      });
      assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');
    });
  });

  it('a successful login does NOT clear the per-IP bucket (spraying stays bounded)', async () => {
    await build(
      { loginWindowMs: 60000, loginMax: 100, loginIpWindowMs: 60000, loginIpMax: 4 },
      async (url2) => {
        const seed = await seedBusinessUser();
        const other = await seedBusinessUser();
        for (let i = 0; i < 2; i++) {
          const res = await api(url2, 'POST', '/api/auth/login', {
            body: { email: other.email, password: 'WrongPass123!' },
          });
          assert.equal(res.status, 401);
        }
        // A success on ONE account must not hand the source fresh IP budget.
        const ok = await api(url2, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: seed.password },
        });
        assert.equal(ok.status, 200);
        // Failures three and four on the OTHER account are still ordinary 401s...
        for (let i = 0; i < 2; i++) {
          const res = await api(url2, 'POST', '/api/auth/login', {
            body: { email: other.email, password: 'WrongPass123!' },
          });
          assert.equal(res.status, 401, 'IP attempt ' + (i + 3) + ' is still a normal 401');
        }
        // ...and the fifth is the IP lock. It only arrives on time if the success
        // above left the IP bucket alone: a reset that cleared every bucket would
        // have bought the source two extra credits and pushed this out.
        const blocked = await api(url2, 'POST', '/api/auth/login', {
          body: { email: other.email, password: 'WrongPass123!' },
        });
        assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');
      }
    );
  });

  it('a login 429 states its wait as positive whole seconds in Retry-After', async () => {
    await build({ loginWindowMs: 60000, loginMax: 1, loginIpMax: 100 }, async (url2) => {
      const seed = await seedBusinessUser();
      const first = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: 'WrongPass123!' },
      });
      assert.equal(first.status, 401);
      const blocked = await api(url2, 'POST', '/api/auth/login', {
        body: { email: seed.email, password: 'WrongPass123!' },
      });
      assertRateLimitBlock(blocked, 'LOGIN_RATE_LIMITED');
      // The exact form the mobile client parses into a countdown, so the screen's
      // contract with this header is pinned on the side that emits it.
      const raw = blocked.header('retry-after');
      const seconds = Number(raw);
      assert.ok(Number.isInteger(seconds) && seconds > 0, 'Retry-After is positive whole seconds, got ' + raw);
      assert.ok(seconds <= 60, 'Retry-After fits the 60 s window, got ' + raw);
    });
  });
  it('registration is rate limited per IP with a safe 429 body', async () => {
    await build({ registerWindowMs: 60000, registerMax: 3 }, async (url2) => {
      for (let i = 0; i < 3; i++) {
        const reg = await registerViaHttp(url2);
        assert.equal(reg.status, 201, `registration ${i + 1} succeeds`);
        assert.equal(reg.json.business.status, 'ACTIVE');
        assertNoSecrets(reg.json);
      }
      const fourth = await registerViaHttp(url2);
      assertRateLimitBlock(fourth, 'REGISTER_RATE_LIMITED');
    });
  });

  it('registration still works for legitimate volume on the production-default app', async () => {
    const ctx = await startApp(buildApp());
    try {
      for (let i = 0; i < 3; i++) {
        const reg = await registerViaHttp(ctx.baseUrl);
        assert.equal(reg.status, 201, `default-limits registration ${i + 1} succeeds`);
      }
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-10-23 SECURITY AUDIT — the AUTHENTICATED credential operations.
//
// WHY THESE ROUTES NEED THEIR OWN CASES RATHER THAN INHERITING H1's. Every limit
// above protects a route a caller reaches WITHOUT a session, so its key is built
// from something the caller supplies. These three sit behind requireAuth, so the
// budget belongs to the ACCOUNT (`req.user.id`) and the cases have to prove that:
// one user exhausting a bucket must not touch another, a source rotating accounts
// must still meet the address bucket, and an anonymous caller must be refused by
// authentication BEFORE any bucket is charged.
//
// WHAT IS BEING DEFENDED, CONCRETELY. `change-password` verifies the CURRENT
// password, and that comparison is the only re-authentication the endpoint
// performs: unlimited, it is an unlimited guess at the account's password by
// anyone holding a session token, and a correct guess installs a new credential.
// Each attempt also costs a bcrypt comparison. `firebase/link` and
// `credentials-changed` each spend an outbound Firebase `checkRevoked`
// verification and a write, so the same account could otherwise drive that work
// without bound.
//
// Every case builds a FRESH app so each limiter starts with an empty store, exactly
// as H1 does.
// ---------------------------------------------------------------------------
dbSuite('Security audit (2026-10-23) — authenticated credential operations', dbOk, () => {
  const build = async (limits, fn) => {
    const ctx = await startApp(buildApp({ limits }));
    try {
      await fn(ctx.baseUrl);
    } finally {
      await ctx.close();
    }
  };

  const changePassword = (url, seed, currentPassword) =>
    api(url, 'POST', '/api/auth/change-password', {
      token: seed.token,
      body: { currentPassword, newPassword: 'Replacement123!' },
    });

  it('change-password spends its account budget on wrong current passwords, then refuses even the correct one', async () => {
    await build(
      { changePasswordWindowMs: 60000, changePasswordMax: 2, changePasswordIpMax: 100 },
      async (url) => {
        const seed = await seedBusinessUser();

        for (let i = 0; i < 2; i++) {
          const res = await changePassword(url, seed, 'WrongPass123!');
          assert.equal(res.status, 400, `attempt ${i + 1} is an ordinary refusal`);
          assert.equal(res.json.code, 'INVALID_CURRENT_PASSWORD');
        }

        // The third attempt is blocked BEFORE the comparison. That is the point: a
        // session holder cannot keep guessing the current password, and a guessed
        // credential can never be installed. The correct password being blocked too
        // is the documented cost of a limiter that runs ahead of the controller.
        const blocked = await changePassword(url, seed, seed.password);
        assertRateLimitBlock(blocked, 'CHANGE_PASSWORD_RATE_LIMITED');

        // And nothing was written by any of the three: the original still signs in.
        const login = await api(url, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: seed.password },
        });
        assert.equal(login.status, 200, 'a blocked attempt cannot change the credential');
      }
    );
  });

  it('a correct change within the budget still succeeds, so the limiter does not break the flow', async () => {
    await build(
      { changePasswordWindowMs: 60000, changePasswordMax: 3, changePasswordIpMax: 100 },
      async (url) => {
        const seed = await seedBusinessUser();
        const res = await changePassword(url, seed, seed.password);
        assert.equal(res.status, 200);
        assert.equal(res.json.message, 'Password changed. Please sign in again.');

        const login = await api(url, 'POST', '/api/auth/login', {
          body: { email: seed.email, password: 'Replacement123!' },
        });
        assert.equal(login.status, 200, 'the replacement password is the one that works now');
      }
    );
  });

  it('the account budget is per account: one user exhausting it does not block another', async () => {
    await build(
      { changePasswordWindowMs: 60000, changePasswordMax: 1, changePasswordIpMax: 100 },
      async (url) => {
        const blockedUser = await seedBusinessUser();
        const other = await seedBusinessUser();

        const spent = await changePassword(url, blockedUser, 'WrongPass123!');
        assert.equal(spent.status, 400);
        const blocked = await changePassword(url, blockedUser, blockedUser.password);
        assertRateLimitBlock(blocked, 'CHANGE_PASSWORD_RATE_LIMITED');

        // A DIFFERENT account, from the same address, still has its own budget.
        const allowed = await changePassword(url, other, other.password);
        assert.equal(allowed.status, 200, 'another account is not rate limited by this one');
      }
    );
  });

  it('the per-address bucket still bounds one source rotating accounts', async () => {
    await build(
      {
        changePasswordWindowMs: 60000,
        changePasswordMax: 100,
        changePasswordIpWindowMs: 60000,
        changePasswordIpMax: 3,
      },
      async (url) => {
        const seeds = [
          await seedBusinessUser(),
          await seedBusinessUser(),
          await seedBusinessUser(),
        ];

        for (let i = 0; i < 3; i++) {
          const res = await changePassword(url, seeds[i], 'WrongPass123!');
          assert.equal(res.status, 400, `account ${i + 1} is still under its own budget`);
        }

        // The account bucket is far from spent (100), so only the address bucket can
        // produce this refusal — which is the property the case exists for.
        const blocked = await changePassword(url, seeds[0], seeds[0].password);
        assertRateLimitBlock(blocked, 'CHANGE_PASSWORD_RATE_LIMITED');
      }
    );
  });

  it('an anonymous caller is refused by authentication before any bucket is charged', async () => {
    await build(
      { changePasswordWindowMs: 60000, changePasswordMax: 1, changePasswordIpMax: 1 },
      async (url) => {
        for (let i = 0; i < 3; i++) {
          const res = await api(url, 'POST', '/api/auth/change-password', {
            body: { currentPassword: 'anything', newPassword: 'Replacement123!' },
          });
          assert.equal(res.status, 401, 'no token is an authentication answer, not a throttle');
          assert.equal(res.json.code, 'AUTH_REQUIRED');
        }

        // If the anonymous requests had spent either bucket, this first authenticated
        // attempt would already be a 429 (both caps are 1).
        const seed = await seedBusinessUser();
        const ok = await changePassword(url, seed, seed.password);
        assert.equal(ok.status, 200, 'anonymous traffic cannot spend an account\'s budget');
      }
    );
  });

  it('firebase/link is bounded per account', async () => {
    await build({ firebaseLinkWindowMs: 60000, firebaseLinkMax: 2 }, async (url) => {
      const seed = await seedBusinessUser();
      const link = () =>
        api(url, 'POST', '/api/auth/firebase/link', {
          token: seed.token,
          body: { idToken: 'not-a-firebase-token' },
        });

      // The first two attempts reach the controller and are refused for the token
      // (400) or for the missing Firebase configuration (503) — never for volume.
      for (let i = 0; i < 2; i++) {
        const res = await link();
        assert.notEqual(res.status, 429, `attempt ${i + 1} reaches the controller`);
      }

      assertRateLimitBlock(await link(), 'FIREBASE_LINK_RATE_LIMITED');
    });
  });

  it('credentials-changed is bounded per account', async () => {
    await build({ credentialsChangedWindowMs: 60000, credentialsChangedMax: 2 }, async (url) => {
      const seed = await seedBusinessUser();
      const record = () =>
        api(url, 'POST', '/api/auth/credentials-changed', {
          token: seed.token,
          body: { idToken: 'not-a-firebase-token' },
        });

      for (let i = 0; i < 2; i++) {
        const res = await record();
        assert.notEqual(res.status, 429, `attempt ${i + 1} reaches the controller`);
      }

      assertRateLimitBlock(await record(), 'CREDENTIALS_CHANGED_RATE_LIMITED');
    });
  });
});
