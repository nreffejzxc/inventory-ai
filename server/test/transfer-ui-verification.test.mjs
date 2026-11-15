// The installed-app transfer verifier's own checks.
//
// The device journey can see a confirmation dialog; it cannot see the ledger. This
// module's decision is what turns six recorded rows into "the transfer is accounted
// for" — so every expected/refused shape is asserted here, with controls that must
// fail. No phone and no database are needed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSFER_UI_PREFIX,
  parseVerifyArgs,
  transferRefs,
  verifyTransferRows,
} from '../scripts/lib/transfer-ui-verification.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierSource = readFileSync(path.join(serverRoot, 'scripts', 'verify-transfer-ui.mjs'), 'utf8');
const libSource = readFileSync(
  path.join(serverRoot, 'scripts', 'lib', 'transfer-ui-verification.mjs'),
  'utf8'
);

const refs = transferRefs('2026-11-15T02-45-00-000Z');
const source = 's'.repeat(24);
const destination = 'd'.repeat(24);

const row = (over = {}) => ({
  _id: over._id ?? String(Math.random()),
  reference: refs.in,
  type: 'STOCK_IN',
  locationId: source,
  quantity: 1,
  previousQuantity: 9,
  newQuantity: 10,
  createdAt: new Date('2026-11-15T02:45:00.000Z'),
  ...over,
});

/** The six rows a successful run writes. */
function successfulRows() {
  return [
    row({ _id: '1', reference: refs.in, previousQuantity: 9, newQuantity: 10 }),
    row({
      _id: '2',
      reference: refs.forward,
      type: 'TRANSFER',
      previousQuantity: 10,
      newQuantity: 9,
      createdAt: new Date('2026-11-15T02:45:01.000Z'),
    }),
    row({
      _id: '3',
      reference: refs.forward,
      type: 'TRANSFER',
      locationId: destination,
      previousQuantity: 3,
      newQuantity: 4,
      createdAt: new Date('2026-11-15T02:45:01.100Z'),
    }),
    row({
      _id: '4',
      reference: refs.reverse,
      type: 'TRANSFER',
      previousQuantity: 9,
      newQuantity: 10,
      createdAt: new Date('2026-11-15T02:45:02.000Z'),
    }),
    row({
      _id: '5',
      reference: refs.reverse,
      type: 'TRANSFER',
      locationId: destination,
      previousQuantity: 4,
      newQuantity: 3,
      createdAt: new Date('2026-11-15T02:45:02.100Z'),
    }),
    row({
      _id: '6',
      reference: refs.out,
      type: 'STOCK_OUT',
      previousQuantity: 10,
      newQuantity: 9,
      createdAt: new Date('2026-11-15T02:45:03.000Z'),
    }),
  ];
}

function verify(over = {}) {
  return verifyTransferRows({
    rows: successfulRows(),
    sourceId: source,
    destinationId: destination,
    currentSource: 9,
    currentDestination: 3,
    refs,
    ...over,
  });
}

describe('verify:transfer-ui — arguments and references', () => {
  it('derives the four expected and two refused references from one run id', () => {
    assert.equal(refs.in, `${TRANSFER_UI_PREFIX}2026-11-15T02-45-00-000Z-IN`);
    assert.equal(refs.out.endsWith('-OUT'), true);
    assert.equal(refs.forward.endsWith('-F'), true);
    assert.equal(refs.reverse.endsWith('-R'), true);
    assert.equal(refs.same.endsWith('-SAME'), true);
    assert.equal(refs.over.endsWith('-OVER'), true);
  });

  it('accepts the complete required set', () => {
    const args = parseVerifyArgs([
      '--run-id=2026-11-15T02-45-00-000Z',
      '--sku=PHONE-SMOKE-20261115',
      '--source=Phone Smoke Location',
      '--destination=Phone Smoke Location 2',
      '--business=64F0C2A9E1B3D4F5A6B7C8D9',
      '--with-production',
      '--format=json',
    ]);
    assert.deepEqual(args.problems, []);
    assert.equal(args.withProduction, true);
    assert.equal(args.businessId, '64f0c2a9e1b3d4f5a6b7c8d9');
    assert.equal(args.format, 'json');
  });

  it('refuses a missing flag, a bad id, and a free-form database', () => {
    assert.match(parseVerifyArgs([]).problems.join(' '), /--run-id is required/);
    assert.match(parseVerifyArgs(['--run-id=x']).problems.join(' '), /--sku is required/);
    assert.match(
      parseVerifyArgs([
        '--run-id=x',
        '--sku=S',
        '--source=A',
        '--destination=B',
        '--business=not-an-id',
      ]).problems.join(' '),
      /24-character hexadecimal/
    );
    assert.match(
      parseVerifyArgs([
        '--run-id=x',
        '--sku=S',
        '--source=A',
        '--destination=B',
        '--database=inventoryai_prod_db',
      ]).problems.join(' '),
      /--database is not accepted/
    );
  });

  it('refuses unknown flags and malformed run ids', () => {
    assert.match(
      parseVerifyArgs(['--run-id=x', '--sku=S', '--source=A', '--destination=B', '--fix']).problems.join(' '),
      /Unknown argument/
    );
    assert.match(
      parseVerifyArgs(['--run-id=bad/id', '--sku=S', '--source=A', '--destination=B']).problems.join(' '),
      /letters, numbers or hyphens/
    );
  });
});

describe('verify:transfer-ui — the six-row shape', () => {
  it('passes a complete net-zero run whose final quantities match the last legs', () => {
    const result = verify();
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.checkedRows, 6);
    assert.deepEqual(result.net, { [source]: 0, [destination]: 0 });
  });

  it('reports a missing leg, the wrong type, the wrong quantity and the wrong sign', () => {
    assert.match(verify({ rows: successfulRows().slice(0, 5) }).errors.join(' '), /OUT: expected 1 row/);

    const wrongType = successfulRows();
    wrongType[0].type = 'ADJUSTMENT';
    assert.match(verify({ rows: wrongType }).errors.join(' '), /type is ADJUSTMENT/);

    const wrongQuantity = successfulRows();
    wrongQuantity[0].quantity = 2;
    assert.match(verify({ rows: wrongQuantity }).errors.join(' '), /quantity is 2/);

    const wrongSign = successfulRows();
    wrongSign[1].previousQuantity = 9;
    wrongSign[1].newQuantity = 10;
    assert.match(verify({ rows: wrongSign }).errors.join(' '), /is 1, expected -1/);
  });

  it('reports a movement that does not net to zero', () => {
    const rows = successfulRows().filter((r) => r.reference !== refs.out);
    const result = verify({ rows });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /source net movement is 1/);
  });

  it('reports final stock that no longer agrees with the last run movement', () => {
    const result = verify({ currentSource: 11 });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /source final stock is 11/);
  });

  it('reports a missing inventory row rather than treating it as zero', () => {
    const result = verify({ currentDestination: null });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /destination inventory row is missing/);
  });

  it('reports a refused submission that wrote a row, and an unexpected run reference', () => {
    const same = successfulRows();
    same.push(
      row({ _id: '7', reference: refs.same, previousQuantity: 9, newQuantity: 8, createdAt: new Date('2026-11-15T02:45:04.000Z') })
    );
    const over = successfulRows();
    over.push(
      row({ _id: '8', reference: refs.over, previousQuantity: 9, newQuantity: 8, createdAt: new Date('2026-11-15T02:45:05.000Z') })
    );
    assert.match(verify({ rows: same }).errors.join(' '), /refused submission wrote a ledger row/);
    assert.match(verify({ rows: over }).errors.join(' '), /refused submission wrote a ledger row/);

    const extra = successfulRows();
    extra.push(
      row({ _id: '9', reference: `${TRANSFER_UI_PREFIX}someone-else-IN`, createdAt: new Date('2026-11-15T02:45:06.000Z') })
    );
    assert.match(verify({ rows: extra }).errors.join(' '), /unexpected run reference/);
  });
});

describe('verify:transfer-ui — read-only claim', () => {
  const WRITE =
    /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|create|save|drop|rename|syncIndexes|createIndex|createIndexes|dropIndex|dropIndexes)\s*\(/;

  it('contains no write call in either file', () => {
    for (const [name, sourceText] of [
      ['verify-transfer-ui.mjs', verifierSource],
      ['lib/transfer-ui-verification.mjs', libSource],
    ]) {
      assert.equal(WRITE.test(sourceText), false, `${name} contains a write-shaped call`);
    }
  });

  it('still finds a write when one is planted — the scan can fail', () => {
    assert.equal(WRITE.test('await Inventory.deleteMany({ businessId });'), true);
    assert.equal(WRITE.test('await Model.syncIndexes();'), true);
  });

  it('uses the fixed database rule and never mutates the rows it reads', () => {
    assert.match(verifierSource, /databasesToCheck\(\{ withProduction: args\.withProduction/);
    assert.match(verifierSource, /DATABASE_NAMES\.test/);
    assert.match(verifierSource, /mongoose\.disconnect\(\)/);
    assert.equal(/\.(save|update|delete|insert)\s*\(/.test(verifierSource), false);
  });

  it('turns off Mongoose autoIndex/autoCreate, which would write at connect time', () => {
    assert.match(verifierSource, /autoIndex: false/);
    assert.match(verifierSource, /autoCreate: false/);
  });
});
