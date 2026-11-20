// Phase 12D — Internal Barcode Generation (POST /api/products/:id/generate-barcode).
//
// DB-backed suite over the real HTTP app. A product without a barcode receives
// an internally issued EAN-13 (GS1 restricted-distribution prefix "2"), stored
// on the existing Product.barcode field so the Phase 12A lookup and the mobile
// scanner treat it like any other code. Covers: generation + deterministic
// value + check digit, no-overwrite of existing barcodes, Phase 12A resolution,
// uniqueness within a business, the SAME code value legitimately existing in
// two businesses (isolation), archived-product protection, RBAC/auth/cross-
// business refusal, invalid ids, and that unrelated product fields (name, SKU,
// prices, status) are untouched. Registered as MIXED in run-tests.mjs.
//
// NOTE: business context always comes from the authenticated user — no client
// barcode/businessId input is accepted.

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
import { ean13Value, ean13CheckDigit, internalEan13Candidates } from '../src/utils/internalBarcode.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const generateUrl = (id) => `/api/products/${id}/generate-barcode`;
const barcodeUrl = (code) => `/api/products/barcode?barcode=${encodeURIComponent(code)}`;
const productUrl = (id) => `/api/products/${id}`;

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P12D'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json; // the created product DTO (id, barcode, status, ...)
}

let main; // primary fixture business (OWNER)
let other; // isolation victim business (OWNER)
let staffMain; // STAFF inside `main`

let noCode; // no barcode yet (main) — target of the happy-path generate
let noCodeCode; // the code `noCode` receives
let skuNoCode; // has a SKU but no barcode
let skuSku; // SKU value of `skuNoCode`
let skuCode; // code `skuNoCode` receives
let hasBc; // already carries a manufacturer barcode
const MANUFACTURER_BC = '4006381333931'; // a valid retail EAN-13, not prefix 2
let archivedNoCode; // no barcode, later ARCHIVED
let targetNoCode; // barcode-less product for RBAC/refusal tests
let generatedByOther; // `other`'s product carrying the SAME code as `noCode`

dbSuite('Phase 12D — internal barcode generation (POST /:id/generate-barcode) over real HTTP', dbOk, () => {
  before(async () => {
    main = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    staffMain = await makeRoleUser({ role: ROLES.STAFF, businessId: main.businessId }, tracker);

    noCode = await newProduct(main);
    skuNoCode = await newProduct(main, { sku: uniqueName('SKU-12D') });
    hasBc = await newProduct(main, { barcode: MANUFACTURER_BC });
    archivedNoCode = await newProduct(main);
    targetNoCode = await newProduct(main);

    const arch = await api('POST', `/api/products/${archivedNoCode.id}/archive`, { token: main.token });
    assert.equal(arch.status, 200, JSON.stringify(arch.json));
    assert.equal(arch.json.status, 'ARCHIVED');
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('generates a deterministic internal EAN-13 for a product without a barcode', async () => {
    const res = await api('POST', generateUrl(noCode.id), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, noCode.id);
    noCodeCode = res.json.barcode;

    // Valid 13-digit EAN-13 starting with the GS1 restricted prefix "2".
    assert.match(noCodeCode, /^2\d{12}$/);
    // Check digit agrees with the standard algorithm.
    assert.equal(noCodeCode, ean13Value(noCodeCode.slice(0, 12)));
    assert.equal(ean13CheckDigit(noCodeCode.slice(0, 12)), Number(noCodeCode[12]));
    // Deterministic: the same product always maps to the same first candidate.
    const [firstCandidate] = internalEan13Candidates(noCode.id);
    assert.equal(noCodeCode, firstCandidate);
  });

  it('an existing (manufacturer) barcode is never overwritten', async () => {
    const res = await api('POST', generateUrl(hasBc.id), { token: main.token });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.code, 'PRODUCT_ALREADY_HAS_BARCODE');

    const get = await api('GET', productUrl(hasBc.id), { token: main.token });
    assert.equal(get.status, 200);
    assert.equal(get.json.barcode, MANUFACTURER_BC, 'original barcode is preserved');
  });

  it('the generated barcode resolves through the Phase 12A lookup', async () => {
    const res = await api('GET', barcodeUrl(noCodeCode), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, noCode.id);
    assert.equal(res.json.barcode, noCodeCode);
    assert.equal(res.json.status, 'ACTIVE');
    assert.equal(res.json.businessId, main.businessId);
  });

  it('keeps the product SKU and leaves other fields untouched', async () => {
    skuSku = skuNoCode.sku;
    const res = await api('POST', generateUrl(skuNoCode.id), { token: main.token });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    skuCode = res.json.barcode;
    assert.match(skuCode, /^2\d{12}$/);
    assert.notEqual(skuCode, noCodeCode, 'two products never share an internal code');

    const get = await api('GET', productUrl(skuNoCode.id), { token: main.token });
    assert.equal(get.status, 200);
    assert.equal(get.json.sku, skuSku, 'SKU is preserved');
    assert.equal(get.json.barcode, skuCode);
  });

  it('uniqueness within a business stays enforced (create + index)', async () => {
    const dup = await api('POST', '/api/products', {
      token: main.token,
      body: { currency: 'PHP', name: uniqueName('P12D Dup'), barcode: noCodeCode },
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.json));
    assert.equal(dup.json.code, 'PRODUCT_BARCODE_EXISTS');
  });

  it('keeps the SAME code value isolated per business', async () => {
    // Another shop can legitimately hold an identical internal number; each
    // business's lookup must resolve only its own product.
    generatedByOther = await newProduct(other, { barcode: noCodeCode });
    assert.equal(generatedByOther.barcode, noCodeCode);

    const inMain = await api('GET', barcodeUrl(noCodeCode), { token: main.token });
    assert.equal(inMain.status, 200);
    assert.equal(inMain.json.id, noCode.id);
    assert.equal(inMain.json.businessId, main.businessId);

    const inOther = await api('GET', barcodeUrl(noCodeCode), { token: other.token });
    assert.equal(inOther.status, 200);
    assert.equal(inOther.json.id, generatedByOther.id);
    assert.equal(inOther.json.businessId, other.businessId);
  });

  it('archived products cannot receive a new barcode', async () => {
    const res = await api('POST', generateUrl(archivedNoCode.id), { token: main.token });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.code, 'PRODUCT_ARCHIVED');

    const get = await api('GET', productUrl(archivedNoCode.id), { token: main.token });
    assert.equal(get.status, 200);
    assert.equal(get.json.barcode, null, 'archived product still has no barcode');
  });

  it('auth/RBAC/cross-business/invalid-id are all refused', async () => {
    // No token.
    const noToken = await api('POST', generateUrl(targetNoCode.id), {});
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, 'AUTH_REQUIRED');

    // STAFF holds PRODUCTS_VIEW only — generation needs products.manage.
    const staff = await api('POST', generateUrl(targetNoCode.id), { token: staffMain.token });
    assert.equal(staff.status, 403, JSON.stringify(staff.json));
    assert.equal(staff.json.code, 'FORBIDDEN');

    // A manager of `other` cannot touch `main`'s product (business isolation).
    const otherOwner = await api('POST', generateUrl(targetNoCode.id), { token: other.token });
    assert.equal(otherOwner.status, 404, JSON.stringify(otherOwner.json));
    assert.equal(otherOwner.json.code, 'NOT_FOUND');

    // Malformed id.
    const badId = await api('POST', generateUrl('not-an-object-id'), { token: main.token });
    assert.equal(badId.status, 400);
    assert.equal(badId.json.code, 'INVALID_ID');

    // None of the above mutated `targetNoCode`.
    const get = await api('GET', productUrl(targetNoCode.id), { token: main.token });
    assert.equal(get.status, 200);
    assert.equal(get.json.barcode, null);
  });

  it('a second generate is refused once the product has its internal code', async () => {
    const first = await api('POST', generateUrl(targetNoCode.id), { token: main.token });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const code = first.json.barcode;
    assert.match(code, /^2\d{12}$/);

    const again = await api('POST', generateUrl(targetNoCode.id), { token: main.token });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'PRODUCT_ALREADY_HAS_BARCODE');

    const get = await api('GET', productUrl(targetNoCode.id), { token: main.token });
    assert.equal(get.json.barcode, code, 'code unchanged by the second attempt');
  });
});
