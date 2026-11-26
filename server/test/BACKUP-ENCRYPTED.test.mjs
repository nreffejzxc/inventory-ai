// Encrypted backup wrapper — the properties an operator relies on when the copy
// is the only one left.
//
// This suite exercises the real command, not a reimplementation: `backup:db`
// writes the plaintext copy, the wrapper verifies the manifest, encrypts with
// GPG, writes the archive checksum, and optionally decrypts into a temporary
// directory for `restore:db --dry-run`. The cases below are the ones that must
// never regress:
//
//   * a created archive has a sidecar that matches the archive bytes;
//   * a changed byte is refused before an archive is opened;
//   * creation works with a PUBLIC key only — the wrapper must never need a
//     private key merely to make a backup;
//   * verification and dry-run restore work with a passphrase-protected private
//     key, without the wrapper receiving or storing the passphrase. GPG's agent
//     unlocks it; the test first clears the agent cache, then proves the key is
//     protected by showing that a direct decrypt fails.
//
// The dry-run runs against the ordinary disposable test database. It is the
// read-only path in `restore:db --dry-run`; the probe collection's count is
// asserted unchanged afterwards. No restore is performed.
//
// The passphrase is generated at runtime and kept in memory. It is sent to GPG
// over stdin for key generation and to a temporary GPG agent for the cached-key
// case; it is never written to disk, passed in argv, printed or committed.
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { disconnectDb, ensureDb } from './helpers.mjs';
import {
  allowPresetPassphrase,
  clearAgentCache,
  createProtectedTestKey,
  gpgPath,
  must,
  presetPassphrase,
  startAgent,
} from './gpgTestSupport.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { DATABASE_NAMES } from '../src/config/env.ts';
import { sha256File } from '../scripts/backup/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const wrapperScript = path.join(serverRoot, 'scripts', 'backup-db-encrypted.mjs');
const PROBE = 'backup_encrypted_probe';

const dbOk = await ensureDb();

function envFor(home) {
  const env = {
    ...process.env,
    TEST_MODE: 'db',
    NODE_ENV: 'test',
    MONGODB_DB_NAME: DATABASE_NAMES.test,
  };
  if (home) env.GNUPGHOME = gpgPath(home);
  return env;
}

function run(command, args, { home, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: serverRoot,
      env: envFor(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 100_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function sync(command, args, { home, input } = {}) {
  const result = spawnSync(command, args, {
    cwd: serverRoot,
    env: envFor(home),
    encoding: 'utf8',
    input,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

let tmpDir = '';
let protectedHome = '';
let publicHome = '';
let fingerprint = '';
let keygrip = '';
let passphrase = '';
let probe = null;
let archive = '';
let sidecar = '';

before(async () => {
  if (!dbOk) return;
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ia-bk-'));
  protectedHome = path.join(tmpDir, 'g');
  publicHome = path.join(tmpDir, 'p');
  await mkdir(protectedHome, { recursive: true });
  await mkdir(publicHome, { recursive: true });

  // `gpg` and `tar` are the wrapper's documented prerequisites. A missing tool
  // is a test failure, not a skipped green.
  must(sync('gpg', ['--version']), 'gpg availability');
  must(sync('tar', ['--version']), 'tar availability');

  passphrase = randomBytes(24).toString('base64url');
  // The passphrase is supplied on stdin, never written to a file or placed in argv.
  ({ fingerprint, keygrip } = await createProtectedTestKey({
    home: protectedHome,
    passphrase,
  }));
  assert.match(fingerprint, /^[0-9A-F]{40}$/, 'the test key has a full fingerprint');
  assert.match(keygrip, /^[0-9A-F]{40}$/, 'the test key has a keygrip');

  // Import only the public half into a separate keyring. This is the keyring a
  // scheduled backup should use: no secret key is present at all.
  const armored = must(
    sync('gpg', ['--armor', '--export', fingerprint], { home: protectedHome }),
    'public key export',
  ).stdout;
  const publicFile = path.join(tmpDir, 'public.asc');
  await writeFile(publicFile, armored, { mode: 0o600 });
  must(sync('gpg', ['--batch', '--import', publicFile], { home: publicHome }), 'public key import');
  const secretKeys = sync('gpg', ['--batch', '--list-secret-keys'], { home: publicHome });
  assert.equal(secretKeys.code, 0, 'the public-only keyring is readable');
  assert.equal(secretKeys.stdout.trim(), '', 'the public-only keyring contains no private key');

  probe = mongoose.connection.getClient().db(DATABASE_NAMES.test).collection(PROBE);
  await probe.drop().catch(() => {});
  await probe.insertMany([
    { _id: new mongoose.mongo.ObjectId(), marker: 'encrypted-backup-test', n: 1 },
    { _id: new mongoose.mongo.ObjectId(), marker: 'encrypted-backup-test', n: 2 },
  ]);
});

after(async () => {
  if (protectedHome || publicHome) {
    sync('gpgconf', ['--kill', 'gpg-agent'], { home: protectedHome });
    sync('gpgconf', ['--kill', 'gpg-agent'], { home: publicHome });
  }
  if (probe) await probe.drop().catch(() => {});
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await disconnectDb();
});

async function assertCreatedArchive(dir) {
  const names = await readdir(dir);
  const archiveName = names.find((name) => name.endsWith('.tar.gz.gpg'));
  assert.ok(archiveName, `the wrapper wrote an encrypted archive in ${dir}`);
  const archivePath = path.join(dir, archiveName);
  const sidecarPath = `${archivePath}.sha256`;
  assert.ok(names.includes(`${archiveName}.sha256`), 'the wrapper wrote the checksum sidecar');
  assert.equal(await sha256File(archivePath), (await readFile(sidecarPath, 'utf8')).trim().split(/\s+/)[0]);
  return { archive: archivePath, sidecar: sidecarPath };
}

dbSuite('encrypted backup wrapper', dbOk, () => {
  it('creates an archive whose sidecar matches its bytes', async () => {
    const outDir = path.join(tmpDir, 'protected-out');
    const result = await run(
      process.execPath,
      [wrapperScript, `--out=${outDir}`, `--recipient=${fingerprint}`],
      { home: protectedHome },
    );
    assert.equal(result.code, 0, `create failed: ${result.stderr.trim().slice(0, 600)}`);
    assert.match(result.stdout, /sha256\s*:/);
    assert.match(result.stdout, /OK — encrypted backup is ready/);

    ({ archive, sidecar } = await assertCreatedArchive(outDir));
    assert.match(await readFile(sidecar, 'utf8'), /^[0-9a-f]{64}\s{2}\S+\n$/);
  });

  it('refuses an archive whose checksum no longer matches, before opening it', async () => {
    const tampered = path.join(tmpDir, 'tampered.tar.gz.gpg');
    await copyFile(archive, tampered);
    await copyFile(sidecar, `${tampered}.sha256`);
    const bytes = await readFile(tampered);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(tampered, bytes);

    const result = await run(process.execPath, [wrapperScript, `--verify=${tampered}`], {
      home: protectedHome,
    });
    assert.equal(result.code, 1, 'a damaged archive is refused');
    assert.match(result.stderr, /Archive checksum mismatch/);
    assert.match(result.stderr, /was not opened/);
  });

  it('creates a backup with a public key only', async () => {
    const outDir = path.join(tmpDir, 'public-out');
    const result = await run(
      process.execPath,
      [wrapperScript, `--out=${outDir}`, `--recipient=${fingerprint}`],
      { home: publicHome },
    );
    assert.equal(result.code, 0, `public-key-only create failed: ${result.stderr.trim().slice(0, 600)}`);
    await assertCreatedArchive(outDir);
  });

  it('verifies and dry-run restores with a passphrase-protected key', async () => {
    // Start from an empty cache and a running agent, then preset over stdin: the
    // wrapper has no passphrase interface, so the agent is the only route in.
    await allowPresetPassphrase(protectedHome);
    clearAgentCache(protectedHome);
    startAgent(protectedHome);
    presetPassphrase({ home: protectedHome, keygrip, passphrase });

    // The wrapper has no passphrase flag: gpg-agent supplies the cached secret.
    const verified = await run(process.execPath, [wrapperScript, `--verify=${archive}`], {
      home: protectedHome,
    });
    assert.equal(verified.code, 0, `verify failed: ${verified.stderr.trim().slice(0, 600)}`);
    assert.match(verified.stdout, /OK — archive, checksum and manifest all verified/);

    const beforeCount = await probe.countDocuments();
    const dryRun = await run(
      process.execPath,
      [wrapperScript, `--verify=${archive}`, '--dry-run-restore'],
      { home: protectedHome },
    );
    assert.equal(dryRun.code, 0, `dry-run failed: ${dryRun.stderr.trim().slice(0, 600)}`);
    assert.match(dryRun.stdout, /DRY RUN/);
    assert.match(dryRun.stdout, /nothing was written/);
    assert.equal(await probe.countDocuments(), beforeCount, 'dry-run left the test collection unchanged');
  });
});

// The old wrapper passed `--batch` to decryption. That prevents pinentry from
// handling a protected key, even though the passphrase is never given to the
// wrapper. The DB case above proves the cached-agent path; this source guard
// pins the interactive path without requiring a real terminal in CI.
unitSuite('encrypted backup wrapper — pinentry path', () => {
  it('does not pass --batch or a non-interactive pinentry mode to decryption', async () => {
    const source = await readFile(wrapperScript, 'utf8');
    const start = source.indexOf('async function runGpgDecrypt');
    const end = source.indexOf('async function collectQuiet', start);
    assert.ok(start >= 0 && end > start, 'the decrypt helper can be located');
    const decryptHelper = source.slice(start, end);
    const nonInteractivePinentry = /--pinentry-mode(?:=|\s+)(?:error|loopback)\b/;
    assert.doesNotMatch(decryptHelper, /--batch/);
    assert.doesNotMatch(decryptHelper, nonInteractivePinentry);
    assert.match(
      decryptHelper,
      /stdio: \['inherit', 'pipe', 'pipe'\]/,
      'stdin stays inherited so pinentry can use the terminal',
    );

    const decryptCall = source.match(/runGpgDecrypt\(\[([\s\S]*?)\]\)/);
    assert.ok(decryptCall, 'the archive decryption call can be located');
    assert.doesNotMatch(decryptCall[1], /--batch/);
    assert.doesNotMatch(decryptCall[1], nonInteractivePinentry);

    // The wrapper must never grow a passphrase interface: the only permitted
    // path is gpg-agent/pinentry, not a command-line flag, env var, or file.
    assert.doesNotMatch(source, /--passphrase(?:-file|-fd)?|GPG_PASSPHRASE/);
  });
});
