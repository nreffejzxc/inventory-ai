// AI-14 — the reference data the assistant could not see, and the ids it could not resolve.
//
// WHY THIS EXISTS. Two capabilities shipped with a hole in front of them:
// `getProductsByLocation` requires a `locationId`, and `searchProducts` /
// `getReorderNeededProducts` accept a `categoryId` — but nothing in the tool table could
// turn "the Main Warehouse" or "Beverages" into either. The specification's own example
// question, *"Show me inventory in the warehouse"*, was answerable only when an unrelated
// inventory row happened to carry the id, and *"which locations do I have?"* was not
// answerable at all. `listLocations` and `listCategories` close that, and this suite pins
// the properties that make them useful rather than merely present: the ids they return are
// the ids the other tools accept, they never cross a tenant boundary, archived records are
// excluded unless asked for, and every role that may read the REST counterpart may read
// these.
//
// THE UNIT HALF runs without a database and pins the schemas, because the schema is what a
// model sees: an accepted `businessId` here would be a tenant injection, and a `status`
// value outside the enum would silently reach the service as an unrecognised filter.
// THE DB HALF proves the join the tools exist for — id out of one tool, usable in another.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES, PERMISSIONS, hasPermission } from '../src/constants/roles.ts';
import { AI_TOOL_DEFS, executeTool, validateToolArgs, aiToolsById } from '../src/services/ai/tools.ts';

const REFERENCE_TOOLS = ['listLocations', 'listCategories'];

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

/** The same session context `runAiChat` builds — server-derived, never client-supplied. */
const ctxOf = (session, role = ROLES.OWNER) => ({
  businessId: session.businessId,
  userId: session.userId,
  role,
});

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

async function newCategory(business, over = {}) {
  const res = await api('POST', '/api/categories', { token: business.token, body: { name: uniqueName('Cat'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

const names = (result) => result.items.map((row) => row.name);

// ---------------------------------------------------------------------------
// The schemas — what the MODEL is allowed to ask for.
// ---------------------------------------------------------------------------

unitSuite('AI-14 the reference tools are advertised, bounded, and closed to scope smuggling', () => {
  it('★ both tools are in the catalogue the model actually receives', () => {
    const advertised = AI_TOOL_DEFS.map((t) => t.name);
    for (const name of REFERENCE_TOOLS) {
      assert.ok(advertised.includes(name), `${name} is not advertised to the model`);
    }
  });

  it('★ every reference tool forbids unknown arguments, so a tenant cannot be smuggled', () => {
    for (const name of REFERENCE_TOOLS) {
      const tool = aiToolsById.get(name);
      assert.equal(tool.parameters.additionalProperties, false, `${name} must forbid extra args`);
      for (const injected of [{ businessId: 'other-tenant' }, { $where: 'this' }, { role: 'OWNER' }]) {
        const { problems } = validateToolArgs(tool, injected);
        assert.ok(
          problems.some((p) => p.includes('unknown argument')),
          `${name} accepted ${JSON.stringify(injected)}: ${problems.join('; ') || 'no problem reported'}`,
        );
      }
    }
  });

  it('★ status is a closed set, and a value outside it never reaches the service', () => {
    for (const name of REFERENCE_TOOLS) {
      const tool = aiToolsById.get(name);
      assert.deepEqual(
        tool.parameters.properties.status.enum,
        ['ACTIVE', 'ARCHIVED'],
        `${name} must only accept the two lifecycle values the reference model has`,
      );
      const { problems, cleaned } = validateToolArgs(tool, { status: 'DELETED' });
      assert.ok(problems.length > 0, `${name} accepted a status the model cannot have`);
      assert.equal(cleaned.status, undefined, 'a rejected value must not survive as cleaned data');
    }
  });

  it('★ limit is clamped by the schema, so one tool call cannot ask for the whole tenant', () => {
    for (const name of REFERENCE_TOOLS) {
      const tool = aiToolsById.get(name);
      const spec = tool.parameters.properties.limit;
      assert.equal(spec.maximum, 50);
      assert.equal(validateToolArgs(tool, { limit: 51 }).problems.length > 0, true);
      assert.equal(validateToolArgs(tool, { limit: 0 }).problems.length > 0, true);
      assert.equal(validateToolArgs(tool, { limit: 50 }).problems.length, 0);
    }
  });

  it('★ each is gated on a permission every role holds — the REST reads it mirrors need only auth', () => {
    for (const name of REFERENCE_TOOLS) {
      const tool = aiToolsById.get(name);
      assert.ok(
        [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.PRODUCTS_VIEW].includes(tool.permission),
        `${name} is gated on ${tool.permission}, which is not the read capability it exists for`,
      );
      // The gate must narrow nobody: `GET /api/locations` and `GET /api/categories`
      // require authentication ONLY, so a tool that refused STAFF would be stricter than
      // the screen it feeds.
      for (const role of [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF]) {
        assert.equal(hasPermission(role, tool.permission), true, `${role} cannot reach ${name}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The behaviour, against real MongoDB.
// ---------------------------------------------------------------------------

dbSuite('AI-14 the reference tools resolve the ids the other tools require', dbOk, () => {
  let A; // the member's business
  let B; // another tenant, used only to prove isolation
  let staff;
  let mainWarehouse;
  let closedDepot;
  let beverages;
  let categoryProduct;
  let foreignLocation; // B's location, deliberately named exactly like A's
  let foreignCategory; // B's category, likewise

  before(async () => {
    A = await registerOwner(api, tracker);
    B = await registerOwner(api, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: A.businessId }, tracker);

    mainWarehouse = await newLocation(A, { name: 'Main Warehouse' });
    closedDepot = await newLocation(A, { name: 'Closed Depot' });
    const archived = await api('POST', `/api/locations/${closedDepot.id}/archive`, { token: A.token });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));

    // Two more ACTIVE locations, so the limit clamp has a partial page to return:
    // three ACTIVE rows with `limit: 2` is the case that proves `count` is the total.
    await newLocation(A, { name: 'Second Shop' });
    await newLocation(A, { name: 'Third Store' });

    beverages = await newCategory(A, { name: 'Beverages' });
    await newCategory(A, { name: 'Snacks' });

    categoryProduct = await newProduct(A, { name: 'Cola Crate', categoryId: beverages.id });
    await newProduct(A, { name: 'Chips Box' });

    // Another tenant's identically-named records: a filter that leaked would look
    // plausible, which is exactly why the assertion is on the ids, not the names alone.
    foreignLocation = await newLocation(B, { name: 'Main Warehouse' });
    foreignCategory = await newCategory(B, { name: 'Beverages' });
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ listLocations returns the ids, names and statuses — and, by default, only ACTIVE rows', async () => {
    const result = await ok('listLocations', {}, ctxOf(A));

    assert.equal(result.status, 'ACTIVE', 'the response says which slice it answered with');
    assert.ok(names(result).includes('Main Warehouse'));
    assert.ok(!names(result).includes('Closed Depot'), 'an archived location cannot hold stock and is not offered');
    for (const row of result.items) {
      assert.deepEqual(Object.keys(row).sort(), ['description', 'id', 'name', 'status']);
      assert.equal(row.status, 'ACTIVE');
      assert.match(row.id, /^[0-9a-f]{24}$/);
    }
    const main = result.items.find((row) => row.name === 'Main Warehouse');
    assert.equal(main.id, mainWarehouse.id, 'the id is the one the other tools accept');
  });

  it('★ the archived location is reachable when it is asked for by name, and never by accident', async () => {
    const archived = await ok('listLocations', { status: 'ARCHIVED' }, ctxOf(A));
    assert.deepEqual(names(archived), ['Closed Depot']);
    assert.equal(archived.status, 'ARCHIVED');

    const search = await ok('listLocations', { q: 'depot' }, ctxOf(A));
    assert.equal(search.count, 0, 'a search for an archived name must not surface it by default');
    const searchArchived = await ok('listLocations', { q: 'depot', status: 'ARCHIVED' }, ctxOf(A));
    assert.deepEqual(names(searchArchived), ['Closed Depot']);
  });

  it('★ a limit is honoured while count still reports the whole match', async () => {
    const page = await ok('listLocations', { limit: 2 }, ctxOf(A));
    assert.equal(page.items.length, 2);
    assert.equal(page.count, 3, 'count is the total, not the page — otherwise the model cannot say "showing 2 of N"');
  });

  it('★ another tenant never appears, even when its records have identical names', async () => {
    const locations = await ok('listLocations', {}, ctxOf(A));
    const categories = await ok('listCategories', {}, ctxOf(A));

    // Counting same-named rows is not enough on its own — one row could be the wrong
    // tenant's. The id is the assertion: A's own record, and B's id nowhere.
    const locationIds = locations.items.map((row) => row.id);
    const categoryIds = categories.items.map((row) => row.id);
    assert.equal(locationIds.filter((id) => id === mainWarehouse.id).length, 1);
    assert.ok(!locationIds.includes(foreignLocation.id), "the other tenant's location was listed");
    assert.equal(categoryIds.filter((id) => id === beverages.id).length, 1);
    assert.ok(!categoryIds.includes(foreignCategory.id), "the other tenant's category was listed");
  });

  it('★ a category id from listCategories is accepted by searchProducts — the join this exists for', async () => {
    const categories = await ok('listCategories', {}, ctxOf(A));
    const byName = categories.items.find((row) => row.name === 'Beverages');
    assert.ok(byName, 'the category the member named was not resolvable');

    const products = await ok('searchProducts', { categoryId: byName.id }, ctxOf(A));
    assert.deepEqual(
      products.items.map((p) => p.id),
      [categoryProduct],
      'the resolved id must filter to exactly the products in that category',
    );
  });

  it('★ a location id from listLocations is accepted by getProductsByLocation', async () => {
    const locations = await ok('listLocations', { q: 'Main' }, ctxOf(A));
    const main = locations.items.find((row) => row.name === 'Main Warehouse');
    assert.ok(main);

    // Stock the product there through the API the app uses, then read it back through
    // the tool chain: reference id -> stock query.
    const productId = await newProduct(A, { name: 'Warehouse Widget' });
    const stocked = await api('POST', '/api/inventory/stock-in', {
      token: A.token,
      body: { productId, locationId: main.id, quantity: 7 },
    });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.json));

    const atLocation = await ok('getProductsByLocation', { locationId: main.id }, ctxOf(A));
    const row = atLocation.items.find((p) => p.id === productId);
    assert.ok(row, 'the stock written at the resolved location was not visible through the tool');
    assert.equal(row.availableQuantity, 7);
  });

  it('★ STAFF — who may already list locations and categories in the app — get the same rows', async () => {
    const staffCtx = ctxOf({ businessId: A.businessId, userId: staff.userId }, ROLES.STAFF);
    const locations = await ok('listLocations', {}, staffCtx);
    const categories = await ok('listCategories', {}, staffCtx);
    assert.ok(names(locations).includes('Main Warehouse'));
    assert.ok(names(categories).includes('Beverages'));
  });

  it('★ the model is told the ACTIVE default in the description it reads', async () => {
    // A tool whose behaviour differs from its description is worse than a missing tool:
    // the model will state the omission as a fact ("you have three locations").
    for (const name of REFERENCE_TOOLS) {
      const tool = aiToolsById.get(name);
      assert.match(tool.description, /ACTIVE/i, `${name}'s description never mentions its default`);
    }
  });
});
