// AI-106 — deterministic finalizers must not erase a detail the member asked for.
//
// WHY THIS SUITE EXISTS. Several finalizers replace the model's whole draft with one
// computed sentence. That is correct for a single-fact question, but a compound question
// can match the same predicate. The measured shape was:
//
//   "How many products are low on stock and what is their total value?"
//
// The restock-count finalizer ran last and replaced a longer draft with a bare count,
// deleting the requested value. The low-stock wording also failed to match "low on stock",
// so the count predicate won by default. These tests pin both halves of the repair:
//
//   * the low-stock value predicate recognises "low on stock" and its answer states the
//     count as well as the value;
//   * the count predicate refuses that compound question, so it cannot overwrite it;
//   * a value-plus-list question routes to the list completion, which appends names to the
//     draft instead of replacing its value sentence;
//   * single-fact replacement finalizers refuse ranked and compound shapes, leaving the
//     grounded draft intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForBestSelling,
  asksForBrandStockRange,
  asksForHighestStockValue,
  asksForLowStockValue,
  asksForMostExpensive,
  asksForMultipleFacts,
  asksForProductStockByLocation,
  asksForProductStockTotal,
  asksForProductsUnderPrice,
  asksForRestockCount,
  asksForRestockList,
  asksForStockOutCount,
  asksForTopOut,
  lowStockValueAnswer,
  restockCountAnswer,
  withCompleteRestockNames,
} from '../src/services/ai/answerCompletion.ts';

const ROWS = [
  { name: 'Two left', sellingPrice: 100, availableQuantity: 2 },
  { name: 'Three left', sellingPrice: 250, availableQuantity: 3 },
];

test('AI-106: count plus value is answered once, with both facts', () => {
  const question = 'How many products are low on stock and what is their total value?';
  assert.equal(asksForLowStockValue(question), true);
  assert.equal(asksForRestockCount(question), false, 'the bare count must not overwrite the value');
  assert.equal(asksForRestockList(question), false, 'a count/value question did not ask for names');

  const answer = lowStockValueAnswer(ROWS, 2000);
  assert.match(answer, /2 low-stock items/);
  assert.match(answer, /950/);
});

test('AI-106: low-stock wording accepts "low on stock" and "show me" stays a value ask', () => {
  assert.equal(asksForLowStockValue('What is the total value of low stock?'), true);
  assert.equal(asksForLowStockValue('Show me the total value of low stock.'), true);
  assert.equal(asksForLowStockValue('What is the total value of low on stock?'), true);
  // "in total" is a count, not a money value. Measured on the phone 2026-11-11: the old
  // predicate answered this with PHP 1,633,025 instead of 19 products.
  assert.equal(asksForLowStockValue('How many low-stock products are there in total?'), false);
  assert.equal(asksForRestockCount('How many low-stock products are there in total?'), true);
  assert.equal(asksForLowStockValue('You already told me. How many low-stock products are there in total?'), false);
  assert.equal(asksForRestockCount('You already told me. How many low-stock products are there in total?'), true);
  assert.equal(restockCountAnswer(19, 2000), '19 products need restocking.');
});

test('AI-106: value plus names keeps the value and appends the list', () => {
  const question = 'What is the total value of low stock and which products are they?';
  assert.equal(asksForLowStockValue(question), false, 'the list finalizer owns this shape');
  assert.equal(asksForRestockList(question), true);

  const draft = 'The total recorded value of the 2 low-stock items is 950.';
  const completed = withCompleteRestockNames(draft, ROWS, 2000, { label: 'low-stock' });
  assert.match(completed, /950/);
  assert.match(completed, /The full low-stock list is: Two left, Three left\./);
});

test('AI-106: compound and ranked questions are recognised', () => {
  for (const question of [
    'How many products are low on stock and what is their total value?',
    'Which product is the most expensive and how many units are in stock?',
    'What are the top 3 most expensive products?',
    'Which products cost under 5000 and how many units do they have?',
    'What is our total stock value, and which product has the highest stock value?',
  ]) {
    assert.equal(asksForMultipleFacts(question), true, question);
  }
  assert.equal(asksForMultipleFacts('Which products are low on stock?'), false);
  assert.equal(asksForMultipleFacts('Which Sandisk and Samsung products are low on stock?'), false);
});

test('AI-106: single-fact replacement finalizers leave compound drafts alone', () => {
  assert.equal(asksForMostExpensive('Which product is the most expensive?'), true);
  assert.equal(asksForMostExpensive('Which product is the most expensive and how many units are in stock?'), false);
  assert.equal(asksForMostExpensive('What are the top 3 most expensive products?'), false);

  assert.equal(asksForProductsUnderPrice('Which products cost less than 5,000?'), true);
  assert.equal(asksForProductsUnderPrice('Which products cost under 5000 and how many units do they have?'), false);

  assert.equal(asksForStockOutCount('How many stock-out movements are recorded?'), true);
  assert.equal(asksForStockOutCount('How many stock-out movements and which product moved most?'), false);

  assert.equal(asksForTopOut('Which product moved the most units out?'), true);
  assert.equal(asksForTopOut('Which product moved the most units out and what is its stock?'), false);

  assert.equal(asksForBrandStockRange('What is the stock range for Logitech products?'), true);
  assert.equal(asksForBrandStockRange('What is the stock range for Logitech products and which is highest?'), false);

  assert.equal(asksForBestSelling('Which product is our best-selling product?'), true);
  assert.equal(asksForBestSelling('Which product is best-selling and low on stock?'), false);

  assert.equal(asksForProductStockByLocation('What is the stock of X at each location?'), true);
  assert.equal(asksForProductStockByLocation('What is the stock of X at each location and its price?'), false);

  assert.equal(asksForProductStockTotal('How many units of X are in stock?'), true);
  assert.equal(asksForProductStockTotal('How many units of X are in stock and what is its price?'), false);
});

test('AI-106: the combined total-plus-highest finalizer still runs', () => {
  const combined =
    'What is our total stock value at the recorded selling price, and which product has the highest stock value?';
  assert.equal(asksForHighestStockValue(combined), true);
  assert.equal(
    asksForHighestStockValue('Which item has the highest stock value and how many units?'),
    false,
  );
});
