// PLAT-8 — the last-active-SUPERADMIN guard under concurrency.
//
// WHAT IS PINNED: two administrator disable requests that arrive together, and a
// disable racing a delete, cannot both commit when the two targets are the only
// ACTIVE SUPERADMINs. At least one active SUPERADMIN always survives, so the
// platform plane cannot be locked out by simultaneous clicks or retries.
//
// WHY A CHILD PROCESS: `node --test` runs every file in parallel against one
// shared database, and other files' SUPERADMINs would make "the last one"
// unreachable. The fixture therefore connects to a disposable database of its
// own, contains nothing else, and drops it afterwards.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-race-secret-0123456789abcdef0123456789';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-race-mfa-key-0123456789abcdef0123456789';
process.env.PLATFORM_CONSOLE_ORIGIN = 'http://localhost:4100';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4100';

import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbSuite } from './testEnv.mjs';
import { ensureDb, disconnectDb } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const fixturePath = path.join(here, 'fixtures', 'last-superadmin-race.mjs');

const dbOk = await ensureDb();

function runFixture(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixturePath], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

dbSuite('PLAT-8 last active SUPERADMIN guard', dbOk, () => {
  it('refuses one of two concurrent disables and one of a delete/disable pair', async () => {
    const result = await runFixture({
      ...process.env,
      NODE_ENV: 'test',
      TEST_MODE: 'db',
      // MongoDB caps database names at 38 bytes; the base-36 stamp keeps it short.
      RACE_DB_NAME: `inventoryai_race_${process.pid}_${Date.now().toString(36)}`,
    });

    assert.equal(
      result.code,
      0,
      `race fixture failed (code ${result.code}, signal ${result.signal || 'none'})\n` +
        `${result.stderr.slice(0, 4000)}`,
    );

    const report = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(report.disableRounds, 10);
    assert.equal(report.refusedDisables, 10);
    assert.equal(report.activeAfterDisableRaces, 1);
    assert.equal(report.deleteRaceFulfilled, 1);
    assert.equal(report.activeAfterDeleteRace, 1);
  });
});

after(async () => {
  await disconnectDb();
});
