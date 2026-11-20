// `npm run audit:product-currency [-- --with-production] [--business=<id>] [--format=json]`
//
// READ-ONLY audit of products whose price currency is missing or not an exact
// ISO 4217 tender code. It never assigns, repairs or infers a currency: a human
// who has verified the source resolves a row with
//   PATCH /api/products/:id  { "currency": "PHP" }
// (or the product edit form, which now requires the field).
//
// The database rule is the same as `audit:integrity` and
// `audit:price-quality`: development by default, production only with
// --with-production, and the test database is refused because `npm test` owns it.
//
// EXIT CODES
//   0  ran to completion, every product has a valid currency
//   1  ran to completion, at least one product needs attention
//   2  NOT CHECKED (bad arguments, no connection string, test database, unreachable)

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { productCurrencyAuditReport } from '../src/services/productCurrencyAudit.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Audit product price currencies (READ-ONLY).

Usage:
  npm run audit:product-currency [options]

Options:
  --with-production       read the production database instead of development
  --business=<24-hex id>  restrict the audit to one tenant
  --format=<text|json>    output shape (default text)
  --help                  this text

A missing or invalid currency is not repaired here. Resolve it only after
verifying the product's actual currency, then PATCH the product with that ISO
4217 code (for example PHP). This command writes nothing.
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
    'Product currency audit (READ-ONLY)',
    `database=${database} tenant=${report.businessId ?? 'all'} total=${report.totalProducts}`,
    '',
    `valid currency    ${report.validCurrency}`,
    `missing currency  ${report.missingCurrency}`,
    `invalid currency  ${report.invalidCurrency}`,
    '',
    'currency distribution',
  ];
  if (report.currencies.length === 0) lines.push('  (no products)');
  for (const row of report.currencies) {
    lines.push(`  ${row.currency ?? '(unrecorded)'}  ${row.count}`);
  }
  if (report.samples.length > 0) {
    lines.push('', `first ${report.samples.length} product(s) needing attention`);
    for (const row of report.samples) {
      lines.push(
        `  ${row.problem}  ${row.name || '(unnamed)'}${row.sku ? ` [${row.sku}]` : ''} ` +
          `status=${row.status} cost=${row.costPrice} selling=${row.sellingPrice} ` +
          `currency=${row.currency ?? '(none)'} id=${row.productId}`
      );
    }
  }
  lines.push(
    '',
    'Nothing was modified. Verify the source, then set the currency explicitly:',
    '  PATCH /api/products/:id  { "currency": "PHP" }'
  );
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
    const report = await productCurrencyAuditReport({ businessId: args.businessId });
    const problemCount = report.missingCurrency + report.invalidCurrency;

    if (args.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          {
            command: 'audit:product-currency',
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
      `[product-currency] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`
    );
    console.error('[product-currency] nothing was checked, so this says nothing about the currencies.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
