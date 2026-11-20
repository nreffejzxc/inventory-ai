// AI-23 — the compare-two-locations question, answered by ONE lookup.
//
// THE GAP THIS CLOSES, measured on the device 2026-10-19. After AI-22 taught the model to
// batch its lookups, the owner's own question — *"Compare my two locations, how many
// products are in each?"* — still cost **3 provider calls / 29.3 s** (`calls=3 toolRuns=3
// tools=listLocations,getProductsByLocation`, `in=14037`). The reason is not batching: the
// member said "my two locations" and never named them, so the model had to spend a call
// learning the names (`listLocations`) before it could ask about one location at a time.
// No batching rule can fix that, because the second lookup cannot be phrased until the
// first one answers. The fix is a CAPABILITY: one read that reports, for every location at
// once, how many products it holds and how much stock is on its shelves.
//
// WHAT THIS SUITE PINS, and why each case is here:
//   * the numbers are exact, per location, and a product held in two places counts once in
//     each but ONCE in the business total (double counting across locations is the obvious
//     way to get this wrong);
//   * an EMPTY location is still reported, with zeros — "which location is empty" is a
//     question this tool exists to answer, and an absent row reads as an error;
//   * an ARCHIVED location still reports the stock it holds (archiving retains inventory;
//     hiding it would understate the business's stock);
//   * another tenant's locations and stock never appear;
//   * the tool takes NO arguments, so there is nothing for a model to smuggle a
//     `businessId` into — the strictest possible schema.
//
// DB-free cases first (schema and permission), then the behaviour against real MongoDB.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { PERMISSIONS, ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

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

const TOOL = 'getLocationBreakdown';

// ---------------------------------------------------------------------------
// The schema: no arguments at all, and a read permission.
// ---------------------------------------------------------------------------

unitSuite('AI-23 the breakdown is a read with nothing to smuggle into it', () => {
  it('★ exists, takes no arguments, and refuses one', () => {
    const tool = aiToolsById.get(TOOL);
    assert.ok(tool, 'the tool is missing from the table');
    assert.deepEqual(tool.parameters.properties ?? {}, {});
    assert.equal(tool.parameters.additionalProperties, false);
    // A model that tries to widen the scope is refused, exactly like every other tool.
    assert.ok(validateToolArgs(tool, { businessId: 'another-tenant' }).problems.length > 0);
    assert.ok(validateToolArgs(tool, { location: 'x' }).problems.length > 0);
    assert.equal(validateToolArgs(tool, {}).problems.length, 0);
  });

  it('★ is gated on a read permission, never a write one', () => {
    const tool = aiToolsById.get(TOOL);
    assert.equal(tool.permission, PERMISSIONS.DASHBOARD_VIEW);
  });

  it('★ the prompt points at the tool for the question shape it exists for', () => {
    // Measured, not assumed: with the tool in the table and a description saying it answers
    // every location at once, a live turn still called `listLocations` first (2026-10-19). The
    // description alone was not enough, so the prompt names the tool for this one question
    // shape — and this assertion is what keeps that instruction from being edited away while
    // the capability quietly goes unused again.
    const prompt = systemPrompt();
    assert.match(prompt, /getLocationBreakdown/);
    assert.match(prompt, /compares locations|each of my locations/i);
    assert.match(prompt, /ONCE/);
  });

  it('the description names the question it answers, so the model can choose it', () => {
    // The model reads the description, not this suite. A capability described vaguely is a
    // capability the model will not reach for at the moment it matters.
    const { description } = aiToolsById.get(TOOL);
    assert.match(description, /each location|per location/i);
    assert.match(description, /compare/i);
    assert.match(description, /products?/i);
  });
});

// ---------------------------------------------------------------------------
// The behaviour, against real MongoDB.
// ---------------------------------------------------------------------------

dbSuite('AI-23 per-location counts are exact, complete and tenant-scoped', dbOk, () => {
  let A;
  let B;
  let main;
  let second;
  let empty;
  let archived;
  let shared;

  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);

    main = await newLocation(A);
    second = await newLocation(A);
    empty = await newLocation(A);
    archived = await newLocation(A);

    // main: product X 5 units + product Y 3 units = 8 units, 2 products
    const x = await newProduct(A);
    const y = await newProduct(A);
    await stockIn(A, x, main.id, 5);
    await stockIn(A, y, main.id, 3);

    // second: X again (7 units) — the SAME product as main, so the business total must be
    // 2 products, not 3.
    await stockIn(A, x, second.id, 7);

    // archived: Z 4 units — archiving a location retains its inventory.
    const z = await newProduct(A);
    await stockIn(A, z, archived.id, 4);
    // Archiving is `POST /:id/archive` (a location is archived, never deleted).
    const archivedRes = await api('POST', `/api/locations/${archived.id}/archive`, { token: A.token });
    assert.equal(archivedRes.status, 200, JSON.stringify(archivedRes.json));

    // Tenant B's own shelf must never appear in A's breakdown.
    shared = await newLocation(B);
    const bProduct = await newProduct(B);
    await stockIn(B, bProduct, shared.id, 99);
  });

  it('★ reports every location with its own product count and on-hand units', async () => {
    const result = await ok(TOOL, {}, ctxOf(A));
    const byName = new Map(result.locations.map((row) => [row.name, row]));

    const mainRow = byName.get(main.name);
    assert.equal(mainRow.products, 2);
    assert.equal(mainRow.units, 8);
    assert.equal(mainRow.status, 'ACTIVE');

    const secondRow = byName.get(second.name);
    assert.equal(secondRow.products, 1);
    assert.equal(secondRow.units, 7);

    // The empty location is PRESENT with zeros: an absent row would read as an error.
    const emptyRow = byName.get(empty.name);
    assert.ok(emptyRow, 'an empty location is missing from the breakdown');
    assert.equal(emptyRow.products, 0);
    assert.equal(emptyRow.units, 0);

    // The archived location still carries the stock it holds, and says it is archived.
    const archivedRow = byName.get(archived.name);
    assert.equal(archivedRow.status, 'ARCHIVED');
    assert.equal(archivedRow.products, 1);
    assert.equal(archivedRow.units, 4);
  });

  it('★ the business total counts a product once, however many locations hold it', async () => {
    const result = await ok(TOOL, {}, ctxOf(A));
    // X, Y and Z — three products; X appears at two locations but is one product.
    assert.equal(result.totals.products, 3);
    assert.equal(result.totals.units, 19); // 8 + 7 + 4
    // And the sum of the per-location product counts is deliberately LARGER than the total,
    // because a product held in two places is two rows on two shelves.
    const sumOfRows = result.locations.reduce((n, row) => n + row.products, 0);
    assert.equal(sumOfRows, 4);
    assert.ok(sumOfRows > result.totals.products);
  });

  it('★ another tenant never appears', async () => {
    const result = await ok(TOOL, {}, ctxOf(A));
    assert.equal(result.locations.some((row) => row.name === shared.name), false);
    assert.equal(result.totals.units, 19);
  });

  it('orders by stock on hand, biggest first', async () => {
    const result = await ok(TOOL, {}, ctxOf(A));
    const units = result.locations.map((row) => row.units);
    assert.deepEqual(units, [...units].sort((a, b) => b - a));
  });

  it('a business with no stock yet still gets its locations, with zeros', async () => {
    const C = await registerOwner(api, tracker);
    const only = await newLocation(C);
    const result = await ok(TOOL, {}, ctxOf(C));
    assert.deepEqual(
      result.locations.map((row) => ({ name: row.name, products: row.products, units: row.units })),
      [{ name: only.name, products: 0, units: 0 }],
    );
    assert.equal(result.totals.products, 0);
    assert.equal(result.totals.units, 0);
  });

  it('every role that can see the dashboard can read it, and nobody else is invented', async () => {
    // The tool is gated on DASHBOARD_VIEW, which all four roles hold — this asserts the gate
    // exists and answers, rather than pinning a matrix already covered by Phase 24.
    for (const role of [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER]) {
      const res = await executeTool(TOOL, {}, { ...ctxOf(A), role });
      assert.equal(res.ok, true, `${role} was refused: ${JSON.stringify(res)}`);
    }
  });
});
