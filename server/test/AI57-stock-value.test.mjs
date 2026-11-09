import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiToolsById, validateToolArgs } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';
import { PERMISSIONS } from '../src/constants/roles.ts';

test('AI-57: getStockValue is registered as an inventory read with a strict, argument-light schema', () => {
  const tool = aiToolsById.get('getStockValue');
  assert.ok(tool, 'getStockValue must be in the tool table');
  assert.equal(tool.permission, PERMISSIONS.INVENTORY_VIEW);
  assert.equal(tool.parameters.additionalProperties, false);
  // AI-59 widened the schema with the optional place/kind filters, so the exact key set is
  // asserted here: every argument is a deliberate one, and an unlisted key is refused.
  assert.deepEqual(Object.keys(tool.parameters.properties), ['limit', 'locationId', 'location', 'categoryId', 'category']);
  assert.equal(tool.parameters.required, undefined);
});

test('AI-57: the description says value is at recorded price and unpriced products are not zero', () => {
  const { description } = aiToolsById.get('getStockValue');
  assert.match(description, /recorded selling price/i);
  assert.match(description, /NOT counted as zero/);
  // Currency is part of the value: a total in two currencies is not one number.
  assert.match(description, /mixedCurrency/);
  assert.match(description, /totalsByCurrency/);
});

test('AI-57: a businessId smuggled into the arguments is refused', () => {
  const tool = aiToolsById.get('getStockValue');
  const { problems } = validateToolArgs(tool, { businessId: '6ae164357b1cce3d75857a35' });
  assert.ok(problems.some((p) => /unknown argument "businessId"/.test(p)), 'extra argument must be rejected');
});

test('AI-57: the prompt routes valuation questions to getStockValue', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /call getStockValue once/);
  assert.match(prompt, /unpricedProducts/);
  assert.match(prompt, /mixedCurrency/);
});
