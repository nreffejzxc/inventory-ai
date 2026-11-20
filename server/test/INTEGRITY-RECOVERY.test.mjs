// Data-integrity hardening: transfer journals, abandoned PO claims, receive
// fingerprints, category archive policy, audit-failure monitoring and price
// quality. DB-backed over the real app and real MongoDB.
//
// The recovery cases deliberately construct the exact intermediate states a
// crashed process leaves behind. They assert the rule that makes recovery safe:
// an exact undo is allowed, a row that moved afterwards is never overwritten,
// and an unprovable state becomes REQUIRES_ATTENTION.

import 'dotenv/config';

import mongoose from 'mongoose';
import { it, before, after } from 'node:test';
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
import { ROLES } from '../src/constants/roles.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import StockTransferOperation from '../src/models/stockTransferOperation.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import AuditFailure from '../src/models/auditFailure.model.ts';
import Product from '../src/models/product.model.ts';
import {
  recoverTransferOperation,
  recoverStaleTransferOperations,
} from '../src/services/stockTransferRecovery.service.ts';
import { recoverStalePurchaseOrderClaims } from '../src/services/purchaseOrderClaimRecovery.service.ts';
import { priceQualityReport } from '../src/services/priceQuality.service.ts';
import { monitorAuditFailure, summarizeAuditFailures } from '../src/services/auditFailure.service.ts';
import { purchaseOrderService } from '../src/services/purchase-orders.service.ts';
import { productService } from '../src/services/product.service.ts';
import { executeTool } from '../src/services/ai/tools.ts';
import inventoryService from '../src/services/inventory.service.ts';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;

async function newProduct(body) {
  const res = await api('POST', '/api/products', { token: owner.token, body: { currency: 'PHP', ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

/** A pre-rule/imported row: the API now refuses this, but history still contains it. */
async function newLegacyProduct(body) {
  await Product.collection.insertOne({
    businessId: oid(owner.businessId),
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...body,
  });
}

async function newLocation() {
  const res = await api('POST', '/api/locations', { token: owner.token, body: { name: uniqueName('IR-loc') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function stockIn(productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-in', {
    token: owner.token,
    body: { productId, locationId, quantity, reason: 'recovery suite' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function inventoryRow(productId, locationId) {
  return Inventory.findOne({ businessId: oid(owner.businessId), productId: oid(productId), locationId: oid(locationId) });
}

async function makeTransferFixture(sourceQty = 10) {
  const product = await newProduct({ name: uniqueName('IR-transfer') });
  const from = await newLocation();
  const to = await newLocation();
  await stockIn(product.id, from.id, sourceQty);
  const source = await inventoryRow(product.id, from.id);
  return { product, from, to, source };
}

function transferJournal({ product, from, to, source, quantity, state }) {
  const operationId = new ObjectId();
  const sourceNew = source.quantity - quantity;
  return {
    operationId,
    sourceNew,
    create: StockTransferOperation.create({
      _id: operationId,
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      fromLocationId: oid(from.id),
      toLocationId: oid(to.id),
      quantity,
      reference: uniqueName('IR-ref'),
      state,
      createdBy: oid(owner.userId),
      sourceRowId: source._id,
      sourcePreviousQuantity: source.quantity,
      sourceNewQuantity: sourceNew,
    }),
  };
}

before(async () => {
  if (!dbOk) return;
  owner = await registerOwner(api, tracker);
});

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('INTEGRITY — transfer journal recovery', dbOk, () => {
  it('undoes a source debit exactly when the destination never landed', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const journal = transferJournal({ product, from, to, source, quantity: 3, state: 'SOURCE_DEBITED' });
    await journal.create;

    await Inventory.updateOne(
      { _id: source._id, businessId: oid(owner.businessId) },
      { $inc: { quantity: -3 }, $addToSet: { transferOperationIds: journal.operationId } }
    );

    const recovered = await recoverTransferOperation(journal.operationId);
    assert.equal(recovered.action, 'compensated');
    assert.equal((await inventoryRow(product.id, from.id)).quantity, 10);
    assert.equal(await inventoryRow(product.id, to.id), null);
    const stored = await StockTransferOperation.findById(journal.operationId);
    assert.equal(stored.state, 'COMPENSATED');
    assert.equal(stored.sourceRowId.toString(), String(source._id));
  });

  it('finishes both inventory legs and writes the paired ledger rows', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const journal = transferJournal({ product, from, to, source, quantity: 4, state: 'DESTINATION_CREDITED' });
    await journal.create;

    await Inventory.updateOne(
      { _id: source._id, businessId: oid(owner.businessId) },
      { $inc: { quantity: -4 }, $addToSet: { transferOperationIds: journal.operationId } }
    );
    const destination = await Inventory.findOneAndUpdate(
      { businessId: oid(owner.businessId), productId: oid(product.id), locationId: oid(to.id) },
      { $inc: { quantity: 4 }, $addToSet: { transferOperationIds: journal.operationId } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    await StockTransferOperation.updateOne(
      { _id: journal.operationId },
      {
        $set: {
          destinationRowId: destination._id,
          destinationPreviousQuantity: 0,
          destinationNewQuantity: 4,
          destinationCreated: true,
        },
      }
    );

    const recovered = await recoverTransferOperation(journal.operationId);
    assert.equal(recovered.action, 'completed');
    assert.equal((await inventoryRow(product.id, from.id)).quantity, 6);
    assert.equal((await inventoryRow(product.id, to.id)).quantity, 4);
    assert.equal(
      await InventoryTransaction.countDocuments({
        businessId: oid(owner.businessId),
        transferOperationId: journal.operationId,
        type: 'TRANSFER',
      }),
      2
    );
    const stored = await StockTransferOperation.findById(journal.operationId);
    assert.equal(stored.state, 'COMPLETED');
    assert.ok(stored.response);
    assert.equal((await inventoryRow(product.id, from.id)).transferOperationIds.length, 0);
  });

  it('refuses an inexact undo and flags the operation instead of overwriting newer stock', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const journal = transferJournal({ product, from, to, source, quantity: 2, state: 'SOURCE_DEBITED' });
    await journal.create;

    await Inventory.updateOne(
      { _id: source._id, businessId: oid(owner.businessId) },
      { $inc: { quantity: -2 }, $addToSet: { transferOperationIds: journal.operationId } }
    );
    // A later legitimate movement built on the debited row.
    await Inventory.updateOne({ _id: source._id }, { $set: { quantity: 42 } });

    const recovered = await recoverTransferOperation(journal.operationId);
    assert.equal(recovered.action, 'flagged');
    assert.equal((await inventoryRow(product.id, from.id)).quantity, 42);
    assert.equal((await StockTransferOperation.findById(journal.operationId)).state, 'REQUIRES_ATTENTION');

    const summary = await recoverStaleTransferOperations({ olderThanMs: 0, now: new Date(Date.now() + 1000) });
    assert.ok(summary.scanned >= 0, 'the reaper remains callable with an attention row present');
  });

  it('replays a completed transfer for the same request and refuses a reused key whose request changed', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const key = uniqueName('IR-transfer-key');
    const body = {
      productId: product.id,
      fromLocationId: from.id,
      toLocationId: to.id,
      quantity: 3,
      reason: 'idempotent transfer',
    };
    const first = await inventoryService.transfer(owner.businessId, owner.userId, {
      ...body,
      idempotencyKey: key,
    });
    const replay = await inventoryService.transfer(owner.businessId, owner.userId, {
      ...body,
      idempotencyKey: key,
    });
    assert.equal(replay.transaction.id, first.transaction.id);
    assert.equal(replay.destinationTransaction.id, first.destinationTransaction.id);
    assert.equal((await inventoryRow(product.id, from.id)).quantity, source.quantity - 3);
    assert.equal((await inventoryRow(product.id, to.id)).quantity, 3);

    await assert.rejects(
      inventoryService.transfer(owner.businessId, owner.userId, {
        ...body,
        quantity: 4,
        idempotencyKey: key,
      }),
      (err) => err.status === 422 && err.code === 'IDEMPOTENCY_KEY_REUSED'
    );
    assert.equal((await inventoryRow(product.id, from.id)).quantity, source.quantity - 3);
    assert.equal((await inventoryRow(product.id, to.id)).quantity, 3);
  });

  it('does not start a fresh transfer while an earlier journal needs attention', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const key = uniqueName('IR-attention-key');
    const operationId = new ObjectId();
    await StockTransferOperation.create({
      _id: operationId,
      businessId: oid(owner.businessId),
      requestKey: key,
      productId: oid(product.id),
      fromLocationId: oid(from.id),
      toLocationId: oid(to.id),
      quantity: 2,
      reference: uniqueName('IR-attention-ref'),
      state: 'REQUIRES_ATTENTION',
      createdBy: oid(owner.userId),
      sourceRowId: source._id,
      sourcePreviousQuantity: source.quantity,
      sourceNewQuantity: source.quantity - 2,
    });

    await assert.rejects(
      inventoryService.transfer(owner.businessId, owner.userId, {
        productId: product.id,
        fromLocationId: from.id,
        toLocationId: to.id,
        quantity: 2,
        idempotencyKey: key,
      }),
      (err) => err.status === 409 && err.code === 'TRANSFER_REQUIRES_ATTENTION'
    );
    assert.equal((await inventoryRow(product.id, from.id)).quantity, source.quantity);
    assert.equal(await inventoryRow(product.id, to.id), null);
  });

  it('does not accept an unmarked ledger pair whose quantities are not the journal’s legs', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const journal = transferJournal({ product, from, to, source, quantity: 2, state: 'LEDGER_WRITTEN' });
    await journal.create;

    // This is the crash window after the ledger rows were written and the
    // inventory markers were cleared, but before COMPLETED was stored. Without a
    // marker the rows themselves must prove the legs; a two-row count is not proof.
    await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(from.id),
      type: 'TRANSFER',
      quantity: 2,
      previousQuantity: 1,
      newQuantity: 9,
      transferOperationId: journal.operationId,
      reference: uniqueName('IR-unmarked-ledger'),
      userId: oid(owner.userId),
    });
    await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(to.id),
      type: 'TRANSFER',
      quantity: 2,
      previousQuantity: 0,
      newQuantity: 2,
      transferOperationId: journal.operationId,
      reference: uniqueName('IR-unmarked-ledger'),
      userId: oid(owner.userId),
    });

    const recovered = await recoverTransferOperation(journal.operationId);
    assert.equal(recovered.action, 'flagged');
    assert.equal((await StockTransferOperation.findById(journal.operationId)).state, 'REQUIRES_ATTENTION');
    assert.equal((await inventoryRow(product.id, from.id)).quantity, 10);
    assert.equal(await inventoryRow(product.id, to.id), null);
  });

  it('does not accept a ledger pair whose quantities are not the journal’s legs', async () => {
    const { product, from, to, source } = await makeTransferFixture(10);
    const journal = transferJournal({ product, from, to, source, quantity: 2, state: 'DESTINATION_CREDITED' });
    await journal.create;
    await Inventory.updateOne(
      { _id: source._id, businessId: oid(owner.businessId) },
      { $inc: { quantity: -2 }, $addToSet: { transferOperationIds: journal.operationId } }
    );
    const destination = await Inventory.findOneAndUpdate(
      { businessId: oid(owner.businessId), productId: oid(product.id), locationId: oid(to.id) },
      { $inc: { quantity: 2 }, $addToSet: { transferOperationIds: journal.operationId } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    await StockTransferOperation.updateOne(
      { _id: journal.operationId },
      {
        $set: {
          destinationRowId: destination._id,
          destinationPreviousQuantity: 0,
          destinationNewQuantity: 2,
          destinationCreated: true,
        },
      }
    );
    // Both rows exist, but the source row claims the wrong prior quantity. It is
    // not proof of this journal's leg and must not complete the transfer.
    await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(from.id),
      type: 'TRANSFER',
      quantity: 2,
      previousQuantity: 1,
      newQuantity: 9,
      transferOperationId: journal.operationId,
      reference: uniqueName('IR-bad-ledger'),
      userId: oid(owner.userId),
    });
    await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(to.id),
      type: 'TRANSFER',
      quantity: 2,
      previousQuantity: 0,
      newQuantity: 2,
      transferOperationId: journal.operationId,
      reference: uniqueName('IR-bad-ledger'),
      userId: oid(owner.userId),
    });

    const recovered = await recoverTransferOperation(journal.operationId);
    assert.equal(recovered.action, 'flagged');
    assert.equal((await StockTransferOperation.findById(journal.operationId)).state, 'REQUIRES_ATTENTION');
    assert.equal((await inventoryRow(product.id, from.id)).quantity, 8);
    assert.equal((await inventoryRow(product.id, to.id)).quantity, 2);
  });
});

dbSuite('INTEGRITY — abandoned PO receive claims', dbOk, () => {
  async function poFixture({ ordered = 5, committed = 3, phase = 'MOVED', quantity = 3 } = {}) {
    const supplierRes = await api('POST', '/api/suppliers', {
      token: owner.token,
      body: { name: uniqueName('IR-sup') },
    });
    assert.equal(supplierRes.status, 201, JSON.stringify(supplierRes.json));
    const product = await newProduct({ name: uniqueName('IR-po') });
    const location = await newLocation();
    const claimId = new ObjectId();
    const createdAt = new Date(Date.now() - 60 * 60 * 1000);
    const po = await PurchaseOrder.create({
      businessId: oid(owner.businessId),
      number: uniqueName('PO-IR'),
      supplierId: oid(supplierRes.json.id),
      locationId: oid(location.id),
      status: 'OPEN',
      items: [
        {
          productId: oid(product.id),
          productName: product.name,
          quantityOrdered: ordered,
          quantityReceived: 0,
          quantityCommitted: committed,
        },
      ],
      claims: [
        {
          _id: claimId,
          productId: oid(product.id),
          quantity,
          createdBy: oid(owner.userId),
          phase,
          createdAt,
        },
      ],
    });
    return { po, claimId, product, location };
  }

  it('undoes an abandoned claim’s exact stock-in and releases the reservation', async () => {
    const { po, claimId, product, location } = await poFixture();
    await Inventory.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(location.id),
      quantity: 7,
      reservedQuantity: 0,
    });
    const txn = await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(location.id),
      type: 'STOCK_IN',
      quantity: 3,
      previousQuantity: 4,
      newQuantity: 7,
      reference: po.number,
      purchaseOrderClaimId: claimId,
      userId: oid(owner.userId),
    });

    const summary = await recoverStalePurchaseOrderClaims({
      olderThanMs: 60_000,
      now: new Date(),
    });
    assert.ok(summary.scanned >= 1);
    assert.ok(summary.undone >= 1);
    assert.equal((await inventoryRow(product.id, location.id)).quantity, 4);
    assert.equal(await InventoryTransaction.countDocuments({ _id: txn._id }), 0);
    const afterPo = await PurchaseOrder.findById(po._id);
    assert.equal(afterPo.claims.length, 0);
    assert.equal(afterPo.items[0].quantityCommitted, 0);
    assert.equal(
      await AuditLog.countDocuments({
        businessId: oid(owner.businessId),
        action: 'PURCHASE_ORDER_CLAIM_RECOVERED',
        'metadata.claimId': String(claimId),
      }),
      1
    );
  });

  it('releases a claim that never moved stock', async () => {
    const { po, claimId, product } = await poFixture({
      committed: 2,
      phase: 'CLAIMED',
      quantity: 2,
    });
    const summary = await recoverStalePurchaseOrderClaims({ olderThanMs: 60_000 });
    assert.ok(summary.released >= 1);
    const afterPo = await PurchaseOrder.findById(po._id);
    assert.equal(afterPo.claims.length, 0);
    assert.equal(afterPo.items[0].quantityCommitted, 0);
    assert.equal(await Inventory.countDocuments({ productId: oid(product.id) }), 0);
    assert.ok(claimId);
  });

  it('flags a moved claim when the inventory row changed after its stock-in', async () => {
    const { po, claimId, product, location } = await poFixture();
    await Inventory.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(location.id),
      quantity: 9,
      reservedQuantity: 0,
    });
    await InventoryTransaction.create({
      businessId: oid(owner.businessId),
      productId: oid(product.id),
      locationId: oid(location.id),
      type: 'STOCK_IN',
      quantity: 3,
      previousQuantity: 4,
      newQuantity: 7,
      purchaseOrderClaimId: claimId,
      userId: oid(owner.userId),
    });

    const summary = await recoverStalePurchaseOrderClaims({ olderThanMs: 60_000 });
    assert.ok(summary.flagged >= 1);
    const afterPo = await PurchaseOrder.findById(po._id);
    assert.equal(afterPo.claims[0].phase, 'REQUIRES_ATTENTION');
    assert.equal((await inventoryRow(product.id, location.id)).quantity, 9);
  });
});

dbSuite('INTEGRITY — receive keys and fingerprints', dbOk, () => {
  async function openPo() {
    const supplierRes = await api('POST', '/api/suppliers', {
      token: owner.token,
      body: { name: uniqueName('IR-rcv-sup') },
    });
    assert.equal(supplierRes.status, 201, JSON.stringify(supplierRes.json));
    const product = await newProduct({ name: uniqueName('IR-rcv') });
    const location = await newLocation();
    const created = await api('POST', '/api/purchase-orders', {
      token: owner.token,
      body: {
        supplierId: supplierRes.json.id,
        locationId: location.id,
        items: [{ productId: product.id, quantityOrdered: 10 }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const issued = await api('POST', `/api/purchase-orders/${created.json.id}/issue`, { token: owner.token });
    assert.equal(issued.status, 200, JSON.stringify(issued.json));
    return { po: issued.json, product, location };
  }

  it('refuses a reused key whose request changed', async () => {
    const { po, product } = await openPo();
    const key = uniqueName('IR-key');
    const first = await purchaseOrderService.receive(owner.businessId, owner.userId, po.id, {
      lines: [{ productId: product.id, quantity: 2 }],
      reference: 'INV-A',
      idempotencyKey: key,
    });
    assert.equal(first.applied.length, 1);

    await assert.rejects(
      purchaseOrderService.receive(owner.businessId, owner.userId, po.id, {
        lines: [{ productId: product.id, quantity: 3 }],
        reference: 'INV-A',
        idempotencyKey: key,
      }),
      (err) => err.status === 422 && err.code === 'IDEMPOTENCY_KEY_REUSED'
    );
  });

  it('requires an Idempotency-Key on the HTTP receive route', async () => {
    const { po, product } = await openPo();
    const res = await api('POST', `/api/purchase-orders/${po.id}/receive`, {
      token: owner.token,
      body: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('★ scopes a receive key to its tenant and never receives another tenant’s PO', async () => {
    const { po, product, location } = await openPo();
    const other = await registerOwner(api, tracker);

    // A PO that belongs entirely to the second tenant.
    const otherSupplier = await api('POST', '/api/suppliers', {
      token: other.token,
      body: { name: uniqueName('IR-cross-sup') },
    });
    assert.equal(otherSupplier.status, 201, JSON.stringify(otherSupplier.json));
    const otherProduct = await api('POST', '/api/products', {
      token: other.token,
      body: { name: uniqueName('IR-cross-product'), currency: 'PHP' },
    });
    assert.equal(otherProduct.status, 201, JSON.stringify(otherProduct.json));
    const otherLocation = await api('POST', '/api/locations', {
      token: other.token,
      body: { name: uniqueName('IR-cross-loc') },
    });
    assert.equal(otherLocation.status, 201, JSON.stringify(otherLocation.json));
    const otherPo = await api('POST', '/api/purchase-orders', {
      token: other.token,
      body: {
        supplierId: otherSupplier.json.id,
        locationId: otherLocation.json.id,
        items: [{ productId: otherProduct.json.id, quantityOrdered: 5 }],
      },
    });
    assert.equal(otherPo.status, 201, JSON.stringify(otherPo.json));
    const otherIssued = await api('POST', `/api/purchase-orders/${otherPo.json.id}/issue`, {
      token: other.token,
    });
    assert.equal(otherIssued.status, 200, JSON.stringify(otherIssued.json));

    // The SAME key is a different operation in each tenant: both must apply.
    const key = uniqueName('IR-cross-key');
    const secondTenant = await api('POST', `/api/purchase-orders/${otherPo.json.id}/receive`, {
      token: other.token,
      headers: { 'idempotency-key': key },
      body: { lines: [{ productId: otherProduct.json.id, quantity: 2 }] },
    });
    assert.equal(secondTenant.status, 200, JSON.stringify(secondTenant.json));

    const firstTenant = await api('POST', `/api/purchase-orders/${po.id}/receive`, {
      token: owner.token,
      headers: { 'idempotency-key': key },
      body: { lines: [{ productId: product.id, quantity: 3 }] },
    });
    assert.equal(firstTenant.status, 200, JSON.stringify(firstTenant.json));

    // The second tenant cannot name the first tenant's PO, even with its own key.
    const foreign = await api('POST', `/api/purchase-orders/${po.id}/receive`, {
      token: other.token,
      headers: { 'idempotency-key': uniqueName('IR-cross-foreign') },
      body: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));

    assert.equal(
      (await Inventory.findOne({
        businessId: oid(other.businessId),
        productId: oid(otherProduct.json.id),
        locationId: oid(otherLocation.json.id),
      }))?.quantity,
      2
    );
    assert.equal((await inventoryRow(product.id, location.id))?.quantity, 3);
  });
});

dbSuite('INTEGRITY — category archive policy', dbOk, () => {
  it('refuses archiving a category with ACTIVE products, then allows it once they are archived', async () => {
    const category = await api('POST', '/api/categories', {
      token: owner.token,
      body: { name: uniqueName('IR-cat') },
    });
    assert.equal(category.status, 201, JSON.stringify(category.json));
    const product = await newProduct({
      name: uniqueName('IR-cat-product'),
      categoryId: category.json.id,
    });

    const blocked = await api('POST', `/api/categories/${category.json.id}/archive`, { token: owner.token });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'CATEGORY_HAS_ACTIVE_PRODUCTS');

    const archivedProduct = await api('POST', `/api/products/${product.id}/archive`, { token: owner.token });
    assert.equal(archivedProduct.status, 200, JSON.stringify(archivedProduct.json));
    const allowed = await api('POST', `/api/categories/${category.json.id}/archive`, { token: owner.token });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.equal(allowed.json.status, 'ARCHIVED');
  });
});

dbSuite('INTEGRITY — audit failure monitoring and price quality', dbOk, () => {
  it('persists a sanitized audit gap and summarizes it per tenant', async () => {
    const wrote = await monitorAuditFailure({
      businessId: owner.businessId,
      action: 'INVENTORY_TRANSFERRED',
      entityType: 'INVENTORY_TRANSACTION',
      entityId: new ObjectId(),
      error: new Error('mongodb://user:secret@host/private should never be stored'), // secret-guard:allow (redaction test fixture; not a credential)
    });
    assert.equal(wrote, true);
    const row = await AuditFailure.findOne({ businessId: oid(owner.businessId) });
    assert.ok(row);
    assert.equal(row.errorCode, 'AUDIT_WRITE_FAILED');
    assert.doesNotMatch(JSON.stringify(row.toObject()), /secret|mongodb:\/\//);

    const summary = await summarizeAuditFailures({
      businessId: owner.businessId,
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(summary.total, 1);
    assert.deepEqual(summary.byAction, [{ action: 'INVENTORY_TRANSFERRED', count: 1 }]);

    // The operator summary is tenant-scoped: another tenant's gap must never
    // inflate this tenant's count or leak into its by-tenant rows.
    const otherOwner = await registerOwner(api, tracker);
    await monitorAuditFailure({
      businessId: otherOwner.businessId,
      action: 'INVENTORY_TRANSFERRED',
      entityType: 'INVENTORY_TRANSACTION',
      error: new Error('other tenant failure'),
    });
    const isolated = await summarizeAuditFailures({
      businessId: owner.businessId,
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(isolated.total, 1, 'another tenant’s audit gap must not change this tenant’s total');
    assert.deepEqual(isolated.byTenant, [{ businessId: owner.businessId, count: 1 }]);
    const otherSummary = await summarizeAuditFailures({
      businessId: otherOwner.businessId,
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(otherSummary.total, 1);
  });

  it('reports missing/zero prices, missing and invalid currencies without writing', async () => {
    const prefix = uniqueName('IR-price');
    await newProduct({ name: `${prefix} PHP`, sellingPrice: 100, currency: 'PHP' });
    await newLegacyProduct({ name: `${prefix} unrecorded`, sellingPrice: 50 });
    await newProduct({ name: `${prefix} zero`, sellingPrice: 0, currency: 'PHP' });
    // The schema rejects a malformed currency on write. A legacy/imported row
    // can still carry one, which is exactly the case this read-only report must
    // see; insert at the raw collection level to construct that historical state.
    await Product.collection.insertOne({
      businessId: oid(owner.businessId),
      name: `${prefix} invalid`,
      sellingPrice: 75,
      currency: 'US',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const before = await Product.countDocuments({ businessId: oid(owner.businessId) });
    const report = await priceQualityReport({ businessId: owner.businessId });
    assert.ok(report.totalActiveProducts >= 4);
    assert.ok(report.zeroPrice >= 1);
    assert.ok(report.missingCurrency >= 1);
    assert.ok(report.invalidCurrency >= 1);
    assert.ok(report.currencies.some((row) => row.currency === null));
    assert.ok(report.currencies.some((row) => row.currency === 'US'));
    assert.ok(report.samples.some((row) => row.problem === 'ZERO_PRICE'));
    assert.equal(await Product.countDocuments({ businessId: oid(owner.businessId) }), before);
  });

  it('ranks ties by name and blocks a mixed-currency ranking', async () => {
    const tie = uniqueName('TieRank');
    await newProduct({ name: `${tie} Beta`, sellingPrice: 100, currency: 'PHP' });
    await newProduct({ name: `${tie} Alpha`, sellingPrice: 100, currency: 'PHP' });
    await newProduct({ name: `${tie} Zeta`, sellingPrice: 200, currency: 'PHP' });
    await newProduct({ name: `${tie} NoPrice`, sellingPrice: 0, currency: 'PHP' });

    const ctx = { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER };
    const ranked = await executeTool('findProducts', { keywords: tie, sort: 'price_asc' }, ctx);
    assert.equal(ranked.ok, true, JSON.stringify(ranked));
    const names = ranked.result.items.map((row) => row.name);
    assert.deepEqual(
      names,
      [`${tie} Alpha`, `${tie} Beta`, `${tie} Zeta`],
      'equal prices must be deterministic by name, and a zero price is not ranked'
    );
    assert.equal(ranked.result.priceCurrency, 'PHP');
    assert.equal(ranked.result.priceRankBlocked, undefined);

    const mixed = uniqueName('MixRank');
    await newProduct({ name: `${mixed} USD`, sellingPrice: 10, currency: 'USD' });
    await newProduct({ name: `${mixed} PHP`, sellingPrice: 900, currency: 'PHP' });
    await newLegacyProduct({ name: `${mixed} Unknown`, sellingPrice: 50 });

    const blocked = await executeTool('findProducts', { keywords: mixed, sort: 'price_asc' }, ctx);
    assert.equal(blocked.ok, true, JSON.stringify(blocked));
    assert.equal(blocked.result.priceRankBlocked, true);
    assert.ok(blocked.result.priceCurrencies.some((group) => group.currency === null));
    assert.equal(blocked.result.priceCurrency, undefined);

    const groups = await productService.priceCurrencies(owner.businessId, { terms: [tie] });
    // The zero-price row is not part of a price ranking, so it is absent from
    // the currency groups used to decide whether ranking is safe.
    assert.deepEqual(groups, [{ currency: 'PHP', count: 3 }]);
  });
});
