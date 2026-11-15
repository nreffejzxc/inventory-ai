// AI-111 — answer actions must be grounded in the rows the turn actually read.
//
// Copy Answer is a client action over the stored text. Product navigation is different: a name
// is not an id, and a name can be shared by two catalogue rows. This pins the server half — only
// a product id from a read row may become a link, the name must appear as a whole word in the
// final answer, and an ambiguous name is omitted rather than guessed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mentionedProductLinks } from '../src/services/ai/answerCompletion.ts';
import AIMessage from '../src/models/aiMessage.model.ts';

const rows = [
  { id: 'p1', name: 'Compact Kettle', sku: 'KET-1', availableQuantity: 2 },
  { id: 'p2', name: 'Steel Mug', sku: 'MUG-2', availableQuantity: 0 },
  { id: 'p3', name: 'Not Mentioned', sku: 'X-3', availableQuantity: 9 },
];

test('AI-111: only products named in the final answer become links', () => {
  const links = mentionedProductLinks('Compact Kettle has 2 left; Steel Mug is out.', rows);
  assert.deepEqual(links, [
    { productId: 'p1', name: 'Compact Kettle', sku: 'KET-1' },
    { productId: 'p2', name: 'Steel Mug', sku: 'MUG-2' },
  ]);
});

test('AI-111: a name is matched as a whole word, not as a substring', () => {
  const links = mentionedProductLinks('We sell Mugs and Kettles, but not the recorded names.', rows);
  assert.deepEqual(links, []);
});

test('AI-111: a product id from another scope is never inferred from a display name', () => {
  const links = mentionedProductLinks('Compact Kettle has 2 left.', [
    { name: 'Compact Kettle', availableQuantity: 2 },
  ]);
  assert.deepEqual(links, [], 'a name without an id cannot become a link');
});

test('AI-111: an ambiguous duplicate name is omitted instead of opening the wrong product', () => {
  const links = mentionedProductLinks('We have the Classic Mug in two products.', [
    { id: 'p1', name: 'Classic Mug', sku: 'MUG-A' },
    { id: 'p2', name: 'Classic Mug', sku: 'MUG-B' },
  ]);
  assert.deepEqual(links, []);
});

test('AI-111: duplicate rows for one id are deduped and the link cap is bounded', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`,
    name: `Product ${index}`,
  }));
  const links = mentionedProductLinks(many.map((row) => row.name).join(', '), [
    ...many,
    ...many,
  ]);
  assert.equal(links.length, 8);
  assert.equal(new Set(links.map((link) => link.productId)).size, 8);
});

test('AI-111: the stored message has the product-link fields the client reads', () => {
  const path = AIMessage.schema.path('productLinks');
  assert.ok(path, 'AIMessage has no productLinks field');
  assert.equal(path.instance, 'Array');
  const linkPath = path.schema.path('productId');
  assert.ok(linkPath, 'productLinks has no productId');
  assert.equal(linkPath.isRequired, true);
});