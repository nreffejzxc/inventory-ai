// The offsite (Google Drive) half of the daily backup, and the alarm that watches it.
//
// WHY THIS FILE EXISTS. The cloud sync is the only part of the backup that talks
// to a service this repository does not run, so its failure modes are the ones a
// person cannot see: a transfer the provider accepted but did not store, a
// retention pass that removed the newest archive, a second same-day dispatch
// that made a second copy, and a "verified" status granted because a command
// exited 0. Each of those is pinned here against a temporary directory standing
// in for the remote, so none of them depends on credentials or the network.
//
// WHAT IT DOES NOT PROVE. That Google Drive accepts an upload. That needs the
// owner's OAuth token and is stated as unverified in the report rather than
// implied by these tests.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { BackupSafetyError } from '../scripts/backup/lib.mjs';
import {
  assertRemote,
  hasArchiveForDay,
  listRemoteArchives,
  precheckSameDay,
  pruneRemote,
  readSidecarDigest,
  syncOffsite,
  utcDayKey,
  verifyRemoteArchive,
} from '../scripts/backup/cloudSync.mjs';
import { readBackupFreshness } from '../src/services/backupFreshness.service.ts';
import { createHealthRouter } from '../src/routes/health.routes.ts';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(testDir, '..', '..');
const REMOTE = 'drive:InventoryAI-Backups';

/**
 * A stand-in for `rclone`, backed by two local directories.
 *
 * It implements exactly the subcommands the module uses, so the module cannot
 * quietly start depending on another one without a test noticing.
 */
function fakeRclone({ remoteDir, localDir }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [command] = args;
    const resolved = (target) => {
      if (target.startsWith(`${REMOTE}/`)) return path.join(remoteDir, target.slice(REMOTE.length + 1));
      if (target === REMOTE) return remoteDir;
      return path.isAbsolute(target) ? target : path.join(localDir, target);
    };
    if (command === 'mkdir') {
      await mkdir(resolved(args.at(-1)), { recursive: true });
      return { stdout: '', stderr: '' };
    }
    if (command === 'lsf') {
      const directory = resolved(args.at(-1));
      const entries = existsSync(directory) ? await readdir(directory, { withFileTypes: true }) : [];
      return {
        stdout: entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
          .join('\n'),
        stderr: '',
      };
    }
    if (command === 'copyto') {
      // `copyto [--checksum] <source> <destination>`
      const source = resolved(args.at(-2));
      const destination = resolved(args.at(-1));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(source));
      return { stdout: '', stderr: '' };
    }
    if (command === 'deletefile') {
      const target = resolved(args[1]);
      if (!existsSync(target)) throw new Error(`rclone deletefile failed: ${args[1]} is not on the remote`);
      const { rm } = await import('node:fs/promises');
      await rm(target, { force: true });
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected rclone subcommand: ${command}`);
  };
  return { run, calls };
}

async function makeArchive(directory, name, contents = 'encrypted-bytes') {
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, name);
  // Owner-only, like the real archive: these live in a `mkdtemp` directory, and
  // an explicit secure mode keeps that true even where the platform's umask is
  // permissive.
  await writeFile(archive, contents, { mode: 0o600 });
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(contents).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}\n`, { mode: 0o600 });
  return { archive, digest };
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inventory-ai-cloud-test-'));
  const localDir = path.join(root, 'local');
  const remoteDir = path.join(root, 'remote');
  await mkdir(localDir, { recursive: true });
  await mkdir(remoteDir, { recursive: true });
  return { root, localDir, remoteDir, ...fakeRclone({ remoteDir, localDir }) };
}

describe('cloud remote guard', () => {
  it('accepts remote:folder and refuses everything that is not one', () => {
    assert.equal(assertRemote('gdrive:InventoryAI-Backups'), 'gdrive:InventoryAI-Backups');
    assert.equal(assertRemote(' gdrive:Backups/2026 '), 'gdrive:Backups/2026');

    // A bare word would be read by rclone as a local path.
    assert.throws(() => assertRemote('InventoryAI-Backups'), /remote:folder/);
    // The remote root is where a prune could reach files this job never wrote.
    assert.throws(() => assertRemote('gdrive:'), /must name a folder/);
    assert.throws(() => assertRemote('gdrive:/'), /must name a folder/);
    // Climbing out of the configured folder.
    assert.throws(() => assertRemote('gdrive:Backups/../Other'), /must name a folder/);
    // An option, not a destination.
    assert.throws(() => assertRemote('--dry-run'), /must not start with/);
    assert.throws(() => assertRemote(''), /no cloud remote/);
  });
});

describe('upload, read back, and retention on the remote', () => {
  it('uploads the archive with its sidecar and proves it by re-downloading it', async () => {
    const { run, remoteDir } = await workspace();
    const name = 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg';
    const { archive, digest } = await makeArchive(path.join(os.tmpdir(), `local-${Date.now()}`), name);

    const result = await syncOffsite({ run, remote: REMOTE, archive, counts: { daily: 14, weekly: 4, monthly: 3 } });

    assert.equal(result.verified, true);
    assert.equal(result.digest, digest);
    // Both halves of the recovery point are on the remote.
    assert.ok(existsSync(path.join(remoteDir, name)));
    assert.ok(existsSync(path.join(remoteDir, `${name}.sha256`)));
    assert.equal(await readSidecarDigest(path.join(remoteDir, name)), digest);
  });

  it('refuses an archive whose offsite bytes do not match the sidecar', async () => {
    const { run, remoteDir } = await workspace();
    const name = 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg';
    const { digest } = await makeArchive(path.join(os.tmpdir(), `local-${Date.now()}`), name);
    await mkdir(remoteDir, { recursive: true });
    // The provider accepted the bytes and stored something else.
    await writeFile(path.join(remoteDir, name), 'truncated');

    await assert.rejects(
      () => verifyRemoteArchive(run, REMOTE, name, digest),
      /does not match|hashes to/,
    );
  });

  it('fails a corrupted upload without reaching retention', async () => {
    const { run, remoteDir } = await workspace();
    const name = 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg';
    const older = 'inventoryai_prod_db-20261126T024501Z.tar.gz.gpg';
    await writeFile(path.join(remoteDir, older), 'yesterday');
    const { archive } = await makeArchive(path.join(os.tmpdir(), `local-${Date.now()}`), name);

    const calls = [];
    // The provider accepted the transfer and stored something else.
    const corrupting = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'copyto' && args.at(-1).startsWith(`${REMOTE}/`)) {
        await writeFile(path.join(remoteDir, path.basename(args.at(-1))), 'truncated');
        return { stdout: '', stderr: '' };
      }
      return run(args);
    };

    await assert.rejects(
      () => syncOffsite({ run: corrupting, remote: REMOTE, archive, counts: { daily: 14, weekly: 4, monthly: 3 } }),
      /hashes to/,
    );
    // Verification failed, so no deletion was attempted: yesterday's archive is
    // still the newest copy a restore could use.
    assert.equal(calls.includes('deletefile'), false);
    assert.ok(existsSync(path.join(remoteDir, older)));
  });

  it('takes the expected digest from the sidecar, not from a caller-supplied value', async () => {
    const { run, remoteDir } = await workspace();
    const name = 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg';
    const { archive, digest } = await makeArchive(path.join(os.tmpdir(), `local-${Date.now()}`), name);

    // `digest` is no longer a parameter. A stray key must neither fail a good
    // upload nor stand in for the sidecar.
    const result = await syncOffsite({
      run,
      remote: REMOTE,
      archive,
      digest: 'c'.repeat(64),
      counts: { daily: 14, weekly: 4, monthly: 3 },
    });

    assert.equal(result.digest, digest);
    assert.equal(await readSidecarDigest(path.join(remoteDir, name)), digest);
  });

  it('applies 14/4/3 on the remote and never deletes the newest archive', async () => {
    const { run, remoteDir } = await workspace();
    await mkdir(remoteDir, { recursive: true });
    // 20 consecutive days, plus the sidecars.
    const names = [];
    for (let day = 1; day <= 20; day += 1) {
      const name = `inventoryai_prod_db-202611${String(day).padStart(2, '0')}T024501Z.tar.gz.gpg`;
      names.push(name);
      await writeFile(path.join(remoteDir, name), `bytes-${day}`);
      await writeFile(path.join(remoteDir, `${name}.sha256`), `${'a'.repeat(64)}  ${name}\n`);
    }

    const result = await pruneRemote(run, REMOTE, { counts: { daily: 14, weekly: 4, monthly: 3 } });

    const remaining = await readdir(remoteDir);
    const newest = names.at(-1);
    assert.ok(remaining.includes(newest), 'the newest archive must survive retention');
    // 15, not 14: the daily window is the 14 newest days (Nov 7–20) and the 4th
    // weekly bucket reaches back to the week of Oct 26–Nov 1, whose newest archive
    // is Nov 1. The union is the point — a bucket never deletes what another keeps.
    assert.equal(result.kept, 15);
    assert.equal(result.removed.length, 5);
    for (const name of result.removed) {
      assert.equal(remaining.includes(name), false, `${name} should be gone`);
      assert.equal(remaining.includes(`${name}.sha256`), false, `${name} sidecar should be gone with it`);
    }
    // Unrecognised files are never touched.
    await writeFile(path.join(remoteDir, 'notes.txt'), 'keep me');
    await pruneRemote(run, REMOTE, { counts: { daily: 14, weekly: 4, monthly: 3 } });
    assert.ok((await readdir(remoteDir)).includes('notes.txt'));
  });
});

describe('same-day idempotency', () => {
  it('recognises a run for a given UTC day from the archive name alone', async () => {
    const { run, remoteDir } = await workspace();
    await mkdir(remoteDir, { recursive: true });
    await writeFile(path.join(remoteDir, 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg'), 'x');

    const archives = await listRemoteArchives(run, REMOTE);
    assert.equal(hasArchiveForDay(archives, '2026-11-27'), true);
    assert.equal(hasArchiveForDay(archives, '2026-11-28'), false);
    assert.equal(utcDayKey(new Date('2026-11-27T23:59:00Z')), '2026-11-27');
  });
});

describe('same-day pre-check failure handling', () => {
  const DAY = '2026-11-27';
  const TODAY = 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg';

  it('skips without opening a run record when today\'s archive already landed', async () => {
    const { run, remoteDir } = await workspace();
    await writeFile(path.join(remoteDir, TODAY), 'x');
    let opened = 0;

    const result = await precheckSameDay({
      run,
      remote: REMOTE,
      dayKey: DAY,
      beginRun: async () => {
        opened += 1;
      },
    });

    assert.equal(result.skip, true);
    assert.equal(result.archive, TODAY);
    // The duplicate delivery must leave no row, no archive and no alert behind.
    assert.equal(opened, 0);
  });

  it('proceeds without opening a run record when today has no archive', async () => {
    const { run } = await workspace();
    let opened = 0;

    const result = await precheckSameDay({
      run,
      remote: REMOTE,
      dayKey: DAY,
      beginRun: async () => {
        opened += 1;
      },
    });

    assert.equal(result.skip, false);
    assert.equal(result.archive, null);
    assert.equal(opened, 0);
  });

  it('opens the run record before failing when the OAuth token is rejected', async () => {
    const order = [];
    const runner = async (args) => {
      order.push(args[0]);
      // rclone reports a revoked/expired token on the very first call.
      throw new Error('rclone mkdir failed with exit 1: invalid_grant: Token has been expired or revoked');
    };

    await assert.rejects(
      () =>
        precheckSameDay({
          run: runner,
          remote: REMOTE,
          dayKey: DAY,
          beginRun: async () => {
            order.push('record');
          },
        }),
      (error) =>
        error instanceof BackupSafetyError &&
        /same-day pre-check could not list/.test(error.message) &&
        /invalid_grant/.test(error.message),
    );

    // The record exists before the throw, so the caller's failure path has a row
    // to close as FAILED and one alert to send.
    assert.deepEqual(order, ['mkdir', 'record']);
  });

  it('opens the run record when Drive is unreachable after the folder exists', async () => {
    let opened = 0;
    const runner = async (args) => {
      if (args[0] === 'mkdir') return { stdout: '', stderr: '' };
      throw new Error('rclone lsf failed with exit 1: 502 Bad Gateway');
    };

    await assert.rejects(
      () =>
        precheckSameDay({
          run: runner,
          remote: REMOTE,
          dayKey: DAY,
          beginRun: async () => {
            opened += 1;
          },
        }),
      (error) => error instanceof BackupSafetyError && /502 Bad Gateway/.test(error.message),
    );
    assert.equal(opened, 1);
  });
});

describe('freshness verdict', () => {
  const verifiedRun = (overrides = {}) => ({
    runId: 'r1',
    trigger: 'SCHEDULED',
    startedAt: '2026-11-27T02:40:00.000Z',
    finishedAt: '2026-11-27T02:45:00.000Z',
    outcome: 'SUCCESS',
    archive: 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg',
    sha256: 'b'.repeat(64),
    sizeBytes: 2_200_000,
    offsite: 'verified',
    pruned: [],
    detail: null,
    alert: { kind: null, sentAt: null, error: null },
    ...overrides,
  });

  it('is fresh only for a SUCCESS run carrying a verified offsite archive', async () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    const fresh = await readBackupFreshness({ now, listRuns: async () => [verifiedRun()] });
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.state, 'fresh');
    assert.equal(fresh.archive, 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg');

    // A run that only copied locally is not an offsite backup.
    const copied = await readBackupFreshness({
      now,
      listRuns: async () => [verifiedRun({ offsite: 'copied' })],
    });
    assert.equal(copied.fresh, false);
    assert.equal(copied.state, 'missing');

    // A SUCCESS row with no digest cannot be restored from.
    const noDigest = await readBackupFreshness({
      now,
      listRuns: async () => [verifiedRun({ sha256: null })],
    });
    assert.equal(noDigest.fresh, false);

    // A stored timestamp that does not parse must fail closed, not throw out of
    // the service the health route calls.
    const malformed = await readBackupFreshness({
      now,
      listRuns: async () => [verifiedRun({ finishedAt: 'not-a-date' })],
    });
    assert.equal(malformed.fresh, false);
    assert.equal(malformed.lastVerifiedAt, null);
    assert.equal(malformed.ageHours, null);
  });

  it('turns stale past the threshold, and fails closed when unreadable or empty', async () => {
    const stale = await readBackupFreshness({
      now: new Date('2026-11-29T02:45:00.000Z'),
      maxAgeHours: 30,
      listRuns: async () => [verifiedRun()],
    });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.fresh, false);
    assert.ok(stale.ageHours > 30);

    const none = await readBackupFreshness({ now: new Date(), listRuns: async () => [] });
    assert.equal(none.state, 'missing');
    assert.equal(none.fresh, false);

    const broken = await readBackupFreshness({
      listRuns: async () => {
        throw new Error('connection lost');
      },
    });
    assert.equal(broken.state, 'unreadable');
    assert.equal(broken.fresh, false);
    // The reason is carried, without the connection string.
    assert.match(broken.detail ?? '', /connection lost/);
  });
});

describe('workflow and runner guards', () => {
  const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/backup-daily.yml'), 'utf8');
      const runner = readFileSync(path.join(REPO_ROOT, 'server/scripts/backup-daily.mjs'), 'utf8');
    // The pre-check runs before any archive exists, so its failure needs the run
    // record opened for it — otherwise a revoked Drive token produces no durable
    // FAILED row and no alert.
    assert.match(runner, /beginRun: \(\) => beginRunRecord\(/);

  it('schedules itself and needs no PAT or Worker', () => {
    // A comment sits between the key and the entry in this file, so the cron is
    // matched across the intervening lines rather than on the next one.
    assert.match(workflow, /\n\s{2}schedule:[\s\S]{0,240}?- cron: '\d+ \d+ \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    // The Worker design existed only to mint an Actions-write token; nothing here
    // may reintroduce one.
    assert.doesNotMatch(workflow, /ACTIONS_TOKEN|WORKFLOW_DISPATCH_TOKEN|api\.github\.com\/repos/);
    assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  });

  it('never carries the private key or the passphrase', () => {
    // The comment above says the key is absent; what must be absent is any way to
    // PUT it there — a secret named for a private key, a passphrase value, or the
    // loopback trick that would let gpg read one from a file.
    assert.doesNotMatch(workflow, /secrets\.[A-Z_]*PRIVATE[A-Z_]*|secrets\.[A-Z_]*PASSPHRASE/i);
    assert.doesNotMatch(workflow, /gpg-passphrase|--passphrase|--pinentry-mode\s+loopback/i);
    assert.match(workflow, /BACKUP_GPG_PUBLIC_KEY/);
    // The job must not write an rclone config file: the token arrives in the env.
    assert.doesNotMatch(workflow, /rclone config|--config /);
  });

  it('runs the cloud mode with the same-day guard, and verifies before recording', () => {
    // The guard is dispatch-conditional: the schedule (where `inputs.force` is empty)
    // always sets it, and only an explicit `force: true` omits it, so one UTC day still
    // cannot gain two archives from two scheduled deliveries.
    assert.match(workflow, /args=\(--cloud="\$BACKUP_CLOUD_REMOTE"\)/);
    assert.match(workflow, /if \[ "\$\{\{ inputs\.force \}\}" != "true" \]; then\s*\n\s*args\+=\(--skip-if-today\)/);
    assert.match(workflow, /force:[\s\S]{0,200}?default: false/);
    assert.doesNotMatch(
      workflow,
      /node scripts\/backup-daily\.mjs --cloud="\$BACKUP_CLOUD_REMOTE" --skip-if-today/,
      'the guard must not be unconditional, or a dispatch could never run a backup',
    );
    // `offsite: 'verified'` may only appear on the branch that ran syncOffsite.
    const verifiedAt = runner.indexOf("offsite: cloudResult ? 'verified'");
    const syncAt = runner.indexOf('await syncOffsite(');
    assert.ok(syncAt > 0 && verifiedAt > syncAt, 'verified must be recorded only after the sync ran');
    // And the sync itself is upload → read back → compare → prune.
    const module = readFileSync(path.join(REPO_ROOT, 'server/scripts/backup/cloudSync.mjs'), 'utf8');
    assert.ok(module.indexOf('verifyRemoteArchive(') < module.indexOf('pruneRemote(run, remote'));
  });
});

// The HTTP contract a monitor actually polls. The service is pinned above; this
// pins that the route EXISTS at `/api/health/backup` (it answered 404 before the
// route was registered), that a fresh verified archive is a 200, and that
// everything else — stale, missing, unreadable — is a 503 so an uptime monitor
// treats it as an incident with no parsing.
describe('GET /api/health/backup', () => {
  const verifiedRun = (overrides = {}) => ({
    runId: 'r1',
    trigger: 'SCHEDULED',
    startedAt: '2026-11-27T02:40:00.000Z',
    finishedAt: '2026-11-27T02:45:00.000Z',
    outcome: 'SUCCESS',
    archive: 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg',
    sha256: 'c'.repeat(64),
    sizeBytes: 2_200_000,
    offsite: 'verified',
    pruned: [],
    detail: null,
    alert: { kind: null, sentAt: null, error: null },
    ...overrides,
  });

  async function request(readBackup, run) {
    const app = express();
    app.use('/api/health', createHealthRouter({ readBackup }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health/backup`);
      return await run(res, await res.json());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('is mounted and answers 200 for a fresh verified archive', async () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    await request(
      () => readBackupFreshness({ now, listRuns: async () => [verifiedRun()] }),
      (res, body) => {
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(body.state, 'fresh');
        assert.equal(body.fresh, true);
        assert.equal(body.archive, 'inventoryai_prod_db-20261127T024501Z.tar.gz.gpg');
        assert.equal(body.sha256, 'c'.repeat(64));
        assert.equal(body.maxAgeHours, 30);
        assert.ok(body.ageHours > 0);
        // The same exposure class as /api/health/integrity: a verdict, never a
        // connection string, credential or run-record detail.
        assert.deepEqual(
          Object.keys(body).sort(),
          [
            'ageHours',
            'archive',
            // Provenance attestation (2026-11-28): the same exposure class — a verdict and
            // a short reason. It says whether the newest SCHEDULED claim came from the GitHub
            // schedule, never which credential or connection produced the archive.
            'attestationReason',
            'attestedAt',
            'detail',
            'fresh',
            'lastOutcome',
            'lastOutcomeAt',
            'lastVerifiedAt',
            'maxAgeHours',
            'scheduledAttested',
            'scheduledRunId',
            'sha256',
            'state',
            'timestamp',
          ],
        );
      },
    );
  });

  it('answers 503 for a stale archive and for no verified run at all', async () => {
    await request(
      () =>
        readBackupFreshness({
          now: new Date('2026-11-30T02:45:00.000Z'),
          maxAgeHours: 30,
          listRuns: async () => [verifiedRun()],
        }),
      (res, body) => {
        assert.equal(res.status, 503);
        assert.equal(body.state, 'stale');
        assert.equal(body.fresh, false);
      },
    );

    // A SUCCESS run that only copied locally is NOT a verified offsite backup,
    // so it must not be reported as fresh.
    await request(
      () => readBackupFreshness({ now: new Date(), listRuns: async () => [verifiedRun({ offsite: 'copied' })] }),
      (res, body) => {
        assert.equal(res.status, 503);
        assert.equal(body.state, 'missing');
        assert.equal(body.fresh, false);
      },
    );
  });

  it('answers 503 when the run history cannot be read', async () => {
    await request(
      async () => {
        throw new Error('the backup run history could not be read');
      },
      (res, body) => {
        assert.equal(res.status, 503);
        assert.equal(body.state, 'unreadable');
        assert.equal(body.fresh, false);
        assert.doesNotMatch(JSON.stringify(body), /mongodb(\+|:\/\/)/i);
      },
    );
  });
});
