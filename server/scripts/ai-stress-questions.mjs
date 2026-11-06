// The 120-question live AI stress suite.
//
// It is built from the same curated fixture the demo tenant uses, so every fact the
// assistant should report is known in advance: 14 real products, 12 brands, 4 categories,
// 3 locations and 136 units. The questions are grouped by what they exercise, and each
// entry names the tools that can legitimately answer it plus a few facts that must appear.
//
// HARDENED ASSERTIONS. A bare number is not evidence that the right thing was counted:
// "12 products and 99 units" passed a question whose truth was 12 products and 99 units
// only by coincidence of the digits, and a missing or negated fact could slip through the
// old keyword checks. Multi-part questions therefore declare:
//   * `all`      — complete sets (every product/restock/never-sold name);
//   * `pairs`    — a label and its value in the same line/sentence ("products" + 12,
//                  "units" + 99, "Demo Shop" + 6), so values cannot be swapped;
//   * `forbid`   — positive claims that contradict the fixture, including negated forms;
//   * `evidence` — a source URL or an explicit unavailable result for research;
//   * `toolsAny` — the evidence tool an absence or research claim must actually use.
// `must` remains for simple literal facts; it is no longer the only content check.

import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_MOVEMENTS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
  expectedLocationBreakdown,
  expectedRestock,
  expectedSummary,
  stockByProduct,
} from './demo/fixture.mjs';

const products = DEMO_PRODUCTS;
const byProduct = stockByProduct();
const productByKey = new Map(products.map((product) => [product.key, product]));
const locationName = new Map(DEMO_LOCATIONS.map((location) => [location.key, location.name]));
const summary = expectedSummary();
const locations = expectedLocationBreakdown();
const brands = [...new Set(products.map((product) => product.brand))];
const categories = DEMO_CATEGORIES;
const restock = expectedRestock();

const priceOf = (product) => Number(product.sellingPrice);
const quantityOf = (product) => byProduct.get(product.key) ?? 0;
const valueOf = (product) => priceOf(product) * quantityOf(product);

const stockValue = products.reduce((total, product) => total + valueOf(product), 0);
const categoryValue = (name) =>
  products
    .filter((product) => product.category === name)
    .reduce((total, product) => total + valueOf(product), 0);
const lowStockValue = products
  .filter((product) => quantityOf(product) <= product.minimumStock)
  .reduce((total, product) => total + valueOf(product), 0);

const neverSold = products
  .filter((product) => !DEMO_MOVEMENTS.some((movement) => movement.product === product.key && movement.type === 'STOCK_OUT'))
  .map((product) => product.name);

const latestMovement = [...DEMO_MOVEMENTS].sort((a, b) => a.daysAgo - b.daysAgo)[0];
const latestProduct = productByKey.get(latestMovement.product);
const stockOuts = DEMO_MOVEMENTS.filter((movement) => movement.type === 'STOCK_OUT');
const shopStockOut = stockOuts.find((movement) => movement.location === 'shop');
const shopStockOutProduct = shopStockOut ? productByKey.get(shopStockOut.product) : undefined;

const warehouseOutByProduct = new Map();
for (const movement of stockOuts.filter((row) => row.location === 'warehouse')) {
  warehouseOutByProduct.set(
    movement.product,
    (warehouseOutByProduct.get(movement.product) ?? 0) + movement.quantity,
  );
}
const maxWarehouseOut = Math.max(...warehouseOutByProduct.values());
const maxWarehouseOutNames = products
  .filter((product) => warehouseOutByProduct.get(product.key) === maxWarehouseOut)
  .map((product) => product.name);

const stockInWarehouse = DEMO_MOVEMENTS.filter(
  (movement) => movement.type === 'STOCK_IN' && movement.location === 'warehouse',
).map((movement) => ({
  name: productByKey.get(movement.product).name,
  quantity: movement.quantity,
}));

const lowRowsAt = (locationKey) =>
  DEMO_STOCK.filter((row) => row.location === locationKey)
    .filter((row) => row.quantity <= productByKey.get(row.product).minimumStock)
    .map((row) => ({
      name: productByKey.get(row.product).name,
      quantity: row.quantity,
    }));

const underFiveThousand = products.filter((product) => priceOf(product) < 5000);
const underTenThousand = products.filter((product) => priceOf(product) < 10000);
const belowThreeThousand = products.filter((product) => priceOf(product) < 3000);
const audioProducts = products.filter((product) => product.category === 'audio');
const cheapestAudio = [...audioProducts].sort((a, b) => priceOf(a) - priceOf(b))[0];
const mostExpensive = [...products].sort((a, b) => priceOf(b) - priceOf(a))[0];
const mostValue = [...products].sort((a, b) => valueOf(b) - valueOf(a))[0];

const brandProducts = (brand) => products.filter((product) => product.brand === brand);

const NUMBER_WORDS = new Map([
  [0, 'zero'], [1, 'one'], [2, 'two'], [3, 'three'], [4, 'four'], [5, 'five'],
  [6, 'six'], [7, 'seven'], [8, 'eight'], [9, 'nine'], [10, 'ten'],
  [11, 'eleven'], [12, 'twelve'], [13, 'thirteen'], [14, 'fourteen'], [15, 'fifteen'],
  [16, 'sixteen'], [17, 'seventeen'], [18, 'eighteen'], [19, 'nineteen'], [20, 'twenty'],
  [30, 'thirty'], [40, 'forty'], [50, 'fifty'], [60, 'sixty'], [70, 'seventy'],
  [80, 'eighty'], [90, 'ninety'],
]);

/** A digit string (or its small-number word) with optional thousands separators. */
function numberPattern(value) {
  const digits = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*');
  const word = NUMBER_WORDS.get(Number(value));
  return new RegExp(`\\b(?:${digits}${word ? `|${word}` : ''})\\b`, 'i');
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelOr = (...labels) =>
  new RegExp(labels.map((label) => (label instanceof RegExp ? label.source : escapeRegExp(label))).join('|'), 'i');

const zeroOrOut = /out of stock|zero|0 units|no units|no stock|not in stock|0 available|none/i;
const zeroDenial = /\bnot\s+(?:out of stock|zero|0 units|none|unavailable)\b/i;
const unitLabel = /(?:units?|on hand|available|stock|qty|quantity|pcs?)/i;
const priceLabel = /(?:price|cost|selling|sells?|retail|charge|PHP|₱|\$)/i;
const stockOutLabel = /(?:stock[- ]?out|stock leaving|left|outbound|sold|removed)/i;
const stockInLabel = /(?:stock[- ]?in|received|opening|arrived)/i;
const quantityPattern = (value) => (value === 0 ? zeroOrOut : numberPattern(value));

const questions = [];
let id = 0;
function add(category, question, tools, must = [], expect = {}, notes = '') {
  id += 1;
  questions.push({
    id,
    category,
    question,
    tools,
    must,
    expect,
    notes,
  });
}

// 1-28: direct product price/stock and per-location facts.
for (const product of products) {
  const quantity = quantityOf(product);
  add(
    'product',
    `What is the recorded selling price of the ${product.name}, and how many units are on hand?`,
    ['getProduct', 'getInventory', 'findProducts', 'getProductsByLocation'],
    [],
    {
      // A product-specific answer may omit the subject name ("The recorded selling
      // price is PHP 7,995; 8 units are on hand") and still answer both parts. The
      // values must still carry labels, and the requested product is unique.
      pairs: [
        // A product row such as "Royal Kludge RK61: PHP 2,499" labels the value by
        // the product itself; a prose "selling price: PHP 2,499" labels it by name.
        { label: labelOr(product.name, priceLabel), value: priceOf(product) },
        { label: unitLabel, value: quantityPattern(quantity) },
      ],
      forbid:
        quantity === 0
          ? [zeroDenial]
          : [/\b(?:is|are)\s+(?:currently\s+)?out of stock\b/i],
    },
  );

  const rows = DEMO_STOCK.filter((row) => row.product === product.key);
  add(
    'product',
    `Where is the ${product.name} stocked, and how many units are at each location?`,
    ['getProduct', 'getInventory', 'findProducts', 'getProductsByLocation'],
    [],
    {
      all: rows.length === 0 ? [product.name, zeroOrOut] : [product.name],
      pairs: rows.map((row) => ({
        label: locationName.get(row.location),
        value: row.quantity,
      })),
      forbid: rows.length === 0 ? [zeroDenial] : [],
    },
  );
}

// 29-52: brand coverage and recorded price ranges.
for (const brand of brands) {
  const covered = brandProducts(brand);
  const totalUnits = covered.reduce((total, product) => total + quantityOf(product), 0);
  const prices = covered.map(priceOf);
  add(
    'brand',
    `Which ${brand} products do you carry, and how many units are on hand across them?`,
    ['listBrands', 'searchProducts', 'findProducts', 'getInventory'],
    [],
    {
      all: [brand, ...covered.map((product) => product.name)],
      // Either the aggregate count or every per-product count completes the answer.
      pairSets: [
        [{ label: labelOr(unitLabel, /total/i), value: quantityPattern(totalUnits) }],
        covered.map((product) => ({ label: product.name, value: quantityOf(product) })),
      ],
      forbid: totalUnits === 0 ? [zeroDenial] : [],
    },
  );
  add(
    'brand',
    `What is the recorded price range for ${brand} products?`,
    ['listBrands', 'searchProducts', 'findProducts', 'getProduct'],
    [],
    {
      all: [brand],
      pairs: [
        // Single-product brands are often written as "Recorded selling price: PHP
        // 8,995" under the product name, so either label is a valid attribution.
        { label: labelOr(brand, priceLabel), value: numberPattern(Math.min(...prices)) },
        { label: labelOr(brand, priceLabel), value: numberPattern(Math.max(...prices)) },
      ],
    },
  );
}

// 53-60: categories and their value.
for (const category of categories) {
  const covered = products.filter((product) => product.category === category.key);
  const totalUnits = covered.reduce((total, product) => total + quantityOf(product), 0);
  add(
    'category',
    `Which products are in the ${category.name} category, and how many units are on hand?`,
    ['listCategories', 'searchProducts', 'findProducts', 'getInventory', 'getCatalogOverview'],
    [],
    {
      all: [category.name, ...covered.map((product) => product.name)],
      // A table of per-product quantities is as complete as a single category total.
      pairSets: [
        [{ label: labelOr(unitLabel, /total/i), value: totalUnits }],
        covered.map((product) => ({ label: product.name, value: quantityOf(product) })),
      ],
    },
  );
  add(
    'category',
    `What is the total recorded stock value of the ${category.name} category?`,
    ['getStockValue'],
    [],
    {
      // The number must be labeled as a value; the category name is not required in
      // the sentence ("The total recorded value is PHP 424,778" is complete).
      pairs: [{ label: /value|worth|total|stock/i, value: categoryValue(category.key) }],
    },
  );
}

// 61-66: location totals and local low stock.
for (const location of locations.locations) {
  const low = lowRowsAt(DEMO_LOCATIONS.find((entry) => entry.name === location.name).key);
  add(
    'location',
    `How many products and units are at the ${location.name}?`,
    ['getLocationBreakdown', 'getProductsByLocation', 'getInventory'],
    [],
    {
      all: [location.name],
      pairs: [
        { label: /products?/i, value: numberPattern(location.products) },
        { label: unitLabel, value: numberPattern(location.units) },
      ],
    },
  );
  add(
    'location',
    `What is low on stock at the ${location.name}?`,
    ['getLowStockProducts', 'getReorderNeededProducts', 'getInventory'],
    [],
    {
      all: [location.name, ...low.map((row) => row.name)],
      pairs: low.map((row) => ({ label: row.name, value: row.quantity })),
      forbid: [/\bno\b[^.\n]{0,40}\b(?:low|below|restock)/i],
    },
  );
}

// 67-76: business-wide health and value.
add(
  'health',
  'How many active products do we have, and how many units are on hand in total?',
  ['getInventorySummary', 'getCatalogOverview'],
  [],
  {
    pairs: [
      { label: /products?/i, value: numberPattern(summary.totalProducts) },
      { label: unitLabel, value: numberPattern(summary.totalInventoryQuantity) },
    ],
  },
);
add(
  'health',
  'How many products are low on stock, and how many are out of stock?',
  ['getInventorySummary', 'getLowStockProducts', 'getOutOfStockProducts'],
  [],
  {
    pairs: [
      { label: /low/i, value: numberPattern(summary.lowStockProducts) },
      { label: /out of stock|out/i, value: numberPattern(summary.outOfStockProducts) },
    ],
  },
);
add(
  'health',
  'What products need restocking, and which one is the most urgent?',
  ['getReorderNeededProducts', 'getLowStockProducts', 'getOutOfStockProducts'],
  [],
  {
    all: [...restock.map((item) => item.name), /urgent/i],
    // The question asks which products need restocking and which is most urgent; the
    // on-hand count is required for the urgent product, not for every listed row.
    pairs: [
      {
        label: restock[0].name,
        value: quantityPattern(restock[0].available),
      },
    ],
  },
);
add(
  'health',
  'Which products have never sold?',
  ['getProductsNeverSold'],
  [],
  {
    all: neverSold,
    pairs: [{ label: /never|no stock-out|not sold/i, value: numberPattern(neverSold.length) }],
  },
);
add(
  'health',
  'How many brands and categories are recorded in the catalogue?',
  ['getCatalogOverview', 'listBrands', 'listCategories'],
  [],
  {
    pairs: [
      { label: /brands?/i, value: numberPattern(brands.length) },
      { label: /categories?/i, value: numberPattern(categories.length) },
    ],
  },
);
add('health', 'How many locations do we have?', ['listLocations', 'getLocationBreakdown'], [], {
  pairs: [{ label: /locations?/i, value: numberPattern(DEMO_LOCATIONS.length) }],
});
add(
  'health',
  'What is our inventory worth at the recorded selling prices?',
  ['getStockValue'],
  [],
  {
    pairs: [{ label: /value|worth|inventory/i, value: numberPattern(stockValue) }],
  },
);
add(
  'health',
  'Which product has the most value tied up in its stock?',
  ['getStockValue', 'getInventory'],
  [],
  {
    all: [mostValue.name],
    pairs: [{ label: mostValue.name, value: numberPattern(valueOf(mostValue)) }],
  },
);
add(
  'health',
  'How is our inventory doing overall?',
  ['getInventorySummary', 'getLocationBreakdown'],
  [],
  {
    // "How is inventory doing overall?" is open-ended: the product count and the
    // low-stock count are the required labeled facts; total units are optional.
    pairs: [
      { label: /products?/i, value: numberPattern(summary.totalProducts) },
      { label: /low/i, value: numberPattern(summary.lowStockProducts) },
    ],
  },
);
add(
  'health',
  'How many products are healthy in stock, and how many are at or below minimum?',
  ['getInventorySummary'],
  [],
  {
    pairs: [
      { label: /healthy|in stock|above/i, value: numberPattern(summary.inStockProducts) },
      { label: /low|minimum/i, value: numberPattern(summary.lowStockProducts) },
    ],
  },
);

// 77-84: movement history and dead stock.
add('history', 'Show me the most recent stock movements.', ['getInventoryHistory'], [], {
  all: [latestProduct.name],
  // A grouped list labels the section once and then lists each movement, so the
  // product and its quantity are the record; the section word is checked by `any`.
  lineAll: [[latestProduct.name, numberPattern(latestMovement.quantity)]],
  any: [stockOutLabel, stockInLabel],
  forbid: [/\bno (?:stock )?movements?\b/i],
});
add(
  'history',
  'How many stock-out movements are recorded?',
  ['getInventoryHistory'],
  [],
  {
    pairs: [{ label: stockOutLabel, value: numberPattern(stockOuts.length) }],
    forbid: [/\bno stock[- ]?out/i],
  },
);
add(
  'history',
  'Which product had the most units leave the warehouse?',
  ['getInventoryHistory'],
  [],
  {
    all: maxWarehouseOutNames,
    pairs: maxWarehouseOutNames.map((name) => ({ label: name, value: maxWarehouseOut, allowComma: true })),
    any: [/most|highest|tied|top/i],
  },
);
add(
  'history',
  'What came into the Demo Warehouse?',
  ['getInventoryHistory'],
  [],
  {
    all: stockInWarehouse.map((row) => row.name),
    pairs: stockInWarehouse.map((row) => ({ label: row.name, value: row.quantity })),
    any: [/Demo Warehouse/i, stockInLabel],
  },
);
add(
  'history',
  'Have any products never sold?',
  ['getProductsNeverSold'],
  [],
  {
    all: neverSold,
    pairs: [{ label: /never|no stock-out|not sold/i, value: numberPattern(neverSold.length) }],
  },
);
add(
  'history',
  'Which products have never left the shelf?',
  ['getProductsNeverSold'],
  [],
  {
    all: neverSold,
  },
);
add(
  'history',
  'What moved out of the Demo Shop recently?',
  ['getInventoryHistory'],
  [],
  {
    all: ['Demo Shop', shopStockOutProduct.name],
    pairs: [{ label: shopStockOutProduct.name, value: shopStockOut.quantity }],
    any: [stockOutLabel],
  },
);
add(
  'history',
  'Show recent activity for the Logitech MX Keys S.',
  ['getInventoryHistory'],
  [],
  {
    all: ['Logitech MX Keys S'],
    // The answer groups stock-outs and stock-ins under headings, so each movement is
    // checked as one bullet: quantity, location and direction on the same line.
    lineAll: [
      [numberPattern(2), 'Demo Shop', stockOutLabel],
      [numberPattern(6), 'Demo Warehouse', stockOutLabel],
      [numberPattern(8), 'Demo Shop', stockInLabel],
      [numberPattern(24), 'Demo Warehouse', stockInLabel],
    ],
  },
);

// 85-96: recommendations and recorded comparisons.
add(
  'recommendation',
  'Which gaming headset do you recommend, and why?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['SteelSeries Arctis Nova 7', /recommend|because|why|gaming|suitable/i],
    pairs: [
      { label: priceLabel, value: 9995 },
      { label: unitLabel, value: 8 },
    ],
  },
);
add(
  'recommendation',
  'Which headset is better for office calls?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['Sony WH-1000XM5', 'SteelSeries Arctis Nova 7'],
    pairs: [
      { label: labelOr('Sony WH-1000XM5', priceLabel), value: 19990 },
      { label: labelOr('SteelSeries Arctis Nova 7', priceLabel), value: 9995 },
    ],
    any: [/office|call|microphone|noise|better/i],
  },
);
add(
  'recommendation',
  'Which mechanical keyboard should I buy for under 7,000?',
  ['findProducts', 'getInventory'],
  [],
  {
    all: ['Royal Kludge RK61', 'Keychron K8 Pro', /under|below|7,000/i],
    pairs: [
      { label: 'Royal Kludge RK61', value: 2499 },
      { label: 'Keychron K8 Pro', value: 6990 },
    ],
  },
);
add(
  'recommendation',
  'Which mouse do you recommend for office work?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['Logitech MX Master 3S', /office|ergonomic|productivity|recommend/i],
    pairs: [
      { label: labelOr('Logitech MX Master 3S', priceLabel), value: 5490 },
      { label: unitLabel, value: 4 },
    ],
  },
);
add(
  'recommendation',
  'Which monitor is best for gaming?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['LG UltraGear 27GP850-B', /gaming|refresh|165|response/i],
    pairs: [
      { label: labelOr('LG UltraGear 27GP850-B', priceLabel), value: 22995 },
      { label: unitLabel, value: 3 },
    ],
  },
);
add(
  'recommendation',
  'Which monitor should I get for photo editing?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['Dell UltraSharp U2723QE', /photo|editing|4K|IPS/i],
    pairs: [
      { label: labelOr('Dell UltraSharp U2723QE', priceLabel), value: 38990 },
      { label: unitLabel, value: 2 },
    ],
  },
);
add(
  'recommendation',
  'Which webcam is best for meetings?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['Logitech C920s HD Pro Webcam', /meeting|webcam|1080/i],
    pairs: [
      { label: labelOr('Logitech C920s HD Pro Webcam', priceLabel), value: 3495 },
      { label: unitLabel, value: 12 },
    ],
  },
);
add(
  'recommendation',
  'Which portable SSD should I buy for travel?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: [/Samsung/i, /T7 Shield/i, /travel|portable|recommend/i],
    pairs: [
      { label: priceLabel, value: 7995 },
      { label: unitLabel, value: 8 },
    ],
    forbid: [/\bno (?:matching )?(?:products?|ssd)\b/i],
  },
);
add(
  'recommendation',
  'Which power bank do you recommend for a laptop?',
  ['findProducts', 'researchInventoryProducts'],
  [],
  {
    all: ['Anker 737 Power Bank', /laptop|power|140/i],
    // Stock is optional context for a recommendation; the price and reason are the
    // required parts, so either the warehouse count or a total can appear.
    pairs: [{ label: labelOr('Anker 737 Power Bank', priceLabel), value: 8995 }],
  },
);
add(
  'recommendation',
  'Compare the Sony WH-1000XM5 and SteelSeries Arctis Nova 7.',
  ['findProducts', 'getProduct', 'researchInventoryProducts'],
  [],
  {
    all: ['Sony WH-1000XM5', 'SteelSeries Arctis Nova 7'],
    pairs: [
      { label: priceLabel, value: 19990 },
      { label: priceLabel, value: 9995 },
    ],
    any: [/compare|difference|price|spec/i],
  },
);
add(
  'recommendation',
  'Compare the Dell UltraSharp U2723QE and LG UltraGear 27GP850-B.',
  ['findProducts', 'getProduct', 'researchInventoryProducts'],
  [],
  {
    all: ['Dell UltraSharp U2723QE', 'LG UltraGear 27GP850-B'],
    pairs: [
      { label: priceLabel, value: 38990 },
      { label: priceLabel, value: 22995 },
    ],
    any: [/compare|difference|price|spec/i],
  },
);
add(
  'recommendation',
  'Compare the Keychron K8 Pro and Royal Kludge RK61.',
  ['findProducts', 'getProduct'],
  [],
  {
    all: ['Keychron K8 Pro', 'Royal Kludge RK61'],
    pairs: [
      { label: priceLabel, value: 6990 },
      { label: priceLabel, value: 2499 },
    ],
    any: [/compare|difference|price|spec|stock/i],
  },
);

// 97-104: live web research, using the free fallback (paid search stays off).
const researchExpect = (name, extraMust = []) => ({
  all: Array.isArray(name) ? name : [name],
  any: extraMust,
  evidence: true,
  toolsAny: ['researchInventoryProducts', 'researchMarketPrices'],
});
add(
  'research',
  'Research owner reviews and reliability for the Logitech MX Master 3S.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('Logitech MX Master 3S', [/review|owner|reliability|quality/i]),
);
add(
  'research',
  'Research the quality and reliability of the Keychron K8 Pro.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('Keychron K8 Pro', [/quality|reliability|review|source/i]),
);
add(
  'research',
  'Research the Samsung T7 Shield specifications and reviews.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect([/Samsung/i, /T7 Shield/i], [/spec|capacity|interface|USB|TB|review/i]),
);
add(
  'research',
  'Is the Sony WH-1000XM5 well reviewed? Cite your sources.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('Sony WH-1000XM5', [/review|rating|well reviewed|source/i]),
);
add(
  'research',
  'Compare current online prices for the Samsung T7 Shield.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('Samsung Portable SSD T7 Shield 1TB', [/price|cost|charge/i]),
);
add(
  'research',
  'What do online stores charge for the Keychron K8 Pro?',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('Keychron K8 Pro', [/price|cost|charge/i]),
);
add(
  'research',
  'Research the SteelSeries Arctis Nova 7 for gaming.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('SteelSeries Arctis Nova 7', [/gaming|review|quality/i]),
);
add(
  'research',
  'Research the LG UltraGear 27GP850-B for gaming.',
  ['findProducts', 'researchInventoryProducts', 'researchMarketPrices'],
  [],
  researchExpect('LG UltraGear 27GP850-B', [/gaming|review|refresh|Hz/i]),
);

// 105-112: affordability and value.
add(
  'value',
  'Which products cost less than 5,000?',
  ['findProducts', 'searchProducts'],
  [],
  {
    all: underFiveThousand.map((product) => product.name),
    pairs: underFiveThousand.map((product) => ({ label: product.name, value: priceOf(product) })),
    forbid: [/\bno (?:products?|matches?)\b/i, /\bnone\b[^.\n]{0,40}\b(?:under|below|5,000)/i],
  },
);
add(
  'value',
  'Which products cost less than 10,000?',
  ['findProducts', 'searchProducts'],
  [],
  {
    all: underTenThousand.map((product) => product.name),
    pairs: underTenThousand.map((product) => ({ label: product.name, value: priceOf(product) })),
  },
);
add('value', 'Which is the cheapest audio product?', ['findProducts', 'searchProducts'], [], {
  all: [cheapestAudio.name],
  pairs: [{ label: cheapestAudio.name, value: priceOf(cheapestAudio) }],
  any: [/cheapest|lowest|least expensive/i],
  forbid: [/\bno audio product/i],
});
add(
  'value',
  'Which is the most expensive product we carry?',
  ['findProducts', 'searchProducts'],
  [],
  {
    all: [mostExpensive.name],
    pairs: [{ label: mostExpensive.name, value: priceOf(mostExpensive) }],
    any: [/most expensive|highest|expensive/i],
  },
);
add(
  'value',
  'Which keyboard is the best value under 10,000?',
  ['findProducts', 'getStockValue'],
  [],
  {
    all: [/best value|value/i, /under 10,000|under 10k|10,000/i],
    any: [
      /Royal Kludge RK61[\s\S]{0,120}2,499/i,
      /Keychron K8 Pro[\s\S]{0,120}6,990/i,
      /MX Keys S[\s\S]{0,120}6,290/i,
    ],
    forbid: [/\b(?:Razer|ASUS|Dell|LG)\b[^\n]{0,80}\b(?:is|are)\s+(?:the\s+)?best\b/i],
  },
);
add('value', 'What is the total value of our accessories?', ['getStockValue'], [], {
  pairs: [{ label: /value|worth|total|stock/i, value: categoryValue('accessories') }],
});
add(
  'value',
  'What can I buy for a home office with a 20,000 budget?',
  ['findProducts', 'getInventory'],
  [],
  {
    all: [/under|within|budget|20,000/i],
    any: [
      'Royal Kludge RK61',
      'Keychron K8 Pro',
      'Logitech MX Keys S',
      'Logitech MX Master 3S',
      'Logitech C920s HD Pro Webcam',
      'Sony WH-1000XM5',
      'Anker 737 Power Bank',
      'Samsung Portable SSD T7 Shield 1TB',
      'Elgato Stream Deck MK.2',
      'SteelSeries Arctis Nova 7',
    ],
    forbid: [
      /(?:22,995|LG UltraGear)[^.\n]{0,80}\b(?:fits?|within|affordable|can afford|is under)\b/i,
      /(?:38,990|Dell UltraSharp)[^.\n]{0,80}\b(?:fits?|within|affordable|can afford|is under)\b/i,
    ],
  },
);
add(
  'value',
  'Which product has the highest recorded price per unit?',
  ['findProducts', 'searchProducts'],
  [],
  {
    all: [mostExpensive.name],
    pairs: [{ label: mostExpensive.name, value: priceOf(mostExpensive) }],
    any: [/highest|most expensive|price per unit/i],
  },
);

// 113-120: compound questions and edge cases.
add(
  'edge',
  'Do we carry Samsung products, and what is the stock range across SKUs?',
  ['listBrands', 'searchProducts', 'getInventory'],
  [],
  {
    all: [/Samsung/i, /T7 Shield/i, /(?:one|single|only|1)\s+(?:Samsung\s+)?SKU/i],
    // There is ONE Samsung SKU, with 6 units at the warehouse + 2 at the shop.
    // Its SKU range is therefore the SKU's total, 8 units — not a 2-to-6
    // location range masquerading as an across-SKU answer.
    pairs: [
      { label: /total|across|on hand|units?/i, value: 8 },
      { label: 'Demo Warehouse', value: 6 },
      { label: 'Demo Shop', value: 2 },
    ],
    forbid: [
      /\b2 (?:SKUs|products)\b/i,
      /\bthree locations\b/i,
      /\b0\s*(?:to|[-–])\s*6\b/i,
      /\b2\s*(?:to|[-–])\s*6\b/i,
    ],
  },
);
add(
  'edge',
  'Which Logitech products are low on stock?',
  ['searchProducts', 'getLowStockProducts', 'getInventory'],
  [],
  {
    all: ['Logitech MX Master 3S', /only|one product|1 product/i],
    pairs: [{ label: 'Logitech MX Master 3S', value: 4 }],
    forbid: [/\bMX Master 3S\b[^\n]{0,80}\bnot (?:low|below)\b/i],
  },
);
add(
  'edge',
  'What is the total recorded value of the low-stock items?',
  ['getLowStockProducts', 'getStockValue'],
  [],
  {
    all: [/low[- ]stock|reorder/i],
    pairs: [{ label: /low[- ]stock|reorder/i, value: lowStockValue }],
  },
);
add(
  'edge',
  'Is the ASUS ROG Strix Flare II Animate available?',
  ['searchProducts', 'getProduct', 'getInventory'],
  [],
  {
    all: ['ASUS ROG Strix Flare II Animate', zeroOrOut],
    forbid: [zeroDenial],
  },
);
add(
  'edge',
  'Do we have any products for vehicle repairs?',
  ['findProducts', 'getCatalogOverview'],
  [],
  {
    any: [
      /\bno\b(?!\s+(?:more|fewer|less)\s+than\b)[^.\n]{0,30}\b(?:products?|items?|matches?)\b/i,
      /\bnone\b/i,
      /\bnothing\b/i,
    ],
    forbid: [/\b(?:can't|cannot|don't know|not sure|insufficient)\b/i],
  },
);
add(
  'edge',
  'What is the stock range across Logitech products?',
  ['searchProducts', 'getInventory'],
  [],
  {
    all: [/4\s*(?:to|[-–])\s*24/i],
    pairs: [{ label: /range|from|between/i, value: /4\s*(?:to|[-–])\s*24/i }],
    forbid: [/\b4 (?:products|Logitech products)\b/i],
  },
);
add(
  'edge',
  'Compare the stock and price of the two 27-inch monitors.',
  ['searchProducts', 'getProduct', 'getInventory'],
  [],
  {
    all: ['Dell UltraSharp U2723QE', 'LG UltraGear 27GP850-B'],
    // The comparison is usually a table: stock and price share the model's row.
    lineAll: [
      ['Dell UltraSharp U2723QE', numberPattern(2), numberPattern(38990)],
      ['LG UltraGear 27GP850-B', numberPattern(3), numberPattern(22995)],
    ],
    forbid: [/\b1,401\b|\b570\b/i],
  },
);
add(
  'edge',
  'Which brands have products under 3,000?',
  ['findProducts', 'listBrands'],
  [],
  {
    all: [belowThreeThousand[0].brand, /RK61/i, /under|below|less than/i],
    pairs: [
      {
        label: labelOr(belowThreeThousand[0].brand, /RK61/i, priceLabel),
        value: priceOf(belowThreeThousand[0]),
      },
    ],
    forbid: [/\bnone of the brands\b/i],
  },
);

if (questions.length !== 120) {
  throw new Error(`The stress suite must contain exactly 120 questions; built ${questions.length}.`);
}

export const STRESS_QUESTIONS = Object.freeze(questions.map((question) => Object.freeze(question)));

export function buildStressQuestions() {
  return STRESS_QUESTIONS;
}

export default { STRESS_QUESTIONS, buildStressQuestions };
