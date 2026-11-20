// Phase 04 — Categories, Locations, Products (catalog): CRUD, search, RBAC,
// business isolation, validation, and audit logging, over the real shipped app.
// Integration tests over the real app + MongoDB (DB-backed; fails loudly when
// MongoDB is unreachable — Phase 07F / M9).

import { describe, it, before, after } from 'node:test';
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
import AuditLog from '../src/models/auditLog.model.ts';
import { ROLES } from '../src/constants/roles.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;
let other; // a second business (OWNER) for isolation checks

async function categoryId(name = uniqueName('Cat'), token = owner.token) {
  const res = await api('POST', '/api/categories', { token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function locationId(name = uniqueName('Loc'), token = owner.token) {
  const res = await api('POST', '/api/locations', { token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function productId(payload = {}, token = owner.token) {
  const res = await api('POST', '/api/products', { token, body: { name: uniqueName('P'), currency: 'PHP', ...payload } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function auditExists(action) {
  return AuditLog.exists({ businessId: owner.businessId, action });
}

function stubAuditCreateToThrow() {
  const real = AuditLog.create.bind(AuditLog);
  AuditLog.create = async () => {
    const err = new Error('injected audit-log failure');
    err.name = 'InjectedAuditError';
    throw err;
  };
  return () => {
    AuditLog.create = real;
  };
}

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 04 — catalog: categories, locations, products', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
  });

  // ---------------------------------------------------------------------------
  describe('categories', () => {
    it('creates, reads, lists and searches a category', async () => {
      const created = await api('POST', '/api/categories', {
        token: owner.token,
        body: { name: 'Beverages', description: 'Drinks' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.name, 'Beverages');
      assert.equal(created.json.description, 'Drinks');
      assert.equal(created.json.status, 'ACTIVE');

      const got = await api('GET', `/api/categories/${created.json.id}`, { token: owner.token });
      assert.equal(got.status, 200);
      assert.equal(got.json.name, 'Beverages');

      const found = await api('GET', `/api/categories?q=bever`, { token: owner.token });
      assert.ok(found.json.items.some((c) => c.id === created.json.id));
    });

    it('updates, archives and restores a category with audit logs', async () => {
      const id = await categoryId();
      const upd = await api('PATCH', `/api/categories/${id}`, {
        token: owner.token,
        body: { name: 'Renamed' },
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.json.name, 'Renamed');
      assert.ok(await auditExists('CATEGORY_UPDATED'));

      const arch = await api('POST', `/api/categories/${id}/archive`, { token: owner.token });
      assert.equal(arch.status, 200);
      assert.equal(arch.json.status, 'ARCHIVED');
      assert.ok(await auditExists('CATEGORY_ARCHIVED'));

      const archList = await api('GET', `/api/categories?status=ARCHIVED`, { token: owner.token });
      assert.ok(archList.json.items.some((c) => c.id === id));

      const restored = await api('POST', `/api/categories/${id}/restore`, { token: owner.token });
      assert.equal(restored.json.status, 'ACTIVE');
    });

    it('PATCH can clear a category description', async () => {
      const created = await api('POST', '/api/categories', {
        token: owner.token,
        body: { name: uniqueName('Clearable Category'), description: 'Remove me' },
      });
      assert.equal(created.status, 201);

      const cleared = await api('PATCH', `/api/categories/${created.json.id}`, {
        token: owner.token,
        body: { description: '' },
      });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
      assert.ok(!cleared.json.description, 'description is cleared, not left as the old value');
    });

    it('validates a missing name (400 with fields)', async () => {
      const res = await api('POST', '/api/categories', { token: owner.token, body: {} });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'VALIDATION_ERROR');
      assert.ok(res.json.fields.some((f) => f.field === 'name'));
    });

    it('category mutations are RBAC-gated', async () => {
      const staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
      const manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
      const admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);

      for (const u of [staff, manager]) {
        const res = await api('POST', '/api/categories', { token: u.token, body: { name: 'x' } });
        assert.equal(res.status, 403, `create category should be forbidden for ${u.role}`);
      }
      const adminRes = await api('POST', '/api/categories', {
        token: admin.token,
        body: { name: uniqueName('AdmCat') },
      });
      assert.equal(adminRes.status, 201);
    });

    it('isolation: another business cannot read this category', async () => {
      const id = await categoryId();
      const got = await api('GET', `/api/categories/${id}`, { token: other.token });
      assert.equal(got.status, 404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('locations', () => {
    it('creates, lists, updates, archives and restores a location', async () => {
      const res = await api('POST', '/api/locations', {
        token: owner.token,
        body: { name: 'Warehouse', description: 'Back room' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.status, 'ACTIVE');
      assert.ok(await auditExists('LOCATION_CREATED'));

      const list = await api('GET', '/api/locations', { token: owner.token });
      assert.ok(list.json.items.some((l) => l.id === res.json.id));

      const upd = await api('PATCH', `/api/locations/${res.json.id}`, {
        token: owner.token,
        body: { name: 'Warehouse 2' },
      });
      assert.equal(upd.status, 200);

      const arch = await api('POST', `/api/locations/${res.json.id}/archive`, { token: owner.token });
      assert.equal(arch.status, 200);
      assert.ok(await auditExists('LOCATION_ARCHIVED'));
    });

    it('location mutations are RBAC-gated (STAFF and MANAGER denied)', async () => {
      const staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
      const manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
      const admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
      for (const u of [staff, manager]) {
        const res = await api('POST', '/api/locations', { token: u.token, body: { name: 'x' } });
        assert.equal(res.status, 403);
      }
      const adminRes = await api('POST', '/api/locations', {
        token: admin.token,
        body: { name: uniqueName('AdmLoc') },
      });
      assert.equal(adminRes.status, 201);
    });

    it('isolation: another business cannot read this location', async () => {
      const id = await locationId();
      const got = await api('GET', `/api/locations/${id}`, { token: other.token });
      assert.equal(got.status, 404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('products', () => {
    it('creates a product with all fields and returns the nested category on GET', async () => {
      const cat = await categoryId('Snacks');
      const res = await api('POST', '/api/products', {
        token: owner.token,
        body: {
          name: 'Potato Chips',
          sku: uniqueName('SKU'),
          barcode: uniqueName('BAR'),
          description: 'Crunchy',
          categoryId: cat,
          costPrice: 1.25,
          sellingPrice: 2.5,
          currency: 'PHP',
          unit: 'bag',
          minimumStock: 10,
          imageUrl: 'https://example.com/chips.png',
        },
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.name, 'Potato Chips');
      assert.equal(res.json.sellingPrice, 2.5);
      assert.equal(res.json.costPrice, 1.25);
      assert.equal(res.json.minimumStock, 10);
      assert.ok(await auditExists('PRODUCT_CREATED'));

      const got = await api('GET', `/api/products/${res.json.id}`, { token: owner.token });
      assert.equal(got.status, 200);
      assert.equal(got.json.category.id, cat);
      assert.equal(got.json.category.name, 'Snacks');
      assert.equal(got.json.category.status, 'ACTIVE');
    });

    it('rejects duplicate SKU / barcode within the business (409 codes)', async () => {
      const sku = uniqueName('DUP');
      const first = await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), sku, currency: 'PHP' },
      });
      assert.equal(first.status, 201);
      const dupSku = await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), sku, currency: 'PHP' },
      });
      assert.equal(dupSku.status, 409);
      assert.equal(dupSku.json.code, 'PRODUCT_SKU_EXISTS');

      const barcode = uniqueName('DUPB');
      await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), barcode, currency: 'PHP' },
      });
      const dupBar = await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), barcode, currency: 'PHP' },
      });
      assert.equal(dupBar.status, 409);
      assert.equal(dupBar.json.code, 'PRODUCT_BARCODE_EXISTS');
    });

    it('validates product input (missing name, non-integer minimumStock)', async () => {
      const noName = await api('POST', '/api/products', { token: owner.token, body: {} });
      assert.equal(noName.status, 400);
      assert.ok(noName.json.fields.some((f) => f.field === 'name'));

      const fracMin = await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), minimumStock: 2.5, currency: 'PHP' },
      });
      assert.equal(fracMin.status, 400);
      assert.ok(fracMin.json.fields.some((f) => f.field === 'minimumStock'));
    });

    it('updates a product and audits PRODUCT_UPDATED; foreign category is rejected', async () => {
      const id = await productId({ sku: uniqueName('UPD'), sellingPrice: 3 });
      const upd = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: { sellingPrice: 4.99, name: 'Renamed Product' },
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.json.sellingPrice, 4.99);
      assert.ok(await auditExists('PRODUCT_UPDATED'));

      const otherCat = await api('POST', '/api/categories', {
        token: other.token,
        body: { name: uniqueName('ForeignCat') },
      });
      const bad = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: { categoryId: otherCat.json.id },
      });
      assert.equal(bad.status, 404);
      assert.equal(bad.json.code, 'CATEGORY_NOT_FOUND');
    });

    it('PATCH can clear a recorded field, while an omitted field stays untouched', async () => {
      const cat = await categoryId('Clearable');
      const id = await productId({
        brand: 'Brand To Clear',
        sku: uniqueName('CLEAR'),
        barcode: uniqueName('CLEARBAR'),
        description: 'Remove me',
        specifications: 'Remove these too',
        categoryId: cat,
        costPrice: 4,
        sellingPrice: 9,
        currency: 'PHP',
        unit: 'box',
        minimumStock: 5,
        imageUrl: 'https://example.com/clear.png',
      });

      const cleared = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: {
          brand: '',
          sku: '',
          barcode: '',
          description: '',
          specifications: '',
          categoryId: null,
          costPrice: '',
          sellingPrice: '',
          unit: '',
          minimumStock: '',
          imageUrl: '',
        },
      });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
      assert.equal(cleared.json.brand, null);
      assert.equal(cleared.json.sku, null);
      assert.equal(cleared.json.barcode, null);
      assert.equal(cleared.json.description, null);
      assert.equal(cleared.json.specifications, null);
      assert.equal(cleared.json.category, null);
      assert.equal(cleared.json.costPrice, 0);
      assert.equal(cleared.json.sellingPrice, 0);
      assert.equal(cleared.json.currency, 'PHP', 'currency is never cleared by an edit');
      assert.equal(cleared.json.unit, null);
      assert.equal(cleared.json.minimumStock, 0);
      assert.equal(cleared.json.imageUrl, null);

      const renamed = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: { name: 'Only the name changed' },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.json.name, 'Only the name changed');
      assert.equal(renamed.json.brand, null, 'an omitted field is not resurrected');

      const clearCurrency = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: { currency: '' },
      });
      assert.equal(clearCurrency.status, 400, JSON.stringify(clearCurrency.json));
      assert.ok(clearCurrency.json.fields.some((f) => f.field === 'currency'));
    });

    it('rejects an archived category on create and on a category change', async () => {
      const cat = await categoryId('Archived Cat');
      const archived = await api('POST', `/api/categories/${cat}/archive`, { token: owner.token });
      assert.equal(archived.status, 200);

      const create = await api('POST', '/api/products', {
        token: owner.token,
        body: { name: uniqueName('P'), categoryId: cat, currency: 'PHP' },
      });
      assert.equal(create.status, 409, JSON.stringify(create.json));
      assert.equal(create.json.code, 'CATEGORY_ARCHIVED');

      const id = await productId();
      const patch = await api('PATCH', `/api/products/${id}`, {
        token: owner.token,
        body: { categoryId: cat },
      });
      assert.equal(patch.status, 409, JSON.stringify(patch.json));
      assert.equal(patch.json.code, 'CATEGORY_ARCHIVED');
    });

    it('a repeated product create with the same Idempotency-Key returns one product', async () => {
      const key = 'op-catalog-create-1';
      const body = { name: uniqueName('Idempotent Product'), sku: uniqueName('IDEMP'), currency: 'PHP' };
      const first = await api('POST', '/api/products', {
        token: owner.token,
        body,
        headers: { 'Idempotency-Key': key },
      });
      assert.equal(first.status, 201, JSON.stringify(first.json));

      const second = await api('POST', '/api/products', {
        token: owner.token,
        body,
        headers: { 'Idempotency-Key': key },
      });
      assert.equal(second.status, 201, JSON.stringify(second.json));
      assert.equal(second.json.id, first.json.id, 'the retry replayed the first product');
    });

    it('a failed audit write after commit does not turn a saved product or category into a 500', async () => {
      const restore = stubAuditCreateToThrow();
      let created;
      let patched;
      let category;
      try {
        created = await api('POST', '/api/products', {
          token: owner.token,
          body: { name: uniqueName('Audit Safe Product'), currency: 'PHP' },
        });
        assert.equal(created.status, 201, JSON.stringify(created.json));

        patched = await api('PATCH', `/api/products/${created.json.id}`, {
          token: owner.token,
          body: { name: 'Audit Safe Renamed' },
        });
        assert.equal(patched.status, 200, JSON.stringify(patched.json));

        category = await api('POST', '/api/categories', {
          token: owner.token,
          body: { name: uniqueName('Audit Safe Category') },
        });
        assert.equal(category.status, 201, JSON.stringify(category.json));
      } finally {
        restore();
      }

      const got = await api('GET', `/api/products/${created.json.id}`, { token: owner.token });
      assert.equal(got.status, 200);
      assert.equal(got.json.name, 'Audit Safe Renamed');
      const gotCat = await api('GET', `/api/categories/${category.json.id}`, { token: owner.token });
      assert.equal(gotCat.status, 200);
    });

    it('archives and restores a product (PRODUCT_ARCHIVED audit)', async () => {
      const id = await productId();
      const arch = await api('POST', `/api/products/${id}/archive`, { token: owner.token });
      assert.equal(arch.status, 200);
      assert.equal(arch.json.status, 'ARCHIVED');
      assert.ok(await auditExists('PRODUCT_ARCHIVED'));

      const archOnly = await api('GET', `/api/products?status=ARCHIVED`, { token: owner.token });
      assert.ok(archOnly.json.items.some((p) => p.id === id));

      const rest = await api('POST', `/api/products/${id}/restore`, { token: owner.token });
      assert.equal(rest.json.status, 'ACTIVE');
    });

    it('searches by name/SKU and filters by category and status', async () => {
      const cat = await categoryId('Snacks');
      const p = await productId({ name: 'Saltines', categoryId: cat, status: 'ACTIVE' });
      const byName = await api('GET', `/api/products?q=salt`, { token: owner.token });
      assert.ok(byName.json.items.some((x) => x.id === p));

      const byCat = await api('GET', `/api/products?categoryId=${cat}`, { token: owner.token });
      assert.ok(byCat.json.items.some((x) => x.id === p));
      assert.ok(byCat.json.items.every((x) => x.category?.id === cat));
    });

    it('product reads are open to STAFF but writes are RBAC-gated', async () => {
      const staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
      const manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
      const id = await productId();

      const staffRead = await api('GET', `/api/products/${id}`, { token: staff.token });
      assert.equal(staffRead.status, 200);
      const staffCreate = await api('POST', '/api/products', {
        token: staff.token,
        body: { name: uniqueName('P'), currency: 'PHP' },
      });
      assert.equal(staffCreate.status, 403);

      const managerCreate = await api('POST', '/api/products', {
        token: manager.token,
        body: { name: uniqueName('PMgr'), currency: 'PHP' },
      });
      assert.equal(managerCreate.status, 201);

      const staffArchive = await api('POST', `/api/products/${id}/archive`, { token: staff.token });
      assert.equal(staffArchive.status, 403);
    });

    // Phase 21 — the lifecycle is archive-only. There is no product delete
    // endpoint, and this is the end-to-end proof of it: the request falls
    // through the products router to the shared 404 handler
    // (src/middlewares/notFound.js), which is all that happens to an
    // unimplemented method. Authentication never runs, so no token is implied.
    it('exposes no product delete endpoint — the lifecycle is archive-only', async () => {
      const id = await productId();

      const del = await api('DELETE', `/api/products/${id}`, { token: owner.token });
      assert.equal(del.status, 404);
      assert.equal(del.json.error, 'Not Found');

      // The product is untouched by the refused delete.
      const still = await api('GET', `/api/products/${id}`, { token: owner.token });
      assert.equal(still.status, 200);

      // The two transitions that DO exist are the terminal lifecycle surface.
      const arch = await api('POST', `/api/products/${id}/archive`, { token: owner.token });
      assert.equal(arch.status, 200);
      assert.equal(arch.json.status, 'ARCHIVED');

      const rest = await api('POST', `/api/products/${id}/restore`, { token: owner.token });
      assert.equal(rest.status, 200);
      assert.equal(rest.json.status, 'ACTIVE');
    });

    it('isolation: foreign product id is a 404 and list never leaks across businesses', async () => {
      const foreignProduct = await productId({}, other.token);
      const got = await api('GET', `/api/products/${foreignProduct}`, { token: owner.token });
      assert.equal(got.status, 404);
    });

    it('rejects non-ObjectId route ids (400)', async () => {
      for (const path of ['/api/products', '/api/categories', '/api/locations']) {
        const res = await api('GET', `${path}/not-an-id`, { token: owner.token });
        assert.equal(res.status, 400, `${path} invalid id`);
        assert.equal(res.json.code, 'INVALID_ID');
      }
    });
  });
});
