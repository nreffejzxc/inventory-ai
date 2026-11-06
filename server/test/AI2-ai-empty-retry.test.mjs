// AI-2 — an upstream 200 with no usable content is retried once, and a turn that
// degrades says so instead of quietly answering HTTP 201 with a canned sentence.
//
// THE DEFECT (ISS-22's code half, and the F-52 sibling of ISS-21). Two shapes of
// the same upstream unreliability ended a turn with no server-side trace at all:
//
//   * F-52 — an Anthropic-compatible 200 whose `content` carries only a
//     `thinking` block and no text and no tool call. `parseAnthropicResponse`
//     maps that correctly to `{ text: '', toolCalls: [] }`, and the orchestration
//     loop treated the empty string as a legitimate final answer.
//   * F-54 — a 200 with a **zero-length body** (`bodyLength=0`,
//     `classification=EMPTY`), where `JSON.parse('')` throws and the turn became
//     a `502 AI_UNAVAILABLE`.
//
// Measured on the device on 2026-10-12 (§27BE): the deployed free-tier model did
// one or the other in roughly **three turns out of five**. The user saw
// "I could not generate a response right now. Please try again." as an ordinary
// 201, and nothing anywhere recorded that the turn had degraded — which is why
// the failure rate could not be measured, let alone fixed.
//
// WHAT THIS SUITE PINS — both halves of the fix:
//   * a content-less 200 is retried ONCE (the retry shares the turn's single
//     deadline and the loop's iteration budget, so it can neither extend a turn
//     nor run unbounded), and the retried answer is what the user receives;
//   * a turn that exhausts that budget is MARKED (`degraded` on the result, and
//     on the 201), which is the first time a degraded turn is visible anywhere.
//
// WHAT IT DELIBERATELY DOES NOT DO: retry a provider FAILURE. A transport error,
// a rejected key or an overloaded gateway is not an empty answer — retrying
// those would double the cost of every outage and hide the cause. The tests that
// pin that are GUARDS, not drivers: they pass before this change too, and exist
// so a later refactor cannot quietly widen the retry to wrap the whole call.
//
// DB-free except the wire suite at the bottom, which is DB-gated because the
// contract the client depends on is the HTTP answer, not the service return.

import { it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
// Permissive limiter: several turns are issued from one user below.
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_EMPTY_RETRY_MAX;
  delete process.env.AI_TURN_DEADLINE_MS;
});

/** Run one turn and count how many times the provider was actually called. */
async function askCounting(scenario) {
  const seen = [];
  setFakeScenario((ctx) => {
    seen.push(ctx);
    return scenario(ctx, seen.length);
  });
  const result = await runAiChat({
    businessId: 'b-dummy',
    userId: 'u-dummy',
    role: ROLES.OWNER,
    message: 'say hello in one sentence',
  });
  return { result, calls: seen.length };
}

/** Silence an expected console.error so a passing run stays pristine. */
async function withoutConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

unitSuite('AI-2 empty-completion retry (DB-free)', () => {
  it('defaults the retry budget to one', () => {
    delete process.env.AI_EMPTY_RETRY_MAX;
    assert.equal(aiConfig().emptyRetryMax, 1);
  });

  it('retries once when the provider answers with neither text nor a tool call', async () => {
    // THE headline behaviour. Before AI-2 this made ONE provider call and handed
    // the canned sentence to the user.
    const { result, calls } = await askCounting((_ctx, n) =>
      n === 1 ? fakeText('') : fakeText('here is the answer.'),
    );

    assert.equal(calls, 2, 'a content-less 200 must be retried exactly once');
    assert.equal(result.content, 'here is the answer.', 'the retry\'s answer is the answer');
    assert.equal(result.degraded, undefined, 'a retry that succeeded is not a degraded turn');
  });

  it('does not retry a healthy answer, so no turn pays twice', async () => {
    const { result, calls } = await askCounting(() => fakeText('Everything is fine.'));

    assert.equal(calls, 1);
    assert.equal(result.content, 'Everything is fine.');
    assert.equal(result.degraded, undefined);
  });

  it('does not retry a tool round — an empty text with tool calls is a normal step', async () => {
    // The model legitimately returns no prose while it asks for data; that is not
    // the empty-completion case, and retrying it would double every tool round.
    const { result, calls } = await askCounting((_ctx, n) =>
      n === 1 ? fakeCalls([{ id: 'call-1', name: 'noSuchTool', input: {} }]) : fakeText('done'),
    );

    assert.equal(calls, 2, 'one tool round plus one final answer, no retry');
    assert.equal(result.content, 'done');
    assert.equal(result.degraded, undefined);
  });

  it('stops at the budget and marks the turn degraded, still answering the user', async () => {
    const { result, calls } = await askCounting(() => fakeText(''));

    assert.equal(calls, 2, 'one attempt plus one retry, then stop');
    assert.match(result.content, /could not generate a response/i, 'the user still gets a sentence');
    assert.equal(result.degraded, 'EMPTY_COMPLETION', 'and the turn is marked, which it never was');
  });

  it('honours a raised retry budget', async () => {
    process.env.AI_EMPTY_RETRY_MAX = '2';
    const { result, calls } = await askCounting(() => fakeText(''));

    assert.equal(calls, 3, 'the configured budget is what bounds the attempts');
    assert.equal(result.degraded, 'EMPTY_COMPLETION');
  });

  it('never retries a provider failure', async () => {
    // A guard, not a driver: an outage must not be answered by paying twice for
    // it, and it must keep its own error code rather than becoming a "degraded"
    // turn. This is what stops a later refactor from wrapping the retry around
    // the whole provider call.
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      throw new Error('upstream exploded');
    });

    await withoutConsoleError(async () => {
      await assert.rejects(
        () => runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'hi' }),
        (err) => err.name === 'AiProviderError',
      );
    });
    assert.equal(calls, 1, 'a failure is never retried');
  });

  it('the retry shares the turn deadline and cannot extend it', async () => {
    // The retry is a loop iteration, not a fresh budget: the second call is
    // clamped to whatever is LEFT of AI_TURN_DEADLINE_MS, so a model that keeps
    // stalling cannot double a turn's wall-clock ceiling.
    process.env.AI_TURN_DEADLINE_MS = '500';
    setFakeScenario(() => new Promise((resolve) => setTimeout(() => resolve(fakeText('')), 400)));

    const started = Date.now();
    await assert.rejects(
      () => runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'hi' }),
      (err) => err.name === 'AiTimeout',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500 + 750, `the turn must end at its deadline, took ${elapsed}ms`);
  });

  it('a large retry budget still cannot outrun the iteration cap', async () => {
    // Both bounds are real and neither may be escaped by the other: the retry
    // consumes iterations, so a misconfigured budget degrades the turn instead of
    // looping. No wall-clock assert here — the point is that it TERMINATES.
    process.env.AI_EMPTY_RETRY_MAX = '50';
    const { result, calls } = await askCounting(() => fakeText(''));

    assert.equal(
      calls,
      aiConfig().maxToolIterations,
      'the iteration cap is the hard bound, not the retry budget',
    );
    // The reason names the CAUSE, not the trigger: the turn stopped at the cap,
    // but what is wrong is that the model produced nothing. Reporting
    // ITERATION_LIMIT here would send an operator looking at the wrong knob.
    assert.equal(result.degraded, 'EMPTY_COMPLETION');
    assert.match(result.content, /could not generate a response/i);
  });

  it('distinguishes a model that keeps asking for data from one that answers nothing', async () => {
    // The other reason, and its own copy: every iteration was a legitimate tool
    // round, so nothing was empty — the turn simply never reached an answer
    // within its step budget. Collapsing the two reasons would make the log line
    // useless for telling a quiet model from a busy one.
    const { result, calls } = await askCounting(() =>
      fakeCalls([{ id: 'call-x', name: 'noSuchTool', input: {} }]),
    );

    assert.equal(calls, aiConfig().maxToolIterations);
    assert.equal(result.degraded, 'ITERATION_LIMIT');
    assert.match(result.content, /could not finish that request/i);
    assert.notEqual(result.degraded, 'EMPTY_COMPLETION', 'the two reasons must stay apart');
  });
});

// ---------------------------------------------------------------------------
// The wire contract: a degraded turn is visible at the boundary. Persistence is
// unchanged — the answer the user actually saw must still be stored, or a
// reloaded conversation would disagree with the screen.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AI-2 a degraded turn is marked on the 201', dbOk, () => {
  it('carries degraded=EMPTY_COMPLETION and still persists the turn', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText(''));

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'how much stock do we hold?' },
    });

    assert.equal(res.status, 201, 'a degraded turn is a completed turn, not an error');
    assert.equal(res.json.degraded, 'EMPTY_COMPLETION');
    assert.match(res.json.assistantMessage.content, /could not generate a response/i);

    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 1, 'the conversation the user saw must exist');
  });

  it('a healthy turn carries no degraded key at all', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText('Nothing is low on stock.'));

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'is anything low?' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'Nothing is low on stock.');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(res.json, 'degraded'),
      'the key is absent, not null — a healthy turn must be distinguishable',
    );
  });
});
