// AI-46 — what does the catalogue actually contain?
//
// A manager asks "what do we carry?" or "which brands?" and the honest answer needs
// three different facts: how many active products exist, how they divide across
// categories, and whether the optional brand/description fields are populated at
// all. Asking category by category spends tool rounds and still does not expose the
// coverage gap. This one read returns the counts and says what it does NOT include.
//
// It is deliberately not a quality ranker. A brand with more products is not better,
// a higher recorded price is not higher quality, and a count cannot tell the model
// what is in stock. The same boundary now travels on listBrands, whose sample rows
// carry the recorded description and a price range so brands can be compared only
// on facts the business actually entered.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';
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

unitSuite('AI-46 catalogue coverage is one grounded read', () => {
  it('★ the prompt sends coverage questions to getCatalogOverview without a quality claim', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /call getCatalogOverview/i);
    assert.match(prompt, /counts/i);
    assert.match(prompt, /no stock, price or quality data/i);
    assert.match(prompt, /count as a quality ranking/i);
  });

  it('★ the tool is a no-argument products read and refuses a smuggled tenant', () => {
    const tool = aiToolsById.get('getCatalogOverview');
    assert.ok(tool, 'getCatalogOverview is missing from the tool table');
    assert.match(tool.description, /ACTIVE catalogue/i);
    assert.match(tool.description, /no stock, price or quality data/i);
    assert.match(tool.description, /no brand recorded/i);
    assert.equal(tool.permission, 'products.view');
    const { problems } = validateToolArgs(tool, { businessId: 'attacker' });
    assert.ok(problems.some((problem) => problem.includes('unknown argument')));
  });
});

dbSuite('AI-46 catalogue overview', dbOk, () => {
  let A;
  let automotiveName;
  let householdName;

  before(async () => {
    A = await registerOwner(api, tracker);
    automotiveName = uniqueName('Automotive');
    householdName = uniqueName('Household');

    const automotive = await api('POST', '/api/categories', {
      token: A.token,
      body: { name: automotiveName },
    });
    assert.equal(automotive.status, 201, JSON.stringify(automotive.json));

    const household = await api('POST', '/api/categories', {
      token: A.token,
      body: { name: householdName },
    });
    assert.equal(household.status, 201, JSON.stringify(household.json));

    const makeProduct = async (body) => {
      const res = await api('POST', '/api/products', { token: A.token, body });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    };

    await makeProduct({
      name: uniqueName('ZZ Oil 10W-40'),
      brand: 'ZZ Oil',
      categoryId: automotive.json.id,
      description: 'API SN 10W-40 for petrol cars and motorcycles',
      sellingPrice: 12.5,
      unit: 'L',
      minimumStock: 2,
    });
    await makeProduct({
      name: uniqueName('ZZ Oil Filter'),
      brand: 'ZZ Oil',
      categoryId: automotive.json.id,
      description: 'Spin-on oil filter for petrol cars',
      sellingPrice: 8,
      unit: 'pc',
      minimumStock: 1,
    });
    await makeProduct({
      name: uniqueName('Acme Coolant'),
      categoryId: automotive.json.id,
      description: 'Ready-to-use coolant for cars',
      sellingPrice: 9.5,
      unit: 'L',
      minimumStock: 1,
    });
    await makeProduct({
      name: uniqueName('Acme Soap'),
      brand: 'Acme',
      categoryId: household.json.id,
      sellingPrice: 4,
      unit: 'pc',
      minimumStock: 1,
    });
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ reports active product, category and recorded-data coverage', async () => {
    const result = await ok('getCatalogOverview', {}, ctxOf(A));
    assert.equal(result.totalActiveProducts, 4);
    assert.equal(result.categoryCount, 2);
    assert.equal(result.recordedBrands, 2);
    assert.equal(result.productsWithBrand, 3);
    assert.equal(result.productsWithoutBrand, 1);
    assert.equal(result.productsWithDescription, 3);
    assert.equal(result.productsWithoutDescription, 1);
    assert.match(result.note, /no stock, price or quality data/i);

    const automotive = result.categories.find((category) => category.name === automotiveName);
    assert.ok(automotive, 'the automotive category is missing');
    assert.equal(automotive.productCount, 3);
    assert.equal(automotive.productsWithBrand, 2);
    assert.equal(automotive.productsWithDescription, 3);

    const household = result.categories.find((category) => category.name === householdName);
    assert.ok(household, 'the household category is missing');
    assert.equal(household.productCount, 1);
    assert.equal(household.productsWithBrand, 1);
    assert.equal(household.productsWithDescription, 0);
  });

  it('★ brand rows carry recorded descriptions and a price range, not a quality score', async () => {
    const result = await ok('listBrands', { q: 'ZZ' }, ctxOf(A));
    assert.equal(result.count, 1);
    const row = result.items[0];
    assert.equal(row.brand, 'ZZ Oil');
    assert.equal(row.productCount, 2);
    assert.deepEqual(row.categories, [automotiveName]);
    assert.deepEqual(row.priceRange, { min: 8, max: 12.5 });
    assert.ok(row.sampleProducts.some((product) => /API SN 10W-40/.test(product.description)));
    assert.match(result.note, /price range is the recorded selling price/i);
    assert.match(result.note, /not a quality or value rating/i);
  });
});
