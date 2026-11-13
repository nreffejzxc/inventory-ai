// AI-108 — the absent-SKU checker recognises the denial the assistant actually writes.
//
// WHY. The 10k gate's `exists-absent` question was scored a failure twice while the answer was
// correct. On 2026-11-12 the answer was "No product with SKU SEEDSKU-999999 was found in your
// inventory."; the old denial regex only knew forms such as "not in our inventory" and
// "not found", so it reported `missing a denial`. This suite pins the observed wording, the
// 2026-11-10 wording, and the boundary that a negative STOCK sentence is not a denial.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { existenceCheck, normalise } from '../scripts/perf/answerCheckers.mjs';

describe('AI-108 — the absent-SKU existence checker', () => {
  it('accepts the wording the 2026-11-12 deployed gate produced', () => {
    assert.deepEqual(existenceCheck('No product with SKU SEEDSKU-999999 was found in your inventory.', false), {
      ok: true,
      reasons: [],
    });
  });

  it('accepts the 2026-11-10 wording and the recorded-catalogue form', () => {
    assert.equal(
      existenceCheck('No, the SKU SEEDSKU-999999 is not present in our inventory.', false).ok,
      true,
    );
    assert.equal(existenceCheck('That SKU is not recorded in the catalogue.', false).ok, true);
  });

  it('still refuses an answer that says nothing about existence', () => {
    const result = existenceCheck('I could not help with that request.', false);
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasons, ['missing a denial']);
  });

  it('does not read a negative stock sentence as a denial of existence', () => {
    assert.equal(
      existenceCheck('No product is out of stock; every product is in stock.', true).ok,
      true,
    );
  });

  it('rejects a denial when the product was supposed to exist', () => {
    const result = existenceCheck(
      'No product with SKU SEEDSKU-999999 was found in your inventory.',
      true,
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('answer denies existence'));
  });

  it('normalises the typography the model emits before checking', () => {
    assert.equal(normalise('**No** product\u2019s SKU was `found`.'), "No product's SKU was found.");
  });
});
