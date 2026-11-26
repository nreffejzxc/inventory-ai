// FW-01 follow-on — one DRAFT purchase order from selected restock rows.
//
// The important boundaries: the client's row snapshot is revalidated against
// the selected location, a stale selection creates nothing, repeated delivery
// with one idempotency key creates one DRAFT, and the path never issues the
// order or writes stock. All reads/writes are tenant-scoped.

import 'dotenv/config';

import { after, before, it } from 'node:test';
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
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import IdempotencyRecord from '../src/models/idempotencyRecord.model.ts';
import { ROLES } from '../src/constants/roles.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;
let other;
let supplier;
let location;
let secondLocation;
let productA;
let productB;
let productC;
let foreignSupplier;
let foreignLocation;
let foreignProduct;
let managerToken;
let staffToken;

async function post(path, biz, body, key) {
  return api('POST', path, {
    token: biz.token,
    body,
    headers: key ? { 'idempotency-key': key } : undefined,
  });
}

async function newSupplier(biz, name = uniqueName('SUP')) {
  const res = await post('/api/suppliers', biz, { name });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newLocation(biz, name = uniqueName('LOC')) {
  const res = await post('/api/locations', biz, { name });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(biz, over = {}) {
  const res = await post('/api/products', biz, {
    name: uniqueName('P'),
    currency: 'PHP',
    minimumStock: 5,
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function stockIn(biz, product, loc, quantity) {
  const res = await post('/api/inventory/stock-in', biz, {
    productId: product.id,
    locationId: loc.id,
    quantity,
    reason: 'fixture stock',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function restockRows(biz, loc) {
  const res = await api('GET', `/api/products/reorder?locationId=${loc.id}&limit=100`, {
    token: biz.token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.items;
}

function selection(rows, products) {
  return rows
    .filter((row) => products.some((p) => p.id === row.id))
    .map((row) => ({
      productId: row.id,
      availableQuantity: row.availableQuantity,
      minimumStock: row.minimumStock,
    }));
}

dbSuite('FW-01 draft PO from restock over real HTTP', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    supplier = await newSupplier(owner);
    location = await newLocation(owner);
    secondLocation = await newLocation(owner);
    productA = await newProduct(owner, { minimumStock: 5 });
    productB = await newProduct(owner, { minimumStock: 5 });
    productC = await newProduct(owner, { minimumStock: 3 });
    await stockIn(owner, productA, location, 2);
    await stockIn(owner, productB, location, 6);
    foreignSupplier = await newSupplier(other);
    foreignLocation = await newLocation(other);
    foreignProduct = await newProduct(other);
    managerToken = (await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker)).token;
    staffToken = (await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker)).token;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('scopes the restock read to the chosen location', async () => {
    const atMain = await restockRows(owner, location);
    assert.ok(atMain.some((r) => r.id === productA.id));
    assert.ok(atMain.some((r) => r.id === productC.id));
    assert.ok(!atMain.some((r) => r.id === productB.id), '6 available at main is not low there');

    const atSecond = await restockRows(owner, secondLocation);
    assert.ok(atSecond.some((r) => r.id === productB.id), 'the same product is low at the second location');
    // A location-scoped read treats "no row at this location" as zero stock,
    // so A is also low at the second location even though it is not low at main.
    const aAtSecond = atSecond.find((r) => r.id === productA.id);
    assert.ok(aAtSecond);
    assert.equal(aAtSecond.availableQuantity, 0);
  });

  it('creates exactly one DRAFT with server-computed quantities, and no stock movement', async () => {
    const rows = await restockRows(owner, location);
    const items = selection(rows, [productA, productC]);
    assert.equal(items.length, 2);
    const key = uniqueName('draft-key');
    const beforeTxns = await InventoryTransaction.countDocuments({ businessId: owner.businessId });

    const res = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items, notes: 'Restock review' },
      key,
    );
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.status, 'DRAFT');
    assert.equal(res.json.itemCount, 2);
    assert.equal(res.json.supplier.id, supplier.id);
    assert.equal(res.json.location.id, location.id);
    const lineA = res.json.items.find((i) => i.productId === productA.id);
    const lineC = res.json.items.find((i) => i.productId === productC.id);
    assert.equal(lineA.quantityOrdered, 3, '5 minimum − 2 available');
    assert.equal(lineC.quantityOrdered, 3, '3 minimum − 0 available');

    const replay = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items, notes: 'Restock review' },
      key,
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.json));
    assert.equal(replay.json.id, res.json.id);
    assert.equal(await PurchaseOrder.countDocuments({ businessId: owner.businessId }), 1);
    assert.equal(
      await InventoryTransaction.countDocuments({ businessId: owner.businessId }),
      beforeTxns,
      'creating a draft must not move stock',
    );
  });

  it('replays one DRAFT when the process died after commit but before the response was recorded', async () => {
    const rows = await restockRows(owner, location);
    const items = selection(rows, [productC]);
    const key = uniqueName('crash-window-key');
    const countBefore = await PurchaseOrder.countDocuments({ businessId: owner.businessId });

    const first = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items, notes: 'one draft only' },
      key,
    );
    assert.equal(first.status, 201, JSON.stringify(first.json));

    // Simulate the exact crash window: the DRAFT committed, but the process died
    // before the middleware stored the response. The claim is left IN_PROGRESS and
    // stale, so the next delivery is allowed to run the handler again.
    const claim = await IdempotencyRecord.findOne({ key }).lean();
    assert.ok(claim, 'the first delivery claimed the key');
    await IdempotencyRecord.updateOne(
      { _id: claim._id },
      {
        $set: { state: 'IN_PROGRESS', createdAt: new Date(Date.now() - 120_000) },
        $unset: { responseStatus: 1, responseBody: 1 },
      },
    );

    const retry = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items, notes: 'one draft only' },
      key,
    );
    assert.equal(retry.status, 201, JSON.stringify(retry.json));
    assert.equal(retry.json.id, first.json.id);
    assert.equal(retry.json.status, 'DRAFT');
    assert.equal(await PurchaseOrder.countDocuments({ businessId: owner.businessId }), countBefore + 1);

    const stored = await PurchaseOrder.findOne({
      businessId: owner.businessId,
      requestKey: key,
    }).lean();
    assert.ok(stored, 'the DRAFT itself carries the durable key');
    assert.equal(String(stored._id), first.json.id);

    const indexes = await PurchaseOrder.collection.indexes();
    assert.ok(
      indexes.some(
        (index) =>
          index.unique === true &&
          index.key?.businessId === 1 &&
          index.key?.requestKey === 1,
      ),
      'the durable key is protected by a unique compound index',
    );

    // A stale claim with a DIFFERENT body must not receive the first order.
    await IdempotencyRecord.updateOne(
      { key },
      {
        $set: { state: 'IN_PROGRESS', createdAt: new Date(Date.now() - 120_000) },
        $unset: { responseStatus: 1, responseBody: 1 },
      },
    );
    const different = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items, notes: 'different body' },
      key,
    );
    assert.equal(different.status, 422, JSON.stringify(different.json));
    assert.equal(different.json.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await PurchaseOrder.countDocuments({ businessId: owner.businessId }), countBefore + 1);
  });

  it('refuses stale rows before allocating an order', async () => {
    const rows = await restockRows(owner, location);
    const old = selection(rows, [productA]);
    assert.equal(old.length, 1);
    const countBefore = await PurchaseOrder.countDocuments({ businessId: owner.businessId });

    // A concurrent stock-in changes the displayed availability.
    await stockIn(owner, productA, location, 1);
    const stale = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: location.id, items: old },
      uniqueName('stale-key'),
    );
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.equal(stale.json.code, 'RESTOCK_ROWS_STALE');
    assert.ok(Array.isArray(stale.json.fields) && stale.json.fields.length > 0);
    assert.match(stale.json.fields[0].message, /refresh/i);
    assert.equal(await PurchaseOrder.countDocuments({ businessId: owner.businessId }), countBefore);

    // Move the product above its minimum: even a corrected quantity snapshot
    // must be refused, because the row no longer belongs on the restock list.
    await stockIn(owner, productA, location, 20);
    const freshRows = await restockRows(owner, location);
    assert.ok(!freshRows.some((r) => r.id === productA.id));
    const noLongerLow = await post(
      '/api/purchase-orders/from-restock',
      owner,
      {
        supplierId: supplier.id,
        locationId: location.id,
        items: [{ productId: productA.id, availableQuantity: 23, minimumStock: 5 }],
      },
      uniqueName('not-low-key'),
    );
    assert.equal(noLongerLow.status, 409, JSON.stringify(noLongerLow.json));
    assert.equal(noLongerLow.json.code, 'RESTOCK_ROWS_STALE');
    assert.equal(await PurchaseOrder.countDocuments({ businessId: owner.businessId }), countBefore);
  });

  it('isolates every reference and keeps RBAC at purchase-orders.manage', async () => {
    const rows = await restockRows(owner, location);
    const items = selection(rows, [productC]);

    const foreignSupplierResult = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: foreignSupplier.id, locationId: location.id, items },
      uniqueName('foreign-sup-key'),
    );
    assert.equal(foreignSupplierResult.status, 404, JSON.stringify(foreignSupplierResult.json));
    assert.equal(foreignSupplierResult.json.code, 'SUPPLIER_NOT_FOUND');

    const foreignLocationResult = await post(
      '/api/purchase-orders/from-restock',
      owner,
      { supplierId: supplier.id, locationId: foreignLocation.id, items },
      uniqueName('foreign-loc-key'),
    );
    assert.equal(foreignLocationResult.status, 404, JSON.stringify(foreignLocationResult.json));
    assert.equal(foreignLocationResult.json.code, 'LOCATION_NOT_FOUND');

    const foreignProductResult = await post(
      '/api/purchase-orders/from-restock',
      owner,
      {
        supplierId: supplier.id,
        locationId: location.id,
        items: [{ productId: foreignProduct.id, availableQuantity: 0, minimumStock: 0 }],
      },
      uniqueName('foreign-prod-key'),
    );
    assert.equal(foreignProductResult.status, 404, JSON.stringify(foreignProductResult.json));
    assert.equal(foreignProductResult.json.code, 'PRODUCT_NOT_FOUND');

    // A bad row after a valid row must name its ORIGINAL index, not the index
    // inside the filtered missing-product list.
    const foreignAfterValid = await post(
      '/api/purchase-orders/from-restock',
      owner,
      {
        supplierId: supplier.id,
        locationId: location.id,
        items: [
          ...selection(rows, [productC]),
          { productId: foreignProduct.id, availableQuantity: 0, minimumStock: 0 },
        ],
      },
      uniqueName('foreign-after-valid-key'),
    );
    assert.equal(foreignAfterValid.status, 404, JSON.stringify(foreignAfterValid.json));
    assert.equal(foreignAfterValid.json.fields[0].field, 'items[1].productId');

    const staff = await api('POST', '/api/purchase-orders/from-restock', {
      token: staffToken,
      body: { supplierId: supplier.id, locationId: location.id, items },
    });
    assert.equal(staff.status, 403, JSON.stringify(staff.json));

    const manager = await api('POST', '/api/purchase-orders/from-restock', {
      token: managerToken,
      body: { supplierId: supplier.id, locationId: location.id, items },
      headers: { 'idempotency-key': uniqueName('manager-key') },
    });
    assert.equal(manager.status, 201, JSON.stringify(manager.json));
    assert.equal(manager.json.status, 'DRAFT');
    assert.equal(manager.json.receipts.length, 0);
    assert.equal(manager.json.totals.quantityReceived, 0);
  });

  it('validates the shape and requires a non-empty selection', async () => {
    const noKey = await post('/api/purchase-orders/from-restock', owner, {
      supplierId: supplier.id,
      locationId: location.id,
      items: [{ productId: productC.id, availableQuantity: 0, minimumStock: 3 }],
    });
    assert.equal(noKey.status, 400, JSON.stringify(noKey.json));
    assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const empty = await post('/api/purchase-orders/from-restock', owner, {
      supplierId: supplier.id,
      locationId: location.id,
      items: [],
    }, uniqueName('empty-selection-key'));
    assert.equal(empty.status, 400, JSON.stringify(empty.json));
    assert.equal(empty.json.code, 'VALIDATION_ERROR');

    const duplicate = await post('/api/purchase-orders/from-restock', owner, {
      supplierId: supplier.id,
      locationId: location.id,
      items: [
        { productId: productC.id, availableQuantity: 0, minimumStock: 3 },
        { productId: productC.id, availableQuantity: 0, minimumStock: 3 },
      ],
    }, uniqueName('duplicate-row-key'));
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.json));
    assert.ok(duplicate.json.fields.some((f) => /duplicate/i.test(f.message)));
  });
});
