// SCALE — the dashboard's health counts stay exact, and stay computed in the database.
//
// WHY THIS EXISTS. On 2026-10-14 a real tenant was measured at **50 625 products /
// 101 374 inventory rows** and the dashboard took **3 983–5 422 ms** (413 ms at 10 000
// products the day before). The old implementation answered correctly, so no existing
// test was red: it fetched the ENTIRE catalogue into the API process, built a Map of
// per-product availability from a second full inventory scan, and counted in
// JavaScript — ~200 000 documents moved per dashboard load to produce six integers.
// The rewrite computes the same six integers in one aggregation that returns a single
// document. `perf:golden` proved the rewrite output-identical on that 50 625-product
// tenant (17/17 cases byte-for-byte); this suite guards the two things a golden capture
// cannot: that the NUMBERS are right on a dataset built to hit every branch at once,
// and that the shape which shipped the catalogue to the process cannot come back
// unnoticed.
//
// The dataset is deliberately small and hand-counted — five numbers, every branch
// named — because the point is the arithmetic, not the volume. Volume is what the
// timing harnesses measure, and a test that asserted seconds would be flaky.
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import Product from '../src/models/product.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import Location from '../src/models/location.model.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SOURCE = readFileSync(
  path.resolve(here, '../src/services/dashboard.service.ts'),
  'utf8',
);
// The comment-stripper is load-bearing, so it is pinned here: without it the scan below
// fires on the file's own explanatory prose, and a guard that reddens on its own
// documentation is a guard nobody keeps.
function selfTestCommentStripper() {
  const sample = "/* Product.find( in a comment */\n// Product.find( too\nconst x = 'Product.find(';\nconst y = /Product.find(/;";
  const body = code(sample);
  assert.doesNotMatch(body, /Product\.find\(\s*in/);
  assert.match(code('const p = Product.find({}).lean();'), /Product\.find\(/, 'real code must survive stripping');
}


/**
 * Source with comments and string literals removed, so the scan reads CODE.
 *
 * This is not tidiness — the first version of this guard scanned raw text and failed
 * on its own documentation, because the explanatory comment in `dashboard.service.ts`
 * quotes the shape it replaced (`Product.find(...).select('_id minimumStock')`). That is
 * exactly the bug §27BP records for a different guard ("a guard that failed on its own
 * documentation"), and the fix is the same one: a source scanner has to say which text
 * it means. Block comments, line comments and quoted strings are stripped here.
 */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * The shapes that mean "the whole catalogue crosses the wire for one dashboard load".
 *
 * Scoped to this ONE file on purpose: in it, each of these is a document-moving read
 * of the tenant's catalogue or ledger, and the summary's job is to need none of them.
 * `Product.countDocuments` is deliberately absent from the list — a count is an index
 * scan that returns a number, which is exactly the kind of read this shape is for.
 */
function catalogueReads(source) {
  const body = code(source);
  const findings = [];
  if (/Product\.find\(/.test(body)) findings.push('Product.find(');
  if (/Inventory\.aggregate\(/.test(body)) findings.push('Inventory.aggregate(');
  if (/activeCatalogue/.test(body)) findings.push('activeCatalogue');
  return findings;
}

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  // The listening HTTP server is closed explicitly, and that is not tidiness: an
  // unclosed listener keeps the event loop alive, so this file's two assertions passed
  // while the FILE failed — `node --test` waits for the child to exit and timed out at
  // 420 s with a green suite inside it. Every DB suite that calls `startServer()` owes
  // this line.
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

/** A product with the given status, plus its optional single inventory row. */
async function seedProduct(businessId, locationId, { name, minimumStock, status = 'ACTIVE', quantity = null, reservedQuantity = 0 }) {
  const product = await Product.create({ businessId, name, minimumStock, status, currency: 'PHP' });
  if (quantity !== null) {
    await Inventory.create({ businessId, productId: product._id, locationId, quantity, reservedQuantity });
  }
  return product;
}

dbSuite('SCALE the dashboard summary at scale', dbOk, () => {
  it('★ counts every branch exactly, from one aggregation, on a hand-counted dataset', async () => {
    const owner = await registerOwner(api, tracker);
    const businessId = owner.businessId;
    const location = await Location.create({ businessId, name: 'Scale Guard Store' });

    // ---- the dataset, branch by branch -------------------------------------------------
    // No inventory row at all: §19 says that is ZERO stock, not missing stock.
    for (let i = 0; i < 3; i += 1) {
      await seedProduct(businessId, location._id, { name: `No Row ${i}`, minimumStock: 10 });
    }
    // A row that is present and empty.
    for (let i = 0; i < 4; i += 1) {
      await seedProduct(businessId, location._id, { name: `Empty ${i}`, minimumStock: 10, quantity: 0 });
    }
    // Comfortably above the minimum — the only healthy rows in the set.
    for (let i = 0; i < 5; i += 1) {
      await seedProduct(businessId, location._id, { name: `Healthy ${i}`, minimumStock: 10, quantity: 50 });
    }
    // Below the minimum but not empty: low, not out.
    for (let i = 0; i < 6; i += 1) {
      await seedProduct(businessId, location._id, { name: `Low Only ${i}`, minimumStock: 10, quantity: 5 });
    }
    // Reserved quantity is what decides these two: 10 - 8 = 2 available, and 5 - 5 = 0.
    for (let i = 0; i < 2; i += 1) {
      await seedProduct(businessId, location._id, { name: `Reserved ${i}`, minimumStock: 5, quantity: 10, reservedQuantity: 8 });
    }
    await seedProduct(businessId, location._id, { name: 'Reserved Empty', minimumStock: 0, quantity: 5, reservedQuantity: 5 });
    // A zero minimum with zero stock is OUT, never also LOW — OUT takes precedence.
    await seedProduct(businessId, location._id, { name: 'Zero Minimum', minimumStock: 0, quantity: 0 });
    // ARCHIVED with stock: its units count toward on-hand, it is not a product and not low.
    for (let i = 0; i < 3; i += 1) {
      await seedProduct(businessId, location._id, { name: `Archived ${i}`, minimumStock: 10, status: 'ARCHIVED', quantity: 100 });
    }

    const res = await api('GET', '/api/dashboard', { token: owner.token });
    assert.equal(res.status, 200);
    const s = res.json;

    assert.equal(s.totalProducts, 22, 'ACTIVE products only: 3+4+5+6+2+1+1');
    assert.equal(s.outOfStockProducts, 9, 'available <= 0: no-row 3, empty 4, reserved-empty 1, zero-minimum 1');
    assert.equal(
      s.lowStockProducts,
      8,
      '0 < available <= minimum: low-only 6 plus reserved-low 2; the 9 OUT products are a separate status',
    );
    assert.equal(
      s.inStockProducts,
      s.totalProducts - s.lowStockProducts - s.outOfStockProducts,
      'healthy is the complement of the disjoint low and out sets, as §19 defines it',
    );
    assert.equal(s.inStockProducts, 5, 'exactly the five comfortable rows');
    assert.equal(
      s.totalInventoryQuantity,
      605,
      'EVERY inventory row counts on-hand, archived included: 250 + 30 + 20 + 5 + 300',
    );
  });

  it('★ every Overview count has exactly the product-level list behind it', async () => {
    const owner = await registerOwner(api, tracker);
    const businessId = owner.businessId;
    const front = await Location.create({ businessId, name: 'Overview Front' });
    const back = await Location.create({ businessId, name: 'Overview Back' });

    async function product(name, minimumStock, rows = [], status = 'ACTIVE') {
      const doc = await Product.create({ businessId, name, minimumStock, status, currency: 'PHP' });
      for (const [locationId, quantity] of rows) {
        await Inventory.create({ businessId, productId: doc._id, locationId, quantity });
      }
      return doc;
    }

    // Four ACTIVE products: two healthy, one low, one out. The split product has
    // a low-looking row at EACH location but 4 available in total, which is the
    // exact case that made the old row-based links disagree with the card.
    const healthy = await product('Overview Healthy', 5, [[front._id, 10]]);
    const low = await product('Overview Low', 3, [[front._id, 3]]);
    const out = await product('Overview Out', 1);
    const split = await product('Overview Split', 3, [[front._id, 2], [back._id, 2]]);
    const archivedOut = await product('Overview Archived Out', 10, [], 'ARCHIVED');

    const dash = await api('GET', '/api/dashboard', { token: owner.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.json));
    assert.equal(dash.json.totalProducts, 4, 'ACTIVE only: archived products are excluded');
    assert.equal(dash.json.inStockProducts, 2, 'healthy + split (summed availability 4 > minimum 3)');
    assert.equal(dash.json.lowStockProducts, 1, 'low only; out is a separate status');
    assert.equal(dash.json.outOfStockProducts, 1, 'out only; it is not also low');
    assert.equal(
      dash.json.inStockProducts + dash.json.lowStockProducts + dash.json.outOfStockProducts,
      dash.json.totalProducts,
      'the three statuses partition the ACTIVE catalogue',
    );

    async function listed(stockStatus) {
      const query = stockStatus ? `&stockStatus=${stockStatus}` : '';
      const res = await api('GET', `/api/products?status=ACTIVE${query}&limit=100`, { token: owner.token });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json;
    }

    const inList = await listed('IN_STOCK');
    const lowList = await listed('LOW_STOCK');
    const outList = await listed('OUT_OF_STOCK');
    const activeList = await listed('');

    assert.equal(inList.total, dash.json.inStockProducts);
    assert.equal(lowList.total, dash.json.lowStockProducts);
    assert.equal(outList.total, dash.json.outOfStockProducts);
    assert.equal(activeList.total, dash.json.totalProducts);

    const ids = (page) => page.items.map((item) => item.id).sort();
    assert.deepEqual(ids(inList), [String(healthy._id), String(split._id)].sort());
    assert.deepEqual(ids(lowList), [String(low._id)]);
    assert.deepEqual(ids(outList), [String(out._id)]);
    assert.equal(
      new Set([...ids(inList), ...ids(lowList), ...ids(outList)]).size,
      dash.json.totalProducts,
      'no product is counted in two lists and none is missing',
    );
    assert.ok(!ids(activeList).includes(String(archivedOut._id)), 'the Active card excludes archived products');

    // The old destinations demonstrate the bug this test prevents: inventory rows
    // are per location, so the split product appears here twice even though the
    // Overview correctly calls it healthy.
    const rowLow = await api(
      'GET',
      `/api/inventory?lowStock=true&locationId=${front._id}&limit=100`,
      { token: owner.token },
    );
    assert.equal(rowLow.status, 200, JSON.stringify(rowLow.json));
    assert.equal(rowLow.json.total, 2, 'front-location rows: low + the split product\u2019s low-looking row');
    assert.ok(
      rowLow.json.items.some((row) => row.product.id === String(split._id)),
      'inventory-row counts cannot be compared with a product-level card',
    );

    const bad = await api('GET', '/api/products?stockStatus=BOGUS', { token: owner.token });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'VALIDATION_ERROR');
    assert.equal(bad.json.fields?.[0]?.field, 'stockStatus');
  });

  it('never ships the catalogue to the API process to count it', async () => {
    selfTestCommentStripper();
    // The rewrite's whole benefit is where the counting happens, and no functional test
    // can see that: both shapes return the same numbers (which is why perf:golden was
    // needed to prove the rewrite safe). So the SHAPE is pinned here instead — the merge
    // that keeps the counts server-side must be present, and the document-moving reads
    // must be absent.
    assert.match(
      code(DASHBOARD_SOURCE),
      /\$unionWith/,
      'the merge that computes the counts inside MongoDB is gone from dashboard.service.ts',
    );
    assert.deepEqual(
      catalogueReads(DASHBOARD_SOURCE),
      [],
      'dashboard.service.ts reads the catalogue/ledger into this process again',
    );

    // POSITIVE CONTROL — a guard that cannot fail is decoration. The old implementation is
    // reconstructed IN MEMORY (nothing is written to disk) and the analyser must fire on
    // it, so a future edit that reintroduces the shape is reported rather than absorbed.
    //
    // The mutation is applied to the STRIPPED text, because that is the text the analyser
    // reads: `$unionWith` also appears in the file's explanatory comment, and a mutation
    // that edited the prose would leave the code untouched and prove nothing.
    const stripped = code(DASHBOARD_SOURCE);
    const legacy = `${stripped.replace('$unionWith', 'Inventory.aggregate([')}
const activeCatalogue = await Product.find().lean();
`;
    assert.notEqual(legacy, stripped, 'the positive control failed to mutate the source');
    assert.deepEqual(
      catalogueReads(legacy).sort(),
      ['Inventory.aggregate(', 'Product.find(', 'activeCatalogue'],
      'the guard did not recognise the shape it exists to catch',
    );
  });
});
