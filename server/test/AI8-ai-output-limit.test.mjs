// AI-8 — an answer the output cap cut in half is marked incomplete, instead of being
// stored and served as though it had finished.
//
// THE DEFECT (ISS-29). Found on the device 2026-10-14: the low-stock answer's `out=800`
// was exactly `AI_MAX_OUTPUT_TOKENS` and its body ended mid-list —
// `3. Ultra Sponge 18982 - available 2` — yet it was persisted and rendered as a
// complete answer. The guard in `parseAnthropicResponse` throws only when
// `stop_reason === 'max_tokens'` **and there is no text**, so by construction a
// truncation that carried any text passed straight through, unmarked, and neither the
// log nor the HTTP response said anything. A member cannot tell a stopped answer from a
// finished one, and the operator cannot count the rate.
//
// WHY THE FIX KEEPS THE TEXT. The other two degraded reasons replace the answer with a
// sentence because there IS no answer. Here there is one, and it is useful: the first
// rows of a list are exactly what was asked for. So `OUTPUT_LIMIT` keeps the partial
// text and only *marks* it — which is why the reason is a third member of
// `DegradedReason` but deliberately NOT a member of the canned-sentence table.
//
// WHERE THE SENTENCE LIVES. The other two reasons own their copy server-side because the
// copy IS the answer the user reads. This reason's copy is an annotation under an intact
// answer, so it belongs to the surface that draws it (mobile); the server's contract is
// the machine-readable reason. Splitting it this way is what keeps the stored content the
// model's own words.
//
// WHAT THIS SUITE PINS:
//   * the wire reports a truncated completion at all (both provider shapes);
//   * a truncated answer keeps its text, is marked `OUTPUT_LIMIT`, and never becomes the
//     canned sentence;
//   * the mark survives persistence and comes back on reload, so a thread reopened later
//     is not silently cleaner than the screen that produced it;
//   * the existing two reasons are unchanged (guards: they pass before this change too);
//   * a truncated TOOL ROUND does not mark a turn whose final answer completed — the flag
//     is about the answer, not about any response in the turn.

import { it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { parseAnthropicResponse } from '../src/services/ai/providers/anthropicWire.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
// Permissive limiter: several turns are issued from one user below.
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
});

/** Run one turn and capture the degradation warning the service emits, if any. */
async function ask(scenario) {
  setFakeScenario(scenario);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'which products are low on stock?',
    });
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

unitSuite('AI-8 a truncated answer is marked (DB-free)', () => {
  it('the wire reports the truncation at all — which is what the cap looks like', () => {
    // Before this, `stop_reason` was read only to decide whether to THROW, so the
    // information that the answer was cut off was discarded on every path that carried
    // any text. Nothing downstream could have marked it.
    const cut = parseAnthropicResponse({
      content: [{ type: 'text', text: '3. Ultra Sponge 18982 - available 2' }],
      stop_reason: 'max_tokens',
      model: 'test-model',
    });
    assert.equal(cut.truncated, true, 'a max_tokens stop is the cap, and must be visible');
    assert.equal(cut.text, '3. Ultra Sponge 18982 - available 2', 'the partial text is still the text');

    const finished = parseAnthropicResponse({
      content: [{ type: 'text', text: 'Nothing is low.' }],
      stop_reason: 'end_turn',
      model: 'test-model',
    });
    assert.ok(!finished.truncated, 'a normal stop is not a truncation');
  });

  it('still refuses a truncated response that carries nothing usable', () => {
    // A guard, not a driver: the throw is about a response with no text and no tool
    // call, and widening the marker must not turn that failure into a success. The
    // CLASS is AI-10's (an output limit, not a provider error); what AI-8 owns here is
    // that the refusal still happens at all.
    assert.throws(
      () => parseAnthropicResponse({ content: [], stop_reason: 'max_tokens' }),
      (err) => err.name === 'AiOutputLimit' && err.code === 'AI_OUTPUT_LIMIT',
    );
  });

  it('★ keeps the partial answer, marks the turn, and never substitutes a sentence', async () => {
    // THE headline behaviour. Before AI-8 this turn was indistinguishable from a complete
    // one — same 201, same stored content, no mark anywhere.
    const { result } = await ask(() => fakeText('1. Everyday Towel 60624 - available 416', { truncated: true }));

    assert.equal(
      result.content,
      '1. Everyday Towel 60624 - available 416',
      'a partial answer is an answer: the text the member can use must survive',
    );
    assert.equal(result.degraded, 'OUTPUT_LIMIT', 'and the turn must say what happened to it');
  });

  it('names the reason in the one greppable degraded line', async () => {
    const { warnings } = await ask(() => fakeText('1. something', { truncated: true }));

    const lines = warnings.filter((w) => w.includes('AI degraded turn'));
    assert.equal(lines.length, 1, 'exactly one line per degraded turn');
    assert.match(lines[0], /reason=OUTPUT_LIMIT/, 'the rate must be countable by reason');
  });

  it('a healthy turn is not marked and logs no degraded line', async () => {
    const { result, warnings } = await ask(() => fakeText('Nothing is low on stock.'));

    assert.equal(result.degraded, undefined, 'absent, not null — a healthy turn stays distinguishable');
    assert.equal(
      warnings.filter((w) => w.includes('AI degraded turn')).length,
      0,
      'a complete answer must not be reported as degraded',
    );
  });

  it('does not mark a turn whose final answer completed, even if a tool round was cut off', async () => {
    // The flag is about the ANSWER. The loop asks for data, one round hits the cap, the
    // model is told so (and the loop continues), and the final answer is complete: the
    // member has everything they asked for, and marking it would be a false alarm.
    const { result } = await ask((_ctx, n) =>
      n === 1
        ? { ...fakeCalls([{ id: 'call-1', name: 'noSuchTool', input: {} }]), truncated: true }
        : fakeText('Nothing is low on stock.'),
    );

    assert.equal(result.content, 'Nothing is low on stock.');
    assert.equal(result.degraded, undefined, 'a complete answer is complete, however it was reached');
  });

  it('leaves the two canned reasons exactly as they were', async () => {
    const empty = await ask(() => fakeText(''));
    assert.equal(empty.result.degraded, 'EMPTY_COMPLETION');
    assert.match(empty.result.content, /could not generate a response/i);

    const steps = await ask(() => fakeCalls([{ id: 'call-x', name: 'noSuchTool', input: {} }]));
    assert.equal(steps.result.degraded, 'ITERATION_LIMIT');
    assert.match(steps.result.content, /could not finish that request/i);
  });
});

// ---------------------------------------------------------------------------
// The wire contract: the mark has to survive the round trip. A stored answer that
// reloads without it would make an old thread look more trustworthy than the screen
// that produced it — the same reasoning that made AI-2 store the degraded turn.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AI-8 the mark reaches the client and the store', dbOk, () => {
  it('★ answers 201 with degraded=OUTPUT_LIMIT and stores the partial answer as incomplete', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText('1. Everyday Towel 60624 - available 416', { truncated: true }));

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'which products are low on stock?' },
    });

    assert.equal(res.status, 201, 'a truncated answer is a completed turn, not an error');
    assert.equal(res.json.degraded, 'OUTPUT_LIMIT');
    assert.equal(
      res.json.assistantMessage.content,
      '1. Everyday Towel 60624 - available 416',
      'the partial answer is what the member read, so it is what must be stored',
    );

    // The reload: the same thread, read back from the database.
    const conversationId = res.json.conversation.id;
    const messages = await api('GET', `/api/ai/conversations/${conversationId}/messages`, {
      token: owner.token,
    });
    assert.equal(messages.status, 200);
    const stored = messages.json.items.find((m) => m.role === 'ASSISTANT');
    assert.ok(stored, 'the assistant turn must be readable back');
    assert.equal(stored.content, '1. Everyday Towel 60624 - available 416');
    assert.equal(
      stored.degraded,
      'OUTPUT_LIMIT',
      'a reopened thread must keep the mark, or the store is cleaner than the screen was',
    );
  });

  it('a healthy turn stores no degraded key at all', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText('Nothing is low on stock.'));

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'is anything low?' },
    });
    assert.equal(res.status, 201);

    const messages = await api('GET', `/api/ai/conversations/${res.json.conversation.id}/messages`, {
      token: owner.token,
    });
    const stored = messages.json.items.find((m) => m.role === 'ASSISTANT');
    assert.ok(stored);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(stored, 'degraded'),
      'absent, not null — a complete answer must stay distinguishable on reload too',
    );
  });
});
