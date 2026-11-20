// DEMO-4 — the verifier as a COMMAND, against a real empty tenant.
//
// `DEMO3-code-coverage.test.mjs` proves the counter and classifier on their own.
// This suite proves the thing an operator actually runs: `verify:demo` opening
// the test database, resolving disposable accounts, printing the coverage and
// barcode-health lines, and exiting 1 for an empty tenant or a wrong EAN-13
// check digit.
//
// The fixture is deliberately the smallest tenant that can exist: one Business
// row and one User row, with zero categories, locations, suppliers, products,
// inventory, movements or purchase orders. No seed, no cleanup command and no
// production database is involved. The account rows are removed afterwards.

import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { dbSuite } from './testEnv.mjs';
import { disconnectDb, ensureDb } from './helpers.mjs';
import { DATABASE_NAMES } from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import User from '../src/models/user.model.ts';
import Product from '../src/models/product.model.ts';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(SERVER_ROOT, 'scripts', 'verify-demo-data.mjs');

// A unique address per process/run: the test database can retain a row from an
// interrupted run, and the unique email index would otherwise turn a retry into
// a fixture failure rather than a test of the verifier.
const RUN_ID = `${process.pid}-${Date.now()}`;
const EMAIL = `demo4-empty-${RUN_ID}@example.invalid`;
const BUSINESS_NAME = `DEMO4 empty tenant ${RUN_ID}`;
const businessId = new mongoose.Types.ObjectId();

const BAD_BARCODE_EMAIL = `demo4-barcode-${RUN_ID}@example.invalid`;
const BAD_BARCODE_BUSINESS_NAME = `DEMO4 barcode tenant ${RUN_ID}`;
const badBarcodeBusinessId = new mongoose.Types.ObjectId();
/** 2000000000015 is the valid fixture code; 2000000000001 has a wrong check digit. */
const VALID_BARCODE = '2000000000015';
const INVALID_BARCODE = '2000000000001';

const dbOk = await ensureDb();

/** Run the real script and keep stdout, stderr and the exit status separate. */
function runVerify(email = EMAIL, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, `--email=${email}`, `--database=${DATABASE_NAMES.test}`, ...extraArgs],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MONGODB_DB_NAME: DATABASE_NAMES.test,
        TEST_MODE: 'db',
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
}

dbSuite('DEMO-4 verify:demo exits 1 for an empty tenant and a wrong check digit', dbOk, () => {
  before(async () => {
    if (!dbOk) return;

    await Business.create({ _id: businessId, name: BUSINESS_NAME });
    await User.create({
      businessId,
      name: 'DEMO4 Empty Owner',
      email: EMAIL,
      role: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    });

    await Business.create({ _id: badBarcodeBusinessId, name: BAD_BARCODE_BUSINESS_NAME });
    await User.create({
      businessId: badBarcodeBusinessId,
      name: 'DEMO4 Barcode Owner',
      email: BAD_BARCODE_EMAIL,
      role: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    });
    await Product.insertMany([
      { businessId: badBarcodeBusinessId, name: 'DEMO4 valid EAN-13', barcode: VALID_BARCODE, currency: 'PHP' },
      { businessId: badBarcodeBusinessId, name: 'DEMO4 bad check digit', barcode: INVALID_BARCODE, currency: 'PHP' },
    ]);
  });

  after(async () => {
    if (dbOk) {
      await Product.deleteMany({ businessId: { $in: [businessId, badBarcodeBusinessId] } });
      await User.deleteMany({ businessId: { $in: [businessId, badBarcodeBusinessId] } });
      await Business.deleteMany({ _id: { $in: [businessId, badBarcodeBusinessId] } });
    }
    await disconnectDb();
  });

  it('reads an empty tenant, prints Codes — empty, and exits 1', async () => {
    const result = runVerify();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    assert.equal(
      result.error,
      undefined,
      `verify:demo could not be started: ${result.error?.message ?? 'unknown error'}`,
    );
    assert.equal(
      result.signal,
      null,
      `verify:demo was killed (${result.signal}); stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.equal(
      result.status,
      1,
      `an empty tenant must exit 1, not ${result.status}; stdout:\n${stdout}\nstderr:\n${stderr}`,
    );

    assert.match(stdout, new RegExp(`^Database : ${DATABASE_NAMES.test}$`, 'm'));
    assert.match(stdout, /^Accounts : 1$/m);
    assert.match(stdout, /^Products : 0$/m);
    assert.match(stdout, /^Documents: 0$/m);
    assert.match(
      stdout,
      /^Codes\s+: 0 both, 0 SKU only, 0 barcode only, 0 neither — empty$/m,
      'the empty tenant must print its coverage line before the verdict',
    );
    assert.match(
      stdout,
      /^Barcodes : 0 present — 0 valid EAN-13, 0 invalid check digits, 0 duplicate values, 0 non-EAN-13$/m,
      'the empty tenant must print its barcode-health line before the verdict',
    );
    assert.match(
      stderr,
      /^Result\s+: FAILED — the tenant is empty — it holds no seeded documents\.$/m,
      'the empty tenant must fail for the reason the operator needs to see',
    );
    assert.match(stdout, /^Result\s+: FAILED — 1 of 1 account\(s\) failed verification\.$/m);
    assert.doesNotMatch(stdout, /Result\s+: SUCCESS/);

    // The command is read-only: the fixture account and business still exist,
    // and the tenant still holds no products.
    assert.equal(await Business.countDocuments({ _id: businessId }), 1);
    assert.equal(await User.countDocuments({ businessId }), 1);
    assert.equal(await Product.countDocuments({ businessId }), 0);
  });

  it('flags a wrong EAN-13 check digit from real rows and exits 1', async () => {
    const result = runVerify(BAD_BARCODE_EMAIL, ['--expect-codes=barcode']);
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    assert.equal(
      result.status,
      1,
      `a bad check digit must exit 1, not ${result.status}; stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.match(stdout, /^Products : 2$/m);
    assert.match(
      stdout,
      /^Barcodes : 2 present — 1 valid EAN-13, 1 invalid check digit, 0 duplicate values, 0 non-EAN-13$/m,
      'the report must distinguish a valid EAN-13 from a wrong check digit',
    );
    assert.match(
      stderr,
      /^Result\s+: FAILED — 1 barcode carries an invalid EAN-13 check digit\.$/m,
    );
    assert.doesNotMatch(stdout, /^Result\s+: SUCCESS$/m);

    // Read-only: both products and the account remain.
    assert.equal(await Product.countDocuments({ businessId: badBarcodeBusinessId }), 2);
    assert.equal(await User.countDocuments({ businessId: badBarcodeBusinessId }), 1);
  });
});
