// Phase 13C — Purchase-order receiving into the inventory ledger (claim-first).
//
// DB-backed suite over the real HTTP app (+ direct service calls for the
// failure-injection cases, mirroring phase07a). Receiving is CLAIM-first: each
// line reserves its remaining quantity on the PO (Op1 CLAIM, quantityCommitted +
// an embedded claim) BEFORE any inventory write, then stock-ins, then turns the
// claim into a durable receipt (Op3 FINALIZE). A lost claim never calls stock-in,
// so a rejected concurrent receive creates ZERO surviving inventory movement. Covers:
//   - partial receive advances exactly that line and is visible as a STOCK_IN
//     with the PO reference + INVENTORY_STOCK_IN audit + embedded PO receipt;
//   - full receive auto-flips OPEN -> RECEIVED; further receipt rejected;
//   - 2-line batch applies per line (one transaction + one receipt per line);
//   - state/validation guards (DRAFT/CANCELED/RECEIVED, over-remaining,
//     line-not-on-PO, archived product/location) with ZERO movement;
//   - structural 400s (lines empty/missing/duplicate/bad qty, bad id, long ref);
//   - RBAC (STAFF may receive but not manage; 401 unauthenticated) + business
//     isolation (foreign PO -> 404; body locationId/businessId ignored);
//   - concurrency: simultaneous same-line full/over-remaining receives yield
//     exactly one 200 + one 409 and the PO never over-accounts; because the
//     losing receive never moves stock, exactly ONE surviving STOCK_IN reconciles
//     on-hand 1:1 to the PO (the movement-first orphan is impossible), and the
//     loser leaves zero row/transaction/audit residue;
//   - concurrent partials summing <= ordered both succeed (no over-rejection);
//   - failure injection (phase07a seams): stock-in txn write failure -> clean
//     reject with the claim released, row restored and PO untouched; audit write
//     failure -> receive still succeeds (H3); a FINALIZE no-op (racing CANCEL)
//     -> 409 RECEIVE_CONFLICT with a full precise undo AND the claim released;
//     a mid-batch CLAIM loss -> earlier lines stay durably applied and are
//     reported as `applied`, the lost line moves nothing;
//   - a claim RELEASE is exact and idempotent: it never touches a sibling claim's
//     share, and re-releasing the same id is a no-op (Op4 by claimId).
//
// Registered MIXED in run-tests.mjs (Phase 07F: the runner exits 2 on any
// unclassified *.test.mjs).

import 'dotenv/config';

import mongoose from 'mongoose';
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
import { ROLES } from '../src/constants/roles.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import { purchaseOrderService, releaseClaim } from '../src/services/purchase-orders.service.ts';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(id);

const { dbOk, baseUrl, server } = await startServer();
const rawApi = makeApi(baseUrl);
let receiveKeySeq = 0;
/**
 * The receive route now requires an Idempotency-Key. Every existing receive in
 * this suite gets a unique one unless it deliberately names its own, so the
 * lifecycle/concurrency cases keep testing what they were written for. The
 * dedicated no-key refusal lives in INTEGRITY-RECOVERY.test.mjs.
 */
const api = (method, path, options = {}) => {
  if (method === 'POST' && /\/receive$/.test(path)) {
    const headers = { ...(options.headers || {}) };
    if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
      receiveKeySeq += 1;
      headers['Idempotency-Key'] = `p13c-${process.pid}-${Date.now()}-${receiveKeySeq}`;
    }
    return rawApi(method, path, { ...options, headers });
  }
  return rawApi(method, path, options);
};
const tracker = createTracker(dbOk);

const poUrl = (id) => `/api/purchase-orders/${id}`;

async function newSupplier(biz) {
  const res = await api('POST', '/api/suppliers', { token: biz.token, body: { name: uniqueName('S13C') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newLocation(biz) {
  const res = await api('POST', '/api/locations', { token: biz.token, body: { name: uniqueName('L13C') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(biz, over = {}) {
  const res = await api('POST', '/api/products', { token: biz.token, body: { currency: 'PHP', name: uniqueName('P13C'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

/** Create + issue a PO; returns the detail body (id, number, items, location…). */
async function mkOpenPo(biz, { supplierId, locationId, items }) {
  const created = await api('POST', '/api/purchase-orders', {
    token: biz.token,
    body: { supplierId, locationId, items },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const issued = await api('POST', `${poUrl(created.json.id)}/issue`, { token: biz.token });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.status, 'OPEN');
  return issued.json;
}

async function archive(biz, path) {
  const res = await api('POST', path, { token: biz.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

async function inventoryRow(productId, locationId) {
  return Inventory.findOne({
    businessId: oid(main.businessId),
    productId: oid(productId),
    locationId: oid(locationId),
  });
}

async function rowQuantity(businessId, productId, locationId) {
  const doc = await Inventory.findOne({
    businessId: oid(businessId),
    productId: oid(productId),
    locationId: oid(locationId),
  });
  return doc ? doc.quantity : null;
}

/** STOCK_IN transactions whose reference is this PO number (a received line). */
async function stockInsFor(businessId, number) {
  return InventoryTransaction.find({
    businessId: oid(businessId),
    reference: number,
    type: 'STOCK_IN',
  });
}

async function auditStockInsFor(businessId, productId) {
  return AuditLog.countDocuments({
    businessId: oid(businessId),
    action: 'INVENTORY_STOCK_IN',
    'metadata.productId': String(productId),
  });
}

/** Count the INVENTORY_STOCK_IN audits tied to exactly this PO's surviving txns. */
async function auditStockInsForPo(businessId, po) {
  const txns = await stockInsFor(businessId, po.number);
  const ids = txns.map((t) => String(t._id));
  if (ids.length === 0) return 0;
  return AuditLog.countDocuments({
    businessId: oid(businessId),
    action: 'INVENTORY_STOCK_IN',
    'metadata.inventoryTransactionId': { $in: ids },
  });
}

async function poDoc(id) {
  const doc = await PurchaseOrder.findById(oid(id));
  assert.ok(doc, 'expected PO to exist');
  return doc;
}

/** Replace a model static with `impl`; returns a restore function. */
function stubStatic(model, name, impl) {
  const original = model[name].bind(model);
  model[name] = impl;
  return () => {
    model[name] = original;
  };
}

function stubTxnToThrow() {
  return stubStatic(InventoryTransaction, 'create', async () => {
    const err = new Error('injected inventory-transaction write failure');
    err.name = 'InjectedTxnError';
    throw err;
  });
}

function stubAuditToThrow() {
  return stubStatic(AuditLog, 'create', async () => {
    const err = new Error('injected audit-log write failure');
    err.name = 'InjectedAuditError';
    throw err;
  });
}

/**
 * Intercept the receive's findOneAndUpdate operations (Op1 CLAIM and Op3
 * FINALIZE) to force a no-op, as a lost PO race would: `onClaim(n)` /
 * `onFinalize(n)` return true to make the n-th claim/finalize call return null.
 * Every other findOneAndUpdate (auto-flip, issue, …) always delegates to the real
 * update. The release (Op4) is an updateOne and is never intercepted. Returns a
 * restore function.
 */
function stubReceiveOps({ onClaim, onFinalize } = {}) {
  const real = PurchaseOrder.findOneAndUpdate.bind(PurchaseOrder);
  let claimCalls = 0;
  let finalizeCalls = 0;
  PurchaseOrder.findOneAndUpdate = (filter, update, opts) => {
    const inc = (update && update.$inc) || {};
    const isClaim = Boolean(update && update.$push && update.$push.claims) && inc['items.$[l].quantityCommitted'];
    const isFinalize =
      Boolean(update && update.$push && update.$push.receipts) &&
      Boolean(update && update.$pull && update.$pull.claims) &&
      inc['items.$[l].quantityReceived'];
    if (isClaim && onClaim) {
      claimCalls += 1;
      if (onClaim(claimCalls)) return null;
    }
    if (isFinalize && onFinalize) {
      finalizeCalls += 1;
      if (onFinalize(finalizeCalls)) return null;
    }
    return real(filter, update, opts);
  };
  return () => {
    PurchaseOrder.findOneAndUpdate = real;
  };
}

/**
 * Apply the FIRST FINALIZE, then throw as if the response was lost after the atomic
 * write. This is the ambiguous case a retry must survive: the receipt and stock-in are
 * durable, but the client saw a 5xx. Returns a restore function.
 */
function stubFinalizeApplyThenThrowOnce() {
  const real = PurchaseOrder.findOneAndUpdate.bind(PurchaseOrder);
  let fired = false;
  PurchaseOrder.findOneAndUpdate = (filter, update, opts) => {
    const inc = (update && update.$inc) || {};
    const isFinalize =
      Boolean(update && update.$push && update.$push.receipts) &&
      Boolean(update && update.$pull && update.$pull.claims) &&
      inc['items.$[l].quantityReceived'];
    if (!isFinalize || fired) return real(filter, update, opts);
    fired = true;
    return Promise.resolve(real(filter, update, opts)).then((doc) => {
      if (!doc) throw new Error('injected finalize no-op');
      const err = new Error('injected failure AFTER finalize applied');
      err.name = 'InjectedFinalizeAfterApply';
      throw err;
    });
  };
  return () => {
    PurchaseOrder.findOneAndUpdate = real;
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
let main; // primary business (OWNER)
let other; // isolation victim business (OWNER)
let concBiz; // dedicated business for the concurrency trials
let staffMain; // STAFF inside `main`
let managerMain; // MANAGER inside `main`

let sup; // supplier (main)
let loc; // location (main)
let cs; // supplier (concBiz)
let cl; // location (concBiz)

// A helper to snapshot a receive candidate's pre-state for zero-movement asserts.
async function movementState(businessId, productId, locationId, po) {
  const row = await rowQuantity(businessId, productId, locationId);
  const doc = await poDoc(po.id);
  return {
    row,
    txns: (await stockInsFor(businessId, po.number)).length,
    received: doc.items.map((i) => i.quantityReceived),
    committed: doc.items.map((i) => i.quantityCommitted ?? 0),
    claims: (doc.claims || []).length,
    receipts: doc.receipts.length,
  };
}

async function assertZeroMovement(beforeState, businessId, productId, locationId, po, label) {
  // The PO's own state (received / committed / claims / receipts) must be untouched.
  const doc = await poDoc(po.id);
  assert.deepEqual(doc.items.map((i) => i.quantityReceived), beforeState.received, `${label}: PO received counters unchanged`);
  assert.deepEqual(doc.items.map((i) => i.quantityCommitted ?? 0), beforeState.committed, `${label}: PO committed counters unchanged`);
  assert.equal((doc.claims || []).length, beforeState.claims, `${label}: no claims recorded`);
  assert.equal(doc.receipts.length, beforeState.receipts, `${label}: no receipt recorded`);
  assert.equal(await rowQuantity(businessId, productId, locationId), beforeState.row, `${label}: inventory row unchanged`);
  assert.equal((await stockInsFor(businessId, po.number)).length, beforeState.txns, `${label}: no transaction recorded`);
}

dbSuite('Phase 13C — purchase-order receiving over real HTTP', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    concBiz = await registerOwner(api, tracker);
    staffMain = await makeRoleUser({ role: ROLES.STAFF, businessId: main.businessId }, tracker);
    managerMain = await makeRoleUser({ role: ROLES.MANAGER, businessId: main.businessId }, tracker);

    sup = await newSupplier(main);
    loc = await newLocation(main);
    cs = await newSupplier(concBiz);
    cl = await newLocation(concBiz);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('partially receives a line: stock row, one STOCK_IN with the PO reference, audit + embedded receipt', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 10 }] });

    const res = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 4 }], reference: 'INV-1' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.allReceived, false, 'partial receive keeps the PO OPEN');
    assert.equal(res.json.applied.length, 1);
    const applied = res.json.applied[0];
    assert.equal(applied.productId, p.id);
    assert.equal(applied.quantity, 4);
    assert.equal(applied.previousQuantity, 0);
    assert.equal(applied.newQuantity, 4);
    assert.ok(applied.inventoryTransactionId);

    // Inventory row advanced exactly +4 at the PO's location.
    const row = await inventoryRow(p.id, loc.id);
    assert.equal(row.quantity, 4);
    assert.equal(String(row.locationId), loc.id);

    // Ledger: exactly one STOCK_IN referencing the PO number, with the agreed shape.
    const txns = await stockInsFor(main.businessId, po.number);
    assert.equal(txns.length, 1, 'one received line = one STOCK_IN transaction');
    const txn = txns[0];
    assert.equal(String(txn._id), applied.inventoryTransactionId);
    assert.equal(txn.quantity, 4);
    assert.equal(txn.previousQuantity, 0);
    assert.equal(txn.newQuantity, 4);
    assert.equal(txn.reason, 'PO receipt');
    assert.equal(txn.reference, po.number);
    assert.equal(String(txn.locationId), loc.id);

    // One INVENTORY_STOCK_IN audit for the movement.
    assert.equal(await auditStockInsFor(main.businessId, p.id), 1);

    // PO: status still OPEN, line advanced, receipt embedded with a pointer back.
    const doc = await poDoc(po.id);
    assert.equal(doc.status, 'OPEN');
    assert.equal(doc.items[0].quantityReceived, 4);
    assert.equal(doc.items[0].quantityCommitted, 4, 'committed equals received at rest');
    assert.equal((doc.claims || []).length, 0, 'no outstanding claims at rest');
    assert.equal(doc.receipts.length, 1);
    const receipt = doc.receipts[0];
    assert.equal(receipt.reference, 'INV-1');
    assert.equal(String(receipt.userId), main.userId);
    assert.equal(receipt.lines.length, 1);
    assert.equal(String(receipt.lines[0].inventoryTransactionId), applied.inventoryTransactionId);
    assert.equal(receipt.lines[0].quantity, 4);
    assert.equal(receipt.lines[0].previousQuantity, 0);
    assert.equal(receipt.lines[0].newQuantity, 4);

    // The detail endpoint exposes the receipts.
    const get = await api('GET', poUrl(po.id), { token: main.token });
    assert.equal(get.status, 200, JSON.stringify(get.json));
    assert.equal(get.json.status, 'OPEN');
    assert.equal(get.json.items[0].quantityReceived, 4);
    assert.equal(get.json.items[0].remainingQuantity, 6);
    assert.equal(get.json.receipts.length, 1);
    assert.equal(get.json.receipts[0].reference, 'INV-1');
    assert.equal(get.json.receipts[0].lines[0].inventoryTransactionId, applied.inventoryTransactionId);
    assert.deepEqual(get.json.pendingClaims, [], 'no interrupted receive is pending');
    assert.deepEqual(get.json.totals, {
      quantityOrdered: 10,
      quantityReceived: 4,
      remainingQuantity: 6,
      estimatedCost: 0,
    });
  });

  it('receives the remaining quantity, auto-flips OPEN -> RECEIVED, and rejects a further receipt', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 6 }] });

    const first = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 2 }] },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.allReceived, false);
    assert.equal(first.json.po.status, 'OPEN');

    const second = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 4 }] },
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.allReceived, true);
    assert.equal(second.json.po.status, 'RECEIVED');
    assert.equal(second.json.applied[0].previousQuantity, 2);
    assert.equal(second.json.applied[0].newQuantity, 6);

    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), 6);
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 2);
    assert.equal(await auditStockInsFor(main.businessId, p.id), 2);

    const doc = await poDoc(po.id);
    assert.equal(doc.status, 'RECEIVED');
    assert.equal(doc.items[0].quantityReceived, 6);
    assert.equal(doc.receipts.length, 2);

    // A fully received PO is final.
    const third = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(third.status, 409, JSON.stringify(third.json));
    assert.equal(third.json.code, 'PO_ALREADY_RECEIVED');
  });

  it('applies a 2-line batch per line (transaction + receipt each) and auto-completes', async () => {
    const pa = await newProduct(main);
    const pb = await newProduct(main);
    const po = await mkOpenPo(main, {
      supplierId: sup.id,
      locationId: loc.id,
      items: [
        { productId: pa.id, quantityOrdered: 3 },
        { productId: pb.id, quantityOrdered: 5 },
      ],
    });

    const res = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: pa.id, quantity: 3 }, { productId: pb.id, quantity: 5 }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.allReceived, true);
    assert.equal(res.json.po.status, 'RECEIVED');
    assert.equal(res.json.applied.length, 2);

    // Each received line produced its own STOCK_IN referencing the PO number.
    const txns = await stockInsFor(main.businessId, po.number);
    assert.equal(txns.length, 2);
    const byProduct = new Map(txns.map((t) => [String(t.productId), t]));
    assert.equal(byProduct.get(pa.id).quantity, 3);
    assert.equal(byProduct.get(pb.id).quantity, 5);

    assert.equal(await rowQuantity(main.businessId, pa.id, loc.id), 3);
    assert.equal(await rowQuantity(main.businessId, pb.id, loc.id), 5);

    // One embedded receipt per received line, each with its own line->txn pointer.
    const doc = await poDoc(po.id);
    assert.equal(doc.receipts.length, 2);
    const totalReceiptLines = doc.receipts.reduce((n, r) => n + r.lines.length, 0);
    assert.equal(totalReceiptLines, 2);
    const refs = new Set(doc.receipts.flatMap((r) => r.lines.map((l) => String(l.inventoryTransactionId))));
    assert.equal(refs.size, 2, 'each receipt line points at a distinct transaction');
    for (const t of txns) assert.ok(refs.has(String(t._id)), 'every transaction is referenced by a receipt');
  });

  it('rejects receiving on a DRAFT and on a CANCELED order with zero movement', async () => {
    const p = await newProduct(main);

    // DRAFT (never issued).
    const draft = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 5 }] },
    });
    assert.equal(draft.status, 201);
    const beforeDraft = await movementState(main.businessId, p.id, loc.id, draft.json);
    const draftRecv = await api('POST', `${poUrl(draft.json.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 2 }] },
    });
    assert.equal(draftRecv.status, 409, JSON.stringify(draftRecv.json));
    assert.equal(draftRecv.json.code, 'PO_NOT_ISSUED');
    await assertZeroMovement(beforeDraft, main.businessId, p.id, loc.id, draft.json, 'DRAFT');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null);

    // CANCELED (open then cancel before receiving).
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 5 }] });
    const canceled = await api('POST', `${poUrl(po.id)}/cancel`, { token: main.token });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.json.status, 'CANCELED');
    const beforeCanc = await movementState(main.businessId, p.id, loc.id, po);
    const cancRecv = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(cancRecv.status, 409, JSON.stringify(cancRecv.json));
    assert.equal(cancRecv.json.code, 'PO_CANCELED');
    await assertZeroMovement(beforeCanc, main.businessId, p.id, loc.id, po, 'CANCELED');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null);
  });

  it('rejects over-remaining and non-member lines with zero movement (PO_REMAINING_EXCEEDED / PO_LINE_NOT_FOUND)', async () => {
    const p = await newProduct(main);
    const ghost = await newProduct(main); // exists in the business but is NOT on the PO
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 5 }] });

    const over = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 6 }] },
    });
    assert.equal(over.status, 409, JSON.stringify(over.json));
    assert.equal(over.json.code, 'PO_REMAINING_EXCEEDED');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null);
    const docAfterOver = await poDoc(po.id);
    assert.equal(docAfterOver.items[0].quantityReceived, 0);
    assert.equal(docAfterOver.receipts.length, 0);

    const notOnPo = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: ghost.id, quantity: 1 }] },
    });
    assert.equal(notOnPo.status, 409, JSON.stringify(notOnPo.json));
    assert.equal(notOnPo.json.code, 'PO_LINE_NOT_FOUND');
    assert.equal(await rowQuantity(main.businessId, ghost.id, loc.id), null);
  });

  it('fails the whole batch cleanly when a product is archived or the location is archived (fail fast, zero applied)', async () => {
    const good = await newProduct(main);
    const doomed = await newProduct(main);

    // Both lines on one PO; archive one product after issue. The whole batch is
    // rejected before anything moves — earlier valid lines must NOT stay applied.
    const po = await mkOpenPo(main, {
      supplierId: sup.id,
      locationId: loc.id,
      items: [
        { productId: good.id, quantityOrdered: 2 },
        { productId: doomed.id, quantityOrdered: 2 },
      ],
    });
    await archive(main, `/api/products/${doomed.id}/archive`);

    const batch = await api('POST', `${poUrl(po.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: good.id, quantity: 2 }, { productId: doomed.id, quantity: 2 }] },
    });
    assert.equal(batch.status, 409, JSON.stringify(batch.json));
    assert.equal(batch.json.code, 'PRODUCT_ARCHIVED');
    assert.equal(await rowQuantity(main.businessId, good.id, loc.id), null, 'no earlier line applied');
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 0);
    assert.equal(doc.items[1].quantityReceived, 0);
    assert.equal(doc.receipts.length, 0);

    // Archiving the receiving location post-issue is also caught by stock-in's
    // own operational assert (409 LOCATION_ARCHIVED, zero applied).
    const loc2 = await newLocation(main);
    const ploc = await newProduct(main);
    const po2 = await mkOpenPo(main, { supplierId: sup.id, locationId: loc2.id, items: [{ productId: ploc.id, quantityOrdered: 4 }] });
    await archive(main, `/api/locations/${loc2.id}/archive`);
    const archivedLoc = await api('POST', `${poUrl(po2.id)}/receive`, {
      token: main.token,
      body: { lines: [{ productId: ploc.id, quantity: 2 }] },
    });
    assert.equal(archivedLoc.status, 409, JSON.stringify(archivedLoc.json));
    assert.equal(archivedLoc.json.code, 'LOCATION_ARCHIVED');
    assert.equal(await rowQuantity(main.businessId, ploc.id, loc2.id), null);
    const doc2 = await poDoc(po2.id);
    assert.equal(doc2.items[0].quantityReceived, 0);
  });

  it('validates receive payloads structurally (400 VALIDATION_ERROR) and ids (400 INVALID_ID)', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 5 }] });
    const url = `${poUrl(po.id)}/receive`;

    const cases = [
      { name: 'missing lines', body: {} },
      { name: 'empty lines', body: { lines: [] } },
      { name: 'lines not an array', body: { lines: 'nope' } },
      { name: 'quantity zero', body: { lines: [{ productId: p.id, quantity: 0 }] } },
      { name: 'quantity negative', body: { lines: [{ productId: p.id, quantity: -1 }] } },
      { name: 'quantity non-integer', body: { lines: [{ productId: p.id, quantity: 1.5 }] } },
      { name: 'quantity non-numeric', body: { lines: [{ productId: p.id, quantity: 'x' }] } },
      { name: 'bad productId', body: { lines: [{ productId: 'abc', quantity: 1 }] } },
      { name: 'duplicate productId in batch', body: { lines: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 2 }] } },
      { name: 'reference overlong', body: { lines: [{ productId: p.id, quantity: 1 }], reference: 'x'.repeat(201) } },
    ];
    for (const c of cases) {
      const res = await api('POST', url, { token: main.token, body: c.body });
      assert.equal(res.status, 400, `${c.name}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.code, 'VALIDATION_ERROR', c.name);
    }
    // None of the structural failures touched the ledger.
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null);
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 0);
    assert.equal(doc.receipts.length, 0);

    // A malformed :id is a 400 INVALID_ID on the receive verb too.
    const badId = await api('POST', `${poUrl('not-an-object-id')}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(badId.status, 400, JSON.stringify(badId.json));
    assert.equal(badId.json.code, 'INVALID_ID');

    // A missing/foreign PO is a 404.
    const missing = await api('POST', `${poUrl('000000000000000000000000')}/receive`, {
      token: main.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    assert.equal(missing.json.code, 'PO_NOT_FOUND');
  });

  it('enforces RBAC (401 / STAFF-receive 200 but manage 403) and business isolation (404, body ids ignored)', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 3 }] });

    // Unauthenticated.
    const anon = await api('POST', `${poUrl(po.id)}/receive`, {
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(anon.status, 401);
    assert.equal(anon.json.code, 'AUTH_REQUIRED');

    // `other` business cannot receive against main's PO (404, no leak).
    const foreign = await api('POST', `${poUrl(po.id)}/receive`, {
      token: other.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    assert.equal(foreign.json.code, 'PO_NOT_FOUND');

    // STAFF can receive (200) but cannot manage (issue/create/cancel are 403).
    const spoof = await api('POST', `${poUrl(po.id)}/receive`, {
      token: staffMain.token,
      body: {
        lines: [{ productId: p.id, quantity: 2 }],
        reference: 'staff-delivery',
        // The server must ignore client-supplied ids: stock must land at the
        // PO's own location in main's business, never at a spoofed one.
        locationId: loc.id,
        businessId: other.businessId,
      },
    });
    assert.equal(spoof.status, 200, JSON.stringify(spoof.json));
    assert.equal(spoof.json.po.businessId, main.businessId, 'server-derived business wins');
    const txn = (await stockInsFor(main.businessId, po.number))[0];
    assert.equal(String(txn.locationId), loc.id, 'stock lands at the PO location, body locationId ignored');

    const staffIssue = await api('POST', `${poUrl(po.id)}/issue`, { token: staffMain.token });
    assert.equal(staffIssue.status, 403, JSON.stringify(staffIssue.json));
    assert.equal(staffIssue.json.code, 'FORBIDDEN');
    const staffCreate = await api('POST', '/api/purchase-orders', {
      token: staffMain.token,
      body: { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 1 }] },
    });
    assert.equal(staffCreate.status, 403);
    const staffCancel = await api('POST', `${poUrl(po.id)}/cancel`, { token: staffMain.token });
    assert.equal(staffCancel.status, 403);

    // MANAGER may also receive (positive RBAC).
    const mgrPo = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 1 }] });
    const mgrRecv = await api('POST', `${poUrl(mgrPo.id)}/receive`, {
      token: managerMain.token,
      body: { lines: [{ productId: p.id, quantity: 1 }] },
    });
    assert.equal(mgrRecv.status, 200, JSON.stringify(mgrRecv.json));
  });

  it('concurrent full receives of the same line: exactly one claim wins and moves stock once (I1/I2 — the loser creates zero movement)', async () => {
    const cp = await newProduct(concBiz);
    const ORDERED = 5;
    for (let trial = 0; trial < 3; trial += 1) {
      const po = await mkOpenPo(concBiz, { supplierId: cs.id, locationId: cl.id, items: [{ productId: cp.id, quantityOrdered: ORDERED }] });
      const beforeRow = (await rowQuantity(concBiz.businessId, cp.id, cl.id)) ?? 0;
      const body = { lines: [{ productId: cp.id, quantity: ORDERED }] };
      const [a, b] = await Promise.all([
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body }),
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 409], `trial ${trial}: expected exactly one win — ${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);
      const winner = a.status === 200 ? a.json : b.json;
      // The loser is the full response (its .status, unlike the winner's body fields).
      const loserRes = a.status === 200 ? b : a;
      assert.equal(winner.allReceived, true);
      assert.equal(winner.po.status, 'RECEIVED');
      assert.equal(winner.applied.length, 1);
      assert.equal(winner.applied[0].quantity, ORDERED);
      // The loser is a 409 either way the race lands: its CLAIM lost while the PO
      // was still OPEN (RECEIVE_CONFLICT) or it fetched after the winner already
      // auto-flipped (PO_ALREADY_RECEIVED). Both record nothing — the residue
      // assertions below are what prove the loser moved no stock.
      assert.equal(loserRes.status, 409, `trial ${trial}: the loser is rejected`);

      // The PO is the hard gate: the winning claim is recorded exactly once and
      // never past the ordered quantity. Once settled, committed == received and
      // no claim remains.
      const doc = await poDoc(po.id);
      assert.equal(doc.items[0].quantityReceived, ORDERED, `trial ${trial}: PO never over-receives`);
      assert.equal(doc.items[0].quantityCommitted, ORDERED, `trial ${trial}: committed equals received at rest`);
      assert.equal((doc.claims || []).length, 0, `trial ${trial}: no outstanding claims`);
      assert.equal(doc.receipts.length, 1, `trial ${trial}: exactly one receipt recorded on the PO`);
      assert.equal(
        String(doc.receipts[0].lines[0].inventoryTransactionId),
        winner.applied[0].inventoryTransactionId,
        `trial ${trial}: the recorded receipt is the winning movement`
      );

      // Claim-first: the loser's Op1 CLAIM lost before any stock-in, so it never
      // moved stock — exactly ONE surviving STOCK_IN reconciles on-hand 1:1. The
      // movement-first orphan (a second reference-tagged STOCK_IN surviving a
      // failed claim) is impossible here.
      const afterRow = await rowQuantity(concBiz.businessId, cp.id, cl.id);
      const poIns = await stockInsFor(concBiz.businessId, po.number);
      const shelfDelta = afterRow - beforeRow;
      const movedTotal = poIns.reduce((sum, t) => sum + t.quantity, 0);
      assert.equal(poIns.length, 1, `trial ${trial}: exactly one surviving STOCK_IN for this PO`);
      assert.equal(shelfDelta, movedTotal, `trial ${trial}: on-hand delta equals this PO's surviving STOCK_IN total`);
      assert.equal(shelfDelta, ORDERED, `trial ${trial}: the shelf moved exactly the ordered quantity (the loser moved nothing)`);
      assert.equal(await auditStockInsForPo(concBiz.businessId, po), 1, `trial ${trial}: exactly one stock-in audit — the loser left no audit residue`);
    }
  });

  it('concurrent over-remaining partial receives (3+3 on ordered 5): one claim wins and moves stock once (PO never over-accounts)', async () => {
    const cp = await newProduct(concBiz);
    const ORDERED = 5;
    const Q1 = 3;
    const Q2 = 3; // 6 > 5 — only one slice may be claimed on the PO
    for (let trial = 0; trial < 3; trial += 1) {
      const po = await mkOpenPo(concBiz, { supplierId: cs.id, locationId: cl.id, items: [{ productId: cp.id, quantityOrdered: ORDERED }] });
      const beforeRow = (await rowQuantity(concBiz.businessId, cp.id, cl.id)) ?? 0;
      const [a, b] = await Promise.all([
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body: { lines: [{ productId: cp.id, quantity: Q1 }] } }),
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body: { lines: [{ productId: cp.id, quantity: Q2 }] } }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 409], `trial ${trial}: only one receive may be recorded — ${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);
      const winner = a.status === 200 ? a.json : b.json;
      assert.equal(winner.applied.length, 1);

      // The PO gate: the winner's slice is recorded exactly once and the order is
      // never over-received; the losing 409 recorded nothing on it and settled to
      // committed == received with no outstanding claim.
      const doc = await poDoc(po.id);
      const received = doc.items[0].quantityReceived;
      assert.equal(received, winner.applied[0].quantity, `trial ${trial}: the PO records exactly the winning slice`);
      assert.ok(received <= ORDERED, `trial ${trial}: never receive past the ordered quantity`);
      assert.equal(doc.items[0].quantityOrdered, ORDERED);
      assert.equal(doc.items[0].quantityCommitted, received, `trial ${trial}: committed equals received at rest`);
      assert.equal((doc.claims || []).length, 0, `trial ${trial}: no outstanding claims`);
      assert.equal(doc.receipts.length, 1, `trial ${trial}: exactly one receipt recorded on the PO`);
      assert.equal(
        String(doc.receipts[0].lines[0].inventoryTransactionId),
        winner.applied[0].inventoryTransactionId,
        `trial ${trial}: the recorded receipt is the winning movement`
      );

      // Claim-first: the loser's claim lost before any stock-in, so exactly ONE
      // surviving STOCK_IN (the winning slice) reconciles on-hand — never the
      // movement-first orphan of two rows summing past the order.
      const afterRow = await rowQuantity(concBiz.businessId, cp.id, cl.id);
      const poIns = await stockInsFor(concBiz.businessId, po.number);
      const shelfDelta = afterRow - beforeRow;
      const movedTotal = poIns.reduce((sum, t) => sum + t.quantity, 0);
      assert.equal(poIns.length, 1, `trial ${trial}: exactly one surviving STOCK_IN for this PO`);
      assert.equal(shelfDelta, movedTotal, `trial ${trial}: on-hand delta equals this PO's surviving STOCK_IN total`);
      assert.equal(shelfDelta, received, `trial ${trial}: the shelf moved exactly the winning slice`);
      assert.equal(await auditStockInsForPo(concBiz.businessId, po), 1, `trial ${trial}: exactly one stock-in audit — the loser left no audit residue`);
    }
  });

  it('concurrent partial receives summing within the order both succeed (no over-rejection: two claims, two movements, received == sum)', async () => {
    const cp = await newProduct(concBiz);
    const ORDERED = 10;
    const Q1 = 3;
    const Q2 = 3; // 6 <= 10 — both slices are independently legal
    for (let trial = 0; trial < 3; trial += 1) {
      const po = await mkOpenPo(concBiz, { supplierId: cs.id, locationId: cl.id, items: [{ productId: cp.id, quantityOrdered: ORDERED }] });
      const beforeRow = (await rowQuantity(concBiz.businessId, cp.id, cl.id)) ?? 0;
      const [a, b] = await Promise.all([
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body: { lines: [{ productId: cp.id, quantity: Q1 }] } }),
        api('POST', `${poUrl(po.id)}/receive`, { token: concBiz.token, body: { lines: [{ productId: cp.id, quantity: Q2 }] } }),
      ]);
      // Both claims fit (committed 0 -> 3 -> 6, both <= ordered - 3) and each is
      // finalized: two legal partials must NOT over-reject each other.
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 200], `trial ${trial}: both legal partials must apply — ${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);
      const appliedCount = (a.json.applied?.length ?? 0) + (b.json.applied?.length ?? 0);
      assert.equal(appliedCount, 2, `trial ${trial}: two movements applied across the two receives`);

      const doc = await poDoc(po.id);
      const received = doc.items[0].quantityReceived;
      assert.equal(received, Q1 + Q2, `trial ${trial}: received the sum of the two legal partials`);
      assert.ok(received <= ORDERED, `trial ${trial}: never past ordered`);
      assert.equal(doc.items[0].quantityCommitted, received, `trial ${trial}: committed equals received at rest`);
      assert.equal((doc.claims || []).length, 0, `trial ${trial}: no outstanding claims`);
      assert.equal(doc.status, 'OPEN', `trial ${trial}: partials do not auto-complete`);

      const afterRow = await rowQuantity(concBiz.businessId, cp.id, cl.id);
      const poIns = await stockInsFor(concBiz.businessId, po.number);
      const shelfDelta = afterRow - beforeRow;
      const movedTotal = poIns.reduce((sum, t) => sum + t.quantity, 0);
      assert.equal(poIns.length, 2, `trial ${trial}: two surviving STOCK_IN`);
      assert.equal(shelfDelta, movedTotal, `trial ${trial}: on-hand reconciles 1:1 to the PO's movements`);
      assert.equal(shelfDelta, Q1 + Q2, `trial ${trial}: on-hand moved the full legal sum`);
    }
  });

  it('compensates a stock-in whose transaction write failed: clean reject, row restored, claim released, PO untouched', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 3 }] });

    const restore = stubTxnToThrow();
    try {
      await assert.rejects(
        purchaseOrderService.receive(main.businessId, main.userId, po.id, {
          lines: [{ productId: p.id, quantity: 2 }],
          reference: 'x',
        }),
        /injected inventory-transaction write failure/
      );
    } finally {
      restore();
    }

    // stockIn's own compensation restored the row it created; the claim that was
    // reserved before it is fully released; the PO was never received.
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null, 'created row removed');
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 0);
    assert.equal(doc.items[0].quantityCommitted, 0, 'the claim was released');
    assert.equal((doc.claims || []).length, 0, 'no claim left outstanding');
    assert.equal(doc.receipts.length, 0);
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 0);
  });

  it('H3: an audit-log failure never rolls the movement back — the receive still succeeds', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 3 }] });

    const restore = stubAuditToThrow();
    let result;
    try {
      result = await purchaseOrderService.receive(main.businessId, main.userId, po.id, {
        lines: [{ productId: p.id, quantity: 3 }],
        reference: 'no-audit',
      });
    } finally {
      restore();
    }

    assert.equal(result.allReceived, true);
    assert.equal(result.po.status, 'RECEIVED');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), 3, 'the movement is durable');
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 3);
    assert.equal(doc.items[0].quantityCommitted, 3, 'committed equals received at rest');
    assert.equal((doc.claims || []).length, 0, 'no outstanding claims');
    assert.equal(doc.receipts.length, 1);
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 1);
    // The injected audit writes failed, so no INVENTORY_STOCK_IN audit rows exist.
    assert.equal(await auditStockInsFor(main.businessId, p.id), 0);
  });

  it('full precise undo + claim release: a FINALIZE no-op (racing CANCEL) after a successful stock-in reverts row, transaction and audit', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 3 }] });

    // Force the FINALIZE (Op3) to no-op after the claim and stock-in committed —
    // exactly what a concurrent CANCEL landing between them would do.
    const restore = stubReceiveOps({ onFinalize: () => true });
    let err;
    try {
      await purchaseOrderService.receive(main.businessId, main.userId, po.id, {
        lines: [{ productId: p.id, quantity: 3 }],
      });
    } catch (e) {
      err = e;
    } finally {
      restore();
    }
    assert.ok(err, 'expected the receive to reject on the finalize no-op');
    assert.equal(err.code, 'RECEIVE_CONFLICT');
    assert.deepEqual(err.applied, [], 'nothing was applied');

    // The stock-in was created by this receive (created row) -> precisely undone.
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), null, 'created inventory row removed');
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 0, 'the transaction was deleted');
    assert.equal(await auditStockInsFor(main.businessId, p.id), 0, 'the audit row was deleted');
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 0, 'the PO line counter was never advanced');
    // The un-finalized reservation is returned to the order (no ghost claim leaks).
    assert.equal(doc.items[0].quantityCommitted, 0, 'the claim was released after the precise undo');
    assert.equal((doc.claims || []).length, 0, 'no claim left outstanding');
    assert.equal(doc.receipts.length, 0, 'no receipt recorded');
  });

  it('★ a retry after a finalize that APPLIED then threw replays the durable receipt instead of adding stock twice', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 10 }] });
    const key = 'op-receive-apply-then-throw';
    const body = { lines: [{ productId: p.id, quantity: 4 }], reference: 'INV-AMBIGUOUS' };

    const restore = stubFinalizeApplyThenThrowOnce();
    let first;
    try {
      first = await api('POST', `${poUrl(po.id)}/receive`, {
        token: main.token,
        body,
        headers: { 'Idempotency-Key': key },
      });
    } finally {
      restore();
    }
    assert.equal(first.status, 500, 'the first delivery reports the ambiguous failure');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), 4, 'the finalize applied before throwing');
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 1);

    // The 5xx releases its idempotency claim; wait for that housekeeping to land, then
    // retry the SAME operation. Without the receipt replay this body would fit the
    // remaining 6 and add another 4 units.
    let retry;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      retry = await api('POST', `${poUrl(po.id)}/receive`, {
        token: main.token,
        body,
        headers: { 'Idempotency-Key': key },
      });
      if (!(retry.status === 409 && retry.json?.code === 'IDEMPOTENT_REQUEST_IN_PROGRESS')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.replayed, true, 'the answer comes from the stored receipt');
    assert.equal(await rowQuantity(main.businessId, p.id, loc.id), 4, 'the retry added no stock');
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 1, 'still exactly one stock-in');
    const doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityReceived, 4, 'the PO counter was advanced once');
    assert.equal(doc.receipts.length, 1, 'exactly one durable receipt');
    assert.equal(doc.receipts[0].requestKey, key, 'the receipt names the retried operation');
    assert.equal((doc.claims || []).length, 0, 'no claim is left behind');
  });

  it('mid-batch CLAIM loss: earlier lines stay durably applied and are reported as applied; the lost line moves nothing', async () => {
    const pa = await newProduct(main);
    const pb = await newProduct(main);
    const po = await mkOpenPo(main, {
      supplierId: sup.id,
      locationId: loc.id,
      items: [
        { productId: pa.id, quantityOrdered: 3 },
        { productId: pb.id, quantityOrdered: 5 },
      ],
    });

    // Let line 1 claim normally; force line 2's CLAIM (Op1) to no-op, as a
    // concurrent receive consuming pb's remaining would. Line 2 then never
    // reaches stock-in.
    const restore = stubReceiveOps({ onClaim: (n) => n === 2 });
    let err;
    try {
      await purchaseOrderService.receive(main.businessId, main.userId, po.id, {
        lines: [{ productId: pa.id, quantity: 3 }, { productId: pb.id, quantity: 5 }],
      });
    } catch (e) {
      err = e;
    } finally {
      restore();
    }
    assert.ok(err, 'expected a partial conflict');
    assert.equal(err.code, 'RECEIVE_CONFLICT');
    assert.equal(err.applied.length, 1, 'exactly line 1 was applied');
    assert.equal(err.applied[0].productId, pa.id);
    assert.equal(err.applied[0].quantity, 3);
    assert.ok(err.applied[0].inventoryTransactionId);

    // Line 1 is durable: row advanced, transaction + audit present, PO recorded.
    assert.equal(await rowQuantity(main.businessId, pa.id, loc.id), 3);
    assert.equal(await auditStockInsFor(main.businessId, pa.id), 1);
    const doc = await poDoc(po.id);
    assert.equal(doc.status, 'OPEN', 'partial batch never auto-completes');
    assert.equal(doc.items[0].quantityReceived, 3);
    assert.equal(doc.items[0].quantityCommitted, 3, 'line 1 committed equals received at rest');
    assert.equal(doc.receipts.length, 1);
    assert.equal(String(doc.receipts[0].lines[0].inventoryTransactionId), err.applied[0].inventoryTransactionId);

    // Line 2 never moved stock (its claim lost BEFORE any stock-in): no row, no
    // transaction, no audit, no claim leak, and both counters sit at 0.
    assert.equal(await rowQuantity(main.businessId, pb.id, loc.id), null);
    assert.equal(await auditStockInsFor(main.businessId, pb.id), 0);
    assert.equal(doc.items[1].quantityReceived, 0);
    assert.equal(doc.items[1].quantityCommitted, 0, 'line 2 committed never advanced (no claim leak)');
    assert.equal((doc.claims || []).length, 0, 'no outstanding claims on the PO');
    assert.equal(doc.receipts[0].lines.some((l) => String(l.productId) === pb.id), false);
    assert.equal((await stockInsFor(main.businessId, po.number)).length, 1, 'only line 1 has a movement');
  });

  it('a claim release is exact and idempotent: it never touches a sibling claim and re-releasing the same id is a no-op', async () => {
    const p = await newProduct(main);
    const po = await mkOpenPo(main, { supplierId: sup.id, locationId: loc.id, items: [{ productId: p.id, quantityOrdered: 10 }] });
    const poId = oid(po.id);
    const oidBiz = oid(main.businessId);
    const pid = oid(p.id);
    const uid = oid(main.userId);

    // Seed two independent outstanding claims on the one line, as two concurrent
    // receives would hold mid-flight: A reserves 2, B reserves 3 -> committed 5.
    const claimA = new ObjectId();
    const claimB = new ObjectId();
    await PurchaseOrder.updateOne(
      { _id: poId },
      {
        $push: {
          claims: {
            $each: [
              { _id: claimA, productId: pid, quantity: 2, createdBy: uid, createdAt: new Date() },
              { _id: claimB, productId: pid, quantity: 3, createdBy: uid, createdAt: new Date() },
            ],
          },
        },
        $inc: { 'items.$[l].quantityCommitted': 5 },
      },
      { arrayFilters: [{ 'l.productId': pid }] }
    );
    let doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityCommitted, 5);
    assert.equal((doc.claims || []).length, 2);

    // Release A by its exact id (e.g. A's stock-in failed): B must be untouched
    // and committed drops by exactly A's 2 — never another request's share.
    const releasedA = await releaseClaim({ poId, oidBiz, productId: pid, quantity: 2, claimId: claimA });
    assert.equal(releasedA.modifiedCount, 1, 'releasing an outstanding claim modifies the PO');
    doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityCommitted, 3, "committed drops by exactly A's quantity");
    assert.equal((doc.claims || []).length, 1, 'exactly one claim remains');
    assert.equal(String(doc.claims[0]._id), String(claimB), 'the sibling claim B is untouched');
    assert.equal(doc.claims[0].quantity, 3, 'B still holds its own 3');
    assert.equal(doc.items[0].quantityReceived, 0, 'no receive has been recorded');

    // Releasing A again is an idempotent no-op (a finalize or double release
    // already removed it): nothing changes and B is still safe.
    const releasedAgain = await releaseClaim({ poId, oidBiz, productId: pid, quantity: 2, claimId: claimA });
    assert.equal(releasedAgain.modifiedCount, 0, 're-releasing an already-gone claim is a no-op');
    doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityCommitted, 3, 'committed unchanged by the no-op');
    assert.equal((doc.claims || []).length, 1, 'B is still the only claim');
    assert.equal(String(doc.claims[0]._id), String(claimB));

    // Releasing B clears the line back to its pre-claim state.
    const releasedB = await releaseClaim({ poId, oidBiz, productId: pid, quantity: 3, claimId: claimB });
    assert.equal(releasedB.modifiedCount, 1);
    doc = await poDoc(po.id);
    assert.equal(doc.items[0].quantityCommitted, 0, 'fully released back to zero');
    assert.equal(doc.items[0].quantityReceived, 0);
    assert.equal((doc.claims || []).length, 0);
  });
});
