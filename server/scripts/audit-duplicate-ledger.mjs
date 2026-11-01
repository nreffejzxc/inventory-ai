// `npm run audit:duplicates [-- --with-production] [--business=<id>] [--days=90]`
//                           [--window-seconds=120] [--format=json]
//
// Report suspected historical duplicate inventory ledger rows, per tenant. READ-ONLY:
// the only calls this file makes are `connect`, `countDocuments`, `aggregate`, `find`
// and `disconnect`. It has no flag to repair, delete or rewrite anything, and it never
// calls the index-sync helper (which can drop an index an operator added on purpose).
//
// WHY THIS EXISTS. §27GZ closed the way a duplicate was CREATED (one operation
// delivered twice, now de-duplicated by `Idempotency-Key`), but it did not touch rows
// written before that fix. The owner asked whether those exist. This reports them for
// a human to judge; it does not decide, because the ledger cannot prove intent.
//
// WHAT IS REPORTED. Pairs of rows sharing every field the client sent — type, product,
// location, quantity, user, reason, reference — and within `--window-seconds` of each
// other. Time is compared exactly, per request signature, with no clock-hour bucket, so
// a pair at 10:59:59.900 and 11:00:00.100 is found like any other. The second row of a
// real duplicate does NOT carry the same `previousQuantity`/`newQuantity` (it carries
// what the first row produced), so equality on those fields would find nothing; the
// shared request is the signal. See `scripts/lib/duplicate-ledger.mjs` for the full rule
// and its limits.
//
// WHAT IS NOT. A deliberate identical repeat inside the window looks the same, and a
// "PO receipt" pair can be two legitimate partial receipts of the same quantity. The
// report says "suspected" and repeats that caveat in its own output; correcting a row
// needs an owner decision, not this tool.
//
// WHICH DATABASE — one per run, the same fixed rule `check:accounts` follows:
// development by default, production INSTEAD with `--with-production`. There is no
// `--database=`; the test database is refused because `npm test` owns it.
//
// EXIT CODES (the repository's contract, so this can gate without parsing output):
//   0  the audit ran to completion and found no suspected duplicate
//   1  the audit ran to completion and found at least one suspected group
//   2  NOT CHECKED — bad arguments, no connection string, the test database, or the
//      database could not be reached. Nothing is known, and nothing is claimed.
//
// Usage:
//   npm run audit:duplicates
//   npm run audit:duplicates -- --with-production
//   npm run audit:duplicates -- --business=64f0c2a9e1b3d4f5a6b7c8d9 --days=all
//   npm run audit:duplicates -- --format=json

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { databasesToCheck } from './seed/lib.mjs';
import {
  DEFAULT_DAYS,
  DEFAULT_WINDOW_SECONDS,
  buildScanPipeline,
  cutoffForDays,
  formatTextReport,
  iso,
  parseDuplicateArgs,
  summarizeGroups,
} from './lib/duplicate-ledger.mjs';

/** Nothing was checked. Never a finding, always exit 2. */
class NotChecked extends Error {}

const USAGE = `Report suspected historical duplicate inventory ledger rows (READ-ONLY).

Usage:
  npm run audit:duplicates [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict the scan to one tenant
  --days=<n|all>          history to scan (default ${DEFAULT_DAYS}; "all" = no cutoff)
  --window-seconds=<n>    how close two rows must be to be suspected (default ${DEFAULT_WINDOW_SECONDS})
  --format=<text|json>    output shape (default text)
  --help                  this text

A suspected pair is a row and the row immediately before it in the same request
signature (type, product, location, quantity, user, reason and reference), within the
window. Time is compared exactly, with no clock-hour bucket, so a pair that crosses an
hour boundary is found too. The second row of a real duplicate has different
before/after quantities, so it is the shared request fields that identify the pair,
not identical rows.

EXIT CODES
  0  ran to completion, no suspected duplicate
  1  ran to completion, at least one suspected group
  2  NOT CHECKED (bad arguments, no connection string, test database, unreachable)

NOTHING IS MODIFIED. A deliberate identical repeat inside the window looks the same,
and a "PO receipt" pair can be two legitimate partial receipts of equal quantity.
`;

/**
 * Resolve the names the report shows. Only the ids that appear in flagged groups are
 * looked up, so this is bounded by the findings rather than by the ledger.
 */
async function resolveNames(groups) {
  const businessIds = new Set();
  const productIds = new Set();
  const locationIds = new Set();
  for (const group of groups) {
    businessIds.add(String(group._id.businessId));
    productIds.add(String(group._id.productId));
    locationIds.add(String(group._id.locationId));
  }

  const [businesses, products, locations] = await Promise.all([
    businessIds.size
      ? Business.find({ _id: { $in: [...businessIds] } }).select('name').lean()
      : Promise.resolve([]),
    productIds.size
      ? Product.find({ _id: { $in: [...productIds] } }).select('name sku').lean()
      : Promise.resolve([]),
    locationIds.size
      ? Location.find({ _id: { $in: [...locationIds] } }).select('name').lean()
      : Promise.resolve([]),
  ]);

  return {
    businesses: new Map(businesses.map((row) => [String(row._id), row.name ?? null])),
    products: new Map(products.map((row) => [String(row._id), { name: row.name ?? null, sku: row.sku ?? null }])),
    locations: new Map(locations.map((row) => [String(row._id), row.name ?? null])),
  };
}

/** One flagged group as the report's own shape (ids stringified, rows time-ordered). */
function groupView(group, names) {
  const productId = String(group._id.productId);
  const locationId = String(group._id.locationId);
  const product = names.products.get(productId) ?? { name: null, sku: null };
  const rows = (Array.isArray(group.rows) ? group.rows : [])
    .slice()
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return {
    type: String(group._id.type ?? ''),
    quantity: group._id.quantity,
    product: { id: productId, name: product.name, sku: product.sku },
    location: { id: locationId, name: names.locations.get(locationId) ?? null },
    userId: String(group._id.userId ?? ''),
    reason: group._id.reason || null,
    reference: group._id.reference || null,
    count: group.count,
    firstCreatedAt: iso(group.firstCreatedAt),
    lastCreatedAt: iso(group.lastCreatedAt),
    spanMs: group.spanMs,
    rows: rows.map((row) => ({
      id: String(row.id),
      at: iso(row.at),
      previousQuantity: row.previousQuantity,
      newQuantity: row.newQuantity,
    })),
  };
}

async function main() {
  const args = parseDuplicateArgs();

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.problems.length > 0) {
    throw new NotChecked(`invalid arguments:\n  ${args.problems.join('\n  ')}`);
  }
  if (!env.mongodbUri) {
    throw new NotChecked('MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was read.');
  }
  if (env.mongodbDbName === DATABASE_NAMES.test) {
    throw new NotChecked(
      'this shell resolves the TEST database, which "npm test" owns and clears. Point MONGODB_DB_NAME at ' +
        'development (or use --with-production). Nothing was read.'
    );
  }

  const [database] = databasesToCheck({ withProduction: args.withProduction, databaseNames: DATABASE_NAMES });
  const since = cutoffForDays(args.days);

  try {
    await mongoose.connect(env.mongodbUri, { dbName: database });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2) — this is not a finding.`
    );
  }

  try {
    const match = {};
    if (args.businessId) match.businessId = new mongoose.Types.ObjectId(args.businessId);
    if (since) match.createdAt = { $gte: since };

    const scanned = await InventoryTransaction.countDocuments(match);
    const groups = await InventoryTransaction.aggregate(
      buildScanPipeline({
        businessId: match.businessId ?? null,
        since,
        windowSeconds: args.windowSeconds,
      }),
      // A full-history scan can exceed the engine's in-memory sort budget; spilling
      // is the difference between a slow report and a failed one.
      { allowDiskUse: true }
    );

    const summary = summarizeGroups(groups);
    const names = await resolveNames(groups);
    const businessName = (id) => names.businesses.get(String(id)) ?? 'Unknown business';
    // The summary's groups are raw aggregation documents; the report shows the
    // resolved shape, built once so the text and JSON outputs cannot disagree.
    const tenants = summary.tenants.map((tenant) => ({
      ...tenant,
      groups: tenant.groups.map((group) => groupView(group, names)),
    }));

    if (args.format === 'json') {
      const payload = {
        command: 'audit:duplicates',
        readOnly: true,
        generatedAt: new Date().toISOString(),
        database,
        scope: {
          days: args.days,
          since: since ? since.toISOString() : null,
          windowSeconds: args.windowSeconds,
          // Time is compared per signature with no bucket; stated so a consumer of this
          // payload cannot assume the old clock-hour approximation.
          exactTimeAdjacency: true,
        },
        scannedRows: scanned,
        suspected: { groups: summary.totalGroups, extraRows: summary.extraRows },
        tenants: tenants.map((tenant) => ({
          business: { id: tenant.businessId, name: businessName(tenant.businessId) },
          groups: tenant.groups,
        })),
        note:
          'Suspected, not proven: a row and the row before it in the same request signature, inside the ' +
          'window. A deliberate identical repeat looks the same. Nothing was modified.',
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(
        formatTextReport({
          database,
          days: args.days,
          windowSeconds: args.windowSeconds,
          scanned,
          summary,
          tenants,
          businessName,
        })
      );
    }

    return summary.totalGroups > 0 ? 1 : 0;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The report is already written; a failed disconnect changes nothing it said.
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    if (err instanceof NotChecked) {
      console.error(`[duplicates] NOT CHECKED (exit 2) — ${err.message}`);
    } else {
      console.error(`[duplicates] NOT CHECKED (exit 2) — ${err?.message ?? err}`);
      console.error('[duplicates] nothing was checked, so this says nothing about the ledger.');
    }
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
