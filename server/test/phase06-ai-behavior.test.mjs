// Phase 06 — AI chat behavior over the real routes with a scripted fake
// provider. Proves chat answers are DB-backed (the model's final text is built
// from real executor results, and we assert the exact numbers), multi-tool
// flows work, history carries across follow-ups, conversations/messages persist
// with the expected public shape, message length is bounded, and write requests
// are refused (no write tool exists — they surface as TOOL_NOT_FOUND soft
// results and nothing is written). DB-backed; fails loudly when MongoDB is
// unreachable (Phase 07F / M9).

import { it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import {
  registerFakeProvider,
  setFakeScenario,
  fakeText,
  fakeCalls,
  lastToolResult,
  lastUserMessage,
} from './fakes/aiProvider.mjs';

// Permissive shared limiter + fake provider for this file.
process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let biz;
let locationId;
const expect = {};

async function chat(token, body) {
  return api('POST', '/api/ai/chat', { token, body });
}

async function newProduct(business, over = {}) {
  const res = await api('POST', '/api/products', { token: business.token, body: { name: uniqueName('P'), ...over } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function newLocation(business) {
  const res = await api('POST', '/api/locations', { token: business.token, body: { name: uniqueName('Loc') } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function movement(business, type, productId, locationId, quantity) {
  const res = await api('POST', `/api/inventory/${type}`, {
    token: business.token,
    body: { productId, locationId, quantity },
  });
  const expected = type === 'stock-in' ? 201 : 200;
  assert.equal(res.status, expected, JSON.stringify(res.json));
}

async function productTotal(token) {
  const res = await api('GET', '/api/products?limit=1', { token });
  assert.equal(res.status, 200);
  return res.json.total;
}

afterEach(() => setFakeScenario(null));

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('Phase 06 — AI chat behavior', dbOk, () => {
  before(async () => {
    biz = await registerOwner(api, tracker);
    locationId = await newLocation(biz);
    // Seeds:
    //   LOW  -> available 2  (minimumStock 5)  => low only
    //   OUT  -> available 0  (minimumStock 5)  => low + out of stock
    //   FINE -> available 10 (minimumStock 3)  => healthy
    expect.low = await newProduct(biz, { sku: 'LOW', minimumStock: 5 });
    await movement(biz, 'stock-in', expect.low, locationId, 2);
    expect.out = await newProduct(biz, { sku: 'OUT', minimumStock: 5 });
    await movement(biz, 'stock-in', expect.out, locationId, 2);
    await movement(biz, 'stock-out', expect.out, locationId, 2);
    expect.fine = await newProduct(biz, { sku: 'FINE', minimumStock: 3 });
    await movement(biz, 'stock-in', expect.fine, locationId, 10);
    expect.productCount = 3;
  });

  // ---- Six sample questions, each DB-backed ----------------------------

  it('Q1 "which products are low on stock?" returns the real low-stock set', async () => {
    let turn = 0;
    // The model reads the rows but answers with only a count; the completion step must add
    // the products it failed to name. The names come from the tool result, not the test.
    const toolNames = [];
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getLowStockProducts', input: { limit: 50 } }]);
      const res = lastToolResult(ctx);
      toolNames.push(...(res.result.items || []).map((product) => product.name));
      return fakeText(`You have ${res.result.count} low-stock products.`);
    });
    const res = await chat(biz.token, { message: 'Which products are low on stock?' });
    assert.equal(res.status, 201);
    const content = res.json.assistantMessage.content;
    assert.match(content, /^You have 2 low-stock products\./);
    assert.match(content, /The full low-stock list is: /);
    assert.equal(toolNames.length, 2);
    for (const name of toolNames) {
      assert.ok(content.includes(name), `${name} must be named in the completed answer`);
    }
    assert.deepEqual(res.json.assistantMessage.toolsUsed, ['getLowStockProducts']);
  });

  it('Q2 "is anything out of stock?" returns the real out-of-stock set', async () => {
    let turn = 0;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getOutOfStockProducts', input: { limit: 50 } }]);
      const res = lastToolResult(ctx);
      const skus = (res.result.items || []).map((p) => p.sku).join(',');
      return fakeText(`Out of stock: ${skus}`);
    });
    const res = await chat(biz.token, { message: 'Is anything out of stock?' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'Out of stock: OUT');
  });

  it('Q3 "how much stock do we hold?" sums the real inventory rows', async () => {
    let turn = 0;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getInventory', input: { limit: 25 } }]);
      const res = lastToolResult(ctx);
      const qty = res.result.items.reduce((n, r) => n + r.quantity, 0);
      return fakeText(`rows=${res.result.count} qty=${qty}`);
    });
    const res = await chat(biz.token, { message: 'How much stock do we hold?' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'rows=3 qty=12');
  });

  it('Q4 a two-tool flow (search then product details) resolves one product', async () => {
    let turn = 0;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 's1', name: 'searchProducts', input: { q: 'FINE', limit: 5 } }]);
      if (turn === 2) {
        const hit = lastToolResult(ctx).result.items[0];
        return fakeCalls([{ id: 'g1', name: 'getProduct', input: { id: hit.id } }]);
      }
      const product = lastToolResult(ctx).result.product;
      return fakeText(`Found ${product.sku} with ${product.stockRows} stocked row(s)`);
    });
    const res = await chat(biz.token, { message: 'Tell me about product FINE' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'Found FINE with 1 stocked row(s)');
    assert.deepEqual(res.json.assistantMessage.toolsUsed, ['searchProducts', 'getProduct']);
  });

  it('Q5 "what has moved recently?" reflects the real transaction history', async () => {
    let turn = 0;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getInventoryHistory', input: { limit: 50 } }]);
      const res = lastToolResult(ctx);
      return fakeText(`movement-count=${res.result.count}`);
    });
    const res = await chat(biz.token, { message: 'What has moved recently?' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'movement-count=4');
  });

  it('Q6 "show inventory in the warehouse" lists that location only', async () => {
    let turn = 0;
    setFakeScenario((ctx) => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getProductsByLocation', input: { locationId } }]);
      const res = lastToolResult(ctx);
      return fakeText(`location-products=${res.result.count}`);
    });
    const res = await chat(biz.token, { message: 'Show inventory in the warehouse' });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'location-products=3');
  });

  // ---- Read-only enforcement -------------------------------------------

  it('write requests are refused: no write tool exists and nothing is written', async () => {
    const beforeCount = await productTotal(biz.token);
    let turn = 0;
    setFakeScenario(() => {
      turn += 1;
      if (turn === 1) {
        return fakeCalls([
          { id: 'w1', name: 'createProduct', input: { name: 'Brand New Thing' } },
          { id: 'w2', name: 'stockOut', input: { quantity: 99 } },
          { id: 'w3', name: 'updateProduct', input: {} },
        ]);
      }
      return fakeText('I am read-only for now — I can analyze your inventory but I cannot change it. Use the app to add products or move stock.');
    });
    const res = await chat(biz.token, { message: 'Create a product and take 99 units out of stock' });
    assert.equal(res.status, 201);
    assert.match(res.json.assistantMessage.content, /read-only/i);
    assert.deepEqual(res.json.assistantMessage.toolsUsed.sort(), ['createProduct', 'stockOut', 'updateProduct']);

    // Every attempted write surfaces as a soft TOOL_NOT_FOUND (no crash, no effect).
    const probe = await import('../src/services/ai/tools.ts');
    for (const name of ['createProduct', 'stockOut', 'updateProduct']) {
      const out = await probe.executeTool(name, {}, { businessId: biz.businessId, role: 'OWNER' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'TOOL_NOT_FOUND');
    }

    const afterCount = await productTotal(biz.token);
    assert.equal(afterCount, beforeCount, 'product catalog must be unchanged by the chat');
  });

  // ---- Context + persistence -------------------------------------------

  it('a follow-up chat in the same conversation carries prior turns', async () => {
    let seenCtx = null;
    setFakeScenario((ctx) => {
      seenCtx = ctx;
      return fakeText('first-answer');
    });
    const first = await chat(biz.token, { message: 'How is everything today?' });
    assert.equal(first.status, 201);
    const convId = first.json.conversation.id;

    setFakeScenario((ctx) => {
      seenCtx = ctx;
      return fakeText('second-answer');
    });
    const second = await chat(biz.token, { conversationId: convId, message: 'Actually, tell me more.' });
    assert.equal(second.status, 201);
    assert.equal(second.json.assistantMessage.content, 'second-answer');

    // The history handed to the provider includes the first exchange.
    const userTexts = seenCtx.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.ok(userTexts.some((t) => t === 'How is everything today?'), 'first user turn must be in history');
    assert.equal(lastUserMessage(seenCtx), 'Actually, tell me more.');

    // Both exchanges are persisted in order.
    const msgs = await api('GET', `/api/ai/conversations/${convId}/messages`, { token: biz.token });
    assert.equal(msgs.status, 200);
    assert.equal(msgs.json.total, 4);
    const roles = msgs.json.items.map((m) => m.role);
    assert.deepEqual(roles, ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    assert.equal(msgs.json.items[0].content, 'How is everything today?');
    assert.equal(msgs.json.items[2].content, 'Actually, tell me more.');
  });

  it('conversations and messages have the public shape with model/usage/tools', async () => {
    let turn = 0;
    setFakeScenario(() => {
      turn += 1;
      if (turn === 1) return fakeCalls([{ id: 'c1', name: 'getInventoryHistory', input: { limit: 5 } }]);
      return fakeText('here is recent history');
    });
    const res = await chat(biz.token, { message: 'recent history?' });
    assert.equal(res.status, 201);
    const conv = res.json.conversation;
    assert.deepEqual(Object.keys(conv).sort(), ['createdAt', 'id', 'title', 'updatedAt']);

    const user = res.json.userMessage;
    assert.deepEqual(Object.keys(user).sort(), ['content', 'conversationId', 'createdAt', 'id', 'role']);

    const assistant = res.json.assistantMessage;
    assert.equal(assistant.model, 'fake-model');
    assert.deepEqual(assistant.toolsUsed, ['getInventoryHistory']);
    assert.equal(typeof assistant.usage.inputTokens, 'number');
    assert.equal(typeof assistant.usage.outputTokens, 'number');

    const msgs = await api('GET', `/api/ai/conversations/${conv.id}/messages`, { token: biz.token });
    assert.equal(msgs.json.total, 2);
    assert.equal(msgs.json.items[1].role, 'ASSISTANT');
    assert.equal(msgs.json.items[1].content, 'here is recent history');
  });

  it('an empty conversation can be created and later listed with no messages', async () => {
    const created = await api('POST', '/api/ai/conversations', {
      token: biz.token,
      body: { title: 'Planning chat' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.conversation.title, 'Planning chat');

    const list = await api('GET', '/api/ai/conversations', { token: biz.token });
    assert.equal(list.status, 200);
    assert.equal(list.json.total >= 1, true);
    assert.ok(list.json.items.some((c) => c.id === created.json.conversation.id));

    const msgs = await api('GET', `/api/ai/conversations/${created.json.conversation.id}/messages`, { token: biz.token });
    assert.equal(msgs.status, 200);
    assert.equal(msgs.json.total, 0);
  });

  // ---- Input bounding ---------------------------------------------------

  it('over-long messages are rejected (400 VALIDATION_ERROR) before any AI call', async () => {
    let called = false;
    setFakeScenario(() => {
      called = true;
      return fakeText('should not run');
    });
    const long = 'x'.repeat(5001);
    const res = await chat(biz.token, { message: long });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'VALIDATION_ERROR');
    assert.ok(res.json.fields.some((f) => f.field === 'message'));
    assert.equal(called, false, 'the provider must not be called for an over-long message');
  });
});
