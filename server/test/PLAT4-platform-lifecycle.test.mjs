// PLAT-5 — recovery codes, account lockout, password change and administrator
// lifecycle. These are the controls that make an administrator lockout
// recoverable without giving a session or a caller the ability to bypass MFA.
//
// WHAT IS PINNED:
//   * a signed-in administrator can generate one-time recovery codes only after
//     re-entering the current password; only digests are stored;
//   * a recovery code completes a login challenge once, then is refused;
//   * five failed TOTP or WebAuthn factors lock the account across rotating IP buckets;
//   * a password change revokes every session and invalidates the old password;
//   * only SUPERADMIN can list/disable/delete administrators or remove a key;
//   * self-disable and self-delete are refused;
//   * every successful and failed lifecycle operation is audited.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-lifecycle-secret-0123456789abcdef0123456789';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-lifecycle-mfa-key-0123456789abcdef0123456789';
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
import {
  PLATFORM_MFA_MAX_FAILURES,
  PLATFORM_MFA_RATE_LIMITED_CODE,
} from '../src/services/platformMfa.service.ts';
import {
  countUnusedRecoveryCodes,
  hashRecoveryCode,
} from '../src/services/platformRecovery.service.ts';
import { PLATFORM_PASSWORD_MIN_LENGTH } from '../src/services/platformAuth.service.ts';

const PASSWORD = 'PlatformLifecycle123!';
const NEW_PASSWORD = 'PlatformLifecycle456!';

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
    email: uniqueEmail(`plat5-${role.toLowerCase()}`),
    name: `PLAT5 ${role}`,
    password: PASSWORD,
    role,
  });
  return track(admin);
}

async function passwordLogin(email, password = PASSWORD) {
  const response = await api('POST', '/api/platform/auth/login', {
    body: { email, password, deviceLabel: 'plat5' },
  });
  return response;
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
      deviceLabel: 'plat5',
    },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const codes = await api('POST', '/api/platform/auth/recovery-codes', {
    token: confirm.json.token,
    body: { password: PASSWORD },
  });
  assert.equal(codes.status, 200, JSON.stringify(codes.json));
  return { start: start.json, confirm: confirm.json, recoveryCodes: codes.json.codes };
}

async function stepUpProof(admin, token) {
  const row = await PlatformAdmin.findOne({ email: admin.email })
    .select('+totpSecretEncrypted lastTotpCounter')
    .lean();
  const counter = Math.max(
    currentTotpCounter(),
    Number(row.lastTotpCounter || 0) + 1,
  );
  const code = generateTotp(decryptPlatformSecret(row.totpSecretEncrypted), counter);
  const proof = await api('POST', '/api/platform/auth/step-up', {
    token,
    body: { password: PASSWORD, code },
  });
  assert.equal(proof.status, 200, JSON.stringify(proof.json));
  assert.ok(proof.json.stepUpToken, 'step-up must return a proof token');
  return proof.json.stepUpToken;
}

async function loginWithTotp(admin) {
  const challenge = await passwordLogin(admin.email);
  assert.equal(challenge.status, 200, JSON.stringify(challenge.json));
  assert.equal(challenge.json.mfaRequired, true);
  const row = await PlatformAdmin.findOne({ email: admin.email })
    .select('+totpSecretEncrypted lastTotpCounter')
    .lean();
  const counter = Math.max(
    currentTotpCounter(),
    Number(row.lastTotpCounter || 0) + 1,
  );
  const code = generateTotp(decryptPlatformSecret(row.totpSecretEncrypted), counter);
  const verify = await api('POST', '/api/platform/auth/mfa/verify', {
    body: { mfaToken: challenge.json.mfaToken, code, deviceLabel: 'plat5' },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return verify.json;
}

function adminPath(id) {
  return `/api/platform/admins/${encodeURIComponent(id)}`;
}

unitSuite('PLAT-5 constants', () => {
  it('keeps the closed audit catalogue unique and includes lifecycle actions', () => {
    assert.equal(new Set(PLATFORM_AUDIT_ACTION_VALUES).size, PLATFORM_AUDIT_ACTION_VALUES.length);
    for (const action of [
      PLATFORM_AUDIT_ACTIONS.PASSWORD_CHANGED,
      PLATFORM_AUDIT_ACTIONS.RECOVERY_CODES_GENERATED,
      PLATFORM_AUDIT_ACTIONS.ADMIN_STATUS_CHANGED,
      PLATFORM_AUDIT_ACTIONS.ADMIN_DELETED,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_KEY_REMOVED,
    ]) {
      assert.ok(PLATFORM_AUDIT_ACTION_VALUES.includes(action), action);
    }
    assert.ok(PLATFORM_MFA_MAX_FAILURES >= 5);
    assert.ok(PLATFORM_PASSWORD_MIN_LENGTH >= 16);
  });

  it('normalizes recovery-code separators and stores only a digest', () => {
    const raw = 'ABCD-EFGH-JKLM';
    assert.equal(hashRecoveryCode(raw), hashRecoveryCode('abcdef ghjk lm'));
    assert.equal(hashRecoveryCode(raw).includes(raw), false);
    assert.equal(countUnusedRecoveryCodes([{ usedAt: null }, { usedAt: new Date() }]), 1);
  });
});

dbSuite('PLAT-5 platform lifecycle end to end', dbOk, () => {
  let owner;
  let ownerToken;
  let ownerStepUp;
  let target;
  let targetToken;
  let support;
  let supportToken;
  let recoveryCodes = [];

  before(async () => {
    owner = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    target = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    support = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    ownerToken = (await startAndConfirmEnrollment(owner)).confirm.token;
    targetToken = (await startAndConfirmEnrollment(target)).confirm.token;
    supportToken = (await startAndConfirmEnrollment(support)).confirm.token;
    ownerStepUp = await stepUpProof(owner, ownerToken);
  });

  it('allows only platform.admin.manage to list administrators', async () => {
    const denied = await api('GET', '/api/platform/admins', { token: supportToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'PLATFORM_FORBIDDEN');

    const listed = await api('GET', '/api/platform/admins', { token: ownerToken });
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const emails = listed.json.admins.map((admin) => admin.email);
    assert.ok(emails.includes(target.email));
    assert.ok(emails.includes(support.email));
    const targetView = listed.json.admins.find((admin) => admin.email === target.email);
    assert.equal(targetView.recoveryCodesRemaining, 10);
    assert.deepEqual(targetView.webauthnKeys, []);
  });

  it('generates recovery codes after password proof and stores only digests', async () => {
    const wrong = await api('POST', '/api/platform/auth/recovery-codes', {
      token: ownerToken,
      body: { password: 'wrong-password' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'PLATFORM_CURRENT_PASSWORD_INVALID');

    const generated = await api('POST', '/api/platform/auth/recovery-codes', {
      token: ownerToken,
      body: { password: PASSWORD },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.equal(generated.json.codes.length, 10);
    assert.equal(generated.json.remaining, 10);
    recoveryCodes = generated.json.codes;

    const stored = await PlatformAdmin.findById(owner._id)
      .select('+recoveryCodes')
      .lean();
    assert.equal(stored.recoveryCodes.length, 10);
    const serialized = JSON.stringify(stored);
    for (const code of recoveryCodes) {
      assert.equal(serialized.includes(code), false, 'plaintext recovery code stored');
      assert.ok(stored.recoveryCodes.some((row) => row.codeHash === hashRecoveryCode(code)));
    }
  });

  it('completes a login with one recovery code and refuses reuse', async () => {
    const challenge = await passwordLogin(owner.email);
    assert.equal(challenge.status, 200);
    assert.ok(challenge.json.methods.includes('recovery'));

    const wrong = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: challenge.json.mfaToken,
        recoveryCode: 'AAAA-AAAA-AAAA',
      },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'PLATFORM_RECOVERY_INVALID');

    const verified = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: challenge.json.mfaToken,
        recoveryCode: recoveryCodes[0],
        deviceLabel: 'plat5-recovery',
      },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    assert.equal(verified.json.mfa.method, 'recovery');
    assert.equal(verified.json.mfa.remaining, 9);

    const replay = await api('POST', '/api/platform/auth/mfa/recovery', {
      body: {
        mfaToken: challenge.json.mfaToken,
        recoveryCode: recoveryCodes[0],
        deviceLabel: 'plat5-replay',
      },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.code, 'PLATFORM_RECOVERY_INVALID');

    const stored = await PlatformAdmin.findById(owner._id)
      .select('+recoveryCodes')
      .lean();
    assert.equal(countUnusedRecoveryCodes(stored.recoveryCodes), 9);
  });

  it('locks the account after five failed TOTP attempts across fresh challenges', async () => {
    const locked = await makePlatformAdmin(PLATFORM_ROLES.SUPERADMIN);
    await startAndConfirmEnrollment(locked);

    for (let attempt = 0; attempt < PLATFORM_MFA_MAX_FAILURES; attempt += 1) {
      const lastChallenge = await passwordLogin(locked.email);
      assert.equal(lastChallenge.status, 200);
      const failed = await api('POST', '/api/platform/auth/mfa/verify', {
        body: { mfaToken: lastChallenge.json.mfaToken, code: '000000' },
      });
      assert.equal(failed.status, 401, JSON.stringify(failed.json));
      assert.equal(failed.json.code, 'PLATFORM_MFA_INVALID');
    }

    const row = await PlatformAdmin.findById(locked._id)
      .select('+totpSecretEncrypted lastTotpCounter mfaLockedUntil')
      .lean();
    assert.ok(row.mfaLockedUntil, 'the fifth failure must set the account lock');
    const code = generateTotp(
      decryptPlatformSecret(row.totpSecretEncrypted),
      Math.max(currentTotpCounter(), Number(row.lastTotpCounter || 0) + 1),
    );
    const lockedChallenge = await passwordLogin(locked.email);
    const blocked = await api('POST', '/api/platform/auth/mfa/verify', {
      body: { mfaToken: lockedChallenge.json.mfaToken, code },
    });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, PLATFORM_MFA_RATE_LIMITED_CODE);
  });

  it('locks the account after repeated failed WebAuthn assertions', async () => {
    const locked = await makePlatformAdmin(PLATFORM_ROLES.SUPPORT);
    await startAndConfirmEnrollment(locked);
    const credentialId = Buffer.from('plat5-webauthn-lock').toString('base64url');
    await PlatformAdmin.updateOne(
      { _id: locked._id },
      {
        $push: {
          webauthnCredentials: {
            credentialId,
            publicKeyEncrypted: encryptPlatformCredential(Buffer.from([1, 2, 3])),
            counter: 0,
            transports: ['internal'],
            label: 'Lockout key',
          },
        },
      },
    );

    for (let attempt = 0; attempt < PLATFORM_MFA_MAX_FAILURES; attempt += 1) {
      const challenge = await passwordLogin(locked.email);
      assert.equal(challenge.status, 200, JSON.stringify(challenge.json));
      const options = await api('POST', '/api/platform/auth/mfa/webauthn/options', {
        body: { mfaToken: challenge.json.mfaToken },
      });
      assert.equal(options.status, 200, JSON.stringify(options.json));
      const failed = await api('POST', '/api/platform/auth/mfa/webauthn/verify', {
        body: {
          authenticationToken: options.json.authenticationToken,
          response: {
            id: 'not-a-registered-key',
            rawId: 'not-a-registered-key',
            type: 'public-key',
            response: {
              clientDataJSON: 'AA',
              authenticatorData: 'AA',
              signature: 'AA',
            },
          },
        },
      });
      assert.equal(failed.status, 401, JSON.stringify(failed.json));
      assert.equal(failed.json.code, 'PLATFORM_WEBAUTHN_INVALID');
    }

    const row = await PlatformAdmin.findById(locked._id)
      .select('mfaLockedUntil')
      .lean();
    assert.ok(row.mfaLockedUntil, 'the fifth WebAuthn failure must set the account lock');
    const blockedChallenge = await passwordLogin(locked.email);
    const blocked = await api('POST', '/api/platform/auth/mfa/webauthn/options', {
      body: { mfaToken: blockedChallenge.json.mfaToken },
    });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, PLATFORM_MFA_RATE_LIMITED_CODE);
  });

  it('disables and enables an administrator, revoking their sessions', async () => {
    const disabled = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerStepUp },
      body: { status: 'DISABLED' },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
    assert.equal(disabled.json.admin.status, 'DISABLED');
    assert.ok(disabled.json.sessionsRevoked >= 1);

    const denied = await api('GET', '/api/platform/auth/me', { token: targetToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'PLATFORM_ACCOUNT_DISABLED');

    const enabled = await api('PATCH', `${adminPath(target._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerStepUp },
      body: { status: 'ACTIVE' },
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    const revoked = await api('GET', '/api/platform/auth/me', { token: targetToken });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, 'PLATFORM_SESSION_REVOKED');
  });

  it('refuses self-disable and self-delete', async () => {
    const disable = await api('PATCH', `${adminPath(owner._id)}/status`, {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerStepUp },
      body: { status: 'DISABLED' },
    });
    assert.equal(disable.status, 409);
    assert.equal(disable.json.code, 'PLATFORM_ADMIN_SELF_PROTECTED');

    const remove = await api('DELETE', adminPath(owner._id), {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerStepUp },
    });
    assert.equal(remove.status, 409);
    assert.equal(remove.json.code, 'PLATFORM_ADMIN_SELF_PROTECTED');
  });

  it('removes a security key and revokes the target sessions', async () => {
    targetToken = (await loginWithTotp(target)).token;
    const credentialId = Buffer.from('plat5-removable-key').toString('base64url');
    await PlatformAdmin.updateOne(
      { _id: target._id },
      {
        $push: {
          webauthnCredentials: {
            credentialId,
            publicKeyEncrypted: encryptPlatformCredential(Buffer.from([9, 8, 7])),
            counter: 0,
            transports: ['internal'],
            label: 'Removable key',
          },
        },
      },
    );

    const removed = await api(
      'DELETE',
      `${adminPath(target._id)}/webauthn/${encodeURIComponent(credentialId)}`,
      { token: ownerToken, headers: { 'x-platform-step-up': ownerStepUp } },
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.removed, true);

    const after = await PlatformAdmin.findById(target._id)
      .select('+webauthnCredentials')
      .lean();
    assert.equal(
      after.webauthnCredentials.some((key) => key.credentialId === credentialId),
      false,
    );
    const revoked = await api('GET', '/api/platform/auth/me', { token: targetToken });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, 'PLATFORM_SESSION_REVOKED');
  });

  it('deletes an administrator and leaves no token able to resolve them', async () => {
    const removed = await api('DELETE', adminPath(target._id), {
      token: ownerToken,
      headers: { 'x-platform-step-up': ownerStepUp },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.deleted.email, target.email);

    const after = await api('GET', '/api/platform/auth/me', {
      token: (await loginWithTotp(support)).token,
    });
    assert.equal(after.status, 200, JSON.stringify(after.json));

    const gone = await api('GET', '/api/platform/auth/me', { token: targetToken });
    assert.equal(gone.status, 401);
    assert.equal(gone.json.code, 'PLATFORM_INVALID_TOKEN');
  });

  it('changes the password, revokes every session and refuses the old password', async () => {
    const changed = await api('POST', '/api/platform/auth/password', {
      token: ownerToken,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.ok(changed.json.sessionsRevoked >= 1);

    const oldToken = await api('GET', '/api/platform/auth/me', { token: ownerToken });
    assert.equal(oldToken.status, 401);
    assert.equal(oldToken.json.code, 'PLATFORM_SESSION_INVALIDATED');

    const oldPassword = await passwordLogin(owner.email, PASSWORD);
    assert.equal(oldPassword.status, 401);
    assert.equal(oldPassword.json.code, 'PLATFORM_INVALID_CREDENTIALS');

    const newPassword = await passwordLogin(owner.email, NEW_PASSWORD);
    assert.equal(newPassword.status, 200, JSON.stringify(newPassword.json));
    assert.equal(newPassword.json.mfaRequired, true);
  });

  it('records the lifecycle and recovery operations in the audit trail', async () => {
    const events = await PlatformAuditLog.find({
      actorAdminId: new mongoose.Types.ObjectId(owner._id),
    }).lean();
    const actions = new Set(events.map((event) => event.action));
    for (const action of [
      PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED,
      PLATFORM_AUDIT_ACTIONS.STEP_UP_USED,
      PLATFORM_AUDIT_ACTIONS.RECOVERY_CODES_GENERATED,
      PLATFORM_AUDIT_ACTIONS.RECOVERY_CODE_SUCCEEDED,
      PLATFORM_AUDIT_ACTIONS.ADMIN_LISTED,
      PLATFORM_AUDIT_ACTIONS.ADMIN_STATUS_CHANGED,
      PLATFORM_AUDIT_ACTIONS.WEBAUTHN_KEY_REMOVED,
      PLATFORM_AUDIT_ACTIONS.ADMIN_DELETED,
      PLATFORM_AUDIT_ACTIONS.PASSWORD_CHANGED,
    ]) {
      assert.ok(actions.has(action), `missing audit action ${action}`);
    }
    const deleted = events.find(
      (event) =>
        event.action === PLATFORM_AUDIT_ACTIONS.ADMIN_DELETED && event.outcome === 'SUCCESS',
    );
    assert.equal(deleted.metadata.email, target.email);
    const recoveryFailure = await PlatformAuditLog.findOne({
      action: PLATFORM_AUDIT_ACTIONS.RECOVERY_CODE_FAILED,
    }).lean();
    assert.ok(recoveryFailure, 'a refused recovery code must be audited');
    assert.equal(JSON.stringify(events).includes(recoveryCodes[0]), false);
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
