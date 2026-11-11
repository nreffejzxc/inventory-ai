/**
 * AI-68 — the history totals must be scoped, and the ranking must be over the whole set.
 *
 * WHY THESE TESTS: written by hand, the totals aggregation was missing its `$match` stage
 * and counted all 5,517 ledger rows in the development database around a 7-row page, so
 * "units sold this week" came back as 214,899. A count with no scope looks like a number,
 * so the scope is asserted rather than assumed. The tool-level test then checks the ranking
 * the model reads: `topOut` is a maximum over every matching row, not an addition of page rows.
 *
 * AI-103 adds the other half: a read with receipts or transfers but no stock-out must still
 * carry its whole-set receipt/transfer totals, otherwise the model is back to adding rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { historyTotalsPipeline } from '../src/services/transactions.service.ts';
import { historyMovementSummary } from '../src/services/ai/tools.ts';

const businessId = { toString: () => '6ae164357b1cce3d75857a35' };

test('AI-68: the totals pipeline starts with the scoped match', () => {
  const match = { businessId, type: 'STOCK_OUT' };
  const stages = historyTotalsPipeline(match);
  assert.deepEqual(stages[0], { $match: match });
});

test('AI-68: the first stage is a $match, never a $group', () => {
  const stages = historyTotalsPipeline({ businessId });
  assert.ok(stages[0].$match, 'stage 0 must be $match');
  assert.equal(stages[0].$match.businessId, businessId);
  assert.ok(!stages[0].$group, 'stage 0 must not be the group stage');
  assert.equal(stages.length, 3);
});

test('AI-103: a receipt-only read still reports whole-set receipt totals', () => {
  const summary = historyMovementSummary(
    { byType: { STOCK_IN: { rows: 4, units: 40 } }, products: [] },
    [],
  );
  assert.equal(summary.unitsReceived, 40);
  assert.equal(summary.deliveries, 4);
  assert.equal(summary.stockOutMovements, 0);
  assert.equal(summary.unitsSold, undefined);
  assert.equal(summary.topOut, undefined);
  assert.match(summary.totalsNote ?? '', /do not add the rows up/);
});

test('AI-103: a transfer-only read still reports its transfer legs', () => {
  const summary = historyMovementSummary(
    { byType: { TRANSFER: { rows: 6, units: 12 } }, products: [] },
    [],
  );
  assert.equal(summary.transferLegs, 6);
  assert.equal(summary.unitsSold, undefined);
  assert.equal(summary.unitsReceived, undefined);
});

test('AI-103: stock-out totals and the five-product ranking survive together', () => {
  const topOut = [{ product: 'Keyboard', productId: 'p1', unitsOut: 5 }];
  const summary = historyMovementSummary(
    {
      byType: {
        STOCK_OUT: { rows: 2, units: 5 },
        STOCK_IN: { rows: 1, units: 9 },
        TRANSFER: { rows: 2, units: 3 },
      },
      products: [],
    },
    topOut,
  );
  assert.equal(summary.unitsSold, 5);
  assert.equal(summary.sales, 2);
  assert.equal(summary.unitsReceived, 9);
  assert.equal(summary.deliveries, 1);
  assert.equal(summary.transferLegs, 2);
  assert.equal(summary.stockOutMovements, 2);
  assert.deepEqual(summary.topOut, topOut);
  assert.match(summary.totalsNote ?? '', /STOCK_OUT units only/);
});

test('AI-103: a read with no movements adds no summary fields', () => {
  assert.deepEqual(historyMovementSummary({ byType: {}, products: [] }, []), {});
});
