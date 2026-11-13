// AI-6 — a reached LIMIT is not an outage (ISS-22's re-scoped follow-up).
//
// THE DEFECT. Every non-2xx from the AI gateway became one `AiProviderError`,
// which the controller maps to `502 AI_UNAVAILABLE` and the app renders as *"The
// AI service is temporarily unavailable. Please try again in a moment."* When the
// owner re-measured on hardware on 2026-10-13 (§27BF) the DOMINANT failure at
// this tier turned out to be a `429 free-models-per-day` QUOTA answer — and that
// reached the member as a provider outage. The sentence was wrong twice over:
// nothing upstream was unavailable, and "try again in a moment" cannot refill a
// spent daily allowance, so it prescribed an action that could never work.
//
// AFTER. A 429 is its own class — `AiQuotaExceeded` / `429 AI_QUOTA_EXCEEDED` —
// with its own sentence, and every other non-2xx (a 5xx above all) stays exactly
// the `AiProviderError` it was. The direction of that boundary is the whole point,
// so it is pinned BOTH ways: a 500 must not become a limit, and a 429 must not
// stay an outage.
//
// Two parts:
//   * DB-free unit tests that ALWAYS run — the classification at the wire layer,
//     and the loop-level facts (the refusal is not retried; a turn that dies of
//     it reports the same word the HTTP answer uses). No API key, no credits, no
//     database: the stub server below is local.
//   * A DB-gated wire test over the real route, because the contract the client
//     depends on is the HTTP answer, not the exception. DB-gated: fails loudly
//     when MongoDB is unreachable (Phase 07F / M9).

import http from 'node:http';
import { once } from 'node:events';

import { it, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { postJson } from '../src/services/ai/providers/http.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import {
  AI_QUOTA_EXCEEDED,
  AI_UNAVAILABLE,
  AiProviderError,
  AiQuotaExceeded,
  isAiError,
} from '../src/services/ai/aiErrors.ts';
import { resetQuotaState } from '../src/services/ai/quota.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
// Permissive limiter: several turns are issued from one user below.
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

// ---------------------------------------------------------------------------
// A local stub gateway. Nothing here can spend provider quota, and the response
// is whatever the test sets — which is what makes the classification testable.
// ---------------------------------------------------------------------------

let respond = { status: 200, body: '{}', contentType: 'application/json' };
let hits = 0;
const stub = http.createServer((req, res) => {
  hits += 1;
  req.resume();
  req.on('end', () => {
    res.writeHead(respond.status, { 'content-type': respond.contentType });
    res.end(respond.body);
  });
});
stub.listen(0);
await once(stub, 'listening');
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1/messages`;

/** Every console.error line emitted during one test, joined. */
let errLines = [];
const realError = console.error;
const realLog = console.log;
let logLines = [];

beforeEach(() => {
  respond = { status: 200, body: '{}', contentType: 'application/json' };
  hits = 0;
  errLines = [];
  logLines = [];
  console.error = (...args) => errLines.push(args.map(String).join(' '));
  console.log = (...args) => logLines.push(args.map(String).join(' '));
});

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  setFakeScenario(null);
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

/** One call through the shared wire layer, with the stub's answer in place. */
const call = (status, body = '', contentType = 'application/json') => {
  respond = { status, body, contentType };
  return postJson({ url: stubUrl, body: { ping: 1 }, providerName: 'stub-ai', timeoutMs: 3000 });
};

unitSuite('AI-6 an upstream 429 is a limit, not an outage (DB-free)', () => {
  it('classifies a reached limit (429 / 402) as a quota refusal, with its own code', async () => {
    for (const [status, reason] of [
      [429, 'free-models-per-day'],
      [402, 'insufficient credits'],
    ]) {
      await assert.rejects(call(status, JSON.stringify({ error: reason })), (err) => {
        assert.equal(err.name, 'AiQuotaExceeded', `HTTP ${status} must be a quota refusal`);
        assert.equal(err.code, AI_QUOTA_EXCEEDED);
        assert.ok(isAiError(err), 'the controller can only map it if it is an AI error');
        assert.ok(
          !(err instanceof AiProviderError),
          'a limit is not a provider failure — inheriting would let a later ordering change quietly re-report it as an outage',
        );
        return true;
      });
    }
  });

  it('classifies a 500 as a provider failure, NOT as a limit', async () => {
    // The negative control in the direction that matters most: an outage must
    // never be softened into "you have hit your limit", which would tell a member
    // to wait for something that is broken.
    await assert.rejects(call(500, 'upstream exploded'), (err) => {
      assert.equal(err.code, AI_UNAVAILABLE);
      assert.ok(!(err instanceof AiQuotaExceeded));
      return true;
    });
  });

  it('leaves every other non-2xx exactly as it was', async () => {
    for (const status of [400, 401, 403, 404, 502, 503]) {
      await assert.rejects(call(status, `{"status":${status}}`), (err) => {
        assert.equal(err.code, AI_UNAVAILABLE, `HTTP ${status} must stay a provider failure`);
        assert.ok(err instanceof AiProviderError);
        return true;
      });
    }
  });

  it('still reads and logs the 429 body, and still leaks no secret from it', async () => {
    await assert.rejects(
      call(429, '{"error":"quota","key":"sk-live-abc123XYZ"}'),
      (err) => err.code === AI_QUOTA_EXCEEDED,
    );
    const logged = errLines.join('\n');
    assert.match(logged, /rate\/quota limit reached \(HTTP 429\)/, 'the limit is named in the log');
    assert.match(logged, /status=429/);
    assert.ok(!logged.includes('sk-live-abc123XYZ'), 'a credential shape must never be logged');
    assert.ok(
      errLines.every((l) => !l.includes('sk-live-abc123XYZ')),
      'no line may carry the secret',
    );
  });

  it('keeps the quota error message free of upstream detail', async () => {
    await assert.rejects(call(429, '{"error":"internal detail that must not escape"}'), (err) => {
      assert.ok(!err.message.includes('internal detail'), 'the upstream body must not reach the client');
      assert.match(err.message, /usage limit/);
      return true;
    });
  });

  it('really reaches the stub — a positive control on the harness itself', async () => {
    // Guards the SUT's own test double. A stale URL, a mis-set status or a dead
    // socket would make every case above "pass" for the wrong reason, and a
    // stubbed suite is exactly where that goes unnoticed: the assertions would be
    // about an error that arrived before the request did. This case asserts the
    // request genuinely landed, and that a healthy 200 is still returned as data
    // rather than being classified as a failure.
    // AI-36 — `postJson` now returns `{ data, quota }`: the allowance the response published
    // rides beside the body so the turn can report it. A stub that publishes no header is an
    // absence (`quota: null`), never a zero.
    const { data, quota } = await call(200, '{"ok":true}');
    assert.deepEqual(data, { ok: true });
    assert.equal(quota, null);
    assert.equal(hits, 1, 'exactly one request must have reached the stub gateway');
    assert.equal(errLines.length, 0, 'a healthy response logs no error');
  });
});

// ---------------------------------------------------------------------------
// The loop-level facts. A quota refusal is a REFUSAL: paying for it twice while
// the cause is hidden is exactly what AI-2 forbade for provider failures, and a
// limit must not be more retryable than a failure.
// ---------------------------------------------------------------------------

const ask = () =>
  runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'how much stock do we hold?' });

unitSuite('AI-6 the quota refusal reaches the turn unchanged, and is never retried (DB-free)', () => {
  it('rejects with the quota error after exactly ONE provider call', async () => {
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      // A second call WOULD succeed — so a retry would produce a 201 and hide the
      // limit entirely. That is what makes `calls === 1` a real assertion.
      if (calls === 1) throw new AiQuotaExceeded();
      return fakeText('this answer must never be produced');
    });

    await assert.rejects(ask(), (err) => {
      assert.equal(err.code, AI_QUOTA_EXCEEDED);
      return true;
    });
    assert.equal(calls, 1, 'a reached limit must never be retried');
  });

  it('reports the turn as AI_QUOTA_EXCEEDED — the log line and the HTTP answer name the same thing', async () => {
    setFakeScenario(() => {
      throw new AiQuotaExceeded();
    });
    await assert.rejects(ask(), (err) => err.code === AI_QUOTA_EXCEEDED);

    const cost = logLines.find((l) => l.includes('AI turn'));
    assert.ok(cost, 'the turn must still report what it spent');
    assert.match(cost, /outcome=AI_QUOTA_EXCEEDED/, 'AI-5 vocabulary: the code names the outcome');
    assert.ok(!cost.includes('outcome=AI_UNAVAILABLE'), 'a limit is not an outage in the log either');
  });

  it('a provider failure still reports AI_UNAVAILABLE — the vocabulary did not blur', async () => {
    setFakeScenario(() => {
      throw new AiProviderError('The AI service returned an error. Please try again.');
    });
    await assert.rejects(ask(), (err) => err.code === AI_UNAVAILABLE);

    const cost = logLines.find((l) => l.includes('AI turn'));
    assert.ok(cost);
    assert.match(cost, /outcome=AI_UNAVAILABLE/);
  });
});

// ---------------------------------------------------------------------------
// The wire contract the mobile client switches on.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AI-6 the limit reaches the client as 429 AI_QUOTA_EXCEEDED', dbOk, () => {
  it('answers 429 with its own code and its own sentence, never as an outage', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiQuotaExceeded();
    });

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'how much stock do we hold?' },
    });

    assert.equal(res.status, 429);
    assert.equal(res.json.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(res.json.error, 'The AI assistant has reached its usage limit. Please try again later.');
    assert.notEqual(res.json.code, 'AI_UNAVAILABLE', 'a spent allowance is not a provider outage');
    // The sentence must not prescribe a wait that cannot help.
    assert.doesNotMatch(res.json.error, /in a moment/i);
  });

  it('is distinguishable from the route\'s OWN rate limit at the boundary', async () => {
    // Two 429s with opposite remedies: `AI_RATE_LIMITED` clears in seconds, the
    // quota does not. A client that could not tell them apart would tell a member
    // to wait a moment for a daily allowance.
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiQuotaExceeded();
    });

    // The member's own limit is set to ONE call before anything is sent, so the
    // second request is refused by the route's limiter rather than by state left
    // over from an earlier test. (`0` would not work: config's `positiveInt`
    // treats a non-positive value as unset and falls back to the default, so the
    // route would never limit at all — measured while writing this case.)
    const previous = process.env.AI_RATE_LIMIT_MAX;
    process.env.AI_RATE_LIMIT_MAX = '1';
    try {
      const quota = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'anything at all' },
      });
      assert.equal(quota.status, 429, 'the first call still reaches the assistant');
      assert.equal(quota.json.code, 'AI_QUOTA_EXCEEDED', 'and is refused by the GATEWAY limit');
      assert.notEqual(quota.json.code, 'AI_RATE_LIMITED');

      const limited = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'anything at all' },
      });
      assert.equal(limited.status, 429);
      assert.equal(
        limited.json.code,
        'AI_RATE_LIMITED',
        "the member's own limit keeps its own code",
      );
      assert.notEqual(limited.json.code, 'AI_QUOTA_EXCEEDED');
    } finally {
      process.env.AI_RATE_LIMIT_MAX = previous;
    }
  });

  it('leaves no conversation and no message behind when the limit is hit', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiQuotaExceeded();
    });

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'anything at all' },
    });
    assert.equal(res.status, 429);

    // Phase 07E / M7 still holds: nothing is persisted until an answer exists, so
    // a refused turn leaves a clean slate rather than a half-written thread.
    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 0, 'a refused turn must leave no conversation behind');
  });

  it('a real upstream failure still answers 502 AI_UNAVAILABLE', async () => {
    // The other direction, over the real route: the new class did not swallow the
    // old one.
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiProviderError('The AI service returned an error. Please try again.');
    });

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'anything at all' },
    });

    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'AI_UNAVAILABLE');
    assert.notEqual(res.json.code, 'AI_QUOTA_EXCEEDED');
  });

  it('continues the same conversation after a quota refusal and recovery', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText('Hello from the first turn.'));
    const first = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'say hello in one sentence' },
    });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const conversationId = first.json.conversation.id;

    const previousBlock = process.env.AI_QUOTA_BLOCK_MS;
    process.env.AI_QUOTA_BLOCK_MS = '2000';
    let calls = 0;
    let retryContext = null;
    setFakeScenario((ctx) => {
      calls += 1;
      if (calls === 1) throw new AiQuotaExceeded(undefined, { remaining: 0, limit: 50 });
      retryContext = { messages: ctx.messages.map((message) => ({ ...message })) };
      return fakeText('Hello from the retry.', { quota: { remaining: 50, limit: 50 } });
    });

    try {
      const refused = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { conversationId, message: 'say hello again in one sentence' },
      });
      assert.equal(refused.status, 429);
      assert.equal(refused.json.code, 'AI_QUOTA_EXCEEDED');
      assert.equal(calls, 1);

      const before = await api('GET', `/api/ai/conversations/${conversationId}/messages`, {
        token: owner.token,
      });
      assert.equal(before.json.total, 2, 'the refused turn persists no message');

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const retried = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { conversationId, message: 'say hello again in one sentence' },
      });
      assert.equal(retried.status, 201, JSON.stringify(retried.json));
      assert.equal(retried.json.conversation.id, conversationId, 'the retry continues the same conversation');
      assert.equal(retried.json.assistantMessage.content, 'Hello from the retry.');
      assert.equal(calls, 2, 'the allowance is asked again after the window');

      const after = await api('GET', `/api/ai/conversations/${conversationId}/messages`, {
        token: owner.token,
      });
      assert.equal(after.json.total, 4, 'the retry adds exactly one question and one answer');
      assert.deepEqual(
        after.json.items.map((message) => message.content),
        [
          'say hello in one sentence',
          'Hello from the first turn.',
          'say hello again in one sentence',
          'Hello from the retry.',
        ],
      );
      assert.ok(
        retryContext.messages.some(
          (message) => message.role === 'assistant' && message.content === 'Hello from the first turn.',
        ),
        'the retry provider request carries the earlier answer as history',
      );

      const list = await api('GET', '/api/ai/conversations', { token: owner.token });
      assert.equal(list.json.total, 1, 'the retry must not create a second conversation');
    } finally {
      if (previousBlock === undefined) delete process.env.AI_QUOTA_BLOCK_MS;
      else process.env.AI_QUOTA_BLOCK_MS = previousBlock;
      resetQuotaState();
    }
  });

  it('returns 429, fails fast, then serves the next request after the quota window', async () => {
    const owner = await registerOwner(api, tracker);
    const previousBlock = process.env.AI_QUOTA_BLOCK_MS;
    // The production fail-fast window is 30 s. A short one lets this test cross the
    // real route's window without a 30-second wait; the provider owns the daily counter.
    process.env.AI_QUOTA_BLOCK_MS = '2000';
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      if (calls === 1) throw new AiQuotaExceeded(undefined, { remaining: 0, limit: 50 });
      return fakeText('served after the quota window', { quota: { remaining: 50, limit: 50 } });
    });

    try {
      const first = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'say hello in one sentence' },
      });
      assert.equal(first.status, 429);
      assert.equal(first.json.code, 'AI_QUOTA_EXCEEDED');
      assert.equal(first.json.error, 'The AI assistant has reached its usage limit. Please try again later.');
      assert.equal(calls, 1);

      const blocked = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'say hello in one sentence' },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.code, 'AI_QUOTA_EXCEEDED');
      assert.equal(calls, 1, 'the fail-fast window must not spend another provider call');

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const afterWindow = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { message: 'say hello in one sentence' },
      });
      assert.equal(afterWindow.status, 201, JSON.stringify(afterWindow.json));
      assert.equal(afterWindow.json.assistantMessage.content, 'served after the quota window');
      assert.equal(calls, 2, 'the allowance is asked again after the window');

      const list = await api('GET', '/api/ai/conversations', { token: owner.token });
      assert.equal(list.json.total, 1, 'the successful retry persists one conversation');
    } finally {
      if (previousBlock === undefined) delete process.env.AI_QUOTA_BLOCK_MS;
      else process.env.AI_QUOTA_BLOCK_MS = previousBlock;
      resetQuotaState();
    }
  });
});
