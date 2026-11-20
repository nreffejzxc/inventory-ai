import { normaliseCurrencyCode } from '../../constants/currencies.ts';

export type ExchangeRateQuote = {
  /** Multiply an amount in `from` by this to get `to`. */
  rate: number;
  from: string;
  to: string;
  /** The ECB reference date the rate belongs to (`YYYY-MM-DD`). */
  rateDate: string;
  /** Human-readable provenance for a cited conversion. */
  rateSource: string;
  sourceUrl: string;
};

export type ExchangeRateFetcher = (
  from: string,
  to: string,
) => Promise<ExchangeRateQuote | null>;

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';
const RATE_SOURCE = 'European Central Bank reference rates via Frankfurter';
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Fetch one verified cross-rate from the ECB's daily reference rates.
 *
 * Frankfurter is a keyless, read-only mirror of the ECB reference set, so no
 * secret has to live in the app and the answer can cite a date and source. The
 * rate is only ever used for a marketplace listing whose currency was actually
 * read from the listing; this function never chooses a currency.
 *
 * Any failure — unsupported pair, timeout, malformed payload, non-positive
 * number — returns null. There is deliberately no fallback rate: an invented
 * conversion is worse than saying no verified rate was available.
 */
export async function fetchVerifiedExchangeRate(
  fromInput: string,
  toInput: string,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ExchangeRateQuote | null> {
  const from = normaliseCurrencyCode(fromInput);
  const to = normaliseCurrencyCode(toInput);
  if (!from || !to) return null;
  if (from === to) {
    return { rate: 1, from, to, rateDate: new Date().toISOString().slice(0, 10), rateSource: RATE_SOURCE, sourceUrl: '' };
  }

  const sourceUrl = `${FRANKFURTER_URL}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  let response: Response;
  try {
    response = await fetchImpl(sourceUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { base?: unknown; date?: unknown; rates?: unknown };
  if (record.base !== from || typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    return null;
  }
  if (!record.rates || typeof record.rates !== 'object') return null;
  const rate = (record.rates as Record<string, unknown>)[to];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;

  return {
    rate,
    from,
    to,
    rateDate: record.date,
    rateSource: RATE_SOURCE,
    sourceUrl,
  };
}

export default { fetchVerifiedExchangeRate };
