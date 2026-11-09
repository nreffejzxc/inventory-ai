import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForHighestStockValue,
  asksForThreeRestockNames,
  asksForTopOut,
  highestStockValueAnswer,
  restockThreeAnswer,
  topOutAnswer,
} from '../src/services/ai/answerCompletion.ts';

// AI-91 — observed on the phone on 2026-11-09 (Asia/Manila).
//
// The assistant ranked the LG UltraGear 27GP850-B 10583 as the top stock-out item, but its
// first answer dropped the numeric suffix. A follow-up then chose a different LG variant,
// 10975, and lost the original product. These helpers make the identity deterministic from
// the tool rows instead of asking the model to reproduce a long recorded name.

test('AI-91: a top stock-out answer keeps the exact recorded product name', () => {
  for (const question of [
    'Which item had the most units leave Main Warehouse',
    'Which product moved the most units out',
    'What item has the highest quantity sold',
  ]) {
    assert.equal(asksForTopOut(question), true, question);
  }
  assert.equal(asksForTopOut('Which brands do we carry'), false);

  assert.equal(
    topOutAnswer(
      [
        { name: 'LG UltraGear 27GP850-B 10583', unitsOut: 575 },
        { name: 'Logitech C920s HD Pro Webcam 10964', unitsOut: 80 },
      ],
      2000,
    ),
    'The item with the most units out is **LG UltraGear 27GP850-B 10583**, with **575 units** moved out.',
  );
  assert.equal(topOutAnswer([], 2000), null);
});

test('AI-91: a highest-stock-value answer uses the recorded currency, not a guess', () => {
  const question = 'Which item has the highest stock value';
  assert.equal(asksForHighestStockValue(question), true);
  assert.equal(asksForHighestStockValue('Which item has the highest selling price'), false);

  const unrecordedCurrency = highestStockValueAnswer(
    [
      {
        name: 'Dell UltraSharp U2723QE 10652',
        sellingPrice: 38990,
        currency: null,
        availableQuantity: 818,
        stockValue: 31893820,
      },
      {
        name: 'LG UltraGear 27GP850-B 10583',
        sellingPrice: 22995,
        currency: null,
        availableQuantity: 341,
        stockValue: 7841295,
      },
    ],
    2000,
  );
  assert.equal(
    unrecordedCurrency,
    'The item with the highest stock value is **Dell UltraSharp U2723QE 10652** at 31,893,820 ' +
      '(recorded selling price 38,990 × 818 units on hand).',
  );
  assert.doesNotMatch(unrecordedCurrency, /₱|PHP/);

  const recordedCurrency = highestStockValueAnswer(
    [
      {
        name: 'Dollar item',
        sellingPrice: 100,
        currency: 'USD',
        availableQuantity: 2,
        stockValue: 200,
      },
    ],
    2000,
  );
  assert.match(recordedCurrency, /USD 200/);
  assert.equal(
    highestStockValueAnswer(
      [
        { name: 'Peso item', sellingPrice: 100, currency: 'PHP', availableQuantity: 2 },
        { name: 'Dollar item', sellingPrice: 100, currency: 'USD', availableQuantity: 1 },
      ],
      2000,
    ),
    null,
  );
});

test('AI-91: a name-three restock answer takes the exact rows in tool order', () => {
  const question = 'How many products need restocking and name three of them';
  assert.equal(asksForThreeRestockNames(question), true);
  assert.equal(asksForThreeRestockNames('How many products need restocking'), false);

  assert.equal(
    restockThreeAnswer(
      [
        { name: 'Dell UltraSharp U2723QE 10988', availableQuantity: 0 },
        { name: 'Logitech C920s HD Pro Webcam 10964', availableQuantity: 0 },
        { name: 'Samsung Portable SSD T7 Shield 1TB 10557', availableQuantity: 0 },
      ],
      149,
      2000,
    ),
    '149 products need restocking; the 3 most urgent are ' +
      '**Dell UltraSharp U2723QE 10988** (out of stock), ' +
      '**Logitech C920s HD Pro Webcam 10964** (out of stock), ' +
      '**Samsung Portable SSD T7 Shield 1TB 10557** (out of stock).',
  );
  assert.equal(restockThreeAnswer([{ name: 'Only one', availableQuantity: 0 }], 1, 2000), null);
});
