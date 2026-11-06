// The DEMO TENANT fixture — one small, fully known inventory, and the numbers it
// must produce.
//
// WHY A HAND-WRITTEN FIXTURE RATHER THAN THE GENERATOR. `seed:demo` produces a
// realistic dataset of tens of thousands of documents, which is right for
// measuring queries and wrong for checking an answer: nobody can say what the
// total SHOULD be. Every quantity, location and minimum below is chosen so the
// expected summary, the expected per-location breakdown and the expected restock
// list are exact integers a test — or a person reading the phone — can compare
// against without querying anything. That is the whole point: an assistant answer
// is only verifiable when the ground truth is known in advance.
//
// THE PRODUCTS ARE REAL. Names, brands, descriptions and specifications come from
// `seed/catalog.mjs`, which records the manufacturer source beside each row. The
// fixture is still small and deterministic, but the assistant now has the model,
// brand and specification facts a real comparison needs.
//
// THE SHAPE IS DELIBERATELY NON-DEGENERATE. It contains healthy products, products
// spread over two locations, products below their minimum, and one product with NO
// inventory row at all (which the specification defines as zero stock, not missing
// stock). A fixture where every row is healthy would leave the restock path, the
// out-of-stock count and the "missing row is zero" rule all unexercised.
//
// NOTHING HERE CONNECTS OR WRITES. It is data plus pure arithmetic; the CLI and
// its library do the I/O. A fixture module that opens a connection on import is
// how a test run writes to a database.

import { CATALOG_CATEGORIES, CATALOG_PRODUCTS } from '../seed/catalog.mjs';

/** The tenant's identity. Both fingerprints are checked before anything is deleted. */
export const DEMO_TENANT = {
  businessName: 'DEMO PREVIEW — safe to delete',
  ownerName: 'Demo Tester',
  // `.invalid` is reserved by RFC 2606 and can never resolve, so no mail can be
  // sent here by accident. The identity is created with `emailVerified: true`
  // because it is a test credential, not a person.
  email: 'demo-preview@example.invalid',
  role: 'OWNER',
};

/** Three places, so a per-location answer has something to compare. */
export const DEMO_LOCATIONS = [
  { key: 'warehouse', name: 'Demo Warehouse' },
  { key: 'shop', name: 'Demo Shop' },
  { key: 'van', name: 'Demo Van' },
];

export const DEMO_CATEGORIES = CATALOG_CATEGORIES.map((category) => ({ ...category }));

/**
 * Stock thresholds are fixture choices, not manufacturer facts. They create one
 * out-of-stock product, three low-stock products and a healthy majority.
 */
const MINIMUM_STOCK = Object.freeze({
  'mx-keys-s': 5,
  'keychron-k8-pro': 6,
  'rog-flare-ii': 3,
  'razer-blackwidow-v4-pro': 3,
  'royal-kludge-rk61': 8,
  'mx-master-3s': 5,
  'sony-wh-1000xm5': 4,
  'arctis-nova-7': 4,
  'dell-u2723qe': 2,
  'lg-27gp850-b': 2,
  'anker-737': 4,
  'samsung-t7-shield': 5,
  'logitech-c920s': 6,
  'elgato-stream-deck-mk2': 3,
});

/**
 * The ACTIVE catalogue. `minimumStock` is what makes a product "low" (available
 * at or below the minimum), so the restock expectations below are derived from
 * these values rather than restated.
 */
export const DEMO_PRODUCTS = CATALOG_PRODUCTS.map((product, index) => ({
  ...product,
  sku: `DEMO-${String(index + 1).padStart(3, '0')}`,
  minimumStock: MINIMUM_STOCK[product.key] ?? 5,
}));

/**
 * On-hand inventory. `rog-flare-ii` has NO row on purpose: zero stock is the
 * absence of a row, and the dashboard's definition counts it as out of stock.
 *
 * Three products are at or below their threshold, one of which is the product with
 * no row. Several products are held in two locations so a location answer is not
 * degenerate.
 */
export const DEMO_STOCK = [
  { product: 'mx-keys-s', location: 'warehouse', quantity: 18 },
  { product: 'mx-keys-s', location: 'shop', quantity: 6 },
  { product: 'keychron-k8-pro', location: 'warehouse', quantity: 4 },
  { product: 'keychron-k8-pro', location: 'shop', quantity: 2 },
  { product: 'razer-blackwidow-v4-pro', location: 'warehouse', quantity: 7 },
  { product: 'razer-blackwidow-v4-pro', location: 'van', quantity: 3 },
  { product: 'royal-kludge-rk61', location: 'warehouse', quantity: 22 },
  { product: 'royal-kludge-rk61', location: 'shop', quantity: 10 },
  { product: 'mx-master-3s', location: 'warehouse', quantity: 3 },
  { product: 'mx-master-3s', location: 'shop', quantity: 1 },
  { product: 'sony-wh-1000xm5', location: 'warehouse', quantity: 8 },
  { product: 'sony-wh-1000xm5', location: 'shop', quantity: 4 },
  { product: 'arctis-nova-7', location: 'warehouse', quantity: 5 },
  { product: 'arctis-nova-7', location: 'shop', quantity: 3 },
  { product: 'dell-u2723qe', location: 'warehouse', quantity: 2 },
  { product: 'lg-27gp850-b', location: 'warehouse', quantity: 3 },
  { product: 'anker-737', location: 'warehouse', quantity: 9 },
  { product: 'anker-737', location: 'van', quantity: 4 },
  { product: 'samsung-t7-shield', location: 'warehouse', quantity: 6 },
  { product: 'samsung-t7-shield', location: 'shop', quantity: 2 },
  { product: 'logitech-c920s', location: 'warehouse', quantity: 12 },
  { product: 'elgato-stream-deck-mk2', location: 'shop', quantity: 2 },
];

/**
 * Recent stock-outs used to build a ledger that ENDS at `DEMO_STOCK`. Keeping the
 * outbound quantities here rather than hand-writing opening balances means the
 * opening quantity and the final quantity cannot disagree.
 */
const DEMO_OUTBOUND = [
  { product: 'mx-keys-s', location: 'warehouse', quantity: 6, daysAgo: 8, reason: 'Sales and transfers' },
  { product: 'mx-keys-s', location: 'shop', quantity: 2, daysAgo: 6, reason: 'Sales and transfers' },
  { product: 'keychron-k8-pro', location: 'warehouse', quantity: 4, daysAgo: 5, reason: 'Sales and transfers' },
  { product: 'razer-blackwidow-v4-pro', location: 'warehouse', quantity: 3, daysAgo: 4, reason: 'Sales and transfers' },
  { product: 'royal-kludge-rk61', location: 'warehouse', quantity: 8, daysAgo: 3, reason: 'Sales and transfers' },
  { product: 'mx-master-3s', location: 'warehouse', quantity: 2, daysAgo: 2, reason: 'Sales and transfers' },
  { product: 'sony-wh-1000xm5', location: 'warehouse', quantity: 2, daysAgo: 1, reason: 'Sales and transfers' },
  { product: 'samsung-t7-shield', location: 'warehouse', quantity: 2, daysAgo: 7, reason: 'Sales and transfers' },
];

/**
 * Ledger rows whose arithmetic is true by construction: STOCK_IN adds, STOCK_OUT
 * subtracts, and each row's `previousQuantity`/`newQuantity` chain ends at exactly
 * the `DEMO_STOCK` figure for that (product, location).
 *
 * `seed-perf-data` taught this lesson the hard way: a ledger that always ADDED
 * made 6 615 of 6 616 STOCK_OUT rows claim stock went up, and the assistant
 * reported that faithfully (§27BG). A fixture is not exempt from the invariant
 * it is used to check.
 */
export const DEMO_MOVEMENTS = (() => {
  const finalByKey = new Map(
    DEMO_STOCK.map((row) => [`${row.product}@${row.location}`, row.quantity]),
  );
  const outByKey = new Map(
    DEMO_OUTBOUND.map((row) => [`${row.product}@${row.location}`, row.quantity]),
  );
  const rows = [];
  for (const stock of DEMO_STOCK) {
    const key = `${stock.product}@${stock.location}`;
    const opening = stock.quantity + (outByKey.get(key) ?? 0);
    rows.push({
      product: stock.product,
      location: stock.location,
      type: 'STOCK_IN',
      quantity: opening,
      previousQuantity: 0,
      newQuantity: opening,
      daysAgo: 30,
      reason: 'Opening stock count',
    });
  }
  for (const out of DEMO_OUTBOUND) {
    const key = `${out.product}@${out.location}`;
    const final = finalByKey.get(key) ?? 0;
    rows.push({
      product: out.product,
      location: out.location,
      type: 'STOCK_OUT',
      quantity: out.quantity,
      previousQuantity: final + out.quantity,
      newQuantity: final,
      daysAgo: out.daysAgo,
      reason: out.reason,
    });
  }
  return rows;
})();

/** The quantity on hand per product, summed over every location. */
export function stockByProduct() {
  const totals = new Map(DEMO_PRODUCTS.map((p) => [p.key, 0]));
  for (const row of DEMO_STOCK) totals.set(row.product, (totals.get(row.product) ?? 0) + row.quantity);
  return totals;
}

/** The quantity on hand per location. */
export function stockByLocation() {
  const totals = new Map(DEMO_LOCATIONS.map((l) => [l.key, 0]));
  for (const row of DEMO_STOCK) totals.set(row.location, (totals.get(row.location) ?? 0) + row.quantity);
  return totals;
}

/**
 * What `getInventorySummary` and the dashboard must answer, by §19's own
 * definitions: low = available <= minimumStock, out = available <= 0, and
 * inStock is the complement of low among ACTIVE products.
 */
export function expectedSummary() {
  const byProduct = stockByProduct();
  const low = DEMO_PRODUCTS.filter((p) => (byProduct.get(p.key) ?? 0) <= p.minimumStock);
  const out = DEMO_PRODUCTS.filter((p) => (byProduct.get(p.key) ?? 0) <= 0);
  const totalInventoryQuantity = DEMO_STOCK.reduce((sum, row) => sum + row.quantity, 0);
  return {
    totalProducts: DEMO_PRODUCTS.length,
    totalInventoryQuantity,
    lowStockProducts: low.length,
    outOfStockProducts: out.length,
    inStockProducts: DEMO_PRODUCTS.length - low.length,
    lowStockNames: low.map((p) => p.name),
    outOfStockNames: out.map((p) => p.name),
  };
}

/**
 * What `getLocationBreakdown` must answer: per location, the number of DISTINCT
 * products held and the units on hand, plus business totals counted over
 * distinct products (so a product in two places counts once).
 */
export function expectedLocationBreakdown() {
  const byLocation = stockByLocation();
  const distinctByLocation = new Map(DEMO_LOCATIONS.map((l) => [l.key, new Set()]));
  for (const row of DEMO_STOCK) distinctByLocation.get(row.location).add(row.product);
  const stockedProducts = new Set(DEMO_STOCK.map((row) => row.product));
  return {
    locations: DEMO_LOCATIONS.map((l) => ({
      name: l.name,
      products: distinctByLocation.get(l.key).size,
      units: byLocation.get(l.key),
    })),
    totals: {
      products: stockedProducts.size,
      units: DEMO_STOCK.reduce((sum, row) => sum + row.quantity, 0),
    },
  };
}

/**
 * What `getReorderNeededProducts` must answer, in the order the server returns:
 * out-of-stock first, then low stock.
 */
export function expectedRestock() {
  const byProduct = stockByProduct();
  const rows = DEMO_PRODUCTS
    .filter((p) => (byProduct.get(p.key) ?? 0) <= p.minimumStock)
    .map((p) => ({
      name: p.name,
      available: byProduct.get(p.key) ?? 0,
      minimumStock: p.minimumStock,
      stockStatus: (byProduct.get(p.key) ?? 0) <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
      shortfall: p.minimumStock - (byProduct.get(p.key) ?? 0),
    }));
  return [...rows.filter((r) => r.stockStatus === 'OUT_OF_STOCK'), ...rows.filter((r) => r.stockStatus !== 'OUT_OF_STOCK')];
}

export default {
  DEMO_TENANT,
  DEMO_LOCATIONS,
  DEMO_CATEGORIES,
  DEMO_PRODUCTS,
  DEMO_STOCK,
  DEMO_MOVEMENTS,
  stockByProduct,
  stockByLocation,
  expectedSummary,
  expectedLocationBreakdown,
  expectedRestock,
};
