// `npm run backup:db:encrypted` — encrypt an existing `backup:db` copy with GPG.
//
// WHY THIS IS A WRAPPER. `backup:db` already writes one gzipped Extended-JSON
// file per collection plus a manifest carrying each file's SHA-256, and
// `restore:db` refuses to drop anything until every file matches that manifest.
// Encryption must not replace those guarantees, so this command:
//
//   1. runs the existing `backup:db` into a temporary directory outside the repo;
//   2. verifies every plaintext file against the manifest before encrypting;
//   3. creates a tar.gz and encrypts it to a GPG recipient;
//   4. writes a sidecar SHA-256 for the encrypted archive;
//   5. optionally decrypts the archive into another temporary directory, verifies
//      the extracted manifest and every file again, and runs the existing
//      `restore:db --dry-run`. This optional step needs the private key; a plain
//      create needs only the public key.
//
// WHAT IT DOES NOT DO. It does not restore, drop, write to a database, upload,
// delete an old backup, or print a connection string, passphrase, or private
// key. The only database connection is the read-only one already made by
// `backup:db`; the optional dry-run is the read-only verification path in
// `restore:db`. A production URI is not rejected by this wrapper because
// `backup:db` is deliberately read-only, but the runbook requires a disposable
// target for the dry-run and forbids using this wrapper against production
// during an unapproved drill.
//
// PREREQUISITES: Node (the repository's runtime), `gpg`, `gpgconf`,
// `gpg-connect-agent`, and `tar`. The output directory must be outside the
// repository, exactly as for `backup:db`. The GPG public key must already be
// imported; only its fingerprint/key id is read.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateArchiveListing } from './backup/archive.mjs';
import {
  BackupSafetyError,
  assertBackupDir,
  readManifest,
  sha256File,
  verifyBackup,
} from './backup/lib.mjs';
import { assertTools } from './backup/tools.mjs';

const COMMAND = 'backup:db:encrypted';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');
const backupScript = path.join(serverRoot, 'scripts', 'backup-db.mjs');
const restoreScript = path.join(serverRoot, 'scripts', 'restore-db.mjs');

function usage() {
  console.log(`Usage:
  ${COMMAND} --out=<external-dir> --recipient=<gpg-key> [--dry-run-restore]
  ${COMMAND} --verify=<archive.tar.gz.gpg> [--dry-run-restore]

Create:
  --out=<dir>              Directory outside the repository for the encrypted archive.
                           BACKUP_DIR is used when the flag is omitted.
  --recipient=<fingerprint> Full 40-character GPG fingerprint. BACKUP_GPG_RECIPIENT
                           is used when the flag is omitted.
  --dry-run-restore        After decrypting and verifying the archive, run the existing
                           restore:db --dry-run against the disposable database named by
                           the current environment. Nothing is written.

Verify:
  --verify=<archive>       Verify the archive's .sha256 sidecar, decrypt it into a
                           temporary directory, and verify every manifest hash.
  --dry-run-restore        Also run restore:db --dry-run on the verified extraction.

Safety:
  The archive is written outside the repository. Plaintext staging is removed on
  success and failure. No database is written by this command.`);
}

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exitCode = 1;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `tar` and `gpg` in this repo's Windows development environment are MSYS
 * programs. A `C:\\...` argument is interpreted by tar as a remote `host:path`
 * and fails. Node's own filesystem calls still use the Windows form, so only
 * arguments handed to those two tools are translated.
 */
function toolPath(value) {
  if (process.platform !== 'win32') return value;
  return path
    .resolve(value)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function wait(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function runInherited(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const result = await wait(child);
  if (result.code !== 0) {
    throw new Error(
      `${path.basename(command)} ${args[0] ?? ''} failed with exit ${result.code ?? result.signal}`,
    );
  }
  return result;
}

async function runQuiet(command, args) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectQuiet(child, command, args);
}

/**
 * Decrypt with gpg's own pinentry/agent. A protected private key must be
 * unlocked by gpg-agent, not by a passphrase argument or a passphrase file
 * this wrapper reads. stdin is inherited so pinentry can prompt; stdout and
 * stderr remain captured so the temporary path never becomes noise.
 */
async function runGpgDecrypt(args) {
  const child = spawn('gpg', args, {
    cwd: serverRoot,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return collectQuiet(child, 'gpg', args);
}

async function collectQuiet(child, command, args) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });
  const result = await wait(child);
  if (result.code !== 0) {
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} failed with exit ${result.code ?? result.signal}` +
        `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
    );
  }
  return { stdout, stderr };
}

async function checkTools() {
  await assertTools(runQuiet);
}

async function assertRecipient(recipient) {
  const normalized = recipient.replace(/\s+/g, '').toLowerCase();
  if (!normalized) {
    throw new BackupSafetyError(
      'Refusing to encrypt: no GPG recipient. Pass --recipient=<full-fingerprint> or set BACKUP_GPG_RECIPIENT.',
    );
  }
  // A short id or an email can be ambiguous. A backup recipient must be the
  // complete 40-hex fingerprint the operator verified out of band.
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new BackupSafetyError(
      'Refusing to encrypt: the recipient must be a full 40-character GPG fingerprint.',
    );
  }
  try {
    await runQuiet('gpg', ['--batch', '--list-keys', '--with-colons', normalized]);
  } catch {
    throw new BackupSafetyError(
      `Refusing to encrypt: the GPG fingerprint "${normalized}" is not present in this keyring. ` +
        'Import the public key first.',
    );
  }
  return normalized;
}

function archiveChecksumPath(archive) {
  return `${archive}.sha256`;
}

async function writeArchiveChecksum(archive) {
  const digest = await sha256File(archive);
  const sidecar = archiveChecksumPath(archive);
  await writeFile(sidecar, `${digest}  ${path.basename(archive)}\n`, { flag: 'wx' });
  return digest;
}

async function readArchiveChecksum(archive) {
  const sidecar = archiveChecksumPath(archive);
  let raw;
  try {
    raw = await readFile(sidecar, 'utf8');
  } catch {
    throw new BackupSafetyError(
      `Refusing to verify: the checksum sidecar "${path.basename(sidecar)}" is missing. ` +
        'Without it, the archive bytes cannot be proved.',
    );
  }
  const expected = raw.trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
    throw new BackupSafetyError(
      `Refusing to verify: "${path.basename(sidecar)}" does not contain a SHA-256 digest.`,
    );
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    throw new BackupSafetyError(
      `Archive checksum mismatch: expected ${expected}, found ${actual}. The archive was not opened.`,
    );
  }
  return { expected, sidecar };
}

/**
 * List first, then extract. A verify-only archive is an external input; a
 * member that is absolute or climbs out of the extraction directory must be
 * refused before tar writes anything.
 * The pure validation lives in `backup/archive.mjs` so its hostile-member
 * rules are unit-testable.
 */
async function listArchive(archive) {
  const { stdout: details } = await runQuiet('tar', ['-tvzf', toolPath(archive)]);
  const { stdout: entries } = await runQuiet('tar', ['-tzf', toolPath(archive)]);
  return validateArchiveListing(details, entries);
}

async function decryptAndVerify(archive, workParent) {
  await readArchiveChecksum(archive);

  const decryptedTar = path.join(workParent, 'decrypted.tar.gz');
  await runGpgDecrypt([
    '--yes',
    '--decrypt',
    '--output',
    toolPath(decryptedTar),
    toolPath(archive),
  ]);

  const root = await listArchive(decryptedTar);
  const extractDir = path.join(workParent, 'extracted');
  await mkdir(extractDir, { recursive: true });
  await runQuiet('tar', ['-xzf', toolPath(decryptedTar), '-C', toolPath(extractDir)]);
  await rm(decryptedTar, { force: true });

  const backupDir = path.join(extractDir, root);
  const manifest = await readManifest(backupDir);
  const verified = await verifyBackup(backupDir, manifest);
  return { backupDir, manifest, verified };
}

async function createEncryptedBackup({ outDir, recipient, dryRunRestore }) {
  const target = assertBackupDir(outDir, { repoRoot });
  await checkTools();
  await mkdir(target, { recursive: true });
  recipient = await assertRecipient(recipient);

  const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'inventory-ai-encrypted-'));
  let archive = '';
  let completed = false;

  try {
    console.log(`[${COMMAND}] backup   : running existing backup:db`);
    await runInherited(process.execPath, [backupScript], {
      BACKUP_DIR: stagingParent,
      CONFIRM: 'backup-db',
    });

    const entries = await readdir(stagingParent, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (directories.length !== 1) {
      throw new Error(
        `expected exactly one backup directory in staging, found ${directories.length}; nothing was encrypted`,
      );
    }
    const backupDir = path.join(stagingParent, directories[0].name);
    const manifest = await readManifest(backupDir);
    const verified = await verifyBackup(backupDir, manifest);
    console.log(
      `[${COMMAND}] manifest : ${manifest.database}, ${manifest.totals.collections} collection(s), ` +
        `${manifest.totals.documents} document(s), ${formatBytes(manifest.totals.uncompressedBytes)} to restore`,
    );
    console.log(`[${COMMAND}] checksums: ${verified.length} file(s) matched the manifest before encryption`);

    archive = path.join(target, `${path.basename(backupDir)}.tar.gz.gpg`);
    const archiveSidecar = archiveChecksumPath(archive);
    if (existsSync(archive) || existsSync(archiveSidecar)) {
      throw new BackupSafetyError(
        `Refusing to encrypt: "${archive}" or its checksum sidecar already exists. Nothing was overwritten.`,
      );
    }

    const tarPath = path.join(stagingParent, `${path.basename(backupDir)}.tar.gz`);
    console.log(`[${COMMAND}] encrypt  : ${recipient}`);
    await runQuiet('tar', [
      '-czf',
      toolPath(tarPath),
      '-C',
      toolPath(stagingParent),
      path.basename(backupDir),
    ]);
    await runQuiet('gpg', [
      '--batch',
      '--yes',
      '--trust-model',
      'always',
      '--encrypt',
      '--recipient',
      recipient,
      '--output',
      toolPath(archive),
      toolPath(tarPath),
    ]);
    await rm(tarPath, { force: true });

    const digest = await writeArchiveChecksum(archive);
    // Re-read the sidecar and recompute the digest before reporting success. This
    // is public-key-only work; the optional content check below is the one that
    // needs the private key.
    await readArchiveChecksum(archive);
    console.log(`[${COMMAND}] archive  : ${archive}`);
    console.log(`[${COMMAND}] sha256   : ${digest}`);

    // The manifest was verified before encryption and the archive checksum now
    // proves the encrypted bytes. Decryption additionally proves the archive can
    // be opened and contains the same files, but it needs the private key; keep
    // that step optional so a backup host can hold only the public key.
    completed = true;
    if (dryRunRestore) {
      const decrypted = await decryptAndVerify(archive, stagingParent);
      console.log(
        `[${COMMAND}] verified : ${decrypted.verified.length} file(s) inside the encrypted archive`,
      );
      await runDryRunRestore(decrypted.backupDir);
    } else {
      console.log(
        `[${COMMAND}] note     : archive checksum verified; run --verify with the private key for a content check.`,
      );
    }

    console.log(`[${COMMAND}] OK — encrypted backup is ready.`);
    return archive;
  } finally {
    await rm(stagingParent, { recursive: true, force: true }).catch(() => {});
    if (!completed && archive) {
      await rm(archive, { force: true }).catch(() => {});
      await rm(archiveChecksumPath(archive), { force: true }).catch(() => {});
    }
  }
}

async function verifyEncryptedBackup({ archive, dryRunRestore }) {
  if (!archive) throw new BackupSafetyError('Refusing to verify: no archive path was given.');
  const resolved = path.resolve(archive);
  if (!existsSync(resolved)) {
    throw new BackupSafetyError(`Refusing to verify: "${resolved}" does not exist.`);
  }
  await checkTools();
  const { expected, sidecar } = await readArchiveChecksum(resolved);
  console.log(`[${COMMAND}] checksum : ${expected}`);
  console.log(`[${COMMAND}] sidecar  : ${sidecar}`);

  const workParent = await mkdtemp(path.join(os.tmpdir(), 'inventory-ai-verify-'));
  try {
    const decrypted = await decryptAndVerify(resolved, workParent);
    console.log(
      `[${COMMAND}] manifest : ${decrypted.manifest.database}, ` +
        `${decrypted.manifest.totals.collections} collection(s), ` +
        `${decrypted.manifest.totals.documents} document(s)`,
    );
    console.log(`[${COMMAND}] verified : ${decrypted.verified.length} file(s) inside the archive`);
    if (dryRunRestore) await runDryRunRestore(decrypted.backupDir);
    console.log(`[${COMMAND}] OK — archive, checksum and manifest all verified.`);
  } finally {
    await rm(workParent, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDryRunRestore(backupDir) {
  console.log(
    `[${COMMAND}] dry-run  : restore:db --dry-run; this writes nothing and requires a disposable target`,
  );
  await runInherited(process.execPath, [restoreScript, `--from=${backupDir}`, '--dry-run'], {
    CONFIRM: 'restore-db',
  });
  console.log(`[${COMMAND}] dry-run  : verified by the existing restore:db command`);
}

async function main() {
  if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) {
    usage();
    return;
  }

  const verifyArg = process.argv.slice(2).find((arg) => arg.startsWith('--verify='));
  const verifyPath = argValue('--verify');
  const dryRunRestore = process.argv.slice(2).includes('--dry-run-restore');
  if (verifyArg !== undefined) {
    if (!verifyPath) {
      throw new BackupSafetyError('Refusing to verify: --verify needs an archive path.');
    }
    await verifyEncryptedBackup({ archive: verifyPath, dryRunRestore });
    return;
  }

  const outDir = argValue('--out') || process.env.BACKUP_DIR || '';
  const recipient = argValue('--recipient') || process.env.BACKUP_GPG_RECIPIENT || '';
  if (!outDir) {
    throw new BackupSafetyError(
      'Refusing to begin: no output directory. Pass --out=<dir> outside the repository or set BACKUP_DIR.',
    );
  }
  if (!recipient) {
    throw new BackupSafetyError(
      'Refusing to begin: no GPG recipient. Pass --recipient=<fingerprint> or set BACKUP_GPG_RECIPIENT.',
    );
  }
  await createEncryptedBackup({ outDir, recipient, dryRunRestore });
}

main().catch((error) => {
  if (error instanceof BackupSafetyError) fail(error.message);
  else fail(error && error.message ? error.message : String(error));
});
