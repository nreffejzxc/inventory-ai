import {
  API_URL,
  COLD_START_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SERVER_WARM_WINDOW_MS,
} from './config';

/** One field-level validation problem from the server's `fields` array. */
export interface ApiFieldError {
  field: string;
  message: string;
}

/**
 * A partial result the server kept durable while a multi-part request was
 * rejected (e.g. a partial PO receive, 409 RECEIVE_CONFLICT):
 * `[{ productId, quantity, ... }]`.
 */
export interface AppliedResult {
  productId?: string;
  quantity?: number;
}

/**
 * Error type raised by the API client for every failed request. Fields mirror
 * the backend error envelope so screens can react to codes and field-level
 * validation problems without scattering fetch logic.
 */
export class ApiError extends Error {
  /** HTTP status; 0 => the request never reached the server. */
  status: number;
  code: string | null;
  fields: ApiFieldError[];
  applied?: AppliedResult[];
  /**
   * Whole seconds the server asked this client to wait, parsed from a
   * `Retry-After` response header; `null` when the response carried none.
   *
   * The rate limiters in this project emit it on every 429 (draft-7 headers), so
   * a caller that wants to describe a wait — rather than print a fixed sentence —
   * can read the server's own number instead of inventing one. It is advisory
   * only: nothing in this client enforces it, and it is never persisted.
   */
  retryAfter: number | null;

  constructor(
    status: number,
    code?: string | null,
    message?: string,
    fields: ApiFieldError[] = [],
    applied?: AppliedResult[],
  ) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
    this.fields = fields;
    this.applied = Array.isArray(applied) ? applied : undefined;
    this.retryAfter = null;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
  get isValidation(): boolean {
    return this.status === 400 && this.fields.length > 0;
  }
}

/**
 * AI-9 — the CALLER cancelled its own request, and that is not a failure.
 *
 * A user-initiated abort reaches `fetch` the same way this client's own timeout
does (both abort the same `AbortController`, and both surface as an
 * `AbortError`), so without a distinct code the transport would report a member
 * changing their mind as `NETWORK_TIMEOUT` — "the assistant took too long" —
 * which is a sentence about a problem they do not have, and one that no retry
 * could ever satisfy. The two are separated by asking *whose* abort fired: the
 * caller's signal is the only thing that can set `REQUEST_CANCELLED`.
 *
 * It is deliberately NOT a network error either (`isNetwork` is `status === 0`,
 * which is true here): a stop is a decision, not an outage, and a screen that
 * treats it as one sends the member to check a connection that was working.
 */
export const REQUEST_CANCELLED = 'REQUEST_CANCELLED';

/**
 * Phase 26A: notified whenever a request that CARRIED a token was refused on
 * authentication grounds (401, or 403 for a disabled account). The listener
 * decides what that means — this module holds no policy — and `lib/auth.tsx`
 * registers one so a dead session is handled in a single place instead of every
 * screen re-deriving it. A screen that never thinks about sessions (a form
 * mid-submit, a background fetch) therefore still returns the app to login
 * rather than showing an authentication error it cannot resolve.
 *
 * A request with no token is never reported: a 401 from /api/auth/login is bad
 * credentials, not a dead session.
 */
export type SessionLostHandler = (error: ApiError) => void;

let sessionLostHandler: SessionLostHandler | null = null;

export function setSessionLostHandler(handler: SessionLostHandler | null | undefined): void {
  sessionLostHandler = typeof handler === 'function' ? handler : null;
}

/** Query-string parameters; `undefined`/`null`/`''` entries are dropped. */
export type QueryParams = Record<string, unknown>;

export interface ApiFetchOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  params?: QueryParams | null;
  /**
   * Wall-clock budget for THIS request, in ms (AI-1). Defaults to
   * `REQUEST_TIMEOUT_MS`, so every existing caller keeps the global 15 s budget
   * and only a caller that states otherwise is affected.
   *
   * It exists because one route is legitimately slow: the assistant's server side
   * is bounded by its own turn deadline, not by 15 s, so a single global budget
   * could only ever be wrong for one of the two. The assistant passes its own,
   * larger budget; nothing else changes.
   */
  timeoutMs?: number;
  /**
   * N-4 — the `token` on this request is a DELIBERATELY TEMPORARY session that is
   * never applied to the app, so a 401/403 answer must NOT be reported as session
   * loss. See the note at the report site below for why that distinction has to
   * exist rather than being left to the caller.
   *
   * It says nothing about authorization, and the server treats the request
   * identically either way: the response is still normalized into an `ApiError` and
   * still thrown. The only thing it changes is whether a client-side NOTIFICATION
   * fires.
   */
  temporarySession?: boolean;
  /**
   * AI-9 — the caller's own cancellation.
   *
   * Supplied by a screen that lets the member STOP something slow (the AI
   * assistant's turn is budgeted 75 s on this side and 60 s on the server).
   * Aborting it rejects with the `REQUEST_CANCELLED` code above, which is
   * distinct from this client's `NETWORK_TIMEOUT` on purpose.
   *
   * It is the only way a request can end early at the caller's request, so every
   * existing caller that passes nothing keeps the behaviour it had.
   */
  signal?: AbortSignal;
  /**
   * The operation's own name, sent as `Idempotency-Key` (inventory duplicate
   * writes). The server remembers the answer it gave for this key and replays it
   * when the same key arrives again, so a request the client gave up on can be
   * retried without applying the movement twice.
   *
   * The caller owns the key's lifetime: one key per operation ATTEMPT, re-used
   * while that same attempt is retried and dropped once its outcome is known.
   * No header is sent when this is absent, which keeps every other request
   * exactly as it was.
   */
  idempotencyKey?: string;
}

function toQuery(params?: QueryParams | null): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** The error envelope the backend returns for every non-2xx response. */
interface ApiErrorEnvelope {
  code?: string;
  error?: string;
  fields?: ApiFieldError[];
  applied?: AppliedResult[];
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * `fetch` reports an abort as a rejection whose `name` is 'AbortError'. The
 * check is structural rather than `instanceof Error` because the abort value is
 * a DOMException in some runtimes — this mirrors the original `err?.name`
 * comparison exactly, including for non-object rejections.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Parses a `Retry-After` header into whole seconds, or `null` when there is
 * nothing usable to parse.
 *
 * Both RFC 9110 forms are accepted — delta-seconds (what every limiter in this
 * project emits) and an HTTP-date — so the reader cannot be the reason a wait is
 * unstated. The digit check is written as a loop rather than a regex so the
 * server's decimal form is accepted exactly and nothing else is.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let allDigits = true;
  for (const ch of trimmed) {
    if (ch < '0' || ch > '9') {
      allDigits = false;
      break;
    }
  }
  if (allDigits) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * Reads the wait the server stated, without assuming the response really is a
 * `Response`.
 *
 * Two suites in this repository stub `fetch` with the minimal object their own
 * subject needs, and some of those stubs carry no header bag at all. An ERROR path
 * must never fail because of that: the `ApiError` is the outcome this function is
 * building, and it has to be built either way. A response with nothing readable
 * simply states no wait, which is the same answer an absent header gives.
 */
function readRetryAfter(res: Response): number | null {
  const headers = res.headers as Headers | undefined;
  if (!headers || typeof headers.get !== 'function') return null;
  return parseRetryAfter(headers.get('retry-after'));
}

/**
 * AUTH-03 — the ONE response code that means "the Inventory JWT expired, but the
 * session it named is still live". Recoverable: the client can renew the same
 * session (or, if renewal is impossible, re-exchange), so this must NEVER be
 * routed to the session-loss path — treating an expiry as a dead session is the
 * behavior AUTH-03 replaces.
 */
export const SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';

/**
 * What a screen says when the token could not be refreshed RIGHT NOW.
 *
 * The server's `SESSION_EXPIRED` sentence — "Session expired — please sign in again" — is true
 * about the TOKEN and false about the SESSION: AUTH-03 deliberately preserves a live session when
 * renewal fails transiently, retries on the next request after its own backoff, and never signs
 * the user out for this. The server cannot know which case the client is in, so the client — which
 * does — replaces the sentence while keeping the CODE, so nothing about classification moves:
 * `SESSION_EXPIRED` stays recoverable and is still never reported as session loss.
 *
 * Measured on a phone on 2026-10-21: a transient renewal failure showed the sign-in instruction on
 * a 14-day session that was still alive, and the only way past it looked like signing in again.
 */
export const SESSION_REFRESH_FAILED_MESSAGE =
  'Could not refresh your sign-in. Check your connection and try again.';

/**
 * True when a refused authenticated request can be recovered by renewal.
 *
 * Classification is by APPLICATION ERROR CODE, never by HTTP status: a 401 alone
 * says nothing about whether the session is recoverable, and the whole point of
 * AUTH-03 is that `SESSION_EXPIRED` (recoverable) and `SESSION_REVOKED`
 * (terminal) are both 401s and must be told apart.
 */
export function isRecoverableAuthError(error: ApiError): boolean {
  return error.code === SESSION_EXPIRED_CODE;
}

/**
 * AUTH-03 — the provider's RECOVERY hook.
 *
 * Called when an authenticated request was refused with a recoverable expiry. It
 * returns a fresh token to retry with, or `null` when recovery could not complete
 * now (transient). Single-flight and the auth epoch live in `lib/auth.tsx`, which
 * registers this; the transport only decides WHEN to ask and how many times to
 * retry (exactly once).
 *
 * `supersededToken` is the token THE REFUSED REQUEST WAS SENT WITH. It matters
 * because a screen can have several requests in flight: the first one refused
 * renews, and the others were already carrying the old token when that happened.
 * Without this argument each of them renewed again — measured on the phone on
 * 2026-10-22: one dashboard load after an idle gap produced THREE renewals, two of
 * them minted for requests whose token had already been replaced. The provider uses
 * it to answer "your token is stale, use the current one" instead of renewing.
 */
export type SessionRecoveryHandler = (
  error: ApiError,
  supersededToken?: string | null,
) => Promise<string | null>;

let sessionRecoveryHandler: SessionRecoveryHandler | null = null;

export function setSessionRecoveryHandler(
  handler: SessionRecoveryHandler | null | undefined,
): void {
  sessionRecoveryHandler = typeof handler === 'function' ? handler : null;
}

/**
 * AUTH-03 — the provider's PROACTIVE-RENEWAL hook.
 *
 * Given the token a request is about to carry, it returns either the same token or
 * a freshly renewed one. The provider decides, from its own token/session horizon
 * (10 minutes), whether a renewal is due — so proactive renewal happens beneath
 * every screen instead of each caller remembering to do it. A failure is
 * swallowed here: the request proceeds with the token it had, and its own response
 * decides what happens next. Without a registered handler (every test that does
 * not install one) the hook is a no-op.
 */
export type SessionRenewalHandler = (token: string) => Promise<string | null>;

let sessionRenewalHandler: SessionRenewalHandler | null = null;

export function setSessionRenewalHandler(
  handler: SessionRenewalHandler | null | undefined,
): void {
  sessionRenewalHandler = typeof handler === 'function' ? handler : null;
}

/**
 * AUTH-03 — the token a request should actually carry, renewing it proactively when due.
 *
 * Exported for AI-40: the streamed chat request does not travel through `apiFetch` (a streaming
 * body cannot be consumed by the JSON client), so without this it would be the one request in
 * the app that lets a nearly-expired token reach the server and come back 401 — signing the
 * member out for a session that renewal would have saved. One rule, one place, both callers.
 */
export async function resolveRequestToken(
  token: string | null,
  { temporarySession = false }: { temporarySession?: boolean } = {},
): Promise<string | null> {
  if (!token || temporarySession || !sessionRenewalHandler) return token;
  try {
    const refreshed = await sessionRenewalHandler(token);
    return refreshed || token;
  } catch {
    // Renewal is best-effort; the request proceeds on the existing token and its own response
    // decides what happens next (exactly as it always has).
    return token;
  }
}

/**
 * DEP-2 — when the server last answered anything, in this app run.
 *
 * IN MEMORY ONLY, DELIBERATELY. This is not an authentication fact, a session fact
 * or a preference: it is a statement about the last few minutes of ONE process's
 * conversation with the backend, and a persisted copy would be stale exactly when
 * it matters most — a fresh launch is the likeliest moment to meet a server that
 * has been asleep, and it is also the moment a persisted copy would have been
 * written by a previous run that ended long ago. A restart therefore begins by
 * assuming the server may be cold, and that is the safe direction: the cost is a
 * longer wait that ends the instant an answer arrives.
 */
let lastServerAnswerAt = 0;

/**
 * The budget for a request that stated none.
 *
 * THE RULE, in one sentence: wait longer only while there is no recent evidence
 * that the server is awake. Every explicit `timeoutMs` bypasses it entirely, so
 * the assistant's own larger budget is unaffected in both states and no route can
 * accidentally inherit the cold-start allowance.
 */
function requestBudget(explicit?: number): number {
  if (typeof explicit === 'number') return explicit;
  const answeredRecently =
    lastServerAnswerAt > 0 && Date.now() - lastServerAnswerAt < SERVER_WARM_WINDOW_MS;
  return answeredRecently ? REQUEST_TIMEOUT_MS : COLD_START_TIMEOUT_MS;
}

/**
 * True when a base URL names the device itself.
 *
 * Only the loopback forms are included, and `10.0.2.2` is deliberately NOT: that
 * address means "the host machine" to an Android emulator and is the CORRECT
 * configuration there, so reporting it as a mistake would cry wolf in the one
 * place it works as intended.
 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  const match = /^https?:\/\/([^/?#]+)/i.exec(baseUrl);
  if (!match) return false;
  let host = match[1].toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host : host.slice(1, end);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * DEP-2 — what "cannot reach the server" says, and when a development build says
 * more.
 *
 * THE PRODUCTION SENTENCE IS UNCHANGED, and that is a requirement rather than an
 * accident: several suites pin it, and it is correct for a member whose network is
 * genuinely down.
 *
 * A DEVELOPMENT BUILD POINTED AT LOOPBACK IS A DIFFERENT FACT and deserves a
 * different sentence, because the general one actively misleads: it blames the
 * network when the app is in fact calling the phone in the member's hand. That
 * state was measured on 2026-10-16 — a physical phone running a dev build whose
 * `mobile/.env` named loopback produced this exact sentence on every request,
 * while the real answer was one `adb reverse` away. The suffix names the URL that
 * is actually configured (client configuration, never a secret) and both ways out
 * of the state, and it cannot reach a production build at all.
 */
export function unreachableMessage(baseUrl: string, isDev: boolean): string {
  const base = 'Cannot reach the server. Check your connection and try again.';
  if (!isDev || !isLoopbackBaseUrl(baseUrl)) return base;
  return (
    `${base} (dev build note: EXPO_PUBLIC_API_URL is ${baseUrl}, which is this ` +
    'device itself — run "adb reverse tcp:4000 tcp:4000" while your backend listens on ' +
    'the laptop, or point EXPO_PUBLIC_API_URL at an address this phone can reach.)'
  );
}

/**
 * Single request path for the whole app. Adds JSON headers and a Bearer token
 * when given, applies a timeout, and normalizes every non-2xx response into an
 * ApiError using the backend's { error, code, fields } shape. Screens never
 * call fetch directly.
 *
 * The response body is a genuinely dynamic boundary, so the parsed JSON is
 * returned as `unknown` unless the caller names the shape it expects (`T`).
 *
 * AUTH-03 adds proactive renewal (before the request) and recovery-on-expiry
 * (after it), both delegated to `lib/auth.tsx` through the hooks above. The retry
 * count is exactly one: the retried attempt is marked `isRetry`, so it neither
 * renews proactively again nor attempts a second recovery.
 */
export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  return apiFetchAttempt<T>(path, options, false);
}

async function apiFetchAttempt<T = unknown>(
  path: string,
  { method = 'GET', token, body, params, temporarySession = false, timeoutMs, signal, idempotencyKey }: ApiFetchOptions,
  isRetry: boolean,
): Promise<T> {
  let effectiveToken = token ?? null;

  // AUTH-03 — proactive renewal, immediately before the request leaves. The
  // provider decides whether the token is near expiry; a failure is non-fatal.
  if (!isRetry) effectiveToken = await resolveRequestToken(effectiveToken, { temporarySession });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (effectiveToken) headers.Authorization = `Bearer ${effectiveToken}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  // AI-1 — the caller's own budget when it stated one. DEP-2 — otherwise the
  // budget for the state this client is in: the ordinary 15 s once the server has
  // answered recently, a cold-start allowance while it has not. Resolved here,
  // once, so every request in the app shares one rule unless it opts out.
  const budgetMs = requestBudget(timeoutMs);
  const controller = new AbortController();
  // WHOSE abort this is, recorded BEFORE the abort fires rather than inferred from
  // the rejection afterwards. That inference is what failed on the device: an
  // aborted request in React Native can reject as a plain
  // `TypeError: Network request failed`, so the client's own decision was reported
  // as somebody else's outage.
  let abortCause: 'timeout' | 'caller' | null = null;
  const timer = setTimeout(() => {
    abortCause = 'timeout';
    controller.abort();
  }, budgetMs);

  // AI-9 — ONE controller, two reasons to abort, and the reason is read back at
  // the failure site below. The caller's signal is FORWARDED into this controller
  // rather than passed to `fetch` beside it, because a `fetch` can only be given
  // one signal: replacing this one would silently drop the timeout, and racing two
  // would make the losing one unstoppable. Forwarding keeps a single abort path
  // that both the budget and the member can pull.
  const callerSignal = signal ?? null;
  const onCallerAbort = () => {
    abortCause = 'caller';
    controller.abort();
  };
  if (callerSignal) {
    // Already aborted before the request began: abort now rather than fetch a
    // request nobody wants. (`abort()` on an already-aborted controller is a
    // no-op, so the immediate case and the later one share one handler.)
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }
  /** Releases the timer and the caller's listener on every exit path. */
  const releaseRequest = (): void => {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${toQuery(params)}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    releaseRequest();
    // WHOSE abort this was decides what the member is told. The caller's own
    // signal can only be aborted by the caller, so it wins when both are set.
    if (callerSignal?.aborted) {
      throw new ApiError(0, REQUEST_CANCELLED, 'The request was cancelled.');
    }
    // A timeout is this client's own decision, so it is read from what this
    // client DID (`abortCause`) and only secondarily from the rejection's shape.
    // The shape was the original — and, measured on a device on 2026-10-16,
    // wrong — authority: the budget fired at 14 989 ms, the rejection arrived as
    // `TypeError: Network request failed`, and a merely slow server was reported
    // as unreachable, sending the member to check a connection that was working.
    // `isAbortError` stays as the fallback for an abort this client did not start.
    if (abortCause === 'timeout' || isAbortError(err)) {
      throw new ApiError(0, 'NETWORK_TIMEOUT', 'The request timed out. Check your connection and try again.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', unreachableMessage(API_URL, __DEV__));
  }
  releaseRequest();

  // DEP-2 — an answer of ANY kind, refusals included, proves the server is awake:
  // it is the only thing that ends the cold-start allowance. Recorded here, where
  // the response exists, so no caller has to remember anything.
  lastServerAnswerAt = Date.now();

  const data = await readJson(res);
  if (res.status >= 200 && res.status < 300) return data as T;
  const envelope = (data ?? {}) as ApiErrorEnvelope;
  const error = new ApiError(
    res.status,
    envelope.code,
    envelope.error || `Request failed (${res.status})`,
    envelope.fields || [],
    envelope.applied,
  );
  // The server's own cooldown, when it stated one. Read for EVERY failed
  // response rather than only 429s: the header is only ever emitted alongside a
  // refusal, and gating on the status here would encode a policy this transport
  // is not entitled to hold.
  error.retryAfter = readRetryAfter(res);

  // AUTH-03 — recoverable expiry: one controlled recovery, then EXACTLY ONE retry.
  // `isRetry` guarantees the retried attempt cannot re-enter this branch, so no
  // loop is possible. A null answer means recovery could not complete now (a
  // transient Firebase/network/rate-limit failure, per the locked classification)
  // — the original error is then thrown and, because it is recoverable, the
  // session is deliberately NOT reported as lost.
  if (
    !isRetry &&
    effectiveToken &&
    !temporarySession &&
    isRecoverableAuthError(error) &&
    sessionRecoveryHandler
  ) {
    let refreshed: string | null = null;
    try {
      refreshed = await sessionRecoveryHandler(error, effectiveToken);
    } catch {
      refreshed = null;
    }
    if (refreshed) {
      return apiFetchAttempt<T>(
        path,
        // `timeoutMs` is carried across the retry: a recovered request must get
        // the same budget its caller asked for, not silently revert to 15 s.
        // `signal` is carried for the same reason in the other direction: a
        // retried request must still be stoppable by the caller who asked for it.
        // `idempotencyKey` is carried for a THIRD: the retry is the same operation,
        // and dropping the key would let a movement that outlived its token be
        // applied a second time by the retried delivery.
        { method, token: refreshed, body, params, temporarySession, timeoutMs, signal, idempotencyKey },
        true,
      );
    }

    // Recovery could not complete now, and the session is preserved on purpose. Replace the
    // server's expiry sentence with what actually happened; the code is untouched.
    if (isRecoverableAuthError(error)) error.message = SESSION_REFRESH_FAILED_MESSAGE;
  }

  // N-4 — WHY ONE REQUEST CAN OPT OUT OF THIS REPORT.
  //
  // The password-recovery handoff deliberately holds a TEMPORARY session (minted by the
  // public exchange, never applied to the app) and calls the credential-change bridge
  // with it. Two of that call's answers are expected and ordinary: `401
  // SESSION_INVALIDATED` is the success-equivalent answer when the revocation this call
  // is repeating already happened, and any 401 from the bridge can happen if the
  // sessions were ended elsewhere first. Reporting either through this handler would
  // fire `lib/auth.tsx`'s session-loss path, which CLEARS the session AND ENDS THE
  // DURABLE FIREBASE SESSION — destroying the very sign-in the recovery is completing,
  // so the final exchange that must follow would then have no Firebase user at all.
  //
  // The flag therefore suppresses the notification for that one request and nothing
  // else. It cannot weaken the rule for any ordinary request (it defaults to false and
  // is set in exactly one place), it changes no authorization decision, and the caller
  // still receives the thrown `ApiError` and handles the status itself.
  //
  // AUTH-03 adds a SECOND, code-based exclusion: a recoverable expiry is never
  // session loss, whether recovery succeeded (handled above) or not. This is what
  // keeps an expired-but-live session from being cleared, which is the entire
  // point of the phase.
  if (
    effectiveToken &&
    !temporarySession &&
    !isRecoverableAuthError(error) &&
    (res.status === 401 || res.status === 403)
  ) {
    sessionLostHandler?.(error);
  }
  throw error;
}

export default apiFetch;
