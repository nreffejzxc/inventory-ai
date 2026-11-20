// Phase 20A — Offset-pagination ordering determinism.
//
// Every paginated list endpoint sorts by a key that is NOT unique. `createdAt`
// (or `updatedAt` for inventory) is identical across rows whenever they are
// written inside the same millisecond — a stock transfer updates its two
// inventory rows in one tick, a bulk import stamps one instant. MongoDB gives no
// stable order for equal sort keys, so a tie that resolves differently between
// two page requests makes a row appear on BOTH pages, or on neither. The mobile
// list appends pages as the user scrolls, so a tie-flip surfaces as a duplicated
// or silently missing row.
//
// The remedy is the convention already used by the audit trail, the dashboard
// recent activity and the inventory history: append `_id` as a tiebreaker in the
// SAME direction as the primary sort, making the order total so every page
// boundary is stable.
//
// This is the regression for that, over all nine paginated paths:
//   /api/products                        catalog list, no location filter
//   /api/products?locationId=…           catalog list, location-filtered
//   /api/products/reorder                compound sort, availability ascending
//   /api/inventory                       sorts on updatedAt
//   /api/purchase-orders
//   /api/categories, /api/locations, /api/suppliers — one shared list service
//   /api/users                           ASCENDING primary sort
//   /api/ai/conversations                sorts on updatedAt (Phase 20C / H-2)
//   /api/ai/conversations/:id/messages   ASCENDING, scoped by conversationId
//
// Each path is asserted three ways:
//   1. distinct sort values -> the intended business order is unchanged;
//   2. ONE shared sort value -> the rows fall back to `_id`, same direction;
//   3. paging at limit=1 and limit=2 reproduces the single-page order exactly —
//      no repeat, no omission, the union is the seeded set.
//
// DB-backed; fails loudly when MongoDB is unreachable (Phase 07F / M9).
// Registered as PURE_DB in run-tests.mjs.

import 'dotenv/config';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  uniqueEmail,
  stampField,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Product from '../src/models/product.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import Category from '../src/models/category.model.ts';
import Location from '../src/models/location.model.ts';
import Supplier from '../src/models/supplier.model.ts';
import User from '../src/models/user.model.ts';
import AIConversation from '../src/models/aiConversation.model.ts';
import AIMessage from '../src/models/aiMessage.model.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const PASSWORD = 'Password123!';
/** Rows seeded per path — enough that a page boundary falls inside the tie. */
const TIED = 5;

// One dedicated business per path, so each list is exactly its own fixture and
// an assertion can never be satisfied by a neighbouring test's rows.
let catalog; // /api/products, no location filter
let located; // /api/products?locationId=…
let reorderTie; // /api/products/reorder, every product out of stock
let reorderDir; // /api/products/reorder, distinct availabilities
let stock; // /api/inventory
let refs; // /api/categories + /api/locations + /api/suppliers
let people; // /api/users
let orders; // /api/purchase-orders
let ai; // /api/ai/conversations + /api/ai/conversations/:id/messages

let locatedLocationId;
let reorderDirRows; // [{ id, available }] — the reorder list's intended order
let aiConversationId; // the conversation whose messages are paged

/** URL with query params; undefined/null values are dropped. */
function url(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const search = qs.toString();
  return search ? `${path}?${search}` : path;
}

/** GET a list route, asserting the standard pagination envelope. */
async function listPage(path, token, params) {
  const res = await api('GET', url(path, params), { token });
  assert.equal(
    res.status,
    200,
    `${path} ${JSON.stringify(params)} -> ${res.status} ${JSON.stringify(res.json)}`
  );
  assert.ok(Array.isArray(res.json.items), `${path}: items must be an array`);
  return res.json;
}

/**
 * Writes ONE value onto a raw column — the shared `stampField` support helper.
 * The local alias keeps the call sites below reading the same as in Phase 20A.
 */
const stamp = stampField;

/**
 * Walks every page at `limit`, returning the ids in arrival order and asserting
 * the envelope stays consistent from page to page. The three ways a page
 * boundary can go wrong — a row repeated, a row skipped, the order shifting —
 * are each a separate assertion so a failure says which one happened.
 */
async function pageThrough(path, token, params, limit, reference) {
  const ids = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const body = await listPage(path, token, { ...params, page, limit });
    assert.equal(body.limit, limit, `${path}: limit is echoed`);
    assert.equal(body.page, page, `${path}: page is echoed`);
    assert.equal(body.total, reference.total, `${path}: total must not depend on the page`);
    totalPages = body.totalPages;
    ids.push(...body.items.map((i) => i.id));
    assert.ok(page <= 50, `${path}: paging terminated`);
  }

  const label = `${path} limit=${limit}`;
  assert.deepEqual(
    ids,
    reference.items.map((i) => i.id),
    `${label}: paged order must reproduce the single-page order`
  );
  assert.equal(ids.length, reference.total, `${label}: every record is returned`);
  assert.equal(new Set(ids).size, ids.length, `${label}: no record repeats across pages`);
  return ids;
}

/**
 * The Phase 20A contract for one paginated path.
 *
 * Step 1 gives every row a DISTINCT primary sort value and asserts the intended
 * business order is untouched. Step 2 collapses them all onto ONE value, so only
 * the `_id` tiebreaker can order them, and asserts it resolves in the SAME
 * direction as the primary sort. Step 3 is the guarantee that matters: paging a
 * tie at limit=1 and limit=2 reproduces that order exactly.
 */
async function assertPaginationContract({
  label,
  path,
  token,
  model,
  filter,
  field,
  direction,
  params = {},
}) {
  const rows = await model.find(filter).select('_id').lean();
  const ids = rows.map((r) => String(r._id)).sort();
  assert.ok(ids.length >= 3, `${label}: expected seeded rows to page over`);

  // Stamps ascend with `_id`, so ascending `field` and ascending `_id` agree and
  // one `expected` serves both steps.
  const base = Date.now();
  for (let i = 0; i < ids.length; i += 1) {
    await stamp(model, [ids[i]], field, new Date(base + i * 1000));
  }
  const expected = direction === 'desc' ? [...ids].reverse() : ids;

  const distinct = await listPage(path, token, { ...params, limit: 100 });
  assert.deepEqual(
    distinct.items.map((i) => i.id),
    expected,
    `${label}: primary sort (${field} ${direction}) is unchanged`
  );
  await pageThrough(path, token, params, 1, distinct);
  await pageThrough(path, token, params, 2, distinct);

  await stamp(model, ids, field, new Date(base));
  const tied = await listPage(path, token, { ...params, limit: 100 });
  const tiedIds = tied.items.map((i) => i.id);
  assert.deepEqual(tiedIds, expected, `${label}: equal ${field} falls back to _id, ${direction}`);
  assert.deepEqual([...tiedIds].sort(), ids, `${label}: the listing is exactly the seeded rows`);
  await pageThrough(path, token, params, 1, tied);
  await pageThrough(path, token, params, 2, tied);
}

async function newProduct(business, body = {}) {
  const res = await api('POST', '/api/products', {
    token: business.token,
    body: { currency: 'PHP', name: uniqueName('P20'), ...body },
  });
  assert.equal(res.status, 201, `product create -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.id;
}

async function newReference(business, path) {
  const res = await api('POST', path, { token: business.token, body: { name: uniqueName('R20') } });
  assert.equal(res.status, 201, `${path} create -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.id;
}

const newLocation = (business) => newReference(business, '/api/locations');

async function newStaff(business) {
  const res = await api('POST', '/api/users', {
    token: business.token,
    body: { name: uniqueName('U20'), email: uniqueEmail('u20'), password: PASSWORD, role: 'STAFF' },
  });
  assert.equal(res.status, 201, `user create -> ${res.status} ${JSON.stringify(res.json)}`);
  tracker.trackUser(res.json.id);
  return res.json.id;
}

async function stockIn(business, productId, locationId, quantity) {
  const res = await api('POST', '/api/inventory/stock-in', {
    token: business.token,
    body: { productId, locationId, quantity, reason: 'Phase 20A seed' },
  });
  assert.equal(res.status, 201, `stock-in -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

dbSuite('Phase 20A — paginated list ordering is deterministic', dbOk, () => {
  before(async () => {
    catalog = await registerOwner(api, tracker);
    located = await registerOwner(api, tracker);
    reorderTie = await registerOwner(api, tracker);
    reorderDir = await registerOwner(api, tracker);
    stock = await registerOwner(api, tracker);
    refs = await registerOwner(api, tracker);
    people = await registerOwner(api, tracker);
    orders = await registerOwner(api, tracker);
    ai = await registerOwner(api, tracker);

    for (let i = 0; i < TIED; i += 1) await newProduct(catalog);

    // Location-filtered catalog: every seeded product carries stock at ONE
    // location, so the "stocked here" guard keeps all of them in the listing.
    locatedLocationId = await newLocation(located);
    for (let i = 0; i < TIED; i += 1) {
      await stockIn(located, await newProduct(located), locatedLocationId, 3);
    }

    // Reorder, tie case: no inventory rows at all, so availability is 0 for
    // every product and equals the default minimumStock — all are candidates
    // and only createdAt/_id can separate them.
    for (let i = 0; i < TIED; i += 1) await newProduct(reorderTie);

    // Reorder, direction case: minimumStock sits above every stocked quantity,
    // so all three are candidates and availability alone orders them.
    const dirLocation = await newLocation(reorderDir);
    reorderDirRows = [];
    for (const quantity of [3, 2, 1]) {
      const id = await newProduct(reorderDir, { minimumStock: 100 });
      await stockIn(reorderDir, id, dirLocation, quantity);
      reorderDirRows.push({ id, available: quantity });
    }

    // Inventory list: five rows in one location. A transfer updates two rows in
    // the same millisecond, which is exactly the tie this path must survive.
    const stockLocation = await newLocation(stock);
    for (let i = 0; i < TIED; i += 1) {
      await stockIn(stock, await newProduct(stock), stockLocation, 4);
    }

    // Categories, locations and suppliers are three models behind ONE list
    // service, so all three are seeded and asserted.
    for (let i = 0; i < TIED; i += 1) await newReference(refs, '/api/categories');
    for (let i = 0; i < TIED; i += 1) await newReference(refs, '/api/locations');
    for (let i = 0; i < TIED; i += 1) await newReference(refs, '/api/suppliers');

    // Users list: the OWNER (created by registerOwner) plus five STAFF.
    for (let i = 0; i < TIED; i += 1) await newStaff(people);

    const poSupplier = await newReference(orders, '/api/suppliers');
    const poLocation = await newLocation(orders);
    const poProduct = await newProduct(orders);
    for (let i = 0; i < TIED; i += 1) {
      const res = await api('POST', '/api/purchase-orders', {
        token: orders.token,
        body: {
          supplierId: poSupplier,
          locationId: poLocation,
          items: [{ productId: poProduct, quantityOrdered: 1, unitCost: 5 }],
        },
      });
      assert.equal(res.status, 201, `PO create -> ${res.status} ${JSON.stringify(res.json)}`);
    }

    // AI conversations are created through the real route so the list is genuine
    // data. Their messages are written straight to the collection instead: the
    // only production writer is the chat route (already covered by the Phase 06
    // suites), and what this suite has to prove is how messages are ORDERED and
    // paged, which a directly-seeded set exercises without a provider in the loop.
    // All TIED messages share one conversation so the equality prefix is fixed and
    // only `createdAt` / `_id` can separate them.
    for (let i = 0; i < TIED; i += 1) {
      const res = await api('POST', '/api/ai/conversations', {
        token: ai.token,
        body: { title: uniqueName('C20') },
      });
      assert.equal(
        res.status,
        201,
        `conversation create -> ${res.status} ${JSON.stringify(res.json)}`
      );
      if (i === 0) aiConversationId = res.json.conversation.id;
    }
    for (let i = 0; i < TIED; i += 1) {
      await AIMessage.create({
        conversationId: aiConversationId,
        role: 'USER',
        content: `Phase 20C seed ${i}`,
      });
    }
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('orders and pages the product catalog (no location filter)', async () => {
    await assertPaginationContract({
      label: 'GET /api/products',
      path: '/api/products',
      token: catalog.token,
      model: Product,
      filter: { businessId: catalog.businessId },
      field: 'createdAt',
      direction: 'desc',
    });
  });

  it('orders and pages the location-filtered product catalog', async () => {
    await assertPaginationContract({
      label: 'GET /api/products?locationId',
      path: '/api/products',
      token: located.token,
      model: Product,
      filter: { businessId: located.businessId },
      field: 'createdAt',
      direction: 'desc',
      params: { locationId: locatedLocationId },
    });
  });

  it('orders and pages the reorder list, tying on both of its leading keys', async () => {
    // Availability is 0 for every product here, so with createdAt also collapsed
    // onto one value the `_id` tiebreaker is the ONLY thing left ordering rows
    // that span a page boundary.
    await assertPaginationContract({
      label: 'GET /api/products/reorder',
      path: '/api/products/reorder',
      token: reorderTie.token,
      model: Product,
      filter: { businessId: reorderTie.businessId },
      field: 'createdAt',
      direction: 'desc',
    });
  });

  it('keeps the reorder list worst-first when availabilities differ', async () => {
    const res = await listPage('/api/products/reorder', reorderDir.token, { limit: 100 });
    assert.equal(res.total, reorderDirRows.length, JSON.stringify(res));
    assert.deepEqual(
      res.items.map((i) => i.id),
      [...reorderDirRows].sort((a, b) => a.available - b.available).map((r) => r.id),
      'availability ascending: the worst-off product comes first'
    );
    assert.deepEqual(res.items.map((i) => i.availableQuantity), [1, 2, 3]);
  });

  it('orders and pages the inventory list (sorts on updatedAt)', async () => {
    // Inventory is the path most likely to tie in production: a transfer writes
    // both of its rows inside one tick and both carry the same updatedAt.
    await assertPaginationContract({
      label: 'GET /api/inventory',
      path: '/api/inventory',
      token: stock.token,
      model: Inventory,
      filter: { businessId: stock.businessId },
      field: 'updatedAt',
      direction: 'desc',
    });
  });

  it('orders and pages the inventory list when a PRODUCT filter is applied (§27DD)', async () => {
    // §27DD moved the `q`/`status` page onto a product-first path (resolve the matching
    // products in one query, then page the inventory index). The order is the contract that
    // could silently move with it — including the `_id` tiebreaker a transfer relies on — so
    // both filtered shapes run the SAME three-step contract the unfiltered list does.
    for (const params of [{ status: 'ACTIVE' }, { q: 'P20' }]) {
      await assertPaginationContract({
        label: `GET /api/inventory?${new URLSearchParams(params)}`,
        path: '/api/inventory',
        token: stock.token,
        model: Inventory,
        filter: { businessId: stock.businessId },
        field: 'updatedAt',
        direction: 'desc',
        params,
      });
    }
  });

  it('a selective product search returns exactly its rows, and a total that agrees', async () => {
    // The new path resolves products first, so a filter that matches ONE product must yield
    // that product's rows and no others — the failure mode a pre-resolved id set can produce
    // (`$in` built from the wrong scope) shows up here as extra rows or a wrong count.
    const all = await listPage('/api/inventory', stock.token, { limit: 100 });
    const target = all.items[0];
    assert.ok(target, 'the fixture has inventory rows');

    const filtered = await listPage('/api/inventory', stock.token, { limit: 100, q: target.product.name });
    assert.equal(filtered.total, filtered.items.length, 'the total is the filtered set');
    assert.ok(filtered.items.length >= 1, 'the matching row is returned');
    assert.deepEqual(
      [...new Set(filtered.items.map((i) => i.product.id))],
      [target.product.id],
      'only the searched product is returned'
    );
    assert.ok(
      filtered.items.some((i) => i.id === target.id),
      'the row the unfiltered list showed first is in the filtered set'
    );

    // A term that matches nothing must be an empty page with a zero total, not a fallback
    // to the unfiltered listing.
    const none = await listPage('/api/inventory', stock.token, { limit: 100, q: 'no-such-product-xyz' });
    assert.equal(none.items.length, 0);
    assert.equal(none.total, 0);
  });

  it('orders and pages the purchase order list', async () => {
    await assertPaginationContract({
      label: 'GET /api/purchase-orders',
      path: '/api/purchase-orders',
      token: orders.token,
      model: PurchaseOrder,
      filter: { businessId: orders.businessId },
      field: 'createdAt',
      direction: 'desc',
    });
  });

  it('orders and pages the categories, locations and suppliers lists', async () => {
    const paths = [
      ['/api/categories', Category],
      ['/api/locations', Location],
      ['/api/suppliers', Supplier],
    ];
    for (const [path, model] of paths) {
      await assertPaginationContract({
        label: `GET ${path}`,
        path,
        token: refs.token,
        model,
        filter: { businessId: refs.businessId },
        field: 'createdAt',
        direction: 'desc',
      });
    }
  });

  it('orders and pages the user list, which is the ascending one', async () => {
    const count = await User.countDocuments({ businessId: people.businessId });
    assert.equal(count, TIED + 1, 'five STAFF plus the OWNER');

    // The only path whose primary sort ascends — the tiebreaker must ascend with
    // it, not fall back to the descending default.
    await assertPaginationContract({
      label: 'GET /api/users',
      path: '/api/users',
      token: people.token,
      model: User,
      filter: { businessId: people.businessId },
      field: 'createdAt',
      direction: 'asc',
    });
  });

  it('orders and pages the AI conversation list (sorts on updatedAt)', async () => {
    // The conversation filter is businessId AND userId, so the contract is given
    // both — the list the route returns is exactly this user's conversations.
    await assertPaginationContract({
      label: 'GET /api/ai/conversations',
      path: '/api/ai/conversations',
      token: ai.token,
      model: AIConversation,
      filter: { businessId: ai.businessId, userId: ai.userId },
      field: 'updatedAt',
      direction: 'desc',
    });
  });

  it('orders and pages a conversation\'s messages, which ascend', async () => {
    // Messages carry no businessId — the route scopes them by the conversation it
    // has already ownership-checked — so the filter is the conversationId.
    await assertPaginationContract({
      label: 'GET /api/ai/conversations/:id/messages',
      path: `/api/ai/conversations/${aiConversationId}/messages`,
      token: ai.token,
      model: AIMessage,
      filter: { conversationId: aiConversationId },
      field: 'createdAt',
      direction: 'asc',
    });
  });

  it('applies default pagination and echoes the coerced page/limit on the AI lists', async () => {
    const conversationPath = '/api/ai/conversations';
    const messagePath = `/api/ai/conversations/${aiConversationId}/messages`;

    for (const [label, path] of [
      ['conversations', conversationPath],
      ['messages', messagePath],
    ]) {
      // Omitted page/limit -> page 1 at the default limit, with totalPages derived
      // from that same (coerced) limit.
      const defaults = await listPage(path, ai.token);
      assert.deepEqual(
        Object.keys(defaults).sort(),
        ['items', 'limit', 'page', 'total', 'totalPages'],
        `${label}: the standard envelope`
      );
      assert.equal(defaults.page, 1, `${label}: page defaults to 1`);
      assert.equal(defaults.limit, 20, `${label}: limit defaults to 20`);
      assert.equal(defaults.total, TIED, `${label}: total is the seeded row count`);
      assert.equal(defaults.totalPages, Math.ceil(TIED / 20), `${label}: totalPages`);
      assert.equal(defaults.items.length, TIED, `${label}: every row fits on page 1`);

      // Explicit page/limit are echoed back as sent when they are valid.
      const explicit = await listPage(path, ai.token, { page: 2, limit: 2 });
      assert.equal(explicit.page, 2, `${label}: page is echoed`);
      assert.equal(explicit.limit, 2, `${label}: limit is echoed`);
      assert.equal(explicit.total, TIED, `${label}: total does not depend on the page`);
      assert.equal(explicit.totalPages, Math.ceil(TIED / 2), `${label}: totalPages at limit 2`);
      assert.equal(explicit.items.length, 2, `${label}: a full second page`);

      // Past the final page the envelope still comes back, with no rows.
      const beyond = await listPage(path, ai.token, { page: 99, limit: 2 });
      assert.equal(beyond.page, 99, `${label}: the requested page is echoed`);
      assert.equal(beyond.total, TIED, `${label}: total is unchanged past the end`);
      assert.deepEqual(beyond.items, [], `${label}: past the final page is empty`);
    }
  });
});
