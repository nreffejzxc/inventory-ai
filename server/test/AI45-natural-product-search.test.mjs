// AI-45 — a manager's words, not the product's exact name.
//
// The sample questions say "engine oil", "something for vehicle maintenance" and
// "brake fluid or coolant". A catalogue may record "Motor Oil 10W-40" as the name and
// "API SN for petrol cars and motorcycles" only in the description. `searchProducts`
// finds the first kind of query and deliberately does not read description text, so the
// assistant could truthfully say "no match" after looking in the wrong field.
//
// findProducts is the discovery read: several comma-separated everyday terms, matched
// independently against name, brand, description, SKU and barcode, with availability
// included. It is not a quality ranker. A match is a candidate; the row's recorded facts
// are the only comparison the assistant may make.
//
// WHAT IS PINNED:
//   * the prompt sends use/task questions to findProducts before declaring absence, and
//     forbids turning a match into a best/trusted claim;
//   * the tool searches description text, which searchProducts does not;
//   * several terms are ORed, so the member does not need the catalogue's exact word;
//   * inStockOnly excludes an out-of-stock match without changing the count rule;
//   * a no-match page is a page with a note, not an invented recommendation.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

unitSuite('AI-45 everyday discovery is bounded by recorded facts', () => {
  it('★ the prompt asks for several terms and forbids a quality ranking', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /call findProducts with several likely terms/i);
    assert.match(prompt, /before concluding that nothing exists/i);
    assert.match(prompt, /recorded facts/i);
    assert.match(prompt, /never call one best, trusted or suitable without recorded evidence/i);
  });

  it('★ the tool description says it reads description text and returns stock', () => {
    const tool = aiToolsById.get('findProducts');
    assert.ok(tool, 'findProducts is missing from the tool table');
    assert.match(tool.description, /recorded description/i);
    assert.match(tool.description, /returns available stock/i);
    assert.match(tool.description, /not a quality ranking/i);
    assert.equal(tool.permission, 'products.view');
  });

  it('the matcher can fail — an absent sentence is not matched', () => {
    assert.doesNotMatch(systemPrompt(), /a product is good because its name says so/i);
  });
});

dbSuite('AI-45 natural product discovery', dbOk, () => {
  let A;
  let main;
  let oilId;
  let brakeId;
  let coolantId;

  before(async () => {
    A = await registerOwner(api, tracker);
    const location = await api('POST', '/api/locations', {
      token: A.token,
      body: { name: uniqueName('Workshop') },
    });
    assert.equal(location.status, 201, JSON.stringify(location.json));
    main = location.json;

    const category = await api('POST', '/api/categories', {
      token: A.token,
      body: { name: uniqueName('Automotive') },
    });
    assert.equal(category.status, 201, JSON.stringify(category.json));

    const makeProduct = async (body) => {
      const res = await api('POST', '/api/products', { token: A.token, body });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    };

    const oil = await makeProduct({
      name: uniqueName('ZZ Motor Oil 10W-40'),
      brand: 'ZZ Oil',
      categoryId: category.json.id,
      description: 'API SN 10W-40 for petrol cars and motorcycles',
      sellingPrice: 12.5,
      unit: 'L',
      minimumStock: 2,
    });
    oilId = oil.id;

    const brake = await makeProduct({
      name: uniqueName('Acme Brake Fluid DOT 4'),
      brand: 'Acme',
      categoryId: category.json.id,
      description: 'For hydraulic brake systems',
      sellingPrice: 8,
      unit: 'L',
      minimumStock: 1,
    });
    brakeId = brake.id;

    const coolant = await makeProduct({
      name: uniqueName('Acme Coolant'),
      brand: 'Acme',
      categoryId: category.json.id,
      description: 'Radiator coolant for petrol cars',
      sellingPrice: 9,
      unit: 'L',
      minimumStock: 1,
    });
    coolantId = coolant.id;

    for (const [productId, quantity] of [
      [oilId, 10],
      [coolantId, 5],
    ]) {
      const stocked = await api('POST', '/api/inventory/stock-in', {
        token: A.token,
        body: { productId, locationId: main.id, quantity },
      });
      assert.equal(stocked.status, 201, JSON.stringify(stocked.json));
    }
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ matches a synonym the name does not use, and reports stock', async () => {
    const result = await ok('findProducts', { keywords: 'engine oil, motor oil, 10W-40' }, ctxOf(A));
    assert.equal(result.count, 1);
    const row = result.items[0];
    assert.equal(row.id, oilId);
    assert.equal(row.brand, 'ZZ Oil');
    assert.match(row.description, /petrol cars and motorcycles/);
    assert.equal(row.availableQuantity, 10);
    assert.deepEqual(result.terms, ['engine oil', 'motor oil', '10W-40']);
    assert.match(result.note, /not a quality ranking/i);
  });

  it('★ reads the recorded description, where the use is actually written', async () => {
    const result = await ok('findProducts', { keywords: 'petrol cars' }, ctxOf(A));
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.items.map((row) => row.id).sort(),
      [oilId, coolantId].sort()
    );
  });

  it('★ several terms are alternatives, and inStockOnly removes the empty row', async () => {
    const all = await ok('findProducts', { keywords: 'brake fluid, coolant' }, ctxOf(A));
    assert.equal(all.count, 2);
    assert.deepEqual(
      all.items.map((row) => row.id).sort(),
      [brakeId, coolantId].sort()
    );

    const stocked = await ok(
      'findProducts',
      { keywords: 'brake fluid, coolant', inStockOnly: true },
      ctxOf(A)
    );
    assert.equal(stocked.count, 1);
    assert.equal(stocked.items[0].id, coolantId);
  });

  it('★ a no-match page states the limit of the search instead of inventing a product', async () => {
    const result = await ok('findProducts', { keywords: 'tractor tyre, plough' }, ctxOf(A));
    assert.equal(result.count, 0);
    assert.equal(result.items.length, 0);
    assert.match(result.note, /No match means none of these terms are recorded/i);
  });

  it('★ category filtering uses the same exact-name resolution', async () => {
    const categories = await ok('listCategories', {}, ctxOf(A));
    const automotive = categories.items.find((row) => row.name.startsWith('Automotive'));
    assert.ok(automotive, 'the test category is missing');
    const result = await ok(
      'findProducts',
      { keywords: 'coolant', category: automotive.name },
      ctxOf(A)
    );
    assert.equal(result.count, 1);
    assert.equal(result.items[0].id, coolantId);
  });
});
