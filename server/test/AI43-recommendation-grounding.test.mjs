// AI-43 — a recommendation may rest only on catalogue facts, and the catalogue must say
// what it does not record.
//
// THE PHONE PASS, 2026-11-03. The assistant was asked the sample recommendation questions
// against the production tenant: vehicle repairs and engine oil, batteries/chargers, and
// cleaning products with "trusted brands". It answered honestly — it found no engine oil,
// named the four real categories, and said brand names are not stored — but that was model
// compliance on one model on one day, not a boundary. The catalogue has NO brand, model,
// specification, rating or review field, and every product name is an adjective plus a noun
// ("Premium Battery", "Ultra Detergent"). A different sample, or a model that treats the
// adjective as evidence, can turn that into "the best brand" or fill the gap from famous
// brands the business does not stock.
//
// WHAT IS PINNED HERE:
//   * the prompt states the recommendation boundary — only tool-returned products, stock
//     checked before "available", no brand/quality inference from a name, no outside brands;
//   * the prompt asks for the category check on a "kind of product" question;
//   * a search result carries the boundary BESIDE the rows and carries the recorded
//     description, shortened in a list so long text cannot push rows out through the cap;
//   * getProduct keeps the full description, which is the only place a real tenant can
//     record a brand or a specification today;
//   * a zero-match page still carries the boundary, because that is the moment the model is
//     most likely to reach for an outside brand.
//
// The tool descriptions are asserted too: the model reads them, not this suite.

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

// ---------------------------------------------------------------------------
// The prompt and the tool descriptions — DB-free.
// ---------------------------------------------------------------------------

unitSuite('AI-43 the prompt states the recommendation boundary', () => {
  it('★ recommends only tool-returned products, and checks stock before saying available', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /Recommend only products a tool returned for this business/i);
    assert.match(prompt, /getInventory or getProduct before saying one is available or in stock/i);
  });

  it('★ forbids inferring a brand or quality from a product name', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /no brand, model, specification, rating or review field/i);
    assert.match(prompt, /never infer a brand or quality from a product name/i);
    assert.match(prompt, /"Premium", "Pro" or "Ultra"/);
  });

  it('★ requires the honest gap statement, and forbids outside brands', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /say plainly that the catalogue does not record it/i);
    assert.match(prompt, /Never fill the gap with a brand or product from outside this business/i);
  });

  it('★ asks for the category check on a kind-of-product question', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /check the categories and search the obvious product words/i);
    assert.match(prompt, /do not turn one empty search into a claim about the whole catalogue/i);
  });

  it('leaves the older guarantees intact', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /This assistant is READ-ONLY/);
    assert.match(prompt, /at most five items/);
  });

  it('the matcher can fail — an absent sentence is not matched', () => {
    assert.doesNotMatch(systemPrompt(), /A product's name proves its quality/i);
  });

  it('the tool descriptions tell the model what a search does and does not read', () => {
    const search = aiToolsById.get('searchProducts').description;
    assert.match(search, /including any recorded description/i);
    assert.match(search, /does not cover description text/i);

    const detail = aiToolsById.get('getProduct').description;
    assert.match(detail, /full recorded description/i);
  });
});

// ---------------------------------------------------------------------------
// The rows — against real MongoDB.
// ---------------------------------------------------------------------------

dbSuite('AI-43 a catalogue row carries its description and the boundary', dbOk, () => {
  let A;
  let productId;
  const longDescription =
    'Brand: ZZ Oil. API SN 10W-40 for petrol cars and motorcycles; 1 L. ' + 'x'.repeat(300);

  before(async () => {
    A = await registerOwner(api, tracker);

    const category = await api('POST', '/api/categories', {
      token: A.token,
      body: { name: uniqueName('Automotive') },
    });
    assert.equal(category.status, 201, JSON.stringify(category.json));

    const product = await api('POST', '/api/products', {
      token: A.token,
      body: {
        name: uniqueName('ZZ Engine Oil'),
        categoryId: category.json.id,
        description: longDescription,
        sellingPrice: 12.5,
        minimumStock: 2,
        unit: 'L',
      },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ search returns the recorded description, shortened, with the boundary beside it', async () => {
    const result = await ok('searchProducts', { q: 'ZZ Engine' }, ctxOf(A));

    assert.equal(result.count, 1);
    const row = result.items[0];
    assert.equal(row.id, productId);
    assert.match(row.description, /^Brand: ZZ Oil/);
    assert.equal(row.description.length, 160, 'a list description must be bounded');
    assert.match(row.description, /…$/, 'the truncation must be visible');

    assert.match(result.note, /no separate brand, model, specification, rating or review field/i);
    assert.match(result.note, /never infer a brand or quality from a product name/i);
    assert.match(result.note, /Recommend only products returned here/i);
  });

  it('★ getProduct keeps the whole description and the same boundary', async () => {
    const result = await ok('getProduct', { id: productId }, ctxOf(A));

    assert.equal(result.found, true);
    assert.equal(result.product.description, longDescription);
    assert.match(result.note, /no separate brand, model, specification, rating or review field/i);
  });

  it('★ a zero-match page still carries the boundary', async () => {
    const result = await ok('searchProducts', { q: 'No Such Engine Oil' }, ctxOf(A));

    assert.equal(result.count, 0);
    assert.equal(result.items.length, 0);
    assert.match(result.note, /no separate brand/i);
  });
});
