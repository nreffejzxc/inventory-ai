// AI-51 — the defects the full tool audit found, each pinned by a test.
//
// The audit ran every assistant tool against a real tenant and compared the output
// to raw Mongo aggregates. Data reads matched; the problems were at the edges:
//
// 1. HTML entities survived into research titles (`Keychron K8 &ndash; Review`),
//    so the assistant quoted markup as if it were a product name.
// 2. A brand's price range took min/max across products in different currencies,
//    which is a number in no currency at all now that `currency` exists.
// 3. `researchMarketPrices` returned a fixed "Shopee, Lazada, Amazon" list even
//    when the free search never targeted them, inviting a false "I checked
//    Shopee" answer.
// 4. `searchProducts` searched name/brand/SKU only, so the everyday word
//    ("keyboard") found nothing while the description held the product.
// 5. A one-product research group was searched and keyed by brand, so a sibling
//    model's review answered for the recorded product.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool, aiToolsById } from '../src/services/ai/tools.ts';
import { cleanSearchText, decodeHtmlEntities } from '../src/services/ai/freeWeb.ts';
import { fallbackQuery, findingsFromSources } from '../src/services/ai/webResearch.ts';
import { RECORDED_PRICE_NOTE, freePriceQuery, productPageHint } from '../src/services/ai/marketPrices.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

const ctxOf = (session) => ({ businessId: session.businessId, userId: session.userId, role: ROLES.OWNER });

async function ok(name, args, ctx) {
  const res = await executeTool(name, args, ctx);
  assert.equal(res.ok, true, `${name} answered ${JSON.stringify(res)}`);
  return res.result;
}

unitSuite('AI-51 research text and search queries', () => {
  it('★ decodes the named, numeric and double-escaped entities a shop title carries', () => {
    assert.equal(decodeHtmlEntities('Keychron K8 &ndash; Review'), 'Keychron K8 – Review');
    assert.equal(decodeHtmlEntities('Logitech &#8211; MX Keys'), 'Logitech – MX Keys');
    assert.equal(decodeHtmlEntities('It&amp;rsquo;s here'), 'It’s here');
    assert.equal(decodeHtmlEntities('5 &times; 3 &deg;'), '5 × 3 °');
    assert.equal(decodeHtmlEntities('Fish &amp; Chips'), 'Fish & Chips');
    // An unknown entity is left alone rather than dropped.
    assert.equal(decodeHtmlEntities('&bogus; text'), '&bogus; text');
    // Tags are removed and the text still decodes.
    assert.equal(cleanSearchText('<b>Shop</b> &mdash; Home'), 'Shop — Home');
  });

  it('★ a price query does not quote a brand the product name already carries', () => {
    // AI-53 — unquoted, because an exact-phrase query only finds pages that repeat the
    // name, and the storefronts that state a price are not those pages (measured
    // 2026-11-04: `"Redragon K552 Kumara" price` returned two pages, one behind a 403).
    assert.equal(
      freePriceQuery({ id: 'p1', name: 'Keychron K8 Pro', brand: 'Keychron' }),
      'Keychron K8 Pro price',
    );
    assert.equal(
      freePriceQuery({ id: 'p2', name: 'RK61 60% Board', brand: 'Royal Kludge' }),
      'Royal Kludge RK61 60% Board price',
    );
    assert.equal(freePriceQuery({ id: 'p3', name: 'Ultra Padlock 10998', brand: null }), 'Ultra Padlock 10998 price');
    // The recorded currency names the market, so local storefronts rank first.
    assert.equal(
      freePriceQuery({ id: 'p4', name: 'Redragon K552 Kumara', brand: 'Redragon', currency: 'PHP' }),
      'Redragon K552 Kumara price Philippines',
    );
    assert.equal(
      freePriceQuery({ id: 'p5', name: 'Logitech MX Keys', brand: 'Logitech', currency: 'USD' }),
      'Logitech MX Keys price USA',
    );
  });

  it('★ page candidates prefer a product page over a category listing', () => {
    assert.equal(productPageHint('https://www.keychron.com/products/keychron-k8-pro'), 2);
    assert.equal(
      productPageHint('https://shopee.ph/Keychron-K8-Pro-i.308793963.21794131531'),
      2,
    );
    // A listing page quotes many prices for many products, so it is never fetched.
    assert.equal(productPageHint('https://www.lazada.com.ph/catalog/?q=Keychron%20K8'), 0);
    assert.equal(productPageHint('https://www.lazada.com.ph/tag/keychron-k8-pro/'), 0);
    assert.equal(productPageHint('https://example.com/blog/k8-pro-review'), 1);
  });

  it('★ a single-product group searches and is keyed by the product, not its brand', () => {
    const group = {
      brand: 'Keychron',
      subjects: [{ id: 'p1', name: 'Keychron K8 Pro', brand: 'Keychron' }],
    };
    const query = fallbackQuery(group, 'overall');
    assert.match(query, /"Keychron K8 Pro"/);
    // The brand must not be quoted a second time: it pulled sibling-model reviews.
    assert.equal((query.match(/Keychron/g) ?? []).length, 1);

    const findings = findingsFromSources(group, [
      { title: 'K8 Pro review', url: 'https://example.com/k8pro', snippet: 'Solid board.' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, 'Keychron K8 Pro');
    assert.equal(findings[0].kind, 'product');
    assert.match(findings[0].finding, /Search-result evidence for Keychron K8 Pro/);
  });

  it('★ a multi-product brand group stays a brand finding', () => {
    const group = {
      brand: 'Keychron',
      subjects: [
        { id: 'p1', name: 'Keychron K8 Pro', brand: 'Keychron' },
        { id: 'p2', name: 'Keychron K2', brand: 'Keychron' },
      ],
    };
    assert.match(fallbackQuery(group, 'quality'), /"Keychron"/);
    const findings = findingsFromSources(group, [
      { title: 'Keychron lineup', url: 'https://example.com/lineup' },
    ]);
    assert.equal(findings[0].name, 'Keychron');
    assert.equal(findings[0].kind, 'brand');
  });

  it('★ the recorded-price note knows the catalogue now has a currency field', () => {
    assert.doesNotMatch(RECORDED_PRICE_NOTE, /no currency field/i);
    assert.match(RECORDED_PRICE_NOTE, /ISO-4217/);
    assert.match(RECORDED_PRICE_NOTE, /do not convert/i);
  });

  it('★ the price tool description does not promise marketplaces the free path never queries', () => {
    const tool = aiToolsById.get('researchMarketPrices');
    assert.ok(tool, 'researchMarketPrices is missing from the tool table');
    assert.match(tool.description, /searchedQueries/);
    assert.match(tool.description, /checkedMarketplaces/);
    assert.match(tool.description, /could not price/);
  });

  it('★ searchProducts tells the model it retries descriptions', () => {
    const tool = aiToolsById.get('searchProducts');
    assert.ok(tool, 'searchProducts is missing from the tool table');
    assert.match(tool.description, /matchedOn/);
  });
});

dbSuite('AI-51 tool behaviour against recorded rows', dbOk, () => {
  let A;
  let Band;

  before(async () => {
    A = await registerOwner(api, tracker);
    Band = await registerOwner(api, tracker);
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  const makeProduct = async (session, body) => {
    const res = await api('POST', '/api/products', { token: session.token, body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  };

  it('★ a description-only word still finds the product, and says how it matched', async () => {
    const word = uniqueName('mechanicalkeyboard').toLowerCase();
    const product = await makeProduct(A, {
      name: uniqueName('KZ Quiet Board'),
      brand: 'KZ',
      description: `Compact ${word} with brown switches`,
      sellingPrice: 3499,
      currency: 'PHP',
      unit: 'pc',
      minimumStock: 1,
    });

    const result = await ok('searchProducts', { q: word }, ctxOf(A));
    assert.equal(result.count, 1);
    assert.equal(result.items[0].id, product.id);
    assert.deepEqual(result.matchedOn, ['description', 'specifications']);
    assert.match(result.note, /description or specifications/i);
    // The catalog grounding note must not be shown for a confirmed match.
    assert.equal(result.items[0].currency, 'PHP');
  });

  it('★ a name match keeps the normal note and does not claim a description match', async () => {
    const name = uniqueName('KZ Wired Mouse');
    await makeProduct(A, { name, brand: 'KZ', sellingPrice: 499, currency: 'PHP', unit: 'pc' });
    const result = await ok('searchProducts', { q: name }, ctxOf(A));
    assert.equal(result.count, 1);
    assert.equal(result.matchedOn, undefined);
    assert.doesNotMatch(result.note, /description or specifications/i);
  });

  it('★ a brand range never mixes currencies', async () => {
    const brand = `KZ Multi ${Date.now()}`;
    await makeProduct(A, {
      name: uniqueName('KZ Multi Lite'),
      brand,
      sellingPrice: 100,
      currency: 'PHP',
      unit: 'pc',
    });
    await makeProduct(A, {
      name: uniqueName('KZ Multi Pro'),
      brand,
      sellingPrice: 200,
      currency: 'USD',
      unit: 'pc',
    });

    const result = await ok('listBrands', { q: brand }, ctxOf(A));
    assert.equal(result.count, 1);
    const row = result.items[0];
    assert.equal(row.priceRange.mixedCurrency, true);
    assert.equal(row.priceRange.min, null);
    assert.equal(row.priceRange.max, null);
    assert.equal(row.priceRange.currency, null);
    assert.deepEqual(
      row.priceRanges.map((range) => [range.currency, range.min, range.max]),
      [
        ['PHP', 100, 100],
        ['USD', 200, 200],
      ],
    );
    assert.match(result.note, /never add or convert them/i);
    // Every sample row carries its own currency, so a price is never bare.
    assert.ok(row.sampleProducts.every((product) => product.currency === 'PHP' || product.currency === 'USD'));
  });

  it('★ a single-currency brand reports that currency on the range', async () => {
    const brand = `KZ Single ${Date.now()}`;
    await makeProduct(A, {
      name: uniqueName('KZ Single One'),
      brand,
      sellingPrice: 55,
      currency: 'PHP',
      unit: 'pc',
    });
    const result = await ok('listBrands', { q: brand }, ctxOf(A));
    const row = result.items[0];
    assert.deepEqual(row.priceRange, { min: 55, max: 55, currency: 'PHP' });
    assert.equal(row.priceRanges, undefined);
    assert.equal(row.priceRange.mixedCurrency, undefined);
  });

  it('★ research still refuses another business and reports the search fields', async () => {
    const mine = await makeProduct(A, {
      name: uniqueName('KZ Private Item'),
      brand: 'KZ',
      sellingPrice: 10,
      currency: 'PHP',
      unit: 'pc',
    });
    const res = await executeTool(
      'researchMarketPrices',
      { productIds: mine.id },
      ctxOf(Band),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.available, false);
    assert.equal(res.result.reason, 'PRODUCTS_NOT_AVAILABLE');
    assert.deepEqual(res.result.searchedQueries, []);
    assert.deepEqual(res.result.checkedMarketplaces, []);
    assert.deepEqual(res.result.targetedMarketplaces, []);
  });
});
