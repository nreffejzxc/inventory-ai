// `npm run recover:movement-receipts [-- --apply] [--with-production]`
//
// SAFE MAINTENANCE for durable stock-movement receipts.
//
// Dry run is the DEFAULT. It reports what a second run would do; every apply
// action uses the same proof hierarchy as a retry: a ledger row, or the receipt's
// own exact INVENTORY_WRITTEN snapshot. Ambiguity is never guessed and is never
// deleted. A `REQUIRES_ATTENTION` row can be resolved only when one of those two
// proofs exists; otherwise it stays visible to `triage:integrity`.
//
// Retention removes ONLY COMPLETED receipts older than the retention window. The
// ledger remains authoritative, and every recovery or prune writes a tenant audit
// row without the idempotency key.
//
// EXIT CODES
//   0  nothing needs work, or an apply left no attention or failure
//   1  attention remains, a failure occurred, or a dry run found work
//   2  NOT CHECKED (bad arguments, no connection, test database, read failure)

import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import {
  MOVEMENT_RECEIPT_RETENTION_MS,
  MOVEMENT_RECEIPT_STALE_MS,
  runMovementReceiptMaintenance,
} from '../src/services/stockMovementReceiptRecovery.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

export class NotChecked extends Error {}

const USAGE = `Safely recover abandoned stock-movement receipts and prune completed replay handles.

Usage:
  npm run recover:movement-receipts [options]

Options:
  --apply                        write the proven repairs/prunes (default is dry-run)
  --with-production              act on production instead of development
  --older-than-minutes=<n>       age before an unfinished receipt is considered abandoned (default 1)
  --retention-days=<n>           completed-receipt retention (default 30)
  --limit=<n>                    maximum unfinished rows and completed rows examined, 1..1000 (default 200 each)
  --business=<24-hex-id>         restrict to one tenant (optional)
  --format=<text|json>           output shape (default text)
  --help                         this text

Only a ledger row or an exact INVENTORY_WRITTEN inventory snapshot can complete a
movement. Any other unfinished receipt becomes REQUIRES_ATTENTION; nothing is
deleted except COMPLETED receipts past retention. Run without --apply first.
`;

function positiveInt(raw, name, { max = 1000 } = {}) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    withProduction: false,
    olderThanMinutes: 1,
    retentionDays: 30,
    limit: 200,
    businessId: null,
    format: 'text',
    help: false,
  };
  const problems = [];
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--older-than-minutes=')) {
      try {
        args.olderThanMinutes = positiveInt(raw.slice('--older-than-minutes='.length), '--older-than-minutes', {
          max: 60 * 24 * 365,
        });
      } catch (err) {
        problems.push(err.message);
      }
    } else if (raw.startsWith('--retention-days=')) {
      try {
        args.retentionDays = positiveInt(raw.slice('--retention-days='.length), '--retention-days', {
          max: 3650,
        });
      } catch (err) {
        problems.push(err.message);
      }
    } else if (raw.startsWith('--limit=')) {
      try {
        args.limit = positiveInt(raw.slice('--limit='.length), '--limit');
      } catch (err) {
        problems.push(err.message);
      }
    } else if (raw.startsWith('--business=')) {
      const value = raw.slice('--business='.length).trim();
      if (!/^[0-9a-fA-F]{24}$/.test(value)) problems.push('--business must be a 24-hex business id');
      else args.businessId = value;
    } else if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) problems.push('--format must be text or json');
      else args.format = value;
    } else {
      problems.push(`unknown argument: ${raw}`);
    }
  }
  return { args, problems };
}

export function formatText(report, database) {
  const lines = [
    `Movement receipt maintenance on ${database}${report.dryRun ? ' (DRY RUN)' : ' (APPLIED)'}`,
    '',
    `scanned            ${report.scanned}`,
    `recovered          ${report.recovered}`,
    `flagged attention  ${report.flagged}`,
    `blocked attention  ${report.blocked}`,
    `pruned             ${report.pruned}`,
    `failed             ${report.failed}`,
  ];
  if (report.items.length > 0) {
    lines.push('', 'rows');
    for (const item of report.items) {
      lines.push(
        `  ${item.action.padEnd(8)} ${item.receiptId} ${item.kind} state=${item.state} ` +
          `evidence=${item.evidence} ledger=${item.ledgerId ?? 'none'}`,
      );
    }
  }
  lines.push(
    '',
    report.dryRun
      ? 'Nothing was modified. Re-run with --apply to perform the listed proven actions.'
      : 'Only proven recoveries and completed-receipt retention actions were applied. Blocked attention was left unchanged.',
  );
  return lines.join('\n');
}

/**
 * Run the command and return its documented exit code. Dependencies are
 * injectable so the CLI contract can be tested without a live database; the
 * default path is still the real mongoose connection and maintenance service.
 */
export async function runCli({
  argv = process.argv.slice(2),
  envConfig = env,
  databaseNames = DATABASE_NAMES,
  selectDatabases = databasesToCheck,
  connect = (uri, options) => mongoose.connect(uri, options),
  disconnect = () => mongoose.disconnect(),
  maintenance = runMovementReceiptMaintenance,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let connected = false;
  try {
    const { args, problems } = parseArgs(argv);
    if (args.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (problems.length > 0) {
      throw new NotChecked(`invalid arguments:\n  ${problems.join('\n  ')}`);
    }
    if (!envConfig.mongodbUri) {
      throw new NotChecked('MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was changed.');
    }
    if (envConfig.mongodbDbName === databaseNames.test) {
      throw new NotChecked(
        'this shell resolves the TEST database, which "npm test" owns. Point MONGODB_DB_NAME at ' +
          'development (or use --with-production). Nothing was changed.',
      );
    }

    const [database] = selectDatabases({ withProduction: args.withProduction, databaseNames });
    try {
      await connect(envConfig.mongodbUri, {
        dbName: database,
        autoIndex: false,
        autoCreate: false,
      });
      connected = true;
    } catch (err) {
      throw new NotChecked(
        `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2).`,
      );
    }

    const report = await maintenance({
      dryRun: !args.apply,
      olderThanMs: args.olderThanMinutes * 60_000,
      retentionMs: args.retentionDays * 24 * 60 * 60 * 1000,
      limit: args.limit,
      businessId: args.businessId || undefined,
    });
    const payload = {
      command: 'recover:movement-receipts',
      database,
      generatedAt: new Date().toISOString(),
      defaults: {
        olderThanMs: MOVEMENT_RECEIPT_STALE_MS,
        retentionMs: MOVEMENT_RECEIPT_RETENTION_MS,
      },
      ...report,
      note: report.dryRun
        ? 'DRY RUN: nothing was modified.'
        : 'Proven repairs and completed-receipt retention only; blocked attention was left unchanged.',
    };
    stdout.write(
      args.format === 'json' ? `${JSON.stringify(payload, null, 2)}\n` : `${formatText(report, database)}\n`,
    );

    const work =
      report.recovered + report.flagged + report.pruned + report.blocked + report.failed;
    // A dry run with work is exit 1 so a scheduler cannot mistake a report for a
    // clean pass. An apply that flags a row has left attention behind, so it is
    // also exit 1 even though it is no longer a dry run.
    return report.failed > 0 || report.blocked > 0 || report.flagged > 0 || (report.dryRun && work > 0)
      ? 1
      : 0;
  } catch (err) {
    stderr.write(
      `[movement-receipt-maintenance] NOT CHECKED (exit 2) — ${
        err instanceof NotChecked ? err.message : err?.message ?? err
      }\n`,
    );
    stderr.write('[movement-receipt-maintenance] nothing was changed.\n');
    return 2;
  } finally {
    if (connected) {
      try {
        await disconnect();
      } catch {
        // The report is already written; disconnect failure changes nothing.
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}