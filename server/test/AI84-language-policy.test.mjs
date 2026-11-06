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
//   * recorded names, codes and numbers are preserved rather than translated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

test('AI-84: the prompt requires the member\'s language', () => {
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
