// AI-1 — one wall-clock deadline for a whole AI turn (ISS-21 root cause RC-2).
//
// BEFORE: the server bounded each provider call (AI_REQUEST_TIMEOUT_MS, default
// 60000) and the NUMBER of calls (AI_MAX_TOOL_ITERATIONS, default 6), but never
// the TURN itself — so "how long may a turn take?" was the product of two
// unrelated knobs and was expressed nowhere. Meanwhile the mobile client aborted
// every request at 15000 ms, so a slow-but-successful answer was killed by the
// phone and reported to the user as "Cannot reach the server".
//
// AFTER: runAiChat derives ONE absolute deadline for the turn and clamps every
// provider call to the time remaining, so the loop can never exceed it no matter
// how many iterations it runs. Exceeding it is an explicit AiTimeout.
//
// Two parts:
//   * DB-free unit tests that ALWAYS run — the deadline, the shared budget and
//     the empty-response guard, with no API key and no database.
//   * A DB-gated wire test over the real route, because the contract the client
//     depends on is the HTTP answer, not the service return value. DB-gated:
//     fails loudly when MongoDB is unreachable (Phase 07F / M9).

import { it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES, PERMISSIONS } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { aiToolsById } from '../src/services/ai/tools.ts';
import { researchMarketPrices } from '../src/services/ai/marketPrices.ts';
import { AI_TIMEOUT, isAiError } from '../src/services/ai/aiErrors.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
// Permissive limiter: several turns are issued from one user below.
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_TURN_DEADLINE_MS;
});

const ask = () => runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'how much stock do we hold?' });

/** A scenario that never settles, so only the deadline can end the turn. */
const hangs = () => new Promise(() => {});

unitSuite('AI-1 turn deadline (DB-free)', () => {
  it('defaults the turn deadline to 60000 ms', () => {
    delete process.env.AI_TURN_DEADLINE_MS;
    assert.equal(aiConfig().turnDeadlineMs, 60000);
  });

  it('rejects with AiTimeout when a provider call outlasts the turn deadline', async () => {
    process.env.AI_TURN_DEADLINE_MS = '200';
    setFakeScenario(hangs);
    await assert.rejects(ask, (err) => {
      assert.equal(err.name, 'AiTimeout');
      assert.equal(err.code, AI_TIMEOUT);
      assert.ok(isAiError(err), 'AiTimeout must be an AI error so the controller can map it');
      return true;
    });
  });

  it('bounds the WHOLE turn, not each call: one deadline, never deadline x iterations', async () => {
    process.env.AI_TURN_DEADLINE_MS = '300';
    setFakeScenario(hangs);
    const started = Date.now();
    await assert.rejects(ask, (err) => err.name === 'AiTimeout');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 300 + 750, `expected the turn to end near 300ms, took ${elapsed}ms`);
  });

  it('bounds a tool that never returns by the turn deadline and cancels it', async () => {
    process.env.AI_TURN_DEADLINE_MS = '250';
    let toolSignal;
    let providerCalls = 0;
    aiToolsById.set('testHang', {
      name: 'testHang',
      description: 'test-only tool that never settles',
      permission: PERMISSIONS.PRODUCTS_VIEW,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      executor: (ctx) => {
        toolSignal = ctx.signal;
        return new Promise(() => {});
      },
    });
    try {
      setFakeScenario(() => {
        providerCalls += 1;
        return fakeCalls([{ id: 'call-hang', name: 'testHang', input: {} }]);
      });
      const started = Date.now();
      await assert.rejects(ask, (err) => err.name === 'AiTimeout');
      assert.ok(Date.now() - started < 1500, 'the tool outlived the turn deadline');
      assert.equal(toolSignal?.aborted, true, 'the tool must be cancelled at the deadline');
      assert.equal(providerCalls, 1, 'a timed-out tool must not trigger another provider call');
    } finally {
      aiToolsById.delete('testHang');
    }
  });

  it('stops price research when the turn signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      researchMarketPrices({
        subjects: [
          { id: 'p1', name: 'Test Widget', brand: null, sellingPrice: null, currency: 'PHP', unit: 'pc' },
        ],
        signal: controller.signal,
      }),
      (err) => err.name === 'AbortError',
    );
  });

  it('clamps each call to the time REMAINING, so the budget is shared across iterations', async () => {
    process.env.AI_TURN_DEADLINE_MS = '5000';
    const budgets = [];
    let turn = 0;
    setFakeScenario((ctx) => {
      budgets.push(ctx.timeoutMs);
      turn += 1;
      // Two tool rounds, then a final answer.
      return turn <= 2 ? fakeCalls([{ id: `call-${turn}`, name: 'noSuchTool', input: {} }]) : fakeText('done');
    });

    const result = await ask();

    assert.equal(result.content, 'done');
    assert.equal(budgets.length, 3, 'the scenario should have been called three times');
    assert.ok(
      budgets.every((b) => typeof b === 'number' && b > 0 && b <= 5000),
      `every call must receive a positive budget within the turn deadline, got ${JSON.stringify(budgets)}`,
    );
    for (let i = 1; i < budgets.length; i += 1) {
      assert.ok(budgets[i] <= budgets[i - 1], `budget must not grow between calls: ${JSON.stringify(budgets)}`);
    }
  });

  it('a fast empty provider response still yields the fallback sentence, never a timeout', async () => {
    // Guards F-52 (the free model intermittently answers with neither text nor a
    // tool call): the deadline must not reclassify that as a timeout.
    setFakeScenario(() => fakeText(''));
    const result = await ask();
    assert.match(result.content, /could not generate a response/i);
  });
});

// ---------------------------------------------------------------------------
// The wire contract the mobile client depends on: WHY it failed, and nothing
// left behind. An unreachable provider and an expired deadline must be
// distinguishable at the boundary — collapsing them is RC-3.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

/** Poll until `predicate` holds or the budget runs out. */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AI-1 the deadline reaches the client as 504 AI_TIMEOUT', dbOk, () => {
  it('answers 504 with its own code, never as an unavailable provider', async () => {
    const owner = await registerOwner(api, tracker);
    process.env.AI_TURN_DEADLINE_MS = '200';
    setFakeScenario(hangs);

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'how much stock do we hold?' },
    });

    assert.equal(res.status, 504);
    assert.equal(res.json.code, 'AI_TIMEOUT');
    assert.equal(res.json.error, 'The assistant took too long to answer. Please try again.');
    assert.notEqual(res.json.code, 'AI_UNAVAILABLE', 'a deadline is not a provider outage');
  });

  it('leaves no conversation and no message behind when the deadline expires', async () => {
    const owner = await registerOwner(api, tracker);
    process.env.AI_TURN_DEADLINE_MS = '200';
    setFakeScenario(hangs);

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'anything at all' },
    });
    assert.equal(res.status, 504);

    // Phase 07E / M7 predates AI-1 and still holds: nothing is persisted until a
    // final answer exists, so a timed-out turn is a clean, repeatable retry.
    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 0, 'a timed-out turn must leave no conversation behind');
  });

  it('abandons the turn when the client goes away, instead of paying for it', async () => {
    // RC-4, measured before this was written: a 5 s handler kept running after
    // the client aborted at 1 s and even wrote to the dead connection, and the
    // aborted request left NO access-log line at all (httpLogger emits on
    // `finish` only). Nothing stopped the model call, so an abandoned turn was
    // billed in full and left no trace.
    const owner = await registerOwner(api, tracker);
    // Long enough that only the disconnection can end this turn.
    process.env.AI_TURN_DEADLINE_MS = '20000';

    let providerSignal;
    setFakeScenario((ctx) => {
      providerSignal = ctx.signal;
      return new Promise(() => {});
    });

    const ac = new AbortController();
    const abortedRequest = fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ message: 'anything at all' }),
      signal: ac.signal,
    });
    // Abort once the turn is provably IN FLIGHT, not on a fixed delay: a delay
    // short enough to beat auth's database lookup would drop the connection
    // before the server had anything to cancel, and would test nothing.
    assert.ok(
      await waitFor(() => providerSignal !== undefined, 5000),
      'the turn never reached the provider',
    );
    ac.abort();
    await assert.rejects(() => abortedRequest, (err) => err.name === 'AbortError');

    assert.ok(
      await waitFor(() => providerSignal !== undefined),
      'the provider must have been handed the signal, or nothing downstream can be cancelled',
    );
    assert.ok(
      await waitFor(() => providerSignal.aborted === true),
      'the provider call must be cancelled once the caller has gone away',
    );
  });
});
