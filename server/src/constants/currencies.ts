/**
 * ISO 4217 currencies accepted for a product's cost and selling prices.
 *
 * This is the active legal-tender set. ISO 4217 also defines special units
 * (XAU/XAG/XDR, testing codes such as XTS, fund codes and next-day units); those
 * are deliberately excluded because a product price in a metal, a fund unit or
 * a test code is not a price a shop can charge. Keeping the list explicit means
 * `ABC` is refused even though it has three letters.
 *
 * The mobile form carries the same list in `mobile/lib/currencies.ts`; the
 * server remains authoritative, and the currency regression test compares the
 * two lists so they cannot drift silently.
 */
export const PRODUCT_CURRENCY_CODES = Object.freeze([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
  'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF',
  'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL',
  'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
  'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
  'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD',
  'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB',
  'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX',
  'USD', 'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD',
  'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
]);

const PRODUCT_CURRENCY_SET = new Set<string>(PRODUCT_CURRENCY_CODES);

/** True for an active tender code in the accepted ISO 4217 set. */
export function isProductCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_CURRENCY_SET.has(value.trim().toUpperCase());
}

/**
 * Normalise a user/API value to an accepted code, or null. This never guesses a
 * currency from a symbol, locale or price; it only trims and upper-cases what
 * the caller supplied.
 */
export function normaliseCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return PRODUCT_CURRENCY_SET.has(code) ? code : null;
}

export default {
  PRODUCT_CURRENCY_CODES,
  isProductCurrencyCode,
  normaliseCurrencyCode,
};
