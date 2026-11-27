// Provenance, attestation and the dead-man heartbeat — proved without a database.
//
// WHY THIS EXISTS. On 2026-11-27 production held a run row (`e546b5a7`) that claimed
// `SCHEDULED` while the platform field said `win32` and the archive path was
// `C:\Users\jeffe\…`. No scheduled GitHub execution of `backup-daily` had ever happened.
// Two independent routes produced that: `--trigger`/`BACKUP_TRIGGER` on a laptop, and the
// workflow's own unconditional `BACKUP_TRIGGER: SCHEDULED`, which also applied to
// `workflow_dispatch`. A label is not evidence, so:
//
//   * the runtime's identifiers are captured, never invented (`readProvenance`);
//   * under GitHub Actions the EVENT decides the trigger (`deriveTrigger`), which closes
//     the dispatch route, and outside Actions `SCHEDULED` is refused outright — a local
//     process can never satisfy the attestation, so it may not write the claim;
//   * the verdict on a claim is a read-path rule (`attestScheduledRun`) so it applies to
//     rows already stored;
//   * the heartbeat is a failure-detection path, not a success ornament — it must be
//     silent without a URL, `/fail` on failure, and must never leak the secret ping URL.
//
// Everything here is pure or injected: no database, no network, no credential. The one
// real-network proof (an actual DOWN/UP mail) cannot live in a unit test and is reported
// separately.
import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULED_WORKFLOW_REF,
  readProvenance,
  deriveTrigger,
} from '../scripts/backup/provenance.mjs';
import { describeHeartbeat, heartbeatTarget, sendHeartbeat } from '../scripts/backup/heartbeat.mjs';
import {
  SCHEDULED_WORKFLOW_REF_PATTERN,
  attestScheduledRun,
  normaliseProvenance,
} from '../src/services/backupProvenance.service.ts';
import { readBackupFreshness } from '../src/services/backupFreshness.service.ts';
import { createHealthHandlers } from '../src/routes/health.routes.ts';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const WORKFLOW_REF = `nreffejzxc/inventory-ai/.github/workflows/backup-daily.yml@${SCHEDULED_WORKFLOW_REF}`;

/** The environment a GitHub-hosted scheduled run actually has. */
function githubScheduleEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: '46048680547',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: 'nreffejzxc/inventory-ai',
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    GITHUB_ACTOR: 'nreffejzxc',
    RUNNER_NAME: 'GitHub Actions 7',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    ...overrides,
  };
}

/** A laptop: none of the GitHub variables exist. */
const LOCAL_ENV = { PATH: '/usr/bin' };

/**
 * A GitHub scheduled run AS A HOSTED RUNNER WOULD STORE IT.
 *
 * `platform` is overridden because `readProvenance` reads `process.platform`, and this suite
 * runs on Windows: the values are otherwise exactly what the runner captures. The laptop
 * case below deliberately keeps the real platform, because that is the contradiction the
 * attestation rule exists to catch.
 */
const GITHUB_SCHEDULED_PROVENANCE = { ...readProvenance(githubScheduleEnv()), platform: 'linux' };

it('captures a GitHub scheduled run identity, and invents nothing for a laptop', () => {
  const github = readProvenance(githubScheduleEnv());
  assert.equal(github.source, 'github-actions');
  assert.equal(github.event, 'schedule');
  assert.equal(github.runId, '46048680547');
  assert.equal(github.sha, SHA);
  assert.equal(github.workflowRef, WORKFLOW_REF);
  assert.equal(github.actor, 'nreffejzxc');
  assert.equal(github.runner.os, 'Linux');
  assert.equal(github.platform, process.platform);

  const local = readProvenance(LOCAL_ENV);
  assert.equal(local.source, 'local');
  for (const field of ['event', 'runId', 'workflowRef', 'sha', 'actor'] ) {
    assert.equal(local[field], null, `${field} is absent, not a placeholder`);
  }
  assert.equal(local.runAttempt, null);
  assert.equal(local.runner.name, null);
});

it('the event decides the trigger under Actions, so a dispatch cannot claim SCHEDULED', () => {
  const schedule = readProvenance(githubScheduleEnv());
  assert.equal(deriveTrigger({ provenance: schedule, requested: 'MANUAL' }), 'SCHEDULED');

  const dispatch = readProvenance(githubScheduleEnv({ GITHUB_EVENT_NAME: 'workflow_dispatch' }));
  // This is the exact regression: the workflow used to set BACKUP_TRIGGER=SCHEDULED for both.
  assert.equal(deriveTrigger({ provenance: dispatch, requested: 'SCHEDULED' }), 'MANUAL');

  const local = readProvenance(LOCAL_ENV);
  // Both local routes to a false claim — `--trigger=SCHEDULED` and `BACKUP_TRIGGER=SCHEDULED`
  // — arrive here as the same string, so this covers each of them.
  assert.equal(
    deriveTrigger({ provenance: local, requested: 'SCHEDULED' }),
    'MANUAL',
    'a local run cannot claim SCHEDULED: no local process can be attested',
  );
  assert.equal(deriveTrigger({ provenance: local, requested: 'scheduled' }), 'MANUAL', 'case cannot evade the refusal');
  assert.equal(deriveTrigger({ provenance: local, requested: 'nonsense' }), 'UNKNOWN');
  assert.equal(deriveTrigger({ provenance: local }), 'UNKNOWN', 'a bare invocation claims nothing');
});

it('normalises a stored payload without promoting junk to evidence', () => {
  const normalised = normaliseProvenance({
    source: 'github-actions',
    event: '  schedule ',
    runId: ' 46048680547 ',
    runAttempt: '2',
    sha: SHA,
    runner: { name: 'r1', os: 'Linux' },
    platform: 'linux',
    extra: 'dropped',
  });
  assert.equal(normalised.event, 'schedule');
  assert.equal(normalised.runAttempt, 2);
  assert.equal(normalised.runner.os, 'Linux');
  assert.equal(normalised.runner.arch, null);
  assert.equal(Object.hasOwn(normalised, 'extra'), false);

  assert.equal(normaliseProvenance(null), null);
  assert.equal(normaliseProvenance('nope'), null);
  assert.equal(normaliseProvenance({ source: 'somewhere-else' }).source, null);
});

it('attests a genuine scheduled GitHub run and rejects each impostor for its own reason', () => {
  const good = { trigger: 'SCHEDULED', provenance: GITHUB_SCHEDULED_PROVENANCE };
  assert.deepEqual(attestScheduledRun(good), { attested: true, reason: null });

  const cases = [
    [{ trigger: 'MANUAL', provenance: readProvenance(githubScheduleEnv()) }, /does not claim a scheduled/],
    [{ trigger: 'SCHEDULED', provenance: null }, /no provenance was recorded/],
    [
      { trigger: 'SCHEDULED', provenance: readProvenance(LOCAL_ENV) },
      /not started by GitHub Actions/,
    ],
    [
      { trigger: 'SCHEDULED', provenance: readProvenance(githubScheduleEnv({ GITHUB_EVENT_NAME: 'workflow_dispatch' })) },
      /recorded the event as workflow_dispatch/,
    ],
    [
      { trigger: 'SCHEDULED', provenance: readProvenance(githubScheduleEnv({ GITHUB_RUN_ID: 'not-a-run' })) },
      /run id is missing or malformed/,
    ],
    [
      { trigger: 'SCHEDULED', provenance: readProvenance(githubScheduleEnv({ GITHUB_SHA: 'shorts' })) },
      /commit SHA is missing or malformed/,
    ],
    // NOTE ON SCOPE: the shape rule pins the workflow FILE and the BRANCH, not the account.
    // A fork that copied this file could satisfy the shape, and that is deliberate — a fork's
    // run writes to its own database, so it never reaches this collection. What the rule must
    // exclude is a different workflow file or a non-main ref in THIS repository; both are
    // asserted immediately below.
    [
      {
        trigger: 'SCHEDULED',
        provenance: readProvenance(
          githubScheduleEnv({ GITHUB_WORKFLOW_REF: `nreffejzxc/inventory-ai/.github/workflows/backup-daily.yml@refs/heads/feature` }),
        ),
      },
      /workflow reference does not name/,
    ],
    [
      { trigger: 'SCHEDULED', provenance: { ...readProvenance(githubScheduleEnv()), platform: 'win32' } },
      /platform was win32/,
    ],
  ];

  for (const [input, expectation] of cases) {
    const result = attestScheduledRun(input);
    assert.equal(result.attested, false, `expected refusal for ${JSON.stringify(input.provenance?.event ?? input.trigger)}`);
    assert.match(result.reason, expectation);
  }

  // The pattern itself: repository, this file, this branch — nothing else.
  assert.ok(SCHEDULED_WORKFLOW_REF_PATTERN.test(WORKFLOW_REF));
  assert.ok(!SCHEDULED_WORKFLOW_REF_PATTERN.test(WORKFLOW_REF.replace('refs/heads/main', 'refs/heads/dev')));
  assert.ok(!SCHEDULED_WORKFLOW_REF_PATTERN.test(WORKFLOW_REF.replace('backup-daily.yml', 'other.yml')));
});

/** A stored SUCCESS row with a verified archive, shaped exactly as the service produces it. */
function row(overrides = {}) {
  return {
    runId: 'e546b5a7-1c00-4775-a8f5-97a5607f29c2',
    trigger: 'SCHEDULED',
    startedAt: '2026-11-27T07:46:35.071Z',
    finishedAt: '2026-11-27T07:46:45.617Z',
    outcome: 'SUCCESS',
    archive: 'inventoryai_prod_db-20261127T074636Z.tar.gz.gpg',
    sha256: 'f8bc0a3a56e44dc4a5b9d59f414cb5ed7d4f45701f2bb2f046e6db1e2529dbef',
    sizeBytes: 2227266,
    offsite: 'copied',
    pruned: [],
    detail: null,
    provenance: null,
    alert: { kind: null, sentAt: null, error: null },
    ...overrides,
  };
}

const NOW = new Date('2026-11-27T19:25:00.000Z');

it('flags the real production record e546b5a7 as an unattested scheduled claim', async () => {
  // The row exactly as it exists in production: SCHEDULED, host win32, no provenance.
  const view = await readBackupFreshness({
    now: NOW,
    listRuns: async () => [row({ host: 'win32' })],
  });
  assert.equal(view.scheduledAttested, false);
  assert.match(view.attestationReason, /no provenance was recorded/);
  assert.equal(view.scheduledRunId, 'e546b5a7-1c00-4775-a8f5-97a5607f29c2');
  assert.equal(view.attestedAt, '2026-11-27T07:46:45.617Z');
  // `offsite: copied` is not a verified archive, so freshness stays fail-closed too.
  assert.equal(view.fresh, false);
  assert.equal(view.state, 'missing');
});

it('a manual run neither proves the schedule nor hides an unattested claim', async () => {
  const localManual = row({
    runId: 'e2d0664d-0b99-4572-bc42-1ba671e66fbf',
    trigger: 'MANUAL',
    offsite: 'verified',
    startedAt: '2026-11-27T18:23:49.088Z',
    finishedAt: '2026-11-27T18:24:23.114Z',
    provenance: readProvenance(LOCAL_ENV),
  });
  const claim = row({ host: 'win32' });

  const view = await readBackupFreshness({
    now: new Date('2026-11-27T19:30:00.000Z'),
    listRuns: async () => [localManual, claim],
  });
  // The archive is real and recent…
  assert.equal(view.fresh, true);
  assert.equal(view.archive, localManual.archive);
  // …but the scheduled claim underneath it is still unproved.
  assert.equal(view.scheduledAttested, false);
  // A verified GitHub scheduled run flips it, and is the only thing that does.
  const attested = await readBackupFreshness({
    now: new Date('2026-11-27T19:30:00.000Z'),
    listRuns: async () => [
      row({
        provenance: GITHUB_SCHEDULED_PROVENANCE,
        platform: 'linux',
        offsite: 'verified',
        startedAt: '2026-11-27T12:40:00.000Z',
        finishedAt: '2026-11-27T12:41:10.000Z',
      }),
      claim,
    ],
  });
  assert.equal(attested.scheduledAttested, true);
  assert.equal(attested.attestationReason, null);
});

it('reports "no claim at all" when no run has ever said SCHEDULED', async () => {
  const view = await readBackupFreshness({
    now: NOW,
    listRuns: async () => [row({ trigger: 'MANUAL', offsite: 'verified', provenance: readProvenance(LOCAL_ENV) })],
  });
  assert.equal(view.scheduledAttested, false);
  assert.match(view.attestationReason, /no run has claimed a scheduled execution/);
});

/** The smallest Express response the handlers touch. */
function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

it('exposes scheduledAttested with a reason through /api/health/backup', async () => {
  const view = await readBackupFreshness({ now: NOW, listRuns: async () => [row({ host: 'win32' })] });
  const handlers = createHealthHandlers({ readBackup: async () => view });
  const res = fakeRes();
  await handlers.backup({}, res);

  assert.equal(res.statusCode, 503, 'offsite: copied is not a verified backup');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.scheduledAttested, false);
  assert.match(res.body.attestationReason, /no provenance was recorded/);
  assert.equal(res.body.scheduledRunId, 'e546b5a7-1c00-4775-a8f5-97a5607f29c2');

  const attestedView = await readBackupFreshness({
    now: NOW,
    listRuns: async () => [row({ offsite: 'verified', provenance: GITHUB_SCHEDULED_PROVENANCE })],
  });
  const ok = fakeRes();
  await createHealthHandlers({ readBackup: async () => attestedView }).backup({}, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.scheduledAttested, true);
  assert.equal(ok.body.attestationReason, null);
});

it('a failed freshness read answers 503 with the attestation fields, never a partial shape', async () => {
  const handlers = createHealthHandlers({
    readBackup: async () => {
      throw new Error('database unreachable');
    },
  });
  const res = fakeRes();
  await handlers.backup({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.scheduledAttested, false);
  assert.equal(res.body.attestationReason, 'the backup freshness check could not run');
  assert.equal(res.body.scheduledRunId, null);
});

it('addresses /fail for failure and the bare URL for success', () => {
  assert.equal(heartbeatTarget('https://hc-ping.com/uuid', 'success'), 'https://hc-ping.com/uuid');
  assert.equal(heartbeatTarget('https://hc-ping.com/uuid/', 'success'), 'https://hc-ping.com/uuid');
  assert.equal(heartbeatTarget('https://hc-ping.com/uuid', 'failure'), 'https://hc-ping.com/uuid/fail');
  assert.equal(heartbeatTarget('', 'success'), '');
});

it('is silent without a URL, so a laptop run cannot satisfy the monitor', async () => {
  const calls = [];
  const result = await sendHeartbeat({ url: '', fetchImpl: async (...args) => calls.push(args) });
  assert.deepEqual(result, { sent: false, status: null, reason: 'not-configured' });
  assert.equal(calls.length, 0, 'no request is made when unconfigured');
});

it('sends the signal it was asked for, and never leaks the URL when it cannot', async () => {
  const seen = [];
  const ok = await sendHeartbeat({
    url: 'https://hc-ping.com/secret-uuid',
    outcome: 'success',
    fetchImpl: async (target, init) => {
      seen.push([target, init.method]);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(ok, { sent: true, status: 200, reason: null });
  assert.deepEqual(seen[0], ['https://hc-ping.com/secret-uuid', 'POST']);

  const failed = await sendHeartbeat({
    url: 'https://hc-ping.com/secret-uuid',
    outcome: 'failure',
    fetchImpl: async (target) => {
      seen.push([target, 'POST']);
      return { ok: false, status: 500 };
    },
  });
  assert.deepEqual(failed, { sent: false, status: 500, reason: 'rejected' });
  assert.equal(seen[1][0], 'https://hc-ping.com/secret-uuid/fail', 'failure uses /fail');

  // A DNS failure or timeout must not surface the credential in its message.
  const unreachable = await sendHeartbeat({
    url: 'https://hc-ping.com/secret-uuid',
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED (url: https://hc-ping.com/secret-uuid)');
    },
  });
  assert.deepEqual(unreachable, { sent: false, status: null, reason: 'unreachable' });
  assert.ok(!JSON.stringify(unreachable).includes('hc-ping'), 'the URL is dropped, not logged');
  assert.ok(!describeHeartbeat(unreachable).includes('http'), 'the log line names no URL');
  assert.equal(describeHeartbeat({ sent: true, status: 200 }, 'success'), 'heartbeat delivered (HTTP 200)');
  assert.equal(describeHeartbeat(unreachable, 'failure'), 'failure signal NOT delivered (unreachable)');

  const invalid = await sendHeartbeat({ url: 'not-a-url', fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.deepEqual(invalid, { sent: false, status: null, reason: 'invalid-url' });
});
