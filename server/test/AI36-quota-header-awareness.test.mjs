/**
 * AI-36 — the account's remaining allowance is READ from the provider's own headers instead of
 * being discovered by spending a request that is refused.
 *
 * WHY THIS EXISTS. The free tier is metered at 50 requests a day, SHARED by every free model, so
 * AI-29 deliberately never fails over on a quota refusal: the next model would be refused
 * identically. That left two blind spots. The operator could not see the allowance approaching
 * zero — the first evidence was a member's failed turn — and once it was spent, every turn still
 * spent a round-trip to be told so, then answered 429. The provider publishes the number in its
 * response headers, so both are avoidable without a paid service or a new dependency.
 *
 * WHAT IS PINNED HERE:
 *
 *   * the headers are parsed (both spellings), non-numeric and absent values stay null;
 *   * the last reading is visible as `quota=<remaining>/<limit>` on the turn line;
 *   * a refusal the provider marked as ZERO remaining blocks further provider calls for a short,
 *     bounded window — and answers 429 immediately, with `calls=0`;
 *   * a 429 WITHOUT that evidence changes nothing (the existing one-request behaviour stays);
 *   * a successful call proves the allowance works again and lifts the block;
 *   * the block expires on its own, so a stale refusal cannot refuse service indefinitely.
 *
 * The provider is the in-process fake (or a stubbed `globalThis.fetch` for the wire case):
 * no request leaves this file.
 */

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { AiQuotaExceeded } from '../src/services/ai/aiErrors.ts';
import {
  noteQuotaRefusal,
  noteQuotaSuccess,
  parseQuotaHeaders,
  quotaBlockRemainingMs,
  quotaSnapshot,
  resetQuotaState,
} from '../src/services/ai/quota.ts';
import { postJson } from '../src/services/ai/providers/http.ts';
import { createAnthropicCompatibleProvider } from '../src/services/ai/providers/anthropicWire.ts';
import { resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelHealthGate } from '../src/services/ai/modelHealthGate.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const ENV_KEYS = ['AI_MODEL_OPENROUTER', 'AI_FALLBACK_MODELS_OPENROUTER'];

async function withCapturedLogs(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => {
    lines.push(args.join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

function turnArgs() {
  return {
    businessId: 'b-dummy',
    userId: 'u-dummy',
    role: ROLES.OWNER,
    message: 'say hello in one sentence',
  };
}

async function turn(scenario, options = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_MODEL_OPENROUTER = 'primary-model';
  if (options.fallback === undefined) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = options.fallback;
  const calls = [];
  try {
    const { value, lines } = await withCapturedLogs(async () => {
      setFakeScenario((ctx) => {
        calls.push(ctx.model);
        return scenario(ctx);
      });
      try {
        return { result: await runAiChat(turnArgs()), error: null };
      } catch (error) {
        return { result: null, error };
      }
    });
    return {
      ...value,
      lines,
      calls,
      costLines: lines.filter((line) => line.includes('AI turn outcome=')),
      quotaLines: lines.filter((line) => line.includes('quota was reported spent')),
    };
  } finally {
    setFakeScenario(null);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function fields(line) {
  const out = {};
  for (const part of line.replace('AI turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

function headers(map) {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(String(name).toLowerCase()) ?? null };
}

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

afterEach(() => {
  setFakeScenario(null);
  for (const key of ENV_KEYS) delete process.env[key];
  resetQuotaState();
  resetModelBreaker();
  resetModelSelection();
  resetModelHealthGate();
});

// ---------------------------------------------------------------------------
// Parsing and state
// ---------------------------------------------------------------------------

unitSuite('AI-36 quota headers', () => {
  it('reads both header spellings and ignores an absent or non-numeric value', () => {
    assert.deepEqual(parseQuotaHeaders(headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-limit': '50' })), {
      remaining: 12,
      limit: 50,
    });
    assert.deepEqual(parseQuotaHeaders(headers({ 'ratelimit-remaining': '3', 'ratelimit-limit': '50' })), {
      remaining: 3,
      limit: 50,
    });
    assert.equal(
      parseQuotaHeaders(headers({ 'x-ratelimit-remaining': 'not-a-number', 'x-ratelimit-limit': '-1' })),
      null,
      'an unusable header is not a zero and not a negative allowance',
    );
    assert.equal(parseQuotaHeaders(headers({})), null, 'nothing published is nothing to record');
    assert.equal(parseQuotaHeaders(null), null);
  });

  it('keeps the last reading for the turn line', () => {
    noteQuotaSuccess({ remaining: 12, limit: 50 });
    assert.deepEqual(
      { remaining: quotaSnapshot()?.remaining, limit: quotaSnapshot()?.limit },
      { remaining: 12, limit: 50 },
    );

    noteQuotaSuccess({ remaining: 11, limit: 50 });
    assert.equal(quotaSnapshot()?.remaining, 11);
  });

  it('blocks only when the provider itself reports that nothing is left', () => {
    noteQuotaRefusal({ remaining: 4, limit: 50 }, { blockMs: 60_000 });
    assert.equal(quotaBlockRemainingMs(), 0, 'a refusal with allowance left is not an exhausted account');

    noteQuotaRefusal(null, { blockMs: 60_000 });
    assert.equal(quotaBlockRemainingMs(), 0, 'a refusal without a reading changes nothing');

    noteQuotaRefusal({ remaining: 0, limit: 50 }, { blockMs: 60_000 });
    assert.ok(quotaBlockRemainingMs() > 0, 'zero remaining is the one reading worth acting on');
  });

  it('lifts the block as soon as a call succeeds, and expiry bounds it', () => {
    const now = 1_000_000;
    noteQuotaRefusal({ remaining: 0, limit: 50 }, { blockMs: 30_000, now });
    assert.equal(quotaBlockRemainingMs(now + 1_000) > 0, true);

    noteQuotaSuccess({ remaining: 1, limit: 50 });
    assert.equal(quotaBlockRemainingMs(), 0, 'a success proves the allowance is available again');

    noteQuotaRefusal({ remaining: 0, limit: 50 }, { blockMs: 30_000, now: 2_000_000 });
    assert.equal(quotaBlockRemainingMs(2_000_000 + 30_000), 0, 'the block is bounded, never permanent');
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

unitSuite('AI-36 quota over the wire', () => {
  it('returns the provider headers with the parsed body', async () => {
    const restore = stubFetch(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '50' },
      });
    });
    try {
      const result = await postJson({ url: 'https://example.invalid/v1/messages', body: {}, providerName: 'test' });
      assert.deepEqual(result.quota, { remaining: 7, limit: 50 });
      assert.deepEqual(result.data, { ok: true });
    } finally {
      restore();
    }
  });

  it('attaches the reading to a provider response so the turn can record it', async () => {
    const restore = stubFetch(async () => {
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'hi' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'x-ratelimit-limit': '50' },
      });
    });
    try {
      process.env.AI36_TEST_KEY = 'not-a-real-key'; // secret-guard:allow — a fixture
      const provider = createAnthropicCompatibleProvider({
        name: 'test',
        apiKeyEnv: 'AI36_TEST_KEY',
        messagesUrl: 'https://example.invalid/v1/messages',
        modelKey: 'openrouterModel',
        defaultModel: 'm',
      });
      const response = await provider.complete({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        timeoutMs: 1_000,
      });
      assert.equal(response.text, 'hi');
      assert.deepEqual(response.quota, { remaining: 9, limit: 50 });
    } finally {
      delete process.env.AI36_TEST_KEY;
      restore();
    }
  });

  it('carries zero remaining on the quota refusal, so the refusal can be acted on', async () => {
    const restore = stubFetch(async () => {
      return new Response(JSON.stringify({ error: { message: 'free-models-per-day' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '50' },
      });
    });
    try {
      await assert.rejects(
        () => postJson({ url: 'https://example.invalid/v1/messages', body: {}, providerName: 'test' }),
        (error) => {
          assert.ok(error instanceof AiQuotaExceeded);
          assert.deepEqual(error.quota, { remaining: 0, limit: 50 });
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

unitSuite('AI-36 quota-aware turns', () => {
  it('reports the remaining allowance on the turn line', async () => {
    const { costLines } = await turn(() => fakeText('ok', { quota: { remaining: 12, limit: 50 } }));

    assert.equal(costLines.length, 1);
    assert.equal(fields(costLines[0]).quota, '12/50');
  });

  it('says unknown rather than inventing a number when the provider publishes none', async () => {
    const { costLines } = await turn(() => fakeText('ok'));

    assert.equal(fields(costLines[0]).quota, 'unknown');
  });

  it('fails fast with 429 and ZERO provider calls once zero remaining was observed', async () => {
    noteQuotaRefusal({ remaining: 0, limit: 50 }, { blockMs: 30_000 });

    const { error, calls, costLines, quotaLines } = await turn(() => fakeText('must not be reached'));

    assert.equal(calls.length, 0, 'nothing was spent to be told what the header already said');
    assert.ok(error instanceof AiQuotaExceeded);
    assert.match(error.message, /usage limit/i);
    assert.equal(fields(costLines[0]).calls, '0');
    assert.ok(quotaLines.length === 1, 'the fail-fast is explained once, in the log');
  });

  it('blocks the next turn when a live 429 carried zero remaining', async () => {
    const first = await turn(() => {
      throw new AiQuotaExceeded(undefined, { remaining: 0, limit: 50 });
    });
    assert.ok(first.error instanceof AiQuotaExceeded);

    const second = await turn(() => fakeText('must not be reached'));
    assert.equal(second.calls.length, 0);
    assert.ok(second.error instanceof AiQuotaExceeded);
  });

  it('does NOT pre-empt on a 429 that carried no reading, preserving the one-request behaviour', async () => {
    const first = await turn(() => {
      throw new AiQuotaExceeded();
    });
    assert.ok(first.error instanceof AiQuotaExceeded);
    assert.equal(quotaBlockRemainingMs(), 0);

    const second = await turn(() => fakeText('still asked'));
    assert.equal(second.calls.length, 1, 'without evidence the next turn still asks the provider');
    assert.equal(second.result.content, 'still asked');
  });

  it('lifts the block when a later call succeeds', async () => {
    noteQuotaRefusal({ remaining: 0, limit: 50 }, { blockMs: 30_000 });
    noteQuotaSuccess({ remaining: 50, limit: 50 });

    const { result, calls } = await turn(() => fakeText('served'));
    assert.equal(calls.length, 1);
    assert.equal(result.content, 'served');
  });
});
