// AI-29 — a broken MODEL is not a broken ASSISTANT, and a spent ALLOWANCE is not
// either.
//
// THE INCIDENT. On 2026-10-21 the configured model's only upstream endpoint went
// down (status -5, uptime 0) while the gateway kept listing the id, so every turn
// answered `502 AI_UNAVAILABLE` — *"temporarily unavailable, please try again in a
// moment"* — and stayed that way for hours. A second free model answered the same
// question correctly the whole time. AI-28 made that condition *visible*; this
// suite is about making it *survivable*.
//
// THE DANGER IN THE OBVIOUS FIX. "Retry on another model" is one line and it is
// wrong in two ways that this file exists to prevent:
//
//   * a 429 is the ACCOUNT's daily allowance, shared by every free model, so
//     retrying another model cannot succeed — it can only spend the refusal twice
//     and tell the member the same untruth twice. Quota and configuration failures
//     must never reach the fallback.
//   * a retry that is not bounded turns one bad turn into a ping-pong between two
//     models. So a turn fails over AT MOST ONCE, and once it has, the rest of that
//     turn's calls go to the model that answered — otherwise every tool round of a
//     working turn would re-pay for the broken primary first.
//
// WHAT IS PINNED HERE:
//
//   * a model-specific upstream failure (404/410/5xx as measured) fails over once,
//     and the turn still answers;
//   * the fallback is STICKY for the rest of the turn, so a tool-calling turn
//     continues on the model that worked rather than re-trying the dead one;
//   * quota (429/402), auth (401/403), a bad request (400) and a transport failure
//     never fail over — each is one call, and the original error is what the member
//     sees;
//   * no fallback configured, or a fallback identical to the primary, changes
//     nothing (one call, same error);
//   * a fallback that also fails does not bounce back, and the turn reports that
//     failure rather than a third attempt;
//   * too little of the turn's single deadline left -> no failover, because a
//     second model cannot finish in the time remaining and the attempt would only
//     delay the honest answer;
//   * the turn line counts BOTH calls, and one greppable line names both models and
//     the reason;
//   * `probeModel` can check the fallback too — the only way to know a fallback can
//     do tool calling before the day it is needed.
//
// Nothing here spends provider quota: the provider is the in-process fake and no
// network call is made.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer as startDbServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { startServer } from '../src/config/startup.ts';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import {
  AI_UNAVAILABLE,
  AiProviderError,
  AiQuotaExceeded,
} from '../src/services/ai/aiErrors.ts';
import { probeModel } from '../src/services/ai/modelCheck.ts';
import {
  declaresToolSupport,
  listCatalogue,
  refreshModelCapabilities,
  resetModelCapabilities,
} from '../src/services/ai/modelCapabilities.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';
const FALLBACK_2 = 'fallback-two';
const FALLBACK_3 = 'fallback-three';

/** A provider failure as the wire layer raises it: an HTTP status, no secrets. */
function upstream(status) {
  return new AiProviderError('The AI service returned an error. Please try again.', AI_UNAVAILABLE, status);
}

/**
 * Run one turn with every log line captured, the environment set the way the case
 * needs it, and the fake provider's own call log exposed.
 */
async function turnCapturingLogs(scenario, { fallback = FALLBACK, deadlineMs, env = {} } = {}) {
  const lines = [];
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
    AI_TURN_DEADLINE_MS: process.env.AI_TURN_DEADLINE_MS,
  };
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;
  if (deadlineMs === undefined) delete process.env.AI_TURN_DEADLINE_MS;
  else process.env.AI_TURN_DEADLINE_MS = String(deadlineMs);
  Object.assign(process.env, env);

  let result = null;
  let error = null;
  try {
    setFakeScenario(scenario);
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
    for (const key of Object.keys(env)) {
      if (key.startsWith('AI_') && saved[key] === undefined) delete process.env[key];
    }
  }
  return {
    lines,
    failoverLines: lines.filter((line) => line.includes('[ai] failover')),
    costLines: lines.filter((line) => line.includes('[ai] turn')),
    result,
    error,
  };
}

/** `key=value` pairs of the turn line, as a map. */
function fields(line) {
  const out = {};
  for (const part of line.replace('[ai] turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  delete process.env.AI_TURN_DEADLINE_MS;
  resetModelCapabilities();
  // AI-30 — the breaker is process-wide by design, so a suite that deliberately throws
  // model-specific failures must not leave a model cooling into the next case.
  resetModelBreaker();
  resetModelSelection();
});

// ---------------------------------------------------------------------------
// When it fails over
// ---------------------------------------------------------------------------

unitSuite('AI-29 model failover (DB-free)', () => {
  it('answers from the fallback when the primary model is gone', async () => {
    const seen = [];
    const { result, error, costLines, failoverLines } = await turnCapturingLogs((ctx) => {
      seen.push(ctx.model);
      if (seen.length === 1) throw upstream(404);
      return fakeText('Recovered from the fallback.');
    });

    assert.equal(error, null, 'a broken primary must not fail the turn');
    assert.equal(result.content, 'Recovered from the fallback.');
    // The FIRST call carries NO override: the provider's configured model is the source of
    // truth and an override would be a second place a model is chosen. The RETRY is the one
    // request that names a model explicitly, because it is the one request that must not use
    // the configuration.
    assert.deepEqual(seen, [undefined, FALLBACK], 'the retry must name the FALLBACK model');
    assert.equal(costLines.length, 1);
    assert.equal(fields(costLines[0]).outcome, 'ok');
    assert.equal(fields(costLines[0]).calls, '2', 'both calls are real and both are counted');
    assert.equal(failoverLines.length, 1, 'exactly one greppable failover line');
    assert.match(failoverLines[0], /fallback-model/);
    assert.match(failoverLines[0], /404/, 'the reason is the status that caused it');
  });

  it('stays on the fallback for the rest of the turn, so a tool round is not re-paid', async () => {
    const seen = [];
    const { result, error, failoverLines } = await turnCapturingLogs((ctx) => {
      seen.push(ctx.model);
      if (seen.length === 1) throw upstream(404);
      if (seen.length === 2) {
        return fakeCalls([{ id: 'c1', name: 'getInventorySummary', input: {} }]);
      }
      return fakeText('You hold 49,217 units.');
    });

    assert.equal(error, null);
    assert.equal(result.content, 'You hold 49,217 units.');
    assert.deepEqual(
      seen,
      [undefined, FALLBACK, FALLBACK],
      'after failing over, every remaining call in the turn uses the model that worked',
    );
    assert.equal(failoverLines.length, 1, 'one failover, not one per round');
  });

  // The whole MODEL_FAILOVER_STATUSES set, not just the two codes that happened to be seen
  // in production. 410 is a withdrawn model, 502/504 are gateway/upstream timeouts, and 529
  // is the provider's overloaded signal; all of them mean "this model, not this request".
  for (const status of [410, 500, 502, 503, 504, 529]) {
    it(`fails over on HTTP ${status}, which is a model-availability answer`, async () => {
      const seen = [];
      const { result, failoverLines } = await turnCapturingLogs((ctx) => {
        seen.push(ctx.model);
        if (seen.length === 1) throw upstream(status);
        return fakeText('ok');
      });
      assert.equal(result.content, 'ok');
      assert.deepEqual(seen, [undefined, FALLBACK]);
      assert.equal(failoverLines.length, 1);
      assert.match(failoverLines[0], new RegExp(String(status)));
    });
  }

  // -------------------------------------------------------------------------
  // When it must NOT fail over
  // -------------------------------------------------------------------------

  it('never answers a spent allowance by paying for it on another model', async () => {
    let calls = 0;
    const { error, failoverLines } = await turnCapturingLogs(() => {
      calls += 1;
      throw new AiQuotaExceeded();
    });

    assert.ok(error instanceof AiQuotaExceeded, 'the limit keeps its own class');
    assert.equal(calls, 1, 'the allowance is shared, so a second model cannot help');
    assert.equal(failoverLines.length, 0);
  });

  it('treats 402 as the same refusal, not as a model fault', async () => {
    let calls = 0;
    const { error } = await turnCapturingLogs(() => {
      calls += 1;
      throw new AiQuotaExceeded();
    });
    assert.equal(calls, 1);
    assert.ok(error instanceof AiQuotaExceeded);
  });

  it('does not fail over on an authentication or bad-request answer', async () => {
    for (const status of [400, 401, 403]) {
      let calls = 0;
      const { error, failoverLines } = await turnCapturingLogs(() => {
        calls += 1;
        throw upstream(status);
      });
      assert.equal(calls, 1, `HTTP ${status} is not a model problem`);
      assert.equal(failoverLines.length, 0);
      assert.ok(error instanceof AiProviderError);
    }
  });

  it('does not fail over on a transport failure that names no status', async () => {
    let calls = 0;
    const { error } = await turnCapturingLogs(() => {
      calls += 1;
      throw new AiProviderError('The AI service could not be reached. Please try again.');
    });
    assert.equal(calls, 1, 'another model would go over the same broken network');
    assert.ok(error instanceof AiProviderError);
  });

  it('changes nothing when no fallback is configured', async () => {
    let calls = 0;
    const { error, failoverLines } = await turnCapturingLogs(
      () => {
        calls += 1;
        throw upstream(404);
      },
      { fallback: null },
    );
    assert.equal(calls, 1);
    assert.equal(failoverLines.length, 0);
    assert.ok(error instanceof AiProviderError);
  });

  it('does not pay twice for a fallback that is the primary model', async () => {
    let calls = 0;
    const { error, failoverLines } = await turnCapturingLogs(
      () => {
        calls += 1;
        throw upstream(404);
      },
      { fallback: PRIMARY },
    );
    assert.equal(calls, 1, 'the same broken model is not a fallback');
    assert.equal(failoverLines.length, 0);
    assert.ok(error instanceof AiProviderError);
  });

  it('tries the fallback once, never bouncing back to the primary', async () => {
    const seen = [];
    const { error, failoverLines, costLines } = await turnCapturingLogs((ctx) => {
      seen.push(ctx.model);
      throw upstream(404);
    });

    assert.deepEqual(seen, [undefined, FALLBACK], 'two calls, in that order, and no third');
    assert.equal(failoverLines.length, 1);
    assert.ok(error instanceof AiProviderError);
    assert.equal(fields(costLines[0]).outcome, 'AI_UNAVAILABLE');
    assert.equal(fields(costLines[0]).calls, '2');
  });

  it('does not start a fallback it has no time to finish', async () => {
    let calls = 0;
    const { error, failoverLines } = await turnCapturingLogs(
      () => {
        calls += 1;
        throw upstream(404);
      },
      { deadlineMs: 1500 },
    );
    assert.equal(calls, 1, 'a second model cannot finish inside the remaining budget');
    assert.equal(failoverLines.length, 0);
    assert.ok(error instanceof AiProviderError);
  });

  // -------------------------------------------------------------------------
  // An ordered CHAIN of candidates
  // -------------------------------------------------------------------------

  it('walks the chain in order until a model answers', async () => {
    const seen = [];
    const { result, error, failoverLines, costLines } = await turnCapturingLogs(
      (ctx) => {
        seen.push(ctx.model);
        if (seen.length < 3) throw upstream(404);
        return fakeText('Third model answered.');
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.equal(error, null);
    assert.equal(result.content, 'Third model answered.');
    assert.deepEqual(seen, [undefined, FALLBACK, FALLBACK_2], 'candidates are tried in the configured order');
    assert.equal(failoverLines.length, 2, 'one line per attempt, so the walk is readable afterwards');
    // Each line names the model the attempt came FROM. The second line must name the
    // CANDIDATE that just failed, not the configured primary — otherwise a three-model walk
    // reads as if the same model were tried twice and the line cannot tell an operator
    // which model to remove.
    assert.match(failoverLines[0], new RegExp(`model=.* -> ${FALLBACK} reason=HTTP 404`));
    assert.match(failoverLines[1], new RegExp(`model=${FALLBACK} -> ${FALLBACK_2} reason=HTTP 404`));
    assert.equal(fields(costLines[0]).calls, '3');
    assert.equal(fields(costLines[0]).failovers, '2');
  });

  it('stops the walk immediately when a candidate is refused by the allowance', async () => {
    // The allowance is shared by every free model, so continuing the walk after a 429
    // would spend the same refusal on every remaining candidate and still end in the
    // same error — the definition of an unnecessary retry.
    const seen = [];
    const { error, failoverLines } = await turnCapturingLogs(
      (ctx) => {
        seen.push(ctx.model);
        if (seen.length === 1) throw upstream(404);
        throw new AiQuotaExceeded();
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.ok(error instanceof AiQuotaExceeded, 'the limit the walk ended on is what the member sees');
    assert.deepEqual(seen, [undefined, FALLBACK], 'no request is sent to the rest of the chain');
    assert.equal(failoverLines.length, 1);
  });

  it('reports the last failure when every candidate is unavailable', async () => {
    const seen = [];
    const { error, failoverLines, costLines } = await turnCapturingLogs(
      (ctx) => {
        seen.push(ctx.model);
        throw upstream(404);
      },
      { fallback: `${FALLBACK},${FALLBACK_2},${FALLBACK_3}` },
    );

    assert.ok(error instanceof AiProviderError);
    assert.equal(error.status, 404);
    assert.equal(seen.length, 4, 'the primary and three candidates, each tried exactly once');
    assert.equal(failoverLines.length, 3);
    assert.equal(fields(costLines[0]).outcome, 'AI_UNAVAILABLE');
    assert.equal(fields(costLines[0]).failovers, '3');
  });

  it('skips a candidate the catalogue says cannot call tools', async () => {
    // The capability comes from the provider's own catalogue (`supported_parameters`),
    // which is free to read — so a model that cannot call tools is excluded BEFORE a
    // request is spent on it. A fallback that cannot read inventory is not a fallback:
    // it would answer an inventory question from nothing.
    await refreshModelCapabilities({
      env: {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key-not-real',
        OPENROUTER_BASE_URL: 'https://example.invalid/api',
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: FALLBACK, supported_parameters: ['temperature'] },
              { id: FALLBACK_2, supported_parameters: ['temperature', 'tools'] },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const seen = [];
    const { result, error, lines } = await turnCapturingLogs(
      (ctx) => {
        seen.push(ctx.model);
        if (seen.length === 1) throw upstream(404);
        return fakeText('answered by the tool-capable candidate');
      },
      { fallback: `${FALLBACK},${FALLBACK_2}` },
    );

    assert.equal(error, null);
    assert.equal(result.content, 'answered by the tool-capable candidate');
    assert.deepEqual(seen, [undefined, FALLBACK_2], 'the tool-less candidate is never called');
    assert.ok(
      lines.some((line) => line.includes('fallback skipped') && line.includes(FALLBACK)),
      'and the skip is recorded rather than silent',
    );
  });

  it('never tries the primary or the same candidate twice', async () => {
    const seen = [];
    const { result } = await turnCapturingLogs(
      (ctx) => {
        seen.push(ctx.model);
        if (seen.length === 1) throw upstream(404);
        return fakeText('ok');
      },
      { fallback: `${PRIMARY},${FALLBACK},${FALLBACK}` },
    );
    assert.equal(result.content, 'ok');
    assert.deepEqual(seen, [undefined, FALLBACK], 'a duplicate is one candidate, and the primary is not a fallback');
  });

  it('reads tool support from the catalogue, and treats an unread catalogue as unknown', async () => {
    const env = {
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key-not-real',
      OPENROUTER_BASE_URL: 'https://example.invalid/api',
    };
    const body = {
      data: [
        { id: FALLBACK, supported_parameters: ['temperature'] },
        { id: FALLBACK_2, supported_parameters: ['temperature', 'tools'] },
      ],
    };
    const ok = await refreshModelCapabilities({
      env,
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    });

    assert.equal(ok, 'ok');
    assert.equal(declaresToolSupport(FALLBACK), false);
    assert.equal(declaresToolSupport(FALLBACK_2), true);
    assert.equal(declaresToolSupport('not-in-the-catalogue'), false, 'absent means it would 404');

    resetModelCapabilities();
    assert.equal(declaresToolSupport(FALLBACK), undefined, 'an unread catalogue is not a verdict');
  });

  it('keeps an established map when a later read fails', async () => {
    const env = {
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key-not-real',
      OPENROUTER_BASE_URL: 'https://example.invalid/api',
    };
    await refreshModelCapabilities({
      env,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: FALLBACK_2, supported_parameters: ['tools'] }] }), {
          status: 200,
        }),
    });
    const failed = await refreshModelCapabilities({
      env,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(failed, 'unreachable');
    assert.equal(declaresToolSupport(FALLBACK_2), true, 'a network fault must not re-enable a tool-less model');
  });

  it('lists the catalogue as plain entries, which is what the operator tooling shows', async () => {
    const entries = await listCatalogue({
      env: {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key-not-real',
        OPENROUTER_BASE_URL: 'https://example.invalid/api',
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'free-with-tools:free',
                supported_parameters: ['tools'],
                context_length: 1000000,
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'paid-no-tools',
                supported_parameters: ['temperature'],
                context_length: 8192,
                pricing: { prompt: '0.000003', completion: '0.000015' },
              },
              { nonsense: true },
            ],
          }),
          { status: 200 },
        ),
    });

    assert.deepEqual(entries, [
      { id: 'free-with-tools:free', tools: true, contextLength: 1000000, free: true },
      { id: 'paid-no-tools', tools: false, contextLength: 8192, free: false },
    ]);
  });

  it('returns null from the catalogue listing when it could not be read or there is no AI', async () => {
    const env = {
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key-not-real',
      OPENROUTER_BASE_URL: 'https://example.invalid/api',
    };
    assert.equal(
      await listCatalogue({
        env,
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
      null,
    );
    assert.equal(await listCatalogue({ env: {}, fetchImpl: async () => new Response('{}') }), null);
  });

  it('reports not_applicable when this deployment has no AI to ask', async () => {
    assert.equal(await refreshModelCapabilities({ env: {}, fetchImpl: async () => new Response('{}') }), 'not_applicable');
  });

  it('parses the candidate list once, trimmed and deduplicated', () => {
    const saved = process.env.AI_FALLBACK_MODELS_OPENROUTER;
    process.env.AI_FALLBACK_MODELS_OPENROUTER = ' a ,, a , b ,c';
    try {
      assert.deepEqual(aiConfig().fallbackModels, ['a', 'b', 'c']);
    } finally {
      if (saved === undefined) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
      else process.env.AI_FALLBACK_MODELS_OPENROUTER = saved;
    }
  });

  // -------------------------------------------------------------------------
  // Knowing whether the fallback is worth having
  // -------------------------------------------------------------------------

  it('can probe the FALLBACK model with a tool-shaped request', async () => {
    // A fallback that cannot do tool calling is worse than none: it answers
    // without touching the inventory and cannot ground a number. The probe is the
    // only cheap way to know before the day it is needed.
    let body = null;
    const result = await probeModel({
      model: FALLBACK,
      env: {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key-not-real',
        OPENROUTER_BASE_URL: 'https://example.invalid/api',
        AI_MODEL_OPENROUTER: PRIMARY,
      },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(result.status, 'usable');
    assert.equal(result.model, FALLBACK);
    assert.equal(body.model, FALLBACK, 'the probe must send the model it claims to check');
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'and it must offer a tool');
  });

  it('refuses to report a quota refusal as an unusable fallback', async () => {
    const result = await probeModel({
      model: FALLBACK,
      env: {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key-not-real',
        OPENROUTER_BASE_URL: 'https://example.invalid/api',
        AI_MODEL_OPENROUTER: PRIMARY,
      },
      fetchImpl: async () => new Response('{}', { status: 429 }),
    });
    assert.equal(result.status, 'quota');
    assert.notEqual(result.status, 'unusable');
  });
});

// ---------------------------------------------------------------------------
// A configured candidate that cannot call tools is said out loud, once, at boot.
// ---------------------------------------------------------------------------

unitSuite('AI-29 the boot capability warning', () => {
  /** A minimal app so `listen` is real but nothing else is. */
  const app = () => ({
    listen: (port, cb) => {
      const server = {
        listening: true,
        on: () => server,
        once: (event, handler) => {
          if (event === 'listening') setImmediate(handler);
          return server;
        },
        address: () => ({ port: 0 }),
        close: () => {},
      };
      setImmediate(cb);
      return server;
    },
  });

  it('★ warns, naming the candidate, and stays silent about the tool-capable one', async () => {
    const lines = [];
    const saved = {
      AI_MODEL_OPENROUTER: process.env.AI_MODEL_OPENROUTER,
      AI_FALLBACK_MODELS_OPENROUTER: process.env.AI_FALLBACK_MODELS_OPENROUTER,
    };
    process.env.AI_MODEL_OPENROUTER = PRIMARY;
    process.env.AI_FALLBACK_MODELS_OPENROUTER = `${FALLBACK},${FALLBACK_2}`;

    try {
      await startServer({
        nodeEnv: 'development',
        appInstance: app(),
        port: 0,
        connectFn: async () => true,
        validator: () => [],
        readiness: () => ({ db: 'ok', mail: 'ok', firebase: 'ok', ai: 'ok' }),
        modelCheck: null,
        capabilities: () =>
          refreshModelCapabilities({
            env: {
              AI_PROVIDER: 'openrouter',
              OPENROUTER_API_KEY: 'test-key-not-real',
              OPENROUTER_BASE_URL: 'https://example.invalid/api',
            },
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  data: [
                    { id: FALLBACK, supported_parameters: [] },
                    { id: FALLBACK_2, supported_parameters: ['tools'] },
                  ],
                }),
                { status: 200 },
              ),
          }),
        logger: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const warnings = lines.filter((line) => line.includes('no tool support'));
      assert.equal(warnings.length, 1, `expected exactly one warning, got:\n${lines.join('\n')}`);
      assert.ok(warnings[0].includes(FALLBACK), 'the candidate that will be skipped is named');
      assert.ok(!warnings[0].includes(FALLBACK_2), 'a usable candidate is not named');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('says nothing when the catalogue could not be read', async () => {
    const lines = [];
    await startServer({
      nodeEnv: 'development',
      appInstance: app(),
      port: 0,
      connectFn: async () => true,
      validator: () => [],
      readiness: () => ({ db: 'ok', mail: 'ok', firebase: 'ok', ai: 'ok' }),
      modelCheck: null,
      capabilities: async () => 'unreachable',
      logger: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lines.filter((line) => line.includes('no tool support')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// The wire contract: a turn that fails over is an ordinary 201 to the client.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startDbServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

dbSuite('AI-29 failover over the real route', dbOk, () => {
  it('answers 201 with the fallback\'s answer when the primary model is down', async () => {
    const owner = await registerOwner(api, tracker);
    process.env.AI_FALLBACK_MODELS_OPENROUTER = FALLBACK;
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      if (calls === 1) throw upstream(404);
      return fakeText('You are welcome.');
    });

    try {
      const res = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'say hello in one sentence' },
      });
      assert.equal(res.status, 201, 'the member sees an ordinary answer, not an outage');
      assert.equal(res.json.assistantMessage.content, 'You are welcome.');
      assert.equal(calls, 2);
    } finally {
      delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
    }
  });

  it('still answers 429 AI_QUOTA_EXCEEDED, with no fallback attempt', async () => {
    const owner = await registerOwner(api, tracker);
    process.env.AI_FALLBACK_MODELS_OPENROUTER = FALLBACK;
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      throw new AiQuotaExceeded();
    });

    try {
      const res = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'say hello in one sentence' },
      });
      assert.equal(res.status, 429);
      assert.equal(res.json.code, 'AI_QUOTA_EXCEEDED');
      assert.equal(calls, 1, 'a spent allowance is not answered by spending more');
    } finally {
      delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
    }
  });
});

// Closed last: after() runs even when the DB half was skipped, and a stale server
// would collide with the next file's port guard.
import { after } from 'node:test';
after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});
