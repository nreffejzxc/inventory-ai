// Phase 06 — read-only AI tools against real data. Seeds several businesses
// through the real HTTP API, then drives executeTool/validateToolArgs directly
// with each business's authenticated session context. Covers valid execution,
// strict argument validation (incl. the "no arbitrary Mongo / no client
// businessId" guarantees), cross-business isolation, role permission checks and
// result caps. DB-backed; fails loudly when MongoDB is unreachable (Phase 07F / M9).

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
import { executeTool, validateToolArgs, AI_TOOL_DEFS, aiToolsById } from '../src/services/ai/tools.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

// Every tool/executor lives on the shipped services; helper seeds use the same
// HTTP endpoints the app uses so tool results are guaranteed to match the app.
async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { name: uniqueName('P'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business, over = {}) {
  const res = await api('POST', '/api/locations', { token: business.token, body: { name: uniqueName('Loc'), ...over } });
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

// Session context for a seeded session — identical to what runAiChat passes.
const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });
const ok = (res) => {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.result;
};

let A; // Business A — catalog + isolation victim
let B; // Business B — isolation attacker (own product)
let staff; // STAFF inside Business A
let low; // business: exactly one low-stock product
let out; // business: exactly one out-of-stock product
let sum; // business: controlled dashboard numbers
let loc; // business: controlled location stock
let hist; // business: controlled movement history

let alpha;
let alphaLoc;
let secretA;
let secretB;

dbSuite('Phase 06 — AI tools', dbOk, () => {
  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: A.businessId }, tracker);

    // --- A: catalog + isolation victim -----------------------------------
    alpha = await newProduct(A, { name: 'Alpha Widget', sku: 'SKU-ALPHA', barcode: 'BAR-ALPHA', minimumStock: 2 });
    secretA = await newProduct(A, { name: uniqueName('SecretA') });
    alphaLoc = await newLocation(A);
    await stockIn(A, alpha, alphaLoc, 10);

    // --- B: an empty-ish business with its own product -------------------
    secretB = await newProduct(B, { name: uniqueName('SecretB') });

    // --- low: one product, available 2 <= minimumStock 5 -----------------
    low = await registerOwner(api, tracker);
    const lowP = await newProduct(low, { minimumStock: 5 });
    const lowL = await newLocation(low);
    await stockIn(low, lowP, lowL, 2);

    // --- out: one product driven to available 0 --------------------------
    out = await registerOwner(api, tracker);
    const outP = await newProduct(out, { minimumStock: 5 });
    const outL = await newLocation(out);
    await stockIn(out, outP, outL, 3);
    await stockOut(out, outP, outL, 3);

    // --- sum: one product, 8 on hand, two movements ----------------------
    sum = await registerOwner(api, tracker);
    const s1 = await newProduct(sum, { name: 'Summary Product' });
    const sumL = await newLocation(sum);
    await stockIn(sum, s1, sumL, 5);
    await stockIn(sum, s1, sumL, 3);

    // --- loc: one product stocked at one location ------------------------
    loc = await registerOwner(api, tracker);
    const ploc = await newProduct(loc, { minimumStock: 1 });
    const locL = await newLocation(loc);
    await stockIn(loc, ploc, locL, 7);

    // --- hist: stock-in 5 then stock-out 2 -------------------------------
    hist = await registerOwner(api, tracker);
    const hp = await newProduct(hist);
    const histL = await newLocation(hist);
    await stockIn(hist, hp, histL, 5);
    await stockOut(hist, hp, histL, 2);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  // -- searchProducts -----------------------------------------------------
  it('searchProducts finds by partial name/sku/barcode and is scoped to the business', async () => {
    const byName = ok(await executeTool('searchProducts', { q: 'alpha', status: 'ACTIVE', limit: 25 }, ctxOf(A)));
    assert.equal(byName.count, 1);
    assert.equal(byName.items[0].id, alpha);
    assert.equal(byName.items[0].sku, 'SKU-ALPHA');

    const bySku = ok(await executeTool('searchProducts', { q: 'SKU-ALPHA' }, ctxOf(A)));
    assert.equal(bySku.items[0].id, alpha);

    const byBarcode = ok(await executeTool('searchProducts', { q: 'BAR-ALPHA' }, ctxOf(A)));
    assert.equal(byBarcode.items[0].id, alpha);

    // Catalog search only — no stock fields leaked here.
    assert.ok(!('availableQuantity' in byName.items[0]));
  });

  // -- getProduct ---------------------------------------------------------
  it('getProduct returns product + stock rows by id/sku/barcode', async () => {
    const byId = ok(await executeTool('getProduct', { id: alpha }, ctxOf(A)));
    assert.equal(byId.found, true);
    assert.equal(byId.product.id, alpha);
    assert.equal(byId.product.sku, 'SKU-ALPHA');
    assert.equal(byId.product.stockRows, 1);
    assert.equal(byId.product.stock[0].location.id, alphaLoc);
    assert.equal(byId.product.stock[0].quantity, 10);
    assert.equal(byId.product.stock[0].availableQuantity, 10);

    const bySku = ok(await executeTool('getProduct', { sku: 'SKU-ALPHA' }, ctxOf(A)));
    assert.equal(bySku.product.id, alpha);

    const missing = ok(await executeTool('getProduct', { sku: 'NOPE' }, ctxOf(A)));
    assert.equal(missing.found, false);

    const none = ok(await executeTool('getProduct', {}, ctxOf(A)));
    assert.equal(none.found, false);
    assert.match(none.error, /Provide one of id, sku, or barcode/);
  });

  // -- getInventory -------------------------------------------------------
  it('getInventory lists rows and filters by product + location', async () => {
    const rows = ok(await executeTool('getInventory', { productId: alpha, locationId: alphaLoc, limit: 25 }, ctxOf(A)));
    assert.equal(rows.count, 1);
    assert.equal(rows.items[0].product.id, alpha);
    assert.equal(rows.items[0].location.id, alphaLoc);
    assert.equal(rows.items[0].quantity, 10);
    assert.equal(rows.items[0].availableQuantity, 10);

    const all = ok(await executeTool('getInventory', { q: 'alpha' }, ctxOf(A)));
    assert.equal(all.count, 1);
  });

  // -- getLowStockProducts / getOutOfStockProducts ------------------------
  it('getLowStockProducts returns exactly the low-stock product', async () => {
    const res = ok(await executeTool('getLowStockProducts', { limit: 50 }, ctxOf(low)));
    assert.equal(res.count, 1);
    assert.equal(res.items[0].availableQuantity, 2);
    assert.equal(res.items[0].minimumStock, 5);
  });

  it('getOutOfStockProducts returns exactly the out-of-stock product', async () => {
    const res = ok(await executeTool('getOutOfStockProducts', { limit: 50 }, ctxOf(out)));
    assert.equal(res.count, 1);
    assert.equal(res.items[0].availableQuantity, 0);
  });

  // -- getInventorySummary ------------------------------------------------
  it('getInventorySummary matches the dashboard numbers', async () => {
    const res = ok(await executeTool('getInventorySummary', {}, ctxOf(sum)));
    assert.equal(res.totalProducts, 1);
    assert.equal(res.totalInventoryQuantity, 8);
    assert.equal(res.lowStockProducts, 0);
    assert.equal(res.outOfStockProducts, 0);
    assert.equal(res.recentActivity.length, 2);
    assert.ok(Array.isArray(res.recentActivity));
  });

  // -- getProductsByLocation ----------------------------------------------
  it('getProductsByLocation lists stock at one location with available quantity', async () => {
    const locs = await api('GET', '/api/locations', { token: loc.token });
    const locationId = locs.json.items.find((l) => l.status === 'ACTIVE').id;
    const res = ok(await executeTool('getProductsByLocation', { locationId }, ctxOf(loc)));
    assert.equal(res.count, 1);
    assert.equal(res.locationId, locationId);
    assert.equal(res.items[0].availableQuantity, 7);
  });

  // -- getInventoryHistory ------------------------------------------------
  it('getInventoryHistory returns movements newest-first and filters by type', async () => {
    const allRes = ok(await executeTool('getInventoryHistory', { limit: 50 }, ctxOf(hist)));
    assert.equal(allRes.count, 2);
    assert.equal(allRes.items[0].type, 'STOCK_OUT');
    assert.equal(allRes.items[1].type, 'STOCK_IN');

    const outs = ok(await executeTool('getInventoryHistory', { type: 'STOCK_OUT' }, ctxOf(hist)));
    assert.equal(outs.count, 1);
    assert.equal(outs.items[0].type, 'STOCK_OUT');
    assert.equal(outs.items[0].quantity, 2);
  });

  // -- cross-business isolation -------------------------------------------
  it('a tool for Business B never sees Business A records', async () => {
    const viaName = await executeTool('searchProducts', { q: secretA }, ctxOf(B));
    assert.equal(viaName.ok, true);
    assert.equal(viaName.result.count, 0);

    const byId = ok(await executeTool('getProduct', { id: alpha }, ctxOf(B)));
    assert.equal(byId.found, false, 'another business product id must resolve to not-found');

    // And the reverse: A cannot see B's product.
    const reverse = await executeTool('searchProducts', { q: secretB }, ctxOf(A));
    assert.equal(reverse.ok, true);
    assert.equal(reverse.result.count, 0);
  });

  it('summary/isolation numbers never mix across businesses', async () => {
    const a = ok(await executeTool('getInventorySummary', {}, ctxOf(A)));
    const b = ok(await executeTool('getInventorySummary', {}, ctxOf(B)));
    assert.ok(a.totalProducts >= 2, 'Business A has its own products');
    // B sees only its own single product — never A's catalog or stock.
    assert.equal(b.totalProducts, 1, 'Business B summary is not polluted by A');
    assert.equal(b.totalInventoryQuantity, 0, 'B has stocked nothing, so its on-hand total is 0');
  });

  // -- role permissions ---------------------------------------------------
  it('STAFF cannot run the dashboard-gated summary tool but may read inventory', async () => {
    const denied = await executeTool('getInventorySummary', {}, {
      businessId: A.businessId,
      userId: staff.userId,
      role: ROLES.STAFF,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'TOOL_FORBIDDEN');
    assert.match(denied.error, /permission/);

    const allowed = await executeTool('getLowStockProducts', { limit: 50 }, {
      businessId: low.businessId,
      userId: low.userId,
      role: ROLES.STAFF,
    });
    assert.equal(allowed.ok, true, 'STAFF holds inventory.view so low-stock is allowed');
  });

  // -- strict argument validation / no arbitrary query --------------------
  it('rejects a model-supplied businessId on every tool', async () => {
    const res = await executeTool('searchProducts', { q: 'alpha', businessId: B.businessId }, ctxOf(A));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TOOL_INVALID_ARGUMENTS');
    assert.match(res.error, /businessId/);
  });

  it('rejects MongoDB operators and undeclared keys (no arbitrary query)', async () => {
    for (const bad of [
      { productId: alpha, $where: 'this.quantity > 0' },
      { productId: alpha, where: { quantity: { $gt: 1 } } },
      { productId: alpha, $match: { x: 1 } },
      { limit: 25, collection: 'products' },
    ]) {
      const res = await executeTool('getInventory', bad, ctxOf(A));
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.equal(res.code, 'TOOL_INVALID_ARGUMENTS');
    }
  });

  it('rejects malformed/wrong-typed arguments', async () => {
    const cases = [
      ['searchProducts', { limit: 999 }, /at most/],
      ['searchProducts', { q: { $regex: 'alpha' } }, /string/],
      ['searchProducts', { status: 'DELETED' }, /ACTIVE, ARCHIVED/],
      ['getInventory', { productId: 'not-an-object-id' }, /invalid value/],
      ['getInventory', { lowStock: 'true' }, /boolean/],
      ['getInventory', { limit: 0 }, /at least 1/],
      ['getInventory', { q: 'a'.repeat(101) }, /too long/],
      ['getLowStockProducts', { limit: 500 }, /at most 50/],
      ['getInventoryHistory', { type: 'ROBOT_ATTACK' }, /must be one of/],
      ['getInventoryHistory', { from: 'yesterday' }, /ISO date-time/],
      ['getInventorySummary', { businessId: 123 }, /businessId/],
      ['getProduct', { id: { $oid: alpha } }, /string/],
    ];
    for (const [tool, args, re] of cases) {
      const res = await executeTool(tool, args, ctxOf(A));
      assert.equal(res.ok, false, `${tool} ${JSON.stringify(args)}`);
      assert.equal(res.code, 'TOOL_INVALID_ARGUMENTS');
      assert.match(res.error, re, `${tool} ${JSON.stringify(args)}`);
    }
  });

  it('★ a required location is refused by the executor, because the schema cannot say "one of two"', async () => {
    // This case used to live in the malformed-arguments list above, asserting a `missing
    // required argument` problem from the schema. AI-15 made the location expressible two
    // ways (`locationId` or the exact `location` name), and this validator's JSON-Schema
    // subset has no `anyOf`, so no single `required` key can state "one of these". The
    // refusal moved to the executor — and the property that matters is unchanged and
    // asserted here: an empty call must not return the catalogue. That is the failure mode
    // the move risked: an `undefined` locationId reaching `productService.list` answers
    // every product while looking exactly like a filtered page.
    const res = await executeTool('getProductsByLocation', {}, ctxOf(A));
    assert.equal(res.ok, true, 'a model-driven mistake is a soft result it can explain, not a crash');
    assert.equal(res.result.found, false);
    assert.match(res.result.error, /locationId or a location name/i);
    assert.equal(res.result.items, undefined, 'the refusal must not carry a page of rows');
  });

  it('validateToolArgs returns only declared keys and reports unknown ones', () => {
    const tool = aiToolsById.get('getInventory');
    const { problems, cleaned } = validateToolArgs(tool, { productId: alpha, limit: 10, evil: 1 });
    assert.ok(problems.some((p) => p.includes('evil')));
    assert.ok('productId' in cleaned && 'limit' in cleaned);
    assert.ok(!('evil' in cleaned));
  });

  it('a malformed session businessId cannot crash the tool (soft TOOL_ERROR)', async () => {
    const res = await executeTool('getInventorySummary', {}, {
      businessId: 'not-an-objectid',
      userId: A.userId,
      role: ROLES.OWNER,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TOOL_ERROR');
  });

  it('the tool catalog is strictly read-only (15 tools, no write verbs)', async () => {
    const names = AI_TOOL_DEFS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      // AI-45: everyday discovery across name, brand and description, with stock.
      'findProducts',
      // AI-46: one read for catalogue contents and brand/description coverage.
      'getCatalogOverview',
      'getInventory',
      'getInventoryHistory',
      'getInventorySummary',
      // AI-23: per-location counts and units, one read for a comparison question.
      'getLocationBreakdown',
      'getLowStockProducts',
      'getOutOfStockProducts',
      'getProduct',
      'getProductsByLocation',
      'getReorderNeededProducts',
      // AI-14: reference lookups — read-only, and the only way to turn a location or
      // category NAME into the id the tools above filter by.
      // AI-44: recorded brands, one read for the brand question.
      'listBrands',
      'listCategories',
      'listLocations',
      'searchProducts',
    ]);
    for (const def of AI_TOOL_DEFS) {
      assert.equal(def.parameters.additionalProperties, false, `${def.name} must forbid extra args`);
      const tool = aiToolsById.get(def.name);
      assert.equal(typeof tool.executor, 'function', `${def.name} must have an executor`);
      assert.ok(tool.permission, `${def.name} must declare a permission`);
    }
  });
});
