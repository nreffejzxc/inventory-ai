import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiToolsById, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const tool = () => aiToolsById.get('getStockValue');

test('AI-59: getStockValue takes an optional place and kind of product', () => {
  const { parameters } = tool();
  assert.deepEqual(Object.keys(parameters.properties).sort(), [
    'category',
    'categoryId',
    'limit',
    'location',
    'locationId',
  ]);
  // Optional: no filter is the whole business, which is the default this tool had before.
  assert.equal(parameters.required, undefined);
});

test('AI-59: the description tells the model to narrow the read rather than add rows up', () => {
  const { description } = tool();
  assert.match(description, /`location`\/`locationId`/);
  assert.match(description, /`category`\/`categoryId`/);
  assert.match(description, /never add up row prices yourself/);
  assert.match(description, /`scope` echoes the filter/);
});

test('AI-59: a scoped total counts only products holding stock at that location', () => {
  // The behaviour lives in product.service; this pins the promise the description makes,
  // because an unscoped count at a location would report the whole catalogue as its contents.
  const { description } = tool();
  assert.match(description, /counts only products actually holding stock there/);
});

test('AI-59: the filters are accepted and a smuggled businessId is still refused', () => {
  const { problems: accepted } = validateToolArgs(tool(), {
    location: 'Main Warehouse',
    category: 'Keyboards',
  });
  assert.deepEqual(accepted, []);

  const { problems } = validateToolArgs(tool(), { businessId: '6ae164357b1cce3d75857a35' });
  assert.ok(problems.some((p) => /unknown argument "businessId"/.test(p)));
});

test('AI-59: the prompt routes a one-place value question to the scoped call', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /value question is about ONE place or ONE kind of product/);
  assert.match(prompt, /do not list the rows and add their values yourself/);
});
