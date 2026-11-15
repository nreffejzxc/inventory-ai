// `npm run audit:integrity [-- --with-production] [--business=<id>] [--days=all] [--format=json]`
//
// Report two integrity anomalies, per tenant. READ-ONLY: this file only calls
// `connect`, `countDocuments`, `aggregate`, `find`, `select`, `lean` and
// `disconnect`. It has no flag to repair, delete or rewrite anything, and it never
// calls an index-sync helper.
//
// WHAT IS REPORTED:
//   * orphan STOCK_IN — a ledger row whose inventory row does not exist;
//   * unreceipted PO receipt — a STOCK_IN written by receiving (`reason: 'PO
//     receipt'`, `reference: <PO number>`) that no receipt on that purchase order
//     references. Receiving finalizes the movement and the receipt in one write; a
//     finalize that THROWS is deliberately left uncompensated because it may have
//     applied. This is the visible signature of that ambiguous case. If the
//     receipt did apply, the transaction is referenced and is not reported.
//
// WHAT IS NOT. A manual stock-in can use a PO-like reference, and an inventory row
// can be removed by an operator, so a finding is a candidate for a human decision.
// The report says so in its own output. There is no automatic repair.
//
// WHICH DATABASE — the same fixed rule `audit:duplicates` follows: development by
// default, production INSTEAD with `--with-production`. There is no `--database=`;
// the test database is refused because `npm test` owns it.
//
// EXIT CODES (the repository's contract):
//   0  the audit ran to completion and found neither anomaly
//   1  the audit ran to completion and found at least one candidate
//   2  NOT CHECKED — bad arguments, no connection string, the test database, or the
//      database could not be reached. Nothing is known, and nothing is claimed.
//
// Usage:
//   npm run audit:integrity
//   npm run audit:integrity -- --with-production
//   npm run audit:integrity -- --business=64f0c2a9e1b3d4f5a6b7c8d9 --days=30
//   npm run audit:integrity -- --format=json

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
  buildOrphanStockInPipeline,
  buildUnreceiptedPoStockInPipeline,
  cutoffForDays,
  formatTextReport,
  iso,
  parseIntegrityArgs,
  summarizeFindings,
} from './lib/inventory-integrity.mjs';

/** Nothing was checked. Never a finding, always exit 2. */
class NotChecked extends Error {}

const USAGE = `Report orphan STOCK_IN ledger rows and unreceipted purchase-order receipts (READ-ONLY).

Usage:
  npm run audit:integrity [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict the scan to one tenant
  --days=<n|all>          history to scan (default ${DEFAULT_DAYS})
  --format=<text|json>    output shape (default text)
  --help                  this text

An ORPHAN STOCK_IN is a STOCK_IN ledger row with no inventory row for the same
business, product and location. An UNRECEIPTED PO RECEIPT is a STOCK_IN with
reason "PO receipt" and a PO-number reference that no receipt on that purchase
order references; it is the visible signature of an ambiguous finalize. A finding
is a candidate for review, not proof of intent.

EXIT CODES
  0  ran to completion, no candidate
  1  ran to completion, at least one candidate
  2  NOT CHECKED (bad arguments, no connection string, test database, unreachable)

NOTHING IS MODIFIED. There is no repair flag.
`;

async function resolveNames(findings) {
  const businessIds = new Set();
  const productIds = new Set();
  const locationIds = new Set();
  for (const row of [...findings.orphanStockIns, ...findings.unreceiptedPoStockIns]) {
    businessIds.add(String(row.businessId));
    productIds.add(String(row.productId));
    locationIds.add(String(row.locationId));
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
    products: new Map(
      products.map((row) => [String(row._id), { name: row.name ?? null, sku: row.sku ?? null }])
    ),
    locations: new Map(locations.map((row) => [String(row._id), row.name ?? null])),
  };
}

function view(row, names, kind) {
  const product = names.products.get(String(row.productId)) ?? { name: null, sku: null };
  const location = names.locations.get(String(row.locationId)) ?? null;
  const business = names.businesses.get(String(row.businessId)) ?? null;
  const po = row.purchaseOrder ?? null;
  return {
    kind,
    transactionId: String(row._id),
    business: { id: String(row.businessId), name: business },
    product: { id: String(row.productId), ...product },
    location: { id: String(row.locationId), name: location },
    userId: String(row.userId ?? ''),
    quantity: row.quantity,
    previousQuantity: row.previousQuantity,
    newQuantity: row.newQuantity,
    reason: row.reason || null,
    reference: row.reference || null,
    createdAt: iso(row.createdAt),
    inventoryRow: row.rowFound === undefined ? { exists: false } : { exists: Boolean(row.rowFound), quantity: row.rowQuantity ?? null },
    purchaseOrder: po
      ? {
          id: String(po._id),
          number: po.number,
          status: po.status,
          receiptCount: po.receiptCount,
          claimCount: po.claimCount,
          claimQuantity: po.claimQuantity,
        }
      : null,
  };
}

async function main() {
  const args = parseIntegrityArgs();

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
    // `autoIndex`/`autoCreate` are OFF: Mongoose would otherwise build declared
    // indexes (a write) in the background at connect time, and this command's
    // contract is READ-ONLY. The explicit false is pinned by the source test.
    await mongoose.connect(env.mongodbUri, { dbName: database, autoIndex: false, autoCreate: false });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2) — this is not a finding.`
    );
  }

  try {
    const match = { type: 'STOCK_IN' };
    if (args.businessId) match.businessId = new mongoose.Types.ObjectId(args.businessId);
    if (since) match.createdAt = { $gte: since };

    const [scanned, orphanRows, unreceiptedRows] = await Promise.all([
      InventoryTransaction.countDocuments(match),
      InventoryTransaction.aggregate(
        buildOrphanStockInPipeline({ businessId: match.businessId ?? null, since }),
        { allowDiskUse: true }
      ),
      InventoryTransaction.aggregate(
        buildUnreceiptedPoStockInPipeline({ businessId: match.businessId ?? null, since }),
        { allowDiskUse: true }
      ),
    ]);

    const raw = {
      orphanStockIns: orphanRows,
      unreceiptedPoStockIns: unreceiptedRows,
    };
    const names = await resolveNames(raw);
    const findings = {
      orphanStockIns: orphanRows.map((row) => view(row, names, 'ORPHAN_STOCK_IN')),
      unreceiptedPoStockIns: unreceiptedRows.map((row) => view(row, names, 'UNRECEIPTED_PO_RECEIPT')),
    };
    const summary = summarizeFindings(findings);

    if (args.format === 'json') {
      const payload = {
        command: 'audit:integrity',
        readOnly: true,
        generatedAt: new Date().toISOString(),
        database,
        scope: {
          days: args.days,
          since: since ? since.toISOString() : null,
          businessId: args.businessId,
        },
        scannedStockIns: scanned,
        totals: summary,
        findings,
        note:
          'Candidates, not proof: a manual stock-in may use a PO-like reference, and an inventory ' +
          'row may have been removed by an operator. Nothing was modified.',
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(
        formatTextReport({
          database,
          days: args.days,
          businessId: args.businessId,
          scanned,
          findings,
          names,
        })
      );
    }

    return summary.total > 0 ? 1 : 0;
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
      console.error(`[integrity] NOT CHECKED (exit 2) — ${err.message}`);
    } else {
      console.error(`[integrity] NOT CHECKED (exit 2) — ${err?.message ?? err}`);
      console.error('[integrity] nothing was checked, so this says nothing about the inventory.');
    }
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
