/**
 * AI-73 — a dead-stock question is answered from the dead-stock tool, never from low stock.
 *
 * Measured on the phone 2026-11-05 11:01 and 11:07 PM: "Any dead stock at the Main Warehouse"
 * (no question mark) routed to `getLowStockProducts`, and the answer listed rows reading
 * "Stock-out count 1" under a dead-stock heading — the opposite of the definition. The same
 * phrase WITH a question mark routed correctly at 11:10 PM, so tool choice is not deterministic
 * for this vocabulary and a prompt rule cannot be the guarantee. The turn loop now rewrites the
 * CALLS before they run. This file pins the predicate and the rewrite.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asksForDeadStock, routeDeadStockReads } from '../src/services/ai/answerCompletion.ts';

test('AI-73 — dead-stock wording the member actually types is recognised', () => {
  for (const question of [
    'Any dead stock at the Main Warehouse',
    'Any dead stock at the Main Warehouse?',
    'What is not selling right now?',
    'What has never left the store at all?',
    'Which products have never sold?',
    'Show me unsold items',
    'What stale stock do we have?',
    'Any zero sales products?',
    'What is sitting on the shelf?',
    'Which products have not moved this month?',
  ]) {
    assert.equal(asksForDeadStock(question), true, question);
  }
});

test('AI-73 — stock-level wording is left to the low-stock tool', () => {
  for (const question of [
    'Which products are low on stock?',
    'Is anything out of stock?',
    'What should I reorder?',
    'What is running low?',
    'What is below minimum?',
    'How much stock do we hold?',
    'Which products sold the most this week?',
    '',
  ]) {
    assert.equal(asksForDeadStock(question), false, question);
  }
});

test('AI-73 — a low-stock read becomes the dead-stock read, keeping the scope', () => {
  const calls = [
    { id: 'call-1', name: 'getLowStockProducts', input: { location: 'Main Warehouse', limit: 50, category: 'Laptops' } },
  ];
  const routed = routeDeadStockReads(calls, 'Any dead stock at the Main Warehouse');
  assert.equal(routed.length, 1);
  assert.equal(routed[0].name, 'getProductsNeverSold');
  assert.equal(routed[0].id, 'call-1');
  assert.deepEqual(routed[0].input, { location: 'Main Warehouse', limit: 25 });
});

test('AI-73 — a dead-stock question with no read gets one, scoped to what was asked', () => {
  const calls = [{ id: 'call-1', name: 'getInventory', input: { location: 'Shop Front' } }];
  const routed = routeDeadStockReads(calls, 'What has never left the store at all?');
  assert.equal(routed.length, 2);
  assert.equal(routed[0].name, 'getInventory');
  assert.equal(routed[1].name, 'getProductsNeverSold');
  assert.match(routed[1].id, /ai73/);
  assert.deepEqual(routed[1].input, { location: 'Shop Front' });
});

test('AI-73 — a mixed question keeps the low-stock answer and adds the dead-stock one', () => {
  const calls = [{ id: 'call-1', name: 'getLowStockProducts', input: { location: 'Main Warehouse' } }];
  const routed = routeDeadStockReads(calls, "What's dead stock and what's low on stock at Main Warehouse?");
  assert.equal(routed.length, 2);
  assert.equal(routed[0].name, 'getLowStockProducts');
  assert.equal(routed[1].name, 'getProductsNeverSold');
});

test('AI-73 — a correct turn and an unrelated question are untouched', () => {
  const deadStockCalls = [{ id: 'call-1', name: 'getProductsNeverSold', input: {} }];
  assert.equal(routeDeadStockReads(deadStockCalls, 'Any dead stock?'), deadStockCalls);

  const other = [{ id: 'call-1', name: 'getLowStockProducts', input: {} }];
  assert.equal(routeDeadStockReads(other, 'Which products are low on stock?'), other);
});
