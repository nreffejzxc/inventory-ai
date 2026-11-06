// Phase 07E — AI correctness & reliability hardening (M6 + M7).
//
// M6 (message deduplication): the current user message must reach the provider
// EXACTLY once. Prior history is loaded from the DB BEFORE the current turn is
// persisted, and the AI service appends the current message itself — so a turn
// can never appear twice by being both in persisted history and appended.
//
// M7 (provider failure & conversation persistence): nothing is written until
// the provider has produced a final answer. A provider failure therefore leaves
// no empty conversation, no orphaned USER message and no misleading ASSISTANT
// reply; retrying is a fresh, predictable attempt that reuses the same
// conversationId when one was supplied.
//
// Two parts:
//   * DB-free unit tests that ALWAYS run — provider message shape, tool-call
//     context and the Anthropic wire mapping, with no database and
//     no real credentials.
//   * DB-gated integration tests over the real routes (Cases A–D from the M7
//     brief) plus conversationId ownership semantics. DB-gated: fails loudly
//     when MongoDB is unreachable (Phase 07F / M9).

import { it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { AIConversation, AIMessage } from '../src/models/index.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { toAnthropicMessages } from '../src/services/ai/providers/anthropicWire.ts';
import { AiProviderError } from '../src/services/ai/aiErrors.ts';
import {
  registerFakeProvider,
  setFakeScenario,
  fakeText,
  fakeCalls,
  lastUserMessage,
  lastToolResult,
} from './fakes/aiProvider.mjs';

// Permissive shared limiter + fake provider for this file.
process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

afterEach(() => setFakeScenario(null));

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

// Count how many times a user message with `content` appears in a provider ctx.
function countUserMessage(ctx, content) {
  return ctx.messages.filter((m) => m.role === 'user' && m.content === content).length;
}

function rolesOf(ctx) {
  return ctx.messages.map((m) => m.role);
}

// ---------------------------------------------------------------------------
// M6 — service-level message shape (no database, no credentials required)
// ---------------------------------------------------------------------------
unitSuite('M6 provider message shape (Phase 07E, DB-free)', () => {
  it('a first turn reaches the provider as exactly one user message', async () => {
    let seen = null;
    setFakeScenario((ctx) => {
      seen = ctx;
      return fakeText('hello there');
    });

    const result = await runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'say hello in one sentence' });
    assert.equal(result.content, 'hello there');

    // The provider saw one and only one message: the current user message.
    assert.equal(seen.messages.length, 1);
    assert.equal(rolesOf(seen)[0], 'user');
    assert.equal(countUserMessage(seen, 'say hello in one sentence'), 1);
    assert.equal(lastUserMessage(seen), 'say hello in one sentence');
  });

  it('prior Q/A turns are preserved in order and the follow-up is sent exactly once', async () => {
    let seen = null;
    setFakeScenario((ctx) => {
      seen = ctx;
      return fakeText('ok');
    });

    const history = [
      { role: 'user', content: 'turn-1' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'turn-2' },
      { role: 'assistant', content: 'reply-2' },
    ];
    await runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, history, message: 'turn-3' });

    // History intact, then exactly one copy of the new message appended.
    assert.equal(seen.messages.length, 5);
    assert.deepEqual(
      seen.messages.map((m) => ({ role: m.role, content: m.content })),
      [
        { role: 'user', content: 'turn-1' },
        { role: 'assistant', content: 'reply-1' },
        { role: 'user', content: 'turn-2' },
        { role: 'assistant', content: 'reply-2' },
        { role: 'user', content: 'turn-3' },
      ]
    );
    assert.equal(countUserMessage(seen, 'turn-3'), 1, 'the current message is never duplicated');
  });

  it('tool-call context stays well-formed around the single current user message (unknown tool, no DB)', async () => {
    let turn = 0;
    let secondTurnCtx = null;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'g1', name: 'ghostTool', input: { limit: 5 } }]);
      secondTurnCtx = ctx;
      return fakeText('final');
    });

    const result = await runAiChat({ businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER, message: 'probe' });
    assert.equal(result.content, 'final');
    assert.deepEqual(result.toolsUsed, ['ghostTool']);

    // Second provider call saw exactly: current user, assistant(toolCall), tool(result).
    const ctx = secondTurnCtx;
    assert.deepEqual(rolesOf(ctx), ['user', 'assistant', 'tool'], 'roles alternate user->assistant->tool');
    assert.equal(countUserMessage(ctx, 'probe'), 1, 'the current user message appears exactly once');
    assert.equal(ctx.messages[1].content, '');
    assert.equal(ctx.messages[1].toolCalls[0].id, 'g1');
    assert.equal(ctx.messages[1].toolCalls[0].name, 'ghostTool');
    assert.deepEqual(ctx.messages[1].toolCalls[0].input, { limit: 5 });
    assert.equal(ctx.messages[2].name, 'ghostTool');
    assert.equal(ctx.messages[2].toolCallId, 'g1');

    // Unknown tool -> structured TOOL_NOT_FOUND soft result (no DB/permission path).
    const toolResult = lastToolResult(ctx);
    assert.equal(toolResult.code, 'TOOL_NOT_FOUND');
  });

  it('maps the deduplicated tool context to a well-formed Anthropic payload', async () => {
    // The exact neutral message sequence runAiChat emits for a tool turn
    // (produced by the previous test) mapped through the Anthropic wire:
    const neutral = [
      { role: 'user', content: 'probe' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'ghostTool', input: { limit: 5 } }] },
      { role: 'tool', name: 'ghostTool', toolCallId: 'g1', content: '{"ok":false,"code":"TOOL_NOT_FOUND"}' },
    ];

    const wire = toAnthropicMessages(neutral);
    assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'user'], 'Anthropic roles alternate cleanly');
    assert.equal(wire[0].content, 'probe');
    assert.equal(wire[1].content[0].type, 'tool_use');
    assert.equal(wire[1].content[0].name, 'ghostTool');
    assert.equal(wire[2].content[0].type, 'tool_result');
    assert.equal(wire[2].content[0].tool_use_id, 'g1');
    assert.equal(wire[2].content[0].content.includes('TOOL_NOT_FOUND'), true);

    // No empty-content assistant block survives; the user text appears exactly once.
    assert.ok(wire.every((m) => Array.isArray(m.content) ? m.content.length > 0 : m.content !== ''));
    const plainTexts = wire.filter((m) => typeof m.content === 'string').map((m) => m.content);
    assert.equal(plainTexts.filter((t) => t === 'probe').length, 1);
  });

  it('a model error notice is re-asked, never shown as the answer', async () => {
    let turn = 0;
    let retryCtx = null;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeText('[ERROR: Max turns exceeded]');
      retryCtx = ctx;
      return fakeText('I can help with that.');
    });

    const result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'say hello in one sentence',
    });

    assert.equal(turn, 2, 'the error notice is retried once');
    assert.equal(result.content, 'I can help with that.');
    assert.ok(
      retryCtx.messages.some((m) => m.role === 'user' && /error notice/i.test(String(m.content))),
      'the retry tells the model the previous reply was not an answer',
    );
  });

  it('an error notice that never clears becomes the honest degraded sentence', async () => {
    setFakeScenario(() => fakeText('[ERROR: Max turns exceeded]'));

    const result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'say hello in one sentence',
    });

    assert.equal(result.degraded, 'UNGROUNDED_ANSWER');
    assert.doesNotMatch(result.content, /max turns|\[ERROR/i);
    assert.match(result.content, /could not read that from your records/i);
  });
});

// ---------------------------------------------------------------------------
// M6 + M7 — real HTTP routes, real persistence (Cases A–D)
// ---------------------------------------------------------------------------
dbSuite('Phase 07E — M6/M7 over the real routes', dbOk, () => {
  before(async () => {
    await registerOwner(api, tracker);
  });

  function chat(token, body) {
    return api('POST', '/api/ai/chat', { token, body });
  }

  /** Fresh owner so each case starts with a clean business (isolated counts). */
  async function freshOwner() {
    return registerOwner(api, tracker);
  }

  /** Conversation + message state for a business, straight from the models. */
  async function stateFor(businessId) {
    const convs = await AIConversation.find({ businessId }).sort({ createdAt: 1, _id: 1 }).lean();
    const ids = convs.map((c) => c._id);
    const msgs = ids.length
      ? await AIMessage.find({ conversationId: { $in: ids } }).sort({ createdAt: 1, _id: 1 }).lean()
      : [];
    return {
      conversationCount: convs.length,
      conversations: convs,
      messages: msgs,
    };
  }

  async function seededOwner(seedMessage) {
    const owner = await freshOwner();
    setFakeScenario(() => fakeText('seed-reply'));
    const res = await chat(owner.token, { message: seedMessage });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return { owner, conversationId: res.json.conversation.id };
  }

  it('M6: a normal first message is sent exactly once and persists one USER+ASSISTANT pair', async () => {
    const owner = await freshOwner();
    let ctx = null;
    setFakeScenario((c) => {
      ctx = c;
      return fakeText('reply');
    });

    const res = await chat(owner.token, { message: 'first hello' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(res.json.conversation.id, 'response returns a conversationId');
    assert.equal(res.json.userMessage.content, 'first hello');
    assert.equal(res.json.assistantMessage.content, 'reply');

    // Exactly one user message reached the provider (no duplicated history).
    assert.equal(ctx.messages.length, 1, 'provider got exactly one message');
    assert.equal(countUserMessage(ctx, 'first hello'), 1);
    assert.equal(lastUserMessage(ctx), 'first hello');

    // Persisted: one conversation, one USER + one ASSISTANT.
    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 1);
    assert.deepEqual(state.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
    assert.equal(state.messages[0].content, 'first hello');
  });

  it('M6: a follow-up in an existing conversation is sent once with prior turns preserved in order', async () => {
    const { owner, conversationId } = await seededOwner('turn-a');

    const seenCtxs = [];
    setFakeScenario((c) => {
      seenCtxs.push(c);
      return fakeText('reply-b');
    });
    const res = await chat(owner.token, { conversationId, message: 'turn-b' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.conversation.id, conversationId, 'existing conversation is reused');
    assert.equal(res.json.userMessage.content, 'turn-b');

    // Provider context for the follow-up: [user turn-a, assistant seed-reply, user turn-b].
    const ctx = seenCtxs[seenCtxs.length - 1];
    assert.equal(ctx.messages.length, 3, 'prior turns + one current turn');
    assert.deepEqual(
      ctx.messages.map((m) => ({ role: m.role, content: m.content })),
      [
        { role: 'user', content: 'turn-a' },
        { role: 'assistant', content: 'seed-reply' },
        { role: 'user', content: 'turn-b' },
      ]
    );
    assert.equal(countUserMessage(ctx, 'turn-a'), 1, 'prior user turn appears once');
    assert.equal(countUserMessage(ctx, 'turn-b'), 1, 'the current message is never duplicated');

    // Persisted in order: USER,ASSISTANT,USER,ASSISTANT.
    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 1, 'still one conversation');
    assert.deepEqual(state.messages.map((m) => m.role), ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    assert.deepEqual(
      state.messages.filter((m) => m.role === 'USER').map((m) => m.content),
      ['turn-a', 'turn-b']
    );
  });

  it('M7 Case A: a successful first message creates the conversation + both messages and the id is reused', async () => {
    const owner = await freshOwner();
    setFakeScenario(() => fakeText('case-a'));

    const first = await chat(owner.token, { message: 'question one' });
    assert.equal(first.status, 201);
    const conversationId = first.json.conversation.id;
    assert.ok(conversationId);

    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 1);
    assert.equal(state.messages.length, 2);
    assert.deepEqual(state.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
    assert.equal(state.messages[1].content, 'case-a');

    // The returned id works for a second turn on the same conversation.
    const second = await chat(owner.token, { conversationId, message: 'question two' });
    assert.equal(second.status, 201);
    assert.equal(second.json.conversation.id, conversationId);
    const after = await stateFor(owner.businessId);
    assert.equal(after.conversationCount, 1, 'no duplicate conversation');
    assert.equal(after.messages.length, 4);
  });

  it('M7 Case B: a failed FIRST attempt writes nothing; retry creates exactly one clean conversation', async () => {
    const owner = await freshOwner();

    setFakeScenario(() => {
      throw new AiProviderError('upstream boom');
    });
    const fail = await chat(owner.token, { message: 'question' });
    assert.equal(fail.status, 502, JSON.stringify(fail.json));
    assert.equal(fail.json.code, 'AI_UNAVAILABLE');
    // The 502 body is the fixed, sanitized message — the provider's own error
    // text never reaches the client, and no credential/internal markers appear.
    assert.equal(fail.json.error, 'The AI service is temporarily unavailable. Please try again in a moment.');
    const failText = JSON.stringify(fail.json).toLowerCase();
    assert.ok(!failText.includes('upstream boom'), 'upstream error text must not reach the client');
    for (const leak of ['mongodb', 'apikey', 'anthropic_api_key', 'gemini_api_key', 'password']) {
      assert.ok(!failText.includes(leak), `failure body leaked "${leak}"`);
    }

    // Nothing persisted — no empty conversation, no orphaned USER, no fake ASSISTANT.
    const empty = await stateFor(owner.businessId);
    assert.equal(empty.conversationCount, 0, 'no conversation after a failed first message');
    assert.equal(empty.messages.length, 0, 'no messages after a failed first message');

    // Retry the same request: exactly one conversation with a normal turn.
    setFakeScenario(() => fakeText('now-it-works'));
    const retry = await chat(owner.token, { message: 'question' });
    assert.equal(retry.status, 201, JSON.stringify(retry.json));
    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 1, 'retry created exactly one conversation');
    assert.equal(state.messages.length, 2);
    assert.deepEqual(state.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
    assert.equal(state.messages[0].content, 'question');
  });

  it('M7 Case C: a failure in an EXISTING conversation corrupts nothing and retry reuses the same id', async () => {
    const { owner, conversationId } = await seededOwner('seed-q');

    // This attempt fails mid-turn. Nothing may be appended.
    setFakeScenario(() => {
      throw new AiProviderError('upstream boom');
    });
    const fail = await chat(owner.token, { conversationId, message: 'failing-turn' });
    assert.equal(fail.status, 502, JSON.stringify(fail.json));
    assert.equal(fail.json.code, 'AI_UNAVAILABLE');

    // Conversation + messages unchanged: no new USER, no misleading ASSISTANT.
    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 1, 'no new/duplicate conversation');
    assert.equal(state.messages.length, 2, 'failed turn wrote nothing');
    assert.deepEqual(state.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
    assert.equal(state.messages[1].content, 'seed-reply', 'last stored turn is still the real assistant reply');

    // Retry on the SAME id appends exactly one turn.
    setFakeScenario(() => fakeText('recovered'));
    const retry = await chat(owner.token, { conversationId, message: 'failing-turn' });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.conversation.id, conversationId, 'retry reuses the same conversationId');
    const after = await stateFor(owner.businessId);
    assert.equal(after.conversationCount, 1);
    assert.deepEqual(after.messages.map((m) => m.role), ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    assert.deepEqual(
      after.messages.filter((m) => m.role === 'USER').map((m) => m.content),
      ['seed-q', 'failing-turn']
    );
  });

  it('M7 Case D: repeated failures never proliferate conversations or messages', async () => {
    const owner = await freshOwner();

    setFakeScenario(() => {
      throw new AiProviderError('boom again');
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await chat(owner.token, { message: `attempt ${i}` });
      assert.equal(res.status, 502);
      assert.equal(res.json.code, 'AI_UNAVAILABLE');
    }
    const state = await stateFor(owner.businessId);
    assert.equal(state.conversationCount, 0, 'repeated failures leave zero conversations');
    assert.equal(state.messages.length, 0, 'repeated failures leave zero messages');

    // A later success still lands exactly one conversation.
    setFakeScenario(() => fakeText('eventually'));
    const ok = await chat(owner.token, { message: 'attempt now' });
    assert.equal(ok.status, 201);
    const after = await stateFor(owner.businessId);
    assert.equal(after.conversationCount, 1);
    assert.equal(after.messages.length, 2);
  });

  it('conversationId semantics: cross-business reuse fails safely with 404 and writes nothing', async () => {
    const other = await freshOwner();
    const { owner, conversationId } = await seededOwner('mine');

    // The other business cannot continue owner's conversation.
    setFakeScenario(() => fakeText('nope'));
    const res = await chat(other.token, { conversationId, message: 'continue yours?' });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.equal(res.json.code, 'NOT_FOUND');

    // Nothing was written under the other business...
    const otherState = await stateFor(other.businessId);
    assert.equal(otherState.conversationCount, 0, 'foreign conversation id created nothing for the caller');
    assert.equal(otherState.messages.length, 0);

    // ...and the owner's original conversation is untouched.
    const ownerState = await stateFor(owner.businessId);
    assert.equal(ownerState.conversationCount, 1);
    assert.equal(ownerState.messages.length, 2);

    // A client-supplied businessId on the foreign call is ignored entirely.
    const forged = await chat(other.token, {
      conversationId,
      message: 'forged business id',
      businessId: owner.businessId,
    });
    assert.equal(forged.status, 404, 'businessId in the body never overrides the session');
  });
});
