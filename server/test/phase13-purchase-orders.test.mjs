// Phase 13B — Purchase Orders core (backend, no stock writes).
//
// DB-backed suite over the real HTTP app. Covers: business-scoped sequential
// numbering (+ uniqueness under concurrent creates via the unique index + retry),
// DRAFT creation with item snapshots + computed totals + quantityReceived 0,
// supplier/location/product reference ownership + ACTIVE enforcement (404/409),
// structural validation 400s, DRAFT-only editing with reference re-validation,
// issue (DRAFT->OPEN) and cancel (DRAFT|OPEN->CANCELED) with every illegal
// transition guarded, RBAC (STAFF cannot manage; reads open to members; MANAGER
// may), cross-business isolation, and that NO inventory/inventory-transaction
// record is created anywhere in this phase. Registered as MIXED in run-tests.mjs.

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
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';

const { ObjectId } = mongoose.Types;

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const poUrl = (id) => `/api/purchase-orders/${id}`;

async function newSupplier(biz) {
  const res = await api('POST', '/api/suppliers', { token: biz.token, body: { name: uniqueName('S13B') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newLocation(biz) {
  const res = await api('POST', '/api/locations', { token: biz.token, body: { name: uniqueName('L13B') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(biz, over = {}) {
  const res = await api('POST', '/api/products', { token: biz.token, body: { currency: 'PHP', name: uniqueName('P13B'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function archive(biz, path) {
  const res = await api('POST', path, { token: biz.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

let main; // primary fixture business (OWNER)
let other; // isolation victim business (OWNER)
let numBiz; // dedicated business for exact sequential-number assertions
let concBiz; // dedicated business for the concurrent-numbering test
let staffMain; // STAFF inside `main`
let managerMain; // MANAGER inside `main`

let supplierA; // ACTIVE (main)
let supplierB; // ACTIVE (main) — for re-pointing a PO
let archSupplier; // (main) archived later
let locationA; // ACTIVE (main)
let archLocation; // (main) archived later
let productA; // ACTIVE (main)
let productB; // ACTIVE (main)
let archProduct; // (main) archived later
let foreignSupplier; // ACTIVE (other)
let foreignLocation; // ACTIVE (other)
let foreignProduct; // ACTIVE (other)

let ns; // supplier (numBiz)
let nl; // location (numBiz)
let np; // product with SKU (numBiz)
let cs; // supplier (concBiz)
let cl; // location (concBiz)
let cp; // product (concBiz)

dbSuite('Phase 13B — purchase orders core over real HTTP', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    numBiz = await registerOwner(api, tracker);
    concBiz = await registerOwner(api, tracker);
    staffMain = await makeRoleUser({ role: ROLES.STAFF, businessId: main.businessId }, tracker);
    managerMain = await makeRoleUser({ role: ROLES.MANAGER, businessId: main.businessId }, tracker);

    supplierA = await newSupplier(main);
    supplierB = await newSupplier(main);
    archSupplier = await newSupplier(main);
    locationA = await newLocation(main);
    archLocation = await newLocation(main);
    productA = await newProduct(main, { sku: uniqueName('SKU-A') });
    productB = await newProduct(main, { sku: uniqueName('SKU-B') });
    archProduct = await newProduct(main);
    foreignSupplier = await newSupplier(other);
    foreignLocation = await newLocation(other);
    foreignProduct = await newProduct(other);

    ns = await newSupplier(numBiz);
    nl = await newLocation(numBiz);
    np = await newProduct(numBiz, { sku: uniqueName('SKU-N') });
    cs = await newSupplier(concBiz);
    cl = await newLocation(concBiz);
    cp = await newProduct(concBiz);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('creates a DRAFT PO (PO-0001) with item snapshots, ACTIVE refs and computed totals', async () => {
    const res = await api('POST', '/api/purchase-orders', {
      token: numBiz.token,
      body: {
        supplierId: ns.id,
        locationId: nl.id,
        items: [{ productId: np.id, quantityOrdered: 2, unitCost: 5 }],
        expectedAt: '2026-10-01T00:00:00.000Z',
        notes: 'Initial order',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const po = res.json;
    assert.equal(po.number, 'PO-0001');
    assert.equal(po.status, 'DRAFT');
    assert.equal(po.supplier.id, ns.id);
    assert.equal(po.supplier.name, ns.name);
    assert.equal(po.supplier.status, 'ACTIVE');
    assert.equal(po.location.id, nl.id);
    assert.equal(po.location.name, nl.name);
    assert.equal(po.notes, 'Initial order');
    assert.equal(new Date(po.expectedAt).toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(po.itemCount, 1);
    assert.deepEqual(po.totals, {
      quantityOrdered: 2,
      quantityReceived: 0,
      remainingQuantity: 2,
      estimatedCost: 10,
    });

    const get = await api('GET', poUrl(po.id), { token: numBiz.token });
    assert.equal(get.status, 200, JSON.stringify(get.json));
    assert.equal(get.json.items.length, 1);
    const item = get.json.items[0];
    assert.equal(item.productId, np.id);
    assert.equal(item.productName, np.name, 'product name is snapshotted');
    assert.equal(item.sku, np.sku, 'sku is snapshotted');
    assert.equal(item.quantityOrdered, 2);
    assert.equal(item.quantityReceived, 0, 'quantityReceived starts at 0');
    assert.equal(item.remainingQuantity, 2);
    assert.equal(item.unitCost, 5);
  });

  it('numbers POs sequentially per business and independently across businesses', async () => {
    const second = await api('POST', '/api/purchase-orders', {
      token: numBiz.token,
      body: { supplierId: ns.id, locationId: nl.id, items: [{ productId: np.id, quantityOrdered: 3 }] },
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.number, 'PO-0002');

    // A different business starts its own sequence at PO-0001.
    const inOther = await api('POST', '/api/purchase-orders', {
      token: other.token,
      body: {
        supplierId: foreignSupplier.id,
        locationId: foreignLocation.id,
        items: [{ productId: foreignProduct.id, quantityOrdered: 1 }],
      },
    });
    assert.equal(inOther.status, 201, JSON.stringify(inOther.json));
    assert.equal(inOther.json.number, 'PO-0001');
    assert.equal(inOther.json.businessId, other.businessId);
  });

  it('keeps PO numbers unique under concurrent creates (unique index + retry)', async () => {
    const attempts = Array.from({ length: 6 }, () =>
      api('POST', '/api/purchase-orders', {
        token: concBiz.token,
        body: { supplierId: cs.id, locationId: cl.id, items: [{ productId: cp.id, quantityOrdered: 1, unitCost: 2.5 }] },
      })
    );
    const results = await Promise.all(attempts);
    for (const r of results) {
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    const numbers = results.map((r) => r.json.number);
    assert.equal(new Set(numbers).size, 6, `expected 6 unique numbers, got ${numbers.join(',')}`);
    for (const n of numbers) assert.match(n, /^PO-\d+$/);

    const list = await api('GET', '/api/purchase-orders?limit=100', { token: concBiz.token });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 6);
  });

  it('rejects references owned by another business with 404 (isolation)', async () => {
    const foreignSupplierBlock = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: foreignSupplier.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(foreignSupplierBlock.status, 404, JSON.stringify(foreignSupplierBlock.json));
    assert.equal(foreignSupplierBlock.json.code, 'SUPPLIER_NOT_FOUND');

    const foreignLocationBlock = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: foreignLocation.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(foreignLocationBlock.status, 404, JSON.stringify(foreignLocationBlock.json));
    assert.equal(foreignLocationBlock.json.code, 'LOCATION_NOT_FOUND');

    const foreignProductBlock = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: foreignProduct.id, quantityOrdered: 1 }] },
    });
    assert.equal(foreignProductBlock.status, 404, JSON.stringify(foreignProductBlock.json));
    assert.equal(foreignProductBlock.json.code, 'PRODUCT_NOT_FOUND');
  });

  it('rejects archived supplier/location/product references with 409', async () => {
    const as = await archive(main, `/api/suppliers/${archSupplier.id}/archive`);
    assert.equal(as.status, 'ARCHIVED');
    const archivedSupplierPo = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: archSupplier.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(archivedSupplierPo.status, 409, JSON.stringify(archivedSupplierPo.json));
    assert.equal(archivedSupplierPo.json.code, 'SUPPLIER_ARCHIVED');

    const al = await archive(main, `/api/locations/${archLocation.id}/archive`);
    assert.equal(al.status, 'ARCHIVED');
    const archivedLocationPo = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: archLocation.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(archivedLocationPo.status, 409, JSON.stringify(archivedLocationPo.json));
    assert.equal(archivedLocationPo.json.code, 'LOCATION_ARCHIVED');

    const ap = await archive(main, `/api/products/${archProduct.id}/archive`);
    assert.equal(ap.status, 'ARCHIVED');
    const archivedProductPo = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: archProduct.id, quantityOrdered: 1 }] },
    });
    assert.equal(archivedProductPo.status, 409, JSON.stringify(archivedProductPo.json));
    assert.equal(archivedProductPo.json.code, 'PRODUCT_ARCHIVED');
  });

  it('validates PO payloads structurally (400 VALIDATION_ERROR)', async () => {
    const cases = [
      { name: 'missing everything', body: {} },
      {
        name: 'missing supplierId',
        body: { locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
      },
      {
        name: 'missing locationId',
        body: { supplierId: supplierA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
      },
      { name: 'empty items', body: { supplierId: supplierA.id, locationId: locationA.id, items: [] } },
      {
        name: 'zero quantity',
        body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 0 }] },
      },
      {
        name: 'negative unitCost',
        body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1, unitCost: -1 }] },
      },
      {
        name: 'bad expectedAt',
        body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }], expectedAt: 'not-a-date' },
      },
      {
        name: 'bad productId',
        body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: 'abc', quantityOrdered: 1 }] },
      },
    ];
    for (const c of cases) {
      const res = await api('POST', '/api/purchase-orders', { token: main.token, body: c.body });
      assert.equal(res.status, 400, `${c.name}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.code, 'VALIDATION_ERROR', c.name);
    }

    const dup = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: {
        supplierId: supplierA.id,
        locationId: locationA.id,
        items: [
          { productId: productA.id, quantityOrdered: 1 },
          { productId: productA.id, quantityOrdered: 2 },
        ],
      },
    });
    assert.equal(dup.status, 400, JSON.stringify(dup.json));
    assert.ok(
      dup.json.fields.some((f) => f.field === 'items[1].productId' && f.message.includes('duplicate')),
      JSON.stringify(dup.json.fields)
    );
  });

  it('keeps reads open to members and blocks STAFF from managing (401/403/200)', async () => {
    const noToken = await api('GET', '/api/purchase-orders', {});
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, 'AUTH_REQUIRED');

    const staffCreate = await api('POST', '/api/purchase-orders', {
      token: staffMain.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(staffCreate.status, 403, JSON.stringify(staffCreate.json));
    assert.equal(staffCreate.json.code, 'FORBIDDEN');

    // MANAGER may create (positive RBAC).
    const mgrPo = await api('POST', '/api/purchase-orders', {
      token: managerMain.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(mgrPo.status, 201, JSON.stringify(mgrPo.json));

    // STAFF may read the detail and list.
    const staffGet = await api('GET', poUrl(mgrPo.json.id), { token: staffMain.token });
    assert.equal(staffGet.status, 200, JSON.stringify(staffGet.json));
    const staffList = await api('GET', '/api/purchase-orders?limit=100', { token: staffMain.token });
    assert.equal(staffList.status, 200);

    // STAFF is refused every mutation verb.
    const staffPatch = await api('PATCH', poUrl(mgrPo.json.id), { token: staffMain.token, body: { notes: 'x' } });
    assert.equal(staffPatch.status, 403);
    const staffIssue = await api('POST', `${poUrl(mgrPo.json.id)}/issue`, { token: staffMain.token });
    assert.equal(staffIssue.status, 403);
    const staffCancel = await api('POST', `${poUrl(mgrPo.json.id)}/cancel`, { token: staffMain.token });
    assert.equal(staffCancel.status, 403);

    // MANAGER can issue (positive RBAC) and the order is now OPEN.
    const mgrIssue = await api('POST', `${poUrl(mgrPo.json.id)}/issue`, { token: managerMain.token });
    assert.equal(mgrIssue.status, 200, JSON.stringify(mgrIssue.json));
    assert.equal(mgrIssue.json.status, 'OPEN');
    assert.equal(mgrIssue.json.items[0].quantityReceived, 0);
  });

  it('issues DRAFT -> OPEN, guards illegal transitions, and moves no stock', async () => {
    const created = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 4, unitCost: 3 }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;
    const number = created.json.number;
    assert.equal(created.json.status, 'DRAFT');

    const issue = await api('POST', `${poUrl(id)}/issue`, { token: main.token });
    assert.equal(issue.status, 200, JSON.stringify(issue.json));
    assert.equal(issue.json.status, 'OPEN');
    assert.equal(issue.json.totals.quantityReceived, 0, 'issuing moves no stock');

    const issueAgain = await api('POST', `${poUrl(id)}/issue`, { token: main.token });
    assert.equal(issueAgain.status, 409);
    assert.equal(issueAgain.json.code, 'PO_ALREADY_OPEN');

    const cancel = await api('POST', `${poUrl(id)}/cancel`, { token: main.token });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
    assert.equal(cancel.json.status, 'CANCELED');

    const cancelAgain = await api('POST', `${poUrl(id)}/cancel`, { token: main.token });
    assert.equal(cancelAgain.status, 409);
    assert.equal(cancelAgain.json.code, 'PO_ALREADY_CANCELED');

    const issueCanceled = await api('POST', `${poUrl(id)}/issue`, { token: main.token });
    assert.equal(issueCanceled.status, 409);
    assert.equal(issueCanceled.json.code, 'PO_CANCELED');

    // A DRAFT may also be canceled directly.
    const draftToCancel = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productB.id, quantityOrdered: 2 }] },
    });
    assert.equal(draftToCancel.status, 201);
    const c = await api('POST', `${poUrl(draftToCancel.json.id)}/cancel`, { token: main.token });
    assert.equal(c.status, 200);
    assert.equal(c.json.status, 'CANCELED');

    // A canceled order cannot be edited.
    const patchCanceled = await api('PATCH', poUrl(draftToCancel.json.id), { token: main.token, body: { notes: 'nope' } });
    assert.equal(patchCanceled.status, 409);
    assert.equal(patchCanceled.json.code, 'PO_NOT_DRAFT');

    // Phase 13B must never touch the ledger: no inventory transaction references
    // this PO number (stock movement is Phase 13C receiving).
    const txnCount = await InventoryTransaction.countDocuments({
      businessId: new ObjectId(main.businessId),
      reference: number,
    });
    assert.equal(txnCount, 0, `no inventory transaction may reference PO ${number}`);
  });

  it('edits a DRAFT only, re-validating references, and freezes after issue', async () => {
    const created = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;

    // Re-point supplier + set notes/expectedAt.
    const repoint = await api('PATCH', poUrl(id), {
      token: main.token,
      body: { supplierId: supplierB.id, notes: 'Urgent', expectedAt: '2026-11-15T00:00:00.000Z' },
    });
    assert.equal(repoint.status, 200, JSON.stringify(repoint.json));
    assert.equal(repoint.json.supplier.id, supplierB.id);
    assert.equal(repoint.json.notes, 'Urgent');
    assert.equal(new Date(repoint.json.expectedAt).toISOString(), '2026-11-15T00:00:00.000Z');

    // Replace the item set — snapshot + quantityReceived reset to 0.
    const reline = await api('PATCH', poUrl(id), {
      token: main.token,
      body: { items: [{ productId: productB.id, quantityOrdered: 7, unitCost: 1.5 }] },
    });
    assert.equal(reline.status, 200, JSON.stringify(reline.json));
    assert.equal(reline.json.itemCount, 1);
    assert.equal(reline.json.items[0].productId, productB.id);
    assert.equal(reline.json.items[0].productName, productB.name);
    assert.equal(reline.json.items[0].quantityOrdered, 7);
    assert.equal(reline.json.items[0].quantityReceived, 0);
    assert.equal(reline.json.items[0].remainingQuantity, 7);
    assert.deepEqual(reline.json.totals, {
      quantityOrdered: 7,
      quantityReceived: 0,
      remainingQuantity: 7,
      estimatedCost: 10.5,
    });

    // A no-op PATCH is a 200 with state unchanged.
    const noop = await api('PATCH', poUrl(id), { token: main.token, body: {} });
    assert.equal(noop.status, 200, JSON.stringify(noop.json));
    assert.equal(noop.json.status, 'DRAFT');

    // Pointing at an archived supplier is rejected while still DRAFT.
    const badSupplier = await api('PATCH', poUrl(id), { token: main.token, body: { supplierId: archSupplier.id } });
    assert.equal(badSupplier.status, 409, JSON.stringify(badSupplier.json));
    assert.equal(badSupplier.json.code, 'SUPPLIER_ARCHIVED');

    // Freeze: after issue, nothing may be edited.
    const issue = await api('POST', `${poUrl(id)}/issue`, { token: main.token });
    assert.equal(issue.status, 200);
    const afterIssue = await api('PATCH', poUrl(id), { token: main.token, body: { notes: 'too late' } });
    assert.equal(afterIssue.status, 409);
    assert.equal(afterIssue.json.code, 'PO_NOT_DRAFT');
  });

  it('lists POs and filters by status, supplier and number', async () => {
    const mk = async (status) => {
      const created = await api('POST', '/api/purchase-orders', {
        token: numBiz.token,
        body: { supplierId: ns.id, locationId: nl.id, items: [{ productId: np.id, quantityOrdered: 1 }] },
      });
      assert.equal(created.status, 201);
      const id = created.json.id;
      if (status === 'OPEN') await api('POST', `${poUrl(id)}/issue`, { token: numBiz.token });
      if (status === 'CANCELED') await api('POST', `${poUrl(id)}/cancel`, { token: numBiz.token });
      return id;
    };
    const draftId = await mk('DRAFT');
    const openId = await mk('OPEN');
    const canceledId = await mk('CANCELED');

    const openList = await api('GET', '/api/purchase-orders?status=OPEN&limit=100', { token: numBiz.token });
    assert.equal(openList.status, 200);
    assert.ok(openList.json.items.some((p) => p.id === openId));
    assert.ok(!openList.json.items.some((p) => p.id === draftId));
    assert.ok(!openList.json.items.some((p) => p.id === canceledId));

    const draftList = await api('GET', '/api/purchase-orders?status=DRAFT&limit=100', { token: numBiz.token });
    assert.ok(draftList.json.items.some((p) => p.id === draftId));

    const canceledList = await api('GET', '/api/purchase-orders?status=CANCELED&limit=100', { token: numBiz.token });
    assert.ok(canceledList.json.items.some((p) => p.id === canceledId));

    const bySupplier = await api('GET', `/api/purchase-orders?supplierId=${ns.id}&limit=100`, { token: numBiz.token });
    assert.equal(bySupplier.status, 200);
    assert.ok(bySupplier.json.items.every((p) => p.supplier.id === ns.id));
    assert.ok(bySupplier.json.items.some((p) => p.id === openId));

    // q searches the PO number.
    const openNumber = openList.json.items.find((p) => p.id === openId).number;
    const byNumber = await api('GET', `/api/purchase-orders?q=${encodeURIComponent(openNumber)}`, { token: numBiz.token });
    assert.equal(byNumber.status, 200);
    assert.equal(byNumber.json.items.length, 1);
    assert.equal(byNumber.json.items[0].id, openId);

    // Header rows carry totals but no item lines.
    const header = openList.json.items.find((p) => p.id === openId);
    assert.equal(header.itemCount, 1);
    assert.equal(header.totals.quantityOrdered, 1);
    assert.equal(header.items, undefined, 'list rows are headers, not details');
  });

  it('isolates cross-business access to an existing PO (404) and rejects bad ids (400)', async () => {
    const mine = await api('POST', '/api/purchase-orders', {
      token: main.token,
      body: { supplierId: supplierA.id, locationId: locationA.id, items: [{ productId: productA.id, quantityOrdered: 1 }] },
    });
    assert.equal(mine.status, 201);

    // `other` cannot read, edit, issue or cancel `main`'s PO.
    const foreignGet = await api('GET', poUrl(mine.json.id), { token: other.token });
    assert.equal(foreignGet.status, 404);
    assert.equal(foreignGet.json.code, 'PO_NOT_FOUND');
    const foreignPatch = await api('PATCH', poUrl(mine.json.id), { token: other.token, body: { notes: 'hijack' } });
    assert.equal(foreignPatch.status, 404);
    const foreignIssue = await api('POST', `${poUrl(mine.json.id)}/issue`, { token: other.token });
    assert.equal(foreignIssue.status, 404);
    const foreignCancel = await api('POST', `${poUrl(mine.json.id)}/cancel`, { token: other.token });
    assert.equal(foreignCancel.status, 404);

    // A nonexistent id within the business is also 404.
    const missing = await api('GET', poUrl('000000000000000000000000'), { token: main.token });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'PO_NOT_FOUND');

    // Malformed ids are 400 INVALID_ID on every verb.
    const badId = 'not-an-object-id';
    for (const verb of ['GET', 'PATCH']) {
      const r = await api(verb, poUrl(badId), verb === 'PATCH' ? { token: main.token, body: {} } : { token: main.token });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'INVALID_ID');
    }
    for (const verb of ['issue', 'cancel']) {
      const r = await api('POST', `${poUrl(badId)}/${verb}`, { token: main.token });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'INVALID_ID');
    }
  });
});
