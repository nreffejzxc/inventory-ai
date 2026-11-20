// Durable movement receipts must be recoverable after the process and the
// transport claim are gone, but only from exact evidence. This suite pins the
// safe proof hierarchy, the dry-run default and the retention boundary.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startServer, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import {
  recoverStaleMovementReceipts,
  runMovementReceiptMaintenance,
  MOVEMENT_RECEIPT_RETENTION_MS,
} from '../src/services/stockMovementReceiptRecovery.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const tracker = createTracker(dbOk);

async function api(method, path, { token, body, idempotencyKey } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let seq = 0;
function key(label) {
  seq += 1;
  return `maintenance-${label}-${process.pid}-${Date.now()}-${seq}`;
}

async function product(business) {
  seq += 1;
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { currency: 'PHP', name: `Receipt Recovery ${process.pid}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function location(business) {
  seq += 1;
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: `Recovery Location ${process.pid}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function stockIn(business, productId, locationId, quantity) {
  const requestKey = key('in');
  const res = await api('POST', '/api/inventory/stock-in', {
    token: business.token,
    body: { productId, locationId, quantity },
    idempotencyKey: requestKey,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const receipt = await mongoose.connection.db
    .collection('stock_movement_operations')
    .findOne({ requestKey });
  assert.ok(receipt);
  return { requestKey, receipt, transactionId: res.json.transaction.id };
}

async function ageReceipt(receiptId, fields, unset = []) {
  const update = { $set: { ...fields, updatedAt: new Date(Date.now() - 10 * 60_000) } };
  if (unset.length) update.$unset = Object.fromEntries(unset.map((field) => [field, '']));
  await mongoose.connection.db.collection('stock_movement_operations').updateOne(
    { _id: receiptId },
    update,
  );
}

async function auditCount(business, receiptId) {
  return mongoose.connection.db.collection('audit_logs').countDocuments({
    businessId: new mongoose.Types.ObjectId(business.businessId),
    entityId: String(receiptId),
    action: { $in: ['MOVEMENT_RECEIPT_RECOVERED', 'MOVEMENT_RECEIPT_PRUNED'] },
  });
}

dbSuite('Movement receipt recovery — exact proof, dry run and retention', dbOk, () => {
  let business;
  let locationId;

  before(async () => {
    business = await registerOwner(api, tracker);
    locationId = await location(business);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ dry run writes nothing, then a ledger-proven receipt is completed and audited', async () => {
    const productId = await product(business);
    const { requestKey, receipt } = await stockIn(business, productId, locationId, 5);
    await ageReceipt(receipt._id, {
      state: 'IN_PROGRESS',
    }, ['response', 'inventoryTransactionId']);

    const dry = await runMovementReceiptMaintenance({ dryRun: true, businessId: business.businessId });
    assert.equal(dry.recovered, 1);
    const still = await mongoose.connection.db
      .collection('stock_movement_operations')
      .findOne({ requestKey });
    assert.equal(still.state, 'IN_PROGRESS', 'dry run must not change the receipt');
    assert.equal(await auditCount(business, receipt._id), 0, 'dry run must not audit');

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.recovered, 1);
    const completed = await mongoose.connection.db
      .collection('stock_movement_operations')
      .findOne({ requestKey });
    assert.equal(completed.state, 'COMPLETED');
    assert.ok(completed.inventoryTransactionId);
    assert.equal(await auditCount(business, receipt._id), 1);
  });

  it('★ recovers an INVENTORY_WRITTEN receipt from its exact inventory snapshot', async () => {
    const productId = await product(business);
    const { requestKey, receipt } = await stockIn(business, productId, locationId, 4);
    await mongoose.connection.db.collection('inventory_transactions').deleteMany({
      movementOperationId: receipt._id,
    });
    await ageReceipt(receipt._id, {
      state: 'INVENTORY_WRITTEN',
    }, ['response', 'inventoryTransactionId']);

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.recovered, 1);
    const ledger = await mongoose.connection.db.collection('inventory_transactions').findOne({
      movementOperationId: receipt._id,
    });
    assert.ok(ledger, 'the missing ledger row is rolled forward');
    const completed = await mongoose.connection.db
      .collection('stock_movement_operations')
      .findOne({ requestKey });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(String(completed.inventoryTransactionId), String(ledger._id));
    assert.equal(await auditCount(business, receipt._id), 1);
  });

  it('★ does not let a full batch of old attention rows starve a newer unfinished receipt', async () => {
    // Attention has no age cutoff. Three old attention rows used to consume the
    // whole batch (oldest first) and leave the newer unfinished receipt unseen
    // forever. The batch must reserve its first slots for stale unfinished rows.
    const attentionIds = [];
    for (let index = 0; index < 3; index += 1) {
      const oldProduct = await product(business);
      const old = await stockIn(business, oldProduct, locationId, 1);
      await mongoose.connection.db.collection('inventory_transactions').deleteMany({
        movementOperationId: old.receipt._id,
      });
      await ageReceipt(
        old.receipt._id,
        { state: 'REQUIRES_ATTENTION', failure: 'old attention fixture' },
        ['response', 'inventoryTransactionId'],
      );
      await mongoose.connection.db.collection('stock_movement_operations').updateOne(
        { _id: old.receipt._id },
        { $set: { updatedAt: new Date(Date.now() - 60 * 60_000) } },
      );
      attentionIds.push(old.receipt._id);
    }

    const freshProduct = await product(business);
    const fresh = await stockIn(business, freshProduct, locationId, 2);
    await ageReceipt(fresh.receipt._id, { state: 'IN_PROGRESS' }, ['response', 'inventoryTransactionId']);

    const summary = await recoverStaleMovementReceipts({
      businessId: business.businessId,
      limit: 2,
    });

    assert.equal(summary.scanned, 2);
    assert.equal(summary.completed, 1, 'the newer unfinished receipt must be in the batch');
    assert.equal(summary.blocked, 1, 'the remaining slot still reports old attention');
    assert.equal(
      (
        await mongoose.connection.db
          .collection('stock_movement_operations')
          .findOne({ _id: fresh.receipt._id })
      ).state,
      'COMPLETED',
    );
    for (const id of attentionIds) {
      assert.equal(
        (await mongoose.connection.db.collection('stock_movement_operations').findOne({ _id: id })).state,
        'REQUIRES_ATTENTION',
      );
    }
  });

  it('★ flags an unprovable abandoned receipt without deleting it', async () => {
    const productId = await product(business);
    const { requestKey, receipt } = await stockIn(business, productId, locationId, 3);
    await mongoose.connection.db.collection('inventory_transactions').deleteMany({
      movementOperationId: receipt._id,
    });
    await ageReceipt(receipt._id, {
      state: 'IN_PROGRESS',
    }, ['response', 'inventoryTransactionId']);

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.flagged, 1);
    const attention = await mongoose.connection.db
      .collection('stock_movement_operations')
      .findOne({ requestKey });
    assert.equal(attention.state, 'REQUIRES_ATTENTION');
    assert.match(attention.failure, /could not be proven/);
    assert.equal(await auditCount(business, receipt._id), 0, 'flagging is not a resolution');
  });

  it('resolves attention only with a ledger row, and leaves an ambiguous row blocked', async () => {
    const productId = await product(business);
    const proven = await stockIn(business, productId, locationId, 2);
    await ageReceipt(proven.receipt._id, { state: 'REQUIRES_ATTENTION', failure: 'fixture' });

    const ambiguous = await stockIn(business, await product(business), locationId, 1);
    await mongoose.connection.db.collection('inventory_transactions').deleteMany({
      movementOperationId: ambiguous.receipt._id,
    });
    await ageReceipt(ambiguous.receipt._id, {
      state: 'REQUIRES_ATTENTION',
    }, ['response', 'inventoryTransactionId']);

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.recovered, 1);
    // The previous test deliberately left one attention row; both it and this
    // test's ambiguous row must remain blocked.
    assert.ok(applied.blocked >= 1);
    assert.equal(
      (await mongoose.connection.db.collection('stock_movement_operations').findOne({ _id: proven.receipt._id })).state,
      'COMPLETED',
    );
    assert.equal(await auditCount(business, proven.receipt._id), 1);
    assert.equal(
      (await mongoose.connection.db.collection('stock_movement_operations').findOne({ _id: ambiguous.receipt._id })).state,
      'REQUIRES_ATTENTION',
    );
    assert.equal(await auditCount(business, ambiguous.receipt._id), 0);
  });

  it('never resolves attention from a ledger row whose movement contradicts the receipt', async () => {
    const productId = await product(business);
    const { receipt } = await stockIn(business, productId, locationId, 2);
    await mongoose.connection.db.collection('inventory_transactions').updateOne(
      { movementOperationId: receipt._id },
      { $set: { quantity: 99 } },
    );
    await ageReceipt(receipt._id, { state: 'REQUIRES_ATTENTION' }, ['response', 'inventoryTransactionId']);

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.flagged, 1);
    assert.equal(
      (await mongoose.connection.db.collection('stock_movement_operations').findOne({ _id: receipt._id })).state,
      'REQUIRES_ATTENTION',
    );
    assert.equal(await auditCount(business, receipt._id), 0);
    assert.equal(
      (await mongoose.connection.db.collection('inventory_transactions').findOne({ movementOperationId: receipt._id }))
        .quantity,
      99,
    );
  });

  it('prunes only completed receipts beyond retention, and dry run keeps them', async () => {
    const productId = await product(business);
    const { requestKey, receipt } = await stockIn(business, productId, locationId, 1);
    await mongoose.connection.db.collection('stock_movement_operations').updateOne(
      { _id: receipt._id },
      { $set: { updatedAt: new Date(Date.now() - MOVEMENT_RECEIPT_RETENTION_MS - 60_000) } },
    );

    const dry = await runMovementReceiptMaintenance({ dryRun: true, businessId: business.businessId });
    assert.equal(dry.pruned, 1);
    assert.ok(await mongoose.connection.db.collection('stock_movement_operations').findOne({ requestKey }));

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.pruned, 1);
    assert.equal(
      await mongoose.connection.db.collection('stock_movement_operations').countDocuments({ requestKey }),
      0,
    );
    assert.equal(await auditCount(business, receipt._id), 1);
  });

  it('never prunes a completed receipt whose ledger proof is missing', async () => {
    const productId = await product(business);
    const { receipt } = await stockIn(business, productId, locationId, 1);
    await mongoose.connection.db.collection('inventory_transactions').deleteOne({
      movementOperationId: receipt._id,
    });
    await mongoose.connection.db.collection('stock_movement_operations').updateOne(
      { _id: receipt._id },
      { $set: { updatedAt: new Date(Date.now() - MOVEMENT_RECEIPT_RETENTION_MS - 60_000) } },
    );

    const applied = await runMovementReceiptMaintenance({ dryRun: false, businessId: business.businessId });
    assert.equal(applied.pruned, 0);
    assert.ok(applied.blocked >= 1);
    assert.ok(
      await mongoose.connection.db.collection('stock_movement_operations').findOne({ _id: receipt._id }),
    );
    assert.equal(await auditCount(business, receipt._id), 0);
  });
});