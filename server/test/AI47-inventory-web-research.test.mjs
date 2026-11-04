// AI-47 — research the web, recommend only what is in the inventory.
//
// The assistant has no rating, review or specification field, so a quality question
// cannot be answered from the catalogue alone. OpenRouter's web plugin can supply
// sourced `url_citation` annotations, but the inventory boundary must survive that
// trip: the model may not turn a famous outside brand into a recommendation.
//
// This suite pins both halves:
//   * the research client searches only the recorded names passed to it, keeps only
//     public source URLs, drops findings keyed to any other name, and never presents
//     an answer that has no source;
//   * the tool accepts product IDs, resolves them in the session's own business, and
//     refuses missing, archived or cross-tenant IDs before any search is made.
//
// The HTTP stub is local and deterministic. It proves what Inventory AI SENDS and how
// it interprets the reply; it is not a live OpenRouter call and makes no claim that
// one would succeed with a particular account.

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
  appendMissingSourceUrls,
  chatCompletionsUrlFromBase,
  filterFindings,
  parseSearchResults,
  researchInventoryWeb,
  validSources,
} from '../src/services/ai/webResearch.ts';

const { dbOk, baseUrl, server: appServer } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let stub;
let stubPort;
let requests = [];
let fallbackHtml = '';
let fallbackForQuery = () => fallbackHtml;
let fallbackRequests = [];
let responder = () => ({ status: 200, json: {} });
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

function useResearch(overrides = {}) {
  pendingRestores.push(
    withEnv('OPENROUTER_API_KEY', overrides.key ?? 'or_ai47_stub_key'),
    withEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${stubPort}/api`),
    withEnv('AI_MODEL_OPENROUTER', overrides.model ?? 'stub/tool-model'),
    withEnv('AI_WEB_RESEARCH_MODEL', overrides.researchModel ?? 'stub/research-model'),
    withEnv('AI_WEB_SEARCH_URL', `http://127.0.0.1:${stubPort}/ddg`),
  );
}

const allowedResponse = (findings, annotations) => ({
  status: 200,
  json: {
    id: 'chatcmpl_ai47',
    model: 'stub/tool-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({ findings, caveat: '' }),
          annotations,
        },
        finish_reason: 'stop',
      },
    ],
  },
});

const subjects = [
  {
    id: '64b000000000000000000101',
    name: 'Ridgeline Trail Lamp',
    brand: 'Ridgeline',
    category: 'Camping',
    sellingPrice: 24.5,
    unit: 'pc',
  },
  {
    id: '64b000000000000000000102',
    name: 'Unbranded Field Stove',
    brand: null,
    category: 'Camping',
    sellingPrice: 18,
    unit: 'pc',
  },
];

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url.startsWith('/ddg')) {
        const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('q') ?? '';
        fallbackRequests.push(query);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fallbackForQuery(query, fallbackRequests.length));
        return;
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = responder(body, requests.length);
      res.writeHead(out.status ?? 200, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json ?? {}));
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
  fallbackHtml = '';
  fallbackForQuery = () => fallbackHtml;
  fallbackRequests = [];
  responder = () => allowedResponse([], []);
  pendingRestores.length = 0;
});

afterEach(() => {
  [...pendingRestores].reverse().forEach((restore) => restore());
  pendingRestores.length = 0;
});

function requestBody() {
  return requests[0].body;
}

unitSuite('AI-47 research is inventory-bound and source-backed', () => {
  it('★ builds the Chat Completions endpoint from the provider base', () => {
    assert.equal(
      chatCompletionsUrlFromBase('https://openrouter.ai/api'),
      'https://openrouter.ai/api/v1/chat/completions',
    );
    assert.equal(
      chatCompletionsUrlFromBase('https://openrouter.ai/api/v1/messages/'),
      'https://openrouter.ai/api/v1/chat/completions',
    );
    assert.equal(
      chatCompletionsUrlFromBase('https://openrouter.ai/api/v1'),
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });

  it('★ sends the web plugin, the recorded names only, and a bounded ask', async () => {
    useResearch();
    responder = () =>
      allowedResponse(
        [
          { subjectId: 'B1', finding: 'Source-backed field reports describe reliable switches.' },
          { subjectId: 'P9', finding: 'This must never reach the assistant.' },
        ],
        [
          { url_citation: { url: 'https://example.com/review', title: 'Field review' } },
          { url_citation: { url: 'https://example.com/review#duplicate', title: 'Duplicate' } },
        ],
      );

    const result = await researchInventoryWeb({ subjects, focus: 'reliability' });

    assert.equal(result.available, true);
    assert.deepEqual(
      result.findings.map((finding) => finding.name),
      ['Ridgeline'],
      'a finding for a name the inventory did not supply must be dropped',
    );
    assert.equal(result.sources.length, 1, 'source URLs are de-duplicated');
    assert.match(result.sources[0].url, /^https:\/\/example\.com\/review/);

    const bodies = requests.map((request) => request.body);
    assert.equal(bodies.length, 2, 'one search per recorded-brand group and one product group');
    for (const body of bodies) {
      assert.equal(body.model, 'stub/research-model');
      assert.equal(body.plugins[0].id, 'web');
      assert.equal(body.plugins[0].max_results, 3);
      assert.match(body.messages[0].content, /Do not mention, compare with, or recommend any other brand/i);
    }
    assert.ok(bodies.some((body) => body.messages[1].content.includes('Ridgeline')));
    assert.ok(bodies.some((body) => body.messages[1].content.includes('Unbranded Field Stove')));
    assert.ok(bodies.some((body) => body.messages[1].content.includes('Brand B1')));
    assert.ok(bodies.some((body) => body.messages[1].content.includes('Product P1')));
    assert.ok(bodies.some((body) => /no brand recorded/i.test(body.messages[1].content)));
    assert.deepEqual(result.unresearched, ['Unbranded Field Stove']);
  });

  it('★ searches each recorded brand separately, so one source cannot stand in for all', async () => {
    useResearch();
    responder = () =>
      allowedResponse(
        [{ subjectId: 'B1', finding: 'A sourced finding for this recorded brand.' }],
        [{ url_citation: { url: 'https://example.com/brand-review', title: 'Brand review' } }],
      );
    const branded = [
      { ...subjects[0], id: 'brand-1', name: 'Trail Lamp', brand: 'Ridgeline' },
      { ...subjects[0], id: 'brand-2', name: 'Camp Stove', brand: 'Firefly' },
      { ...subjects[0], id: 'brand-3', name: 'Water Filter', brand: 'ClearFlow' },
    ];

    const result = await researchInventoryWeb({ subjects: branded, focus: 'quality' });

    assert.equal(requests.length, 3);
    assert.equal(result.available, true);
    assert.deepEqual(
      result.findings.map((finding) => finding.name).sort(),
      ['ClearFlow', 'Firefly', 'Ridgeline'],
    );
    assert.equal(result.sources.length, 1, 'the same URL from each group is still one source');
  });

  it('★ an answer without a valid citation is not research', async () => {
    useResearch();
    responder = () =>
      allowedResponse(
        [{ subjectId: 'B1', finding: 'Famous for being great.' }],
        [
          { url_citation: { url: 'javascript:alert(1)', title: 'Not a source' } },
          { url_citation: { url: 'https://example.com/ok#section', title: 'A source' } },
        ],
      );
    const withOneValid = await researchInventoryWeb({ subjects });
    assert.equal(withOneValid.available, true, 'one valid source is enough');
    assert.equal(withOneValid.sources.length, 1);

    responder = () => allowedResponse([{ subjectId: 'B1', finding: 'Famous for being great.' }], []);
    const noSources = await researchInventoryWeb({ subjects });
    assert.equal(noSources.available, false);
    assert.equal(noSources.reason, 'NO_SOURCES');
    assert.deepEqual(noSources.findings, []);
  });

  it('★ a malformed body cannot become an unsourced claim', async () => {
    useResearch();
    responder = () => ({ status: 200, json: { choices: [{ message: { content: 'not json' } }] } });
    const result = await researchInventoryWeb({ subjects });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'NO_SOURCES');
    assert.deepEqual(result.findings, []);
  });

  it('★ a spent search allowance falls back to sourced snippets, never a guess', async () => {
    useResearch();
    responder = () => ({ status: 402, json: { error: { message: 'credits' } } });
    fallbackHtml = [
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffield-review&amp;rut=x">Ridgeline field review</a>',
      '<a class="result__snippet" href="#">Owners report a durable switch and a fair price.</a>',
    ].join('');
    const result = await researchInventoryWeb({ subjects });
    assert.equal(result.available, true);
    assert.equal(result.findings[0].name, 'Ridgeline');
    assert.equal(result.sources[0].url, 'https://example.com/field-review');
    assert.match(result.sources[0].snippet, /durable switch and a fair price/i);
    assert.match(result.findings[0].finding, /source snippets, not independently verified/i);
  });

  it('★ a no-result fallback retries with the recorded brand alone', async () => {
    useResearch();
    responder = () => ({ status: 402, json: { error: { message: 'credits' } } });
    fallbackForQuery = (_query, count) =>
      count === 1
        ? ''
        : '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frk-review">Royal Kludge review</a>';
    const branded = [{ ...subjects[0], name: 'Royal Kludge RK61 Plus', brand: 'Royal Kludge' }];

    const result = await researchInventoryWeb({ subjects: branded, focus: 'quality' });

    assert.equal(fallbackRequests.length, 2, 'one empty result and one simplified retry');
    assert.match(fallbackRequests[0], /Royal Kludge RK61 Plus/);
    assert.equal(fallbackRequests[1], '"Royal Kludge" review');
    assert.equal(result.available, true);
    assert.equal(result.findings[0].name, 'Royal Kludge');
    assert.equal(result.sources[0].url, 'https://example.com/rk-review');
  });

  it('★ parses only public result links and keeps their snippets', () => {
    const parsed = parseSearchResults([
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freview&amp;rut=x">A &amp; B review</a>',
      '<a class="result__snippet" href="#">Useful <b>budget</b> evidence.</a>',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Unsafe</a>',
    ].join(''));
    assert.deepEqual(parsed, [
      {
        title: 'A & B review',
        url: 'https://example.com/review',
        snippet: 'Useful budget evidence.',
      },
    ]);
  });

  it('★ appends every source URL the model omitted, once', () => {
    const sources = [
      { title: 'ROG guide', url: 'https://example.com/rog' },
      { title: 'Already cited', url: 'https://example.com/already' },
    ];
    const text = 'The model cited Already cited: https://example.com/already';
    const withUrls = appendMissingSourceUrls(text, sources);
    assert.match(withUrls, /Source URLs:/);
    assert.match(withUrls, /ROG guide: https:\/\/example\.com\/rog/);
    assert.equal((withUrls.match(/https:\/\/example\.com\/already/g) ?? []).length, 1);
    assert.equal(appendMissingSourceUrls(withUrls, sources), withUrls);
  });

  it('★ source and finding filters are independently provable', () => {
    assert.deepEqual(
      validSources([
        { url_citation: { url: 'https://example.com/a', title: 'A' } },
        { url_citation: { url: 'ftp://example.com/a', title: 'FTP' } },
        { url_citation: { url: 'https://example.com/a', title: 'Again' } },
      ]),
      [{ title: 'A', url: 'https://example.com/a' }],
    );
    const findings = filterFindings(
      { findings: [{ subjectId: 'B1', finding: 'Supported.' }, { subjectId: 'P9', finding: 'Outside.' }] },
      subjects,
    );
    assert.deepEqual(findings, [{ name: 'Ridgeline', kind: 'brand', finding: 'Supported.' }]);
  });

  it('★ the prompt sends research questions through the tool and keeps the boundary visible', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /researchInventoryProducts/i);
    assert.match(prompt, /only those recorded products and brands/i);
    assert.match(prompt, /recommend only the names in its subjects/i);
    assert.match(prompt, /source URLs/i);
    assert.match(prompt, /no sources.*say so plainly/i);
  });

  it('★ the tool is read-only, id-taking, and refuses a smuggled brand/tenant', () => {
    const tool = aiToolsById.get('researchInventoryProducts');
    assert.ok(tool, 'researchInventoryProducts is missing from the tool table');
    assert.equal(tool.permission, 'products.view');
    assert.match(tool.description, /product ids/i);
    assert.match(tool.description, /cannot research a brand/i);
    assert.match(tool.description, /does not check or change stock/i);
    assert.ok(validateToolArgs(tool, { productIds: 'x', brand: 'Outside' }).problems.length > 0);
    assert.ok(validateToolArgs(tool, { productIds: 'x', businessId: 'other' }).problems.length > 0);
  });
});

dbSuite('AI-47 inventory research tool', dbOk, () => {
  let owner;
  let productId;
  let archivedId;

  before(async () => {
    owner = await registerOwner(api, tracker);
    const product = await api('POST', '/api/products', {
      token: owner.token,
      body: {
        name: uniqueName('Ridgeline Trail Lamp'),
        brand: 'Ridgeline',
        description: 'A battery lantern for camping.',
        sellingPrice: 24.5,
        unit: 'pc',
      },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const archived = await api('POST', '/api/products', {
      token: owner.token,
      body: { name: uniqueName('Retired Lamp'), brand: 'Retired Brand' },
    });
    assert.equal(archived.status, 201, JSON.stringify(archived.json));
    const archivedPatch = await api('POST', `/api/products/${archived.json.id}/archive`, {
      token: owner.token,
    });
    assert.equal(archivedPatch.status, 200, JSON.stringify(archivedPatch.json));
    archivedId = archived.json.id;
  });

  it('★ researches only the product rows owned by the session', async () => {
    useResearch();
    responder = () =>
      allowedResponse(
        [{ subjectId: 'B1', finding: 'Reviews report a durable switch and a fair price.' }],
        [{ url_citation: { url: 'https://example.com/ridgeline', title: 'Ridgeline review' } }],
      );

    const result = await executeTool(
      'researchInventoryProducts',
      { productIds: productId, focus: 'quality' },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.available, true);
    assert.deepEqual(result.result.findings.map((finding) => finding.name), ['Ridgeline']);
    assert.equal(result.result.subjects[0].id, productId);
    assert.equal(result.result.subjects[0].brand, 'Ridgeline');
    assert.equal(result.result.subjects[0].name.startsWith('Ridgeline Trail Lamp'), true);
    assert.equal(requests.length, 1);
    assert.ok(requestBody().messages[1].content.includes('Ridgeline'));
  });

  it('★ a cross-tenant id is refused before the web is called', async () => {
    const other = await registerOwner(api, tracker);
    const foreign = await api('POST', '/api/products', {
      token: other.token,
      body: { name: uniqueName('Foreign Lamp'), brand: 'Foreign Brand' },
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.json));

    useResearch();
    const beforeCount = requests.length;
    const result = await executeTool(
      'researchInventoryProducts',
      { productIds: foreign.json.id },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.available, false);
    assert.equal(result.result.reason, 'PRODUCTS_NOT_AVAILABLE');
    assert.equal(requests.length, beforeCount, 'no foreign product name may reach the web');
  });

  it('★ archived products and malformed ids are refused without a search', async () => {
    useResearch();
    const beforeCount = requests.length;
    const archived = await executeTool(
      'researchInventoryProducts',
      { productIds: archivedId },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );
    assert.equal(archived.result.available, false);
    assert.equal(archived.result.reason, 'PRODUCTS_NOT_AVAILABLE');

    const malformed = await executeTool(
      'researchInventoryProducts',
      { productIds: 'not-an-id' },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );
    assert.equal(malformed.result.available, false);
    assert.equal(malformed.result.reason, 'PRODUCTS_NOT_AVAILABLE');
    assert.equal(requests.length, beforeCount);
  });
});
