// AI-71 — "which products have never sold?" must have data behind it.
//
// WHY THIS EXISTS. On the mirrored test phone (2026-11-05, 6:45 PM) the member asked
// *"Which products have never sold"* and the assistant answered honestly but uselessly: the
// movement history lists only products that moved, so the dead stock — the products the
// business is paying to hold and has never shifted — was exactly the part of the catalogue
// the history could not name. The model then offered to "run a broader search" it had no
// tool for, and the turn ended in a dead end.
//
// WHAT THIS SUITE PINS:
//   * a product with no stock-out on record is listed, and one that has moved is not;
//   * `soldProductCount` is the whole-ledger count, not the page;
//   * availability is still reported per row (dead stock is a shelf question);
//   * the note says a stock-out is not proof of a sale (usage, damage, write-off), so the
//     model may not upgrade "nothing left the shelf" into "customers never bought it";
//   * the page contract (`count`/`returned`/`hasMore`) holds like every other list tool.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool } from '../src/services/ai/tools.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({
  businessId: session.businessId,
  userId: session.userId,
  role: ROLES.OWNER,
  timeZone: 'Asia/Manila',
});

dbSuite('AI-71 — dead stock is read from the whole ledger', dbOk, () => {
  let A;
  let moved;
  let idle;
  let backShelf;
  let soldShelf;

  before(async () => {
    A = await registerOwner(api, tracker);
    const loc = await api('POST', '/api/locations', { token: A.token, body: { name: 'Shelf' } });
    assert.equal(loc.status, 201, JSON.stringify(loc.json));
    const back = await api('POST', '/api/locations', { token: A.token, body: { name: 'Back Shelf' } });
    assert.equal(back.status, 201, JSON.stringify(back.json));
    backShelf = back.json;
    // A shelf where the ONLY product has already moved: the empty-page case.
    const soldOnly = await api('POST', '/api/locations', { token: A.token, body: { name: 'Sold Shelf' } });
    assert.equal(soldOnly.status, 201, JSON.stringify(soldOnly.json));
    soldShelf = soldOnly.json;

    const create = async (name) => {
      const res = await api('POST', '/api/products', { token: A.token, body: { name: uniqueName(name) } });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const stocked = await api('POST', '/api/inventory/stock-in', {
        token: A.token,
        body: { productId: res.json.id, locationId: loc.json.id, quantity: 5 },
      });
      assert.equal(stocked.status, 201, JSON.stringify(stocked.json));
      return res.json;
    };

    moved = await create('MovedWidget');
    idle = await create('IdleWidget');

    // The idle product also sits at a second location, so "business-wide" and "on this one
    // shelf" have different right answers — the distinction AI-61 found the hard way.
    const restock = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId: idle.id, locationId: backShelf.id, quantity: 3 },
    });
    assert.equal(restock.status, 201, JSON.stringify(restock.json));

    // One product has left the shelf; the other has only ever been received.
    const out = await api('POST', '/api/inventory/stock-out', {
      token: A.token,
      body: { productId: moved.id, locationId: loc.json.id, quantity: 2 },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));

    const shelfStock = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId: moved.id, locationId: soldShelf.id, quantity: 4 },
    });
    assert.equal(shelfStock.status, 201, JSON.stringify(shelfStock.json));

    const soldHere = await api('POST', '/api/inventory/stock-out', {
      token: A.token,
      body: { productId: moved.id, locationId: soldShelf.id, quantity: 1 },
    });
    assert.equal(soldHere.status, 200, JSON.stringify(soldHere.json));
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ lists what never left the shelf and omits what did', async () => {
    const res = await executeTool('getProductsNeverSold', { limit: 25 }, ctxOf(A));
    assert.equal(res.ok, true, JSON.stringify(res));
    const names = res.result.items.map((row) => row.name);

    assert.ok(names.includes(idle.name), `never-moved product missing: ${JSON.stringify(names)}`);
    assert.ok(!names.includes(moved.name), 'a product with a stock-out was reported as never sold');

    // The page is a page: the count is the whole matched set, and it agrees with the rows.
    assert.equal(res.result.returned, res.result.items.length);
    assert.equal(res.result.hasMore, res.result.count > res.result.items.length);

    // AI-68's totals are the exclusion set, so both tools cannot disagree.
    assert.equal(res.result.soldProductCount, 1);
  });

  it('★ dead stock still reports its availability, and says what a stock-out is not', async () => {
    const res = await executeTool('getProductsNeverSold', { limit: 25 }, ctxOf(A));
    const row = res.result.items.find((item) => item.name === idle.name);
    assert.equal(row.availableQuantity, 8, 'business-wide availability is both shelves');
    assert.match(res.result.note, /stock-out/);
    assert.match(res.result.note, /usage, damage or a write-off rather than a sale/);
  });

  it('★ one shelf is answered from that shelf, and an unknown place is refused', async () => {
    const scoped = await executeTool('getProductsNeverSold', { location: 'Back Shelf', limit: 25 }, ctxOf(A));
    assert.equal(scoped.ok, true, JSON.stringify(scoped));
    const row = scoped.result.items.find((item) => item.name === idle.name);
    assert.ok(row, 'a product stocked on that shelf must still be listed');
    assert.equal(row.availableQuantity, 3, 'availability must be the scoped location, not the business');
    assert.equal(scoped.result.locationId, backShelf.id);
    assert.match(scoped.result.note, /at Back Shelf/);

    // A wrong place name is a soft not-found the model can explain, never a silent
    // business-wide list that looks like a scoped one (AI-15's rule).
    const refused = await executeTool('getProductsNeverSold', { location: 'Nowhere At All' }, ctxOf(A));
    assert.equal(refused.ok, true);
    assert.equal(refused.result.found, false, 'an unknown place must not answer the whole catalogue');
  });

  it('★ an empty page explains itself instead of reading as "no stock-outs at all"', async () => {
    // The only product on this shelf has moved, so the scope has no dead stock at all.
    const res = await executeTool('getProductsNeverSold', { location: 'Sold Shelf', limit: 25 }, ctxOf(A));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.count, 0);
    assert.equal(res.result.emptyReason, 'everyProductHasMoved');
    assert.match(res.result.note, /NO dead stock/);
    assert.match(res.result.note, /does not mean data is missing/);
  });

  it('★ a date narrows what counts as movement', async () => {
    // Nothing has moved in the last hour except the one stock-out, so with `from` in the
    // future nothing counts as sold and both products are dead stock.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await executeTool('getProductsNeverSold', { from: future, limit: 25 }, ctxOf(A));
    assert.equal(res.ok, true, JSON.stringify(res));
    const names = res.result.items.map((row) => row.name);
    assert.ok(names.includes(moved.name), 'with `from` after every movement both products are dead');
    assert.equal(res.result.soldProductCount, 0);
    assert.equal(res.result.countedFrom, future);
  });
});
