// Hosted freshness for the inventory-integrity monitor.
//
// The endpoint is the independent signal: UptimeRobot can see a stopped laptop
// without reading the laptop's local history. These tests pin the classifier, the
// HTTP 200/503 contract, and the writer's narrow surface without touching MongoDB.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { unitSuite } from './testEnv.mjs';
import { createHealthRouter } from '../src/routes/health.routes.ts';
import {
  INTEGRITY_HEARTBEAT_MAX_AGE_MS,
  classifyIntegrityHeartbeat,
} from '../src/services/integrityHeartbeat.service.ts';
import {
  buildHeartbeat,
  parseHeartbeatArgs,
} from '../scripts/lib/integrity-heartbeat.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-15T12:00:00.000Z');

function beat(over = {}) {
  return {
    _id: 'production',
    checkedAt: new Date(NOW.getTime() - 60_000),
    status: 'UNCHANGED',
    scannedStockIns: 4896,
    orphanStockIns: 2516,
    unreceiptedPoStockIns: 0,
    newCount: 0,
    resolvedCount: 1,
    ...over,
  };
}

async function withHealthApp(readIntegrity, run) {
  const app = express();
  app.use('/api/health', createHealthRouter({ readIntegrity }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

unitSuite('integrity heartbeat — freshness classification', () => {
  it('reports a recent completed audit as fresh', () => {
    const view = classifyIntegrityHeartbeat(beat(), { now: NOW });
    assert.equal(view.state, 'fresh');
    assert.equal(view.fresh, true);
    assert.equal(view.auditStatus, 'UNCHANGED');
    assert.equal(view.resolvedCount, 1);
    assert.equal(view.ageSeconds, 60);
  });

  it('reports a missing heartbeat as missing, never fresh', () => {
    const view = classifyIntegrityHeartbeat(null, { now: NOW });
    assert.equal(view.state, 'missing');
    assert.equal(view.fresh, false);
    assert.equal(view.lastCheckedAt, null);
  });

  it('reports a heartbeat older than the threshold as stale', () => {
    const old = new Date(NOW.getTime() - INTEGRITY_HEARTBEAT_MAX_AGE_MS - 1);
    const view = classifyIntegrityHeartbeat(beat({ checkedAt: old }), { now: NOW });
    assert.equal(view.state, 'stale');
    assert.equal(view.fresh, false);
  });

  it('reports NOT CHECKED as not checked even when the timestamp is recent', () => {
    const view = classifyIntegrityHeartbeat(beat({ status: 'NOT_CHECKED' }), { now: NOW });
    assert.equal(view.state, 'not_checked');
    assert.equal(view.fresh, false);
  });

  it('rejects a future timestamp beyond tolerance and an invalid date', () => {
    const future = new Date(NOW.getTime() + 6 * 60 * 1000);
    assert.equal(classifyIntegrityHeartbeat(beat({ checkedAt: future }), { now: NOW }).state, 'invalid');
    assert.equal(classifyIntegrityHeartbeat(beat({ checkedAt: 'not-a-date' }), { now: NOW }).state, 'invalid');
  });

  it('rejects an unknown status instead of treating it as healthy', () => {
    assert.equal(
      classifyIntegrityHeartbeat(beat({ status: 'DONE' }), { now: NOW }).state,
      'invalid'
    );
  });
});

unitSuite('integrity heartbeat — endpoint contract', () => {
  it('returns 200 and no-store for a fresh heartbeat', async () => {
    const view = classifyIntegrityHeartbeat(beat(), { now: NOW });
    await withHealthApp(async () => view, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health/integrity`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.json();
      assert.equal(body.state, 'fresh');
      assert.equal(body.fresh, true);
      assert.equal(body.auditStatus, 'UNCHANGED');
    });
  });

  it('returns 503 for stale, missing and NOT CHECKED', async () => {
    const views = [
      classifyIntegrityHeartbeat(beat({ checkedAt: new Date(0) }), { now: NOW }),
      classifyIntegrityHeartbeat(null, { now: NOW }),
      classifyIntegrityHeartbeat(beat({ status: 'NOT_CHECKED' }), { now: NOW }),
    ];
    for (const view of views) {
      await withHealthApp(async () => view, async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/health/integrity`);
        assert.equal(res.status, 503, view.state);
        assert.equal((await res.json()).fresh, false);
      });
    }
  });

  it('returns 503, not a 500 or a false green, when the reader throws', async () => {
    await withHealthApp(
      async () => {
        throw new Error('database unavailable');
      },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/health/integrity`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.state, 'not_checked');
        assert.equal(body.fresh, false);
      }
    );
  });
});

unitSuite('integrity heartbeat — writer and arguments', () => {
  it('builds a document from the local result without inventing counts', () => {
    const document = buildHeartbeat(
      {
        status: 'UNCHANGED',
        checkedAt: '2026-11-15T11:11:36.859Z',
        database: 'inventoryai_prod_db',
        audit: { scannedStockIns: 4896, totals: { orphanStockIns: 2516, unreceiptedPoStockIns: 0 } },
        comparison: { newCount: 0, resolvedCount: 1 },
      },
      { now: NOW, database: 'inventoryai_prod_db' }
    );
    assert.equal(document._id, 'production');
    assert.equal(document.status, 'UNCHANGED');
    assert.equal(document.scannedStockIns, 4896);
    assert.equal(document.resolvedCount, 1);
    assert.equal(document.database, 'inventoryai_prod_db');
  });

  it('accepts NOT CHECKED so the endpoint can fail closed immediately', () => {
    const document = buildHeartbeat({ status: 'NOT_CHECKED', checkedAt: NOW.toISOString() }, {
      now: NOW,
      database: 'inventoryai_prod_db',
    });
    assert.equal(document.status, 'NOT_CHECKED');
    assert.equal(document.newCount, 0);
  });

  it('refuses an unknown status, a bad timestamp and a different database', () => {
    assert.throws(() => buildHeartbeat({ status: 'DONE', checkedAt: NOW }, { now: NOW }));
    assert.throws(() => buildHeartbeat({ status: 'UNCHANGED', checkedAt: 'nope' }, { now: NOW }));
    assert.throws(() =>
      buildHeartbeat(
        { status: 'UNCHANGED', checkedAt: NOW, database: 'inventoryai_dev_db' },
        { now: NOW, database: 'inventoryai_prod_db' }
      )
    );
  });

  it('requires --with-production and refuses a free-form database', () => {
    assert.deepEqual(parseHeartbeatArgs(['--history-dir=C:/tmp']).problems.length, 1);
    const args = parseHeartbeatArgs(['--with-production', '--database=inventoryai_dev_db']);
    assert.equal(args.withProduction, true);
    assert.ok(args.problems.some((p) => p.includes('--database is not accepted')));
  });

  it('writes only the heartbeat collection; no inventory or ledger model is imported', () => {
    const source = readFileSync(path.join(serverRoot, 'scripts', 'write-integrity-heartbeat.mjs'), 'utf8');
    assert.match(source, /INTEGRITY_HEARTBEAT_COLLECTION/);
    assert.doesNotMatch(source, /inventory\.model|inventoryTransaction\.model|purchaseOrder\.model/);
    assert.equal((source.match(/\.updateOne\(/g) || []).length, 1);
  });
});
