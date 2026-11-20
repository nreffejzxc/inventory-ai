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
import { fetchVerifiedExchangeRate } from '../src/services/ai/exchangeRates.ts';
import {
  convertListings,
  marketplaceCountryOf,
  priceListingFromText,
} from '../src/services/ai/marketPrices.ts';
import Product from '../src/models/product.model.ts';
import { productCurrencyAuditReport } from '../src/services/productCurrencyAudit.service.ts';

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
    const quote = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ base: 'USD', date: '2026-11-19', rates: { PHP: 56.2 } }),
      }),
    });
    assert.equal(quote?.rate, 56.2);
    assert.equal(quote?.rateDate, '2026-11-19');

    const malformed = await fetchVerifiedExchangeRate('USD', 'PHP', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ base: 'USD', date: 'not-a-date', rates: {} }) }),
    });
    assert.equal(malformed, null);
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

  it('★ audits a legacy missing currency and resolves it only through an explicit PATCH', async () => {
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

    const resolved = await api('PATCH', `/api/products/${inserted.insertedId}`, {
      token: owner.token,
      body: { currency: 'PHP' },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
    assert.equal(resolved.json.currency, 'PHP');
    assert.equal(resolved.json.sellingPrice, 20, 'the original monetary values were preserved');
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
