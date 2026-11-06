/**
 * AI-35 — the provider's own endpoint health decides which model a turn STARTS on, so a
 * deployment stops paying for a model the provider already says is not serving.
 *
 * WHY THIS EXISTS. AI-28 proved a listed-but-dead model could be SEEN (`GET /v1/models/{id}/endpoints`
 * reports status/uptime), and AI-34 alerts on it every 30 minutes — but neither changed selection.
 * A cold start therefore still tried the dead primary first, every turn, until five consecutive
 * refusals opened AI-30's cooldown: up to five wasted requests from a 50-a-day allowance, inside
 * the member's turn, before any surviving model was asked.
 *
 * WHAT IS PINNED HERE:
 *
 *   * only `unavailable` blocks a model — `degraded` is still serving and `unknown` is not evidence;
 *   * a mark expires, so a transient outage cannot remove a model forever;
 *   * every configured model being unavailable releases the configured primary, so a wrong health
 *     reading can never take the assistant completely offline;
 *   * a turn starts on the next configured model and NEVER calls the blocked one;
 *   * a blocked candidate is skipped inside the failover walk (with its own line);
 *   * a usable answer clears a mark that a concurrent check set while the turn was in flight;
 *   * all models blocked -> the existing 502 sentence with zero provider calls;
 *   * the boot refresh reads free endpoint health only, never a completion, and never throws.
 *
 * The provider is the in-process fake: no request leaves this file.
 */

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { AiProviderError } from '../src/services/ai/aiErrors.ts';
import {
  applyHealthVerdicts,
  clearModelHealth,
  isModelHealthBlocked,
  markModelUnavailable,
  modelHealthGateSnapshot,
  resetModelHealthGate,
} from '../src/services/ai/modelHealthGate.ts';
import { refreshModelHealthGate } from '../src/services/ai/healthWatch.ts';
import { resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelCapabilities } from '../src/services/ai/modelCapabilities.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';
const FALLBACK_2 = 'fallback-two';
/** The id the fake provider reports as its configured model: the default active model. */
const FAKE_MODEL = 'fake-model';

const ENV_KEYS = ['AI_MODEL_OPENROUTER', 'AI_FALLBACK_MODELS_OPENROUTER'];

function setEnv({ fallback = FALLBACK } = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

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

/** One turn, with the model ids the provider was actually called with. */
async function turn(scenario, options = {}) {
  const restore = setEnv(options);
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
      skipLines: lines.filter((line) => line.includes('unavailable by the provider')),
      failoverLines: lines.filter((line) => line.includes('[ai] failover')),
    };
  } finally {
    setFakeScenario(null);
    restore();
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

function upstream(status) {
  return new AiProviderError('The AI service returned an error. Please try again.', 'AI_UNAVAILABLE', status);
}

/** One verdict in the shape `classifyModelHealth` produces. */
function verdict(model, level, reason = `${model} is ${level}`) {
  return { model, role: 'fallback', level, reason, endpoints: [] };
}

afterEach(() => {
  setFakeScenario(null);
  for (const key of ENV_KEYS) delete process.env[key];
  resetModelHealthGate();
  resetModelBreaker();
  resetModelSelection();
  resetModelCapabilities();
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

unitSuite('AI-35 model-health gate', () => {
  it('blocks only an unavailable model, and clears it on a healthy reading', () => {
    applyHealthVerdicts(
      [verdict('a', 'unavailable'), verdict('b', 'degraded'), verdict('c', 'unknown'), verdict('d', 'ok')],
      { primary: 'a' },
    );

    assert.equal(isModelHealthBlocked('a'), true, 'unavailable removes a model from selection');
    assert.equal(isModelHealthBlocked('b'), false, 'degraded still serves traffic and must not be removed');
    assert.equal(isModelHealthBlocked('c'), false, 'a check that could not run is not evidence about the model');
    assert.equal(isModelHealthBlocked('d'), false);

    applyHealthVerdicts([verdict('a', 'ok')], { primary: 'a' });
    assert.equal(isModelHealthBlocked('a'), false, 'a healthy reading returns the model');
  });

  it('forgets a mark when its window expires', () => {
    const now = 1_000_000;
    markModelUnavailable('a', { ttlMs: 30_000, now, reason: 'no endpoint' });

    assert.equal(isModelHealthBlocked('a', now + 29_999), true);
    assert.equal(isModelHealthBlocked('a', now + 30_000), false, 'the mark is bounded, never permanent');
  });

  it('releases the configured primary when every model reads unavailable', () => {
    // A health reading that would remove EVERY model is the one case where trusting it can take
    // the assistant offline entirely, so the operator's configured choice keeps one attempt.
    const outcome = applyHealthVerdicts(
      [verdict('primary', 'unavailable'), verdict('fallback', 'unavailable')],
      { primary: 'primary' },
    );

    assert.equal(isModelHealthBlocked('primary'), false, 'the primary is still attempted');
    assert.equal(isModelHealthBlocked('fallback'), true);
    assert.deepEqual(outcome.released, ['primary']);
    assert.equal(outcome.blocked.includes('primary'), false);
  });

  it('does not release the primary while another model is still usable', () => {
    const outcome = applyHealthVerdicts(
      [verdict('primary', 'unavailable'), verdict('fallback', 'ok')],
      { primary: 'primary' },
    );

    assert.equal(isModelHealthBlocked('primary'), true);
    assert.deepEqual(outcome.released, []);
  });

  it('reports the models it is holding out, so the state is inspectable', () => {
    markModelUnavailable('a', { ttlMs: 60_000, now: 5000, reason: 'no endpoint currently healthy' });

    const snapshot = modelHealthGateSnapshot(6000);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].model, 'a');
    assert.equal(snapshot[0].reason, 'no endpoint currently healthy');
    assert.equal(snapshot[0].remainingMs, 59_000);
  });
});

// ---------------------------------------------------------------------------
// A turn's model choice
// ---------------------------------------------------------------------------

unitSuite('AI-35 health-aware turn selection', () => {
  it('starts on the next configured model and never calls the blocked one', async () => {
    markModelUnavailable(FAKE_MODEL, { reason: 'no endpoint currently reports status 0' });

    const { result, calls, skipLines } = await turn(() => fakeText('served by the fallback'));

    assert.deepEqual(calls, [FALLBACK], 'the blocked primary was never asked');
    assert.equal(result.content, 'served by the fallback');
    assert.ok(
      skipLines.some((line) => line.includes(FAKE_MODEL)),
      'the skipped model is named, so an operator can see why the deployment changed',
    );
  });

  it('never calls a blocked candidate, even when it is next in the chain', async () => {
    markModelUnavailable(FALLBACK, { reason: 'no endpoint currently reports status 0' });

    const { result, calls, skipLines } = await turn(
      (ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('served by the second candidate');
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.deepEqual(calls, [undefined, FALLBACK_2], 'the blocked candidate was never asked');
    assert.equal(result.content, 'served by the second candidate');
    assert.ok(
      skipLines.some((line) => line.includes(FALLBACK)),
      'the held-out model is named, so an operator can see why the deployment changed',
    );
  });

  it('skips a candidate that becomes unavailable while the turn is in flight', async () => {
    // The race the walk guard exists for: the watchdog marks a model between this turn's chain
    // being built and the walk reaching it. The fresh mark must win over the stale chain.
    const { result, calls, failoverLines } = await turn(
      (ctx) => {
        if (ctx.model === undefined) {
          markModelUnavailable(FALLBACK, { reason: 'a check ran mid-turn' });
          throw upstream(404);
        }
        return fakeText('served by the second candidate');
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.deepEqual(calls, [undefined, FALLBACK_2], 'the newly blocked candidate was never asked');
    assert.equal(result.content, 'served by the second candidate');
    assert.ok(
      failoverLines.some((line) => line.includes('reported unavailable')),
      'the skip inside the walk is explained rather than silent',
    );
  });

  it('clears a mark when the model answers, even if a check set it mid-turn', async () => {
    // The race this covers: the watchdog marks a model while a turn is already in flight, and that
    // turn proves the mark wrong. The answer must win — otherwise a stale reading outlives reality.
    const { result } = await turn((ctx) => {
      markModelUnavailable(ctx.model ?? FAKE_MODEL, { reason: 'a concurrent check set this' });
      return fakeText('it answered anyway');
    });

    assert.equal(result.content, 'it answered anyway');
    assert.equal(isModelHealthBlocked(FAKE_MODEL), false, 'a usable answer is the freshest evidence');
  });

  it('fails fast with the existing sentence and no provider call when every model is held out', async () => {
    markModelUnavailable(FAKE_MODEL, { reason: 'down' });
    markModelUnavailable(FALLBACK, { reason: 'down' });

    const { error, calls, lines } = await turn(() => fakeText('must not be reached'));

    assert.equal(calls.length, 0, 'nothing was spent to discover what the gate already knew');
    assert.equal(error?.code, 'AI_UNAVAILABLE');
    assert.match(error?.message ?? '', /temporarily unavailable/i);
    assert.ok(
      lines.some((line) => line.includes('every configured model is unavailable')),
      'the log distinguishes this from an all-cooling turn',
    );
  });

  it('still answers from the configured primary when the gate holds nothing', async () => {
    const { result, calls } = await turn(() => fakeText('primary answered'));

    assert.deepEqual(calls, [undefined], 'no override is sent when the configured model is used');
    assert.equal(result.content, 'primary answered');
  });
});

// ---------------------------------------------------------------------------
// The boot refresh
// ---------------------------------------------------------------------------

unitSuite('AI-35 boot health refresh', () => {
  const OPENROUTER_ENV = {
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key-not-real', // secret-guard:allow — a fixture, never used
    OPENROUTER_BASE_URL: 'https://openrouter.example/api',
    AI_MODEL_OPENROUTER: PRIMARY,
    AI_FALLBACK_MODELS_OPENROUTER: FALLBACK,
  };

  function health(over = {}) {
    return { status: 'ok', model: PRIMARY, message: 'published', endpoints: [], ...over };
  }

  it('marks the models the provider reports as unavailable and leaves the rest alone', async () => {
    const seen = [];
    const readHealth = async ({ model }) => {
      seen.push(model);
      if (model === PRIMARY) {
        return health({ model, endpoints: [{ provider: 'Vendor', status: -5, uptime5m: 0, uptime30m: 0, uptime1d: 0 }] });
      }
      return health({ model, endpoints: [{ provider: 'Vendor', status: 0, uptime5m: 100, uptime30m: 100, uptime1d: 100 }] });
    };

    const outcome = await refreshModelHealthGate({ env: OPENROUTER_ENV, readHealth });

    assert.deepEqual(seen, [PRIMARY, FALLBACK], 'every configured model is read, in order');
    assert.equal(isModelHealthBlocked(PRIMARY), true);
    assert.equal(isModelHealthBlocked(FALLBACK), false);
    assert.equal(outcome.blocked.includes(PRIMARY), true);
  });

  it('never marks a model when the reading itself failed', async () => {
    // `unreachable` means the QUESTION could not be asked. Treating it as an answer would turn a
    // broken check into an outage of its own.
    const outcome = await refreshModelHealthGate({
      env: OPENROUTER_ENV,
      readHealth: async () => health({ status: 'unreachable', message: 'provider could not be reached' }),
    });

    assert.equal(isModelHealthBlocked(PRIMARY), false);
    assert.equal(isModelHealthBlocked(FALLBACK), false);
    assert.deepEqual(outcome.blocked, []);
  });

  it('does nothing at all when no OpenRouter deployment is configured', async () => {
    let called = false;
    const outcome = await refreshModelHealthGate({
      env: { ...OPENROUTER_ENV, AI_PROVIDER: 'fake' },
      readHealth: async () => {
        called = true;
        return health();
      },
    });

    assert.equal(called, false, 'a deployment without OpenRouter must not contact a provider');
    assert.equal(outcome.status, 'not_applicable');
  });

  it('never throws when the reader throws, so a boot can never depend on it', async () => {
    const outcome = await refreshModelHealthGate({
      env: OPENROUTER_ENV,
      readHealth: async () => {
        throw new Error('boom');
      },
    });

    assert.equal(outcome.status, 'ok');
    assert.deepEqual(outcome.blocked, []);
  });

  it('clears a previous mark once the model reports healthy again', async () => {
    markModelUnavailable(PRIMARY, { reason: 'a previous reading' });

    await refreshModelHealthGate({
      env: OPENROUTER_ENV,
      readHealth: async ({ model }) =>
        health({ model, endpoints: [{ provider: 'Vendor', status: 0, uptime5m: 100, uptime30m: 100, uptime1d: 100 }] }),
    });

    assert.equal(isModelHealthBlocked(PRIMARY), false);
    clearModelHealth(PRIMARY);
  });
});
