// AI-16 — the category a member named, without a round-trip to translate it.
//
// WHY THIS EXISTS. AI-15 gave the location tools an exact `location` name, so "products in
// Main Warehouse" stopped paying a `listLocations` call. The category tools had the same
// defect one table over: `searchProducts` and `getReorderNeededProducts` filter on
// `categoryId`, so *"how many beverages products are low?"* cost a provider round-trip to
// `listCategories` purely to turn a member's word into an id — and on the measured
// free-tier turns that is one extra model call, a full re-send of the prompt and tool
// catalogue, and one more chance to receive an empty completion.
//
// WHAT THIS SUITE GUARDS, and why each case is here rather than assumed:
//   * the name and the id must return the SAME rows — a shortcut that quietly changed the
//     answer would be worse than the extra call;
//   * only an EXACT, ACTIVE name resolves, because an unanchored or case-forgiving match
//     would attach a member's question to the wrong category;
//   * a duplicated name returns BOTH candidates instead of picking one;
//   * another tenant's category never resolves, even with an identical name;
//   * asking by both forms at once is refused, since two answers are not one;
//   * no category means "every category", not a refusal — both tools are documented as
//     catalogue-wide queries.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';

const CATEGORY_TOOLS = ['searchProducts', 'getReorderNeededProducts'];

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

async function newCategory(business, over = {}) {
  const res = await api('POST', '/api/categories', { token: business.token, body: { name: uniqueName('Cat'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { name: uniqueName('P'), ...over } });
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

const productIds = (result) => result.items.map((row) => row.id).sort();

// ---------------------------------------------------------------------------
// The schemas — a name is accepted, bounded, and cannot smuggle anything else.
// ---------------------------------------------------------------------------

unitSuite('AI-16 the category-name argument is declared and bounded', () => {
  it('★ both category-filtering tools accept a name, and neither still demands an id', () => {
    for (const name of CATEGORY_TOOLS) {
      const tool = aiToolsById.get(name);
      const props = tool.parameters.properties;
      assert.ok(props.category, `${name} does not accept a category name`);
      assert.equal(props.category.type, 'string');
      assert.equal(props.category.maxLength, 100);
      assert.ok(
        !(tool.parameters.required ?? []).includes('categoryId'),
        `${name} still requires categoryId, so a name alone would be refused`,
      );
      assert.equal(tool.parameters.additionalProperties, false);
    }
  });

  it('★ a name is bounded and cannot be widened into an operator or a tenant', () => {
    for (const name of CATEGORY_TOOLS) {
      const tool = aiToolsById.get(name);
      assert.equal(validateToolArgs(tool, { category: 'x'.repeat(100) }).problems.length, 0);
      assert.ok(validateToolArgs(tool, { category: 'x'.repeat(101) }).problems.length > 0);
      assert.ok(validateToolArgs(tool, { businessId: 'other' }).problems.length > 0);
      // A Mongo operator is an UNKNOWN argument, never a filter — the schema has no
      // `category` object form for it to reach.
      assert.ok(validateToolArgs(tool, { category: { $ne: null } }).problems.length > 0);
    }
  });

  it('the descriptions tell the model when a name is the cheaper way', () => {
    // The model reads the description, not this suite: a parameter it is never told about
    // is a parameter that will not be used.
    for (const name of CATEGORY_TOOLS) {
      const description = aiToolsById.get(name).description;
      assert.match(description, /exact/i, `${name}'s description never says the name must be exact`);
      assert.match(description, /category/i);
    }
    // And the tool the model would otherwise use to translate the name says it may not
    // need to: leaving that sentence out is what would keep the extra call in the loop.
    const list = aiToolsById.get('listCategories').description;
    assert.match(list, /searchProducts/);
    assert.match(list, /getReorderNeededProducts/);
    // The model must know the alias is accepted, or it will keep translating it by hand.
    for (const name of CATEGORY_TOOLS) {
      assert.match(aiToolsById.get(name).parameters.properties.category.description, /"and" and "&"/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The behaviour, against real MongoDB.
// ---------------------------------------------------------------------------

dbSuite('AI-16 a category name returns exactly what its id returns', dbOk, () => {
  let A;
  let B;
  let beverages;
  let snacks;
  let archived;
  let sharedNameB;
  let cola;
  let pretzels;
  let chips;
  let uncategorisedLow;
  let ampCategory;
  let ampProduct;

  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);

    beverages = await newCategory(A, { name: 'Beverages' });
    snacks = await newCategory(A, { name: 'Snacks' });
    ampCategory = await newCategory(A, { name: 'Keyboards & Mice' });
    archived = await newCategory(A, { name: 'Retired Line' });
    const arch = await api('POST', `/api/categories/${archived.id}/archive`, { token: A.token });
    assert.equal(arch.status, 200, JSON.stringify(arch.json));

    // A category whose DESCRIPTION contains another category's name: an unanchored search
    // would resolve the wrong row, which is the defect the anchored query exists to prevent.
    await newCategory(A, { name: 'Annex Goods', description: 'Overflow for Beverages stock' });

    // Two ACTIVE categories with one name: legal in the model, so the tool must not choose.
    await newCategory(A, { name: 'Twin Line' });
    await newCategory(A, { name: 'Twin Line' });

    const location = await (async () => {
      const res = await api('POST', '/api/locations', { token: A.token, body: { name: uniqueName('Loc') } });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    })();

    // Cola is LOW (1 on hand against a minimum of 5); Chips is HEALTHY in the same catalogue;
    // Pretzels is LOW inside Snacks, so narrowing by category is visible in both tools.
    cola = await newProduct(A, { name: 'Cola Crate', categoryId: beverages.id, minimumStock: 5 });
    chips = await newProduct(A, { name: 'Chips Box', categoryId: snacks.id, minimumStock: 2 });
    pretzels = await newProduct(A, { name: 'Pretzel Bag', categoryId: snacks.id, minimumStock: 3 });
    uncategorisedLow = await newProduct(A, { name: 'Loose Nails', minimumStock: 4 });
    ampProduct = await newProduct(A, { name: 'Amp Keyboard', categoryId: ampCategory.id });

    await stockIn(A, cola, location.id, 1);
    await stockIn(A, chips, location.id, 10);
    // Pretzels (and the uncategorised product) are deliberately never stocked: a product with
    // nothing on hand must still appear in the restock list as OUT_OF_STOCK.

    // Another tenant with the same category name — the isolation half.
    sharedNameB = await newCategory(B, { name: 'Beverages' });
    const foreignProduct = await newProduct(B, { name: 'Foreign Cola', categoryId: sharedNameB.id });
    assert.ok(foreignProduct);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ by name and by id return the same rows — the shortcut cannot change the answer', async () => {
    const byId = await ok('searchProducts', { categoryId: beverages.id }, ctxOf(A));
    const byName = await ok('searchProducts', { category: 'Beverages' }, ctxOf(A));

    assert.deepEqual(productIds(byName), productIds(byId), 'the name path returned a different page');
    assert.equal(byName.count, byId.count);
    assert.deepEqual(byName.items.map((p) => p.id), [cola], 'the resolved category must be Beverages');
  });

  it('★ case and surrounding whitespace are forgiven, because they are not a different catalogue', async () => {
    const byName = await ok('searchProducts', { category: '  bevERAGES  ' }, ctxOf(A));
    assert.deepEqual(productIds(byName), productIds(await ok('searchProducts', { categoryId: beverages.id }, ctxOf(A))));
  });

  it('★ "and" and "&" resolve to the same active category', async () => {
    const alias = ampCategory.name.replace('&', 'and');
    const byAmp = await ok('searchProducts', { category: ampCategory.name }, ctxOf(A));
    const byAnd = await ok('searchProducts', { category: alias }, ctxOf(A));
    assert.deepEqual(productIds(byAnd), [ampProduct]);
    assert.deepEqual(productIds(byAnd), productIds(byAmp));

    // T4 asked the value tool, not searchProducts. The alias must resolve there too.
    const valueByAnd = await ok('getStockValue', { category: alias }, ctxOf(A));
    assert.equal(valueByAnd.scope.categoryId, ampCategory.id);
  });

  it('★ a PREFIX does not resolve — the name must be exact, not merely a start of one', async () => {
    // The unanchored version of this query is the realistic defect: `Bev` would resolve to
    // `Beverages` and `Snack` to `Snacks`, so a member asking about a grouping that does not
    // exist would be answered about another one.
    for (const fragment of ['Bev', 'Snack', 'Twin']) {
      const res = await ok('searchProducts', { category: fragment }, ctxOf(A));
      assert.equal(res.found, false, `"${fragment}" resolved as if it were a category name`);
    }
  });

  it('★ a name that matches only a DESCRIPTION does not resolve', async () => {
    // "Annex Goods" exists; "Beverages" appears in its description. Anchoring is what keeps
    // the member's question about beverages off the annex.
    const annex = await ok('searchProducts', { category: 'Overflow for Beverages stock' }, ctxOf(A));
    assert.equal(annex.found, false, 'a description fragment resolved as if it were a category');

    const real = await ok('searchProducts', { category: 'Beverages' }, ctxOf(A));
    assert.deepEqual(real.items.map((p) => p.id), [cola]);
  });

  it('★ an unknown name is a soft answer that points at listCategories, not a crash', async () => {
    const res = await ok('searchProducts', { category: 'Nowhere At All' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.message, /No active category is named/i);
    assert.match(res.message, /listCategories/, 'the model is told how to recover');
    assert.equal(res.count, undefined, 'a refusal must not look like an empty result set');
  });

  it('★ an archived category never resolves by name, even though it still exists', async () => {
    const res = await ok('searchProducts', { category: 'Retired Line' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.message, /No active category/i);
  });

  it('★ a duplicated name returns both candidates instead of picking one', async () => {
    const res = await ok('searchProducts', { category: 'Twin Line' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.equal(res.ambiguous, true);
    assert.equal(res.matches.length, 2);
    assert.ok(res.matches.every((row) => row.name === 'Twin Line'));
    assert.equal(new Set(res.matches.map((row) => row.id)).size, 2, 'both ids must be offered');
  });

  it("★ another tenant's category never resolves, even with an identical name", async () => {
    const res = await ok('searchProducts', { category: 'Beverages' }, ctxOf(A));
    assert.deepEqual(res.items.map((p) => p.id), [cola]);
    assert.ok(!res.items.some((p) => p.name.includes('Foreign')), "the other tenant's product appeared");

    const onlyB = await newCategory(B, { name: 'Private Range' });
    await newProduct(B, { name: 'Private Product', categoryId: onlyB.id });
    const missing = await ok('searchProducts', { category: 'Private Range' }, ctxOf(A));
    assert.equal(missing.found, false, `A resolved B's category ${onlyB.id}`);

    const inB = await ok('searchProducts', { category: 'Private Range' }, ctxOf(B));
    assert.equal(inB.count, 1, 'the name must resolve for its own tenant');
  });

  it('★ asking by both forms at once is refused — two answers are not one', async () => {
    const res = await ok('searchProducts', { categoryId: beverages.id, category: 'Snacks' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.error, /either categoryId or category/i);
  });

  it('★ a category name still combines with the other filters instead of replacing them', async () => {
    const res = await ok('searchProducts', { category: 'Snacks', q: 'Pretzel' }, ctxOf(A));
    assert.deepEqual(res.items.map((p) => p.id), [pretzels]);
  });

  it('★ getReorderNeededProducts narrows by the same name, and no category stays wider', async () => {
    const byId = await ok('getReorderNeededProducts', { categoryId: beverages.id }, ctxOf(A));
    const byName = await ok('getReorderNeededProducts', { category: 'Beverages' }, ctxOf(A));
    assert.deepEqual(byName.items.map((p) => p.id).sort(), byId.items.map((p) => p.id).sort());
    assert.equal(byName.count, byId.count);
    assert.ok(byName.items.some((p) => p.id === cola), 'the low-stock product in the category is missing');
    assert.ok(!byName.items.some((p) => p.id === pretzels), 'a product from another category leaked in');

    // Snacks narrows to its own low item — and excludes the healthy one in the same category.
    const snackName = await ok('getReorderNeededProducts', { category: 'Snacks' }, ctxOf(A));
    assert.ok(snackName.items.some((p) => p.id === pretzels));
    assert.ok(!snackName.items.some((p) => p.id === chips), 'a healthy product appeared in the restock list');

    // The absence of a category is "every category", not a refusal: the unfiltered answer
    // really is wider, or the narrowing cases prove nothing.
    const all = await ok('getReorderNeededProducts', {}, ctxOf(A));
    assert.ok(all.count > byName.count, `unfiltered (${all.count}) was not wider than one category (${byName.count})`);
    assert.ok(all.items.some((p) => p.id === uncategorisedLow), 'an uncategorised low product must still be listed');
    assert.equal(all.found, undefined, 'the absence of a filter is not a refusal');
  });
});
