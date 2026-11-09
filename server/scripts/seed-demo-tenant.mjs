// `npm run seed:demo-tenant -- --database=<resolved database name>`
//
// Create (or refresh) ONE small demo tenant and print what the assistant MUST
// answer from it. This is the tenant the preview APK is tested against, so the
// numbers on screen can be compared with the numbers this command prints.
//
// WHY A SEPARATE COMMAND FROM `seed:demo`. That seeder writes tens of thousands of
// documents for measuring queries; this one writes a small fixed fixture of 14
// curated products, three locations, 22 stock rows (136 units) and 30 ledger
// movements — small enough that every figure is known in advance, and safe enough
// to run where the build runs.
//
// SAFETY. The database must be NAMED on the command line and must equal the one
// `config/env.ts` resolved; the test database is refused; a confirmation phrase is
// required. A re-run resets ONLY the demo tenant's data, and refuses outright if the
// demo address already belongs to a different business.
//
// The Firebase identity is created when absent (with `emailVerified: true`, because
// it is a test credential) and is NEVER deleted by the teardown — see
// `scripts/demo/lib.mjs` for why.
//
// Usage:
//   DEMO_ACCOUNT_PASSWORD='…' SEED_CONFIRM=seed-demo-tenant \
//     npm run seed:demo-tenant -- --database=inventoryai_prod_db
//
// Teardown (two phrases; production adds the third):
//   CLEANUP_CONFIRM=cleanup:demo-tenant CLEANUP_DB_CONFIRM=<name> \
//     npm run cleanup:demo-tenant -- --database=<name>

import 'dotenv/config';
import mongoose from 'mongoose';

import env from '../src/config/env.ts';
import { countTenantDataRemoval } from '../src/services/tenantTeardown.service.ts';
import {
  DEMO_SEED_CONFIRM,
  DemoTenantError,
  assertDemoTarget,
  findDemoTenant,
  isProductionDatabase,
  planSeed,
  seedDemoTenant,
  verifyDemoTenant,
} from './demo/lib.mjs';
import { DEMO_TENANT } from './demo/fixture.mjs';

const COMMAND = 'seed:demo-tenant';

function argValue(flag, argv = process.argv) {
  const prefix = `${flag}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exit(1);
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const database = assertDemoTarget({
    mongodbUri: env.mongodbUri,
    resolvedDbName: env.mongodbDbName,
    requestedDatabase: argValue('--database'),
    confirm: process.env.SEED_CONFIRM,
    confirmPhrase: DEMO_SEED_CONFIRM,
  });

  console.log(`[${COMMAND}] database : ${database}${isProductionDatabase(database) ? '   (PRODUCTION)' : ''}`);
  console.log(`[${COMMAND}] tenant   : "${DEMO_TENANT.businessName}" / ${DEMO_TENANT.email}`);
  console.log(`[${COMMAND}]           ${DEMO_TENANT.ownerName}, ${DEMO_TENANT.role}`);
  if (dryRun) console.log(`[${COMMAND}] mode     : DRY RUN — counting only, nothing will be written`);

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });

  if (dryRun) {
    // The preview stops BEFORE `seedDemoTenant`, which resolves the identity (creating it when it
    // is absent, with the password from DEMO_ACCOUNT_PASSWORD) and clears the tenant's data. A
    // preview may not write to either store, so it reports the plan and the rows that would go.
    const plan = planSeed(await findDemoTenant());
    if (plan.action === 'refuse') {
      // A refusal is not a completed preview. Exiting 0 here said "the dry run agrees"
      // when the half-state or a different business is exactly what the real run refuses.
      await mongoose.disconnect();
      fail(plan.reason);
    }
    const what = {
      create: 'would CREATE a new tenant',
      'attach-user': `would ATTACH the owner to ${plan.businessId}`,
      reset: `${plan.businessId} would be REPLACED`,
    }[plan.action];
    console.log(`[${COMMAND}] tenant   : ${what}`);
    if (plan.businessId) {
      const { total, counts } = await countTenantDataRemoval([plan.businessId]);
      for (const [collection, count] of Object.entries(counts)) {
        if (count > 0) console.log(`[${COMMAND}]   ${collection.padEnd(24)} ${count}`);
      }
      console.log(`[${COMMAND}] would clear ${total} document(s), then write the fixture again.`);
    }
    console.log(
      `[${COMMAND}] firebase : not touched by this preview; a real run creates or refreshes ` +
        `${DEMO_TENANT.email}`,
    );
    console.log(`[${COMMAND}] DRY RUN complete — nothing was written.`);
    await mongoose.disconnect();
    return;
  }

  const started = Date.now();

  const result = await seedDemoTenant();
  console.log(
    `[${COMMAND}] identity : uid ${String(result.identity.uid).slice(0, 10)}… ` +
      `(${result.identity.created ? 'CREATED now' : 'already existed'})` +
      `${result.identity.passwordRefreshed ? ', password refreshed from DEMO_ACCOUNT_PASSWORD' : ''}`,
  );
  console.log(
    `[${COMMAND}] tenant   : ${result.businessCreated ? 'CREATED' : 'reused'} ${result.businessId}` +
      `${result.userCreated ? ', MongoDB user CREATED' : ''}` +
      `${result.cleared > 0 ? `, reset ${result.cleared} previous document(s)` : ''}`,
  );

  const verification = await verifyDemoTenant(result.businessId);
  console.log('');
  console.log(`[${COMMAND}]   categories  ${pad(result.counts.categories, 3)}`);
  console.log(`[${COMMAND}]   locations   ${pad(result.counts.locations, 3)}`);
  console.log(`[${COMMAND}]   products    ${pad(result.counts.products, 3)}`);
  console.log(`[${COMMAND}]   inventory   ${pad(result.counts.inventory, 3)}`);
  console.log(`[${COMMAND}]   movements   ${pad(result.counts.transactions, 3)}`);

  const { summary, breakdown, restock } = verification.expected;
  console.log('');
  console.log(`[${COMMAND}] what the assistant must answer from this tenant`);
  console.log(`[${COMMAND}]   products ${summary.totalProducts}, on hand ${summary.totalInventoryQuantity} units`);
  console.log(
    `[${COMMAND}]   healthy ${summary.inStockProducts}, low ${summary.lowStockProducts}, ` +
      `out ${summary.outOfStockProducts}`,
  );
  for (const loc of breakdown.locations) {
    console.log(`[${COMMAND}]   ${pad(loc.name, 16)} ${pad(loc.units, 3)} units / ${loc.products} product(s)`);
  }
  console.log(`[${COMMAND}]   restock, in the server's order`);
  for (const row of restock) {
    console.log(
      `[${COMMAND}]   ${pad(row.stockStatus, 12)} ${pad(row.name, 22)} available ${row.available}, ` +
        `minimum ${row.minimumStock}`,
    );
  }

  console.log('');
  const failed = verification.checks.filter((c) => !c.ok);
  for (const check of verification.checks) {
    console.log(
      `[${COMMAND}] ${check.ok ? 'ok  ' : 'FAIL'} ${pad(check.name, 26)} ` +
        `${JSON.stringify(check.actual)} (expected ${JSON.stringify(check.expected)})`,
    );
  }
  console.log('');
  if (failed.length > 0) {
    await mongoose.disconnect();
    fail(
      `${failed.length} verification check(s) disagree with the fixture. The tenant was written ` +
        'but does NOT match what this command printed as the expected answers — do not test against it.',
    );
  }
  console.log(`[${COMMAND}] OK — ${verification.checks.length} checks match the fixture`);
  console.log(`[${COMMAND}] businessId : ${result.businessId}`);
  console.log(`[${COMMAND}] elapsed    : ${Date.now() - started} ms`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  await mongoose.disconnect().catch(() => {});
  if (err instanceof DemoTenantError) fail(err.message);
  fail(err && err.message ? err.message : String(err));
});
