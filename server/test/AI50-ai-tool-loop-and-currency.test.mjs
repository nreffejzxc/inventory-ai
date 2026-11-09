// AI-50 — two defects measured on the physical phone during the 2026-11-04 retest.
//
// 1. THE TOOL LOOP ENDED IN A CANNED SENTENCE. Q1 ("specs, stock and prices, then
//    recommend one") spent every one of its six steps re-issuing the same
//    `searchProducts` + `getInventory` pair and then returned the ITERATION_LIMIT
//    sentence, although the results needed for an answer were already in the
//    conversation. Two things were missing:
//      * nothing told the model a call was a repeat, so it re-ran it;
//      * the LAST step was an ordinary tool round, so it could be spent on another
//        search instead of on the answer.
//    The last round now withholds the tools and says so, and a repeat's result
//    carries a `repeatNotice` field.
//
// 2. A RECORDED PRICE HAD NO CURRENCY. Products stored a bare number, so the model
//    wrote `₱6,990` for a price the catalogue never labelled and prompt rule 23 had
//    to say "do not put a currency symbol". Products now record an optional
//    ISO-4217 code; when it is absent the answer must stay symbol-free.
//
// DB-free: the loop tests drive the real ai.service through the fake provider, and
// the currency tests exercise the pure prompt builders and the product validator.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { marketPricePrompt } from '../src/services/ai/marketPrices.ts';
import { researchPrompt } from '../src/services/ai/webResearch.ts';
import { registerFakeProvider, setFakeScenario, fakeText, fakeCalls } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
});

/** Run one turn, recording every request the loop sent. */
async function askRecording(scenario, message = 'how much stock do we hold?') {
  const seen = [];
  setFakeScenario((ctx) => {
    // The loop keeps appending to the SAME messages array, so each request must be
    // snapshotted: otherwise an earlier round's record grows the later tool results and
    // a first call looks like a repeat.
    const snapshot = { ...ctx, messages: [...ctx.messages] };
    seen.push(snapshot);
    return scenario(snapshot, seen.length);
  });
  const result = await runAiChat({
    businessId: 'b-dummy',
    userId: 'u-dummy',
    role: ROLES.OWNER,
    message,
  });
  return { result, seen };
}

function lastToolMessage(ctx) {
  for (let i = ctx.messages.length - 1; i >= 0; i -= 1) {
    if (ctx.messages[i].role === 'tool') return ctx.messages[i];
  }
  return null;
}

unitSuite('AI-50 — the last tool round answers instead of searching again', () => {
  it('withholds the tools on the final round and asks for an answer from what it has', async () => {
    const { result, seen } = await askRecording((_ctx, n) =>
      n < aiConfig().maxToolIterations
        ? fakeCalls([{ id: `call-${n}`, name: 'getInventory', input: {} }])
        : fakeText('You hold stock in two locations.'),
    );

    const last = seen[seen.length - 1];
    assert.equal(
      (last.tools ?? []).length,
      0,
      'the final round must not offer any tool, or it can spend the step searching',
    );
    const instruction = last.messages[last.messages.length - 1];
    assert.equal(instruction.role, 'user');
    assert.match(instruction.content, /No further tools are available/i);
    assert.match(instruction.content, /already above/i);

    // The answer from that round is the turn's answer: no canned sentence.
    assert.equal(result.degraded, undefined);
    assert.match(result.content, /two locations/);
  });

  it('still offers tools on every round before the last', async () => {
    const { seen } = await askRecording((_ctx, n) =>
      n < aiConfig().maxToolIterations ? fakeCalls([{ id: `call-${n}`, name: 'getInventory', input: {} }]) : fakeText('done'),
    );

    const cap = aiConfig().maxToolIterations;
    for (let i = 0; i < cap - 1; i += 1) {
      assert.ok((seen[i].tools ?? []).length > 0, `round ${i + 1} must keep its tools`);
    }
  });

  it('tells the model when a call is a repeat, without breaking the JSON result', async () => {
    const { seen } = await askRecording((_ctx, n) =>
      n < aiConfig().maxToolIterations
        ? fakeCalls([{ id: `call-${n}`, name: 'getInventory', input: {} }])
        : fakeText('done'),
    );

    // Round 2 repeats round 1's exact call, so the tool result the loop sends AFTER that
    // round carries the note (the last request of the turn sees it).
    const afterRepeat = seen[seen.length - 1];
    const tool = lastToolMessage(afterRepeat);
    assert.ok(tool, 'a later round should carry the repeated call\u2019s result');
    const parsed = JSON.parse(tool.content);
    assert.match(parsed.repeatNotice ?? '', /already ran earlier in this turn/i);
    assert.match(parsed.repeatNotice ?? '', /Do not call it again/i);
    // The note rides inside the result object, so the payload stays parseable JSON.
    assert.equal(typeof parsed, 'object');

    // The first round's result has no note: a first call is not a repeat.
    const first = JSON.parse(lastToolMessage(seen[1]).content);
    assert.equal(first.repeatNotice, undefined);
  });
});

unitSuite('AI-50 — research turns get room to reach the research tool', () => {
  it('calls researchInventoryProducts after the ordinary iteration cap', async () => {
    const cap = aiConfig().maxToolIterations;
    assert.equal(cap, 6, 'this regression pins the documented six-step default');
    const researchRound = cap + 1;
    const expandedRound = Math.min(cap + 2, 8);

    const { result, seen } = await askRecording(
      (_ctx, n) => {
        if (n < researchRound) {
          return fakeCalls([{ id: `discovery-${n}`, name: 'noSuchTool', input: {} }]);
        }
        if (n === researchRound) {
          return fakeCalls([
            {
              id: 'research-1',
              name: 'researchInventoryProducts',
              // A malformed id is refused before any database or web read. The test is
              // about reaching the tool, not about the research response itself.
              input: { productIds: 'not-an-id' },
            },
          ]);
        }
        return fakeText('The research tool returned its result for the Keychron K8 Pro.');
      },
      // AI-88: a quality/reliability question is inventory-only unless the member names an
      // external source, so the explicit "online" is what makes this a research turn.
      'Research online the quality and reliability of the Keychron K8 Pro.',
    );

    assert.equal(seen.length, expandedRound, 'the research turn must reach its answer round');
    assert.ok(
      (seen[cap - 1].tools ?? []).length > 0,
      'the old final round must still offer tools, or research can never be called',
    );
    assert.ok(
      (seen[researchRound - 1].tools ?? []).some((tool) => tool.name === 'researchInventoryProducts'),
      'the research tool must be available on the expanded round',
    );
    assert.ok(result.toolsUsed.includes('researchInventoryProducts'));
    // The malformed call was refused before it could read a source. Now that a research
    // answer must be backed by a returned source, this is not a verified research turn:
    // the guard re-asks twice and then refuses to show the unsourced model text.
    assert.equal(result.degraded, 'UNVERIFIED_RESEARCH');
    assert.match(result.content, /couldn't verify current online information/i);
    assert.doesNotMatch(result.content, /research tool returned its result/i);
  });
});

unitSuite('AI-50 — a recorded price carries the currency the catalogue stores', () => {
  const base = { id: 'p1', name: 'Keychron K8 Pro', brand: 'Keychron', unit: 'pc' };

  it('names the recorded currency in the market-price prompt', () => {
    const prompt = marketPricePrompt({ ...base, sellingPrice: 6990, currency: 'PHP' });
    assert.match(prompt, /recorded selling price 6990 per pc \(inventory price, in PHP\)/);
  });

  it('keeps the unknown case explicitly unknown rather than defaulting it', () => {
    const prompt = marketPricePrompt({ ...base, sellingPrice: 6990, currency: null });
    assert.match(prompt, /inventory price, currency not recorded/);
    assert.doesNotMatch(prompt, /in PHP|in USD/);
  });

  it('does the same in the research prompt', () => {
    const subject = { ...base, category: 'Keyboards', sellingPrice: 6990 };
    const priced = researchPrompt([{ ...subject, currency: 'PHP' }], 'overall');
    assert.match(priced, /recorded selling price 6990 per pc \(in PHP\)/);

    const unrecorded = researchPrompt([{ ...subject, currency: null }], 'overall');
    assert.match(unrecorded, /recorded selling price 6990 per pc \(currency not recorded\)/);
  });
});
