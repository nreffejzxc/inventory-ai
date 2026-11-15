// AI-116 — bounded follow-up context and answer provenance.
//
// WHAT IS PINNED:
//   * only an anaphoric follow-up ("which of those", "among them") uses the
//     previous set; a fresh question does not;
//   * the previous set is membership only — filtering re-reads CURRENT stock;
//   * the filter is limited to the previous products, combines category/location
//     and stock filters, and cannot reach another tenant;
//   * an inventory row's id is never mistaken for a product id;
//   * the stored context carries the retrieval time, sources, counts and filters
//     the footer/Inspect panel needs, and no product ids are exposed to the client.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool } from '../src/services/ai/tools.ts';
import {
  buildAnswerContext,
  filterLabels,
  isPreviousResultFollowUp,
  productIdsFromToolResult,
} from '../src/services/ai/answerContext.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });
const PRODUCT_A = '64b000000000000000000001';
const PRODUCT_B = '64b000000000000000000002';

async function newCategory(session, name) {
  const res = await api('POST', '/api/categories', { token: session.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(session, name) {
  const res = await api('POST', '/api/locations', { token: session.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newProduct(session, { name, categoryId, minimumStock = 10 }) {
  const res = await api('POST', '/api/products', {
    token: session.token,
    body: { name, categoryId, minimumStock },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function stockIn(session, productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-in', {
    token: session.token,
    body: { productId, locationId, quantity },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

unitSuite('AI-116 — only a real follow-up uses the previous set', () => {
  it('★ recognises narrowing language and leaves a fresh question alone', () => {
    assert.equal(isPreviousResultFollowUp('Which of those are in Keyboards & Mice?'), true);
    assert.equal(isPreviousResultFollowUp('How many of those are low?'), true);
    assert.equal(isPreviousResultFollowUp('Among them, which are at Main Warehouse?'), true);
    assert.equal(isPreviousResultFollowUp('Narrow that list to Logitech'), true);
    assert.equal(isPreviousResultFollowUp('Which products need restocking?'), false);
    assert.equal(isPreviousResultFollowUp('Show me the inventory in Main Warehouse.'), false);
    assert.equal(isPreviousResultFollowUp('What is the stock value?'), false);
  });

  it('★ keeps product ids, never an inventory row id', () => {
    assert.deepEqual(
      productIdsFromToolResult('getInventory', {
        items: [{ id: '64b000000000000000000099', product: { id: PRODUCT_A } }],
      }),
      [PRODUCT_A],
    );
    assert.deepEqual(
      productIdsFromToolResult('getReorderNeededProducts', {
        items: [{ id: PRODUCT_A }, { id: PRODUCT_B }],
      }),
      [PRODUCT_A, PRODUCT_B],
    );
    assert.deepEqual(productIdsFromToolResult('getInventoryHistory', { items: [{ id: PRODUCT_A }] }), []);
  });
});

unitSuite('AI-116 — the stored context is small, readable and honest', () => {
  it('★ carries sources, counts and filters without a payload', () => {
    const context = buildAnswerContext({
      tools: ['getReorderNeededProducts', 'researchMarketPrices', 'getReorderNeededProducts'],
      retrievedAt: '2026-11-15T12:00:00.000Z',
      read: {
        tool: 'getReorderNeededProducts',
        input: { category: 'Keyboards & Mice', lowStock: true, outOfStock: false, limit: 50 },
        productIds: [PRODUCT_A, PRODUCT_B],
        total: 2,
        hasMore: false,
        retrievedAt: '2026-11-15T11:59:58.000Z',
      },
      webSources: [{ title: 'Example', url: 'https://example.com/item' }],
    });

    assert.deepEqual(context.tools, ['getReorderNeededProducts', 'researchMarketPrices']);
    assert.deepEqual(context.sources, ['Inventory records', 'Public web']);
    assert.equal(context.productCount, 2);
    assert.equal(context.total, 2);
    assert.equal(context.hasMore, false);
    assert.deepEqual(context.filters, [
      { label: 'Category', value: 'Keyboards & Mice' },
      { label: 'Low stock', value: 'Yes' },
      { label: 'Limit', value: '50' },
    ]);
    assert.deepEqual(context.resultProductIds, [PRODUCT_A, PRODUCT_B]);
    assert.deepEqual(context.webSources, [{ title: 'Example', url: 'https://example.com/item' }]);
  });

  it('★ names no source when the answer read nothing', () => {
    const context = buildAnswerContext({
      tools: [],
      retrievedAt: '2026-11-15T12:00:00.000Z',
    });
    assert.deepEqual(context.sources, []);
    assert.equal(context.productCount, 0);
    assert.deepEqual(filterLabels({ businessId: 'secret', lowStock: false }), []);
  });

  it('★ names the inventory source for a reference-only read', () => {
    const context = buildAnswerContext({
      tools: ['listCategories', 'listLocations'],
      retrievedAt: '2026-11-15T12:00:00.000Z',
    });
    assert.deepEqual(context.sources, ['Inventory records']);
    assert.equal(context.productCount, 0);
  });
});

dbSuite('AI-116 — filtering the previous set re-reads current stock', dbOk, () => {
  let owner;
  let otherOwner;
  let keyboardCategory;
  let mouseCategory;
  let warehouse;
  let counter;
  let foreignLocation;
  let keyboard;
  let mouse;
  let outOfStock;
  let notPrevious;
  let foreign;
  let previous;

  before(async () => {
    owner = await registerOwner(api, tracker);
    otherOwner = await registerOwner(api, tracker);
    keyboardCategory = await newCategory(owner, uniqueName('Keyboards'));
    mouseCategory = await newCategory(owner, uniqueName('Mice'));
    warehouse = await newLocation(owner, uniqueName('Main Warehouse'));
    counter = await newLocation(owner, uniqueName('Front Counter'));
    foreignLocation = await newLocation(otherOwner, uniqueName('Foreign Store'));

    keyboard = await newProduct(owner, {
      name: uniqueName('Keyboard'),
      categoryId: keyboardCategory,
      minimumStock: 5,
    });
    mouse = await newProduct(owner, {
      name: uniqueName('Mouse'),
      categoryId: mouseCategory,
      minimumStock: 5,
    });
    outOfStock = await newProduct(owner, {
      name: uniqueName('Empty Keyboard'),
      categoryId: keyboardCategory,
      minimumStock: 5,
    });
    notPrevious = await newProduct(owner, {
      name: uniqueName('New Keyboard'),
      categoryId: keyboardCategory,
      minimumStock: 5,
    });
    foreign = await newProduct(otherOwner, {
      name: uniqueName('Foreign Keyboard'),
      categoryId: await newCategory(otherOwner, uniqueName('Foreign')),
      minimumStock: 5,
    });

    await stockIn(owner, keyboard, warehouse, 2);
    await stockIn(owner, mouse, counter, 20);
    await stockIn(owner, notPrevious, warehouse, 5);
    await stockIn(otherOwner, foreign, foreignLocation, 8);

    previous = {
      tool: 'getReorderNeededProducts',
      input: { limit: 50 },
      productIds: [keyboard, mouse, outOfStock, foreign],
      retrievedAt: '2026-11-15T11:59:58.000Z',
      total: 4,
    };
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ filters only the previous ids, by category and by place', async () => {
    const ctx = { ...ctxOf(owner), previousResult: previous };

    const category = await executeTool('filterPreviousResults', { categoryId: keyboardCategory }, ctx);
    assert.equal(category.ok, true, JSON.stringify(category));
    assert.deepEqual(category.result.items.map((row) => row.id).sort(), [keyboard, outOfStock].sort());
    assert.equal(category.result.count, 2);
    assert.equal(category.result.scope, 'previous-result-set');
    assert.equal(category.result.items.some((row) => row.id === notPrevious), false);
    assert.equal(category.result.items.some((row) => row.id === foreign), false);

    const place = await executeTool('filterPreviousResults', { locationId: warehouse }, ctx);
    assert.equal(place.ok, true, JSON.stringify(place));
    assert.deepEqual(place.result.items.map((row) => row.id), [keyboard]);
  });

  it('★ every quantity is re-read, not carried over from the previous answer', async () => {
    const ctx = { ...ctxOf(owner), previousResult: previous };
    const beforeChange = await executeTool('filterPreviousResults', { categoryId: keyboardCategory }, ctx);
    const beforeRow = beforeChange.result.items.find((row) => row.id === keyboard);
    assert.equal(beforeRow.availableQuantity, 2);

    // The fixture starts at 2; add 5 so the fresh read must report 7.
    await stockIn(owner, keyboard, warehouse, 5);

    const afterChange = await executeTool('filterPreviousResults', { categoryId: keyboardCategory }, ctx);
    const afterRow = afterChange.result.items.find((row) => row.id === keyboard);
    assert.equal(afterRow.availableQuantity, 7);
    assert.equal(afterRow.unitsBelowMinimum, 0);
  });

  it('★ a follow-up cannot filter without a previous set', async () => {
    const result = await executeTool('filterPreviousResults', { categoryId: keyboardCategory }, ctxOf(owner));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.available, false);
    assert.equal(result.result.code, 'NO_PREVIOUS_RESULT');
  });
});
