// DB-backed coverage for the read-only attention triage.
//
// The unit suite pins the report shape. This suite seeds the two real evidence
// states a person must review — a REQUIRES_ATTENTION transfer journal and a
// quarantined ledger row — then proves the report names them and that reading it
// changed no document in any collection the command touches.

import 'dotenv/config';

import mongoose from 'mongoose';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import { readAttentionEvidence } from '../scripts/lib/triage-read.mjs';
import { buildAttentionReport, formatAttentionText } from '../scripts/lib/triage-integrity.mjs';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import StockTransferOperation from '../src/models/stockTransferOperation.model.ts';
import { TRANSFER_LEDGER_QUARANTINE_COLLECTION } from '../src/services/transferLedgerMigration.service.ts';

const { ObjectId } = mongoose.Types;
const dbOk = await ensureDb();
const db = mongoose.connection.db;
const businessIds = [];

function uniqueName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedTenant() {
  const businessId = new ObjectId();
  const productId = new ObjectId();
  const fromLocationId = new ObjectId();
  const toLocationId = new ObjectId();
  const userId = new ObjectId();
  businessIds.push(businessId);

  await db.collection('businesses').insertOne({ _id: businessId, name: uniqueName('TriageBiz') });
  await db.collection('products').insertOne({
    _id: productId,
    businessId,
    name: 'Blue widget',
    sku: 'SKU-1',
  });
  await db.collection('locations').insertMany([
    { _id: fromLocationId, businessId, name: 'Warehouse' },
    { _id: toLocationId, businessId, name: 'Store' },
  ]);
  await db.collection('users').insertOne({
    _id: userId,
    businessId,
    name: 'Ada',
    email: `${uniqueName('triage')}@example.com`,
  });

  const operation = await StockTransferOperation.create({
    businessId,
    productId,
    fromLocationId,
    toLocationId,
    quantity: 5,
    reference: 'TR-42',
    state: 'REQUIRES_ATTENTION',
    createdBy: userId,
    sourceRowId: new ObjectId(),
    sourcePreviousQuantity: 10,
    sourceNewQuantity: 5,
    destinationRowId: new ObjectId(),
    destinationPreviousQuantity: 3,
    destinationNewQuantity: 8,
    failure: 'destination row changed after the debit',
    reconciledAt: new Date('2026-11-19T01:00:00.000Z'),
  });

  const ledger = await InventoryTransaction.create({
    businessId,
    productId,
    locationId: fromLocationId,
    type: 'TRANSFER',
    quantity: 5,
    previousQuantity: 10,
    newQuantity: 5,
    reference: 'TR-42',
    transferOperationId: operation._id,
    userId,
  });

  await db.collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION).insertOne({
    businessId,
    transferOperationId: operation._id,
    productId,
    locationId: toLocationId,
    type: 'TRANSFER',
    quantity: 5,
    previousQuantity: 3,
    newQuantity: 8,
    reference: 'TR-42',
    quarantineReason: 'DUPLICATE_TRANSFER_LEDGER_LEG',
    quarantinedAt: new Date('2026-11-19T02:00:00.000Z'),
    keptId: ledger._id,
    createdAt: new Date('2026-11-19T00:00:01.000Z'),
  });

  return { businessId, operation, ledger };
}

async function snapshot(businessId) {
  const collections = [
    'stock_transfer_operations',
    'stock_movement_operations',
    'inventory_transactions',
    TRANSFER_LEDGER_QUARANTINE_COLLECTION,
    'inventory',
    'products',
    'locations',
    'users',
    'businesses',
  ];
  const out = {};
  for (const name of collections) {
    const filter = name === 'businesses' ? { _id: businessId } : { businessId };
    out[name] = await db.collection(name).find(filter).sort({ _id: 1 }).toArray();
  }
  return JSON.parse(JSON.stringify(out));
}

after(async () => {
  if (dbOk) {
    const ids = businessIds.map((id) => new ObjectId(id));
    for (const name of [
      'stock_transfer_operations',
      'stock_movement_operations',
      'inventory_transactions',
      TRANSFER_LEDGER_QUARANTINE_COLLECTION,
      'inventory',
      'products',
      'locations',
      'users',
    ]) {
      await db.collection(name).deleteMany({ businessId: { $in: ids } }).catch(() => undefined);
    }
    await db.collection('businesses').deleteMany({ _id: { $in: ids } }).catch(() => undefined);
  }
  await disconnectDb();
});

dbSuite('triage:integrity — DB-backed attention evidence', dbOk, () => {
  it('★ reports a REQUIRES_ATTENTION transfer and quarantine row and writes nothing', async () => {
    const { businessId, operation, ledger } = await seedTenant();

    // A second tenant must not contribute to this tenant's report.
    const other = await seedTenant();

    const before = await snapshot(businessId);
    const evidence = await readAttentionEvidence({ businessId, limit: 50 });
    const report = buildAttentionReport({
      database: 'inventoryai_test_db',
      businessId: String(businessId),
      limit: 50,
      ...evidence,
    });
    const after = await snapshot(businessId);

    assert.deepEqual(after, before, 'reading attention evidence must not write any collection');

    assert.deepEqual(report.counts, { transfers: 1, movements: 0, quarantine: 1 });
    assert.equal(report.transfers[0].id, String(operation._id));
    assert.equal(report.transfers[0].failureReason, 'destination row changed after the debit');
    assert.equal(report.transfers[0].product.name, 'Blue widget');
    assert.equal(report.transfers[0].product.sku, 'SKU-1');
    assert.equal(report.transfers[0].from.name, 'Warehouse');
    assert.equal(report.transfers[0].to.name, 'Store');
    assert.equal(report.transfers[0].createdBy.name, 'Ada');
    assert.deepEqual(report.transfers[0].snapshots.source, {
      rowId: String(operation.sourceRowId),
      previousQuantity: 10,
      newQuantity: 5,
    });
    assert.deepEqual(report.transfers[0].snapshots.destination, {
      rowId: String(operation.destinationRowId),
      previousQuantity: 3,
      newQuantity: 8,
    });
    assert.equal(report.transfers[0].ledgerRows.length, 1);
    assert.equal(report.transfers[0].ledgerRows[0].id, String(ledger._id));
    assert.equal(report.transfers[0].ledgerRows[0].location.name, 'Warehouse');

    assert.equal(report.quarantine[0].reason, 'DUPLICATE_TRANSFER_LEDGER_LEG');
    assert.equal(report.quarantine[0].keptId, String(ledger._id));
    assert.equal(report.quarantine[0].transferOperationId, String(operation._id));
    assert.equal(report.quarantine[0].product.sku, 'SKU-1');
    assert.equal(report.quarantine[0].location.name, 'Store');

    const text = formatAttentionText(report);
    assert.match(text, /destination row changed after the debit/);
    assert.match(text, /destination snapshot: row \S+ 3 → 8/);
    assert.match(text, /DUPLICATE_TRANSFER_LEDGER_LEG/);
    assert.match(text, /kept: \S+/);
    assert.match(text, /Nothing was repaired or modified/);

    // The second tenant is real evidence, not a fixture the report may absorb.
    const otherReport = buildAttentionReport({
      database: 'inventoryai_test_db',
      businessId: String(other.businessId),
      ...(await readAttentionEvidence({ businessId: other.businessId, limit: 50 })),
    });
    assert.equal(otherReport.counts.transfers, 1);
    assert.equal(otherReport.counts.quarantine, 1);
    assert.notEqual(otherReport.transfers[0].id, report.transfers[0].id);
  });
});
