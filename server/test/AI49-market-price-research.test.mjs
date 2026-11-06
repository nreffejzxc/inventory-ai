// AI-49 — market prices come from a cited page, never from the model's prose.
//
// The review-research tool asks a model to summarise quality. A price needs a
// stronger guarantee: a number the model writes can be plausible and unsourced.
// This suite therefore proves that the price client ignores message content,
// reads only `url_citation` annotations, keeps a price only when the page also
// names the recorded product, and returns the exact price string beside its
// marketplace and URL. The tool half proves the inventory boundary: product IDs
// only, resolved in the session's business, with missing/archived/foreign rows
// refused before any web request.

import { it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { aiToolsById, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';
import {
  extractPrices,
  marketplaceOf,
  priceSources,
  productPageRelevant,
  researchMarketPrices,
} from '../src/services/ai/marketPrices.ts';
import { fetchPublicPage, parseDuckDuckGoLiteResults, parseSearxResults } from '../src/services/ai/freeWeb.ts';

const { dbOk, baseUrl, server: appServer } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let stub;
let stubPort;
let requests = [];
let responder = () => priceResponse([]);
let freeSearchHtml = '';
let freePageHtml = '';
let freeSearchRequests = [];
let freePageRequests = [];
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

function usePrice() {
  pendingRestores.push(
    withEnv('OPENROUTER_API_KEY', 'or_ai49_stub_key'),
    withEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${stubPort}/api`),
    withEnv('AI_MODEL_OPENROUTER', 'stub/tool-model'),
    withEnv('AI_WEB_PRICE_MODEL', 'stub/price-model'),
    withEnv('AI_ALLOW_PAID_WEB_SEARCH', 'true'),
  );
}

function useFreePrice() {
  pendingRestores.push(
    withEnv('AI_ALLOW_PAID_WEB_SEARCH', 'false'),
    withEnv('AI_WEB_SEARCH_URL', `http://127.0.0.1:${stubPort}/ddg`),
    withEnv('AI_FREE_SEARCH_URL', undefined),
    withEnv('AI_FREE_WEB_ALLOW_PRIVATE_URLS', 'true'),
  );
}

function priceResponse(annotations, content = null) {
  return {
    status: 200,
    json: {
      id: 'chatcmpl_ai49',
      model: 'stub/price-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, annotations },
          finish_reason: 'stop',
        },
      ],
    },
  };
}

function citation(url, title, content) {
  return { url_citation: { url, title, content } };
}

const k8 = {
  id: '64c000000000000000000101',
  name: 'Keychron K8 Pro',
  brand: 'Keychron',
  sellingPrice: 6990,
  unit: 'pcs',
};

const rk61 = {
  id: '64c000000000000000000102',
  name: 'Royal Kludge RK61',
  brand: 'Royal Kludge',
  sellingPrice: 2499,
  unit: 'pcs',
};

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url.startsWith('/ddg')) {
        freeSearchRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(freeSearchHtml);
        return;
      }
      if (req.url.startsWith('/free-page')) {
        freePageRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(freePageHtml);
        return;
      }
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // A malformed body stays null; the request is still recorded below.
      }
      requests.push({ method: req.method, url: req.url, body });
      const out = responder(body, requests.length);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = stub.address().port;
});

after(async () => {
  await tracker.cleanup();
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
  await disconnectDb();
});

beforeEach(() => {
  requests = [];
  responder = () => priceResponse([]);
  freeSearchHtml = '';
  freePageHtml = '';
  freeSearchRequests = [];
  freePageRequests = [];
  pendingRestores.length = 0;
});

afterEach(() => {
  [...pendingRestores].reverse().forEach((restore) => restore());
  pendingRestores.length = 0;
});

unitSuite('AI-49 prices are extracted from citations', () => {
  it('★ keeps exact displayed prices and drops discounts, shipping and zero', () => {
    const prices = extractPrices(
      'Sale price₱5,095.00 Save ₱500.00 Regular price PHP 6,997.00 $74.99 ₱0.00 free shipping ₱1,200.00',
    );
    assert.deepEqual(
      prices.map((price) => price.text),
      ['₱5,095.00', 'PHP 6,997.00', '$74.99'],
    );
    assert.equal(prices[0].currency, 'PHP');
    assert.equal(prices[2].currency, 'USD');
  });

  it('★ recognises the named marketplaces and names any other retailer', () => {
    assert.deepEqual(marketplaceOf('https://shopee.ph/Keychron-K8-Pro-i.1'), {
      key: 'shopee',
      label: 'Shopee',
    });
    assert.deepEqual(marketplaceOf('https://www.lazada.com.ph/products/keychron-k8-pro-i2.html'), {
      key: 'lazada',
      label: 'Lazada',
    });
    assert.deepEqual(marketplaceOf('https://www.amazon.com/dp/B0D5VF97SL'), {
      key: 'amazon',
      label: 'Amazon',
    });
    assert.deepEqual(marketplaceOf('https://datablitz.com.ph/collections/keychrons'), {
      key: 'other',
      label: 'datablitz.com.ph',
    });
  });

  it('★ requires the recorded brand and a model token on the page', () => {
    assert.equal(productPageRelevant(k8, 'Keychron K8 Pro QMK keyboard — ₱5,195.00'), true);
    assert.equal(productPageRelevant(k8, 'Keychron mechanical keyboards — shop'), false);
    assert.equal(productPageRelevant(k8, 'Logitech MX Keys S — ₱3,000.00'), false);
  });

  it('★ reads only public citations, with no duplicate URL and no javascript scheme', () => {
    const sources = priceSources([
      citation('https://shopee.ph/k8-pro-i.1', 'K8 Pro', 'Keychron K8 Pro ₱5,195.00'),
      citation('javascript:alert(1)', 'Unsafe', 'Keychron K8 Pro ₱1.00'),
      citation('https://shopee.ph/k8-pro-i.1#variant', 'Duplicate', 'Again'),
    ]);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'https://shopee.ph/k8-pro-i.1');
    assert.match(sources[0].content, /Keychron K8 Pro/);
  });

  it('★ returns cited listings even when the model wrote no prose', async () => {
    usePrice();
    responder = () => {
      return priceResponse([
        citation(
          'https://shopee.ph/Keychron-K8-Pro-i.1',
          'Keychron K8 Pro',
          'Keychron K8 Pro wireless mechanical keyboard. ₱5,195.00. Free shipping.',
        ),
        citation(
          'https://www.lazada.com.ph/products/keychron-k8-pro-i2.html',
          'Keychron K8 Pro',
          'Keychron K8 Pro QMK keyboard. No price shown.',
        ),
        citation(
          'https://datablitz.com.ph/products/keychron-k8-pro',
          'Keychron K8 Pro',
          'Keychron K8 Pro Gateron Red. Sale price₱4,295.00. Save ₱700.00.',
        ),
        citation(
          'https://example.com/logitech-mx-keys',
          'Logitech MX Keys',
          'Logitech MX Keys S. ₱3,000.00.',
        ),
      ]);
    };

    const result = await researchMarketPrices({ subjects: [k8] });

    assert.equal(result.available, true);
    assert.deepEqual(
      result.listings.map((listing) => [listing.marketplace, listing.priceText]),
      [
        ['Shopee', '₱5,195.00'],
        ['datablitz.com.ph', '₱4,295.00'],
      ],
    );
    assert.equal(result.sources.length, 2);
    // The answer needs a citation, not the page body: returning 2,500-character
    // page content inflated the live Q4 prompt to 12,570 input tokens.
    assert.deepEqual(Object.keys(result.sources[0]).sort(), ['title', 'url']);
    assert.equal(result.subjects[0].sellingPrice, 6990);
    assert.equal(result.listings[0].priceSource, 'cited-page-content');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, 'stub/price-model');
    assert.equal(requests[0].body.plugins[0].id, 'web');
    assert.match(requests[0].body.messages[1].content, /Keychron K8 Pro/);
    assert.match(requests[0].body.messages[1].content, /6990/);
    assert.doesNotMatch(requests[0].body.messages[1].content, /Logitech/);
  });

  it('★ a page without a price produces no listing and no estimate', async () => {
    usePrice();
    responder = () =>
      priceResponse([
        citation(
          'https://shopee.ph/Keychron-K8-Pro-i.1',
          'Keychron K8 Pro',
          'Keychron K8 Pro mechanical keyboard. Ask the seller for the price.',
        ),
      ]);

    const result = await researchMarketPrices({ subjects: [k8] });

    assert.equal(result.available, false);
    assert.equal(result.reason, 'NO_PRICE_FOUND');
    assert.deepEqual(result.listings, []);
    assert.deepEqual(result.sources, []);
  });

  it('★ a spent allowance is reported without inventing a price', async () => {
    usePrice();
    responder = () => ({ status: 429, json: { error: { message: 'limit' } } });

    const result = await researchMarketPrices({ subjects: [k8, rk61] });

    assert.equal(result.available, false);
    assert.equal(result.reason, 'SEARCH_QUOTA');
    assert.equal(requests.length, 2, 'at most the bounded pair is sent into the refusal');
    assert.deepEqual(result.listings, []);
  });

  it('★ paid web search disabled uses the free public page, with no provider call', async () => {
    useFreePrice();
    freeSearchHtml = `<a class="result__a" href="http://127.0.0.1:${stubPort}/free-page">Keychron K8 Pro price</a><a class="result__snippet" href="#">Keychron K8 Pro QMK keyboard</a>`;
    freePageHtml = '<html><head><title>Keychron K8 Pro</title></head><body><h1>Keychron K8 Pro</h1><p>Price: ₱5,195.00</p></body></html>';

    const result = await researchMarketPrices({ subjects: [k8] });

    assert.equal(result.available, true);
    assert.equal(result.reason, undefined);
    assert.equal(result.listings[0].priceText, '₱5,195.00');
    assert.equal(result.listings[0].priceSource, 'public-page');
    assert.equal(result.sources[0].url, `http://127.0.0.1:${stubPort}/free-page`);
    assert.equal(requests.length, 0, 'no OpenRouter request may be made');
    assert.equal(freeSearchRequests.length, 1);
    assert.equal(freePageRequests.length, 1);
  });

  it('★ a free page without a price produces no listing and no estimate', async () => {
    useFreePrice();
    freeSearchHtml = `<a class="result__a" href="http://127.0.0.1:${stubPort}/free-page">Keychron K8 Pro price</a><a class="result__snippet" href="#">Keychron K8 Pro QMK keyboard</a>`;
    freePageHtml = '<html><head><title>Keychron K8 Pro</title></head><body><h1>Keychron K8 Pro</h1><p>Ask the seller for the price.</p></body></html>';

    const result = await researchMarketPrices({ subjects: [k8] });

    assert.equal(result.available, false);
    assert.equal(result.reason, 'NO_PRICE_FOUND');
    assert.deepEqual(result.listings, []);
    assert.equal(requests.length, 0, 'no OpenRouter request may be made');
    // The name-only query found pages that quote no price, so one retry runs; both
    // queries are reported and neither turns into an estimate. AI-52 — the retry drops
    // the quotes and does not repeat a brand the name already carries, because the old
    // "brand" + name form searched `Keychron Keychron K8 Pro price` and, when words were
    // added instead, returned unrelated pages (measured 2026-11-04).
    //
    // AI-52 (second pass) — the anchored retry is spent twice, because the keyless
    // engine's answer is random per call: the same `Keychron K8 Pro price` query
    // answered DataBlitz, keychron.com and keychron.ph on one call and nothing usable on
    // the next, which is how the phone came to report no online price for a product with
    // three live listings. What this test still guarantees is the outcome: the repeat is
    // the same query (not a third, different one), no listing or estimate is invented,
    // and no paid request is made.
    // AI-53 — the primary query is unquoted and the exact phrase is the retry, the
    // reverse of the AI-52 order: unquoted words reach the storefronts that state a
    // price, quotes reach pages that merely repeat the name (measured 2026-11-04).
    assert.deepEqual(result.searchedQueries, ['Keychron K8 Pro price', '"Keychron K8 Pro" price']);
    assert.equal(freeSearchRequests.length, 3, 'two anchored calls after the first');
    assert.equal(freePageRequests.length, 3);
  });

  it('★ a failed free search is unavailable, never a paid fallback', async () => {
    useFreePrice();

    const result = await researchMarketPrices({ subjects: [k8] });

    assert.equal(result.available, false);
    assert.equal(result.reason, 'NO_PRICE_FOUND');
    assert.deepEqual(result.listings, []);
    assert.equal(requests.length, 0, 'no OpenRouter request may be made');
    assert.equal(freeSearchRequests.length, 1);
  });

  it('★ free search parsers cover SearXNG and the Lite layout; private pages are refused', async () => {
    assert.deepEqual(
      parseSearxResults({
        results: [{ title: 'Keychron review', url: 'https://example.com/review', content: 'A review.' }],
      }),
      [{ title: 'Keychron review', url: 'https://example.com/review', snippet: 'A review.' }],
    );
    assert.deepEqual(
      parseDuckDuckGoLiteResults(
        '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage" class="result-link">Free page</a><td class="result-snippet">Useful price context.</td>',
      ),
      [{ title: 'Free page', url: 'https://example.com/page', snippet: 'Useful price context.' }],
    );

    const restore = withEnv('AI_FREE_WEB_ALLOW_PRIVATE_URLS', undefined);
    try {
      const result = await fetchPublicPage(`http://127.0.0.1:${stubPort}/free-page`);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'UNSAFE_URL');
    } finally {
      restore();
    }
  });

  it('★ an unconfigured provider is refused before the web', async () => {
    usePrice();
    const restore = withEnv('OPENROUTER_API_KEY', undefined);
    try {
      const result = await researchMarketPrices({ subjects: [k8] });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'NOT_CONFIGURED');
      assert.equal(requests.length, 0);
    } finally {
      restore();
    }
  });

  it('★ the assistant is told to use the tool and to keep web prices separate', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /researchMarketPrices/);
    assert.match(prompt, /exact `priceText`/);
    assert.match(prompt, /never convert currency/i);
    assert.match(prompt, /with the ISO code in the recorded `currency` field/i);
    assert.match(prompt, /write the bare number with no symbol/i);
    assert.match(prompt, /keep the recorded selling price separate/i);
    assert.match(prompt, /good value/i);
    assert.match(prompt, /which requested kinds the catalogue does not contain/i);
    assert.match(prompt, /name a publication only when a returned source carries its URL/i);

    const tool = aiToolsById.get('researchMarketPrices');
    assert.ok(tool, 'researchMarketPrices is missing from the tool table');
    assert.equal(tool.permission, 'products.view');
    assert.match(tool.description, /cited page/i);
    assert.match(tool.description, /does not change stock or prices/i);
    assert.ok(validateToolArgs(tool, { productIds: k8.id, brand: 'Outside' }).problems.length > 0);
    assert.ok(validateToolArgs(tool, { productIds: k8.id, businessId: 'other' }).problems.length > 0);
  });
});

dbSuite('AI-49 market price tool is tenant-bound', dbOk, () => {
  let owner;
  let productId;
  let productName;

  before(async () => {
    owner = await registerOwner(api, tracker);
    productName = uniqueName('Keychron K8 Pro');
    const product = await api('POST', '/api/products', {
      token: owner.token,
      body: {
        name: productName,
        brand: 'Keychron',
        description: 'Wireless mechanical keyboard for the office.',
        sellingPrice: 6990,
        unit: 'pcs',
      },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;
  });

  it('★ prices the session’s own product and keeps the recorded price separate', async () => {
    usePrice();
    responder = () =>
      priceResponse([
        citation(
          'https://shopee.ph/Keychron-K8-Pro-i.1',
          productName,
          `${productName} wireless mechanical keyboard. ₱5,195.00.`,
        ),
      ]);

    const result = await executeTool(
      'researchMarketPrices',
      { productIds: productId },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.available, true);
    assert.equal(result.result.listings[0].priceText, '₱5,195.00');
    assert.equal(result.result.subjects[0].name, productName);
    assert.equal(result.result.subjects[0].sellingPrice, 6990);
    assert.equal(requests.length, 1);
  });

  it('★ refuses a cross-tenant id before the web is called', async () => {
    const other = await registerOwner(api, tracker);
    const foreign = await api('POST', '/api/products', {
      token: other.token,
      body: { name: uniqueName('Foreign Keyboard'), brand: 'Outside Brand' },
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.json));

    usePrice();
    const beforeCount = requests.length;
    const result = await executeTool(
      'researchMarketPrices',
      { productIds: foreign.json.id },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.available, false);
    assert.equal(result.result.reason, 'PRODUCTS_NOT_AVAILABLE');
    assert.equal(requests.length, beforeCount, 'no foreign product name may reach the web');
  });
});
