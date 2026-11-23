// `npm run migrate:required-indexes [-- --with-production --apply]`
//
// Preflight or apply the six indexes that `/api/health/ready` requires:
//   - inventory_transactions (businessId, transferOperationId, locationId) — transfer ledger
//   - purchase_orders      (businessId, requestKey)         — DRAFT replay
//   - audit_logs           (businessId, dedupeKey)          — audit dedupe
//   - audit_outbox         (deliveredAt)                    — bounded DELIVERED retention
//   - stock_movement_operations (state, auditTracked, auditEnqueuedAt, updatedAt)
//   - purchase_orders      (receipts.receiveId, receipts.auditEnqueuedAt, updatedAt)
//
// READ-ONLY BY DEFAULT. Without --apply it reports whether each exact unique
// partial index exists. With --apply it first runs a duplicate-key preflight
// using the index's own partial filter; a target with ANY duplicate group is
// refused and no index is created. It then calls createIndex for that one
// exact definition and re-inspects it.
//
// It never calls syncIndexes(), never drops an index and never removes a
// document. Existing duplicates must be resolved by hand before applying.
//
// Production apply additionally requires:
//   REQUIRED_INDEXES_CONFIRM=ENSURE-REQUIRED-INDEXES
//
// EXIT CODES
//   0  every required index is ready, or was created and verified
//   1  at least one index is missing, has the wrong shape, is blocked by
//      duplicate keys, or failed to build/verify
//   2  NOT CHECKED (arguments, connection, test database, missing phrase)

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import {
  DEFAULT_DUPLICATE_LIMIT,
  MAX_DUPLICATE_LIMIT,
  rolloutRequiredIndexes,
} from '../src/services/requiredIndexRollout.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Preflight or apply the six indexes required for readiness.

Usage:
  npm run migrate:required-indexes [options]

Options:
  --with-production    inspect/apply the production database
  --apply              create each missing exact index after a clean preflight
  --limit=<n>          maximum duplicate groups shown per index (default ${DEFAULT_DUPLICATE_LIMIT}, max ${MAX_DUPLICATE_LIMIT})
  --format=<text|json> output shape (default text)
  --help               this text

The default is READ-ONLY. --apply refuses a target with duplicate key groups
before creating anything; it never deletes documents or drops indexes.

Production apply additionally requires:
  REQUIRED_INDEXES_CONFIRM=ENSURE-REQUIRED-INDEXES

EXIT CODES
  0  ready or applied
  1  missing, wrong, blocked by duplicates, or failed
  2  NOT CHECKED
`;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    withProduction: false,
    apply: false,
    limit: DEFAULT_DUPLICATE_LIMIT,
    format: 'text',
    help: false,
    problems: [],
  };
  for (const raw of argv) {
    if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--limit=')) {
      const value = Number(raw.slice('--limit='.length));
      if (!Number.isInteger(value) || value < 1 || value > MAX_DUPLICATE_LIMIT) {
        args.problems.push(`--limit must be an integer from 1 to ${MAX_DUPLICATE_LIMIT}`);
      } else args.limit = value;
    } else if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json');
      else args.format = value;
    } else args.problems.push(`unknown argument: ${raw}`);
  }
  return args;
}

function textReport(summary, database) {
  const lines = [
    'Required index rollout',
    `database=${database} mode=${summary.apply ? 'apply' : 'preflight'}`,
  ];
  for (const result of summary.results) {
    lines.push(
      `${result.status.padEnd(19)} ${result.label}.${result.name}` +
        (result.reason ? ` — ${result.reason}` : ''),
    );
    if (result.duplicateSample?.length) {
      for (const group of result.duplicateSample) {
        lines.push(`  duplicate ${JSON.stringify(group._id)} count=${group.count ?? '?'}`);
      }
      if (result.duplicateGroups > result.duplicateSample.length) {
        lines.push(
          `  …and ${result.duplicateGroups - result.duplicateSample.length} more group(s)`,
        );
      }
    }
  }
  lines.push(
    '',
    `ready=${summary.ready ? 'yes' : 'no'} changed=${summary.changed} attention=${summary.attention}`,
  );
  if (!summary.ready) {
    lines.push(
      summary.apply
        ? 'Nothing was deleted. Resolve BLOCKED_DUPLICATES/FAILED rows and run again.'
        : 'Re-run with --apply only after reviewing the report.',
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
  if (args.problems.length > 0) {
    throw new NotChecked(`invalid arguments:\n  ${args.problems.join('\n  ')}`);
  }
  if (!env.mongodbUri) {
    throw new NotChecked(
      'MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was read or changed.',
    );
  }
  if (env.mongodbDbName === DATABASE_NAMES.test) {
    throw new NotChecked(
      'this shell resolves the TEST database, which "npm test" owns. Point MONGODB_DB_NAME at ' +
        'development (or use --with-production). Nothing was read or changed.',
    );
  }
  if (args.apply && args.withProduction) {
    if (process.env.REQUIRED_INDEXES_CONFIRM !== 'ENSURE-REQUIRED-INDEXES') {
      throw new NotChecked(
        'production apply requires REQUIRED_INDEXES_CONFIRM=ENSURE-REQUIRED-INDEXES. ' +
          'Nothing was read or changed.',
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
      // The rollout owns index changes. Mongoose's background build must not
      // race the duplicate preflight or create a concurrent copy.
      autoIndex: false,
      autoCreate: false,
    });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. ` +
        'NOT CHECKED (exit 2); nothing was changed.',
    );
  }

  try {
    const summary = await rolloutRequiredIndexes({
      apply: args.apply,
      duplicateLimit: args.limit,
    });
    if (args.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          { command: 'migrate:required-indexes', database, ...summary },
          null,
          2,
        )}\n`,
      );
    } else {
      console.log(textReport(summary, database));
    }
    return summary.ready ? 0 : 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The report is already decided; a failed disconnect changes nothing.
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(
      `[required-indexes] NOT CHECKED (exit 2) — ${
        err instanceof NotChecked ? err.message : err?.message ?? err
      }`,
    );
    console.error('[required-indexes] nothing was checked or changed.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
