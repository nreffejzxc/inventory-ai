// AI-109 — hard stops for a production HTTP gate.
//
// WHY. A production gate must stop before the next request as soon as it sees a paid model,
// any nonzero/unknown cost, a depleted free allowance, an inventory shape change it did not
// cause, or a provider paid-usage delta. These tests pin each stop and the clean paths.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDatasetUnchanged,
  assertFreeAllowance,
  assertFreeZeroCost,
  assertPaidUsageUnchanged,
  assertRestored,
} from '../scripts/perf/productionGateGuards.mjs';

describe('AI-109 — production gate guards', () => {
  it('requires enough free allowance and refuses an unreadable allowance', () => {
    assert.equal(assertFreeAllowance({ status: 'OK', daily: { remaining: 936 } }, 25), 936);
    assert.throws(
      () => assertFreeAllowance({ status: 'OK', daily: { remaining: 24 } }, 25),
      /below the 25/,
    );
    assert.throws(() => assertFreeAllowance({ status: 'UNREADABLE' }, 25), /UNREADABLE/);
    assert.throws(() => assertFreeAllowance({ status: 'OK', daily: {} }, 25), /unknown/);
  });

  it('accepts only a free model with a known zero cost', () => {
    assert.equal(
      assertFreeZeroCost({ model: 'nvidia/nemotron-3.5-lightning:free', costUsd: 0 }),
      true,
    );
    assert.throws(
      () => assertFreeZeroCost({ model: 'openai/gpt-oss-20b', costUsd: 0 }),
      /non-free model/,
    );
    assert.throws(
      () => assertFreeZeroCost({ model: 'nvidia/nemotron-3.5-lightning:free', costUsd: 0.000001 }),
      /cost is \$0\.000001/,
    );
    assert.throws(
      () => assertFreeZeroCost({ model: 'nvidia/nemotron-3.5-lightning:free', costUsd: null }),
      /cost is unknown/,
    );
  });

  it('detects a product-row or quantity change, but accepts the same shape', () => {
    const before = { products: 10000, inventoryRows: 20006, totalQuantity: 2446801 };
    assert.equal(assertDatasetUnchanged(before, { ...before }), true);
    assert.throws(
      () => assertDatasetUnchanged(before, { ...before, totalQuantity: 2446401 }),
      /totalQuantity 2446801 -> 2446401/,
    );
    assert.throws(
      () => assertDatasetUnchanged(before, { ...before, inventoryRows: 20007 }),
      /inventoryRows/,
    );
    assert.throws(
      () => assertDatasetUnchanged(before, { ...before, products: 9999 }),
      /products/,
    );
  });

  it('verifies an exact inventory restore, including reserved quantity', () => {
    const snapshot = [
      { _id: 'a', quantity: 7, reservedQuantity: 1 },
      { _id: 'b', quantity: 0, reservedQuantity: 0 },
    ];
    assert.equal(
      assertRestored(snapshot, [
        { _id: 'a', quantity: 7, reservedQuantity: 1 },
        { _id: 'b', quantity: 0, reservedQuantity: 0 },
      ]),
      true,
    );
    assert.throws(
      () => assertRestored(snapshot, [{ _id: 'a', quantity: 7, reservedQuantity: 1 }]),
      /row count/,
    );
    assert.throws(
      () =>
        assertRestored(snapshot, [
          { _id: 'a', quantity: 8, reservedQuantity: 1 },
          { _id: 'b', quantity: 0, reservedQuantity: 0 },
        ]),
      /restore mismatch/,
    );
  });

  it('refuses a provider paid-usage delta', () => {
    assert.equal(assertPaidUsageUnchanged({ paidUsage: 12 }, { paidUsage: 12 }), true);
    assert.throws(
      () => assertPaidUsageUnchanged({ paidUsage: 12 }, { paidUsage: 13 }),
      /paid usage changed/,
    );
    assert.throws(
      () => assertPaidUsageUnchanged({ paidUsage: 12 }, {}),
      /unreadable/,
    );
  });
});
