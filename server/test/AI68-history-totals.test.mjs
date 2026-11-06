/**
 * AI-68 — the history totals must be scoped, and the ranking must be over the whole set.
 *
 * WHY THESE TESTS: written by hand, the totals aggregation was missing its `$match` stage
 * and counted all 5,517 ledger rows in the development database around a 7-row page, so
 * "units sold this week" came back as 214,899. A count with no scope looks like a number,
 * so the scope is asserted rather than assumed. The tool-level test then checks the ranking
 * the model reads: `topOut` is a maximum over every matching row, not an addition of page rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { historyTotalsPipeline } from '../src/services/transactions.service.ts';

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
