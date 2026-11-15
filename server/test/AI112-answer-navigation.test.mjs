// AI-112 — a paged answer needs a complete-list destination and a bounded way to keep reading.
//
// The rows and routes are built from the tool call the server executed. Nothing here accepts a
// path or a product id from the model, and every product row keeps the id the read returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerActionsForTool,
  mergeAnswerActions,
  withoutInventoryActions,
} from '../src/services/ai/answerActions.ts';
import AIMessage from '../src/models/aiMessage.model.ts';

const envelope = (result) => ({ ok: true, result });

const restock = envelope({
  count: 19,
  hasMore: false,
  items: [
    {
      id: 'p1',
      name: 'Compact Kettle',
      sku: 'KET-1',
      availableQuantity: 2,
      minimumStock: 5,
      unitsBelowMinimum: 3,
    },
    {
      id: 'p2',
      name: 'Steel Mug',
      sku: 'MUG-2',
      availableQuantity: 0,
      minimumStock: 4,
      unitsBelowMinimum: 4,
    },
  ],
});

test('AI-112: a restock read carries its total, rows and the filter that produced it', () => {
  const action = answerActionsForTool('getReorderNeededProducts', { q: 'kettle', categoryId: 'cat-1' }, restock);
  assert.ok(action?.list);
  assert.equal(action.list.kind, 'restock');
  assert.equal(action.list.total, 19);
  assert.equal(action.list.path, '/restock?q=kettle&categoryId=cat-1');
  assert.deepEqual(action.list.rows[0], {
    productId: 'p1',
    title: 'Compact Kettle',
    detail: 'SKU KET-1 · 2 available · minimum 5 · 3 below minimum',
  });
  assert.equal(action.screen?.path, action.list.path);
});

test('AI-112: a location-scoped out-of-stock read opens the matching inventory filter', () => {
  const action = answerActionsForTool(
    'getOutOfStockProducts',
    { locationId: 'loc-1' },
    envelope({ count: 1, items: [{ id: 'p2', name: 'Steel Mug', sku: 'MUG-2', availableQuantity: 0, minimumStock: 4 }] }),
  );
  assert.equal(action.screen.path, '/inventory?status=out&locationId=loc-1');
  assert.equal(action.list.kind, 'inventory');
});

test('AI-112: inventory filters survive the jump to the complete list', () => {
  const action = answerActionsForTool(
    'getInventory',
    { q: 'cable', locationId: 'loc-1', lowStock: true, status: 'ACTIVE' },
    envelope({
      total: 17,
      items: [{ product: { id: 'p3', name: 'Pro Cable' }, location: { name: 'Main Warehouse' }, availableQuantity: 4 }],
    }),
  );
  assert.equal(action.screen.path, '/inventory?q=cable&locationId=loc-1&lowStock=true');
  assert.deepEqual(action.list.rows[0], {
    productId: 'p3',
    title: 'Pro Cable',
    detail: 'Main Warehouse · 4 available',
  });
});

test('AI-112: history and reference reads get their own screens', () => {
  const history = answerActionsForTool(
    'getInventoryHistory',
    { type: 'STOCK_OUT', productId: 'p1', locationId: 'loc-1' },
    envelope({ total: 3, items: [] }),
  );
  assert.equal(history.screen.path, '/history?type=STOCK_OUT&productId=p1&locationId=loc-1');
  assert.equal(answerActionsForTool('listLocations', {}, envelope({ items: [] })).screen.path, '/locations');
  assert.equal(answerActionsForTool('listCategories', {}, envelope({ items: [] })).screen.path, '/categories');
});

test('AI-112: a single-product read does not invent a list destination', () => {
  assert.equal(answerActionsForTool('getProduct', { id: 'p1' }, envelope({ product: { id: 'p1' } })), null);
});

test('AI-112: a highest-stock ranking drops the auxiliary inventory page, not a useful screen', () => {
  const auxiliary = answerActionsForTool(
    'getInventory',
    { productId: 'p1' },
    envelope({
      total: 12,
      items: [{ product: { id: 'p1', name: 'Razer BlackWidow V4 Pro' }, location: { name: 'Shop Front' }, availableQuantity: 8 }],
    }),
  );
  const alone = withoutInventoryActions(mergeAnswerActions({ screens: [] }, auxiliary));
  assert.equal(alone.list, undefined);
  assert.deepEqual(alone.screens, []);

  const useful = answerActionsForTool('getReorderNeededProducts', {}, restock);
  const mixed = withoutInventoryActions(mergeAnswerActions(mergeAnswerActions({ screens: [] }, auxiliary), useful));
  assert.equal(mixed.list.kind, 'restock');
  assert.deepEqual(mixed.screens.map((entry) => entry.kind), ['restock']);
});

test('AI-112: one turn keeps the most useful list and at most three screen links', () => {
  let actions = { screens: [] };
  actions = mergeAnswerActions(actions, answerActionsForTool('searchProducts', { q: 'cable' }, envelope({ total: 2, items: [] })));
  actions = mergeAnswerActions(actions, answerActionsForTool('getInventory', {}, envelope({ total: 2, items: [] })));
  actions = mergeAnswerActions(actions, answerActionsForTool('getReorderNeededProducts', {}, restock));
  actions = mergeAnswerActions(actions, answerActionsForTool('listLocations', {}, envelope({ items: [] })));
  assert.equal(actions.list.kind, 'restock');
  assert.equal(actions.screens.length, 3);
  assert.deepEqual(actions.screens.map((entry) => entry.kind), ['products', 'inventory', 'restock']);
});

test('AI-112: filters provided by name are carried for the screen to resolve', () => {
  const restockAction = answerActionsForTool(
    'getReorderNeededProducts',
    { category: 'Beverages' },
    restock,
  );
  assert.equal(restockAction.list.path, '/restock?category=Beverages');

  const scoped = answerActionsForTool(
    'getLowStockProducts',
    { location: 'Main Warehouse' },
    envelope({ count: 3, items: [] }),
  );
  assert.equal(scoped.screen.path, '/inventory?status=low&location=Main%20Warehouse');

  const inventory = answerActionsForTool(
    'getInventory',
    { location: 'Main Warehouse' },
    envelope({ total: 1, items: [] }),
  );
  assert.equal(inventory.screen.path, '/inventory?location=Main%20Warehouse');

  const history = answerActionsForTool(
    'getInventoryHistory',
    { location: 'Main Warehouse' },
    envelope({ total: 1, items: [] }),
  );
  assert.equal(history.screen.path, '/history?locationName=Main%20Warehouse');
});

test('AI-112: the stored message can carry the bounded list without a schema change', () => {
  const path = AIMessage.schema.path('answerActions');
  assert.ok(path, 'AIMessage has no answerActions field');
  assert.ok(path.schema.path('list'));
  assert.ok(path.schema.path('screens'));
});