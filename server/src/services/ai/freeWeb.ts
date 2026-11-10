/**
 * Keyless public-web access for the research tools.
 *
 * WHY THIS EXISTS
 * OpenRouter's web plugin is a paid tool: it costs about $0.007 per search even
 * when the chat model is a `:free` endpoint. That charge is not covered by the
 * free-model request allowance. Review research already had a keyless result-list
 * fallback; this module makes that fallback reusable and adds the missing direct
 * page fetch so price research can work with no search subscription at all.
 *
 * WHAT IT CONTACTS
 * - DuckDuckGo's public HTML endpoint (no key, no account)
 * - DuckDuckGo Lite as a second no-key result layout
 * - Bing's public HTML endpoint as a keyless fallback (AI-52)
 * - an optional operator-owned SearXNG instance through `AI_FREE_SEARCH_URL`
 * - public result pages, after URL validation, for exact visible price text
 *
 * There is deliberately no paid API, no API key, and no automatic paid fallback
 * in this module. A failed free search becomes a structured failure; it never
 * silently buys a result from another provider.
 *
 * SECURITY
 * Search-result URLs are attacker-influenced. Before a page is fetched, its URL
 * and every redirect target are checked for http(s), embedded credentials,
 * localhost/private/link-local addresses, and DNS answers in private ranges.
 * Responses are bounded in time and bytes. An operator can allow private URLs
 * only for a local test harness with `AI_FREE_WEB_ALLOW_PRIVATE_URLS=true`; that
 * flag is never set by the application.
 */

import { lookup } from 'node:dns/promises';

export interface FreeSearchSource {
  title: string;
  url: string;
  snippet?: string;
}

export type FreeSearchFailureReason = 'SEARCH_TIMEOUT' | 'SEARCH_UNAVAILABLE' | 'NO_SOURCES';

export interface FreeSearchResult {
  sources: FreeSearchSource[];
  reason?: FreeSearchFailureReason;
}

export type PublicPageFailureReason =
  | 'UNSAFE_URL'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_UNAVAILABLE'
  | 'PAGE_TOO_LARGE'
  | 'TOO_MANY_REDIRECTS';

export type PublicPageResult =
  | { ok: true; html: string; url: string }
  | { ok: false; reason: PublicPageFailureReason };

const DEFAULT_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const LITE_SEARCH_URL = 'https://lite.duckduckgo.com/lite/';
const BING_SEARCH_URL = 'https://www.bing.com/search';
/**
 * AI-52 — how long a search engine that answered with a block page is left alone.
 *
 * Measured on 2026-11-04: after a handful of research questions DuckDuckGo answered
 * `202` with its anomaly page for every query, and each query then spent four
 * attempts (two layouts, two user agents) reading a block page before reporting that
 * the web had nothing on the product — the opposite of the truth. A short memory per
 * engine keeps that block out of the next question's critical path, which is also the
 * polite thing to do to an engine that has just asked for a pause.
 */
const ENGINE_BLOCK_COOLDOWN_MS = 5 * 60_000;
/**
 * AI-52 — DuckDuckGo answers 202 with an anomaly page instead of a result list when it
 * throttles a client, and the page is a normal 2xx, so it used to parse as "zero
 * results". These markers are the page's own words for "this is not a search result".
 */
const DDG_BLOCK_MARKERS = ['anomaly-modal', 'anomaly.js', 'challenge-form', 'are you a robot'] as const;
/**
 * AI-53 — Bing's way of saying "this endpoint has nothing for that query".
 *
 * Measured 2026-11-04: the phrase also sits in the page's localisation JSON (`searchNoResult`)
 * of EVERY Bing answer, so a raw-HTML search retired Bing on its good pages too and the
 * whole ladder then reported "no sources" for products Bing was listing. Only visible text
 * counts, and a result list that survives it is still checked for relevance below.
 */
const BING_NO_RESULTS_MARKERS = ['There are no results for', 'no results for your search'] as const;
/**
 * AI-53 — words that carry no product identity. A junk batch is told apart from a real one
 * by whether ANY result shares a distinctive query word; these are dropped before counting
 * so `price` or `review` alone cannot crown an unrelated page as an answer.
 */
const QUERY_STOPWORDS = new Set([
  'about', 'best', 'brand', 'buy', 'can', 'cheap', 'compare', 'current', 'does', 'for', 'from',
  'good', 'how', 'latest', 'laptop', 'laptops', 'much', 'near', 'new', 'official', 'online',
  'price', 'prices', 'pricing', 'review', 'reviews', 'shop', 'spec', 'specs', 'store', 'the',
  'update', 'updates', 'what', 'where', 'with', 'worth',
]);

/**
 * AI-53 — whether a Bing answer says it found nothing. The phrase also appears inside the
 * localisation JSON of every Bing page, so only visible text counts, and a page that also
 * counts its hits ("148 results") did find them.
 */
export function bingStatesNoResults(html: string): boolean {
  const visible = visiblePageText(html);
  if (!BING_NO_RESULTS_MARKERS.some((marker) => visible.includes(marker.toLowerCase()))) return false;
  return !/(?:^|\s)\d[\d,]*\s+results/i.test(visible);
}

/** Visible text of a search page, for checks that must ignore scripts and styling. */
function visiblePageText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Identifiable words in a query: long enough, not purely numeric, not generic. */
function queryTerms(query: string) {
  const terms = new Set<string>();
  for (const token of query.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? []) {
    const word = token.replace(/[.+-]+$/, '');
    if (word.length < 3 || /^\d+$/.test(word) || QUERY_STOPWORDS.has(word)) continue;
    terms.add(word);
  }
  return [...terms];
}

/**
 * Keep the results that at least name something from the question, in that order.
 *
 * An engine with nothing for a query does not say so: it serves another query's page
 * (measured 2026-11-04: a Redragon query returned `outlook.com` sign-in hosts, a movie
 * database and Zhihu threads). Sending those to the caller costs a fetch each and ends as
 * "nothing found" anyway, so a batch where NO result mentions any distinctive query word
 * counts as this attempt failing and the next engine gets the query. A batch with at least
 * one matching result is kept whole and only reordered, because a real review page often
 * answers a question without repeating its words.
 */
function orderByQueryMatch(sources: FreeSearchSource[], terms: string[]): { sources: FreeSearchSource[]; junk: boolean } {
  if (terms.length === 0) return { sources, junk: false };
  const matches = (source: FreeSearchSource) => {
    const haystack = `${source.title} ${source.snippet ?? ''} ${source.url}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  };
  const relevant = sources.filter(matches);
  if (relevant.length === 0) return { sources: [], junk: true };
  const rest = sources.filter((source) => !relevant.includes(source));
  return { sources: [...relevant, ...rest], junk: false };
}
/**
 * One engine request, not the whole search.
 *
 * The old 9 s ceiling was paid by EVERY attempt in a sequential ladder: four
 * DuckDuckGo layouts plus Bing could spend ~45 s on one query before the caller
 * saw a result. Engines that answer at all answer in 1–3 s, so 6 s keeps slow
 * pages while letting the caller's own budget decide how many engines to try.
 */
const SEARCH_TIMEOUT_MS = 6_000;
/** The whole search: two engines in parallel, then at most one fallback. */
const SEARCH_TOTAL_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 9_000;
/**
 * Repeated product questions are common (the same model checked twice, a follow-up
 * about the same item). A short successful-result cache removes the fetch and the
 * throttle risk from the second question; it is keyed by the exact query and limit,
 * holds nothing but public result titles/snippets/URLs, and is never logged.
 */
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, { expiresAt: number; sources: FreeSearchSource[] }>();

function cachedSearch(key: string): FreeSearchSource[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  return hit.sources;
}

function rememberSearch(key: string, sources: FreeSearchSource[]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, sources });
}
const MAX_SEARCH_BYTES = 2_000_000;
/**
 * AI-52 — a page is read up to this many bytes, not refused above it.
 *
 * Measured on the RK61 price question (2026-11-04): both PH retailers that stock it
 * serve ~2 MB Shopify storefronts, and the old 1.5 MB ceiling turned every one of them
 * into `PAGE_TOO_LARGE`, so a product with real listings reported no price at all. The
 * product name, JSON-LD and the price are all near the top of such a page, so the
 * bounded prefix is worth reading; the cap below still bounds time and memory.
 */
const MAX_PAGE_BYTES = 3_500_000;
/**
 * The ceiling a page is REFUSED above, as opposed to read up to. A declared length past
 * this is not a product page but a download, and it never reaches the reader.
 */
const MAX_HARD_BYTES = 8_000_000;
const MAX_REDIRECTS = 3;
const MAX_SOURCE_TITLE_CHARS = 180;
const MAX_SOURCE_SNIPPET_CHARS = 320;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
] as const;

/**
 * Named entities that survive into a model prompt as literal `&ndash;` text if
 * they are not decoded. Search pages and shop titles use these constantly, and a
 * title the assistant quotes must read as a product name, not as markup.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  trade: '™',
  reg: '®',
  copy: '©',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  peso: '₱',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  shy: '',
  zwnj: '',
  zwj: '',
};

function decodeOnce(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key] as string;
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Decode HTML entities, including the double-escaped form (`&amp;ndash;`) that
 * search engines produce when a shop title already contains an entity. Two passes
 * are enough for that; a third would start rewriting user text that legitimately
 * contains `&amp;`.
 */
export function decodeHtmlEntities(value: string) {
  const once = decodeOnce(value);
  return /&(?:#x?[0-9a-f]+|[a-z][a-z0-9]*);/i.test(once) && once !== value ? decodeOnce(once) : once;
}

function decodeEntities(value: string) {
  return decodeHtmlEntities(value);
}

export function cleanSearchText(value: string) {
  return decodeEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sourceFromUrl(
  rawUrl: string,
  rawTitle: string,
  rawSnippet: string,
  base = 'https://html.duckduckgo.com',
): FreeSearchSource | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) {
    const target = parsed.searchParams.get('uddg');
    if (!target) return null;
    try {
      parsed = new URL(target);
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) return null;
  if (process.env.AI_FREE_WEB_ALLOW_PRIVATE_URLS !== 'true' && isBlockedHostname(parsed.hostname)) {
    return null;
  }
  parsed.hash = '';
  const title = clip(cleanSearchText(rawTitle), MAX_SOURCE_TITLE_CHARS);
  if (!title) return null;
  const snippet = clip(cleanSearchText(rawSnippet), MAX_SOURCE_SNIPPET_CHARS);
  return { title, url: parsed.toString(), ...(snippet ? { snippet } : {}) };
}

/** Parse the classic DuckDuckGo HTML result layout. */
export function parseDuckDuckGoResults(html: string, limit = 3): FreeSearchSource[] {
  const sources: FreeSearchSource[] = [];
  const seen = new Set<string>();
  const link = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = link.exec(html))) {
    const afterLink = html.slice(link.lastIndex, link.lastIndex + 2500);
    const snippetMatch =
      /<(?:a|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(
        afterLink,
      );
    const source = sourceFromUrl(
      (match[1] ?? '').replace(/&amp;/g, '&'),
      match[2] ?? '',
      snippetMatch?.[1] ?? '',
    );
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/** Parse the smaller DuckDuckGo Lite layout, used when the HTML view is challenged. */
export function parseDuckDuckGoLiteResults(html: string, limit = 3): FreeSearchSource[] {
  const sources: FreeSearchSource[] = [];
  const seen = new Set<string>();
  const link =
    /<a\b[^>]*href="([^"]+)"[^>]*class=['"][^'"]*\bresult-link\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = link.exec(html))) {
    const afterLink = html.slice(link.lastIndex, link.lastIndex + 2500);
    const snippetMatch = /<td\b[^>]*class=['"][^'"]*\bresult-snippet\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i.exec(
      afterLink,
    );
    const source = sourceFromUrl(
      (match[1] ?? '').replace(/&amp;/g, '&'),
      match[2] ?? '',
      snippetMatch?.[1] ?? '',
      'https://lite.duckduckgo.com',
    );
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/** Parse a self-hosted SearXNG JSON response, which requires no API key. */
export function parseSearxResults(payload: unknown, limit = 3): FreeSearchSource[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const sources: FreeSearchSource[] = [];
  const seen = new Set<string>();
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { url?: unknown; title?: unknown; content?: unknown };
    if (typeof row.url !== 'string') continue;
    const source = sourceFromUrl(
      row.url,
      typeof row.title === 'string' ? row.title : '',
      typeof row.content === 'string' ? row.content : '',
    );
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

function isBlockedHostname(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string) {
  const value = address.trim().toLowerCase();
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  if (value.startsWith('::ffff:')) {
    return isBlockedHostname(value.slice('::ffff:'.length));
  }
  return isBlockedHostname(value);
}

async function urlProblem(url: URL): Promise<PublicPageFailureReason | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'UNSAFE_URL';
  if (url.username || url.password) return 'UNSAFE_URL';
  if (process.env.AI_FREE_WEB_ALLOW_PRIVATE_URLS === 'true') return null;
  if (isBlockedHostname(url.hostname)) return 'UNSAFE_URL';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return isPrivateAddress(host) ? 'UNSAFE_URL' : null;
  }
  try {
    const answers = await lookup(host, { all: true });
    if (answers.length === 0 || answers.some((answer) => isPrivateAddress(answer.address))) {
      return 'UNSAFE_URL';
    }
  } catch {
    return 'UNSAFE_URL';
  }
  return null;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string } | { reason: 'PAGE_TOO_LARGE' | 'SEARCH_UNAVAILABLE' }> {
  const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > MAX_HARD_BYTES) return { reason: 'PAGE_TOO_LARGE' };
  const reader = response.body?.getReader();
  if (!reader) return { reason: 'SEARCH_UNAVAILABLE' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // AI-52 — stop READING at the budget and keep the prefix (see MAX_PAGE_BYTES):
      // the evidence a price or a title needs sits at the top of the document, and
      // refusing the whole page was the reason a 2 MB storefront looked like no
      // evidence at all. A page above the hard ceiling is still refused.
      if (total > maxBytes) {
        chunks.push(value);
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    return { reason: 'SEARCH_UNAVAILABLE' };
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))) };
}

/**
 * AI-52 — which engines have recently asked this client to stop.
 *
 * Keyed by engine name, not by query: a throttle covers every query, and the point of
 * the memory is to stop paying for a block page on each one.
 */
/**
 * AI-53 — keyless search endpoints throttle a burst, not a question.
 *
 * Research asks about up to three products in parallel and each group retries; measured
 * 2026-11-04, that burst was answered with anomaly pages while the same queries a few
 * seconds apart were answered normally. Spacing the outbound engine requests turns the
 * burst into a queue, which costs a few hundred milliseconds and keeps the engine
 * answering.
 */
const SEARCH_SPACING_MS = 350;
let searchGate: Promise<void> = Promise.resolve();

async function searchSlot(): Promise<void> {
  const wait = searchGate;
  searchGate = wait.then(() => new Promise<void>((resolve) => setTimeout(resolve, SEARCH_SPACING_MS)));
  await wait;
}

const engineBlockedUntil = new Map<string, number>();
/**
 * AI-53 — consecutive refusals per endpoint. One anomaly page is noise: the same host
 * answered `202` and then `200` within a minute during measurement (2026-11-04), so a
 * single refusal must not retire an endpoint for five minutes. Two in a row is a pattern.
 */
const engineStrikes = new Map<string, number>();

function isEngineBlocked(engine: string): boolean {
  const until = engineBlockedUntil.get(engine) ?? 0;
  if (until > Date.now()) return true;
  if (until) engineBlockedUntil.delete(engine);
  return false;
}

function noteEngineBlock(engine: string, detail: string): void {
  if (isEngineBlocked(engine)) return;
  const strikes = (engineStrikes.get(engine) ?? 0) + 1;
  engineStrikes.set(engine, strikes);
  if (strikes < 2) return;
  engineStrikes.delete(engine);
  engineBlockedUntil.set(engine, Date.now() + ENGINE_BLOCK_COOLDOWN_MS);
  console.warn(
    `AI web research ${engine} refused the search twice in a row (${detail}) — using the other keyless engine` +
      ` and skipping ${engine} for ${Math.round(ENGINE_BLOCK_COOLDOWN_MS / 60_000)} min`,
  );
}

function clearEngineStrikes(engine: string): void {
  engineStrikes.delete(engine);
}

/** A cancellation that must not be mistaken for an ordinary search timeout. */
function abortError(): Error {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** The operation's own timeout, plus the caller's cancellation if one was given. */
function boundedBy(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}

async function fetchSearchPage(
  endpoint: URL,
  userAgent: string,
  engine: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ html: string } | { reason: FreeSearchFailureReason; blocked?: boolean }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': userAgent,
      },
      redirect: 'follow',
      signal: boundedBy(timeoutMs, signal),
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const name = (error as { name?: unknown } | null)?.name;
    return { reason: name === 'TimeoutError' || name === 'AbortError' ? 'SEARCH_TIMEOUT' : 'SEARCH_UNAVAILABLE' };
  }
  // AI-52 — 202 is the shape of a throttle, not of a result list, and it is `ok`.
  const throttled = response.status === 202 || response.status === 429;
  if (!response.ok || throttled) return { reason: 'SEARCH_UNAVAILABLE', blocked: true };
  const body = await readBoundedText(response, MAX_SEARCH_BYTES);
  throwIfAborted(signal);
  if (!('text' in body)) return { reason: 'SEARCH_UNAVAILABLE' };
  const lowered = body.text.toLowerCase();
  if (engine === 'duckduckgo' && DDG_BLOCK_MARKERS.some((marker) => lowered.includes(marker))) {
    return { reason: 'SEARCH_UNAVAILABLE', blocked: true };
  }
  return { html: body.text };
}

type SearchEngine = 'duckduckgo' | 'bing';

interface SearchAttempt {
  url: string;
  userAgent: string;
  lite: boolean;
  engine: SearchEngine;
  /**
   * AI-53 — what the cooldown memory keys on. It is the engine AND its layout, because
   * DuckDuckGo throttles one endpoint and not the other: measured 2026-11-04, the HTML
   * endpoint answered `202` with its anomaly page on every query while Lite answered
   * `200` with a normal result list a second later. Keying both on `duckduckgo` meant the
   * first 202 retired the working endpoint too, and every question fell through to Bing.
   */
  engineKey: string;
}

export function duckDuckGoAttempts(base: string): SearchAttempt[] {
  // AI-53 — Lite is tried first: it is the layout that still answers when the main one
  // is challenged, and it returns the same titles, snippets and targets.
  return [
    { url: LITE_SEARCH_URL, userAgent: USER_AGENTS[0], lite: true, engine: 'duckduckgo', engineKey: 'duckduckgo-lite' },
    { url: base, userAgent: USER_AGENTS[0], lite: false, engine: 'duckduckgo', engineKey: 'duckduckgo-html' },
    { url: LITE_SEARCH_URL, userAgent: USER_AGENTS[1], lite: true, engine: 'duckduckgo', engineKey: 'duckduckgo-lite' },
    { url: base, userAgent: USER_AGENTS[1], lite: false, engine: 'duckduckgo', engineKey: 'duckduckgo-html' },
  ];
}

/**
 * AI-52 — Bing's keyless HTML results, decoded.
 *
 * Bing is the fallback because it is the one public engine that still answered while
 * DuckDuckGo throttled this host (measured 2026-11-04), and it needs no key, which the
 * no-paid-services rule requires. Its outbound links are wrappers around the real
 * destination (`/ck/a?…&u=a1<base64url>`), so the target has to be decoded before the
 * same URL safety checks run; an undecodable wrapper is dropped rather than fetched.
 */
function decodeBingTarget(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'https://www.bing.com');
  } catch {
    return '';
  }
  if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return parsed.toString();
  const payload = parsed.searchParams.get('u') ?? '';
  if (!payload.startsWith('a1')) return '';
  try {
    const decoded = Buffer.from(payload.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

export function parseBingResults(html: string, limit = 3): FreeSearchSource[] {
  const sources: FreeSearchSource[] = [];
  const seen = new Set<string>();
  const item = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = item.exec(html))) {
    const block = match[1] ?? '';
    const link = /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const target = decodeBingTarget(decodeHtmlEntities((link[1] ?? '').replace(/&amp;/g, '&')));
    if (!target) continue;
    const rawSnippet =
      /<p\b[^>]*class="[^"]*\bb_lineclamp\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
      /<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
      '';
    // The date badge sits inside the caption and is not part of what the page says
    // about the product, so it is removed BEFORE the text is collapsed.
    const source = sourceFromUrl(
      target,
      link[2] ?? '',
      rawSnippet.replace(/<span\b[^>]*\bnews_dt\b[^>]*>[\s\S]*?<\/span>/gi, ' '),
      'https://www.bing.com',
    );
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Search the free web. SearXNG is preferred only when the operator configured
 * it; DuckDuckGo is the zero-configuration default. No API key is read here.
 */
export async function searchFreeWeb(
  query: string,
  {
    limit = 3,
    signal,
    timeoutMs = SEARCH_TOTAL_TIMEOUT_MS,
  }: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FreeSearchResult> {
  throwIfAborted(signal);
  const cleanQuery = query.replace(/\s+/g, ' ').trim();
  if (!cleanQuery) return { sources: [], reason: 'NO_SOURCES' };
  const wanted = Math.max(1, Math.min(limit, 10));
  const failures: FreeSearchFailureReason[] = [];
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  // Custom endpoints are a test harness or an operator's own engine: answer freshness
  // matters more there than the milliseconds a cache saves, and a cached stub answer
  // would make a resilience test prove the wrong thing.
  const configuredForCache = Boolean(
    (process.env.AI_FREE_SEARCH_URL || '').trim() || (process.env.AI_WEB_SEARCH_URL || '').trim(),
  );
  const cacheable = !configuredForCache;
  const cacheKey = `${wanted}\u0000${cleanQuery.toLowerCase()}`;
  if (cacheable) {
    const cached = cachedSearch(cacheKey);
    if (cached) return { sources: cached };
  }
  const success = (sources: FreeSearchSource[]): FreeSearchResult => {
    if (cacheable) rememberSearch(cacheKey, sources);
    return { sources };
  };

  const searxBase = (process.env.AI_FREE_SEARCH_URL || '').trim();
  if (searxBase) {
    try {
      const endpoint = new URL(searxBase);
      endpoint.searchParams.set('q', cleanQuery);
      endpoint.searchParams.set('format', 'json');
      const response = await fetch(endpoint, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENTS[1] },
        redirect: 'follow',
        signal: boundedBy(SEARCH_TIMEOUT_MS, signal),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        const sources = parseSearxResults(payload, wanted);
        if (sources.length > 0) return success(sources);
        failures.push('NO_SOURCES');
      } else {
        failures.push('SEARCH_UNAVAILABLE');
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const name = (error as { name?: unknown } | null)?.name;
      failures.push(name === 'TimeoutError' || name === 'AbortError' ? 'SEARCH_TIMEOUT' : 'SEARCH_UNAVAILABLE');
    }
  }

  const configured = (process.env.AI_WEB_SEARCH_URL || '').trim();
  let base = configured || DEFAULT_SEARCH_URL;
  let custom = Boolean(configured);
  try {
    const parsed = new URL(base);
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) custom = false;
    base = parsed.toString();
  } catch {
    failures.push('SEARCH_UNAVAILABLE');
    base = DEFAULT_SEARCH_URL;
    custom = false;
  }

  const attempts: SearchAttempt[] = custom
    ? [{ url: base, userAgent: USER_AGENTS[0], lite: false, engine: 'duckduckgo', engineKey: 'custom' }]
    : duckDuckGoAttempts(base);
  // AI-52 — an engine that has just throttled this client is skipped, so the question
  // reaches the engine that is still answering instead of reading a block page four
  // times. The fallback keeps research working without a key or a paid search.
  const fallbackAttempts: SearchAttempt[] = custom
    ? []
    : [{ url: BING_SEARCH_URL, userAgent: USER_AGENTS[0], lite: false, engine: 'bing', engineKey: 'bing' }];

  /** One pass over the ladder; returns sources when an attempt produced a result list. */
  const runAttempts = async (
    list: SearchAttempt[],
    attemptTimeoutMs = SEARCH_TIMEOUT_MS,
  ): Promise<FreeSearchSource[] | null> => {
    for (const attempt of list) {
      throwIfAborted(signal);
      const left = remainingMs();
      if (left <= 0) {
        failures.push('SEARCH_TIMEOUT');
        break;
      }
      if (isEngineBlocked(attempt.engineKey)) {
        failures.push('SEARCH_UNAVAILABLE');
        continue;
      }
      let endpoint: URL;
      try {
        endpoint = new URL(attempt.url);
        endpoint.searchParams.set('q', cleanQuery);
        if (attempt.engine === 'duckduckgo') endpoint.searchParams.set('kl', 'ph-en');
      } catch {
        failures.push('SEARCH_UNAVAILABLE');
        continue;
      }
      await searchSlot();
      throwIfAborted(signal);
      const page = await fetchSearchPage(
        endpoint,
        attempt.userAgent,
        attempt.engine,
        Math.min(attemptTimeoutMs, remainingMs() || 1),
        signal,
      );
      if (!('html' in page)) {
        if (page.blocked) noteEngineBlock(attempt.engineKey, 'throttled');
        else clearEngineStrikes(attempt.engineKey);
        failures.push(page.reason);
        continue;
      }
      clearEngineStrikes(attempt.engineKey);
      const sources =
        attempt.engine === 'bing'
          ? parseBingResults(page.html, wanted)
          : attempt.lite
            ? parseDuckDuckGoLiteResults(page.html, wanted)
            : parseDuckDuckGoResults(page.html, wanted);
      // AI-53 — Bing's keyless endpoint answers `200` with "There are no results for …"
      // followed by unrelated `b_algo` items (measured 2026-11-04: a Redragon keyboard
      // query returned Vietnamese forum threads and Xvideos pages). Those items are not
      // results for the question, so the page counts as no evidence and the caller's own
      // anchored retry decides what to do next.
      if (attempt.engine === 'bing' && bingStatesNoResults(page.html)) {
        failures.push('NO_SOURCES');
        continue;
      }
      const ordered = orderByQueryMatch(sources, queryTerms(cleanQuery));
      if (ordered.junk) {
        failures.push('NO_SOURCES');
        continue;
      }
      if (ordered.sources.length > 0) return ordered.sources;
      failures.push('NO_SOURCES');
    }
    return null;
  };

  // The two keyless engines are asked at the same time. Sequentially they were four
  // DuckDuckGo layouts plus Bing, each with its own timeout; in parallel the first pass
  // costs one timeout at most, and a throttled DuckDuckGo no longer delays Bing.
  // The search-slot gate still spaces their starts, so this does not become a burst.
  let firstPass: FreeSearchSource[] | null = null;
  if (custom || fallbackAttempts.length === 0) {
    firstPass = await runAttempts(attempts);
  } else {
    const primary = attempts[0];
    if (primary) {
      const [duck, bing] = await Promise.all([
        runAttempts([primary]),
        runAttempts([...fallbackAttempts]),
      ]);
      firstPass = duck ?? bing;
    }
  }
  if (firstPass) return success(firstPass);

  // One last layout, and only when an engine actually refused rather than timed out:
  // a timeout has already shown this host is slow, so asking it again spends the
  // caller's remaining budget for the same answer.
  if (!custom && failures.includes('SEARCH_UNAVAILABLE') && remainingMs() > 0) {
    const alternate = attempts[1];
    if (alternate && !isEngineBlocked(alternate.engineKey)) {
      const secondPass = await runAttempts([alternate]);
      if (secondPass) return success(secondPass);
    }
  }

  if (failures.includes('SEARCH_TIMEOUT')) return { sources: [], reason: 'SEARCH_TIMEOUT' };
  if (failures.includes('SEARCH_UNAVAILABLE')) return { sources: [], reason: 'SEARCH_UNAVAILABLE' };
  return { sources: [], reason: 'NO_SOURCES' };
}

/**
 * Fetch a public result page. Redirects are followed manually so every hop is
 * checked before it is contacted; the response is bounded by both time and size.
 */
export async function fetchPublicPage(
  rawUrl: string,
  { timeoutMs = PAGE_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PublicPageResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'UNSAFE_URL' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    throwIfAborted(signal);
    const problem = await urlProblem(current);
    if (problem) return { ok: false, reason: problem };
    let response: Response;
    try {
      response = await fetch(current, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': USER_AGENTS[0],
        },
        redirect: 'manual',
        signal: boundedBy(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const name = (error as { name?: unknown } | null)?.name;
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'SEARCH_TIMEOUT' : 'SEARCH_UNAVAILABLE' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, reason: 'SEARCH_UNAVAILABLE' };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: 'UNSAFE_URL' };
      }
      continue;
    }
    if (!response.ok) return { ok: false, reason: 'SEARCH_UNAVAILABLE' };
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return { ok: false, reason: 'SEARCH_UNAVAILABLE' };
    }
    const body = await readBoundedText(response, MAX_PAGE_BYTES);
    if ('reason' in body) {
      return { ok: false, reason: body.reason === 'PAGE_TOO_LARGE' ? 'PAGE_TOO_LARGE' : 'SEARCH_UNAVAILABLE' };
    }
    return { ok: true, html: body.text, url: current.toString() };
  }
  return { ok: false, reason: 'TOO_MANY_REDIRECTS' };
}

export default {
  fetchPublicPage,
  parseDuckDuckGoLiteResults,
  parseDuckDuckGoResults,
  parseSearxResults,
  searchFreeWeb,
};
