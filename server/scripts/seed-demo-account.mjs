// `npm run seed:demo -- --email=<you@example.com> [--total=80000] [--seed=1]`
//   [--codes=both|none|sku|barcode]`
// `npm run seed:demo -- --database=<name> --business=<id> --email=<you@example.com>`
//
// Give ONE real account a large, realistic inventory dataset so the AI assistant
// can be asked questions at a scale a test fixture never reaches, and so the phone
// the owner already signs in with lands directly in that dataset.
//
// For SEVERAL accounts at once (each with its own size, and WITHOUT generated
// SKUs/barcodes) use `seed:accounts` instead — see seed-accounts.mjs. Both call the
// same `seedTenant` core in ./seed/lib.mjs; this file is the single-account CLI.
//
// WHY IT ATTACHES TO AN EXISTING IDENTITY RATHER THAN INVENTING ONE. The application
// joins Firebase to MongoDB on `firebaseUid` ONLY (never email), and the exchange
// resolves a user by that uid. So the honest way to hand an existing login a seeded
// tenant is: resolve the uid from FIREBASE (the identity authority), then create or
// reuse the MongoDB User that carries it — exactly the linkage the registration flow
// writes. Nothing here reads a user by email in MongoDB.
//
// WHY IT DOES NOT DELETE FIREBASE IDENTITIES. `docs/DEVELOPMENT_ROADMAP.md` §27BB
// (F-50) records what happens when the two stores are cleaned in the wrong
// relationship: a MongoDB user whose Firebase identity was deleted can neither sign
// in nor register (`409 EMAIL_IN_USE`), and **nothing in the application can repair
// it**. Clearing MongoDB alone is the safe direction — it frees every address and
// orphans nothing. This script therefore never deletes a Firebase user, and it only
// ever creates one when the requested identity does not exist.
//
// SAFETY. `assertSeedTarget` requires `--database=` to equal the database this
// process resolved, refuses the test database and any unknown one, and requires two
// phrases in development or three in production — all before a connection is opened.
// A re-run resets ONLY the data of the one tenant the resolved account owns (never
// the account rows), by businessId, so another tenant cannot be reached even if the
// wrong id were supplied.
//
// PRODUCTION. The same command can write into a NAMED database, production
// included: `--database=<name>` must equal the database this process resolved, and
// that target needs THREE phrases (SEED_CONFIRM, SEED_DB_CONFIRM and
// SEED_PROD_CONFIRM). Because this script
// REPLACES the data of the business the account owns, a production run additionally
// requires `--business=<id>` as soon as that business already exists — naming the
// tenant is what proves the reset is meant. A production run never rewrites an
// EXISTING login's password, even when DEMO_ACCOUNT_PASSWORD is set: seeding is not a
// credential operation, and that address may belong to a person. Creating a brand-new
// identity still uses the password, because there is no credential to preserve.
//
// DETERMINISTIC: a seeded PRNG (`--seed`, default 1) means the same dataset every
// run, so two measurements describe the same tenant.
//
// PRODUCT CODES. `--codes=both|none|sku|barcode` selects the fields on every seeded product,
// through the same parser `seed:accounts` uses. This command has always written both, so its
// default stays `both`; `none` leaves the app's own barcode generation to assign the first
// code, `sku` writes only the SKU, and `barcode` writes only a valid, unique EAN-13.
//
// Teardown: re-running the script resets the tenant, which is the documented way
// back; `clearTenantData` is exported from ./perf/lib.mjs for a targeted removal.
// The performance tenant (Part 3G) has its own `cleanup:perf-tenant`.
//
// Usage (development — TWO phrases; the database is always named):
//   SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_dev_db \
//     npm run seed -- --plan=demo --database=inventoryai_dev_db \
//       --email=you@example.com --total=80000
//   … add --dry-run to print the plan without writing; in production it connects read-only to
//     check the named tenant, while the development preview opens no connection at all.
//
// Production (THREE phrases, and the tenant being reset is named too):
//   NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
//     SEED_CONFIRM=seed-demo-account \
//     SEED_DB_CONFIRM=inventoryai_prod_db \
//     SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
//     npm run seed -- --plan=demo --database=inventoryai_prod_db \
//       --email=you@example.com --business=<the id verify:demo prints> --total=60000
//
// `npm run seed:demo` is the same command with the plan preselected, and takes the
// same phrases. The rule itself lives in ./seed/guard.mjs, not here.
//
// If the Firebase identity does not exist yet, supply its initial password through
// the environment (never on the command line, never in this file):
//   DEMO_ACCOUNT_PASSWORD='…' SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_dev_db \
//     npm run seed -- --plan=demo --database=inventoryai_dev_db --email=new@example.com

import 'dotenv/config';
import mongoose from 'mongoose';

import env from '../src/config/env.ts';
import User from '../src/models/user.model.ts';
import { SeedSafetyError, clearTenantData, countTenantDataRemoval } from './perf/lib.mjs';
import { assertSeedTarget } from './seed/guard.mjs';
import {
  assertOneBusinessAssociation,
  assertProductionTenantOwnership,
  assertRequestedTenantKnown,
  assertRequestedTenantMatches,
  assertTenantNamedForReset,
  codeFields,
  countDisagreements,
  ensureTenantForIdentity,
  isEmailAddress,
  makeRandom,
  normaliseBusinessId,
  normaliseEmail,
  parseCount,
  parseRunwideCodes,
  readBusinessAssociations,
  readIdentity,
  readTenantCounts,
  resolveExistingTenantForIdentity,
  resolveIdentity,
  seedTenant,
} from './seed/lib.mjs';

const COMMAND = 'seed:demo';
const CONFIRM_PHRASE = 'seed-demo-account';

/** The tenant this seeder names when it has to CREATE one. Never renamed afterwards. */
const DEMO_BUSINESS_NAME = 'AI SCALE TEST — 80k seeded dataset';

function argValue(flag, argv = process.argv) {
  const prefix = `${flag}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exit(1);
}

/**
 * What a PRODUCTION dry run can prove without writing.
 *
 * The development preview stays connection-free, because it creates tenants there and a
 * preview cannot create one. A production run, by contrast, REPLACES an existing tenant;
 * its preview must compare a supplied `--business` with the tenant the account actually
 * owns. Without this, a wrong id printed a success and exit 0 while the same command for
 * real refused (the defect fixed in seed:accounts on 2026-10-28). Every lookup here is
 * read-only: `readIdentity` never creates, and `resolveExistingTenantForIdentity` never
 * writes.
 */
async function previewProductionDryRun({ email, requestedBusiness, database, total }) {
  try {
    await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  } catch (err) {
    throw new SeedSafetyError(
      `could not read ${database} to check the tenant (${String(err.message).split('\n')[0]}). ` +
        'Nothing was written — and the tenant was NOT checked. Fix the connection and re-run the dry run.',
    );
  }

  try {
    const identity = await readIdentity(email);
    if (!identity) {
      if (requestedBusiness) {
        throw new SeedSafetyError(
          `--business=${requestedBusiness} names no tenant for ${email}, and no Firebase identity exists ` +
            'either. A production run would create a tenant only when no id is named. Nothing was written.',
        );
      }
      if (!process.env.DEMO_ACCOUNT_PASSWORD) {
        throw new SeedSafetyError(
          `no Firebase identity exists for ${email}, and DEMO_ACCOUNT_PASSWORD is not set. A real run ` +
            'would refuse rather than create the login. Set it to preview the creation. Nothing was written.',
        );
      }
      // A row with no identity is the F-50 state, not a new account. `ensureTenantForIdentity`
      // refuses it; the preview must not promise a create the real run would reject.
      const stranded = await User.findOne({ email }).select('_id businessId').lean();
      if (stranded) {
        throw new SeedSafetyError(
          `a MongoDB account row for ${email} already exists with no Firebase identity. A real run ` +
            'would refuse rather than attach an identity or create a second row; repair the link ' +
            'deliberately. Nothing was written.',
        );
      }
      console.log(`[${COMMAND}] identity : absent — a real run would CREATE it`);
      console.log(`[${COMMAND}] tenant   : would be CREATED (a new business for ${email})`);
      return;
    }

    const tenant = await resolveExistingTenantForIdentity({ email, identity });
    assertOneBusinessAssociation({
      email,
      businessIds: await readBusinessAssociations({ email, firebaseUid: identity.uid }),
    });

    if (!tenant) {
      if (requestedBusiness) {
        throw new SeedSafetyError(
          `--business=${requestedBusiness} names no tenant for ${email}, whose account has no business ` +
            'of its own. A production run will not create a tenant with a chosen id. Nothing was written.',
        );
      }
      console.log(`[${COMMAND}] identity : uid ${String(identity.uid).slice(0, 10)}… (already existed)`);
      console.log(`[${COMMAND}] tenant   : would be CREATED (this account has no business yet)`);
      return;
    }

    // The real run's rules, applied here so a missing tenant, a renamed id or a non-OWNER
    // fails the preview rather than the write.
    assertProductionTenantOwnership({
      email,
      tenant,
      requestedBusinessId: requestedBusiness,
      command: COMMAND,
      namingHint: '--business=<businessId>',
    });
    // The ownership rule accepts an omitted id (seed:accounts resolves one from each
    // address). THIS command's contract is stricter: replacing an existing tenant must
    // name it, exactly as the real run's final check does.
    assertTenantNamedForReset({
      production: true,
      reused: true,
      requestedBusinessId: requestedBusiness,
      businessId: tenant.businessId,
      businessName: tenant.businessName,
      command: COMMAND,
      namingHint: '--business=<businessId>',
    });

    const { total: existing, counts } = await countTenantDataRemoval([tenant.businessId]);
    console.log(`[${COMMAND}] identity : uid ${String(identity.uid).slice(0, 10)}… (already existed)`);
    console.log(`[${COMMAND}] tenant   : ${tenant.businessName} (${String(tenant.businessId)}) would be REPLACED`);
    for (const [collection, count] of Object.entries(counts)) {
      if (count > 0) console.log(`[${COMMAND}]   ${collection.padEnd(24)} ${count}`);
    }
    console.log(
      `[${COMMAND}] would clear ${existing.toLocaleString()} document(s), then write ~${total.toLocaleString()} ` +
        'document(s).',
    );
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  // Lower-cased once, here: the schema lower-cases on write but queries are exact, so a
  // mixed-case argument would find the Firebase identity and miss the database row.
  const email = normaliseEmail(argValue('--email'));
  const rawBusiness = argValue('--business');
  const requestedBusiness = normaliseBusinessId(rawBusiness);
  const dryRun = process.argv.includes('--dry-run');

  // Same four choices as seed:accounts, but this command's existing default is both. The parser
  // also refuses the removed --include-sku before any connection or identity lookup.
  const codes = parseRunwideCodes(process.argv, { defaultMode: 'both' });
  const { includeSku, includeBarcode } = codeFields(codes);

  // The unified guard: `--database=` must equal the resolved database, and the
  // target class decides the phrase count — two for development, three for
  // production. It runs before any connection, identity lookup or write, on a dry
  // run as well, so a dry run proves the destination too.
  const target = assertSeedTarget({
    env,
    command: COMMAND,
    database: argValue('--database'),
    confirmPhrase: CONFIRM_PHRASE,
  });
  const production = target.production;

  if (!isEmailAddress(email)) {
    fail('--email=<a valid address> is required. Nothing was written.');
  }
  const total = parseCount(argValue('--total'), {
    name: '--total',
    min: 100,
    max: 400000,
    fallback: 80000,
  });
  const seed = parseCount(argValue('--seed'), { name: '--seed', min: 0, fallback: 1 });
  if (rawBusiness !== undefined && !requestedBusiness) {
    fail('--business must be a 24-character hexadecimal businessId. Nothing was written.');
  }

  console.log(`[${COMMAND}] database : ${target.database}${production ? '   (PRODUCTION)' : ''}`);
  console.log(`[${COMMAND}] confirmed: ${target.phrases} phrase(s) accepted`);
  console.log(`[${COMMAND}] account  : ${email}`);
  console.log(`[${COMMAND}] target   : ~${total.toLocaleString()} documents across 7 collections`);
  console.log(`[${COMMAND}] PRNG seed: ${seed} (the dataset is reproducible)`);
  console.log(`[${COMMAND}] SKU/barcode: ${codes} (--codes=both|none|sku|barcode; default both)`);

  if (dryRun) {
    console.log('');
    if (production) {
      // Read-only, but connected: a preview that cannot see the tenant cannot validate the id
      // the real run will require.
      await previewProductionDryRun({
        email,
        requestedBusiness,
        database: target.database,
        total,
      });
    } else {
      console.log(`[${COMMAND}] dry run complete — no connection was opened and nothing was written.`);
      console.log(
        `[${COMMAND}] a real run would resolve (creating only if absent) the Firebase identity for ` +
          `${email}, then REPLACE the data of the tenant that account owns.`,
      );
    }
    console.log(`[${COMMAND}] DRY RUN complete — nothing was written.`);
    console.log(
      `[${COMMAND}] to run for real: SEED_CONFIRM=${CONFIRM_PHRASE} ` +
        `SEED_DB_CONFIRM=${target.database}${production ? ' SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA' : ''} ` +
        `npm run ${COMMAND} -- --database=${target.database} …`,
    );
    return;
  }

  // A production run that names a tenant must not create the identity first and only then
  // discover that the id names nothing. The read is side-effect free; `resolveIdentity`
  // below is the call that may create an identity.
  if (production && requestedBusiness) {
    const existingIdentity = await readIdentity(email);
    if (!existingIdentity) {
      fail(
        `--business=${requestedBusiness} names no tenant for ${email}, and no Firebase identity ` +
          'exists either. A production run will not create a tenant with a chosen id. Nothing was written.',
      );
    }
  }

  // In production an existing credential is never rewritten; see resolveIdentity.
  const identity = await resolveIdentity(email, { refreshPassword: !production });
  console.log(
    `[${COMMAND}] identity : uid ${String(identity.uid).slice(0, 10)}… ` +
      `(${identity.created ? 'CREATED now' : 'already existed'}${identity.emailVerified ? ', verified' : ', NOT verified'})` +
      `${identity.passwordSkipped ? ' — password NOT changed on a production run' : ''}`,
  );

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  const started = Date.now();

  // Production validation runs against the tenant as it already exists, BEFORE any
  // create. A member must not reach the clear, and a supplied id that names no tenant
  // must not silently become a second business. The shared rule checks OWNER, the
  // account's ACTIVE status and the business's ACTIVE status.
  // Resolved in BOTH environments, and before any create: the read is what makes a supplied
  // `--business` checkable, and development must check it too (§27GQ).
  const existing = await resolveExistingTenantForIdentity({ email, identity });
  if (production && existing) {
    assertOneBusinessAssociation({
      email,
      businessIds: await readBusinessAssociations({ email, firebaseUid: identity.uid }),
    });
    assertProductionTenantOwnership({
      email,
      tenant: existing,
      requestedBusinessId: requestedBusiness,
      command: COMMAND,
      namingHint: '--business=<businessId>',
    });
  }
  if (production && !existing && requestedBusiness) {
    fail(
      `--business=${requestedBusiness} names no tenant for ${email}, and a production run ` +
        'will not create a tenant with a chosen id. Nothing was written.',
    );
  }

  // The same claim-checks the accounts seeder applies, BEFORE a tenant can be created. A supplied
  // `--business` was parsed and then ignored outside production, so a mistyped id replaced the
  // caller's own tenant instead of being refused; an id naming NO tenant was replaced by a
  // generated one. Both are refusals now (§27GQ).
  if (!production && existing) {
    assertRequestedTenantMatches({
      email,
      requestedBusinessId: requestedBusiness,
      businessId: existing.businessId,
      command: COMMAND,
    });
  }
  if (!production && !existing) {
    assertRequestedTenantKnown({
      email,
      requestedBusinessId: requestedBusiness,
      command: COMMAND,
      namingHint: '--business',
    });
  }

  const tenant = existing ?? await ensureTenantForIdentity({
    email,
    identity,
    businessName: DEMO_BUSINESS_NAME,
  });

  console.log(
    `[${COMMAND}] tenant   : ${tenant.reused ? 'reusing' : 'CREATED'} ${String(tenant.businessId)} ("${tenant.businessName}")`,
  );

  // A newly created tenant is written as an ACTIVE OWNER, but it still goes through the
  // same rule. The id just created is the only one it can be compared with.
  if (production && !existing) {
    assertProductionTenantOwnership({
      email,
      tenant,
      requestedBusinessId: tenant.businessId,
      command: COMMAND,
      namingHint: '--business=<businessId>',
    });
  }

  // Naming the tenant is the third deliberate act a production reset needs. The rule lives
  // in ./seed/lib.mjs and is shared with seed:accounts, so the two cannot disagree about it.
  assertTenantNamedForReset({
    production,
    reused: tenant.reused,
    requestedBusinessId: requestedBusiness,
    businessId: tenant.businessId,
    businessName: tenant.businessName,
    command: COMMAND,
  });
  if (production) {
    console.log(
      `[${COMMAND}] scope    : replacing the DATA of business ${String(tenant.businessId)}; ` +
        'its login and business row are kept',
    );
  }

  // ---- reset this tenant's DATA (never the account rows) ----
  const cleared = await clearTenantData([tenant.businessId]);
  if (cleared.removed > 0) {
    console.log(`[${COMMAND}] reset    : removed ${cleared.removed} previous document(s) from this tenant`);
  }

  const { counts, achieved, receiptTransactions } = await seedTenant({
    businessId: tenant.businessId,
    userId: tenant.userId,
    total,
    rand: makeRandom(seed),
    includeSku,
    includeBarcode,
    label: 'DEMO',
  });

  // The write is not the claim. Count it back through the tenant's own filter, so a
  // partially-rejected insert can never be reported as a finished dataset.
  const readBack = await readTenantCounts(tenant.businessId);
  const disagreements = countDisagreements(counts, readBack);
  if (disagreements.length) {
    fail(
      `the read-back does not match what was written (${disagreements
        .map((d) => `${d.collection}: wrote ${d.wrote}, found ${d.found}`)
        .join('; ')}). The dataset is NOT trustworthy; re-run before using it.`,
    );
  }

  console.log('');
  console.log(`[${COMMAND}] OK`);
  console.log(`[${COMMAND}]   categories             ${counts.categories}`);
  console.log(`[${COMMAND}]   locations              ${counts.locations}`);
  console.log(`[${COMMAND}]   suppliers              ${counts.suppliers}`);
  console.log(`[${COMMAND}]   products               ${counts.products}`);
  console.log(`[${COMMAND}]   inventory              ${counts.inventory}`);
  console.log(`[${COMMAND}]   inventory_transactions ${counts.inventory_transactions}  (incl. ${receiptTransactions} PO receipt movement(s))`);
  console.log(`[${COMMAND}]   purchase_orders        ${counts.purchase_orders}`);
  console.log(`[${COMMAND}]   ----------------------------------------`);
  console.log(
    `[${COMMAND}]   TOTAL                  ${achieved.toLocaleString()}   ` +
      `(target ${total.toLocaleString()}; read-back equal)`,
  );
  console.log(`[${COMMAND}] businessId : ${String(tenant.businessId)}`);
  console.log(`[${COMMAND}] account    : ${email}${tenant.accountCreated ? '  (MongoDB account CREATED — sign in as usual)' : '  (existing account, unchanged)'}`);
  console.log(`[${COMMAND}] elapsed    : ${Date.now() - started} ms`);

  if (production) {
    console.log(`[${COMMAND}] next       : measure the DEPLOYED assistant — the database and the tenant are both named:`);
    console.log(
      `[${COMMAND}]   NODE_ENV=production MONGODB_DB_NAME=${env.mongodbDbName} ` +
        'PERF_TURNS_CONFIRM=perf-turns:production \\',
    );
    console.log(
      `[${COMMAND}]     npm run perf:turns -- --base=https://ai-inventory-l1mi.onrender.com ` +
        `--database=${env.mongodbDbName} --business=${String(tenant.businessId)} --login --only=1,2`,
    );
  } else {
    console.log(`[${COMMAND}] next       : npm run perf:measure -- --business=${String(tenant.businessId)}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  await mongoose.disconnect().catch(() => {});
  if (err instanceof SeedSafetyError) fail(err.message);
  fail(err && err.message ? err.message : String(err));
});
