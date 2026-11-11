// OPS-4 — the external production probe's decision logic.
//
// The scheduled workflow runs the CLI, but the decision that matters is testable without
// GitHub and without touching production: a 200 readiness response alone is not healthy,
// a health body missing `status: ok` or `db: connected` is not healthy, and a single failed
// probe must not alert while a second successful one must recover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { checkProductionHealth } from '../../scripts/check-production-health.mjs';

test('OPS-4: the production probe distinguishes healthy, unhealthy and recovered attempts', async () => {
  let readyStatus = 200;
  let healthStatus = 200;
  let healthBody = { status: 'ok', db: 'connected', commit: 'abc123' };
  let readyCalls = 0;
  let healthCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/ready') {
      readyCalls += 1;
      res.statusCode = readyStatus;
      res.end('ready');
      return;
    }
    if (req.url === '/health') {
      healthCalls += 1;
      res.statusCode = healthStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(healthBody));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0);
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const healthy = await checkProductionHealth({
      readyUrl: `${origin}/ready`,
      healthUrl: `${origin}/health`,
      attempts: 2,
      delayMs: 0,
      timeoutMs: 2_000,
    });
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.checks.length, 1, 'one healthy probe is enough');
    assert.equal(healthy.checks[0].health.status, 'ok');
    assert.equal(healthy.checks[0].health.db, 'connected');

    // The readiness endpoint is the first gate: a 503 is unhealthy even when the richer
    // health body still says ok (the two endpoints answer different questions).
    readyStatus = 503;
    readyCalls = 0;
    healthCalls = 0;
    const readyDown = await checkProductionHealth({
      readyUrl: `${origin}/ready`,
      healthUrl: `${origin}/health`,
      attempts: 2,
      delayMs: 0,
      timeoutMs: 2_000,
    });
    assert.equal(readyDown.healthy, false);
    assert.equal(readyDown.checks.length, 2, 'two failed probes are required');
    assert.equal(readyCalls, 2);
    assert.equal(healthCalls, 2);
    assert.equal(readyDown.checks[0].ready.statusCode, 503);

    // A 200 with a degraded/failed database is not ready for the product either.
    readyStatus = 200;
    healthStatus = 200;
    healthBody = { status: 'degraded', db: 'disconnected', commit: 'abc123' };
    const degraded = await checkProductionHealth({
      readyUrl: `${origin}/ready`,
      healthUrl: `${origin}/health`,
      attempts: 1,
      delayMs: 0,
      timeoutMs: 2_000,
    });
    assert.equal(degraded.healthy, false);
    assert.equal(degraded.checks[0].health.status, 'degraded');
    assert.equal(degraded.checks[0].health.db, 'disconnected');

    // The first failed attempt followed by a healthy one is recovery inside the window:
    // the workflow must not open an alert for a transient cold start.
    readyStatus = 200;
    healthStatus = 200;
    healthBody = { status: 'ok', db: 'connected', commit: 'abc123' };
    let first = true;
    const transient = http.createServer((req, res) => {
      if (req.url === '/ready') {
        res.statusCode = first ? 503 : 200;
        if (first) first = false;
        res.end('ready');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', db: 'connected' }));
    });
    transient.listen(0);
    await once(transient, 'listening');
    try {
      const tOrigin = `http://127.0.0.1:${transient.address().port}`;
      const recovered = await checkProductionHealth({
        readyUrl: `${tOrigin}/ready`,
        healthUrl: `${tOrigin}/health`,
        attempts: 2,
        delayMs: 0,
        timeoutMs: 2_000,
      });
      assert.equal(recovered.healthy, true);
      assert.equal(recovered.checks.length, 2, 'the first failure was observed, then the second probe recovered');
    } finally {
      await new Promise((resolve) => transient.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
