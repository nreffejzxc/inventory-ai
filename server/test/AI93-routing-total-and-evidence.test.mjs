import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asksForBestSelling,
  asksForHighestStockValue,
  asksForTotalStockValue,
  bestSellingLimitsAnswer,
  highestStockValueAnswer,
  normaliseSkuTypography,
  replaceFalseToolClaims,
  replaceRestockCountClaims,
  stripModelGlitchPreamble,
  stripUnsupportedSalesClaims,
} from '../src/services/ai/answerCompletion.ts';
import { asksForResearchModel } from '../src/services/ai/webCapabilities.ts';
import { answerSourceUrls, unreturnedSourceUrls } from '../src/services/ai/webResearch.ts';
import { normaliseLookupText } from '../src/utils/lookupText.ts';

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
    'Which product is our best-selling product? Use only our records, and do not guess if the data does not support a sales ranking.',
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

  const withSku = highestStockValueAnswer(
    [
      {
        name: 'Samsung Bespoke RF29BB8600QL Refrigerator',
        sku: 'SEEDSKU-344',
        sellingPrice: 189990,
        currency: null,
        availableQuantity: 801,
        stockValue: 152181990,
      },
    ],
    2000,
  );
  assert.match(withSku, /\(SKU SEEDSKU-344\)/);
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

test('AI-95: Unicode SKU punctuation is normalized for lookup', () => {
  assert.equal(normaliseLookupText('SEEDSKU\u2011964'), 'SEEDSKU-964');
  assert.equal(normaliseLookupText('SEEDSKU\u2013964'), 'SEEDSKU-964');
  assert.equal(normaliseLookupText('  SEEDSKU\uFF0D964\u00a0'), 'SEEDSKU-964');
  assert.equal(normaliseLookupText('SEEDSKU-964'), 'SEEDSKU-964');
});

test('AI-95: a malformed restock count is replaced, not partially matched', () => {
  assert.equal(
    replaceRestockCountClaims('**1,1535 products need restocking; the 5 most urgent are below.**', 1535),
    '**1,535 products need restocking; the 5 most urgent are below.**',
  );
  assert.equal(
    replaceRestockCountClaims('1535 products are low on stock', 1535),
    '1,535 products are low on stock',
  );
  assert.equal(
    replaceRestockCountClaims('2 1,535 products need restocking; the 5 most urgent are below.', 1535),
    '1,535 products need restocking; the 5 most urgent are below.',
  );
  assert.equal(
    replaceRestockCountClaims('2. 1,535 products need restocking.', 1535),
    '1,535 products need restocking.',
  );
});

test('AI-98: emitted SKUs use the catalogue ASCII hyphen', () => {
  assert.equal(
    normaliseSkuTypography('| Anker 737 Power Bank | SEEDSKU\u20119992 | 0 / 96 |'),
    '| Anker 737 Power Bank | SEEDSKU-9992 | 0 / 96 |',
  );
  assert.equal(normaliseSkuTypography('SKU SEEDSKU\u2013979'), 'SKU SEEDSKU-979');
  assert.equal(normaliseSkuTypography('SEEDSKU-344 is already canonical.'), 'SEEDSKU-344 is already canonical.');
  assert.equal(normaliseSkuTypography('The 2024\u20132025 total is unchanged.'), 'The 2024\u20132025 total is unchanged.');
});

test('AI-95: a best-selling label becomes a movement statement', () => {
  assert.equal(asksForBestSelling('Which product is our best-selling product?'), true);
  assert.equal(asksForBestSelling('Which products are below their minimum?'), false);
  assert.equal(
    stripUnsupportedSalesClaims('**Best\u2011selling (most units out)**\n\nDenso moved 830 units.'),
    '**Most units out**\n\nDenso moved 830 units.',
  );
});

test('AI-97: a sales question gets a limitation, not a rewritten fragment', () => {
  assert.equal(
    bestSellingLimitsAnswer([{ name: 'Denso Air Filter', unitsOut: 830 }], 2000),
    "The inventory records do not contain a sales ranking, so I can't identify a best seller. " +
      'The product with the most units out is **Denso Air Filter**, with **830 units** moved out; ' +
      'stock-outs can include usage, damage or write-offs.',
  );
  assert.equal(bestSellingLimitsAnswer([], 2000), null);
});

test('AI-97: a model self-correction preamble is removed', () => {
  assert.equal(
    stripModelGlitchPreamble(
      '9 542 MARCNG 3 b110981?  \n\n(Ok, that was a glitch. Here is the correct answer.)  \n\n**1,535 products need restocking.**',
    ),
    '**1,535 products need restocking.**',
  );
  assert.equal(
    stripModelGlitchPreamble('**1,535 products need restocking.**'),
    '**1,535 products need restocking.**',
  );
});

test('AI-96: web citations are checked against the sources the tools returned', () => {
  const answer =
    'See [Consumer Reports](https://www.consumerreports.org/a) and <https://www.reviewed.com/b>.';
  assert.deepEqual(answerSourceUrls(answer), [
    'https://www.consumerreports.org/a',
    'https://www.reviewed.com/b',
  ]);
  assert.deepEqual(
    unreturnedSourceUrls(answer, [
      { title: 'Reviewed', url: 'https://www.reviewed.com/b' },
    ]),
    ['https://www.consumerreports.org/a'],
  );
});
