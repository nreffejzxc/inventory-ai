// AI-30 — a model that has just failed five times should not be tried again on the
// very next turn.
//
// THE PROBLEM. AI-29 made a broken model survivable: a turn that hits a dead primary
// walks to a healthy candidate and still answers. But the configured primary is tried
// FIRST on every new turn, so a model that is known-dead costs one failed request —
// and, on a free tier, a share of a shared allowance — on every turn for as long as an
// operator leaves it configured. That is reliability with a recurring tax.
//
// WHAT IS PINNED HERE:
//
//   * consecutive model-specific failures are counted per model id;
//   * the FIFTH opens a 30-second cooldown, and a model inside it is skipped;
//   * the primary is skipped like any other model, without changing configuration,
//     and the turn starts directly on the next eligible candidate;
//   * the cooldown expires on its own, so the model is eligible again — and one more
//     failure re-opens it at once (the count is NOT reset at expiry);
//   * a single success clears the streak and closes the breaker;
//   * quota (429/402), auth (401/403), bad request (400), configuration errors and
//     UNCLASSIFIED provider errors never touch the breaker;
//   * a CLASSIFIED transport failure (AI-31: network/timeout/invalid_response) counts,
//     but ends the turn instead of walking to another model;
//   * if every model is cooling, the turn fails fast with ZERO provider calls;
//   * a cooling candidate is skipped inside the failover walk too.
//
// Nothing here spends provider quota: the provider is the in-process fake.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { AiProviderError, AiQuotaExceeded } from '../src/services/ai/aiErrors.ts';
import {
  isModelCooling,
  modelBreakerSnapshot,
  modelCooldownRemainingMs,
  modelFailureCount,
  MODEL_COOLDOWN_MAX_MS,
  MODEL_COOLDOWN_MS,
  MODEL_FAILURE_THRESHOLD,
  recordModelFailure,
  recordModelSuccess,
  resetModelBreaker,
} from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelCapabilities } from '../src/services/ai/modelCapabilities.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';
const FALLBACK_2 = 'fallback-two';
/** The id the fake provider reports as its configured model — the breaker's key. */
const FAKE_MODEL = 'fake-model';

function upstream(status) {
  return new AiProviderError('The AI service returned an error. Please try again.', 'AI_UNAVAILABLE', status);
}

/**
 * One turn with logs captured and the fake provider's call log exposed. The call log
 * is the important half: `undefined` means "no model override, so the configured
 * primary", a string means the request named that candidate.
 */
async function turn(scenario, { fallback = FALLBACK } = {}) {
  const lines = [];
  const calls = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => {
    lines.push(args.join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const saved = {
    AI_MODEL_OPENROUTER: process.env.AI_MODEL_OPENROUTER,
    AI_FALLBACK_MODELS_OPENROUTER: process.env.AI_FALLBACK_MODELS_OPENROUTER,
  };
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;

  let result = null;
  let error = null;
  try {
    setFakeScenario((ctx) => {
      calls.push(ctx.model);
      return scenario(ctx);
    });
    result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'say hello in one sentence',
    });
  } catch (err) {
    error = err;
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return {
    lines,
    calls,
    result,
    error,
    failoverLines: lines.filter((line) => line.includes('[ai] failover')),
    costLines: lines.filter((line) => line.includes('[ai] turn')),
    cooldownLines: lines.filter((line) => line.includes('cooling down')),
  };
}

function fields(line) {
  const out = {};
  for (const part of line.replace('[ai] turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

function prime(model, times = MODEL_FAILURE_THRESHOLD) {
  for (let i = 0; i < times; i += 1) recordModelFailure(model);
}

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  delete process.env.AI_MODEL_FAILURE_THRESHOLD;
  delete process.env.AI_MODEL_COOLDOWN_MS;
  resetModelCapabilities();
  resetModelBreaker();
  resetModelSelection();
});

// ---------------------------------------------------------------------------
// The breaker itself
// ---------------------------------------------------------------------------

unitSuite('AI-30 model breaker', () => {
  it('opens on the FIFTH consecutive failure, not before', () => {
    for (let i = 1; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      const outcome = recordModelFailure(PRIMARY);
      assert.equal(outcome.failures, i);
      assert.equal(outcome.opened, false, `failure ${i} must not open the breaker`);
      assert.equal(isModelCooling(PRIMARY), false);
    }

    const fifth = recordModelFailure(PRIMARY);
    assert.equal(fifth.failures, MODEL_FAILURE_THRESHOLD);
    assert.equal(fifth.opened, true);
    assert.equal(isModelCooling(PRIMARY), true);
    assert.ok(modelCooldownRemainingMs(PRIMARY) > 0);
    assert.ok(modelCooldownRemainingMs(PRIMARY) <= MODEL_COOLDOWN_MS);
  });

  it('skips for exactly 30 seconds and is eligible again on its own', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) recordModelFailure(PRIMARY, t0);

    assert.equal(isModelCooling(PRIMARY, t0), true);
    assert.equal(isModelCooling(PRIMARY, t0 + MODEL_COOLDOWN_MS - 1), true);
    assert.equal(modelCooldownRemainingMs(PRIMARY, t0 + 1_000), MODEL_COOLDOWN_MS - 1_000);
    assert.equal(isModelCooling(PRIMARY, t0 + MODEL_COOLDOWN_MS), false, 'the window ends by itself');
    assert.equal(modelFailureCount(PRIMARY), MODEL_FAILURE_THRESHOLD, 'expiry does not erase the streak');
  });

  it('re-opens immediately when the first trial after a cooldown fails', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) recordModelFailure(PRIMARY, t0);

    const afterCooldown = t0 + MODEL_COOLDOWN_MS;
    assert.equal(isModelCooling(PRIMARY, afterCooldown), false);

    const trial = recordModelFailure(PRIMARY, afterCooldown);
    assert.equal(trial.opened, true, 'a failed half-open trial must not wait for five more failures');
    assert.equal(trial.failures, MODEL_FAILURE_THRESHOLD + 1);
    assert.equal(isModelCooling(PRIMARY, afterCooldown + 1), true);
    assert.equal(
      modelCooldownRemainingMs(PRIMARY, afterCooldown + 1),
      MODEL_COOLDOWN_MS * 2 - 1,
      'a failed trial waits longer than the first cooldown',
    );
  });

  it('backs off on repeated failed trials, up to a 5-minute ceiling', () => {
    const t0 = 1_000_000;
    const fail = (now) => recordModelFailure(PRIMARY, now);

    fail(t0);
    fail(t0);
    fail(t0);
    fail(t0);
    fail(t0);
    assert.equal(modelCooldownRemainingMs(PRIMARY, t0), MODEL_COOLDOWN_MS);

    let t = t0 + MODEL_COOLDOWN_MS;
    fail(t);
    assert.equal(modelCooldownRemainingMs(PRIMARY, t), MODEL_COOLDOWN_MS * 2);

    t += MODEL_COOLDOWN_MS * 2;
    fail(t);
    assert.equal(modelCooldownRemainingMs(PRIMARY, t), MODEL_COOLDOWN_MS * 4);

    t += MODEL_COOLDOWN_MS * 4;
    fail(t);
    assert.equal(modelCooldownRemainingMs(PRIMARY, t), MODEL_COOLDOWN_MS * 8);

    t += MODEL_COOLDOWN_MS * 8;
    fail(t);
    assert.equal(
      modelCooldownRemainingMs(PRIMARY, t),
      MODEL_COOLDOWN_MAX_MS,
      'the ceiling stops a permanently dead model from backing off indefinitely',
    );
  });

  it('one success clears the streak and the cooldown', () => {
    prime(PRIMARY);
    assert.equal(isModelCooling(PRIMARY), true);

    recordModelSuccess(PRIMARY);
    assert.equal(modelFailureCount(PRIMARY), 0);
    assert.equal(isModelCooling(PRIMARY), false);
    assert.equal(modelCooldownRemainingMs(PRIMARY), 0);
  });

  it('counts each model separately', () => {
    prime(PRIMARY);
    recordModelFailure(FALLBACK);

    assert.equal(isModelCooling(PRIMARY), true);
    assert.equal(isModelCooling(FALLBACK), false, 'one model failing says nothing about another');
    assert.equal(modelFailureCount(FALLBACK), 1);
    assert.deepEqual(
      modelBreakerSnapshot().map((entry) => entry.model).sort(),
      [FALLBACK, PRIMARY].sort(),
    );
  });

  it('ignores an absent id rather than inventing a bucket', () => {
    assert.deepEqual(recordModelFailure(null), {
      failures: 0,
      opened: false,
      openUntil: null,
      cooldownMs: 0,
    });
    recordModelSuccess(undefined);
    assert.deepEqual(modelBreakerSnapshot(), []);
  });
});

// ---------------------------------------------------------------------------
// The turn loop using the breaker
// ---------------------------------------------------------------------------

unitSuite('AI-30 turns with a cooling model', () => {
  it('starts directly on a candidate while the primary is cooling', async () => {
    prime(FAKE_MODEL);

    // The answer deliberately states no figure: this suite measures model selection, and
    // AI-60 re-asks any turn that states one without reading (a single extra call here would
    // be correct behaviour, but it is not what these assertions are about).
    const { result, error, calls, cooldownLines, failoverLines, costLines } = await turn(() =>
      fakeText('Happy to help — which product should I check?'),
    );

    assert.equal(error, null);
    assert.equal(result.content, 'Happy to help — which product should I check?');
    assert.deepEqual(calls, [FALLBACK], 'the primary must not be tried at all');
    assert.equal(failoverLines.length, 0, 'this is not a failover — the model was chosen up front');
    assert.equal(fields(costLines[0]).failovers, '0');
    assert.match(cooldownLines.join('\n'), new RegExp(`skipped: .*${FAKE_MODEL}`));
    assert.match(cooldownLines.join('\n'), /s left\)/);
  });

  it('skips the primary after five failing turns without changing configuration', async () => {
    // Each turn: primary 404, fallback answers. After the fifth the primary is cooling.
    for (let i = 1; i <= MODEL_FAILURE_THRESHOLD; i += 1) {
      const { calls, error } = await turn((ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('answered by the fallback');
      });
      assert.equal(error, null);
      assert.deepEqual(calls, [undefined, FALLBACK]);
      assert.equal(modelFailureCount(FAKE_MODEL), i);
    }

    assert.equal(isModelCooling(FAKE_MODEL), true);

    let configuredDuringTurn = null;
    const sixth = await turn(() => {
      configuredDuringTurn = process.env.AI_MODEL_OPENROUTER;
      return fakeText('still answering');
    });
    assert.equal(sixth.error, null);
    assert.deepEqual(sixth.calls, [FALLBACK], 'the sixth turn pays no failed request');
    assert.equal(fields(sixth.costLines[0]).calls, '1');
    assert.equal(configuredDuringTurn, PRIMARY, 'the primary stays configured while it cools');
  });

  it('logs the moment the breaker opens, naming the model and the count', async () => {
    let last = null;
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      last = await turn((ctx) => {
        if (ctx.model === undefined) throw upstream(503);
        return fakeText('ok');
      });
    }

    assert.match(
      last.cooldownLines.join('\n'),
      /model cooling down for 30s after 5 consecutive failure\(s\): fake-model/,
    );
  });

  it('resets the streak when the model answers again', async () => {
    prime(FAKE_MODEL, MODEL_FAILURE_THRESHOLD - 1);
    assert.equal(modelFailureCount(FAKE_MODEL), MODEL_FAILURE_THRESHOLD - 1);

    const { result, calls, error } = await turn(() => fakeText('healthy again'));
    assert.equal(error, null);
    assert.equal(result.content, 'healthy again');
    assert.deepEqual(calls, [undefined], 'a model under the threshold is still tried first');
    assert.equal(modelFailureCount(FAKE_MODEL), 0);
    assert.equal(isModelCooling(FAKE_MODEL), false);
  });

  it('skips a cooling candidate inside the failover walk', async () => {
    prime(FALLBACK);

    const { result, error, calls, failoverLines, lines } = await turn(
      (ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        if (ctx.model === FALLBACK) throw new Error('the cooling candidate must never be called');
        return fakeText('answered by the second candidate');
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.equal(error, null);
    assert.equal(result.content, 'answered by the second candidate');
    assert.deepEqual(calls, [undefined, FALLBACK_2], 'the cooling candidate is skipped, not tried');
    assert.equal(failoverLines.length, 1);
    assert.match(failoverLines[0], new RegExp(`-> ${FALLBACK_2}`));
    assert.match(lines.join('\n'), new RegExp(`model cooling down, skipped: .*${FALLBACK}`));
  });

  it('fails fast with ZERO provider calls when every model is cooling', async () => {
    prime(FAKE_MODEL);
    prime(FALLBACK);

    const { error, calls, lines, costLines } = await turn(() => fakeText('never reached'));

    assert.ok(error instanceof AiProviderError);
    assert.equal(error.code, 'AI_UNAVAILABLE');
    assert.equal(calls.length, 0, 'a known-bad deployment must not spend a request to prove it');
    assert.equal(fields(costLines[0]).calls, '0');
    assert.equal(fields(costLines[0]).outcome, 'AI_UNAVAILABLE');
    assert.match(lines.join('\n'), /every configured model is cooling down/);
  });

  it('does not count a quota refusal against the model', async () => {
    const { error, calls, failoverLines } = await turn(() => {
      throw new AiQuotaExceeded();
    });

    assert.ok(error instanceof AiQuotaExceeded);
    assert.equal(calls.length, 1);
    assert.equal(failoverLines.length, 0);
    assert.equal(modelFailureCount(FAKE_MODEL), 0, 'a shared allowance is not a model fault');
    assert.equal(isModelCooling(FAKE_MODEL), false);
  });

  for (const status of [400, 401, 403]) {
    it(`does not count an HTTP ${status} against the model`, async () => {
      const { error, calls } = await turn(() => {
        throw upstream(status);
      });

      assert.ok(error instanceof AiProviderError);
      assert.equal(calls.length, 1);
      assert.equal(modelFailureCount(FAKE_MODEL), 0);
      assert.equal(isModelCooling(FAKE_MODEL), false);
    });
  }

  it('does not count an UNCLASSIFIED provider error that names no status', async () => {
    const { error, calls } = await turn(() => {
      throw new AiProviderError('The AI service could not be reached.');
    });

    assert.ok(error instanceof AiProviderError);
    assert.equal(calls.length, 1);
    assert.equal(modelFailureCount(FAKE_MODEL), 0);
    assert.equal(isModelCooling(FAKE_MODEL), false);
  });

  it('counts a CLASSIFIED network failure but never fails over for it', async () => {
    const { error, calls, failoverLines } = await turn(() => {
      throw new AiProviderError('The AI service could not be reached.', 'AI_UNAVAILABLE', undefined, 'network');
    });

    assert.ok(error instanceof AiProviderError);
    assert.equal(calls.length, 1, 'another model travels the same broken network');
    assert.equal(failoverLines.length, 0);
    assert.equal(modelFailureCount(FAKE_MODEL), 1);
    assert.equal(isModelCooling(FAKE_MODEL), false, 'one outage is not five');
  });

  it('cools the active model after five consecutive network failures', async () => {
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      const { error, calls, failoverLines } = await turn(() => {
        throw new AiProviderError('The AI service could not be reached.', 'AI_UNAVAILABLE', undefined, 'network');
      });
      assert.ok(error instanceof AiProviderError);
      assert.equal(calls.length, 1);
      assert.equal(failoverLines.length, 0);
    }

    assert.equal(modelFailureCount(FAKE_MODEL), MODEL_FAILURE_THRESHOLD);
    assert.equal(isModelCooling(FAKE_MODEL), true, 'the breaker opens on the fifth');
  });

  it('leaves a healthy deployment exactly as it was', async () => {
    const { result, error, calls, cooldownLines, failoverLines, costLines } = await turn(() =>
      fakeText('the deployment is healthy.'),
    );

    assert.equal(error, null);
    assert.equal(result.content, 'the deployment is healthy.');
    assert.deepEqual(calls, [undefined], 'the configured model is still the first and only call');
    assert.equal(cooldownLines.length, 0);
    assert.equal(failoverLines.length, 0);
    assert.equal(fields(costLines[0]).calls, '1');
    assert.equal(fields(costLines[0]).failovers, '0');
    assert.equal(modelFailureCount(FAKE_MODEL), 0);
  });
});
