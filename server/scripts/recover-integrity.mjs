// `npm run recover:integrity [-- --with-production]`
//
// Run ONE reconciliation pass for durable stock-transfer journals and abandoned
// PO receive claims. Serving processes schedule the same pass; this command is
// for an operator after a crash, a restart, or before an audit.
//
// It performs only the exact, quantity-anchored actions in the recovery services:
// finish a transfer whose inventory legs are both present, undo a transfer whose
// destination never landed, release an untouched claim, undo a claim's exact
// stock-in, or mark a claim REQUIRES_ATTENTION. It never guesses and never
// overwrites a row a later movement changed.
//
// The database rule is the repository's: development by default, production only
// with --with-production, test refused. This command WRITES business data (only
// the recovery actions above). It is not part of `npm test`.

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { runIntegrityRecoveryPass } from '../src/services/recoveryScheduler.ts';
import { databasesToCheck } from './seed/lib.mjs';

class NotChecked extends Error {}

const USAGE = `Reconcile durable transfer journals and abandoned PO receive claims.

Usage:
  npm run recover:integrity [options]

Options:
  --with-production   act on the production database instead of development
  --format=<text|json> output shape (default text)
  --help              this text

The pass is exact and idempotent: it finishes provably complete transfers, undoes
provably partial ones, releases untouched claims, undoes a claim's exact stock-in,
and flags anything it cannot prove. It never guesses and never overwrites newer
stock. Run the read-only audits afterwards.
`;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { withProduction: false, format: 'text', help: false, problems: [] };
  for (const raw of argv) {
    if (raw === '--with-production') args.withProduction = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--format=')) {
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
    throw new NotChecked('MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was changed.');
  }
  if (env.mongodbDbName === DATABASE_NAMES.test) {
    throw new NotChecked(
      'this shell resolves the TEST database, which "npm test" owns. Point MONGODB_DB_NAME at ' +
        'development (or use --with-production). Nothing was changed.'
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
      `could not reach MongoDB for ${database}: ${err?.message ?? err}. NOT CHECKED (exit 2).`
    );
  }

  try {
    const totals = await runIntegrityRecoveryPass();
    const payload = {
      command: 'recover:integrity',
      database,
      generatedAt: new Date().toISOString(),
      ...totals,
    };
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(`Integrity recovery on ${database}`);
      console.log(
        totals.skipped === 'lease-held'
          ? 'lease: held by another recovery pass; this run did nothing'
          : 'lease: acquired for this pass'
      );
      if (totals.transfers) {
        console.log(
          `transfers: scanned=${totals.transfers.scanned} completed=${totals.transfers.completed} ` +
            `compensated=${totals.transfers.compensated} flagged=${totals.transfers.flagged} failed=${totals.transfers.failed}`
        );
      } else {
        console.log('transfers: not run');
      }
      if (totals.claims) {
        console.log(
          `PO claims: scanned=${totals.claims.scanned} released=${totals.claims.released} ` +
            `undone=${totals.claims.undone} receipted=${totals.claims.receipted} ` +
            `flagged=${totals.claims.flagged} failed=${totals.claims.failed}`
        );
      } else {
        console.log('PO claims: not run');
      }
      console.log('Anything flagged REQUIRES_ATTENTION must be reviewed by hand.');
    }
    const failed = (totals.transfers?.failed ?? 0) + (totals.claims?.failed ?? 0);
    // A skipped pass is not a failed reconciliation: another instance owns the
    // lease and is doing the work. This is the duplicate-run prevention path.
    return failed > 0 ? 1 : 0;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // The pass is durable; a failed disconnect changes nothing it did.
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(
      `[recover-integrity] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`
    );
    console.error('[recover-integrity] nothing was changed.');
    try {
      await mongoose.disconnect();
    } catch {
      // Already failing.
    }
    process.exitCode = 2;
  });
