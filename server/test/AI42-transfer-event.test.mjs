// AI-42 — a transfer is ONE event to the assistant, although its ledger keeps two rows.
//
// WHY THIS EXISTS. The assistant's `getInventoryHistory` tool returns ledger rows, and a
// stock transfer deliberately writes two of them sharing one `reference` (one source leg,
// one destination leg). The History screen and the dashboard both have their own,
// documented behaviour: History keeps both rows, Recent Activity merges them. The model
// receives the history page, so an ungrouped page lets an answer count a single transfer
// twice — and on a phone it also put the source on the wrong side, because a leg carries
// only its own location.
//
// The assistant's page therefore folds a COMPLETE pair into one event with `from`, `to`
// and the shared reference, and reports a logical count. A single leg — a location-filtered
// page, or a pair split by the page boundary — stays a leg, with its own direction.
//
// The ledger and the Inventory History screen are deliberately untouched: phase19 pins
// that History still shows both rows.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool } from '../src/services/ai/tools.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

dbSuite('AI-42 a transfer is one event to the assistant', dbOk, () => {
  let A;
  let productId;
  let fromLocationId;
  let toLocationId;
  let reference;

  before(async () => {
    A = await registerOwner(api, tracker);
    const from = await api('POST', '/api/locations', {
      token: A.token,
      body: { name: uniqueName('A42From') },
    });
    assert.equal(from.status, 201, JSON.stringify(from.json));
    fromLocationId = from.json.id;
    const to = await api('POST', '/api/locations', {
      token: A.token,
      body: { name: uniqueName('A42To') },
    });
    assert.equal(to.status, 201, JSON.stringify(to.json));
    toLocationId = to.json.id;

    const product = await api('POST', '/api/products', {
      token: A.token,
      body: { name: uniqueName('A42Prod') },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const stocked = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId, locationId: fromLocationId, quantity: 10 },
    });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.json));

    const moved = await api('POST', '/api/inventory/transfer', {
      token: A.token,
      body: { productId, fromLocationId, toLocationId, quantity: 4 },
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.json));
    reference = moved.json.reference;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ folds both legs into one event with the source and destination', async () => {
    const result = await ok('getInventoryHistory', { productId, limit: 50 }, ctxOf(A));
    const transfers = result.items.filter((item) => item.type === 'TRANSFER');

    assert.equal(transfers.length, 1, 'the two ledger legs must reach the model as one event');
    const event = transfers[0];
    assert.equal(event.reference, reference);
    assert.equal(event.quantity, 4);
    assert.equal(event.from.id, fromLocationId, 'the source is the leg that lost stock');
    assert.equal(event.to.id, toLocationId, 'the destination is the leg that gained stock');
    assert.equal(event.location, undefined, 'a two-location event has no single location');

    // One stock-in + one transfer = two logical events, not three ledger rows.
    assert.equal(result.count, 2);
    assert.equal(result.returned, 2);
    assert.equal(result.hasMore, false);
  });

  it('★ a location-filtered page keeps the single leg and names its direction', async () => {
    const source = await ok('getInventoryHistory', { productId, locationId: fromLocationId }, ctxOf(A));
    const out = source.items.filter((item) => item.type === 'TRANSFER');
    assert.equal(out.length, 1);
    assert.equal(out[0].direction, 'out', 'the source leg lost stock');
    assert.equal(out[0].location.id, fromLocationId);
    assert.equal(source.count, 2, 'the stock-in and the transfer are still two events');

    const destination = await ok('getInventoryHistory', { productId, locationId: toLocationId }, ctxOf(A));
    const into = destination.items.filter((item) => item.type === 'TRANSFER');
    assert.equal(into.length, 1);
    assert.equal(into[0].direction, 'in', 'the destination leg gained stock');
    assert.equal(into[0].location.id, toLocationId);
    assert.equal(destination.count, 1);
  });

  it('a stock-in page is unchanged', async () => {
    const result = await ok('getInventoryHistory', { productId, type: 'STOCK_IN' }, ctxOf(A));

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'STOCK_IN');
    assert.equal(result.count, 1);
    assert.equal(result.hasMore, false);
    assert.equal('note' in result, false);
  });
});
