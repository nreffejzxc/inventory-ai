/**
 * AI-36 — the account's remaining AI allowance, read from the provider's own response headers.
 *
 * WHY THIS EXISTS. The free tier is metered by REQUESTS (50 a day at the time of writing), and
 * the allowance is shared by every free model — which is exactly why AI-29 never fails over on a
 * quota refusal: the next model would be refused identically. Before this module, two things were
 * therefore invisible. The operator could not see the allowance approaching zero; the first
 * evidence was a member's failed turn. And once it was spent, every turn still spent one provider
 * round-trip to be told so, then answered 429. The provider publishes the number on every response
 * (`x-ratelimit-remaining` / `x-ratelimit-limit`), so reading it costs nothing: no completion, no
 * dependency, no new provider.
 *
 * WHAT IT DOES WITH THE READING.
 *
 *   * every reading is kept, so `AI turn …` can report `quota=12/50` and an operator can watch
 *     the budget instead of discovering its exhaustion;
 *   * a refusal that reports **zero** remaining blocks further provider calls for a short window
 *     (`AI_QUOTA_BLOCK_MS`, default 30 s). That is the only reading strong enough to act on: a
 *     refusal without a reading, or with allowance still shown, changes nothing — AI-6's original
 *     behaviour is preserved exactly;
 *   * any successful call proves the allowance works again and lifts the block immediately, so a
 *     recovered account never waits out the window;
 *   * the window is bounded and self-expiring, so a stale refusal cannot refuse service.
 *
 * WHAT IT IS NOT. It is not a rate limiter (members have their own, `AI_RATE_LIMIT_*`), not a
 * billing signal, and not authoritative: the provider's answer to a request always outranks this
 * cache. It holds two integers and a timestamp — no key, no address, no prompt.
 */

/** What a provider response said about the account's allowance. `null` = not published. */
export interface QuotaInfo {
  remaining: number | null;
  limit: number | null;
}

/** Anything with a `get` — a `Headers`, or a fake in a test. */
interface HeaderBag {
  get(name: string): string | null;
}

/** The header names seen in the wild, in priority order. The `x-` form is OpenRouter's. */
const REMAINING_HEADERS = ['x-ratelimit-remaining', 'ratelimit-remaining'];
const LIMIT_HEADERS = ['x-ratelimit-limit', 'ratelimit-limit'];

function readCount(headers: HeaderBag, names: readonly string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null || raw === undefined) continue;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    // A malformed value is UNKNOWN, not zero: treating it as an exhausted account would refuse
    // service on a header this code did not understand.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Parse the allowance out of response headers.
 *
 * `null` means the provider published neither number. A missing `limit` with a present `remaining`
 * is kept: the remaining count is the actionable one.
 */
export function parseQuotaHeaders(headers: HeaderBag | null | undefined): QuotaInfo | null {
  if (!headers || typeof headers.get !== 'function') return null;
  const remaining = readCount(headers, REMAINING_HEADERS);
  const limit = readCount(headers, LIMIT_HEADERS);
  if (remaining === null && limit === null) return null;
  return { remaining, limit };
}

interface Reading extends QuotaInfo {
  updatedAt: number;
}

let latest: Reading | null = null;
let blockedUntil = 0;

function adopt(info: QuotaInfo | null | undefined, now: number): void {
  if (!info) return;
  if (info.remaining === null && info.limit === null) return;
  latest = { remaining: info.remaining, limit: info.limit, updatedAt: now };
}

/**
 * Record a successful provider call.
 *
 * A 2xx is proof the allowance is available, so it also lifts any block a previous refusal set —
 * including one from another server instance, which cannot happen today but is the right reading
 * of the evidence either way.
 */
export function noteQuotaSuccess(info: QuotaInfo | null | undefined, now: number = Date.now()): void {
  adopt(info, now);
  blockedUntil = 0;
}

export interface QuotaRefusalOptions {
  /** How long to stop calling the provider after an observed zero. 0 disables the block. */
  blockMs?: number;
  now?: number;
}

/**
 * Record a quota refusal (429/402).
 *
 * Only `remaining === 0` starts a block. That precision is the whole safety property: a quota
 * refusal that carries no reading must keep the old behaviour (one request per turn to discover
 * the state), and a refusal with allowance still visible is not an exhausted account.
 */
export function noteQuotaRefusal(
  info: QuotaInfo | null | undefined,
  { blockMs = 0, now = Date.now() }: QuotaRefusalOptions = {},
): void {
  adopt(info, now);
  if (info?.remaining === 0 && blockMs > 0) {
    blockedUntil = Math.max(blockedUntil, now + blockMs);
  }
}

/** The last reading, or null when the provider has never published one. */
export function quotaSnapshot(): QuotaInfo | null {
  return latest ? { remaining: latest.remaining, limit: latest.limit } : null;
}

/** Milliseconds left on the fail-fast window (0 when calls are allowed). */
export function quotaBlockRemainingMs(now: number = Date.now()): number {
  return Math.max(0, blockedUntil - now);
}

/** Test-only: forget the reading and the block. */
export function resetQuotaState(): void {
  latest = null;
  blockedUntil = 0;
}

export default {
  parseQuotaHeaders,
  noteQuotaSuccess,
  noteQuotaRefusal,
  quotaSnapshot,
  quotaBlockRemainingMs,
  resetQuotaState,
};
