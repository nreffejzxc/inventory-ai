// `npm run seed:perf -- --size=N` — create ONE isolated, clearly-marked tenant of
// realistic inventory data, for measuring how the app and the AI assistant behave
// as a business grows.
//
// WHY A SCRIPT AND NOT A TEST FIXTURE. The point is to measure latency and query
// plans at sizes a test fixture never reaches, and to do it against the SAME
// database the local server serves — so the phone, the REST routes and the AI
// tools all see the seeded rows. It is therefore a tool an operator runs, not
// something CI executes.
//
// SAFETY: `assertSafeTarget` (scripts/perf/lib.mjs) refuses production, refuses
// the test database, and requires SEED_CONFIRM, all before a connection is opened.
// This script then touches only its OWN tenant: a re-run deletes exactly the
// tenant its markers identify, and every delete filter is scoped to that
// businessId. No other business's documents are read, changed or deleted, and no
// credential is ever printed.
//
// DETERMINISTIC. The data comes from a seeded PRNG (`--seed`, default 1), so 1,000
// rows are the same 1,000 rows on every machine and every run. Without that,
// stage 1 and stage 2 would be different datasets and comparing their timings
// would mean nothing.
//
// THE PRODUCTS ARE REAL. Every row cycles the curated catalogue in
// `seed/catalog.mjs` (14 sourced products across four categories), so even a
// large measurement tenant carries actual names, brands, descriptions and
// specifications. A generated "Premium Kettle 1001" has nothing for the
// assistant to search or compare, which makes the measurements measure the
// fixture rather than the assistant.
//
// Usage:
//   SEED_CONFIRM=seed-perf-ai npm run seed:perf -- --size=100
//   SEED_CONFIRM=seed-perf-ai npm run seed:perf -- --size=1000 --seed=1
//
// Teardown: `npm run cleanup:perf` — never touches anything but this tenant.

import 'dotenv/config';
import mongoose from 'mongoose';

import env from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import Category from '../src/models/category.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import User from '../src/models/user.model.ts';
import {
  SEED_BUSINESS_NAME,
  SEED_OWNER_EMAIL,
  SeedSafetyError,
  assertSafeTarget,
  findSeedTenantIds,
  removeTenant,
} from './perf/lib.mjs';
import { CATALOG_CATEGORIES, catalogProductAt } from './seed/catalog.mjs';
import { parseCount } from './seed/lib.mjs';

const COMMAND = 'seed:perf';

const LOCATIONS = ['Main Warehouse', 'Shop Front', 'Overflow Store'];
const CATEGORY_NAMES = CATALOG_CATEGORIES.map((category) => category.name);

function argValue(flag, argv = process.argv) {
  const prefix = `${flag}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exit(1);
}

/** Small deterministic PRNG (mulberry32) — same seed, same dataset, everywhere. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

/** The PRNG MUST replay identically — asserted, not assumed. */
function assertDeterministic(seed) {
  const a = makeRandom(seed);
  const b = makeRandom(seed);
  for (let i = 0; i < 5; i += 1) {
    if (a() !== b()) throw new SeedSafetyError('the PRNG did not replay identically');
  }
}

async function main() {
  // Strict whole numbers: parseInt accepted `900abc` as 900 and `12.9` as 12, so a
  // mistyped size seeded a plausible-looking dataset nobody asked for.
  const size = parseCount(argValue('--size'), { name: '--size', min: 1, max: 200000 });
  const seed = parseCount(argValue('--seed'), { name: '--seed', min: 0, fallback: 1 });
  // The dataset depends on nothing already stored, so the preview needs no connection at all: the
  // plan IS the whole answer. `--dry-run` used to be silently ignored here (the flag was only
  // mentioned for the cleanup), which on a live database meant writing during a "preview".
  const dryRun = process.argv.includes('--dry-run');

  assertSafeTarget(env, COMMAND);
  assertDeterministic(seed);

  console.log(`[${COMMAND}] database : ${env.mongodbDbName}`);
  console.log(`[${COMMAND}] products : ${size}   locations: ${LOCATIONS.length}   categories: ${CATEGORY_NAMES.length}`);
  console.log(`[${COMMAND}] PRNG seed: ${seed} (the dataset is reproducible)`);

  if (dryRun) {
    console.log(`[${COMMAND}] mode     : DRY RUN — would replace any existing seed tenant`);
    console.log(`[${COMMAND}] DRY RUN — no connection was opened and nothing was written.`);
    return;
  }

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });

  const started = Date.now();
  const rand = makeRandom(seed);

  // ---- the previous run of THIS tenant, removed by id only ----
  const staleIds = await findSeedTenantIds();
  if (staleIds.length) {
    const { removed } = await removeTenant(staleIds);
    console.log(`[${COMMAND}] reset   : removed a previous seed tenant (${removed} document(s))`);
  }

  // ---- the tenant ----
  const business = await Business.create({ name: SEED_BUSINESS_NAME, status: 'ACTIVE' });
  const businessId = business._id;
  const owner = await User.create({
    businessId,
    name: 'Perf Seed Owner',
    email: SEED_OWNER_EMAIL,
    role: 'OWNER',
    status: 'ACTIVE',
  });

  const categories = await Category.insertMany(
    CATEGORY_NAMES.map((name) => ({ businessId, name, status: 'ACTIVE' })),
    { ordered: false },
  );
  const locations = await Location.insertMany(
    LOCATIONS.map((name) => ({ businessId, name, status: 'ACTIVE' })),
    { ordered: false },
  );

  // ---- products, with a realistic spread of stock health ----
  // A share is deliberately at or below its minimum so the restock path returns a
  // FULL page. A tenant where nothing is ever low would leave that query's cost
  // unmeasured, which is the point of seeding at all.
  const productDocs = [];
  for (let i = 0; i < size; i += 1) {
    const minimumStock = intBetween(rand, 5, 100);
    const lowStock = rand() < 0.15;
    const available = lowStock
      ? (rand() < 0.4 ? 0 : intBetween(rand, 1, minimumStock))
      : Math.round(minimumStock * (1.5 + rand() * 8));

    // A curated real product, not an adjective + noun + index. Runs larger than
    // the catalogue cycle it: scale is the point here, but every row still has a
    // real brand, description and specification for the assistant to read.
    const template = catalogProductAt(i);
    const categoryIndex = CATEGORY_NAMES.indexOf(
      CATALOG_CATEGORIES.find((category) => category.key === template.category)?.name ?? '',
    );

    productDocs.push({
      businessId,
      name: template.name,
      brand: template.brand,
      sku: `SEEDSKU-${i}`,
      barcode: `SEEDBC${i}`,
      description: template.description,
      specifications: template.specifications,
      categoryId: categories[categoryIndex >= 0 ? categoryIndex : i % categories.length]._id,
      costPrice: template.costPrice,
      sellingPrice: template.sellingPrice,
      unit: template.unit,
      minimumStock,
      status: 'ACTIVE',
      // Carried on the doc so the inventory rows below can be built from it without
      // a second pass over the database; stripped before the insert.
      _availableTotal: available,
    });
  }
  const products = await Product.insertMany(
    productDocs.map((doc) => {
      // Strip the carried field before the insert — it coordinates the inventory rows
      // below and is not part of a product document.
      const clean = { ...doc };
      delete clean._availableTotal;
      return clean;
    }),
    { ordered: false },
  );

  // ---- inventory rows: each product stocked at 1..N locations ----
  const inventoryDocs = [];
  products.forEach((product, i) => {
    const total = productDocs[i]._availableTotal;
    const locationCount = intBetween(rand, 1, locations.length);
    let remaining = total;
    for (let l = 0; l < locationCount; l += 1) {
      const isLast = l === locationCount - 1;
      const qty = isLast ? remaining : Math.floor(total / locationCount);
      remaining -= qty;
      inventoryDocs.push({
        businessId,
        productId: product._id,
        locationId: locations[l]._id,
        quantity: Math.max(0, qty),
        reservedQuantity: 0,
      });
    }
  });
  await Inventory.insertMany(inventoryDocs, { ordered: false });

  // ---- transaction history spread across the last 90 days ----
  // `timestamps: false` is what lets the explicit createdAt stick. Without it
  // Mongoose stamps every row with "now" and every history query would be
  // measuring a single-bucket dataset.
  // Every row must satisfy the invariant its OWN type implies, not merely carry two
  // plausible numbers: `newQuantity = previousQuantity + quantity` for STOCK_IN,
  // `- quantity` for STOCK_OUT, and `quantity = |target - previousQuantity|` for an
  // ADJUSTMENT. The first version of this script ignored the type and always ADDED, which
  // made **6 615 of 6 616** seeded STOCK_OUT rows show stock going UP. The assistant then
  // reported that faithfully — a self-contradicting ledger reads exactly like a wrong
  // answer, so the fixture's consistency is part of what makes an answer trustworthy (it
  // was found on a device, in the History answer, and cost an investigation to clear).
  const types = ['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT'];
  const txDocs = [];
  for (let i = 0; i < products.length; i += 1) {
    const movements = intBetween(rand, 1, 3);
    for (let m = 0; m < movements; m += 1) {
      const type = pick(rand, types);
      const when = new Date(Date.now() - rand() * 90 * 86400000);
      let quantity;
      let previous;
      let target;
      if (type === 'STOCK_OUT') {
        // Stock must exist for stock to leave: a stock-out from an empty shelf is
        // impossible, and would write a negative `newQuantity` the model forbids.
        previous = intBetween(rand, 1, 500);
        quantity = intBetween(rand, 1, previous);
        target = previous - quantity;
      } else if (type === 'ADJUSTMENT') {
        // An adjustment records a TARGET, and its `quantity` is the absolute delta —
        // which is why the other two shapes' arithmetic does not apply to it. The same
        // rule the service enforces is kept here: no adjustment is a no-change one.
        previous = intBetween(rand, 0, 500);
        target = intBetween(rand, 0, 500);
        if (target === previous) target = previous + 1;
        quantity = Math.abs(target - previous);
      } else {
        previous = intBetween(rand, 0, 500);
        quantity = intBetween(rand, 1, 50);
        target = previous + quantity;
      }
      txDocs.push({
        businessId,
        productId: products[i]._id,
        locationId: pick(rand, locations)._id,
        type,
        quantity,
        previousQuantity: previous,
        newQuantity: target,
        reason: 'Seeded movement',
        reference: `SEED-${i}-${m}`,
        userId: owner._id,
        createdAt: when,
        updatedAt: when,
      });
    }
  }
  await InventoryTransaction.insertMany(txDocs, { ordered: false, timestamps: false });

  console.log(`[${COMMAND}] OK`);
  console.log(`[${COMMAND}] businessId      : ${String(businessId)}`);
  console.log(`[${COMMAND}] categories      : ${categories.length}`);
  console.log(`[${COMMAND}] locations       : ${locations.length}`);
  console.log(`[${COMMAND}] products        : ${products.length}`);
  console.log(`[${COMMAND}] inventory rows  : ${inventoryDocs.length}`);
  console.log(`[${COMMAND}] transactions    : ${txDocs.length}`);
  console.log(`[${COMMAND}] elapsed         : ${Date.now() - started} ms`);
  console.log(`[${COMMAND}] next            : node scripts/measure-ai-tools.mjs --business=${String(businessId)}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  await mongoose.disconnect().catch(() => {});
  if (err instanceof SeedSafetyError) fail(err.message);
  fail(err && err.message ? err.message : String(err));
});
