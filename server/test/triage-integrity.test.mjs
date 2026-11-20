// The read-only attention triage must show a person WHY a row is stuck and
// WHAT evidence surrounds it, while never repairing or rewriting anything.
// These cases pin the shared report shape, its text form and the read-only
// source guard. The database queries are a thin use of the same builder.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIAGE_DEFAULT_LIMIT,
  buildAttentionReport,
  formatAttentionText,
  parseTriageArgs,
} from '../scripts/lib/triage-integrity.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = readFileSync(path.join(serverRoot, 'scripts/triage-integrity.mjs'), 'utf8');
const libSource = readFileSync(path.join(serverRoot, 'scripts/lib/triage-integrity.mjs'), 'utf8');
const readSource = readFileSync(path.join(serverRoot, 'scripts/lib/triage-read.mjs'), 'utf8');

function sample() {
  const transfer = {
    _id: 'op-1',
    businessId: 'biz-1',
    productId: 'prod-1',
    fromLocationId: 'loc-a',
    toLocationId: 'loc-b',
    quantity: 5,
    reason: 'replenish shelf',
    reference: 'TR-42',
    state: 'REQUIRES_ATTENTION',
    failure: 'destination row changed after the debit',
    createdBy: 'user-1',
    sourceRowId: 'row-a',
    sourcePreviousQuantity: 10,
    sourceNewQuantity: 5,
    destinationRowId: 'row-b',
    destinationPreviousQuantity: 3,
    destinationNewQuantity: 8,
    reconciledAt: new Date('2026-11-19T01:00:00.000Z'),
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
    updatedAt: new Date('2026-11-19T01:00:01.000Z'),
  };
  const ledgerRows = [
    {
      _id: 'ledger-a',
      transferOperationId: 'op-1',
      locationId: 'loc-a',
      type: 'TRANSFER',
      quantity: 5,
      previousQuantity: 10,
      newQuantity: 5,
      reference: 'TR-42',
      createdAt: new Date('2026-11-19T00:00:01.000Z'),
    },
  ];
  const quarantine = [
    {
      _id: 'quarantine-1',
      businessId: 'biz-1',
      transferOperationId: 'op-1',
      productId: 'prod-1',
      locationId: 'loc-b',
      type: 'TRANSFER',
      quantity: 5,
      previousQuantity: 3,
      newQuantity: 8,
      reference: 'TR-42',
      quarantineReason: 'DUPLICATE_TRANSFER_LEDGER_LEG',
      quarantinedAt: new Date('2026-11-19T02:00:00.000Z'),
      keptId: 'ledger-b',
    },
  ];
  const movement = {
    _id: 'movement-1',
    businessId: 'biz-1',
    kind: 'STOCK_IN',
    state: 'REQUIRES_ATTENTION',
    productId: 'prod-1',
    locationId: 'loc-a',
    quantity: 5,
    previousQuantity: null,
    newQuantity: null,
    requestKey: 'op-stuck-1',
    reason: 'delivery',
    reference: 'PO-9',
    failure: 'the inventory write could not be proven or safely finished',
    createdBy: 'user-1',
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
    updatedAt: new Date('2026-11-19T01:00:00.000Z'),
  };
  const names = {
    businesses: new Map([['biz-1', 'Acme']]),
    products: new Map([['prod-1', { name: 'Blue widget', sku: 'SKU-1' }]]),
    locations: new Map([
      ['loc-a', 'Warehouse'],
      ['loc-b', 'Store'],
    ]),
    users: new Map([['user-1', 'Ada']]),
  };
  return { transfer, movement, ledgerRows, quarantine, names };
}

describe('triage:integrity — report', () => {
  it('lists attention transfers with the reason, snapshots and ledger evidence', () => {
    const { transfer, movement, ledgerRows, quarantine, names } = sample();
    const report = buildAttentionReport({
      database: 'inventoryai_prod_db',
      generatedAt: '2026-11-19T03:00:00.000Z',
      transfers: [transfer],
      movements: [movement],
      ledgerRows,
      quarantine,
      names,
    });

    assert.equal(report.command, 'triage:integrity');
    assert.equal(report.readOnly, true);
    assert.deepEqual(report.counts, { transfers: 1, movements: 1, quarantine: 1 });

    const row = report.transfers[0];
    assert.equal(row.id, 'op-1');
    assert.equal(row.product.name, 'Blue widget');
    assert.equal(row.from.name, 'Warehouse');
    assert.equal(row.to.name, 'Store');
    assert.equal(row.failureReason, 'destination row changed after the debit');
    assert.equal(row.reason, 'replenish shelf');
    assert.equal(row.createdBy.name, 'Ada');
    assert.deepEqual(row.snapshots.source, {
      rowId: 'row-a',
      previousQuantity: 10,
      newQuantity: 5,
    });
    assert.equal(row.ledgerRows.length, 1);
    assert.equal(row.ledgerRows[0].location.name, 'Warehouse');
    assert.equal(row.ledgerRows[0].previousQuantity, 10);

    const stuck = report.movements[0];
    assert.equal(stuck.id, 'movement-1');
    assert.equal(stuck.kind, 'STOCK_IN');
    assert.equal(stuck.product.name, 'Blue widget');
    assert.equal(stuck.location.name, 'Warehouse');
    assert.equal(stuck.requestKey, 'op-stuck-1');
    assert.equal(stuck.failureReason, 'the inventory write could not be proven or safely finished');
    assert.equal(stuck.createdBy.name, 'Ada');

    const quarantined = report.quarantine[0];
    assert.equal(quarantined.reason, 'DUPLICATE_TRANSFER_LEDGER_LEG');
    assert.equal(quarantined.keptId, 'ledger-b');
    assert.equal(quarantined.product.sku, 'SKU-1');
    assert.equal(quarantined.location.name, 'Store');
  });

  it('prints every reason and evidence row, and states that nothing changed', () => {
    const { transfer, movement, ledgerRows, quarantine, names } = sample();
    const report = buildAttentionReport({
      database: 'inventoryai_prod_db',
      transfers: [transfer],
      movements: [movement],
      ledgerRows,
      quarantine,
      names,
    });
    const text = formatAttentionText(report);
    assert.match(text, /READ-ONLY/);
    assert.match(text, /destination row changed after the debit/);
    assert.match(text, /source snapshot: row row-a 10 → 5/);
    assert.match(text, /ledger rows \(1\)/);
    assert.match(text, /REQUIRES_ATTENTION movement receipts: 1/);
    assert.match(text, /request key: op-stuck-1 — do NOT retry under a new key/);
    assert.match(text, /could not be proven or safely finished/);
    assert.match(text, /DUPLICATE_TRANSFER_LEDGER_LEG/);
    assert.match(text, /kept: ledger-b/);
    assert.match(text, /Nothing was repaired or modified/);
  });

  it('reports an empty triage without inventing a finding', () => {
    const report = buildAttentionReport({ database: 'inventoryai_prod_db' });
    assert.deepEqual(report.counts, { transfers: 0, movements: 0, quarantine: 0 });
    assert.equal(report.transfers.length, 0);
    assert.equal(report.movements.length, 0);
    assert.equal(report.quarantine.length, 0);
    assert.match(formatAttentionText(report), /none/);
  });
});

describe('triage:integrity — arguments', () => {
  it('accepts the production, business, limit and JSON forms', () => {
    const args = parseTriageArgs([
      '--with-production',
      '--business=64f0c2a9e1b3d4f5a6b7c8d9',
      '--limit=500',
      '--format=json',
    ]);
    assert.deepEqual(args.problems, []);
    assert.equal(args.withProduction, true);
    assert.equal(args.businessId, '64f0c2a9e1b3d4f5a6b7c8d9');
    assert.equal(args.limit, 500);
    assert.equal(args.format, 'json');
    assert.equal(parseTriageArgs([]).limit, TRIAGE_DEFAULT_LIMIT);
  });

  it('refuses malformed ids, limits, formats and unknown flags', () => {
    assert.match(parseTriageArgs(['--business=nope']).problems.join(' '), /24-character/);
    assert.match(parseTriageArgs(['--limit=0']).problems.join(' '), /--limit/);
    assert.match(parseTriageArgs(['--format=yaml']).problems.join(' '), /--format/);
    assert.match(parseTriageArgs(['--repair']).problems.join(' '), /unknown argument/);
  });
});

describe('triage:integrity — read-only source guard', () => {
  it('uses reads only and never mutates, repairs or re-indexes', () => {
    assert.doesNotMatch(
      cliSource,
      /\.(updateOne|updateMany|deleteOne|deleteMany|insertOne|insertMany|replaceOne|bulkWrite|createIndex|dropIndex|findOneAndUpdate|findOneAndDelete)\b/
    );
    assert.doesNotMatch(libSource, /\b(mongoose|mongodb)\b/);
    assert.match(cliSource, /autoIndex: false/);
    assert.match(cliSource, /autoCreate: false/);
    assert.match(cliSource, /readAttentionEvidence/);
    assert.doesNotMatch(
      readSource,
      /\.(updateOne|updateMany|deleteOne|deleteMany|insertOne|insertMany|replaceOne|bulkWrite|createIndex|dropIndex|findOneAndUpdate|findOneAndDelete)\b/,
    );
    assert.match(libSource, /readOnly: true/);
  });
});
