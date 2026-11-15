// AI-113 — the highest-stock answer is a server ranking, not the first page of an inventory read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForRestockList,
  asksForRestockCount,
  asksForRestockShortfall,
  asksForHighestStockQuantity,
  highestStockQuantityAnswer,
  restockShortfallAnswer,
} from '../src/services/ai/answerCompletion.ts';
import { aiToolsById } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const row = (id, name, availableQuantity, sku = null) => ({ id, name, availableQuantity, sku });

test('AI-113: highest-stock wording is recognised, and the lookalike questions are not', () => {
  for (const question of [
    'Which products have the highest stock?',
    'What are our largest stock quantities?',
    'Show me the top products by stock',
    'Which product has the most units on hand?',
    'What is the highest stock at Main Warehouse?',
    'top 3 products by stock',
  ]) {
    assert.equal(asksForHighestStockQuantity(question), true, question);
  }
  for (const question of [
    'What is the highest stock value?',
    'Which product sold the most units?',
    'What is low on stock?',
    'How many units are in stock?',
    'Which products have the highest stock and what is their value?',
  ]) {
    assert.equal(asksForHighestStockQuantity(question), false, question);
  }
});

test('AI-113: the answer ranks the rows itself and never trusts their order', () => {
  const answer = highestStockQuantityAnswer(
    [row('p1', 'Mug', 4), row('p2', 'Kettle', 120), row('p3', 'Cable', 37), row('p4', 'Mug', 4)],
    40,
    500,
    'Which products have the highest stock?',
  );
  assert.ok(answer);
  assert.match(answer, /Top 3 of 40 products with stock:/);
  assert.match(answer, /1\. \*\*Kettle\*\* — 120 units/);
  assert.match(answer, /2\. \*\*Cable\*\* — 37 units/);
  assert.match(answer, /3\. \*\*Mug\*\* — 4 units/);
  assert.equal(answer.match(/\*\*Mug\*\*/g)?.length, 1);
});

test('AI-113: a singular question returns the one winner, and a top-N question honors N', () => {
  const rows = [row('p1', 'Mug', 4), row('p2', 'Kettle', 120), row('p3', 'Cable', 37)];
  const one = highestStockQuantityAnswer(rows, 3, 500, 'Which product has the highest stock?');
  assert.ok(one);
  assert.match(one, /^The product with the highest stock is:/);
  assert.match(one, /\*\*Kettle\*\* — 120 units/);
  assert.doesNotMatch(one, /Cable/);

  const three = highestStockQuantityAnswer(rows, 3, 500, 'top 3 products by stock');
  assert.ok(three);
  assert.match(three, /The products with the highest stock are:/);
  assert.match(three, /3\. \*\*Mug\*\*/);
});

test('AI-113: a location-scoped ranking says which place it describes', () => {
  const answer = highestStockQuantityAnswer(
    [row('p1', 'Kettle', 12)],
    1,
    500,
    'What is the highest stock at Main Warehouse?',
    'Main Warehouse',
  );
  assert.ok(answer);
  assert.match(answer, /^The product with the highest stock at Main Warehouse is:/);
});

test('AI-113: malformed rows cannot become a ranking', () => {
  assert.equal(
    highestStockQuantityAnswer(
      [{ name: 'No quantity' }, { name: 'Negative', availableQuantity: -2 }, null],
      10,
      500,
      'highest stock',
    ),
    null,
  );
});

test('AI-113: a unit-shortfall question is not answered with a product count', () => {
  const question = 'How many units do we need to restock in total?';
  assert.equal(asksForRestockShortfall(question), true);
  assert.equal(asksForRestockCount(question), false);
  assert.equal(asksForRestockList(question), false);
  assert.equal(asksForRestockCount('How many products need restocking?'), true);

  assert.equal(
    restockShortfallAnswer(240, 19, 300),
    '19 products need restocking, with a combined gap of 240 units to their configured minimums.',
  );
  assert.equal(restockShortfallAnswer(0, 0, 300), 'No products need restocking right now.');
  assert.equal(restockShortfallAnswer(-1, 3, 300), null);
});

test('AI-113: the restock tool exposes the whole-set shortfall and the prompt says to quote it', () => {
  const tool = aiToolsById.get('getReorderNeededProducts');
  assert.ok(tool);
  assert.match(tool.description, /totalUnitsBelowMinimum/);
  const prompt = systemPrompt();
  assert.match(prompt, /totalUnitsBelowMinimum/);
  assert.match(prompt, /instead of adding the row gaps/);
});