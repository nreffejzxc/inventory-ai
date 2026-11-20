// `npm run audit:price-quality [-- --with-production] [--business=<id>] [--format=json]`
//
// READ-ONLY price-data quality report for ACTIVE products. It counts rows whose
// selling price is absent or zero, rows with no recorded currency, and rows with
// a malformed currency code, then lists the currency distribution and a bounded
// sample. It never writes, repairs or guesses a currency: the assistant can only
// be as currency-safe as the catalogue data.
//
// The database rule is the same as `audit:integrity`: development by default,
// production only with --with-production, and the test database is refused
// because `npm test` owns it.
//
// EXIT CODES
//   0  ran to completion, no price-data problem
//   1  ran to completion, at least one problem
//   2  NOT CHECKED (bad arguments, no connection string, test database, unreachable)

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { priceQualityReport } from '../src/services/priceQuality.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Report price-data quality for ACTIVE products (READ-ONLY).

Usage:
  npm run audit:price-quality [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict the report to one tenant
  --format=<text|json>    output shape (default text)
  --help                  this text

A MISSING or ZERO price is not "free"; a MISSING currency cannot join a numeric
comparison; an INVALID currency looks comparable but is not a currency code.
Nothing is modified. There is no repair flag.
`;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    withProduction: false,
    businessId: null,
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
    } else if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json');
      else args.format = value;
    } else args.problems.push(`unknown argument: ${raw}`);
  }
  return args;
}

function textReport(report, database) {
  const lines = [
    'Price-data quality (READ-ONLY)',
    `database=${database} tenant=${report.businessId ?? 'all'} ` +
      `active=${report.totalActiveProducts} priced=${report.pricedProducts}`,
    '',
    `money field`,
    `  missing price   ${report.missingPrice}`,
    `  zero price      ${report.zeroPrice}`,
    `  missing currency${report.missingCurrency.toString().padStart(2)}`,
    `  invalid currency${report.invalidCurrency.toString().padStart(2)}`,
    '',
    'currency distribution',
  ];
  if (report.currencies.length === 0) lines.push('  (none)');
  for (const row of report.currencies) {
    lines.push(`  ${row.currency ?? '(unrecorded)'}  ${row.count}`);
  }
  if (report.samples.length > 0) {
    lines.push('', `first ${report.samples.length} row(s) needing attention`);
    for (const row of report.samples) {
      lines.push(
        `  ${row.problem}  ${row.name || '(unnamed)'}${row.sku ? ` [${row.sku}]` : ''} ` +
          `price=${row.sellingPrice} currency=${row.currency ?? '(none)'} id=${row.productId}`
      );
    }
  }
  lines.push('', 'Nothing was modified. This is a report, not a repair.');
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
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2) — this is not a finding.`
    );
  }

  try {
    const report = await priceQualityReport({ businessId: args.businessId });
    const problemCount =
      report.missingPrice + report.zeroPrice + report.missingCurrency + report.invalidCurrency;

    if (args.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          {
            command: 'audit:price-quality',
            readOnly: true,
            database,
            ...report,
            generatedAt: report.generatedAt.toISOString(),
            problemCount,
            note: 'Nothing was modified. A report, not a repair.',
          },
          null,
          2
        )}\n`
      );
    } else {
      console.log(textReport(report, database));
    }
    return problemCount > 0 ? 1 : 0;
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
      `[price-quality] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`
    );
    console.error('[price-quality] nothing was checked, so this says nothing about the prices.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
