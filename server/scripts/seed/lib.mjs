// Shared seeding core for the account seeders (`seed:demo` and `seed:accounts`).
//
// WHY THIS MODULE EXISTS. Both seeders write the same seven collections in the same
// shape, and they differ in exactly three things: WHICH accounts, HOW BIG, and
// whether products carry a generated `sku`/`barcode`. A second copy of the dataset
// shape is how two seeders drift apart — the same reason `perf/lib.mjs` keeps ONE
// `TENANT_DATA_COLLECTIONS` list. There is one implementation here and the two CLIs
// are thin shells over it, so a fix to the fixture benefits both.
//
// NOTHING HERE RUNS ON IMPORT: no `main()`, no connection, no write. A library that
// acts when you read it is how a "seed" script writes to a database by accident.
//
// SAFETY lives in the CALLERS (`assertSeedTarget` in ./guard.mjs), before a connection
// is opened. This module only ever writes rows belonging to the `businessId` it is
// handed, and it never deletes a Firebase identity.

import mongoose from 'mongoose';

import Business from '../../src/models/business.model.ts';
import Category from '../../src/models/category.model.ts';
import Inventory from '../../src/models/inventory.model.ts';
import InventoryTransaction from '../../src/models/inventoryTransaction.model.ts';
import Location from '../../src/models/location.model.ts';
import Product from '../../src/models/product.model.ts';
import PurchaseOrder from '../../src/models/purchaseOrder.model.ts';
import Supplier from '../../src/models/supplier.model.ts';
import User from '../../src/models/user.model.ts';
import { MAX_BARCODE_ATTEMPTS, internalEan13Candidates } from '../../src/utils/internalBarcode.ts';
import { SeedSafetyError } from '../perf/lib.mjs';
import { BULK_CATEGORIES, catalogProductAt } from './catalog.mjs';
import { assertSeedFirebaseProject } from './guard.mjs';

const LOCATION_NAMES = [
  'Main Warehouse', 'Shop Front', 'Overflow Store', 'Cold Room', 'Returns Bay', 'Transit Hub',
];
const CATEGORY_NAMES = [
  ...BULK_CATEGORIES.map((category) => category.name),
  'Beverages', 'Snacks', 'Household', 'Personal Care', 'Stationery', 'Hardware',
  'Electrical', 'Kitchen', 'Pet Supplies', 'Toys', 'Clothing', 'Garden',
  'Automotive', 'Baby', 'Sports', 'Office', 'Cleaning', 'Seasonal',
  'Bakery', 'Frozen', 'Dairy', 'Produce', 'Butcher', 'Deli',
];
const ADJECTIVES = [
  'Premium', 'Classic', 'Compact', 'Heavy Duty', 'Everyday', 'Deluxe', 'Eco',
  'Professional', 'Mini', 'Ultra', 'Value', 'Pro',
];
const SUPPLIER_SUFFIX = ['Supplies', 'Trading', 'Distributors', 'Wholesale', 'Industries'];
const PO_STATUSES = ['DRAFT', 'OPEN', 'RECEIVED', 'CANCELED'];
const TX_TYPES = ['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT'];

/**
 * A production run that would REPLACE an existing tenant must name it.
 *
 * Shared by `seed:demo` and `seed:accounts` so the two CLIs cannot answer "may I replace this
 * business?" differently. A brand-new tenant is allowed without an id: the run is about to create
 * it, and creating deletes nothing.
 *
 * `namingHint` is the command's own way of naming the tenant (`--business=` for one account, the
 * third field of `--accounts` for several), so the refusal tells the operator what to type rather
 * than what the other command would have accepted.
 */
export function assertTenantNamedForReset({
  production,
  reused,
  requestedBusinessId,
  businessId,
  businessName,
  command,
  namingHint = '--business=<businessId>',
}) {
  if (!production || !reused) return;

  if (!requestedBusinessId) {
    throw new SeedSafetyError(
      `${namingHint} is required in production [${command}]: this run would REPLACE the data of ` +
        `business ${String(businessId)}${businessName ? ` ("${businessName}")` : ''}. Name it to ` +
        'prove that is the tenant you mean. Nothing was replaced.',
    );
  }
  if (String(requestedBusinessId) !== String(businessId)) {
    throw new SeedSafetyError(
      `${namingHint} names business ${String(requestedBusinessId)}, but this account owns ` +
        `${String(businessId)} [${command}]. Refusing to reset a business that was not named. ` +
        'Nothing was replaced.',
    );
  }
}

/**
 * A production seed or cleanup may only act on a tenant this account OWNS.
 *
 * WHY. `--accounts="address:products"` resolves the address to the tenant its own user row
 * points at, which is the only id worth trusting. Two states would make that resolution
 * unsafe: an account with NO tenant (a production run must not create a second business
 * quietly — registration is the path that creates one) and a non-OWNER member (the run
 * replaces or empties the WHOLE tenant, not just their rows). Both are refused before a
 * connection is used for a write, and a supplied `:businessId` is still compared against
 * the resolved tenant, so naming one cannot bypass the lookup.
 *
 * Shared by `seed:accounts` and `cleanup:account` so the two CLIs cannot disagree about
 * which accounts a production run may touch.
 */
export function assertProductionTenantOwnership({
  email,
  tenant,
  requestedBusinessId,
  command,
  namingHint = 'the third field of --accounts',
}) {
  const address = normaliseEmail(email);

  if (!tenant || !tenant.businessId) {
    throw new SeedSafetyError(
      `no business exists for ${address} in this database, and a production run will not create ` +
        'one. Register the account in the app first — registration creates its business — or name ' +
        'a different address. Nothing was changed.',
    );
  }

  if (tenant.role !== 'OWNER') {
    throw new SeedSafetyError(
      `${address} is ${tenant.role || 'not an OWNER'} in business ${String(tenant.businessId)}. ` +
        'A production seed or cleanup acts on the whole tenant, so it requires the OWNER. ' +
        'Nothing was changed.',
    );
  }

  // A role is not enough. A DISABLED account cannot sign in, and a business that is not
  // ACTIVE is not a target either. Both are checked here so every production caller that
  // uses this shared rule refuses the same states, instead of each CLI deciding for itself.
  if (String(tenant.status ?? '').toUpperCase() !== 'ACTIVE') {
    throw new SeedSafetyError(
      `${address} is ${tenant.status || 'not ACTIVE'} in business ${String(tenant.businessId)}. ` +
        'A production seed or cleanup requires an ACTIVE account. Nothing was changed.',
    );
  }
  if (String(tenant.businessStatus ?? '').toUpperCase() !== 'ACTIVE') {
    throw new SeedSafetyError(
      `business ${String(tenant.businessId)} is ${tenant.businessStatus || 'not ACTIVE'}. ` +
        'A production seed or cleanup requires an ACTIVE business. Nothing was changed.',
    );
  }

  assertTenantNamedForReset({
    production: true,
    reused: true,
    // RESOLUTION IS THE NAMING ACT now. When no id was typed, the tenant's own id is the one
    // this run will use, so the shared rule below compares only a SUPPLIED id — a mismatch
    // still refuses, and an omitted one is no longer a demand for a value that was just read.
    requestedBusinessId: requestedBusinessId ?? tenant.businessId,
    businessId: tenant.businessId,
    businessName: tenant.businessName,
    command,
    namingHint,
  });

  return tenant.businessId;
}

/**
 * A supplied `:businessId` must agree with the tenant the address actually resolves to.
 *
 * WHY THIS IS NOT PRODUCTION-ONLY (found 2026-10-29). The development path read the id but never
 * compared it: `tenant = existing ?? ensureTenantForIdentity(...)` and then straight to the reset.
 * `assertTenantNamedForReset` returns early outside production, so an `--accounts` entry such as
 * `alice@x.com:1000:<bob's id>` was ACCEPTED AND IGNORED — the run replaced alice's own tenant
 * while the operator believed they had named bob's. Development data is still data, and a typo
 * should be a refusal rather than a silent substitution.
 *
 * Omission is not a claim, so it passes: the address's own tenant is the target. Pure, so the rule
 * is asserted without a database.
 */
export function assertRequestedTenantMatches({ email, requestedBusinessId, businessId, command = 'seed:accounts' }) {
  if (requestedBusinessId == null) return;
  if (String(requestedBusinessId) === String(businessId)) return;

  throw new SeedSafetyError(
    `${normaliseEmail(email)} names business ${String(requestedBusinessId)}, but this account owns ` +
      `${String(businessId)} [${command}]. Refusing to write to a tenant that was not named. ` +
      'Nothing was changed.',
  );
}

/**
 * A supplied id must name a tenant the address ALREADY owns.
 *
 * The other half of `assertRequestedTenantMatches`: that rule compares an id with a tenant that was
 * found, this one refuses the case where nothing was found. Without it a development run given an id
 * that names no tenant silently created a DIFFERENT one for the address, so the run's output named a
 * business the operator had not asked for. Nothing is replaced in that case, which is why it is a
 * refusal rather than a safety incident — but a typed id that is ignored is still a typed id that was
 * not honoured. Production refuses the same way, in `seed:demo`'s own words.
 */
export function assertRequestedTenantKnown({
  email,
  requestedBusinessId,
  command = 'seed:accounts',
  namingHint = 'the third field of --accounts',
}) {
  if (requestedBusinessId == null) return;

  throw new SeedSafetyError(
    `${namingHint} names business ${String(requestedBusinessId)}, but no tenant is linked to ` +
      `${normaliseEmail(email)} in this database [${command}]. A run creates a tenant only when no ` +
      'id is named, and it prints the id it created. Nothing was written.',
  );
}

/**
 * The first tenant two plan entries share, if any. Pure.
 *
 * A plan is a list of ACCOUNTS, but every destructive act is scoped to a TENANT. Naming two members
 * of one business (the role fixture is exactly that shape) makes a cleanup count and report the same
 * documents twice, and makes a seed's "separate datasets" premise false. The resolved ids are what
 * matter: two typed ids that differ can still resolve to one tenant, so callers pass the resolutions.
 */
export function findDuplicateTenant(entries) {
  const seen = new Map();

  for (const entry of entries ?? []) {
    const id = entry?.businessId == null ? '' : String(entry.businessId);
    if (!id) continue;
    const email = normaliseEmail(entry.email);
    if (seen.has(id)) return { businessId: id, first: seen.get(id), second: email };
    seen.set(id, email);
  }

  return null;
}

/**
 * Refuse a plan in which two accounts name one tenant.
 *
 * Shared by `seed:accounts` and `cleanup:account` so they cannot disagree about what a plan means;
 * the consequence is the command's own words (`Nothing was written.` / `Nothing was deleted.`).
 */
export function assertDistinctTenants(
  entries,
  { command = 'seed:accounts', consequence = 'Nothing was changed.' } = {},
) {
  const duplicate = findDuplicateTenant(entries);
  if (!duplicate) return;

  throw new SeedSafetyError(
    `"${duplicate.second}" and "${duplicate.first}" resolve to the same business ` +
      `${duplicate.businessId} [${command}]. Name one account per tenant: two accounts of one ` +
      'business would repeat the same work and report its documents twice. ' +
      consequence,
  );
}

/**
 * An account must resolve to exactly ONE business.
 *
 * `users.email` is unique and so is `firebaseUid`, so this should be one row — but a seed is
 * a destructive command, and "the database cannot contain that" is not the same as "this run
 * checked". Legacy rows or a repaired link can leave an address pointing at two businesses;
 * choosing one of them would be a guess, so the run stops and prints the ids instead.
 */
export function assertOneBusinessAssociation({ email, businessIds }) {
  const unique = [...new Set((businessIds ?? []).filter(Boolean).map(String))];
  if (unique.length > 1) {
    throw new SeedSafetyError(
      `${normaliseEmail(email)} is linked to ${unique.length} businesses in this database ` +
        `(${unique.join(', ')}). Refusing to choose one — a seed or cleanup needs exactly one ` +
        'tenant. Nothing was changed.',
    );
  }
  return unique[0] ?? null;
}

/** Every business an address or identity is linked to. READ-ONLY, and the input to the rule above. */
export async function readBusinessAssociations({ email, firebaseUid }) {
  const address = normaliseEmail(email);
  const filter = firebaseUid
    ? { $or: [{ email: address }, { firebaseUid: String(firebaseUid) }] }
    : { email: address };
  const rows = await User.find(filter).select('businessId').lean();
  return rows.map((row) => row.businessId).filter(Boolean);
}

/** Small deterministic PRNG (mulberry32) — same seed, same dataset, everywhere. */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const intBetween = (rand, min, max) => Math.floor(rand() * (max - min + 1)) + min;
export const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/**
 * One spelling for an address, everywhere.
 *
 * WHY THIS IS NOT COSMETIC. The `User.email` field is `lowercase: true`, and Mongoose applies
 * that on WRITE only. A query with `{ email: 'A@X.com' }` therefore does not match the stored
 * `a@x.com`, so a mixed-case argument could miss the existing row and attempt a second one —
 * dying on the unique index with an error that names nothing. Firebase treats addresses
 * case-insensitively, so the identity was found and the database lookup was not: the two halves
 * of the script disagreed about who this person is. Normalising at the boundary makes the CLI,
 * the identity lookup and the database lookup use one string.
 */
export function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * A usable address, not merely a string containing an `@`.
 *
 * The demo commands used to accept `a@`, `@b` or `@`, hand the address to Firebase or
 * MongoDB and report whatever the driver said. A malformed argument is an input problem,
 * so it is refused before a connection with a sentence that names the flag.
 * The shape matches the User model's own validator.
 */
export function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(value));
}

/**
 * One spelling for a business id, or null when it is not one.
 *
 * The regex already allowed upper-case hex, but the comparison against `ObjectId.toString()`
 * is exact and that string is lower-case: `--business=ABC…` was therefore a valid argument
 * that could never match, and a correct id was refused as the wrong tenant. Trimming also
 * makes a pasted value with a trailing space usable instead of silently different.
 */
export function normaliseBusinessId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(text) ? text : null;
}

/**
 * A strict whole number from a CLI value, or a refusal.
 *
 * `Number.parseInt` accepts `900abc` as 900 and `12.9` as 12, so a mistyped `--total` used to
 * seed a plausible-looking dataset of the wrong size. Seeding is a measurement input; a size
 * nobody intended is a measurement nobody can trust.
 *
 * Pure, so every branch is asserted without a database. `fallback` is used only when the flag
 * is absent or blank, which is what makes `--total` optional in the first place.
 */
export function parseCount(value, { name, min, max, fallback }) {
  const raw = String(value ?? '').trim();
  const text = raw === '' ? (fallback === undefined ? '' : String(fallback)) : raw;
  const range = max === undefined ? `at least ${min}` : `between ${min} and ${max}`;

  if (!/^\d+$/.test(text)) {
    const hint =
      raw === ''
        ? fallback === undefined
          ? ' (it is required)'
          : ` (default ${fallback})`
        : `, not "${raw}"`;
    throw new SeedSafetyError(`${name} must be a whole number ${range}${hint}. Nothing was written.`);
  }

  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new SeedSafetyError(
      `${name} must be a whole number ${range}, not "${text}". Nothing was written.`,
    );
  }
  return parsed;
}

/**
 * The three comparison accounts, in PRODUCTS — the unit a person actually thinks in.
 *
 * WHY ONE DEFINITION, IN THIS FILE. The seeder, the cleanup and the pre-flight check all
 * have to agree on WHICH accounts this workflow owns and how big each one is: a checker
 * that lists a different set from the seeder is worse than no checker. The list is read by
 * `seed-accounts.mjs`, `cleanup-accounts.mjs` and `check-accounts.mjs`, so all three
 * describe the same three tenants.
 *
 * Sizes are PRODUCTS. `seedTenant` takes DOCUMENTS (its `total` — the seven collections
 * together), and products land at ~22.5 % of that, so `documentsForProducts` converts and
 * the console prints both numbers for every entry.
 */
export const COMPARISON_ACCOUNTS = Object.freeze([
  { email: 'jefferndullamalinaozxc@gmail.com', products: 30000, tier: 'small' },
  { email: 'jefferndullamalinao@gmail.com', products: 50000, tier: 'medium' },
  { email: 'jeffernmalinaoqwe@gmail.com', products: 90000, tier: 'large' },
]);

/** The share of a seeded tenant that is products (the rest is stock, movements, POs, …). */
export const PRODUCTS_SHARE = 0.225;

/** Five is where `seedTenant` floors `productCount`, so it is also the smallest plan here. */
export const MIN_PRODUCTS = 5;

/**
 * The ceiling, in products, and why it is not one million.
 *
 * 112 500 products ≈ 500 000 documents, which the generator can still hold in memory and
 * write in bounded chunks. One million products would be ≈4.4 million documents — the
 * whole plan is built in memory before it is inserted, so that size is refused rather than
 * attempted: the run would either exhaust the process or, on the deployed tier, the storage
 * allowance, and neither failure would be pleasant to discover halfway through a replace.
 */
export const MAX_PRODUCTS = 112500;

/** The smallest `--total` in documents that `seedTenant` accepts as a serious dataset. */
export const MIN_DOCUMENTS = 100;

/** 112 500 products, expressed in documents. The two ceilings are the same ceiling. */
export const MAX_DOCUMENTS = 500000;

/** What a document count (`--total`, or a `d`-suffixed plan entry) yields in products. */
export function productsForDocuments(total) {
  return Math.max(5, Math.round(Number(total) * PRODUCTS_SHARE));
}

/**
 * The document budget that produces EXACTLY `products` products.
 *
 * Both sides round, so the round trip is checked rather than assumed: `seedTenant` computes
 * `max(5, round(total * 0.225))`, and a document figure that lands one product off would be
 * reported as a dataset nobody asked for. The loop moves the budget by a document or two
 * until the product count is exact, which is why every caller can print both numbers and
 * mean them.
 */
export function documentsForProducts(products) {
  const wanted = Math.max(1, Math.round(Number(products)));
  // No floor from `MIN_DOCUMENTS` here: that bound validates a DOCUMENT count, and applying
  // it to a small product count would make the request unsatisfiable (100 documents is
  // already 23 products, so "5 products" could never be met).
  let total = Math.max(1, Math.round(wanted / PRODUCTS_SHARE));

  for (let i = 0; i < 8; i += 1) {
    const achieved = Math.max(5, Math.round(total * PRODUCTS_SHARE));
    if (achieved === wanted) return total;
    total += achieved < wanted ? 1 : -1;
  }
  throw new SeedSafetyError(
    `${String(products)} products cannot be expressed as a document budget. Nothing was written.`,
  );
}

/**
 * The SKU/barcode choices an `--accounts` entry may state, per account.
 *
 * The two fields are optional on the Product schema and are written independently, so a tenant
 * can carry a SKU without a barcode (or the reverse). All four combinations are expressible
 * because each is a state the app itself can meet: `none` leaves the app's own barcode
 * generation the first code to assign, `sku` is a catalogue imported with internal references,
 * `barcode` is a label-only stock item, and `both` is the fully described product.
 */
export const CODE_MODES = Object.freeze(['both', 'none', 'sku', 'barcode']);

/**
 * The two booleans a mode stands for. `seedTenant` takes the fields separately because they are
 * separate on the schema; every caller states a MODE instead, so the translation lives once.
 */
export function codeFields(mode) {
  return {
    includeSku: mode === 'both' || mode === 'sku',
    includeBarcode: mode === 'both' || mode === 'barcode',
  };
}

/**
 * The run-wide code default from the command line: `--codes=both|none|sku|barcode`.
 *
 * `--include-sku` is GONE, and it is REFUSED rather than ignored. It used to mean `both` for every
 * entry that stated nothing, so a saved command line that still passes it would seed NEITHER field
 * while the plan printed `none` — a silent downgrade that looks exactly like a deliberate choice.
 * The refusal names the replacement, the way the removed cleanup selectors are refused.
 *
 * `--codes=` is also the only way to reach the `seed:three` preset: it has no entry list, so it
 * cannot say `codes=` per account, and before this the boolean was the only lever it had.
 *
 * `defaultMode` preserves a command's own existing default. `seed:accounts` uses `none`, while
 * `seed --plan=demo` has always written both fields and keeps `both`; the flag itself means the
 * same four choices in both commands. The value is validated here so an internal typo cannot
 * quietly select an unsupported mode.
 *
 * Pure and throwing, like the entry parser, so every refusal is assertable without a process.
 */
export function parseRunwideCodes(argv = [], { flag = '--codes', defaultMode = 'none' } = {}) {
  if (!CODE_MODES.includes(defaultMode)) {
    throw new SeedSafetyError(
      `the internal default for ${flag} is "${String(defaultMode)}", not one of ` +
        `${CODE_MODES.join(', ')}. Nothing was written.`,
    );
  }
  if (argv.includes('--include-sku')) {
    throw new SeedSafetyError(
      '--include-sku is gone. Pass --codes=both for the same thing, or --codes=sku / ' +
        '--codes=barcode for one field; an entry may still say codes=… for itself. ' +
        'Nothing was written.',
    );
  }

  const prefix = `${flag}=`;
  const hits = argv.filter((arg) => arg.startsWith(prefix));
  if (hits.length > 1) {
    throw new SeedSafetyError(`${flag} is given more than once. Nothing was written.`);
  }
  if (!hits.length) {
    if (argv.includes(flag)) {
      throw new SeedSafetyError(
        `${flag} needs a value: ${flag}=both, ${flag}=none, ${flag}=sku or ${flag}=barcode. ` +
          'Nothing was written.',
      );
    }
    return defaultMode;
  }

  const written = hits[0].slice(prefix.length).trim();
  const mode = written.toLowerCase();
  if (!CODE_MODES.includes(mode)) {
    throw new SeedSafetyError(
      `${flag}=${written} is not a choice: use ${flag}=both, ${flag}=none, ${flag}=sku or ` +
        `${flag}=barcode. Nothing was written.`,
    );
  }
  return mode;
}

/**
 * One `--accounts` entry: `address:size[:businessId][:codes=both|none|sku|barcode]`.
 *
 * `size` is PRODUCTS, or DOCUMENTS with a `d` suffix. The two optional fields are accepted in
 * EITHER order, because each is recognised by its own shape — a 24-hex id, or a `codes=`
 * prefix — so asking for codes does not force a particular position for the tenant id.
 *
 * `defaultCodes` is the run-wide default set by `--codes=` on the command line; an entry that says
 * nothing about codes takes it, and an entry that says something overrides it in either direction.
 *
 * Pure, and it THROWS instead of exiting, so every refusal is asserted without a database or a
 * connection. The CLI's own `fail()` prints the `[seed:accounts]` prefix it always did.
 */
export function parseAccountsPlanEntry(entry, { defaultCodes = 'none' } = {}) {
  const text = String(entry ?? '');
  const parts = text.split(':').map((part) => part.trim());

  if (parts.length < 2 || parts.length > 4) {
    throw new SeedSafetyError(
      `--accounts entry "${text}" must be address:products[:businessId][:codes=both|none|sku|barcode] ` +
        '(or a size in documents with a d suffix: address:400000d). Nothing was written.',
    );
  }

  const email = normaliseEmail(parts[0]);
  if (!isEmailAddress(email)) {
    throw new SeedSafetyError(
      `--accounts entry "${text}" has no usable address. Nothing was written.`,
    );
  }

  const size = parts[1];
  const inDocuments = /^\d+d$/i.test(size);
  const digits = (inDocuments ? size.slice(0, -1) : size).replace(/p$/i, '');

  let products;
  let total;
  if (inDocuments) {
    total = parseCount(digits, {
      name: `--accounts document size for ${email}`,
      min: MIN_DOCUMENTS,
      max: MAX_DOCUMENTS,
    });
    products = productsForDocuments(total);
  } else {
    // The ceiling is reported HERE, before the range parser, because the number is what
    // makes the limit understandable: "between 5 and 112500" says what, not why.
    const asked = /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : NaN;
    if (Number.isSafeInteger(asked) && asked > MAX_PRODUCTS) {
      throw new SeedSafetyError(
        `${email} asks for ${asked.toLocaleString()} products. The ceiling is ` +
          `${MAX_PRODUCTS.toLocaleString()} products (${MAX_DOCUMENTS.toLocaleString()} documents): ` +
          'one million products would be ≈4 400 000 documents, and the whole dataset is built in ' +
          'memory before it is inserted, so that run is refused rather than attempted. Nothing was written.',
      );
    }
    products = parseCount(digits, {
      name: `--accounts product size for ${email}`,
      min: MIN_PRODUCTS,
      max: MAX_PRODUCTS,
    });
    total = documentsForProducts(products);
  }

  let businessId;
  let codes;
  for (const part of parts.slice(2)) {
    const choice = /^codes=(.*)$/i.exec(part);
    if (choice) {
      if (codes !== undefined) {
        throw new SeedSafetyError(
          `--accounts entry "${text}" carries more than one codes= field. Nothing was written.`,
        );
      }
      const mode = choice[1].trim().toLowerCase();
      if (!CODE_MODES.includes(mode)) {
        throw new SeedSafetyError(
          `--accounts entry "${text}" has codes="${choice[1].trim()}", but codes must be both, ` +
            'none, sku or barcode (both writes both fields, sku or barcode writes that one, ' +
            'none omits them). Nothing was written.',
        );
      }
      codes = mode;
      continue;
    }

    const id = normaliseBusinessId(part);
    if (!id) {
      throw new SeedSafetyError(
        `--accounts entry "${text}" has the field "${part}", which is neither a 24-character ` +
          'businessId nor codes=both|none|sku|barcode. Nothing was written.',
      );
    }
    if (businessId !== undefined) {
      throw new SeedSafetyError(
        `--accounts entry "${text}" carries more than one businessId. Nothing was written.`,
      );
    }
    businessId = id;
  }

  const resolved = codes ?? defaultCodes;
  return {
    email,
    products,
    total,
    tier: 'custom',
    businessId: businessId || undefined,
    codes: resolved,
    ...codeFields(resolved),
  };
}

/**
 * Insert in bounded chunks: one 30 000-document batch would approach the 16 MB
 * command limit. Re-exported so both CLIs share the bound.
 */
export const DEFAULT_CHUNK_SIZE = 2000;

/**
 * Insert in bounded chunks.
 *
 * Returns the INSERTED DOCUMENTS, not a count — callers need the `_id` of every row
 * they just wrote to build the rows that reference it. The first draft returned a
 * number and the next collection's rows were built from `undefined._id`, which is how
 * this script failed on its very first real run: a count is only ever useful to a
 * caller that does not have to point anything at what it wrote, so callers here take
 * `.length` where they want the number.
 */
export async function insertChunked(model, docs, chunkSize = DEFAULT_CHUNK_SIZE) {
  const inserted = [];
  for (let i = 0; i < docs.length; i += chunkSize) {
    const result = await model.insertMany(docs.slice(i, i + chunkSize), { ordered: false });
    inserted.push(...result);
  }
  return inserted;
}

/**
 * Resolve the Firebase identity for an email, creating it only if it is absent — and
 * REFRESHING the password when one was supplied.
 *
 * The application joins Firebase to MongoDB on `firebaseUid` ONLY (never email), so
 * the honest way to hand an existing login a seeded tenant is to read the uid from
 * FIREBASE — the identity authority — and then create or reuse the MongoDB User that
 * carries it. Nothing in this module looks a user up by email in MongoDB.
 *
 * WHY AN EXISTING IDENTITY'S PASSWORD IS SET RATHER THAN IGNORED (found 2026-10-24). The
 * original version read the existing row and returned, so a second seeding run silently
 * kept whatever password the FIRST run chose — and since that password is supplied in the
 * environment and never written down, the next person to test a preview build had an
 * identity they could not sign in as, with no message saying why. The identity is reused
 * across test cycles precisely to avoid accumulating addresses, so refreshing its credential
 * is the behaviour that makes the documented `DEMO_ACCOUNT_PASSWORD` mean what it says.
 *
 * `refreshPassword: false` is for an EXISTING identity in production (2026-10-25). The account
 * seeders can now run against a real deployment, where the address may belong to a person: a
 * seeding run must never rewrite a living user's credential as a side effect. Creation still
 * uses the password, because a new identity has none otherwise.
 *
 * `emailVerified` is set true alongside it, for the reason the create path already gives:
 * this is a reserved demo credential (`…@example.invalid`), not a person, and the preview
 * test asserts the app's post-verification behaviour rather than re-testing Firebase.
 *
 * This never DELETES an identity. `docs/DEVELOPMENT_ROADMAP.md` §27BB records what
 * happens when the two stores are cleaned in the wrong relationship: a MongoDB user
 * whose Firebase identity was deleted can neither sign in nor register
 * (`409 EMAIL_IN_USE`), and nothing in the application can repair it.
 */
export async function resolveIdentity(email, { refreshPassword = true } = {}) {
  const { getFirebaseAdminApp } = await import('../../src/services/firebase/adminApp.ts');
  const { getAuth } = await import('firebase-admin/auth');
  const app = getFirebaseAdminApp();
  // WHICH identity authority, checked before the first read: the shell's credentials decide the
  // project, and an identity created in the wrong one could never be joined to the tenant written
  // here (the application resolves a user by `firebaseUid` only). See `assertSeedFirebaseProject`.
  assertSeedFirebaseProject(app.options?.projectId);
  const auth = getAuth(app);
  const address = normaliseEmail(email);

  const password = process.env.DEMO_ACCOUNT_PASSWORD;

  try {
    const existing = await auth.getUserByEmail(address);
    if (!password || !refreshPassword) {
      return {
        uid: existing.uid,
        created: false,
        emailVerified: existing.emailVerified,
        passwordRefreshed: false,
        // True only when a password WAS supplied and deliberately not applied. Callers use it to
        // say "unchanged" out loud rather than leaving the operator to wonder.
        passwordSkipped: Boolean(password) && !refreshPassword,
      };
    }
    await auth.updateUser(existing.uid, { password, emailVerified: true });
    return { uid: existing.uid, created: false, emailVerified: true, passwordRefreshed: true };
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
  }

  if (!password) {
    throw new SeedSafetyError(
      `no Firebase identity exists for ${address}, and DEMO_ACCOUNT_PASSWORD is not set. ` +
        'Set it in the environment to create the identity (it is never written to a file or printed).',
    );
  }
  const created = await auth.createUser({ email: address, password, emailVerified: true });
  // NOT a refresh: the identity did not exist, so creation is what set the credential.
  // Saying otherwise in the console line would report a change that did not happen.
  return { uid: created.uid, created: true, emailVerified: true, passwordRefreshed: false, passwordSkipped: false };
}

/**
 * Read-only: the Firebase identity for an address, or null. NEVER creates, NEVER updates.
 *
 * WHY IT IS SEPARATE FROM `resolveIdentity`. A preview has to answer "which tenant would this run
 * reset?" without the side effects a seed may have: `resolveIdentity` creates a login when one is
 * missing and can refresh a password. A dry run that created an identity would be the write it
 * promised not to make.
 */
export async function readIdentity(email) {
  const { getFirebaseAdminApp } = await import('../../src/services/firebase/adminApp.ts');
  const { getAuth } = await import('firebase-admin/auth');
  const app = getFirebaseAdminApp();
  assertSeedFirebaseProject(app.options?.projectId);
  const auth = getAuth(app);
  try {
    const existing = await auth.getUserByEmail(normaliseEmail(email));
    return { uid: existing.uid, emailVerified: Boolean(existing.emailVerified), created: false };
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return null;
    throw err;
  }
}

/**
 * The identity link on an existing account must be the one Firebase reports now.
 *
 * WHY THIS EXISTS (found 2026-10-26). `ensureTenantForIdentity` resolves the tenant by
 * `firebaseUid`. When an identity has been deleted and re-created under the same address,
 * Firebase reports a NEW uid while the row still carries the old one, so the lookup misses
 * and the seeder tries to create a second User for the same address — dying on
 * `users.email_1` with a raw driver error that says nothing about the cause.
 *
 * That state is §27BB's trap: the row can neither sign in (the exchange resolves by
 * `firebaseUid` only) nor register again (`409 EMAIL_IN_USE`). It is NOT this seeder's job
 * to repair it, because re-pointing `firebaseUid` is an identity linkage change and the
 * project deliberately never performs one implicitly. So the run is refused, and the
 * message names both uids and the choice (repair deliberately, or seed another address).
 *
 * Pure: both uids are passed in, so the rule is testable without Firebase or MongoDB.
 */
export function assertIdentityLinkUsable({ email, storedUid, resolvedUid }) {
  const stored = String(storedUid ?? '').trim();
  const resolved = String(resolvedUid ?? '').trim();
  const short = (uid) => (uid.length > 10 ? `${uid.slice(0, 10)}…` : uid);

  if (stored && stored === resolved) return true;

  if (!stored) {
    throw new SeedSafetyError(
      `the database account for ${email} carries NO Firebase identity, so this run cannot prove it is the ` +
        'same person. A legacy address has to be migrated deliberately; a data seeder will not attach an ' +
        'identity to it. Nothing was written.',
    );
  }

  throw new SeedSafetyError(
    `the database account for ${email} is linked to Firebase uid ${short(stored)}, but Firebase now reports ` +
      `${short(resolved)} for that address. That row can neither sign in (the exchange resolves by ` +
      'firebaseUid only) nor register again (409 EMAIL_IN_USE), and re-pointing an identity link is not ' +
      'something a data seeder does implicitly. Repair the link deliberately, or seed a different address. ' +
      'Nothing was written.',
  );
}

/**
 * The tenant this identity already owns, or null when the account has none yet. READ-ONLY.
 *
 * The lookup is shared with the production dry run, so a preview and a real run cannot disagree
 * about which tenant an account owns — the disagreement that made the preview report exit 0 for
 * an id the real run refuses (measured 2026-10-28).
 */
export async function resolveExistingTenantForIdentity({ email, identity }) {
  const address = normaliseEmail(email);
  const user = await User.findOne({ firebaseUid: identity.uid })
    .select('_id businessId email role status')
    .lean();

  // The uid lookup missed. If a row already owns this ADDRESS, the next write would hit
  // `users.email_1` — and the reason is either a stale link (the §27BB trap) or a legacy
  // account. Both are reported, neither is repaired here: see assertIdentityLinkUsable.
  if (!user) {
    const byEmail = await User.findOne({ email: address })
      .select('_id businessId email role status firebaseUid')
      .lean();
    if (!byEmail) return null;
    assertIdentityLinkUsable({
      email: address,
      storedUid: byEmail.firebaseUid,
      resolvedUid: identity.uid,
    });
    return tenantForExistingUser(byEmail);
  }

  if (!user.businessId) return null;
  return tenantForExistingUser(user);
}

/** The business a resolved user row points at, with the two states a seed refuses to repair. */
async function tenantForExistingUser(user) {
  const business = user.businessId
    ? await Business.findById(user.businessId).select('name status').lean()
    : null;
  if (!business) {
    throw new SeedSafetyError(
      `the account for ${user.email} exists but its business ${String(user.businessId)} does not. ` +
        'Refusing to guess at a repair — fix the linkage deliberately. Nothing was written.',
    );
  }
  if (business.status !== 'ACTIVE') {
    throw new SeedSafetyError(
      `the account's business status is ${business.status}. Nothing was written.`,
    );
  }
  return {
    businessId: business._id,
    businessName: business.name,
    userId: user._id,
    role: user.role,
    status: user.status,
    businessStatus: business.status,
    accountCreated: false,
    reused: true,
  };
}

/**
 * Find — or create — the tenant that belongs to an already-resolved identity.
 *
 * Reuse is the normal path: the owner registers through the app, and the seeder then
 * attaches to the tenant registration created. Creation is the fallback for an
 * identity that exists in Firebase but has no MongoDB account yet (which is exactly
 * the state the app itself calls `REGISTRATION_REQUIRED`), and it writes the same
 * shape the registration flow writes: OWNER, ACTIVE, linked by `firebaseUid` only.
 *
 * The account rows are only ever CREATED here, never deleted and never re-linked: a
 * data seeder has no business touching an account's identity linkage.
 */
export async function ensureTenantForIdentity({ email, identity, businessName }) {
  const existing = await resolveExistingTenantForIdentity({ email, identity });
  if (existing) return existing;

  const address = normaliseEmail(email);
  // `resolveExistingTenantForIdentity` returns null for a row with NO businessId, because there
  // is no tenant to return. That is not permission to create a second row: `users.email` is
  // unique, so the create below would die on the index after a business row was already made,
  // leaving an empty tenant behind. Refuse before either write and name the linkage to repair.
  const orphan = await User.findOne({
    $or: [{ email: address }, { firebaseUid: String(identity.uid) }],
  })
    .select('_id businessId')
    .lean();
  if (orphan) {
    throw new SeedSafetyError(
      `an account row for ${address} already exists but carries no businessId. Refusing to ` +
        'create a second account or an empty business for it — repair that linkage deliberately. ' +
        'Nothing was written.',
    );
  }

  const business = await Business.create({ name: businessName, status: 'ACTIVE' });
  const created = await User.create({
    businessId: business._id,
    name: 'AI Test Owner',
    email: address,
    role: 'OWNER',
    status: 'ACTIVE',
    firebaseUid: identity.uid,
    emailVerified: identity.emailVerified === true,
  });
  return {
    businessId: business._id,
    businessName,
    userId: created._id,
    role: 'OWNER',
    status: 'ACTIVE',
    businessStatus: 'ACTIVE',
    accountCreated: true,
    reused: false,
  };
}

/**
 * Allocate one valid EAN-13 barcode per product, unique within the batch.
 *
 * WHY EAN-13. A seeded barcode is only useful if the app can scan it and print it: the mobile
 * scanner decodes EAN-13 natively, the product screen renders only `isEan13` values, and the
 * lookup is an exact string match. An opaque string such as `ACCTBC0` is stored but can never
 * be scanned off a label. These are the SAME candidates `POST /api/products/:id/generate-barcode`
 * issues — deterministic from the product's ObjectId, in the GS1 "restricted distribution"
 * prefix-2 range, with a real mod-10 check digit — so a seeded code and one the app assigns
 * later are indistinguishable to a reader.
 *
 * UNIQUENESS IS PER TENANT, which is what the partial `(businessId, barcode)` unique index
 * enforces. `taken` carries codes already in the tenant (empty for every seeder, because each
 * caller clears the tenant first); within the batch the same set prevents two products from
 * sharing a code even when their candidate windows overlap. A product whose 64 consecutive
 * candidates are all taken is a refusal rather than a duplicate: the whole dataset is written
 * with `insertMany({ ordered: false })`, and a duplicate would fail the chunk after part of
 * the tenant had been written.
 *
 * Pure, so every property is asserted without a database.
 */
export function allocateEan13Barcodes(ids, { taken = [] } = {}) {
  const used = new Set(taken);
  const codes = new Map();

  for (const id of ids) {
    const hex = String(id);
    if (codes.has(hex)) {
      throw new SeedSafetyError(
        `product ${hex} appears twice in the barcode batch. Nothing was written.`,
      );
    }

    let code = null;
    for (const candidate of internalEan13Candidates(hex)) {
      if (!used.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new SeedSafetyError(
        `could not allocate a unique EAN-13 barcode for product ${hex}: ` +
          `${MAX_BARCODE_ATTEMPTS} consecutive candidates are all taken. Nothing was written.`,
      );
    }

    used.add(code);
    codes.set(hex, code);
  }

  return codes;
}

/**
 * Write a full, self-consistent dataset into ONE tenant.
 *
 * Every count scales with `total`, so the knob means what it says at any size. A
 * FIXED supplier/PO count was the first draft, and at `--total=300` the "fixed"
 * collections alone produced 666 documents for a 300-document request — a target the
 * script then reported as if it had hit it.
 *
 * `includeSku` and `includeBarcode` are independent, because the two fields are: a tenant may
 * have a SKU without a barcode, a barcode without a SKU, both, or neither. The PO line's `sku`
 * snapshot follows the product's own value (it is optional in the schema), and both fields are
 * uniquely indexed with a `partialFilterExpression`, so any number of products may omit them —
 * which is what leaves the app's own barcode generation as the thing that first assigns them
 * on a tenant that was seeded with `codes=none`. When barcodes ARE included they are real
 * EAN-13 values (`allocateEan13Barcodes`), so a seeded product can be printed and scanned.
 * The SKU stays `<label>SKU-<i>`, which is a human-readable test value rather than a code the
 * scanner is expected to decode.
 *
 * Returns per-collection counts. It does NOT reset pre-existing data first; the
 * caller does that with `clearTenantData`, because "reset then seed" is a tenant
 * lifecycle decision rather than part of writing a dataset.
 */
export async function seedTenant({
  businessId,
  userId = null,
  total,
  rand,
  includeSku = true,
  includeBarcode = true,
  label = 'DEMO',
}) {
  const business = businessId;

  const scale = (share, min, max) => Math.max(min, Math.min(max, Math.round(total * share)));
  const categoryCount = Math.min(CATEGORY_NAMES.length, scale(0.0003, 4, 24));
  const locationCount = scale(0.0001, 2, 6);
  const supplierCount = scale(0.004, 5, 300);
  const poCount = scale(0.02, 5, 1600);
  const productCount = Math.max(5, Math.round(total * 0.225));

  const categories = await Category.insertMany(
    CATEGORY_NAMES.slice(0, categoryCount).map((name) => ({ businessId: business, name, status: 'ACTIVE' })),
    { ordered: false },
  );
  const locations = await Location.insertMany(
    LOCATION_NAMES.slice(0, locationCount).map((name) => ({ businessId: business, name, status: 'ACTIVE' })),
    { ordered: false },
  );
  const suppliers = await Supplier.insertMany(
    Array.from({ length: supplierCount }, (_, i) => ({
      businessId: business,
      name: `${pick(rand, ADJECTIVES)} ${pick(rand, SUPPLIER_SUFFIX)} ${1000 + i}`,
      contactName: `Contact ${i}`,
      phone: `+63 900 ${String(1000000 + i).slice(-7)}`,
      email: `supplier${i}@example.invalid`,
      description: 'Seeded supplier for AI scale testing',
      status: 'ACTIVE',
    })),
    { ordered: false },
  );

  // ---- products, with a realistic spread of stock health ----
  // A share sits at or below its minimum so the restock path returns a full page; a
  // tenant where nothing is ever low would leave that query's cost unmeasured.
  const productDocs = [];
  for (let i = 0; i < productCount; i += 1) {
    const minimumStock = intBetween(rand, 5, 100);
    const low = rand() < 0.15;
    const available = low
      ? (rand() < 0.4 ? 0 : intBetween(rand, 1, minimumStock))
      : Math.round(minimumStock * (1.5 + rand() * 8));
    // A curated real product, not an adjective + noun + index. Large runs cycle
    // the catalogue because their purpose is scale; every row still has a real
    // brand, description and specification for the assistant to read.
    const template = catalogProductAt(i);
    const categoryIndex = CATEGORY_NAMES.indexOf(
      BULK_CATEGORIES.find((category) => category.key === template.category)?.name ?? '',
    );
    const doc = {
      // Pre-generated so the EAN-13 barcode can be derived from the product's own id, exactly
      // as `POST /api/products/:id/generate-barcode` derives it.
      _id: new mongoose.Types.ObjectId(),
      businessId: business,
      name: template.name,
      brand: template.brand,
      description: template.description,
      specifications: template.specifications,
      categoryId: categories[(categoryIndex >= 0 ? categoryIndex : i) % categories.length]._id,
      costPrice: template.costPrice,
      sellingPrice: template.sellingPrice,
      unit: template.unit,
      minimumStock,
      status: 'ACTIVE',
      _availableTotal: available,
    };
    if (includeSku) doc.sku = `${label}SKU-${i}`;
    productDocs.push(doc);
  }

  // Barcodes are allocated together, after the ids exist, so two products in this tenant can
  // never share one. `taken` is empty because every caller clears the tenant first; the
  // partial (businessId, barcode) unique index remains the final authority.
  if (includeBarcode) {
    const codes = allocateEan13Barcodes(productDocs.map((doc) => doc._id.toHexString()));
    for (const doc of productDocs) doc.barcode = codes.get(doc._id.toHexString());
  }
  const products = await insertChunked(
    Product,
    productDocs.map((doc) => {
      const clean = { ...doc };
      delete clean._availableTotal;
      return clean;
    }),
  );

  // ---- inventory: each product stocked at 1..3 locations ----
  const inventoryDocs = [];
  productDocs.forEach((doc, i) => {
    const totalQty = doc._availableTotal;
    const spread = intBetween(rand, 1, Math.min(3, locations.length));
    let remaining = totalQty;
    for (let l = 0; l < spread; l += 1) {
      const isLast = l === spread - 1;
      const qty = isLast ? remaining : Math.floor(totalQty / spread);
      remaining -= qty;
      inventoryDocs.push({
        businessId: business,
        productId: products[i]._id,
        locationId: locations[l]._id,
        quantity: Math.max(0, qty),
        reservedQuantity: 0,
      });
    }
  });
  const inventoryInserted = (await insertChunked(Inventory, inventoryDocs)).length;

  // ---- purchase orders ----
  // Status spread with receipts that are BACKED BY REAL TRANSACTIONS: a receipt line
  // requires an `inventoryTransactionId`, and pointing one at an id that was never
  // written would be a fixture that contradicts itself. The ids are pre-generated so
  // the transactions and the lines that reference them can be inserted in either
  // order. A self-contradicting ledger reads exactly like a wrong answer.
  const poDocs = [];
  const receiptTxDocs = [];
  const receivingUser = userId;

  for (let i = 0; i < poCount; i += 1) {
    const status = PO_STATUSES[i % PO_STATUSES.length];
    const itemCount = intBetween(rand, 1, 3);
    const items = [];
    for (let k = 0; k < itemCount; k += 1) {
      const productIndex = intBetween(rand, 0, products.length - 1);
      const ordered = intBetween(rand, 5, 100);
      const fullyReceived = status === 'RECEIVED';
      items.push({
        productId: products[productIndex]._id,
        productName: productDocs[productIndex].name,
        // Optional in the schema. Omitted with the product's own sku, so the PO line
        // never claims a code the product does not have.
        sku: productDocs[productIndex].sku,
        quantityOrdered: ordered,
        quantityReceived: fullyReceived ? ordered : 0,
        quantityCommitted: fullyReceived ? ordered : 0,
        unitCost: productDocs[productIndex].costPrice,
      });
    }

    const receipts = [];
    if (status === 'RECEIVED' && receivingUser) {
      const lines = items.map((item) => {
        const txId = new mongoose.Types.ObjectId();
        const previous = intBetween(rand, 0, 400);
        receiptTxDocs.push({
          _id: txId,
          businessId: business,
          productId: item.productId,
          locationId: locations[i % locations.length]._id,
          type: 'STOCK_IN',
          quantity: item.quantityReceived,
          previousQuantity: previous,
          newQuantity: previous + item.quantityReceived,
          reason: 'Purchase order receipt',
          reference: `PO-${label}-${String(i + 1).padStart(5, '0')}`,
          userId: receivingUser,
          createdAt: new Date(Date.now() - rand() * 30 * 86400000),
        });
        return {
          productId: item.productId,
          quantity: item.quantityReceived,
          inventoryTransactionId: txId,
          previousQuantity: previous,
          newQuantity: previous + item.quantityReceived,
        };
      });
      receipts.push({
        receivedAt: new Date(Date.now() - rand() * 30 * 86400000),
        userId: receivingUser,
        reference: `DR-${1000 + i}`,
        lines,
      });
    }

    poDocs.push({
      businessId: business,
      number: `PO-${label}-${String(i + 1).padStart(5, '0')}`,
      supplierId: suppliers[intBetween(rand, 0, suppliers.length - 1)]._id,
      locationId: locations[i % locations.length]._id,
      status,
      expectedAt: new Date(Date.now() - rand() * 30 * 86400000),
      notes: 'Seeded purchase order for AI scale testing',
      items,
      receipts,
      claims: [],
    });
  }
  const poInserted = (await insertChunked(PurchaseOrder, poDocs, 500)).length;

  // ---- transactions: the remainder of the budget, so the total is exact ----
  // Every row satisfies the invariant its OWN type implies — `newQuantity =
  // previousQuantity + quantity` for STOCK_IN, `- quantity` for STOCK_OUT, and
  // `quantity = |target - previousQuantity|` for an ADJUSTMENT — never merely two
  // plausible numbers. The first version of the performance seeder always ADDED, and
  // 6 615 of 6 616 STOCK_OUT rows ended up claiming stock went UP; the assistant then
  // reported that faithfully. Fixture consistency is part of answer trustworthiness.
  const historyDocs = [];
  // The PO receipt movements are ALREADY written and count toward the budget, so they
  // are subtracted here rather than added on top of it. Without that the first full run
  // reported 80 842 documents for an 80 000 target — a 1 % overshoot that the script
  // displayed as if the target had been met.
  const historyTarget = Math.max(
    productCount,
    total -
      categoryCount -
      locationCount -
      supplierCount -
      poInserted -
      productCount -
      inventoryInserted -
      receiptTxDocs.length,
  );

  for (let i = 0; i < historyTarget; i += 1) {
    const productIndex = i % productCount;
    const type = pick(rand, TX_TYPES);
    const when = new Date(Date.now() - rand() * 90 * 86400000);
    let quantity;
    let previous;
    let target;
    if (type === 'STOCK_OUT') {
      // Stock must exist for stock to leave: a stock-out from an empty shelf is
      // impossible and would write the negative `newQuantity` the model forbids.
      previous = intBetween(rand, 1, 500);
      quantity = intBetween(rand, 1, previous);
      target = previous - quantity;
    } else if (type === 'ADJUSTMENT') {
      // An adjustment records a TARGET and its `quantity` is the absolute delta,
      // which is why the other two shapes' arithmetic does not apply to it.
      previous = intBetween(rand, 0, 500);
      target = intBetween(rand, 0, 500);
      if (target === previous) target = previous + 1;
      quantity = Math.abs(target - previous);
    } else {
      previous = intBetween(rand, 0, 500);
      quantity = intBetween(rand, 1, 50);
      target = previous + quantity;
    }
    historyDocs.push({
      businessId: business,
      productId: products[productIndex]._id,
      locationId: pick(rand, locations)._id,
      type,
      quantity,
      previousQuantity: previous,
      newQuantity: target,
      reason: 'Seeded movement',
      reference: `${label}-${productIndex}-${i}`,
      userId: receivingUser,
      createdAt: when,
      updatedAt: when,
    });
  }

  const allTxDocs = [...historyDocs, ...receiptTxDocs];
  const txInserted = (await insertChunked(InventoryTransaction, allTxDocs, DEFAULT_CHUNK_SIZE)).length;

  const counts = {
    categories: categoryCount,
    locations: locationCount,
    suppliers: supplierCount,
    products: products.length,
    inventory: inventoryInserted,
    inventory_transactions: txInserted,
    purchase_orders: poInserted,
  };
  const achieved = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return { counts, achieved, receiptTransactions: receiptTxDocs.length, productDocs };
}

/**
 * Count what is ACTUALLY in one tenant, through the same `businessId` filter every screen uses.
 *
 * A seeder's own tally is evidence about the seeder. This is the read-back: if an insert was
 * partially rejected, the difference shows up here rather than in a measurement taken later.
 * The seven collections are the ones `seedTenant` writes, so the comparison is exact.
 */
export async function readTenantCounts(businessId) {
  const filter = { businessId };
  const [categories, locations, suppliers, products, inventory, inventory_transactions, purchase_orders] =
    await Promise.all([
      Category.countDocuments(filter),
      Location.countDocuments(filter),
      Supplier.countDocuments(filter),
      Product.countDocuments(filter),
      Inventory.countDocuments(filter),
      InventoryTransaction.countDocuments(filter),
      PurchaseOrder.countDocuments(filter),
    ]);

  return { categories, locations, suppliers, products, inventory, inventory_transactions, purchase_orders };
}

/**
 * The collections whose write count and read-back count disagree, named with both numbers.
 *
 * Pure, so the comparison is asserted on values rather than on a database. An empty array means
 * the dataset that was reported is the dataset that exists.
 */
export function countDisagreements(written, readBack) {
  return Object.keys(written ?? {})
    .filter((collection) => (readBack ?? {})[collection] !== written[collection])
    .map((collection) => ({
      collection,
      wrote: written[collection],
      found: (readBack ?? {})[collection],
    }));
}

/**
 * Which database a read-only check covers: exactly ONE.
 *
 * WHY ONE, AND WHY IT IS A FUNCTION (measured 2026-10-28). `check:accounts --with-production` used to
 * return `[development, production]` — development always, production appended when asked — and then
 * judged readiness across both. A shell whose development database held no user row (because the data
 * had been cleaned) therefore reported **NOT READY (exit 1)** for accounts that were READY in
 * production. The exit code described the other database, which is not the one the operator was
 * about to seed. Each environment is judged on its own, by selecting one.
 *
 * Pure, and takes the names as an argument, so the rule is asserted on values rather than inferred
 * from the script's text.
 */
export function databasesToCheck({ withProduction, databaseNames }) {
  return withProduction ? [databaseNames.production] : [databaseNames.development];
}

/**
 * Readiness over every database that was actually read — and over nothing else.
 *
 * The exit code is `notReady > 0 ? 1 : 0`, so this is where "a missing row in the other environment"
 * stops being able to fail a run: the caller only ever passes the databases `databasesToCheck` chose.
 * Pure, so the arithmetic is tested without a connection.
 */
/**
 * Refuse, in the report, a plan whose accounts resolve to ONE tenant.
 *
 * `check:accounts` is the pre-flight for `seed:accounts`, and since §27GQ the seeder refuses a plan
 * that names one tenant twice. Reporting two READY lines for that plan made the check promise a run
 * the seeder would not perform. A row that is already refused is left exactly as it was — this rule
 * says nothing about a state another rule already explained.
 *
 * Pure: returns NEW rows, so the caller's records are never mutated.
 */
export function markSharedTenants(rows) {
  const list = rows ?? [];
  const counts = new Map();
  for (const row of list) {
    if (row?.verdict !== 'READY' || !row.businessId) continue;
    const id = String(row.businessId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return list.map((row) => {
    const id = row?.businessId == null ? '' : String(row.businessId);
    if (row?.verdict !== 'READY' || (counts.get(id) ?? 0) < 2) return row;

    const others = list
      .filter((other) => other !== row && other?.businessId != null && String(other.businessId) === id)
      .map((other) => other.email);
    return {
      ...row,
      verdict: 'SHARED TENANT',
      detail:
        `business ${id} is also the tenant of ${others.join(', ')} — a seed refuses a plan that names ` +
        'one tenant twice, because its datasets would not be separate',
    };
  });
}

export function summariseReadiness(checked) {
  const pairs = checked.reduce((total, entry) => total + entry.rows.length, 0);
  const notReady = checked.reduce(
    (total, entry) => total + entry.rows.filter((row) => row.verdict !== 'READY').length,
    0,
  );
  return { pairs, notReady, ready: pairs - notReady };
}

/**
 * One account's readiness, as a value.
 *
 * READY means the account can actually be used: a Firebase identity exists and is enabled and
 * verified, the user row is linked to it, the user is ACTIVE, and the business exists and is
 * ACTIVE. A production run additionally requires the OWNER. Anything else is returned as a
 * named state so `check:accounts` can explain it instead of printing READY for a login that
 * cannot sign in or a tenant the seeder would refuse.
 *
 * Pure: the caller supplies the already-read records, so the decision is asserted without a
 * database, Firebase or a connection.
 */
export function accountReadiness({ production = false, identity, user, business } = {}) {
  if (!user) return 'MISSING';
  if (!identity?.exists) return 'NO IDENTITY';
  if (user.firebaseUid && String(user.firebaseUid) !== String(identity.uid)) return 'STALE LINK';
  if (!user.firebaseUid) return 'NOT LINKED';
  if (identity.disabled) return 'IDENTITY DISABLED';
  if (!identity.emailVerified) return 'IDENTITY UNVERIFIED';
  if (!business) return 'NO BUSINESS';
  if (user.status !== 'ACTIVE') return 'USER INACTIVE';
  if (production && user.role !== 'OWNER') return 'NOT OWNER';
  if (business.status !== 'ACTIVE') return 'BUSINESS INACTIVE';
  return 'READY';
}

export default {
  COMPARISON_ACCOUNTS,
  PRODUCTS_SHARE,
  MIN_PRODUCTS,
  MAX_PRODUCTS,
  MIN_DOCUMENTS,
  MAX_DOCUMENTS,
  productsForDocuments,
  documentsForProducts,
  makeRandom,
  intBetween,
  pick,
  insertChunked,
  normaliseEmail,
  isEmailAddress,
  normaliseBusinessId,
  parseCount,
  assertIdentityLinkUsable,
  resolveIdentity,
  readIdentity,
  resolveExistingTenantForIdentity,
  ensureTenantForIdentity,
  seedTenant,
  allocateEan13Barcodes,
  readTenantCounts,
  countDisagreements,
  databasesToCheck,
  summariseReadiness,
  accountReadiness,
};
