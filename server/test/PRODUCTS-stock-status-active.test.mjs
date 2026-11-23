// PRODUCT stock-status queries are ACTIVE-catalogue views.
//
// The mobile Products chips send status=ACTIVE, but the server is the security
// and integrity boundary: a direct `/api/products?stockStatus=LOW_STOCK` request
// must not return an archived product, and an explicit status=ARCHIVED must not
// widen that view. The legacy lowStock/outOfStock flags keep their historical
// status behaviour, which is covered as a control rather than changed here.
import { after, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Product from '../src/models/product.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import Location from '../src/models/location.model.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

async function product(businessId, label, { status = 'ACTIVE', minimumStock = 0 } = {}) {
  return Product.create({
    businessId,
    name: uniqueName(label),
    minimumStock,
    status,
    currency: 'PHP',
  });
}

async function stock(businessId, productId, locationId, quantity) {
  return Inventory.create({ businessId, productId, locationId, quantity });
}

dbSuite('PRODUCT stockStatus active-only guard', dbOk, () => {
  it('never returns an archived product for any canonical stockStatus', async () => {
    const owner = await registerOwner(api, tracker);
    const businessId = owner.businessId;
    const location = await Location.create({ businessId, name: uniqueName('Guard Store') });

    const fixtures = [
      { status: 'IN_STOCK', minimumStock: 0, quantity: 10 },
      { status: 'LOW_STOCK', minimumStock: 5, quantity: 2 },
      { status: 'OUT_OF_STOCK', minimumStock: 5, quantity: 0 },
    ];
    const activeByStatus = new Map();
    for (const fixture of fixtures) {
      const active = await product(businessId, `Active ${fixture.status}`, {
        minimumStock: fixture.minimumStock,
      });
      const archived = await product(businessId, `Archived ${fixture.status}`, {
        status: 'ARCHIVED',
        minimumStock: fixture.minimumStock,
      });
      await stock(businessId, active._id, location._id, fixture.quantity);
      await stock(businessId, archived._id, location._id, fixture.quantity);
      activeByStatus.set(fixture.status, String(active._id));
    }

    for (const fixture of fixtures) {
      for (const suffix of ['', '&status=ARCHIVED', '&status=ACTIVE']) {
        const res = await api(
          'GET',
          `/api/products?stockStatus=${fixture.status}&limit=100${suffix}`,
          { token: owner.token },
        );
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.equal(res.json.total, 1, `${fixture.status}${suffix} total`);
        assert.equal(res.json.items.length, 1);
        assert.equal(res.json.items[0].id, activeByStatus.get(fixture.status));
        assert.equal(res.json.items[0].status, 'ACTIVE');
        assert.equal(
          res.json.items.every((item) => item.status !== 'ARCHIVED'),
          true,
          `${fixture.status}${suffix} must not include an archived row`,
        );
      }
    }
  });

  it('leaves legacy stock filters and ordinary status filters unchanged', async () => {
    const owner = await registerOwner(api, tracker);
    const businessId = owner.businessId;
    const location = await Location.create({ businessId, name: uniqueName('Legacy Store') });

    const activeLow = await product(businessId, 'Active Low', { minimumStock: 5 });
    const archivedLow = await product(businessId, 'Archived Low', {
      status: 'ARCHIVED',
      minimumStock: 5,
    });
    const archivedOut = await product(businessId, 'Archived Out', {
      status: 'ARCHIVED',
      minimumStock: 5,
    });
    await stock(businessId, activeLow._id, location._id, 2);
    await stock(businessId, archivedLow._id, location._id, 2);
    await stock(businessId, archivedOut._id, location._id, 0);

    // Legacy filters are deliberately not archive-guarded: existing API clients
    // retain the old ability to combine them with an explicit ARCHIVED status.
    const archivedLegacyLow = await api(
      'GET',
      '/api/products?lowStock=true&status=ARCHIVED&limit=100',
      { token: owner.token },
    );
    assert.equal(archivedLegacyLow.status, 200, JSON.stringify(archivedLegacyLow.json));
    assert.deepEqual(
      archivedLegacyLow.json.items.map((item) => item.id).sort(),
      [String(archivedLow._id), String(archivedOut._id)].sort(),
      'legacy lowStock stays broad and still includes out-of-stock rows',
    );

    const archivedLegacyOut = await api(
      'GET',
      '/api/products?outOfStock=true&status=ARCHIVED&limit=100',
      { token: owner.token },
    );
    assert.equal(archivedLegacyOut.status, 200, JSON.stringify(archivedLegacyOut.json));
    assert.deepEqual(
      archivedLegacyOut.json.items.map((item) => item.id),
      [String(archivedOut._id)],
    );

    const archivedAll = await api('GET', '/api/products?status=ARCHIVED&limit=100', {
      token: owner.token,
    });
    assert.equal(archivedAll.status, 200, JSON.stringify(archivedAll.json));
    assert.equal(archivedAll.json.total, 2);

    const activeAll = await api('GET', '/api/products?status=ACTIVE&limit=100', {
      token: owner.token,
    });
    assert.equal(activeAll.status, 200, JSON.stringify(activeAll.json));
    assert.deepEqual(
      activeAll.json.items.map((item) => item.id),
      [String(activeLow._id)],
    );
  });
});
