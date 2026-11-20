import mongoose from 'mongoose';

import Product from '../models/product.model.ts';

type IdLike = string | mongoose.Types.ObjectId;

export type PriceQualityReport = {
  generatedAt: Date;
  businessId: string | null;
  totalActiveProducts: number;
  pricedProducts: number;
  missingPrice: number;
  zeroPrice: number;
  missingCurrency: number;
  invalidCurrency: number;
  currencies: Array<{ currency: string | null; count: number }>;
  samples: Array<{
    productId: string;
    name: string;
    sku: string | null;
    sellingPrice: number;
    currency: string | null;
    problem: 'MISSING_PRICE' | 'ZERO_PRICE' | 'MISSING_CURRENCY' | 'INVALID_CURRENCY';
  }>;
};

const ISO_CURRENCY = /^[A-Z]{3}$/;
const SAMPLE_LIMIT = 25;

function asObjectId(value: IdLike): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

/**
 * Read-only price-data quality report for ACTIVE products.
 *
 * The assistant now refuses to rank across currencies, so the catalogue's own
 * price hygiene is part of answer correctness: a zero/default price is not
 * "free", a missing currency cannot join a numeric comparison, and a malformed
 * code is worse than an absent one because it looks comparable. This report
 * counts those conditions and samples the rows a human should fix; it never
 * writes, repairs or infers a currency.
 */
export async function priceQualityReport({
  businessId,
  now = new Date(),
}: {
  businessId?: IdLike | null;
  now?: Date;
} = {}): Promise<PriceQualityReport> {
  const match: Record<string, unknown> = { status: 'ACTIVE' };
  if (businessId) match.businessId = asObjectId(businessId);

  const [totalActiveProducts, missingPrice, zeroPrice, missingCurrency, currencyRows, samples] =
    await Promise.all([
      Product.countDocuments(match),
      Product.countDocuments({ ...match, $or: [{ sellingPrice: { $exists: false } }, { sellingPrice: null }] }),
      Product.countDocuments({ ...match, sellingPrice: 0 }),
      Product.countDocuments({
        ...match,
        $or: [{ currency: { $exists: false } }, { currency: null }, { currency: '' }],
      }),
      Product.aggregate([
        { $match: match },
        { $group: { _id: '$currency', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      Product.find({
        ...match,
        $or: [
          { sellingPrice: { $exists: false } },
          { sellingPrice: null },
          { sellingPrice: 0 },
          { currency: { $exists: false } },
          { currency: null },
          { currency: '' },
          {
            currency: { $nin: [null, ''] },
            $expr: { $not: { $regexMatch: { input: '$currency', regex: '^[A-Z]{3}$' } } },
          },
        ],
      })
        .sort({ name: 1, _id: 1 })
        .limit(SAMPLE_LIMIT)
        .select('name sku sellingPrice currency')
        .lean(),
    ]);

  const currencies = (currencyRows as Array<{ _id?: unknown; count?: unknown }>).map((row) => ({
    currency: typeof row._id === 'string' && row._id.trim() ? row._id : null,
    count: typeof row.count === 'number' ? row.count : 0,
  }));
  const invalidCurrency = currencies
    .filter((row) => row.currency !== null && !ISO_CURRENCY.test(row.currency))
    .reduce((sum, row) => sum + row.count, 0);

  return {
    generatedAt: now,
    businessId: businessId ? String(businessId) : null,
    totalActiveProducts,
    pricedProducts: Math.max(0, totalActiveProducts - missingPrice - zeroPrice),
    missingPrice,
    zeroPrice,
    missingCurrency,
    invalidCurrency,
    currencies,
    samples: (samples as Array<{
      _id: unknown;
      name?: string;
      sku?: string;
      sellingPrice?: number;
      currency?: string;
    }>).map((row) => {
      const priceMissing = row.sellingPrice == null;
      const currency = typeof row.currency === 'string' && row.currency.trim() ? row.currency : null;
      const problem = priceMissing
        ? 'MISSING_PRICE'
        : Number(row.sellingPrice) === 0
          ? 'ZERO_PRICE'
          : currency === null
            ? 'MISSING_CURRENCY'
            : 'INVALID_CURRENCY';
      return {
        productId: String(row._id),
        name: row.name ?? '',
        sku: row.sku ?? null,
        sellingPrice: Number(row.sellingPrice) || 0,
        currency,
        problem,
      };
    }),
  };
}
