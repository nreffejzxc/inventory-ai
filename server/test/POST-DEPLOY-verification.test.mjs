// POST-DEPLOY — the read-only verification surface.
//
// These tests exercise the SHIPPED app (`createApp`) rather than a hand-built
// router: `/health` and `/ready` must expose the canonical health payloads, and
// no `/health/live` or `/health/ready` aliases may be added. The same test records
// the startup/DB-down signature — `/api/health/ready` is a real 503 (and therefore
// a server error), while `/api/health` and `/live` remain 200 — which makes one
// readiness 5xx after a deploy distinguishable from a process failing every request.
// The verifier tests separately pin SHA matching, readiness/liveness and exit reasons.
// No database is required: a fresh app has no Mongo connection, so readiness is 503.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.ts';
import { operationalCounters, resetOperationalCounters } from '../src/config/operationalCounters.ts';
import { verifyProductionDeploy } from '../../scripts/verify-production-deploy.mjs';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

async function startApp(app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function get(origin, path) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // The assertions below only need JSON for these routes.
  }
  return { status: response.status, json };
}

test('POST-DEPLOY: the shipped app exposes bare aliases, and a readiness 503 is the startup signature', async () => {
  resetOperationalCounters();
  const app = createApp({ requestLogging: false });
  const local = await startApp(app);
  try {
    const canonicalHealth = await get(local.origin, '/api/health');
    const aliasHealth = await get(local.origin, '/health');
    assert.equal(canonicalHealth.status, 200);
    assert.equal(aliasHealth.status, 200);
    // `counters` and `uptimeSeconds` move between requests; every stable field
    // must still match because both paths are the same health implementation.
    for (const key of ['status', 'db', 'environment', 'commit', 'exchangeRates']) {
      assert.deepEqual(aliasHealth.json[key], canonicalHealth.json[key], `health alias ${key} matches`);
    }

    // `/health/live` and `/health/ready` are deliberately NOT added as aliases:
    // the backward-compatible surface is exactly the two historical paths.
    assert.equal((await get(local.origin, '/health/live')).status, 404);
    assert.equal((await get(local.origin, '/health/ready')).status, 404);

    // The process is live and `/api/health` is 200 while readiness is 503 — the
    // shape of a startup/database readiness probe, not a process-wide 5xx.
    const notReady = await get(local.origin, '/ready');
    const canonicalNotReady = await get(local.origin, '/api/health/ready');
    const live = await get(local.origin, '/api/health/live');
    assert.equal(notReady.status, 503);
    assert.equal(canonicalNotReady.status, 503);
    assert.equal(live.status, 200);
    assert.equal(notReady.json.status, 'not ready');
    assert.equal(canonicalNotReady.json.status, 'not ready');
    assert.equal(live.json.status, 'live');

    const pulse = operationalCounters();
    assert.equal(pulse.serverErrors, 2, 'both readiness 503s are real availability failures');
    assert.ok(pulse.byStatusClass['5xx'] >= 2);
    assert.match(String(pulse.lastServerErrorAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await get(local.origin, '/health')).status, 200, 'the process view stays healthy');
  } finally {
    await local.close();
  }
});

test('POST-DEPLOY: the verifier waits for the SHA, then requires ready, live and database connectivity', async () => {
  const requests = [];
  let healthCalls = 0;
  let readyCalls = 0;
  let liveCalls = 0;
  let deployed = OLD_SHA;
  let ready = false;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/api/health') {
      healthCalls += 1;
      // The first poll sees the old process; the next poll sees the merge.
      if (healthCalls >= 2) deployed = SHA;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', db: 'connected', commit: deployed }));
      return;
    }
    if (req.url === '/api/health/ready') {
      readyCalls += 1;
      // Readiness is still warming on the first matching-SHA attempt.
      if (readyCalls >= 2) ready = true;
      res.statusCode = ready ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: ready ? 'ready' : 'not ready',
        db: 'connected',
        ...(ready ? {} : { reason: 'required unique partial index is missing' }),
      }));
      return;
    }
    if (req.url === '/api/health/live') {
      liveCalls += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'live' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await verifyProductionDeploy({
      sha: SHA,
      baseUrl: origin,
      timeoutMs: 2_000,
      intervalMs: 10,
      requestTimeoutMs: 1000,
    });
    assert.equal(result.verified, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.health.commit, SHA);
    assert.equal(result.readiness.statusCode, 200);
    assert.equal(result.readiness.db, 'connected');
    assert.equal(result.liveness.statusCode, 200);
    assert.equal(healthCalls, 3);
    assert.equal(readyCalls, 2);
    assert.equal(liveCalls, 2);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.method === 'GET'), 'verification is read-only');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST-DEPLOY: a different commit fails as a SHA mismatch, not as a generic timeout', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      db: 'connected',
      commit: OLD_SHA,
      ...(req.url === '/api/health/ready' ? { status: 'ready' } : {}),
      ...(req.url === '/api/health/live' ? { status: 'live' } : {}),
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await verifyProductionDeploy({
      sha: SHA,
      baseUrl: origin,
      timeoutMs: 1_000,
      intervalMs: 20,
      requestTimeoutMs: 1000,
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'sha_mismatch');
    assert.equal(result.lastSeenCommit, OLD_SHA);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST-DEPLOY: the expected SHA with a failing readiness gate fails as a health check', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', db: 'connected', commit: SHA }));
      return;
    }
    if (req.url === '/api/health/ready') {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: 'not ready', db: 'connected', reason: 'index missing' }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ status: 'live' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await verifyProductionDeploy({
      sha: SHA,
      baseUrl: origin,
      timeoutMs: 1_000,
      intervalMs: 20,
      requestTimeoutMs: 1000,
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'health_check_failed');
    assert.equal(result.health.commit, SHA);
    assert.equal(result.readiness.statusCode, 503);
    assert.equal(result.readiness.reason, 'index missing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST-DEPLOY: an absent health endpoint is a timeout, and invalid configuration is refused', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end('unavailable');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await verifyProductionDeploy({
      sha: SHA,
      baseUrl: origin,
      timeoutMs: 1_000,
      intervalMs: 20,
      requestTimeoutMs: 1000,
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'timeout');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(
    () => verifyProductionDeploy({ sha: 'not-a-sha', baseUrl: 'http://127.0.0.1:1' }),
    /expected SHA/,
  );
  await assert.rejects(
    () => verifyProductionDeploy({ sha: SHA, baseUrl: 'not-a-url' }),
    /base URL/,
  );
});
