// `npm run verify:transfer-ui -- --run-id=<id> --sku=<sku> --source=<name> --destination=<name>`
//                                  [--business=<id>] [--with-production] [--format=json]
//
// Verify the database half of an installed-app transfer run. READ-ONLY: it only
// reads products, locations, inventory and inventory transactions.
//
// The device journey writes six rows under one run id:
//   PHONE-TRF-<runId>-IN    STOCK_IN   +1 at the source
//   PHONE-TRF-<runId>-F     TRANSFER   -1 at the source, +1 at the destination
//   PHONE-TRF-<runId>-R     TRANSFER   +1 at the source, -1 at the destination
//   PHONE-TRF-<runId>-OUT   STOCK_OUT  -1 at the source
// and no rows under `-SAME` or `-OVER`, because the form's submit button is
// disabled for those two refusals. This script checks that shape, the net-zero
// arithmetic, and that each location's current quantity equals the last movement's
// `newQuantity`.
//
// Exit codes:
//   0  the run's six rows and final stock agree
//   1  the database disagrees — a real finding
//   2  NOT CHECKED — bad arguments, no database, an ambiguous SKU/location, or an
//      unreachable database. Nothing is claimed.
//
// Usage:
//   npm run verify:transfer-ui -- --run-id=20261115024500 --sku=PHONE-SMOKE-20261115 \
//     --source="Phone Smoke Location" --destination="Phone Smoke Location 2"
//   npm run verify:transfer-ui -- ... --with-production --format=json

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { databasesToCheck } from './seed/lib.mjs';
import {
  parseVerifyArgs,
  transferRefs,
  verifyTransferRows,
} from './lib/transfer-ui-verification.mjs';

class NotChecked extends Error {}

const USAGE = `Verify the six ledger rows and final stock of one installed-app transfer run (READ-ONLY).

Usage:
  npm run verify:transfer-ui -- --run-id=<id> --sku=<sku> --source=<name> --destination=<name> [options]

Required:
  --run-id=<id>           the device run's id (letters, numbers, hyphens)
  --sku=<sku>             the product the journey used
  --source=<name>         the source location's exact name
  --destination=<name>    the destination location's exact name

Options:
  --business=<24-hex id>  disambiguate a SKU that exists in more than one tenant
  --with-production       read production instead of development
  --format=<text|json>    output shape (default text)
  --help                  this text

What is checked:
  - exactly one IN row at the source and one OUT row at the source;
  - exactly two rows per transfer reference, one on each side, with the expected sign;
  - no row for the refused same-location or over-quantity submissions;
  - each location nets to zero;
  - the current inventory quantity equals that location's last run movement.

EXIT CODES
  0  the rows and final stock agree
  1  the database disagrees
  2  NOT CHECKED (bad arguments, no database, ambiguous SKU/location, unreachable)

NOTHING IS MODIFIED. This command has no repair flag.
`;

async function oneLocation(businessId, name) {
  const rows = await Location.find({ businessId, name }).select('name').lean();
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return null;
  throw new NotChecked(`location "${name}" is not unique in this tenant (${rows.length} exact matches).`);
}

async function main() {
  const args = parseVerifyArgs();

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

  try {
    // Read-only includes index creation: Mongoose's autoIndex would build declared
    // indexes in the background after connect. Both are explicitly off.
    await mongoose.connect(env.mongodbUri, { dbName: database, autoIndex: false, autoCreate: false });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2) — this is not a finding.`
    );
  }

  try {
    const productFilter = { sku: args.sku };
    if (args.businessId) productFilter.businessId = new mongoose.Types.ObjectId(args.businessId);
    const products = await Product.find(productFilter).select('name sku businessId').lean();
    if (products.length === 0) {
      throw new NotChecked(`no product with SKU "${args.sku}" in ${database}.`);
    }
    if (products.length > 1) {
      throw new NotChecked(
        `SKU "${args.sku}" exists in ${products.length} tenants; pass --business=<id> to name the one this run used.`
      );
    }

    const product = products[0];
    const businessId = product.businessId;
    const source = await oneLocation(businessId, args.source);
    const destination = await oneLocation(businessId, args.destination);
    if (!source) throw new NotChecked(`source location "${args.source}" was not found in this tenant.`);
    if (!destination) {
      throw new NotChecked(`destination location "${args.destination}" was not found in this tenant.`);
    }

    const refs = transferRefs(args.runId);
    const allRefs = [refs.in, refs.out, refs.forward, refs.reverse, refs.same, refs.over];
    const rows = await InventoryTransaction.find({
      businessId,
      productId: product._id,
      reference: { $in: allRefs },
    })
      .select('reference type locationId quantity previousQuantity newQuantity createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    const [sourceRow, destinationRow] = await Promise.all([
      Inventory.findOne({ businessId, productId: product._id, locationId: source._id })
        .select('quantity')
        .lean(),
      Inventory.findOne({ businessId, productId: product._id, locationId: destination._id })
        .select('quantity')
        .lean(),
    ]);

    const result = verifyTransferRows({
      rows,
      sourceId: source._id,
      destinationId: destination._id,
      currentSource: sourceRow ? sourceRow.quantity : null,
      currentDestination: destinationRow ? destinationRow.quantity : null,
      refs,
    });

    const payload = {
      command: 'verify:transfer-ui',
      readOnly: true,
      generatedAt: new Date().toISOString(),
      database,
      runId: args.runId,
      business: { id: String(businessId) },
      product: { id: String(product._id), name: product.name, sku: product.sku },
      source: { id: String(source._id), name: source.name, quantity: sourceRow ? sourceRow.quantity : null },
      destination: {
        id: String(destination._id),
        name: destination.name,
        quantity: destinationRow ? destinationRow.quantity : null,
      },
      references: refs,
      rows: rows.length,
      result,
      note: 'Read-only verification of one device run. Nothing was modified.',
    };

    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(`[transfer-ui] database: ${database} — READ-ONLY`);
      console.log(
        `[transfer-ui] ${product.name} (${product.sku}) · ${source.name} → ${destination.name} · run ${args.runId}`
      );
      console.log(
        `[transfer-ui] ${rows.length} run row(s) · source ${sourceRow ? sourceRow.quantity : 'MISSING'} · destination ${
          destinationRow ? destinationRow.quantity : 'MISSING'
        }`
      );
      if (result.ok) {
        console.log(
          `PASS: six movements reconcile; source net ${result.net[String(source._id)]}, destination net ${
            result.net[String(destination._id)]
          }.`
        );
      } else {
        console.log(`FAIL: ${result.errors.length} disagreement(s):`);
        for (const error of result.errors) console.log(`  - ${error}`);
      }
      console.log('NOTHING WAS MODIFIED.');
    }

    return result.ok ? 0 : 1;
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
      console.error(`[transfer-ui] NOT CHECKED (exit 2) — ${err.message}`);
    } else {
      console.error(`[transfer-ui] NOT CHECKED (exit 2) — ${err?.message ?? err}`);
      console.error('[transfer-ui] nothing was checked, so this says nothing about the transfer.');
    }
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
