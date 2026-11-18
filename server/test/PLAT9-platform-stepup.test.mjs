// PLAT-9 — SEC-08 step-up proof for destructive platform administrator actions.
//
// WHAT IS PINNED:
//   * destructive lifecycle routes refuse a request without a fresh proof;
//   * the proof endpoint requires the current password AND a TOTP code;
//   * a proof is bound to one administrator, one session and one action scope;
//   * an expired proof is refused;
//   * a proof is not an access token and cannot open an authenticated route;
//   * issuance, refusal and successful use are audited without a password,
//     TOTP code or proof token in the audit payload.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-step-up-secret-0123456789abcdef0123456789';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-step-up-mfa-key-0123456789abcdef0123456789';
process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4100';

import { it, before, after } from 'node:test';
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
import {
  createPlatformAdminAccount,
  PLATFORM_PASSWORD_MIN_LENGTH,
} from '../src/services/platformAuth.service.ts';
import { decryptPlatformSecret } from '../src/services/platformMfa/secretVault.ts';
import { currentTotpCounter, generateTotp } from '../src/services/platformMfa/totp.ts';
import PlatformAdmin from '../src/models/platformAdmin.model.ts';
import PlatformAuditLog from '../src/models/platformAuditLog.model.ts';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTION_VALUES,
} from '../src/constants/platformAudit.ts';
import {
  decodePlatformAccessToken,
  signPlatformStepUpToken,
} from '../src/config/platformJwt.ts';
import { PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE } from '../src/config/platformSecurity.ts';

const PASSWORD = 'PlatformStepUp123!';
const NEW_PASSWORD = 'PlatformStepUp456!';

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
    email: uniqueEmail(`plat9-${role.toLowerCase()}`),
    name: `PLAT9 ${role}`,
    password: PASSWORD,
    role,
  });
  return track(admin);
}

async function passwordLogin(email, password = PASSWORD) {
  return api('POST', '/api/platform/auth/login', {
    body: { email, password, deviceLabel: 'plat9' },
  });
}

async function startAndConfirmEnrollment(admin) {
  const first = await passwordLogin(admin.email);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.mfaEnrollmentRequired, true);

  const start = await api('POST', '/api/platform/auth/mfa/enroll/start', {
    body: { enrollmentToken: first.json.enrollmentToken },
  });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const code = generateTotp(start.json.secret, currentTotpCounter());
  const confirm = await api('POST', '/api/platform/auth/mfa/enroll/confirm', {
    body: {
      enrollmentToken: start.json.enrollmentToken,
      code,
      deviceLabel: 'plat9',
    },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const codes = await api('POST', '/api/platform/auth/recovery-codes', {
    token: confirm.json.token,
    body: { password: PASSWORD },
  });
  assert.equal(codes.status, 200, JSON.stringify(codes.json));
  return { confirm: confirm.json, recoveryCodes: codes.json.codes, code };
}

async function stepUp(admin, token, options = {}) {
  const row = await PlatformAdmin.findOne({ email: admin.email })
    .select('+totpSecretEncrypted lastTotpCounter')
    .lean();
  const counter = Math.max(currentTotpCounter(), Number(row.lastTotpCounter || 0) + 1);
  const code =
    options.code ??
    generateTotp(decryptPlatformSecret(row.totpSecretEncrypted), counter);
  return api('POST', '/api/platform/auth/step-up', {
    token,
    body: { password: options.password ?? PASSWORD, code },
  });
}

async function successfulStepUp(admin, token) {
  const proof = await stepUp(admin, token);
  assert.equal(proof.status, 200, JSON.stringify(proof.json));
  assert.ok(proof.json.stepUpToken, 'a successful step-up must return a proof');
  return proof.json;
}

function adminPath(id) {
  return `/api/platform/admins/${encodeURIComponent(id)}`;
}

function actorQuery(admin) {
  return { actorAdminId: admin._id };
}

unitSuite('PLAT-9 audit vocabulary', () => {
  it('contains all four step-up actions in the closed catalogue', () => {
    for (const action of [
      PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED,
      PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
      PLATFORM_AUDIT_ACTIONS.STEP_UP_REQUIRED,
      PLATFORM_AUDIT_ACTIONS.STEP_UP_USED,
    ]) {
      assert.ok(PLATFORM_AUDIT_ACTION_VALUES.includes(action), action);
    }
    assert.ok(PLATFORM_PASSWORD_MIN_LENGTH > 0);
  });
});

dbSuite('PLAT-9 step-up enforcement', dbOk, () => {
  let owner;
  let ownerToken;
  let ownerToken2;
  let ownerProof;
  let ownerProofData;
  let target;
  let support;
  let supportToken;

  before(async () => {
    owner = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    target = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    support = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    const ownerEnrollment = await startAndConfirmEnrollment(owner);
    ownerToken = ownerEnrollment.confirm.token;
    await startAndConfirmEnrollment(target);
    supportToken = (await startAndConfirmEnrollment(support)).confirm.token;

    // A second session for the same administrator, opened with a recovery code
    // so it does not consume the TOTP step the first step-up will use.
    const challenge = await passwordLogin(owner.email);
    const second = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: challenge.json.mfaToken,
        recoveryCode: ownerEnrollment.recoveryCodes[0],
        deviceLabel: 'plat9-session-two',
      },
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    ownerToken2 = second.json.token;

    ownerProofData = await successfulStepUp(owner, ownerToken);
    ownerProof = ownerProofData.stepUpToken;
  });

  it('refuses a destructive action without a proof and audits the refusal', async () => {
    const response = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      body: { status: 'DISABLED' },
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(response.json.code, 'PLATFORM_STEP_UP_REQUIRED');

    const row = await PlatformAdmin.findById(target._id).lean();
    assert.equal(row.status, 'ACTIVE');

    const event = await PlatformAuditLog.findOne({
      ...actorQuery(owner),
      action: PLATFORM_AUDIT_ACTIONS.STEP_UP_REQUIRED,
    }).lean();
    assert.ok(event, 'a refused destructive action must be audited');
    assert.equal(event.outcome, 'DENIED');
    assert.equal(event.metadata.scope, PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE);
  });

  it('explains that the login TOTP step was already used instead of calling it invalid', async () => {
    const reuser = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    const enrollment = await startAndConfirmEnrollment(reuser);

    const response = await stepUp(reuser, enrollment.confirm.token, {
      code: enrollment.code,
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(response.json.code, 'PLATFORM_MFA_CODE_ALREADY_USED');
    assert.match(response.json.error, /already used/i);
    assert.equal(response.json.stepUpToken, undefined);

    const row = await PlatformAdmin.findById(reuser._id)
      .select('mfaFailedAttempts')
      .lean();
    assert.equal(row.mfaFailedAttempts ?? 0, 0);
  });

  it('requires the current password and a valid TOTP code to issue a proof', async () => {
    const before = await PlatformAdmin.findById(owner._id)
      .select('lastTotpCounter')
      .lean();

    const wrongPassword = await stepUp(owner, ownerToken, { password: NEW_PASSWORD });
    assert.equal(wrongPassword.status, 401, JSON.stringify(wrongPassword.json));
    assert.equal(wrongPassword.json.code, 'PLATFORM_CURRENT_PASSWORD_INVALID');
    assert.equal(wrongPassword.json.stepUpToken, undefined);

    const wrongCode = await stepUp(owner, ownerToken, { code: '000000' });
    assert.equal(wrongCode.status, 401, JSON.stringify(wrongCode.json));
    assert.equal(wrongCode.json.code, 'PLATFORM_MFA_INVALID');
    assert.equal(wrongCode.json.stepUpToken, undefined);

    const after = await PlatformAdmin.findById(owner._id)
      .select('lastTotpCounter')
      .lean();
    assert.equal(after.lastTotpCounter, before.lastTotpCounter);

    const failed = await PlatformAuditLog.find({
      ...actorQuery(owner),
      action: PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
    }).lean();
    assert.ok(failed.length >= 2, 'each refused proof must be audited');
    assert.ok(failed.every((event) => event.outcome === 'FAILURE'));
  });

  it('issues a scoped proof and refuses it as an access token', async () => {
    assert.equal(ownerProofData.scope, PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE);
    assert.equal(ownerProofData.expiresIn, 300);
    assert.ok(ownerProofData.stepUpToken.split('.').length === 3);

    const asAccessToken = await api('GET', '/api/platform/auth/me', {
      token: ownerProofData.stepUpToken,
    });
    assert.equal(asAccessToken.status, 401, JSON.stringify(asAccessToken.json));
    assert.equal(asAccessToken.json.code, 'PLATFORM_INVALID_TOKEN');

    const disabled = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerProofData.stepUpToken },
      body: { status: 'DISABLED' },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
    assert.equal(disabled.json.admin.status, 'DISABLED');

    const events = await PlatformAuditLog.find({
      ...actorQuery(owner),
      action: { $in: [PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED, PLATFORM_AUDIT_ACTIONS.STEP_UP_USED] },
    }).lean();
    assert.ok(events.some((event) => event.action === PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED));
    assert.ok(events.some((event) => event.action === PLATFORM_AUDIT_ACTIONS.STEP_UP_USED));
    assert.equal(JSON.stringify(events).includes(PASSWORD), false);
    assert.equal(JSON.stringify(events).includes('000000'), false);
    assert.equal(JSON.stringify(events).includes(ownerProofData.stepUpToken), false);
  });

  it('refuses a proof from another session and accepts one from the requesting session', async () => {
    const reenabled = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerProof },
      body: { status: 'ACTIVE' },
    });
    assert.equal(reenabled.status, 200, JSON.stringify(reenabled.json));

    const crossSession = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken2,
      headers: { 'x-platform-step-up': ownerProof },
      body: { status: 'DISABLED' },
    });
    assert.equal(crossSession.status, 403, JSON.stringify(crossSession.json));
    assert.equal(crossSession.json.code, 'PLATFORM_STEP_UP_REQUIRED');
    const untouched = await PlatformAdmin.findById(target._id).lean();
    assert.equal(untouched.status, 'ACTIVE');

    const disabled = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerProof },
      body: { status: 'DISABLED' },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
    assert.equal(disabled.json.admin.status, 'DISABLED');
  });

  it('refuses an expired proof and records the expiry reason', async () => {
    const claims = decodePlatformAccessToken(ownerToken);
    assert.ok(claims.jti, 'the access token must carry a session id');
    const expired = signPlatformStepUpToken(
      String(owner._id),
      claims.jti,
      PLATFORM_STEP_UP_SCOPE_ADMIN_LIFECYCLE,
      -1,
    );

    const response = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': expired },
      body: { status: 'ACTIVE' },
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(response.json.code, 'PLATFORM_STEP_UP_REQUIRED');

    const event = await PlatformAuditLog.findOne({
      ...actorQuery(owner),
      action: PLATFORM_AUDIT_ACTIONS.STEP_UP_REQUIRED,
      reason: 'step_up_expired',
    }).lean();
    assert.ok(event, 'an expired proof must be audited with its reason');
  });

  it('refuses malformed and wrong-scope proofs', async () => {
    const malformed = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': 'not-a-jwt' },
      body: { status: 'ACTIVE' },
    });
    assert.equal(malformed.status, 403, JSON.stringify(malformed.json));
    assert.equal(malformed.json.code, 'PLATFORM_STEP_UP_REQUIRED');

    const claims = decodePlatformAccessToken(ownerToken);
    const wrongScope = signPlatformStepUpToken(
      String(owner._id),
      claims.jti,
      'platform.audit.export',
      300,
    );
    const response = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': wrongScope },
      body: { status: 'ACTIVE' },
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(response.json.code, 'PLATFORM_STEP_UP_REQUIRED');

    const row = await PlatformAdmin.findById(target._id).lean();
    assert.equal(row.status, 'DISABLED');
  });

  it('does not allow a proof issued to one administrator to authorize another', async () => {
    const supportProof = await successfulStepUp(support, supportToken);
    assert.ok(supportProof.stepUpToken);

    const response = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': supportProof.stepUpToken },
      body: { status: 'ACTIVE' },
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(response.json.code, 'PLATFORM_STEP_UP_REQUIRED');

    const targetRow = await PlatformAdmin.findById(target._id).lean();
    assert.equal(targetRow.status, 'DISABLED');
  });
});

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});
