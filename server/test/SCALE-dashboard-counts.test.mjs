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
    // A zero minimum with zero stock is both low and out — the boundary of `<=`.
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
      17,
      'available <= minimum: the 9 above, plus low-only 6 and reserved-low 2',
    );
    assert.equal(s.inStockProducts, s.totalProducts - s.lowStockProducts, 'healthy is the complement, as §19 defines it');
    assert.equal(s.inStockProducts, 5, 'exactly the five comfortable rows');
    assert.equal(
      s.totalInventoryQuantity,
      605,
      'EVERY inventory row counts on-hand, archived included: 250 + 30 + 20 + 5 + 300',
    );
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
