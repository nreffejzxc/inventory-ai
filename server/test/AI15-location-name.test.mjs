// AI-15 — the location a member named, without a round-trip to translate it.
//
// WHY THIS EXISTS. `getInventory` and `getProductsByLocation` took only a `locationId`, so a
// question about "Main Warehouse" cost the model a whole provider call to `listLocations`
// first. On the measured free-tier turns that call existed only to translate a name into an
// id: about 5 s and a full re-send of the prompt and tool catalogue. Both tools now accept
// an exact `location` name as well.
//
// WHAT THIS SUITE GUARDS, and why each case is here rather than assumed:
//   * the name and the id must return the SAME rows — a shortcut that quietly changed the
//     answer would be worse than the extra call;
//   * only an EXACT, ACTIVE name resolves, because an unanchored or case-forgiving match
//     would attach a member's question to the wrong shelf;
//   * a duplicated name returns BOTH candidates instead of picking one;
//   * another tenant's location never resolves, even with an identical name;
//   * asking by both forms at once is refused, since two answers are not one.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

/** Run a tool and return its result; a thrown or refused call is a failure here. */
async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

async function newLocation(business, over = {}) {
  const res = await api('POST', '/api/locations', { token: business.token, body: { name: uniqueName('Loc'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P'), ...over } });
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

const ids = (result) => result.items.map((row) => row.id).sort();

// ---------------------------------------------------------------------------
// The schemas — a name is accepted, bounded, and cannot smuggle anything else.
// ---------------------------------------------------------------------------

unitSuite('AI-15 the location-name argument is declared and bounded', () => {
  it('★ every location-filtering tool accepts a name, and none still demands an id', () => {
    for (const name of ['getInventory', 'getProductsByLocation', 'getInventoryHistory']) {
      const tool = aiToolsById.get(name);
      const props = tool.parameters.properties;
      assert.ok(props.location, `${name} does not accept a location name`);
      assert.equal(props.location.type, 'string');
      assert.equal(props.location.maxLength, 100);
      assert.ok(
        !(tool.parameters.required ?? []).includes('locationId'),
        `${name} still requires locationId, so a name alone would be refused`,
      );
      assert.equal(tool.parameters.additionalProperties, false);
    }
  });

  it('★ a name is bounded and cannot be widened into an operator or a tenant', () => {
    for (const name of ['getInventory', 'getProductsByLocation', 'getInventoryHistory']) {
      const tool = aiToolsById.get(name);
      assert.equal(validateToolArgs(tool, { location: 'x'.repeat(100) }).problems.length, 0);
      assert.ok(validateToolArgs(tool, { location: 'x'.repeat(101) }).problems.length > 0);
      assert.ok(validateToolArgs(tool, { businessId: 'other' }).problems.length > 0);
      // A Mongo operator is an UNKNOWN argument, never a filter — the schema has no
      // `location` object form for it to reach.
      assert.ok(validateToolArgs(tool, { location: { $ne: null } }).problems.length > 0);
    }
  });

  it('the descriptions tell the model when a name is the cheaper way', () => {
    // The model reads the description, not this suite: a parameter it is never told about
    // is a parameter that will not be used.
    for (const name of ['getInventory', 'getProductsByLocation', 'getInventoryHistory']) {
      assert.match(aiToolsById.get(name).description, /exact/i, `${name}'s description never says the name must be exact`);
      assert.match(aiToolsById.get(name).description, /location/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The behaviour, against real MongoDB.
// ---------------------------------------------------------------------------

dbSuite('AI-15 a location name returns exactly what its id returns', dbOk, () => {
  let A;
  let B;
  let main;
  let second;
  let archived;
  let sharedNameB;
  let productAtMain;
  let productAtSecond;

  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);

    main = await newLocation(A, { name: 'Main Warehouse' });
    second = await newLocation(A, { name: 'Shop Front' });
    archived = await newLocation(A, { name: 'Old Depot' });
    const arch = await api('POST', `/api/locations/${archived.id}/archive`, { token: A.token });
    assert.equal(arch.status, 200, JSON.stringify(arch.json));

    // A record whose DESCRIPTION contains another location's name: an unanchored search
    // would resolve the wrong row, which is the defect the anchored query exists to prevent.
    await newLocation(A, { name: 'Annex', description: 'Overflow for Main Warehouse stock' });

    productAtMain = await newProduct(A, { name: 'Main Widget' });
    productAtSecond = await newProduct(A, { name: 'Shop Widget' });
    await stockIn(A, productAtMain, main.id, 11);
    await stockIn(A, productAtSecond, second.id, 4);

    // Two ACTIVE locations with one name: legal in the model, so the tool must not choose.
    await newLocation(A, { name: 'Twin Shelf' });
    await newLocation(A, { name: 'Twin Shelf' });

    // Another tenant with the same names — the isolation half.
    sharedNameB = await newLocation(B, { name: 'Main Warehouse' });
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ by name and by id return the same rows — the shortcut cannot change the answer', async () => {
    const byId = await ok('getProductsByLocation', { locationId: main.id }, ctxOf(A));
    const byName = await ok('getProductsByLocation', { location: 'Main Warehouse' }, ctxOf(A));

    assert.deepEqual(ids(byName), ids(byId), 'the name path returned a different page');
    assert.equal(byName.count, byId.count);
    assert.equal(byName.locationId, main.id, 'the resolved id is reported, so the answer is checkable');
    const row = byName.items.find((p) => p.id === productAtMain);
    assert.ok(row, 'the product stocked at the resolved location is missing');
    assert.equal(row.availableQuantity, 11);
  });

  it('★ case and surrounding whitespace are forgiven, because they are not a different place', async () => {
    const byName = await ok('getProductsByLocation', { location: '  main WAREHOUSE  ' }, ctxOf(A));
    assert.equal(byName.locationId, main.id);
    assert.deepEqual(ids(byName), ids(await ok('getProductsByLocation', { locationId: main.id }, ctxOf(A))));
  });

  it('★ getInventory narrows by the same name', async () => {
    const byName = await ok('getInventory', { location: 'Shop Front' }, ctxOf(A));
    const byId = await ok('getInventory', { locationId: second.id }, ctxOf(A));
    assert.deepEqual(ids(byName), ids(byId));
    assert.equal(byName.count, byId.count);
    assert.ok(byName.items.every((row) => row.location.name === 'Shop Front'));
  });

  it('★ a PREFIX does not resolve — the name must be exact, not merely a start of one', async () => {
    // The unanchored version of this query is the realistic defect (and the first mutation
    // tried here): `Main` would resolve to `Main Warehouse` and `Sh` to `Shop Front`, so a
    // member asking about a place that does not exist would be answered about another one.
    for (const fragment of ['Main', 'Sh', 'Twin']) {
      const res = await ok('getProductsByLocation', { location: fragment }, ctxOf(A));
      assert.equal(res.found, false, `"${fragment}" resolved as if it were a location name`);
    }
  });

  it('★ a name that matches only a DESCRIPTION does not resolve', async () => {
    // "Annex" exists; "Main Warehouse" appears in its description. Anchoring is what keeps
    // the member's question about the warehouse off the annex's shelf.
    const annex = await ok('getProductsByLocation', { location: 'Overflow for Main Warehouse stock' }, ctxOf(A));
    assert.equal(annex.found, false, 'a description fragment resolved as if it were a location');

    const real = await ok('getProductsByLocation', { location: 'Main Warehouse' }, ctxOf(A));
    assert.equal(real.locationId, main.id);
  });

  it('★ getInventoryHistory narrows by the same name, and keeps "all locations" as its default', async () => {
    const byName = await ok('getInventoryHistory', { location: 'Main Warehouse' }, ctxOf(A));
    const byId = await ok('getInventoryHistory', { locationId: main.id }, ctxOf(A));
    assert.deepEqual(byName.items.map((row) => row.id).sort(), byId.items.map((row) => row.id).sort());
    assert.equal(byName.count, byId.count);
    assert.ok(byName.count >= 1, 'the stock-in at Main Warehouse should be in its own history');

    const all = await ok('getInventoryHistory', {}, ctxOf(A));
    assert.ok(all.count > byName.count, 'history with no location must still cover every location');
  });

  it('★ an unknown name is a soft answer that points at listLocations, not a crash', async () => {
    const res = await ok('getProductsByLocation', { location: 'Nowhere At All' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.message, /No active location is named/i);
    assert.match(res.message, /listLocations/, 'the model is told how to recover');
    assert.equal(res.count, undefined, 'a refusal must not look like an empty result set');
  });

  it('★ an archived location never resolves by name, even though it still exists', async () => {
    const res = await ok('getProductsByLocation', { location: 'Old Depot' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.message, /No active location/i);
  });

  it('★ a duplicated name returns both candidates instead of picking one', async () => {
    const res = await ok('getProductsByLocation', { location: 'Twin Shelf' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.equal(res.ambiguous, true);
    assert.equal(res.matches.length, 2);
    assert.ok(res.matches.every((row) => row.name === 'Twin Shelf'));
    assert.equal(new Set(res.matches.map((row) => row.id)).size, 2, 'both ids must be offered');
  });

  it('★ another tenant\'s location never resolves, even with an identical name', async () => {
    // B has a "Main Warehouse" too. Resolving A's must return A's id and never B's — and a
    // name only B has must not resolve at all inside A.
    const res = await ok('getProductsByLocation', { location: 'Main Warehouse' }, ctxOf(A));
    assert.equal(res.locationId, main.id);
    assert.notEqual(res.locationId, sharedNameB.id);

    const onlyB = await newLocation(B, { name: 'Private Vault' });
    const missing = await ok('getProductsByLocation', { location: 'Private Vault' }, ctxOf(A));
    assert.equal(missing.found, false, `A resolved B's location ${onlyB.id}`);

    const inB = await ok('getProductsByLocation', { location: 'Private Vault' }, ctxOf(B));
    assert.equal(inB.locationId, onlyB.id, 'the name must resolve for its own tenant');
  });

  it('★ asking by both forms at once is refused — two answers are not one', async () => {
    const res = await ok('getProductsByLocation', { locationId: main.id, location: 'Shop Front' }, ctxOf(A));
    assert.equal(res.found, false);
    assert.match(res.error, /either locationId or location/i);
  });

  it('★ getProductsByLocation refuses no location; getInventory keeps "all locations" as its default', async () => {
    // Two different tools, two different contracts, and the first draft of this change broke
    // the second one: a resolver that refuses "no location" for both would have silently
    // stopped `getInventory({ lowStock: true })` from listing anything at all. The dangerous
    // failure on the other side is an undefined id reaching productService.list and answering
    // the whole catalogue while looking like a filtered page — which is why the required
    // tool refuses rather than quietly unfiltering.
    const refused = await ok('getProductsByLocation', {}, ctxOf(A));
    assert.equal(refused.found, false);
    assert.match(refused.error, /locationId or a location name/i);

    const all = await ok('getInventory', {}, ctxOf(A));
    assert.ok(Array.isArray(all.items), 'an unfiltered inventory query must still work');
    assert.ok(all.count >= 1);
    assert.equal(all.found, undefined, 'the absence of a filter is not a refusal');
    // And the unfiltered answer really is wider than one location's, or the case proves nothing.
    const onePlace = await ok('getInventory', { location: 'Main Warehouse' }, ctxOf(A));
    assert.ok(all.count > onePlace.count, `unfiltered (${all.count}) was not wider than one location (${onePlace.count})`);
  });
});
