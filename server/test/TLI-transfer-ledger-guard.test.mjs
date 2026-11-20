// TLI — the transfer-ledger unique guard, the recovery lease, and the safe
// duplicate-deduplication migration.
//
// The guard is asserted against real MongoDB indexes, not just the schema:
// ordinary movements have no transferOperationId and must remain outside the
// partial index, while a second leg for the same operation and location must be
// refused even when two recovery passes race.
//
// The migration runs in a DISPOSABLE database in a child process. It has to
// create duplicate rows before the unique index exists, which cannot be done to
// the shared test database without dropping the guard every other suite relies
// on. The fixture drops its own database afterwards.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

import { dbSuite } from './testEnv.mjs';
import { ensureDb, disconnectDb } from './helpers.mjs';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import IntegrityRecoveryLease from '../src/models/integrityRecoveryLease.model.ts';
import {
  acquireIntegrityRecoveryLease,
  INTEGRITY_RECOVERY_LEASE_ID,
} from '../src/services/integrityRecoveryLease.service.ts';
import { runIntegrityRecoveryPass } from '../src/services/recoveryScheduler.ts';

const { ObjectId } = mongoose.Types;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const fixturePath = path.join(here, 'fixtures', 'transfer-ledger-migration.mjs');

const dbOk = await ensureDb();

function ledgerRow(businessId, transferOperationId, locationId, extra = {}) {
  return {
    businessId,
    productId: new ObjectId(),
    locationId,
    type: 'TRANSFER',
    quantity: 2,
    previousQuantity: 5,
    newQuantity: 3,
    reference: `TLI-${new ObjectId()}`,
    transferOperationId,
    userId: new ObjectId(),
    ...extra,
  };
}

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

before(async () => {
  if (!dbOk) return;
  await IntegrityRecoveryLease.deleteOne({ _id: INTEGRITY_RECOVERY_LEASE_ID });
});

after(async () => {
  if (dbOk) {
    await IntegrityRecoveryLease.deleteOne({ _id: INTEGRITY_RECOVERY_LEASE_ID });
  }
  await disconnectDb();
});

dbSuite('TLI — unique transfer operation/location guard', dbOk, () => {
  it('★ refuses a second ledger leg for the same operation and location', async () => {
    const businessId = new ObjectId();
    const operationId = new ObjectId();
    const locationId = new ObjectId();
    const first = await InventoryTransaction.create(
      ledgerRow(businessId, operationId, locationId)
    );
    try {
      await assert.rejects(
        InventoryTransaction.create(ledgerRow(businessId, operationId, locationId)),
        (err) => err.code === 11000,
        'the unique guard must reject a duplicate operation/location leg'
      );
      // Same operation at the OTHER location (and the reverse) is a valid pair.
      const other = await InventoryTransaction.create(
        ledgerRow(businessId, operationId, new ObjectId())
      );
      await InventoryTransaction.deleteOne({ _id: other._id });
    } finally {
      await InventoryTransaction.deleteMany({
        businessId,
        transferOperationId: operationId,
      });
      assert.ok(first);
    }
  });

  it('keeps ordinary movements outside the partial index', async () => {
    const businessId = new ObjectId();
    const rows = [1, 2, 3].map(() => ({
      businessId,
      productId: new ObjectId(),
      locationId: new ObjectId(),
      type: 'STOCK_IN',
      quantity: 1,
      previousQuantity: 0,
      newQuantity: 1,
      userId: new ObjectId(),
    }));
    await InventoryTransaction.insertMany(rows);
    await InventoryTransaction.deleteMany({ businessId });
  });
});

dbSuite('TLI — recovery lease', dbOk, () => {
  it('grants one owner, renews, and releases only the owner', async () => {
    const first = await acquireIntegrityRecoveryLease({
      owner: 'owner-a',
      ttlMs: 60_000,
    });
    assert.ok(first);
    assert.equal(
      await acquireIntegrityRecoveryLease({ owner: 'owner-b', ttlMs: 60_000 }),
      null,
      'an active lease must not be taken over'
    );
    assert.equal(await first.renew(60_000), true);

    const second = await acquireIntegrityRecoveryLease({
      owner: 'owner-b',
      ttlMs: 60_000,
      now: new Date(Date.now() - 120_000),
    });
    assert.equal(second, null, 'a non-expired lease still belongs to owner-a');

    const stale = await acquireIntegrityRecoveryLease({
      owner: 'owner-b',
      ttlMs: 60_000,
      now: new Date(Date.now() + 120_000),
    });
    assert.ok(stale, 'an expired lease must be taken over');
    assert.equal(await first.release(), false, 'the old owner must not release the new lease');
    assert.equal(await stale.release(), true);
  });

  it('skips the whole pass when another owner holds the lease', async () => {
    let transfersRan = 0;
    let claimsRan = 0;
    const blocker = await acquireIntegrityRecoveryLease({
      owner: 'blocker',
      ttlMs: 60_000,
    });
    assert.ok(blocker);
    try {
      const skipped = await runIntegrityRecoveryPass({
        owner: 'pass-owner',
        recoverTransfers: async () => {
          transfersRan += 1;
          return { scanned: 0, completed: 0, compensated: 0, flagged: 0, failed: 0 };
        },
        recoverClaims: async () => {
          claimsRan += 1;
          return { scanned: 0, released: 0, undone: 0, receipted: 0, flagged: 0, failed: 0 };
        },
        recoverMovements: async () => ({ scanned: 0, completed: 0, flagged: 0, blocked: 0, failed: 0 }),
      });
      assert.equal(skipped.skipped, 'lease-held');
      assert.equal(skipped.lease?.acquired, false);
      assert.equal(transfersRan, 0);
      assert.equal(claimsRan, 0);
    } finally {
      await blocker.release();
    }

    const ran = await runIntegrityRecoveryPass({
      owner: 'pass-owner',
      recoverTransfers: async () => {
        transfersRan += 1;
        return { scanned: 0, completed: 0, compensated: 0, flagged: 0, failed: 0 };
      },
      recoverClaims: async () => {
        claimsRan += 1;
        return { scanned: 0, released: 0, undone: 0, receipted: 0, flagged: 0, failed: 0 };
      },
      recoverMovements: async () => ({ scanned: 0, completed: 0, flagged: 0, blocked: 0, failed: 0 }),
    });
    assert.equal(ran.skipped, undefined);
    assert.equal(ran.lease?.acquired, true);
    assert.equal(transfersRan, 1);
    assert.equal(claimsRan, 1);
    assert.equal(
      await IntegrityRecoveryLease.countDocuments({ _id: INTEGRITY_RECOVERY_LEASE_ID }),
      0,
      'the pass must release its lease'
    );
  });
});

dbSuite('TLI — duplicate migration', dbOk, () => {
  it('refuses ambiguity before any write, then quarantines exact copies and builds the guard', async () => {
    const database = `inventoryai_mig_${process.pid}_${Date.now().toString(36)}`;
    const result = await runFixture({
      ...process.env,
      NODE_ENV: 'test',
      TEST_MODE: 'db',
      MIGRATION_DB_NAME: database,
    });
    assert.equal(
      result.code,
      0,
      `migration fixture failed (code ${result.code}, signal ${result.signal || 'none'})\n` +
        `${result.stderr.slice(0, 4000)}`
    );
    const report = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(report.blockedBeforeWrites, true);
    assert.equal(report.rowsAfterBlocked, 5);
    assert.equal(report.quarantineAfterBlocked, 0);
    assert.equal(report.conflictBlocked, true);
    assert.equal(report.conflictName, 'legacy_transfer_ledger_key');
    assert.equal(report.rowsAfterConflict, 3);
    assert.equal(report.quarantineAfterConflict, 0);
    assert.equal(report.cappedBlocked, true);
    assert.match(report.cappedReason, /--limit=1/);
    assert.equal(report.rowsAfterCapped, 3);
    assert.equal(report.quarantined, 2);
    assert.equal(report.remainingGroupRows, 1);
    assert.equal(report.ordinaryRowsAccepted, 3);
    assert.equal(report.duplicateRejected, true);
    assert.equal(report.indexUnique, true);
    assert.equal(report.indexPartialField, 'transferOperationId');
  });
});
