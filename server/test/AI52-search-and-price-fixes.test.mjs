// AI-52 — the keyless research path answers about the product that was asked about.
//
// THE DEFECT (measured on the device battery, 2026-11-04). Four separate failures, all
// of them visible to the member as a wrong or empty answer:
//
//   1. `"Royal Kludge RK61" reviews` was answered by DuckDuckGo with HTTP 202 and an
//      anomaly page, which the parser read as "no results" — so research reported
//      `NO_SOURCES` for a product with plenty of coverage. There was no second engine
//      and no memory of the block, so every retry paid for the same block page.
//   2. When an engine DID answer 200, the results were unrelated: Royal Cable internet,
//      Coca-Cola's "Royal" drink, royal.uk — cited as review evidence for a keyboard.
//      A 200 is not relevance, so keyless results are now filtered by the recorded name.
//   3. Quoting the model and adding only qualifier words unanchored the engine; the same
//      query with the recorded category (`… RK61 keyboard review`) returned rtings,
//      reddit and verdict-reviews. The category now anchors both fallback query shapes.
//   4. Both PH retailers of the RK61 were rejected as "no price" because a real product
//      page states its price in a buy box more than 170 characters from the model name:
//      `Regular price ₱2,595.00` under a title block. A price carrying its own label is
//      accepted; an unlabelled figure far from the name is still refused.
//
// The Bing parser lives here too, because the fallback engine is only useful if its
// redirect links are read back into real URLs and its date badges stay out of snippets.

import { it, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { unitSuite } from './testEnv.mjs';
import { parseBingResults, searchFreeWeb } from '../src/services/ai/freeWeb.ts';
import { researchMarketPrices } from '../src/services/ai/marketPrices.ts';
import { researchInventoryWeb } from '../src/services/ai/webResearch.ts';
import { broadQuery, fallbackQuery, relevantSources } from '../src/services/ai/webResearch.ts';

const rk61 = {
  id: '64c000000000000000000102',
  name: 'Royal Kludge RK61',
  brand: 'Royal Kludge',
  sellingPrice: 2499,
  unit: 'pcs',
};

const rk61Group = {
  brand: 'Royal Kludge',
  subjects: [{ id: rk61.id, name: rk61.name, brand: rk61.brand, category: 'keyboard' }],
};

let stub;
let stubPort;
let searchHtml = '';
/** Answers handed out in turn, for tests where the engine is junk on one call and useful on the next. */
let searchHtmlQueue = [];
let pageHtml = '';
let searchRequests = [];
let pageRequests = [];
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

function useFreePrice() {
  pendingRestores.push(
    withEnv('AI_ALLOW_PAID_WEB_SEARCH', 'false'),
    withEnv('AI_WEB_SEARCH_URL', `http://127.0.0.1:${stubPort}/ddg`),
    withEnv('AI_FREE_SEARCH_URL', undefined),
    withEnv('AI_FREE_WEB_ALLOW_PRIVATE_URLS', 'true'),
  );
}

/** The base64url target Bing hides behind `/ck/a?…&u=a1…`. */
function bingTarget(url) {
  return `a1${Buffer.from(url, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function bingItem({ url, title, snippet, date }) {
  const badge = date ? `<span class="news_dt">${date}</span>` : '';
  return (
    '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=' +
    `${bingTarget(url)}&amp;ntb=1">${title}</a></h2>` +
    `<div class="b_caption"><p class="b_lineclamp4 b_algoSlug">${snippet}${badge}</p></div></li>`
  );
}

before(async () => {
  stub = http.createServer((req, res) => {
    if (req.url.startsWith('/ddg')) {
      searchRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(searchHtmlQueue.length > 0 ? searchHtmlQueue.shift() : searchHtml);
      return;
    }
    if (req.url.startsWith('/blocked')) {
      searchRequests.push(req.url);
      // The shape DuckDuckGo actually returned: 202 + an anomaly page.
      res.writeHead(202, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>');
      return;
    }
    if (req.url.startsWith('/free-page')) {
      pageRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = stub.address().port;
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

beforeEach(() => {
  searchHtml = '';
  searchHtmlQueue = [];
  pageHtml = '';
  searchRequests = [];
  pageRequests = [];
  pendingRestores.length = 0;
});

afterEach(() => {
  [...pendingRestores].reverse().forEach((restore) => restore());
  pendingRestores.length = 0;
});

unitSuite('AI-52 Bing fallback parser', () => {
  it('★ reads the redirect target back into the real URL and keeps the date badge out of the snippet', () => {
    const target = 'https://www.rtings.com/reviews/royal-kludge-rk61';
    const sources = parseBingResults(
      '<ol id="b_results">' +
        bingItem({
          url: target,
          title: 'Royal Kludge RK61 <strong>review</strong>',
          snippet: 'The RK61 is a solid 60% keyboard.',
          date: 'Nov 3, 2026',
        }) +
        '</ol>',
    );

    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, target, 'the citation must be the page, not bing.com/ck/a');
    assert.equal(sources[0].title, 'Royal Kludge RK61 review');
    assert.ok(sources[0].snippet.includes('solid 60% keyboard'));
    assert.ok(!sources[0].snippet.includes('Nov 3, 2026'), 'a publication date is not what the page says about the product');
  });

  it('★ skips a link it cannot resolve, dedupes a repeat, and honours the limit', () => {
    const first = 'https://example.com/rk61-review';
    const second = 'https://example.com/rk61-owners';
    const html =
      '<li class="b_algo"><h2><a href="javascript:void(0)">Unclickable</a></h2><p class="b_lineclamp">RK61</p></li>' +
      bingItem({ url: first, title: 'RK61 review', snippet: 'one' }) +
      bingItem({ url: first, title: 'RK61 review again', snippet: 'two' }) +
      bingItem({ url: second, title: 'RK61 owners', snippet: 'three' });

    assert.deepEqual(
      parseBingResults(html).map((source) => source.url),
      [first, second],
    );
    assert.equal(parseBingResults(html, 1).length, 1);
    assert.deepEqual(parseBingResults('<html><body>no results</body></html>'), []);
  });
});

unitSuite('AI-52 relevance filtering and query shape', () => {
  it('★ a result about anything called "Royal" is not evidence about a Royal Kludge', () => {
    const junk = [
      { title: 'Royal Cable — internet, cable and broadband', url: 'https://royalcable.com.ph', snippet: 'Plans' },
      { title: 'Royal (Coca-Cola) - Wikipedia', url: 'https://en.wikipedia.org/wiki/Royal', snippet: 'soft drink' },
      { title: 'The Royal Family', url: 'https://www.royal.uk', snippet: 'Official site' },
    ];
    const good = [
      { title: 'Royal Kludge RK61 review', url: 'https://www.rtings.com/reviews/rk61', snippet: 'measured' },
      { title: 'Budget 60% board', url: 'https://example.com/rk61', snippet: 'the rk61 is fine for the price' },
    ];

    assert.deepEqual(relevantSources(rk61Group, junk), [], 'the brand is "royal kludge", not "royal"');
    assert.deepEqual(
      relevantSources(rk61Group, [...junk, ...good]).map((source) => source.url),
      good.map((source) => source.url),
    );
  });

  it('★ a shared numeric code is not a product identity', () => {
    // Measured 2026-11-06: both models cited a Depesche TopModel Friends 10482
    // notebook for the inventory item Value Notebook 10482. The only shared token
    // was the SKU, so a numeric-only match must not identify a product.
    const group = {
      brand: null,
      subjects: [
        {
          id: '64c000000000000000000104',
          name: 'Value Notebook 10482',
          brand: null,
          category: 'Office',
          sellingPrice: null,
          unit: 'pc',
        },
      ],
    };
    const wrong = {
      title: 'Depesche TopModel Friends 10482 Notebook with Liquid and Glitter',
      url: 'https://example.com/depesche-10482',
      snippet: 'A notebook with a glittery liquid cover.',
    };
    const right = {
      title: 'Value Notebook 10482 review',
      url: 'https://example.com/value-notebook-10482',
      snippet: 'The recorded notebook has a sturdy cover.',
    };

    assert.deepEqual(relevantSources(group, [wrong]), [], '10482 alone is shared by an unrelated product');
    assert.deepEqual(
      relevantSources(group, [wrong, right]).map((source) => source.url),
      [right.url],
      'the recorded name phrase keeps the real product and drops the Depesche page',
    );
  });

  it('★ the recorded category anchors a query whose name already carries the brand', () => {
    assert.equal(broadQuery(rk61Group, 'overall'), 'Royal Kludge RK61 keyboard review');
    assert.equal(
      fallbackQuery(rk61Group, 'reliability'),
      '"Royal Kludge RK61" keyboard reliability durability review',
    );
    // A category already inside the name is not repeated.
    const named = {
      brand: 'Royal Kludge',
      subjects: [{ id: rk61.id, name: 'Royal Kludge RK61 keyboard', brand: rk61.brand, category: 'keyboard' }],
    };
    assert.equal(broadQuery(named, 'overall'), 'Royal Kludge RK61 keyboard review');
  });
});

unitSuite('AI-52 a buy-box price is the page’s price', () => {
  it('★ accepts a labelled price that sits far from the model name', async () => {
    useFreePrice();
    searchHtml = `<a class="result__a" href="http://127.0.0.1:${stubPort}/free-page">Royal Kludge RK61 price</a>`;
    pageHtml =
      '<html><head><title>Royal Kludge RK61 Mechanical Keyboard | DataBlitz</title></head><body>' +
      '<h1>Royal Kludge RK61 Mechanical Keyboard</h1>' +
      `<p>${'In stock today at our stores nationwide, ready for pickup or same day delivery within Metro Manila. '.repeat(3)}</p>` +
      '<div class="price">Regular price ₱2,595.00</div></body></html>';

    const result = await researchMarketPrices({ subjects: [rk61] });

    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.listings[0].priceText, '₱2,595.00');
    assert.equal(result.listings[0].priceSource, 'public-page');
  });

  it('★ still refuses an unlabelled number that is nowhere near the product', async () => {
    useFreePrice();
    searchHtml = `<a class="result__a" href="http://127.0.0.1:${stubPort}/free-page">Royal Kludge RK61 price</a>`;
    pageHtml =
      '<html><head><title>Royal Kludge RK61 Mechanical Keyboard | DataBlitz</title></head><body>' +
      '<h1>Royal Kludge RK61 Mechanical Keyboard</h1>' +
      `<p>${'In stock today at our stores nationwide, ready for pickup or same day delivery within Metro Manila. '.repeat(3)}</p>` +
      '<div>₱2,595.00</div></body></html>';

    const result = await researchMarketPrices({ subjects: [rk61] });

    assert.equal(result.available, false);
    assert.equal(result.reason, 'NO_PRICE_FOUND');
    assert.deepEqual(result.listings, [], 'an unlabelled figure is not this product’s price');
  });
});

unitSuite('AI-52 a junk answer is retried, because the junk is random per call', () => {
  const ddgResult = (url, title, snippet = '') =>
    `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&rut=x">${title}</a>` +
    `<a class="result__snippet" href="#">${snippet}</a>`;

  // The answer measured on 2026-11-04 for `"Royal Kludge RK61" reviews`: a soft-drink
  // brand, a cable company and the royal family. It is not about the product.
  const junk =
    ddgResult('https://www.royalcable.com.ph/', 'Royal Cable - Fiber home internet') +
    ddgResult('https://www.coca-cola.com/ph/en/brands/royal', 'Royal - Products & Nutrition Facts') +
    ddgResult('https://www.royal.uk/', 'The official website of the Royal Family');

  it('★ research reports the product after a junk call, instead of NO_SOURCES', async () => {
    useFreePrice();
    searchHtmlQueue = [
      junk,
      junk,
      junk,
      ddgResult(
        'https://www.rtings.com/keyboard/reviews/royal-kludge/rk61',
        'Royal Kludge RK61 Review',
        'The RK61 is a solid budget 60% board with a durable case.',
      ),
    ];

    const result = await researchInventoryWeb({
      subjects: [{ id: rk61.id, name: rk61.name, brand: rk61.brand }],
    });

    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.sources[0].url, 'https://www.rtings.com/keyboard/reviews/royal-kludge/rk61');
    assert.equal(
      result.findings[0].name,
      'Royal Kludge RK61',
      'the finding is keyed to the recorded product, not to the junk brand',
    );
    assert.equal(searchRequests.length, 4, 'three junk answers and one more anchored call');
  });

  it('★ a price search repeats the anchored query once the engine has answered junk', async () => {
    useFreePrice();
    searchHtmlQueue = [
      junk,
      junk,
      `<a class="result__a" href="http://127.0.0.1:${stubPort}/free-page">Royal Kludge RK61 price</a>`,
    ];
    pageHtml =
      '<html><head><title>Royal Kludge RK61 Mechanical Keyboard | DataBlitz</title></head><body>' +
      '<h1>Royal Kludge RK61 Mechanical Keyboard</h1><div class="price">Regular price ₱2,595.00</div></body></html>';

    const result = await researchMarketPrices({ subjects: [rk61] });

    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.listings[0].priceText, '₱2,595.00');
    assert.equal(searchRequests.length, 3, 'the same anchored query is worth one more call');
    assert.equal(
      new Set(result.searchedQueries).size,
      2,
      'the repeat is not reported as a third, different query',
    );
  });
});

// Last in the file on purpose: the cooldown is module state, and this test is the one
// that sets it.
unitSuite('AI-52 keyless search treats a block page as a block, not as an empty result', () => {
  it('★ 202 with an anomaly page is SEARCH_UNAVAILABLE, and two in a row skip the engine for five minutes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    pendingRestores.push(withEnv('AI_WEB_SEARCH_URL', `http://127.0.0.1:${stubPort}/blocked`));

    assert.deepEqual(await searchFreeWeb('"Royal Kludge RK61" reviews'), {
      sources: [],
      reason: 'SEARCH_UNAVAILABLE',
    });
    assert.equal(searchRequests.length, 1);

    // AI-53 — one anomaly page is noise, not a verdict: the same host answered 202 and
    // then 200 within a minute during measurement, so the next question asks once more.
    const second = await searchFreeWeb('"Keychron K8 Pro" review');
    assert.equal(second.reason, 'SEARCH_UNAVAILABLE');
    assert.equal(searchRequests.length, 2, 'a single refusal is retried');

    // Two consecutive refusals are a pattern: the engine is left alone, and the reason
    // stays honest instead of claiming the web has nothing on the product.
    const third = await searchFreeWeb('"Keychron K8 Pro" review');
    assert.equal(third.reason, 'SEARCH_UNAVAILABLE');
    assert.equal(searchRequests.length, 2, 'a throttled engine must not be asked again for five minutes');

    // The cooldown expires, so research is not permanently degraded by one block page.
    t.mock.timers.tick(5 * 60 * 1000 + 1000);
    await searchFreeWeb('"Keychron K8 Pro" review');
    assert.equal(searchRequests.length, 3, 'after the cooldown the engine is tried again');
  });
});
