// Bounded audit-outbox and repair health.
//
// The health record answers the operational questions the outbox exists for:
// how many rows are in each state, how old the oldest one is, how many FAILED
// rows have stopped converging, and which completed receipts still have no
// audit hand-off. It is read-only and returns aggregates only.

import 'dotenv/config';

import mongoose from 'mongoose';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import AuditOutbox from '../src/models/auditOutbox.model.ts';
import ProductImport from '../src/models/productImport.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import StockMovementOperation from '../src/models/stockMovementOperation.model.ts';
import {
  AUDIT_FAILED_OVERDUE_MS,
  AUDIT_UNMARKED_OVERDUE_MS,
  readAuditHealth,
  recordAuditRepairPass,
  resetAuditRepairTotals,
} from '../src/services/auditHealth.service.ts';

const { ObjectId } = mongoose.Types;
const dbOk = await ensureDb();

async function cleanup(businessId) {
  await Promise.all([
    AuditOutbox.deleteMany({ businessId }),
    ProductImport.deleteMany({ businessId }),
    StockMovementOperation.deleteMany({ businessId }),
    PurchaseOrder.deleteMany({ businessId }),
  ]);
}

function outboxRow(businessId, status, at, extra = {}) {
  return {
    businessId,
    dedupeKey: `health-${status}-${new ObjectId()}`,
    action: 'PRODUCTS_IMPORTED',
    entityType: 'PRODUCT_IMPORT',
    status,
    attempts: status === 'FAILED' ? 2 : 0,
    availableAt: at,
    ...(status === 'DELIVERED' ? { deliveredAt: at } : {}),
    ...(status === 'SENDING' ? { claimedAt: at } : {}),
    ...(status === 'FAILED' ? { lastError: 'MongoServerError' } : {}),
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

after(async () => {
  await disconnectDb();
});

dbSuite('AUDIT HEALTH — bounded outbox and repair monitoring', dbOk, () => {
  it('★ counts each status, reports oldest ages, and alerts on overdue FAILED rows and unmarked receipts', async () => {
    resetAuditRepairTotals();
    const businessId = new ObjectId();
    const now = new Date('2026-11-23T12:00:00.000Z');
    const old = new Date(now.getTime() - 20 * 60_000);
    const fresh = new Date(now.getTime() - 60_000);
    const receiveId = new ObjectId();

    try {
      await AuditOutbox.collection.insertMany([
        outboxRow(businessId, 'PENDING', fresh),
        outboxRow(businessId, 'FAILED', old),
        outboxRow(businessId, 'DELIVERED', fresh),
        outboxRow(businessId, 'SENDING', fresh, { claimedAt: old }),
      ]);
      await ProductImport.collection.insertOne({
        businessId,
        key: `health-import-${new ObjectId()}`,
        fingerprint: `health-fingerprint-${new ObjectId()}`,
        fileName: 'health.csv',
        status: 'COMPLETED',
        totalRows: 1,
        createdProducts: [],
        stockOperations: [],
        failures: [],
        createdAt: old,
        updatedAt: old,
      });
      await StockMovementOperation.collection.insertOne({
        businessId,
        requestKey: `health-move-${new ObjectId()}`,
        requestFingerprint: `health-move-fingerprint-${new ObjectId()}`,
        kind: 'STOCK_IN',
        state: 'COMPLETED',
        createdBy: new ObjectId(),
        productId: new ObjectId(),
        locationId: new ObjectId(),
        quantity: 2,
        auditTracked: true,
        previousQuantity: 0,
        newQuantity: 2,
        createdAt: old,
        updatedAt: old,
      });
      await PurchaseOrder.collection.insertOne({
        businessId,
        number: `PO-HEALTH-${new ObjectId()}`,
        supplierId: new ObjectId(),
        locationId: new ObjectId(),
        status: 'OPEN',
        items: [],
        claims: [],
        receipts: [
          {
            receivedAt: old,
            userId: new ObjectId(),
            reference: 'HEALTH',
            receiveId,
            lines: [
              {
                productId: new ObjectId(),
                quantity: 1,
                inventoryTransactionId: new ObjectId(),
                previousQuantity: 0,
                newQuantity: 1,
              },
            ],
          },
          // A second finalized batch on the SAME order. Health counts receipt
          // batches, not purchase orders; this fresh batch is unmarked but not
          // overdue, while the order's own updatedAt is old.
          {
            receivedAt: fresh,
            userId: new ObjectId(),
            reference: 'HEALTH-2',
            receiveId: new ObjectId(),
            lines: [
              {
                productId: new ObjectId(),
                quantity: 1,
                inventoryTransactionId: new ObjectId(),
                previousQuantity: 0,
                newQuantity: 1,
              },
            ],
          },
        ],
        createdAt: old,
        updatedAt: old,
      });

      const health = await readAuditHealth({ now, businessId });

      assert.deepEqual(health.outbox.counts, {
        PENDING: 1,
        SENDING: 1,
        DELIVERED: 1,
        FAILED: 1,
      });
      assert.equal(health.outbox.oldest.FAILED.ageMs, 20 * 60_000);
      assert.equal(health.outbox.oldest.PENDING.ageMs, 60_000);
      assert.equal(health.failedOverdue.count, 1);
      assert.equal(health.failedOverdue.oldestAgeMs, 20 * 60_000);
      assert.equal(health.unmarked.total, 4);
      assert.equal(health.unmarked.overdue, 3);
      assert.deepEqual(health.unmarked.byProducer, {
        productImports: 1,
        movements: 1,
        poReceipts: 2,
      });
      assert.deepEqual(health.unmarked.overdueByProducer, {
        productImports: 1,
        movements: 1,
        poReceipts: 1,
      });
      assert.equal(health.unmarked.oldestAgeMs, 20 * 60_000);
      assert.equal(health.alerts.length, 2);
      assert.match(health.alerts[0], /1 FAILED audit-outbox row/);
      assert.match(health.alerts[0], /15 minutes/);
      assert.match(health.alerts[1], /3 completed receipt/);
      assert.match(health.alerts[1], /imports=1, movements=1, poReceipts=1/);

      const totals = recordAuditRepairPass({
        movementAudits: { scanned: 2, enqueued: 1, delivered: 1, failed: 0, skipped: 0 },
        poAudits: { scanned: 3, groups: 1, enqueued: 1, delivered: 1, failed: 0, skipped: 0 },
        importAudits: { scanned: 4, enqueued: 2, delivered: 2, failed: 0 },
        auditOutbox: { scanned: 5, delivered: 4, failed: 1 },
      });
      assert.equal(totals.passes, 1);
      assert.equal(totals.movement.enqueued, 1);
      assert.equal(totals.po.groups, 1);
      assert.equal(totals.imports.enqueued, 2);
      assert.equal(totals.outbox.failed, 1);
      assert.equal(totals.outbox.skipped, 0);

      const second = await readAuditHealth({ now, businessId });
      assert.equal(second.repair.passes, 1);
      assert.equal(second.repair.outbox.delivered, 4);
      assert.ok(second.repair.lastPassAt);
    } finally {
      await cleanup(businessId);
      resetAuditRepairTotals();
    }
  });

  it('★ reports no alerts when failures are recent and every completed receipt is marked', async () => {
    resetAuditRepairTotals();
    const businessId = new ObjectId();
    const now = new Date('2026-11-23T12:00:00.000Z');
    const fresh = new Date(now.getTime() - 60_000);

    try {
      await AuditOutbox.collection.insertOne(outboxRow(businessId, 'FAILED', fresh));
      await ProductImport.collection.insertOne({
        businessId,
        key: `health-marked-import-${new ObjectId()}`,
        fingerprint: `health-marked-fingerprint-${new ObjectId()}`,
        fileName: 'marked.csv',
        status: 'COMPLETED',
        auditEnqueuedAt: fresh,
        createdAt: fresh,
        updatedAt: fresh,
      });
      await StockMovementOperation.collection.insertOne({
        businessId,
        requestKey: `health-marked-move-${new ObjectId()}`,
        requestFingerprint: `health-marked-fingerprint-${new ObjectId()}`,
        kind: 'STOCK_IN',
        state: 'COMPLETED',
        createdBy: new ObjectId(),
        productId: new ObjectId(),
        locationId: new ObjectId(),
        quantity: 1,
        auditTracked: true,
        auditEnqueuedAt: fresh,
        createdAt: fresh,
        updatedAt: fresh,
      });
      await PurchaseOrder.collection.insertOne({
        businessId,
        number: `PO-HEALTH-MARKED-${new ObjectId()}`,
        supplierId: new ObjectId(),
        locationId: new ObjectId(),
        status: 'RECEIVED',
        items: [],
        claims: [],
        receipts: [
          {
            receivedAt: fresh,
            userId: new ObjectId(),
            reference: 'MARKED',
            receiveId: new ObjectId(),
            auditEnqueuedAt: fresh,
            lines: [
              {
                productId: new ObjectId(),
                quantity: 1,
                inventoryTransactionId: new ObjectId(),
                previousQuantity: 0,
                newQuantity: 1,
              },
            ],
          },
        ],
        createdAt: fresh,
        updatedAt: fresh,
      });

      const health = await readAuditHealth({ now, businessId });

      assert.equal(health.failedOverdue.count, 0);
      assert.equal(health.unmarked.total, 0);
      assert.equal(health.unmarked.overdue, 0);
      assert.deepEqual(health.alerts, []);
      assert.equal(health.outbox.counts.FAILED, 1);
      assert.equal(health.failedOverdue.thresholdMs, AUDIT_FAILED_OVERDUE_MS);
      assert.equal(health.unmarked.thresholdMs, AUDIT_UNMARKED_OVERDUE_MS);
    } finally {
      await cleanup(businessId);
      resetAuditRepairTotals();
    }
  });
});
