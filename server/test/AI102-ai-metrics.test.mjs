// AI-102 — durable AI turn metrics and the protected metrics endpoint.
//
// WHAT IS PINNED:
//   * free/paid/unknown turn classification and status derivation;
//   * provider cost is never coerced: complete, partial and unknown stay distinct;
//   * one turn writes one row even when the same report is retried;
//   * two real turns that share a short turn id are still two rows;
//   * the endpoint is OWNER/ADMIN only and scopes every query to the caller's business;
//   * it returns counts, failovers, retries, re-asks, latency and daily cost separately;
//   * the day window is UTC and every day is present, including empty ones.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';

import { unitSuite, dbSuite } from './testEnv.mjs';
import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  disconnectDb,
} from './support.mjs';
import { ROLES } from '../src/constants/roles.ts';
import AiTurnMetric from '../src/models/aiTurnMetric.model.ts';
import {
  buildAiTurnMetricDocument,
  parseAiMetricsDays,
  recordAiTurnMetric,
} from '../src/services/ai/aiMetrics.service.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

function metricInput(overrides = {}) {
  const now = new Date();
  return {
    turnId: 'a1b2c3d4',
    businessId: String(new mongoose.Types.ObjectId()),
    userId: String(new mongoose.Types.ObjectId()),
    startedAt: new Date(now.getTime() - 1000),
    completedAt: now,
    outcome: 'ok',
    route: 'default',
    model: 'vendor/free:free',
    upstream: 'vendor',
    durationMs: 1000,
    providerMs: 900,
    toolMs: 100,
    calls: 1,
    emptyResponses: 0,
    retries: 0,
    failovers: 0,
    reasks: 0,
    escalations: 0,
    iterations: 1,
    toolRuns: 0,
    tools: [],
    inputTokens: 10,
    outputTokens: 5,
    providerCostUsd: 0,
    unknownCostCalls: 0,
    quota: 'unknown',
    web: 'none',
    ...overrides,
  };
}

unitSuite('AI-102 turn metric records', () => {
  it('classifies tier, status and complete provider cost', () => {
    const row = buildAiTurnMetricDocument(metricInput());
    assert.equal(row.tier, 'free');
    assert.equal(row.status, 'ok');
    assert.equal(row.costStatus, 'provider');
    assert.equal(row.providerCostComplete, true);
    assert.equal(row.providerCostUsd, 0, 'a reported zero is a real value, not unknown');

    const paid = buildAiTurnMetricDocument(
      metricInput({ model: 'vendor/paid-model', outcome: 'degraded' }),
    );
    assert.equal(paid.tier, 'paid');
    assert.equal(paid.status, 'degraded');
  });

  it('never turns an unknown or partial charge into a number', () => {
    const unknown = buildAiTurnMetricDocument(
      metricInput({ providerCostUsd: null, unknownCostCalls: 2 }),
    );
    assert.equal(unknown.providerCostUsd, null);
    assert.equal(unknown.costStatus, 'unknown');
    assert.equal(unknown.providerCostComplete, false);

    const partial = buildAiTurnMetricDocument(
      metricInput({ providerCostUsd: 0.0123, unknownCostCalls: 1 }),
    );
    assert.equal(partial.providerCostUsd, 0.0123);
    assert.equal(partial.costStatus, 'partial');
    assert.equal(partial.providerCostComplete, false);

    const malformed = buildAiTurnMetricDocument(
      metricInput({ providerCostUsd: Number.NaN }),
    );
    assert.equal(malformed.providerCostUsd, null);
    assert.equal(malformed.costStatus, 'unknown');
  });

  it('keeps retries, re-asks and failovers separate', () => {
    const row = buildAiTurnMetricDocument(
      metricInput({ retries: 3, reasks: 2, failovers: 1, escalations: 1, calls: 4 }),
    );
    assert.equal(row.retries, 3);
    assert.equal(row.reasks, 2);
    assert.equal(row.failovers, 1);
    assert.equal(row.escalations, 1);
    assert.equal(row.calls, 4, 'provider calls are not turns');
  });

  it('defaults and validates the day window', () => {
    assert.deepEqual(parseAiMetricsDays(undefined), { days: 7, problem: null });
    assert.deepEqual(parseAiMetricsDays('30'), { days: 30, problem: null });
    assert.match(parseAiMetricsDays('0').problem, /1 to 90/);
    assert.match(parseAiMetricsDays('91').problem, /1 to 90/);
    assert.match(parseAiMetricsDays('7.5').problem, /1 to 90/);
    assert.match(parseAiMetricsDays(['7']).problem, /1 to 90/);
  });
});

dbSuite('AI-102 metrics endpoint', dbOk, () => {
  let owner;
  let admin;
  let manager;
  let staff;
  let otherOwner;
  let mainTurnIds = [];

  before(async () => {
    owner = await registerOwner(api, tracker);
    admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
    otherOwner = await registerOwner(api, tracker);

    const base = Date.now();
    const rows = [
      {
        turnId: 'm1free',
        outcome: 'ok',
        model: 'vendor/free:free',
        durationMs: 1000,
        failovers: 0,
        retries: 0,
        reasks: 1,
        escalations: 0,
        providerCostUsd: 0,
        unknownCostCalls: 0,
      },
      {
        turnId: 'm2paid',
        outcome: 'ok',
        model: 'vendor/paid',
        durationMs: 3000,
        failovers: 1,
        retries: 2,
        reasks: 0,
        escalations: 0,
        providerCostUsd: 0.02,
        unknownCostCalls: 0,
      },
      {
        turnId: 'm3partial',
        outcome: 'failed',
        model: 'vendor/paid',
        durationMs: 5000,
        failovers: 2,
        retries: 1,
        reasks: 0,
        escalations: 1,
        providerCostUsd: 0.01,
        unknownCostCalls: 1,
      },
      {
        turnId: 'm4unknown',
        outcome: 'degraded',
        model: null,
        durationMs: 2000,
        failovers: 0,
        retries: 0,
        reasks: 0,
        escalations: 0,
        providerCostUsd: null,
        unknownCostCalls: 0,
      },
    ];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      mainTurnIds.push(row.turnId);
      const ok = await recordAiTurnMetric(
        metricInput({
          ...row,
          businessId: owner.businessId,
          userId: owner.userId,
          startedAt: new Date(base - (i + 1) * 1000),
          completedAt: new Date(base - i * 1000),
        }),
      );
      assert.equal(ok, true, `metric ${row.turnId} was not written`);
    }

    const other = await recordAiTurnMetric(
      metricInput({
        turnId: 'other1',
        businessId: otherOwner.businessId,
        userId: otherOwner.userId,
        startedAt: new Date(base - 1000),
        completedAt: new Date(base),
      }),
    );
    assert.equal(other, true, 'the other tenant metric was not written');
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('requires authentication and admits only OWNER/ADMIN', async () => {
    assert.equal((await api('GET', '/api/ai/metrics')).status, 401);
    assert.equal((await api('GET', '/api/ai/metrics', { token: owner.token })).status, 200);
    assert.equal((await api('GET', '/api/ai/metrics', { token: admin.token })).status, 200);
    assert.equal((await api('GET', '/api/ai/metrics', { token: manager.token })).status, 403);
    assert.equal((await api('GET', '/api/ai/metrics', { token: staff.token })).status, 403);
  });

  it('counts each turn once and keeps free/paid, failover, retry and re-ask separate', async () => {
    const res = await api('GET', '/api/ai/metrics?days=7', { token: owner.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.range.timeZone, 'UTC');
    assert.equal(res.json.range.days, 7);
    assert.equal(res.json.daily.length, 7, 'every UTC day is present, including empty ones');

    const totals = res.json.totals;
    assert.equal(totals.turns, 4);
    assert.equal(totals.freeTurns, 1);
    assert.equal(totals.paidTurns, 2);
    assert.equal(totals.unknownTierTurns, 1);
    assert.equal(totals.failoverTurns, 2);
    assert.equal(totals.failoverRate, 0.5);
    assert.equal(totals.failovers, 3);
    assert.equal(totals.retries, 3);
    assert.equal(totals.reasks, 1);
    assert.equal(totals.simpleEscalationTurns, 1);
    assert.equal(totals.okTurns, 2);
    assert.equal(totals.degradedTurns, 1);
    assert.equal(totals.failedTurns, 1);

    assert.equal(totals.latency.sampleSize, 4);
    assert.ok(totals.latency.medianMs >= 2000 && totals.latency.medianMs <= 3000);
    assert.ok(totals.latency.p95Ms >= 3000 && totals.latency.p95Ms <= 5000);
    assert.equal(totals.latency.minMs, 1000);
    assert.equal(totals.latency.maxMs, 5000);

    assert.equal(totals.cost.providerReportedUsd, 0.03);
    assert.equal(totals.cost.reportedCostTurns, 3);
    assert.equal(totals.cost.completeCostTurns, 2);
    assert.equal(totals.cost.partialCostTurns, 1);
    assert.equal(totals.cost.unknownCostTurns, 1);
    assert.equal(totals.cost.complete, false);
    assert.equal(totals.cost.estimatedUsd, null);
    assert.equal(totals.cost.estimatedAvailable, false);

    const raw = await fetch(`${baseUrl}/api/ai/metrics?days=7`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('cache-control'), 'no-store');
  });

  it('scopes the aggregation to the caller’s business', async () => {
    const res = await api('GET', '/api/ai/metrics?days=7', { token: otherOwner.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.totals.turns, 1, 'only the other tenant’s one turn is counted');
    assert.equal(res.json.totals.freeTurns, 1);
  });

  it('rejects an invalid day window instead of silently widening it', async () => {
    const res = await api('GET', '/api/ai/metrics?days=0', { token: owner.token });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'VALIDATION_ERROR');
  });

  it('returns zeroed days and an unknown, not zero-dollar, spend when there are no turns', async () => {
    const empty = await registerOwner(api, tracker);
    const res = await api('GET', '/api/ai/metrics?days=3', { token: empty.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.totals.turns, 0);
    assert.equal(res.json.totals.freeRate, null);
    assert.equal(res.json.totals.failoverRate, null);
    assert.equal(res.json.totals.cost.providerReportedUsd, null);
    assert.equal(res.json.totals.cost.complete, false);
    assert.equal(res.json.daily.length, 3);
    assert.ok(
      res.json.daily.every((day) => day.turns === 0 && day.providerReportedUsd === null),
      'an empty day must be zero turns and unknown spend, never zero dollars',
    );
  });

  it('writes one row for a retried report and two rows for two real turns', async () => {
    const businessId = String(new mongoose.Types.ObjectId());
    const input = metricInput({ businessId, turnId: 'retry1' });
    assert.equal(await recordAiTurnMetric(input), true);
    assert.equal(await recordAiTurnMetric(input), true);
    assert.equal(
      await AiTurnMetric.countDocuments({ businessId, turnId: 'retry1' }),
      1,
      'retrying the same report must not double-count the turn',
    );

    const sameId = metricInput({
      businessId,
      turnId: 'retry1',
      startedAt: new Date(input.startedAt.getTime() - 1),
    });
    assert.equal(await recordAiTurnMetric(sameId), true);
    assert.equal(
      await AiTurnMetric.countDocuments({ businessId, turnId: 'retry1' }),
      2,
      'a turn-id collision between two real turns must keep both',
    );
    await AiTurnMetric.deleteMany({ businessId });
  });

  it('writes the row from a real turn, with the provider-reported cost and model tier', async () => {
    const stub = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'stub/paid-model',
          content: [{ type: 'text', text: 'Hello.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2, cost: 0.001 },
        }),
      );
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = stub.address().port;

    const keys = [
      'AI_PROVIDER',
      'OPENROUTER_API_KEY',
      'OPENROUTER_BASE_URL',
      'AI_MODEL_OPENROUTER',
      'AI_FALLBACK_MODELS_OPENROUTER',
      'AI_REASONING_PAID_MODELS',
      'AI_WEB_SEARCH',
      'AI_WEB_FETCH',
    ];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const businessId = String(new mongoose.Types.ObjectId());
    try {
      Object.assign(process.env, {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key', // secret-guard:allow — local stub only
        OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api`,
        AI_MODEL_OPENROUTER: 'stub/paid-model',
        AI_FALLBACK_MODELS_OPENROUTER: '',
        AI_REASONING_PAID_MODELS: 'enable',
        AI_WEB_SEARCH: 'disable',
        AI_WEB_FETCH: 'disable',
      });

      const result = await runAiChat({
        businessId,
        userId: String(new mongoose.Types.ObjectId()),
        role: ROLES.OWNER,
        message: 'hello',
        timeZone: 'UTC',
      });
      assert.equal(result.content, 'Hello.');

      let row = null;
      for (let i = 0; i < 40; i += 1) {
        row = await AiTurnMetric.findOne({ businessId, turnId: result.turnId });
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(row, 'the real turn did not write a metrics row');
      assert.equal(row.status, 'ok');
      assert.equal(row.tier, 'paid');
      assert.equal(row.model, 'stub/paid-model');
      assert.equal(row.calls, 1);
      assert.equal(row.providerCostUsd, 0.001);
      assert.equal(row.providerCostComplete, true);
      assert.equal(row.costStatus, 'provider');
    } finally {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise((resolve) => stub.close(resolve));
      await AiTurnMetric.deleteMany({ businessId });
    }
  });
});
