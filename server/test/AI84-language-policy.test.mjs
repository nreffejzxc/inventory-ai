// AI-84 — the assistant must answer in the language the member used.
//
// WHY THIS EXISTS. In the 14-question Bisaya/Tagalog control on 2026-11-06,
// only 4 of 14 replies followed the question's language: most switched to
// English, and one Bisaya question was answered in Tagalog. The system prompt
// described the inventory rules in detail but never told the model to keep the
// member's language, so English tool output and app labels became the reply
// language by default.
//
// WHAT THIS SUITE PINS:
//   * replies follow the latest message's language;
//   * Bisaya/Cebuano and Tagalog/Filipino are treated as different languages;
//   * English tool output is not a reason to switch the reply to English;
//   * recorded names, codes and numbers are preserved rather than translated;
//   * a Bisaya/Tagalog turn carries a direct answer-language instruction, while
//     an English turn is byte-for-byte unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, runAiChat } from '../src/services/ai/ai.service.ts';
import { languageDirective, replyLanguageOf } from '../src/services/ai/language.ts';
import { simpleInventoryPrompt } from '../src/services/ai/simpleInventory.ts';
import { restockCountAnswer } from '../src/services/ai/answerCompletion.ts';
import { ROLES } from '../src/constants/roles.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

test("AI-84: the prompt requires the member's language", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /Reply in the language of the member's latest message/i);
  assert.match(prompt, /English for English/i);
  assert.match(prompt, /Tagalog\/Filipino for Tagalog/i);
  assert.match(prompt, /Bisaya\/Cebuano for Bisaya/i);
});

test('AI-84: Bisaya and Tagalog are not interchangeable', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /never answer a Bisaya question in Tagalog or a Tagalog question in Bisaya/i);
});

test('AI-84: English tool output does not change the reply language', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /Do not switch to English because tool results, product names, field labels or the rest of the app are in English/i);
  assert.match(prompt, /keep product names, SKUs, codes, numbers, URLs and necessary technical terms exactly as recorded/i);
});

const BISAYA = [
  'Pila ka units ang naa sa stock?',
  'Unsa ang mga produkto nga ubos na ang stock?',
  'Asa nako makita ang mga nawala nga stock?',
  'Kinsa ang nagpalit sa tanan nga stock?',
  'Ngano nga dili na makita ang produkto?',
];

const TAGALOG = [
  'Ilan ang natitira sa stock?',
  'Ano ang mga produktong mababa ang stock?',
  'Saan ko makikita ang mga nawawalang stock?',
  'Bakit hindi available ang presyo?',
  'Magkano ang kabuuang halaga ng stock?',
];

const ENGLISH = [
  'Which products are low on stock?',
  'What is the total value of our inventory at Main Warehouse?',
];

test('AI-84: Bisaya questions are classified as Bisaya, not Tagalog', () => {
  for (const question of BISAYA) {
    assert.equal(replyLanguageOf(question), 'Bisaya', question);
  }
});

test('AI-84: Tagalog questions are classified as Tagalog, not Bisaya', () => {
  for (const question of TAGALOG) {
    assert.equal(replyLanguageOf(question), 'Tagalog', question);
  }
});

test('AI-84: English questions add no language directive and stay unchanged', () => {
  for (const question of ENGLISH) {
    assert.equal(replyLanguageOf(question), null, question);
    assert.equal(languageDirective(question), null, question);
  }
});

test('AI-84: the directive names the exact language and protects recorded facts', () => {
  const bisaya = languageDirective('Pila ka units ang naa sa stock?');
  assert.match(bisaya, /Bisaya\/Cebuano/);
  assert.match(bisaya, /entire answer/i);
  assert.match(bisaya, /product names, SKUs, codes, numbers, URLs/i);
  assert.match(bisaya, /do not translate them or invent anything/i);

  const tagalog = languageDirective('Ilan ang natitira sa stock?');
  assert.match(tagalog, /Tagalog\/Filipino/);
  assert.doesNotMatch(tagalog, /Bisaya/);
});

test('AI-84: the deterministic restock count answers in the question language', () => {
  assert.equal(restockCountAnswer(19, 1000, 'Tagalog'), 'May 19 na produktong mababa ang stock.');
  assert.equal(restockCountAnswer(19, 1000, 'Bisaya'), 'Adunay 19 ka produkto nga ubos ang stock.');
  assert.equal(restockCountAnswer(19, 1000, null), '19 products need restocking.');
  assert.equal(restockCountAnswer(0, 1000, 'Tagalog'), 'Wala nang produktong mababa ang stock ngayon.');
  assert.equal(restockCountAnswer(0, 1000, 'Bisaya'), 'Wala nay produktong ubos ang stock karon.');
  assert.equal(restockCountAnswer(19, 10, 'Tagalog'), null);
});

test('AI-84: the simple route carries the same language lock', () => {
  const intent = { operation: 'restock_count', readTools: ['getLowStockProducts'] };
  const bisaya = simpleInventoryPrompt(intent, 'Pila ka produkto ang ubos na?');
  assert.match(bisaya, /LANGUAGE FOR THIS ANSWER: the member wrote in Bisaya\/Cebuano/);
  const english = simpleInventoryPrompt(intent, 'How many products are low on stock?');
  assert.doesNotMatch(english, /LANGUAGE FOR THIS ANSWER/);
});

test('AI-84: a Bisaya turn reaches the provider with the directive in the system prompt', async () => {
  process.env.AI_PROVIDER = 'fake';
  registerFakeProvider();
  let captured = null;
  try {
    setFakeScenario((ctx) => {
      captured = ctx;
      return fakeText('Ako ang inventory assistant.');
    });
    await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message: 'Unsa ang imong ngalan?',
    });
  } finally {
    setFakeScenario(null);
    process.env.AI_PROVIDER = 'openrouter';
  }

  assert.ok(captured, 'the fake provider was called');
  assert.match(captured.system, /LANGUAGE FOR THIS ANSWER: the member wrote in Bisaya\/Cebuano/);
  assert.match(captured.system, /Do not answer in English or in the other Philippine language/);
});
