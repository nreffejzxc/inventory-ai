// Required-index rollout — pure control-flow coverage.
//
// The real database shape is covered by phase-index-integrity.test.mjs and the
// readiness evaluator is covered by transfer-ledger-index-readiness.test.mjs.
// These cases pin the operator write path itself: a read-only run never creates,
// an apply refuses duplicate groups before createIndex, targeted creation uses
// the exact spec, and every failure stays visible instead of being reported ready.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DUPLICATE_LIMIT,
  MAX_DUPLICATE_LIMIT,
  REQUIRED_INDEX_TARGETS,
  duplicatePreflightPipeline,
  rolloutRequiredIndexes,
} from '../src/services/requiredIndexRollout.service.ts';
import { AUDIT_DEDUPE_INDEX } from '../src/models/auditLog.model.ts';
import { AUDIT_OUTBOX_DELIVERED_TTL_INDEX } from '../src/models/auditOutbox.model.ts';
import {
  PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX,
  PURCHASE_ORDER_REQUEST_KEY_INDEX,
} from '../src/models/purchaseOrder.model.ts';
import { TRANSFER_LEDGER_INDEX } from '../src/models/inventoryTransaction.model.ts';
import { MOVEMENT_AUDIT_REPAIR_INDEX } from '../src/models/stockMovementOperation.model.ts';

function indexFromSpec(spec) {
  return {
    name: spec.name,
    key: { ...spec.key },
    ...(spec.unique === true ? { unique: true } : {}),
    ...(spec.partialFilterExpression
      ? { partialFilterExpression: spec.partialFilterExpression }
      : {}),
    ...(spec.expireAfterSeconds !== undefined
      ? { expireAfterSeconds: spec.expireAfterSeconds }
      : {}),
  };
}

function fakeTarget({
  spec = PURCHASE_ORDER_REQUEST_KEY_INDEX,
  indexes = [],
  duplicates = { total: 0, sample: [] },
  aggregateError = null,
  createError = null,
} = {}) {
  let current = indexes.map((index) => ({
    ...index,
    key: { ...index.key },
    ...(index.partialFilterExpression
      ? { partialFilterExpression: index.partialFilterExpression }
      : {}),
  }));
  const calls = { aggregates: 0, creates: 0, pipelines: [], options: [], created: [] };
  const collection = {
    indexes: async () => current,
    // Mongoose's collection.aggregate returns an Aggregate synchronously; the
    // fake must do the same so the service's `.toArray()` reaches the cursor.
    aggregate: (pipeline, options) => {
      calls.aggregates += 1;
      calls.pipelines.push(pipeline);
      calls.options.push(options);
      if (aggregateError) throw aggregateError;
      return {
        toArray: async () => [
          {
            total: [{ groups: duplicates.total }],
            sample: duplicates.sample,
          },
        ],
      };
    },
    createIndex: async (key, options) => {
      calls.creates += 1;
      calls.created.push({ key, options });
      if (createError) throw createError;
      current.push({ key: { ...key }, ...options });
      return options.name;
    },
  };
  return { target: { label: 'test_collection', spec, collection }, calls };
}

describe('required-index rollout — duplicate preflight', () => {
  it('matches the partial filter and groups by every ordered key field', () => {
    for (const spec of [
      TRANSFER_LEDGER_INDEX,
      PURCHASE_ORDER_REQUEST_KEY_INDEX,
      AUDIT_DEDUPE_INDEX,
    ]) {
      const pipeline = duplicatePreflightPipeline(spec);
      assert.deepEqual(pipeline[0], { $match: spec.partialFilterExpression });
      assert.deepEqual(pipeline[1].$group._id, {
        ...Object.fromEntries(Object.keys(spec.key).map((field) => [field, `$${field}`])),
      });
      assert.deepEqual(pipeline[2], { $match: { count: { $gt: 1 } } });
      assert.deepEqual(pipeline[3].$facet.sample, [{ $limit: DEFAULT_DUPLICATE_LIMIT }]);
    }
  });

  it('bounds the sample and rejects an unusable limit', () => {
    const pipeline = duplicatePreflightPipeline(AUDIT_DEDUPE_INDEX, 7);
    assert.deepEqual(pipeline[3].$facet.sample, [{ $limit: 7 }]);

    for (const limit of [0, -1, 1.5, MAX_DUPLICATE_LIMIT + 1, Number.NaN]) {
      assert.throws(() => duplicatePreflightPipeline(AUDIT_DEDUPE_INDEX, limit), /duplicate limit/);
    }
  });

  it('lists the six live targets in readiness order', () => {
    assert.deepEqual(
      REQUIRED_INDEX_TARGETS.map((target) => target.spec.name),
      [
        TRANSFER_LEDGER_INDEX.name,
        PURCHASE_ORDER_REQUEST_KEY_INDEX.name,
        AUDIT_DEDUPE_INDEX.name,
        AUDIT_OUTBOX_DELIVERED_TTL_INDEX.name,
        MOVEMENT_AUDIT_REPAIR_INDEX.name,
        PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX.name,
      ],
    );
  });
});

describe('required-index rollout — read-only report', () => {
  it('reports READY without a duplicate scan or a write', async () => {
    const { target, calls } = fakeTarget({
      indexes: [indexFromSpec(PURCHASE_ORDER_REQUEST_KEY_INDEX)],
    });

    const summary = await rolloutRequiredIndexes({ targets: [target] });

    assert.equal(summary.ready, true);
    assert.equal(summary.changed, 0);
    assert.equal(summary.results[0].status, 'READY');
    assert.equal(calls.aggregates, 0);
    assert.equal(calls.creates, 0);
  });

  it('reports MISSING and WRONG_SHAPE without writing', async () => {
    const missing = await rolloutRequiredIndexes({
      targets: [fakeTarget().target],
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.results[0].status, 'MISSING');
    assert.match(missing.results[0].reason, /missing/);

    const wrong = await rolloutRequiredIndexes({
      targets: [
        fakeTarget({
          indexes: [{ ...indexFromSpec(PURCHASE_ORDER_REQUEST_KEY_INDEX), unique: false }],
        }).target,
      ],
    });
    assert.equal(wrong.ready, false);
    assert.equal(wrong.results[0].status, 'WRONG_SHAPE');
    assert.match(wrong.results[0].reason, /not unique/);
  });

  it('reports an inspection failure as FAILED, not as a missing index', async () => {
    const { target } = fakeTarget();
    target.collection.indexes = async () => {
      throw new Error('connection details must not be echoed');
    };

    const summary = await rolloutRequiredIndexes({ targets: [target] });

    assert.equal(summary.results[0].status, 'FAILED');
    assert.doesNotMatch(summary.results[0].reason, /connection details/);
  });
});

describe('required-index rollout — apply', () => {
  it('creates and verifies the exact missing index', async () => {
    const spec = PURCHASE_ORDER_REQUEST_KEY_INDEX;
    const { target, calls } = fakeTarget({ spec, indexes: [{ name: '_id_', key: { _id: 1 } }] });

    const summary = await rolloutRequiredIndexes({ targets: [target], apply: true });

    assert.equal(summary.ready, true);
    assert.equal(summary.changed, 1);
    assert.equal(summary.attention, 0);
    assert.equal(summary.results[0].status, 'CREATED');
    assert.equal(calls.aggregates, 1);
    assert.equal(calls.creates, 1);
    assert.deepEqual(calls.created[0], {
      key: spec.key,
      options: {
        name: spec.name,
        unique: true,
        partialFilterExpression: spec.partialFilterExpression,
      },
    });
    assert.deepEqual(calls.options[0], { allowDiskUse: true, maxTimeMS: 60_000 });
  });

  it('creates a TTL or plain repair index without a duplicate preflight', async () => {
    const { target, calls } = fakeTarget({ spec: AUDIT_OUTBOX_DELIVERED_TTL_INDEX });

    const summary = await rolloutRequiredIndexes({ targets: [target], apply: true });

    assert.equal(summary.ready, true);
    assert.equal(summary.results[0].status, 'CREATED');
    assert.equal(calls.aggregates, 0, 'non-unique indexes have no duplicate constraint');
    assert.deepEqual(calls.created[0], {
      key: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.key,
      options: {
        name: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.name,
        expireAfterSeconds: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.expireAfterSeconds,
        partialFilterExpression:
          AUDIT_OUTBOX_DELIVERED_TTL_INDEX.partialFilterExpression,
      },
    });
  });

  it('refuses a duplicate group before creating the index', async () => {
    const { target, calls } = fakeTarget({
      duplicates: {
        total: 2,
        sample: [
          {
            _id: { businessId: 'business-1', requestKey: 'same-key' },
            count: 2,
          },
        ],
      },
    });

    const summary = await rolloutRequiredIndexes({ targets: [target], apply: true });

    assert.equal(summary.ready, false);
    assert.equal(summary.results[0].status, 'BLOCKED_DUPLICATES');
    assert.equal(summary.results[0].duplicateGroups, 2);
    assert.equal(summary.results[0].duplicateSample.length, 1);
    assert.equal(summary.results[0].truncated, true);
    assert.equal(calls.creates, 0);
  });

  it('reports a conflicting or failed create without dropping anything', async () => {
    const conflict = Object.assign(new Error('IndexOptionsConflict'), {
      codeName: 'IndexOptionsConflict',
    });
    const { target, calls } = fakeTarget({ createError: conflict });

    const summary = await rolloutRequiredIndexes({ targets: [target], apply: true });

    assert.equal(summary.results[0].status, 'FAILED');
    assert.match(summary.results[0].reason, /IndexOptionsConflict/);
    assert.match(summary.results[0].reason, /no index was dropped/);
    assert.equal(calls.creates, 1);
  });

  it('reports a failed duplicate preflight without creating the index', async () => {
    const { target, calls } = fakeTarget({ aggregateError: new Error('aggregation failed') });

    const summary = await rolloutRequiredIndexes({ targets: [target], apply: true });

    assert.equal(summary.results[0].status, 'FAILED');
    assert.match(summary.results[0].reason, /duplicate preflight failed/);
    assert.equal(calls.creates, 0);
  });

  it('continues to independent targets after a blocked one', async () => {
    const blocked = fakeTarget({
      duplicates: { total: 1, sample: [{ _id: { requestKey: 'duplicate' }, count: 2 }] },
    });
    const missingAudit = fakeTarget({ spec: AUDIT_DEDUPE_INDEX });

    const summary = await rolloutRequiredIndexes({
      targets: [blocked.target, missingAudit.target],
      apply: true,
    });

    assert.deepEqual(
      summary.results.map((result) => result.status),
      ['BLOCKED_DUPLICATES', 'CREATED'],
    );
    assert.equal(summary.changed, 1);
    assert.equal(summary.attention, 1);
    assert.equal(summary.ready, false);
  });
});
