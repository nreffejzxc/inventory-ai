// Fail-closed readiness for the unique transfer-ledger guard.
//
// A reachable MongoDB is not enough for `/api/health/ready`: recovery relies on
// the exact unique partial index, so a missing or differently-shaped index must
// answer 503. These cases pin key order, uniqueness and the exact partial
// filter, then drive the HTTP route with injected readiness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  checkRequiredIndexes,
  checkTransferLedgerIndex,
  evaluateTransferLedgerIndex,
} from '../src/config/indexReadiness.ts';
import { createHealthRouter } from '../src/routes/health.routes.ts';

const EXPECTED = {
  name: 'uniq_transfer_operation_location',
  key: { businessId: 1, transferOperationId: 1, locationId: 1 },
  unique: true,
  partialFilterExpression: { transferOperationId: { $type: 'objectId' } },
};

function exact(overrides = {}) {
  return { ...EXPECTED, ...overrides };
}

describe('transfer-ledger index readiness — evaluation', () => {
  it('accepts only the exact key order, uniqueness and partial filter', () => {
    assert.deepEqual(evaluateTransferLedgerIndex([exact()]), {
      ready: true,
      name: EXPECTED.name,
      reason: null,
    });
  });

  it('rejects a missing index', () => {
    const result = evaluateTransferLedgerIndex([]);
    assert.equal(result.ready, false);
    assert.match(result.reason, /required unique partial index .* is missing/);
  });

  it('rejects the same key in a different order', () => {
    const result = evaluateTransferLedgerIndex([
      exact({ key: { locationId: 1, businessId: 1, transferOperationId: 1 } }),
    ]);
    assert.equal(result.ready, false);
    assert.match(result.reason, /wrong order/);
  });

  it('rejects a non-unique index with the right key and filter', () => {
    const result = evaluateTransferLedgerIndex([exact({ unique: false })]);
    assert.equal(result.ready, false);
    assert.match(result.reason, /is not unique/);
  });

  it('rejects a missing or different partial filter', () => {
    const missing = evaluateTransferLedgerIndex([exact({ partialFilterExpression: undefined })]);
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /different partial filter/);

    const wrong = evaluateTransferLedgerIndex([
      exact({ partialFilterExpression: { transferOperationId: { $exists: true } } }),
    ]);
    assert.equal(wrong.ready, false);
    assert.match(wrong.reason, /different partial filter/);
  });

  it('rejects a key with an extra field', () => {
    const result = evaluateTransferLedgerIndex([
      exact({ key: { ...EXPECTED.key, extra: 1 } }),
    ]);
    assert.equal(result.ready, false);
    assert.match(result.reason, /is missing|wrong order/);
  });

  it('reads the live index list and fails closed on inspection errors', async () => {
    const ready = await checkTransferLedgerIndex({
      model: { collection: { indexes: async () => [exact()] } },
    });
    assert.equal(ready.ready, true);

    const missing = await checkTransferLedgerIndex({
      model: {
        collection: {
          indexes: async () => {
            throw Object.assign(new Error('no namespace'), { codeName: 'NamespaceNotFound' });
          },
        },
      },
    });
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /missing/);

    const failed = await checkTransferLedgerIndex({
      model: {
        collection: {
          indexes: async () => {
            throw new Error('mongodb://user:secret@host/db');
          },
        },
      },
    });
    assert.equal(failed.ready, false);
    assert.doesNotMatch(failed.reason, /secret|mongodb/);
  });

  it('reports every required check as not ready if one throws', async () => {
    const result = await checkRequiredIndexes({
      checkTransferLedger: async () => {
        throw new Error('inspection crashed');
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].reason, /could not run/);
  });
});

async function withHealthApp({ isReady = true, checkIndexes, run }) {
  const app = express();
  app.use(
    '/api/health',
    createHealthRouter({
      getState: () => (isReady ? 'connected' : 'disconnected'),
      isReady: () => isReady,
      checkIndexes,
    })
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('transfer-ledger index readiness — /api/health/ready', () => {
  it('stays a minimal 200 gate when the index is ready', async () => {
    await withHealthApp({
      checkIndexes: async () => ({ ready: true, failures: [] }),
      run: async (origin) => {
        const res = await fetch(`${origin}/api/health/ready`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'ready');
        assert.deepEqual(Object.keys(body).sort(), ['db', 'status', 'timestamp']);
      },
    });
  });

  it('answers 503 with a safe reason when the index is missing or incorrect', async () => {
    await withHealthApp({
      checkIndexes: async () => ({
        ready: false,
        failures: [{ name: EXPECTED.name, reason: 'required unique partial index is missing' }],
      }),
      run: async (origin) => {
        const res = await fetch(`${origin}/api/health/ready`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'not ready');
        assert.match(body.reason, /unique partial index is missing/);
        assert.doesNotMatch(JSON.stringify(body), /mongodb:|secret/i);
      },
    });
  });

  it('answers 503 when the index check itself throws or returns a malformed result', async () => {
    await withHealthApp({
      checkIndexes: async () => {
        throw new Error('inspection failed');
      },
      run: async (origin) => {
        const res = await fetch(`${origin}/api/health/ready`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).status, 'not ready');
      },
    });

    await withHealthApp({
      checkIndexes: async () => undefined,
      run: async (origin) => {
        const res = await fetch(`${origin}/api/health/ready`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).status, 'not ready');
      },
    });
  });

  it('does not inspect indexes while the database is not ready', async () => {
    let called = 0;
    await withHealthApp({
      isReady: false,
      checkIndexes: async () => {
        called += 1;
        return { ready: true, failures: [] };
      },
      run: async (origin) => {
        const res = await fetch(`${origin}/api/health/ready`);
        assert.equal(res.status, 503);
        assert.equal(called, 0);
      },
    });
  });
});
