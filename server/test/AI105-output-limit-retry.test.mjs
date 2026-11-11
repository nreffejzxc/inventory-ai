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
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

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
