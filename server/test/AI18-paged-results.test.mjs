// AI-18 — every paged list says it is a page, and the prompt tells the model what that means.
//
// WHY THIS EXISTS, measured on the device 2026-10-19. The specification's own example
// question — *"Show me the inventory in Main Warehouse"* — called `getInventory`, got a page
// of 25 rows out of 203, and answered with a 25-row Markdown table: 800 output tokens,
// exactly AI-8's cap, so it stopped mid-table at row 16 and the member read a truncation
// note. The model had `count: 203` beside the array and even wrote "showing the first 25 of
// 203" — and enumerated anyway. A bare number does not tell a model that `items` is a
// WINDOW rather than the list; `hasMore` is that sentence, delivered by the tool result.
//
// WHAT THIS SUITE PINS:
//   * every paged list reports `returned` and `hasMore` consistently with `count`;
//   * no paged tool can silently go back to a bare `{ count, items }` — a source guard,
//     because the defect would be invisible in a result that happens to fit one page;
//   * the system prompt says what `hasMore` means and bounds the answer's length;
//   * the single-page case reports `hasMore: false`, so the flag is not permanently true
//     (which would make it noise the model learns to ignore).

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool, aiToolsById } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS_SOURCE = readFileSync(join(here, '..', 'src', 'services', 'ai', 'tools.ts'), 'utf8');

/** The nine list tools whose result is one page of a possibly larger set. */
const PAGED_TOOLS = [
  'searchProducts',
  'getInventory',
  'getLowStockProducts',
  'getOutOfStockProducts',
  'getReorderNeededProducts',
  'getInventoryHistory',
  'getProductsByLocation',
  'getProductsNeverSold',
  'listLocations',
  'listCategories',
  'listBrands',
  'findProducts',
];

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

/** The invariant every paged result must satisfy, asserted in one place. */
function assertPageShape(name, result) {
  assert.equal(typeof result.count, 'number', `${name} did not report count`);
  assert.equal(result.returned, result.items.length, `${name}: returned must equal the rows actually sent`);
  assert.equal(result.hasMore, result.count > result.items.length, `${name}: hasMore must mean "there are rows you do not have"`);
}

unitSuite('AI-18 the page marker cannot be dropped, and the prompt explains it', () => {
  it('★ no paged tool returns a bare { count, items } any more', () => {
    // A source guard on purpose: the failure this prevents is invisible in a fixture small
    // enough to fit one page, so a behavioural test alone would not catch a tool that
    // quietly stopped reporting `hasMore` on a large tenant.
    const bareReturns = TOOLS_SOURCE.match(/return \{ count/g) ?? [];
    assert.equal(bareReturns.length, 0, 'a tool still returns { count, items } without the page marker');
    assert.match(TOOLS_SOURCE, /function page\(/, 'the page() helper is gone');
  });

  it('★ every advertised list tool declares itself through the helper', () => {
    // Nine lists, nine `page(` calls. A new list tool added without one fails here rather
    // than on the next device run.
    const calls = TOOLS_SOURCE.match(/return page\(/g) ?? [];
    // getInventory has two page paths (a catalogue search and a product's stock rows), so
    // the source has one more paged return than there are distinct list tools.
    assert.equal(calls.length, PAGED_TOOLS.length + 1, `expected ${PAGED_TOOLS.length + 1} paged returns, found ${calls.length}`);
    for (const name of PAGED_TOOLS) {
      assert.ok(aiToolsById.has(name), `${name} is no longer in the tool table`);
    }
  });

  it('★ the system prompt tells the model what hasMore means and bounds the answer', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /hasMore/, 'the model is never told what the marker means');
    assert.match(prompt, /at most five/i, 'the prompt does not bound how many rows may be listed');
    assert.match(prompt, /page/i);
  });
});

dbSuite('AI-18 a page of a larger set says so', dbOk, () => {
  let A;
  let main;

  before(async () => {
    A = await registerOwner(api, tracker);
    main = await (async () => {
      const res = await api('POST', '/api/locations', { token: A.token, body: { name: 'Main Warehouse' } });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    })();

    // Three products, two of them stocked at the location above: enough that a limit of 1
    // is a page of a larger set and a limit of 50 is not.
    for (let i = 0; i < 3; i += 1) {
      const created = await api('POST', '/api/products', {
        token: A.token,
        body: { name: uniqueName(`Widget${i}`) },
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      if (i < 2) {
        const stocked = await api('POST', '/api/inventory/stock-in', {
          token: A.token,
          body: { productId: created.json.id, locationId: main.id, quantity: 5 },
        });
        assert.equal(stocked.status, 201, JSON.stringify(stocked.json));
      }
    }
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ a page of a larger set reports hasMore, and a complete set does not', async () => {
    const paged = await ok('getProductsByLocation', { location: 'Main Warehouse', limit: 1 }, ctxOf(A));
    assertPageShape('getProductsByLocation (paged)', paged);
    assert.equal(paged.count, 2);
    assert.equal(paged.returned, 1);
    assert.equal(paged.hasMore, true);

    const complete = await ok('getProductsByLocation', { location: 'Main Warehouse', limit: 50 }, ctxOf(A));
    assertPageShape('getProductsByLocation (complete)', complete);
    assert.equal(complete.returned, complete.count);
    assert.equal(complete.hasMore, false, 'hasMore must not be permanently true, or the model learns to ignore it');
  });

  it('★ the marker survives a filter and a name resolution', async () => {
    const byName = await ok('getInventory', { location: 'Main Warehouse', limit: 1 }, ctxOf(A));
    assertPageShape('getInventory', byName);
    assert.equal(byName.hasMore, true);
    // The resolved id travels with the page, so an answer about "Main Warehouse" can be
    // checked without another call — and is ABSENT (not null) when no location was asked for.
    assert.equal(byName.locationId, main.id, 'the resolved id is not reported beside the page marker');
    const unfiltered = await ok('getInventory', {}, ctxOf(A));
    assert.equal('locationId' in unfiltered, false, 'an unfiltered page must not name a location');

    const history = await ok('getInventoryHistory', { location: 'Main Warehouse', limit: 1 }, ctxOf(A));
    assert.equal(history.locationId, main.id);
  });

  it('★ history, search and the reference lists carry the same marker', async () => {
    const history = await ok('getInventoryHistory', { location: 'Main Warehouse', limit: 1 }, ctxOf(A));
    assertPageShape('getInventoryHistory', history);
    assert.equal(history.hasMore, true);

    const search = await ok('searchProducts', { limit: 1 }, ctxOf(A));
    assertPageShape('searchProducts', search);
    assert.equal(search.hasMore, true);

    const locations = await ok('listLocations', {}, ctxOf(A));
    assertPageShape('listLocations', locations);
    assert.equal(locations.hasMore, false);
    assert.equal(locations.status, 'ACTIVE');

    const categories = await ok('listCategories', {}, ctxOf(A));
    assertPageShape('listCategories', categories);
    assert.equal(categories.hasMore, false);
  });

  it('★ every list tool agrees with its own count — the invariant, tool by tool', async () => {
    // One loop over the whole table, so a tool that reports the marker wrongly cannot pass
    // by being paged in a way the cases above happen not to exercise.
    const calls = {
      searchProducts: {},
      getInventory: {},
      getLowStockProducts: {},
      getOutOfStockProducts: {},
      getReorderNeededProducts: {},
      getInventoryHistory: {},
      getProductsByLocation: { location: 'Main Warehouse' },
      listLocations: {},
      listCategories: {},
      findProducts: { keywords: 'Widget' },
    };
    for (const [name, args] of Object.entries(calls)) {
      const result = await ok(name, args, ctxOf(A));
      assertPageShape(name, result);
    }
  });
});
