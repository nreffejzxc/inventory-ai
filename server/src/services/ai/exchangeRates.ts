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

type CachedRate = { quote: ExchangeRateQuote; cachedAt: number };

type NegativeCacheEntry = {
  failure: ExchangeRateFailure;
  retryAt: number;
  failures: number;
};

/** The default maximum age of a usable ECB reference date. */
export const EXCHANGE_RATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A verified quote is reused for this long; the rate date is still re-checked. */
export const EXCHANGE_RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** The first suppressed retry after a failure; doubles up to the cap. */
export const EXCHANGE_RATE_NEGATIVE_TTL_MS = 30 * 1000;
/** Bound a repeated outage without making recovery wait for a full day. */
export const EXCHANGE_RATE_BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Keys are bounded because this cache is process-local and caller-driven. */
export const EXCHANGE_RATE_MAX_NEGATIVE_ENTRIES = 256;

export type ExchangeRateAvailability = {
  /** Process-local since boot; not a cluster-wide counter. */
  status: 'unused' | 'available' | 'degraded' | 'unavailable';
  requests: number;
  cacheHits: number;
  negativeCacheHits: number;
  coalescedRequests: number;
  verified: number;
  sameCurrency: number;
  stale: number;
  unavailable: number;
  lastVerifiedAt: string | null;
  lastRateDate: string | null;
  lastFailureAt: string | null;
  lastFailure: ExchangeRateFailure | null;
};

export type ExchangeRateFailure =
  | 'timeout'
  | 'http'
  | 'malformed'
  | 'missing-rate'
  | 'stale'
  | 'pair-mismatch';

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';
const RATE_SOURCE = 'European Central Bank reference rates via Frankfurter';
const DEFAULT_TIMEOUT_MS = 4_000;

const defaultCache = new Map<string, CachedRate>();
const defaultNegativeCache = new Map<string, NegativeCacheEntry>();
const defaultInFlight = new Map<string, Promise<ExchangeRateQuote | null>>();

let monitoring = {
  requests: 0,
  cacheHits: 0,
  negativeCacheHits: 0,
  coalescedRequests: 0,
  verified: 0,
  sameCurrency: 0,
  stale: 0,
  unavailable: 0,
  lastVerifiedAt: null as string | null,
  lastRateDate: null as string | null,
  lastFailureAt: null as string | null,
  lastFailure: null as ExchangeRateFailure | null,
};

function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

/**
 * A reference date is usable only when it parses, is not in the future, and is
 * no older than the configured maximum. ECB does not publish on weekends or
 * public holidays, so the default allows a full week; it never allows an
 * arbitrarily old rate to be presented as current.
 */
function usableRateDate(rateDate: string, now: Date, maxAgeMs: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) return false;
  const parsed = Date.parse(`${rateDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  const age = now.getTime() - parsed;
  // One day of tolerance covers a server running ahead of UTC while the ECB
  // has already published the next business day elsewhere.
  if (age < -24 * 60 * 60 * 1000) return false;
  return age <= maxAgeMs;
}

function noteVerified(quote: ExchangeRateQuote, now: Date) {
  monitoring.verified += 1;
  monitoring.lastVerifiedAt = now.toISOString();
  monitoring.lastRateDate = quote.rateDate;
}

function noteFailure(reason: ExchangeRateFailure, now: Date, from: string, to: string, detail = '') {
  monitoring.unavailable += 1;
  if (reason === 'stale') monitoring.stale += 1;
  monitoring.lastFailureAt = now.toISOString();
  monitoring.lastFailure = reason;
  const suffix = detail ? ` (${detail})` : '';
  // A single structured line, no credentials and no full response body.
  console.warn(`[exchange-rates] ${from}->${to} unavailable: ${reason}${suffix}`);
}

/** A read-only snapshot for operational monitoring and tests. */
export function exchangeRateAvailability(): ExchangeRateAvailability {
  const hasRecentFailure =
    monitoring.lastFailureAt !== null &&
    (monitoring.lastVerifiedAt === null || monitoring.lastFailureAt > monitoring.lastVerifiedAt);
  return {
    status:
      monitoring.requests === 0 && monitoring.sameCurrency === 0
        ? 'unused'
        : hasRecentFailure
          ? monitoring.lastVerifiedAt === null
            ? 'unavailable'
            : 'degraded'
          : 'available',
    ...monitoring,
  };
}

/** Test-only reset; production code never calls this. */
export function resetExchangeRateState() {
  defaultCache.clear();
  defaultNegativeCache.clear();
  defaultInFlight.clear();
  monitoring = {
    requests: 0,
    cacheHits: 0,
    negativeCacheHits: 0,
    coalescedRequests: 0,
    verified: 0,
    sameCurrency: 0,
    stale: 0,
    unavailable: 0,
    lastVerifiedAt: null,
    lastRateDate: null,
    lastFailureAt: null,
    lastFailure: null,
  };
}

/** Record one failed pair and set the next permitted retry. */
function recordNegativeFailure(
  key: string,
  failure: ExchangeRateFailure,
  now: Date,
  negativeCache: Map<string, NegativeCacheEntry>,
) {
  const previous = negativeCache.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const multiplier = 2 ** Math.min(failures - 1, 8);
  const delay = Math.min(EXCHANGE_RATE_NEGATIVE_TTL_MS * multiplier, EXCHANGE_RATE_BACKOFF_MAX_MS);
  negativeCache.set(key, { failure, retryAt: now.getTime() + delay, failures });
  // The cache is bounded independently of the request path. Delete the oldest
  // insertion when a caller has supplied more pairs than the cap allows.
  while (negativeCache.size > EXCHANGE_RATE_MAX_NEGATIVE_ENTRIES) {
    const oldest = negativeCache.keys().next().value;
    if (oldest === undefined) break;
    negativeCache.delete(oldest);
  }
}

type FetchOutcome =
  | { quote: ExchangeRateQuote }
  | { failure: ExchangeRateFailure; detail?: string };

async function fetchQuote(
  from: string,
  to: string,
  {
    fetchImpl,
    timeoutMs,
    now,
    maxAgeMs,
  }: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    now: Date;
    maxAgeMs: number;
  },
): Promise<FetchOutcome> {
  const sourceUrl = `${FRANKFURTER_URL}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(sourceUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'AbortError';
    return { failure: timedOut ? 'timeout' : 'http' };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return { failure: 'http', detail: `status ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { failure: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') {
    return { failure: 'malformed' };
  }
  const record = payload as { base?: unknown; date?: unknown; rates?: unknown };
  if (record.base !== from) {
    return { failure: 'pair-mismatch' };
  }
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    return { failure: 'malformed' };
  }
  if (!usableRateDate(record.date, now, maxAgeMs)) {
    return { failure: 'stale', detail: `rate date ${record.date}` };
  }
  if (!record.rates || typeof record.rates !== 'object') {
    return { failure: 'missing-rate' };
  }
  const rate = (record.rates as Record<string, unknown>)[to];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return { failure: 'missing-rate' };
  }

  return {
    quote: {
      rate,
      from,
      to,
      rateDate: record.date,
      rateSource: RATE_SOURCE,
      sourceUrl,
    },
  };
}

/**
 * Fetch one verified cross-rate from the ECB's daily reference rates.
 *
 * Frankfurter is a keyless, read-only mirror of the ECB reference set, so no
 * secret has to live in the app and the answer can cite a date and source. The
 * rate is only ever used for a marketplace listing whose currency was actually
 * read from the listing; this function never chooses a currency.
 *
 * A verified quote is cached for six hours, but every cache hit re-validates
 * the ECB date against the maximum age. A stale or undated quote is discarded,
 * never served. Any failure — unsupported pair, timeout, malformed payload,
 * non-positive number, missing rate or stale date — returns null. Failures are
 * negatively cached with bounded exponential backoff, and concurrent callers
 * for one pair share a single provider request. There is deliberately no
 * fallback rate: an invented conversion is worse than saying no verified rate
 * was available.
 */
export async function fetchVerifiedExchangeRate(
  fromInput: string,
  toInput: string,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = new Date(),
    maxAgeMs = EXCHANGE_RATE_MAX_AGE_MS,
    cache = defaultCache,
    negativeCache = defaultNegativeCache,
    inFlight = defaultInFlight,
  }: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: Date;
    maxAgeMs?: number;
    cache?: Map<string, CachedRate>;
    negativeCache?: Map<string, NegativeCacheEntry>;
    inFlight?: Map<string, Promise<ExchangeRateQuote | null>>;
  } = {}
): Promise<ExchangeRateQuote | null> {
  const from = normaliseCurrencyCode(fromInput);
  const to = normaliseCurrencyCode(toInput);
  if (!from || !to) return null;
  if (from === to) {
    monitoring.sameCurrency += 1;
    return {
      rate: 1,
      from,
      to,
      rateDate: isoDay(now),
      rateSource: RATE_SOURCE,
      sourceUrl: '',
    };
  }

  monitoring.requests += 1;
  const key = `${from}:${to}`;
  const cached = cache.get(key);
  if (cached) {
    const cacheFresh = now.getTime() - cached.cachedAt <= EXCHANGE_RATE_CACHE_TTL_MS;
    const dateFresh = usableRateDate(cached.quote.rateDate, now, maxAgeMs);
    if (cacheFresh && dateFresh) {
      monitoring.cacheHits += 1;
      negativeCache.delete(key);
      noteVerified(cached.quote, now);
      return cached.quote;
    }
    cache.delete(key);
    // A stale cached quote is never served. Fall through and try a fresh
    // fetch; a failed fetch is then recorded as the current failure.
    if (!dateFresh) monitoring.stale += 1;
  }

  const blocked = negativeCache.get(key);
  if (blocked && now.getTime() < blocked.retryAt) {
    monitoring.negativeCacheHits += 1;
    return null;
  }

  // One request per pair at a time. A concurrent caller waits for the leader's
  // result and never launches a second provider request or records a second
  // failure for the same outage.
  const pending = inFlight.get(key);
  if (pending) {
    monitoring.coalescedRequests += 1;
    return pending;
  }

  const pendingRequest = (async () => {
    try {
      const outcome = await fetchQuote(from, to, { fetchImpl, timeoutMs, now, maxAgeMs });
      if ('failure' in outcome) {
        noteFailure(outcome.failure, now, from, to, outcome.detail);
        recordNegativeFailure(key, outcome.failure, now, negativeCache);
        return null;
      }
      negativeCache.delete(key);
      cache.set(key, { quote: outcome.quote, cachedAt: now.getTime() });
      noteVerified(outcome.quote, now);
      return outcome.quote;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pendingRequest);
  return pendingRequest;
}

export default { fetchVerifiedExchangeRate, exchangeRateAvailability };
