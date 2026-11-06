// AI-53 — real-world product research: the parts that were wrong on 2026-11-04.
//
// The device battery asked for reviews, prices, specs and comparisons of products that
// really sit in a tenant's inventory. What it exposed, measured against live sites:
//
//   1. Bing's `202`-style refusal is not a result list, but its way of saying so also
//      lives in the page's localisation JSON (`searchNoResult`) — so a raw-HTML check
//      retired Bing on pages that HAD results, and research collapsed to NO_SOURCES.
//      Only visible text may count, and a page counting its hits ("148 results") found them.
//   2. An engine with nothing for a query serves another query's page: a Redragon query
//      answered outlook.com sign-in hosts, a movie database and Zhihu threads. Each junk
//      batch is now a failed attempt (the next engine / anchored retry runs) instead of
//      "evidence"; a batch with one matching result is kept whole and only reordered.
//   3. A storefront often states its price only in markup: DataBlitz/Shopify put it in
//      `product:price:amount` and JSON-LD, Lazada in embedded `pdt_price`. Reading only
//      visible text reported "no price" for pages that do state one.
//   4. An Alienware m16 R2 was "priced" ₱600 — the page's loyalty offer ("Earn up to ₱600
//      worth of BesBuy Points"), which next to a ₱139,995 record reads as a 99% markdown.
//      Monthly instalments were already refused; points and cash-back are now too.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { unitSuite } from './testEnv.mjs';
import { bingStatesNoResults, searchFreeWeb } from '../src/services/ai/freeWeb.ts';
import {
  extractPrices,
  researchMarketPrices,
  storeHints,
  storeQuery,
  structuredPriceTokens,
} from '../src/services/ai/marketPrices.ts';
import {
  fallbackQuery,
  latestModelQuery,
  researchInventoryWeb,
  researchPrompt,
} from '../src/services/ai/webResearch.ts';

let stub;
let stubPort;
let searchHtml = '';
const pendingRestores = [];

function withEnv(key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

function useFreeSearch() {
  pendingRestores.push(
    withEnv('AI_WEB_SEARCH_URL', `http://127.0.0.1:${stubPort}/ddg`),
    withEnv('AI_FREE_SEARCH_URL', undefined),
    withEnv('AI_FREE_WEB_ALLOW_PRIVATE_URLS', 'true'),
  );
}

const ddgResult = (url, title, snippet = '') =>
  `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&rut=x">${title}</a>` +
  `<a class="result__snippet" href="#">${snippet}</a>`;

before(async () => {
  stub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(searchHtml);
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = stub.address().port;
});

after(async () => {
  [...pendingRestores].reverse().forEach((restore) => restore());
  await new Promise((resolve) => stub.close(resolve));
});

unitSuite('AI-53 a refusal page is read from its visible text', () => {
  it('★ Bing’s localisation JSON does not turn a page with results into “no results”', () => {
    // What every Bing page carries, plus a real result list and its hit count.
    const page =
      '<script type="application/json">{"searchNoResult":"There are no results for {0}"}</script>' +
      '<main><span class="sb_count">148 results</span>' +
      '<li class="b_algo"><h2><a href="https://www.rtings.com/keyboard/reviews/redragon/k552-kumara">Redragon K552 Kumara Review</a></h2></li></main>';

    assert.equal(bingStatesNoResults(page), false, 'a page that lists results found them');
  });

  it('★ a page whose visible text says it found nothing is a failed attempt', () => {
    assert.equal(
      bingStatesNoResults('<body><h1>There are no results for Redragon K552 Kumara price</h1></body>'),
      true,
    );
    // ...but not when it also counts hits, which some layouts print beside the phrase.
    assert.equal(bingStatesNoResults('<body>There are no results for "xyz" · 12 results for xyz</body>'), false);
  });
});

unitSuite('AI-53 a junk batch is a failed attempt, not evidence', () => {
  it('★ results that share no distinctive word with the question are refused', async () => {
    useFreeSearch();
    // Measured on 2026-11-04 for a Redragon query.
    searchHtml =
      ddgResult('https://login.live.com/', 'Sign in to your Microsoft account') +
      ddgResult('https://www.imdb.com/title/tt0088763/', 'Back to the Future (1985) - IMDb') +
      ddgResult('https://www.zhihu.com/question/123', '有哪些值得推荐的机械键盘？');

    assert.deepEqual(await searchFreeWeb('Redragon K552 Kumara reviews'), {
      sources: [],
      reason: 'NO_SOURCES',
    });
  });

  it('★ a batch with one matching result is kept whole and only reordered', async () => {
    useFreeSearch();
    const review = 'https://www.rtings.com/keyboard/reviews/redragon/k552-kumara';
    searchHtml =
      ddgResult('https://www.imdb.com/title/tt0088763/', 'Back to the Future (1985) - IMDb') +
      ddgResult(review, 'Redragon K552 Kumara Review', 'A solid budget board.') +
      ddgResult('https://www.zhihu.com/question/123', '有哪些值得推荐的机械键盘？');

    const result = await searchFreeWeb('Redragon K552 Kumara reviews');
    assert.equal(result.reason, undefined);
    assert.equal(result.sources[0].url, review, 'the matching page is offered first');
    assert.equal(result.sources.length, 3, 'nothing is thrown away, because a review need not repeat the name');
  });
});

unitSuite('AI-53 a price stated only in markup is still the page’s price', () => {
  it('★ reads Open Graph, Lazada state and JSON-LD amounts with their currency', () => {
    const meta =
      '<meta property="product:price:amount" content="1295">' +
      '<meta property="product:price:currency" content="PHP">';
    const lazada = '<script>window.__INITIAL_STATE__={"pdt_price":"1,295.00"}</script>';
    const jsonLd =
      '<script type="application/ld+json">{"@type":"Product","name":"Redragon K552","offers":{"price":"1295.00","priceCurrency":"PHP"}}</script>';

    assert.deepEqual(structuredPriceTokens(meta), ['price ₱1295'], 'the currency comes from the page');
    assert.deepEqual(structuredPriceTokens(`<script>{"currency":"PHP"}</script>${lazada}`), ['price ₱1,295.00']);
    assert.deepEqual(structuredPriceTokens(jsonLd), ['price ₱1295.00']);
    // The same price stated three ways is one listing, not three.
    assert.deepEqual(structuredPriceTokens(`<html><head>${meta}</head><body>${lazada}${jsonLd}</body></html>`), [
      'price ₱1295',
    ]);
  });

  it('★ a non-product JSON-LD block invents nothing', () => {
    const html =
      '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"position":2,"name":"1295"}]}</script>';
    assert.deepEqual(structuredPriceTokens(html), []);
  });
});

unitSuite('AI-53 money-shaped text that is not the price', () => {
  it('★ loyalty points and cash-back are refused as prices', () => {
    assert.deepEqual(extractPrices('Earn up to ₱600 worth of BesBuy Points'), []);
    assert.deepEqual(extractPrices('Get ₱1,000 cashback when you pay with GCash'), []);
    assert.deepEqual(extractPrices('₱250 rewards on your next order'), []);
  });

  it('★ a real price next to a loyalty offer is still read', () => {
    const found = extractPrices('Alienware m16 R2 · ₱139,995.00 Earn up to ₱600 worth of BesBuy Points');
    assert.equal(found[0].text, '₱139,995.00');
    assert.equal(found.length, 1, 'the points figure is not offered as a second listing');
  });

  it('★ a monthly instalment is refused, and “what you get ₱…” is not', () => {
    assert.deepEqual(extractPrices('₱12,999 per month for 12 months'), []);
    assert.deepEqual(extractPrices('₱12,999 /mo'), []);
    const found = extractPrices('Price you get ₱12,999 today');
    assert.equal(found[0].text, '₱12,999', '“get” alone does not make a figure a reward');
  });

  it('★ another item’s “offers from” block is not this listing’s price', () => {
    // The real Amazon markup, 2026-11-04: a carousel card for a DIFFERENT ASIN showed
    // “4 offers from PHP71,203.36” on the Alienware m16 R2 page we were citing.
    assert.deepEqual(extractPrices('4 offers from PHP71,203.36'), []);
    assert.deepEqual(extractPrices('“… B0BXFKXG6N” 4 offers from PHP 71,203.36'), []);
    const found = extractPrices('Alienware m16 R2 PHP 139,995.00 · 4 offers from PHP71,203.36');
    assert.equal(found[0].text, 'PHP 139,995.00');
    assert.equal(found.length, 1, 'the carousel offer is not offered as a second price');
  });
});

// ── a shop the member named is asked, not skipped ──────────────────────────────
//
// Measured 2026-11-04: "Check rkgamingstore.com and Shopee for the Redragon K552"
// answered that neither was "returned by the search" and told the member to look by
// hand. A `site:` query proved rkgamingstore.com is reachable and simply carries Royal
// Kludge instead of Redragon — a fact the answer can only state if the tool asks.

unitSuite('AI-53 a shop the member named is asked directly', () => {
  it('★ a pasted URL becomes the host a site: query needs', () => {
    const [hint] = storeHints([' https://www.rkgamingstore.com/collections/gaming-keyboards ']);
    assert.deepEqual(hint, { label: 'rkgamingstore.com', token: 'rkgamingstore.com', domain: true });
  });

  it('★ a plain shop name stays a search word, and repeats collapse', () => {
    const hints = storeHints(['Shopee', 'shopee', 'Lazada', 'Amazon', 'eBay']);
    assert.deepEqual(
      hints.map((hint) => hint.label),
      ['Shopee', 'Lazada', 'Amazon'],
      'three shops at most, each once',
    );
    assert.equal(hints[0].domain, false);
  });

  it('★ the query asks the store itself', () => {
    const subject = { id: 'p1', name: 'Redragon K552 Kumara', brand: 'Redragon' };
    assert.equal(storeQuery(storeHints(['rkgamingstore.com'])[0], subject), 'site:rkgamingstore.com Redragon K552 Kumara');
    assert.equal(storeQuery(storeHints(['Shopee'])[0], subject), 'Redragon K552 Kumara price Shopee');
  });

  it('★ a store whose pages came back without a price is reported that way', async () => {
    useFreeSearch();
    searchHtml =
      ddgResult(
        'https://rkgamingstore.com/collections/gaming-keyboards',
        'Gaming Keyboards – RK Gaming Store',
        'Royal Kludge mechanical keyboards',
      ) +
      ddgResult('https://rkgamingstore.com/collections/rk-keyboard', 'RK Keyboards', 'RK61, RK84, RK87');

    const result = await researchMarketPrices({
      subjects: [
        { id: '6aeb71cff8462e2c4839ebb6', name: 'Redragon K552 Kumara', brand: 'Redragon', currency: 'PHP' },
      ],
      stores: ['rkgamingstore.com'],
    });

    const check = result.storeChecks[0];
    assert.equal(check.store, 'rkgamingstore.com');
    assert.equal(check.reachedStore, true, 'the store’s own pages were reached');
    assert.deepEqual(check.listings, [], 'none of them quoted a price for this product');
    assert.ok(check.pages.some((url) => url.includes('rkgamingstore.com')));
    assert.ok(result.searchedQueries.includes('site:rkgamingstore.com Redragon K552 Kumara'));
    assert.ok(result.targetedMarketplaces.includes('rkgamingstore.com'));
  });
});

// ── the newest model is searched for, not assumed absent ───────────────────────
//
// Measured 2026-11-04: "does a newer 2026 ROG Strix G16 exist and what changed"
// answered "no 2026 model appears in the data" while rog.asus.com published it. The
// recorded name carries "(2024)", which pins every query to the old machine.

const g16 = {
  id: '6aeb71d0f8462e2c4839ebb9',
  name: 'ASUS ROG Strix G16 (2024)',
  brand: 'ASUS ROG',
  category: 'Laptops',
  sellingPrice: 89995,
  currency: 'PHP',
  specifications: 'Core i7-13650HX, RTX 4060, 16GB DDR5, 1TB SSD',
};

unitSuite('AI-53 a product update is researched, not assumed absent', () => {
  it('★ the line is searched without the year that pins it to the recorded model', () => {
    assert.equal(latestModelQuery({ brand: 'ASUS ROG', subjects: [g16] }), 'ASUS ROG Strix G16 specifications latest model');
  });

  it('★ the specifications lens asks for specifications, not reviews', () => {
    const query = fallbackQuery({ brand: 'ASUS ROG', subjects: [g16] }, 'specifications');
    assert.match(query, /specifications latest model$/);
  });

  it('★ the research prompt makes the manufacturer the primary evidence', () => {
    const prompt = researchPrompt([g16], 'specifications');
    assert.match(prompt, /manufacturer’s own product, specification and release pages/);
    assert.match(prompt, /never claim a newer model does not exist/);
  });

  it('★ the official 2026 page is returned as a source for a 2024 record', async () => {
    useFreeSearch();
    const older = 'https://www.rtings.com/laptop/reviews/asus/rog-strix-g16-2024';
    const newer = 'https://rog.asus.com/laptops/rog-strix/rog-strix-g16-2026/';
    searchHtml =
      ddgResult(older, 'ASUS ROG Strix G16 (2024) Laptop Review - RTINGS.com', '240Hz QHD+ and 165Hz FHD+ options') +
      ddgResult(newer, 'ROG Strix G16 (2026) G615 | ROG Strix | Gaming Laptops', 'Up to an Intel Core Ultra 9 processor');

    const result = await researchInventoryWeb({ subjects: [g16], focus: 'specifications' });
    assert.equal(result.available, true);
    const urls = result.sources.map((source) => source.url);
    assert.ok(urls.includes(newer), 'the newest model is citable');
    assert.ok(urls.includes(older), 'the recorded model keeps its own evidence');
    assert.match(result.findings[0].finding, /2026/);
  });
});
