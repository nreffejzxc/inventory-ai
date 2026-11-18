// PLAT-7 — recovery setup, the outer access gate and the break-glass reset.
//
// WHAT IS PINNED:
//   * a signed-in administrator with no unused recovery codes can read only
//     `/auth/me`, `/auth/csrf`, `/auth/logout` and the recovery-code ceremony;
//     every protected route is refused by the server with a fixed code;
//   * generating recovery codes unlocks the console, and a code completes a
//     later login;
//   * `PLATFORM_ACCESS_KEY` gates `/platform` and `/api/platform` with HTTP
//     Basic before the platform login is reachable, and production validation
//     refuses to omit it;
//   * the break-glass service resets a totally locked-out administrator, clears
//     every factor and session, leaves the account needing a fresh enrollment,
//     and writes an audit event without a password.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-recovery-secret-0123456789abcdef0123456789';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-recovery-mfa-key-0123456789abcdef0123456789';
process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4100';

import { it, after } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite, dbSuite } from './testEnv.mjs';
import {
  startServer,
  makeApi,
  createTracker,
  uniqueEmail,
  disconnectDb,
} from './support.mjs';
import { PLATFORM_ROLES } from '../src/constants/platformRoles.ts';
import { createPlatformAdminAccount } from '../src/services/platformAuth.service.ts';
import { breakGlassPlatformAdmin } from '../src/services/platformBreakGlass.service.ts';
import platformAccessGate, {
  parsePlatformBasicAuth,
  platformAccessGateStateForTests,
  resetPlatformAccessGateLimiter,
  PLATFORM_ACCESS_HEADER,
  PLATFORM_ACCESS_RATE_LIMITED_CODE,
  PLATFORM_ACCESS_REQUIRED_CODE,
} from '../src/middlewares/platformAccessGate.ts';
import { PLATFORM_RECOVERY_SETUP_REQUIRED_CODE } from '../src/middlewares/platformAuthenticate.ts';
import {
  currentTotpCounter,
  generateTotp,
} from '../src/services/platformMfa/totp.ts';
import PlatformAdmin from '../src/models/platformAdmin.model.ts';
import PlatformAuditLog from '../src/models/platformAuditLog.model.ts';
import { PLATFORM_AUDIT_ACTIONS } from '../src/constants/platformAudit.ts';

const PASSWORD = 'PlatformRecovery123!';
const NEW_PASSWORD = 'PlatformBreakGlass456!';
const CONSOLE_ORIGIN = 'http://localhost:4100';
const ACCESS_KEY = 'outer-access-key-0123456789abcdef0123456789';
const ACCESS_USER = 'gate-user';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

function track(admin) {
  tracker.trackPlatformAdmin(admin._id);
  return admin;
}

async function makePlatformAdmin() {
  return track(
    await createPlatformAdminAccount({
      email: uniqueEmail('plat7-admin'),
      name: 'PLAT7 Administrator',
      password: PASSWORD,
      role: PLATFORM_ROLES.SUPERADMIN,
    }),
  );
}

async function passwordLogin(email, password = PASSWORD) {
  return api('POST', '/api/platform/auth/login', {
    body: { email, password, deviceLabel: 'plat7' },
  });
}

async function enroll(admin, { generateCodes = true, password = PASSWORD } = {}) {
  const first = await passwordLogin(admin.email, password);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.mfaEnrollmentRequired, true);
  assert.equal(first.json.token, undefined);

  const headers = { Origin: CONSOLE_ORIGIN };
  const start = await api('POST', '/api/platform/auth/mfa/enroll/start', {
    body: { enrollmentToken: first.json.enrollmentToken },
    headers,
  });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const code = generateTotp(start.json.secret, currentTotpCounter());
  const confirm = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
    body: {
      enrollmentToken: start.json.enrollmentToken,
      code,
      deviceLabel: 'plat7',
    },
    headers,
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const token = confirm.json.token;
  assert.equal(typeof token, 'string');

  let codes = null;
  if (generateCodes) {
    const generated = await api('POST', '/api/platform/auth/recovery-codes', {
      token,
      body: { password },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    codes = generated.json.codes;
  }
  return { token, codes };
}

unitSuite('PLAT-7 access gate', () => {
  it('parses one Basic credential pair and refuses malformed headers', () => {
    const encoded = Buffer.from('gate-user:secret-key').toString('base64');
    assert.deepEqual(parsePlatformBasicAuth(`Basic ${encoded}`), {
      user: 'gate-user',
      key: 'secret-key',
    });
    assert.equal(parsePlatformBasicAuth('Bearer token'), null);
    assert.equal(parsePlatformBasicAuth('Basic !!!'), null);
    assert.equal(parsePlatformBasicAuth(undefined), null);
    assert.equal(parsePlatformBasicAuth(`Basic ${Buffer.from('no-colon').toString('base64')}`), null);
  });

});

dbSuite('PLAT-7 recovery ceremony and break-glass reset', dbOk, () => {
  it('gates the console and API before platform authentication', async () => {
    const previousKey = process.env.PLATFORM_ACCESS_KEY;
    const previousUser = process.env.PLATFORM_ACCESS_USER;
    process.env.PLATFORM_ACCESS_KEY = ACCESS_KEY;
    process.env.PLATFORM_ACCESS_USER = ACCESS_USER;
    const encoded = Buffer.from(`${ACCESS_USER}:${ACCESS_KEY}`).toString('base64');
    const basic = { Authorization: `Basic ${encoded}` };
    try {
      const shell = await fetch(`${baseUrl}/platform/`);
      assert.equal(shell.status, 401);
      assert.match(shell.headers.get('www-authenticate') || '', /^Basic realm=/);
      assert.equal(await shell.json().then((body) => body.code), PLATFORM_ACCESS_REQUIRED_CODE);

      const gated = await fetch(`${baseUrl}/api/platform/auth/me`);
      assert.equal(gated.status, 401);
      assert.equal((await gated.json()).code, PLATFORM_ACCESS_REQUIRED_CODE);

      const shellWithKey = await fetch(`${baseUrl}/platform/`, { headers: basic });
      assert.equal(shellWithKey.status, 200);
      assert.match(shellWithKey.headers.get('content-type') || '', /text\/html/);

      // Passing the outer gate is not platform authentication: the route still
      // answers with its own 401, which proves the gate did not become an auth.
      const me = await fetch(`${baseUrl}/api/platform/auth/me`, { headers: basic });
      assert.equal(me.status, 401);
      assert.equal((await me.json()).code, 'PLATFORM_AUTH_REQUIRED');

      // An API client has Authorization occupied by its Bearer token and names
      // the shared key in the dedicated header instead.
      const headerGated = await fetch(`${baseUrl}/api/platform/auth/me`, {
        headers: { [PLATFORM_ACCESS_HEADER]: ACCESS_KEY },
      });
      assert.equal(headerGated.status, 401);
      assert.equal((await headerGated.json()).code, 'PLATFORM_AUTH_REQUIRED');

      const preflight = await fetch(`${baseUrl}/api/platform/auth/login`, { method: 'OPTIONS' });
      assert.notEqual(preflight.status, 401, 'a CORS preflight carries no credentials');

      // NS-05 — wrong keys are bounded, the correct key still works, and one
      // sampled audit row records the source without any key material.
      const previousGateWindow = process.env.PLATFORM_ACCESS_GATE_WINDOW_MS;
      const previousGateMax = process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES;
      const previousGateGlobalMax = process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES;
      process.env.PLATFORM_ACCESS_GATE_WINDOW_MS = '60000';
      process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES = '3';
      process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES = '1000';
      resetPlatformAccessGateLimiter();
      const gateProbe = `/api/platform/auth/me?ns05=${Date.now()}`;
      try {
        const wrongBasic = `Basic ${Buffer.from(`${ACCESS_USER}:wrong-key`).toString('base64')}`;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const wrong = await fetch(`${baseUrl}${gateProbe}`, {
            headers: { Authorization: wrongBasic },
          });
          assert.equal(wrong.status, 401, `attempt ${attempt} should be a bounded 401`);
          assert.equal((await wrong.json()).code, PLATFORM_ACCESS_REQUIRED_CODE);
        }

        const limited = await fetch(`${baseUrl}${gateProbe}`, {
          headers: { Authorization: wrongBasic },
        });
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).code, PLATFORM_ACCESS_RATE_LIMITED_CODE);
        assert.ok(Number(limited.headers.get('retry-after')) > 0);

        // The budget is for failures only: a correct key passes the gate and
        // reaches the platform authentication middleware (its own 401).
        const stillWorks = await fetch(`${baseUrl}/api/platform/auth/me`, { headers: basic });
        assert.equal(stillWorks.status, 401);
        assert.equal((await stillWorks.json()).code, 'PLATFORM_AUTH_REQUIRED');

        const auditRows = await PlatformAuditLog.find({
          action: PLATFORM_AUDIT_ACTIONS.ACCESS_GATE_DENIED,
          route: gateProbe,
        }).lean();
        assert.equal(auditRows.length, 1, 'one sampled gate event for the burst');
        const serialized = JSON.stringify(auditRows[0]);
        assert.equal(serialized.includes(ACCESS_KEY), false);
        assert.equal(serialized.includes('wrong-key'), false);
        assert.equal(auditRows[0].metadata.gate, 'basic');
      } finally {
        if (previousGateWindow === undefined) delete process.env.PLATFORM_ACCESS_GATE_WINDOW_MS;
        else process.env.PLATFORM_ACCESS_GATE_WINDOW_MS = previousGateWindow;
        if (previousGateMax === undefined) delete process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES;
        else process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES = previousGateMax;
        if (previousGateGlobalMax === undefined) {
          delete process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES;
        } else {
          process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES = previousGateGlobalMax;
        }
        resetPlatformAccessGateLimiter();
      }
    } finally {
      if (previousKey === undefined) delete process.env.PLATFORM_ACCESS_KEY;
      else process.env.PLATFORM_ACCESS_KEY = previousKey;
      if (previousUser === undefined) delete process.env.PLATFORM_ACCESS_USER;
      else process.env.PLATFORM_ACCESS_USER = previousUser;
    }
  });

  it('caps the global failure budget without growing state or audit rows', async () => {
    const previousKey = process.env.PLATFORM_ACCESS_KEY;
    const previousUser = process.env.PLATFORM_ACCESS_USER;
    const previousWindow = process.env.PLATFORM_ACCESS_GATE_WINDOW_MS;
    const previousMax = process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES;
    const previousGlobalMax = process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES;
    process.env.PLATFORM_ACCESS_KEY = ACCESS_KEY;
    process.env.PLATFORM_ACCESS_USER = ACCESS_USER;
    process.env.PLATFORM_ACCESS_GATE_WINDOW_MS = '60000';
    process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES = '100';
    process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES = '2';
    resetPlatformAccessGateLimiter();
    const probe = `/api/platform/auth/me?global=${Date.now()}`;
    const wrongBasic = `Basic ${Buffer.from(`${ACCESS_USER}:wrong-key`).toString('base64')}`;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await fetch(`${baseUrl}${probe}`, {
          headers: { Authorization: wrongBasic },
        });
        assert.equal(response.status, 401, `attempt ${attempt} should be a bounded 401`);
      }

      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const response = await fetch(`${baseUrl}${probe}`, {
          headers: { Authorization: wrongBasic },
        });
        assert.equal(response.status, 429, `attempt ${attempt + 2} should be globally capped`);
      }

      // A different address must not get a bucket or an audit row after the
      // shared budget is exhausted. Invoke the real middleware with a fake req
      // because the test server sees one loopback address.
      let cappedStatus = 0;
      let cappedBody = null;
      let nextCalled = false;
      await platformAccessGate(
        {
          method: 'GET',
          headers: { authorization: wrongBasic },
          ip: '203.0.113.77',
          originalUrl: `${probe}&new-address`,
          socket: {},
        },
        {
          setHeader() {},
          status(code) {
            cappedStatus = code;
            return this;
          },
          json(body) {
            cappedBody = body;
            return this;
          },
        },
        () => {
          nextCalled = true;
        },
      );
      assert.equal(cappedStatus, 429);
      assert.equal(cappedBody.code, PLATFORM_ACCESS_RATE_LIMITED_CODE);
      assert.equal(nextCalled, false);

      assert.deepEqual(platformAccessGateStateForTests(), {
        trackedAddresses: 1,
        globalFailures: 2,
      });

      const auditRows = await PlatformAuditLog.find({
        action: PLATFORM_AUDIT_ACTIONS.ACCESS_GATE_DENIED,
        route: probe,
      }).lean();
      assert.equal(auditRows.length, 1, 'the global cap stops further audit rows');

      const stillWorks = await fetch(`${baseUrl}/api/platform/auth/me`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${ACCESS_USER}:${ACCESS_KEY}`).toString('base64')}`,
        },
      });
      assert.equal(stillWorks.status, 401);
      assert.equal((await stillWorks.json()).code, 'PLATFORM_AUTH_REQUIRED');
    } finally {
      if (previousKey === undefined) delete process.env.PLATFORM_ACCESS_KEY;
      else process.env.PLATFORM_ACCESS_KEY = previousKey;
      if (previousUser === undefined) delete process.env.PLATFORM_ACCESS_USER;
      else process.env.PLATFORM_ACCESS_USER = previousUser;
      if (previousWindow === undefined) delete process.env.PLATFORM_ACCESS_GATE_WINDOW_MS;
      else process.env.PLATFORM_ACCESS_GATE_WINDOW_MS = previousWindow;
      if (previousMax === undefined) delete process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES;
      else process.env.PLATFORM_ACCESS_GATE_MAX_FAILURES = previousMax;
      if (previousGlobalMax === undefined) {
        delete process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES;
      } else {
        process.env.PLATFORM_ACCESS_GATE_GLOBAL_MAX_FAILURES = previousGlobalMax;
      }
      resetPlatformAccessGateLimiter();
    }
  });

  it('records exactly one platform.admin.created event with operator, source and target', async () => {
    const email = uniqueEmail('plat7-created');
    const audit = { operator: 'operator@example.com', source: 'cli', grantId: 'grant-plat7' };
    const admin = await createPlatformAdminAccount({
      email,
      name: 'PLAT7 Created',
      password: PASSWORD,
      role: PLATFORM_ROLES.SUPERADMIN,
      audit,
    });
    track(admin);

    const rows = await PlatformAuditLog.find({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_CREATED,
      'metadata.targetAdminId': String(admin._id),
    }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorEmail, audit.operator);
    assert.equal(rows[0].metadata.targetEmail, email);
    assert.equal(rows[0].metadata.targetRole, PLATFORM_ROLES.SUPERADMIN);
    assert.equal(rows[0].metadata.source, 'cli');
    assert.equal(rows[0].metadata.grantId, 'grant-plat7');
    assert.equal(JSON.stringify(rows[0]).includes(PASSWORD), false);

    await assert.rejects(
      () =>
        createPlatformAdminAccount({
          email,
          name: 'Duplicate',
          password: PASSWORD,
          role: PLATFORM_ROLES.SUPERADMIN,
          audit,
        }),
      (err) => {
        assert.equal(err.code, 'PLATFORM_ADMIN_EXISTS');
        return true;
      },
    );
    const afterDuplicate = await PlatformAuditLog.countDocuments({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_CREATED,
      'metadata.targetAdminId': String(admin._id),
    });
    assert.equal(afterDuplicate, 1, 'a failed creation writes no success event');
  });

  it('refuses protected work until recovery codes exist, then unlocks and accepts a code', async () => {
    const admin = await makePlatformAdmin();
    const { token } = await enroll(admin, { generateCodes: false });

    const me = await api('GET', '/api/platform/auth/me', { token });
    assert.equal(me.status, 200, JSON.stringify(me.json));
    assert.equal(me.json.recoverySetupRequired, true);
    assert.equal(me.json.admin.recoveryCodesRemaining, 0);

    for (const path of ['/api/platform/operations', '/api/platform/audit', '/api/platform/tickets']) {
      const refused = await api('GET', path, { token });
      assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.json)}`);
      assert.equal(refused.json.code, PLATFORM_RECOVERY_SETUP_REQUIRED_CODE);
    }

    const generated = await api('POST', '/api/platform/auth/recovery-codes', {
      token,
      body: { password: PASSWORD },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.equal(generated.json.codes.length, 10);
    assert.equal(generated.json.remaining, 10);

    const unlockedMe = await api('GET', '/api/platform/auth/me', { token });
    assert.equal(unlockedMe.status, 200, JSON.stringify(unlockedMe.json));
    assert.equal(unlockedMe.json.recoverySetupRequired, false);
    assert.equal(unlockedMe.json.admin.recoveryCodesRemaining, 10);

    const operations = await api('GET', '/api/platform/operations', { token });
    assert.equal(operations.status, 200, JSON.stringify(operations.json));

    // A recovery code is a complete second-factor login, not merely a view flag.
    const first = await passwordLogin(admin.email);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.mfaRequired, true);
    const recovered = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: first.json.mfaToken,
        recoveryCode: generated.json.codes[0],
        deviceLabel: 'plat7 recovery',
      },
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
    assert.equal(typeof recovered.json.token, 'string');
    assert.equal(recovered.json.mfa.remaining, 9);

    const replay = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: first.json.mfaToken,
        recoveryCode: generated.json.codes[0],
        deviceLabel: 'plat7 replay',
      },
    });
    assert.notEqual(replay.status, 200);
  });

  it('break-glass resets every factor and session, then requires a fresh setup', async () => {
    const admin = await makePlatformAdmin();
    const { token: oldToken } = await enroll(admin);
    const oldSession = await api('GET', '/api/platform/auth/me', { token: oldToken });
    assert.equal(oldSession.status, 200);

    const reset = await breakGlassPlatformAdmin({
      email: admin.email,
      newPassword: NEW_PASSWORD,
      operator: 'test-operator',
    });
    assert.equal(reset.email, admin.email);
    assert.equal(reset.status, 'ACTIVE');

    const oldSessionAfter = await api('GET', '/api/platform/auth/me', { token: oldToken });
    assert.equal(oldSessionAfter.status, 401);

    const oldPassword = await passwordLogin(admin.email);
    assert.equal(oldPassword.status, 401, 'the old password must stop working');

    const row = await PlatformAdmin.findOne({ email: admin.email })
      .select('+recoveryCodes +totpSecretEncrypted +webauthnCredentials')
      .lean();
    assert.equal(row.mfaEnabled, false);
    assert.equal(row.totpSecretEncrypted, null);
    assert.deepEqual(row.recoveryCodes, []);
    assert.deepEqual(row.webauthnCredentials, []);

    const fresh = await enroll(admin, { generateCodes: false, password: NEW_PASSWORD });
    const forced = await api('GET', '/api/platform/operations', { token: fresh.token });
    assert.equal(forced.status, 403);
    assert.equal(forced.json.code, PLATFORM_RECOVERY_SETUP_REQUIRED_CODE);

    const generated = await api('POST', '/api/platform/auth/recovery-codes', {
      token: fresh.token,
      body: { password: NEW_PASSWORD },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    const rebuilt = await api('GET', '/api/platform/operations', { token: fresh.token });
    assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.json));

    const audit = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_BREAK_GLASS_RESET,
      'metadata.targetEmail': admin.email,
    }).lean();
    assert.ok(audit, 'the break-glass reset must be audited');
    assert.equal(audit.actorEmail, 'test-operator');
    assert.equal(JSON.stringify(audit).includes(NEW_PASSWORD), false);
  });
});

after(async () => {
  await tracker.cleanup();
  await disconnectDb();
  if (server) server.close();
});
