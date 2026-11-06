// SEED-1 — the seed catalogue is real product data, not placeholder rows.
//
// The assistant's answers are only as useful as the rows it can read. A catalogue of
// "Premium Kettle 10001" cannot teach it a brand, a model, a specification or a real
// comparison. This suite pins the catalogue itself, the demo fixture that uses it, and
// the bulk seeder's product rows.

import 'dotenv/config';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import Product from '../src/models/product.model.ts';
import Category from '../src/models/category.model.ts';
import { seedTenant } from '../scripts/seed/lib.mjs';
import { CATALOG_CATEGORIES, CATALOG_PRODUCTS } from '../scripts/seed/catalog.mjs';
import { DEMO_CATEGORIES, DEMO_PRODUCTS } from '../scripts/demo/fixture.mjs';
import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const PLACEHOLDER = /\b(Demo|Seeded)\b|Premium .* \d{4,}|for AI scale testing/i;

function seedableProduct(product) {
  assert.ok(product.key && product.name, JSON.stringify(product));
  assert.ok(product.brand, `${product.name} has no brand`);
  assert.ok(product.category, `${product.name} has no category`);
  assert.ok(product.description && product.description.length >= 40, `${product.name} has a thin description`);
  assert.ok(product.specifications && product.specifications.includes(':'), `${product.name} has no recorded specifications`);
  assert.ok(product.unit, `${product.name} has no unit`);
  assert.ok(product.sellingPrice > 0, `${product.name} has no selling price`);
  assert.ok(product.costPrice > 0 && product.costPrice < product.sellingPrice, `${product.name} has unusable prices`);
  assert.match(product.sourceUrl, /^https:\/\//, `${product.name} has no source URL`);
  assert.doesNotMatch(`${product.name} ${product.description}`, PLACEHOLDER, `${product.name} is placeholder data`);
}

unitSuite('SEED-1 the curated catalogue is real and useful', () => {
  it('has a broad, sourced, fully described catalogue', () => {
    assert.ok(CATALOG_PRODUCTS.length >= 12, `only ${CATALOG_PRODUCTS.length} catalogue products`);
    assert.ok(new Set(CATALOG_PRODUCTS.map((product) => product.brand)).size >= 8, 'too few real brands');
    assert.equal(new Set(CATALOG_PRODUCTS.map((product) => product.category)).size, CATALOG_CATEGORIES.length);

    const keys = new Set();
    const names = new Set();
    for (const product of CATALOG_PRODUCTS) {
      seedableProduct(product);
      assert.ok(!keys.has(product.key), `duplicate catalogue key ${product.key}`);
      assert.ok(!names.has(product.name), `duplicate catalogue name ${product.name}`);
      keys.add(product.key);
      names.add(product.name);
      assert.ok(
        CATALOG_CATEGORIES.some((category) => category.key === product.category),
        `${product.name} uses an unknown category ${product.category}`,
      );
    }
  });

  it('★ the perf seeder writes the curated catalogue, not generated names', () => {
    const source = readFileSync(new URL('../scripts/seed-perf-data.mjs', import.meta.url), 'utf8');
    assert.match(source, /catalogProductAt/);
    assert.match(source, /template\.brand/);
    assert.match(source, /template\.description/);
    assert.match(source, /template\.specifications/);
    assert.doesNotMatch(source, /ADJECTIVES|NOUNS|Seeded row/);
  });

  it('★ the demo fixture uses real names, brands, descriptions and specifications', () => {
    assert.equal(DEMO_PRODUCTS.length, CATALOG_PRODUCTS.length);
    assert.equal(DEMO_CATEGORIES.length, CATALOG_CATEGORIES.length);
    for (const product of DEMO_PRODUCTS) {
      assert.ok(product.brand, `${product.name} has no brand`);
      assert.ok(product.description && product.description.length >= 40, `${product.name} has a thin description`);
      assert.ok(product.specifications && product.specifications.includes(':'), `${product.name} has no specifications`);
      assert.doesNotMatch(product.name, PLACEHOLDER);
    }
    assert.equal(new Set(DEMO_PRODUCTS.map((product) => product.sku)).size, DEMO_PRODUCTS.length);
  });
});

dbSuite('SEED-1 the bulk seeder writes the curated catalogue', dbOk, () => {
  let owner;

  before(async () => {
    owner = await registerOwner(api, tracker);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('★ every generated product is a real, described, specification-bearing row', async () => {
    const total = 100; // → 23 products
    const result = await seedTenant({
      businessId: owner.businessId,
      userId: owner.userId,
      total,
      rand: () => 0.42,
      includeSku: false,
      includeBarcode: false,
      label: 'CATALOG',
    });
    assert.equal(result.counts.products, 23, JSON.stringify(result));

    const products = await Product.find({ businessId: owner.businessId }).lean();
    assert.equal(products.length, 23);
    const names = new Set(CATALOG_PRODUCTS.map((product) => product.name));
    const categories = new Set(CATALOG_CATEGORIES.map((category) => category.name));

    for (const product of products) {
      assert.ok(names.has(product.name), `generated placeholder product ${product.name}`);
      assert.ok(product.brand && product.brand.length > 1, `${product.name} has no brand`);
      assert.ok(product.description && product.description.length >= 40, `${product.name} has no description`);
      assert.ok(product.specifications && product.specifications.includes(':'), `${product.name} has no specifications`);
      assert.ok(product.categoryId, `${product.name} has no category`);
      assert.doesNotMatch(`${product.name} ${product.description}`, PLACEHOLDER);
    }

    for (const category of await Product.distinct('categoryId', { businessId: owner.businessId })) {
      assert.ok(category);
    }
    const categoryNames = await Category.find({ businessId: owner.businessId }).select('name').lean();
    for (const name of categoryNames.map((row) => row.name)) assert.ok(categories.has(name), name);
  });
});
