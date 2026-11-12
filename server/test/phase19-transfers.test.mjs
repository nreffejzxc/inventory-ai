// Phase 19 — Stock transfers between locations. Integration tests against the
// real shipped app + MongoDB (DB-backed; fails loudly when MongoDB is
// unreachable — Phase 07F / M9).
//
// Covers the transfer contract end to end: the two paired inventory legs, the
// paired TRANSFER ledger rows correlated by `reference`, the single
// INVENTORY_TRANSFERRED audit event, validation and the same-location guard,
// insufficient-source-stock rejection with zero partial mutation, tenant
// isolation (cross-business location/product, client businessId ignored), the
// INVENTORY_MANAGE RBAC gate, and — the reason this suite exists — the
// atomicity/compensation behavior, using the same failure-injection technique as
// Phase 07A (`stub*` helpers below, restored in every `finally`).
//
// The compensation assertions deliberately mirror Phase 07A's H3/H4/H5/L5
// semantics: a rollback is quantity-anchored, so a concurrent movement landing
// inside the compensation window is preserved rather than clobbered, and a
// compensated debit can never drive a row negative.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import { ROLES } from '../src/constants/roles.ts';
import inventoryService from '../src/services/inventory.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner; // Business A — the acting business
let other; // Business B — isolation counterpart
let admin;
let manager;
let staff;

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { name: uniqueName('P19'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business, over = {}) {
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: uniqueName('Loc19'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function stockIn(business, productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-in', {
    token: business.token,
    body: { productId, locationId, quantity, reason: 'seed' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

function transfer(business, body) {
  return api('POST', '/api/inventory/transfer', { token: business.token, body });
}

/** On-hand quantity for one product+location, or null when no row exists. */
async function rowQuantity(businessId, productId, locationId) {
  const doc = await Inventory.findOne({ businessId, productId, locationId });
  return doc ? doc.quantity : null;
}

async function txnCount(businessId, productId, type) {
  return InventoryTransaction.countDocuments({ businessId, productId, type });
}

/**
 * INVENTORY_TRANSFERRED audit rows for ONE product. Scoped by product because
 * the suite shares a single business across tests, so a business-wide count
 * would carry rows in from earlier cases.
 */
async function transferredAuditCount(businessId, productId) {
  return AuditLog.countDocuments({
    businessId,
    action: 'INVENTORY_TRANSFERRED',
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

/** Make every InventoryTransaction.create call throw (injected ledger failure). */
function stubTxnToThrow() {
  return stubCreate(InventoryTransaction, async () => {
    const err = new Error('injected inventory-transaction write failure');
    err.name = 'InjectedTxnError';
    throw err;
  });
}

/**
 * Replace InventoryTransaction.create so the FIRST call passes through to the
 * real create and every LATER call throws. For a transfer this leaves exactly
 * one ledger row written (the source leg) before the failure, which is the
 * partial-ledger case the compensation must clean up.
 */
function stubTxnSecondCallThrows() {
  const realCreate = InventoryTransaction.create.bind(InventoryTransaction);
  let calls = 0;
  InventoryTransaction.create = async function (...args) {
    calls += 1;
    if (calls === 1) return realCreate(...args);
    const err = new Error('injected inventory-transaction write failure');
    err.name = 'InjectedTxnError';
    throw err;
  };
  return () => {
    InventoryTransaction.create = realCreate;
  };
}

/**
 * Replace InventoryTransaction.create so the FIRST call runs `beforeThrow`
 * (typically a real, fully-successful concurrent movement) and then throws —
 * the same technique Phase 07A uses to prove compensation never clobbers a
 * movement that committed inside the window.
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

/** Make every AuditLog.create call throw (injected audit failure). */
function stubAuditToThrow() {
  return stubCreate(AuditLog, async () => {
    const err = new Error('injected audit-log write failure');
    err.name = 'InjectedAuditError';
    throw err;
  });
}

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 19 — stock transfers between locations', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
  });

  it('moves stock between locations: source -N, destination +N, paired ledger rows, one audit', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const res = await transfer(owner, {
      productId: p,
      fromLocationId: from,
      toLocationId: to,
      quantity: 4,
      reason: 'rebalance',
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    // The two inventory legs landed with the right arithmetic.
    assert.equal(await rowQuantity(owner.businessId, p, from), 6, 'source must decrease by N');
    assert.equal(await rowQuantity(owner.businessId, p, to), 4, 'destination must increase by N');
    assert.equal(res.json.previousQuantity, 10);
    assert.equal(res.json.newQuantity, 6);
    assert.equal(res.json.destinationPreviousQuantity, 0);
    assert.equal(res.json.destinationNewQuantity, 4);

    // Exactly two TRANSFER rows — not a STOCK_OUT + STOCK_IN pair.
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 2, 'one TRANSFER row per leg');
    assert.equal(await txnCount(owner.businessId, p, 'STOCK_OUT'), 0, 'a transfer is not a stock-out');
    assert.equal(await txnCount(owner.businessId, p, 'STOCK_IN'), 1, 'only the seeding stock-in exists');

    // Both rows share the transfer correlation reference returned to the client.
    const rows = await InventoryTransaction.find({ businessId: owner.businessId, productId: p, type: 'TRANSFER' }).sort({
      createdAt: 1,
    });
    assert.equal(rows[0].reference, res.json.reference, 'the source leg carries the transfer reference');
    assert.equal(rows[1].reference, res.json.reference, 'the destination leg carries the same reference');
    assert.ok(res.json.reference, 'the response exposes the correlation reference');

    // Each leg records its own location and its own before/after quantities.
    const sourceLeg = rows.find((r) => String(r.locationId) === String(from));
    const destLeg = rows.find((r) => String(r.locationId) === String(to));
    assert.ok(sourceLeg && destLeg, 'one row per location');
    assert.equal(sourceLeg.previousQuantity, 10);
    assert.equal(sourceLeg.newQuantity, 6);
    assert.equal(sourceLeg.quantity, 4);
    assert.equal(destLeg.previousQuantity, 0);
    assert.equal(destLeg.newQuantity, 4);
    assert.equal(destLeg.quantity, 4);

    // ONE audit event for the transfer as a whole.
    assert.equal(await transferredAuditCount(owner.businessId, p), 1, 'exactly one INVENTORY_TRANSFERRED audit row');
    const audit = await AuditLog.findOne({
      businessId: owner.businessId,
      action: 'INVENTORY_TRANSFERRED',
      'metadata.productId': String(p),
    });
    assert.equal(audit.entityType, 'INVENTORY_TRANSACTION');
    assert.equal(String(audit.userId), String(owner.userId));
    assert.equal(audit.metadata.productId, String(p));
    assert.equal(audit.metadata.fromLocationId, String(from));
    assert.equal(audit.metadata.toLocationId, String(to));
    assert.equal(audit.metadata.reference, res.json.reference);
    assert.deepEqual(
      audit.metadata.inventoryTransactionIds.slice().sort(),
      rows.map((r) => String(r._id)).sort(),
      'the audit links both ledger rows'
    );
  });

  it('a second transfer onward from the destination keeps the ledger consistent', async () => {
    const p = await newProduct(owner);
    const a = await newLocation(owner);
    const b = await newLocation(owner);
    const c = await newLocation(owner);
    await stockIn(owner, p, a, 9);

    assert.equal((await transfer(owner, { productId: p, fromLocationId: a, toLocationId: b, quantity: 9 })).status, 201);
    assert.equal((await transfer(owner, { productId: p, fromLocationId: b, toLocationId: c, quantity: 5 })).status, 201);

    assert.equal(await rowQuantity(owner.businessId, p, a), 0);
    assert.equal(await rowQuantity(owner.businessId, p, b), 4);
    assert.equal(await rowQuantity(owner.businessId, p, c), 5);
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 4, 'two transfers = four legs');
    assert.equal(await transferredAuditCount(owner.businessId, p), 2, 'one audit per transfer, not per leg');
  });

  it('rejects a same-location transfer without moving anything', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 5);

    const res = await transfer(owner, { productId: p, fromLocationId: l, toLocationId: l, quantity: 2 });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.ok(res.json.fields.some((f) => f.field === 'toLocationId'), 'the field problem names toLocationId');

    assert.equal(await rowQuantity(owner.businessId, p, l), 5, 'the row is untouched');
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0);
  });

  it('the service itself also refuses a same-location transfer (defence in depth)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 5);

    await assert.rejects(
      inventoryService.transfer(owner.businessId, owner.userId, {
        productId: p,
        fromLocationId: l,
        toLocationId: l,
        quantity: 1,
      }),
      (err) => err.code === 'TRANSFER_SAME_LOCATION'
    );
    assert.equal(await rowQuantity(owner.businessId, p, l), 5);
  });

  it('rejects insufficient source stock with no partial mutation', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 3);

    const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 5 });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.code, 'INSUFFICIENT_STOCK');

    assert.equal(await rowQuantity(owner.businessId, p, from), 3, 'the source is untouched');
    assert.equal(await rowQuantity(owner.businessId, p, to), null, 'no destination row may be created');
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0, 'no ledger row may survive');
    assert.equal(await transferredAuditCount(owner.businessId, p), 0, 'no audit may be written');
  });

  it('rejects a transfer from a location with no inventory row (404)', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);

    const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 1 });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.equal(res.json.code, 'INVENTORY_NOT_FOUND');
    assert.equal(await rowQuantity(owner.businessId, p, to), null);
  });

  it('rejects quantities that are not a positive integer', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 5);

    for (const quantity of [0, -3, 1.5, 'many']) {
      const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity });
      assert.equal(res.status, 400, `quantity=${quantity} must be rejected`);
      assert.ok(res.json.fields.some((f) => f.field === 'quantity'), `quantity=${quantity}`);
    }
    assert.equal(await rowQuantity(owner.businessId, p, from), 5);
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0);
  });

  it("cannot reach another business's product or location", async () => {
    const p = await newProduct(owner);
    const foreignProduct = await newProduct(other);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    const foreignLocation = await newLocation(other);
    await stockIn(owner, p, from, 10);
    await stockIn(other, foreignProduct, foreignLocation, 10);

    const crossLocation = await transfer(owner, {
      productId: p,
      fromLocationId: from,
      toLocationId: foreignLocation,
      quantity: 2,
    });
    assert.equal(crossLocation.status, 404, JSON.stringify(crossLocation.json));
    assert.equal(crossLocation.json.code, 'LOCATION_NOT_FOUND');

    const crossProduct = await transfer(owner, {
      productId: foreignProduct,
      fromLocationId: from,
      toLocationId: to,
      quantity: 2,
    });
    assert.equal(crossProduct.status, 404, JSON.stringify(crossProduct.json));
    assert.equal(crossProduct.json.code, 'PRODUCT_NOT_FOUND');

    assert.equal(await rowQuantity(owner.businessId, p, from), 10, "the acting business's stock is untouched");
    assert.equal(await rowQuantity(other.businessId, foreignProduct, foreignLocation), 10, "the other business's stock is untouched");
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0);
    assert.equal(await txnCount(other.businessId, foreignProduct, 'TRANSFER'), 0);
  });

  it('ignores a client-supplied businessId and acts on the session business', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 8);

    const res = await transfer(owner, {
      productId: p,
      fromLocationId: from,
      toLocationId: to,
      quantity: 3,
      businessId: other.businessId,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(await rowQuantity(owner.businessId, p, from), 5, 'the session business moved');
    assert.equal(await rowQuantity(owner.businessId, p, to), 3);
    assert.equal(
      await InventoryTransaction.countDocuments({ businessId: other.businessId, type: 'TRANSFER' }),
      0,
      'nothing may be written under the client-supplied businessId'
    );
  });

  it('RBAC: OWNER, ADMIN and MANAGER may transfer; STAFF is 403; unauthenticated is 401', async () => {
    const holder = { OWNER: owner, ADMIN: admin, MANAGER: manager };
    for (const [role, user] of Object.entries(holder)) {
      const p = await newProduct(owner);
      const from = await newLocation(owner);
      const to = await newLocation(owner);
      await stockIn(owner, p, from, 10);

      const res = await transfer(user, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 });
      assert.equal(res.status, 201, `${role} must be allowed: ${JSON.stringify(res.json)}`);
      assert.equal(await rowQuantity(owner.businessId, p, from), 6, `${role} moved the source`);
      assert.equal(await rowQuantity(owner.businessId, p, to), 4, `${role} credited the destination`);
    }

    // STAFF is denied by the INVENTORY_MANAGE gate, and nothing moves.
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const denied = await transfer(staff, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(await rowQuantity(owner.businessId, p, from), 10, 'a denied transfer moves nothing');
    assert.equal(await rowQuantity(owner.businessId, p, to), null);
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0);

    const anon = await api('POST', '/api/inventory/transfer', {
      body: { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 },
    });
    assert.equal(anon.status, 401, JSON.stringify(anon.json));
  });

  it('injected ledger failure undoes BOTH legs and leaves no row, no audit', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.transfer(owner.businessId, owner.userId, {
          productId: p,
          fromLocationId: from,
          toLocationId: to,
          quantity: 4,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(owner.businessId, p, from), 10, 'the source debit is compensated');
    assert.equal(await rowQuantity(owner.businessId, p, to), null, 'the created destination row is removed entirely');
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0, 'no ledger row may survive');
    assert.equal(await transferredAuditCount(owner.businessId, p), 0, 'no audit for a failed transfer');
  });

  it('a failure on the SECOND ledger row removes the row already written and undoes both legs', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const restore = stubTxnSecondCallThrows();
    try {
      await assert.rejects(
        inventoryService.transfer(owner.businessId, owner.userId, {
          productId: p,
          fromLocationId: from,
          toLocationId: to,
          quantity: 4,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    // The partial ledger must not survive: a transfer with one leg recorded is
    // not a transfer, so the written row is dropped and both legs are undone.
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0, 'the partial ledger row is removed');
    assert.equal(await rowQuantity(owner.businessId, p, from), 10, 'the source debit is compensated');
    assert.equal(await rowQuantity(owner.businessId, p, to), null, 'the destination credit is undone');
    assert.equal(await transferredAuditCount(owner.businessId, p), 0);
  });

  it('a compensating transfer onto an EXISTING destination row restores it, leaving no orphan', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);
    await stockIn(owner, p, to, 5); // pre-existing destination row

    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        inventoryService.transfer(owner.businessId, owner.userId, {
          productId: p,
          fromLocationId: from,
          toLocationId: to,
          quantity: 4,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(owner.businessId, p, from), 10, 'source restored');
    assert.equal(await rowQuantity(owner.businessId, p, to), 5, 'the pre-existing destination quantity is restored, not deleted');
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0);
  });

  it('H3: an audit failure never compensates a transfer whose ledger is already durable', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const restore = stubAuditToThrow();
    try {
      const out = await inventoryService.transfer(owner.businessId, owner.userId, {
        productId: p,
        fromLocationId: from,
        toLocationId: to,
        quantity: 4,
      });
      assert.equal(out.newQuantity, 6);
    } finally {
      restore();
    }

    assert.equal(await rowQuantity(owner.businessId, p, from), 6, 'the durable transfer must stand');
    assert.equal(await rowQuantity(owner.businessId, p, to), 4);
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 2, 'both ledger rows survive an audit failure');
    assert.equal(await transferredAuditCount(owner.businessId, p), 0, 'the injected audit write failed, so no audit exists');
  });

  it('H4/H5: compensation never clobbers a concurrent drain and can never go negative', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const restore = stubTxnFirstCallRunsThenThrows(async () => {
      // Both legs have landed (source 10 -> 6, destination 0 -> 4). Before the
      // ledger write throws, a REAL concurrent stock-out drains the source
      // (6 -> 0). The source compensation is anchored at 6, so it must no-op
      // rather than restore 6 onto a row that has legitimately moved on.
      const concurrent = await inventoryService.stockOut(owner.businessId, owner.userId, {
        productId: p,
        locationId: from,
        quantity: 6,
        reason: 'concurrent sale',
      });
      assert.equal(concurrent.newQuantity, 0);
    });

    try {
      await assert.rejects(
        inventoryService.transfer(owner.businessId, owner.userId, {
          productId: p,
          fromLocationId: from,
          toLocationId: to,
          quantity: 4,
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    // The concurrent movement's committed value survives; a blind restore to 10
    // would have destroyed it, and a blind decrement could have gone negative.
    assert.equal(await rowQuantity(owner.businessId, p, from), 0, 'the concurrent drain is preserved');
    assert.ok((await rowQuantity(owner.businessId, p, from)) >= 0, 'the source is never negative');
    assert.equal(await txnCount(owner.businessId, p, 'STOCK_OUT'), 1, 'the concurrent movement keeps its ledger row');
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 0, 'the failed transfer leaves no ledger row');

    // The destination leg was untouched by the concurrent movement, so it is
    // still fully undone.
    assert.equal(await rowQuantity(owner.businessId, p, to), null, 'the destination credit is undone');
  });

  // ---------------------------------------------------------------------------
  // Dashboard Recent Activity — a transfer is ONE logical business event, even
  // though the ledger holds TWO immutable TRANSFER rows for it. Grouping happens
  // at presentation time, so the ledger rows and the History screen keep their
  // per-row contract (asserted above, and again in the History case below).
  // ---------------------------------------------------------------------------

  function dashboardSummary(business) {
    return api('GET', '/api/dashboard', { token: business.token });
  }

  /**
   * Dashboard recent-activity entries for ONE product, optionally narrowed to a
   * single movement type. This suite shares one business across every case, so
   * each assertion is scoped by product — a business-wide count would carry
   * movements in from earlier tests.
   */
  async function activityFor(business, productId, type) {
    const res = await dashboardSummary(business);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.recentActivity.filter(
      (a) => a.product?.id === String(productId) && (type === undefined || a.type === type)
    );
  }

  it('dashboard: one transfer is ONE logical activity, not one per ledger leg', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    assert.equal((await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 })).status, 201);

    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 2, 'the ledger keeps one row per leg');
    assert.equal((await activityFor(owner, p, 'TRANSFER')).length, 1, 'the dashboard reports the transfer once');
  });

  it('dashboard: both ledger legs are grouped under their shared reference', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const legs = await InventoryTransaction.find({ businessId: owner.businessId, productId: p, type: 'TRANSFER' });
    assert.equal(legs.length, 2, 'two ledger rows');
    assert.deepEqual([...new Set(legs.map((l) => l.reference))], [res.json.reference], 'both legs share one reference');

    const [activity] = await activityFor(owner, p, 'TRANSFER');
    assert.ok(activity, 'the transfer appears');
    assert.equal(activity.reference, res.json.reference, 'the activity carries the shared reference');
    assert.equal(activity.id, res.json.reference, 'one activity per reference');
  });

  it('dashboard: the logical activity reports the source, the destination and the quantity', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    assert.equal((await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 })).status, 201);

    const [activity] = await activityFor(owner, p, 'TRANSFER');
    // Source/destination are derived from the signed quantity delta rather than
    // from row order, so the classification holds however the legs were written.
    assert.equal(activity.from.id, String(from), 'the debited location is the source');
    assert.equal(activity.to.id, String(to), 'the credited location is the destination');
    assert.ok(activity.from.name && activity.to.name, 'both locations are named for display');
    assert.equal(activity.quantity, 4, 'the moved quantity is reported as a magnitude');
  });

  it('dashboard: two transfers stay two separate logical activities', async () => {
    const p = await newProduct(owner);
    const a = await newLocation(owner);
    const b = await newLocation(owner);
    const c = await newLocation(owner);
    await stockIn(owner, p, a, 10);

    assert.equal((await transfer(owner, { productId: p, fromLocationId: a, toLocationId: b, quantity: 4 })).status, 201);
    assert.equal((await transfer(owner, { productId: p, fromLocationId: b, toLocationId: c, quantity: 3 })).status, 201);
    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 4, 'two transfers = four legs');

    const activities = await activityFor(owner, p, 'TRANSFER');
    assert.equal(activities.length, 2, 'two transfers are two activities');
    assert.equal(new Set(activities.map((x) => x.reference)).size, 2, 'each transfer keeps its own reference');
    assert.equal(new Set(activities.map((x) => x.id)).size, 2, 'no logical transfer is duplicated');
    for (const activity of activities) {
      assert.ok(activity.from && activity.to, 'every activity is a complete pair');
    }
    // Newest first — the second transfer is the more recent one.
    assert.equal(activities[0].from.id, String(b));
    assert.equal(activities[0].to.id, String(c));
    assert.equal(activities[1].from.id, String(a));
    assert.equal(activities[1].to.id, String(b));
  });

  it('dashboard: stock in, stock out and adjustment stay one activity per movement, with signed change and reason', async () => {
    const p = await newProduct(owner);
    const loc = await newLocation(owner);

    await stockIn(owner, p, loc, 10);
    const out = await api('POST', '/api/inventory/stock-out', {
      token: owner.token,
      body: { productId: p, locationId: loc, quantity: 3, reason: 'sale' },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const adjusted = await api('POST', '/api/inventory/adjust', {
      token: owner.token,
      body: { productId: p, locationId: loc, quantity: 9, reason: 'count' },
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.json));

    const movement = {};
    for (const type of ['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT']) {
      const rows = await activityFor(owner, p, type);
      assert.equal(rows.length, 1, `${type} must stay one activity per ledger row`);
      movement[type] = rows[0];
    }

    // The single-row projection keeps its own location and before/after
    // quantities, now with the signed change and recorded reason the assistant
    // reads. It must not gain the transfer-only fields that would signal an
    // accidental grouping.
    const SHAPE = ['createdAt', 'delta', 'id', 'location', 'newQuantity', 'previousQuantity', 'product', 'quantity', 'reason', 'type'];
    for (const [type, activity] of Object.entries(movement)) {
      assert.deepEqual(Object.keys(activity).sort(), SHAPE, `${type} keeps its documented shape`);
      assert.equal(activity.location.id, String(loc), `${type} keeps its own location`);
      assert.equal(activity.from, undefined, `${type} must not gain a transfer source`);
      assert.equal(activity.to, undefined, `${type} must not gain a transfer destination`);
    }
    assert.equal(movement.STOCK_IN.previousQuantity, 0);
    assert.equal(movement.STOCK_IN.newQuantity, 10);
    assert.equal(movement.STOCK_IN.delta, 10);
    assert.equal(movement.STOCK_IN.reason, 'seed');
    assert.equal(movement.STOCK_OUT.previousQuantity, 10);
    assert.equal(movement.STOCK_OUT.newQuantity, 7);
    assert.equal(movement.STOCK_OUT.delta, -3);
    assert.equal(movement.STOCK_OUT.reason, 'sale');
    assert.equal(movement.ADJUSTMENT.previousQuantity, 7);
    assert.equal(movement.ADJUSTMENT.newQuantity, 9);
    assert.equal(movement.ADJUSTMENT.delta, 2);
    assert.equal(movement.ADJUSTMENT.reason, 'count');
  });

  it('dashboard: the activity limit never exposes half a transfer', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 5);

    // Five transfers = ten ledger rows, one row more than the dashboard window,
    // so the oldest leg of the oldest transfer falls outside it. A newer
    // movement for an unrelated product is what pushes it over the edge.
    for (let i = 0; i < 5; i += 1) {
      const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 1 });
      assert.equal(res.status, 201, JSON.stringify(res.json));
    }
    const unrelated = await newProduct(owner);
    await stockIn(owner, unrelated, from, 1);

    assert.equal(await txnCount(owner.businessId, p, 'TRANSFER'), 10, 'ten ledger rows exist for the product');

    const activities = await activityFor(owner, p, 'TRANSFER');
    // The window holds the newest ten rows: the unrelated stock-in plus nine of
    // the ten legs. The remaining four complete transfers must all survive.
    assert.equal(activities.length, 4, 'the limit must be met with complete transfers only');
    assert.ok(activities.every((a) => a.from && a.to), 'no activity may show half a transfer');
    assert.ok(
      activities.every((a) => a.from.id === String(from) && a.to.id === String(to)),
      'source and destination stay correct at the boundary'
    );
    assert.equal(new Set(activities.map((a) => a.reference)).size, 4, 'no logical transfer is duplicated');
  });

  it('dashboard: a transfer reference never appears twice, across products', async () => {
    const first = await newProduct(owner);
    const second = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, first, from, 4);
    await stockIn(owner, second, from, 4);

    assert.equal((await transfer(owner, { productId: first, fromLocationId: from, toLocationId: to, quantity: 2 })).status, 201);
    assert.equal((await transfer(owner, { productId: second, fromLocationId: from, toLocationId: to, quantity: 2 })).status, 201);

    const res = await dashboardSummary(owner);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const transfers = res.json.recentActivity.filter((a) => a.type === 'TRANSFER');
    assert.equal(transfers.length, 2, 'two transfers across two products');
    assert.equal(
      new Set(transfers.map((a) => a.reference)).size,
      transfers.length,
      'one activity per reference, business-wide'
    );
    assert.ok(transfers.every((a) => a.from && a.to), 'every transfer activity is a complete pair');
  });

  it('dashboard: the transfer activity exposes exactly its documented projection', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    assert.equal((await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 })).status, 201);

    const [activity] = await activityFor(owner, p, 'TRANSFER');
    // The contract the mobile screen and the AI summary tool both consume.
    assert.deepEqual(
      Object.keys(activity).sort(),
      ['createdAt', 'from', 'id', 'product', 'quantity', 'reason', 'reference', 'to', 'type'],
      'the documented logical-transfer projection'
    );
    assert.equal(activity.reason, null, 'a transfer without an entered reason reports null');
    assert.equal(activity.type, 'TRANSFER');
    assert.equal(activity.product.id, String(p));
    assert.ok(activity.product.name, 'the product is named for display');
    // A two-location event has no single location, and no single before/after —
    // `from`/`to` and the shared quantity replace them.
    assert.equal(activity.location, undefined, 'a transfer must not report one location');
    assert.equal(activity.previousQuantity, undefined);
    assert.equal(activity.newQuantity, undefined);

    // Ordered by the newest leg, so the activity sits where the event finished.
    const legs = await InventoryTransaction.find({ businessId: owner.businessId, productId: p, type: 'TRANSFER' });
    const newest = legs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    assert.equal(new Date(activity.createdAt).getTime(), newest.createdAt.getTime());
  });

  it('history: the same transfer still shows BOTH ledger rows with the shared reference', async () => {
    const p = await newProduct(owner);
    const from = await newLocation(owner);
    const to = await newLocation(owner);
    await stockIn(owner, p, from, 10);

    const res = await transfer(owner, { productId: p, fromLocationId: from, toLocationId: to, quantity: 4 });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const history = await api('GET', `/api/inventory/history?productId=${p}&type=TRANSFER`, { token: owner.token });
    assert.equal(history.status, 200, JSON.stringify(history.json));
    assert.equal(history.json.items.length, 2, 'History keeps one row per leg');
    for (const row of history.json.items) {
      assert.equal(row.type, 'TRANSFER');
      assert.equal(row.reference, res.json.reference, 'both rows share the transfer reference');
      assert.ok(row.location?.name, 'each row keeps its own location');
      assert.equal(row.quantity, 4);
    }
    assert.deepEqual(
      history.json.items.map((r) => r.location.id).sort(),
      [String(from), String(to)].sort(),
      'one row per location'
    );

    // The dashboard reports that same transfer exactly once.
    assert.equal((await activityFor(owner, p, 'TRANSFER')).length, 1);
  });
});
