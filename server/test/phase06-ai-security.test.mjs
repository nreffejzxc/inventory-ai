// Phase 06 — AI security over the real HTTP routes. Proves that businessId
// always comes from the authenticated session (never the request body), that
// conversations/messages are isolated per business AND per user, that STAFF
// permissions are enforced on the tools inside a live chat, and that client
// responses carry no secrets. DB-backed; fails loudly when MongoDB is
// unreachable (Phase 07F / M9).

import { it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import AIConversation from '../src/models/aiConversation.model.ts';
import {
  registerFakeProvider,
  setFakeScenario,
  fakeText,
  fakeCalls,
  toolResults,
} from './fakes/aiProvider.mjs';

// Permissive shared limiter + fake provider for this file.
process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let ownerA;
let ownerB;
let staff;

async function chat(token, body) {
  return api('POST', '/api/ai/chat', { token, body });
}

async function newProduct(business) {
  const res = await api('POST', '/api/products', { token: business.token, body: { currency: 'PHP', name: uniqueName('P') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

afterEach(() => setFakeScenario(null));

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 06 — AI security', dbOk, () => {
  before(async () => {
    ownerA = await registerOwner(api, tracker);
    ownerB = await registerOwner(api, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: ownerA.businessId }, tracker);
    // Give Business A real data so a leaked/forbidden summary would be visible.
    await newProduct(ownerA);
    await newProduct(ownerA);
  });

  it('chat requires authentication (401) even before provider config matters', async () => {
    const res = await chat(undefined, { message: 'hello' });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'AUTH_REQUIRED');
  });

  it('a client-supplied businessId is ignored — the session wins', async () => {
    setFakeScenario(() => fakeText('scoped'));
    const res = await chat(ownerA.token, {
      message: 'tell me about anything',
      businessId: ownerB.businessId, // attacker tries to read/pretend Business B
    });
    assert.equal(res.status, 201);
    const conv = res.json.conversation;
    assert.ok(conv.id);
    // Public DTO must not expose ownership fields to the client.
    assert.deepEqual(Object.keys(conv).sort(), ['createdAt', 'id', 'title', 'updatedAt']);

    // The conversation really lives under ownerA's business.
    const doc = await AIConversation.findOne({ _id: conv.id });
    assert.equal(String(doc.businessId), ownerA.businessId);
    assert.equal(String(doc.userId), ownerA.userId);

    // And Business B cannot see it anywhere.
    const bList = await api('GET', '/api/ai/conversations', { token: ownerB.token });
    assert.equal(bList.status, 200);
    assert.equal(bList.json.total, 0);
  });

  it('conversations never cross users (same business) or businesses', async () => {
    setFakeScenario(() => fakeText('mine'));
    const a = await chat(ownerA.token, { message: 'create mine' });
    assert.equal(a.status, 201);
    const convA = a.json.conversation.id;

    // A different business owner cannot read it and does not see it listed.
    const bRead = await api('GET', `/api/ai/conversations/${convA}/messages`, { token: ownerB.token });
    assert.equal(bRead.status, 404);
    assert.equal(bRead.json.code, 'NOT_FOUND');

    // A different user of the SAME business (staff) cannot read it either.
    const staffRead = await api('GET', `/api/ai/conversations/${convA}/messages`, { token: staff.token });
    assert.equal(staffRead.status, 404);

    // staff starts their own conversation in the same business.
    const staffChat = await chat(staff.token, { message: 'staff conversation' });
    assert.equal(staffChat.status, 201);
    const staffConv = staffChat.json.conversation.id;

    // ownerA's list contains their own conversation but never staff's.
    const aList = await api('GET', '/api/ai/conversations', { token: ownerA.token });
    assert.equal(aList.status, 200);
    assert.ok(aList.json.items.some((c) => c.id === convA));
    assert.ok(!aList.json.items.some((c) => c.id === staffConv), 'ownerA must not see staff conversations');

    // staff's list contains their own conversation but never ownerA's.
    const staffList = await api('GET', '/api/ai/conversations', { token: staff.token });
    assert.ok(staffList.json.items.some((c) => c.id === staffConv));
    assert.ok(!staffList.json.items.some((c) => c.id === convA), 'staff must not see ownerA conversations');
  });

  it('cannot continue a conversation that is not yours (chat 404)', async () => {
    setFakeScenario(() => fakeText('nope'));
    const a = await chat(ownerA.token, { message: 'seed' });
    const convA = a.json.conversation.id;
    const res = await chat(ownerB.token, { conversationId: convA, message: 'continue yours?' });
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'NOT_FOUND');
  });

  it('STAFF permissions are enforced on tools inside a live chat', async () => {
    let lastCtx = null;
    let turn = 0;
    setFakeScenario((ctx) => {
      lastCtx = ctx;
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'g1', name: 'getInventorySummary', input: {} }]);
      return fakeText('summary-denied');
    });

    const res = await chat(staff.token, { message: 'what is my inventory summary?' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'summary-denied');
    assert.ok(res.json.assistantMessage.toolsUsed.includes('getInventorySummary'));

    // The tool layer returned a structured TOOL_FORBIDDEN result, so the model
    // saw no Business A numbers.
    const results = toolResults(lastCtx);
    const summaryResult = results.find((r) => r && r.code === 'TOOL_FORBIDDEN');
    assert.ok(summaryResult, 'expected a TOOL_FORBIDDEN soft result');
    assert.equal(summaryResult.error.includes('summary') || summaryResult.error.includes('dashboard'), false);
    assert.equal(summaryResult.error.includes('getInventorySummary'), true);
  });

  it('client error bodies are secret-free across config/provider failures', async () => {
    // Unset provider -> 503 body must not echo key names/values or URIs.
    const prevProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = '';
    try {
      const res = await chat(ownerA.token, { message: 'hi' });
      assert.equal(res.status, 503);
      const text = JSON.stringify(res.json).toLowerCase();
      for (const leak of ['anthropic', 'generativelanguage', 'apikey', 'mongodb']) {
        assert.ok(!text.includes(leak), `503 body leaked "${leak}"`);
      }
    } finally {
      process.env.AI_PROVIDER = prevProvider;
    }
  });

  it('an assistant response never contains internal keys, even on tool errors', async () => {
    let lastCtx = null;
    setFakeScenario((ctx) => {
      lastCtx = ctx;
      return fakeText('I cannot see that data.');
    });
    const res = await chat(ownerA.token, { message: 'ok' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'I cannot see that data.');
    const stored = JSON.stringify(res.json);
    for (const leak of ['businessId', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'passwordHash']) {
      assert.ok(!stored.toLowerCase().includes(leak.toLowerCase()), `response leaked "${leak}"`);
    }
    // The provider sees exactly one message for a first turn: the current user
    // message alone, no duplicated history and no tool state (Phase 07E / M6).
    const userTurns = lastCtx.messages.filter((m) => m.role === 'user');
    assert.equal(lastCtx.messages.length, 1, 'system/history/user only — no tool state leaks into later turns');
    assert.equal(userTurns.length, 1, 'the current user message is sent exactly once');
    assert.equal(userTurns[0].content, 'ok');
  });
});
