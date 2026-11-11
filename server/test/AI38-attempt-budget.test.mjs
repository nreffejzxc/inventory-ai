/**
 * AI-38 — a hanging model must not consume the whole turn and leave no time for the fallback.
 *
 * WHY THIS EXISTS. AI-29 fails a turn over only when the FIRST model refuses (404/5xx) and at
 * least 5 s of the turn deadline remain. A model that does not refuse but never answers — a stalled
 * upstream, the failure AI-31 counts as a transport timeout — gets the whole remaining budget,
 * which at the default 60-second deadline is the entire turn. The failover then cannot start, and
 * the member waits the full minute for a failure another model could have answered.
 *
 * WHAT IT IS. An OPTIONAL slice per attempt (`AI_ATTEMPT_MAX_MS`, **0 = off by default**), applied
 * only while another candidate remains and only as a MODEL-level deadline. The last attempt always
 * keeps everything left, so a slow but working answer is never cut short when there is nowhere else
 * to go. A capped attempt that expires is failover-eligible — unlike a network failure, which still
 * ends the turn because another model would travel the same broken path.
 *
 * WHY IT IS OFF BY DEFAULT. The measured range on this tier is 5.3–19.4 s (§27DZ/§27EA), so a 25 s
 * slice would be safe on that evidence — but the change is only enabled after re-measuring on the
 * device, exactly so a legitimately slow answer is not stopped by a number chosen in advance.
 *
 * WHAT IS PINNED HERE:
 *
 *   * the default changes nothing (a 300 ms answer with candidates configured is not failed over);
 *   * a capped attempt that hangs fails over to a working candidate and answers;
 *   * the final attempt is never capped, so a slow sole model still answers;
 *   * a NETWORK failure still ends the turn with no failover, cap or no cap;
 *   * the turn line counts both calls, and the failover line gives a reason when there is no status.
 *
 * No network: the provider is the in-process fake, and its "hang" is a promise that never settles.
 */

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { AiProviderError } from '../src/services/ai/aiErrors.ts';
import { modelFailureCount, resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelHealthGate } from '../src/services/ai/modelHealthGate.ts';
import { resetQuotaState } from '../src/services/ai/quota.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';

const ENV_KEYS = [
  'AI_MODEL_OPENROUTER',
  'AI_FALLBACK_MODELS_OPENROUTER',
  'AI_ATTEMPT_MAX_MS',
  'AI_TURN_DEADLINE_MS',
];

function setEnv({ fallback = FALLBACK, attemptMaxMs, deadlineMs = 20000 } = {}) {
  // 20 s, not 5 s: AI-29 refuses to START a failover with under 5 s left, so a 5 s turn could
  // never exercise the cap — the test would be measuring the wrong rule.
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;
  if (attemptMaxMs === undefined) delete process.env.AI_ATTEMPT_MAX_MS;
  else process.env.AI_ATTEMPT_MAX_MS = String(attemptMaxMs);
  process.env.AI_TURN_DEADLINE_MS = String(deadlineMs);
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

function turnArgs() {
  return {
    businessId: 'b-dummy',
    userId: 'u-dummy',
    role: ROLES.OWNER,
    message: 'say hello in one sentence',
  };
}

async function turn(scenario, options = {}) {
  const restore = setEnv(options);
  const calls = [];
  const startedAt = Date.now();
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
      elapsedMs: Date.now() - startedAt,
      failoverLines: lines.filter((line) => line.includes('AI failover')),
      costLines: lines.filter((line) => line.includes('AI turn outcome=')),
    };
  } finally {
    setFakeScenario(null);
    restore();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fields(line) {
  const out = {};
  for (const part of line.replace('AI turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

afterEach(() => {
  setFakeScenario(null);
  for (const key of ENV_KEYS) delete process.env[key];
  resetModelBreaker();
  resetModelSelection();
  resetModelHealthGate();
  resetQuotaState();
});

unitSuite('AI-38 per-attempt time budget', () => {
  it('is OFF by default, so a slow answer with a fallback configured is not failed over', async () => {
    assert.equal(aiConfig().attemptMaxMs, 0);

    const { result, calls, elapsedMs } = await turn(async () => {
      await sleep(300);
      return fakeText('the slow primary answered');
    });

    assert.equal(result.content, 'the slow primary answered');
    assert.deepEqual(calls, [undefined], 'a 300 ms answer is not a failure');
    assert.ok(elapsedMs >= 280);
  });

  it('fails over when an attempt misses its slice, and answers from the fallback', async () => {
    const { result, calls, failoverLines, costLines, elapsedMs } = await turn(
      (ctx) => {
        if (ctx.model === undefined) return new Promise(() => {}); // never settles
        return fakeText('served by the fallback');
      },
      { attemptMaxMs: 150 },
    );

    assert.equal(result.content, 'served by the fallback');
    assert.deepEqual(calls, [undefined, FALLBACK]);
    assert.ok(elapsedMs < 3000, `the turn did not wait out its 5 s deadline (took ${elapsedMs} ms)`);
    assert.equal(fields(costLines[0]).calls, '2');
    assert.equal(fields(costLines[0]).failovers, '1');
    assert.ok(
      failoverLines.some((line) => line.includes('attempt timeout')),
      'a failover with no HTTP status still states a reason',
    );
  });

  it('never caps the LAST attempt, so a slow sole model still answers', async () => {
    const { result, calls } = await turn(
      async () => {
        await sleep(300);
        return fakeText('slow but working');
      },
      { attemptMaxMs: 100, fallback: null },
    );

    assert.equal(result.content, 'slow but working');
    assert.deepEqual(calls, [undefined], 'there was nowhere else to go, so the answer was awaited');
  });

  it('still refuses to fail over on a NETWORK failure, cap or no cap', async () => {
    const { error, calls } = await turn(
      (ctx) => {
        if (ctx.model === undefined) {
          throw new AiProviderError('The AI service could not be reached.', 'AI_UNAVAILABLE', undefined, 'network');
        }
        return fakeText('must not be reached');
      },
      { attemptMaxMs: 150 },
    );

    assert.deepEqual(calls, [undefined], 'another model would travel the same broken network');
    assert.equal(error?.code, 'AI_UNAVAILABLE');
  });

  it('counts a timed-out attempt against the model, so repeated hangs cool it down', async () => {
    const { calls } = await turn(
      (ctx) => (ctx.model === undefined ? new Promise(() => {}) : fakeText('fallback')),
      { attemptMaxMs: 120 },
    );

    assert.deepEqual(calls, [undefined, FALLBACK]);
    // One timeout is one failure: not enough to open the breaker, but it must be RECORDED —
    // otherwise a model that only ever hangs could never be cooled down at all.
    assert.equal(modelFailureCount('fake-model'), 1);
    assert.equal(aiConfig().attemptMaxMs, 0, 'the environment was restored');
  });
});
