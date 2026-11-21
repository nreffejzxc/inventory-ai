// AI-118 — run-out estimates from recorded movements, with the rule stated in the data.
//
// WHAT THIS SUITE PINS:
//   * the tool exists, is read-only, takes exactly one product identifier (including an
//     exact recorded name), and cannot receive a tenant id or an unbounded window;
//   * stock-out units are summed over the whole matching ledger, while transfers and
//     stock-in are excluded;
//   * current stock is summed over every matching inventory row, not one page of them;
//   * a location scope changes both sides of the calculation consistently;
//   * no movements means daysOfCover is null, never "infinite";
//   * missing, foreign, archived, partial and ambiguous products/locations are refused honestly;
//   * `getProductsByLocation` does not present archived products as current stock.

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
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES, PERMISSIONS, hasPermission } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';
import { filterLabels, sourcesForTools } from '../src/services/ai/answerContext.ts';
import { asksForStockCoverage } from '../src/services/ai/answerCompletion.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session, role = ROLES.OWNER) => ({
  businessId: session.businessId,
  userId: session.userId,
  role,
});

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

async function newLocation(business, name) {
  const res = await api('POST', '/api/locations', {
    token: business.token,
    body: { name: uniqueName(name) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { currency: 'PHP', name: uniqueName('Coverage'), ...over },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
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

async function transfer(business, productId, fromLocationId, toLocationId, quantity) {
  const res = await api('POST', '/api/inventory/transfer', {
    token: business.token,
    body: { productId, fromLocationId, toLocationId, quantity },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

// ---------------------------------------------------------------------------
// The schema and the prompt — what the model is allowed to ask for.
// ---------------------------------------------------------------------------

unitSuite('AI-118 the coverage read is one product, bounded, and read-only', () => {
  it('★ the tool is advertised, closed to extra arguments, and gated on a read permission', () => {
    const tool = aiToolsById.get('getProductStockCoverage');
    assert.ok(tool, 'getProductStockCoverage is not in the tool catalogue');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.permission, PERMISSIONS.INVENTORY_HISTORY_VIEW);
    for (const role of [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF]) {
      assert.equal(hasPermission(role, tool.permission), true, `${role} cannot read coverage`);
    }
    for (const injected of [{ businessId: 'other-tenant' }, { role: 'OWNER' }]) {
      assert.ok(
        validateToolArgs(tool, injected).problems.some((problem) => problem.includes('unknown argument')),
        `coverage accepted ${JSON.stringify(injected)}`,
      );
    }
    // `location` is a known field, so an operator object is rejected for its TYPE; the
    // important property is that it never reaches a Mongo query.
    assert.ok(validateToolArgs(tool, { location: { $ne: null } }).problems.length > 0);
  });

  it('★ days are bounded, and the identifier set has exactly one executable answer', async () => {
    const tool = aiToolsById.get('getProductStockCoverage');
    assert.ok(validateToolArgs(tool, { days: 6 }).problems.length > 0);
    assert.ok(validateToolArgs(tool, { days: 366 }).problems.length > 0);
    assert.equal(validateToolArgs(tool, { days: 7 }).problems.length, 0);
    assert.equal(validateToolArgs(tool, { name: 'MX Keys S' }).problems.length, 0);

    const ctx = { businessId: '64b000000000000000000001', userId: 'u', role: ROLES.OWNER };
    const none = await ok('getProductStockCoverage', {}, ctx);
    assert.equal(none.found, false);
    assert.match(none.error, /exactly one/i);
    const two = await ok(
      'getProductStockCoverage',
      { id: '64b000000000000000000002', sku: 'SKU-1' },
      ctx,
    );
    assert.equal(two.found, false);
    assert.match(two.error, /exactly one/i);
  });

  it('★ the description and prompt name the proxy boundary instead of promising a sales forecast', () => {
    const tool = aiToolsById.get('getProductStockCoverage');
    assert.match(tool.description, /STOCK_OUT/i);
    assert.match(tool.description, /not a sales figure|movement proxy/i);
    const prompt = systemPrompt({ nativeWeb: false, sourceRestricted: false });
    assert.match(prompt, /getProductStockCoverage/);
    assert.match(prompt, /daysOfCover/);
    assert.match(prompt, /not sales/i);
  });

  it('★ provenance names the inventory source and keeps the lookback in Inspect', () => {
    assert.deepEqual(sourcesForTools(['getProductStockCoverage']), ['Inventory records']);
    assert.deepEqual(filterLabels({ days: 30 }), [{ label: 'Lookback days', value: '30' }]);
  });

  it('★ run-out paraphrases activate the coverage guard, ordinary stock questions do not', () => {
    for (const question of [
      'How long will the MX Keys S last?',
      'How many days of cover does the K8 Pro have?',
      'Are we going to run out of the Razer BlackWidow soon?',
      'What is the stock coverage for the Sony XM5?',
      'How long until the RK61 runs out?',
      'How much longer will the MX Master last?',
      'When will we run out of the Stream Deck?',
    ]) {
      assert.equal(asksForStockCoverage(question), true, question);
    }
    for (const question of [
      'How many units of the MX Keys S are in stock?',
      'Which products are low on stock?',
      'Is anything out of stock?',
      'How long will delivery take?',
    ]) {
      assert.equal(asksForStockCoverage(question), false, question);
    }
  });
});

// ---------------------------------------------------------------------------
// The behaviour, against real MongoDB and the real stock ledger.
// ---------------------------------------------------------------------------

dbSuite('AI-118 coverage uses whole-set stock and stock-out movements only', dbOk, () => {
  let A;
  let B;
  let main;
  let shop;
  let foreignLocation;
  let product;
  let foreignProduct;
  let idle;
  let empty;

  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);
    main = await newLocation(A, 'Coverage Main');
    shop = await newLocation(A, 'Coverage Shop');
    foreignLocation = await newLocation(B, 'Coverage Foreign');

    product = await newProduct(A, {
      name: uniqueName('Coverage Widget'),
      sku: uniqueName('COV-SKU'),
      barcode: uniqueName('COV-BAR'),
      sellingPrice: 25,
    });
    foreignProduct = await newProduct(B, { name: uniqueName('Foreign Widget') });

    await stockIn(A, product.id, main.id, 10);
    await stockIn(A, product.id, shop.id, 5);
    await stockOut(A, product.id, main.id, 2);
    await stockOut(A, product.id, main.id, 2);
    await stockOut(A, product.id, shop.id, 1);
    // Moving stock between shelves is movement, not demand. If a transfer leg were
    // counted as a stock-out, the business-wide rate would be 11/10 instead of 5/10.
    await transfer(A, product.id, main.id, shop.id, 3);

    idle = await newProduct(A, { name: uniqueName('Idle Widget') });
    await stockIn(A, idle.id, main.id, 5);
    empty = await newProduct(A, { name: uniqueName('Empty Widget') });
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ sums every location, excludes transfers, and states the estimate basis', async () => {
    const result = await ok(
      'getProductStockCoverage',
      { id: product.id, days: 10 },
      ctxOf(A),
    );

    assert.equal(result.found, true);
    assert.equal(result.product.id, product.id);
    assert.equal(result.scope.days, 10);
    assert.equal(result.scope.locationId, null);
    assert.equal(result.current.rows, 2);
    assert.equal(result.current.quantity, 10);
    assert.equal(result.current.availableQuantity, 10);
    assert.equal(result.movement.unitsOut, 5);
    assert.equal(result.movement.stockOutMovements, 3);
    assert.equal(result.forecast.averageDailyUnitsOut, 0.5);
    assert.equal(result.forecast.daysOfCover, 20);
    assert.equal(result.forecast.projectedUnitsOut30Days, 15);
    assert.match(result.note, /movement proxy/i);
    assert.match(result.note, /not confirmed sales/i);
  });

  it('★ a location scope changes the stock and the rate together', async () => {
    const mainCoverage = await ok(
      'getProductStockCoverage',
      { id: product.id, location: main.name, days: 10 },
      ctxOf(A),
    );
    assert.equal(mainCoverage.scope.locationId, main.id);
    assert.equal(mainCoverage.scope.locationName, main.name);
    assert.equal(mainCoverage.current.availableQuantity, 3);
    assert.equal(mainCoverage.movement.unitsOut, 4);
    assert.equal(mainCoverage.forecast.averageDailyUnitsOut, 0.4);
    assert.equal(mainCoverage.forecast.daysOfCover, 7.5);
    assert.equal(mainCoverage.forecast.projectedUnitsOut30Days, 12);

    const shopCoverage = await ok(
      'getProductStockCoverage',
      { id: product.id, locationId: shop.id, days: 10 },
      ctxOf(A),
    );
    assert.equal(shopCoverage.current.availableQuantity, 7);
    assert.equal(shopCoverage.movement.unitsOut, 1);
    assert.equal(shopCoverage.forecast.daysOfCover, 70);
  });

  it('★ SKU and barcode resolve the same product, and the window is echoed', async () => {
    const bySku = await ok(
      'getProductStockCoverage',
      { sku: product.sku, days: 10 },
      ctxOf(A),
    );
    const byBarcode = await ok(
      'getProductStockCoverage',
      { barcode: product.barcode, days: 10 },
      ctxOf(A),
    );
    assert.equal(bySku.product.id, product.id);
    assert.equal(byBarcode.product.id, product.id);
    assert.equal(
      Date.parse(bySku.asOf) - Date.parse(bySku.scope.windowStart),
      10 * 24 * 60 * 60 * 1000,
      'the echoed window and asOf must come from one clock',
    );
  });

  it('★ an exact recorded name resolves coverage, refuses partials and duplicates, and stays in the tenant', async () => {
    const namedName = uniqueName('Coverage Named');
    const named = await newProduct(A, {
      name: namedName,
      sku: uniqueName('COV-NAME'),
    });
    await stockIn(A, named.id, main.id, 5);

    const byName = await ok(
      'getProductStockCoverage',
      { name: `  ${namedName.toUpperCase()}  `, days: 10 },
      ctxOf(A),
    );
    assert.equal(byName.found, true);
    assert.equal(byName.product.id, named.id);
    assert.equal(byName.product.name, named.name);

    const partial = await ok(
      'getProductStockCoverage',
      { name: namedName.slice(0, -1), days: 10 },
      ctxOf(A),
    );
    assert.equal(partial.found, false);
    assert.match(partial.error, /exact recorded name/i);

    const foreignByName = await ok(
      'getProductStockCoverage',
      { name: foreignProduct.name, days: 10 },
      ctxOf(A),
    );
    assert.equal(foreignByName.found, false);

    const duplicateName = uniqueName('Coverage Duplicate');
    const first = await newProduct(A, {
      name: duplicateName,
      sku: uniqueName('COV-DUP-A'),
    });
    const second = await newProduct(A, {
      name: duplicateName,
      sku: uniqueName('COV-DUP-B'),
    });
    const ambiguous = await ok(
      'getProductStockCoverage',
      { name: duplicateName, days: 10 },
      ctxOf(A),
    );
    assert.equal(ambiguous.found, false);
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.matches.length, 2);
    assert.deepEqual(
      ambiguous.matches.map((match) => match.id).sort(),
      [first.id, second.id].sort(),
    );

    const both = await ok(
      'getProductStockCoverage',
      { id: named.id, name: namedName, days: 10 },
      ctxOf(A),
    );
    assert.equal(both.found, false);
    assert.match(both.error, /exactly one/i);
  });

  it('★ no movement is null cover, not an infinite forecast', async () => {
    const result = await ok(
      'getProductStockCoverage',
      { id: idle.id, days: 10 },
      ctxOf(A),
    );
    assert.equal(result.current.availableQuantity, 5);
    assert.equal(result.movement.unitsOut, 0);
    assert.equal(result.forecast.averageDailyUnitsOut, 0);
    assert.equal(result.forecast.daysOfCover, null);
    assert.equal(result.forecast.projectedUnitsOut30Days, 0);
    assert.match(result.note, /no stock-out|no STOCK_OUT/i);
    assert.match(result.note, /not say the stock will last forever/i);
  });

  it('★ a product with no inventory row is zero stock, not an unreadable result', async () => {
    const result = await ok(
      'getProductStockCoverage',
      { id: empty.id, days: 10 },
      ctxOf(A),
    );
    assert.equal(result.found, true);
    assert.equal(result.current.rows, 0);
    assert.equal(result.current.availableQuantity, 0);
    assert.equal(result.forecast.daysOfCover, null);
  });

  it('★ missing, foreign and ambiguous identifiers are refused without a zero answer', async () => {
    const missing = await ok(
      'getProductStockCoverage',
      { id: '64b000000000000000000099', days: 10 },
      ctxOf(A),
    );
    assert.equal(missing.found, false);

    const foreign = await ok(
      'getProductStockCoverage',
      { id: foreignProduct.id, days: 10 },
      ctxOf(A),
    );
    assert.equal(foreign.found, false);

    const foreignPlace = await ok(
      'getProductStockCoverage',
      { id: product.id, locationId: foreignLocation.id, days: 10 },
      ctxOf(A),
    );
    assert.equal(foreignPlace.found, false);
    assert.match(foreignPlace.error, /location/i);

    const both = await ok(
      'getProductStockCoverage',
      { id: product.id, sku: product.sku, days: 10 },
      ctxOf(A),
    );
    assert.equal(both.found, false);
    assert.match(both.error, /exactly one/i);
  });

  it('★ an archived product is not presented as stock at a location', async () => {
    const retiredLocation = await newLocation(A, 'Coverage Retired Shelf');
    const retired = await newProduct(A, { name: uniqueName('Retired Widget') });
    await stockIn(A, retired.id, retiredLocation.id, 4);
    const archived = await api('POST', `/api/products/${retired.id}/archive`, {
      token: A.token,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));

    const atLocation = await ok(
      'getProductsByLocation',
      { location: retiredLocation.name },
      ctxOf(A),
    );
    assert.equal(
      atLocation.items.some((row) => row.id === retired.id),
      false,
      'an archived product was returned as currently stocked',
    );

    // The exclusion is about "what is current stock at this shelf", not erasure: an
    // explicit one-product read must still show the archived record and its status.
    const explicit = await ok('getProduct', { id: retired.id }, ctxOf(A));
    assert.equal(explicit.found, true);
    assert.equal(explicit.product.status, 'ARCHIVED');
  });

  it('★ getProduct refuses two identifiers instead of silently preferring one', async () => {
    const result = await ok(
      'getProduct',
      { id: product.id, sku: product.sku },
      ctxOf(A),
    );
    assert.equal(result.found, false);
    assert.match(result.error, /exactly one/i);
  });
});
