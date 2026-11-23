// `npm run triage:audit-outbox [-- --with-production] [--business=<id>] [--min-age-minutes=15] [--min-attempts=3] [--limit=100] [--format=json]`
//
// READ-ONLY operator view of FAILED audit-outbox rows. A FAILED row is evidence
// that an audit event has not been appended; this command never retries,
// resolves, deletes or edits it. It lists the bounded set whose age OR attempt
// count crosses the threshold and shows only the event identity and error class.
//
// EXIT CODES
//   0  read completed; no FAILED row crossed either threshold
//   1  read completed; at least one FAILED row needs attention
//   2  NOT CHECKED — bad arguments, no connection, test database, or read failure

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { readAuditOutboxTriage } from '../src/services/auditOutboxTriage.service.ts';
import { databasesToCheck } from './seed/lib.mjs';
import { sanitizeOpsDetail } from './lib/ops-integrity.mjs';
import {
  AUDIT_TRIAGE_DEFAULT_LIMIT,
  AUDIT_TRIAGE_DEFAULT_MIN_AGE_MINUTES,
  AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS,
  AUDIT_TRIAGE_MAX_LIMIT,
  formatAuditOutboxTriageText,
  parseAuditOutboxTriageArgs,
} from './lib/audit-outbox-triage.mjs';

class NotChecked extends Error {}

const USAGE = `List FAILED audit-outbox rows whose age or attempts need attention (READ-ONLY).

Usage:
  npm run triage:audit-outbox [options]

Options:
  --with-production          read the production database instead of development
  --business=<24-hex id>     restrict the read to one tenant
  --min-age-minutes=<n>      include a FAILED row at least this old (default ${AUDIT_TRIAGE_DEFAULT_MIN_AGE_MINUTES}, 0..10080)
  --min-attempts=<n>         include a FAILED row with at least this many attempts (default ${AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS})
  --limit=<n>                maximum rows returned, 1..${AUDIT_TRIAGE_MAX_LIMIT} (default ${AUDIT_TRIAGE_DEFAULT_LIMIT})
  --format=<text|json>       output shape (default text)
  --help                     this text

A row is included when it is at least --min-age-minutes old OR has reached
--min-attempts. The report deliberately omits metadata, userId and businessId.

NOTHING IS RETRIED, RESOLVED, DELETED OR MODIFIED. Fix the dependency, let the
normal flusher retry, and never delete a FAILED row as a cleanup shortcut.

EXIT CODES
  0  read completed, no threshold-crossing row
  1  read completed, at least one row needs attention
  2  NOT CHECKED (bad arguments, no connection string, test database, read failure)
`;

async function main() {
  const args = parseAuditOutboxTriageArgs();
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
        'development (or use --with-production). Nothing was read.',
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
        'NOT CHECKED (exit 2) — this is not a finding.',
    );
  }

  try {
    const report = await readAuditOutboxTriage({
      businessId: args.businessId,
      minAgeMs: args.minAgeMinutes * 60_000,
      minAttempts: args.minAttempts,
      limit: args.limit,
    });
    const output = { ...report, database };
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      console.log(formatAuditOutboxTriageText(output));
    }
    return report.counts.matching > 0 ? 1 : 0;
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
      `[triage-audit-outbox] NOT CHECKED (exit 2) — ${sanitizeOpsDetail(err?.message ?? err)}`,
    );
    console.error('[triage-audit-outbox] nothing was read or changed.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
