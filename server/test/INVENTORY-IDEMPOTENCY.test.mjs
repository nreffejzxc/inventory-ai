// Inventory writes are applied once, however many times the request is delivered.
//
// THE DEFECT THIS PINS. A movement is written exactly once by the services, but the
// HTTP request that carries it can arrive twice: the client's request budget can
// expire while a cold server is still working, the form is told the movement failed,
// the member submits again, and the server applies it a second time. The symptom the
// owner reported is two Recent Activity entries for one operation — which is two
// ledger rows, and a stock level wrong by the whole movement. Nothing in
// `inventory.service.ts` was duplicating; the same operation was being SENT twice.
//
// WHAT THE FIX PROMISES, and therefore what this suite asserts:
//
//   * the same `Idempotency-Key` delivered twice applies the movement ONCE and
//     answers the second delivery with the first delivery's response, byte for byte
//     where it matters (quantity, previous/new, transaction id);
//   * a DIFFERENT key is a different operation and applies in full — legitimate
//     repeats are never swallowed as duplicates;
//   * the same key with a DIFFERENT body is refused (422) and applies nothing, so a
//     reused key can never return somebody else's quantities;
//   * a request with NO key behaves exactly as before, which is what keeps an older
//     installed build working;
//   * a transfer delivered twice writes its two legs once (two rows, not four).
//
// DB-backed; registered as DB-required through dbSuite.

import { it, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import { idempotent } from '../src/middlewares/idempotency.ts';
import { startServer, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';

const { dbOk, baseUrl, server } = await startServer();
const tracker = createTracker(dbOk);

/** `makeApi`, plus request headers — the key travels in one. */
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
  return `test-${label}-${process.pid}-${Date.now()}-${seq}`;
}

async function newProduct(business) {
  seq += 1;
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { name: `Idem Product ${process.pid}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business) {
  seq += 1;
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: `Idem Location ${process.pid}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newSupplier(business) {
  seq += 1;
  const res = await api('POST', '/api/suppliers', {
    token: business.token,
    body: { name: `Idem Supplier ${process.pid}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

/** Ledger rows for one product, newest first. */
async function history(business, productId) {
  const res = await api('GET', `/api/inventory/history?productId=${productId}`, { token: business.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

/** The single inventory row for a product/location, or undefined. */
async function row(business, productId, locationId) {
  const res = await api('GET', `/api/inventory?productId=${productId}&locationId=${locationId}`, {
    token: business.token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.items[0];
}

/**
 * The dashboard's Recent Activity entries carrying `id`. The reported symptom is
 * about THIS list, so the ledger assertions above are paired with it: one
 * operation must be one row here too.
 */
async function activitiesFor(business, id) {
  const res = await api('GET', '/api/dashboard', { token: business.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.recentActivity.filter((entry) => entry.id === id);
}

/** An OPEN purchase order with one line, so a receive can be delivered to it. */
async function openPo(business, { supplierId, locationId, productId, quantityOrdered }) {
  const created = await api('POST', '/api/purchase-orders', {
    token: business.token,
    body: { supplierId, locationId, items: [{ productId, quantityOrdered, unitCost: 3 }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const issued = await api('POST', `/api/purchase-orders/${created.json.id}/issue`, {
    token: business.token,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  return created.json;
}

dbSuite('Inventory idempotency — one operation, one movement', dbOk, () => {
  let business;
  let productId;
  let locationId;

  /** A complete stock-in body for this suite's own product and location. */
  const move = (quantity) => ({ productId, locationId, quantity, reason: 'idempotency suite' });

  before(async () => {
    business = await registerOwner(api, tracker);
    productId = await newProduct(business);
    locationId = await newLocation(business);
  });

  after(async () => {
    if (dbOk) {
      await mongoose.connection.db.collection('idempotency_records').deleteMany({});
    }
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  describe('stock in', () => {
    it('applies once when the same key is delivered twice, and replays the answer', async () => {
      const key1 = key('in-same');
      const body = move(7);

      const first = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));
      assert.equal(first.json.transaction.quantity, 7);

      const second = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 201, JSON.stringify(second.json));
      // The replay is the SAME movement: same transaction, same before/after.
      assert.equal(second.json.transaction.id, first.json.transaction.id);
      assert.equal(second.json.previousQuantity, first.json.previousQuantity);
      assert.equal(second.json.newQuantity, first.json.newQuantity);

      const ledger = await history(business, productId);
      assert.equal(ledger.total, 1, 'one delivery of one operation must write one ledger row');
      const stock = await row(business, productId, locationId);
      assert.equal(stock.quantity, 7, 'the quantity must move by the movement, once');
    });

    it('applies in full under a different key — a deliberate repeat is not a duplicate', async () => {
      const before = (await row(business, productId, locationId)).quantity;
      const first = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: move(3),
        idempotencyKey: key('in-second'),
      });
      const second = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: move(3),
        idempotencyKey: key('in-third'),
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));
      assert.equal(second.status, 201, JSON.stringify(second.json));
      assert.notEqual(first.json.transaction.id, second.json.transaction.id);

      const ledger = await history(business, productId);
      assert.equal(ledger.total, 3, 'two more operations must add two more rows');
      const stock = await row(business, productId, locationId);
      assert.equal(stock.quantity, before + 6);
    });

    it('refuses a key reused for a different body, and applies nothing', async () => {
      const key1 = key('in-reuse');
      const first = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: move(2),
        idempotencyKey: key1,
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));
      const ledgerBefore = await history(business, productId);

      const changed = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: move(5),
        idempotencyKey: key1,
      });
      assert.equal(changed.status, 422, JSON.stringify(changed.json));
      assert.equal(changed.json.code, 'IDEMPOTENCY_KEY_REUSED');

      const ledgerAfter = await history(business, productId);
      assert.equal(ledgerAfter.total, ledgerBefore.total, 'the refused request must not write a row');
    });

    it('leaves a request without a key exactly as it was', async () => {
      const ledgerBefore = await history(business, productId);
      const first = await api('POST', '/api/inventory/stock-in', { token: business.token, body: move(1) });
      const second = await api('POST', '/api/inventory/stock-in', { token: business.token, body: move(1) });
      assert.equal(first.status, 201, JSON.stringify(first.json));
      assert.equal(second.status, 201, JSON.stringify(second.json));
      const ledgerAfter = await history(business, productId);
      assert.equal(ledgerAfter.total, ledgerBefore.total + 2, 'an older build keeps its old behaviour');
    });
  });

  describe('purchase order creation', () => {
    it('creates one DRAFT when the same key is delivered twice', async () => {
      const supplierId = await newSupplier(business);
      const key1 = key('po-create');
      const body = { supplierId, locationId, items: [{ productId, quantityOrdered: 2, unitCost: 5 }] };

      const first = await api('POST', '/api/purchase-orders', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));

      const second = await api('POST', '/api/purchase-orders', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 201, JSON.stringify(second.json));
      assert.equal(second.json.id, first.json.id, 'the replay must be the same order');

      const listed = await api('GET', '/api/purchase-orders', { token: business.token });
      assert.equal(listed.status, 200, JSON.stringify(listed.json));
      assert.equal(listed.json.total, 1, 'one operation must leave one order behind');
    });
  });

  describe('transfer', () => {
    it('writes both legs once when the same key is delivered twice', async () => {
      const destinationId = await newLocation(business);
      // Plenty at the source, so the test is about delivery, not availability.
      const seed = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: { productId, locationId, quantity: 10 },
      });
      assert.equal(seed.status, 201, JSON.stringify(seed.json));

      const key1 = key('transfer');
      const body = {
        productId,
        fromLocationId: locationId,
        toLocationId: destinationId,
        quantity: 4,
      };
      const first = await api('POST', '/api/inventory/transfer', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));

      const second = await api('POST', '/api/inventory/transfer', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 201, JSON.stringify(second.json));
      assert.equal(second.json.reference, first.json.reference);

      const legs = (await history(business, productId)).items.filter(
        (row) => row.type === 'TRANSFER' && row.reference === first.json.reference
      );
      assert.equal(legs.length, 2, 'a transfer has exactly two legs, however many times it is delivered');

      const destination = await row(business, productId, destinationId);
      assert.equal(destination.quantity, 4, 'the destination received the stock once');

      // The two legs are ONE activity, and one delivery of the transfer is one
      // activity — the grouping already merged the pair, so a duplicate delivery
      // would have shown as two identical TRANSFER entries.
      const entries = await activitiesFor(business, first.json.reference);
      assert.equal(entries.length, 1, 'a transfer is one Recent Activity entry');
      assert.equal(entries[0].type, 'TRANSFER');
    });
  });

  describe('stock out', () => {
    it('moves stock once and leaves one activity when the same key is delivered twice', async () => {
      const outProductId = await newProduct(business);
      const seed = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: { productId: outProductId, locationId, quantity: 10 },
      });
      assert.equal(seed.status, 201, JSON.stringify(seed.json));

      const key1 = key('out-same');
      const body = { productId: outProductId, locationId, quantity: 4, reason: 'idempotency suite' };
      const first = await api('POST', '/api/inventory/stock-out', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.newQuantity, 6);

      const second = await api('POST', '/api/inventory/stock-out', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 200, JSON.stringify(second.json));
      assert.equal(second.json.transaction.id, first.json.transaction.id);

      const ledger = await history(business, outProductId);
      const outs = ledger.items.filter((entry) => entry.type === 'STOCK_OUT');
      assert.equal(outs.length, 1, 'one operation must write one STOCK_OUT row');
      assert.equal((await row(business, outProductId, locationId)).quantity, 6);

      const entries = await activitiesFor(business, first.json.transaction.id);
      assert.equal(entries.length, 1, 'one operation must be one Recent Activity entry');
    });
  });

  describe('stock adjustment', () => {
    it('sets the target once and leaves one activity when the same key is delivered twice', async () => {
      const adjProductId = await newProduct(business);
      const seed = await api('POST', '/api/inventory/stock-in', {
        token: business.token,
        body: { productId: adjProductId, locationId, quantity: 10 },
      });
      assert.equal(seed.status, 201, JSON.stringify(seed.json));

      const key1 = key('adjust-same');
      const body = { productId: adjProductId, locationId, quantity: 4, reason: 'idempotency suite' };
      const first = await api('POST', '/api/inventory/adjust', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.newQuantity, 4);

      const second = await api('POST', '/api/inventory/adjust', {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 200, JSON.stringify(second.json));
      assert.equal(second.json.transaction.id, first.json.transaction.id);

      const ledger = await history(business, adjProductId);
      const adjustments = ledger.items.filter((entry) => entry.type === 'ADJUSTMENT');
      assert.equal(adjustments.length, 1, 'one operation must write one ADJUSTMENT row');
      assert.equal((await row(business, adjProductId, locationId)).quantity, 4);

      const entries = await activitiesFor(business, first.json.transaction.id);
      assert.equal(entries.length, 1, 'one operation must be one Recent Activity entry');
    });
  });

  describe('purchase order receiving', () => {
    it('receives a partial line once and leaves one activity when the same key is delivered twice', async () => {
      const supplierId = await newSupplier(business);
      const receiveProductId = await newProduct(business);
      const po = await openPo(business, {
        supplierId,
        locationId,
        productId: receiveProductId,
        quantityOrdered: 10,
      });

      const key1 = key('receive-same');
      // 3 of 10: a second application would still fit the remaining bound, so
      // without the key this delivery doubles the stock. It is the case that
      // proves the middleware, not the service's own remaining-quantity guard.
      const body = { lines: [{ productId: receiveProductId, quantity: 3 }], reference: 'suite' };
      const first = await api('POST', `/api/purchase-orders/${po.id}/receive`, {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      const txnId = first.json.applied[0].inventoryTransactionId;
      assert.equal(first.json.po.items[0].quantityReceived, 3);

      const second = await api('POST', `/api/purchase-orders/${po.id}/receive`, {
        token: business.token,
        body,
        idempotencyKey: key1,
      });
      assert.equal(second.status, 200, JSON.stringify(second.json));
      assert.equal(second.json.applied[0].inventoryTransactionId, txnId, 'the replay is the same receipt');

      const ledger = await history(business, receiveProductId);
      const receipts = ledger.items.filter((entry) => entry.type === 'STOCK_IN');
      assert.equal(receipts.length, 1, 'one receipt must write one STOCK_IN row');

      const stock = await row(business, receiveProductId, locationId);
      assert.equal(stock.quantity, 3, 'the stock moved by the receipt, once');

      const entries = await activitiesFor(business, txnId);
      assert.equal(entries.length, 1, 'one receipt must be one Recent Activity entry');
    });
  });

  describe('a refusal that applied work', () => {
    it('is replayed, never re-run, so the lines it reported cannot be applied again', async () => {
      // A real partial receive cannot be forced deterministically through the API
      // (the batch is validated against one snapshot, and the failing line needs a
      // concurrent claim). This mounts the real middleware on the shape the receive
      // controller produces: 409 `RECEIVE_CONFLICT` carrying `applied`.
      const app = express();
      app.use(express.json());
      let calls = 0;
      app.post(
        '/partial',
        (req, _res, next) => {
          req.user = { id: String(business.userId), businessId: business.businessId };
          next();
        },
        idempotent(),
        (_req, res) => {
          calls += 1;
          res.status(409).json({
            code: 'RECEIVE_CONFLICT',
            error: 'Only part of this receive could be applied',
            applied: [{ productId: 'p', quantity: 1 }],
          });
        }
      );
      const listener = app.listen(0);
      await new Promise((resolve) => listener.once('listening', resolve));
      const { port } = listener.address();
      try {
        const key1 = key('partial');
        const send = () =>
          fetch(`http://127.0.0.1:${port}/partial`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': key1 },
            body: JSON.stringify({ lines: [{ productId: 'p', quantity: 1 }] }),
          });

        const first = await send();
        assert.equal(first.status, 409);
        const second = await send();
        assert.equal(second.status, 409, 'the reported outcome is replayed');
        assert.equal(calls, 1, 'the handler must not run a second time');
        assert.deepEqual((await second.json()).applied, [{ productId: 'p', quantity: 1 }]);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    });
  });
});
