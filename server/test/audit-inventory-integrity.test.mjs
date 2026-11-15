// `npm run audit:integrity` — the read-only inventory-integrity audit.
//
// WHAT IS PINNED HERE, in three layers:
//
//   1. the ARGUMENTS — defaults, every accepted value, and each refusal (a bad id,
//      an out-of-range history, an unknown flag, and `--database=`, which would
//      otherwise let a production read look like a harmless flag);
//   2. the DETECTION — the two aggregation pipelines against a real MongoDB seeded
//      with a normal PO receipt, an unreceipted PO stock-in, an orphan movement and
//      controls that must not be reported; plus the summary and report;
//   3. the READ-ONLY CLAIM — a source scan for every write verb, with a planted
//      control so the scan cannot pass by being unable to fail.
//
// Registered MIXED in run-tests.mjs: the pure cases run in every mode, the DB cases
// only when MongoDB is available (and fail loudly when it is required).

import 'dotenv/config';

import mongoose from 'mongoose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Business from '../src/models/business.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import {
  DEFAULT_DAYS,
  PO_RECEIPT_REASON,
  buildOrphanStockInPipeline,
  buildUnreceiptedPoStockInPipeline,
  cutoffForDays,
  formatTextReport,
  parseIntegrityArgs,
  summarizeFindings,
} from '../scripts/lib/inventory-integrity.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditSource = readFileSync(path.join(serverRoot, 'scripts', 'audit-inventory-integrity.mjs'), 'utf8');
const libSource = readFileSync(path.join(serverRoot, 'scripts', 'lib', 'inventory-integrity.mjs'), 'utf8');

describe('audit:integrity — arguments', () => {
  it('defaults to all history, one fixed database and text', () => {
    assert.deepEqual(parseIntegrityArgs([]), {
      help: false,
      withProduction: false,
      businessId: null,
      days: DEFAULT_DAYS,
      format: 'text',
      problems: [],
    });
  });

  it('accepts every documented value', () => {
    const args = parseIntegrityArgs([
      '--with-production',
      '--business=64F0C2A9E1B3D4F5A6B7C8D9',
      '--days=30',
      '--format=json',
    ]);
    assert.deepEqual(args.problems, []);
    assert.equal(args.withProduction, true);
    assert.equal(args.businessId, '64f0c2a9e1b3d4f5a6b7c8d9');
    assert.equal(args.days, 30);
    assert.equal(args.format, 'json');
  });

  it('accepts --days=all and refuses an id that is not 24 hex characters', () => {
    assert.equal(parseIntegrityArgs(['--days=all']).days, 'all');
    assert.match(parseIntegrityArgs(['--business=not-an-id']).problems.join(' '), /24-character hexadecimal/);
  });

  it('refuses days outside their bound and a format it cannot produce', () => {
    assert.match(parseIntegrityArgs(['--days=0']).problems.join(' '), /--days/);
    assert.match(parseIntegrityArgs(['--days=99999']).problems.join(' '), /--days/);
    assert.match(parseIntegrityArgs(['--format=xml']).problems.join(' '), /--format/);
    assert.match(parseIntegrityArgs(['--fix-integrity']).problems.join(' '), /Unknown argument/);
    assert.match(parseIntegrityArgs(['stray']).problems.join(' '), /Unexpected argument/);
  });

  it('refuses --database= — the target is a fixed choice, not a free-form flag', () => {
    const problems = parseIntegrityArgs(['--database=inventoryai_prod_db']).problems.join(' ');
    assert.match(problems, /--database is not accepted/);
    assert.match(problems, /--with-production/);
  });

  it('reports a flag given twice rather than silently choosing one', () => {
    assert.match(
      parseIntegrityArgs(['--days=10', '--days=20']).problems.join(' '),
      /more than once/
    );
  });

  it('prints usage on --help and names the exit-code contract', () => {
    const args = parseIntegrityArgs(['--help']);
    assert.equal(args.help, true);
    assert.deepEqual(args.problems, []);

    const usage = auditSource.match(/const USAGE = `([\s\S]*?)`;/)?.[1] ?? '';
    assert.match(usage, /READ-ONLY/);
    assert.match(usage, /EXIT CODES/);
    assert.match(usage, /0 {2}ran to completion/);
    assert.match(usage, /1 {2}ran to completion, at least one candidate/);
    assert.match(usage, /2 {2}NOT CHECKED/);
  });

  it('computes the cutoff and allows all history', () => {
    assert.equal(cutoffForDays('all'), null);
    assert.equal(
      cutoffForDays(1, new Date('2026-01-02T00:00:00Z')).toISOString(),
      '2026-01-01T00:00:00.000Z'
    );
  });
});

describe('audit:integrity — the two detection rules', () => {
  it('orphan STOCK_IN partitions on the exact inventory row and requires no match', () => {
    const pipeline = buildOrphanStockInPipeline({ businessId: 'biz', since: new Date('2026-01-01T00:00:00Z') });
    assert.deepEqual(pipeline[0], {
      $match: {
        type: 'STOCK_IN',
        businessId: 'biz',
        createdAt: { $gte: new Date('2026-01-01T00:00:00Z') },
      },
    });
    const lookup = pipeline.find((stage) => stage.$lookup).$lookup;
    assert.equal(lookup.from, 'inventory');
    assert.equal(lookup.as, 'inventoryRows');
    assert.deepEqual(lookup.pipeline.find((stage) => stage.$match).$match.$expr.$and, [
      { $eq: ['$businessId', '$$businessId'] },
      { $eq: ['$productId', '$$productId'] },
      { $eq: ['$locationId', '$$locationId'] },
    ]);
    assert.deepEqual(pipeline.find((stage) => stage.$match?.inventoryRows), {
      $match: { inventoryRows: { $size: 0 } },
    });
  });

  it('unreceipted PO receipts match the receiving reason and the PO number, then reject referenced movements', () => {
    const pipeline = buildUnreceiptedPoStockInPipeline({ businessId: 'biz' });
    assert.deepEqual(pipeline[0].$match, {
      type: 'STOCK_IN',
      reason: PO_RECEIPT_REASON,
      reference: { $exists: true, $nin: [null, ''] },
      businessId: 'biz',
    });
    const lookups = pipeline.filter((stage) => stage.$lookup);
    assert.equal(lookups.length, 2);
    assert.equal(lookups[0].$lookup.from, 'inventory');
    assert.equal(lookups[1].$lookup.from, 'purchase_orders');
    assert.deepEqual(lookups[1].$lookup.let, { businessId: '$businessId', number: '$reference' });

    const addFields = pipeline.filter((stage) => stage.$addFields);
    assert.ok(addFields.some((stage) => stage.$addFields.receipted));
    assert.deepEqual(
      pipeline.find((stage) => stage.$match && 'receipted' in stage.$match),
      { $match: { receipted: false } }
    );
    assert.ok(addFields.some((stage) => stage.$addFields.purchaseOrder));
  });

  it('falls back to every STOCK_IN when no tenant is named', () => {
    assert.deepEqual(buildOrphanStockInPipeline()[0], { $match: { type: 'STOCK_IN' } });
  });
});

describe('audit:integrity — summary and report', () => {
  it('counts both categories and their total', () => {
    assert.deepEqual(
      summarizeFindings({ orphanStockIns: [{ id: 1 }], unreceiptedPoStockIns: [{ id: 2 }, { id: 3 }] }),
      { orphanStockIns: 1, unreceiptedPoStockIns: 2, total: 3 }
    );
    assert.deepEqual(summarizeFindings({}), { orphanStockIns: 0, unreceiptedPoStockIns: 0, total: 0 });
  });

  it('reports a clean scope as clean, not as a failure', () => {
    const report = formatTextReport({
      database: 'inventoryai_dev_db',
      days: 'all',
      scanned: 0,
      findings: { orphanStockIns: [], unreceiptedPoStockIns: [] },
      names: { businesses: new Map(), products: new Map(), locations: new Map() },
    });
    assert.match(report, /database: inventoryai_dev_db — READ-ONLY/);
    assert.match(report, /scanned: 0 STOCK_IN/);
    assert.match(report, /CLEAN: no orphan STOCK_IN/);
    assert.doesNotMatch(report, /FINDINGS:/);
  });

  it('names the transaction, tenant, product, location, PO and claim state', () => {
    const businessId = 'a'.repeat(24);
    const productId = 'b'.repeat(24);
    const locationId = 'c'.repeat(24);
    const report = formatTextReport({
      database: 'inventoryai_prod_db',
      days: 30,
      businessId,
      scanned: 42,
      findings: {
        orphanStockIns: [
          {
            _id: 'd'.repeat(24),
            businessId,
            productId,
            locationId,
            quantity: 5,
            previousQuantity: 0,
            newQuantity: 5,
            reason: 'supplier delivery',
            reference: 'MANUAL-1',
            createdAt: new Date('2026-10-30T10:00:00Z'),
          },
        ],
        unreceiptedPoStockIns: [
          {
            _id: 'e'.repeat(24),
            businessId,
            productId,
            locationId,
            quantity: 3,
            previousQuantity: 5,
            newQuantity: 8,
            reason: PO_RECEIPT_REASON,
            reference: 'PO-2',
            createdAt: new Date('2026-10-30T11:00:00Z'),
            rowFound: true,
            rowQuantity: 8,
            purchaseOrder: {
              _id: 'f'.repeat(24),
              number: 'PO-2',
              status: 'OPEN',
              receiptCount: 0,
              claimCount: 1,
              claimQuantity: 3,
            },
          },
        ],
      },
      names: {
        businesses: new Map([[businessId, 'Demo Business']]),
        products: new Map([[productId, { name: 'Compact Kettle', sku: 'KET-1' }]]),
        locations: new Map([[locationId, 'Main Warehouse']]),
      },
    });

    assert.match(report, /FINDINGS: 2 candidate/);
    assert.match(report, /Demo Business · Compact Kettle \(KET-1\) @ Main Warehouse/);
    assert.match(report, /PO-2 \(OPEN\) · receipts 0 · claims 1\/3 unit/);
    assert.match(report, /row quantity 8/);
    assert.match(report, /NOTHING WAS MODIFIED/);
  });
});

describe('audit:integrity — the read-only claim', () => {
  const WRITE =
    /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|create|save|drop|rename|syncIndexes|createIndex|createIndexes|dropIndex|dropIndexes)\s*\(/;

  it('contains no write call in either file', () => {
    for (const [name, source] of [
      ['audit-inventory-integrity.mjs', auditSource],
      ['lib/inventory-integrity.mjs', libSource],
    ]) {
      assert.equal(WRITE.test(source), false, `${name} contains a write-shaped call`);
    }
  });

  it('still finds a write when one is planted — the scan can fail', () => {
    assert.equal(WRITE.test('await Inventory.deleteMany({ businessId });'), true);
    assert.equal(WRITE.test('await Model.syncIndexes();'), true);
  });

  it('reads the fixed database rule and never invents its own connection target', () => {
    assert.match(auditSource, /databasesToCheck\(\{ withProduction: args\.withProduction/);
    assert.match(auditSource, /DATABASE_NAMES\.test/);
    assert.match(auditSource, /allowDiskUse: true/);
    assert.match(auditSource, /mongoose\.disconnect\(\)/);
  });

  it('turns off Mongoose autoIndex/autoCreate, which would write at connect time', () => {
    assert.match(auditSource, /autoIndex: false/);
    assert.match(auditSource, /autoCreate: false/);
  });
});

// ---------------------------------------------------------------------------
// Detection against a real database.
// ---------------------------------------------------------------------------

const dbOk = await ensureDb();
const { ObjectId } = mongoose.Types;

dbSuite('audit:integrity — detection over real MongoDB', dbOk, () => {
  const bizId = new ObjectId();
  const otherBizId = new ObjectId();
  const productId = new ObjectId();
  const otherProductId = new ObjectId();
  const orphanProductId = new ObjectId();
  const locationId = new ObjectId();
  const userId = new ObjectId();
  const normalTxnId = new ObjectId();
  const unreceiptedTxnId = new ObjectId();
  const orphanPoTxnId = new ObjectId();
  const orphanManualTxnId = new ObjectId();
  const manualWithRowTxnId = new ObjectId();
  const otherTxnId = new ObjectId();
  const normalPoId = new ObjectId();
  const openPoId = new ObjectId();
  const base = new Date('2026-10-30T10:00:00.000Z');

  const txn = (overrides) => ({
    businessId: bizId,
    productId,
    locationId,
    userId,
    type: 'STOCK_IN',
    quantity: 5,
    previousQuantity: 0,
    newQuantity: 5,
    createdAt: base,
    ...overrides,
  });

  before(async () => {
    await Business.collection.insertMany([
      { _id: bizId, name: 'Integrity Audit Biz', status: 'ACTIVE' },
      { _id: otherBizId, name: 'Other Integrity Biz', status: 'ACTIVE' },
    ]);
    await Product.collection.insertMany([
      { _id: productId, businessId: bizId, name: 'Compact Kettle', sku: 'KET-1', status: 'ACTIVE' },
      { _id: otherProductId, businessId: bizId, name: 'Desk Lamp', sku: 'LAMP-1', status: 'ACTIVE' },
      { _id: orphanProductId, businessId: bizId, name: 'Orphan Shelf', sku: 'ORPH-1', status: 'ACTIVE' },
    ]);
    await Location.collection.insertOne({ _id: locationId, businessId: bizId, name: 'Main Warehouse' });

    await Inventory.collection.insertMany([
      { businessId: bizId, productId, locationId, quantity: 5, reservedQuantity: 0 },
      { businessId: bizId, productId: otherProductId, locationId, quantity: 2, reservedQuantity: 0 },
    ]);

    await InventoryTransaction.collection.insertMany([
      txn({
        _id: normalTxnId,
        quantity: 5,
        previousQuantity: 0,
        newQuantity: 5,
        reason: PO_RECEIPT_REASON,
        reference: 'PO-1',
      }),
      txn({
        _id: unreceiptedTxnId,
        productId: otherProductId,
        quantity: 3,
        previousQuantity: 2,
        newQuantity: 5,
        reason: PO_RECEIPT_REASON,
        reference: 'PO-2',
        createdAt: new Date(base.getTime() + 1000),
      }),
      txn({
        _id: orphanPoTxnId,
        productId: orphanProductId,
        quantity: 4,
        previousQuantity: 0,
        newQuantity: 4,
        reason: PO_RECEIPT_REASON,
        reference: 'PO-2',
        createdAt: new Date(base.getTime() + 2000),
      }),
      txn({
        _id: orphanManualTxnId,
        productId: orphanProductId,
        quantity: 7,
        previousQuantity: 0,
        newQuantity: 7,
        reason: 'manual count',
        reference: 'MANUAL-1',
        createdAt: new Date(base.getTime() + 3000),
      }),
      txn({
        _id: manualWithRowTxnId,
        quantity: 2,
        previousQuantity: 5,
        newQuantity: 7,
        reason: 'manual count',
        reference: 'MANUAL-2',
        createdAt: new Date(base.getTime() + 4000),
      }),
      txn({
        _id: otherTxnId,
        businessId: otherBizId,
        quantity: 9,
        previousQuantity: 0,
        newQuantity: 9,
        reason: 'orphan in another tenant',
        reference: 'OTHER-1',
        createdAt: new Date(base.getTime() + 5000),
      }),
    ]);

    await PurchaseOrder.collection.insertMany([
      {
        _id: normalPoId,
        businessId: bizId,
        number: 'PO-1',
        status: 'RECEIVED',
        items: [],
        receipts: [
          {
            receivedAt: base,
            userId,
            reference: '',
            lines: [
              {
                productId,
                quantity: 5,
                inventoryTransactionId: normalTxnId,
                previousQuantity: 0,
                newQuantity: 5,
              },
            ],
          },
        ],
        claims: [],
      },
      {
        _id: openPoId,
        businessId: bizId,
        number: 'PO-2',
        status: 'OPEN',
        items: [],
        receipts: [],
        claims: [{ _id: new ObjectId(), productId: otherProductId, quantity: 3, createdBy: userId, createdAt: base }],
      },
    ]);
  });

  after(async () => {
    await InventoryTransaction.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Inventory.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await PurchaseOrder.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Product.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Location.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Business.deleteMany({ _id: { $in: [bizId, otherBizId] } });
    await disconnectDb();
  });

  it('finds exactly the STOCK_IN rows without an inventory row, scoped to the tenant', async () => {
    const rows = await InventoryTransaction.aggregate(
      buildOrphanStockInPipeline({ businessId: bizId }),
      { allowDiskUse: true }
    );
    assert.deepEqual(
      rows.map((row) => String(row._id)).sort(),
      [String(orphanManualTxnId), String(orphanPoTxnId)].sort()
    );
  });

  it('does not report a stock-in that has its inventory row', async () => {
    const rows = await InventoryTransaction.aggregate(
      buildOrphanStockInPipeline({ businessId: bizId }),
      { allowDiskUse: true }
    );
    const ids = rows.map((row) => String(row._id));
    assert.equal(ids.includes(String(normalTxnId)), false);
    assert.equal(ids.includes(String(unreceiptedTxnId)), false);
    assert.equal(ids.includes(String(manualWithRowTxnId)), false);
  });

  it('finds the unreceipted PO stock-ins, including an orphan, and reports the PO claim state', async () => {
    const rows = await InventoryTransaction.aggregate(
      buildUnreceiptedPoStockInPipeline({ businessId: bizId }),
      { allowDiskUse: true }
    );
    assert.deepEqual(
      rows.map((row) => String(row._id)).sort(),
      [String(orphanPoTxnId), String(unreceiptedTxnId)].sort()
    );

    const unreceipted = rows.find((row) => String(row._id) === String(unreceiptedTxnId));
    assert.equal(unreceipted.purchaseOrder.number, 'PO-2');
    assert.equal(unreceipted.purchaseOrder.status, 'OPEN');
    assert.equal(unreceipted.purchaseOrder.receiptCount, 0);
    assert.equal(unreceipted.purchaseOrder.claimCount, 1);
    assert.equal(unreceipted.purchaseOrder.claimQuantity, 3);
    assert.equal(unreceipted.rowFound, true);
    assert.equal(unreceipted.rowQuantity, 2);

    const orphan = rows.find((row) => String(row._id) === String(orphanPoTxnId));
    assert.equal(orphan.rowFound, false);
  });

  it('does not report a PO stock-in whose receipt references it', async () => {
    const rows = await InventoryTransaction.aggregate(
      buildUnreceiptedPoStockInPipeline({ businessId: bizId }),
      { allowDiskUse: true }
    );
    assert.equal(rows.some((row) => String(row._id) === String(normalTxnId)), false);
  });

  it('respects the history cutoff and keeps another tenant out of a scoped scan', async () => {
    const afterEverything = await InventoryTransaction.aggregate(
      buildOrphanStockInPipeline({ businessId: bizId, since: new Date('2026-10-30T11:00:00Z') }),
      { allowDiskUse: true }
    );
    assert.equal(afterEverything.length, 0);

    const otherTenant = await InventoryTransaction.aggregate(
      buildOrphanStockInPipeline({ businessId: otherBizId }),
      { allowDiskUse: true }
    );
    assert.deepEqual(
      otherTenant.map((row) => String(row._id)),
      [String(otherTxnId)]
    );
  });
});
