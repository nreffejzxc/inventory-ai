// Durable audit outbox — Product Import is the first producer.
//
// The business write and the AuditLog insert are separate documents. This suite
// pins the crash windows: a completed receipt with no hand-off is repaired, an
// enqueued-but-undelivered event is replayed, an in-flight claim left by a
// crashed worker is reclaimed, and concurrent retries append one audit row.

import 'dotenv/config';

import mongoose from 'mongoose';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import ProductImport from '../src/models/productImport.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import AuditOutbox, {
  AUDIT_OUTBOX_DELIVERED_RETENTION_SECONDS,
} from '../src/models/auditOutbox.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import StockMovementOperation from '../src/models/stockMovementOperation.model.ts';
import inventoryService from '../src/services/inventory.service.ts';
import purchaseOrderService from '../src/services/purchase-orders.service.ts';
import {
  enqueueAndDeliverMovementAudit,
  recoverMovementAudits,
} from '../src/services/stockMovementAudit.service.ts';
import { recoverPoReceiveAudits } from '../src/services/purchaseOrderReceiveAudit.service.ts';
import {
  enqueueAuditOnce,
  enqueueAndDeliverAudit,
  flushAuditOutbox,
} from '../src/services/auditOutbox.service.ts';
import {
  productImportAuditEvent,
  recoverProductImportAudits,
} from '../src/services/productImportAudit.service.ts';

const { ObjectId } = mongoose.Types;

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;

function completedImport(overrides = {}) {
  return ProductImport.create({
    businessId: new ObjectId(owner.businessId),
    key: uniqueName('outbox-import'),
    fingerprint: uniqueName('outbox-fingerprint'),
    fileName: 'outbox.csv',
    userId: new ObjectId(owner.userId),
    status: 'COMPLETED',
    totalRows: 2,
    createdProducts: [
      { line: 2, productId: new ObjectId() },
      { line: 3, productId: new ObjectId() },
    ],
    stockOperations: [{ line: 2, quantity: 5, inventoryTransactionId: new ObjectId() }],
    result: { createdCount: 2, openingStockCount: 1, openingStockUnits: 5 },
    finishedAt: new Date(),
    ...overrides,
  });
}

function auditKey(receipt) {
  return `product-import:${String(receipt._id)}:completed`;
}

async function newProduct() {
  const res = await api('POST', '/api/products', {
    token: owner.token,
    body: { currency: 'PHP', name: uniqueName('OUTBOX-P') },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newLocation() {
  const res = await api('POST', '/api/locations', {
    token: owner.token,
    body: { name: uniqueName('OUTBOX-L') },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newSupplier() {
  const res = await api('POST', '/api/suppliers', {
    token: owner.token,
    body: { name: uniqueName('OUTBOX-S') },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function mkOpenPo({ supplierId, locationId, items }) {
  const created = await api('POST', '/api/purchase-orders', {
    token: owner.token,
    body: { supplierId, locationId, items },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const issued = await api('POST', `/api/purchase-orders/${created.json.id}/issue`, {
    token: owner.token,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  return issued.json;
}

async function clearMovementAudit(receipt) {
  const dedupeKey = `movement:${String(receipt._id)}:completed`;
  await AuditLog.deleteMany({ dedupeKey });
  await AuditOutbox.deleteMany({ dedupeKey });
  await StockMovementOperation.updateOne(
    { _id: receipt._id },
    { $unset: { auditEnqueuedAt: 1 } },
  );
  return dedupeKey;
}

async function clearPoAudit(poId, dedupeKey) {
  await AuditLog.deleteMany({ dedupeKey });
  await AuditOutbox.deleteMany({ dedupeKey });
  await PurchaseOrder.updateOne(
    { _id: new ObjectId(poId) },
    { $set: { 'receipts.$[].auditEnqueuedAt': null } },
  );
}

before(async () => {
  if (!dbOk) return;
  owner = await registerOwner(api, tracker);
  // The unique dedupe key is the duplicate-prevention boundary, not a
  // best-effort application check.
  await AuditOutbox.init();
});

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AUDIT OUTBOX — Product Import crash recovery and replay', dbOk, () => {
  it('★ repairs a completed import that never got an audit hand-off', async () => {
    const receipt = await completedImport();
    const summary = await recoverProductImportAudits({
      olderThanMs: 0,
      businessId: owner.businessId,
      limit: 10,
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.enqueued, 1);
    assert.equal(summary.delivered, 1);
    assert.equal(summary.failed, 0);

    const audit = await AuditLog.findOne({
      businessId: new ObjectId(owner.businessId),
      dedupeKey: auditKey(receipt),
    }).lean();
    assert.ok(audit);
    assert.equal(audit.action, 'PRODUCTS_IMPORTED');
    assert.equal(audit.entityId, String(receipt._id));
    assert.equal(audit.metadata.fileName, 'outbox.csv');
    assert.equal(audit.metadata.createdCount, 2);
    assert.equal(audit.metadata.openingStockCount, 1);
    assert.equal(audit.metadata.openingStockUnits, 5);

    const outbox = await AuditOutbox.findOne({
      businessId: new ObjectId(owner.businessId),
      dedupeKey: auditKey(receipt),
    }).lean();
    assert.equal(outbox.status, 'DELIVERED');
    assert.equal(outbox.attempts, 1);
    assert.ok(outbox.deliveredAt instanceof Date);

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.ok(stored.auditEnqueuedAt instanceof Date);
  });

  it('★ fences a legacy completed import whose audit predates dedupe keys', async () => {
    const receipt = await completedImport();
    await AuditLog.create({
      businessId: new ObjectId(owner.businessId),
      userId: new ObjectId(owner.userId),
      action: 'PRODUCTS_IMPORTED',
      entityType: 'PRODUCT_IMPORT',
      entityId: String(receipt._id),
      metadata: { fileName: 'outbox.csv', legacy: true },
    });

    const summary = await recoverProductImportAudits({
      olderThanMs: 0,
      businessId: owner.businessId,
      limit: 10,
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.enqueued, 0, 'a legacy audit already exists');
    assert.equal(summary.delivered, 0);
    assert.equal(summary.failed, 0);

    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        action: 'PRODUCTS_IMPORTED',
        entityId: String(receipt._id),
      }),
      1,
      'repair must not append a second historical audit',
    );
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: auditKey(receipt),
      }),
      0,
    );
    const stored = await ProductImport.findById(receipt._id).lean();
    assert.ok(stored.auditEnqueuedAt instanceof Date, 'the receipt is fenced from later scans');
  });

  it('★ re-running repair after a lost receipt marker does not duplicate the audit', async () => {
    const receipt = await completedImport();
    await recoverProductImportAudits({ olderThanMs: 0, businessId: owner.businessId });

    // Simulate a crash after the outbox row was written but before the receipt
    // marker was stored: the repair sees the same import again.
    await ProductImport.updateOne({ _id: receipt._id }, { $unset: { auditEnqueuedAt: 1 } });
    const again = await recoverProductImportAudits({
      olderThanMs: 0,
      businessId: owner.businessId,
    });
    assert.equal(again.scanned, 1);
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: auditKey(receipt),
      }),
      1,
    );
    assert.equal(
      await AuditOutbox.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: auditKey(receipt),
      }),
      1,
    );
  });

  it('★ delivers an enqueued event left behind by a crash before the AuditLog write', async () => {
    const receipt = await completedImport();
    const event = productImportAuditEvent(receipt.toObject());
    await enqueueAuditOnce(event);
    await ProductImport.updateOne({ _id: receipt._id }, { $set: { auditEnqueuedAt: new Date() } });

    const first = await flushAuditOutbox({ businessId: owner.businessId, limit: 10 });
    assert.ok(first.scanned >= 1);
    assert.ok(first.delivered >= 1);
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: event.dedupeKey,
      }),
      1,
    );

    const second = await flushAuditOutbox({ businessId: owner.businessId, limit: 10 });
    assert.equal(second.delivered, 0, 'a delivered row is not replayed');
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: event.dedupeKey,
      }),
      1,
    );
  });

  it('★ reclaims a stale SENDING claim after the AuditLog insert committed', async () => {
    const receipt = await completedImport();
    const event = productImportAuditEvent(receipt.toObject());
    const outbox = await enqueueAuditOnce(event);
    await AuditLog.create({
      businessId: event.businessId,
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
      dedupeKey: event.dedupeKey,
    });
    await AuditOutbox.updateOne(
      { _id: outbox._id },
      { $set: { status: 'SENDING', claimedAt: new Date(Date.now() - 2 * 60_000) } },
    );

    const flushed = await flushAuditOutbox({ businessId: owner.businessId, limit: 10 });
    assert.ok(flushed.delivered >= 1);
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: event.dedupeKey,
      }),
      1,
      'the retry returns the existing audit row rather than appending another'
    );
    assert.equal(
      (await AuditOutbox.findById(outbox._id).lean()).status,
      'DELIVERED',
    );
  });

  it('★ retries a FAILED row and concurrent deliveries append one audit', async () => {
    const receipt = await completedImport();
    const event = productImportAuditEvent(receipt.toObject());
    const outbox = await enqueueAuditOnce(event);
    await AuditOutbox.updateOne(
      { _id: outbox._id },
      {
        $set: {
          status: 'FAILED',
          lastError: 'MongoServerError',
          availableAt: new Date(Date.now() - 1000),
        },
      },
    );

    const retried = await flushAuditOutbox({ businessId: owner.businessId, limit: 10 });
    assert.ok(retried.delivered >= 1);
    assert.equal((await AuditOutbox.findById(outbox._id).lean()).status, 'DELIVERED');

    const concurrentReceipt = await completedImport();
    const concurrentEvent = productImportAuditEvent(concurrentReceipt.toObject());
    await Promise.all(
      Array.from({ length: 8 }, () => enqueueAndDeliverAudit(concurrentEvent)),
    );
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: concurrentEvent.dedupeKey,
      }),
      1,
    );
    assert.equal(
      await AuditOutbox.countDocuments({
        businessId: new ObjectId(owner.businessId),
        dedupeKey: concurrentEvent.dedupeKey,
      }),
      1,
    );
  });

  it('★ a keyed movement completes with one audit and repairs a lost hand-off', async () => {
    const product = await newProduct();
    const location = await newLocation();
    const key = uniqueName('outbox-move');
    const first = await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: product.id,
      locationId: location.id,
      quantity: 3,
      idempotencyKey: key,
    });

    const receipt = await StockMovementOperation.findOne({
      businessId: new ObjectId(owner.businessId),
      requestKey: key,
    }).lean();
    assert.ok(receipt);
    assert.equal(receipt.auditTracked, true);
    assert.ok(receipt.auditEnqueuedAt instanceof Date);

    const dedupeKey = await clearMovementAudit(receipt);
    assert.equal(
      await AuditLog.countDocuments({ dedupeKey }),
      0,
      'the simulated crash leaves the completed receipt as the only durable evidence',
    );

    // A retry returns the stored response and repairs the audit from the same
    // receipt; it must not apply the movement a second time.
    const replay = await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: product.id,
      locationId: location.id,
      quantity: 3,
      idempotencyKey: key,
    });
    assert.equal(String(replay.transaction.id), String(first.transaction.id));
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
    assert.equal((await AuditOutbox.findOne({ dedupeKey }).lean()).status, 'DELIVERED');

    // Re-deliver the same event concurrently: the unique outbox key and
    // recordAuditOnce must still leave exactly one audit row.
    await clearMovementAudit(receipt);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueueAndDeliverMovementAudit(
          receipt._id,
          { transaction: first.transaction, previousQuantity: first.previousQuantity, newQuantity: first.newQuantity },
          first.transaction.id,
        ),
      ),
    );
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
    assert.equal(
      await AuditOutbox.countDocuments({ dedupeKey }),
      1,
    );

    // The recovery sweep is the backstop for a crash where no retry arrives.
    await clearMovementAudit(receipt);
    const summaries = await Promise.all(
      Array.from({ length: 8 }, () =>
        recoverMovementAudits({ olderThanMs: 0, businessId: owner.businessId, limit: 10 }),
      ),
    );
    assert.ok(summaries.every((summary) => summary.failed === 0));
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
  });

  it('★ a PO receive completes with one audit and repairs a lost hand-off on replay and recovery', async () => {
    const supplier = await newSupplier();
    const location = await newLocation();
    const product = await newProduct();
    const po = await mkOpenPo({
      supplierId: supplier.id,
      locationId: location.id,
      items: [{ productId: product.id, quantityOrdered: 2 }],
    });
    const key = uniqueName('outbox-receive');
    const result = await purchaseOrderService.receive(
      owner.businessId,
      owner.userId,
      po.id,
      {
        lines: [{ productId: product.id, quantity: 2 }],
        reference: 'OUTBOX-INV',
        idempotencyKey: key,
      },
    );
    assert.equal(result.allReceived, true);

    const stored = await PurchaseOrder.findById(po.id).lean();
    const receiveId = stored.receipts[0].receiveId;
    assert.ok(receiveId, 'new receipts carry the durable receive identity');
    const dedupeKey = `po-receive:${String(po.id)}:${String(receiveId)}`;
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
    assert.equal((await AuditOutbox.findOne({ dedupeKey }).lean()).status, 'DELIVERED');

    // Crash after the receipt and before the audit hand-off: no audit, no outbox
    // row, and the PO receipt is the durable evidence.
    await clearPoAudit(po.id, dedupeKey);
    const replayed = await purchaseOrderService.receive(
      owner.businessId,
      owner.userId,
      po.id,
      {
        lines: [{ productId: product.id, quantity: 2 }],
        reference: 'OUTBOX-INV',
        idempotencyKey: key,
      },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
    assert.equal((await AuditOutbox.findOne({ dedupeKey }).lean()).status, 'DELIVERED');

    // No retry: concurrent recovery passes still produce exactly one event.
    await clearPoAudit(po.id, dedupeKey);
    const summaries = await Promise.all(
      Array.from({ length: 8 }, () =>
        recoverPoReceiveAudits({ olderThanMs: 0, businessId: owner.businessId, limit: 10 }),
      ),
    );
    assert.ok(summaries.every((summary) => summary.failed === 0));
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
    assert.equal(await AuditOutbox.countDocuments({ dedupeKey }), 1);
  });

  it('★ a partial multi-line PO receive repairs exactly the applied lines once on replay and concurrent recovery', async () => {
    const supplier = await newSupplier();
    const location = await newLocation();
    const firstProduct = await newProduct();
    const secondProduct = await newProduct();
    const untouchedProduct = await newProduct();
    const po = await mkOpenPo({
      supplierId: supplier.id,
      locationId: location.id,
      items: [
        { productId: firstProduct.id, quantityOrdered: 2 },
        { productId: secondProduct.id, quantityOrdered: 2 },
        { productId: untouchedProduct.id, quantityOrdered: 2 },
      ],
    });
    const key = uniqueName('outbox-partial-receive');
    const body = {
      lines: [
        { productId: firstProduct.id, quantity: 2 },
        { productId: secondProduct.id, quantity: 2 },
      ],
      reference: 'OUTBOX-PARTIAL',
      idempotencyKey: key,
    };

    const partial = await purchaseOrderService.receive(
      owner.businessId,
      owner.userId,
      po.id,
      body,
    );
    assert.equal(partial.allReceived, false, 'the third line keeps the PO OPEN');
    assert.equal(partial.applied.length, 2);

    const stored = await PurchaseOrder.findById(po.id).lean();
    assert.equal(stored.receipts.length, 2, 'one receipt per finalized line');
    const receiveIds = new Set(stored.receipts.map((receipt) => String(receipt.receiveId)));
    assert.equal(receiveIds.size, 1, 'both applied lines share one receive identity');
    const receiveId = stored.receipts[0].receiveId;
    const dedupeKey = `po-receive:${String(po.id)}:${String(receiveId)}`;

    const assertOneAppliedAudit = async () => {
      assert.equal(await AuditLog.countDocuments({ dedupeKey }), 1);
      const audit = await AuditLog.findOne({ dedupeKey }).lean();
      assert.equal(audit.metadata.status, 'OPEN');
      assert.deepEqual(
        audit.metadata.receivedLines
          .map((line) => ({ productId: String(line.productId), quantity: line.quantity }))
          .sort((a, b) => a.productId.localeCompare(b.productId)),
        [
          { productId: String(firstProduct.id), quantity: 2 },
          { productId: String(secondProduct.id), quantity: 2 },
        ].sort((a, b) => a.productId.localeCompare(b.productId)),
      );
      assert.equal(
        await AuditOutbox.countDocuments({ dedupeKey }),
        1,
        'the batch has one outbox row, not one per line',
      );
    };

    await assertOneAppliedAudit();

    // Crash after both receipts were durable but before the batch hand-off.
    await clearPoAudit(po.id, dedupeKey);
    assert.equal(await AuditLog.countDocuments({ dedupeKey }), 0);

    const replayed = await purchaseOrderService.receive(
      owner.businessId,
      owner.userId,
      po.id,
      body,
    );
    assert.equal(replayed.replayed, true, 'the stored receipts replay the same operation');
    assert.equal(replayed.applied.length, 2);
    await assertOneAppliedAudit();

    // No retry at all: concurrent repair passes must not split or duplicate the batch.
    await clearPoAudit(po.id, dedupeKey);
    const summaries = await Promise.all(
      Array.from({ length: 8 }, () =>
        recoverPoReceiveAudits({ olderThanMs: 0, businessId: owner.businessId, limit: 10 }),
      ),
    );
    assert.ok(summaries.every((summary) => summary.failed === 0));
    await assertOneAppliedAudit();
    assert.equal(
      await AuditLog.countDocuments({
        businessId: new ObjectId(owner.businessId),
        action: 'PURCHASE_ORDER_RECEIVED',
        entityId: String(po.id),
      }),
      1,
      'exactly one receive audit exists for the PO',
    );
  });

  it('★ DELIVERED rows have bounded retention while FAILED rows are never expired', async () => {
    const indexes = await AuditOutbox.collection.indexes();
    const ttl = indexes.find((index) => index.key?.deliveredAt === 1);
    assert.ok(ttl, 'audit_outbox must declare a deliveredAt TTL index');
    assert.equal(ttl.expireAfterSeconds, AUDIT_OUTBOX_DELIVERED_RETENTION_SECONDS);
    assert.deepEqual(ttl.partialFilterExpression, { status: 'DELIVERED' });

    const triage = indexes.find(
      (index) => index.key?.status === 1 && index.key?.updatedAt === 1,
    );
    assert.ok(triage, 'FAILED rows need an age-ordered operator triage index');

    const failed = await AuditOutbox.create({
      businessId: new ObjectId(owner.businessId),
      dedupeKey: uniqueName('ttl-failed'),
      action: 'PRODUCTS_IMPORTED',
      entityType: 'PRODUCT_IMPORT',
      status: 'FAILED',
      attempts: 1,
      availableAt: new Date(),
      lastError: 'MongoServerError',
    });
    assert.equal(failed.deliveredAt, undefined, 'FAILED rows are outside the TTL boundary');
    await failed.deleteOne();
  });
});
