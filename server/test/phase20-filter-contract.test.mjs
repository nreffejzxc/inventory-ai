// Phase 20D — the list filter contract, asserted as shipped.
//
// The Phase 20B audit found that the list endpoints disagreed about what a
// MALFORMED filter is. `/api/products` and `/api/inventory` rejected one;
// `/api/users`, `/api/purchase-orders`, the reference lists and `/api/audit`
// quietly dropped it and answered 200 with a WIDER result set than the caller
// asked for. That is the dangerous direction for a filter bug: a client that
// misspells a status, or sends a truncated `supplierId`, is not told it is
// wrong — it receives the unfiltered collection and cannot tell.
//
// This suite pins the normalized contract (M-1, M-2, M-3):
//   * an unknown `status` is a field problem, never an ignored filter;
//   * a malformed `supplierId` is a field problem, and the predicate is never
//     silently removed;
//   * a `q` that is PRESENT but blank (`?q=`, `?q=%20%20`) is a field problem,
//     while an ABSENT `q` still means "no search";
//   * a VALID filter in any of those positions still filters.
//
// Every rejection asserts `notEqual(status, 200)` and that no `items` array came
// back, so the "answered with the unfiltered list" failure can never regress
// silently. DB-backed; registered as PURE_DB in run-tests.mjs.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  uniqueEmail,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let main; // the business under test (an OWNER session)
let other; // a second business, for the cross-tenant supplier probe

let activeProduct;
let archivedProduct;
let activeCategory;
let archivedCategory;
let activeLocation;
let archivedLocation;
let supplierA;
let supplierB;
let archivedSupplier;
let otherSupplier;
let draftPo;
let openPo;
let disabledUserId;
let staffEmail;

/** Every list path that accepts `q`. */
const Q_PATHS = [
  '/api/products',
  '/api/products/reorder',
  '/api/inventory',
  '/api/users',
  '/api/purchase-orders',
  '/api/categories',
  '/api/locations',
  '/api/suppliers',
  '/api/audit',
];

/** The five endpoint families that accept a `status` filter. */
const STATUS_PATHS = [
  '/api/users',
  '/api/purchase-orders',
  '/api/categories',
  '/api/locations',
  '/api/suppliers',
];

/**
 * Asserts a response is a well-formed VALIDATION_ERROR anchored on one field —
 * and, critically, that it is NOT a 200 list. A malformed filter must never be
 * answered with data; that is the silent-widening failure this phase fixes.
 */
function assertRejected(res, field, label) {
  assert.notEqual(res.status, 200, `${label}: a malformed filter must not answer with a list`);
  assert.equal(res.status, 400, `${label} -> ${res.status} ${JSON.stringify(res.json)}`);
  assert.equal(res.json.code, 'VALIDATION_ERROR', `${label}: code`);
  assert.ok(Array.isArray(res.json.fields), `${label}: fields is an array`);
  assert.ok(res.json.fields.some((f) => f.field === field), `${label}: anchored on '${field}'`);
}

/** POST expecting 201 (a create). */
async function created(path, body, token = main.token) {
  const res = await api('POST', path, { token, body });
  assert.equal(res.status, 201, `POST ${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** POST expecting 200 (archive / issue / restore). */
async function posted(path, body, token = main.token) {
  const res = await api('POST', path, { token, body });
  assert.equal(res.status, 200, `POST ${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** GET expecting 200 (a valid filter, or no filter at all). */
async function get(path, token = main.token) {
  const res = await api('GET', path, { token });
  assert.equal(res.status, 200, `GET ${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Asserts a valid ACTIVE/ARCHIVED filter still narrows in both directions. */
async function assertStatusFilters(path, activeId, archivedId) {
  const archived = await get(`${path}?status=ARCHIVED&limit=100`);
  const archivedIds = archived.items.map((i) => i.id);
  assert.ok(archivedIds.includes(archivedId), `${path}: the archived row is returned`);
  assert.ok(!archivedIds.includes(activeId), `${path}: the active row is filtered out`);
  assert.ok(
    archived.items.every((i) => i.status === 'ARCHIVED'),
    `${path}: every returned row is ARCHIVED`
  );

  const active = await get(`${path}?status=ACTIVE&limit=100`);
  const activeIds = active.items.map((i) => i.id);
  assert.ok(activeIds.includes(activeId), `${path}: the active row is returned`);
  assert.ok(!activeIds.includes(archivedId), `${path}: the archived row is filtered out`);
}

dbSuite('Phase 20D — list filter contract', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);

    // Reference rows: one ACTIVE and one ARCHIVED per family, so a valid status
    // filter can be shown to narrow in both directions.
    activeCategory = await created('/api/categories', { name: uniqueName('P20D-cat') });
    archivedCategory = await created('/api/categories', { name: uniqueName('P20D-cat-arch') });
    await posted(`/api/categories/${archivedCategory.id}/archive`);

    activeLocation = await created('/api/locations', { name: uniqueName('P20D-loc') });
    archivedLocation = await created('/api/locations', { name: uniqueName('P20D-loc-arch') });
    await posted(`/api/locations/${archivedLocation.id}/archive`);

    supplierA = await created('/api/suppliers', { name: uniqueName('P20D-sup-A') });
    supplierB = await created('/api/suppliers', { name: uniqueName('P20D-sup-B') });
    archivedSupplier = await created('/api/suppliers', { name: uniqueName('P20D-sup-arch') });
    await posted(`/api/suppliers/${archivedSupplier.id}/archive`);

    // A supplier that belongs to a DIFFERENT business: a valid ObjectId the
    // caller may not use, which must filter to nothing rather than be dropped.
    otherSupplier = await created('/api/suppliers', { name: uniqueName('P20D-sup-other') }, other.token);

    // Products: one ACTIVE with stock, one ARCHIVED.
    activeProduct = await created('/api/products', { currency: 'PHP', name: uniqueName('P20D-prod') });
    archivedProduct = await created('/api/products', { currency: 'PHP', name: uniqueName('P20D-prod-arch') });
    await posted(`/api/products/${archivedProduct.id}/archive`);
    await created('/api/inventory/stock-in', {
      productId: activeProduct.id,
      locationId: activeLocation.id,
      quantity: 5,
    });

    // Purchase orders: one stays DRAFT (supplier A), one is issued to OPEN
    // (supplier B), so both a status filter and a supplier filter have two
    // distinguishable subjects.
    const line = [{ productId: activeProduct.id, quantityOrdered: 2 }];
    draftPo = await created('/api/purchase-orders', {
      supplierId: supplierA.id,
      locationId: activeLocation.id,
      items: line,
    });
    openPo = await created('/api/purchase-orders', {
      supplierId: supplierB.id,
      locationId: activeLocation.id,
      items: line,
    });
    await posted(`/api/purchase-orders/${openPo.id}/issue`);

    // Users: the OWNER stays ACTIVE, one STAFF is disabled.
    const staff = await created('/api/users', {
      name: uniqueName('P20D-staff'),
      email: uniqueEmail('p20d'),
      password: 'Password123!',
      role: 'STAFF',
    });
    disabledUserId = staff.id;
    staffEmail = staff.email;
    const patched = await api('PATCH', `/api/users/${staff.id}`, {
      token: main.token,
      body: { status: 'DISABLED' },
    });
    assert.equal(patched.status, 200, `disable user -> ${patched.status} ${JSON.stringify(patched.json)}`);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  // -- M-1: an invalid status is rejected, not silently ignored ---------------

  it('rejects an unknown status on all five families', async () => {
    for (const path of STATUS_PATHS) {
      const res = await api('GET', `${path}?status=NOPE`, { token: main.token });
      assertRejected(res, 'status', `${path}?status=NOPE`);
    }
  });

  it('rejects an empty status rather than treating it as absent', async () => {
    for (const path of STATUS_PATHS) {
      const res = await api('GET', `${path}?status=`, { token: main.token });
      assertRejected(res, 'status', `${path}?status=`);
    }
  });

  it('still filters on a valid status (users and purchase orders)', async () => {
    const disabled = await get('/api/users?status=DISABLED&limit=100');
    assert.deepEqual(
      disabled.items.map((i) => i.id),
      [disabledUserId],
      'DISABLED returns exactly the disabled user'
    );
    const active = await get('/api/users?status=ACTIVE&limit=100');
    assert.ok(active.items.some((i) => i.id === main.userId), 'ACTIVE includes the owner');
    assert.ok(!active.items.some((i) => i.id === disabledUserId), 'ACTIVE excludes the disabled user');

    const drafts = await get('/api/purchase-orders?status=DRAFT&limit=100');
    assert.deepEqual(
      drafts.items.map((i) => i.id),
      [draftPo.id],
      'DRAFT returns only the unissued order'
    );
    const open = await get('/api/purchase-orders?status=OPEN&limit=100');
    assert.deepEqual(
      open.items.map((i) => i.id),
      [openPo.id],
      'OPEN returns only the issued order'
    );
  });

  it('still filters on a valid status (the three reference families)', async () => {
    await assertStatusFilters('/api/categories', activeCategory.id, archivedCategory.id);
    await assertStatusFilters('/api/locations', activeLocation.id, archivedLocation.id);
    await assertStatusFilters('/api/suppliers', supplierA.id, archivedSupplier.id);
  });

  it('leaves the already-conforming product and inventory status filters working', async () => {
    const products = await get('/api/products?status=ARCHIVED&limit=100');
    assert.ok(
      products.items.some((i) => i.id === archivedProduct.id),
      'the archived product is returned'
    );
    assert.ok(
      products.items.every((i) => i.status === 'ARCHIVED'),
      'every returned product is ARCHIVED'
    );

    const inventory = await get('/api/inventory?status=ACTIVE&limit=100');
    assert.ok(inventory.items.length >= 1, 'an ACTIVE status is still accepted by inventory');
  });

  // -- M-2: a malformed supplierId never drops the predicate ------------------

  it('rejects a malformed supplierId instead of dropping the filter', async () => {
    for (const bad of ['not-an-objectid', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '5f'.repeat(11)]) {
      const res = await api('GET', `/api/purchase-orders?supplierId=${bad}`, { token: main.token });
      assertRejected(res, 'supplierId', `supplierId=${bad}`);
    }
  });

  it('never answers a malformed filter with the unfiltered list', async () => {
    const all = await get('/api/purchase-orders?limit=100');
    assert.ok(all.total >= 2, 'the business has purchase orders that could leak');

    for (const query of ['?status=NOPE', '?supplierId=not-an-objectid', '?q=']) {
      const res = await api('GET', `/api/purchase-orders${query}`, { token: main.token });
      assert.equal(res.status, 400, `${query} must be rejected, not answered with a list`);
      assert.equal(res.json.items, undefined, `${query} must not return an items array`);
    }
  });

  it('still filters on a valid supplierId', async () => {
    const a = await get(`/api/purchase-orders?supplierId=${supplierA.id}&limit=100`);
    assert.deepEqual(
      a.items.map((i) => i.id),
      [draftPo.id],
      "supplier A's filter returns only supplier A's order"
    );
    const b = await get(`/api/purchase-orders?supplierId=${supplierB.id}&limit=100`);
    assert.deepEqual(
      b.items.map((i) => i.id),
      [openPo.id],
      "supplier B's filter returns only supplier B's order"
    );
  });

  it('applies a cross-business supplierId rather than dropping it', async () => {
    const res = await get(`/api/purchase-orders?supplierId=${otherSupplier.id}&limit=100`);
    assert.equal(res.total, 0, 'a valid id from another business filters to nothing');
    assert.deepEqual(res.items, [], 'and leaks no purchase orders');
  });

  it('treats a blank supplierId as absent, per the shared ObjectId convention', async () => {
    // The locked decision: only a MALFORMED non-empty supplierId is a client
    // error. `?supplierId=` is "no supplier filter", matching optionalObjectId.
    const res = await get('/api/purchase-orders?supplierId=&limit=100');
    assert.equal(res.total, 2, 'blank means no supplier filter, so both orders are returned');
  });

  // -- M-3: a blank q is rejected; an absent q is not ------------------------

  it('rejects an empty or whitespace-only q on every list endpoint that takes one', async () => {
    for (const path of Q_PATHS) {
      for (const suffix of ['?q=', '?q=%20%20', '?q=%20']) {
        const res = await api('GET', `${path}${suffix}`, { token: main.token });
        assertRejected(res, 'q', `${path}${suffix}`);
      }
    }
  });

  it('still answers 200 when q is absent', async () => {
    for (const path of Q_PATHS) {
      const res = await api('GET', `${path}?limit=100`, { token: main.token });
      assert.equal(res.status, 200, `${path} without q -> ${res.status} ${JSON.stringify(res.json)}`);
    }
  });

  it('still narrows on a real q', async () => {
    const products = await get(`/api/products?q=${encodeURIComponent(activeProduct.name)}&limit=100`);
    assert.deepEqual(
      products.items.map((i) => i.id),
      [activeProduct.id],
      'the product name search returns exactly the match'
    );

    const users = await get(`/api/users?q=${encodeURIComponent(staffEmail)}&limit=100`);
    assert.deepEqual(
      users.items.map((i) => i.id),
      [disabledUserId],
      'the user email search returns exactly the match'
    );

    const suppliers = await get(`/api/suppliers?q=${encodeURIComponent(supplierA.name)}&limit=100`);
    const supplierIds = suppliers.items.map((i) => i.id);
    assert.ok(supplierIds.includes(supplierA.id), 'the supplier search returns its match');
    assert.ok(!supplierIds.includes(supplierB.id), 'and excludes the other supplier');

    const categories = await get(`/api/categories?q=${encodeURIComponent(activeCategory.name)}&limit=100`);
    assert.ok(
      categories.items.some((i) => i.id === activeCategory.id),
      'the category search returns its match'
    );

    const pos = await get(`/api/purchase-orders?q=${encodeURIComponent(draftPo.number)}&limit=100`);
    assert.deepEqual(
      pos.items.map((i) => i.id),
      [draftPo.id],
      'the order-number search returns exactly the match'
    );
  });
});
