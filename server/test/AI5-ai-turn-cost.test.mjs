// AI-5 — a turn reports its own cost, so "why did that answer take 60 seconds" is
// answerable from the log instead of from a one-off probe.
//
// THE GAP. AI-1 bounded a turn and AI-2 made a DEGRADED turn visible, but a turn
// that SUCCEEDED recorded nothing about itself: the service could emit exactly two
// things, a provider failure and the degraded warning. So the one question the
// owner's open provider decision depends on — how much of a slow answer is the
// model, how much is the tools, and how many model round-trips it took — could not
// be answered from a running server at all. It had to be re-measured with a script
// against a seeded tenant, which spends provider quota and only ever describes a
// controlled run.
//
// That matters because the evidence already collected says the model, not the
// database, is what a member waits for: the tools are 0.07-0.3 s of a turn
// (measured at 10 000 products) while turns take 10-60 s. What was missing was the
// split WITHIN those 10-60 s, per turn, from the real thing rather than a probe.
//
// WHAT THIS PINS. One line per turn, on EVERY exit path:
//
//   [ai] turn outcome=ok total=15211ms providerMs=14800ms calls=2 toolMs=180ms
//        toolRuns=1 tools=getInventorySummary empty=0 in=3399 out=427
//        cost=$0.007192 web=none model=... iterations=2
//
// `grep -c '[ai] turn'` is then the turn count, and `outcome=` splits the healthy
// turns from the four ways one can end badly (AI_TIMEOUT, AI_ABANDONED,
// AI_UNAVAILABLE, AI_NOT_CONFIGURED) plus `degraded` and `ERROR`. The value is not
// the line: it is that the next latency question is answered by asking the
// assistant one real question from the phone, costing nothing extra.
//
// WHAT IT DELIBERATELY DOES NOT DO — change any behaviour. No new timing knob, no
// change to the deadline, the retry budget, the prompt, the tools or the schema. A
// turn that took 60 s before takes the same 60 s now; it is merely legible. That is
// why this suite asserts the NUMBERS rather than only their presence: a line that
// printed zeroes would satisfy a shape check and diagnose nothing, so the provider
// timing is checked against a deliberate delay.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_EMPTY_RETRY_MAX;
  delete process.env.AI_TURN_DEADLINE_MS;
});

/** Run one turn with console output captured — the real line, not a copy of it. */
async function turnCapturingLogs(scenario, over = {}) {
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  console.warn = (...args) => {
    lines.push(args.join(' '));
  };
  let result = null;
  let error = null;
  try {
    setFakeScenario(scenario);
    result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'say hello in one sentence',
      ...over,
    });
  } catch (err) {
    error = err;
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return { lines, costLines: lines.filter((line) => line.includes('[ai] turn')), result, error };
}

/** `key=value` pairs of the cost line, as a map. */
function fields(line) {
  const out = {};
  for (const part of line.replace('[ai] turn', '').trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

const ms = (value) => Number(String(value).replace('ms', ''));

unitSuite('AI-5 turn cost (DB-free)', () => {
  it('reports exactly one cost line for a healthy answer', async () => {
    const { costLines } = await turnCapturingLogs(() => fakeText('Everything is fine.'));

    assert.equal(costLines.length, 1, 'one line per turn is what makes grep -c the turn count');
    assert.ok(!costLines[0].includes('\n'), 'and it must stay a single line');
    const f = fields(costLines[0]);
    assert.equal(f.outcome, 'ok');
    assert.equal(f.calls, '1', 'a healthy answer is one model call');
    assert.equal(f.toolRuns, '0');
    assert.equal(f.tools, 'none');
    assert.equal(f.iterations, '1');
    assert.equal(f.model, 'fake-model');
    assert.match(f.total, /^\d+ms$/, 'times carry their unit so the line reads without a legend');
    assert.ok(ms(f.total) >= 0);
  });

  it('counts a tool round and names the tool it ran', async () => {
    // `noSuchTool` keeps this DB-free: the tool is refused, but the loop still ran
    // one, which is exactly what the count is for.
    let call = 0;
    const { costLines } = await turnCapturingLogs(() => {
      call += 1;
      return call === 1 ? fakeCalls([{ id: 'call-1', name: 'noSuchTool', input: {} }]) : fakeText('done');
    });

    const f = fields(costLines[0]);
    assert.equal(f.calls, '2', 'tool round + final answer is two model calls');
    assert.equal(f.toolRuns, '1');
    assert.equal(f.tools, 'noSuchTool');
    assert.equal(f.iterations, '2');
  });

  it('★ sums every call’s tokens instead of reporting only the last call', async () => {
    // A tool turn makes at least two provider calls, and both are billed. The line used
    // to carry only the final response's usage, so the prompt tokens of the first call
    // disappeared — exactly the calls a research turn spends the most on.
    let call = 0;
    const { costLines } = await turnCapturingLogs(() => {
      call += 1;
      return call === 1
        ? {
            model: 'fake-model',
            text: '',
            toolCalls: [{ id: 'call-1', name: 'noSuchTool', input: {} }],
            usage: { inputTokens: 10, outputTokens: 2 },
          }
        : {
            model: 'fake-model',
            text: 'done',
            toolCalls: [],
            usage: { inputTokens: 20, outputTokens: 3 },
          };
    });

    const f = fields(costLines[0]);
    assert.equal(f.in, '30', 'both calls’ prompt tokens are on the turn line');
    assert.equal(f.out, '5', 'and both calls’ completion tokens');
  });

  it('★ sums every call’s provider charge instead of reporting only the last one', async () => {
    let call = 0;
    const { costLines } = await turnCapturingLogs(() => {
      call += 1;
      return call === 1
        ? {
            model: 'fake-model',
            text: '',
            toolCalls: [{ id: 'call-1', name: 'noSuchTool', input: {} }],
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.002 },
          }
        : {
            model: 'fake-model',
            text: 'done',
            toolCalls: [],
            usage: { inputTokens: 20, outputTokens: 3, costUsd: 0.005 },
          };
    });

    assert.equal(fields(costLines[0]).cost, '$0.007000');
  });

  it('★ an unreported charge is unknown, never a free turn', async () => {
    const { costLines } = await turnCapturingLogs(() => fakeText('done'));

    assert.equal(fields(costLines[0]).cost, 'unknown');
  });

  it('★ a partial charge total says it is a lower bound', async () => {
    let call = 0;
    const { costLines } = await turnCapturingLogs(() => {
      call += 1;
      return call === 1
        ? {
            model: 'fake-model',
            text: '',
            toolCalls: [{ id: 'call-1', name: 'noSuchTool', input: {} }],
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.002 },
          }
        : fakeText('done');
    });

    assert.equal(fields(costLines[0]).cost, '>=$0.002000');
  });

  it('measures provider time rather than printing zeroes', async () => {
    // THE ASSERTION THAT MAKES THE LINE WORTH HAVING. A shape-only check passes on
    // a line of zeroes, which would look like instrumentation and diagnose nothing.
    const { costLines } = await turnCapturingLogs(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return fakeText('slow but fine');
    });

    const f = fields(costLines[0]);
    assert.ok(ms(f.providerMs) >= 30, `providerMs must reflect the delay, got ${f.providerMs}`);
    assert.ok(
      ms(f.total) >= ms(f.providerMs) + ms(f.toolMs),
      `the parts cannot exceed the whole: ${f.total} < ${f.providerMs} + ${f.toolMs}`,
    );
  });

  it('★ makes a retry that SUCCEEDED visible as a spent call', async () => {
    // MEASURED ON THE DEPLOYED PROVIDER (2026-10-13, 10 000-product tenant): one
    // real question answered in 20 820 ms from 3 model calls and 1 tool run — three
    // calls, one tool round, so one of the three returned NOTHING and was retried
    // (AI-2). The turn was `ok`, so no AI-2 warning fired and nothing said the answer
    // had cost a third more provider time than it needed. `calls` alone only implies
    // it; `empty` states it, which is what makes the free tier's empty-completion
    // rate countable across every healthy turn rather than only the degraded ones.
    let call = 0;
    const { lines, costLines } = await turnCapturingLogs(() => {
      call += 1;
      return call === 1 ? fakeText('') : fakeText('recovered on the retry');
    });

    const f = fields(costLines[0]);
    assert.equal(f.outcome, 'ok', 'a recovered turn is healthy, not degraded');
    assert.equal(f.calls, '2', 'the retry is a real call');
    assert.equal(f.empty, '1', 'and the line says why there was a second one');
    assert.ok(
      !lines.some((line) => line.includes('degraded turn')),
      'no degraded warning — the turn recovered, and the cost line already carries it',
    );
  });

  it('reports a turn that died, with what it spent before it did', async () => {
    process.env.AI_TURN_DEADLINE_MS = '60';
    const { costLines, error } = await turnCapturingLogs(() => new Promise(() => {}));

    assert.ok(error, 'the turn must fail');
    assert.equal(error.code, 'AI_TIMEOUT');
    const f = fields(costLines[0]);
    assert.equal(f.outcome, 'AI_TIMEOUT', 'the reason a turn died is the first thing to know');
    assert.equal(f.calls, '1');
    assert.ok(ms(f.providerMs) >= 50, 'a call that timed out still spent the time it burned');
    // AI-28 — AND IT NAMES THE MODEL IT WAS TRYING. A provider-side failure (the 2026-10-21
    // withdrawn-model 404) reported `model=unknown` at the one moment that field decides what an
    // operator changes; the configured model is known before any call and is therefore reportable
    // even when every call fails.
    assert.equal(f.model, 'fake-model', 'a turn that never got an answer still names its model');
  });

  it('reports an abandoned turn, even one that never reached the provider', async () => {
    const { costLines, error } = await turnCapturingLogs(
      () => fakeText('should never be asked'),
      { signal: AbortSignal.abort() },
    );

    assert.ok(error);
    assert.equal(error.code, 'AI_ABANDONED');
    const f = fields(costLines[0]);
    assert.equal(f.outcome, 'AI_ABANDONED');
    assert.equal(f.calls, '0', 'nothing was spent, and the line says so rather than staying silent');
    assert.equal(f.providerMs, '0ms');
  });

  it('keeps the degraded warning AND reports the cost of the degraded turn', async () => {
    const { lines, costLines } = await turnCapturingLogs(() => fakeText(''));

    assert.equal(costLines.length, 1);
    assert.equal(fields(costLines[0]).outcome, 'degraded');
    assert.ok(
      lines.some((line) => line.includes('degraded turn')),
      'the AI-2 warning stays exactly as it was — a degraded turn remains countable',
    );
  });

  it('keeps the provider-failure path intact while reporting it', async () => {
    const { costLines, error } = await turnCapturingLogs(() => {
      throw new Error('upstream exploded');
    });

    assert.ok(error, 'a provider failure is still a failure');
    assert.equal(error.code, 'AI_UNAVAILABLE');
    assert.equal(fields(costLines[0]).outcome, 'AI_UNAVAILABLE');
  });
});
