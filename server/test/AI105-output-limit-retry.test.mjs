// AI-105 — the one output-limit retry reserves answer space.
//
// The measured 10k failure spent the entire 1,200-token cap on mandatory reasoning on
// two attempts, with no text and no tool call. The fix is deliberately scoped: ordinary
// turns keep AI_MAX_OUTPUT_TOKENS, while the retry asks for a larger cap and, on a paid
// model, an explicit reasoning budget that leaves the original amount for the answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { AiOutputLimit } from '../src/services/ai/aiErrors.ts';
import { ROLES } from '../src/constants/roles.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

test('AI-105: the retry uses a larger cap and a paid-model reasoning budget, then answers', async () => {
  process.env.AI_PROVIDER = 'fake';
  registerFakeProvider();
  const original = aiConfig().maxOutputTokens;
  let calls = 0;
  let secondRequest = null;
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    setFakeScenario((ctx) => {
      calls += 1;
      if (calls === 1) {
        throw new AiOutputLimit(undefined, { model: 'openai/gpt-oss-20b' });
      }
      secondRequest = ctx;
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
    setFakeScenario(null);
    process.env.AI_PROVIDER = 'openrouter';
  }

  assert.equal(calls, 2, 'one retry, never a third attempt');
  assert.equal(result.content, 'here is the answer.');
  assert.equal(secondRequest.maxOutputTokens, original + Math.max(original, 1200));
  assert.equal(secondRequest.reasoningBudgetTokens, Math.max(1024, original));
  assert.notEqual(secondRequest.maxOutputTokens, original, 'the configured normal cap is untouched');
});

test('AI-105: a free-model limit does not enable reasoning on the retry', async () => {
  process.env.AI_PROVIDER = 'fake';
  registerFakeProvider();
  let calls = 0;
  let secondRequest = null;
  const warn = console.warn;
  console.warn = () => {};
  try {
    setFakeScenario((ctx) => {
      calls += 1;
      if (calls === 1) {
        throw new AiOutputLimit(undefined, { model: 'nvidia/nemotron-3.5-lightning:free' });
      }
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
    setFakeScenario(null);
    process.env.AI_PROVIDER = 'openrouter';
  }

  assert.equal(calls, 2);
  assert.ok(secondRequest.maxOutputTokens > aiConfig().maxOutputTokens);
  assert.equal(secondRequest.reasoningBudgetTokens, undefined, 'the free switch stays off');
});

test('AI-105: the retry trims a long same-thread history but keeps the current turn', async () => {
  process.env.AI_PROVIDER = 'fake';
  registerFakeProvider();
  // The production failure had ten prior exchanges (the 20-message context cap),
  // ending with the count answer that the compound question followed. The old retry
  // replayed all 20 messages; this test pins the bounded retry context.
  const history = [];
  for (let i = 0; i < 9; i += 1) {
    history.push({ role: 'user', content: `older question ${i}` });
    history.push({ role: 'assistant', content: `older answer ${i}` });
  }
  history.push({ role: 'user', content: 'How many products are low on stock?' });
  history.push({ role: 'assistant', content: '19 products need restocking.' });
  assert.equal(history.length, 20);

  let calls = 0;
  let secondRequest = null;
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    setFakeScenario((ctx) => {
      calls += 1;
      if (calls === 1) {
        throw new AiOutputLimit(undefined, { model: 'openai/gpt-oss-20b' });
      }
      if (calls === 2) {
        // Snapshot the request: the live `messages` array is mutated by the tool
        // round that follows, and this test is about what the RETRY was sent.
        secondRequest = { ...ctx, messages: ctx.messages.map((message) => ({ ...message })) };
        // The retry asks for the stock read, which keeps the later no-stock-read
        // guard from re-asking. The DB-free test environment returns a structured
        // TOOL_ERROR for it, but the attempted read is enough for this context test.
        return fakeCalls([{ id: 'call-1', name: 'getLowStockProducts', input: {} }]);
      }
      return fakeText('The total recorded value of the 19 low-stock items is 1,633,025.');
    });
    result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      history,
      message: 'How many products are low on stock and what is their total value?',
    });
  } finally {
    console.warn = warn;
    setFakeScenario(null);
    process.env.AI_PROVIDER = 'openrouter';
  }

  assert.equal(calls, 3, 'the output-limit retry, one tool round, then the answer');
  assert.equal(result.content, 'The total recorded value of the 19 low-stock items is 1,633,025.');
  const sent = secondRequest.messages.map((message) => message.content);
  assert.ok(sent.includes('How many products are low on stock and what is their total value?'));
  assert.ok(sent.includes('19 products need restocking.'), 'the immediate prior answer is retained');
  assert.ok(sent.includes('How many products are low on stock?'), 'the prior question is retained');
  assert.ok(!sent.includes('older question 0'), 'the rest of the long thread is not replayed');
  assert.ok(
    secondRequest.messages.length <= 6,
    `the retry keeps at most four recent history messages, current question and brief instruction; got ${secondRequest.messages.length}`,
  );
});
