// AI-101 — the assistant's monitoring record is complete and machine-readable.
//
// WHY THIS SUITE EXISTS. The ten fields an operator needs after a turn — model, tier,
// reasoning configuration, web configuration, duration, status, upstream provider, tools,
// tokens/credits, retry attempts and intent — used to be spread over four lines with two
// different shapes. A missing field was silent: nothing failed when `upstream` was never
// captured or when `retries` was not counted. These cases assert the RECORD, not the code:
// each one names the fields that make a real incident diagnosable.
//
// PURE BY CONSTRUCTION. The formatters take counts and labels and return a string; no
// provider, database or clock is involved, so a wrong format is a test failure rather than
// something discovered in Render's log viewer.

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import {
  configurationLine,
  durationSeconds,
  modelCallLine,
  modelTier,
  newTurnId,
  turnRequestLine,
  turnResultLine,
  turnStatus,
} from '../src/services/ai/aiMonitor.ts';
import { reasoningSettings } from '../src/services/ai/reasoningPolicy.ts';

const SETTINGS = reasoningSettings({
  AI_REASONING_FREE_MODELS: 'disable',
  AI_REASONING_PAID_MODELS: 'enable',
});

function request(over = {}) {
  return turnRequestLine({
    turn: '4f2a9c1e',
    intent: 'inventory:product_stock',
    route: 'simple',
    model: 'vendor/free:free',
    reasoning: SETTINGS,
    legacyReasoning: '',
    webSearch: true,
    webFetch: true,
    researchTools: false,
    ...over,
  });
}

function result(over = {}) {
  return turnResultLine({
    turn: '4f2a9c1e',
    outcome: 'ok',
    totalMs: 8284,
    providerMs: 7747,
    toolMs: 512,
    calls: 2,
    emptyResponses: 0,
    retries: 1,
    failovers: 1,
    reasks: 0,
    tools: ['getInventory'],
    toolRuns: 1,
    inputTokens: 24171,
    outputTokens: 157,
    cost: '$0.001073',
    quota: '991/1000',
    web: 'none',
    upstream: 'Groq',
    model: 'openai/gpt-oss-20b',
    route: 'simple',
    escalations: 0,
    iterations: 2,
    ...over,
  });
}

unitSuite('AI-101 AI monitoring record (DB-free)', () => {
  it('names the allowance a model id spends from', () => {
    assert.equal(modelTier('vendor/free:free'), 'free');
    assert.equal(modelTier('openai/gpt-oss-20b'), 'paid');
  });

  it('states intent, route, tier, reasoning and web configuration before the first request', () => {
    const line = request();

    assert.match(line, /^AI request /);
    assert.match(line, /intent=inventory:product_stock/);
    assert.match(line, /route=simple/);
    assert.match(line, /model=vendor\/free:free tier=free/);
    assert.match(line, /reasoning-free=disabled/);
    assert.match(line, /reasoning-free-source=AI_REASONING_FREE_MODELS/);
    assert.match(line, /reasoning-paid=enabled/);
    assert.match(line, /reasoning-paid-source=AI_REASONING_PAID_MODELS/);
    assert.match(line, /reasoning-legacy=unset/);
    assert.match(line, /web-search=enabled/);
    assert.match(line, /web-fetch=enabled/);
    assert.match(line, /tools=inventory\b/);
    assert.match(line, /turn=4f2a9c1e$/);
  });

  it('shows the legacy AI_REASONING switch and the source it supplied', () => {
    const legacy = reasoningSettings({ AI_REASONING: 'enable' });
    const line = request({ reasoning: legacy, legacyReasoning: 'enable' });

    assert.match(line, /reasoning-paid=enabled/);
    assert.match(line, /reasoning-paid-source=AI_REASONING/);
    assert.match(line, /reasoning-legacy=enable/);
  });

  it('names web research as its own intent and the tools it may use', () => {
    const line = request({ intent: 'web-research', route: 'research', researchTools: true });

    assert.match(line, /intent=web-research/);
    assert.match(line, /tools=inventory\+research/);
  });

  it('completes the turn with duration, status, attempts, tokens, credits and upstream', () => {
    const line = result();

    assert.match(line, /^AI turn outcome=ok status=ok/);
    assert.match(line, /duration=8.28s total=8284ms/);
    assert.match(line, /providerMs=7747ms toolMs=512ms/);
    assert.match(line, /calls=2 attempts=2 empty=0/);
    assert.match(line, /retries=1 failovers=1 reasks=0/);
    assert.match(line, /tools=getInventory toolRuns=1/);
    assert.match(line, /in=24171 out=157 cost=\$0\.001073/);
    assert.match(line, /upstream=Groq/);
    assert.match(line, /model=openai\/gpt-oss-20b tier=paid/);
    assert.match(line, /route=simple simpleEscalations=0 iterations=2/);
    assert.match(line, /turn=4f2a9c1e$/);
  });

  it('reports a failed turn as failed and never invents an upstream or a model', () => {
    const line = result({ outcome: 'AI_TIMEOUT', upstream: null, model: null, cost: 'unknown' });

    assert.match(line, /outcome=AI_TIMEOUT status=failed/);
    assert.match(line, /upstream=unknown/);
    assert.match(line, /model=unknown tier=unknown/);
    assert.match(line, /cost=unknown/);
    assert.equal(turnStatus('degraded'), 'degraded', 'a degraded turn is neither ok nor failed');
  });

  it('identifies the tier and the reasoning field sent on every model call', () => {
    const line = modelCallLine({
      turn: '4f2a9c1e',
      provider: 'openrouter',
      model: 'vendor/free:free',
      reasoning: 'disabled',
      field: 'disabled',
      source: 'AI_REASONING_FREE_MODELS',
    });

    assert.equal(
      line,
      'AI model call provider=openrouter model=vendor/free:free tier=free reasoning=disabled' +
        ' field=disabled source=AI_REASONING_FREE_MODELS turn=4f2a9c1e',
    );
  });

  it('mints one short id that every record of a turn can share', () => {
    const first = newTurnId();
    assert.match(first, /^[0-9a-f]{8}$/);
    assert.notEqual(newTurnId(), first, 'two turns must not share an id');
  });

  it('states models, reasoning and web tools in one boot record', () => {
    const line = configurationLine({
      models: ['openai/gpt-oss-20b', 'vendor/free:free'],
      reasoning: SETTINGS,
      legacyReasoning: '',
      webSearch: true,
      webFetch: false,
    });

    assert.match(line, /^AI configuration models=openai\/gpt-oss-20b->vendor\/free:free/);
    assert.match(line, /reasoning-free=disabled/);
    assert.match(line, /reasoning-paid=enabled/);
    assert.match(line, /web-search=enabled/);
    assert.match(line, /web-fetch=disabled/);
    assert.doesNotMatch(line, /\[ai\]/, 'the monitoring record no longer uses a generic prefix');
  });

  it('prints the same duration in two units without rounding it away', () => {
    assert.equal(durationSeconds(905), '0.91s', 'two decimals round to the nearest 10 ms');
    assert.equal(durationSeconds(15211), '15.21s');
    assert.equal(durationSeconds(60000), '1m 0.00s', 'a minute and longer switch to minutes');
    assert.equal(durationSeconds(75210), '1m 15.21s');
  });
});
