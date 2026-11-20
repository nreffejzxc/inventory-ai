// Phase 07A — Inventory integrity hardening: failure-injection tests for H3, H4,
// H5 and L5. Verifies that when a stock movement's durability step fails, the
// compensation logic keeps inventory quantity, transaction history and audit
// behavior consistent:
//
//   H3 — an audit-log failure after the InventoryTransaction was created must
//        never trigger a rollback (which would orphan the transaction).
//   H4 — compensation is conditional/quantity-anchored: it must never blindly
//        overwrite a newer quantity committed by a concurrent movement.
//   H5 — compensation can never create a negative quantity.
//   L5 — a failed first stock-in must not leave a zero-quantity orphan row.
//
// Integration tests against the real shipped app + MongoDB (DB-backed; fails
// loudly when MongoDB is unreachable — Phase 07F / M9). Failures are injected by
// stubbing the model
// statics InventoryTransaction.create / AuditLog.create (runtime property
// lookups inside recordMovement / recordAudit), always restored afterwards.

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
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import inventoryService from '../src/services/inventory.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { currency: 'PHP', name: uniqueName('P07A'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business, over = {}) {
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: uniqueName('Loc07A'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function rowQuantity(productId, locationId) {
  const doc = await Inventory.findOne({
    businessId: owner.businessId,
    productId,
    locationId,
  });
  return doc ? doc.quantity : null;
}

async function txnCount(productId, locationId, type) {
  return InventoryTransaction.countDocuments({
    businessId: owner.businessId,
    productId,
    locationId,
    type,
  });
}

async function auditCountForProduct(action, productId) {
  return AuditLog.countDocuments({
    businessId: owner.businessId,
    action,
    'metadata.productId': String(productId),
  });
}

/** Replace model.create with `impl`; returns a restore function. */
function stubCreate(model, impl) {
  const original = model.create.bind(model);
  model.create = impl;
  return () => {
    model.create = original;
  };
}

/** Make every AuditLog.create call throw (injected audit failure). */
function stubAuditToThrow() {
  return stubCreate(AuditLog, async () => {
    const err = new Error('injected audit-log write failure');
    err.name = 'InjectedAuditError';
    throw err;
  });
}

/** Make every InventoryTransaction.create call throw (injected txn failure). */
function stubTxnToThrow() {
  return stubCreate(InventoryTransaction, async () => {
    const err = new Error('injected inventory-transaction write failure');
    err.name = 'InjectedTxnError';
    throw err;
  });
}

/**
 * Replace InventoryTransaction.create so that the FIRST invocation runs
 * `beforeThrow` (typically a real, fully-successful concurrent movement that
 * needs its own create to pass through) and then throws; every later invocation
 * delegates to the real Mongoose create. Returns a restore function.
 */
function stubTxnFirstCallRunsThenThrows(beforeThrow) {
  const realCreate = InventoryTransaction.create.bind(InventoryTransaction);
  let calls = 0;
  InventoryTransaction.create = async function (...args) {
    calls += 1;
    if (calls === 1) {
      if (beforeThrow) await beforeThrow();
      const err = new Error('injected inventory-transaction write failure');
      err.name = 'InjectedTxnError';
      throw err;
    }
    return realCreate(...args);
  };
  return () => {
    InventoryTransaction.create = realCreate;
  };
}

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 07A — inventory compensation failure-injection', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
  });

  it('normal successful stock-in still writes quantity, transaction and audit (baseline)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const res = await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 10,
      reason: 'seed',
    });
    assert.equal(res.newQuantity, 10);
    assert.equal(await rowQuantity(p, l), 10);
    assert.equal(await txnCount(p, l, 'STOCK_IN'), 1);
    assert.equal(await auditCountForProduct('INVENTORY_STOCK_IN', p), 1);
  });

  it('H3: audit failure after transaction creation never rolls back the durable movement', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const restore = stubAuditToThrow();
    try {
      const res = await inventoryService.stockIn(owner.businessId, owner.userId, {
        productId: p,
        locationId: l,
        quantity: 10,
      });
      // The movement still succeeds: its InventoryTransaction is the durable
      // record and must NOT be compensated away (that is what used to orphan it).
      assert.equal(res.newQuantity, 10);
      assert.equal(await rowQuantity(p, l), 10);
      assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'the movement must keep exactly one transaction');
      assert.equal(
        await auditCountForProduct('INVENTORY_STOCK_IN', p),
        0,
        'the injected audit write failed, so no audit row was created'
      );
    } finally {
      restore();
    }
  });

  it('H3+H5: failed stock-in compensation restores quantity with no stray txn/audit', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 10,
    });
    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.stockIn(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 5,
        }),
        /injected inventory-transaction write failure/
      );
      assert.equal(await rowQuantity(p, l), 10, 'quantity must return to the pre-movement value');
      assert.ok((await rowQuantity(p, l)) >= 0, 'quantity must never be negative');
      assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'no transaction may survive a failed movement');
      assert.equal(await auditCountForProduct('INVENTORY_STOCK_IN', p), 1, 'no audit for the failed movement');
    } finally {
      restore();
    }
  });

  it('H3+H5: failed stock-out compensation restores quantity with no stray txn/audit', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 10,
    });
    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.stockOut(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 4,
        }),
        /injected inventory-transaction write failure/
      );
      assert.equal(await rowQuantity(p, l), 10, 'quantity must return to the pre-movement value');
      assert.ok((await rowQuantity(p, l)) >= 0);
      assert.equal(await txnCount(p, l, 'STOCK_OUT'), 0);
      assert.equal(await auditCountForProduct('INVENTORY_STOCK_OUT', p), 0);
    } finally {
      restore();
    }
  });

  it('H3+H5: failed adjustment compensation restores the previous quantity', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 10,
    });
    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.adjust(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 3,
        }),
        /injected inventory-transaction write failure/
      );
      assert.equal(await rowQuantity(p, l), 10, 'adjustment must be reverted to the previous quantity');
      assert.ok((await rowQuantity(p, l)) >= 0);
      assert.equal(await txnCount(p, l, 'ADJUSTMENT'), 0);
      assert.equal(await auditCountForProduct('INVENTORY_ADJUSTED', p), 0);
    } finally {
      restore();
    }
  });

  it('H4: compensation never clobbers a concurrent committed movement (stock-in rollback no-ops)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 10,
    });

    const restore = stubTxnFirstCallRunsThenThrows(async () => {
      // The failing stock-in has already bumped the row to 15. Before it throws,
      // let a REAL concurrent stock-out of 3 commit (its transaction create is
      // call #2 and passes through). The compensation that follows must see the
      // row at 12, not 15, and must not roll it back.
      const concurrent = await inventoryService.stockOut(owner.businessId, owner.userId, {
        productId: p,
        locationId: l,
        quantity: 3,
        reason: 'concurrent sale',
      });
      assert.equal(concurrent.newQuantity, 12);
    });

    try {
      await assert.rejects(
        inventoryService.stockIn(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 5,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    // The concurrent movement's committed quantity (12) must survive; a blind
    // rollback to 10 would have destroyed it.
    assert.equal(await rowQuantity(p, l), 12, 'the concurrent committed movement must be preserved');
    assert.equal(await txnCount(p, l, 'STOCK_OUT'), 1, 'the concurrent stock-out keeps its transaction');
    assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'the failed stock-in leaves no transaction');
    const concurrentTxn = await InventoryTransaction.findOne({
      businessId: owner.businessId,
      productId: p,
      locationId: l,
      type: 'STOCK_OUT',
    });
    assert.equal(concurrentTxn.previousQuantity, 15);
    assert.equal(concurrentTxn.newQuantity, 12);
    assert.equal(await auditCountForProduct('INVENTORY_STOCK_OUT', p), 1, 'the concurrent movement is audited');
  });

  it('H5: compensation cannot drive the row negative when a concurrent drain lands', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await inventoryService.stockIn(owner.businessId, owner.userId, {
      productId: p,
      locationId: l,
      quantity: 5,
    });

    const restore = stubTxnFirstCallRunsThenThrows(async () => {
      // The failing stock-in has already bumped the row 5 -> 10. Before it
      // throws, a REAL concurrent stock-out drains all 10 (row -> 0). The
      // stock-in's compensation is anchored at quantity 10; the row is now 0, so
      // it must no-op instead of writing 10 - 5 = 5, and certainly never a
      // negative under a blind rollback.
      const concurrent = await inventoryService.stockOut(owner.businessId, owner.userId, {
        productId: p,
        locationId: l,
        quantity: 10,
        reason: 'drain',
      });
      assert.equal(concurrent.newQuantity, 0);
    });

    try {
      await assert.rejects(
        inventoryService.stockIn(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 5,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(p, l), 0, 'quantity is drained to zero and never goes negative');
    assert.ok((await rowQuantity(p, l)) >= 0);
    assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'the failed stock-in leaves no transaction');
    const drainTxn = await InventoryTransaction.findOne({
      businessId: owner.businessId,
      productId: p,
      locationId: l,
      type: 'STOCK_OUT',
    });
    assert.equal(drainTxn.previousQuantity, 10);
    assert.equal(drainTxn.newQuantity, 0);
  });

  it('L5: failed first stock-in removes the created row instead of leaving a zero-quantity orphan', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    assert.equal(await rowQuantity(p, l), null, 'no inventory row exists yet');

    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.stockIn(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 7,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(p, l), null, 'the freshly created row must be removed entirely');
    assert.equal(await txnCount(p, l, 'STOCK_IN'), 0);
    assert.equal(await auditCountForProduct('INVENTORY_STOCK_IN', p), 0);
  });

  it('L5+H4: first stock-in rollback preserves a concurrent build on the created row', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);

    const restore = stubTxnFirstCallRunsThenThrows(async () => {
      // The failing first stock-in created the row at 7. Before it throws, a
      // REAL concurrent stock-in of 3 builds on it (row 7 -> 10). The delete
      // compensation is anchored at quantity 7 + reservedQuantity 0, so it must
      // no-op and keep the row that now carries the concurrent stock.
      const concurrent = await inventoryService.stockIn(owner.businessId, owner.userId, {
        productId: p,
        locationId: l,
        quantity: 3,
        reason: 'concurrent build',
      });
      assert.equal(concurrent.newQuantity, 10);
    });

    try {
      await assert.rejects(
        inventoryService.stockIn(owner.businessId, owner.userId, {
          productId: p,
          locationId: l,
          quantity: 7,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(p, l), 10, 'the row carrying the concurrent stock must survive');
    const concurrentTxn = await InventoryTransaction.findOne({
      businessId: owner.businessId,
      productId: p,
      locationId: l,
      type: 'STOCK_IN',
    });
    assert.equal(concurrentTxn.previousQuantity, 7);
    assert.equal(concurrentTxn.newQuantity, 10);
    assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'only the concurrent stock-in has a transaction');
    assert.equal(await auditCountForProduct('INVENTORY_STOCK_IN', p), 1);
  });

  it('duplicate-key retry re-creates a winning row that vanished before the retry, never orphaning the ledger', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const realFindOneAndUpdate = Inventory.findOneAndUpdate.bind(Inventory);
    let calls = 0;

    // First upsert: a concurrent winner inserts the row at 7, then its own
    // transaction write fails and its compensation removes the row. The losing
    // upsert sees a duplicate key and must retry the FULL upsert, not a
    // no-upsert update that returns null for the vanished row.
    Inventory.findOneAndUpdate = async function (...args) {
      calls += 1;
      if (calls === 1) {
        await Inventory.create({
          businessId: owner.businessId,
          productId: p,
          locationId: l,
          quantity: 7,
        });
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        await Inventory.deleteOne({ businessId: owner.businessId, productId: p, locationId: l });
        throw err;
      }
      return realFindOneAndUpdate(...args);
    };

    try {
      const res = await inventoryService.stockIn(owner.businessId, owner.userId, {
        productId: p,
        locationId: l,
        quantity: 5,
        reason: 'duplicate-key retry',
      });
      assert.equal(res.previousQuantity, 0, 'the vanished winner left no quantity behind');
      assert.equal(res.newQuantity, 5);
      assert.equal(res.createdRow, true, 'the retry created the row itself');
      assert.equal(await rowQuantity(p, l), 5, 'the retry must leave the stock on the shelf');
      assert.equal(await txnCount(p, l, 'STOCK_IN'), 1, 'the movement has exactly one ledger row');
      assert.equal(await auditCountForProduct('INVENTORY_STOCK_IN', p), 1);
    } finally {
      Inventory.findOneAndUpdate = realFindOneAndUpdate;
    }
  });
});
