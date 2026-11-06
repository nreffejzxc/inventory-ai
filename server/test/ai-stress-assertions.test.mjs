import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseStressText,
  missingStressAssertions,
  assessStressResult,
} from '../scripts/ai-stress-assertions.mjs';
import { STRESS_QUESTIONS } from '../scripts/ai-stress-questions.mjs';

const question = (id) => STRESS_QUESTIONS[id - 1];
const check = (id, content, toolsUsed = []) =>
  assessStressResult(question(id), { content, toolsUsed, degraded: null });

test('stress assertions accept a narrow no-break space in a product name', () => {
  const answer = 'The SteelSeries Arctis Nova\u202F7 is stocked in two locations.';
  assert.equal(normaliseStressText(answer), 'The SteelSeries Arctis Nova 7 is stocked in two locations.');
  assert.deepEqual(missingStressAssertions(answer, [/SteelSeries Arctis Nova 7/i]), []);
});

test('stress assertions normalise every Unicode whitespace form', () => {
  const answer = 'Demo\u00A0Shop\u202Fhas\u3000 30\u2009units';
  assert.equal(normaliseStressText(answer), 'Demo Shop has 30 units');
  assert.deepEqual(missingStressAssertions(answer, [/Demo Shop has 30 units/i]), []);
});

test('stress assertions still report facts that are genuinely absent', () => {
  const missing = missingStressAssertions('Demo Shop has 36 units', [
    /Demo Shop/i,
    /\b30\b/i,
  ]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0], '/\\b30\\b/i');
});

test('every stress question has a structured content expectation', () => {
  assert.equal(STRESS_QUESTIONS.length, 120);
  for (const entry of STRESS_QUESTIONS) {
    const expect = entry.expect ?? {};
    assert.ok(
      expect.all?.length ||
        expect.any?.length ||
        expect.pairs?.length ||
        expect.forbid?.length ||
        expect.evidence ||
        expect.toolsAny?.length,
      `Q${entry.id} has no structured expectation`,
    );
  }
});

test('multi-part values must be attached to their own labels', () => {
  assert.equal(check(67, 'There are 14 products and 136 units on hand.').ok, true);
  const swapped = check(67, 'There are 136 products and 14 units on hand.');
  assert.equal(swapped.ok, false);
  assert.equal(swapped.missing.length, 2);

  assert.equal(check(61, 'Demo Warehouse has 12 products and 99 units.').ok, true);
  assert.equal(check(61, 'Demo Warehouse has 12 units and 99 products.').ok, false);
  assert.equal(check(63, 'Demo Shop has 8 products and 36 units.').ok, false);

  assert.equal(check(68, '5 products are low on stock and 1 is out of stock.').ok, true);
  assert.equal(check(68, '1 product is low on stock and 5 are out of stock.').ok, false);
});

test('complete sets reject a missing product even when every count is right', () => {
  const restock = [
    '5 products need restocking; the ASUS ROG Strix Flare II Animate is most urgent with 0 units.',
    'Keychron K8 Pro has 6 available.',
    'Logitech MX Master 3S has 4 available.',
    'Dell UltraSharp U2723QE has 2 available.',
    'Elgato Stream Deck MK.2 has 2 available.',
  ].join(' ');
  assert.equal(check(69, restock).ok, true);
  const missingElgato = restock.replace('Elgato Stream Deck MK.2 has 2 available.', '');
  const missing = check(69, missingElgato);
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.some((item) => item.includes('Elgato Stream Deck MK.2')));

  const neverSold = [
    '7 products have never sold:',
    'ASUS ROG Strix Flare II Animate,',
    'SteelSeries Arctis Nova 7,',
    'Dell UltraSharp U2723QE,',
    'LG UltraGear 27GP850-B,',
    'Anker 737 Power Bank,',
    'Logitech C920s HD Pro Webcam,',
    'and Elgato Stream Deck MK.2.',
  ].join(' ');
  assert.equal(check(70, neverSold).ok, true);
  assert.equal(check(70, neverSold.replace('ASUS ROG Strix Flare II Animate,', '')).ok, false);

  const underFive = 'Royal Kludge RK61 costs PHP 2,499 and Logitech C920s HD Pro Webcam costs PHP 3,495.';
  assert.equal(check(105, underFive).ok, true);
  assert.equal(check(105, underFive.replace(' and Logitech C920s HD Pro Webcam costs PHP 3,495', '')).ok, false);

  const wrongLogitechCounts =
    'I carry three Logitech products: Logitech C920s HD Pro Webcam 12 units, Logitech MX Master 3S 4 units, Logitech MX Keys S 30 units.';
  assert.equal(check(29, wrongLogitechCounts).ok, false);
});

test('negated availability and false none-claims do not pass', () => {
  const unavailable =
    'The ASUS ROG Strix Flare II Animate is not in stock — 0 units on hand and out of stock.';
  assert.equal(check(116, unavailable).ok, true);
  assert.equal(
    check(116, 'The ASUS ROG Strix Flare II Animate is not out of stock; it is available.').ok,
    false,
  );

  assert.equal(check(120, 'Royal Kludge RK61 is under 3,000 at PHP 2,499.').ok, true);
  assert.equal(
    check(120, 'None of the brands have products under 3,000. Royal Kludge RK61 is 2,499 PHP.').ok,
    false,
  );

  const monitors =
    'Dell UltraSharp U2723QE: 2 units, PHP 38,990. LG UltraGear 27GP850-B: 3 units, PHP 22,995.';
  assert.equal(check(119, monitors).ok, true);
  assert.equal(
    check(
      119,
      'Dell UltraSharp U2723QE: 1,401 units, PHP 38,990. LG UltraGear 27GP850-B: 570 units, PHP 22,995.',
    ).ok,
    false,
  );

  assert.equal(check(78, '8 stock-out movements are recorded.').ok, true);
  assert.equal(check(78, '30 stock-out movements are recorded.').ok, false);
});

test('research answers need evidence and the research tool', () => {
  const answer =
    'The Samsung Portable SSD T7 Shield 1TB specifications and reviews are available at https://example.com/review.';
  assert.equal(check(99, answer, ['researchInventoryProducts']).ok, true);
  assert.equal(check(99, 'The Samsung Portable SSD T7 Shield 1TB has specifications and reviews.').ok, false);
  assert.equal(check(99, answer, []).ok, false);
  assert.equal(
    check(
      99,
      'Research is unavailable for the Samsung Portable SSD T7 Shield 1TB; no specifications or sources were returned.',
      ['researchMarketPrices'],
    ).ok,
    true,
  );
});

test('product-row and selling-price wording are accepted as labels', () => {
  assert.equal(
    check(
      9,
      'Royal Kludge RK61: PHP 2,499 per unit, with 32 units on hand (10 at Demo Shop and 22 at Demo Warehouse).',
      ['getProduct'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      52,
      'The only Elgato product is the Elgato Stream Deck MK.2. Recorded selling price: PHP 8,995.',
      ['searchProducts'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      89,
      'The LG UltraGear 27GP850-B is the gaming monitor with 3 units available at PHP 22,995 each.',
      ['findProducts'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      91,
      'The Logitech C920s HD Pro Webcam has 12 units on hand and sells for PHP 3,495.',
      ['findProducts'],
    ).ok,
    true,
  );
});

test('number words, per-product totals, and comma-separated labels are accepted', () => {
  assert.equal(check(72, 'You have three active locations.').ok, true);

  assert.equal(
    check(
      55,
      'The Audio category contains SteelSeries Arctis Nova 7: 8 units total. Sony WH-1000XM5: 12 units total.',
      ['getInventory'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      57,
      'The Displays category contains LG UltraGear 27GP850-B with 3 units on hand and Dell UltraSharp U2723QE with 2 units on hand.',
      ['getInventory'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      77,
      'The most recent movement is Sony WH-1000XM5 — Stock out, 2 units.',
      ['getInventoryHistory'],
    ).ok,
    true,
  );
});

test('equivalent product spellings and optional context do not fail a correct answer', () => {
  assert.equal(
    check(
      92,
      'One portable SSD is recorded: Samsung Portable SSD T7 Shield 1 TB, 8 units available at PHP 7,995.',
      ['findProducts'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      93,
      'The Anker 737 Power Bank is the laptop recommendation; it has 13 units on hand and its listed selling price is 8,995.',
      ['findProducts'],
    ).ok,
    true,
  );
  assert.equal(
    check(110, '4 products with a recorded selling price, total value PHP 240,825.', ['getStockValue']).ok,
    true,
  );
  assert.equal(
    check(
      113,
      'We carry one Samsung model, the Samsung Portable SSD T7 Shield 1 TB. Demo Shop has 2 units and Demo Warehouse has 6 units, for 8 units total across the single SKU.',
      ['searchProducts'],
    ).ok,
    true,
  );
  assert.equal(
    check(
      113,
      'We carry one Samsung model, the Samsung Portable SSD T7 Shield 1 TB. Demo Shop has 2 units and Demo Warehouse has 6 units, so the stock range is 2 to 6 units.',
      ['searchProducts'],
    ).ok,
    false,
  );
  assert.equal(
    check(
      113,
      'We carry two Samsung SKUs. Demo Shop has 2 units and Demo Warehouse has 6 units, for 8 units total.',
      ['searchProducts'],
    ).ok,
    false,
  );
  assert.equal(
    check(
      113,
      'We carry one Samsung model. Demo Shop has 2 units and Demo Warehouse has 6 units across three locations; the range is 0 to 6 units.',
      ['searchProducts'],
    ).ok,
    false,
  );
});

test('table rows, grouped bullets, and an aggregate total each count as one record', () => {
  const monitors = [
    '| Product | Brand | Price | Stock |',
    '| Dell UltraSharp U2723QE | Dell | PHP 38,990 | 2 units |',
    '| LG UltraGear 27GP850-B | LG | PHP 22,995 | 3 units |',
  ].join('\n');
  assert.equal(check(119, monitors).ok, true);
  // The same facts on separate lines are not a row: each model loses its stock.
  const split = [
    'Dell UltraSharp U2723QE',
    'PHP 38,990',
    'LG UltraGear 27GP850-B',
    'PHP 22,995',
    '2 units total',
    '3 units total',
  ].join('\n');
  assert.equal(check(119, split).ok, false);

  const activity = [
    'Recent activity for the Logitech MX Keys S:',
    '**Stock-out movements**',
    '- 2 units on 2026-10-31 at Demo Shop (sold)',
    '- 6 units on 2026-10-29 at Demo Warehouse (sold)',
    '**Stock-in movements**',
    '- 24 units on 2026-10-07 at Demo Warehouse (opening stock count)',
    '- 8 units on 2026-10-07 at Demo Shop (opening stock count)',
  ].join('\n');
  assert.equal(check(84, activity, ['getInventoryHistory']).ok, true);
  assert.equal(
    check(
      84,
      activity.replace('2 units on 2026-10-31 at Demo Shop', '2 units on 2026-10-31 at Demo Warehouse'),
      ['getInventoryHistory'],
    ).ok,
    false,
  );

  const brand = [
    '**Royal Kludge RK61** is the only Royal Kludge product.',
    '| Location | Available |',
    '| Demo Shop | 10 |',
    '| Demo Warehouse | 22 |',
    '| **Total across both locations** | **32** |',
  ].join('\n');
  assert.equal(check(37, brand, ['searchProducts', 'getInventory']).ok, true);
  assert.equal(check(37, brand.replace('**32**', '**2**'), ['searchProducts', 'getInventory']).ok, false);
});

test('natural absence and label punctuation pass without accepting a false claim', () => {
  assert.equal(check(117, 'No automotive repair products were found.', ['findProducts']).ok, true);
  assert.equal(check(117, 'No more than three products were found.', ['findProducts']).ok, false);

  const value =
    'The **Sony WH-1000XM5**, worth **PHP 239,880** at the recorded selling price of PHP 19,990 per unit with 12 units available.';
  assert.equal(check(74, value, ['getStockValue']).ok, true);
  assert.equal(
    check(
      74,
      'The Sony WH-1000XM5 and Logitech MX Master 3S, worth PHP 239,880 combined.',
      ['getStockValue'],
    ).ok,
    false,
  );

  const namesOnly =
    '5 products need restocking; the ASUS ROG Strix Flare II Animate is the most urgent because it is out of stock. The others are Keychron K8 Pro, Logitech MX Master 3S, Dell UltraSharp U2723QE and Elgato Stream Deck MK.2.';
  assert.equal(check(69, namesOnly).ok, true);
  assert.equal(check(69, namesOnly.replace('Elgato Stream Deck MK.2', '')).ok, false);

  assert.equal(
    check(120, 'Royal Kludge — RK61 keyboard at PHP 2,499 is the only product under 3,000.', [
      'findProducts',
    ]).ok,
    true,
  );
});

test('budget answers reject over-budget products presented as affordable', () => {
  const affordable =
    'With a 20,000 budget, the Royal Kludge RK61 at PHP 2,499 fits. The LG UltraGear at PHP 22,995 exceeds the budget.';
  assert.equal(check(111, affordable).ok, true);

  assert.equal(
    check(
      111,
      'The LG UltraGear 27GP850-B at PHP 22,995 fits within the 20,000 budget.',
    ).ok,
    false,
  );
  assert.equal(
    check(
      111,
      'The Dell UltraSharp U2723QE at PHP 38,990 is under the 20,000 budget.',
    ).ok,
    false,
  );
});

test('absence answers must be a real negative, not a failed search', () => {
  assert.equal(
    check(117, 'There are no products matching vehicle repairs in the catalogue.').ok,
    true,
  );
  assert.equal(check(117, 'I cannot find any products for vehicle repairs.').ok, false);
  assert.equal(
    check(92, 'No matching portable SSD products were found.', ['findProducts']).ok,
    false,
  );
});

test('research claims without evidence or a research tool fail', () => {
  assert.equal(
    check(100, 'The Sony WH-1000XM5 is well reviewed and reliable.', [
      'researchInventoryProducts',
    ]).ok,
    false,
  );
  assert.equal(
    check(
      100,
      'The Sony WH-1000XM5 is well reviewed. Source: https://example.com/review.',
      [],
    ).ok,
    false,
  );
  assert.equal(
    check(
      100,
      'The Sony WH-1000XM5 is well reviewed. Source: https://example.com/review.',
      ['researchInventoryProducts'],
    ).ok,
    true,
  );
});

test('list questions reject an incomplete set', () => {
  const audio =
    'The Audio category contains SteelSeries Arctis Nova 7 with 8 units and Sony WH-1000XM5 with 12 units.';
  assert.equal(check(55, audio, ['getInventory']).ok, true);
  assert.equal(
    check(55, audio.replace(' and Sony WH-1000XM5 with 12 units', ''), ['getInventory']).ok,
    false,
  );

  const underTen = [
    'Royal Kludge RK61 2,499',
    'Logitech MX Master 3S 5,490',
    'Keychron K8 Pro 6,990',
    'Logitech MX Keys S 6,290',
    'Elgato Stream Deck MK.2 8,995',
    'Logitech C920s HD Pro Webcam 3,495',
    'Samsung Portable SSD T7 Shield 1TB 7,995',
    'Anker 737 Power Bank 8,995',
  ].join(', ');
  assert.equal(check(106, underTen).ok, false);
  assert.ok(check(106, underTen).missing.some((item) => item.includes('SteelSeries Arctis Nova 7')));
});

test('unicode hyphens are normalised for product-name matching', () => {
  const answer = 'The LG UltraGear 27GP850\u2011B is in the Displays category.';
  assert.equal(normaliseStressText(answer), 'The LG UltraGear 27GP850-B is in the Displays category.');
  assert.deepEqual(missingStressAssertions(answer, [/LG UltraGear 27GP850-B/i]), []);
});

test('answer correctness does not depend on the expected tool route', () => {
  const checks = assessStressResult(
    {
      must: [/Dell UltraSharp U2723QE/i, /PHP 38,990/i],
      tools: ['findProducts', 'searchProducts'],
    },
    {
      content: 'The most expensive product is **Dell UltraSharp U2723QE** at PHP 38,990.',
      toolsUsed: ['getStockValue'],
      degraded: null,
    },
  );
  assert.equal(checks.ok, true);
  assert.equal(checks.toolHit, false);
  assert.deepEqual(checks.missing, []);
});

test('a matching tool route is still reported separately', () => {
  const checks = assessStressResult(
    { must: [/Dell/i], tools: ['findProducts', 'searchProducts'] },
    { content: 'Dell UltraSharp U2723QE', toolsUsed: ['searchProducts'], degraded: null },
  );
  assert.equal(checks.ok, true);
  assert.equal(checks.toolHit, true);
});

test('missing facts or a degraded answer still fail answer correctness', () => {
  const missing = assessStressResult(
    { must: [/\b30\b/i], tools: ['getProductsByLocation'] },
    { content: 'Demo Shop has 36 units', toolsUsed: ['getProductsByLocation'], degraded: null },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.toolHit, true);
  assert.equal(missing.missing.length, 1);

  const degraded = assessStressResult(
    { must: [], tools: ['findProducts'] },
    { content: 'I could not read that from your records just now.', toolsUsed: [], degraded: 'UNGROUNDED_ANSWER' },
  );
  assert.equal(degraded.ok, false);
  assert.equal(degraded.toolHit, false);
});
