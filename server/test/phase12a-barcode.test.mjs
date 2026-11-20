// Phase 12A — Barcode Foundation.
//
// DB-backed suite over the real HTTP app: GET /api/products/barcode resolves an
// exact barcode to the authenticated business's product (unique per business via
// the partial unique index, so the lookup is singular). Covers successful
// lookup (category populated), unknown-barcode 404, invalid input 400s (missing /
// blank / non-string array / over-long), cross-business isolation (including the
// same barcode value legitimately existing in two different businesses), the
// write-time duplicate-within-business 409 behavior, archived-product lookup
// (returned with status ARCHIVED — owner decision 2026-09-09), and RBAC/auth.
// Read-only — no inventory or data-model change. Registered as MIXED in
// run-tests.mjs.
//
// NOTE: business context is always the authenticated user's (req.user.businessId)
// — no client-supplied businessId is accepted anywhere on this endpoint.

import 'dotenv/config';

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
import { dbSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const barcodeUrl = (code) => `/api/products/barcode?barcode=${encodeURIComponent(code)}`;

async function newCategory(business, name) {
  const res = await api('POST', '/api/categories', { token: business.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P12A'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json; // the created product DTO (id, barcode, status, ...)
}

let main; // primary fixture business (OWNER)
let other; // isolation victim business (OWNER)
let staffMain; // STAFF inside `main`
let mainCatId; // category owned by `main`

let activeProduct; // ACTIVE product in `main` with a category
let mainOnly; // barcode that exists only in `main`
let otherOnly; // barcode that exists only in `other`
let sharedValue; // the SAME barcode string, present in both businesses
let sharedMain; // ... as owned by `main`
let sharedOther; // ... as owned by `other`
let dupSource; // product whose barcode a duplicate create will target (409)
let archivedProduct; // product in `main` later ARCHIVED (keeps its barcode)

dbSuite('Phase 12A — barcode lookup (GET /api/products/barcode) over real HTTP', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    mainCatId = await newCategory(main, 'Barcode Cat');
    staffMain = await makeRoleUser({ role: ROLES.STAFF, businessId: main.businessId }, tracker);

    activeProduct = await newProduct(main, { name: uniqueName('P12A Main'), barcode: uniqueName('BRC-MAIN'), categoryId: mainCatId });
    mainOnly = await newProduct(main, { barcode: uniqueName('BRC-MAIN-ONLY') });
    otherOnly = await newProduct(other, { barcode: uniqueName('BRC-OTHER-ONLY') });

    // The same raw barcode is allowed across businesses (uniqueness is per
    // business); each business's lookup must resolve only its own product.
    sharedValue = uniqueName('BRC-SHARED');
    sharedMain = await newProduct(main, { barcode: sharedValue });
    sharedOther = await newProduct(other, { barcode: sharedValue });

    dupSource = await newProduct(main, { barcode: uniqueName('BRC-DUP') });

    archivedProduct = await newProduct(main, { barcode: uniqueName('BRC-ARCH') });
    const arch = await api('POST', `/api/products/${archivedProduct.id}/archive`, { token: main.token });
    assert.equal(arch.status, 200, JSON.stringify(arch.json));
    assert.equal(arch.json.status, 'ARCHIVED');
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('resolves an ACTIVE barcode to the product, with the category populated', async () => {
    const res = await api('GET', barcodeUrl(activeProduct.barcode), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, activeProduct.id);
    assert.equal(res.json.barcode, activeProduct.barcode);
    assert.equal(res.json.status, 'ACTIVE');
    assert.equal(res.json.businessId, main.businessId);
    assert.equal(res.json.category.id, mainCatId);
    assert.equal(res.json.category.name, 'Barcode Cat');
  });

  it('returns a clean 404 NOT_FOUND for an unknown barcode', async () => {
    const res = await api('GET', barcodeUrl(uniqueName('BRC-NOPE')), { token: main.token });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.equal(res.json.code, 'NOT_FOUND');
    assert.equal(res.json.error, 'Product not found');
  });

  it('rejects invalid input with 400 VALIDATION_ERROR', async () => {
    // Missing query param.
    const missing = await api('GET', '/api/products/barcode', { token: main.token });
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.equal(missing.json.code, 'VALIDATION_ERROR');
    assert.ok(missing.json.fields.some((f) => f.field === 'barcode'));

    // Blank value.
    const blank = await api('GET', barcodeUrl(''), { token: main.token });
    assert.equal(blank.status, 400);
    assert.ok(blank.json.fields.some((f) => f.field === 'barcode'));

    // Repeated key -> an array, never treated as a string to match against.
    const arr = await api('GET', '/api/products/barcode?barcode=a&barcode=b', { token: main.token });
    assert.equal(arr.status, 400);
    assert.ok(arr.json.fields.some((f) => f.field === 'barcode'));

    // Longer than the product schema allows (CODE_MAX = 100) can never match.
    const tooLong = await api('GET', barcodeUrl('9'.repeat(101)), { token: main.token });
    assert.equal(tooLong.status, 400);
    assert.ok(tooLong.json.fields.some((f) => f.field === 'barcode'));
  });

  it('keeps the SAME barcode value isolated per business', async () => {
    const inMain = await api('GET', barcodeUrl(sharedValue), { token: main.token });
    assert.equal(inMain.status, 200, JSON.stringify(inMain.json));
    assert.equal(inMain.json.id, sharedMain.id);
    assert.equal(inMain.json.businessId, main.businessId);

    const inOther = await api('GET', barcodeUrl(sharedValue), { token: other.token });
    assert.equal(inOther.status, 200, JSON.stringify(inOther.json));
    assert.equal(inOther.json.id, sharedOther.id);
    assert.equal(inOther.json.businessId, other.businessId);

    assert.notEqual(inMain.json.id, inOther.json.id, 'each business resolves its own product');
  });

  it('never leaks a barcode owned only by another business', async () => {
    const mainSeesOther = await api('GET', barcodeUrl(otherOnly.barcode), { token: main.token });
    assert.equal(mainSeesOther.status, 404);
    assert.equal(mainSeesOther.json.code, 'NOT_FOUND');

    const otherSeesMain = await api('GET', barcodeUrl(mainOnly.barcode), { token: other.token });
    assert.equal(otherSeesMain.status, 404);
  });

  it('duplicate barcode within a business stays rejected (409) and the lookup stays singular', async () => {
    const dup = await api('POST', '/api/products', {
      token: main.token,
      body: { currency: 'PHP', name: uniqueName('P12A Dup'), barcode: dupSource.barcode },
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.json));
    assert.equal(dup.json.code, 'PRODUCT_BARCODE_EXISTS');

    const res = await api('GET', barcodeUrl(dupSource.barcode), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, dupSource.id, 'lookup resolves the single owning product');
  });

  it('returns an ARCHIVED product with status ARCHIVED (not treated as active)', async () => {
    const res = await api('GET', barcodeUrl(archivedProduct.barcode), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, archivedProduct.id);
    assert.equal(res.json.status, 'ARCHIVED');
  });

  it('RBAC: STAFF may read a barcode lookup; auth failures are 401', async () => {
    const staff = await api('GET', barcodeUrl(activeProduct.barcode), { token: staffMain.token });
    assert.equal(staff.status, 200, JSON.stringify(staff.json));
    assert.equal(staff.json.id, activeProduct.id);

    const noToken = await api('GET', barcodeUrl(activeProduct.barcode), {});
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, 'AUTH_REQUIRED');

    const badToken = await api('GET', barcodeUrl(activeProduct.barcode), { token: 'not-a-real-token' });
    assert.equal(badToken.status, 401);
    assert.equal(badToken.json.code, 'INVALID_TOKEN');
  });
});
