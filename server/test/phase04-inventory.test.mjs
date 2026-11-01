// Phase 04 — Inventory core + dashboard: stock in/out/adjust semantics,
// negative-stock prevention, concurrency, history, low/out-of-stock logic,
// RBAC, business isolation, validation and audit logging. Integration tests
// against the real shipped app + MongoDB (DB-backed; fails loudly when MongoDB
// is unreachable — Phase 07F / M9).

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueName,
  stampField,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import { ROLES } from '../src/constants/roles.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner; // Business A
let other; // Business B (isolation)
let status; // business with controlled low/out-of-stock data
let dash; // business with controlled dashboard data
let hist; // business with controlled history data
let staff;
let manager;

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { name: uniqueName('P'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business, over = {}) {
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: uniqueName('Loc'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function stockIn(business, productId, locationId, quantity, over = {}) {
  return api('POST', '/api/inventory/stock-in', {
    token: business.token,
    body: { productId, locationId, quantity, ...over },
  });
}

async function stockOut(business, productId, locationId, quantity, over = {}) {
  return api('POST', '/api/inventory/stock-out', {
    token: business.token,
    body: { productId, locationId, quantity, ...over },
  });
}

async function adjust(business, productId, locationId, quantity, over = {}) {
  return api('POST', '/api/inventory/adjust', {
    token: business.token,
    // A reason is mandatory on this endpoint; callers that are not testing that
    // rule get a default so the quantity semantics stay the subject of the test.
    body: { productId, locationId, quantity, reason: 'test adjustment', ...over },
  });
}

async function row(productId, locationId, businessId) {
  return Inventory.findOne({ businessId, productId, locationId });
}

async function txnCount(businessId, productId, locationId, type) {
  return InventoryTransaction.countDocuments({ businessId, productId, locationId, type });
}

async function auditExists(businessId, action) {
  return AuditLog.exists({ businessId, action });
}

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 04 — inventory core + dashboard', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    status = await registerOwner(api, tracker);
    dash = await registerOwner(api, tracker);
    hist = await registerOwner(api, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
  });

  it('stock movements require authentication (401)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const res = await api('POST', '/api/inventory/stock-in', {
      body: { productId: p, locationId: l, quantity: 5 },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'AUTH_REQUIRED');
  });

  it('validates movement input (quantity integer > 0, ids present/valid)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);

    const zero = await stockIn(owner, p, l, 0);
    assert.equal(zero.status, 400);
    assert.ok(zero.json.fields.some((f) => f.field === 'quantity'));

    const frac = await stockIn(owner, p, l, 2.5);
    assert.equal(frac.status, 400);
    assert.ok(frac.json.fields.some((f) => f.field === 'quantity'));

    const noProduct = await stockIn(owner, undefined, l, 5);
    assert.equal(noProduct.status, 400);
    assert.ok(noProduct.json.fields.some((f) => f.field === 'productId'));

    const badId = await stockIn(owner, 'zzzz', l, 5);
    assert.equal(badId.status, 400);
    assert.ok(badId.json.fields.some((f) => f.field === 'productId'));
  });

  it('stock-in creates the inventory row, a transaction and an audit log', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const res = await stockIn(owner, p, l, 10, { reason: 'initial', reference: 'INV-1' });
    assert.equal(res.status, 201);
    assert.equal(res.json.transaction.type, 'STOCK_IN');
    assert.equal(res.json.previousQuantity, 0);
    assert.equal(res.json.newQuantity, 10);
    assert.equal(res.json.transaction.previousQuantity, 0);
    assert.equal(res.json.transaction.newQuantity, 10);
    assert.equal(res.json.transaction.quantity, 10);
    assert.equal(res.json.transaction.reference, 'INV-1');

    const inv = await row(p, l, owner.businessId);
    assert.ok(inv);
    assert.equal(inv.quantity, 10);
    assert.equal(inv.reservedQuantity, 0);
    assert.equal(inv.availableQuantity, 10);
    assert.equal(await txnCount(owner.businessId, p, l, 'STOCK_IN'), 1);
    assert.ok(await auditExists(owner.businessId, 'INVENTORY_STOCK_IN'));

    const list = await api('GET', `/api/inventory?productId=${p}&locationId=${l}`, { token: owner.token });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    const item = list.json.items[0];
    assert.equal(item.product.id, p);
    assert.equal(item.location.id, l);
    assert.equal(item.quantity, 10);
    assert.equal(item.availableQuantity, 10);
    assert.equal(item.isOutOfStock, false);
  });

  it('stock-out succeeds when available, is atomic, and writes prev/new', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 10);
    const res = await stockOut(owner, p, l, 4, { reason: 'sale' });
    assert.equal(res.status, 200);
    assert.equal(res.json.previousQuantity, 10);
    assert.equal(res.json.newQuantity, 6);
    assert.equal(res.json.transaction.type, 'STOCK_OUT');
    assert.equal(await row(p, l, owner.businessId).then((x) => x.quantity), 6);
    assert.ok(await auditExists(owner.businessId, 'INVENTORY_STOCK_OUT'));
  });

  it('rejects stock-out above available stock (409) and never goes negative', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 6);
    const res = await stockOut(owner, p, l, 7);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'INSUFFICIENT_STOCK');
    assert.equal((await row(p, l, owner.businessId)).quantity, 6);
    assert.equal(await txnCount(owner.businessId, p, l, 'STOCK_OUT'), 0);
  });

  it('stock-out exactly to zero is allowed, then further stock-out is 409', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 5);
    assert.equal((await stockOut(owner, p, l, 5)).status, 200);
    assert.equal((await row(p, l, owner.businessId)).quantity, 0);
    const blocked = await stockOut(owner, p, l, 1);
    assert.equal(blocked.status, 409);
    assert.equal((await row(p, l, owner.businessId)).quantity, 0);
  });

  it('stock-out on a missing row returns 404 INVENTORY_NOT_FOUND', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const res = await stockOut(owner, p, l, 1);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'INVENTORY_NOT_FOUND');
  });

  it('concurrent stock-outs never oversell (atomic availability guard)', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 10);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => stockOut(owner, p, l, 3))
    );
    const ok = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 409 && r.json.code === 'INSUFFICIENT_STOCK').length;
    assert.equal(ok, 3);
    assert.equal(rejected, 1);
    assert.equal((await row(p, l, owner.businessId)).quantity, 1);
    assert.equal(await txnCount(owner.businessId, p, l, 'STOCK_OUT'), 3);
  });

  it('adjustment sets absolute quantity, stores the magnitude, rejects no-change and negatives', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 5);

    const up = await adjust(owner, p, l, 20, { reason: 'stocktake' });
    assert.equal(up.status, 200);
    assert.equal(up.json.transaction.type, 'ADJUSTMENT');
    assert.equal(up.json.transaction.quantity, 15);
    assert.equal(up.json.previousQuantity, 5);
    assert.equal(up.json.newQuantity, 20);
    assert.equal((await row(p, l, owner.businessId)).quantity, 20);
    assert.ok(await auditExists(owner.businessId, 'INVENTORY_ADJUSTED'));

    const same = await adjust(owner, p, l, 20);
    assert.equal(same.status, 409);
    assert.equal(same.json.code, 'NO_CHANGE');
    assert.equal(await txnCount(owner.businessId, p, l, 'ADJUSTMENT'), 1);

    const down = await adjust(owner, p, l, 0);
    assert.equal(down.status, 200);
    assert.equal(down.json.newQuantity, 0);
    assert.equal((await row(p, l, owner.businessId)).quantity, 0);

    const neg = await adjust(owner, p, l, -3);
    assert.equal(neg.status, 400);

    const blocked = await stockOut(owner, p, l, 1);
    assert.equal(blocked.status, 409);
  });

  it('refuses an adjustment with no reason, and changes nothing', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 10);

    const missing = await api('POST', '/api/inventory/adjust', {
      token: owner.token,
      body: { productId: p, locationId: l, quantity: 4 },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.ok(
      (missing.json.fields ?? []).some((f) => f.field === 'reason'),
      'the refusal must name the reason field'
    );
    assert.equal((await row(p, l, owner.businessId)).quantity, 10, 'a refused adjustment changed stock');
    assert.equal(await txnCount(owner.businessId, p, l, 'ADJUSTMENT'), 0, 'a refused adjustment wrote a ledger row');

    // Whitespace is not a reason.
    const blank = await api('POST', '/api/inventory/adjust', {
      token: owner.token,
      body: { productId: p, locationId: l, quantity: 4, reason: '   ' },
    });
    assert.equal(blank.status, 400, JSON.stringify(blank.json));

    const withReason = await adjust(owner, p, l, 4, { reason: 'cycle count' });
    assert.equal(withReason.status, 200, JSON.stringify(withReason.json));
    assert.equal((await row(p, l, owner.businessId)).quantity, 4);
  });

  it('rejects movements against archived products and locations', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await api('POST', `/api/products/${p}/archive`, { token: owner.token });
    const prodArch = await stockIn(owner, p, l, 5);
    assert.equal(prodArch.status, 409);
    assert.equal(prodArch.json.code, 'PRODUCT_ARCHIVED');

    const p2 = await newProduct(owner);
    const l2 = await newLocation(owner);
    await api('POST', `/api/locations/${l2}/archive`, { token: owner.token });
    const locArch = await stockIn(owner, p2, l2, 5);
    assert.equal(locArch.status, 409);
    assert.equal(locArch.json.code, 'LOCATION_ARCHIVED');
  });

  // ---------------------------------------------------------------------------
  // Phase 21 — the archive-only lifecycle, seen from the inventory side.
  // Archiving is the terminal product state: it retires a product from new
  // movements WITHOUT touching the stock and the history it already has. The
  // declaration half of this (no delete route, no delete service method, no
  // deleted status) is pinned DB-free in phase21-product-archive-invariant.
  // ---------------------------------------------------------------------------

  it('rejects every movement type against an archived product', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    const l2 = await newLocation(owner);
    await stockIn(owner, p, l, 10);
    await api('POST', `/api/products/${p}/archive`, { token: owner.token });

    // assertOperationalProduct runs before any row is read (inventory.service.js
    // stock-out :361, transfer :445, adjust :617 — stock-in :288), so all four
    // paths answer 409 regardless of how much stock happens to exist. stock-out
    // and adjust are included precisely because they never create a row, and so
    // are not covered by the stock-in case above.
    const attempts = {
      'stock-in': await stockIn(owner, p, l, 1),
      'stock-out': await stockOut(owner, p, l, 1),
      adjust: await adjust(owner, p, l, 5),
      transfer: await api('POST', '/api/inventory/transfer', {
        token: owner.token,
        body: { productId: p, fromLocationId: l, toLocationId: l2, quantity: 1 },
      }),
    };
    for (const [name, res] of Object.entries(attempts)) {
      assert.equal(res.status, 409, `${name} should reject an archived product: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.code, 'PRODUCT_ARCHIVED', `${name} should report PRODUCT_ARCHIVED`);
    }

    // The refusals moved nothing: the archived product's stock is intact.
    assert.equal((await row(p, l, owner.businessId)).quantity, 10);
  });

  it('archiving a product retains its inventory row, quantity and history', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 8);
    await stockOut(owner, p, l, 3);

    const before = await row(p, l, owner.businessId);
    assert.equal(before.quantity, 5);

    const arch = await api('POST', `/api/products/${p}/archive`, { token: owner.token });
    assert.equal(arch.status, 200);
    assert.equal(arch.json.status, 'ARCHIVED');

    // The row survives archival, unchanged, on the same product and location.
    const after = await row(p, l, owner.businessId);
    assert.ok(after, 'archiving removed the inventory row');
    assert.equal(String(after._id), String(before._id));
    assert.equal(after.quantity, 5);

    // ...and it is still listed, still attributed to the archived product.
    const listed = await api('GET', `/api/inventory?productId=${p}`, { token: owner.token });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.total, 1);
    assert.equal(listed.json.items[0].quantity, 5);
    assert.equal(listed.json.items[0].product.id, p);
    assert.equal(listed.json.items[0].product.status, 'ARCHIVED');

    // The ledger is retained too, and still resolves the product's name.
    const hist = await api('GET', `/api/inventory/history?productId=${p}`, { token: owner.token });
    assert.equal(hist.status, 200);
    assert.equal(hist.json.total, 2);
    assert.equal(await txnCount(owner.businessId, p, l, 'STOCK_IN'), 1);
    assert.equal(await txnCount(owner.businessId, p, l, 'STOCK_OUT'), 1);
    assert.ok(hist.json.items.every((i) => i.product?.id === p && i.product?.name));
  });

  it('restoring an archived product makes it operational again', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);
    await stockIn(owner, p, l, 4);

    await api('POST', `/api/products/${p}/archive`, { token: owner.token });
    assert.equal((await stockIn(owner, p, l, 1)).status, 409);

    const rest = await api('POST', `/api/products/${p}/restore`, { token: owner.token });
    assert.equal(rest.status, 200);
    assert.equal(rest.json.status, 'ACTIVE');

    // The archived stock was never touched, so the movement resumes from it.
    const back = await stockIn(owner, p, l, 2);
    assert.equal(back.status, 201);
    assert.equal((await row(p, l, owner.businessId)).quantity, 6);
  });

  it('isolation: foreign product/location ids never match another business', async () => {
    const bp = await newProduct(other);
    const bl = await newLocation(other);
    await stockIn(other, bp, bl, 7);

    const crossIn = await stockIn(owner, bp, bl, 1);
    assert.equal(crossIn.status, 404);
    assert.equal(crossIn.json.code, 'PRODUCT_NOT_FOUND');

    const crossList = await api('GET', `/api/inventory?locationId=${bl}`, { token: owner.token });
    assert.equal(crossList.status, 200);
    assert.equal(crossList.json.total, 0);

    const ownList = await api('GET', `/api/inventory?locationId=${bl}`, { token: other.token });
    assert.equal(ownList.json.total, 1);
    assert.equal(ownList.json.items[0].quantity, 7);
  });

  it('isolation: a row that points at ANOTHER business\'s product exposes nothing (§27DE)', async () => {
    // The application cannot create this row — every write path resolves the product inside the
    // caller's business first. The listing's product lookup is now the simple `localField` form,
    // which resolves a document by `_id` ALONE, so this is the case that would leak if the tenant
    // guard beside it were ever dropped: the row's own `businessId` is the owner's, while its
    // product belongs to someone else.
    const foreignProduct = await newProduct(other, { name: 'FOREIGN-PRODUCT-SHOULD-NEVER-APPEAR' });
    const foreignLocation = await newLocation(other);
    const leaked = await Inventory.create({
      businessId: owner.businessId,
      productId: foreignProduct,
      locationId: foreignLocation,
      quantity: 42,
      reservedQuantity: 0,
    });

    try {
      const list = await api('GET', '/api/inventory?limit=100', { token: owner.token });
      assert.equal(list.status, 200);
      const asText = JSON.stringify(list.json);
      assert.ok(!asText.includes('FOREIGN-PRODUCT-SHOULD-NEVER-APPEAR'), 'the foreign product never appears');
      assert.ok(
        !list.json.items.some((i) => i.product?.id === foreignProduct),
        'no row carries the foreign product'
      );
      assert.ok(
        !list.json.items.some((i) => i.location?.id === foreignLocation),
        'no row carries the foreign location'
      );
    } finally {
      await Inventory.deleteOne({ _id: leaked._id });
    }
  });

  it('inventory list flags low stock / out of stock per spec §19', async () => {
    const l = await newLocation(status);
    // healthy (10 >= min 5)
    const healthy = await newProduct(status, { minimumStock: 5 });
    await stockIn(status, healthy, l, 10);
    // low only (3 <= min 3, but > 0)
    const lowOnly = await newProduct(status, { minimumStock: 3 });
    await stockIn(status, lowOnly, l, 3);
    // low AND out (0 stock)
    const gone = await newProduct(status, { minimumStock: 0 });
    await stockIn(status, gone, l, 1);
    await adjust(status, gone, l, 0);
    // low only (1 <= min 2)
    const scarce = await newProduct(status, { minimumStock: 2 });
    await stockIn(status, scarce, l, 1);

    const all = await api('GET', '/api/inventory', { token: status.token });
    assert.equal(all.json.total, 4);

    const low = await api('GET', '/api/inventory?lowStock=true', { token: status.token });
    assert.equal(low.json.total, 3);
    const lowIds = low.json.items.map((i) => i.product.id).sort();
    assert.deepEqual(lowIds, [lowOnly, gone, scarce].sort());

    const out = await api('GET', '/api/inventory?outOfStock=true', { token: status.token });
    assert.equal(out.json.total, 1);
    assert.equal(out.json.items[0].product.id, gone);
    assert.equal(out.json.items[0].isOutOfStock, true);
    assert.equal(out.json.items[0].isLowStock, true);

    // Products endpoint uses the same predicates (business-wide availability).
    const prodLow = await api('GET', '/api/products?lowStock=true', { token: status.token });
    const prodLowIds = prodLow.json.items.map((x) => x.id).sort();
    assert.deepEqual(prodLowIds, [lowOnly, gone, scarce].sort());
  });

  it('dashboard returns correct totals, low/out counts and recent activity', async () => {
    const l = await newLocation(dash);
    const d1 = await newProduct(dash, { minimumStock: 5 });
    await stockIn(dash, d1, l, 10);
    const d2 = await newProduct(dash, { minimumStock: 3 });
    await stockIn(dash, d2, l, 3);
    await newProduct(dash, { minimumStock: 0 }); // no stock row at all
    const d4 = await newProduct(dash, { minimumStock: 2 });
    await stockIn(dash, d4, l, 1);
    await api('POST', `/api/products/${d4}/archive`, { token: dash.token });

    const res = await api('GET', '/api/dashboard', { token: dash.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.totalProducts, 3); // active products only (d1,d2,d3)
    assert.equal(res.json.totalInventoryQuantity, 14); // includes archived d4 stock
    assert.equal(res.json.lowStockProducts, 2); // d2 (3<=3) + d3 (0<=0)
    assert.equal(res.json.outOfStockProducts, 1); // d3 only
    assert.equal(res.json.recentActivity.length, 3);
    const newest = res.json.recentActivity[0];
    assert.ok(newest.product?.name);
    assert.ok(newest.location?.name);
  });

  it('history is newest-first, filterable, searchable by type and paginated', async () => {
    const p = await newProduct(hist);
    const l = await newLocation(hist);
    const t1 = await stockIn(hist, p, l, 10);
    const t2 = await stockOut(hist, p, l, 3);
    const t3 = await stockIn(hist, p, l, 2);
    const t4 = await adjust(hist, p, l, 20);
    assert.equal([t1, t2, t3, t4].every((r) => r.status === 200 || r.status === 201), true);

    const all = await api('GET', '/api/inventory/history', { token: hist.token });
    assert.equal(all.json.total, 4);
    assert.equal(all.json.items.length, 4);
    assert.equal(all.json.items[0].type, 'ADJUSTMENT'); // newest first
    assert.ok(all.json.items[0].product?.name);
    assert.ok(all.json.items[0].location?.name);

    const ins = await api('GET', '/api/inventory/history?type=STOCK_IN', { token: hist.token });
    assert.equal(ins.json.total, 2);
    assert.ok(ins.json.items.every((i) => i.type === 'STOCK_IN'));

    // An unrecognised type is rejected. TRANSFER used to serve as this example
    // because it was reserved-but-unimplemented; Phase 19 made it a real,
    // filterable type, so the example is now a value that is not a type at all.
    const badType = await api('GET', '/api/inventory/history?type=NOT_A_TYPE', { token: hist.token });
    assert.equal(badType.status, 400);
    assert.ok(badType.json.fields.some((f) => f.field === 'type'));

    const from = t2.json.transaction.createdAt;
    const since = await api('GET', `/api/inventory/history?from=${encodeURIComponent(from)}`, { token: hist.token });
    assert.equal(since.json.total, 3);

    // Phase 20C (L-2): the previous check only proved the two pages DIFFER, which
    // a repeated row plus a dropped row would also satisfy. Page the whole history
    // instead and assert the traversal properly: every row exactly once, in the
    // newest-first order `all` already established, under a stable envelope.
    const fullOrder = all.json.items.map((i) => i.id);
    const walked = [];
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page += 1) {
      const res = await api('GET', `/api/inventory/history?limit=2&page=${page}`, {
        token: hist.token,
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.page, page);
      assert.equal(res.json.limit, 2);
      assert.equal(res.json.total, 4, 'total must not depend on the page');
      assert.equal(res.json.totalPages, 2);
      totalPages = res.json.totalPages;
      walked.push(...res.json.items.map((i) => i.id));
      assert.ok(page <= 10, 'history paging terminated');
    }
    const page1Ids = walked.slice(0, 2);
    const page2Ids = walked.slice(2);
    assert.deepEqual(page1Ids.filter((id) => page2Ids.includes(id)), [], 'the pages are disjoint');
    assert.deepEqual(walked, fullOrder, 'paged order reproduces the single-page order');
    assert.equal(new Set(walked).size, walked.length, 'no history row repeats across pages');
    assert.equal(walked.length, all.json.total, 'every history row is returned exactly once');

    // The four movements above were written in one burst, so they can share a
    // createdAt. Collapse them onto ONE instant deliberately: only the `_id`
    // tiebreaker is left to order them, and it must run in the SAME (descending)
    // direction as the primary sort. This is what proves the sort-before-lookup /
    // $facet pipeline yields correctly ordered pages, rather than the rows merely
    // happening to carry distinct timestamps.
    const txns = await InventoryTransaction.find({ businessId: hist.businessId })
      .select('_id')
      .lean();
    assert.equal(txns.length, 4, 'the four movements are in the ledger');
    const txnIds = txns.map((t) => String(t._id)).sort();
    await stampField(InventoryTransaction, txnIds, 'createdAt', new Date());
    const newestFirst = [...txnIds].reverse();

    const tiedAll = await api('GET', '/api/inventory/history?limit=100', { token: hist.token });
    assert.deepEqual(
      tiedAll.json.items.map((i) => i.id),
      newestFirst,
      'rows sharing a createdAt fall back to _id, descending'
    );

    const tiedWalked = [];
    let tiedPages = 1;
    for (let page = 1; page <= tiedPages; page += 1) {
      const res = await api('GET', `/api/inventory/history?limit=1&page=${page}`, {
        token: hist.token,
      });
      assert.equal(res.json.total, 4, 'total is unchanged by the tie');
      assert.equal(res.json.totalPages, 4, 'a tied list still reports the right page count');
      tiedPages = res.json.totalPages;
      tiedWalked.push(...res.json.items.map((i) => i.id));
      assert.ok(page <= 10, 'tied history paging terminated');
    }
    assert.deepEqual(tiedWalked, newestFirst, 'a tied history pages in the full order');
    assert.equal(new Set(tiedWalked).size, tiedWalked.length, 'no tied row repeats across pages');
  });
  it('enforces RBAC on inventory, history and dashboard', async () => {
    const p = await newProduct(owner);
    const l = await newLocation(owner);

    const staffList = await api('GET', '/api/inventory', { token: staff.token });
    assert.equal(staffList.status, 200);
    const staffHist = await api('GET', '/api/inventory/history', { token: staff.token });
    assert.equal(staffHist.status, 200);

    const staffIn = await stockIn(staff, p, l, 5);
    assert.equal(staffIn.status, 201, JSON.stringify(staffIn.json));
    const staffOut = await stockOut(staff, p, l, 2);
    assert.equal(staffOut.status, 200);

    const staffAdj = await adjust(staff, p, l, 1);
    assert.equal(staffAdj.status, 403);
    assert.equal(staffAdj.json.code, 'FORBIDDEN');

    const staffDash = await api('GET', '/api/dashboard', { token: staff.token });
    assert.equal(staffDash.status, 403);

    const managerDash = await api('GET', '/api/dashboard', { token: manager.token });
    assert.equal(managerDash.status, 200);

    // MANAGER can adjust (inventory.manage), confirming it is not STAFF-restricted.
    const mp = await newProduct(owner);
    const ml = await newLocation(owner);
    assert.equal((await stockIn(owner, mp, ml, 5)).status, 201);
    const mgrAdj = await adjust(manager, mp, ml, 9);
    assert.equal(mgrAdj.status, 200, JSON.stringify(mgrAdj.json));
  });
});
