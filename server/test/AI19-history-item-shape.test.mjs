// AI-19 — the history page the model reads carries no tenant or user identifiers.
//
// WHY THIS EXISTS. `getInventoryHistory` returned `transactionPublic` verbatim, so every
// history answer put `businessId` and `userId` into the prompt — the identifiers the
// reference rows deliberately omit — and spent its output budget having the model retype
// fields nobody asked about. Measured on the device 2026-10-19: *"What moved recently in
// Main Warehouse?"* came back `degraded` with the table cut off at the 800-token cap.
//
// WHAT THIS SUITE PINS, in the two directions that matter:
//   * the identifiers are GONE from what the model receives — asserted on the serialized
//     result, because that string is the prompt;
//   * nothing an answer needs is gone with them — the movement, its before/after
//     quantities, its reason, and the product and location NAMES (which the `$lookup`
//     already pays for) must all still be there, or the narrowing has traded one defect
//     for a worse one.

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

dbSuite('AI-19 a history row is the movement, not the ledger record', dbOk, () => {
  let A;
  let location;
  let productName;
  let productId;

  before(async () => {
    A = await registerOwner(api, tracker);
    const created = await api('POST', '/api/locations', { token: A.token, body: { name: uniqueName('HQLoc') } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    location = created.json;

    productName = uniqueName('HQProd');
    const product = await api('POST', '/api/products', { token: A.token, body: { currency: 'PHP', name: productName } });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const stocked = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId, locationId: location.id, quantity: 12 },
    });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.json));
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ the prompt the model receives contains no businessId and no userId', async () => {
    const result = await ok('getInventoryHistory', { location: location.name }, ctxOf(A));
    const payload = JSON.stringify(result);

    assert.ok(result.count >= 1, 'the stock-in above should be in this page');
    assert.ok(!payload.includes('businessId'), 'a tenant identifier reached the prompt');
    assert.ok(!payload.includes('userId'), 'an internal user id reached the prompt');
    assert.ok(!payload.includes(String(A.userId)), 'the caller’s user id is in the payload');
  });

  it('★ the movement an answer needs is all still there', async () => {
    const result = await ok('getInventoryHistory', { location: location.name }, ctxOf(A));
    const row = result.items.find((item) => item.product?.id === productId);
    assert.ok(row, 'the movement just created is missing from the history page');

    assert.equal(row.type, 'STOCK_IN');
    assert.equal(row.quantity, 12);
    assert.equal(row.previousQuantity, 0);
    assert.equal(row.newQuantity, 12);
    assert.equal(row.location.name, location.name, 'the location name the $lookup paid for is gone');
    assert.equal(row.product.name, productName, 'the product name the $lookup paid for is gone');
    assert.ok(row.createdAt, 'a movement with no time cannot be reported as recent');
    // The ids the model may need to chain another call are kept; the ledger's foreign keys
    // are not, because `product.id`/`location.id` already answer "which record was this".
    assert.equal(row.product.id, productId);
    assert.equal(row.location.id, location.id);
    assert.equal('productId' in row, false, 'the raw foreign key is redundant beside product.id');
  });

  it('★ the page marker still holds on the narrowed rows', async () => {
    const paged = await ok('getInventoryHistory', { location: location.name, limit: 1 }, ctxOf(A));
    assert.equal(paged.returned, paged.items.length);
    assert.equal(paged.hasMore, paged.count > paged.items.length);
  });
});
