// `npm run audit:failures [-- --with-production] [--business=<id>] [--days=30] [--format=json]`
//
// READ-ONLY report of durable audit-write gaps. Best-effort audit writes are
// intentionally non-fatal, so a failed row leaves the business write committed;
// `audit_failures` makes that gap countable. This command never writes and never
// stores or prints an upstream error message (the collection does not contain one).
//
// EXIT CODES
//   0  ran to completion, no failures in the window
//   1  ran to completion, at least one failure
//   2  NOT CHECKED (bad arguments, no connection string, test database, unreachable)

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { summarizeAuditFailures } from '../src/services/auditFailure.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Report durable audit-write failures (READ-ONLY).

Usage:
  npm run audit:failures [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict to one tenant
  --days=<n>              rolling window, 1..365 (default 30)
  --format=<text|json>    output shape (default text)
  --help                  this text

Nothing is modified. The report contains counts and sanitized action/entity
names only, never an upstream message, request body or user id.
`;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    withProduction: false,
    businessId: null,
    days: 30,
    format: 'text',
    help: false,
    problems: [],
  };
  for (const raw of argv) {
    if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--business=')) {
      const value = raw.slice('--business='.length).trim();
      if (!/^[a-f0-9]{24}$/i.test(value)) args.problems.push('--business must be a 24-character hex id');
      else args.businessId = value;
    } else if (raw.startsWith('--days=')) {
      const value = Number(raw.slice('--days='.length));
      if (!Number.isInteger(value) || value < 1 || value > 365) {
        args.problems.push('--days must be an integer from 1 to 365');
      } else args.days = value;
    } else if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json');
      else args.format = value;
    } else args.problems.push(`unknown argument: ${raw}`);
  }
  return args;
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
  const to = new Date();
  const from = new Date(to.getTime() - args.days * 24 * 60 * 60 * 1000);

  try {
    await mongoose.connect(env.mongodbUri, {
      dbName: database,
      autoIndex: false,
      autoCreate: false,
    });
  } catch (err) {
    throw new NotChecked(
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2) — this is not a finding.`
    );
  }

  try {
    const summary = await summarizeAuditFailures({
      ...(args.businessId ? { businessId: args.businessId } : {}),
      from,
      to,
    });

    if (args.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          {
            command: 'audit:failures',
            readOnly: true,
            database,
            scope: {
              days: args.days,
              from: from.toISOString(),
              to: to.toISOString(),
              businessId: args.businessId,
            },
            ...summary,
            latestAt: summary.latestAt ? summary.latestAt.toISOString() : null,
            note: 'A gap, not a lost business write: the write committed and its audit row did not. Nothing was modified.',
          },
          null,
          2
        )}\n`
      );
    } else {
      console.log('Audit-write failures (READ-ONLY)');
      console.log(
        `database=${database} tenant=${args.businessId ?? 'all'} days=${args.days} total=${summary.total}`
      );
      if (summary.latestAt) console.log(`latest=${summary.latestAt.toISOString()}`);
      if (summary.byAction.length > 0) {
        console.log('');
        console.log('by action');
        for (const row of summary.byAction) console.log(`  ${row.action}  ${row.count}`);
      }
      if (summary.byTenant.length > 0) {
        console.log('');
        console.log('by tenant (bounded to the top 20 actions above)');
        for (const row of summary.byTenant) console.log(`  ${row.businessId}  ${row.count}`);
      }
      console.log('');
      console.log('A gap, not a lost business write. Nothing was modified.');
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
    console.error(
      `[audit-failures] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`
    );
    console.error('[audit-failures] nothing was checked, so this says nothing about the audit trail.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
