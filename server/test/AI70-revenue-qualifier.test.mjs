/**
 * AI-70 — the revenue qualification is the server's sentence, so its arrival is a property.
 *
 * WHY THESE TESTS: measured on the phone (2026-11-05 6:23 PM) the assistant answered "PHP 68,975
 * in revenue this week", built by multiplying recorded selling price by units out. Nothing in the
 * product records a sale price, invoice or customer, and a STOCK_OUT can be usage or damage, so
 * the figure is an estimate presented as revenue. Re-asking the model for the wording cost the
 * whole step budget and returned "I could not finish that request within the allowed number of
 * steps" (6:27 PM), so the server appends the sentence itself. That makes two things worth
 * pinning: the sentence is present, and it is still present after the answer cap, since the cap
 * is applied after the model stops and would otherwise slice the note off a long answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForRevenue,
  statesUnqualifiedMoney,
  withRevenueQualifier,
} from '../src/services/ai/answerCompletion.ts';

const NOTE =
  'Note: this is an estimate, not recorded revenue. The app tracks stock movements, not sale prices, invoices or customers.';

test('AI-70: the note sits below the answer, separated by a blank line', () => {
  const out = withRevenueQualifier('PHP 68,975 in revenue this week.', NOTE, 4000);
  assert.equal(out, `PHP 68,975 in revenue this week.\n\n${NOTE}`);
});

test('AI-70: a long answer keeps the note whole instead of losing it to the cap', () => {
  const body = 'row '.repeat(1250).trimEnd(); // 4,999 chars — longer than cap minus the note
  const cap = 4000;
  const out = withRevenueQualifier(body, NOTE, cap);
  assert.ok(out.length <= cap, `answer must fit the cap, got ${out.length}`);
  assert.ok(out.endsWith(NOTE), 'the note must be the last thing in the answer');
  assert.ok(out.includes('…'), 'the body is what gets cut, and it is marked as cut');
});

test('AI-70: an answer that already carries the note is not given it twice', () => {
  const once = withRevenueQualifier('PHP 68,975 in recorded revenue.', NOTE, 4000);
  assert.equal(withRevenueQualifier(once, NOTE, 4000), once);
});

test('AI-70: an empty answer still carries the qualification', () => {
  assert.equal(withRevenueQualifier('', NOTE, 4000), NOTE);
});

test('AI-70: the note alone is returned when there is no room for a body', () => {
  assert.equal(withRevenueQualifier('PHP 1,000 in revenue.', NOTE, NOTE.length + 10), NOTE);
});

test('AI-70: a qualified figure is not flagged, so no note is added', () => {
  const qualified = 'An estimated PHP 68,975 at recorded prices; the app does not track revenue.';
  assert.equal(asksForRevenue('How much revenue did we make this week'), true);
  assert.equal(statesUnqualifiedMoney(qualified), false);
  const unqualified = 'PHP 68,975 in revenue this week.';
  assert.equal(statesUnqualifiedMoney(unqualified), true);
});
