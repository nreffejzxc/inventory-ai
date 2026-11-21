// AI-118 follow-up — the live evaluator's judgements, tested without a paid call.
//
// The artifact has both an exact phrase and a semantic caveat: "stock-out events
// (sales, usage, damage, or write-offs)" is a real proxy caveat even though it does
// not contain "movement proxy". These tests pin that distinction, and pin that a
// selected tool is not counted as used unless the answer finalizer actually ran.

import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasStockOutProxyCaveat,
  summarizeStockCoverageRows,
} from '../scripts/eval-stock-coverage-metrics.mjs';

it('★ recognises exact and semantic proxy caveats, but not a bare stock-out basis', () => {
  for (const answer of [
    'Stock-out is a movement proxy, not confirmed sales.',
    'This estimate reflects only recorded stock-out events (sales, usage, damage, or write-offs).',
    'Outflow can be usage, damage or a write-off.',
    'STOCK_OUT is not a sales figure; it may be a sale, usage, damage or a write-off.',
  ]) {
    assert.equal(hasStockOutProxyCaveat(answer), true, answer);
  }
  for (const answer of [
    'Over the 30-day window, 3 units left stock, giving an estimate of 100 days.',
    'The stock-out rate is 0.1 units per day over the last 30 days.',
    'The average daily outflow is 0.4 units.',
    'Stock-out is not a guarantee of future demand.',
  ]) {
    assert.equal(hasStockOutProxyCaveat(answer), false, answer);
  }
});

it('★ separates selected, succeeded and actually used coverage', () => {
  const rows = [
    {
      coverageSelected: true,
      coverageFirst: true,
      coverageSucceeded: true,
      coverageUsed: true,
      corrected: false,
      error: null,
      answerExcerpt: 'Stock-out is a movement proxy, not confirmed sales.',
    },
    {
      coverageSelected: true,
      coverageFirst: false,
      coverageSucceeded: true,
      coverageUsed: false,
      corrected: false,
      error: null,
      answerExcerpt: 'The product has 12 units on hand.',
    },
    {
      coverageSelected: false,
      coverageFirst: false,
      coverageSucceeded: false,
      coverageUsed: false,
      corrected: true,
      error: null,
      answerExcerpt: 'I could not read that from your records just now.',
      answerClaimsInfiniteCover: false,
    },
    {
      coverageSelected: true,
      coverageFirst: false,
      coverageSucceeded: true,
      coverageUsed: true,
      corrected: false,
      error: null,
      answerExcerpt: 'This estimate reflects only recorded stock-out events (sales, usage, damage, or write-offs).',
    },
  ];

  const summary = summarizeStockCoverageRows(rows);
  assert.equal(summary.selectedAny, 3);
  assert.equal(summary.succeededAny, 3);
  assert.equal(summary.usedAny, 2);
  assert.equal(summary.selectedButUnused, 1);
  assert.equal(summary.selectedFirst, 1);
  assert.equal(summary.corrected, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.proxyCaveatAnswers, 2);
  assert.equal(summary.coverageUsedRateAny, 0.5);
  assert.equal(summary.selectionRateAny, 0.75);
});

it('★ an empty sample has null rates rather than a vacuous success', () => {
  const summary = summarizeStockCoverageRows([]);
  assert.equal(summary.questions, 0);
  assert.equal(summary.selectionRateAny, null);
  assert.equal(summary.coverageUsedRateAny, null);
});

it('★ a legacy artifact without finalizer metadata reports unknown, not unused', () => {
  const summary = summarizeStockCoverageRows([
    {
      coverageSelected: true,
      coverageFirst: false,
      answerExcerpt: 'The product has 12 units on hand.',
    },
  ]);
  assert.equal(summary.selectedAny, 1);
  assert.equal(summary.succeededAny, 0);
  assert.equal(summary.usedAny, 0);
  assert.equal(summary.selectedButUnused, 0);
  assert.equal(summary.coverageSucceededRateAny, null);
  assert.equal(summary.coverageUsedRateAny, null);
});