// AI-110 — a restock answer should not make the model do subtraction.
//
// THE GAP. `getReorderNeededProducts` returned `minimumStock` and
// `availableQuantity` and left the difference to the provider. Asked "how many
// should I order?", the model had to subtract two numbers itself; a correct
// list could still carry an incorrect quantity, and the app's restock screen
// made the manager do the same mental arithmetic on every row.
//
// WHAT THIS PINS:
//   * the subtraction has one implementation, with the empty-threshold and
//     unknown-availability cases stated as `null` rather than a misleading 0;
//   * the reorder DTO shared by the REST list and the read-only AI tool carries
//     the value;
//   * the tool description and system prompt tell the model to quote it instead
//     of recalculating it, and call it a floor rather than a purchase order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { productService, unitsBelowMinimum } from '../src/services/product.service.ts';
import { aiToolsById } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

test('AI-110: unitsBelowMinimum is the gap to the configured threshold, or null when there is none', () => {
  assert.equal(unitsBelowMinimum(12, 20), 8);
  assert.equal(unitsBelowMinimum(0, 4), 4);
  assert.equal(unitsBelowMinimum(20, 20), 0);
  assert.equal(unitsBelowMinimum(25, 20), 0);
  assert.equal(unitsBelowMinimum(0, 0), null, 'no threshold means no shortfall to state');
  assert.equal(unitsBelowMinimum(0, null), null);
  assert.equal(unitsBelowMinimum(0, undefined), null);
  assert.equal(unitsBelowMinimum(undefined, 5), null, 'unknown availability is not zero availability');
  assert.equal(unitsBelowMinimum(null, 5), null);
});

test('AI-110: the restock row carries the shortfall beside the quantities it was derived from', () => {
  const row = productService.reorderItemPublic({
    _id: 'product-1',
    businessId: 'business-1',
    name: 'Compact Kettle',
    status: 'ACTIVE',
    minimumStock: 20,
    available: 12,
  });

  assert.equal(row.availableQuantity, 12);
  assert.equal(row.minimumStock, 20);
  assert.equal(row.unitsBelowMinimum, 8);
  assert.equal(row.stockStatus, 'LOW_STOCK');
});

test('AI-110: a zero minimum leaves the shortfall null rather than claiming an order quantity', () => {
  const row = productService.reorderItemPublic({
    _id: 'product-2',
    businessId: 'business-1',
    name: 'No Threshold',
    status: 'ACTIVE',
    minimumStock: 0,
    available: 0,
  });

  assert.equal(row.unitsBelowMinimum, null);
  assert.equal(row.stockStatus, 'OUT_OF_STOCK');
});

test('AI-110: the model is told the field exists and what it means', () => {
  const tool = aiToolsById.get('getReorderNeededProducts');
  assert.ok(tool, 'getReorderNeededProducts is missing');
  assert.match(tool.description, /unitsBelowMinimum/);
  assert.match(tool.description, /null when no minimum is configured/);

  const lowTool = aiToolsById.get('getLowStockProducts');
  assert.ok(lowTool, 'getLowStockProducts is missing');
  assert.match(lowTool.description, /unitsBelowMinimum/);

  const prompt = systemPrompt();
  assert.match(prompt, /unitsBelowMinimum/);
  assert.match(prompt, /gap to the configured minimum/);
  assert.match(prompt, /not a recommended purchase quantity/);
});
