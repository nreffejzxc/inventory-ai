// `npm run resolve:product-currency -- --evidence=<file> [--apply] [--with-production] [--format=json]`
//
// Apply a HUMAN-APPROVED evidence file as a batch of idempotent PATCH-like
// updates. This command never guesses a currency: every row must carry an
// explicit ISO 4217 code and the evidence the reviewer checked. A dry run is
// the default; --apply is required to write. An existing valid, different code
// is a conflict and is never overwritten.
//
// `--template --business=<24-hex id>` prints a review file for every currently
// missing/invalid row. Fill in the reviewer, source, currency and evidence, then
// run the normal command. The template is read-only.
//
// EXIT CODES
//   0  applied cleanly, or a dry run found nothing to change
//   1  completed, but at least one row conflicts, is missing, or needs review
//   2  NOT CHECKED (bad arguments/file, test database, unreachable, no approval)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import {
  resolveProductCurrencies,
  unresolvedCurrencyCandidates,
  validateCurrencyResolutionEvidence,
} from '../src/services/productCurrencyResolution.service.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Resolve legacy product currencies from human-approved evidence.

Usage:
  npm run resolve:product-currency -- --evidence=<file> [--apply]
  npm run resolve:product-currency -- --template --business=<id> [--out=<file>]

Options:
  --evidence=<file>       reviewed JSON evidence file
  --apply                 write the verified codes (default is a dry run)
  --template              print a review file for every missing/invalid row
  --business=<24-hex id>  tenant for --template
  --out=<file>            write the template to a file instead of stdout
  --with-production       target production instead of development
  --format=<text|json>    output shape (default text)
  --help                  this text

Production writes are refused unless RESOLVE_PROD_CONFIRM is exactly
RESOLVE-PRODUCTION-CURRENCY. The test database is always refused.

The command is idempotent: a row already holding the requested code is a no-op,
and a row holding a different valid code is a conflict. It never infers a
currency from a locale, a symbol, a price or the tenant.
`;

const PRODUCTION_CONFIRM = 'RESOLVE-PRODUCTION-CURRENCY';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    evidence: null,
    apply: false,
    template: false,
    businessId: null,
    out: null,
    withProduction: false,
    format: 'text',
    help: false,
    problems: [],
  };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--template') args.template = true;
    else if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--evidence=')) args.evidence = raw.slice('--evidence='.length).trim();
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length).trim();
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
  if (args.template) {
    if (!args.businessId) args.problems.push('--template requires --business=<24-hex id>');
    if (args.evidence) args.problems.push('--template cannot be combined with --evidence');
    if (args.apply) args.problems.push('--template is read-only and cannot be combined with --apply');
  } else if (!args.evidence) {
    args.problems.push('--evidence=<file> is required (or use --template)');
  }
  return args;
}

function candidateTemplate(businessId, candidates) {
  return {
    version: 1,
    businessId,
    reviewedBy: '',
    reviewedAt: new Date().toISOString(),
    source: '',
    entries: candidates.map((row) => ({
      productId: String(row._id),
      expectedName: row.name ?? '',
      currency: '',
      evidence: '',
    })),
  };
}

function textReport(report, database) {
  const lines = [
    `Product currency resolution (${report.dryRun ? 'DRY RUN' : 'APPLY'})`,
    `database=${database} business=${report.businessId}`,
    `reviewedBy=${report.reviewedBy} reviewedAt=${report.reviewedAt}`,
    `source=${report.source}`,
    '',
    `resolved         ${report.resolved}`,
    `would resolve    ${report.wouldResolve}`,
    `already resolved ${report.alreadyResolved}`,
    `conflicts        ${report.conflicts}`,
    `not found        ${report.notFound}`,
    `name mismatches  ${report.nameMismatches}`,
    `failed           ${report.failed}`,
  ];
  if (report.rows.length > 0) {
    lines.push('', 'rows');
    for (const row of report.rows) {
      lines.push(
        `  ${row.status.padEnd(15)} ${row.name ?? '(unnamed)'} ` +
          `${row.previousCurrency ?? '(none)'} -> ${row.currency} id=${row.productId}` +
          `${row.message ? ` — ${row.message}` : ''}` +
          `${row.auditRecorded === false ? ' [AUDIT GAP]' : ''}`
      );
    }
  }
  if (report.dryRun) lines.push('', 'No writes were made. Re-run with --apply after reviewing this report.');
  return lines.join('\n');
}

async function connect(database) {
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
  if (args.apply && args.withProduction && process.env.RESOLVE_PROD_CONFIRM !== PRODUCTION_CONFIRM) {
    throw new NotChecked(
      `production writes require RESOLVE_PROD_CONFIRM=${PRODUCTION_CONFIRM}. NOT CHECKED (exit 2).`
    );
  }

  const [database] = databasesToCheck({
    withProduction: args.withProduction,
    databaseNames: DATABASE_NAMES,
  });

  if (args.template) {
    await connect(database);
    try {
      const candidates = await unresolvedCurrencyCandidates({ businessId: args.businessId, limit: 5_000 });
      const output = JSON.stringify(candidateTemplate(args.businessId, candidates), null, 2);
      if (args.out) {
        const outPath = path.resolve(process.cwd(), args.out);
        fs.writeFileSync(outPath, `${output}\n`, 'utf8');
        console.log(`Wrote a read-only review template to ${outPath} (${candidates.length} row(s)).`);
      } else {
        process.stdout.write(`${output}\n`);
      }
      return candidates.length > 0 ? 1 : 0;
    } finally {
      await mongoose.disconnect();
    }
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.evidence), 'utf8'));
  } catch (err) {
    throw new NotChecked(`could not read/parse --evidence: ${err?.message ?? err}. NOT CHECKED (exit 2).`);
  }
  const validated = validateCurrencyResolutionEvidence(raw);
  if (!validated.ok) {
    throw new NotChecked(`evidence is not valid:\n  ${validated.errors.join('\n  ')}`);
  }

  await connect(database);
  try {
    const report = await resolveProductCurrencies({
      evidence: validated.evidence,
      apply: args.apply,
    });
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify({ command: 'resolve:product-currency', database, ...report }, null, 2)}\n`);
    } else {
      console.log(textReport(report, database));
    }
    const unresolved =
      report.conflicts + report.notFound + report.nameMismatches + report.failed + report.wouldResolve;
    return unresolved > 0 ? 1 : 0;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The report is already written.
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
    console.error('[product-currency] nothing was written, so no currency was resolved.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
