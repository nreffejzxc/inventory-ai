import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForProductStockByLocation,
  productStockByLocationAnswer,
} from '../src/services/ai/answerCompletion.ts';

// AI-92 — production phone test on 2026-11-09.
//
// The production catalogue record for Logitech MX Keys S (SKU DEMOSKU-112) held
// 149 units at Shop Front and 149 at Main Warehouse. The assistant answered 1,029
// and 1,625 units on the first turn, then 904 and 1,625 on a follow-up. The final
// answer must be rebuilt from the inventory rows instead of trusting the model's
// arithmetic.
test('AI-92: a single product at each location is rebuilt from the inventory rows', () => {
  const question =
    'What is the current on-hand quantity for the Logitech MX Keys S at each active location?';
  assert.equal(asksForProductStockByLocation(question), true);

  const rows = [
    {
      id: 'product-logitech-mx-keys-s',
      name: 'Logitech MX Keys S',
      locationName: 'Shop Front',
      availableQuantity: 149,
    },
    {
      id: 'product-logitech-mx-keys-s',
      name: 'Logitech MX Keys S',
      locationName: 'Main Warehouse',
      availableQuantity: 149,
    },
  ];

  assert.equal(
    productStockByLocationAnswer(rows, question, 2000),
    '**Logitech MX Keys S** on hand:\n\n' +
      '- Shop Front: **149**\n' +
      '- Main Warehouse: **149**\n\n' +
      'Total: **298** units.',
  );
});

test('AI-92: only a single named product can produce a location answer', () => {
  const question = 'What is the stock of Logitech MX Keys S at each location?';
  const rows = [
    {
      id: 'keys-s',
      name: 'Logitech MX Keys S',
      locationName: 'Shop Front',
      availableQuantity: 149,
    },
    {
      id: 'keys-s',
      name: 'Logitech MX Keys S',
      locationName: 'Main Warehouse',
      availableQuantity: 149,
    },
    {
      id: 'master-3s',
      name: 'Logitech MX Master 3S',
      locationName: 'Shop Front',
      availableQuantity: 0,
    },
    {
      id: 'master-3s',
      name: 'Logitech MX Master 3S',
      locationName: 'Main Warehouse',
      availableQuantity: 0,
    },
  ];

  assert.match(productStockByLocationAnswer(rows, question, 2000), /Logitech MX Keys S/);
  assert.doesNotMatch(productStockByLocationAnswer(rows, question, 2000), /MX Master 3S/);
  assert.equal(
    productStockByLocationAnswer(
      rows,
      'What is the stock of the Logitech MX Keys S and Logitech MX Master 3S at each location?',
      2000,
    ),
    null,
  );
  assert.equal(
    productStockByLocationAnswer(
      [{ name: 'Logitech MX Keys S', locationName: 'Shop Front', availableQuantity: 149 }],
      question,
      2000,
    ),
    null,
  );
});

test('AI-92: unrelated stock questions are not rewritten', () => {
  assert.equal(asksForProductStockByLocation('What is low at each location?'), false);
  assert.equal(asksForProductStockByLocation('What is the total stock value?'), false);
  assert.equal(
    asksForProductStockByLocation('What is the on-hand quantity for the Logitech MX Keys S?'),
    false,
  );
});
