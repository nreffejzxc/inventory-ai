// Backup failure notifications — DB-independent unit coverage.
//
// The alert path sits between a durable record and an operator's inbox, and
// everything about it is easy to get wrong in a way nobody notices until the one
// night it matters:
//
//   * a FAILED run must be described by the identifiers needed to find it again;
//   * an INTERRUPTED run must say the result is missing, not that it failed;
//   * the same run must never be mailed twice, while a genuine retry must still
//     be able to get through;
//   * no recipient, no mail provider, a missing record and a mail outage are all
//     silent — never an exception the runner could act on;
//   * a successful run must never reach the failure path.
//
// No database and no network: every dependency is injected.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupAlertMessage, deliverBackupAlert } from '../src/services/backupAlerts.service.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const RUN = {
  runId: '0b0f6f4e-2b9c-4f5f-9d5a-0c1f0a7c9d11',
  trigger: 'SCHEDULED',
  startedAt: '2026-11-27T19:00:00.000Z',
  finishedAt: '2026-11-27T19:00:41.000Z',
  archive: null,
  sizeBytes: null,
  offsite: 'unknown',
  detail: 'backup:db:encrypted failed with exit 2; no copy was attempted.',
};

function deps(overrides = {}) {
  const calls = { send: 0, claim: 0, finish: [], log: [] };
  const base = {
    recipient: () => 'ops@example.test',
    mailConfigured: () => true,
    send: async () => {
      calls.send += 1;
      return { id: 'msg' };
    },
    claim: async () => {
      calls.claim += 1;
      return true;
    },
    finish: async (_runId, error) => {
      calls.finish.push(error);
    },
    loadRun: async () => RUN,
    log: (line) => calls.log.push(line),
  };
  return { value: { ...base, ...overrides }, calls };
}

it('describes a failed run with the identifiers a person needs', () => {
  const { subject, text } = backupAlertMessage(RUN, 'FAILED', 120);
  assert.match(subject, /FAILED/);
  assert.ok(subject.includes(RUN.runId));
  assert.ok(text.includes(`Run id     : ${RUN.runId}`));
  assert.ok(text.includes('Outcome    : FAILED'));
  assert.ok(text.includes('Trigger    : SCHEDULED'));
  assert.ok(text.includes(RUN.detail));
  assert.ok(text.includes('Started    : 2026-11-27T19:00:00.000Z'));
  // An operator alert must never carry key material.
  assert.doesNotMatch(text, /passphrase is|private key is [A-Z0-9]{8}/i);
});

it('says an interrupted run has no result rather than calling it a failure', () => {
  const stale = { ...RUN, finishedAt: null, detail: null };
  const { subject, text } = backupAlertMessage(stale, 'INTERRUPTED', 120);
  assert.match(subject, /INTERRUPTED/);
  assert.ok(text.includes('Outcome    : INTERRUPTED'));
  assert.ok(text.includes('no completion was recorded'));
  assert.ok(text.includes('more than 120 minutes'));
  assert.ok(text.includes('the runner recorded no failure text'));
});

it('sends one alert and marks the run as reported', async () => {
  const { value, calls } = deps();
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.deepEqual(result, { sent: true, reason: 'sent' });
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.finish, [null]);
});

it('never sends twice for the same run', async () => {
  const { value, calls } = deps({ claim: async () => false });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'duplicate');
  assert.equal(calls.send, 0);
  assert.deepEqual(calls.finish, []);
});

it('swallows a mail outage and records it on the run', async () => {
  const { value, calls } = deps({
    send: async () => {
      throw new Error('Brevo 503');
    },
  });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'delivery-failed');
  assert.deepEqual(calls.finish, ['Brevo 503']);
  assert.match(calls.log.join('\n'), /delivery failed/);
});

it('does nothing when no recipient is configured, and says so', async () => {
  const { value, calls } = deps({ recipient: () => '' });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.reason, 'not-configured');
  assert.equal(calls.claim, 0);
  assert.equal(calls.send, 0);
  assert.match(calls.log.join('\n'), /BACKUP_ALERT_EMAIL is not set/);
});

it('does nothing when the mail provider is not configured', async () => {
  const { value, calls } = deps({ mailConfigured: () => false });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.reason, 'not-configured');
  assert.equal(calls.send, 0);
});

it('refuses to describe a run that does not exist', async () => {
  const { value, calls } = deps({ loadRun: async () => null });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.reason, 'missing-run');
  assert.equal(calls.claim, 0);
  assert.equal(calls.send, 0);
});

it('cannot throw even when the store itself fails', async () => {
  const { value } = deps({
    claim: async () => {
      throw new Error('MongoServerSelectionError');
    },
  });
  const result = await deliverBackupAlert(RUN.runId, 'FAILED', value);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'claim-failed');
});

it('the runner alerts only after a FAILED record is written', async () => {
  const source = await readFile(path.join(serverRoot, 'scripts', 'backup-daily.mjs'), 'utf8');
  const failureCatch = source.indexOf('main().catch');
  assert.ok(failureCatch > 0, 'the runner still has a failure handler');
  const failedRecord = source.indexOf("outcome: 'FAILED'");
  const notify = source.indexOf('await notifyRunFailure(');
  assert.ok(failedRecord > failureCatch, 'FAILED is written inside the failure handler');
  assert.ok(notify > failedRecord, 'the alert follows the durable write');
  // Exactly one call, inside the failure handler: the success path returns before
  // it, so a good run can never be reported as a failed one.
  assert.equal((source.match(/await notifyRunFailure\(/g) || []).length, 1);
  assert.equal(source.slice(0, failureCatch).includes('await notifyRunFailure('), false);
});
