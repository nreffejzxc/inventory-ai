import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRowPublic } from '../src/services/inventory.service.ts';
import { aiToolsById } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';

const businessId = '6ae164357b1cce3d75857a35';

function row(product) {
  return {
    _id: '6aeb71d0f8462e2c4839ebbe',
    businessId,
    product,
    location: { _id: '6aeb71d0f8462e2c4839eb00', name: 'Main Warehouse' },
    quantity: 3,
    reservedQuantity: 0,
  };
}

const product = {
  _id: '6aeb71d0f8462e2c4839ebbc',
  name: 'Alienware m16 R2',
  sku: 'AW-M16R2-4070',
  unit: 'pc',
  status: 'ACTIVE',
  minimumStock: 1,
  sellingPrice: 139995,
  currency: 'PHP',
};

test('AI-58: an inventory row carries the recorded price and its currency', () => {
  const dto = inventoryRowPublic(row(product));
  assert.equal(dto.product.sellingPrice, 139995);
  assert.equal(dto.product.currency, 'PHP');
  // The quantity is what a value is computed from, so the pair must agree.
  assert.equal(dto.availableQuantity, 3);
});

test('AI-58: an unrecorded price stays null rather than becoming zero or a guess', () => {
  const dto = inventoryRowPublic(row({ ...product, sellingPrice: null, currency: null }));
  assert.equal(dto.product.sellingPrice, null);
  assert.equal(dto.product.currency, null);

  const absent = inventoryRowPublic(row({ ...product, sellingPrice: undefined, currency: undefined }));
  assert.equal(absent.product.sellingPrice, null);
  assert.equal(absent.product.currency, null);
});

test('AI-58: a non-numeric price or blank currency is not passed through', () => {
  const dto = inventoryRowPublic(row({ ...product, sellingPrice: '139995', currency: '  ' }));
  assert.equal(dto.product.sellingPrice, null);
  assert.equal(dto.product.currency, null);
});

test('AI-58: getInventory says the rows carry the recorded price', () => {
  const { description } = aiToolsById.get('getInventory');
  assert.match(description, /sellingPrice/);
  assert.match(description, /never recorded/);
});

test('AI-58: the prompt forbids estimating a price', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /Take every price from tool output/);
  assert.match(prompt, /Never estimate, round or restate a price/);
});
