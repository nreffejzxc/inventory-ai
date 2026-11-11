// AI-31 — a working fallback does not just rescue one turn; it becomes the model the
// deployment uses next, without anyone editing `.env`.
//
// THE SHAPE OF THE FEATURE. The configured default stays the operator's choice. A runtime
// promotion records which model has PROVED it can answer while the configured one is
// unhealthy, and new turns start there. It is threshold-gated on purpose: a single failed
// request must not churn the active model (AI-29 already lets a fallback serve that turn),
// so promotion happens when the active has been confirmed unhealthy — it is cooling down
// after five consecutive model-specific failures.
//
// WHAT IS PINNED HERE:
//
//   * a healthy active model stays active after many turns;
//   * 1–4 consecutive failures do NOT promote (the fallback still serves the turn);
//   * the fifth failure promotes the fallback that answered, and the next turn starts there;
//   * a promoted model that later fails five times is replaced by the next working model;
//   * a failed model becomes eligible again after its cooldown and rejoins the rotation;
//   * all models unavailable -> the existing 502 sentence, no provider call when all are cooling;
//   * quota (429/402) and auth (401/403) failures never promote and never count;
//   * a failover after a tool step does not execute that tool twice;
//   * concurrent requests keep one promotion and do not reset one another's counters;
//   * the configured order is the rotation order, and threshold/cooldown come from `.env`.
//
// Nothing here spends real provider quota: the provider is the in-process fake.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { AiNotConfigured, AiProviderError, AiQuotaExceeded } from '../src/services/ai/aiErrors.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import {
  isModelCooling,
  modelCooldownRemainingMs,
  modelFailureCount,
  recordModelFailure,
  resetModelBreaker,
} from '../src/services/ai/modelBreaker.ts';
import {
  activeModel,
  promoteModel,
  promotedModel,
  resetModelSelection,
} from '../src/services/ai/modelSelection.ts';
import { resetModelCapabilities } from '../src/services/ai/modelCapabilities.ts';
import { registerFakeProvider, setFakeScenario, fakeCalls, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';
const FALLBACK_2 = 'fallback-two';
const FALLBACK_3 = 'fallback-three';
/** The id the fake provider reports as its configured model: the default active model. */
const FAKE_MODEL = 'fake-model';

const ENV_KEYS = [
  'AI_MODEL_OPENROUTER',
  'AI_FALLBACK_MODELS_OPENROUTER',
  'AI_MODEL_FAILURE_THRESHOLD',
  'AI_MODEL_COOLDOWN_MS',
];

function upstream(status) {
  return new AiProviderError('The AI service returned an error. Please try again.', 'AI_UNAVAILABLE', status);
}

function setEnv({ fallback = FALLBACK, threshold, cooldownMs } = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;
  if (threshold === undefined) delete process.env.AI_MODEL_FAILURE_THRESHOLD;
  else process.env.AI_MODEL_FAILURE_THRESHOLD = String(threshold);
  if (cooldownMs === undefined) delete process.env.AI_MODEL_COOLDOWN_MS;
  else process.env.AI_MODEL_COOLDOWN_MS = String(cooldownMs);
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

/** One turn, with the provider's own call log exposed (`undefined` = no override). */
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
      failoverLines: lines.filter((line) => line.includes('AI failover')),
      promotionLines: lines.filter((line) => line.includes('AI promoted model')),
      costLines: lines.filter((line) => line.includes('AI turn')),
    };
  } finally {
    setFakeScenario(null);
    restore();
  }
}

/** Several turns in flight at once, sharing one environment and one log capture. */
async function turnsConcurrently(count, scenario, options = {}) {
  const restore = setEnv(options);
  const calls = [];
  try {
    const { value, lines } = await withCapturedLogs(async () => {
      setFakeScenario((ctx) => {
        calls.push(ctx.model);
        return scenario(ctx);
      });
      return Promise.all(
        Array.from({ length: count }, (_, i) =>
          runAiChat({ ...turnArgs(), message: `concurrent question ${i}` })
            .then((result) => ({ result, error: null }))
            .catch((error) => ({ result: null, error })),
        ),
      );
    });
    return { turns: value, lines, calls };
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

function fields(line) {
  const out = {};
  for (const part of line.replace('AI turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

function prime(model, times = 5, options) {
  for (let i = 0; i < times; i += 1) recordModelFailure(model, Date.now(), options);
}

/** Every turn until the active model is confirmed unhealthy and a fallback takes over. */
async function driveToPromotion() {
  let last = null;
  for (let i = 1; i <= 5; i += 1) {
    last = await turn((ctx) => {
      if (ctx.model === undefined) throw upstream(404);
      return fakeText('served by the fallback');
    });
  }
  return last;
}

afterEach(() => {
  setFakeScenario(null);
  for (const key of ENV_KEYS) delete process.env[key];
  resetModelCapabilities();
  resetModelBreaker();
  resetModelSelection();
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

unitSuite('AI-31 automatic promotion', () => {
  it('keeps a healthy active model active', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { result, error, calls, promotionLines } = await turn(() => fakeText('the deployment is healthy.'));
      assert.equal(error, null);
      assert.equal(result.content, 'the deployment is healthy.');
      assert.deepEqual(calls, [undefined], 'the configured model is still the first call');
      assert.equal(promotionLines.length, 0);
    }
    assert.equal(promotedModel(), null);
    assert.equal(activeModel(FAKE_MODEL), FAKE_MODEL);
  });

  it('does not promote on one to four consecutive failures', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const { error, calls, promotionLines, costLines } = await turn((ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('served by the fallback');
      });
      assert.equal(error, null);
      assert.deepEqual(calls, [undefined, FALLBACK], 'the fallback serves the turn, nothing more');
      assert.equal(promotionLines.length, 0, `failure ${i} must not churn the active model`);
      assert.equal(fields(costLines[0]).failovers, '1');
      assert.equal(modelFailureCount(FAKE_MODEL), i);
    }
    assert.equal(promotedModel(), null);
    assert.equal(activeModel(FAKE_MODEL), FAKE_MODEL);
    assert.equal(isModelCooling(FAKE_MODEL), false);
  });

  it('promotes the fallback on the fifth failure', async () => {
    const fifth = await driveToPromotion();

    assert.equal(fifth.error, null);
    assert.deepEqual(fifth.calls, [undefined, FALLBACK]);
    assert.equal(promotedModel(), FALLBACK);
    assert.equal(activeModel(FAKE_MODEL), FALLBACK, 'the promoted model is what new turns use');
    assert.equal(isModelCooling(FAKE_MODEL), true);
    assert.match(fifth.promotionLines.join('\n'), /AI promoted model: fake-model -> fallback-model/);
  });

  it('starts the next request on the promoted model', async () => {
    await driveToPromotion();

    const next = await turn(() => fakeText('still answering'));
    assert.equal(next.error, null);
    assert.deepEqual(next.calls, [FALLBACK], 'the unhealthy configured model is not tried first');
    assert.equal(next.failoverLines.length, 0);
    assert.equal(fields(next.costLines[0]).calls, '1');
    assert.equal(fields(next.costLines[0]).failovers, '0');
  });

  it('promotes the first model that serves after a run of network failures', async () => {
    // A network failure is counted but never fails over in the same turn: another model
    // would travel the same broken path. Five in a row still cool the active model, so
    // the next turn starts on the fallback (AI-31).
    for (let i = 0; i < 5; i += 1) {
      const { error, calls, failoverLines } = await turn(() => {
        throw new AiProviderError(
          'The AI service could not be reached.',
          'AI_UNAVAILABLE',
          undefined,
          'network',
        );
      });
      assert.ok(error instanceof AiProviderError);
      assert.deepEqual(calls, [undefined], 'one call per turn while the network is down');
      assert.equal(failoverLines.length, 0);
    }

    assert.equal(isModelCooling(FAKE_MODEL), true);
    assert.equal(promotedModel(), null, 'nothing answered yet, so nothing is promoted');

    const recovered = await turn(() => fakeText('served by the fallback'));
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.calls, [FALLBACK], 'the cooling active model is not tried again yet');
    assert.equal(promotedModel(), FALLBACK);
    assert.match(recovered.promotionLines.join('\n'), /promoted model: fake-model -> fallback-model/);
  });

  it('replaces a promoted model that later fails five times', async () => {
    // An earlier promotion is the state this case starts from.
    assert.equal(promoteModel(FALLBACK, FAKE_MODEL), true);

    let last = null;
    for (let i = 1; i <= 5; i += 1) {
      last = await turn(
        (ctx) => {
          // Only the second fallback is healthy: the promoted model and the configured
          // default both fail, so the replacement has to walk past both of them.
          if (ctx.model === FALLBACK_2) return fakeText('served by the second fallback');
          throw upstream(503);
        },
        { fallback: `${FALLBACK},${FALLBACK_2}` },
      );
      assert.equal(last.error, null);
    }

    assert.equal(promotedModel(), FALLBACK_2);
    assert.equal(isModelCooling(FALLBACK), true);
    assert.match(last.promotionLines.join('\n'), new RegExp(`promoted model: ${FALLBACK} -> ${FALLBACK_2}`));

    const next = await turn(() => fakeText('third model active'), { fallback: `${FALLBACK},${FALLBACK_2}` });
    assert.deepEqual(next.calls, [FALLBACK_2]);
  });

  it('lets a cooled model rejoin the rotation once its cooldown has passed', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) recordModelFailure(FALLBACK, t0);
    assert.equal(isModelCooling(FALLBACK, t0 + 29_999), true);
    assert.equal(isModelCooling(FALLBACK, t0 + 30_000), false, 'eligibility returns by itself');
    assert.equal(modelFailureCount(FALLBACK), 5, 'the streak is kept, so one failure re-opens it');
    assert.equal(modelCooldownRemainingMs(FALLBACK, t0 + 30_000), 0);
  });

  it('uses the configured order as the rotation', async () => {
    const { error, calls } = await turn(
      (ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('second fallback answered');
      },
      { fallback: `${FALLBACK_2},${FALLBACK}` },
    );

    assert.equal(error, null);
    assert.deepEqual(calls, [undefined, FALLBACK_2], 'the environment order decides who is tried first');
  });

  it('honours a configured threshold and cooldown', async () => {
    const first = await turn(
      (ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('served');
      },
      { threshold: 2, cooldownMs: 1234 },
    );
    assert.equal(first.error, null);
    assert.equal(promotedModel(), null, 'one failure is not enough when the threshold is 2');

    const second = await turn(
      (ctx) => {
        if (ctx.model === undefined) throw upstream(404);
        return fakeText('served again');
      },
      { threshold: 2, cooldownMs: 1234 },
    );
    assert.equal(second.error, null);
    assert.equal(promotedModel(), FALLBACK);
    assert.ok(modelCooldownRemainingMs(FAKE_MODEL) <= 1234, 'the configured cooldown is the one applied');

    const restore = setEnv({ threshold: 7, cooldownMs: 4321 });
    try {
      const cfg = aiConfig();
      assert.equal(cfg.modelFailureThreshold, 7, 'the threshold is read from the environment');
      assert.equal(cfg.modelCooldownMs, 4321, 'the cooldown is read from the environment');
    } finally {
      restore();
    }
  });

  it('fails fast with the existing sentence when every model is cooling', async () => {
    prime(FAKE_MODEL);
    prime(FALLBACK);

    const { error, calls } = await turn(() => fakeText('never reached'));

    assert.ok(error instanceof AiProviderError);
    assert.equal(error.code, 'AI_UNAVAILABLE');
    assert.equal(calls.length, 0);
    assert.equal(promotedModel(), null);
  });
});

// ---------------------------------------------------------------------------
// Safety: quota, auth, tools, concurrency
// ---------------------------------------------------------------------------

unitSuite('AI-31 promotion safety', () => {
  it('never promotes on a quota refusal, and never fails over', async () => {
    const { error, calls, failoverLines, promotionLines } = await turn(() => {
      throw new AiQuotaExceeded();
    });

    assert.ok(error instanceof AiQuotaExceeded);
    assert.equal(calls.length, 1);
    assert.equal(failoverLines.length, 0);
    assert.equal(promotionLines.length, 0);
    assert.equal(promotedModel(), null);
    assert.equal(modelFailureCount(FAKE_MODEL), 0);
  });

  for (const status of [400, 401, 403]) {
    it(`never promotes or counts an HTTP ${status}`, async () => {
      const { error, calls, promotionLines } = await turn(() => {
        throw upstream(status);
      });

      assert.ok(error instanceof AiProviderError);
      assert.equal(calls.length, 1);
      assert.equal(promotionLines.length, 0);
      assert.equal(promotedModel(), null);
      assert.equal(modelFailureCount(FAKE_MODEL), 0);
    });
  }

  it('does not count a configuration error as a model failure', async () => {
    const saved = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'no-such-provider';
    try {
      await assert.rejects(runAiChat(turnArgs()), (err) => err instanceof AiNotConfigured);
    } finally {
      process.env.AI_PROVIDER = saved;
    }

    assert.equal(promotedModel(), null);
    assert.equal(modelFailureCount(FAKE_MODEL), 0);
    assert.equal(isModelCooling(FAKE_MODEL), false);
  });

  it('does not execute a tool a second time when the model fails after it', async () => {
    let providerCall = 0;
    let toolMessagesSeenByFallback = 0;

    const { result, error, calls, costLines } = await turn((ctx) => {
      providerCall += 1;
      if (providerCall === 1) {
        return fakeCalls([{ id: 'tool-call-1', name: 'noSuchTool', input: {} }]);
      }
      if (providerCall === 2) {
        throw upstream(500);
      }
      toolMessagesSeenByFallback = ctx.messages.filter((m) => m.role === 'tool').length;
      return fakeText('The tool ran once; the fallback read its result.');
    });

    assert.equal(error, null);
    assert.equal(result.content, 'The tool ran once; the fallback read its result.');
    assert.equal(calls.length, 3, 'primary tool round, primary failure, fallback answer');
    assert.equal(fields(costLines[0]).toolRuns, '1', 'the tool was executed exactly once');
    assert.equal(toolMessagesSeenByFallback, 1, 'the fallback received the existing result, not a re-run');
  });

  it('keeps counters correct across concurrent requests', async () => {
    const { turns } = await turnsConcurrently(2, (ctx) => {
      if (ctx.model === undefined) throw upstream(404);
      return fakeText('served concurrently');
    });

    assert.equal(turns.length, 2);
    for (const entry of turns) {
      assert.equal(entry.error, null);
      assert.equal(entry.result.content, 'served concurrently');
    }
    assert.equal(modelFailureCount(FAKE_MODEL), 2, 'parallel failures are both recorded');
    assert.equal(isModelCooling(FAKE_MODEL), false);
    assert.equal(promotedModel(), null, 'two failures are below the threshold');
  });

  it('promotes once when concurrent requests reach the threshold together', async () => {
    prime(FAKE_MODEL);

    const { turns, lines } = await turnsConcurrently(2, (ctx) => {
      if (ctx.model === undefined) throw new Error('the cooling primary must not be called');
      return fakeText('served concurrently');
    });

    for (const entry of turns) assert.equal(entry.error, null);
    assert.equal(promotedModel(), FALLBACK);
    assert.equal(
      lines.filter((line) => line.includes('AI promoted model')).length,
      1,
      'two requests may not overwrite one another or log the same promotion twice',
    );
  });

  it('refuses a stale promotion instead of letting it overwrite a newer one', () => {
    assert.equal(promoteModel(FALLBACK, FAKE_MODEL), true);
    assert.equal(promoteModel(FALLBACK_2, FAKE_MODEL), false, 'a stale caller must not win');
    assert.equal(promotedModel(), FALLBACK);
    assert.equal(promoteModel(FALLBACK_2, FALLBACK), true, 'a caller that knows the new active may promote');
    assert.equal(promotedModel(), FALLBACK_2);
    assert.equal(promoteModel(FALLBACK_3, FALLBACK), false, 'and a second stale caller still loses');
  });
});
