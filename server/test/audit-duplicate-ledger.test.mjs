// `npm run audit:duplicates` — the read-only historical-duplicate audit (§27HA).
//
// WHY IT EXISTS. §27GZ stopped one operation being applied twice, but the rows
// written before it were never examined. This tool reports suspected duplicate
// ledger rows per tenant for a human to judge; it does not repair them, because the
// ledger cannot prove intent and a bulk delete of "duplicates" would destroy real
// movements.
//
// WHAT IS PINNED HERE, in three layers:
//
//   1. the ARGUMENTS — defaults, every accepted value, and each refusal (a bad id,
//      an out-of-range window, an unknown flag, and `--database=`, which would
//      otherwise let a production read look like a harmless flag);
//   2. the DETECTION — the aggregation's signature, its predecessor comparison and its
//      window, plus the summary arithmetic, asserted against a real MongoDB seeded with
//      the same duplicate pair twice (once straddling an hour boundary), a legitimate
//      identical repeat outside the window, a repeat that must not hide an adjacent
//      pair, two users doing the same thing, and a normal transfer pair;
//   3. the READ-ONLY CLAIM — a source scan for every write verb, `syncIndexes` and
//      index creation, with a planted control so the scan cannot pass by being
//      unable to fail.
//
// Registered MIXED in run-tests.mjs: the pure cases run in every mode, the DB
// cases only when MongoDB is available (and fail loudly when it is required).

import 'dotenv/config';

import mongoose from 'mongoose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import Business from '../src/models/business.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import {
  DEFAULT_DAYS,
  DEFAULT_WINDOW_SECONDS,
  buildScanPipeline,
  cutoffForDays,
  formatTextReport,
  parseDuplicateArgs,
  summarizeGroups,
} from '../scripts/lib/duplicate-ledger.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditSource = readFileSync(path.join(serverRoot, 'scripts', 'audit-duplicate-ledger.mjs'), 'utf8');
const libSource = readFileSync(path.join(serverRoot, 'scripts', 'lib', 'duplicate-ledger.mjs'), 'utf8');

describe('audit:duplicates — arguments', () => {
  it('defaults to one fixed database, 90 days, a 120-second window and text', () => {
    assert.deepEqual(parseDuplicateArgs([]), {
      help: false,
      withProduction: false,
      businessId: null,
      days: DEFAULT_DAYS,
      windowSeconds: DEFAULT_WINDOW_SECONDS,
      format: 'text',
      problems: [],
    });
  });

  it('accepts every documented value', () => {
    const args = parseDuplicateArgs([
      '--with-production',
      '--business=64F0C2A9E1B3D4F5A6B7C8D9',
      '--days=all',
      '--window-seconds=30',
      '--format=json',
    ]);
    assert.deepEqual(args.problems, []);
    assert.equal(args.withProduction, true);
    assert.equal(args.businessId, '64f0c2a9e1b3d4f5a6b7c8d9');
    assert.equal(args.days, 'all');
    assert.equal(args.windowSeconds, 30);
    assert.equal(args.format, 'json');
  });

  it('refuses an id that is not 24 hex characters', () => {
    assert.match(parseDuplicateArgs(['--business=not-an-id']).problems.join(' '), /24-character hexadecimal/);
  });

  it('refuses days and windows outside their bounds', () => {
    assert.match(parseDuplicateArgs(['--days=0']).problems.join(' '), /--days/);
    assert.match(parseDuplicateArgs(['--days=99999']).problems.join(' '), /--days/);
    assert.match(parseDuplicateArgs(['--window-seconds=0']).problems.join(' '), /--window-seconds/);
    assert.match(parseDuplicateArgs(['--window-seconds=3601']).problems.join(' '), /--window-seconds/);
  });

  it('refuses a format it cannot produce and a flag it does not know', () => {
    assert.match(parseDuplicateArgs(['--format=xml']).problems.join(' '), /--format/);
    assert.match(parseDuplicateArgs(['--fix-duplicates']).problems.join(' '), /Unknown argument/);
    assert.match(parseDuplicateArgs(['stray']).problems.join(' '), /Unexpected argument/);
  });

  it('refuses --database= — the target is a fixed choice, not a free-form flag', () => {
    const problems = parseDuplicateArgs(['--database=inventoryai_prod_db']).problems.join(' ');
    assert.match(problems, /--database is not accepted/);
    assert.match(problems, /--with-production/);
  });

  it('reports a flag given twice rather than silently choosing one', () => {
    assert.match(
      parseDuplicateArgs(['--window-seconds=10', '--window-seconds=20']).problems.join(' '),
      /more than once/
    );
  });

  it('prints usage on --help and names the exit-code contract', () => {
    const args = parseDuplicateArgs(['--help']);
    assert.equal(args.help, true);
    assert.deepEqual(args.problems, []);

    const usage = auditSource.match(/const USAGE = `([\s\S]*?)`;/)?.[1] ?? '';
    assert.match(usage, /READ-ONLY/);
    assert.match(usage, /EXIT CODES/);
    assert.match(usage, /0 {2}ran to completion/);
    assert.match(usage, /1 {2}ran to completion, at least one suspected group/);
    assert.match(usage, /2 {2}NOT CHECKED/);
  });
});

describe('audit:duplicates — the detection rule', () => {
  const pipeline = buildScanPipeline({ windowSeconds: 120 });

  it('partitions by the request the client sent, not by identical ledger rows', () => {
    const window = pipeline.find((stage) => stage.$setWindowFields).$setWindowFields;
    assert.deepEqual(Object.keys(window.partitionBy).sort(), [
      'businessId',
      'locationId',
      'productId',
      'quantity',
      'reason',
      'reference',
      'type',
      'userId',
    ]);
    // A missing reason and an empty string are the same request, so they share one
    // partition instead of splitting a pair in two.
    assert.deepEqual(window.partitionBy.reason, { $ifNull: ['$reason', ''] });
    assert.deepEqual(window.partitionBy.reference, { $ifNull: ['$reference', ''] });
    // previousQuantity/newQuantity are deliberately absent: the duplicate carries
    // the value the first row produced, so requiring them to match finds nothing.
    assert.equal('previousQuantity' in window.partitionBy, false);
    assert.equal('newQuantity' in window.partitionBy, false);
    assert.equal('hour' in window.partitionBy, false);
  });

  it('compares each row with its immediate predecessor, with no hour bucket to fall across', () => {
    const window = pipeline.find((stage) => stage.$setWindowFields).$setWindowFields;
    assert.deepEqual(window.sortBy, { createdAt: 1, _id: 1 });
    const shift = window.output.previous.$shift;
    assert.equal(shift.by, -1);
    assert.equal(shift.default, null);
    assert.deepEqual(Object.keys(shift.output).sort(), ['at', 'id', 'newQuantity', 'previousQuantity']);
    // The bucket is gone entirely — a pair at 10:59:59.900 and 11:00:00.100 has no
    // boundary between it any more.
    const stageNames = pipeline.flatMap((stage) => Object.keys(stage));
    assert.equal(stageNames.includes('$group'), false);
    assert.equal(JSON.stringify(pipeline).includes('$dateTrunc'), false);
  });

  it('requires a real predecessor and a gap inside the window', () => {
    assert.deepEqual(pipeline.find((stage) => stage.$addFields).$addFields, {
      gapMs: { $subtract: ['$createdAt', '$previous.at'] },
    });
    const matches = pipeline.filter((stage) => stage.$match).map((stage) => stage.$match);
    assert.ok(matches.some((match) => match.previous?.$ne === null), 'the first row has no pair');
    assert.ok(
      matches.some((match) => match.gapMs?.$lte === 120_000),
      'the window must be applied to the gap in milliseconds'
    );
  });

  it('emits the pair itself: both rows and the quantities each one moved', () => {
    const project = pipeline.find((stage) => stage.$project).$project;
    assert.equal(project.count.$literal, 2);
    assert.equal(project.firstCreatedAt, '$previous.at');
    assert.equal(project.lastCreatedAt, '$createdAt');
    assert.equal(project.spanMs, '$gapMs');
    const [predecessor, current] = project.rows.$concatArrays;
    assert.deepEqual(predecessor, [
      {
        id: '$previous.id',
        at: '$previous.at',
        previousQuantity: '$previous.previousQuantity',
        newQuantity: '$previous.newQuantity',
      },
    ]);
    assert.deepEqual(current, [
      { id: '$_id', at: '$createdAt', previousQuantity: '$previousQuantity', newQuantity: '$newQuantity' },
    ]);
  });

  it('applies the tenant and cut-off filters with a single $match', () => {
    const scoped = buildScanPipeline({ businessId: 'biz', since: new Date('2026-01-01T00:00:00Z'), windowSeconds: 60 });
    assert.deepEqual(scoped[0], {
      $match: { businessId: 'biz', createdAt: { $gte: new Date('2026-01-01T00:00:00Z') } },
    });
    // No filter at all: the pipeline starts at the window stage rather than with an
    // empty match.
    assert.equal(buildScanPipeline()[0].$setWindowFields !== undefined, true);
  });

  it('sorts newest first so the report leads with the most recent suspicion', () => {
    const sort = pipeline.find((stage) => stage.$sort).$sort;
    assert.equal(sort.lastCreatedAt, -1);
  });

  it('computes the cutoff and allows all history', () => {
    assert.equal(cutoffForDays('all'), null);
    assert.equal(
      cutoffForDays(1, new Date('2026-01-02T00:00:00Z')).toISOString(),
      '2026-01-01T00:00:00.000Z'
    );
  });
});

describe('audit:duplicates — the per-tenant summary', () => {
  it('counts extra rows per tenant and orders by them', () => {
    const summary = summarizeGroups([
      { _id: { businessId: 'a' }, count: 2 },
      { _id: { businessId: 'a' }, count: 3 },
      { _id: { businessId: 'b' }, count: 2 },
    ]);
    // a: (2-1) + (3-1) = 3 extra rows; b: (2-1) = 1.
    assert.equal(summary.totalGroups, 3);
    assert.equal(summary.extraRows, 4);
    assert.deepEqual(
      summary.tenants.map((tenant) => [tenant.businessId, tenant.extraRows]),
      [
        ['a', 3],
        ['b', 1],
      ]
    );
  });

  it('reports nothing as nothing, never as a failure', () => {
    assert.deepEqual(summarizeGroups([]), { tenants: [], totalGroups: 0, extraRows: 0 });
  });
});

describe('audit:duplicates — the text report', () => {
  const tenantId = 'b'.repeat(24);
  const tenants = [
    {
      businessId: tenantId,
      extraRows: 2,
      groups: [
        {
          type: 'STOCK_IN',
          quantity: 5,
          product: { id: 'p1', name: 'Compact Kettle', sku: 'KET-1' },
          location: { id: 'l1', name: 'Main Warehouse' },
          userId: 'u'.repeat(24),
          reason: 'supplier delivery',
          reference: 'PO-1',
          count: 2,
          spanMs: 2500,
          rows: [
            { id: 'a'.repeat(24), at: '2026-10-30T10:00:00.000Z', previousQuantity: 10, newQuantity: 15 },
            { id: 'c'.repeat(24), at: '2026-10-30T10:00:02.500Z', previousQuantity: 15, newQuantity: 20 },
          ],
        },
        {
          type: 'STOCK_IN',
          quantity: 3,
          product: { id: 'p2', name: 'Desk Lamp', sku: null },
          location: { id: 'l1', name: 'Main Warehouse' },
          userId: 'u'.repeat(24),
          reason: 'PO receipt',
          reference: 'PO-9',
          count: 2,
          spanMs: 500,
          rows: [
            { id: 'd'.repeat(24), at: '2026-10-30T11:00:00.000Z', previousQuantity: 0, newQuantity: 3 },
            { id: 'e'.repeat(24), at: '2026-10-30T11:00:00.500Z', previousQuantity: 3, newQuantity: 6 },
          ],
        },
      ],
    },
  ];

  const report = formatTextReport({
    database: 'inventoryai_dev_db',
    days: 'all',
    windowSeconds: 120,
    scanned: 5487,
    summary: { totalGroups: 2, extraRows: 2 },
    tenants,
    businessName: () => 'Demo Business',
  });

  it('names the tenant, the movement, both rows and the quantities they moved', () => {
    assert.match(report, /database: inventoryai_dev_db — READ-ONLY/);
    assert.match(report, /scanned: 5,487 ledger row\(s\)/);
    assert.match(report, /each row within 120s of the previous row of that signature/);
    assert.match(report, /SUSPECTED: 2 pair\(s\), 2 extra row\(s\)/);
    assert.match(report, /Demo Business \(bbbbbbbbbb…\) — 2 pair\(s\), 2 extra row\(s\)/);
    assert.match(report, /STOCK_IN × 5 · Compact Kettle \(KET-1\) @ Main Warehouse/);
    assert.match(report, /2 rows · 2.5s apart/);
    assert.match(report, /prev 10 → 15/);
    assert.match(report, /prev 15 → 20/);
  });

  it('warns that an equal partial PO receipt looks the same, and that nothing was changed', () => {
    assert.match(report, /PO's own receipts/);
    assert.match(report, /nothing was changed/);
    assert.match(report, /Suspected" means the rows share the request fields/);
  });

  it('reports a clean ledger as clean, not as a failure', () => {
    const clean = formatTextReport({
      database: 'db',
      days: 90,
      windowSeconds: 120,
      scanned: 0,
      summary: { totalGroups: 0, extraRows: 0 },
      tenants: [],
      businessName: () => 'nobody',
    });
    assert.match(clean, /no suspected duplicates/);
    assert.doesNotMatch(clean, /SUSPECTED:/);
  });
});

describe('audit:duplicates — the read-only claim', () => {
  /** Every way this repository writes to a collection, or to an index. */
  const WRITE =
    /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|create|save|drop|rename|syncIndexes|createIndex|createIndexes|dropIndex|dropIndexes)\s*\(/;

  it('contains no write call in either file', () => {
    for (const [name, source] of [
      ['audit-duplicate-ledger.mjs', auditSource],
      ['lib/duplicate-ledger.mjs', libSource],
    ]) {
      assert.equal(WRITE.test(source), false, `${name} contains a write-shaped call`);
    }
  });

  it('still finds a write when one is planted — the scan can fail', () => {
    assert.equal(WRITE.test('await InventoryTransaction.deleteMany({ businessId });'), true);
    assert.equal(WRITE.test('await Model.syncIndexes();'), true);
  });

  it('reads the fixed database rule and never invents its own connection target', () => {
    assert.match(auditSource, /databasesToCheck\(\{ withProduction: args\.withProduction/);
    assert.match(auditSource, /DATABASE_NAMES\.test/);
    assert.match(auditSource, /allowDiskUse: true/);
    assert.match(auditSource, /mongoose\.disconnect\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Detection against a real database.
// ---------------------------------------------------------------------------

const dbOk = await ensureDb();
const { ObjectId } = mongoose.Types;

dbSuite('audit:duplicates — detection over real MongoDB', dbOk, () => {
  const bizId = new ObjectId();
  const otherBizId = new ObjectId();
  const productId = new ObjectId();
  const otherProductId = new ObjectId();
  const locationId = new ObjectId();
  const secondLocationId = new ObjectId();
  const userId = new ObjectId();
  const otherUserId = new ObjectId();

  // One minute past the hour, so the fixture does not sit on a boundary by accident;
  // the cross-boundary case below names its own timestamps.
  const base = new Date('2026-10-30T10:01:00.000Z');
  const at = (ms) => new Date(base.getTime() + ms);

  const txn = (overrides) => ({
    businessId: bizId,
    productId,
    locationId,
    userId,
    type: 'STOCK_IN',
    quantity: 1,
    previousQuantity: 0,
    newQuantity: 1,
    createdAt: base,
    ...overrides,
  });

  // The pair the audit must find: same request, 2.5 seconds apart.
  const duplicatePair = [
    txn({ _id: new ObjectId(), quantity: 5, previousQuantity: 10, newQuantity: 15, reason: 'supplier delivery', reference: 'PO-1', createdAt: at(0) }),
    txn({ _id: new ObjectId(), quantity: 5, previousQuantity: 15, newQuantity: 20, reason: 'supplier delivery', reference: 'PO-1', createdAt: at(2500) }),
  ];

  before(async () => {
    await Business.collection.insertMany([
      { _id: bizId, name: 'Audit Duplicate Biz', status: 'ACTIVE' },
      { _id: otherBizId, name: 'Audit Clean Biz', status: 'ACTIVE' },
    ]);
    await Product.collection.insertMany([
      { _id: productId, businessId: bizId, name: 'Compact Kettle', sku: 'KET-1', status: 'ACTIVE' },
      { _id: otherProductId, businessId: bizId, name: 'Desk Lamp', sku: 'LAMP-1', status: 'ACTIVE' },
    ]);
    await Location.collection.insertMany([
      { _id: locationId, businessId: bizId, name: 'Main Warehouse' },
      { _id: secondLocationId, businessId: bizId, name: 'Second Shelf' },
    ]);

    await InventoryTransaction.collection.insertMany([
      ...duplicatePair,

      // A legitimate identical repeat 30 minutes later: the 120 s window excludes it.
      txn({ productId: otherProductId, quantity: 3, previousQuantity: 0, newQuantity: 3, createdAt: at(0) }),
      txn({ productId: otherProductId, quantity: 3, previousQuantity: 3, newQuantity: 6, createdAt: at(30 * 60_000) }),

      // Two members doing the same thing a second apart are two operations.
      txn({ productId: otherProductId, locationId: secondLocationId, quantity: 7, previousQuantity: 0, newQuantity: 7, createdAt: at(0) }),
      txn({ productId: otherProductId, locationId: secondLocationId, userId: otherUserId, quantity: 7, previousQuantity: 0, newQuantity: 7, createdAt: at(1000) }),

      // A normal transfer: two legs share the reference by DESIGN, and differ by
      // location, so the pair must not be reported.
      txn({ type: 'TRANSFER', quantity: 4, previousQuantity: 10, newQuantity: 6, locationId, reference: 'TRF-1', createdAt: at(0) }),
      txn({ type: 'TRANSFER', quantity: 4, previousQuantity: 0, newQuantity: 4, locationId: secondLocationId, reference: 'TRF-1', createdAt: at(1000) }),

      // 10:59:59.900 and 11:00:00.100 — 200 ms apart, either side of an hour boundary.
      // This is the pair the old clock-hour bucket could never compare.
      txn({ quantity: 9, previousQuantity: 0, newQuantity: 9, createdAt: new Date('2026-10-30T10:59:59.900Z') }),
      txn({ quantity: 9, previousQuantity: 9, newQuantity: 18, createdAt: new Date('2026-10-30T11:00:00.100Z') }),

      // Three identical movements: an adjacent pair 2 s apart, then a legitimate repeat
      // 40 minutes later. A span-over-the-bucket rule saw the 40-minute span and hid
      // the real pair; adjacency does not.
      txn({ quantity: 11, previousQuantity: 0, newQuantity: 11, createdAt: at(0) }),
      txn({ quantity: 11, previousQuantity: 11, newQuantity: 22, createdAt: at(2000) }),
      txn({ quantity: 11, previousQuantity: 22, newQuantity: 33, createdAt: at(40 * 60_000) }),

      // A second tenant with a clean ledger.
      txn({ businessId: otherBizId, quantity: 2, previousQuantity: 0, newQuantity: 2 }),
    ]);
  });

  after(async () => {
    await InventoryTransaction.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Product.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Location.deleteMany({ businessId: { $in: [bizId, otherBizId] } });
    await Business.deleteMany({ _id: { $in: [bizId, otherBizId] } });
    await disconnectDb();
  });

  const scan = (options = {}) =>
    InventoryTransaction.aggregate(
      buildScanPipeline({ businessId: bizId, since: null, windowSeconds: 120, ...options }),
      { allowDiskUse: true }
    );

  it('reports every suspected pair, newest first, with both rows and their quantities', async () => {
    const groups = await scan();
    assert.equal(groups.length, 3, JSON.stringify(groups.map((group) => [group._id.quantity, group.spanMs])));
    // Ordered by the later row of each pair, newest first.
    assert.deepEqual(groups.map((group) => group._id.quantity), [9, 5, 11]);

    const five = groups.find((group) => group._id.quantity === 5);
    assert.equal(five.count, 2);
    assert.equal(five._id.type, 'STOCK_IN');
    assert.deepEqual(five.rows.map((row) => String(row.id)).sort(), duplicatePair.map((row) => String(row._id)).sort());
    assert.deepEqual(
      five.rows.map((row) => [row.previousQuantity, row.newQuantity]).sort((a, b) => a[0] - b[0]),
      [
        [10, 15],
        [15, 20],
      ]
    );
    assert.equal(five.spanMs, 2500);
  });

  it('finds a pair that straddles an hour boundary — the old blind spot', async () => {
    const [nine] = (await scan()).filter((group) => group._id.quantity === 9);
    assert.ok(nine, 'the 10:59:59.900 / 11:00:00.100 pair must be reported');
    assert.equal(nine.count, 2);
    assert.equal(nine.spanMs, 200);
    assert.deepEqual(nine.rows.map((row) => row.at), [
      new Date('2026-10-30T10:59:59.900Z'),
      new Date('2026-10-30T11:00:00.100Z'),
    ]);
    assert.deepEqual(nine.rows.map((row) => [row.previousQuantity, row.newQuantity]), [
      [0, 9],
      [9, 18],
    ]);
  });

  it('does not let a later legitimate repeat hide an adjacent pair', async () => {
    const [eleven] = (await scan()).filter((group) => group._id.quantity === 11);
    assert.ok(eleven);
    assert.equal(eleven.count, 2);
    assert.equal(eleven.rows.length, 2);
    assert.equal(eleven.spanMs, 2000);
    const latest = Math.max(...eleven.rows.map((row) => new Date(row.at).getTime()));
    assert.ok(latest < base.getTime() + 10 * 60_000, 'the 40-minute repeat is not part of the pair');
  });

  it('honours the window inclusively: 2.0 s is inside a 2-second window, 2.5 s is not', async () => {
    const quantities = async (windowSeconds) =>
      (await scan({ windowSeconds })).map((group) => group._id.quantity).sort((a, b) => a - b);

    assert.deepEqual(await quantities(2), [9, 11]);
    assert.deepEqual(await quantities(1), [9]);
  });

  it('never merges two members doing the same movement', async () => {
    const groups = await scan();
    assert.equal(groups.some((group) => String(group._id.userId) === String(otherUserId)), false);
  });

  it('never reports a transfer implemented as its ordinary two legs', async () => {
    const groups = await scan();
    assert.equal(groups.some((group) => group._id.type === 'TRANSFER'), false);
  });

  it('scopes to one tenant and to the requested history', async () => {
    assert.equal((await scan({ businessId: otherBizId })).length, 0);

    // A cutoff after the early pairs keeps the later 11:00 pair, and only it: the
    // remaining single rows of the 3- and 11-unit signatures are not pairs.
    const afterEarlyPairs = new Date(base.getTime() + 10 * 60_000);
    assert.deepEqual(
      (await scan({ since: afterEarlyPairs })).map((group) => group._id.quantity),
      [9]
    );

    // A cutoff after every fixture row reports nothing rather than failing.
    const afterEverything = new Date('2026-10-30T11:10:00.000Z');
    assert.equal((await scan({ since: afterEverything })).length, 0);
  });
});
