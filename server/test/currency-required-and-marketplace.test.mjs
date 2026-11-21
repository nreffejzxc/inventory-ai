// Required product currency, legacy resolution and verified marketplace comparisons.
//
// The rule this suite protects is simple: a price without a currency never reaches
// the database through a create, a legacy row cannot be edited without a verified
// code, and the assistant only converts a marketplace price when the server fetched
// a dated ECB reference rate. A bare `$` is not enough to choose a currency.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { PRODUCT_CURRENCY_CODES } from '../src/constants/currencies.ts';
import { validateProduct } from '../src/utils/validate.ts';
import { executeTool } from '../src/services/ai/tools.ts';
import {
  EXCHANGE_RATE_BACKOFF_MAX_MS,
  EXCHANGE_RATE_MAX_AGE_MS,
  EXCHANGE_RATE_NEGATIVE_TTL_MS,
  exchangeRateAvailability,
  fetchVerifiedExchangeRate,
  resetExchangeRateState,
} from '../src/services/ai/exchangeRates.ts';
import {
  convertListings,
  marketplaceCountryOf,
  priceListingFromText,
} from '../src/services/ai/marketPrices.ts';
import Product from '../src/models/product.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import { productService } from '../src/services/product.service.ts';
import { productCurrencyAuditReport } from '../src/services/productCurrencyAudit.service.ts';
import {
  MAX_CURRENCY_RESOLUTION_ENTRIES,
  resolveProductCurrencies,
  unresolvedCurrencyCandidates,
  validateCurrencyResolutionEvidence,
} from '../src/services/productCurrencyResolution.service.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

// Read the client copy as text rather than importing a mobile TS module into the
// server programme (the two packages have different module settings). This still
// fails if the lists drift.
const MOBILE_CURRENCY_CODES = [
  ...readFileSync(new URL('../../mobile/lib/currencies.ts', import.meta.url), 'utf8').matchAll(/'([A-Z]{3})'/g),
].map((match) => match[1]);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

const subject = {
  id: 'p1',
  name: 'Keychron K8 Pro',
  brand: 'Keychron',
  sellingPrice: 6990,
  currency: 'PHP',
  unit: 'pc',
};

function listing(text, url = 'https://shopee.ph/Keychron-K8-Pro-i.1') {
  return priceListingFromText({
    subject,
    title: 'Keychron K8 Pro wireless mechanical keyboard',
    url,
    text,
    retrievedAt: '2026-11-20T00:00:00.000Z',
    priceSource: 'public-page',
  });
}

unitSuite('Currency contract — ISO 4217 list and request validation', () => {
  it('★ accepts only active ISO tender codes, not merely three letters', () => {
    assert.ok(PRODUCT_CURRENCY_CODES.includes('PHP'));
    assert.ok(PRODUCT_CURRENCY_CODES.includes('USD'));
    assert.ok(PRODUCT_CURRENCY_CODES.includes('GBP'));
    assert.ok(!PRODUCT_CURRENCY_CODES.includes('ABC'));
    assert.ok(!PRODUCT_CURRENCY_CODES.includes('XTS'));
    assert.deepEqual([...MOBILE_CURRENCY_CODES], [...PRODUCT_CURRENCY_CODES], 'client and server lists must match');
  });

  it('★ create requires a currency and normalises a valid lower-case code', () => {
    const missing = validateProduct({ name: 'Kettle' });
    assert.ok(missing.problems.some((problem) => problem.field === 'currency'));

    const invalid = validateProduct({ name: 'Kettle', currency: 'ABC' });
    assert.ok(invalid.problems.some((problem) => problem.field === 'currency'));

    const valid = validateProduct({ name: 'Kettle', currency: 'php' });
    assert.equal(valid.problems.length, 0);
    assert.equal(valid.currency, 'PHP');
  });

  it('★ PATCH cannot clear a currency, and may omit it for an existing row', () => {
    const omitted = validateProduct({ name: 'Kettle' }, { partial: true });
    assert.equal(omitted.problems.length, 0);
    assert.equal(omitted.currency, undefined);

    for (const value of ['', null, '   ']) {
      const cleared = validateProduct({ currency: value }, { partial: true });
      assert.ok(cleared.problems.some((problem) => problem.field === 'currency'), `clearing ${String(value)} must fail`);
    }
  });

  it('★ the list service refuses a raw price comparison without one recorded currency', async () => {
    await assert.rejects(
      productService.list('64f000000000000000000001', { sort: 'price_asc', skip: 0, limit: 1 }),
      (err) => err?.code === 'PRICE_CURRENCY_REQUIRED',
    );
    await assert.rejects(
      productService.list('64f000000000000000000001', {
        maxSellingPrice: 100,
        skip: 0,
        limit: 1,
      }),
      (err) => err?.code === 'PRICE_CURRENCY_REQUIRED',
    );
  });
});

unitSuite('Currency contract — marketplace country, match and conversion', () => {
  it('★ verifies the marketplace country and the listing currency from a real page', () => {
    const found = listing('Keychron K8 Pro wireless keyboard. ₱5,195.00');
    assert.ok(found);
    assert.equal(found.marketplaceCountry, 'PH');
    assert.equal(found.currency, 'PHP');
    assert.equal(found.originalPrice?.text, '₱5,195.00');
    assert.equal(found.matchEvidence.verified, true);
    assert.deepEqual(found.matchEvidence.modelTokensMatched, ['k8']);
    assert.equal(found.conversionStatus, 'same-currency');
  });

  it('★ a bare $ is resolved by a US marketplace, never assumed globally', () => {
    const us = listing('Keychron K8 Pro wireless keyboard. $74.99', 'https://www.amazon.com/dp/B0TEST');
    assert.ok(us);
    assert.equal(us.marketplaceCountry, 'US');
    assert.equal(us.currency, 'USD');
    assert.equal(us.conversionStatus, 'rate-unavailable');

    const unknown = listing('Keychron K8 Pro wireless keyboard. $74.99', 'https://example.com/k8');
    assert.ok(unknown);
    assert.equal(unknown.marketplaceCountry, null);
    assert.equal(unknown.currency, 'unknown');
    assert.equal(unknown.conversionStatus, 'currency-unverified');
  });

  it('★ rejects a page for a different model', () => {
    assert.equal(listing('Logitech MX Keys S wireless keyboard. ₱3,000.00'), null);
  });

  it('★ converts only with a dated, matching rate and keeps the original', async () => {
    const us = listing('Keychron K8 Pro wireless keyboard. $74.99', 'https://www.amazon.com/dp/B0TEST');
    assert.ok(us);
    const converted = await convertListings([us], [subject], async (from, to) => ({
      rate: 56.2,
      from,
      to,
      rateDate: '2026-11-19',
      rateSource: 'European Central Bank reference rates via Frankfurter',
      sourceUrl: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP',
    }));
    assert.equal(converted[0].conversionStatus, 'converted');
    assert.equal(converted[0].originalPrice?.currency, 'USD');
    assert.equal(converted[0].convertedPrice?.currency, 'PHP');
    assert.equal(converted[0].convertedPrice?.amount, 4214.44);
    assert.equal(converted[0].convertedPrice?.rateDate, '2026-11-19');

    const unavailable = await convertListings([us], [subject], async () => null);
    assert.equal(unavailable[0].conversionStatus, 'rate-unavailable');
    assert.equal(unavailable[0].convertedPrice, null);

    // A legacy row with a malformed stored code must never trigger a rate fetch.
    let fetched = false;
    const malformedTarget = await convertListings([us], [{ ...subject, currency: 'ABC' }], async () => {
      fetched = true;
      return null;
    });
    assert.equal(malformedTarget[0].conversionStatus, 'currency-unverified');
    assert.equal(fetched, false);

    assert.equal(marketplaceCountryOf('https://datablitz.com.ph/collections/keychrons'), 'PH');
    assert.equal(marketplaceCountryOf('https://shopee.com/Keychron'), 'SG');
  });

  it('fetches an ECB reference rate without a key and refuses a malformed one', async () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    resetExchangeRateState();
    const quote = await fetchVerifiedExchangeRate('USD', 'PHP', {
      now,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ base: 'USD', date: '2026-11-19', rates: { PHP: 56.2 } }),
      }),
    });
    assert.equal(quote?.rate, 56.2);
    assert.equal(quote?.rateDate, '2026-11-19');

    resetExchangeRateState();
    const malformed = await fetchVerifiedExchangeRate('USD', 'PHP', {
      now,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ base: 'USD', date: 'not-a-date', rates: {} }) }),
    });
    assert.equal(malformed, null);
  });
});

unitSuite('Exchange-rate cache — dated, bounded and never guessed', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const freshDate = '2026-11-19';
  const payload = (date = freshDate, rate = 58.5) => ({
    ok: true,
    status: 200,
    json: async () => ({ base: 'USD', date, rates: { PHP: rate } }),
  });

  it('★ reuses a verified quote and re-validates its ECB date', async () => {
    resetExchangeRateState();
    const cache = new Map();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return payload();
    };
    const first = await fetchVerifiedExchangeRate('USD', 'PHP', { fetchImpl, now, cache });
    const second = await fetchVerifiedExchangeRate('USD', 'PHP', { fetchImpl, now, cache });
    assert.equal(calls, 1, 'a six-hour cache hit must not call the network again');
    assert.equal(first?.rate, 58.5);
    assert.equal(second?.rateDate, freshDate);
    assert.ok(exchangeRateAvailability().cacheHits >= 1);
  });

  it('★ rejects a rate older than the maximum age and does not serve it from cache', async () => {
    resetExchangeRateState();
    const cache = new Map();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return payload('2026-11-01');
    };
    const quote = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl,
      now,
      cache,
      maxAgeMs: EXCHANGE_RATE_MAX_AGE_MS,
    });
    assert.equal(quote, null);
    assert.equal(cache.size, 0, 'a stale quote is never cached');
    assert.equal(exchangeRateAvailability().lastFailure, 'stale');

    const later = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl,
      now: new Date('2026-12-01T12:00:00.000Z'),
      cache,
    });
    assert.equal(later, null);
    assert.equal(calls, 2, 'a stale quote must be re-fetched, not resurrected');
  });

  it('★ expires the six-hour cache and re-fetches when the cached date has aged out', async () => {
    resetExchangeRateState();
    const cache = new Map();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return payload(freshDate, calls === 1 ? 58.5 : 59.1);
    };
    const first = await fetchVerifiedExchangeRate('USD', 'PHP', { fetchImpl, now, cache });
    assert.equal(first?.rate, 58.5);
    const afterTtl = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl,
      now: new Date('2026-11-20T19:00:00.000Z'),
      cache,
    });
    assert.equal(calls, 2, 'a quote older than six hours is re-fetched');
    assert.equal(afterTtl?.rate, 59.1);

    const agedOut = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl: async () => {
        calls += 1;
        return payload(freshDate);
      },
      now: new Date('2026-12-01T12:00:00.000Z'),
      cache,
    });
    assert.equal(agedOut, null, 'an aged cached date is discarded, never served');
    assert.equal(calls, 3);
    assert.ok(exchangeRateAvailability().stale >= 1);
  });

  it('★ rejects a missing rate, a malformed pair and a network failure without a fallback', async () => {
    resetExchangeRateState();
    const missing = await fetchVerifiedExchangeRate('USD', 'PHP', {
      now,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ base: 'USD', date: freshDate, rates: {} }) }),
    });
    assert.equal(missing, null);
    assert.equal(exchangeRateAvailability().lastFailure, 'missing-rate');

    resetExchangeRateState();
    const wrongPair = await fetchVerifiedExchangeRate('USD', 'PHP', {
      now,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ base: 'EUR', date: freshDate, rates: { PHP: 58.5 } }) }),
    });
    assert.equal(wrongPair, null);
    assert.equal(exchangeRateAvailability().lastFailure, 'pair-mismatch');

    resetExchangeRateState();
    const failed = await fetchVerifiedExchangeRate('USD', 'PHP', {
      now,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(failed, null);
    assert.equal(exchangeRateAvailability().status, 'unavailable');
  });

  it('★ an identity rate never calls the network', async () => {
    resetExchangeRateState();
    let calls = 0;
    const quote = await fetchVerifiedExchangeRate('php', 'PHP', {
      now,
      fetchImpl: async () => {
        calls += 1;
        return payload();
      },
    });
    assert.equal(quote?.rate, 1);
    assert.equal(calls, 0);
    assert.equal(exchangeRateAvailability().sameCurrency, 1);
  });

  it('★ coalesces concurrent identical lookups into one provider request', async () => {
    resetExchangeRateState();
    const cache = new Map();
    const negativeCache = new Map();
    const inFlight = new Map();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = async () => {
      calls += 1;
      await gate;
      return payload();
    };

    const requests = [1, 2, 3].map(() =>
      fetchVerifiedExchangeRate('USD', 'PHP', {
        fetchImpl,
        now,
        cache,
        negativeCache,
        inFlight,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'only the leader may call the provider');
    release();
    const quotes = await Promise.all(requests);
    assert.ok(quotes.every((quote) => quote?.rate === 58.5));
    assert.equal(calls, 1);
    assert.equal(exchangeRateAvailability().coalescedRequests, 2);
    assert.equal(exchangeRateAvailability().verified, 1);
  });

  it('★ negative-caches a failure briefly and never serves a guessed number', async () => {
    resetExchangeRateState();
    const cache = new Map();
    const negativeCache = new Map();
    const inFlight = new Map();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('provider down');
    };
    const first = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl,
      now,
      cache,
      negativeCache,
      inFlight,
    });
    const second = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl,
      now: new Date(now.getTime() + 1_000),
      cache,
      negativeCache,
      inFlight,
    });
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(calls, 1, 'a repeated lookup inside the negative window must not hit the provider');
    const availability = exchangeRateAvailability();
    assert.equal(availability.negativeCacheHits, 1);
    assert.equal(availability.unavailable, 1);
    assert.equal(availability.status, 'unavailable');
  });

  it('★ backs off exponentially, recovers, and clears the negative entry on success', async () => {
    resetExchangeRateState();
    const cache = new Map();
    const negativeCache = new Map();
    const inFlight = new Map();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls <= 2) throw new Error('provider down');
      return payload();
    };
    const options = (at) => ({ fetchImpl, now: at, cache, negativeCache, inFlight });

    assert.equal(await fetchVerifiedExchangeRate('USD', 'PHP', options(now)), null);
    assert.equal(
      await fetchVerifiedExchangeRate('USD', 'PHP', options(new Date(now.getTime() + EXCHANGE_RATE_NEGATIVE_TTL_MS))),
      null,
    );
    assert.equal(calls, 2, 'the first retry is allowed at the end of the first negative window');
    assert.equal(
      await fetchVerifiedExchangeRate(
        'USD',
        'PHP',
        options(new Date(now.getTime() + EXCHANGE_RATE_NEGATIVE_TTL_MS * 3 - 1_000)),
      ),
      null,
    );
    assert.equal(calls, 2, 'the second failure doubles the window');

    const recoveredAt = new Date(now.getTime() + EXCHANGE_RATE_NEGATIVE_TTL_MS * 3);
    const recovered = await fetchVerifiedExchangeRate('USD', 'PHP', options(recoveredAt));
    assert.equal(recovered?.rate, 58.5);
    assert.equal(calls, 3);
    assert.equal(negativeCache.size, 0);
    assert.ok(EXCHANGE_RATE_BACKOFF_MAX_MS >= EXCHANGE_RATE_NEGATIVE_TTL_MS);

    const cached = await fetchVerifiedExchangeRate(
      'USD',
      'PHP',
      options(new Date(recoveredAt.getTime() + 1_000)),
    );
    assert.equal(cached?.rate, 58.5);
    assert.equal(calls, 3, 'a recovered quote is served from the positive cache');
  });
});

dbSuite('Currency contract — API, legacy rows, audit and assistant output', dbOk, () => {
  let owner;

  before(async () => {
    owner = await registerOwner(api, tracker);
  });

  it('★ refuses create without a currency and refuses a non-ISO code', async () => {
    const missing = await api('POST', '/api/products', {
      token: owner.token,
      body: { name: uniqueName('No currency') },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.ok(missing.json.fields.some((field) => field.field === 'currency'));

    const invalid = await api('POST', '/api/products', {
      token: owner.token,
      body: { name: uniqueName('Bad currency'), currency: 'ABC' },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
    assert.ok(invalid.json.fields.some((field) => field.field === 'currency'));

    const valid = await api('POST', '/api/products', {
      token: owner.token,
      body: { name: uniqueName('Lower currency'), currency: 'php' },
    });
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    assert.equal(valid.json.currency, 'PHP');
  });

  it('★ blocks ordinary PATCH currency changes and resolves a legacy row through the audited correction endpoint', async () => {
    const name = uniqueName('Legacy product');
    const inserted = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      name,
      costPrice: 10,
      sellingPrice: 20,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const beforeCount = await Product.countDocuments({ businessId: owner.businessId });
    const report = await productCurrencyAuditReport({ businessId: owner.businessId });
    assert.ok(report.missingCurrency >= 1);
    assert.equal(report.samples[0].problem, 'MISSING_CURRENCY');
    assert.equal(await Product.countDocuments({ businessId: owner.businessId }), beforeCount, 'audit writes nothing');

    const blocked = await api('PATCH', `/api/products/${inserted.insertedId}`, {
      token: owner.token,
      body: { sellingPrice: 21 },
    });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'CURRENCY_REQUIRED');

    const ordinaryChange = await api('PATCH', `/api/products/${inserted.insertedId}`, {
      token: owner.token,
      body: { currency: 'PHP' },
    });
    assert.equal(ordinaryChange.status, 400, JSON.stringify(ordinaryChange.json));
    assert.equal(ordinaryChange.json.code, 'CURRENCY_CORRECTION_REQUIRED');

    const missingFields = await api('POST', `/api/products/${inserted.insertedId}/currency-correction`, {
      token: owner.token,
      body: { currency: 'PHP' },
    });
    assert.equal(missingFields.status, 400, JSON.stringify(missingFields.json));
    assert.ok(missingFields.json.fields.some((field) => field.field === 'reason'));
    assert.ok(missingFields.json.fields.some((field) => field.field === 'priceReconfirmed'));

    const unconfirmed = await api('POST', `/api/products/${inserted.insertedId}/currency-correction`, {
      token: owner.token,
      body: { currency: 'PHP', reason: 'Supplier invoice correction', priceReconfirmed: false },
    });
    assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.json));
    assert.ok(unconfirmed.json.fields.some((field) => field.field === 'priceReconfirmed'));

    const resolved = await api('POST', `/api/products/${inserted.insertedId}/currency-correction`, {
      token: owner.token,
      body: {
        currency: 'PHP',
        reason: 'Supplier invoice correction',
        priceReconfirmed: true,
      },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
    assert.equal(resolved.json.currency, 'PHP');
    assert.equal(resolved.json.sellingPrice, 20, 'the original monetary values were preserved');

    const correctionAudit = await AuditLog.findOne({
      businessId: owner.businessId,
      entityId: String(inserted.insertedId),
      action: 'PRODUCT_CURRENCY_CORRECTED',
    });
    assert.ok(correctionAudit, 'the correction must write a distinct audit event');
    assert.equal(correctionAudit.metadata.previousCurrency, null);
    assert.equal(correctionAudit.metadata.currency, 'PHP');
    assert.equal(correctionAudit.metadata.reason, 'Supplier invoice correction');
    assert.equal(correctionAudit.metadata.priceReconfirmed, true);

    const again = await api('POST', `/api/products/${inserted.insertedId}/currency-correction`, {
      token: owner.token,
      body: { currency: 'PHP', reason: 'Repeat attempt', priceReconfirmed: true },
    });
    assert.equal(again.status, 400, JSON.stringify(again.json));
    assert.equal(again.json.code, 'CURRENCY_CORRECTION_NOT_APPLICABLE');
  });

  it('★ an ordinary edit cannot use correction fields to change a valid code; the explicit endpoint records both codes', async () => {
    const name = uniqueName('Explicit correction');
    const created = await api('POST', '/api/products', {
      token: owner.token,
      body: { name, sellingPrice: 10, currency: 'USD' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;

    const ordinaryChange = await api('PATCH', `/api/products/${id}`, {
      token: owner.token,
      body: {
        currency: 'PHP',
        currencyCorrectionReason: 'Not the explicit endpoint',
        priceReconfirmed: true,
      },
    });
    assert.equal(ordinaryChange.status, 400, JSON.stringify(ordinaryChange.json));
    assert.equal(ordinaryChange.json.code, 'CURRENCY_CORRECTION_REQUIRED');
    assert.equal((await Product.findById(id)).currency, 'USD');

    const sameCurrency = await api('PATCH', `/api/products/${id}`, {
      token: owner.token,
      body: { name: `${name} renamed`, currency: 'USD' },
    });
    assert.equal(sameCurrency.status, 200, JSON.stringify(sameCurrency.json));
    assert.equal(sameCurrency.json.currency, 'USD');

    const corrected = await api('POST', `/api/products/${id}/currency-correction`, {
      token: owner.token,
      body: {
        currency: 'PHP',
        sellingPrice: 560,
        reason: 'Supplier pricing was quoted in PHP',
        priceReconfirmed: true,
      },
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
    assert.equal(corrected.json.currency, 'PHP');
    assert.equal(corrected.json.sellingPrice, 560);

    const audit = await AuditLog.findOne({
      businessId: owner.businessId,
      entityId: id,
      action: 'PRODUCT_CURRENCY_CORRECTED',
    });
    assert.ok(audit);
    assert.equal(audit.metadata.previousCurrency, 'USD');
    assert.equal(audit.metadata.currency, 'PHP');
    assert.equal(audit.metadata.reason, 'Supplier pricing was quoted in PHP');
    assert.equal(audit.metadata.priceReconfirmed, true);
    assert.ok(audit.metadata.updated.includes('sellingPrice'));

    const sameCorrection = await api('POST', `/api/products/${id}/currency-correction`, {
      token: owner.token,
      body: { currency: 'PHP', reason: 'Already PHP', priceReconfirmed: true },
    });
    assert.equal(sameCorrection.status, 400, JSON.stringify(sameCorrection.json));
    assert.equal(sameCorrection.json.code, 'CURRENCY_CORRECTION_NOT_APPLICABLE');
  });

  it('★ the correction endpoint is tenant-scoped', async () => {
    const otherBusinessId = new mongoose.Types.ObjectId();
    const foreign = await Product.collection.insertOne({
      businessId: otherBusinessId,
      name: uniqueName('Foreign currency row'),
      sellingPrice: 10,
      currency: 'USD',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await api('POST', `/api/products/${foreign.insertedId}/currency-correction`, {
      token: owner.token,
      body: { currency: 'PHP', reason: 'Cross-tenant attempt', priceReconfirmed: true },
    });
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal((await Product.findById(foreign.insertedId)).currency, 'USD');
  });

  it('★ a dry-run evidence file writes nothing; applying it resolves legacy rows once and audits them', async () => {
    const missingName = uniqueName('Bulk missing');
    const invalidName = uniqueName('Bulk invalid');
    const missing = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      name: missingName,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const invalid = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      name: invalidName,
      currency: 'ABC',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const paddedName = uniqueName('Bulk padded');
    const padded = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      name: paddedName,
      currency: 'php',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const evidence = {
      version: 1,
      businessId: owner.businessId,
      reviewedBy: 'Owner review',
      reviewedAt: '2026-11-20T10:00:00.000Z',
      source: 'Supplier invoice pack 2026-11-19',
      entries: [
        { productId: String(missing.insertedId), expectedName: missingName, currency: 'PHP', evidence: 'Invoice INV-100 line 1' },
        { productId: String(invalid.insertedId), expectedName: invalidName, currency: 'PHP', evidence: 'Invoice INV-100 line 2' },
        { productId: String(padded.insertedId), expectedName: paddedName, currency: 'PHP', evidence: 'Invoice INV-100 line 3' },
      ],
    };
    const validated = validateCurrencyResolutionEvidence(evidence);
    assert.equal(validated.ok, true, JSON.stringify(validated));

    const beforeAudit = await AuditLog.countDocuments({ businessId: owner.businessId, action: 'PRODUCT_UPDATED' });
    const dry = await resolveProductCurrencies({ evidence: validated.evidence, apply: false });
    assert.equal(dry.wouldResolve, 3);
    assert.equal(dry.resolved, 0);
    assert.equal((await Product.findById(missing.insertedId)).currency, undefined);
    assert.equal((await Product.findById(invalid.insertedId)).currency, 'ABC');
    assert.equal((await Product.findById(padded.insertedId)).currency, 'php');

    const applied = await resolveProductCurrencies({ evidence: validated.evidence, apply: true });
    assert.equal(applied.resolved, 3, JSON.stringify(applied));
    assert.equal(applied.failed, 0);
    assert.equal((await Product.findById(missing.insertedId)).currency, 'PHP');
    assert.equal((await Product.findById(invalid.insertedId)).currency, 'PHP');
    assert.equal((await Product.findById(padded.insertedId)).currency, 'PHP');
    assert.equal(
      await AuditLog.countDocuments({ businessId: owner.businessId, action: 'PRODUCT_UPDATED' }),
      beforeAudit + 3,
      'one audit row per actual currency change',
    );
    const audit = await AuditLog.findOne({ businessId: owner.businessId, entityId: String(missing.insertedId) });
    assert.equal(audit.metadata.reason, 'legacy-currency-resolution');
    assert.equal(audit.metadata.reviewedBy, evidence.reviewedBy);
    assert.deepEqual(audit.metadata.updated, ['currency']);

    const again = await resolveProductCurrencies({ evidence: validated.evidence, apply: true });
    assert.equal(again.alreadyResolved, 3);
    assert.equal(again.resolved, 0);
    assert.equal(
      await AuditLog.countDocuments({ businessId: owner.businessId, action: 'PRODUCT_UPDATED' }),
      beforeAudit + 3,
      'rerunning the same evidence is a no-op and writes no duplicate audit rows',
    );
  });

  it('★ bulk resolution refuses an existing different code, a cross-tenant id and a mismatched name', async () => {
    const name = uniqueName('Bulk conflict');
    const created = await api('POST', '/api/products', {
      token: owner.token,
      body: { name, currency: 'USD' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const crossTenant = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(),
      name: uniqueName('Other tenant legacy'),
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const mismatch = await Product.collection.insertOne({
      businessId: new mongoose.Types.ObjectId(owner.businessId),
      name: uniqueName('Bulk name mismatch'),
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const evidence = {
      version: 1,
      businessId: owner.businessId,
      reviewedBy: 'Owner review',
      reviewedAt: '2026-11-20T10:00:00.000Z',
      source: 'Supplier invoice pack 2026-11-19',
      entries: [
        { productId: created.json.id, expectedName: name, currency: 'PHP', evidence: 'Invoice A' },
        { productId: String(crossTenant.insertedId), currency: 'PHP', evidence: 'Invoice B' },
        { productId: String(mismatch.insertedId), expectedName: 'a different product', currency: 'PHP', evidence: 'Invoice C' },
      ],
    };
    const validated = validateCurrencyResolutionEvidence(evidence);
    assert.equal(validated.ok, true, JSON.stringify(validated));
    const report = await resolveProductCurrencies({ evidence: validated.evidence, apply: true });
    assert.equal(report.conflicts, 1);
    assert.equal(report.notFound, 1);
    assert.equal(report.nameMismatches, 1);
    assert.equal(report.resolved, 0);
    assert.equal((await Product.findById(created.json.id)).currency, 'USD', 'a valid different code is never overwritten');
    assert.equal((await Product.findById(crossTenant.insertedId)).currency, undefined, 'another tenant is untouched');
    assert.equal((await Product.findById(mismatch.insertedId)).currency, undefined, 'a name mismatch is untouched');

    const invalid = validateCurrencyResolutionEvidence({ ...evidence, reviewedBy: '', entries: [{ ...evidence.entries[0], currency: 'ABC' }] });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => error.includes('reviewedBy')));
    assert.ok(invalid.errors.some((error) => error.includes('currency')));
  });

  it('★ caps the review template at 5,000 rows and reports truncation', async () => {
    const capBusinessId = new mongoose.Types.ObjectId();
    const prefix = uniqueName('Cap candidates');
    const candidateNames = Array.from(
      { length: MAX_CURRENCY_RESOLUTION_ENTRIES + 1 },
      (_, index) => `${prefix}-${String(index).padStart(5, '0')}`,
    );
    const now = new Date();

    try {
      await Product.collection.insertMany(
        candidateNames.map((name) => ({
          businessId: capBusinessId,
          name,
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        })),
      );

      const result = await unresolvedCurrencyCandidates({ businessId: String(capBusinessId) });
      assert.equal(result.limit, MAX_CURRENCY_RESOLUTION_ENTRIES);
      assert.equal(result.items.length, MAX_CURRENCY_RESOLUTION_ENTRIES);
      assert.equal(result.truncated, true);
      assert.equal(result.items[0].name, candidateNames[0]);
      assert.equal(result.items.at(-1).name, candidateNames[MAX_CURRENCY_RESOLUTION_ENTRIES - 1]);
      assert.equal(
        result.items.some((row) => row.name === candidateNames[MAX_CURRENCY_RESOLUTION_ENTRIES]),
        false,
        'the extra probe row must not be included in the template',
      );
    } finally {
      await Product.deleteMany({ businessId: capBusinessId });
    }
  });

  it('★ the assistant sees the exact recorded selling price and currency, never internal cost', async () => {
    const name = uniqueName('AI priced product');
    const created = await api('POST', '/api/products', {
      token: owner.token,
      body: { name, costPrice: 125.5, sellingPrice: 199.99, currency: 'GBP' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const result = await executeTool(
      'findProducts',
      { keywords: name },
      { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const row = result.result.items.find((item) => item.id === created.json.id);
    assert.ok(row, JSON.stringify(result.result.items));
    assert.equal(row.sellingPrice, 199.99);
    assert.equal(row.currency, 'GBP');
    assert.ok(!('costPrice' in row), 'cost price is internal accounting data and must not enter the assistant payload');
  });
});
