// Encrypted backup security — DB-independent unit coverage.
//
// The DB-backed wrapper suite proves the end-to-end archive flow. This file
// covers the parts that must be provable without MongoDB:
//
//   * a protected key can be generated with a passphrase supplied over stdin;
//   * gpg-agent can be given that passphrase over stdin (no argv/file interface);
//   * clearing the agent cache really removes the cached secret;
//   * hostile archive member names and types are refused before extraction;
//   * the wrapper requires only the two programs it runs; the GnuPG agent tools are
//     checked when a caller asks for them, with actionable errors.
//
// Every GPG command uses a temporary GNUPGHOME. The test never reads, uses or
// modifies the operator's real keyring, and the generated passphrase is never
// written to disk or passed in argv.
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateArchiveListing } from '../scripts/backup/archive.mjs';
import { AGENT_TOOLS, assertTools } from '../scripts/backup/tools.mjs';
import {
  allowPresetPassphrase,
  clearAgentCache,
  createProtectedTestKey,
  must,
  presetPassphrase,
  runGpg,
  startAgent,
} from './gpgTestSupport.mjs';
import { unitSuite } from './testEnv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const wrapperScript = path.join(serverRoot, 'scripts', 'backup-db-encrypted.mjs');
const samplePlaintext = 'inventory-ai encrypted backup unit test\n';

function decryptWithAgent(home, cipher, output) {
  return runGpg(
    'gpg',
    [
      '--batch',
      '--pinentry-mode',
      'error',
      '--yes',
      '--decrypt',
      '--output',
      output,
      cipher,
    ],
    { home },
  );
}

unitSuite('encrypted backup — GPG key and agent (no database)', () => {
  let home = '';
  let fingerprint = '';
  let keygrip = '';
  let passphrase = '';
  let plainFile = '';
  let cipher = '';

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ia-bk-unit-'));
    passphrase = randomBytes(24).toString('base64url');

    ({ fingerprint, keygrip } = await createProtectedTestKey({ home, passphrase }));
    assert.match(fingerprint, /^[0-9A-F]{40}$/, 'the generated key has a full fingerprint');
    assert.match(keygrip, /^[0-9A-F]{40}$/, 'the generated key has a keygrip');

    plainFile = path.join(home, 'plain.txt');
    await writeFile(plainFile, samplePlaintext);
    cipher = path.join(home, 'plain.gpg');
    must(
      runGpg(
        'gpg',
        [
          '--batch',
          '--yes',
          '--trust-model',
          'always',
          '--encrypt',
          '--recipient',
          fingerprint,
          '--output',
          cipher,
          plainFile,
        ],
        { home },
      ),
      'test-only encryption',
    );

    // Key generation may leave a cached passphrase. Start every case from a
    // known empty cache; the protected-key negative control in particular would
    // be meaningless otherwise.
    clearAgentCache(home);
  });

  after(async () => {
    try {
      clearAgentCache(home);
    } catch {
      // The agent may already be gone; cleanup is best-effort.
    }
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('generates a protected key from a stdin passphrase, which cannot decrypt on its own', async () => {
    const secretKeys = must(
      runGpg('gpg', ['--batch', '--list-secret-keys', fingerprint], { home }),
      'protected key lookup',
    ).stdout;
    assert.match(secretKeys, /^sec\s/m, 'the private key exists in the temporary keyring');
    assert.match(secretKeys, new RegExp(fingerprint), 'the requested fingerprint is present');

    // The negative control for every cache case below: with an empty agent cache a
    // protected key refuses, so a later successful decrypt can only be the preset.
    clearAgentCache(home);
    const output = path.join(home, 'must-not-exist-1.txt');
    const result = decryptWithAgent(home, cipher, output);
    assert.notEqual(result.code, 0, 'a protected key must not decrypt without a cached passphrase');
    assert.ok(!(await readFile(output).catch(() => null)), 'no plaintext was left behind');
  });

  it('presets the passphrase over stdin, decrypts, and revokes it when the cache clears', async () => {
    await allowPresetPassphrase(home);
    clearAgentCache(home);
    startAgent(home);

    const preset = presetPassphrase({ home, keygrip, passphrase });
    assert.match(preset.stdout, /OK/, 'gpg-connect-agent accepted the preset command');

    const output = path.join(home, 'preset-output.txt');
    const unlocked = decryptWithAgent(home, cipher, output);
    assert.equal(
      unlocked.code,
      0,
      `the preset passphrase should unlock the cached key: ${unlocked.stderr.trim().slice(0, 600)}`,
    );
    assert.equal(await readFile(output, 'utf8'), samplePlaintext, 'the decrypted bytes are the sample');

    // Clearing the agent must take the secret away again, not merely advance a counter.
    clearAgentCache(home);
    const deniedOutput = path.join(home, 'cache-cleared.txt');
    const denied = decryptWithAgent(home, cipher, deniedOutput);
    assert.notEqual(denied.code, 0, 'clearing the agent cache must remove the cached passphrase');
    assert.ok(!(await readFile(deniedOutput).catch(() => null)), 'the cleared cache left no plaintext');
  });
});

function tarLine(type, name) {
  return `${type}rw-r--r-- 0/0 1 2026-01-01 00:00 ${name}`;
}

unitSuite('encrypted backup — hostile archive members (no database)', () => {
  it('accepts regular files and directories under one top-level directory', () => {
    const details = [tarLine('-', 'root/manifest.json'), tarLine('d', 'root/')].join('\n');
    assert.equal(validateArchiveListing(details, 'root/\nroot/manifest.json\n'), 'root');
  });

  it('refuses backslash traversal and every backslash-separated member name', () => {
    for (const entry of ['root\\..\\outside', 'root\\file', '..\\outside']) {
      assert.throws(
        () => validateArchiveListing(tarLine('-', 'root/file'), entry),
        /unsafe path/,
        `expected backslash member ${JSON.stringify(entry)} to be refused`,
      );
    }
  });

  it('refuses POSIX and Windows absolute paths', () => {
    for (const entry of ['/root/file', 'C:/root/file', 'C:\\root\\file']) {
      assert.throws(
        () => validateArchiveListing(tarLine('-', 'root/file'), entry),
        /unsafe path/,
        `expected absolute member ${JSON.stringify(entry)} to be refused`,
      );
    }
  });

  it('refuses parent traversal, NUL bytes and multiple roots', () => {
    const cases = [
      ['root/../../outside', /unsafe path/],
      ['../outside', /unsafe path/],
      ['root/\0file', /unsafe path/],
      ['root/file\nother/file', /exactly one safe top-level directory/],
    ];
    for (const [entry, pattern] of cases) {
      assert.throws(() => validateArchiveListing(tarLine('-', 'root/file'), entry), pattern);
    }
  });

  it('refuses symlinks, hard links and every special-file type', () => {
    for (const type of ['l', 'h', 'c', 'b', 'p', 's']) {
      assert.throws(
        () => validateArchiveListing(tarLine(type, 'root/member'), 'root/member'),
        /link or special file/,
        `expected tar member type ${type} to be refused`,
      );
    }
  });

  it('refuses an empty archive', () => {
    assert.throws(() => validateArchiveListing('', ''), /archive is empty/);
  });

  it('the wrapper delegates member validation to this validator', async () => {
    const source = await readFile(wrapperScript, 'utf8');
    assert.match(source, /from '\.\/backup\/archive\.mjs'/);
    assert.match(source, /validateArchiveListing\(details, entries\)/);
  });
});

unitSuite('encrypted backup — external tool prerequisites (no database)', () => {
  it('requires only the programs the wrapper runs, in order, and stops at the first missing one', async () => {
    const calls = [];
    await assertTools(async (command) => {
      calls.push(command);
    });
    assert.deepEqual(calls, ['gpg', 'tar'], 'gpgconf and gpg-connect-agent are not wrapper prerequisites');

    for (const command of ['gpg', 'tar']) {
      let laterToolRan = false;
      await assert.rejects(
        assertTools(async (candidate) => {
          if (candidate === command) throw new Error('not found');
          laterToolRan = true;
        }),
        (error) => {
          assert.equal(error.name, 'BackupSafetyError');
          assert.match(error.message, new RegExp(`Missing prerequisite: ${command}`));
          assert.match(error.message, /PATH/);
          return true;
        },
      );
      assert.equal(laterToolRan, command === 'gpg' ? false : true);
    }
  });

  it('checks the GnuPG agent tools when the caller asks for them, with their own hints', async () => {
    const calls = [];
    await assertTools(async (command) => {
      calls.push(command);
    }, AGENT_TOOLS);
    assert.deepEqual(calls, ['gpgconf', 'gpg-connect-agent']);

    await assert.rejects(
      assertTools(async (command) => {
        if (command === 'gpgconf') throw new Error('spawn gpgconf ENOENT');
      }, AGENT_TOOLS),
      (error) => {
        assert.match(error.message, /Missing prerequisite: gpgconf/);
        assert.match(error.message, /GnuPG 2\.x/);
        assert.match(error.message, /gpgconf --version/);
        return true;
      },
    );

    await assert.rejects(
      assertTools(async (command) => {
        if (command === 'gpg-connect-agent') throw new Error('spawn gpg-connect-agent ENOENT');
      }, AGENT_TOOLS),
      (error) => {
        assert.match(error.message, /Missing prerequisite: gpg-connect-agent/);
        assert.match(error.message, /presets a passphrase through stdin/);
        return true;
      },
    );
  });
});
