// `npm run triage:integrity [-- --with-production] [--business=<id>] [--format=json]`
//
// READ-ONLY operator view of the two places integrity recovery deliberately
// stops: stock-transfer journals in REQUIRES_ATTENTION and ledger rows copied to
// `inventory_transaction_quarantine` by the duplicate migration.
//
// This command never repairs, retries, deletes or re-indexes anything. It reads
// the journal, its inventory snapshots, its ledger rows and the quarantine copy,
// then prints the reasons and the evidence a person needs to decide what to do.
//
// EXIT CODES
//   0  the read completed and found nothing needing attention
//   1  the read completed and found at least one attention/quarantine row
//   2  NOT CHECKED — bad arguments, no connection, test database, or read failure

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { databasesToCheck } from './seed/lib.mjs';
import { sanitizeOpsDetail } from './lib/ops-integrity.mjs';
import { readAttentionEvidence } from './lib/triage-read.mjs';
import {
  TRIAGE_DEFAULT_LIMIT,
  TRIAGE_MAX_LIMIT,
  buildAttentionReport,
  formatAttentionText,
  parseTriageArgs,
} from './lib/triage-integrity.mjs';

class NotChecked extends Error {}

const USAGE = `List REQUIRES_ATTENTION transfers, movement receipts and quarantined ledger rows (READ-ONLY).

Usage:
  npm run triage:integrity [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict both lists to one tenant
  --limit=<n>             maximum rows per list, 1..${TRIAGE_MAX_LIMIT} (default ${TRIAGE_DEFAULT_LIMIT})
  --format=<text|json>    output shape (default text)
  --help                  this text

Every transfer is printed with its failure reason, source/destination inventory
snapshots and every ledger row carrying its operation id. Every keyed movement
receipt that could not prove its outcome is printed with its request key, target,
quantities and failure. Every quarantine row is printed with its quarantine
reason, original id, kept id and movement fields.

NOTHING IS REPAIRED, RETRIED, DELETED OR MODIFIED. Use recover:integrity for its
documented exact actions, or resolve an ambiguous row by hand.

EXIT CODES
  0  read completed, nothing needs attention
  1  read completed, at least one attention/quarantine row
  2  NOT CHECKED (bad arguments, no connection string, test database, read failure)
`;

async function main() {
  const args = parseTriageArgs();
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
      'this shell resolves the TEST database, which "npm test" owns. Point MONGODB_DB_NAME at ' +
        'development (or use --with-production). Nothing was read.'
    );
  }

  const [database] = databasesToCheck({
    withProduction: args.withProduction,
    databaseNames: DATABASE_NAMES,
  });

  try {
    await mongoose.connect(env.mongodbUri, {
      dbName: database,
      autoIndex: false,
      autoCreate: false,
    });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${sanitizeOpsDetail(err?.message ?? err)}. ` +
        'NOT CHECKED (exit 2) — this is not a finding.'
    );
  }

  try {
    const evidence = await readAttentionEvidence({
      businessId: args.businessId,
      limit: args.limit,
    });
    const report = buildAttentionReport({
      database,
      businessId: args.businessId,
      limit: args.limit,
      ...evidence,
    });

    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(formatAttentionText(report));
    }
    return report.counts.transfers + report.counts.movements + report.counts.quarantine > 0 ? 1 : 0;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The report is already written; a failed disconnect changes nothing.
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(
      `[triage-integrity] NOT CHECKED (exit 2) — ${sanitizeOpsDetail(err?.message ?? err)}`
    );
    console.error('[triage-integrity] nothing was read or changed.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
