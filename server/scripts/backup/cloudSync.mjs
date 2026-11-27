// Offsite synchronisation to Google Drive, through `rclone`.
//
// WHY THIS IS A SEPARATE MODULE. The local off-machine copy (`backup-daily.mjs`
// → `copyArchive`) proves a copy on a second disk of the same machine. That is
// not an offsite backup: one stolen laptop takes both. This module is the copy
// that survives the machine, and it is deliberately built from the same three
// pieces the local path already uses — the `.sha256` sidecar as the only
// statement of what the archive should hash to, `parseArchiveName` for what
// counts as an archive, and `planRetention` for what may be deleted.
//
// THREE RULES, THE SAME ONES AS THE LOCAL COPY:
//
//   1. UPLOAD, THEN DOWNLOAD, THEN COMPARE. `rclone copyto` exiting 0 means the
//      transfer was accepted, not that the bytes arrived intact. The archive is
//      read back from the remote and hashed; a mismatch fails the run and is
//      reported as a failure, never as "uploaded".
//   2. RETENTION NEVER DELETES THE NEWEST ARCHIVE. The caller passes the name it
//      just uploaded as `protect`, and `planRetention` already keeps the newest
//      name it can see.
//   3. THE ARCHIVE IS THE UNIT. A sidecar without its archive, or an archive
//      without its sidecar, is not a recovery point, so both travel together on
//      upload and are removed together on prune.
//
// WHAT IT NEVER SEES. No connection string, no GPG private key and no
// passphrase: encryption happened before this module is called, and the only
// thing read here is the public digest in the sidecar.
//
// The remote is reached ONLY through the injected `run(command, args)` so the
// whole sync — upload, read-back, prune — is testable against a temporary
// directory without rclone and without a Google account.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BackupSafetyError, formatBytes, sha256File } from './lib.mjs';
import { RETENTION_DEFAULTS, parseArchiveName, planRetention } from './retention.mjs';

/** `gdrive:InventoryAI-Backups` — one rclone remote plus a folder inside it. */
export const DEFAULT_CLOUD_REMOTE = 'gdrive:InventoryAI-Backups';

/** A remote name is a config section, then a colon, then a path. */
const REMOTE_PATTERN = /^[A-Za-z0-9_-]+:[^\s]+$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Guard — a remote that cannot be mistaken for a local path or a flag.
 *
 * `--` at the start would be read by rclone as an option, an empty path would
 * resolve to the remote root (where a prune could reach unrelated files), and a
 * `..` segment would climb out of the folder the operator configured. Each is
 * refused with its own reason rather than a generic "invalid".
 */
export function assertRemote(remote) {
  const value = String(remote ?? '').trim();
  if (!value) {
    throw new BackupSafetyError(
      'Refusing to sync: no cloud remote. Pass --cloud=<remote:path> or set BACKUP_CLOUD_REMOTE ' +
        '(for example gdrive:InventoryAI-Backups).',
    );
  }
  if (CONTROL_CHARS.test(value)) {
    throw new BackupSafetyError('Refusing to sync: the cloud remote contains a control character.');
  }
  if (value.startsWith('-')) {
    throw new BackupSafetyError('Refusing to sync: the cloud remote must not start with "-".');
  }
  // The folder is checked BEFORE the shape: `gdrive:` is a well-formed remote and
  // an empty folder, and naming the real problem (the remote root) is more useful
  // than calling the whole value malformed.
  const colon = value.indexOf(':');
  if (colon === -1) {
    throw new BackupSafetyError(
      `Refusing to sync: "${value}" is not a remote path of the form "remote:folder". ` +
        'A bare folder name would be read as a local directory.',
    );
  }
  const folder = value.slice(colon + 1);
  if (!folder || folder === '/' || folder.replace(/\/+$/, '').split('/').includes('..')) {
    throw new BackupSafetyError(
      `Refusing to sync: "${value}" must name a folder inside the remote, not its root and not a ` +
        'parent directory.',
    );
  }
  if (!REMOTE_PATTERN.test(value)) {
    throw new BackupSafetyError(
      `Refusing to sync: "${value}" is not a remote name and folder ` +
        '(letters, digits, underscore or hyphen, then a colon, then a path).',
    );
  }
  return value;
}

/** The digest recorded in `<archive>.sha256`, or a stop. */
export async function readSidecarDigest(archive) {
  let raw;
  try {
    raw = await readFile(`${archive}.sha256`, 'utf8');
  } catch {
    throw new BackupSafetyError(
      `checksum sidecar "${path.basename(archive)}.sha256" is missing — the archive bytes are not proved.`,
    );
  }
  const digest = raw.trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) {
    throw new BackupSafetyError(`"${path.basename(archive)}.sha256" does not contain a SHA-256 digest.`);
  }
  return digest;
}

/** The default runner: `rclone`, with output captured so a failure says why. */
export function rcloneRunner(command = 'rclone') {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.once('error', (error) => reject(error));
      child.once('close', (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          reject(
            new Error(
              `rclone ${args[0] ?? ''} failed with exit ${code ?? signal}` +
                `${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
            ),
          );
        }
      });
    });
}

/** Archive file names in the remote folder, newest first. Sidecars are excluded. */
export async function listRemoteArchives(run, remote) {
  const { stdout } = await run(['lsf', '--files-only', '--max-depth', '1', remote]);
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => parseArchiveName(name))
    .filter(Boolean)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1));
}

/** `2026-11-27` — the UTC day an archive belongs to, taken from its own name. */
export function utcDayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Has an archive already been produced for this UTC day?
 *
 * The idempotency guard for a second dispatch. It reads the archive's stamped
 * name, not the remote's timestamp metadata: a sync client rewrites mtimes, and
 * the name is the same fact the local retention planner already trusts.
 */
export function hasArchiveForDay(archives, dayKey) {
  return (archives ?? []).some((entry) => entry.stamp.slice(0, 8) === String(dayKey).replace(/-/g, ''));
}

/**
 * The same-day pre-check, and what failing it means.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES IN THE RUNNER. The listing is the
 * first thing a scheduled run does that depends on Drive, and it happens before
 * any archive exists — so a failure here used to exit non-zero having written no
 * run record and sent no alert. A run that cannot even ask Drive whether today is
 * done is a failed execution, and it must be recorded as one. Putting the
 * decision here keeps that rule in one place and lets it be pinned without
 * rclone, credentials or a database: `beginRun` is injected, and the tests assert
 * it is called exactly once before the throw.
 *
 * THE FOLDER IS CREATED FIRST. On the first ever run the destination folder does
 * not exist, and listing a missing folder is an error on most backends; `mkdir`
 * is idempotent, so it makes the first run work without turning a real
 * credential or connectivity failure into "nothing there".
 */
export async function precheckSameDay({
  run,
  remote,
  dayKey = utcDayKey(),
  beginRun,
  log = () => {},
}) {
  let existing;
  try {
    const guarded = assertRemote(remote);
    await run(['mkdir', guarded]);
    existing = await listRemoteArchives(run, guarded);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The record is opened before the throw so the caller's existing failure path
    // (close as FAILED, then one alert) has a row to close.
    if (beginRun) await beginRun();
    throw new BackupSafetyError(
      `the same-day pre-check could not list ${remote}, so no backup was attempted: ${reason}`,
    );
  }
  const today = existing.find((entry) => hasArchiveForDay([entry], dayKey));
  if (today) log(`precheck : ${today.name} already exists for ${dayKey} on ${remote}`);
  return { skip: Boolean(today), archive: today ? today.name : null, dayKey };
}

/**
 * Upload the archive and its sidecar.
 *
 * `copyto` rather than `copy`: the destination is the exact file, so a retry of
 * the same run overwrites the same name instead of creating a second copy under
 * a generated one.
 */
export async function uploadArchive(run, remote, archive, log = () => {}) {
  const name = path.basename(archive);
  const digest = await readSidecarDigest(archive);
  const size = (await stat(archive)).size;
  await run(['copyto', '--checksum', archive, `${remote}/${name}`]);
  await run(['copyto', '--checksum', `${archive}.sha256`, `${remote}/${name}.sha256`]);
  log(`uploaded : ${name} (${formatBytes(size)})`);
  return { name, digest, size };
}

/**
 * Read the archive back and hash it.
 *
 * This is the step that turns "rclone exited 0" into "the bytes are there". The
 * temporary copy is removed in a `finally` so a failed verification does not
 * leave a decrypted-nothing, but still large, file on the runner.
 */
export async function verifyRemoteArchive(run, remote, name, expectedDigest, { tmpDir } = {}) {
  const parent = tmpDir || (await mkdtemp(path.join(os.tmpdir(), 'inventory-ai-cloudverify-')));
  const target = path.join(parent, `readback-${randomUUID()}-${name}`);
  try {
    await run(['copyto', `${remote}/${name}`, target]);
    const actual = await sha256File(target);
    if (actual !== expectedDigest) {
      throw new BackupSafetyError(
        `the archive read back from ${remote} hashes to ${actual} but its sidecar records ` +
          `${expectedDigest}; the offsite copy is not a verified backup.`,
      );
    }
    return actual;
  } finally {
    await rm(target, { force: true }).catch(() => {});
    if (!tmpDir) await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Apply 14/4/3 on the remote, using the same pure planner as the local pass.
 *
 * Deleting the sidecar is best-effort and happens only after its archive was
 * deleted: an orphaned sidecar is harmless, an orphaned archive is not, so the
 * order is never reversed.
 */
export async function pruneRemote(run, remote, { counts = {}, protect = [], log = () => {} } = {}) {
  const archives = await listRemoteArchives(run, remote);
  if (archives.length === 0) {
    log('retain   : no archives on the remote');
    return { removed: [], kept: 0 };
  }
  const plan = planRetention(
    archives.map((entry) => entry.name),
    {
      daily: counts.daily ?? RETENTION_DEFAULTS.daily,
      weekly: counts.weekly ?? RETENTION_DEFAULTS.weekly,
      monthly: counts.monthly ?? RETENTION_DEFAULTS.monthly,
      protect,
    },
  );
  for (const name of plan.remove) {
    await run(['deletefile', `${remote}/${name}`]);
    await run(['deletefile', `${remote}/${name}.sha256`]).catch(() => {});
    log(`prune    : removed ${name} (+ sidecar) from the remote`);
  }
  log(
    `retain   : ${plan.keep.length} archive(s) kept on the remote (daily ${plan.buckets.daily.length}/${counts.daily ?? RETENTION_DEFAULTS.daily}, ` +
      `weekly ${plan.buckets.weekly.length}/${counts.weekly ?? RETENTION_DEFAULTS.weekly}, ` +
      `monthly ${plan.buckets.monthly.length}/${counts.monthly ?? RETENTION_DEFAULTS.monthly})`,
  );
  return { removed: plan.remove, kept: plan.keep.length };
}

/**
 * The whole offsite step: upload, prove it by reading it back, then prune.
 *
 * ONE STATEMENT OF WHAT THE ARCHIVE SHOULD HASH TO. That statement is the
 * `.sha256` sidecar, and it is read here rather than accepted from the caller:
 * a caller-supplied digest could only ever be either the same value `uploadArchive`
 * has just read from that sidecar — a check that cannot fail — or a third number
 * with no authority behind it. The verification that matters is the read-back
 * below, which hashes the bytes that came back from the remote.
 *
 * Pruning happens LAST and only after verification, so a run that cannot prove
 * its upload cannot delete the older archive that is still the newest good copy.
 */
export async function syncOffsite({
  run,
  remote,
  archive,
  counts = {},
  log = () => {},
  tmpDir,
}) {
  const expected = await readSidecarDigest(archive);
  const uploaded = await uploadArchive(run, remote, archive, log);
  const verifiedDigest = await verifyRemoteArchive(run, remote, uploaded.name, expected, { tmpDir });
  log(`verified : ${uploaded.name} re-downloaded from ${remote} and matched its SHA-256`);
  const retention = await pruneRemote(run, remote, { counts, protect: [uploaded.name], log });
  return {
    name: uploaded.name,
    digest: verifiedDigest,
    size: uploaded.size,
    pruned: retention.removed,
    verified: true,
  };
}

export default {
  DEFAULT_CLOUD_REMOTE,
  assertRemote,
  readSidecarDigest,
  rcloneRunner,
  listRemoteArchives,
  utcDayKey,
  hasArchiveForDay,
  precheckSameDay,
  uploadArchive,
  verifyRemoteArchive,
  pruneRemote,
  syncOffsite,
};
