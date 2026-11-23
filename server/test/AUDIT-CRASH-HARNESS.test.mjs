// Child-process crash injection for the four audit producer boundaries.
//
// The harness is a real process kill, not a simulated deletion: a child writes
// the durable state and exits 86 before the normal hand-off, then the parent
// runs the real repair/flush functions and verifies one AuditLog row.

import 'dotenv/config';

import { after, it } from 'node:test';
import assert from 'node:assert/strict';

import { DATABASE_NAMES } from '../src/config/env.ts';
import { disconnectDb, ensureDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import { runAuditCrashHarness } from '../scripts/audit-crash-harness.mjs';

const dbOk = await ensureDb();

after(async () => {
  await disconnectDb();
});

dbSuite('AUDIT CRASH — child-process boundaries', dbOk, () => {
  it('★ leaves exactly one audit after each of the four process deaths', async () => {
    const results = await runAuditCrashHarness({ database: DATABASE_NAMES.test });

    assert.equal(results.length, 4);
    assert.deepEqual(
      results.map((result) => result.case),
      ['import-commit', 'movement-enqueued', 'po-receipt', 'audit-in-flight'],
    );
    for (const result of results) {
      assert.equal(result.childExitCode, 86, `${result.case} must die abruptly`);
      assert.equal(result.audits, 1, `${result.case} must leave one audit`);
    }
  });
});
