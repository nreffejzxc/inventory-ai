// Phase 11 — Inventory Intelligence & Alerts.
//
// Two layers:
//   * unit (DB-free): the pure stock-status classifier (classifyStockStatus)
//     boundary matrix that the restock list + dashboard health share.
//   * db: over the real HTTP app + executeTool — the /api/products/reorder
//     endpoint (ACTIVE at-or-below-min products, each flagged OUT_OF_STOCK vs
//     LOW_STOCK, worst first, search/pagination), the dashboard's new
//     in-stock (healthy) count, cross-business isolation, STAFF/OWNER RBAC, and
//     the read-only getReorderNeededProducts AI tool (incl. rejecting a
//     model-supplied businessId). Reuses the shipped dashboard/product services
//     so every number matches the app.
//
// Registered as MIXED in run-tests.mjs.

import 'dotenv/config';

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
import { unitSuite, dbSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { STOCK_STATUSES, classifyStockStatus } from '../src/constants/stockStatus.ts';
import { executeTool } from '../src/services/ai/tools.ts';

// ---------------------------------------------------------------------------
// Unit — stock-status classifier (all DB-free)
// ---------------------------------------------------------------------------
unitSuite('stock-status classifier — classifyStockStatus (Phase 11)', () => {
  it('classifies a healthy product (available above its minimum) as IN_STOCK', () => {
    assert.equal(classifyStockStatus(10, 5), STOCK_STATUSES.IN_STOCK);
    assert.equal(classifyStockStatus(6, 5), STOCK_STATUSES.IN_STOCK);
  });

  it('with minimumStock 0 a product is healthy whenever it has any availability (never LOW)', () => {
    // At a zero restock threshold there is no "positive but at/below minimum"
    // region, so the classifier may only return OUT (avail <= 0, covered above)
    // or IN_STOCK — any on-hand unit is healthy and needs no restock.
    assert.equal(classifyStockStatus(1, 0), STOCK_STATUSES.IN_STOCK);
    assert.equal(classifyStockStatus(5, 0), STOCK_STATUSES.IN_STOCK);
  });

  it('treats available equal to the minimum as LOW_STOCK (at the threshold)', () => {
    assert.equal(classifyStockStatus(5, 5), STOCK_STATUSES.LOW_STOCK);
    assert.equal(classifyStockStatus(3, 3), STOCK_STATUSES.LOW_STOCK);
  });

  it('treats available between zero and the minimum as LOW_STOCK', () => {
    assert.equal(classifyStockStatus(1, 5), STOCK_STATUSES.LOW_STOCK);
    assert.equal(classifyStockStatus(4, 9), STOCK_STATUSES.LOW_STOCK);
  });

  it('treats zero or negative availability as OUT_OF_STOCK', () => {
    assert.equal(classifyStockStatus(0, 2), STOCK_STATUSES.OUT_OF_STOCK);
    assert.equal(classifyStockStatus(0, 0), STOCK_STATUSES.OUT_OF_STOCK);
    assert.equal(classifyStockStatus(-3, 0), STOCK_STATUSES.OUT_OF_STOCK);
  });

  it('treats a product with no inventory row (availability missing) as OUT_OF_STOCK', () => {
    assert.equal(classifyStockStatus(null, 1), STOCK_STATUSES.OUT_OF_STOCK);
    assert.equal(classifyStockStatus(undefined, 1), STOCK_STATUSES.OUT_OF_STOCK);
  });

  it('exposes a frozen vocabulary of distinct statuses', () => {
    assert.equal(Object.isFrozen(STOCK_STATUSES), true);
    assert.equal(new Set(Object.values(STOCK_STATUSES)).size, 3);
  });
});

// ---------------------------------------------------------------------------
// DB — reorder list + dashboard health + AI restock tool over real HTTP
// ---------------------------------------------------------------------------
const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P11'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business) {
  const res = await api('POST', '/api/locations', { token: business.token, body: { name: uniqueName('Loc') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newCategory(business, name) {
  const res = await api('POST', '/api/categories', { token: business.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function stockIn(business, productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-in', {
    token: business.token,
    body: { productId, locationId, quantity },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

async function stockOut(business, productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-out', {
    token: business.token,
    body: { productId, locationId, quantity },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
}

const ownerCtxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

let main; // controlled health + restock fixture
let other; // isolation victim
let staffMain; // STAFF inside `main`
let mainCatId; // category assigned to lowAtMin

// Product ids in `main` (created in before) with their stock story:
let healthy; // avail 10, min 5   -> IN_STOCK (never restock)
let lowAtMin; // avail 3, min 3   -> LOW_STOCK (at the threshold)
let out; // avail 0,  min 2   -> OUT_OF_STOCK
let empty; // avail 0,  min 1   -> OUT_OF_STOCK (no inventory row)
let scarce; // avail 1,  min 4   -> LOW_STOCK
let archivedLow; // archived, must never appear in a restock list
let otherLow; // a restock candidate owned by `other`

dbSuite('Phase 11 — inventory intelligence (reorder + health) over real HTTP', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    mainCatId = await newCategory(main, 'Health Category');
    const mainLoc = await newLocation(main);

    healthy = await newProduct(main, { name: 'P11 Healthy', minimumStock: 5 });
    await stockIn(main, healthy, mainLoc, 10);

    lowAtMin = await newProduct(main, { name: 'P11 Low At Min', minimumStock: 3, categoryId: mainCatId });
    await stockIn(main, lowAtMin, mainLoc, 3);

    out = await newProduct(main, { name: 'P11 Out', minimumStock: 2 });
    await stockIn(main, out, mainLoc, 2);
    await stockOut(main, out, mainLoc, 2);

    empty = await newProduct(main, { name: 'P11 Empty', minimumStock: 1 });

    scarce = await newProduct(main, { name: 'P11 Scarce', sku: 'SKU-P11-SCARCE', minimumStock: 4 });
    await stockIn(main, scarce, mainLoc, 1);

    // Archived stock still counts toward on-hand totals but is not restockable.
    archivedLow = await newProduct(main, { name: 'P11 Archived', minimumStock: 1 });
    await stockIn(main, archivedLow, mainLoc, 1);
    const arch = await api('POST', `/api/products/${archivedLow}/archive`, { token: main.token });
    assert.equal(arch.status, 200, JSON.stringify(arch.json));

    // --- other: one low product, its own business --------------------------
    other = await registerOwner(api, tracker);
    const otherLoc = await newLocation(other);
    otherLow = await newProduct(other, { name: 'P11 Other Low', minimumStock: 2 });
    await stockIn(other, otherLow, otherLoc, 1);

    staffMain = await makeRoleUser({ role: ROLES.STAFF, businessId: main.businessId }, tracker);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('/api/products/reorder returns only ACTIVE at-or-below-min products, flagged and worst-first', async () => {
    const res = await api('GET', '/api/products/reorder', { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.total, 4, JSON.stringify(res.json));
    const ids = res.json.items.map((i) => i.id);
    assert.deepEqual([...ids].sort(), [lowAtMin, out, empty, scarce].sort());

    const byId = new Map(res.json.items.map((i) => [i.id, i]));
    for (const item of res.json.items) {
      assert.equal(item.status, 'ACTIVE', `${item.id} must be an active product`);
      assert.ok(
        item.stockStatus === STOCK_STATUSES.LOW_STOCK || item.stockStatus === STOCK_STATUSES.OUT_OF_STOCK,
        `${item.id} must carry a LOW/OUT stockStatus`
      );
      assert.ok(Number.isFinite(item.availableQuantity), `${item.id} must carry availability`);
    }
    assert.equal(byId.get(healthy), undefined, 'healthy product must not be a restock candidate');
    assert.equal(byId.get(archivedLow), undefined, 'archived product must not be restockable');
    assert.equal(byId.get(out).stockStatus, STOCK_STATUSES.OUT_OF_STOCK);
    assert.equal(byId.get(empty).stockStatus, STOCK_STATUSES.OUT_OF_STOCK);
    assert.equal(byId.get(scarce).stockStatus, STOCK_STATUSES.LOW_STOCK);
    assert.equal(byId.get(lowAtMin).stockStatus, STOCK_STATUSES.LOW_STOCK);

    // Category join survives into the restock item.
    assert.equal(byId.get(lowAtMin).category?.id, mainCatId);
    assert.equal(byId.get(lowAtMin).category?.name, 'Health Category');

    // AI-110 — the arithmetic is the server's. A manager asking "how many should
    // I order?" reads one computed gap per row, not a subtraction exercise.
    assert.equal(byId.get(lowAtMin).unitsBelowMinimum, 0, 'at the threshold there is no gap');
    assert.equal(byId.get(out).unitsBelowMinimum, 2);
    assert.equal(byId.get(empty).unitsBelowMinimum, 1);
    assert.equal(byId.get(scarce).unitsBelowMinimum, 3);

    // Worst first: all OUT_OF_STOCK rows precede LOW_STOCK rows, availability ascending.
    const firstLow = res.json.items.findIndex((i) => i.stockStatus === STOCK_STATUSES.LOW_STOCK);
    assert.ok(firstLow >= 0);
    for (let x = 0; x < firstLow; x += 1) {
      assert.equal(res.json.items[x].stockStatus, STOCK_STATUSES.OUT_OF_STOCK);
    }
    const avail = res.json.items.map((i) => i.availableQuantity);
    assert.deepEqual(avail, [...avail].sort((a, b) => a - b));
    assert.equal(res.json.items.at(-1).id, lowAtMin, 'largest remaining availability sorts last');
  });

  it('/api/products/reorder supports q search and the standard pagination envelope', async () => {
    const q = await api('GET', '/api/products/reorder?q=SKU-P11-SCARCE', { token: main.token });
    assert.equal(q.json.total, 1, JSON.stringify(q.json));
    assert.equal(q.json.items[0].id, scarce);

    const p1 = await api('GET', '/api/products/reorder?limit=2&page=1', { token: main.token });
    assert.equal(p1.json.total, 4);
    assert.equal(p1.json.items.length, 2);
    assert.equal(p1.json.page, 1);
    assert.equal(p1.json.totalPages, 2);
    assert.ok(p1.json.items.every((i) => i.stockStatus === STOCK_STATUSES.OUT_OF_STOCK));

    const p2 = await api('GET', '/api/products/reorder?limit=2&page=2', { token: main.token });
    assert.equal(p2.json.total, 4);
    assert.equal(p2.json.items.length, 2);
    assert.equal(p2.json.items[0].id, scarce);
    assert.equal(p2.json.items[1].id, lowAtMin);
    assert.notDeepEqual(
      p1.json.items.map((i) => i.id),
      p2.json.items.map((i) => i.id)
    );
  });

  it('/api/dashboard reports the healthy in-stock count consistent with total and low', async () => {
    const d = await api('GET', '/api/dashboard', { token: main.token });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.totalProducts, 5);
    assert.equal(d.json.totalInventoryQuantity, 15); // includes the archived product's 1
    assert.equal(d.json.lowStockProducts, 4);
    assert.equal(d.json.outOfStockProducts, 2);
    assert.equal(d.json.inStockProducts, 1);
    assert.equal(d.json.inStockProducts, d.json.totalProducts - d.json.lowStockProducts);
  });

  it('keeps reorder + dashboard health isolated per business', async () => {
    const mainList = await api('GET', '/api/products/reorder', { token: main.token });
    assert.ok(!mainList.json.items.some((i) => i.id === otherLow), 'main must not see other\'s restock list');

    const otherList = await api('GET', '/api/products/reorder', { token: other.token });
    assert.equal(otherList.json.total, 1);
    assert.equal(otherList.json.items[0].id, otherLow);

    const d = await api('GET', '/api/dashboard', { token: other.token });
    assert.equal(d.json.totalProducts, 1);
    assert.equal(d.json.inStockProducts, 0);
  });

  it('minimumStock = 0: health still satisfies inStock = total - low (low collapses to out)', async () => {
    // A dedicated business whose products all carry a zero restock threshold. At
    // min 0 the dashboard low set (available <= minimumStock) collapses onto the
    // out set (available <= 0), so the single inStock = total - low subtraction
    // still excludes every out-of-stock product and only truly stocked products
    // are healthy. (Uses its own business so the main fixture counts stay intact.)
    const zeroMin = await registerOwner(api, tracker);
    const loc = await newLocation(zeroMin);

    const zeroOutStocked = await newProduct(zeroMin, { name: 'P11 Z Out Stocked', minimumStock: 0 });
    await stockIn(zeroMin, zeroOutStocked, loc, 1);
    await stockOut(zeroMin, zeroOutStocked, loc, 1); // avail 0 -> OUT_OF_STOCK

    const zeroNoRow = await newProduct(zeroMin, { name: 'P11 Z No Row', minimumStock: 0 }); // avail 0 -> OUT_OF_STOCK

    const zeroHealthy = await newProduct(zeroMin, { name: 'P11 Z Healthy', minimumStock: 0 });
    await stockIn(zeroMin, zeroHealthy, loc, 5); // avail 5 > 0 -> IN_STOCK

    const d = await api('GET', '/api/dashboard', { token: zeroMin.token });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.totalProducts, 3);
    assert.equal(d.json.lowStockProducts, 2);
    assert.equal(d.json.outOfStockProducts, 2);
    assert.equal(d.json.lowStockProducts, d.json.outOfStockProducts, 'at minimumStock 0 the low set is the out set');
    assert.equal(d.json.inStockProducts, d.json.totalProducts - d.json.lowStockProducts);
    assert.equal(d.json.inStockProducts, 1, 'only the product with positive availability is healthy');

    // Restock list sees only the two OUT items — a stocked min-0 product is not a
    // candidate, and nothing at a zero threshold can be LOW_STOCK.
    const re = await api('GET', '/api/products/reorder', { token: zeroMin.token });
    assert.equal(re.status, 200, JSON.stringify(re.json));
    assert.equal(re.json.total, 2);
    const byId = new Map(re.json.items.map((i) => [i.id, i]));
    assert.ok(byId.get(zeroOutStocked));
    assert.ok(byId.get(zeroNoRow));
    assert.equal(byId.get(zeroHealthy), undefined, 'a stocked min-0 product needs no restock');
    for (const item of re.json.items) {
      assert.equal(item.stockStatus, STOCK_STATUSES.OUT_OF_STOCK, `${item.id} must be OUT at a zero threshold`);
    }

    // The read-only AI restock tool agrees on the same business.
    const tool = await executeTool('getReorderNeededProducts', { limit: 50 }, ownerCtxOf(zeroMin));
    assert.equal(tool.ok, true, JSON.stringify(tool));
    assert.equal(tool.result.count, 2);
  });

  it('preserves RBAC: STAFF may read the restock list, but not the MANAGER+ dashboard', async () => {
    const staffReorder = await api('GET', '/api/products/reorder', { token: staffMain.token });
    assert.equal(staffReorder.status, 200, JSON.stringify(staffReorder.json));

    const staffDash = await api('GET', '/api/dashboard', { token: staffMain.token });
    assert.equal(staffDash.status, 403);
    assert.equal(staffDash.json.code, 'FORBIDDEN');
  });

  it('getReorderNeededProducts answers "what needs restocking" through the read-only tool', async () => {
    const res = await executeTool('getReorderNeededProducts', { limit: 50 }, ownerCtxOf(main));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.count, 4);
    assert.ok(res.result.items.some((i) => i.id === out && i.stockStatus === STOCK_STATUSES.OUT_OF_STOCK));
    assert.ok(res.result.items.some((i) => i.id === scarce && i.stockStatus === STOCK_STATUSES.LOW_STOCK));
    assert.ok(!res.result.items.some((i) => i.id === archivedLow));

    const searched = await executeTool('getReorderNeededProducts', { q: 'SKU-P11-SCARCE' }, ownerCtxOf(main));
    assert.equal(searched.ok, true);
    assert.equal(searched.result.count, 1);
    assert.equal(searched.result.items[0].id, scarce);
    assert.equal(searched.result.items[0].unitsBelowMinimum, 3);

    // The low-stock list shares the same stock card, so the same computed gap is
    // available when a member asks what is low without asking for the restock tool.
    const low = await executeTool('getLowStockProducts', { limit: 50 }, ownerCtxOf(main));
    assert.equal(low.ok, true, JSON.stringify(low));
    const lowById = new Map(low.result.items.map((item) => [item.id, item]));
    assert.equal(lowById.get(scarce).unitsBelowMinimum, 3);
    assert.equal(lowById.get(lowAtMin).unitsBelowMinimum, 0);
  });

  it('the restock tool is scoped to the authenticated business and role', async () => {
    const otherRes = await executeTool('getReorderNeededProducts', {}, ownerCtxOf(other));
    assert.equal(otherRes.ok, true);
    assert.equal(otherRes.result.count, 1);
    assert.equal(otherRes.result.items[0].id, otherLow);

    // STAFF holds inventory.view, so the restock tool is allowed for them too.
    const staffRes = await executeTool(
      'getReorderNeededProducts',
      { limit: 5 },
      { businessId: main.businessId, userId: staffMain.userId, role: ROLES.STAFF }
    );
    assert.equal(staffRes.ok, true);
  });

  it('the restock tool rejects a model-supplied businessId or any unknown key', async () => {
    const withBiz = await executeTool('getReorderNeededProducts', { businessId: other.businessId }, ownerCtxOf(main));
    assert.equal(withBiz.ok, false);
    assert.equal(withBiz.code, 'TOOL_INVALID_ARGUMENTS');

    const withMongoKey = await executeTool('getReorderNeededProducts', { collection: 'products' }, ownerCtxOf(main));
    assert.equal(withMongoKey.ok, false);
    assert.equal(withMongoKey.code, 'TOOL_INVALID_ARGUMENTS');
  });

  it('getInventorySummary now includes the healthy in-stock count', async () => {
    const sum = await executeTool('getInventorySummary', {}, ownerCtxOf(main));
    assert.equal(sum.ok, true, JSON.stringify(sum));
    assert.equal(sum.result.totalProducts, 5);
    assert.equal(sum.result.lowStockProducts, 4);
    assert.equal(sum.result.inStockProducts, 1);
    assert.equal(sum.result.inStockProducts, sum.result.totalProducts - sum.result.lowStockProducts);
  });
});
