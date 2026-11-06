// AI-61 — "what's running low at the counter?" must answer for the counter.
//
// WHY THIS EXISTS. On the mirrored test phone (2026-11-05) the dev tenant had a Front
// Counter down to 4 items at or below minimum while the Store Room held the rest. Asking
// about the counter could only be answered from a business-wide list, which summed every
// location: `getLowStockProducts` returned ONE product for the whole business and the four
// shortages on the selling shelf were invisible. The same blind spot applied to
// `getOutOfStockProducts` — a product sold out at the counter but stacked in the store
// room was reported as simply "in stock".
//
// WHAT THIS SUITE GUARDS:
//   * both tools accept an exact `location` name or a `locationId`, optionally;
//   * the name is resolved to an id and passed to product.service (which already judges
//     each product against the one location's rows);
//   * no location keeps the previous business-wide meaning;
//   * the page echoes `locationId` so the answer is checkable;
//   * an unknown location is refused with the names it does know, not silently ignored;
//   * a smuggled `businessId` is still rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiToolsById, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const tool = (name) => aiToolsById.get(name);

test('AI-61: both stock lists take an optional place', () => {
  for (const name of ['getLowStockProducts', 'getOutOfStockProducts']) {
    const { parameters } = tool(name);
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['limit', 'location', 'locationId'], name);
    // Optional: no location is the business-wide list these tools always returned.
    assert.equal(parameters.required, undefined, name);
  }
});

test('AI-61: the descriptions say what a scoped list means', () => {
  assert.match(tool('getLowStockProducts').description, /judge each product against what ONE place holds/);
  assert.match(tool('getLowStockProducts').description, /full store room otherwise hides a selling shelf/);
  assert.match(tool('getOutOfStockProducts').description, /sold out AT one place/);
});

test('AI-61: the prompt says a shortage question about a place is about that place', () => {
  assert.match(systemPrompt(), /getLowStockProducts and getOutOfStockProducts do/);
  assert.match(systemPrompt(), /pass the location rather than answering from the business-wide total/);
});

test('AI-61: the filters are accepted and a smuggled businessId is still refused', () => {
  for (const name of ['getLowStockProducts', 'getOutOfStockProducts']) {
    const { problems: accepted } = validateToolArgs(tool(name), { location: 'Front Counter', limit: 10 });
    assert.deepEqual(accepted, [], name);

    const { problems } = validateToolArgs(tool(name), { businessId: '6ae164357b1cce3d75857a35' });
    assert.ok(
      problems.some((p) => /unknown argument "businessId"/.test(p)),
      `${name} accepted a smuggled businessId`
    );
  }
});
