#!/usr/bin/env node
/**
 * Read-only proof that one Draft PO restart attempt produced exactly one DRAFT.
 *
 * The device run supplies the request key and body that the logging proxy captured. This script
 * checks the database against them: one row for that key, DRAFT status, the same supplier/location,
 * and the same product ids. It never writes and refuses any database except the disposable test or
 * development database.
 *
 *   node scripts/verify-draft-po-resume.mjs \
 *     --database=inventoryai_test_db --key=op-... \
 *     --body='{"supplierId":"...","locationId":"...","items":[...]}' --format=json
 *
 * Exit 0 proves the claim, 1 is a failed claim, 2 could not check.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const ALLOWED_DATABASES = new Set(['inventoryai_test_db', 'inventoryai_dev_db']);

/** The server's canonical restock-selection fingerprint, mirrored for verification. */
function restockDraftFingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        supplierId: String(body.supplierId),
        locationId: String(body.locationId),
        expectedAt: body.expectedAt ? new Date(body.expectedAt).toISOString() : null,
        notes: body.notes ?? null,
        items: body.items.map((line) => ({
          productId: String(line.productId),
          availableQuantity: line.availableQuantity,
          minimumStock: line.minimumStock,
        })),
      })
    )
    .digest('hex');
}

function parseArgs(argv) {
  const args = { format: 'json' };
  for (const raw of argv) {
    const [flag, ...rest] = raw.replace(/^--/, '').split('=');
    const value = rest.join('=');
    switch (flag) {
      case 'database':
        args.database = value;
        break;
      case 'key':
        args.key = value;
        break;
      case 'body':
        args.body = value;
        break;
      case 'format':
        args.format = value;
        break;
      default:
        throw new Error(`unknown option: ${raw}`);
    }
  }
  return args;
}

function output(args, status, payload) {
  if (args.format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(status === 0 ? `PASS: ${payload.detail}` : `FAIL: ${payload.detail}`);
    for (const problem of payload.problems ?? []) console.log(`  - ${problem}`);
  }
  process.exit(status);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

if (!args.database || !ALLOWED_DATABASES.has(args.database)) {
  output(args, 2, {
    detail: `refusing database ${args.database ?? '(none)'}: only ${[...ALLOWED_DATABASES].join(', ')}`,
    problems: [],
  });
}
if (!args.key) output(args, 2, { detail: '--key is required', problems: [] });

let body;
try {
  body = JSON.parse(args.body ?? '');
} catch {
  output(args, 2, { detail: '--body must be the captured JSON body', problems: [] });
}
if (!body || typeof body !== 'object' || !Array.isArray(body.items) || !body.supplierId || !body.locationId) {
  output(args, 2, { detail: '--body must carry supplierId, locationId and items', problems: [] });
}
let expectedFingerprint;
try {
  expectedFingerprint = restockDraftFingerprint(body);
} catch {
  output(args, 2, { detail: '--body has an invalid expectedAt or item shape', problems: [] });
}

if (!process.env.MONGODB_URI) {
  output(args, 2, { detail: 'MONGODB_URI is not set', problems: [] });
}

try {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: args.database,
    serverSelectionTimeoutMS: 10_000,
  });
  const collection = mongoose.connection.db.collection('purchase_orders');
  const rows = await collection.find({ requestKey: args.key }).toArray();

  const problems = [];
  if (rows.length !== 1) problems.push(`expected exactly 1 purchase order for the key, found ${rows.length}`);

  const po = rows[0];
  if (po) {
    if (po.status !== 'DRAFT') problems.push(`expected DRAFT, found ${String(po.status)}`);
    if (String(po.supplierId) !== String(body.supplierId)) {
      problems.push(`supplierId ${String(po.supplierId)} does not match the request ${String(body.supplierId)}`);
    }
    if (String(po.locationId) !== String(body.locationId)) {
      problems.push(`locationId ${String(po.locationId)} does not match the request ${String(body.locationId)}`);
    }
    const storedIds = (po.items ?? []).map((item) => String(item.productId)).sort();
    const requestedIds = body.items.map((line) => String(line.productId)).sort();
    if (JSON.stringify(storedIds) !== JSON.stringify(requestedIds)) {
      problems.push(`line product ids ${storedIds.join(',')} do not match the request ${requestedIds.join(',')}`);
    }
    if (!po.requestFingerprint) {
      problems.push('the DRAFT has no requestFingerprint');
    } else if (po.requestFingerprint !== expectedFingerprint) {
      problems.push('the stored requestFingerprint does not match the captured body');
    }
  }

  if (problems.length) {
    output(args, 1, { detail: 'the database does not match the restart claim', problems, rows: rows.length });
  }

  output(args, 0, {
    detail: `exactly one DRAFT (${po.number}) for ${args.key}`,
    problems: [],
    count: rows.length,
    po: {
      id: String(po._id),
      number: po.number,
      status: po.status,
      requestKey: po.requestKey,
      requestFingerprint: po.requestFingerprint,
      supplierId: String(po.supplierId),
      locationId: String(po.locationId),
      items: (po.items ?? []).map((item) => ({
        productId: String(item.productId),
        productName: item.productName,
        quantityOrdered: item.quantityOrdered,
      })),
      createdAt: po.createdAt,
    },
  });
} catch (err) {
  output(args, 2, { detail: `could not check the database: ${err.message}`, problems: [] });
} finally {
  await mongoose.disconnect().catch(() => {});
}
