// AI-86 — research efficiency: third-party evidence outranks a vendor's own shop,
// one host cannot fill the citation list, and token accounting survives both wire
// shapes OpenRouter has used.
//
// WHY THIS SUITE EXISTS. The turn budget (AI-1/AI-85) stopped the assistant from
// timing out, but the phone run still answered a Logitech review question with three
// logitech.com pages and a price question with no source at all. Speed alone is not
// quality: the search ladder had spent its whole budget, and the citation list had no
// notion of an independent publisher. These cases pin the ranking and the accounting
// that the next device run depends on, without calling a model or the web.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import {
  capResearchSourcesPerHost,
  rankResearchSources,
} from '../src/services/ai/webResearch.ts';
import {
  asksForWebResearch,
  webToolsUsedFromResponse,
} from '../src/services/ai/webCapabilities.ts';
import { runAiChat, systemPrompt } from '../src/services/ai/ai.service.ts';
import { ROLES } from '../src/constants/roles.ts';
import { readUsage } from '../src/services/ai/providers/anthropicWire.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
process.env.AI_WEB_SEARCH = 'disable';
process.env.AI_WEB_FETCH = 'disable';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
});

const group = {
  brand: 'Logitech',
  subjects: [
    {
      id: 'p1',
      name: 'Logitech MX Keys S',
      brand: 'Logitech',
      category: 'Keyboard',
      sellingPrice: 6290,
      unit: 'pc',
    },
  ],
};

const source = (url, title, snippet = '') => ({ url, title, ...(snippet ? { snippet } : {}) });

unitSuite('AI-86 sources are ranked by evidence, not by engine order', () => {
  it('★ an independent review outranks the manufacturer’s own product, shop and software pages', () => {
    const ranked = rankResearchSources(
      group,
      [
        source('https://www.logitech.com/en-ph/shop/mx-keys-s', 'MX Keys S — Official Logitech Shop'),
        source('https://www.logitech.com/en-ph/software/ghub', 'Logitech G Hub software'),
        source(
          'https://www.rtings.com/keyboard/reviews/logitech/mx-keys-s',
          'Logitech MX Keys S Review',
          'Tested: a quiet office keyboard with a solid verdict.',
        ),
      ],
      'overall',
    );

    assert.equal(ranked[0].url, 'https://www.rtings.com/keyboard/reviews/logitech/mx-keys-s');
    assert.equal(ranked.at(-1).url, 'https://www.logitech.com/en-ph/shop/mx-keys-s');
  });

  it('★ specification questions keep the manufacturer first', () => {
    const ranked = rankResearchSources(
      group,
      [
        source('https://www.rtings.com/keyboard/reviews/logitech/mx-keys-s', 'MX Keys S review'),
        source('https://www.logitech.com/en-ph/shop/mx-keys-s/specs', 'MX Keys S specifications'),
      ],
      'specifications',
    );

    assert.equal(ranked[0].url, 'https://www.logitech.com/en-ph/shop/mx-keys-s/specs');
  });

  it('★ two pages from one host are kept, the third is dropped', () => {
    const capped = capResearchSourcesPerHost(
      [
        source('https://www.logitech.com/a', 'One'),
        source('https://www.logitech.com/b', 'Two'),
        source('https://www.logitech.com/c', 'Three'),
        source('https://www.rtings.com/review', 'Review'),
      ],
      2,
    );

    assert.deepEqual(
      capped.map((entry) => entry.url),
      ['https://www.logitech.com/a', 'https://www.logitech.com/b', 'https://www.rtings.com/review'],
    );
  });
});

unitSuite('AI-86 usage is read from the Anthropic and OpenAI shapes', () => {
  it('★ cache reads and writes count as billed input tokens', () => {
    assert.deepEqual(
      readUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
        cost: 0.007192,
      }),
      { inputTokens: 135, outputTokens: 20, costUsd: 0.007192 },
    );
  });

  it('★ a reported zero cost is a measurement, not an absence', () => {
    assert.deepEqual(readUsage({ input_tokens: 1, output_tokens: 1, cost: 0 }), {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
  });

  it('★ an OpenAI-shaped report is accepted, not reported as zero', () => {
    assert.deepEqual(readUsage({ prompt_tokens: 90, completion_tokens: 12 }), {
      inputTokens: 90,
      outputTokens: 12,
    });
  });

  it('★ a body with no counters stays absent rather than becoming a zero', () => {
    assert.equal(readUsage({}), null);
    assert.equal(readUsage(null), null);
  });
});

unitSuite('AI-86 native web tools are the primary research path', () => {
  it('★ server-tool usage details count as a real web read', () => {
    assert.deepEqual(
      webToolsUsedFromResponse([], {
        server_tool_use_details: { web_search_requests: 2, web_fetch_requests: 1 },
      }),
      ['search', 'fetch'],
    );
    assert.deepEqual(
      webToolsUsedFromResponse([], {
        server_tool_use: { web_search_requests: 1 },
      }),
      ['search'],
    );
  });

  it('★ the native-mode prompt supersedes the local research tools', () => {
    const native = systemPrompt({ nativeWeb: true });
    assert.match(native, /OpenRouter native web search and web fetch are enabled/);
    assert.match(native, /do NOT call researchInventoryProducts or researchMarketPrices/);
    assert.match(native, /cite every source URL exactly/i);

    const local = systemPrompt({ nativeWeb: false });
    assert.doesNotMatch(local, /OpenRouter native web search and web fetch are enabled/);
    assert.match(local, /call researchInventoryProducts/);
  });
});

unitSuite('AI-80/AI-86 research is multilingual and never invented', () => {
  it('★ Bisaya and Tagalog research requests reach the research path; inventory prices do not', () => {
    for (const message of [
      'Pangitaa ang mga review sa Logitech MX Master 3S 10663 ug ibutang ang mga source',
      'Maghanap ng online na presyo ng Samsung Portable SSD T7 Shield 1TB 10557 at magbigay ng sources',
      'Pangitaa ang mga presyo sa Shopee para sa Logitech MX Master 3S',
    ]) {
      assert.equal(asksForWebResearch(message), true, message);
    }

    for (const message of [
      'Pila ang presyo ng Dell UltraSharp U2723QE 10232?',
      'Ilan ang presyo ng Dell UltraSharp U2723QE 10232?',
      'Hanapin ang mga keyboard sa ating catalogue.',
      'Review my stock and tell me what is low.',
      'What do reviews say about this product?',
    ]) {
      assert.equal(asksForWebResearch(message), false, message);
    }
  });

  it('★ a research answer with no web read is refused, not shown', async () => {
    setFakeScenario(() =>
      fakeText(
        'Owner reviews are very positive. The current price is PHP 4,999: https://invented.example/review',
      ),
    );

    const result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message:
        'Pangitaa ang mga review sa Logitech MX Master 3S 10663 ug ibutang ang mga source',
    });

    assert.equal(result.degraded, 'UNVERIFIED_RESEARCH');
    assert.match(result.content, /couldn't verify current online information/i);
    assert.doesNotMatch(result.content, /https?:\/\//);
    assert.doesNotMatch(result.content, /PHP 4,999/);
    assert.deepEqual(result.toolsUsed, []);
  });

  it('★ a research answer backed by a returned source is kept', async () => {
    setFakeScenario(() =>
      fakeText('A sourced review says the mouse is comfortable.', {
        webSources: [{ title: 'Review', url: 'https://example.com/review' }],
      }),
    );

    const result = await runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      message:
        'Pangitaa ang mga review sa Logitech MX Master 3S 10663 ug ibutang ang mga source',
    });

    assert.equal(result.degraded, undefined);
    assert.match(result.content, /A sourced review/);
    assert.match(result.content, /https:\/\/example\.com\/review/);
  });
});
