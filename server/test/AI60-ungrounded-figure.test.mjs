import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statesRecordedFigure,
  normaliseAnswerMarkup,
  asksForRecordedData,
  looksUnanswered,
  claimsEmptyElsewhere,
  claimsEmptyResult,
  asksForRevenue,
  statesUnqualifiedMoney,
  looksLikeFailureNotice,
  normaliseReversedQuantityRange,
  stripUnrequestedLowStockTail,
  asksForBrandList,
  asksForBrandListOnly,
  withCompleteBrandList,
  canonicalBrandListAnswer,
  asksForRestockList,
  withCompleteRestockNames,
  lowStockValueAnswer,
  mostExpensiveProductAnswer,
  brandStockRangeAnswer,
  asksForLocationTotals,
  locationTotalsAnswer,
  asksForStockOutCount,
  stockOutCountAnswer,
  asksForProductsUnderPrice,
  productsUnderPriceAnswer,
} from '../src/services/ai/answerCompletion.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

// AI-60 — the guard that catches an answer stating figures that no tool was asked for.
//
// The device case it exists for, verbatim (2026-11-05, calls=1 toolRuns=0, truth 383,426 / 26):
//   "The Phone Test Shelf is worth PHP 18,500, with 25 units on hand overall (an average of
//    PHP 740 each)."
// so the detector must fire on that shape. The negative cases matter as much: every false
// positive costs the member a whole re-ask round, so ordinary prose must pass through.

const deviceFabrication =
  'The Phone Test Shelf is worth PHP 18,500, with 25 units on hand overall (an average of PHP 740 each).';

test('AI-75: a model error notice is not an answer', () => {
  for (const notice of [
    '[ERROR: Max turns exceeded]',
    'Max turns exceeded',
    'Error: maximum number of steps reached',
  ]) {
    assert.equal(looksLikeFailureNotice(notice), true, notice);
  }
  for (const answer of [
    '',
    'Error rates are not recorded for this product.',
    'The maximum stock level is 5 units.',
    'I could not find a product called that. Try the Inventory screen search box.',
  ]) {
    assert.equal(looksLikeFailureNotice(answer), false, answer);
  }
});

test('AI-60: the measured fabricated answer is caught', () => {
  assert.equal(statesRecordedFigure(deviceFabrication), true);
});

test('AI-60: a currency code in front of an amount counts, whatever the casing', () => {
  for (const text of ['PHP 383,426', 'PHP383,426', 'php 139995', 'USD 45', 'eur12.50']) {
    assert.equal(statesRecordedFigure(text), true, text);
  }
});

test('AI-60: the peso sign and the other symbols count, before or after the number', () => {
  for (const text of ['₱1,299', '₱ 45', '$45.00', '€1.000', '£12', '1,299 ₱', '45 €']) {
    assert.equal(statesRecordedFigure(text), true, text);
  }
});

test('AI-60: a thousands-grouped number counts even with no currency at all', () => {
  for (const text of ['383,426', 'That is 1,299 units across 12 rows', 'a total of 18,500']) {
    assert.equal(statesRecordedFigure(text), true, text);
  }
});

// AI-62 — the device case this widening exists for, verbatim (2026-11-05 5:13 PM, calls=1
// toolRuns=0, truth: 4 low products at Front Counter — chair 1, SSD 5, headset 4, monitor 2):
//   "The products running low at the Front Counter … are: 1. Product A – 2 units available,
//    minimum 5  2. Product B – 0 units available, minimum 3  3. Product C – 1 unit available,
//    minimum 4. In total, 3 products are flagged as low stock at the Front Counter."
// Every figure is invented and none of the money shapes matched it, so it shipped to the phone.
const deviceQuantityFabrication =
  'The products running low at the Front Counter are:\n' +
  '1. Product A – 2 units available, minimum 5\n' +
  '2. Product B – 0 units available, minimum 3\n' +
  '3. Product C – 1 unit available, minimum 4\n' +
  'In total, 3 products are flagged as low stock at the Front Counter.';

test('AI-62: the fabricated quantity answer measured on the phone is caught', () => {
  assert.equal(statesRecordedFigure(deviceQuantityFabrication), true);
});

test('AI-62: a count of a business thing counts, with no currency anywhere', () => {
  for (const text of [
    'There are 26 units on the shelf.',
    '4 products are low at the Front Counter.',
    'We have 3 locations and 2 suppliers.',
    '12 items sold this week.',
    'The Logitech G304 has 7 pcs left.',
    '5 on hand at the Store Room.',
    'Only 1 unit remains.',
  ]) {
    assert.equal(statesRecordedFigure(text), true, text);
  }
});

test('AI-62: a reorder threshold counts', () => {
  for (const text of ['minimum 5', 'Minimum: 3', 'reorder point 4', 'par level: 12', 'min. 2']) {
    assert.equal(statesRecordedFigure(text), true, text);
  }
});

test('AI-62: a markdown table with digits counts', () => {
  const table = '| Product | On hand |\n| --- | --- |\n| AOC 24G2SP | 2 |';
  assert.equal(statesRecordedFigure(table), true);
});

test('AI-60: ordinary prose without a claimed figure passes through', () => {
  for (const text of [
    '',
    'Hello! I can help with stock levels, prices and movements.',
    'I can check 3 things for you: current stock, prices and recent movements.',
    'I could not find a location named "Main Warehouse". The only active location is Phone Test Shelf.',
    'I have 2 tools available for that.',
    'Which product did you mean?',
    'Sure — 2026 was a strong year.',
    'Use the Stock In screen, then pick the product.',
    'Product A shows as low stock.',
  ]) {
    assert.equal(statesRecordedFigure(text), false, text);
  }
});

// AI-63 — the second measured fabrication, verbatim (2026-11-05 5:19 PM, calls=1 toolRuns=0):
//   "From 2026-11-01 to 2026-11-05 … there were 538 stock-out movements recorded across the
//    business. These are the STOCK_OUT events that represent items sold or used."
// Truth: 7 stock-out movements, 13 units, in the last 7 days. No money shape matched, and the
// count sat in front of a *qualified* noun, so the detector could not see it either.
test('AI-62: a count followed by a qualified noun is caught', () => {
  assert.equal(statesRecordedFigure('there were 538 stock-out movements recorded'), true);
});

test('AI-63: a recorded-data question with no tool read is a fabrication risk', () => {
  for (const question of [
    'How many units did we sell this week',
    'What is running low at the Front Counter right now',
    "What's the Store Room worth?",
    'Where are the G304s?',
    'What came in last week?',
    'What came into the Demo Warehouse?',
    'What should I reorder?',
    'Show me the history for the Logitech C920',
  ]) {
    assert.equal(asksForRecordedData(question), true, question);
  }
});

test('AI-76: a brand-list question is recognised, and every returned brand is kept', () => {
  for (const question of [
    'What brands do you carry?',
    'Which brands does the catalogue have?',
    'List all brands.',
    'Name every brand we stock.',
    'Do you carry any brands?',
    'Which gaming headset do you recommend and what brands do you carry',
  ]) {
    assert.equal(asksForBrandList(question), true, question);
  }
  for (const question of [
    'Do you carry Samsung products?',
    'What products do you carry?',
    'Which brand do you recommend?',
    'What is the best brand?',
  ]) {
    assert.equal(asksForBrandList(question), false, question);
  }

  const brands = ['Acme', 'Logitech', 'Samsung'];
  const incomplete = 'We carry Acme and Logitech.';
  const completed = withCompleteBrandList(incomplete, brands, 500);
  assert.match(completed, /Acme and Logitech/);
  assert.match(completed, /Complete recorded brand list: Acme, Logitech, Samsung\./);
  assert.equal(withCompleteBrandList('Acme, Logitech and Samsung are recorded.', brands, 500), 'Acme, Logitech and Samsung are recorded.');
});

test('AI-81: product-kind, comparison and recommendation questions need a tool read', () => {
  for (const question of [
    'Compare the Sony WH-1000XM5 and SteelSeries Arctis Nova 7',
    'Which gaming headset do you recommend and why',
    'Do we have any keyboards?',
    'Which monitors are available?',
  ]) {
    assert.equal(asksForRecordedData(question), true, question);
  }
  assert.equal(asksForRecordedData('How do I record a sale?'), false);
});

test('AI-76: a pure brand-list answer is rebuilt only from the tool rows', () => {
  assert.equal(asksForBrandListOnly('What brands do you carry?'), true);
  assert.equal(asksForBrandListOnly('Which gaming headset do you recommend and what brands do you carry'), false);
  const rows = [
    { brand: 'Logitech', productCount: 29 },
    { brand: 'ASUS ROG', productCount: 10 },
    { brand: 'Samsung', productCount: 9 },
  ];
  const text = canonicalBrandListAnswer(rows, 500);
  assert.match(text, /Logitech/);
  assert.match(text, /ASUS ROG/);
  assert.match(text, /Samsung/);
  assert.doesNotMatch(text, /Roccat/);
  assert.match(text, /The catalogue carries 3 recorded brands/);
});

test('AI-75: a reversed stock range is put in ascending order', () => {
  assert.equal(
    normaliseReversedQuantityRange('some units have no available stock, while others have between 596 and 242 units on hand'),
    'some units have no available stock, while others have between 242 and 596 units on hand',
  );
  assert.equal(normaliseReversedQuantityRange('from 0 to 596 units'), 'from 0 to 596 units');
  assert.equal(
    normaliseReversedQuantityRange('between 2 and 4 products'),
    'between 2 and 4 products',
    'a product-count range is not a stock quantity',
  );
});

test('AI-75: a brand stock range cannot pass with a reversed or middle-value floor', () => {
  // The prompt is the only mechanism that can supply a floor the model never wrote. Pin the
  // instruction as well as the deterministic reorder, so removing either fails this test.
  const prompt = systemPrompt();
  assert.match(
    prompt,
    /report the quantities in ascending order using the true smallest and largest values the tool returned/i,
  );
  assert.match(prompt, /never "between 596 and 242 units"/i);
  assert.match(prompt, /never call two middle values the range/i);
  assert.match(prompt, /If some SKUs have none, say how many have none separately/i);

  // The measured Samsung rows. 242 is the fifth-largest quantity, not the floor; the true
  // range is 0 to 596, and the answer must not present 242 as its lower endpoint.
  const samsungQuantities = [0, 0, 75, 147, 186, 238, 242, 307, 596];
  const trueMinimum = Math.min(...samsungQuantities);
  const trueMaximum = Math.max(...samsungQuantities);
  assert.equal(trueMinimum, 0);
  assert.equal(trueMaximum, 596);

  const stored =
    'some units have no available stock, while others have between 596 and 242 units on hand';
  const repaired = normaliseReversedQuantityRange(stored);
  assert.match(repaired, /between 242 and 596 units/);
  // The reorder deliberately does not invent the missing 0; the prompt assertions above are
  // what prevent a middle quantity from being accepted as the floor in the first place.
});

test('AI-77: an unrequested low-stock tail is removed with its wrong count', () => {
  const answer =
    'Yes, the catalogue carries Samsung products – 9 SKUs of the Samsung Portable SSD T7 ' +
    'Shield 1TB. Their recorded available quantities range from 0 to 596 units. ' +
    'The most urgent low\u2011stock items (available ≤ minimum) are: 242\u2011unit, 307\u2011unit and ' +
    '0-unit rows (the two that are at or below their configured minimums).';
  const question = 'Do you carry Samsung products and what is the stock range across SKUs';
  const cleaned = stripUnrequestedLowStockTail(answer, question);
  assert.equal(
    cleaned,
    'Yes, the catalogue carries Samsung products – 9 SKUs of the Samsung Portable SSD T7 ' +
      'Shield 1TB. Their recorded available quantities range from 0 to 596 units.',
  );
  assert.doesNotMatch(cleaned, /low-stock|242-unit|the two/i);

  // A member who actually asked for low stock keeps the section.
  const asked = 'Which Samsung SKUs are low stock?';
  assert.equal(stripUnrequestedLowStockTail(answer, asked), answer);
  assert.equal(
    stripUnrequestedLowStockTail('Only the range: from 0 to 596 units.', question),
    'Only the range: from 0 to 596 units.',
  );
});

test('AI-75: brand and product-availability questions require a read', () => {
  // Verbatim from the phone, 2026-11-05 10:00 PM: answered "No" with toolRuns=0 while nine
  // Samsung products were ACTIVE. The question had no figure and no stock noun the old
  // vocabulary recognised, so the guard never asked for a read.
  for (const question of [
    'Do you carry Samsung products?',
    'What brands do you carry?',
    'Which gaming headset do you recommend and what brands do you carry',
  ]) {
    assert.equal(asksForRecordedData(question), true, question);
  }
});

test('AI-63: an app or capability question is not a recorded-data question', () => {
  for (const question of [
    '',
    'hello',
    'Thanks, that helps.',
    'What can you do?',
    'Who are you?',
    'How do I record a sale?',
    'How to add a product',
    'Where do I find the Stock In screen?',
    'What is the difference between stock in and stock out?',
  ]) {
    assert.equal(asksForRecordedData(question), false, question);
  }
});

test('AI-60: the detector reads the answer as the member will, after markup is normalised', () => {
  // A model that writes `<br>PHP 18,500` must still be caught: the guard runs on the text
  // the member sees, so the tag is already a line break by the time it is inspected.
  const raw = 'Worth<br>PHP 18,500';
  assert.equal(statesRecordedFigure(raw), true);
  assert.equal(statesRecordedFigure(normaliseAnswerMarkup(raw)), true);
});

test('AI-64: the tool-narration measured on the phone is not an answer', () => {
  // Verbatim from the device, 2026-11-05 5:29 PM: the model promised a read, wrote a
  // placeholder, and that text was stored and shown as the reply (toolRuns=0).
  const measured =
    `I'll call getInventoryHistory with the location set to "Store Room" and a recent ` +
    'time window to list the movements out of it.' +
    String.fromCharCode(10, 10) +
    '[awaiting tool response]';
  assert.equal(looksUnanswered(measured), true);
  assert.equal(looksUnanswered('I will run getInventoryHistory to check.'), true);
  assert.equal(looksUnanswered("Let me query searchProducts for 'G304' first."), true);
  assert.equal(looksUnanswered('Checking... [awaiting tool response]'), true);
});

test('AI-66: an absence claim with no digits is still a recorded-data claim', () => {
  // Verbatim from the phone, 2026-11-05 5:50 PM: toolRuns=0, and the guard stayed quiet.
  const measured =
    'No stock-out movements were recorded for the Store Room in the last 7 days ' +
    '(2026-10-29 to 2026-11-05, Asia/Manila). The inventory history returned zero events ' +
    'for that location and period, so nothing left the Store Room during that window.';
  assert.equal(statesRecordedFigure(measured), true);
  assert.equal(statesRecordedFigure('Zero sales were recorded this week.'), true);
  assert.equal(statesRecordedFigure('There are no units left of the G304.'), true);
  // Prose that promises nothing about the ledger stays untouched.
  assert.equal(statesRecordedFigure('There is no way to record a sale without stock.'), false);
  assert.equal(statesRecordedFigure('Zero is not a valid quantity.'), false);
});

test('AI-66: a question about things moving out of a place is about recorded data', () => {
  for (const question of [
    'What moved out of the Store Room recently',
    'What went out yesterday?',
    'What left the warehouse this week?',
    'What moved between locations?',
  ]) {
    assert.equal(asksForRecordedData(question), true, question);
  }
});

test('AI-67: a roster claim about OTHER locations is recognised', () => {
  // Verbatim from the phone, 2026-11-05 5:58 PM, from a page of 15 of 17 rows.
  assert.equal(
    claimsEmptyElsewhere(
      'The Logitech G304 Lightspeed is currently at the Front Counter with 6 units available ' +
        'and is priced at PHP 2,195 each. No other location shows stock for this product.',
    ),
    true,
  );
  assert.equal(claimsEmptyElsewhere('It is stocked only at the Front Counter.'), true);
  assert.equal(claimsEmptyElsewhere('Nowhere else carries it.'), true);
  assert.equal(claimsEmptyElsewhere('The G304 is available at both locations.'), false);
  assert.equal(claimsEmptyElsewhere('There is no other location configured yet.'), false);
});

test('AI-69: an empty-period answer is recognised so a dead end can be repaired', () => {
  // Verbatim from the phone, 2026-11-05 6:08 PM.
  assert.equal(
    claimsEmptyResult(
      'No stock-out movements were recorded for the Store Room between 2026-10-29 and ' +
        '2026-11-05 (Asia/Manila). The history window is empty for that location and period, ' +
        'so there is nothing to report about what sold or left the Store Room in that time.',
    ),
    true,
  );
  assert.equal(claimsEmptyResult('Nothing matched in that period.'), true);
  assert.equal(claimsEmptyResult('The G304 is at the Front Counter with 6 units.'), false);
  assert.equal(claimsEmptyResult('Two transfers went out of the Store Room on 2026-10-24.'), false);
});

test('AI-70: money stated as revenue without a qualification is caught', () => {
  assert.equal(asksForRevenue('How much revenue did we make this week'), true);
  assert.equal(asksForRevenue('What is our profit this month'), true);
  assert.equal(asksForRevenue('How much is the stock worth'), false);
  // Verbatim from the phone, 2026-11-05 6:23 PM.
  assert.equal(
    statesUnqualifiedMoney(
      'PHP 68,975 in revenue this week (2026-11-05, Asia/Manila). This total is the sum of ' +
        'recorded selling prices \u00d7 units sold from the stock out movements.',
    ),
    true,
  );
  assert.equal(
    statesUnqualifiedMoney('An estimated PHP 68,975 at recorded prices; the app does not track revenue.'),
    false,
  );
  assert.equal(statesUnqualifiedMoney('The Front Counter holds 21 units.'), false);
});

test('AI-64: a real answer that happens to mention checking is not narration', () => {
  for (const answer of [
    '',
    'You can see every movement on the History screen, filtered by Store Room.',
    'The Store Room holds 62 units across 6 products.',
    'I could not find a product called that. Try the Inventory screen search box.',
    'Let me know if you want the per-location breakdown.',
    'Store in and stock out are different: one adds units, one removes them.',
  ]) {
    assert.equal(looksUnanswered(answer), false, answer);
  }
});

test('AI-90: a restock question is recognised in its natural wording', () => {
  for (const question of [
    'Which products need restocking?',
    'What should I reorder?',
    'Show me products that need restock',
  ]) {
    assert.equal(asksForRestockList(question), true, question);
  }
  assert.equal(asksForRestockList('What is our total stock value?'), false);
});

test('AI-90: every returned restock product is named once', () => {
  const rows = [
    { name: 'ASUS ROG Strix Flare II Animate' },
    { name: 'Elgato Stream Deck MK.2' },
    { name: 'Dell UltraSharp U2723QE' },
    { name: 'Logitech MX Master 3S' },
    { name: 'Keychron K8 Pro' },
    { name: 'Dell UltraSharp U2723QE' },
  ];
  const answer = withCompleteRestockNames('47 products need restocking.', rows, 2000);
  assert.match(answer, /The full restock list is:/);
  for (const row of rows) {
    assert.equal(
      answer.split(row.name).length - 1,
      1,
      `${row.name} should appear exactly once`,
    );
  }
});

test('AI-90: a low-stock subtotal uses only returned rows and prices', () => {
  const answer = lowStockValueAnswer(
    [
      { name: 'Out of stock', sellingPrice: 999, availableQuantity: 0 },
      { name: 'Two left', sellingPrice: 100, availableQuantity: 2 },
      { name: 'Three left', sellingPrice: 250, availableQuantity: 3 },
    ],
    2000,
  );
  assert.equal(answer, 'The total recorded value of the 3 low-stock items is PHP 950.');
  assert.equal(lowStockValueAnswer([], 2000), null);
  assert.equal(lowStockValueAnswer([{ name: 'Unknown price', availableQuantity: 2 }], 2000), null);
});

test('AI-90: the most expensive product is chosen by selling price, not stock value', () => {
  const answer = mostExpensiveProductAnswer(
    [
      { id: '1', name: 'Sony WH-1000XM5', sellingPrice: 19990, availableQuantity: 1 },
      { id: '2', name: 'Dell UltraSharp U2723QE', sellingPrice: 38990, availableQuantity: 2 },
      { id: '3', name: 'LG UltraFine', sellingPrice: 22995, availableQuantity: 99 },
    ],
    2000,
  );
  assert.match(answer, /Dell UltraSharp U2723QE/);
  assert.match(answer, /PHP 38,990/);
  assert.doesNotMatch(answer, /Sony|LG/);
});

test('AI-90: a brand stock range uses product totals, never location rows', () => {
  const rows = [
    { id: '1', name: 'Logitech MX Master 3S', brand: 'Logitech', availableQuantity: 4 },
    { id: '2', name: 'Logitech MX Keys S', brand: 'Logitech', availableQuantity: 24 },
    { id: '3', name: 'Sony WH-1000XM5', brand: 'Sony', availableQuantity: 12 },
  ];
  assert.equal(
    brandStockRangeAnswer(rows, 'What is the stock range for Logitech products?', 2000),
    'The recorded stock range across Logitech products is **4 to 24 units** ' +
      '(product totals across all locations).',
  );
  // A repeated product read must not be summed into a false range.
  assert.equal(
    brandStockRangeAnswer(
      [
        { id: '1', name: 'Logitech MX Master 3S', brand: 'Logitech', availableQuantity: 4 },
        { id: '1', name: 'Logitech MX Master 3S', brand: 'Logitech', availableQuantity: 4 },
        { id: '2', name: 'Logitech MX Keys S', brand: 'Logitech', availableQuantity: 24 },
      ],
      'What is the stock range for Logitech products?',
      2000,
    ),
    'The recorded stock range across Logitech products is **4 to 24 units** ' +
      '(product totals across all locations).',
  );
});

test('AI-90: malformed restock rows cannot add phantom names', () => {
  const answer = withCompleteRestockNames(
    '5 products need restocking.',
    [
      null,
      undefined,
      {},
      { name: '   ' },
      { name: 12345 },
      { name: 'Dell UltraSharp U2723QE' },
      { name: ' dell ultraSharp u2723qe ' },
    ],
    2000,
  );
  assert.equal(
    answer,
    '5 products need restocking.\n\nThe full restock list is: Dell UltraSharp U2723QE.',
  );
  assert.equal(
    withCompleteRestockNames('No valid rows', [null, {}, { name: '   ' }, { name: 12345 }], 2000),
    'No valid rows',
  );
});

test('AI-90: malformed low-stock rows are refused instead of producing a total', () => {
  for (const rows of [
    [null, {}, { name: '   ' }],
    [{ name: 'No price', availableQuantity: 2 }],
    [{ name: 'No quantity', sellingPrice: 100 }],
    [{ name: 'String price', sellingPrice: '100', availableQuantity: 2 }],
    [{ name: 'NaN price', sellingPrice: Number.NaN, availableQuantity: 2 }],
    [{ name: 'Infinite quantity', sellingPrice: 100, availableQuantity: Number.POSITIVE_INFINITY }],
    [{ name: 12345, sellingPrice: 100, availableQuantity: 2 }],
  ]) {
    assert.equal(lowStockValueAnswer(rows, 2000), null, JSON.stringify(rows));
  }
});

test('AI-90: partial and duplicate low-stock rows count once with merged fields', () => {
  const answer = lowStockValueAnswer(
    [
      null,
      { id: 'p1', name: 'Elgato Stream Deck MK.2', availableQuantity: 2 },
      { id: 'p1', name: 'Elgato Stream Deck MK.2', sellingPrice: 8995 },
      { name: 'Keychron K8 Pro', sellingPrice: 6990, availableQuantity: 6 },
      { name: ' keychron k8 pro ', sellingPrice: 6990, availableQuantity: 6 },
      { name: 'Cheap item', sellingPrice: 1000, availableQuantity: 1 },
    ],
    2000,
  );
  assert.equal(answer, 'The total recorded value of the 3 low-stock items is PHP 60,930.');
});

test('AI-90: malformed prices cannot create a most-expensive winner', () => {
  const answer = mostExpensiveProductAnswer(
    [
      null,
      {},
      { name: '   ' },
      { name: 12345, sellingPrice: 99999 },
      { name: 'No price' },
      { name: 'Zero', sellingPrice: 0 },
      { name: 'NaN', sellingPrice: Number.NaN },
      { name: 'String', sellingPrice: '38990' },
    ],
    2000,
  );
  assert.equal(answer, null);
});

test('AI-90: partial and duplicate product reads produce one most-expensive winner', () => {
  const answer = mostExpensiveProductAnswer(
    [
      { id: 'p1', name: 'Dell UltraSharp U2723QE', availableQuantity: 2 },
      { id: 'p1', name: 'Dell UltraSharp U2723QE', sellingPrice: 38990 },
      { id: 'p2', name: 'Sony WH-1000XM5', sellingPrice: 19990 },
      { id: 'p1', name: 'Dell duplicate', sellingPrice: 38990 },
    ],
    2000,
  );
  assert.equal(
    answer,
    'The product with the highest recorded selling price is **Dell UltraSharp U2723QE** at PHP 38,990.',
  );
});

test('AI-90: malformed brand rows cannot distort the stock range', () => {
  const question = 'What is the stock range for Logitech products?';
  assert.equal(
    brandStockRangeAnswer(
      [
        null,
        {},
        { name: 'No brand', availableQuantity: 999 },
        { brand: 'Logitech', availableQuantity: 999 },
        { name: 12345, brand: 'Logitech', availableQuantity: 999 },
        { name: 'No quantity', brand: 'Logitech' },
        { name: 'String quantity', brand: 'Logitech', availableQuantity: '4' },
        { id: 'p1', name: 'Only product', brand: 'Logitech', availableQuantity: 4 },
      ],
      question,
      2000,
    ),
    null,
  );
});

test('AI-90: a location total counts the complete returned page', () => {
  const question = 'How many products and units are at Demo Warehouse?';
  const rows = [
    { name: 'A', availableQuantity: 18 },
    { name: 'B', availableQuantity: 26 },
    { name: 'C', availableQuantity: 55 },
  ];
  assert.equal(asksForLocationTotals(question), true);
  assert.equal(locationTotalsAnswer(rows, question, 2000), 'Demo Warehouse has 3 products and 99 units on hand.');
  assert.equal(locationTotalsAnswer([], question, 2000), null);
  assert.equal(locationTotalsAnswer([{ name: 'A', availableQuantity: 1 }, { name: 'B' }], question, 2000), null);
});

test('AI-90: stock-out movements are counted separately from all movements', () => {
  const question = 'How many stock-out movements are recorded?';
  assert.equal(asksForStockOutCount(question), true);
  assert.equal(asksForStockOutCount('How many movements are recorded?'), false);
  assert.equal(stockOutCountAnswer(8, 2000), 'There are 8 stock-out movements recorded.');
  assert.equal(stockOutCountAnswer(1, 2000), 'There is 1 stock-out movement recorded.');
});

test('AI-90: a price-threshold question lists only rows below the ceiling', () => {
  const question = 'Which products cost less than 5,000?';
  assert.equal(asksForProductsUnderPrice(question), true);
  const answer = productsUnderPriceAnswer(
    [
      { name: 'Dell UltraSharp U2723QE', sellingPrice: 38990 },
      { name: 'Royal Kludge RK61', sellingPrice: 2499 },
      { name: 'Logitech C920s HD Pro Webcam', sellingPrice: 3495 },
    ],
    question,
    2000,
  );
  assert.match(answer, /Royal Kludge RK61/);
  assert.match(answer, /Logitech C920s HD Pro Webcam/);
  assert.doesNotMatch(answer, /Dell UltraSharp/);
});

test('AI-90: the five low-stock rows produce the recorded subtotal', () => {
  const answer = lowStockValueAnswer(
    [
      { name: 'ASUS ROG Strix Flare II Animate', sellingPrice: 12990, availableQuantity: 0 },
      { name: 'Elgato Stream Deck MK.2', sellingPrice: 8995, availableQuantity: 2 },
      { name: 'Dell UltraSharp U2723QE', sellingPrice: 38990, availableQuantity: 2 },
      { name: 'Logitech MX Master 3S', sellingPrice: 5490, availableQuantity: 4 },
      { name: 'Keychron K8 Pro', sellingPrice: 6990, availableQuantity: 6 },
    ],
    2000,
  );
  assert.equal(answer, 'The total recorded value of the 5 low-stock items is PHP 159,870.');
});

test('AI-90: partial and duplicate brand reads do not inflate the range', () => {
  const answer = brandStockRangeAnswer(
    [
      { id: 'p1', name: 'Logitech MX Master 3S', brand: 'Logitech', availableQuantity: 4 },
      { id: 'p2', name: 'Logitech MX Keys S', brand: 'Logitech', availableQuantity: 24 },
      { id: 'p2', name: 'Logitech MX Keys S', brand: 'Logitech', availableQuantity: 24 },
      { brand: 'Logitech', availableQuantity: 999 },
      { id: 'p1', name: 'Logitech MX Master 3S', brand: 'Logitech', availableQuantity: 4 },
      { id: 'p3', name: 'Sony WH-1000XM5', brand: 'Sony', availableQuantity: 12 },
    ],
    'What is the stock range for Logitech products?',
    2000,
  );
  assert.equal(
    answer,
    'The recorded stock range across Logitech products is **4 to 24 units** ' +
      '(product totals across all locations).',
  );
});
