// AI-107 — one turn at a time per conversation.
//
// WHY. The AI route is rate-limited per user, but a window limiter admits several requests at
// once; two devices, a retry, or a hand-built client could run two turns for the SAME conversation.
// That can append two answers, spend two provider turns, and leave the thread in an order nobody
// asked for. This suite pins the guard's boundary and every release path.
//
// WHAT IS PINNED HERE:
//   * the DB-free middleware: same user + same conversation is refused with 409
//     AI_TURN_IN_PROGRESS, while another conversation, another user and a new-chat request are
//     independent;
//   * release on finish, close and the bounded safety hold, so a completed, failed, aborted or
//     dropped request can never wedge a conversation;
//   * over the real route: the second request is refused before the provider is called, while a
//     different conversation still answers; success and failure each release the slot.

import { EventEmitter } from 'node:events';

import { it, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { AiProviderError } from '../src/services/ai/aiErrors.ts';
import {
  AI_TURN_IN_PROGRESS_MESSAGE,
  createAiSingleFlight,
} from '../src/services/ai/singleFlight.ts';
import { registerFakeProvider, setFakeScenario, fakeText, lastUserMessage } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.headers = {};
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function fakeRequest(userId, conversationId) {
  return {
    user: { id: userId },
    body: conversationId === undefined ? {} : { conversationId },
    ip: '127.0.0.1',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

unitSuite('AI-107 single-flight middleware', () => {
  it('refuses a second turn for the same user and conversation, then releases on finish', () => {
    const guard = createAiSingleFlight();
    let admitted = 0;
    const first = fakeResponse();
    guard(fakeRequest('user-1', 'conversation-1'), first, () => {
      admitted += 1;
    });

    const second = fakeResponse();
    guard(fakeRequest('user-1', 'conversation-1'), second, () => {
      admitted += 1;
    });
    assert.equal(admitted, 1);
    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.body, {
      error: AI_TURN_IN_PROGRESS_MESSAGE,
      code: 'AI_TURN_IN_PROGRESS',
    });
    assert.equal(second.headers['Cache-Control'], 'no-store');
    assert.match(AI_TURN_IN_PROGRESS_MESSAGE, /still answering your previous message/i);

    first.emit('finish');
    guard(fakeRequest('user-1', 'conversation-1'), fakeResponse(), () => {
      admitted += 1;
    });
    assert.equal(admitted, 2);
  });

  it('keeps conversations, users and new-chat requests independent', () => {
    const guard = createAiSingleFlight();
    let admitted = 0;
    const admit = (req) => {
      guard(req, fakeResponse(), () => {
        admitted += 1;
      });
    };

    admit(fakeRequest('user-1', 'conversation-1'));
    admit(fakeRequest('user-1', 'conversation-2'));
    admit(fakeRequest('user-2', 'conversation-1'));
    admit(fakeRequest('user-1', undefined));
    assert.equal(admitted, 4);

    // New-chat requests share the `new` key: a second is still one active new chat.
    const duplicateNew = fakeResponse();
    guard(fakeRequest('user-1', undefined), duplicateNew, () => {
      admitted += 1;
    });
    assert.equal(admitted, 4);
    assert.equal(duplicateNew.statusCode, 409);
  });

  it('releases on close and after a bounded hold even when no response event arrives', async () => {
    const guard = createAiSingleFlight();
    let admitted = 0;
    const first = fakeResponse();
    guard(fakeRequest('user-1', 'conversation-close'), first, () => {
      admitted += 1;
    });
    first.emit('close');
    guard(fakeRequest('user-1', 'conversation-close'), fakeResponse(), () => {
      admitted += 1;
    });
    assert.equal(admitted, 2);

    const shortHold = createAiSingleFlight({ maxHoldMs: 20 });
    shortHold(fakeRequest('user-1', 'conversation-hold'), fakeResponse(), () => {
      admitted += 1;
    });
    const blocked = fakeResponse();
    shortHold(fakeRequest('user-1', 'conversation-hold'), blocked, () => {
      admitted += 1;
    });
    assert.equal(blocked.statusCode, 409);
    await sleep(35);
    shortHold(fakeRequest('user-1', 'conversation-hold'), fakeResponse(), () => {
      admitted += 1;
    });
    assert.equal(admitted, 4);
  });
});

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

afterEach(() => {
  setFakeScenario(null);
});

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('AI-107 the real route admits one turn per conversation', dbOk, () => {
  let gate;
  let release;
  let started;
  let startFirst;

  beforeEach(() => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
    started = new Promise((resolve) => {
      startFirst = resolve;
    });
  });

  it('refuses the duplicate before the provider, answers another conversation, and releases on success', async () => {
    const owner = await registerOwner(api, tracker);
    const a = await api('POST', '/api/ai/conversations', {
      token: owner.token,
      body: { title: 'single flight A' },
    });
    const b = await api('POST', '/api/ai/conversations', {
      token: owner.token,
      body: { title: 'single flight B' },
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const conversationA = a.json.conversation.id;
    const conversationB = b.json.conversation.id;

    let providerCalls = 0;
    setFakeScenario(async (ctx) => {
      providerCalls += 1;
      const text = lastUserMessage(ctx);
      if (text === 'First question') {
        startFirst();
        await gate;
        return fakeText('First answer');
      }
      return fakeText(`Answer to: ${text}`);
    });

    const first = api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId: conversationA, message: 'First question' },
    });
    await started;

    const duplicate = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId: conversationA, message: 'Duplicate question' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.code, 'AI_TURN_IN_PROGRESS');
    assert.equal(duplicate.json.error, AI_TURN_IN_PROGRESS_MESSAGE);
    assert.equal(providerCalls, 1);

    const other = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId: conversationB, message: 'Other conversation' },
    });
    assert.equal(other.status, 201);
    assert.equal(providerCalls, 2);

    release();
    const firstResult = await first;
    assert.equal(firstResult.status, 201);

    const afterSuccess = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId: conversationA, message: 'After success' },
    });
    assert.equal(afterSuccess.status, 201);
  });

  it('releases after a failed turn so the next send can run', async () => {
    const owner = await registerOwner(api, tracker);
    const conversation = await api('POST', '/api/ai/conversations', {
      token: owner.token,
      body: { title: 'single flight failure' },
    });
    const conversationId = conversation.json.conversation.id;
    let calls = 0;
    setFakeScenario(() => {
      calls += 1;
      if (calls === 1) throw new AiProviderError('The AI service returned an error. Please try again.');
      return fakeText('Recovered answer');
    });

    const failed = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId, message: 'Fail once' },
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.code, 'AI_UNAVAILABLE');

    const recovered = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { conversationId, message: 'Try again' },
    });
    assert.equal(recovered.status, 201);
    assert.equal(calls, 2);
  });

  it('releases after the client aborts, so an abandoned turn cannot wedge the conversation', async () => {
    const owner = await registerOwner(api, tracker);
    const conversation = await api('POST', '/api/ai/conversations', {
      token: owner.token,
      body: { title: 'single flight abort' },
    });
    const conversationId = conversation.json.conversation.id;

    setFakeScenario(async (ctx) => {
      if (lastUserMessage(ctx) === 'Slow question') {
        startFirst();
        await gate;
        return fakeText('Abandoned answer');
      }
      return fakeText('After abort');
    });

    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ conversationId, message: 'Slow question' }),
      signal: controller.signal,
    }).catch((error) => error);
    await started;
    controller.abort();
    const aborted = await pending;
    assert(aborted instanceof Error);

    let afterAbort;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      afterAbort = await api('POST', '/api/ai/chat', {
        token: owner.token,
        body: { conversationId, message: 'After abort' },
      });
      if (afterAbort.status !== 409) break;
      await sleep(25);
    }
    assert.equal(afterAbort.status, 201);

    release();
    await sleep(50);
  });
});
