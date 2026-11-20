import mongoose from 'mongoose';

import Product from '../models/product.model.ts';
import { PRODUCT_CURRENCY_CODES } from '../constants/currencies.ts';

type IdLike = string | mongoose.Types.ObjectId;

export type ProductCurrencyAuditReport = {
  generatedAt: Date;
  businessId: string | null;
  totalProducts: number;
  missingCurrency: number;
  invalidCurrency: number;
  validCurrency: number;
  currencies: Array<{ currency: string | null; count: number }>;
  samples: Array<{
    productId: string;
    name: string;
    sku: string | null;
    status: string;
    costPrice: number;
    sellingPrice: number;
    currency: string | null;
    problem: 'MISSING_CURRENCY' | 'INVALID_CURRENCY';
  }>;
};

const SAMPLE_LIMIT = 50;

function asObjectId(value: IdLike): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

/**
 * Read-only audit of products whose price currency is absent or not an exact,
 * accepted ISO 4217 code.
 *
 * It deliberately covers every status, not only ACTIVE products: an archived
 * row can be restored, and the assistant's refusal to guess applies to it the
 * moment it is active again. No value is inferred from the tenant, the price,
 * a marketplace or a locale; the repair is an explicit `PATCH /api/products/:id`
 * carrying a currency a human verified against the source.
 */
export async function productCurrencyAuditReport({
  businessId,
  now = new Date(),
}: {
  businessId?: IdLike | null;
  now?: Date;
} = {}): Promise<ProductCurrencyAuditReport> {
  const match: Record<string, unknown> = {};
  if (businessId) match.businessId = asObjectId(businessId);

  const invalidMatch = {
    ...match,
    $or: [
      { currency: { $exists: false } },
      { currency: null },
      { currency: '' },
      { currency: { $nin: PRODUCT_CURRENCY_CODES } },
    ],
  };

  const [totalProducts, currencyRows, samples] = await Promise.all([
    Product.countDocuments(match),
    Product.aggregate([
      { $match: match },
      { $group: { _id: '$currency', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]),
    Product.find(invalidMatch)
      .sort({ name: 1, _id: 1 })
      .limit(SAMPLE_LIMIT)
      .select('name sku status costPrice sellingPrice currency')
      .lean(),
  ]);

  const currencies = (currencyRows as Array<{ _id?: unknown; count?: unknown }>).map((row) => ({
    currency: typeof row._id === 'string' && row._id.trim() ? row._id : null,
    count: typeof row.count === 'number' ? row.count : 0,
  }));

  let missingCurrency = 0;
  let invalidCurrency = 0;
  for (const row of currencies) {
    if (row.currency === null) missingCurrency += row.count;
    else if (!PRODUCT_CURRENCY_CODES.includes(row.currency)) invalidCurrency += row.count;
  }

  return {
    generatedAt: now,
    businessId: businessId ? String(businessId) : null,
    totalProducts,
    missingCurrency,
    invalidCurrency,
    validCurrency: Math.max(0, totalProducts - missingCurrency - invalidCurrency),
    currencies,
    samples: (samples as Array<{
      _id: unknown;
      name?: string;
      sku?: string;
      status?: string;
      costPrice?: number;
      sellingPrice?: number;
      currency?: string;
    }>).map((row) => {
      const currency = typeof row.currency === 'string' && row.currency.trim() ? row.currency : null;
      return {
        productId: String(row._id),
        name: row.name ?? '',
        sku: row.sku ?? null,
        status: row.status ?? 'ACTIVE',
        costPrice: Number(row.costPrice) || 0,
        sellingPrice: Number(row.sellingPrice) || 0,
        currency,
        problem: currency === null ? 'MISSING_CURRENCY' : 'INVALID_CURRENCY',
      };
    }),
  };
}

export default { productCurrencyAuditReport };
