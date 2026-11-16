// PLAT-2/PLAT-3 — the platform security boundary, end to end.
//
// WHAT IS PINNED:
//   * password login NEVER returns a session; only TOTP/WebAuthn completes it;
//   * a TOTP code is single-use, and its secret is encrypted at rest;
//   * the console cookie is HttpOnly + SameSite=Strict; cookie auth requires the
//     exact console Origin and a matching CSRF header, while Bearer clients do not;
//   * every login failure, denied capability, report read, audit read and logout
//     is recorded in `platform_audit_events`;
//   * the audit model refuses update/delete, including document save/remove;
//   * only SECURITY and SUPERADMIN can read the trail;
//   * WebAuthn registration options are authenticated, and a malformed assertion
//     is refused rather than trusted.
//
// A real browser + authenticator is not available in this test process, so WebAuthn
// is verified at the challenge/rejection boundary, not by a completed assertion.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-security-secret-0123456789abcdef0123456789';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-security-mfa-key-0123456789abcdef0123456789';
process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4100';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

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
import {
  decryptPlatformSecret,
  encryptPlatformCredential,
} from '../src/services/platformMfa/secretVault.ts';
import { currentTotpCounter, generateTotp } from '../src/services/platformMfa/totp.ts';
import PlatformAdmin from '../src/models/platformAdmin.model.ts';
import PlatformAuditLog from '../src/models/platformAuditLog.model.ts';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTION_VALUES,
} from '../src/constants/platformAudit.ts';
import { validateProductionConfig } from '../src/config/validateConfig.ts';
import {
  platformConsoleOrigin,
  platformCookieSecure,
  platformWebAuthnConfig,
} from '../src/config/platformSecurity.ts';
import crypto from 'node:crypto';

const PASSWORD = 'PlatformSecurity123!';
const CONSOLE_ORIGIN = 'http://localhost:4100';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const trackedAdminIds = [];
const trackedEmails = [];

function track(admin) {
  tracker.trackPlatformAdmin(admin._id);
  trackedAdminIds.push(String(admin._id));
  trackedEmails.push(admin.email);
  return admin;
}

async function makePlatformAdmin(role) {
  const admin = await createPlatformAdminAccount({
    email: uniqueEmail(`plat3-${role.toLowerCase()}`),
    name: `PLAT3 ${role}`,
    password: PASSWORD,
    role,
  });
  return track(admin);
}

async function passwordLogin(email) {
  const response = await api('POST', '/api/platform/auth/login', {
    body: { email, password: PASSWORD, deviceLabel: 'plat3' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
}

async function startAndConfirmEnrollment(admin, { console = false } = {}) {
  const first = await passwordLogin(admin.email);
  assert.equal(first.mfaEnrollmentRequired, true);
  assert.equal(typeof first.token, 'undefined');

  const headers = { Origin: CONSOLE_ORIGIN };
  if (console) headers['X-Platform-Console'] = '1';
  const start = await api('POST', '/api/platform/auth/mfa/enroll/start', {
    body: { enrollmentToken: first.enrollmentToken },
    headers,
  });
  assert.equal(start.status, 200, JSON.stringify(start.json));

  const code = generateTotp(start.json.secret, currentTotpCounter());
  const confirm = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
    body: {
      enrollmentToken: start.json.enrollmentToken,
      code,
      deviceLabel: 'plat3',
    },
    headers,
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  return { start: start.json, confirm };
}

async function loginWithTotp(admin, codeOffset = 0) {
  const first = await passwordLogin(admin.email);
  assert.equal(first.mfaRequired, true, JSON.stringify(first));
  const adminRow = await PlatformAdmin.findOne({ email: admin.email })
    .select('+totpSecretEncrypted lastTotpCounter')
    .lean();
  const counter = Math.max(
    currentTotpCounter(),
    Number(adminRow.lastTotpCounter || 0) + 1 + codeOffset,
  );
  const code = generateTotp(decryptPlatformSecret(adminRow.totpSecretEncrypted), counter);
  const verify = await api('POST', '/api/platform/auth/mfa/verify', {
    body: { mfaToken: first.mfaToken, code, deviceLabel: 'plat3' },
  });
  return { verify, code, first };
}

function cookieValues(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''];
  const found = {};
  for (const value of raw) {
    if (!value) continue;
    const pair = value.split(';')[0];
    const index = pair.indexOf('=');
    if (index < 0) continue;
    found[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { raw, found };
}

async function fetchJson(
  pathname,
  {
    cookie = '',
    csrf = '',
    origin = CONSOLE_ORIGIN,
    token = '',
    method = 'GET',
    requestBody,
    headers: extraHeaders = {},
  } = {},
) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-Platform-CSRF'] = csrf;
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (requestBody !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

unitSuite('PLAT-2/3 audit vocabulary and cookie flags', () => {
  it('has a closed, unique action catalogue', () => {
    assert.ok(PLATFORM_AUDIT_ACTION_VALUES.length >= 15);
    assert.equal(new Set(PLATFORM_AUDIT_ACTION_VALUES).size, PLATFORM_AUDIT_ACTION_VALUES.length);
    for (const action of PLATFORM_AUDIT_ACTION_VALUES) {
      assert.match(action, /^platform\.[a-z]+(\.[a-z_]+)+$/);
    }
    assert.ok(PLATFORM_AUDIT_ACTION_VALUES.includes(PLATFORM_AUDIT_ACTIONS.AUDIT_READ));
  });

  it('declares no tenant field and no TTL on the audit collection', () => {
    assert.equal(PlatformAuditLog.schema.path('businessId'), undefined);
    assert.equal(PlatformAuditLog.schema.path('userId'), undefined);
    const ttl = PlatformAuditLog.schema.indexes().find(([, options]) => options?.expireAfterSeconds != null);
    assert.equal(ttl, undefined, 'audit events must not expire automatically');
  });

  it('keeps WebAuthn challenges hidden and stores only a hash', () => {
    const path = PlatformAdmin.schema.path('webauthnChallenges');
    assert.ok(path);
    assert.equal(path.options.select, false, 'challenge rows must not be selected by ordinary reads');
  });

  it('refuses a production platform plane without its own MFA key and HTTPS console', () => {
    const base = {
      MONGODB_URI: 'mongodb://localhost:27017/platform-config-test',
      JWT_SECRET: 'tenant-secret-0123456789abcdef0123456789abcdef',
      PLATFORM_ADMIN_JWT_SECRET: 'platform-secret-0123456789abcdef0123456789ab',
      PLATFORM_CONSOLE_ORIGIN: 'https://ops.example.com',
      PLATFORM_WEBAUTHN_ORIGIN: 'https://ops.example.com',
    };
    const missingMfa = validateProductionConfig(base).map((problem) => problem.variable);
    assert.ok(missingMfa.includes('PLATFORM_MFA_ENCRYPTION_KEY'));

    const sameAsSigning = validateProductionConfig({
      ...base,
      PLATFORM_MFA_ENCRYPTION_KEY: base.PLATFORM_ADMIN_JWT_SECRET,
    }).map((problem) => problem.variable);
    assert.ok(sameAsSigning.includes('PLATFORM_MFA_ENCRYPTION_KEY'));

    const plainHttp = validateProductionConfig({
      ...base,
      PLATFORM_MFA_ENCRYPTION_KEY: 'mfa-secret-0123456789abcdef0123456789abcdef',
      PLATFORM_CONSOLE_ORIGIN: 'http://ops.example.com',
    }).map((problem) => problem.variable);
    assert.ok(plainHttp.includes('PLATFORM_CONSOLE_ORIGIN'));

    const missingConsole = validateProductionConfig({
      ...base,
      PLATFORM_MFA_ENCRYPTION_KEY: 'mfa-secret-0123456789abcdef0123456789abcdef',
      PLATFORM_CONSOLE_ORIGIN: undefined,
    }).map((problem) => problem.variable);
    assert.ok(missingConsole.includes('PLATFORM_CONSOLE_ORIGIN'));

    const webAuthnPath = validateProductionConfig({
      ...base,
      PLATFORM_MFA_ENCRYPTION_KEY: 'mfa-secret-0123456789abcdef0123456789abcdef',
      PLATFORM_WEBAUTHN_ORIGIN: 'https://ops.example.com/not-a-bare-origin',
    }).map((problem) => problem.variable);
    assert.ok(webAuthnPath.includes('PLATFORM_WEBAUTHN_ORIGIN'));

    const valid = validateProductionConfig({
      ...base,
      PLATFORM_MFA_ENCRYPTION_KEY: 'mfa-secret-0123456789abcdef0123456789abcdef',
    });
    assert.deepEqual(
      valid.filter((problem) => problem.variable.startsWith('PLATFORM_')),
      [],
      JSON.stringify(valid),
    );
  });

  it('fails closed on non-bare origins and keeps cookies Secure without NODE_ENV', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousConsoleOrigin = process.env.PLATFORM_CONSOLE_ORIGIN;
    const previousWebAuthnOrigin = process.env.PLATFORM_WEBAUTHN_ORIGIN;
    try {
      process.env.NODE_ENV = '';
      process.env.PLATFORM_CONSOLE_ORIGIN = 'https://ops.example.com';
      process.env.PLATFORM_WEBAUTHN_ORIGIN = 'https://ops.example.com';
      assert.equal(platformCookieSecure(), true, 'HTTPS must set Secure without NODE_ENV');
      assert.equal(platformConsoleOrigin(), 'https://ops.example.com');

      process.env.PLATFORM_CONSOLE_ORIGIN = 'http://ops.example.com';
      assert.throws(() => platformConsoleOrigin(), /must use https|not configured/);

      process.env.PLATFORM_CONSOLE_ORIGIN = 'https://ops.example.com/console';
      assert.throws(() => platformConsoleOrigin(), /bare origin|must be a valid/);

      process.env.PLATFORM_CONSOLE_ORIGIN = 'https://ops.example.com';
      process.env.PLATFORM_WEBAUTHN_ORIGIN = 'https://ops.example.com/path';
      assert.throws(() => platformWebAuthnConfig(), /not configured/);

      process.env.NODE_ENV = '';
      process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
      assert.equal(
        platformCookieSecure(),
        true,
        'an unknown environment must not emit an insecure cookie',
      );

      process.env.NODE_ENV = 'test';
      process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
      assert.equal(platformCookieSecure(), false, 'loopback HTTP development may omit Secure');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousConsoleOrigin === undefined) delete process.env.PLATFORM_CONSOLE_ORIGIN;
      else process.env.PLATFORM_CONSOLE_ORIGIN = previousConsoleOrigin;
      if (previousWebAuthnOrigin === undefined) delete process.env.PLATFORM_WEBAUTHN_ORIGIN;
      else process.env.PLATFORM_WEBAUTHN_ORIGIN = previousWebAuthnOrigin;
    }
  });
});

dbSuite('PLAT-2/3 platform security end to end', dbOk, () => {
  let superAdmin;
  let supportAdmin;
  let securityAdmin;
  let cookieAdmin;
  let superToken;
  let supportToken;
  let securityToken;
  let cookieHeader = '';
  let cookieCsrf = '';
  let cookieSessionValue = '';

  before(async () => {
    superAdmin = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    supportAdmin = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    securityAdmin = await makePlatformAdmin(PLATFORM_ROLES.SECURITY);
    cookieAdmin = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);

    const superEnrollment = await startAndConfirmEnrollment(superAdmin);
    superToken = superEnrollment.confirm.json.token;
    const supportEnrollment = await startAndConfirmEnrollment(supportAdmin);
    supportToken = supportEnrollment.confirm.json.token;
    const securityEnrollment = await startAndConfirmEnrollment(securityAdmin);
    securityToken = securityEnrollment.confirm.json.token;

    const cookieEnrollment = await startAndConfirmEnrollment(cookieAdmin, { console: true });
    assert.equal(cookieEnrollment.confirm.response.status, 200);
    assert.equal(cookieEnrollment.confirm.json.transport, 'cookie');
    assert.equal(typeof cookieEnrollment.confirm.json.token, 'undefined', 'the console never receives a bearer token');
    assert.equal(typeof cookieEnrollment.confirm.json.csrfToken, 'string');
    const { raw, found } = cookieValues(cookieEnrollment.confirm.response);
    const sessionCookie = raw.find((value) => value.startsWith('platform_session='));
    const csrfCookie = raw.find((value) => value.startsWith('platform_csrf='));
    assert.ok(sessionCookie, 'session cookie missing');
    assert.ok(csrfCookie, 'csrf cookie missing');
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Strict/i);
    assert.match(sessionCookie, /Path=\/api\/platform/i);
    assert.equal(/HttpOnly/i.test(csrfCookie), false, 'the CSRF cookie must be readable by the console');
    assert.match(csrfCookie, /SameSite=Strict/i);
    assert.match(csrfCookie, /Path=\//i);
    cookieSessionValue = found.platform_session;
    cookieCsrf = found.platform_csrf;
    cookieHeader = `platform_session=${cookieSessionValue}; platform_csrf=${cookieCsrf}`;
  });

  it('requires password plus TOTP and never returns a session from the password step', async () => {
    const newAdmin = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    const first = await passwordLogin(newAdmin.email);
    assert.equal(first.mfaEnrollmentRequired, true);
    assert.equal(typeof first.token, 'undefined');
    assert.equal(typeof first.mfaToken, 'undefined');

    const started = await api('POST', '/api/platform/auth/mfa/enroll/start', {
      body: { enrollmentToken: first.enrollmentToken },
    });
    assert.equal(started.status, 200);
    const secret = started.json.secret;
    assert.match(secret, /^[A-Z2-7]+$/);

    const wrong = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
      body: { enrollmentToken: started.json.enrollmentToken, code: '000000' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'PLATFORM_MFA_INVALID');

    const code = generateTotp(secret, currentTotpCounter());
    const confirmed = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
      body: { enrollmentToken: started.json.enrollmentToken, code },
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(typeof confirmed.json.token, 'string');
    assert.equal(confirmed.json.admin.mfaEnabled, true);

    const stored = await PlatformAdmin.findById(newAdmin._id)
      .select('+totpSecretEncrypted')
      .lean();
    assert.match(stored.totpSecretEncrypted, /^v1\./);
    assert.equal(stored.totpSecretEncrypted.includes(secret), false, 'the TOTP secret must not be stored in plaintext');
    assert.equal(JSON.stringify(stored).includes(secret), false);

    // The same code cannot be replayed, even by a fresh password challenge.
    const replayChallenge = await passwordLogin(newAdmin.email);
    const replay = await api('POST', '/api/platform/auth/mfa/verify', {
      body: { mfaToken: replayChallenge.mfaToken, code },
    });
    assert.equal(replay.status, 401, JSON.stringify(replay.json));
    assert.equal(replay.json.code, 'PLATFORM_MFA_INVALID');
  });

  it('accepts TOTP on a later login and refuses a wrong code', async () => {
    const wrongChallenge = await passwordLogin(superAdmin.email);
    const wrong = await api('POST', '/api/platform/auth/mfa/verify', {
      body: { mfaToken: wrongChallenge.mfaToken, code: '123456' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'PLATFORM_MFA_INVALID');

    const login = await loginWithTotp(superAdmin);
    assert.equal(login.verify.status, 200, JSON.stringify(login.verify.json));
    assert.equal(login.verify.json.admin.mfaEnabled, true);
    assert.equal(login.verify.json.mfa.method, 'totp');
  });

  it('accepts the cookie only with the exact Origin and a matching CSRF header', async () => {
    const me = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
    });
    assert.equal(me.response.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.transport, 'cookie');
    assert.equal(me.body.admin.email, cookieAdmin.email);

    const noCsrf = await fetchJson('/api/platform/auth/me', { cookie: cookieHeader });
    assert.equal(noCsrf.response.status, 403);
    assert.equal(noCsrf.body.code, 'PLATFORM_CSRF_INVALID');

    // A cross-origin console cannot read the API host's CSRF cookie. This GET
    // bootstraps a fresh value from the existing cookie session and exact Origin.
    const boot = await fetchJson('/api/platform/auth/csrf', { cookie: cookieHeader });
    assert.equal(boot.response.status, 200, JSON.stringify(boot.body));
    assert.equal(typeof boot.body.csrfToken, 'string');
    const bootCookies = cookieValues(boot.response);
    const afterBoot = await fetchJson('/api/platform/auth/me', {
      cookie: `platform_session=${cookieSessionValue}; platform_csrf=${bootCookies.found.platform_csrf}`,
      csrf: boot.body.csrfToken,
    });
    assert.equal(afterBoot.response.status, 200, JSON.stringify(afterBoot.body));

    const bootWrongOrigin = await fetchJson('/api/platform/auth/csrf', {
      cookie: cookieHeader,
      origin: 'http://evil.example',
    });
    assert.equal(bootWrongOrigin.response.status, 403);
    assert.equal(bootWrongOrigin.body.code, 'PLATFORM_CSRF_ORIGIN');

    const wrongCsrf = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: 'not-the-cookie-value',
    });
    assert.equal(wrongCsrf.response.status, 403);
    assert.equal(wrongCsrf.body.code, 'PLATFORM_CSRF_INVALID');

    const wrongOrigin = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
      origin: 'http://evil.example',
    });
    assert.equal(wrongOrigin.response.status, 403);
    assert.equal(wrongOrigin.body.code, 'PLATFORM_CSRF_ORIGIN');

    // A browser omits Origin on a same-origin GET. The console header plus the
    // browser-controlled Sec-Fetch-Site value is the proof for that one case.
    const sameOriginGet = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
      origin: '',
      headers: {
        'X-Platform-Console': '1',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(sameOriginGet.response.status, 200, JSON.stringify(sameOriginGet.body));

    const sameOriginWithoutConsoleHeader = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
      origin: '',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(sameOriginWithoutConsoleHeader.response.status, 403);
    assert.equal(sameOriginWithoutConsoleHeader.body.code, 'PLATFORM_CSRF_ORIGIN');

    const sameSiteRequest = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
      origin: '',
      headers: {
        'X-Platform-Console': '1',
        'Sec-Fetch-Site': 'same-site',
      },
    });
    assert.equal(sameSiteRequest.response.status, 403);
    assert.equal(sameSiteRequest.body.code, 'PLATFORM_CSRF_ORIGIN');

    // A supplied foreign Origin is never replaced by the same-origin shortcut.
    const foreignWithSameOriginProof = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
      origin: 'http://evil.example',
      headers: {
        'X-Platform-Console': '1',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(foreignWithSameOriginProof.response.status, 403);
    assert.equal(foreignWithSameOriginProof.body.code, 'PLATFORM_CSRF_ORIGIN');

    // A Bearer client remains exempt: it does not use an ambient cookie.
    const bearer = await fetchJson('/api/platform/auth/me', {
      token: superToken,
      origin: '',
    });
    assert.equal(bearer.response.status, 200);
  });

  it('records login failures and refusals in the append-only trail', async () => {
    const unknownEmail = uniqueEmail('plat3-unknown');
    trackedEmails.push(unknownEmail);
    const failed = await api('POST', '/api/platform/auth/login', {
      body: { email: unknownEmail, password: 'wrong-password' },
    });
    assert.equal(failed.status, 401);

    const denied = await api('GET', '/api/platform/audit', { token: supportToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'PLATFORM_FORBIDDEN');

    const loginFailure = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.LOGIN_FAILED,
      actorEmail: unknownEmail,
    }).lean();
    assert.ok(loginFailure, 'a failed login must be recorded');
    assert.equal(loginFailure.outcome, 'FAILURE');
    assert.equal(JSON.stringify(loginFailure).includes('wrong-password'), false);

    const capabilityDenial = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.ACCESS_DENIED,
      actorAdminId: new mongoose.Types.ObjectId(supportAdmin._id),
      capability: 'platform.audit.read',
    }).lean();
    assert.ok(capabilityDenial, 'a capability refusal must be recorded');
    assert.equal(capabilityDenial.outcome, 'DENIED');
    assert.equal(capabilityDenial.route, '/api/platform/audit');
  });

  it('lets SECURITY and SUPERADMIN read the trail, and records the read', async () => {
    const securityRead = await api('GET', '/api/platform/audit?limit=10', {
      token: securityToken,
    });
    assert.equal(securityRead.status, 200, JSON.stringify(securityRead.json));
    assert.ok(Array.isArray(securityRead.json.events));
    assert.ok(securityRead.json.events.length <= 10);

    const readEvent = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.AUDIT_READ,
      actorAdminId: new mongoose.Types.ObjectId(securityAdmin._id),
    }).lean();
    assert.ok(readEvent, 'reading the trail must itself be recorded');
    assert.equal(readEvent.capability, 'platform.audit.read');

    const superRead = await api('GET', '/api/platform/audit?limit=5&outcome=SUCCESS', {
      token: superToken,
    });
    assert.equal(superRead.status, 200);
    assert.ok(superRead.json.events.every((event) => event.outcome === 'SUCCESS'));

    const badLimit = await api('GET', '/api/platform/audit?limit=101', {
      token: superToken,
    });
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.json.code, 'VALIDATION_ERROR');

    const badAction = await api('GET', '/api/platform/audit?action=made.up', {
      token: superToken,
    });
    assert.equal(badAction.status, 400);
  });

  it('refuses every model-level update and delete', async () => {
    const event = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.AUDIT_READ,
    }).lean();
    assert.ok(event);

    await assert.rejects(
      () => PlatformAuditLog.updateOne({ _id: event._id }, { $set: { reason: 'tampered' } }),
      /append-only/,
    );
    await assert.rejects(
      () => PlatformAuditLog.updateMany({}, { $set: { reason: 'tampered' } }),
      /append-only/,
    );
    await assert.rejects(
      () => PlatformAuditLog.findOneAndUpdate({ _id: event._id }, { $set: { reason: 'tampered' } }),
      /append-only/,
    );
    await assert.rejects(
      () => PlatformAuditLog.findOneAndDelete({ _id: event._id }),
      /append-only/,
    );
    await assert.rejects(
      () => PlatformAuditLog.deleteOne({ _id: event._id }),
      /append-only/,
    );
    await assert.rejects(
      () => PlatformAuditLog.deleteMany({ _id: event._id }),
      /append-only/,
    );

    const doc = await PlatformAuditLog.findById(event._id);
    assert.ok(doc);
    doc.reason = 'tampered';
    await assert.rejects(() => doc.save(), /append-only/);

    const unchanged = await PlatformAuditLog.findById(event._id).lean();
    assert.ok(unchanged);
    assert.notEqual(unchanged.reason, 'tampered');
  });

  it('records operations reads and logout, and clears the cookie', async () => {
    const report = await api('GET', '/api/platform/operations?days=7', { token: superToken });
    assert.equal(report.status, 200);
    const read = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.OPERATIONS_READ,
      actorAdminId: new mongoose.Types.ObjectId(superAdmin._id),
    }).lean();
    assert.ok(read, 'a platform report read must be recorded');

    const logout = await fetchJson('/api/platform/auth/logout', {
      method: 'POST',
      requestBody: {},
      cookie: cookieHeader,
      csrf: cookieCsrf,
    });
    assert.equal(logout.response.status, 200, JSON.stringify(logout.body));
    const cleared = cookieValues(logout.response).raw;
    assert.ok(cleared.some((value) => /^platform_session=;/.test(value)));
    assert.ok(cleared.some((value) => /^platform_csrf=;/.test(value)));

    const afterLogout = await fetchJson('/api/platform/auth/me', {
      cookie: cookieHeader,
      csrf: cookieCsrf,
    });
    assert.equal(afterLogout.response.status, 401);
    assert.equal(afterLogout.body.code, 'PLATFORM_SESSION_REVOKED');

    const logoutEvent = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.LOGOUT,
      actorAdminId: new mongoose.Types.ObjectId(cookieAdmin._id),
    }).lean();
    assert.ok(logoutEvent);
  });

  it('issues WebAuthn registration options only to an authenticated platform session', async () => {
    const anonymous = await api('POST', '/api/platform/auth/webauthn/register/options', {
      body: {},
    });
    assert.equal(anonymous.status, 401);

    const options = await api('POST', '/api/platform/auth/webauthn/register/options', {
      token: superToken,
      body: {},
    });
    assert.equal(options.status, 200, JSON.stringify(options.json));
    assert.equal(typeof options.json.registrationToken, 'string');
    assert.equal(typeof options.json.options.challenge, 'string');
    assert.equal(options.json.options.rp.id, 'localhost');
    assert.equal(options.json.options.user.name, superAdmin.email);

    const invalid = await api('POST', '/api/platform/auth/webauthn/register/verify', {
      token: superToken,
      body: {
        registrationToken: options.json.registrationToken,
        response: {},
      },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'PLATFORM_WEBAUTHN_INVALID');

    const challenge = await passwordLogin(superAdmin.email);
    const noKey = await api('POST', '/api/platform/auth/mfa/webauthn/options', {
      body: { mfaToken: challenge.mfaToken },
    });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.code, 'PLATFORM_WEBAUTHN_NO_CREDENTIALS');

    // A registered credential makes login options available. The challenge must
    // be persisted as a hash so the eventual assertion can be consumed once.
    const credentialId = Buffer.from('plat3-test-credential').toString('base64url');
    await PlatformAdmin.updateOne(
      { _id: superAdmin._id },
      {
        $push: {
          webauthnCredentials: {
            credentialId,
            publicKeyEncrypted: encryptPlatformCredential(Buffer.from([1, 2, 3, 4])),
            counter: 0,
            transports: ['internal'],
            label: 'Test key',
          },
        },
      },
    );
    const loginChallenge = await passwordLogin(superAdmin.email);
    const loginOptions = await api('POST', '/api/platform/auth/mfa/webauthn/options', {
      body: { mfaToken: loginChallenge.mfaToken },
    });
    assert.equal(loginOptions.status, 200, JSON.stringify(loginOptions.json));
    assert.equal(loginOptions.json.options.allowCredentials[0].id, credentialId);

    const storedAdmin = await PlatformAdmin.findById(superAdmin._id).select(
      '+webauthnChallenges',
    );
    const expectedHash = crypto
      .createHash('sha256')
      .update(loginOptions.json.options.challenge)
      .digest('hex');
    assert.ok(
      storedAdmin.webauthnChallenges.some((row) => row.challengeHash === expectedHash),
      'the login challenge must be stored as a one-time hash',
    );

    const badAssertion = await api('POST', '/api/platform/auth/mfa/webauthn/verify', {
      body: {
        authenticationToken: loginOptions.json.authenticationToken,
        response: { id: credentialId },
      },
    });
    assert.equal(badAssertion.status, 401);
    assert.equal(badAssertion.json.code, 'PLATFORM_WEBAUTHN_INVALID');
  });
});

after(async () => {
  if (dbOk) {
    await mongoose.connection.db.collection('platform_audit_events').deleteMany({
      $or: [
        { actorAdminId: { $in: trackedAdminIds.map((id) => new mongoose.Types.ObjectId(id)) } },
        { actorEmail: { $in: trackedEmails } },
      ],
    });
  }
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});
