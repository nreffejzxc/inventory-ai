// `npm run migrate:transfer-ledger-index [-- --with-production --apply]`
//
// Preflight and apply the unique transfer-ledger guard:
//   (businessId, transferOperationId, locationId)
//
// READ-ONLY BY DEFAULT. Without --apply it reports duplicate groups and whether
// the guard exists. With --apply it:
//   1. refuses the whole run if ANY duplicate group is not an exact copy;
//   2. copies every exact duplicate to inventory_transaction_quarantine;
//   3. deletes only the copied rows, and only while they still match the copy;
//   4. builds the unique, partial index and verifies it.
//
// The quarantine copy exists before the delete, so a crash between the two is
// repeatable: the copy is an upsert keyed by the original transaction id. No
// inventory row, transfer journal or other ledger row is touched.
//
// Production apply also requires the operator-provided environment phrase:
//   TRANSFER_LEDGER_MIGRATION_CONFIRM=MIGRATE-TRANSFER-LEDGER
// Run the read-only preflight first; do not apply until it reports BLOCKED=none.
//
// EXIT CODES
//   0  clean (index present and no duplicates) or applied successfully
//   1  a finding: duplicates need review/quarantine, or ambiguous duplicates block apply
//   2  NOT CHECKED (arguments, connection, test database, missing production phrase)

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import {
  runTransferLedgerMigration,
  TRANSFER_LEDGER_INDEX,
} from '../src/services/transferLedgerMigration.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Preflight or apply the unique transfer-operation/location ledger guard.

Usage:
  npm run migrate:transfer-ledger-index [options]

Options:
  --with-production   inspect/apply the production database
  --apply             quarantine exact duplicates, remove them and build the index
  --limit=<n>         maximum duplicate groups to inspect (default 500, max 5000)
  --format=<text|json> output shape (default text)
  --help              this text

The preflight is READ-ONLY. --apply refuses every ambiguous duplicate group
before changing anything; exact copies are quarantined in
inventory_transaction_quarantine before their duplicates are deleted. No
inventory, transfer journal or unrelated ledger row is modified.

Production apply additionally requires:
  TRANSFER_LEDGER_MIGRATION_CONFIRM=MIGRATE-TRANSFER-LEDGER

EXIT CODES
  0  clean or applied
  1  duplicates need review, or an ambiguous group blocks apply
  2  NOT CHECKED
`;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { withProduction: false, apply: false, limit: 500, format: 'text', help: false, problems: [] };
  for (const raw of argv) {
    if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--limit=')) {
      const value = Number(raw.slice('--limit='.length));
      if (!Number.isInteger(value) || value < 1 || value > 5000) {
        args.problems.push('--limit must be an integer from 1 to 5000');
      } else args.limit = value;
    } else if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json');
      else args.format = value;
    } else args.problems.push(`unknown argument: ${raw}`);
  }
  return args;
}

function textReport(summary) {
  const lines = [
    'Transfer ledger index migration',
    `database=${summary.database} mode=${summary.apply ? 'apply' : 'preflight'}`,
    `index=${TRANSFER_LEDGER_INDEX.name} present=${summary.indexPresent ? 'yes' : 'no'}`,
    `duplicate groups=${summary.duplicateGroups} rows_to_quarantine=${summary.duplicateRows}`,
    `exact=${summary.exactGroups} ambiguous=${summary.ambiguousGroups}`,
    `status=${summary.status}`,
  ];
  if (summary.indexConflict) {
    lines.push(`conflicting index=${summary.indexConflict} (not the unique partial guard)`);
  }
  if (summary.blockedReason) lines.push(`blocked=${summary.blockedReason}`);
  if (summary.ambiguous.length > 0) {
    lines.push('', 'Ambiguous groups (no row was changed):');
    for (const row of summary.ambiguous.slice(0, 25)) {
      lines.push(
        `  business=${row.businessId} operation=${row.transferOperationId} ` +
          `location=${row.locationId} — ${row.reasons.join('; ')}`
      );
    }
    if (summary.ambiguous.length > 25) lines.push(`  …and ${summary.ambiguous.length - 25} more`);
  }
  if (summary.status === 'READY') {
    lines.push('', 'Review is required. Re-run with --apply only when every group is exact and expected.');
  }
  if (summary.status === 'APPLIED') {
    lines.push(
      '',
      `quarantined=${summary.quarantined} removed=${summary.removed} kept_groups=${summary.kept}`,
      'The unique guard is now present. No inventory or transfer journal was modified.'
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.problems.length > 0) throw new NotChecked(`invalid arguments:\n  ${args.problems.join('\n  ')}`);
  if (!env.mongodbUri) {
    throw new NotChecked('MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was read or changed.');
  }
  if (env.mongodbDbName === DATABASE_NAMES.test) {
    throw new NotChecked(
      'this shell resolves the TEST database, which "npm test" owns. Point MONGODB_DB_NAME at ' +
        'development (or use --with-production). Nothing was read or changed.'
    );
  }
  if (args.apply && args.withProduction) {
    if (process.env.TRANSFER_LEDGER_MIGRATION_CONFIRM !== 'MIGRATE-TRANSFER-LEDGER') {
      throw new NotChecked(
        'production apply requires TRANSFER_LEDGER_MIGRATION_CONFIRM=MIGRATE-TRANSFER-LEDGER. ' +
          'Nothing was read or changed.'
      );
    }
  }

  const [database] = databasesToCheck({
    withProduction: args.withProduction,
    databaseNames: DATABASE_NAMES,
  });

  try {
    await mongoose.connect(env.mongodbUri, {
      dbName: database,
      // The migration must run before Mongoose's background index build would
      // attempt the same unique key over duplicate data.
      autoIndex: false,
      autoCreate: false,
    });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2); nothing was changed.`
    );
  }

  try {
    const summary = await runTransferLedgerMigration({ apply: args.apply, limit: args.limit });
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify({ command: 'migrate:transfer-ledger-index', ...summary }, null, 2)}\n`);
    } else {
      console.log(textReport(summary));
    }
    return summary.status === 'BLOCKED' || summary.status === 'READY' ? 1 : 0;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The migration result is already decided; a failed disconnect changes nothing.
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(
      `[transfer-ledger-index] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`
    );
    console.error('[transfer-ledger-index] nothing was changed.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
