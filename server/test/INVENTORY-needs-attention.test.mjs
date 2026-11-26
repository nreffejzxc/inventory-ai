// FW-01 follow-up — Inventory row attention, canonical status and chip counts.
//
// The Inventory screen shows one row per product/location. A product can be low
// at one location and healthy at another, so every filter and count here must be
// row-local: that row's availability against its own product's minimum. Low and
// Out are disjoint (OUT takes precedence); Needs attention is exactly their
// union. One response carries all four counts, and each count must equal the
// `total` of the list that opens from it.
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

async function product(businessId, label, minimumStock) {
  return Product.create({ businessId, name: uniqueName(label), minimumStock, currency: 'PHP' });
}

async function row(businessId, productId, locationId, quantity) {
  return Inventory.create({ businessId, productId, locationId, quantity });
}

dbSuite('INVENTORY needsAttention row filter', dbOk, () => {
  it('keeps Low and Out disjoint, counts all four choices exactly and isolates tenants', async () => {
    const owner = await registerOwner(api, tracker);
    const other = await registerOwner(api, tracker);
    const businessId = owner.businessId;

    const front = await Location.create({ businessId, name: uniqueName('Attention Front') });
    const back = await Location.create({ businessId, name: uniqueName('Attention Back') });
    const otherLocation = await Location.create({ businessId: other.businessId, name: uniqueName('Foreign Store') });

    // Same product: low at Front (2 <= min 3), healthy at Back (20 > 3).
    // This is the multi-location case a summed product-level filter gets wrong.
    const split = await product(businessId, 'Attention Split', 3);
    await row(businessId, split._id, front._id, 2);
    await row(businessId, split._id, back._id, 20);

    // Empty at Front: out, and in the combined view but NOT in canonical Low.
    const empty = await product(businessId, 'Attention Empty', 2);
    await row(businessId, empty._id, front._id, 0);

    // Healthy at Front: must not appear in any attention/filter total.
    const healthy = await product(businessId, 'Attention Healthy', 2);
    await row(businessId, healthy._id, front._id, 10);

    // Low at Back only: proves the filter is not silently restricted to Front.
    const backLow = await product(businessId, 'Attention Back Low', 4);
    await row(businessId, backLow._id, back._id, 1);

    // Another tenant's low row must not leak into the caller's rows or counts.
    const foreignLow = await product(other.businessId, 'Foreign Attention Row', 5);
    await row(other.businessId, foreignLow._id, otherLocation._id, 1);

    const all = await api('GET', '/api/inventory?includeCounts=true&limit=100', {
      token: owner.token,
    });
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.total, 5);
    assert.deepEqual(all.json.counts, { all: 5, low: 2, out: 1, needsAttention: 3 });
    assert.equal(
      all.json.counts.low + all.json.counts.out,
      all.json.counts.needsAttention,
      'Needs attention is exactly Low + Out',
    );

    const low = await api(
      'GET',
      '/api/inventory?stockStatus=LOW_STOCK&includeCounts=true&limit=100',
      { token: owner.token },
    );
    assert.equal(low.status, 200, JSON.stringify(low.json));
    assert.equal(low.json.total, low.json.counts.low);
    assert.deepEqual(
      low.json.items.map((item) => item.product.name).sort(),
      [split.name, backLow.name].sort(),
    );
    assert.ok(
      low.json.items.every((item) => item.isLowStock && !item.isOutOfStock),
      'canonical Low never includes an out row',
    );

    const out = await api(
      'GET',
      '/api/inventory?stockStatus=OUT_OF_STOCK&includeCounts=true&limit=100',
      { token: owner.token },
    );
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.total, out.json.counts.out);
    assert.equal(out.json.items.length, 1);
    assert.equal(out.json.items[0].product.id, String(empty._id));

    const attention = await api(
      'GET',
      '/api/inventory?needsAttention=true&includeCounts=true&limit=100',
      { token: owner.token },
    );
    assert.equal(attention.status, 200, JSON.stringify(attention.json));
    assert.equal(attention.json.total, attention.json.counts.needsAttention);
    assert.deepEqual(
      attention.json.items.map((item) => item.product.name).sort(),
      [split.name, empty.name, backLow.name].sort(),
    );
    assert.ok(
      attention.json.items.every((item) => item.isLowStock || item.isOutOfStock),
      'every returned row carries a low/out state',
    );
    assert.ok(
      attention.json.items.every((item) => item.product.name !== healthy.name),
      'a healthy row is not part of the combined filter',
    );
    assert.ok(
      attention.json.items.every((item) => item.product.name !== foreignLow.name),
      'another tenant is never returned or counted',
    );

    // The counts are scoped by location, just like the list. The same product is
    // low at Front and healthy at Back, so Front contributes one low row and one
    // out row, never the product's summed availability.
    const frontOnly = await api(
      'GET',
      `/api/inventory?includeCounts=true&locationId=${front._id}&limit=100`,
      { token: owner.token },
    );
    assert.equal(frontOnly.status, 200, JSON.stringify(frontOnly.json));
    assert.deepEqual(frontOnly.json.counts, { all: 3, low: 1, out: 1, needsAttention: 2 });

    const backOnly = await api(
      'GET',
      `/api/inventory?needsAttention=true&locationId=${back._id}&limit=100`,
      { token: owner.token },
    );
    assert.equal(backOnly.status, 200, JSON.stringify(backOnly.json));
    assert.equal(backOnly.json.total, 1);
    assert.equal(backOnly.json.items[0].product.id, String(backLow._id));

    // Search narrows both the page and the counts; split has one low row and one
    // healthy row, so only the low one is counted.
    const searched = await api(
      'GET',
      `/api/inventory?includeCounts=true&q=${encodeURIComponent(split.name)}&limit=100`,
      { token: owner.token },
    );
    assert.equal(searched.status, 200, JSON.stringify(searched.json));
    assert.deepEqual(searched.json.counts, { all: 2, low: 1, out: 0, needsAttention: 1 });

    // The count is over the full scoped set, not the page size.
    const page1 = await api('GET', '/api/inventory?needsAttention=true&includeCounts=true&limit=2&page=1', {
      token: owner.token,
    });
    assert.equal(page1.status, 200, JSON.stringify(page1.json));
    assert.equal(page1.json.total, 3);
    assert.equal(page1.json.counts.needsAttention, 3);
    assert.equal(page1.json.items.length, 2);
    assert.equal(page1.json.totalPages, 2);

    const page2 = await api('GET', '/api/inventory?needsAttention=true&includeCounts=true&limit=2&page=2', {
      token: owner.token,
    });
    assert.equal(page2.status, 200, JSON.stringify(page2.json));
    assert.equal(page2.json.total, 3);
    assert.equal(page2.json.items.length, 1);

    // Combining with outOfStock is an intersection, not a union.
    const outOnly = await api(
      'GET',
      '/api/inventory?needsAttention=true&outOfStock=true&limit=100',
      { token: owner.token },
    );
    assert.equal(outOnly.status, 200, JSON.stringify(outOnly.json));
    assert.equal(outOnly.json.total, 1);
    assert.equal(outOnly.json.items[0].product.id, String(empty._id));

    // Legacy lowStock remains the broad row filter for existing API clients. Its
    // total can therefore exceed canonical `counts.low`, which deliberately
    // excludes out rows. The mobile screen uses stockStatus, never this flag.
    const legacyLow = await api('GET', '/api/inventory?lowStock=true&limit=100', {
      token: owner.token,
    });
    assert.equal(legacyLow.status, 200, JSON.stringify(legacyLow.json));
    assert.equal(legacyLow.json.total, 3);
    assert.ok(
      legacyLow.json.items.some((item) => item.isOutOfStock),
      'the legacy broad filter still includes out rows',
    );

    // Counts are opt-in; an ordinary list response keeps its old shape.
    const withoutCounts = await api('GET', '/api/inventory?limit=100', { token: owner.token });
    assert.equal(withoutCounts.status, 200, JSON.stringify(withoutCounts.json));
    assert.equal(withoutCounts.json.counts, undefined);

    const invalid = await api('GET', '/api/inventory?stockStatus=IN_STOCK', {
      token: owner.token,
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  });

  it('applies the canonical Out filter when a product search also narrows the list', async () => {
    const owner = await registerOwner(api, tracker);
    const businessId = owner.businessId;
    const location = await Location.create({ businessId, name: uniqueName('Search Out Location') });
    const product = await Product.create({
      businessId,
      name: uniqueName('Search Out Product'),
      minimumStock: 2,
      currency: 'PHP',
    });
    await row(businessId, product._id, location._id, 0);

    const res = await api(
      'GET',
      `/api/inventory?q=${encodeURIComponent(product.name)}&stockStatus=OUT_OF_STOCK&includeCounts=true`,
      { token: owner.token },
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.total, 1, 'the product-first path must not ignore the out filter');
    assert.equal(res.json.items.length, 1);
    assert.deepEqual(res.json.counts, { all: 1, low: 0, out: 1, needsAttention: 1 });
  });
});
