// The demo tenant's safety core and its I/O: seed, verify, remove.
//
// WHY THIS EXISTS SEPARATELY FROM `seed:demo`. `seed:demo` shares
// `assertSafeTarget`, which REFUSES production and requires the development
// database — deliberately, because it writes a large dataset for measuring queries.
// The preview APK talks to production and nothing else, so a demo tenant that can be
// exercised from that build has to be seedable there. Rather than weaken that guard
// for every caller, the seeder has its own named-database check (`assertDemoTarget`),
// while the teardown uses the shared `assertScopedCleanupTarget` (two phrases in
// development, three in production). The words in the seeder's guard are different on
// purpose:
//
//   * the DATABASE IS NAMED BY HAND, twice — `--database=<name>` must equal the
//     database `config/env.ts` actually resolved (`dbName` on the connection comes
//     from config, never from the URI's path segment). A `SEED_CONFIRM` alone cannot
//     be copied from a shell history into the wrong target by accident; typing the
//     target's name can still be, but only after reading it.
//   * the CONNECTION STRING must not name a DIFFERENT database. The connection obeys
//     the resolved `dbName`, so the run would still write to the right place — and that
//     is exactly why a disagreement stops it: the shell it came from was set up for
//     another environment.
//   * the TEST database is refused outright, because `npm test` clears it.
//   * the seeder requires its own `SEED_CONFIRM=seed-demo-tenant`; the teardown's
//     first phrase is `CLEANUP_CONFIRM=cleanup:demo-tenant`, plus the database
//     phrase every scoped cleanup costs.
//   * the tenant is identified by TWO fingerprints (exact business name AND exact
//     owner email) and every delete is anchored to the businessId they agree on.
//     There is no "delete by email" path, so a real account whose address happened to
//     match could never be removed.
//
// WHAT IS NEVER DELETED: the Firebase identity. `docs/DEVELOPMENT_ROADMAP.md` §27BB
// (F-50) records the failure — a MongoDB user whose Firebase identity is gone can
// neither sign in nor register, and nothing in the application can repair it. The
// reverse is harmless, so a teardown removes Mongo rows only and leaves the identity
// for the next seeding run to reuse.
//
// NOTHING RUNS ON IMPORT. No connection, no write, no argument parsing.

import mongoose from 'mongoose';

import { DATABASE_NAMES } from '../../src/config/env.ts';
import { databaseNameInUri } from '../lib/mongo-uri.mjs';
import Business from '../../src/models/business.model.ts';
import Category from '../../src/models/category.model.ts';
import Inventory from '../../src/models/inventory.model.ts';
import InventoryTransaction from '../../src/models/inventoryTransaction.model.ts';
import Location from '../../src/models/location.model.ts';
import Product from '../../src/models/product.model.ts';
import User from '../../src/models/user.model.ts';
import {
  clearTenantData,
  countTenantLeftovers,
  countTenantRemoval,
  removeTenant,
} from '../perf/lib.mjs';
import { resolveIdentity } from '../seed/lib.mjs';
import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_MOVEMENTS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
  DEMO_TENANT,
  expectedLocationBreakdown,
  expectedRestock,
  expectedSummary,
  stockByLocation,
  stockByProduct,
} from './fixture.mjs';

/** The confirmation phrases. Distinct from every other seeder's on purpose. */
export const DEMO_SEED_CONFIRM = 'seed-demo-tenant';
export const DEMO_CLEANUP_CONFIRM = 'cleanup:demo-tenant';

/** Raised by every guard below; the CLIs print the message and exit non-zero. */
export class DemoTenantError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The SEEDER's fail-closed target check, BEFORE a connection is opened.
 *
 * Every rule is a pure function of its arguments, so each one is asserted in
 * `server/test/DEMO1-demo-tenant.test.mjs` without a database or a network call.
 * Production is deliberately ALLOWED — that is what makes the preview build testable —
 * and the target is made deliberate instead by requiring the operator to name it.
 * The teardown no longer calls this: it uses the shared scoped cleanup rule.
 */
export function assertDemoTarget({
  mongodbUri,
  resolvedDbName,
  requestedDatabase,
  confirm,
  confirmPhrase,
}) {
  const resolved = String(resolvedDbName ?? '').trim();
  const requested = String(requestedDatabase ?? '').trim();

  if (!mongodbUri) {
    throw new DemoTenantError('MONGODB_URI is not set. Nothing was written or deleted.');
  }
  if (!resolved) {
    throw new DemoTenantError('the resolved database name is empty. Nothing was written or deleted.');
  }
  if (!requested) {
    throw new DemoTenantError(
      `--database=<name> is required and must be the database this run targets ("${resolved}"). ` +
        'Naming it is what makes the target deliberate. Nothing was written or deleted.',
    );
  }
  if (requested !== resolved) {
    throw new DemoTenantError(
      `--database is "${requested}" but the resolved database is "${resolved}". ` +
        'Refusing to touch a database the run is not connected to. Nothing was written or deleted.',
    );
  }
  // The flag and the resolved name can agree while the URI's path names something else.
  // The connection obeys `dbName` and would therefore write to the resolved database, so
  // this run is not actually ambiguous — but the shell it came from is, and every earlier
  // instruction in it was written for the other database. Stop on that evidence rather
  // than proceed correctly-but-unexpectedly, exactly as every other data command does.
  const uriDatabase = databaseNameInUri(mongodbUri);
  if (uriDatabase && uriDatabase !== resolved) {
    throw new DemoTenantError(
      `MONGODB_URI names the database "${uriDatabase}", but this run resolved "${resolved}". ` +
        'The connection string and the environment were configured for different databases; ' +
        'fix one of them. Nothing was written or deleted.',
    );
  }
  if (resolved === DATABASE_NAMES.test) {
    throw new DemoTenantError(
      `the resolved database is the test database "${DATABASE_NAMES.test}", which ` +
        '`npm test` clears. Refusing. Nothing was written or deleted.',
    );
  }
  if (String(confirm ?? '').trim() !== confirmPhrase) {
    // Name the ENVIRONMENT VARIABLE, not the command. The old message said
    // `set seed:demo-tenant confirmation to "seed:demo-tenant"`, which never told the operator
    // what to export; the shell needs the variable name and the value, and the confirmation phrase
    // is still named so the refusal cannot read as a missing flag instead of a missing phrase.
    throw new DemoTenantError(
      `set SEED_CONFIRM=${confirmPhrase} to proceed — the confirmation phrase is required. ` +
        'Nothing was written or deleted.',
    );
  }
  return resolved;
}

/** True when the resolved database is the production one (used only for logging). */
export function isProductionDatabase(resolvedDbName) {
  return String(resolvedDbName ?? '').trim() === DATABASE_NAMES.production;
}

/**
 * Find the demo tenant by BOTH fingerprints, and prove the two agree.
 *
 * Returns `{ businessId, userId, userCount, businessCount }` or nulls. It does not
 * create, repair or delete anything: a caller that finds a half-state must refuse,
 * because inventing the missing half is exactly how a seeder ends up pointing a real
 * account at a demo business.
 */
export async function findDemoTenant() {
  const businesses = await Business.find({ name: DEMO_TENANT.businessName }).select('_id name').lean();
  const users = await User.find({ email: DEMO_TENANT.email }).select('_id businessId').lean();

  if (businesses.length > 1) {
    throw new DemoTenantError(
      `${businesses.length} businesses are named "${DEMO_TENANT.businessName}". Refusing to guess ` +
        'which one is the demo tenant. Nothing was written or deleted.',
    );
  }
  if (users.length > 1) {
    throw new DemoTenantError(
      `${users.length} users share ${DEMO_TENANT.email}. Refusing to guess. Nothing was written or deleted.`,
    );
  }

  const business = businesses[0] ?? null;
  const user = users[0] ?? null;
  return {
    businessId: business ? String(business._id) : null,
    userId: user ? String(user._id) : null,
    userBusinessId: user?.businessId ? String(user.businessId) : null,
  };
}

/**
 * Decide what a seed may do with the state it found, as data.
 *
 * Split out as a pure function because the dangerous case is the one that never
 * happens in a happy-path test: an address that already belongs to a REAL tenant. If
 * the demo email's user points at a different business, seeding would either move a
 * user between tenants or write demo rows into a real business, so both are refused
 * rather than repaired.
 */
export function planSeed(found) {
  const { businessId, userId, userBusinessId } = found;
  const hasBusiness = Boolean(businessId);
  const hasUser = Boolean(userId);

  if (hasUser && userBusinessId && userBusinessId !== businessId) {
    return {
      action: 'refuse',
      reason:
        `${DEMO_TENANT.email} belongs to a DIFFERENT business (${userBusinessId || '(none)'}), not ` +
        `the demo tenant (${businessId || '(none)'}). This is a real account's linkage; refusing to ` +
        'write demo data into it or to re-point it. Nothing was written.',
    };
  }
  if (hasBusiness && !hasUser) return { action: 'attach-user', businessId };
  if (!hasBusiness && hasUser) {
    return {
      action: 'refuse',
      reason:
        `a user for ${DEMO_TENANT.email} exists with no business named "${DEMO_TENANT.businessName}". ` +
        'Refusing to invent its linkage. Nothing was written.',
    };
  }
  if (hasBusiness && hasUser) return { action: 'reset', businessId, userId };
  return { action: 'create' };
}

/**
 * Create the identity if absent, then the tenant, then the fixture.
 *
 * The identity is created through the SAME helper `seed:demo` uses (`resolveIdentity`,
 * which reads the uid from Firebase and never resolves a user by email in MongoDB).
 */
export async function seedDemoTenant() {
  const identity = await resolveIdentity(DEMO_TENANT.email);
  const found = await findDemoTenant();
  const plan = planSeed(found);

  if (plan.action === 'refuse') throw new DemoTenantError(plan.reason);

  let businessId = plan.businessId ?? null;
  let userId = plan.userId ?? null;
  let businessCreated = false;
  let userCreated = false;

  if (!businessId) {
    const business = await Business.create({ name: DEMO_TENANT.businessName, status: 'ACTIVE' });
    businessId = String(business._id);
    businessCreated = true;
  }
  if (!userId) {
    const user = await User.create({
      businessId,
      name: DEMO_TENANT.ownerName,
      email: DEMO_TENANT.email,
      role: DEMO_TENANT.role,
      status: 'ACTIVE',
      firebaseUid: identity.uid,
      emailVerified: identity.emailVerified === true,
    });
    userId = String(user._id);
    userCreated = true;
  }

  // Reset ONLY this tenant's DATA, so re-running the seeder is idempotent and never
  // accumulates a second copy of the fixture.
  const cleared = await clearTenantData([businessId]);

  const categories = await Category.insertMany(
    DEMO_CATEGORIES.map((c) => ({ businessId, name: c.name, status: 'ACTIVE' })),
  );
  const locations = await Location.insertMany(
    DEMO_LOCATIONS.map((l) => ({ businessId, name: l.name, status: 'ACTIVE' })),
  );

  const categoryId = new Map(categories.map((doc, i) => [DEMO_CATEGORIES[i].key, doc._id]));
  const locationId = new Map(locations.map((doc, i) => [DEMO_LOCATIONS[i].key, doc._id]));

  const products = await Product.insertMany(
    DEMO_PRODUCTS.map((p) => ({
      businessId,
      name: p.name,
      brand: p.brand,
      sku: p.sku,
      description: p.description,
      specifications: p.specifications,
      categoryId: categoryId.get(p.category),
      costPrice: p.costPrice,
      sellingPrice: p.sellingPrice,
      unit: p.unit,
      minimumStock: p.minimumStock,
      status: 'ACTIVE',
    })),
  );
  const productId = new Map(products.map((doc, i) => [DEMO_PRODUCTS[i].key, doc._id]));

  const inventory = await Inventory.insertMany(
    DEMO_STOCK.map((row) => ({
      businessId,
      productId: productId.get(row.product),
      locationId: locationId.get(row.location),
      quantity: row.quantity,
      reservedQuantity: 0,
    })),
  );

  const now = Date.now();
  const movements = await InventoryTransaction.insertMany(
    DEMO_MOVEMENTS.map((row) => {
      const when = new Date(now - row.daysAgo * DAY_MS);
      return {
        businessId,
        productId: productId.get(row.product),
        locationId: locationId.get(row.location),
        type: row.type,
        quantity: row.quantity,
        previousQuantity: row.previousQuantity,
        newQuantity: row.newQuantity,
        reason: row.reason,
        reference: `DEMO-${row.product}-${row.daysAgo}`,
        userId,
        createdAt: when,
        updatedAt: when,
      };
    }),
  );

  return {
    identity,
    businessId,
    businessCreated,
    userCreated,
    cleared: cleared.removed,
    counts: {
      categories: categories.length,
      locations: locations.length,
      products: products.length,
      inventory: inventory.length,
      transactions: movements.length,
    },
  };
}

/**
 * Read the tenant back and compare it with the fixture's own expectations.
 *
 * This is the half that makes the seed trustworthy: the CLI prints what the
 * ASSISTANT should answer, and the check refuses to call the run successful when the
 * database disagrees with the fixture. It reads through the same collections the API
 * reads, so a mismatch is a defect in the seed (or a stray writer), not a formatting
 * difference.
 */
export async function verifyDemoTenant(businessId) {
  const oid = new mongoose.Types.ObjectId(String(businessId));
  const [categories, locations, products, inventory, movements] = await Promise.all([
    Category.countDocuments({ businessId: oid }),
    Location.find({ businessId: oid }).select('_id name').sort({ name: 1 }).lean(),
    Product.find({ businessId: oid, status: 'ACTIVE' })
      .select('_id name brand description specifications minimumStock')
      .sort({ name: 1 })
      .lean(),
    Inventory.find({ businessId: oid }).select('productId locationId quantity').lean(),
    InventoryTransaction.find({ businessId: oid }).select('type quantity previousQuantity newQuantity').lean(),
  ]);

  const expected = expectedSummary();
  const expectedBreakdown = expectedLocationBreakdown();
  const expectedRestockRows = expectedRestock();

  const byProduct = stockByProduct();
  const byLocation = stockByLocation();
  const productName = new Map(products.map((p) => [String(p._id), p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));

  const unitsByLocationName = new Map();
  const productsByLocationName = new Map();
  for (const row of inventory) {
    const name = locationName.get(String(row.locationId));
    unitsByLocationName.set(name, (unitsByLocationName.get(name) ?? 0) + row.quantity);
    if (row.quantity > 0) {
      if (!productsByLocationName.has(name)) productsByLocationName.set(name, new Set());
      productsByLocationName.get(name).add(String(row.productId));
    }
  }

  const stockByProductName = new Map();
  for (const row of inventory) {
    const name = productName.get(String(row.productId));
    stockByProductName.set(name, (stockByProductName.get(name) ?? 0) + row.quantity);
  }
  const lowNames = products
    .filter((p) => (stockByProductName.get(p.name) ?? 0) <= p.minimumStock)
    .map((p) => p.name)
    .sort();
  const outNames = products
    .filter((p) => (stockByProductName.get(p.name) ?? 0) <= 0)
    .map((p) => p.name)
    .sort();

  const totalUnits = inventory.reduce((sum, row) => sum + row.quantity, 0);
  const stocked = new Set(inventory.filter((row) => row.quantity > 0).map((row) => String(row.productId)));

  const checks = [
    { name: 'categories', ok: categories === DEMO_CATEGORIES.length, actual: categories, expected: DEMO_CATEGORIES.length },
    { name: 'locations', ok: locations.length === DEMO_LOCATIONS.length, actual: locations.length, expected: DEMO_LOCATIONS.length },
    { name: 'active products', ok: products.length === expected.totalProducts, actual: products.length, expected: expected.totalProducts },
    {
      name: 'recorded brands',
      ok: products.filter((p) => p.brand).length === expected.totalProducts,
      actual: products.filter((p) => p.brand).length,
      expected: expected.totalProducts,
    },
    {
      name: 'recorded specifications',
      ok: products.filter((p) => p.specifications).length === expected.totalProducts,
      actual: products.filter((p) => p.specifications).length,
      expected: expected.totalProducts,
    },
    { name: 'on-hand units', ok: totalUnits === expected.totalInventoryQuantity, actual: totalUnits, expected: expected.totalInventoryQuantity },
    { name: 'stacked products', ok: stocked.size === expectedBreakdown.totals.products, actual: stocked.size, expected: expectedBreakdown.totals.products },
    { name: 'low-stock products', ok: lowNames.length === expected.lowStockProducts, actual: lowNames, expected: expected.lowStockProducts },
    { name: 'out-of-stock products', ok: outNames.length === expected.outOfStockProducts, actual: outNames, expected: expected.outOfStockProducts },
    { name: 'ledger rows', ok: movements.length === DEMO_MOVEMENTS.length, actual: movements.length, expected: DEMO_MOVEMENTS.length },
  ];

  for (const loc of expectedBreakdown.locations) {
    checks.push({
      name: `units at ${loc.name}`,
      ok: (unitsByLocationName.get(loc.name) ?? 0) === loc.units,
      actual: unitsByLocationName.get(loc.name) ?? 0,
      expected: loc.units,
    });
    checks.push({
      name: `products at ${loc.name}`,
      ok: (productsByLocationName.get(loc.name)?.size ?? 0) === loc.products,
      actual: productsByLocationName.get(loc.name)?.size ?? 0,
      expected: loc.products,
    });
  }

  // The ledger invariant, checked against the rows that were actually written.
  let ledgerOk = true;
  for (const row of movements) {
    if (row.type === 'STOCK_IN' && row.newQuantity !== row.previousQuantity + row.quantity) ledgerOk = false;
    if (row.type === 'STOCK_OUT' && row.newQuantity !== row.previousQuantity - row.quantity) ledgerOk = false;
  }
  checks.push({ name: 'ledger arithmetic', ok: ledgerOk, actual: ledgerOk ? 'consistent' : 'inconsistent', expected: 'consistent' });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    expected: {
      summary: expected,
      breakdown: expectedBreakdown,
      restock: expectedRestockRows,
      // Only asserted so a caller can see the fixture's own arithmetic agrees with
      // the database rows it just wrote.
      fixtureByProduct: [...byProduct.entries()],
      fixtureByLocation: [...byLocation.entries()],
    },
  };
}

/**
 * The one place the teardown decides whether a found demo state is safe to remove.
 * Both the preview and the real removal use it, so they cannot disagree about the
 * tenant or refuse in only one of the two paths.
 */
function completeDemoTenant(found) {
  if (!found.businessId && !found.userId) return false;
  if (!found.businessId || !found.userId || found.userBusinessId !== found.businessId) {
    throw new DemoTenantError(
      'the demo tenant is in a half-state (business and user do not agree). Refusing to remove ' +
        `anything: business=${found.businessId ?? '(none)'} user=${found.userId ?? '(none)'} ` +
        `userBusiness=${found.userBusinessId ?? '(none)'}.`,
    );
  }
  return true;
}

/**
 * Count exactly what `removeDemoTenant` would remove, and delete nothing.
 *
 * It uses the same `countTenantRemoval` plan as the real removal and applies the same
 * two-fingerprint check first. The Firebase identity is not counted, because the
 * teardown never touches it.
 */
export async function previewDemoTenantRemoval() {
  const found = await findDemoTenant();
  if (!completeDemoTenant(found)) {
    return { removable: false, reason: 'no demo tenant exists — nothing to remove', counts: {}, total: 0 };
  }

  const { total, counts } = await countTenantRemoval([found.businessId]);
  return { removable: true, businessId: found.businessId, total, counts };
}

/**
 * Remove the demo tenant's Mongo rows, and prove nothing is left.
 *
 * Refuses unless BOTH fingerprints agree on one businessId, so the one command that
 * deletes can never be pointed at a business that merely looks similar. The Firebase
 * identity is intentionally left behind — see the header.
 */
export async function removeDemoTenant() {
  const found = await findDemoTenant();
  if (!completeDemoTenant(found)) {
    return { removed: false, reason: 'no demo tenant exists — nothing to remove', counts: {} };
  }

  const result = await removeTenant([found.businessId]);
  const leftovers = await countTenantLeftovers([found.businessId]);
  if (leftovers !== 0) {
    throw new DemoTenantError(
      `${leftovers} document(s) still carry businessId ${found.businessId} after removal. ` +
        'The teardown is incomplete — inspect before re-running anything.',
    );
  }
  return { removed: true, businessId: found.businessId, counts: result.counts, leftovers };
}

export default {
  DEMO_SEED_CONFIRM,
  DEMO_CLEANUP_CONFIRM,
  DemoTenantError,
  assertDemoTarget,
  isProductionDatabase,
  findDemoTenant,
  planSeed,
  seedDemoTenant,
  verifyDemoTenant,
  previewDemoTenantRemoval,
  removeDemoTenant,
};
