// A FAILED audit-outbox row is durable evidence, not cleanup. This suite pins
// the read-only triage: threshold selection, safe fields, tenant scope and a
// source guard that fails if a retry/delete path is added.

import 'dotenv/config';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import AuditOutbox from '../src/models/auditOutbox.model.ts';
import {
  AUDIT_TRIAGE_DEFAULT_LIMIT,
  AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS,
  AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS,
  readAuditOutboxTriage,
} from '../src/services/auditOutboxTriage.service.ts';
import {
  formatAuditOutboxTriageText,
  parseAuditOutboxTriageArgs,
} from '../scripts/lib/audit-outbox-triage.mjs';

const { ObjectId } = mongoose.Types;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = readFileSync(path.join(serverRoot, 'scripts/triage-audit-outbox.mjs'), 'utf8');
const libSource = readFileSync(path.join(serverRoot, 'scripts/lib/audit-outbox-triage.mjs'), 'utf8');
const serviceSource = readFileSync(
  path.join(serverRoot, 'src/services/auditOutboxTriage.service.ts'),
  'utf8',
);

const dbOk = await ensureDb();

after(async () => {
  await disconnectDb();
});

describe('triage:audit-outbox — arguments', () => {
  it('accepts the production, business, threshold, limit and JSON forms', () => {
    const args = parseAuditOutboxTriageArgs([
      '--with-production',
      '--business=64f0c2a9e1b3d4f5a6b7c8d9',
      '--min-age-minutes=30',
      '--min-attempts=5',
      '--limit=500',
      '--format=json',
    ]);
    assert.deepEqual(args.problems, []);
    assert.equal(args.withProduction, true);
    assert.equal(args.businessId, '64f0c2a9e1b3d4f5a6b7c8d9');
    assert.equal(args.minAgeMinutes, 30);
    assert.equal(args.minAttempts, 5);
    assert.equal(args.limit, 500);
    assert.equal(args.format, 'json');

    const defaults = parseAuditOutboxTriageArgs([]);
    assert.equal(defaults.minAgeMinutes, 15);
    assert.equal(defaults.minAttempts, AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS);
    assert.equal(defaults.limit, AUDIT_TRIAGE_DEFAULT_LIMIT);
  });

  it('refuses malformed ids, thresholds, limits, formats and unknown flags', () => {
    assert.match(parseAuditOutboxTriageArgs(['--business=nope']).problems.join(' '), /24-character/);
    assert.match(parseAuditOutboxTriageArgs(['--min-age-minutes=-1']).problems.join(' '), /min-age/);
    assert.match(parseAuditOutboxTriageArgs(['--min-attempts=0']).problems.join(' '), /min-attempts/);
    assert.match(parseAuditOutboxTriageArgs(['--limit=0']).problems.join(' '), /--limit/);
    assert.match(parseAuditOutboxTriageArgs(['--format=yaml']).problems.join(' '), /--format/);
    assert.match(parseAuditOutboxTriageArgs(['--repair']).problems.join(' '), /unknown argument/);
  });
});

describe('triage:audit-outbox — report shape', () => {
  it('prints every threshold-crossing row without claiming a repair', () => {
    const report = {
      database: 'inventoryai_dev_db',
      generatedAt: '2026-11-23T12:00:00.000Z',
      thresholds: { minAgeMs: AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS, minAttempts: 3 },
      scope: { businessId: null, limit: 100 },
      counts: { failed: 2, matching: 1, returned: 1 },
      rows: [
        {
          action: 'PRODUCTS_IMPORTED',
          dedupeKey: 'product-import:r1:completed',
          attempts: 4,
          ageMs: 20 * 60_000,
          lastError: 'MongoServerError',
          entityType: 'PRODUCT_IMPORT',
          entityId: 'r1',
          updatedAt: '2026-11-23T11:40:00.000Z',
          availableAt: '2026-11-23T11:45:00.000Z',
        },
      ],
      note: 'READ-ONLY: nothing was retried.',
    };
    const text = formatAuditOutboxTriageText(report);
    assert.match(text, /READ-ONLY/);
    assert.match(text, /age >= 15m OR attempts >= 3/);
    assert.match(text, /FAILED rows: 2; matching: 1 \(returned 1\)/);
    assert.match(text, /PRODUCTS_IMPORTED product-import:r1:completed/);
    assert.match(text, /attempts=4 age=20m error=MongoServerError/);
    assert.match(text, /nothing was retried/);
  });

  it('reports an empty triage without inventing a finding', () => {
    const text = formatAuditOutboxTriageText({
      database: 'inventoryai_dev_db',
      generatedAt: '2026-11-23T12:00:00.000Z',
      thresholds: { minAgeMs: AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS, minAttempts: 3 },
      scope: { businessId: null, limit: 100 },
      counts: { failed: 0, matching: 0, returned: 0 },
      rows: [],
      note: 'READ-ONLY',
    });
    assert.match(text, /matching: 0/);
    assert.match(text, / {2}none/);
  });
});

describe('triage:audit-outbox — read-only source guard', () => {
  it('uses reads only and never retries, resolves or deletes a FAILED row', () => {
    const writes =
      /\.(updateOne|updateMany|deleteOne|deleteMany|insertOne|insertMany|replaceOne|bulkWrite|createIndex|dropIndex|findOneAndUpdate|findOneAndDelete)\b/;
    assert.doesNotMatch(cliSource, writes);
    assert.doesNotMatch(serviceSource, writes);
    assert.doesNotMatch(libSource, /\b(mongoose|mongodb)\b/);
    assert.match(cliSource, /autoIndex: false/);
    assert.match(cliSource, /autoCreate: false/);
    assert.match(serviceSource, /readOnly: true/);
    assert.match(serviceSource, /countDocuments\(/);
  });
});

dbSuite('triage:audit-outbox — bounded FAILED evidence', dbOk, () => {
  it('★ selects by age OR attempts, scopes to one tenant and omits metadata/user ids', async () => {
    const businessId = new ObjectId();
    const otherBusiness = new ObjectId();
    const userId = new ObjectId();
    const now = new Date('2026-11-23T12:00:00.000Z');
    const old = new Date(now.getTime() - 20 * 60_000);
    const fresh = new Date(now.getTime() - 60_000);

    const failed = (key, extra) => ({
      businessId,
      dedupeKey: key,
      action: 'PRODUCTS_IMPORTED',
      entityType: 'PRODUCT_IMPORT',
      entityId: key,
      status: 'FAILED',
      attempts: 1,
      availableAt: fresh,
      lastError: 'MongoServerError',
      metadata: { token: 'super-secret', email: 'person@example.com' },
      userId,
      createdAt: fresh,
      updatedAt: fresh,
      ...extra,
    });

    try {
      await AuditOutbox.collection.insertMany([
        failed('old-row', { updatedAt: old, availableAt: old }),
        failed('hot-row', { attempts: 5, lastError: 'ValidationError' }),
        failed('fresh-row'),
        failed('delivered-row', {
          businessId,
          status: 'DELIVERED',
          updatedAt: old,
          deliveredAt: old,
        }),
        failed('other-tenant-row', { businessId: otherBusiness, updatedAt: old }),
      ]);

      const report = await readAuditOutboxTriage({
        now,
        businessId,
        minAgeMs: AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS,
        minAttempts: 3,
        limit: 10,
      });

      assert.equal(report.readOnly, true);
      assert.deepEqual(report.counts, { failed: 3, matching: 2, returned: 2 });
      assert.deepEqual(
        report.rows.map((row) => row.dedupeKey).sort(),
        ['hot-row', 'old-row'],
      );
      const oldRow = report.rows.find((row) => row.dedupeKey === 'old-row');
      const hotRow = report.rows.find((row) => row.dedupeKey === 'hot-row');
      assert.equal(oldRow.attempts, 1);
      assert.equal(oldRow.ageMs, 20 * 60_000);
      assert.equal(hotRow.attempts, 5);
      assert.equal(hotRow.lastError, 'ValidationError');
      assert.equal(oldRow.entityType, 'PRODUCT_IMPORT');
      assert.equal(Object.hasOwn(oldRow, 'metadata'), false);
      assert.equal(Object.hasOwn(oldRow, 'userId'), false);
      assert.equal(Object.hasOwn(oldRow, 'businessId'), false);
      assert.doesNotMatch(JSON.stringify(report), /super-secret|person@example\.com/);
      assert.equal(report.counts.failed, 3, 'another tenant is not in this read');
    } finally {
      await AuditOutbox.deleteMany({
        businessId: { $in: [businessId, otherBusiness] },
      });
    }
  });
});
