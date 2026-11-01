// AI-42 — a transfer is ONE event to the assistant, although its ledger keeps two rows.
//
// WHY THIS EXISTS. The assistant's `getInventoryHistory` tool returns ledger rows, and a
// stock transfer deliberately writes two of them sharing one `reference` (one source leg,
// one destination leg). The History screen and the dashboard both have their own,
// documented behaviour: History keeps both rows, Recent Activity merges them. The model
// receives the history page, so it has to be told which rows are one event or an answer
// counts a single transfer as two movements — observed in a production answer.
//
// The note is attached to the page only when a paired transfer is actually present. That
// keeps a page of stock-ins free of an instruction about transfers, and it puts the rule
// beside the rows it describes rather than in a prompt the model may not connect to them.

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
  let reference;

  before(async () => {
    A = await registerOwner(api, tracker);
    const from = await api('POST', '/api/locations', {
      token: A.token,
      body: { name: uniqueName('A42From') },
    });
    assert.equal(from.status, 201, JSON.stringify(from.json));
    const to = await api('POST', '/api/locations', {
      token: A.token,
      body: { name: uniqueName('A42To') },
    });
    assert.equal(to.status, 201, JSON.stringify(to.json));

    const product = await api('POST', '/api/products', {
      token: A.token,
      body: { name: uniqueName('A42Prod') },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const stocked = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId, locationId: from.json.id, quantity: 10 },
    });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.json));

    const moved = await api('POST', '/api/inventory/transfer', {
      token: A.token,
      body: { productId, fromLocationId: from.json.id, toLocationId: to.json.id, quantity: 4 },
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.json));
    reference = moved.json.reference;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ a page holding both legs says they are one transfer', async () => {
    const result = await ok('getInventoryHistory', { productId, limit: 50 }, ctxOf(A));
    const legs = result.items.filter((item) => item.type === 'TRANSFER');

    assert.equal(legs.length, 2, 'the ledger keeps two rows');
    assert.equal(legs[0].reference, reference);
    assert.equal(legs[1].reference, reference);
    assert.match(result.note, /one (stock )?transfer|one event/i);
  });

  it('a page with no paired transfer carries no transfer note', async () => {
    const result = await ok('getInventoryHistory', { productId, type: 'STOCK_IN' }, ctxOf(A));

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'STOCK_IN');
    assert.equal('note' in result, false, 'a stock-in page must not pay for a transfer instruction');
  });
});
