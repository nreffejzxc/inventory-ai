// AI-44 — brands are recorded facts, not adjectives inferred from a name.
//
// AI-43 made the assistant say the catalogue had no brand field. That was true, and it
// meant "what brands do we carry?" could never be answered from data. This suite pins the
// replacement: an optional brand on the product, searchable by the same `q` as name/SKU/
// barcode, and one `listBrands` read that aggregates the recorded field without pretending
// a missing brand is a brand called "".
//
// WHAT IS PINNED:
//   * the prompt sends brand questions to listBrands and distinguishes null ("not
//     recorded") from "no such brand";
//   * searchProducts matches the recorded brand and returns it beside the row;
//   * listBrands counts only ACTIVE products with a recorded brand, reports the category
//     and a few product names, and says stock is a separate read;
//   * the category filter is the same exact-name resolution the other tools use;
//   * a no-match page is still a page, with the note that no brand is recorded;
//   * getProduct reports a recorded brand and null when there is none.

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

unitSuite('AI-44 brands are a recorded field', () => {
  it('★ the prompt sends brand questions to listBrands and distinguishes a missing brand', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /Brand is an optional recorded field/i);
    assert.match(prompt, /when the member asks for a brand and it is null, say plainly that no brand is recorded for that product/i);
    assert.match(prompt, /call listBrands/i);
    assert.match(prompt, /no brand is recorded for that filter/i);
  });

  it('★ the tool is advertised, and says stock is a separate read', () => {
    const tool = aiToolsById.get('listBrands');
    assert.ok(tool, 'listBrands is missing from the tool table');
    assert.match(tool.description, /recorded on ACTIVE products/i);
    assert.match(tool.description, /an empty result means no brand is recorded/i);
    assert.match(tool.description, /Stock is not included/i);
    assert.equal(tool.permission, 'products.view');
  });
});

dbSuite('AI-44 recorded brands are searchable and summarised', dbOk, () => {
  let A;
  let categoryName;
  let oilId;
  let filterId;
  let noBrandId;

  before(async () => {
    A = await registerOwner(api, tracker);
    categoryName = uniqueName('Household');
    const category = await api('POST', '/api/categories', {
      token: A.token,
      body: { name: categoryName },
    });
    assert.equal(category.status, 201, JSON.stringify(category.json));

    const makeProduct = async (body) => {
      const res = await api('POST', '/api/products', { token: A.token, body });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    };

    const oil = await makeProduct({
      name: uniqueName('ZZ Oil 10W-40'),
      brand: 'ZZ Oil',
      categoryId: category.json.id,
      description: 'API SN 10W-40 for petrol cars',
      sellingPrice: 12.5,
      unit: 'L',
      minimumStock: 2,
    });
    oilId = oil.id;
    assert.equal(oil.brand, 'ZZ Oil', 'the API must return the recorded brand');

    const filter = await makeProduct({
      name: uniqueName('ZZ Oil Filter'),
      brand: 'ZZ Oil',
      categoryId: category.json.id,
      sellingPrice: 8,
      unit: 'pc',
      minimumStock: 1,
    });
    filterId = filter.id;

    await makeProduct({
      name: uniqueName('Acme Coolant'),
      brand: 'Acme',
      categoryId: category.json.id,
      sellingPrice: 9.5,
      unit: 'L',
      minimumStock: 1,
    });

    const noBrand = await makeProduct({
      name: uniqueName('Unbranded Cloth'),
      categoryId: category.json.id,
      sellingPrice: 4,
      unit: 'pc',
      minimumStock: 1,
    });
    noBrandId = noBrand.id;
    assert.equal(noBrand.brand, null, 'an absent brand is null, not an empty string');
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ searchProducts matches the recorded brand and returns it on the row', async () => {
    const result = await ok('searchProducts', { q: 'ZZ Oil' }, ctxOf(A));
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.items.map((row) => row.id).sort(),
      [oilId, filterId].sort()
    );
    assert.ok(result.items.every((row) => row.brand === 'ZZ Oil'));
    assert.match(result.note, /Brand is an optional recorded field/i);
  });

  it('★ listBrands aggregates the brand, its products and its category', async () => {
    const result = await ok('listBrands', { q: 'ZZ' }, ctxOf(A));
    assert.equal(result.count, 1);
    assert.equal(result.items.length, 1);
    const row = result.items[0];
    assert.equal(row.brand, 'ZZ Oil');
    assert.equal(row.productCount, 2);
    assert.deepEqual(row.categories, [categoryName]);
    assert.deepEqual(row.priceRange, { min: 8, max: 12.5 });
    assert.equal(row.sampleProducts.length, 2);
    assert.ok(row.sampleProducts.every((product) => product.name));
    assert.ok(row.sampleProducts.some((product) => /API SN 10W-40/.test(product.description)));
    assert.match(result.note, /does not include stock levels/i);
    assert.match(result.note, /no brand is recorded/i);
  });

  it('★ the category name filter reuses the exact-name resolution', async () => {
    const result = await ok('listBrands', { category: categoryName }, ctxOf(A));
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.items.map((row) => row.brand).sort(),
      ['Acme', 'ZZ Oil']
    );
  });

  it('★ a no-match page says no brand is recorded rather than inventing one', async () => {
    const result = await ok('listBrands', { q: 'No Such Brand' }, ctxOf(A));
    assert.equal(result.count, 0);
    assert.equal(result.items.length, 0);
    assert.match(result.note, /no brand is recorded/i);
  });

  it('★ getProduct reports a recorded brand and null when there is none', async () => {
    const branded = await ok('getProduct', { id: oilId }, ctxOf(A));
    assert.equal(branded.found, true);
    assert.equal(branded.product.brand, 'ZZ Oil');
    assert.equal(branded.product.description, 'API SN 10W-40 for petrol cars');

    const unbranded = await ok('getProduct', { id: noBrandId }, ctxOf(A));
    assert.equal(unbranded.found, true);
    assert.equal(unbranded.product.brand, null);
  });
});
