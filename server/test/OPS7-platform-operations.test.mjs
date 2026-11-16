// PLAT-1 — the INTERNAL Platform Operations surface and its durable stores.
//
// WHAT IS PINNED:
//   * the durable writers are preserved: a 5xx row carries no message/body/user,
//     and feature presence is one row per member/feature/day;
//   * platform administrators authenticate on their OWN plane — a tenant token is
//     refused there, and a platform token is refused on every tenant route;
//   * OWNER, ADMIN, MANAGER and STAFF are all refused, because no tenant role or
//     tenant permission reaches this surface;
//   * capability gating is real: READ_ONLY can identify itself but cannot read the
//     cross-tenant operations report, and a role/status change takes effect on the
//     very next request with the same token;
//   * the report aggregates across tenants, ignores any client-supplied
//     businessId, and returns no business name, member name, email or user id;
//   * the response is no-store and `days` is validated.

// The platform plane needs its own secret. Set before any token is signed; the
// platform JWT helper reads it at call time and never falls back to JWT_SECRET.
process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-admin-secret-0123456789abcdef0123456789abcdef';
// MFA is mandatory for every platform session; a missing key fails closed.
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-mfa-key-0123456789abcdef0123456789abcdef';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import { unitSuite, dbSuite } from './testEnv.mjs';
import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueEmail,
  disconnectDb,
} from './support.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { PLATFORM_ROLES } from '../src/constants/platformRoles.ts';
import errorHandler from '../src/middlewares/errorHandler.ts';
import PlatformAdmin from '../src/models/platformAdmin.model.ts';
import OpsErrorEvent from '../src/models/opsErrorEvent.model.ts';
import OpsFeatureUsage from '../src/models/opsFeatureUsage.model.ts';
import AiFeedback from '../src/models/aiFeedback.model.ts';
import {
  buildOpsErrorEvent,
  featureForPath,
  normalizeErrorPath,
  parseOperationsDays,
  recordFeatureUse,
  recordOperationalError,
} from '../src/services/operations.service.ts';
import { getPlatformOperationsSummary } from '../src/services/platformOperations.service.ts';
import { createPlatformAdminAccount } from '../src/services/platformAuth.service.ts';
import { decryptPlatformSecret } from '../src/services/platformMfa/secretVault.ts';
import { currentTotpCounter, generateTotp } from '../src/services/platformMfa/totp.ts';
import {
  platformSessionState,
  PLATFORM_SESSION_ABSOLUTE_CAP_MS,
  PLATFORM_SESSION_IDLE_MS,
} from '../src/services/platformSession.service.ts';
import { validateProductionConfig } from '../src/config/validateConfig.ts';
import { recordAiTurnMetric } from '../src/services/ai/aiMetrics.service.ts';

const PASSWORD = 'PlatformPass123!x';
const PLATFORM_PASSWORD = 'PlatformPass123!x';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

function metricInput(overrides = {}) {
  const now = new Date();
  return {
    turnId: `ops-${Math.random().toString(16).slice(2, 8)}`,
    businessId: String(new mongoose.Types.ObjectId()),
    userId: String(new mongoose.Types.ObjectId()),
    startedAt: new Date(now.getTime() - 1000),
    completedAt: now,
    outcome: 'ok',
    route: 'default',
    model: 'vendor/paid',
    upstream: 'vendor',
    durationMs: 1200,
    providerMs: 1100,
    toolMs: 100,
    calls: 2,
    emptyResponses: 0,
    retries: 0,
    failovers: 0,
    reasks: 0,
    escalations: 0,
    iterations: 2,
    toolRuns: 1,
    tools: ['getLowStockProducts'],
    inputTokens: 100,
    outputTokens: 40,
    providerCostUsd: 0.001,
    unknownCostCalls: 0,
    quota: 'unknown',
    web: 'none',
    ...overrides,
  };
}

unitSuite('PLAT-1 session boundaries', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const base = {
    revokedAt: null,
    lastUsedAt: new Date(now.getTime() - 1000),
    expiresAt: new Date(now.getTime() + PLATFORM_SESSION_ABSOLUTE_CAP_MS),
  };

  it('expires an idle session at 15 minutes and never by renewal', () => {
    assert.equal(platformSessionState(base, now), 'active');
    assert.equal(
      platformSessionState(
        { ...base, lastUsedAt: new Date(now.getTime() - PLATFORM_SESSION_IDLE_MS + 1) },
        now,
      ),
      'active',
    );
    assert.equal(
      platformSessionState(
        { ...base, lastUsedAt: new Date(now.getTime() - PLATFORM_SESSION_IDLE_MS) },
        now,
      ),
      'expired',
    );
  });

  it('enforces the 8-hour absolute cap and a revoked row', () => {
    assert.equal(
      platformSessionState(
        { ...base, expiresAt: new Date(now.getTime() - 1) },
        now,
      ),
      'expired',
    );
    assert.equal(
      platformSessionState(
        { ...base, revokedAt: new Date(now.getTime() - 1) },
        now,
      ),
      'revoked',
    );
  });
});

unitSuite('OPS-8 durable monitoring helpers', () => {
  it('bounds the day window to 1–30 and rejects typed query values', () => {
    assert.deepEqual(parseOperationsDays(undefined), { days: 7, problem: null });
    assert.deepEqual(parseOperationsDays('30'), { days: 30, problem: null });
    assert.match(parseOperationsDays('0').problem, /1 to 30/);
    assert.match(parseOperationsDays('31').problem, /1 to 30/);
    assert.match(parseOperationsDays('7.5').problem, /1 to 30/);
    assert.match(parseOperationsDays(['7']).problem, /1 to 30/);
  });

  it('maps only known TENANT feature prefixes — never a platform route', () => {
    assert.equal(featureForPath('/api/products'), 'products');
    assert.equal(featureForPath('/api/products/abc?x=1'), 'products');
    assert.equal(featureForPath('/api/products-archive'), null);
    assert.equal(featureForPath('/api/ai/feedback/123'), 'feedback');
    assert.equal(featureForPath('/api/ai/chat'), 'ai');
    // The tenant operations screen is gone; AI metrics stays in the AI bucket.
    assert.equal(featureForPath('/api/ai/metrics'), 'ai');
    assert.equal(featureForPath('/api/users/1'), 'team');
    // Platform reads are not tenant feature adoption and must not be recorded.
    assert.equal(featureForPath('/api/platform/operations'), null);
    assert.equal(featureForPath('/api/unrelated'), null);
  });

  it('normalises ids and strips the query string from an error route', () => {
    const id = '507f1f77bcf86cd799439011';
    assert.equal(
      normalizeErrorPath(`/api/products/${id}/edit?secret=1`),
      '/api/products/:id/edit',
    );
    assert.equal(normalizeErrorPath('/api/inventory/42'), '/api/inventory/:id');
    assert.equal(normalizeErrorPath(''), '/');
  });

  it('builds a bounded error row with no message, user or query data', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const row = buildOpsErrorEvent({
      businessId: '507f1f77bcf86cd799439011',
      status: 503,
      code: 'AI_UNAVAILABLE',
      method: 'post',
      path: '/api/ai/chat?token=should-not-be-stored',
      now,
    });
    assert.equal(row.status, 503);
    assert.equal(row.code, 'AI_UNAVAILABLE');
    assert.equal(row.method, 'POST');
    assert.equal(row.route, '/api/ai/chat');
    assert.equal(row.occurredAt.toISOString(), now.toISOString());
    assert.ok(row.expiresAt.getTime() > now.getTime());
    assert.equal('message' in row, false);
    assert.equal('userId' in row, false);
    assert.equal('requestBody' in row, false);

    const sanitized = buildOpsErrorEvent({
      businessId: 'not-an-id',
      status: 200,
      code: 'bad code',
      method: 'TRACE',
      path: '/api/x',
    });
    assert.equal(sanitized.status, 500);
    assert.equal(sanitized.code, 'INTERNAL_ERROR');
    assert.equal(sanitized.method, null);
    assert.equal(sanitized.businessId, null);
  });

  it('refuses a production build that reuses the tenant secret for the platform plane', () => {
    const tenantSecret = 'tenant-secret-0123456789abcdef0123456789abcdef';
    const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/test', JWT_SECRET: tenantSecret };

    const valid = validateProductionConfig({
      ...base,
      PLATFORM_ADMIN_JWT_SECRET: 'platform-secret-0123456789abcdef0123456789',
      PLATFORM_MFA_ENCRYPTION_KEY: 'mfa-key-0123456789abcdef0123456789abcdef',
    });
    assert.deepEqual(
      valid.filter((problem) => problem.variable === 'PLATFORM_ADMIN_JWT_SECRET'),
      [],
    );

    const reused = validateProductionConfig({
      ...base,
      PLATFORM_ADMIN_JWT_SECRET: tenantSecret,
    });
    assert.ok(
      reused.some(
        (problem) =>
          problem.variable === 'PLATFORM_ADMIN_JWT_SECRET' && /must not equal JWT_SECRET/.test(problem.message),
      ),
      'the platform plane must not reuse the tenant signing secret',
    );

    const short = validateProductionConfig({
      ...base,
      PLATFORM_ADMIN_JWT_SECRET: 'too-short',
    });
    assert.ok(
      short.some(
        (problem) =>
          problem.variable === 'PLATFORM_ADMIN_JWT_SECRET' && /at least/.test(problem.message),
      ),
    );
  });
});

dbSuite('PLAT-1 platform administrator access control', dbOk, () => {
  let owner;
  let admin;
  let manager;
  let staff;
  let otherOwner;
  let platformSuper;
  let platformReadOnly;
  let platformLogout;
  let platformDemoted;
  let platformDisabled;
  let superToken;
  let readOnlyToken;
  let logoutToken;
  let demotedToken;
  let disabledToken;

  /**
   * Complete the MANDATORY MFA flow and return an access token.
   *
   * A first login enrolls TOTP; a later login proves the existing secret. The
   * helper deliberately exercises the real HTTP routes rather than minting a
   * token in-process, so every platform test uses the production login path.
   */
  async function platformLogin(email) {
    const first = await api('POST', '/api/platform/auth/login', {
      body: { email, password: PLATFORM_PASSWORD, deviceLabel: 'test-runner' },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(typeof first.json.token, 'undefined', 'password login must not return an access token');

    if (first.json.mfaEnrollmentRequired) {
      const start = await api('POST', '/api/platform/auth/mfa/enroll/start', {
        body: { enrollmentToken: first.json.enrollmentToken },
      });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      const code = generateTotp(start.json.secret, currentTotpCounter());
      const confirm = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
        body: {
          enrollmentToken: start.json.enrollmentToken,
          code,
          deviceLabel: 'test-runner',
        },
      });
      assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
      assert.equal(confirm.json.admin.mfaEnabled, true);
      return confirm.json.token;
    }

    assert.equal(first.json.mfaRequired, true);
    const admin = await PlatformAdmin.findOne({ email })
      .select('+totpSecretEncrypted lastTotpCounter')
      .lean();
    assert.ok(admin?.totpSecretEncrypted, 'an MFA-enabled administrator must have an encrypted secret');
    const counter = Math.max(
      currentTotpCounter(),
      Number(admin.lastTotpCounter ?? 0) + 1,
    );
    const code = generateTotp(decryptPlatformSecret(admin.totpSecretEncrypted), counter);
    const verify = await api('POST', '/api/platform/auth/mfa/verify', {
      body: { mfaToken: first.json.mfaToken, code, deviceLabel: 'test-runner' },
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.json));
    return verify.json.token;
  }

  async function makePlatformAdmin(role) {
    const admin = await createPlatformAdminAccount({
      email: uniqueEmail(`plat-${role.toLowerCase()}`),
      name: `Platform ${role}`,
      password: PLATFORM_PASSWORD,
      role,
    });
    tracker.trackPlatformAdmin(admin._id);
    return admin;
  }

  before(async () => {
    owner = await registerOwner(api, tracker);
    admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
    otherOwner = await registerOwner(api, tracker);

    platformSuper = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    platformReadOnly = await makePlatformAdmin(PLATFORM_ROLES.READ_ONLY);
    platformLogout = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    platformDemoted = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    platformDisabled = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);

    superToken = await platformLogin(platformSuper.email);
    readOnlyToken = await platformLogin(platformReadOnly.email);
    logoutToken = await platformLogin(platformLogout.email);
    demotedToken = await platformLogin(platformDemoted.email);
    disabledToken = await platformLogin(platformDisabled.email);

    // Current-window facts for the HTTP report. The report is platform-wide, so
    // these are asserted as a LOWER BOUND — other suites share this database.
    const businessId = new mongoose.Types.ObjectId(owner.businessId);
    const otherBusinessId = new mongoose.Types.ObjectId(otherOwner.businessId);
    const db = mongoose.connection.db;

    await db.collection('products').insertMany([
      { businessId, name: 'Active one', status: 'ACTIVE' },
      { businessId, name: 'Active two', status: 'ACTIVE' },
      { businessId, name: 'Archived one', status: 'ARCHIVED' },
      { businessId: otherBusinessId, name: 'Other active', status: 'ACTIVE' },
    ]);
    await db.collection('locations').insertMany([
      { businessId, name: 'Main', status: 'ACTIVE' },
      { businessId: otherBusinessId, name: 'Other', status: 'ACTIVE' },
    ]);
    await db.collection('suppliers').insertMany([
      { businessId, name: 'Supplier', status: 'ACTIVE' },
      { businessId: otherBusinessId, name: 'Other supplier', status: 'ACTIVE' },
    ]);
    await db.collection('purchase_orders').insertMany([
      { businessId, number: 'PO-1', status: 'OPEN' },
      { businessId: otherBusinessId, number: 'PO-2', status: 'OPEN' },
    ]);
    await db.collection('inventory_transactions').insertMany([
      {
        businessId,
        productId: new mongoose.Types.ObjectId(),
        locationId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        type: 'STOCK_IN',
        quantity: 2,
        previousQuantity: 0,
        newQuantity: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        businessId: otherBusinessId,
        productId: new mongoose.Types.ObjectId(),
        locationId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        type: 'STOCK_OUT',
        quantity: 1,
        previousQuantity: 1,
        newQuantity: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const conversationId = new mongoose.Types.ObjectId();
    await AiFeedback.create([
      {
        businessId,
        conversationId,
        messageId: new mongoose.Types.ObjectId(),
        userId: owner.userId,
        rating: 'DOWN',
        reason: 'INCORRECT_DATA',
        status: 'OPEN',
      },
      {
        businessId,
        conversationId,
        messageId: new mongoose.Types.ObjectId(),
        userId: owner.userId,
        rating: 'DOWN',
        reason: 'MISSING_INFORMATION',
        status: 'REVIEWED',
        reviewedBy: owner.userId,
        reviewedAt: new Date(),
      },
      {
        businessId,
        conversationId,
        messageId: new mongoose.Types.ObjectId(),
        userId: admin.userId,
        rating: 'UP',
        status: 'OPEN',
      },
      {
        businessId: otherBusinessId,
        conversationId: new mongoose.Types.ObjectId(),
        messageId: new mongoose.Types.ObjectId(),
        userId: otherOwner.userId,
        rating: 'DOWN',
        reason: 'OTHER',
        status: 'OPEN',
      },
    ]);

    const now = Date.now();
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-ok-1',
        businessId: owner.businessId,
        userId: owner.userId,
        startedAt: new Date(now - 3000),
        completedAt: new Date(now - 2000),
        outcome: 'ok',
      }),
    );
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-deg-1',
        businessId: owner.businessId,
        userId: admin.userId,
        startedAt: new Date(now - 2000),
        completedAt: new Date(now - 1000),
        outcome: 'degraded',
      }),
    );
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-fail-1',
        businessId: owner.businessId,
        userId: owner.userId,
        startedAt: new Date(now - 1000),
        completedAt: new Date(now),
        outcome: 'failed',
        failovers: 1,
      }),
    );
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-other-1',
        businessId: otherOwner.businessId,
        userId: otherOwner.userId,
        outcome: 'ok',
      }),
    );

    await recordFeatureUse({
      businessId: owner.businessId,
      userId: owner.userId,
      feature: 'products',
    });
    await recordFeatureUse({
      businessId: owner.businessId,
      userId: admin.userId,
      feature: 'inventory',
    });
    await recordFeatureUse({
      businessId: otherOwner.businessId,
      userId: otherOwner.userId,
      feature: 'products',
    });

    await recordOperationalError({
      businessId: owner.businessId,
      status: 503,
      code: 'AI_UNAVAILABLE',
      method: 'POST',
      path: '/api/ai/chat?secret=not-stored',
    });
    await recordOperationalError({
      businessId: otherOwner.businessId,
      status: 500,
      code: 'INTERNAL_ERROR',
      method: 'GET',
      path: '/api/products/507f1f77bcf86cd799439011',
    });
  });

  it('rejects unauthenticated callers and every tenant role', async () => {
    const anonymous = await api('GET', '/api/platform/operations');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.code, 'PLATFORM_AUTH_REQUIRED');

    // OWNER, ADMIN, MANAGER and STAFF are ordinary business accounts. Their
    // tokens are valid tenant credentials and are still refused here.
    for (const [role, token] of [
      [ROLES.OWNER, owner.token],
      [ROLES.ADMIN, admin.token],
      [ROLES.MANAGER, manager.token],
      [ROLES.STAFF, staff.token],
    ]) {
      const res = await api('GET', '/api/platform/operations', { token });
      assert.equal(res.status, 401, `${role} must not reach platform operations`);
      assert.equal(res.json.code, 'PLATFORM_INVALID_TOKEN', `${role} token is not a platform token`);

      const me = await api('GET', '/api/platform/auth/me', { token });
      assert.equal(me.status, 401, `${role} must not reach the platform principal`);
    }
  });

  it('keeps the two credential realms separate in both directions', async () => {
    // A tenant credential is not a platform credential.
    const tenantOnPlatform = await api('POST', '/api/platform/auth/login', {
      body: { email: uniqueEmail('not-a-platform-admin'), password: PASSWORD },
    });
    assert.equal(tenantOnPlatform.status, 401);
    assert.equal(tenantOnPlatform.json.code, 'PLATFORM_INVALID_CREDENTIALS');

    // A platform credential is not a tenant credential.
    const platformOnTenant = await api('POST', '/api/auth/login', {
      body: { email: platformSuper.email, password: PLATFORM_PASSWORD },
    });
    assert.equal(platformOnTenant.status, 401);

    // A platform token cannot authenticate a tenant route.
    for (const path of ['/api/auth/me', '/api/dashboard', '/api/products']) {
      const res = await api('GET', path, { token: superToken });
      assert.equal(res.status, 401, `platform token must be refused on ${path}`);
      assert.equal(res.json.code, 'INVALID_TOKEN');
    }
  });

  it('enforces platform capabilities, not tenant roles', async () => {
    const allowed = await api('GET', '/api/platform/operations?days=7', { token: superToken });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.equal(allowed.json.range.days, 7);
    assert.equal(allowed.json.range.timeZone, 'UTC');
    assert.equal(allowed.json.service.status, 'ok');
    assert.equal(allowed.json.service.database, 'connected');

    const me = await api('GET', '/api/platform/auth/me', { token: readOnlyToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.admin.role, PLATFORM_ROLES.READ_ONLY);
    assert.deepEqual(me.json.admin.capabilities, ['platform.health.read']);

    // READ_ONLY can identify itself but cannot read cross-tenant metrics.
    const denied = await api('GET', '/api/platform/operations', { token: readOnlyToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'PLATFORM_FORBIDDEN');

    const badDays = await api('GET', '/api/platform/operations?days=31', { token: superToken });
    assert.equal(badDays.status, 400);
    assert.equal(badDays.json.code, 'VALIDATION_ERROR');
  });

  it('fails closed when the platform secret is not configured', async () => {
    const saved = process.env.PLATFORM_ADMIN_JWT_SECRET;
    delete process.env.PLATFORM_ADMIN_JWT_SECRET;
    try {
      const res = await api('GET', '/api/platform/operations', { token: superToken });
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'PLATFORM_AUTH_NOT_CONFIGURED');

      // Login fails closed too, and the answer does not depend on whether the
      // submitted credential is correct — no configuration oracle.
      for (const password of [PLATFORM_PASSWORD, 'definitely-the-wrong-password']) {
        const login = await api('POST', '/api/platform/auth/login', {
          body: { email: platformSuper.email, password },
        });
        assert.equal(login.status, 503);
        assert.equal(login.json.code, 'PLATFORM_AUTH_NOT_CONFIGURED');
      }
    } finally {
      process.env.PLATFORM_ADMIN_JWT_SECRET = saved;
    }
  });

  it('returns a platform-wide report and ignores a client-supplied businessId', async () => {
    const res = await api(
      'GET',
      `/api/platform/operations?days=7&businessId=${owner.businessId}`,
      { token: superToken },
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));

    // Lower bounds: this database is shared with parallel suites, so the report
    // contains at least the two tenants seeded here. The exact cross-tenant
    // aggregation is proved deterministically in the fixed-window suite below.
    assert.ok(res.json.platform.businesses.total >= 2);
    assert.ok(res.json.platform.accounts.active >= 4);
    assert.ok(res.json.ai.turns >= 4, JSON.stringify(res.json.ai));
    assert.ok(res.json.feedback.total >= 4, JSON.stringify(res.json.feedback));
    assert.ok(res.json.usage.products.active >= 3, JSON.stringify(res.json.usage));
    assert.ok(res.json.issues.count >= 2, JSON.stringify(res.json.issues));
    assert.ok(res.json.issues.affectedTenants >= 2, JSON.stringify(res.json.issues));

    const featureMap = new Map(
      res.json.usage.features.map((row) => [row.feature, row.members]),
    );
    assert.ok((featureMap.get('products') ?? 0) >= 2);
    assert.ok((featureMap.get('inventory') ?? 0) >= 1);

    // The selector changes nothing: there is no tenant parameter in the service.
    const withoutSelector = await api('GET', '/api/platform/operations?days=7', {
      token: superToken,
    });
    assert.equal(withoutSelector.status, 200);
    assert.equal(withoutSelector.json.ai.turns, res.json.ai.turns);
    assert.equal(withoutSelector.json.feedback.total, res.json.feedback.total);
    assert.equal(withoutSelector.json.issues.count, res.json.issues.count);
  });

  it('never returns business names, member identities or emails, and is not cached', async () => {
    const res = await fetch(`${baseUrl}/api/platform/operations?days=7`, {
      headers: { authorization: `Bearer ${superToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.equal(body.includes('@example.com'), false);
    assert.equal(body.includes(owner.userId), false);
    assert.equal(body.includes(otherOwner.userId), false);
    assert.equal(body.includes('businessName'), false);
    assert.equal(body.includes('reportedBy'), false);
  });

  it('re-reads role and status from the database on every request', async () => {
    // A SUPPORT administrator may read metrics; demotion to READ_ONLY takes
    // effect on the SAME token, without a new login.
    const beforeDemotion = await api('GET', '/api/platform/operations', { token: demotedToken });
    assert.equal(beforeDemotion.status, 200);
    await PlatformAdmin.updateOne(
      { _id: platformDemoted._id },
      { $set: { role: PLATFORM_ROLES.READ_ONLY } },
    );
    const afterDemotion = await api('GET', '/api/platform/operations', { token: demotedToken });
    assert.equal(afterDemotion.status, 403);
    assert.equal(afterDemotion.json.code, 'PLATFORM_FORBIDDEN');

    // Disabling the row is immediate too.
    await PlatformAdmin.updateOne(
      { _id: platformDisabled._id },
      { $set: { status: 'DISABLED' } },
    );
    const disabled = await api('GET', '/api/platform/operations', { token: disabledToken });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.json.code, 'PLATFORM_ACCOUNT_DISABLED');
  });

  it('renews a token for the same session and revokes it on logout', async () => {
    const sessionsBefore = await mongoose.connection.db
      .collection('platform_admin_sessions')
      .countDocuments({ adminId: new mongoose.Types.ObjectId(platformLogout._id) });

    const renewed = await api('POST', '/api/platform/auth/renew', { token: logoutToken });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.json));
    assert.equal(typeof renewed.json.token, 'string');

    const sessionsAfter = await mongoose.connection.db
      .collection('platform_admin_sessions')
      .countDocuments({ adminId: new mongoose.Types.ObjectId(platformLogout._id) });
    assert.equal(sessionsAfter, sessionsBefore, 'renewal must not create a session row');

    const me = await api('GET', '/api/platform/auth/me', { token: renewed.json.token });
    assert.equal(me.status, 200);

    const logout = await api('POST', '/api/platform/auth/logout', { token: renewed.json.token });
    assert.equal(logout.status, 200);

    const afterLogout = await api('GET', '/api/platform/auth/me', { token: renewed.json.token });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.json.code, 'PLATFORM_SESSION_REVOKED');
  });

  it('stores one presence row per member/feature/day', async () => {
    const rows = await OpsFeatureUsage.find({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      feature: 'products',
      userId: new mongoose.Types.ObjectId(owner.userId),
    }).lean();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].firstSeenAt instanceof Date);
    assert.ok(rows[0].lastSeenAt instanceof Date);
  });

  it('keeps the 5xx row durable and bounded', async () => {
    const event = await OpsErrorEvent.findOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
    }).lean();
    assert.ok(event);
    assert.equal(event.status, 503);
    assert.equal(event.code, 'AI_UNAVAILABLE');
    assert.equal(event.route, '/api/ai/chat');
    assert.equal('message' in event, false);
    assert.equal('userId' in event, false);
  });

  it('records a real handler 5xx without its message', async () => {
    const local = express();
    local.use((req, _res, next) => {
      req.user = { id: owner.userId, businessId: owner.businessId };
      next();
    });
    local.get('/api/products/:id/broken', () => {
      throw new Error('secret internal detail that must never be stored');
    });
    local.use(errorHandler);

    const httpServer = local.listen(0);
    await new Promise((resolve) => httpServer.once('listening', resolve));
    const port = httpServer.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/products/507f1f77bcf86cd799439011/broken`);
      assert.equal(res.status, 500);
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    let event = null;
    for (let i = 0; i < 20 && !event; i += 1) {
      event = await OpsErrorEvent.findOne({
        businessId: new mongoose.Types.ObjectId(owner.businessId),
        route: '/api/products/:id/broken',
      }).lean();
      if (!event) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(event, 'the error handler did not persist its 5xx');
    assert.equal(event.status, 500);
    assert.equal(event.code, 'INTERNAL_ERROR');
    assert.equal(event.method, 'GET');
    assert.equal(event.route, '/api/products/:id/broken');
    assert.equal(JSON.stringify(event).includes('secret internal detail'), false);
    assert.equal('message' in event, false);
    assert.equal('stack' in event, false);
    assert.equal('userId' in event, false);
  });

  it('records feature presence after a successful authenticated response', async () => {
    await api('GET', '/api/products', { token: admin.token });

    let row = null;
    for (let i = 0; i < 20 && !row; i += 1) {
      row = await OpsFeatureUsage.findOne({
        businessId: new mongoose.Types.ObjectId(owner.businessId),
        userId: new mongoose.Types.ObjectId(admin.userId),
        feature: 'products',
        date: new Date().toISOString().slice(0, 10),
      }).lean();
      if (!row) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(row, 'the feature middleware did not persist the successful request');
    const count = await OpsFeatureUsage.countDocuments({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      userId: new mongoose.Types.ObjectId(admin.userId),
      feature: 'products',
      date: new Date().toISOString().slice(0, 10),
    });
    assert.equal(count, 1, 'one member/feature/day must create exactly one row');
  });
});

dbSuite('PLAT-1 cross-tenant aggregation (fixed window)', dbOk, () => {
  const now = new Date('2019-01-07T12:00:00.000Z');
  const inside = new Date('2019-01-03T10:00:00.000Z');

  let businessA;
  let businessB;
  let memberA;
  let memberB;
  let otherOwner;

  before(async () => {
    // One real tenant registered through the API, plus raw rows for a second.
    otherOwner = await registerOwner(api, tracker);
    businessA = new mongoose.Types.ObjectId(otherOwner.businessId);
    businessB = new mongoose.Types.ObjectId();
    memberA = new mongoose.Types.ObjectId(otherOwner.userId);
    memberB = new mongoose.Types.ObjectId();

    // AI: two turns, one per tenant, in the fixed window.
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-fixed-a',
        businessId: String(businessA),
        userId: String(memberA),
        startedAt: new Date(inside.getTime() - 1000),
        completedAt: inside,
        outcome: 'ok',
      }),
    );
    await recordAiTurnMetric(
      metricInput({
        turnId: 'plat-fixed-b',
        businessId: String(businessB),
        userId: String(memberB),
        startedAt: new Date(inside.getTime() - 1000),
        completedAt: inside,
        outcome: 'failed',
        failovers: 1,
      }),
    );

    // Feedback: one per tenant, one down reason each.
    await AiFeedback.create([
      {
        businessId: businessA,
        conversationId: new mongoose.Types.ObjectId(),
        messageId: new mongoose.Types.ObjectId(),
        userId: memberA,
        rating: 'DOWN',
        reason: 'INCORRECT_DATA',
        status: 'OPEN',
        createdAt: inside,
        updatedAt: inside,
      },
      {
        businessId: businessB,
        conversationId: new mongoose.Types.ObjectId(),
        messageId: new mongoose.Types.ObjectId(),
        userId: memberB,
        rating: 'DOWN',
        reason: 'MISSING_INFORMATION',
        status: 'OPEN',
        createdAt: inside,
        updatedAt: inside,
      },
    ]);

    // Feature presence: two members on one tenant and one on the other.
    await recordFeatureUse({
      businessId: String(businessA),
      userId: String(memberA),
      feature: 'products',
      at: inside,
    });
    await recordFeatureUse({
      businessId: String(businessB),
      userId: String(memberB),
      feature: 'inventory',
      at: inside,
    });

    // Errors: one per tenant at a fixed instant.
    await recordOperationalError({
      businessId: String(businessA),
      status: 503,
      code: 'AI_UNAVAILABLE',
      method: 'POST',
      path: '/api/ai/chat',
      now: inside,
    });
    await recordOperationalError({
      businessId: String(businessB),
      status: 500,
      code: 'INTERNAL_ERROR',
      method: 'GET',
      path: '/api/products/507f1f77bcf86cd799439011',
      now: inside,
    });
    // A pre-authentication 5xx has no tenant. It must count in the platform
    // total and must NOT inflate the affected-tenant count.
    await recordOperationalError({
      status: 500,
      code: 'INTERNAL_ERROR',
      method: 'GET',
      path: '/api/health',
      now: inside,
    });
  });

  it('counts both tenants in one report and never one tenant’s rows only', async () => {
    const report = await getPlatformOperationsSummary({ days: 7, now });

    assert.equal(report.range.days, 7);
    assert.equal(report.range.from, '2019-01-01T00:00:00.000Z');

    // AI — exactly the two fixed turns, one per tenant.
    assert.equal(report.ai.turns, 2);
    assert.equal(report.ai.okTurns, 1);
    assert.equal(report.ai.failedTurns, 1);
    assert.equal(report.ai.successRate, 0.5);

    // Feedback — exactly the two fixed reports.
    assert.equal(report.feedback.window.total, 2);
    assert.equal(report.feedback.window.down, 2);
    const reasons = new Map(
      report.feedback.window.byReason.map((row) => [row.reason, row.count]),
    );
    assert.equal(reasons.get('INCORRECT_DATA'), 1);
    assert.equal(reasons.get('MISSING_INFORMATION'), 1);
    assert.equal(reasons.get('OTHER'), 0);

    // Usage — two distinct members and two distinct tenants in the window.
    assert.equal(report.usage.activeMembers.inWindow, 2);
    assert.equal(report.platform.tenantsActiveInWindow, 2);
    const features = new Map(report.usage.features.map((row) => [row.feature, row.members]));
    assert.equal(features.get('products'), 1);
    assert.equal(features.get('inventory'), 1);

    // Issues — three errors: two tenants plus one pre-auth row with no tenant.
    // The pre-auth row counts in the total but not as an affected tenant.
    assert.equal(report.issues.count, 3);
    assert.equal(report.issues.affectedTenants, 2);
    assert.equal(report.issues.byRoute.length, 3);
    const routes = report.issues.byRoute.map((row) => row.route).sort();
    assert.deepEqual(routes, ['/api/ai/chat', '/api/health', '/api/products/:id']);
    const byRoute = new Map(report.issues.byRoute.map((row) => [row.route, row.affectedTenants]));
    assert.equal(byRoute.get('/api/ai/chat'), 1);
    assert.equal(byRoute.get('/api/products/:id'), 1);
    assert.equal(byRoute.get('/api/health'), 0);

    // Catalogue/platform counts are global and shared with other suites; only
    // their presence and non-negative shape are asserted here.
    assert.ok(report.platform.businesses.total >= 1);
    assert.ok(report.platform.accounts.total >= 1);
    assert.ok(report.usage.products.active >= 0);
  });

  it('does not accept a tenant selector at the service boundary', async () => {
    // The service signature has no businessId parameter. Passing one in the bag
    // is ignored by construction — the same report is returned.
    const report = await getPlatformOperationsSummary({
      days: 7,
      now,
      businessId: String(businessA),
    });
    assert.equal(report.ai.turns, 2);
    assert.equal(report.issues.count, 3);
    assert.equal(report.issues.affectedTenants, 2);
  });

  // This suite's second tenant is a bare ObjectId, not a registered business, so
  // the shared tracker cannot remove its rows. Delete them explicitly; the first
  // tenant is tracked and cleaned by the file-level hook below.
  after(async () => {
    if (!dbOk) return;
    const db = mongoose.connection.db;
    for (const collection of [
      'ai_turn_metrics',
      'ai_feedback',
      'ops_feature_usage',
      'ops_error_events',
    ]) {
      await db.collection(collection).deleteMany({ businessId: businessB });
    }
    // The pre-authentication error has no tenant and is not covered above.
    await db
      .collection('ops_error_events')
      .deleteMany({ route: '/api/health', occurredAt: inside });
  });
});

// One lifecycle for the whole file: both dbSuites share the real app and the
// same connection, so closing either inside a suite would strand the other.
after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});
