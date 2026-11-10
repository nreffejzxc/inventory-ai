// AI-99 — simple inventory questions start on the FREE fallback model.
//
// WHY THIS SUITE EXISTS. The free-request allowance is a different budget from the paid
// credits, and the five simplest inventory questions (a product's stock, whether it exists,
// what needs restocking, what is low, how many those are) should spend the free one first.
// The risk is not that the free model is slower; it is that a weaker model answers before
// it reads, or does the arithmetic itself. The route therefore keeps the SAME tool loop and
// adds three guarantees this file pins:
//
//   * only a `:free` fallback that declares tool support can start a simple turn;
//   * a draft written without the required read is discarded — re-asked once on the free
//     model, then escalated to the paid primary in the SAME turn;
//   * a free-model quota refusal falls forward to the paid primary once, because the free
//     daily allowance is not the paid credit balance;
//   * the final count and stock total come from the returned rows, never the model.
//
// Nothing here spends provider quota: the provider is the in-process fake.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runAiChat } from '../src/services/ai/ai.service.ts';
import {
  AI_UNAVAILABLE,
  AiOutputLimit,
  AiProviderError,
  AiQuotaExceeded,
  AiTimeout,
} from '../src/services/ai/aiErrors.ts';
import { ROLES } from '../src/constants/roles.ts';
import { recordModelFailure, resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelCapabilities } from '../src/services/ai/modelCapabilities.ts';
import {
  selectSimpleModel,
  simpleInventoryIntent,
  simpleInventoryPrompt,
  simpleInventoryToolInput,
} from '../src/services/ai/simpleInventory.ts';
import {
  reserveSimplePaidFallback,
  resetSimplePaidBudget,
  settleSimplePaidFallback,
  simplePaidBudgetSnapshot,
} from '../src/services/ai/simplePaidBudget.ts';
import {
  asksForProductStockTotal,
  productStockTotalAnswer,
  productDetailStockRead,
  asksForRestockCount,
  asksForRestockList,
  restockCountAnswer,
} from '../src/services/ai/answerCompletion.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'openrouter';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider('openrouter');

const PRIMARY = 'fake-model';
const FREE = 'free-model:free';
const FREE_2 = 'free-model-two:free';
const RESEARCH = 'research-model';

/**
 * Run one turn with the logs captured and the fake provider's requested model exposed.
 * Every value this suite reads is per-turn: no model is left configured for the next case.
 */
async function runTurn(scenario, { message, fallback = `${FREE},${FREE_2}`, research = null } = {}) {
  const lines = [];
  const seen = [];
  const systems = [];
  const timeouts = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => lines.push(args.join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const saved = {};
  for (const key of [
    'AI_PROVIDER',
    'AI_MODEL_OPENROUTER',
    'AI_FALLBACK_MODELS_OPENROUTER',
    'AI_RESEARCH_MODEL_OPENROUTER',
    'AI_REASONING_PAID_MODELS',
    'AI_REASONING',
    'AI_REASONING_FREE_MODELS',
    'AI_SIMPLE_FREE_ATTEMPT_MS',
    'AI_SIMPLE_PAID_DAILY_BUDGET_USD',
    'AI_SIMPLE_PAID_TURN_RESERVE_USD',
  ]) {
    saved[key] = process.env[key];
  }

  process.env.AI_PROVIDER = 'openrouter';
  process.env.AI_MODEL_OPENROUTER = PRIMARY;
  delete process.env.AI_REASONING_PAID_MODELS;
  delete process.env.AI_REASONING;
  delete process.env.AI_REASONING_FREE_MODELS;
  if (fallback === null) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  else process.env.AI_FALLBACK_MODELS_OPENROUTER = fallback;
  if (research === null) delete process.env.AI_RESEARCH_MODEL_OPENROUTER;
  else process.env.AI_RESEARCH_MODEL_OPENROUTER = research;

  let result = null;
  let error = null;
  try {
    setFakeScenario((ctx) => {
      seen.push(ctx.model);
      systems.push(ctx.system);
      timeouts.push(ctx.timeoutMs);
      return scenario(ctx, seen.length);
    });
    result = await runAiChat({
      businessId: 'b-simple',
      userId: 'u-simple',
      role: ROLES.OWNER,
      message,
    });
  } catch (err) {
    error = err;
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { seen, systems, timeouts, lines, result, error };
}

afterEach(() => {
  setFakeScenario(null);
  delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  delete process.env.AI_RESEARCH_MODEL_OPENROUTER;
  delete process.env.AI_REASONING_PAID_MODELS;
  delete process.env.AI_REASONING;
  delete process.env.AI_REASONING_FREE_MODELS;
  delete process.env.AI_SIMPLE_FREE_ATTEMPT_MS;
  delete process.env.AI_SIMPLE_PAID_DAILY_BUDGET_USD;
  delete process.env.AI_SIMPLE_PAID_TURN_RESERVE_USD;
  resetSimplePaidBudget();
  resetModelBreaker();
  resetModelSelection();
  resetModelCapabilities();
});

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test('AI-99: the five simple shapes are recognised', () => {
  const simple = [
    'How many units of the Samsung 990 PRO are currently in stock?',
    'Does the Logitech MX Master 3S exist in our inventory?',
    'Which products need to be restocked?',
    'Which products are currently running low on stock?',
    'What products have reached their minimum stock levels?',
  ];
  for (const question of simple) {
    assert.ok(simpleInventoryIntent(question), question);
  }
  assert.equal(simpleInventoryIntent(simple[0]).operation, 'product_stock');
  assert.equal(simpleInventoryIntent(simple[1]).operation, 'product_existence');
  assert.equal(simpleInventoryIntent(simple[2]).operation, 'restock_list');
  assert.equal(simpleInventoryIntent(simple[3]).operation, 'restock_list');
  assert.equal(simpleInventoryIntent(simple[4]).operation, 'restock_list');
});

test('AI-99: a pure restock count is its own operation', () => {
  assert.equal(
    simpleInventoryIntent('How many products need restocking?').operation,
    'restock_count',
  );
  assert.equal(
    simpleInventoryIntent('How many products are low on stock?').operation,
    'restock_count',
  );
});

test('AI-99: an explicitly named SKU travels as an exact identifier', () => {
  const stock = simpleInventoryIntent(
    'How many units of the product with SKU SEEDSKU-42 are in stock?',
  );
  assert.equal(stock.operation, 'product_stock');
  assert.equal(stock.exactSku, 'SEEDSKU-42');

  const exists = simpleInventoryIntent(
    'Do we have the product with SKU SEEDSKU-999999 in our inventory?',
  );
  assert.equal(exists.operation, 'product_existence');
  assert.equal(exists.exactSku, 'SEEDSKU-999999');
});

test('AI-99: advanced questions stay on the existing route', () => {
  for (const question of [
    'What is the total stock value?',
    'Which products sold the most this week?',
    'Compare the Logitech MX Keys S and the Razer BlackWidow V4 Pro',
    'Find reviews for the Logitech MX Master 3S online',
    'How many units are in stock at each location?',
    'How many units are in Main Warehouse?',
    'How much stock do we hold?',
    'What is the price and stock of the Samsung 990 PRO?',
    'Recommend a product under 5000',
    'How many products do we have?',
    'Where is the Logitech MX Keys S?',
    'What is the minimum stock level of the Logitech MX Keys S?',
  ]) {
    assert.equal(simpleInventoryIntent(question), null, question);
  }
});

test('AI-99: only a tool-capable free model is selected', () => {
  assert.equal(selectSimpleModel([PRIMARY, FREE, FREE_2]), FREE);
  assert.equal(selectSimpleModel([PRIMARY, FREE_2], (id) => id !== FREE_2), null);
  assert.equal(selectSimpleModel([PRIMARY, 'free-no-tools:free'], () => false), null);
  assert.equal(selectSimpleModel([PRIMARY, 'paid-fallback']), null);
});

test('AI-99: the simple prompt names the one read and forbids extras', () => {
  const intent = simpleInventoryIntent('Which products need to be restocked?');
  const prompt = simpleInventoryPrompt(intent);
  assert.match(prompt, /SIMPLE INVENTORY READ FOR THIS TURN/);
  assert.match(prompt, /getReorderNeededProducts/);
  assert.match(prompt, /at most three sentences/);
});

test('AI-99: a simple stock total raises getInventory to its maximum page', () => {
  const intent = simpleInventoryIntent('How many units of the Logitech MX Master 3S are in stock?');
  assert.deepEqual(simpleInventoryToolInput(intent, 'getInventory', { q: 'MX Master', limit: 1 }), {
    q: 'MX Master',
    limit: 25,
  });
  assert.deepEqual(simpleInventoryToolInput(intent, 'getInventory', null), { limit: 25 });
  assert.deepEqual(simpleInventoryToolInput(intent, 'getProduct', { id: 'p1', limit: 1 }), {
    id: 'p1',
    limit: 1,
  });
  assert.deepEqual(
    simpleInventoryToolInput(
      simpleInventoryIntent('Which products need to be restocked?'),
      'getInventory',
      { limit: 1 },
    ),
    { limit: 1 },
  );
});

test('AI-99: an exact SKU replaces a substring search in getInventory', () => {
  const intent = simpleInventoryIntent(
    'How many units of the product with SKU SEEDSKU-42 are in stock?',
  );
  assert.deepEqual(
    simpleInventoryToolInput(intent, 'getInventory', { q: 'SEEDSKU-42', limit: 1 }),
    { q: 'SEEDSKU-42', limit: 25, exactSku: 'SEEDSKU-42' },
  );
  assert.deepEqual(simpleInventoryToolInput(intent, 'getInventory', null), {
    limit: 25,
    exactSku: 'SEEDSKU-42',
  });

  const exists = simpleInventoryIntent(
    'Do we have the product with SKU SEEDSKU-999999 in our inventory?',
  );
  assert.deepEqual(simpleInventoryToolInput(exists, 'getInventory', { q: 'SEEDSKU' }), {
    q: 'SEEDSKU',
    exactSku: 'SEEDSKU-999999',
  });
});

// ---------------------------------------------------------------------------
// The deterministic answer
// ---------------------------------------------------------------------------

test('AI-99: a single product total is summed from the inventory rows', () => {
  const question = 'How many units of the Logitech MX Keys S are in stock?';
  assert.equal(asksForProductStockTotal(question), true);

  const rows = [
    {
      id: 'keys',
      name: 'Logitech MX Keys S',
      locationName: 'Shop Front',
      availableQuantity: 149,
    },
    {
      id: 'keys',
      name: 'Logitech MX Keys S',
      locationName: 'Main Warehouse',
      availableQuantity: 149,
    },
  ];
  assert.equal(
    productStockTotalAnswer(rows, question, 2000),
    '**Logitech MX Keys S** has **298** units on hand across all locations.',
  );
  assert.equal(
    productStockTotalAnswer(
      rows,
      'How many units of the Logitech MX Keys S are in stock at Shop Front?',
      2000,
    ),
    '**Logitech MX Keys S** has **149** units on hand at **Shop Front**.',
  );

  // A breakdown has its own finalizer; a value question has its own tool; a page with two
  // unnamed products is not evidence about either one.
  assert.equal(
    asksForProductStockTotal('What is the stock of the MX Keys S at each location?'),
    false,
  );
  assert.equal(asksForProductStockTotal('What is the total stock value?'), false);
  assert.equal(
    productStockTotalAnswer(
      [
        { id: 'keys', name: 'Logitech MX Keys S', availableQuantity: 12 },
        { id: 'master', name: 'Logitech MX Master 3S', availableQuantity: 5 },
      ],
      'How many units are in stock?',
      2000,
    ),
    null,
  );
});

test('AI-99: a getProduct detail read yields the requested stock total', () => {
  const question = 'How many units of the product with SKU SEEDSKU-17 are in stock?';
  const product = {
    id: 'p-17',
    name: 'Samsung 990 PRO 1TB NVMe SSD',
    sku: 'SEEDSKU-17',
    sellingPrice: 8999,
    currency: 'PHP',
  };
  const read = productDetailStockRead({
    found: true,
    product: {
      ...product,
      stockRows: 3,
      stock: [
        {
          id: 'r1',
          product,
          location: { name: 'Overflow Store' },
          availableQuantity: 19,
        },
        { id: 'r2', product, location: { name: 'Shop Front' }, availableQuantity: 17 },
        { id: 'r3', product, location: { name: 'Main Warehouse' }, availableQuantity: 17 },
      ],
    },
  });

  assert.equal(read.complete, true);
  assert.equal(read.facts.length, 3);
  assert.equal(
    productStockTotalAnswer(read.facts, question, 2000),
    '**Samsung 990 PRO 1TB NVMe SSD** has **53** units on hand across all locations.',
  );

  // A detail read that returned fewer rows than it holds cannot prove a total.
  const partial = productDetailStockRead({
    found: true,
    product: { ...product, stockRows: 25, stock: [{ product, availableQuantity: 1 }] },
  });
  assert.equal(partial.complete, false);

  // An absent product has no rows and no total.
  const missing = productDetailStockRead({ found: false });
  assert.equal(missing.complete, true);
  assert.deepEqual(missing.facts, []);
});

test('AI-99: a restock count comes from the tool total, not a page', () => {
  assert.equal(asksForRestockCount('How many products need restocking?'), true);
  assert.equal(asksForRestockCount('How many products are low on stock?'), true);
  assert.equal(asksForRestockCount('Which products need restocking?'), false);
  assert.equal(asksForRestockCount('How many products need restocking and name three?'), false);
  assert.equal(restockCountAnswer(3, 2000), '3 products need restocking.');
  assert.equal(restockCountAnswer(1, 2000), '1 product needs restocking.');
  assert.equal(restockCountAnswer(0, 2000), 'No products need restocking right now.');
  // The list predicate must understand the wording members actually use, without turning a
  // product's recorded minimum into a restock list.
  assert.equal(asksForRestockList('What products have reached their minimum stock levels?'), true);
  assert.equal(asksForRestockList('What is the minimum stock level of the MX Keys S?'), false);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test('AI-99: a simple question starts free, re-asks free, then escalates to the paid primary', async () => {
  const { seen, systems, lines, result, error } = await runTurn(
    (ctx, call) => fakeText(call === 1 ? 'Let me look that up.' : 'I could not read that.'),
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );

  assert.equal(error, null);
  assert.deepEqual(
    seen,
    [FREE, FREE, PRIMARY],
    'the free model gets one re-ask, then the paid primary finishes the turn',
  );
  assert.match(systems[0], /SIMPLE INVENTORY READ FOR THIS TURN/);
  assert.match(systems[0], /getInventory/);
  assert.ok(lines.some((line) => line.includes('route=simple')));
  assert.ok(
    lines.some(
      (line) =>
        line.includes('free-model reasoning=disabled') &&
        line.includes('env=AI_REASONING_FREE_MODELS') &&
        line.includes(`freeModel=${FREE}`),
    ),
    'every submitted question states the effective free-model policy',
  );
  assert.ok(lines.some((line) => line.includes('escalating to the paid primary')));
  // The invented draft must never ship, and neither may an ungrounded "there are none".
  assert.match(result.content, /could not read that from your records/);
});

test('AI-99: an ordinary turn keeps the configured model and prompt', async () => {
  const { seen, systems } = await runTurn(() => fakeText('Hello! How can I help?'), {
    message: 'Hello, what can you do?',
  });
  assert.equal(seen[0], undefined, 'the configured model stays the source of truth');
  assert.doesNotMatch(systems[0], /SIMPLE INVENTORY READ FOR THIS TURN/);
});

test('AI-99: without a free fallback the turn is unchanged', async () => {
  const { seen } = await runTurn(() => fakeText('ok'), {
    message: 'How many units of the Logitech MX Keys S are in stock?',
    fallback: 'paid-fallback',
  });
  assert.equal(seen[0], undefined);
});

test('AI-99: research still starts on the research model, never the free one', async () => {
  const { seen } = await runTurn(() => fakeText('Some sources.'), {
    message:
      'Compare the Logitech MX Keys S and Razer BlackWidow V4 Pro and find reviews online.',
    research: RESEARCH,
  });
  assert.equal(seen[0], RESEARCH);
  assert.ok(!seen.includes(FREE), 'a research turn must not spend the simple route');
});

test('AI-99: a free-model quota refusal falls forward to the paid primary once', async () => {
  const seen = [];
  const { lines, result, error } = await runTurn(
    (ctx) => {
      seen.push(ctx.model);
      if (ctx.model === FREE) throw new AiQuotaExceeded();
      return fakeText('I could not read that.');
    },
    { message: 'Which products need to be restocked?' },
  );

  assert.equal(error, null, 'an exhausted free allowance must not fail the whole turn');
  assert.equal(seen[0], FREE);
  assert.equal(seen[1], PRIMARY, 'the paid primary answers when the free allowance is spent');
  assert.ok(lines.some((line) => line.includes('falling forward to the paid primary once')));
  assert.match(result.content, /could not read/);
});

test('AI-99: repeated free-model quota refusals fall forward on every turn', async () => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const seen = [];
    const { lines, result, error } = await runTurn(
      (ctx) => {
        seen.push(ctx.model);
        if (ctx.model === FREE) throw new AiQuotaExceeded();
        return fakeText('I could not read that.');
      },
      { message: 'Which products need to be restocked?' },
    );

    assert.equal(error, null, `turn ${attempt} must not fail when the free allowance is spent`);
    assert.equal(seen[0], FREE, `turn ${attempt} must start on the free model`);
    assert.equal(seen[1], PRIMARY, `turn ${attempt} must fall forward to the paid primary`);
    assert.equal(
      seen.filter((model) => model === FREE).length,
      1,
      `turn ${attempt} must not retry the exhausted free allowance`,
    );
    assert.ok(
      lines.some((line) => line.includes('refused by quota — falling forward to the paid primary once')),
      `turn ${attempt} must record the quota fall-forward`,
    );
    assert.match(result.content, /could not read/);
  }
});

test('AI-99: a free-model timeout falls back to the paid primary', async () => {
  process.env.AI_SIMPLE_FREE_ATTEMPT_MS = '25';
  process.env.AI_SIMPLE_PAID_DAILY_BUDGET_USD = '0.25';
  process.env.AI_SIMPLE_PAID_TURN_RESERVE_USD = '0.01';
  const { seen, timeouts, lines, result, error } = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) throw new AiTimeout('the free attempt expired');
      return fakeText('I could not read that.');
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );

  assert.equal(error, null);
  assert.equal(seen[0], FREE);
  assert.equal(seen[1], PRIMARY, 'the paid primary answers after the free timeout');
  assert.ok(timeouts[0] <= 100, `the free attempt was capped at ${timeouts[0]}ms`);
  assert.ok(timeouts[1] > 100, `the paid attempt kept the turn budget (${timeouts[1]}ms)`);
  assert.ok(lines.some((line) => line.includes('falling back to the paid primary once')));
  assert.match(result.content, /could not read/);
  assert.ok(
    Math.abs(simplePaidBudgetSnapshot().spentUsd - 0.01) < 1e-9,
    'a paid fallback with no reported cost charges the reservation',
  );
});

test('AI-99: the daily paid budget reserves, settles and rolls at UTC midnight', () => {
  const at = Date.UTC(2026, 0, 1, 12);
  resetSimplePaidBudget(at);

  const first = reserveSimplePaidFallback({
    dailyBudgetUsd: 0.01,
    turnReserveUsd: 0.006,
    now: at,
  });
  assert.equal(first.ok, true);
  settleSimplePaidFallback(first.reservation, 0.004, at);
  assert.equal(simplePaidBudgetSnapshot(at).spentUsd, 0.004);

  const second = reserveSimplePaidFallback({
    dailyBudgetUsd: 0.01,
    turnReserveUsd: 0.006,
    now: at,
  });
  assert.equal(second.ok, true, 'the second reservation fits exactly');
  settleSimplePaidFallback(second.reservation, 0.006, at);
  assert.equal(simplePaidBudgetSnapshot(at).spentUsd, 0.01);

  const blocked = reserveSimplePaidFallback({
    dailyBudgetUsd: 0.01,
    turnReserveUsd: 0.006,
    now: at,
  });
  assert.equal(blocked.ok, false);

  const nextDay = reserveSimplePaidFallback({
    dailyBudgetUsd: 0.01,
    turnReserveUsd: 0.006,
    now: at + 24 * 60 * 60 * 1000,
  });
  assert.equal(nextDay.ok, true, 'the UTC day boundary starts a fresh budget');
  resetSimplePaidBudget();
});

test('AI-99: the paid fallback stops before another provider call at the daily budget', async () => {
  process.env.AI_SIMPLE_PAID_DAILY_BUDGET_USD = '0.01';
  process.env.AI_SIMPLE_PAID_TURN_RESERVE_USD = '0.006';
  resetSimplePaidBudget();

  const first = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) throw new AiTimeout('the free attempt expired');
      return fakeText('I could not read that.', {
        usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.004 },
      });
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );
  assert.equal(first.error, null);
  assert.ok(
    Math.abs(simplePaidBudgetSnapshot().spentUsd - 0.008) < 1e-9,
    'the paid turn settles both actual provider calls',
  );

  const second = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) throw new AiTimeout('the free attempt expired');
      return fakeText('I could not read that.', {
        usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.004 },
      });
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );
  assert.equal(second.error?.code, 'AI_QUOTA_EXCEEDED');
  assert.deepEqual(second.seen, [FREE], 'the blocked turn must not call the paid primary');
  assert.ok(
    second.lines.some((line) => line.includes('paid fallback blocked by daily budget')),
    'the guard records why the paid call was refused',
  );
});

test('AI-99: a simple turn forced to start on the paid model is still guarded', async () => {
  process.env.AI_SIMPLE_PAID_DAILY_BUDGET_USD = '0';
  recordModelFailure(FREE, Date.now(), { threshold: 1, cooldownMs: 60_000 });

  const result = await runTurn(() => fakeText('I could not read that.'), {
    message: 'How many units of the Logitech MX Keys S are in stock?',
  });
  assert.equal(result.error?.code, 'AI_QUOTA_EXCEEDED');
  assert.deepEqual(result.seen, [], 'the paid start must be refused before any provider call');
});

test('AI-99: a model-specific failover to the paid primary is guarded too', async () => {
  process.env.AI_SIMPLE_PAID_DAILY_BUDGET_USD = '0';

  const result = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) {
        throw new AiProviderError(
          'The AI service could not be reached.',
          AI_UNAVAILABLE,
          503,
        );
      }
      return fakeText('I could not read that.');
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );
  assert.equal(result.error?.code, 'AI_QUOTA_EXCEEDED');
  assert.deepEqual(result.seen, [FREE], 'the paid candidate must not be called');
});

test('AI-99: a free-model output-limit falls back to the paid primary', async () => {
  const { seen, lines, result, error } = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) throw new AiOutputLimit();
      return fakeText('I could not read that.');
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );

  assert.equal(error, null);
  assert.equal(seen[0], FREE);
  assert.equal(seen[1], PRIMARY, 'the paid primary answers after the free output limit');
  assert.ok(lines.some((line) => line.includes('falling back to the paid primary once')));
  assert.match(result.content, /could not read/);
});

test('AI-99: a free-model empty completion falls back to the paid primary', async () => {
  const { seen, lines, result, error } = await runTurn(
    (ctx) => {
      if (ctx.model === FREE) {
        return {
          model: FREE,
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      }
      return fakeText('I could not read that.');
    },
    { message: 'How many units of the Logitech MX Keys S are in stock?' },
  );

  assert.equal(error, null);
  assert.equal(seen[0], FREE);
  assert.equal(seen[1], PRIMARY, 'the paid primary answers after the empty free completion');
  assert.ok(lines.some((line) => line.includes('falling back to the paid primary once')));
  assert.match(result.content, /could not read/);
});
