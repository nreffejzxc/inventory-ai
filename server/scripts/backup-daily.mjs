// `npm run backup:daily` — one unattended run: create, copy off-machine, prune.
//
// This is the body of the Windows Scheduled Task (scripts/run-db-backup.ps1); it
// is deliberately a separate command so the same run can be repeated by hand.
//
// It does three things and no more:
//
//   1. runs `backup:db:encrypted` exactly as documented, so the encryption, the
//      manifest-before-encryption check and the `.sha256` sidecar are unchanged;
//   2. copies the new archive AND its sidecar to the off-machine directory,
//      verifying the copy's SHA-256 before and after the rename that places it;
//   3. applies the retention policy (14 daily / 4 weekly / 3 monthly) in both
//      directories, independently, never touching the archive just created.
//
// WHAT IT DOES NOT DO. It never restores, never writes to a database, never
// needs the private key or the passphrase (encryption uses only the public key),
// and never deletes the newest archive. A failure at any step exits non-zero and
// leaves the local archive in place — a copy that could not be placed in
// OneDrive is still a backup, so it is never removed as compensation.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackupSafetyError, assertBackupDir, formatBytes, sha256File } from './backup/lib.mjs';
import { RETENTION_DEFAULTS, parseArchiveName, planRetention } from './backup/retention.mjs';
import { notifyInterruptedRuns, notifyRunFailure } from './backup/alerts.mjs';
import { closeRunRecord, closeRunStore, openRunRecord } from './backup/runStore.mjs';

const COMMAND = 'backup:daily';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');
const encryptedScript = path.join(serverRoot, 'scripts', 'backup-db-encrypted.mjs');

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exitCode = 1;
}

async function listArchives(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => parseArchiveName(entry.name))
    .filter(Boolean)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1));
}

/** The digest recorded in `<archive>.sha256`, or a stop. */
async function readSidecarDigest(archive) {
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

function runEncryptedBackup({ outDir, recipient }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [encryptedScript, `--out=${outDir}`, `--recipient=${recipient}`],
      { cwd: serverRoot, env: process.env, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Copy an archive and its sidecar into the off-machine directory.
 *
 * WRITE UNDER A TEMPORARY NAME, VERIFY, THEN RENAME. A half-copied `.gpg` under
 * its real name is worse than no copy: it looks like a backup to every later
 * reader, including the retention planner. `rename` is what makes the pair
 * appear complete.
 */
async function copyArchive(archive, destinationDir) {
  const digest = await readSidecarDigest(archive);
  const name = path.basename(archive);
  const destArchive = path.join(destinationDir, name);
  const destSidecar = `${destArchive}.sha256`;

  if (existsSync(destArchive)) {
    const existing = (await sha256File(destArchive)) === digest &&
      existsSync(destSidecar) &&
      (await readSidecarDigest(destArchive)) === digest;
    if (!existing) {
      throw new BackupSafetyError(
        `"${name}" already exists in the off-machine directory with different bytes; nothing was overwritten.`,
      );
    }
    console.log(`[${COMMAND}] copy     : ${name} already present and identical`);
    return { name, digest, copied: false };
  }

  const incomingArchive = `${destArchive}.incoming`;
  const incomingSidecar = `${destSidecar}.incoming`;
  await rm(incomingArchive, { force: true });
  await rm(incomingSidecar, { force: true });

  await copyFile(archive, incomingArchive);
  await copyFile(`${archive}.sha256`, incomingSidecar);

  const copiedDigest = await sha256File(incomingArchive);
  if (copiedDigest !== digest) {
    await rm(incomingArchive, { force: true });
    await rm(incomingSidecar, { force: true });
    throw new BackupSafetyError(
      `copy of "${name}" hashes to ${copiedDigest} but its sidecar records ${digest}; the broken copy was removed.`,
    );
  }

  await rename(incomingArchive, destArchive);
  await rename(incomingSidecar, destSidecar);

  const placedDigest = await sha256File(destArchive);
  if (placedDigest !== digest) {
    throw new BackupSafetyError(
      `"${name}" hashes to ${placedDigest} after being placed in the off-machine directory; expected ${digest}.`,
    );
  }
  console.log(`[${COMMAND}] offsite  : ${destArchive} (${formatBytes((await stat(destArchive)).size)}, sha256 verified)`);
  return { name, digest, copied: true };
}

async function prune(directory, counts, protect) {
  const archives = await listArchives(directory);
  if (archives.length === 0) {
    console.log(`[${COMMAND}] retain   : no archives in ${directory}`);
    return [];
  }
  const plan = planRetention(
    archives.map((entry) => entry.name),
    { ...counts, protect },
  );
  for (const name of plan.remove) {
    await rm(path.join(directory, name), { force: true });
    await rm(path.join(directory, `${name}.sha256`), { force: true });
    console.log(`[${COMMAND}] prune    : removed ${name} (+ sidecar)`);
  }
  console.log(
    `[${COMMAND}] retain   : ${plan.keep.length} archive(s) kept in ${directory} ` +
      `(daily ${plan.buckets.daily.length}/${counts.daily}, weekly ${plan.buckets.weekly.length}/${counts.weekly}, ` +
      `monthly ${plan.buckets.monthly.length}/${counts.monthly})`,
  );
  return plan.remove;
}

// The durable record's identity. A run that is retried by the scheduler is a
// new execution and gets a new id; a repeated write inside one execution
// updates its own row, so the history cannot gain duplicates.
let activeRunId = null;

async function main() {
  const outDir = argValue('--out') || process.env.BACKUP_DIR || '';
  const copyDir = argValue('--copy-to') || process.env.BACKUP_COPY_DIR || '';
  const recipient = argValue('--recipient') || process.env.BACKUP_GPG_RECIPIENT || '';
  const runId = argValue('--run-id') || randomUUID();
  // No default of SCHEDULED: only the wrapper knows why it was started, and it
  // always states it. A bare invocation of this script is UNKNOWN, not a claim.
  const requestedTrigger = (argValue('--trigger') || process.env.BACKUP_TRIGGER || 'UNKNOWN').toUpperCase();
  const trigger = ['SCHEDULED', 'MANUAL', 'CONSOLE'].includes(requestedTrigger)
    ? requestedTrigger
    : 'UNKNOWN';
  const counts = {
    daily: Number(argValue('--daily') || RETENTION_DEFAULTS.daily),
    weekly: Number(argValue('--weekly') || RETENTION_DEFAULTS.weekly),
    monthly: Number(argValue('--monthly') || RETENTION_DEFAULTS.monthly),
  };

  // A previous execution that never finished has no result to write, so this is
  // the first process that can notice it. Best-effort: never affects this run.
  await notifyInterruptedRuns();

  // Opened before validation on purpose: a run that fails on a bad directory is
  // still an execution the console should be able to see.
  activeRunId = runId;
  await openRunRecord({
    runId,
    trigger,
    archiveDir: outDir || null,
    copyDir: copyDir || null,
    host: process.platform,
  });

  if (!outDir) {
    throw new BackupSafetyError('no archive directory. Pass --out=<dir> or set BACKUP_DIR.');
  }
  if (!copyDir) {
    throw new BackupSafetyError(
      'no off-machine directory. Pass --copy-to=<dir> or set BACKUP_COPY_DIR — a backup on one disk is not a backup.',
    );
  }
  if (!recipient) {
    throw new BackupSafetyError('no GPG recipient. Pass --recipient=<fingerprint> or set BACKUP_GPG_RECIPIENT.');
  }

  const target = assertBackupDir(outDir, { repoRoot });
  const copyTarget = assertBackupDir(copyDir, { repoRoot });
  if (target === copyTarget) {
    throw new BackupSafetyError('the archive directory and the off-machine directory are the same path.');
  }
  await mkdir(target, { recursive: true });
  await mkdir(copyTarget, { recursive: true });

  const before = new Set((await listArchives(target)).map((entry) => entry.name));
  console.log(`[${COMMAND}] start    : ${new Date().toISOString()}`);

  const result = await runEncryptedBackup({ outDir: target, recipient });
  if (result.code !== 0) {
    throw new Error(
      `backup:db:encrypted failed with exit ${result.code ?? result.signal}; no copy was attempted.`,
    );
  }

  const created = (await listArchives(target)).find((entry) => !before.has(entry.name));
  if (!created) {
    throw new Error('the encrypted wrapper reported success but no new archive appeared; nothing copied.');
  }
  const archive = path.join(target, created.name);
  const archiveSize = (await stat(archive)).size;
  console.log(
    `[${COMMAND}] created  : ${created.name} (${formatBytes(archiveSize)})`,
  );

  const copy = await copyArchive(archive, copyTarget);
  const digest = copy.digest;

  const pruned = [
    ...(await prune(target, counts, [created.name])),
    ...(await prune(copyTarget, counts, [created.name])),
  ];

  console.log(`[${COMMAND}] OK — ${created.name} created, copied off-machine and verified.`);
  console.log(`[${COMMAND}] finish   : ${new Date().toISOString()}`);

  activeRunId = null;
  await closeRunRecord({
    runId,
    outcome: 'SUCCESS',
    archive: created.name,
    sha256: digest,
    sizeBytes: archiveSize,
    offsite: copy.copied ? 'copied' : 'present',
    pruned,
    detail: null,
  });
}

main().catch(async (error) => {
  const message = error instanceof BackupSafetyError
    ? error.message
    : (error && error.message ? error.message : String(error));
  fail(message);
  if (activeRunId) {
    const runId = activeRunId;
    activeRunId = null;
    await closeRunRecord({ runId, outcome: 'FAILED', detail: message });
    // After the record is durable, and never able to change the exit status.
    await notifyRunFailure(runId);
  }
}).finally(async () => {
  await closeRunStore();
});
