// OPS-2 — the pulse an outside watcher can read.
//
// WHY THIS EXISTS. Every defect this project found was found by a person looking, and the logs carry
// all of it while **nothing watched them**. `/api/health/ready` answers "is the process up and the
// database reachable" and cannot answer "are requests succeeding" — so on 2026-10-18, while the
// cluster was refusing writes and five assistant tools answered TOOL_ERROR, the readiness probe
// reported `ready` throughout. This suite pins the signal that closes that gap: the payload's shape
// (little, and deliberately so), the counting RULES (5xx is the class worth waking someone for), the
// snapshot's safety (a caller serializing it cannot reach into the process's state), the bounded
// growth, and — through the real app over real HTTP — that the middleware is actually wired.
//
// The last case proves it end to end the only way that is honest without manufacturing a fake
// failure: the database connection is dropped and `/api/health/ready`'s genuine 503 is counted. That
// is the exact sequence that was invisible before this increment.
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { startServer, makeApi, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import {
  operationalCounters,
  recordResponse,
  resetOperationalCounters,
  serverErrorsByStatus,
  statusClass,
} from '../src/config/operationalCounters.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.resolve(here, '../src/app.ts'), 'utf8');

unitSuite('OPS-2 — counter rules and their own controls', () => {
  it('classifies statuses the way the payload reports them, and refuses to guess', () => {
    for (const [status, expected] of [
      [200, '2xx'],
      [201, '2xx'],
      [204, '2xx'],
      [301, '3xx'],
      [304, '3xx'],
      [400, '4xx'],
      [404, '4xx'],
      [429, '4xx'],
      [500, '5xx'],
      [502, '5xx'],
      [503, '5xx'],
      [504, '5xx'],
    ]) {
      assert.equal(statusClass(status), expected, `${status} is ${expected}`);
    }
    // Not a status at all: counted as `other` rather than folded into a class, because a
    // value this module cannot interpret must be visible rather than plausible.
    for (const notAStatus of [99, 600, 0, -1, 1.5, Number.NaN, undefined, null, '200']) {
      assert.equal(statusClass(notAStatus), 'other', `${String(notAStatus)} is not a status`);
    }
  });

  it('starts at zero, and reading the counters is not traffic', () => {
    resetOperationalCounters();
    const before = operationalCounters();
    assert.equal(before.responses, 0);
    assert.equal(before.serverErrors, 0);
    assert.equal(before.lastServerErrorAt, null);

    operationalCounters();
    operationalCounters();
    assert.equal(operationalCounters().responses, 0, 'a read must never count as a response');
  });

  it('accumulates per class, and a 4xx never touches the 5xx fields', () => {
    resetOperationalCounters();

    for (const status of [200, 201, 304, 400, 404, 429]) recordResponse(status);
    const afterOk = operationalCounters();
    assert.equal(afterOk.responses, 6);
    assert.deepEqual(afterOk.byStatusClass, { '2xx': 2, '3xx': 1, '4xx': 3, '5xx': 0, other: 0 });
    assert.equal(afterOk.serverErrors, 0, 'a rejected request is the API working, not failing');
    assert.equal(afterOk.lastServerErrorAt, null);

    recordResponse(503);
    const afterError = operationalCounters();
    assert.equal(afterError.serverErrors, 1);
    assert.match(afterError.lastServerErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(serverErrorsByStatus(), { 503: 1 });

    recordResponse(404);
    assert.equal(operationalCounters().serverErrors, 1, 'a later 4xx does not inflate the error count');
  });

  it('does not call a monitoring-only 503 a server error', () => {
    resetOperationalCounters();

    // The integrity endpoint's 503 is a state signal for an uptime monitor, not
    // a failed request. It is still a response, and still a literal 5xx.
    recordResponse(503, '/api/health/integrity');
    const monitoring = operationalCounters();
    assert.equal(monitoring.responses, 1);
    assert.equal(monitoring.byStatusClass['5xx'], 1);
    assert.equal(monitoring.serverErrors, 0);
    assert.equal(monitoring.lastServerErrorAt, null);

    // Readiness is a real availability failure and must keep counting.
    recordResponse(503, '/api/health/ready');
    assert.equal(operationalCounters().serverErrors, 1);

    // A genuine 500 on the same monitoring route is still a server failure.
    recordResponse(500, '/api/health/integrity');
    assert.equal(operationalCounters().serverErrors, 2);
    assert.deepEqual(serverErrorsByStatus(), { 503: 1, 500: 1 });
  });

  it('hands out a copy — a caller cannot mutate the process to make itself look healthy', () => {
    resetOperationalCounters();
    recordResponse(500);

    const first = operationalCounters();
    const second = operationalCounters();
    assert.notStrictEqual(first, second, 'each read is its own object');
    assert.notStrictEqual(first.byStatusClass, second.byStatusClass, 'and its own nested object');

    first.responses = 0;
    first.serverErrors = 0;
    first.byStatusClass['5xx'] = 0;
    const third = operationalCounters();
    assert.equal(third.responses, 1, 'the live state ignored the mutation');
    assert.equal(third.serverErrors, 1);
    assert.equal(third.byStatusClass['5xx'], 1);
  });

  it('publishes a fixed surface, and nothing in it names a request', () => {
    resetOperationalCounters();
    recordResponse(200);
    recordResponse(504);

    const snapshot = operationalCounters();
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'byStatusClass',
      'lastServerErrorAt',
      'responses',
      'serverErrors',
      'uptimeSeconds',
    ]);
    assert.deepEqual(Object.keys(snapshot.byStatusClass).sort(), ['2xx', '3xx', '4xx', '5xx', 'other']);

    // The payload is numbers, one timestamp and null. No path, no id, no message, no duration.
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === 'lastServerErrorAt') {
        assert.ok(value === null || typeof value === 'string');
        continue;
      }
      if (key === 'byStatusClass') {
        for (const count of Object.values(value)) assert.equal(typeof count, 'number', `${key} holds counts`);
        continue;
      }
      assert.equal(typeof value, 'number', `${key} is a count or a duration`);
    }
  });

  it('cannot be grown by traffic: the per-status map is bounded', () => {
    resetOperationalCounters();
    for (let status = 500; status <= 599; status++) recordResponse(status);

    const detail = serverErrorsByStatus();
    const keys = Object.keys(detail);
    assert.ok(keys.length <= 9, `at most 8 statuses plus an aggregate, got ${keys.length}`);
    assert.ok('other' in detail, 'the overflow lands in a named bucket rather than being dropped');
    assert.equal(
      Object.values(detail).reduce((sum, count) => sum + count, 0),
      100,
      'every one of the 100 errors was counted somewhere'
    );
    assert.equal(operationalCounters().serverErrors, 100);
  });

  it('resets to boot state so a suite cannot inherit another suite’s traffic', () => {
    recordResponse(500);
    resetOperationalCounters();
    const state = operationalCounters();
    assert.equal(state.responses, 0);
    assert.equal(state.serverErrors, 0);
    assert.equal(state.lastServerErrorAt, null);
    assert.deepEqual(state.byStatusClass, { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 });
  });

  it('is registered in the app BEFORE the routes, so there is no path around it', () => {
    const counterAt = APP_SOURCE.indexOf(
      "recordResponse(res.statusCode, req.originalUrl.split('?')[0])",
    );
    const firstRoute = APP_SOURCE.indexOf("app.use('/api/health'");
    assert.ok(counterAt > -1, 'app.ts wires the response counter');
    assert.ok(firstRoute > -1, 'app.ts still mounts the health router');
    assert.ok(
      counterAt < firstRoute,
      'the counter is installed before the first route — a route registered ahead of it would go uncounted'
    );
  });
});

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('OPS-2 — the counters over the real app', dbOk, () => {
  it('counts real traffic, and publishes it on the legacy health payload only', async () => {
    const first = await api('GET', '/api/health');
    assert.equal(first.status, 200);
    assert.ok(first.json.counters, 'the legacy endpoint carries the counters');
    const baseline = first.json.counters.responses;

    const second = await api('GET', '/api/health');
    assert.ok(
      second.json.counters.responses >= baseline + 1,
      `a finished request is counted (${baseline} → ${second.json.counters.responses})`
    );
    assert.ok(second.json.counters.byStatusClass['2xx'] >= 1);
    assert.equal(typeof second.json.counters.uptimeSeconds, 'number');
    assert.ok(second.json.counters.uptimeSeconds >= 0);

    // The two probes stay exactly what they were: a gate and a dependency-free check. A watcher
    // is told to poll `/ready`; the counters live where the commit id already lives.
    const live = await api('GET', '/api/health/live');
    const ready = await api('GET', '/api/health/ready');
    assert.equal(live.json.counters, undefined, '/live stays dependency-free and unchanged');
    assert.equal(ready.json.counters, undefined, '/ready stays a gate that reports readiness');
    assert.deepEqual(Object.keys(live.json).sort(), ['status', 'timestamp']);
  });

  it('counts a 404 as a 4xx and leaves the error count alone', async () => {
    const before = (await api('GET', '/api/health')).json.counters;
    const missing = await api('GET', '/api/ops2-does-not-exist');
    assert.equal(missing.status, 404);

    const after = (await api('GET', '/api/health')).json.counters;
    assert.equal(after.byStatusClass['4xx'], before.byStatusClass['4xx'] + 1, 'the 404 landed in 4xx');
    assert.equal(after.serverErrors, before.serverErrors, 'a 404 is not a server error');
  });

  it('counts a stale integrity 503 as a response, not as a server error', async () => {
    const heartbeat = mongoose.connection.db.collection('integrity_monitor_heartbeats');
    const before = (await api('GET', '/api/health')).json.counters;
    try {
      await heartbeat.updateOne(
        { _id: 'production' },
        {
          $set: {
            checkedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            status: 'UNCHANGED',
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );

      const stale = await api('GET', '/api/health/integrity');
      assert.equal(stale.status, 503, 'a stale heartbeat is still a 503 for the uptime monitor');

      const after = (await api('GET', '/api/health')).json.counters;
      assert.equal(after.serverErrors, before.serverErrors, 'the monitoring state is not a failure');
      assert.equal(after.lastServerErrorAt, before.lastServerErrorAt);
      assert.equal(
        after.byStatusClass['5xx'],
        before.byStatusClass['5xx'] + 1,
        'the response census still counts the literal 5xx',
      );
    } finally {
      await heartbeat.deleteOne({ _id: 'production' });
    }
  });

  it('counts a REAL 503 — the sequence that was invisible before this increment', async () => {
    await mongoose.disconnect();

    const ready = await api('GET', '/api/health/ready');
    assert.equal(ready.status, 503, 'the readiness gate reports the database is gone');

    // `/api/health` still answers (it is a liveness endpoint), and by now it must carry the
    // failure: this is the reading a watcher alerts on.
    const health = await api('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.ok(health.json.counters.serverErrors >= 1, 'the 503 was counted as a server error');
    assert.ok(health.json.counters.byStatusClass['5xx'] >= 1);
    assert.match(String(health.json.counters.lastServerErrorAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(
      health.json.counters.responses > 0,
      'earlier requests are still counted while the database is down'
    );
  });
});
