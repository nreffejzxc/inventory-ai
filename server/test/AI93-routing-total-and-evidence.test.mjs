import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForHighestStockValue,
  asksForTotalStockValue,
  highestStockValueAnswer,
  replaceFalseToolClaims,
  stripUnsupportedSalesClaims,
} from '../src/services/ai/answerCompletion.ts';
import { asksForResearchModel } from '../src/services/ai/webCapabilities.ts';

// AI-93/AI-94 — the 2026-11-09 production/development conversation exposed four
// defects that the configuration alone could not catch:
//   1. a combined total/highest-value question lost the total in the finalizer;
//   2. a grounded answer falsely claimed it used no tools;
//   3. "stock versus minimum" was routed to the 120B research model;
//   4. a stock-level read was turned into an unsupported "best-selling" claim.

test('AI-93: ordinary stock comparisons stay on the default model', () => {
  for (const message of [
    'How many products need restocking? Name every product and show its available stock versus its minimum.',
    'Compare stock across all locations.',
    'Compare the quantities at Main Warehouse and Shop Front.',
    'What is the price of the Sony headset?',
    'Which products are below their minimum?',
  ]) {
    assert.equal(asksForResearchModel(message), false, message);
  }

  for (const message of [
    'Compare the Sony and Bose headsets.',
    'Which headset is better?',
    'Should I buy the Sony or Bose?',
    'Compare our suppliers online.',
    'Research this product.',
  ]) {
    assert.equal(asksForResearchModel(message), true, message);
  }
});

test('AI-93: a combined stock-value answer keeps the tool total and the top item', () => {
  const question = 'What is our total stock value at the recorded selling price, and which product has the highest stock value?';
  assert.equal(asksForHighestStockValue(question), true);
  assert.equal(asksForTotalStockValue(question), true);
  assert.equal(asksForTotalStockValue('Which product has the highest stock value?'), false);

  const answer = highestStockValueAnswer(
    [
      {
        name: 'Sony WH-1000XM5',
        sellingPrice: 19990,
        currency: null,
        availableQuantity: 12,
        stockValue: 239880,
      },
      {
        name: 'Dell UltraSharp U2723QE',
        sellingPrice: 38990,
        currency: null,
        availableQuantity: 2,
        stockValue: 77980,
      },
    ],
    2000,
    { totalValue: 1132408, currency: null, mixedCurrency: false, unpricedProducts: 0 },
  );

  assert.equal(
    answer,
    'The total stock value at the recorded selling price is 1,132,408. ' +
      'The item with the highest stock value is **Sony WH-1000XM5** at 239,880 ' +
      '(recorded selling price 19,990 × 12 units on hand).',
  );
  assert.match(answer, /1,132,408/);
  assert.match(answer, /239,880/);
});

test('AI-93: a grounded answer cannot claim no tools were used', () => {
  assert.equal(
    replaceFalseToolClaims('I repeated the total without using any tools.'),
    'I repeated the total from your recorded inventory.',
  );
  assert.equal(
    replaceFalseToolClaims("I didn't need to use any tools for this answer."),
    'I read your recorded inventory for this answer.',
  );
  assert.equal(
    replaceFalseToolClaims('The recorded inventory total is 1,132,408.'),
    'The recorded inventory total is 1,132,408.',
  );
});

test('AI-94: unsupported best-selling wording is removed when no sales read occurred', () => {
  assert.equal(
    stripUnsupportedSalesClaims(
      'Restocking it first will keep this high-value, best-selling product available.',
    ),
    'Restocking it first will keep this product available.',
  );
  assert.equal(
    stripUnsupportedSalesClaims('This is our best-selling product.'),
    'This is our product.',
  );
  assert.equal(
    stripUnsupportedSalesClaims('The recorded stock level is 0 units.'),
    'The recorded stock level is 0 units.',
  );
});
