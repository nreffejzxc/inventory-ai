// AI-10 — a question the model could not fit inside its own output budget is a LIMIT,
// not an outage.
//
// THE DEFECT (measured 2026-10-16, §27BG Q4 — the question this harness was extended
// to catch). "How many products are completely out of stock, and what percentage of the
// active catalogue is that?" answered `502 AI_UNAVAILABLE` **twice**, at 31 421 ms and
// 31 789 ms, with `calls=2 toolRuns=1` — the tool had already run and answered. The
// member was told *"The AI service is temporarily unavailable. Please try again in a
// moment."* Three things were wrong with that, and all three are pinned below:
//
//   1. It named the wrong cause. Nothing upstream was unavailable: the gateway answered
//      2xx, and the model had spent `AI_MAX_OUTPUT_TOKENS` (default 800) without yet
//      producing a single token of answer or a tool call. `parseAnthropicResponse` saw
//      `stop_reason: 'max_tokens'` with nothing usable and threw `AiProviderError` —
//      the one class the controller maps to a provider outage.
//   2. It prescribed an action that cannot work. "Try again in a moment" refills
//      nothing; the same question spends the same budget again. The actionable advice
//      is to ask for less at once.
//   3. It left NO trace. Every sibling path in `providers/http.ts` logs before it
//      throws; this one did not, so the only evidence of the failure was a missing
//      answer — which is why it took elimination to identify (§27BG).
//
// A SECOND DEFECT, FOUND BY THIS SUITE'S FIRST DEVICE RUN (2026-10-17, §27CM). On the
// phone the fix behaved exactly as designed — the member read the actionable sentence
// and no error banner — and the SERVER then reported the turn as
// `outcome=AI_OUTPUT_LIMIT … in=0 out=0 model=unknown`: the parser had the gateway's
// `usage` and `model` in hand and threw both away with the error, so the one turn whose
// entire story is "the model spent everything it had" looked like a turn that cost
// nothing on a model nobody could name. The failure now carries its accounting, and the
// service adopts it before writing the line — which is what the four ★ cases below pin,
// the last of them through the real wire so the hand-thrown case cannot be the only proof.
//
// AFTER. `AiOutputLimit` / `AI_OUTPUT_LIMIT`, its own sentence, and one `AI turn` line
// naming the cap. It is deliberately NOT an `AiProviderError`, for the same reason
// `AiTimeout`, `AiAbandoned` and `AiQuotaExceeded` are not: "we gave up waiting", "the
// caller left", "an allowance is spent" and "the model ran out of room" are four
// different facts with four different remedies, and collapsing any of them into
// "temporarily unavailable" is the defect this suite exists to prevent.
//
// WHY THE WIRE, NOT THE FAKE, FOR THE HEADLINE CASE. The route case below drives the
// REAL Anthropic-compatible provider against a local stub gateway, so the whole chain
// is under test: stub → postJson → parseAnthropicResponse → AiOutputLimit → the
// service's pass-through → the controller's mapping → the HTTP answer the app reads.
// A hand-thrown error from the fake would have covered only the last two hops, and the
// first two are where the misclassification lived. Nothing here can spend provider
// quota: the gateway is a socket on localhost.

import http from 'node:http';
import { once } from 'node:events';

import { it, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { createOpenrouterProvider } from '../src/services/ai/providers/openrouterProvider.ts';
import { parseAnthropicResponse } from '../src/services/ai/providers/anthropicWire.ts';
import { AI_OUTPUT_LIMIT, AiOutputLimit, AiProviderError, isAiError } from '../src/services/ai/aiErrors.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

// ---------------------------------------------------------------------------
// A local stub gateway. Nothing here can spend provider quota, and the response is
// whatever the test sets — which is what makes the classification testable.
// ---------------------------------------------------------------------------

let respond = { status: 200, body: '{}', contentType: 'application/json' };
let hits = 0;
let lastBody = null;
let lastAuth = null;
const stub = http.createServer((req, res) => {
  hits += 1;
  lastAuth = req.headers.authorization ?? null;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      lastBody = null;
    }
    res.writeHead(respond.status, { 'content-type': respond.contentType });
    res.end(respond.body);
  });
});
stub.listen(0);
await once(stub, 'listening');
const stubOrigin = `http://127.0.0.1:${stub.address().port}`;
// NOTE ON WHERE THIS STUB IS CLOSED. Not here. A root-level `after()` hook
// registered above the suites belongs to the root suite as it existed at that
// moment, and `node --test` runs it as soon as that root's first child finishes —
// so the stub was already closed (`listening=false`) by the time the wire suite
// below issued its request, which failed with ECONNREFUSED against a port nothing
// was listening on. The DB-free cases, which run first, passed either way, so the
// symptom looked like a provider bug rather than a harness one. The close now lives
// in the LAST root-level hook — the one registered after `await startServer()`, the
// same place every other suite in this repo cleans up — which runs at the end of
// the file.

// The deployed provider is openrouter, and it is the one whose wire carries the guard,
// so the route below runs the production path against the stub.
process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'stub-key-not-real';
process.env.OPENROUTER_BASE_URL = `${stubOrigin}/api`;
process.env.AI_MODEL_OPENROUTER = 'stub-model';
// Permissive limiter: several turns are issued from one user below.
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

/** The exact shape the free-tier model produced on 2026-10-16: a 2xx with nothing in it. */
const EMPTY_AT_THE_CAP = JSON.stringify({
  model: 'stub-model',
  content: [],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 1200, output_tokens: 800 },
});

let warnings = [];
let logLines = [];
let errLines = [];
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  respond = { status: 200, body: '{}', contentType: 'application/json' };
  hits = 0;
  lastBody = null;
  lastAuth = null;
  warnings = [];
  logLines = [];
  errLines = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  console.log = (...args) => logLines.push(args.map(String).join(' '));
  console.error = (...args) => errLines.push(args.map(String).join(' '));
});

afterEach(() => {
  console.warn = realWarn;
  console.log = realLog;
  console.error = realError;
  setFakeScenario(null);
});

/** One call through the real provider, with the stub's answer in place. */
async function callProvider(body = EMPTY_AT_THE_CAP, status = 200) {
  respond = { status, body, contentType: 'application/json' };
  const provider = createOpenrouterProvider();
  return provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });
}

unitSuite('AI-10 the output limit is its own failure (DB-free)', () => {
  it('★ classifies a max_tokens stop with nothing usable as an output limit, not a provider error', () => {
    let thrown = null;
    try {
      parseAnthropicResponse({ content: [], stop_reason: 'max_tokens', model: 'stub-model' });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'a response with no text and no tool call is still not an answer');
    assert.equal(thrown.name, 'AiOutputLimit');
    assert.equal(thrown.code, AI_OUTPUT_LIMIT);
    // The sentence must name the limit and the remedy. "Try again in a moment" is the
    // advice that cannot work, and "unavailable" is the word that names the wrong cause.
    assert.match(thrown.message, /out of room|length limit/i);
    assert.match(thrown.message, /shorter|more specific/i);
    assert.doesNotMatch(thrown.message, /unavailable|in a moment/i);
    // The exact defect: this used to be an AiProviderError, which the controller maps to
    // 502 AI_UNAVAILABLE. One instance check is the whole difference.
    assert.equal(thrown instanceof AiProviderError, false, 'a limit is not a provider failure');
    assert.equal(isAiError(thrown), true, 'and the service must let it through its catch untouched');
  });

  // -------------------------------------------------------------------------
  // A cap-spent turn is the ONE turn whose whole point is the spend (found on the
  // device 2026-10-17, §27CM). The phone said the right sentence — and the server
  // said the turn had cost `in=0 out=0 model=unknown`, because `parseAnthropicResponse`
  // threw away a `usage` and a `model` it had already parsed. The line exists to
  // answer "what did this cost?", and on a spent output budget it answered "nothing".
  // -------------------------------------------------------------------------

  it('★ carries the spend it saw, so a spent cap is countable afterwards', () => {
    let thrown = null;
    try {
      parseAnthropicResponse({
        content: [],
        stop_reason: 'max_tokens',
        model: 'stub-model',
        usage: { input_tokens: 1200, output_tokens: 800 },
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'the response is still refused');
    assert.equal(thrown.model, 'stub-model', 'the model is known at the throw site');
    assert.deepEqual(
      thrown.usage,
      { inputTokens: 1200, outputTokens: 800 },
      'and so is the burn — the two numbers an operator decides on',
    );
  });

  it('omits usage when the gateway reported none, rather than inventing zeros', () => {
    let thrown = null;
    try {
      parseAnthropicResponse({ content: [], stop_reason: 'max_tokens', model: 'stub-model' });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown);
    assert.equal(thrown.usage ?? null, null, 'a missing report stays missing (absent, not zeroed)');
    assert.equal(thrown.model, 'stub-model', 'but the model is still named');
  });

  it('★ the turn line reports the tokens a spent output budget actually burned', async () => {
    process.env.AI_PROVIDER = 'fake';
    try {
      setFakeScenario(() => {
        throw new AiOutputLimit(undefined, {
          model: 'stub-model',
          usage: { inputTokens: 1200, outputTokens: 800 },
        });
      });
      await assert.rejects(
        runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'say hello in one sentence' }),
        (err) => err.code === AI_OUTPUT_LIMIT,
      );
    } finally {
      process.env.AI_PROVIDER = 'openrouter';
    }

    const cost = logLines.find((l) => l.includes('AI turn'));
    assert.ok(cost, 'the turn must still report what it spent');
    assert.match(cost, /in=1200 out=800/, 'the model spent its whole budget: the line must not say it spent nothing');
    assert.match(cost, /model=stub-model/, 'and must name the model the cap was spent on');
  });

  it('logs the failure it used to swallow, naming the cap', async () => {
    await callProvider().then(
      () => assert.fail('the call must throw'),
      (err) => assert.equal(err.code, AI_OUTPUT_LIMIT),
    );

    const lines = warnings.filter((w) => w.includes('output limit'));
    assert.equal(lines.length, 1, 'exactly one line, so the rate is countable');
    assert.match(lines[0], new RegExp(String(aiConfig().maxOutputTokens)), 'the cap is the number an operator needs');
    assert.match(lines[0], /stub-model/, 'and the model it happened on');
    assert.equal(errLines.length, 0, 'an unusable 2xx is not an HTTP or transport failure');
  });

  it('a healthy answer logs nothing (control for the line above)', async () => {
    respond = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ model: 'stub-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    };
    const provider = createOpenrouterProvider();
    const out = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });

    assert.equal(out.text, 'ok');
    assert.equal(warnings.length, 0, 'no limit line on a turn that answered');
    assert.equal(hits, 1, 'positive control: the request really reached the stub');
    assert.equal(lastAuth, 'Bearer stub-key-not-real', 'the key travels in the header, as documented');
    assert.equal(lastBody.max_tokens, aiConfig().maxOutputTokens, 'and the request carries the cap');
  });

  it('the turn reports AI_OUTPUT_LIMIT — the log vocabulary and the code are the same word', async () => {
    process.env.AI_PROVIDER = 'fake';
    try {
      setFakeScenario(() => {
        throw new AiOutputLimit();
      });
      await assert.rejects(
        runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'say hello in one sentence' }),
        (err) => err.code === AI_OUTPUT_LIMIT,
      );
    } finally {
      process.env.AI_PROVIDER = 'openrouter';
    }

    const cost = logLines.find((l) => l.includes('AI turn'));
    assert.ok(cost, 'the turn must still report what it spent');
    assert.match(cost, /outcome=AI_OUTPUT_LIMIT/);
    assert.ok(!cost.includes('outcome=AI_UNAVAILABLE'), 'a limit is not an outage in the log either');
  });

  // AI-52 — the limit is retried ONCE, and only when it produced nothing.
  //
  // This suite used to pin `calls === 1`: "paying twice cannot buy room that was already
  // spent". That held while the failure looked deterministic. The device battery of
  // 2026-11-04 showed it is not — "what do reviewers say about the K8 Pro" and "do we
  // have anything from Royal Kludge?" each hit `AiOutputLimit` with no text and no tool
  // call, and each answered correctly on the immediate retry (the retry's own log line
  // is in that run). A member was being shown "ask a shorter question" for a question
  // that only needed asking twice, so the rule is now the empty-completion rule: one
  // retry, sharing `emptyRetryMax`, and a second limit in the same turn is reported.
  it('is retried once when it produced nothing — the spent budget was not the question\'s fault', async () => {
    process.env.AI_PROVIDER = 'fake';
    let calls = 0;
    const warn = console.warn;
    console.warn = () => {};
    let result;
    try {
      setFakeScenario(() => {
        calls += 1;
        if (calls === 1) throw new AiOutputLimit();
        return fakeText('here is the answer.');
      });
      result = await runAiChat({
        businessId: 'b-dummy',
        userId: 'u-dummy',
        role: ROLES.OWNER,
        message: 'say hello in one sentence',
      });
    } finally {
      console.warn = warn;
      process.env.AI_PROVIDER = 'openrouter';
    }
    assert.equal(calls, 2, 'a limit with no content is retried exactly once');
    assert.equal(result.content, 'here is the answer.', "the retry's answer is the answer");
  });

  it('reports a second limit rather than paying a third time', async () => {
    process.env.AI_PROVIDER = 'fake';
    let calls = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      setFakeScenario(() => {
        calls += 1;
        throw new AiOutputLimit();
      });
      await assert.rejects(
        runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'say hello in one sentence' }),
        (err) => err.code === AI_OUTPUT_LIMIT,
      );
    } finally {
      console.warn = warn;
      process.env.AI_PROVIDER = 'openrouter';
    }
    assert.equal(calls, 2, 'the retry budget is one, not an open question');
  });

  // AI-53 — the retry must ASK FOR SOMETHING ELSE.
  //
  // On 2026-11-04 a real question ("...is there a newer Alienware model than the one we
  // stock") spent the whole 1,200-token budget twice: two calls, both stop=max_tokens, no
  // text and no tool call, so the member was shown only "ran out of room". The retry used to
  // resend the identical request, which at temperature 0 mostly re-spends the budget on the
  // same preamble. It now adds one brevity instruction, so the resent turn is a different
  // request; this test reads the messages the second call actually received.
  it('the retry asks for brevity instead of resending the identical request', async () => {
    process.env.AI_PROVIDER = 'fake';
    let calls = 0;
    let secondMessages = null;
    const warn = console.warn;
    console.warn = () => {};
    try {
      setFakeScenario((ctx) => {
        calls += 1;
        if (calls === 1) throw new AiOutputLimit();
        secondMessages = ctx.messages;
        return fakeText('here is the answer.');
      });
      await runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'say hello in one sentence' });
    } finally {
      console.warn = warn;
      process.env.AI_PROVIDER = 'openrouter';
    }

    assert.equal(calls, 2, 'still exactly one retry');
    const final = secondMessages[secondMessages.length - 1];
    assert.equal(final.role, 'user', 'the nudge rides on the retry as a user turn');
    assert.match(String(final.content), /whole reply budget without producing an answer/);
    assert.match(String(final.content), /under 120 words/, 'it names a length the model can meet');
  });

  it('the output-limit retry raises ONLY that call’s cap and reserves reasoning space', async () => {
    process.env.AI_PROVIDER = 'fake';
    const original = aiConfig().maxOutputTokens;
    let calls = 0;
    let secondRequest = null;
    const warn = console.warn;
    console.warn = () => {};
    try {
      setFakeScenario((ctx) => {
        calls += 1;
        if (calls === 1) throw new AiOutputLimit(undefined, { model: 'openai/gpt-oss-20b' });
        secondRequest = ctx;
        return fakeText('here is the answer.');
      });
      await runAiChat({
        businessId: 'b-dummy',
        userId: 'u-dummy',
        role: ROLES.OWNER,
        message: 'say hello in one sentence',
      });
    } finally {
      console.warn = warn;
      process.env.AI_PROVIDER = 'openrouter';
    }

    assert.equal(calls, 2, 'still one retry');
    assert.equal(secondRequest.maxOutputTokens, original + Math.max(original, 1200));
    assert.equal(secondRequest.reasoningBudgetTokens, Math.max(1024, original));
    assert.notEqual(secondRequest.maxOutputTokens, original, 'the normal cap is not changed globally');
  });

  it('the real wire receives the retry cap and the reasoning budget', async () => {
    respond = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ model: 'stub-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    };
    const provider = createOpenrouterProvider();
    const out = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxOutputTokens: 2400,
      reasoningBudgetTokens: 1200,
    });

    assert.equal(out.text, 'ok');
    assert.equal(lastBody.max_tokens, 2400, 'the retry cap reaches the gateway');
    assert.deepEqual(
      lastBody.thinking,
      { type: 'enabled', budget_tokens: 1200 },
      'the retry reserves reasoning space instead of re-spending the answer budget',
    );
    assert.equal(aiConfig().maxOutputTokens, 1200, 'the normal configured cap is untouched');
  });

  it('leaves AI-8 alone: a truncated answer that ARRIVED keeps its text', async () => {
    respond = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'stub-model',
        content: [{ type: 'text', text: '1. Everyday Towel 60624 - available 416' }],
        stop_reason: 'max_tokens',
      }),
    };
    const provider = createOpenrouterProvider();
    const out = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });

    assert.equal(out.text, '1. Everyday Towel 60624 - available 416', 'a partial answer is still an answer');
    assert.equal(out.truncated, true, 'and it is still marked as cut off');
    assert.equal(warnings.length, 0, 'the limit line is for the case with NOTHING usable');
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
  // The stub gateway closes with everything else, in this last root-level hook — see
  // the note beside its creation for why the hook above the suites was the wrong home.
  await new Promise((resolve) => stub.close(resolve));
  await disconnectDb();
});

dbSuite('AI-10 the limit reaches the client as its own code, never as an outage', dbOk, () => {
  it('★ answers 502 AI_OUTPUT_LIMIT with the actionable sentence, over the REAL wire', async () => {
    const owner = await registerOwner(api, tracker);
    // The real provider, the real parser, the real mapping: only the gateway is stubbed,
    // and it answers exactly what the model answered on the device.
    respond = { status: 200, body: EMPTY_AT_THE_CAP, contentType: 'application/json' };

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'How many products are completely out of stock, and what percentage of the active catalogue is that?' },
    });

    // Positive control: the turn really reached the gateway. Without it, the
    // assertions below would pass just as happily against a provider that never
    // spoke to the stub at all.
    // AI-10 retries a content-less limit once, so the control expects the first call and
    // its retry — both real requests to the gateway.
    assert.equal(
      hits,
      2,
      `positive control: the turn really reached the gateway — provider=${process.env.AI_PROVIDER}` +
        ` base=${process.env.OPENROUTER_BASE_URL}`
    );
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'AI_OUTPUT_LIMIT');
    assert.notEqual(res.json.code, 'AI_UNAVAILABLE', 'a spent output budget is not a provider outage');
    assert.match(res.json.error, /out of room|length limit/i);
    assert.doesNotMatch(res.json.error, /temporarily unavailable|in a moment/i, 'the sentence that cannot help');
  });

  it('★ the same spend is reported over the REAL wire, not only for a hand-thrown error', async () => {
    const owner = await registerOwner(api, tracker);
    respond = { status: 200, body: EMPTY_AT_THE_CAP, contentType: 'application/json' };

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'How many products are completely out of stock?' },
    });
    assert.equal(res.status, 502, 'positive control: the request really reached the gateway');
    assert.equal(hits, 2, 'the limit is retried once before it is reported');

    // The whole chain: stub gateway → postJson → parseAnthropicResponse → AiOutputLimit →
    // the service's catch → the cost line. A hand-thrown error would prove only the last hop.
    const cost = logLines.find((l) => l.includes('AI turn') && l.includes('AI_OUTPUT_LIMIT'));
    assert.ok(cost, 'the turn must report itself');
    assert.match(cost, /in=1200 out=800/, 'the gateway reported 1200 in / 800 out and the line must carry it');
    assert.match(cost, /model=stub-model/, 'the model that spent the cap is named');
  });

  it('leaves no conversation and no message behind when the limit is hit', async () => {
    const owner = await registerOwner(api, tracker);
    respond = { status: 200, body: EMPTY_AT_THE_CAP, contentType: 'application/json' };

    const res = await api('POST', '/api/ai/chat', { token: owner.token, body: { message: 'anything at all' } });
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'AI_OUTPUT_LIMIT');

    // Phase 07E / M7 still holds: nothing is persisted until an answer exists.
    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 0, 'a turn that could not answer must leave no thread behind');
  });

  it('an AI-layer limit raised inside the loop reaches the client unchanged', async () => {
    // The service's catch must let this class through untouched. If it did not, the
    // error would be rewrapped as AiProviderError and the member would be told the
    // service was unavailable — the defect, one layer up from where it started.
    const owner = await registerOwner(api, tracker);
    process.env.AI_PROVIDER = 'fake';
    try {
      setFakeScenario(() => {
        throw new AiOutputLimit();
      });
      const res = await api('POST', '/api/ai/chat', { token: owner.token, body: { message: 'anything at all' } });
      assert.equal(res.status, 502);
      assert.equal(res.json.code, 'AI_OUTPUT_LIMIT');
    } finally {
      process.env.AI_PROVIDER = 'openrouter';
    }
  });

  it('a real provider failure still answers 502 AI_UNAVAILABLE — the new class did not swallow the old one', async () => {
    const owner = await registerOwner(api, tracker);
    respond = { status: 500, body: '{"error":"upstream exploded"}', contentType: 'application/json' };

    const res = await api('POST', '/api/ai/chat', { token: owner.token, body: { message: 'anything at all' } });

    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'AI_UNAVAILABLE');
    assert.notEqual(res.json.code, 'AI_OUTPUT_LIMIT', 'an outage is not a limit');
    assert.doesNotMatch(res.json.error, /out of room|length limit/i);
  });
});
