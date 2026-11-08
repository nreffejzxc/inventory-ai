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

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import {
  capResearchSourcesPerHost,
  rankResearchSources,
} from '../src/services/ai/webResearch.ts';
import { readUsage } from '../src/services/ai/providers/anthropicWire.ts';

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
      }),
      { inputTokens: 135, outputTokens: 20 },
    );
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
