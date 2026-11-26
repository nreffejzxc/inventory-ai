// A tenant teardown must be driven by the MODEL SET, not by whoever remembered
// to extend a list. `product_imports` and now `idempotency_records` were both
// found by inspection; this guard makes the next `businessId` model fail the
// suite until it is classified.
//
// The test is intentionally database-free: it reads the registered Mongoose
// schemas and the one shared teardown plan. A fake model proves the guard can
// fail, so an accidentally empty model list cannot make it pass for the wrong
// reason.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { models } from '../src/models/index.ts';
import { TENANT_TEARDOWN_PLAN } from '../src/services/tenantTeardown.service.ts';

const planByCollection = new Map(
  TENANT_TEARDOWN_PLAN.map((step) => [step.model.collection.collectionName, step]),
);

function businessModels(list = models) {
  return list.filter((model) => model.schema.path('businessId'));
}

function accountModels(list = models) {
  return list.filter(
    (model) => model.schema.path('userId') && !model.schema.path('businessId'),
  );
}

function unclassifiedBusiness(list, plan) {
  return list
    .filter((model) => plan.get(model.collection.collectionName)?.match !== 'business')
    .map((model) => model.collection.collectionName);
}

function unclassifiedAccount(list, plan) {
  return list
    .filter((model) => plan.get(model.collection.collectionName)?.match !== 'user')
    .map((model) => model.collection.collectionName);
}

describe('tenant teardown — schema-derived coverage', () => {
  it('★ every model with businessId is classified as a business step', () => {
    const unclassified = unclassifiedBusiness(businessModels(), planByCollection);
    assert.deepEqual(
      unclassified,
      [],
      `add these businessId collections to TENANT_DATA_COLLECTIONS (or exempt them explicitly): ${unclassified.join(', ')}`,
    );
    // The two collections this guard was written for must be present.
    assert.ok(planByCollection.has('product_imports'));
    assert.ok(planByCollection.has('idempotency_records'));
  });

  it('★ every user-scoped model with no businessId is classified as a user step', () => {
    const unclassified = unclassifiedAccount(accountModels(), planByCollection);
    assert.deepEqual(
      unclassified,
      [],
      `add these account-scoped collections to TENANT_TEARDOWN_PLAN with match "user": ${unclassified.join(', ')}`,
    );
    assert.deepEqual(
      accountModels().map((model) => model.collection.collectionName).sort(),
      ['password_reset_challenges', 'password_reset_tokens', 'sessions'],
    );
  });

  it('★ the guard fails for an unclassified future tenant model', () => {
    const future = {
      modelName: 'FutureTenantThing',
      schema: { path: (field) => (field === 'businessId' ? {} : undefined) },
      collection: { collectionName: 'future_tenant_things' },
    };
    assert.deepEqual(unclassifiedBusiness([future], planByCollection), [
      'future_tenant_things',
    ]);
    assert.equal(
      unclassifiedBusiness([future], planByCollection).length,
      1,
      'a future businessId model must not disappear into an empty plan',
    );
    const futureAccount = {
      ...future,
      schema: { path: (field) => (field === 'userId' ? {} : undefined) },
      collection: { collectionName: 'future_account_things' },
    };
    assert.deepEqual(unclassifiedAccount([futureAccount], planByCollection), [
      'future_account_things',
    ]);
  });
});
