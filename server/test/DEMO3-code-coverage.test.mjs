// DEMO-3 — the code-mode half of `verify:demo`, against real MongoDB.
//
// A seed can ask for `both`, `sku`, `barcode` or `none`, and the command can print the
// mode it intended. That is evidence about the plan, not the products. This suite reads
// products carrying every combination, including a mixed tenant, through the SAME
// counter the verifier uses, so a missing field or a mis-paired count is caught by the
// database rather than by the seeder's own report. Two more rows carry a wrong EAN-13
// check digit and a non-EAN-13 value, so the barcode-health half is read from real
// documents rather than only from hand-built arrays.
//
// The helper is read-only. Its source is scanned for a write call; this suite only
// creates its own fixture and removes it afterwards.

import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';

// `helpers.mjs` loads dotenv first; the model and script imports below read the
// environment when they are evaluated, so this import must stay ahead of them.
import { disconnectDb, ensureDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';

import mongoose from 'mongoose';
import Product from '../src/models/product.model.ts';
import { ean13Value } from '../src/utils/internalBarcode.ts';
import { readProductCodeCoverage } from '../scripts/demo/codeCoverage.mjs';
import {
  barcodeHealthProblem,
  classifyBarcodeHealth,
  classifyCodeCoverage,
  codeCoverageProblem,
  formatBarcodeHealth,
  formatCodeCoverage,
} from '../scripts/demo/verify.mjs';

const { ObjectId } = mongoose.Types;

const dbOk = await ensureDb();

const bothBusiness = new ObjectId();
const skuBusiness = new ObjectId();
const barcodeBusiness = new ObjectId();
const noneBusiness = new ObjectId();
const mixedBusiness = new ObjectId();
const emptyBusiness = new ObjectId();
const invalidBarcodeBusiness = new ObjectId();
const nonEanBarcodeBusiness = new ObjectId();

const businesses = [
  bothBusiness,
  skuBusiness,
  barcodeBusiness,
  noneBusiness,
  mixedBusiness,
  emptyBusiness,
  invalidBarcodeBusiness,
  nonEanBarcodeBusiness,
];

/** One product with exactly the fields its tenant's mode allows. */
function product(businessId, index, { sku = false, barcode = false, barcodeValue } = {}) {
  const doc = { businessId, name: `DEMO3 product ${index}`, currency: 'PHP' };
  if (sku) doc.sku = `DEMO3-SKU-${String(businessId).slice(-4)}-${index}`;
  if (barcodeValue !== undefined) doc.barcode = barcodeValue;
  else if (barcode) doc.barcode = ean13Value(`200000000${String(index).padStart(3, '0')}`);
  return doc;
}

dbSuite('DEMO-3 code coverage reads the products, not the seed plan', dbOk, () => {
  before(async () => {
    if (!dbOk) return;

    await Product.insertMany([
      product(bothBusiness, 1, { sku: true, barcode: true }),
      product(bothBusiness, 2, { sku: true, barcode: true }),
      product(bothBusiness, 3, { sku: true, barcode: true }),

      product(skuBusiness, 1, { sku: true }),
      product(skuBusiness, 2, { sku: true }),

      product(barcodeBusiness, 1, { barcode: true }),
      product(barcodeBusiness, 2, { barcode: true }),
      product(barcodeBusiness, 3, { barcode: true }),
      product(barcodeBusiness, 4, { barcode: true }),

      product(noneBusiness, 1),
      product(noneBusiness, 2),
      product(noneBusiness, 3),
      product(noneBusiness, 4),
      product(noneBusiness, 5),

      product(mixedBusiness, 1, { sku: true, barcode: true }),
      product(mixedBusiness, 2, { sku: true }),
      product(mixedBusiness, 3, { barcode: true }),
      product(mixedBusiness, 4),

      // Valid on the left, one deliberately wrong check digit on the right.
      product(invalidBarcodeBusiness, 1, { barcode: true }),
      product(invalidBarcodeBusiness, 2, { barcodeValue: '2000000000001' }),

      // A manufacturer code that is not EAN-13: reported, never failed.
      product(nonEanBarcodeBusiness, 1, { barcodeValue: 'ABC-123' }),
    ]);
  });

  after(async () => {
    if (dbOk) {
      await Product.deleteMany({ businessId: { $in: businesses } });
    }
    await disconnectDb();
  });

  it('counts both, SKU-only, barcode-only and neither from real rows', async () => {
    const both = classifyCodeCoverage(await readProductCodeCoverage(bothBusiness));
    assert.deepEqual(both, {
      total: 3,
      withSku: 3,
      withBarcode: 3,
      both: 3,
      skuOnly: 0,
      barcodeOnly: 0,
      neither: 0,
      mode: 'both',
    });

    const sku = classifyCodeCoverage(await readProductCodeCoverage(skuBusiness));
    assert.deepEqual(sku, {
      total: 2,
      withSku: 2,
      withBarcode: 0,
      both: 0,
      skuOnly: 2,
      barcodeOnly: 0,
      neither: 0,
      mode: 'sku',
    });

    const barcode = classifyCodeCoverage(await readProductCodeCoverage(barcodeBusiness));
    assert.deepEqual(barcode, {
      total: 4,
      withSku: 0,
      withBarcode: 4,
      both: 0,
      skuOnly: 0,
      barcodeOnly: 4,
      neither: 0,
      mode: 'barcode',
    });

    const none = classifyCodeCoverage(await readProductCodeCoverage(noneBusiness));
    assert.deepEqual(none, {
      total: 5,
      withSku: 0,
      withBarcode: 0,
      both: 0,
      skuOnly: 0,
      barcodeOnly: 0,
      neither: 5,
      mode: 'none',
    });
  });

  it('calls a tenant with more than one combination MIXED and names it in the mismatch', async () => {
    const mixed = classifyCodeCoverage(await readProductCodeCoverage(mixedBusiness));
    assert.deepEqual(mixed, {
      total: 4,
      withSku: 2,
      withBarcode: 2,
      both: 1,
      skuOnly: 1,
      barcodeOnly: 1,
      neither: 1,
      mode: 'mixed',
    });

    assert.equal(
      formatCodeCoverage(mixed),
      'Codes    : 1 both, 1 SKU only, 1 barcode only, 1 neither — MIXED',
    );
    assert.match(
      codeCoverageProblem(mixed, 'both'),
      /code coverage is MIXED, expected both — 4 products: 1 both, 1 SKU only, 1 barcode only, 1 neither/,
    );
    assert.match(
      codeCoverageProblem(mixed, 'none'),
      /code coverage is MIXED, expected none/,
    );
  });

  it('flags an invalid EAN-13 check digit from real rows', async () => {
    const raw = await readProductCodeCoverage(invalidBarcodeBusiness);
    const health = classifyBarcodeHealth(raw.barcodes);

    assert.equal(raw.barcode, 2);
    assert.equal(raw.barcodes.length, 2);
    assert.deepEqual(health, {
      present: 2,
      valid: 1,
      invalid: 1,
      notEan13: 0,
      duplicateValues: 0,
      duplicateRows: 0,
    });
    assert.equal(
      formatBarcodeHealth(health),
      'Barcodes : 2 present — 1 valid EAN-13, 1 invalid check digit, 0 duplicate values, 0 non-EAN-13',
    );
    assert.equal(barcodeHealthProblem(health), '1 barcode carries an invalid EAN-13 check digit');
  });

  it('counts a non-EAN-13 barcode without failing it', async () => {
    const raw = await readProductCodeCoverage(nonEanBarcodeBusiness);
    const health = classifyBarcodeHealth(raw.barcodes);

    assert.equal(raw.barcodes.length, 1);
    assert.equal(health.present, 1);
    assert.equal(health.valid, 0);
    assert.equal(health.invalid, 0);
    assert.equal(health.notEan13, 1);
    assert.equal(barcodeHealthProblem(health), null);
  });

  it('reports an empty tenant as empty rather than claiming none', async () => {
    const empty = classifyCodeCoverage(await readProductCodeCoverage(emptyBusiness));
    assert.equal(empty.total, 0);
    assert.equal(empty.mode, 'empty');
    assert.equal(codeCoverageProblem(empty, 'none'), null);
  });
});

// DUPLICATE BARCODES are asserted on the pure classifier in DEMO1. The model's partial
// unique (businessId, barcode) index makes a duplicate impossible to insert here while the
// suite has created the indexes, and dropping it to manufacture one would break every other
// DB suite sharing this collection. The verifier keeps the check as a defensive read: a
// legacy tenant, or a deployment whose index is missing, can still contain duplicates.
