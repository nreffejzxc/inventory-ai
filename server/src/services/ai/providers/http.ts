/**
 * Shared JSON-over-HTTPS caller for the AI providers (Node >=18 global fetch,
 * no SDK dependency). Enforces a timeout and normalises every failure into an
 * AI error carrying a safe, client-presentable message — raw upstream bodies
 * and statuses are logged server-side, never returned to the client.
 *
 * TWO non-2xx answers are deliberately not an AiProviderError (AI-6): 429 and 402
 * mean the gateway answered correctly and refused because an allowance is spent,
 * so they become an AiQuotaExceeded (429 AI_QUOTA_EXCEEDED) instead. Every other
 * status — including every 5xx, which really is an outage — keeps the
 * AiProviderError this layer has always thrown.
 */

import { AiAbandoned, AiProviderError, AiQuotaExceeded } from '../aiErrors.ts';
import { parseQuotaHeaders, type QuotaInfo } from '../quota.ts';

/**
 * The upstream JSON body, as far as anything here is allowed to assume: an
 * object whose properties are probed and never trusted. `Response.json()` is
 * typed `unknown`, and this is the narrowest thing that lets the parsers below
 * reach into a response at all — the `=== null` / `typeof` / `Array.isArray`
 * guard in postJson is the check that actually establishes the object, and every
 * field stays `unknown` for the caller to narrow deliberately. Nothing is
 * coerced and no default is introduced, so an array, a string or a body missing
 * a property still behaves exactly as it did when the local was untyped.
 */
export type UpstreamJsonBody = Record<string, unknown>;

/**
 * AI-36 — what one call returned: the body, and the allowance the response published.
 *
 * The headers used to be discarded, so the operator could not see the daily allowance shrinking
 * and every turn after it was spent still paid for a round-trip to be refused. `quota` is null
 * when the provider published neither number — an absence, never a zero.
 */
export interface PostJsonResult {
  data: UpstreamJsonBody;
  quota: QuotaInfo | null;
}

/**
 * One JSON-over-HTTPS call. `body` is the provider's own request payload, built
 * by the caller and serialised here; `headers` are merged over the two this
 * layer always sends.
 */
export interface PostJsonOptions {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  providerName?: string;
  /**
   * Aborted when the CALLER has gone away (AI-1). Combined with this layer's own
   * timeout so either can end the request, and told apart in the catch below so
   * an abandoned call is neither logged as a timeout nor reported as one.
   */
  signal?: AbortSignal;
}

/**
 * TEMPORARY — Phase 31D.3 / 31D.6 diagnostics for upstream failures.
 *
 * Phase 31D.3: a production AgentRouter call answered 2xx with a body `res.json()`
 * could not parse, and the branch below recorded only that fact: the status, the
 * Content-Type and the body itself were all discarded, which left the failure
 * un-diagnosable. These helpers record what that branch was throwing away.
 *
 * Phase 31D.6: the same blindness applied to every non-2xx. `!res.ok` logged the
 * status alone and threw without reading the body, so the 401 the gateway
 * returned after the origin migration — the failure that replaced the Aliyun WAF
 * challenge — was un-diagnosable by construction. That branch now reads its body
 * and reports it through this same helper.
 *
 * They are logging only. Nothing here alters control flow, the thrown error or
 * the response: the same AiProviderError is raised on every path, and a response
 * body is read exactly once (one `res.text()` per branch) — never re-read, never
 * retried.
 */

/** Longest body prefix ever logged; everything past this is never inspected. */
const BODY_PREFIX_MAX = 300;

/**
 * Anything that could be credential material. Several of these are value
 * *prefixes* (`sk-`, `Bearer `, `eyJ`), so masking the marker alone would leave
 * the secret itself in the log — a match therefore withholds the WHOLE prefix
 * rather than partially masking it. That costs only the prefix: `status`,
 * `contentType`, `contentLength` and `classification` are what this diagnostic
 * is read for, and none of them depends on it. Over-redacting is the safe side.
 */
const SECRET_LIKE = /sk-|bearer|eyJ|mongodb|api[_-]?key|token|authorization/i;

/** The body prefix for the log, or a withholding notice when it looks sensitive. */
function sanitizeBodyPrefix(body: string) {
  const prefix = body.slice(0, BODY_PREFIX_MAX);
  if (SECRET_LIKE.test(prefix)) return '[WITHHELD - prefix matched a secret-like marker]';
  return prefix;
}

/**
 * Coarse shape of the upstream body, checked in the order that keeps each rule
 * unambiguous: an empty body first (nothing else can be said about one), then
 * HTML, then an SSE stream, then JSON-looking text. `UNKNOWN` is reached only
 * when the response carried no Content-Type at all and the body matched nothing.
 */
function classifyUpstreamBody(contentType: string, body: string) {
  if (body.length === 0) return 'EMPTY';
  const ct = contentType.toLowerCase();
  const head = body.slice(0, 40).trimStart().toLowerCase();
  if (ct.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html')) return 'HTML';
  if (ct.includes('text/event-stream') || head.startsWith('data:')) return 'SSE';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON_LIKE';
  return ct ? 'TEXT' : 'UNKNOWN';
}

/**
 * Log what a failing branch would otherwise discard. Reports response metadata
 * and a bounded, sanitized body prefix only — never the request, its headers,
 * the caller's prompt or the upstream body in full.
 *
 * `reason` distinguishes the branches in the header line (`non-JSON`, `HTTP
 * error`) while every field below it is produced identically for both, so a
 * non-2xx and an unparseable 2xx are read the same way.
 */
function logUpstreamDiagnostics({
  providerName,
  res,
  body,
  reason,
}: {
  providerName: string;
  res: Response;
  body: string;
  reason: string;
}) {
  const contentType = res.headers.get('content-type') ?? '';
  console.error(
    [
      `AI provider ${providerName} upstream ${reason} diagnostics`,
      `status=${res.status}`,
      `contentType=${contentType || 'none'}`,
      `contentLength=${res.headers.get('content-length') ?? 'none'}`,
      `location=${res.headers.get('location') ?? 'none'}`,
      `bodyLength=${body.length}`,
      `classification=${classifyUpstreamBody(contentType, body)}`,
      `bodyPrefix=${JSON.stringify(sanitizeBodyPrefix(body))}`,
    ].join('\n')
  );
}

/**
 * The one place a non-2xx upstream response becomes an error.
 *
 * Shared by the JSON and the streaming call since AI-40, so the two cannot disagree about
 * which statuses are quota refusals, which carry the allowance, or what a member is told.
 * Every branch logs before it throws, and the body is never returned to a client.
 */
async function failUpstream(res: Response, providerName: string): Promise<never> {
  // AI-6 — 429 and 402 are the two non-2xx that are NOT outages. The gateway is
  // answering perfectly well; it is refusing because an allowance is spent.
  // 429 is the measured dominant failure at this tier (`429
  // free-models-per-day`, §27BF) and 402 is its sibling — an exhausted credit
  // balance. Both used to reach the member as 502 AI_UNAVAILABLE, whose sentence
  // tells them to try again in a moment, which cannot refill either one. 402 was
  // previously covered by a test case that labelled it `insufficient credits`
  // and still asserted a provider failure; it is the same class.
  //
  // The log line is deliberately separate and greppable, because the operator
  // question is never "was there a 429?" but "is this a limit or an outage?".
  const isQuotaRefusal = res.status === 429 || res.status === 402;
  console.error(
    isQuotaRefusal
      ? `AI provider ${providerName} upstream rate/quota limit reached (HTTP ${res.status})`
      : `AI provider ${providerName} upstream HTTP ${res.status}`
  );
  // Phase 31D.6: this branch used to throw without reading the body, so a
  // non-2xx was diagnosable only by its status code. The read is guarded
  // because an error body may itself fail to arrive (a truncated stream, a
  // connection dropped mid-body) and that must not replace the error this
  // branch throws — and it happens BEFORE the throw for the same reason it
  // always has: the quota case needs its diagnostics just as much, and the
  // body is still never returned to the client.
  const errorBody = await res.text().catch(() => '');
  logUpstreamDiagnostics({ providerName, res, body: errorBody, reason: 'HTTP error' });
  // AI-36 — the allowance travels with the refusal. Only a reading of ZERO is acted on by the
  // turn loop; anything else leaves the AI-6 behaviour exactly as it was.
  const quota = parseQuotaHeaders(res.headers);
  if (isQuotaRefusal) throw new AiQuotaExceeded(undefined, quota ?? undefined);
  // AI-29 — the status travels with the error so the turn loop can tell a broken
  // MODEL (404/410/5xx, worth a second model) from a broken REQUEST, KEY or NETWORK
  // (400/401/403, where another model changes nothing). It is a classification input,
  // never client copy: the sentence stays the safe generic one.
  throw new AiProviderError('The AI service returned an error. Please try again.', undefined, res.status);
}

export async function postJson({ url, headers = {}, body, timeoutMs = 60000, providerName = 'ai', signal }: PostJsonOptions): Promise<PostJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Either this layer's own timeout or the caller disappearing ends the request.
  const abortSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  // The definite-assignment assertion replaces the untyped `let res;` without
  // touching the flow: every path reaching the read below has either assigned a
  // response or thrown. Erased, so the declaration is still emitted as `let res;`.
  let res!: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    // `err` is `unknown`: a thrown value has no shape TypeScript may assume, and
    // the assertion is the erasable way to read the properties this check has
    // always read. Nothing is attached to the error that leaves.
    if ((err as { name?: unknown })?.name === 'AbortError') {
      // AI-1 — WHO aborted decides what this is. A caller that has gone away is
      // not a timeout: logging it as one would hide the abandonment, and
      // throwing a timeout would become a 502 written to a closed socket. The
      // caller's own signal is what tells the two apart, because this layer's
      // controller is only ever aborted by its own timer.
      if (signal?.aborted) {
        console.error(`AI provider ${providerName} caller went away; the upstream call was cancelled`);
        throw new AiAbandoned();
      }
      console.error(`AI provider ${providerName} request timed out after ${timeoutMs}ms`);
      // AI-31 — classified so repeated failures can count toward the model breaker, while
      // still NOT triggering an in-turn failover: another model would hit the same clock.
      throw new AiProviderError(
        'The AI service took too long to respond. Please try again.',
        undefined,
        undefined,
        'timeout',
      );
    }
    console.error(`AI provider ${providerName} network error: ${(err as { message?: unknown })?.message ?? 'unknown'}`);
    // AI-31 — a dropped connection is an availability fact, not a model verdict: counted
    // by the breaker when it repeats, never used to walk to another model in the same turn.
    throw new AiProviderError(
      'The AI service could not be reached. Please try again.',
      undefined,
      undefined,
      'network',
    );
  }
  clearTimeout(timer);

  if (!res.ok) await failUpstream(res, providerName);

  // `unknown` at the untrusted boundary: the guard below is what narrows it, so
  // `=== null` here is a live check rather than a comparison the compiler knows
  // to be impossible.
  //
  // The body is read as text rather than through `res.json()` only so the
  // failure branch below has something to report (Phase 31D.3). Stripping a
  // leading BOM is what `Body.json()` itself does before parsing, so a
  // BOM-prefixed JSON body parses exactly as it did before.
  let bodyText = '';
  let data: unknown;
  try {
    bodyText = await res.text();
    data = JSON.parse(bodyText.charCodeAt(0) === 0xfeff ? bodyText.slice(1) : bodyText);
  } catch {
    console.error(`AI provider ${providerName} upstream returned a non-JSON body`);
    logUpstreamDiagnostics({ providerName, res, body: bodyText, reason: 'non-JSON' });
    throw new AiProviderError(
      'The AI service returned an unexpected response.',
      undefined,
      undefined,
      'invalid_response',
    );
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    console.error(`AI provider ${providerName} upstream returned an unexpected payload shape`);
    throw new AiProviderError(
      'The AI service returned an unexpected response.',
      undefined,
      undefined,
      'invalid_response',
    );
  }
  return { data: data as UpstreamJsonBody, quota: parseQuotaHeaders(res.headers) };
}

/**
 * AI-40 — one streamed completion, delivered event by event.
 *
 * WHY IT IS A SECOND FUNCTION RATHER THAN A FLAG ON postJson. `postJson` waits for the whole
 * body, which is exactly what streaming exists to avoid: the answer is useful while it is being
 * written. Everything AROUND the body is identical — the abort handling, the status
 * classification, the diagnostics, the allowance headers — so those stay in one place and this
 * function differs only in how the body is consumed.
 *
 * WHAT IT GUARANTEES. `onEvent` sees only complete SSE events: framing (`data:` lines, the blank
 * line separator, CRLF) never reaches the provider assembler, and a chunk split mid-event is
 * held until the rest of it arrives. When the stream ends with events still buffered, they are
 * flushed, because a gateway that closes without a trailing blank line has still sent them.
 *
 * A 2xx that produced NO event at all is `invalid_response`, not an empty answer: a gateway which
 * ignored `stream: true` answered JSON, and the caller's fallback is the ordinary request. That
 * distinction is why the error carries its kind.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export interface PostSseOptions extends PostJsonOptions {
  /** Called once per complete event. Throwing here aborts the stream and propagates. */
  onEvent: (event: SseEvent) => void;
}

export async function postSse({
  url,
  headers = {},
  body,
  timeoutMs = 60000,
  providerName = 'ai',
  signal,
  onEvent,
}: PostSseOptions): Promise<{ quota: QuotaInfo | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  let res!: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: unknown })?.name === 'AbortError') {
      if (signal?.aborted) {
        console.error(`AI provider ${providerName} caller went away; the upstream stream was cancelled`);
        throw new AiAbandoned();
      }
      console.error(`AI provider ${providerName} stream request timed out after ${timeoutMs}ms`);
      throw new AiProviderError(
        'The AI service took too long to respond. Please try again.',
        undefined,
        undefined,
        'timeout',
      );
    }
    console.error(`AI provider ${providerName} network error: ${(err as { message?: unknown })?.message ?? 'unknown'}`);
    throw new AiProviderError(
      'The AI service could not be reached. Please try again.',
      undefined,
      undefined,
      'network',
    );
  }

  if (!res.ok) {
    clearTimeout(timer);
    await failUpstream(res, providerName);
  }

  const quota = parseQuotaHeaders(res.headers);
  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    throw new AiProviderError(
      'The AI service returned an unexpected response.',
      undefined,
      undefined,
      'invalid_response',
    );
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let seen = 0;

  /** One framed block -> one event. Comments (`:ping`) and unknown fields are ignored. */
  const emit = (block: string): void => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    seen += 1;
    onEvent({ event, data: data.join('\n') });
  };

  /**
   * Append decoded text, normalising CRLF over the WHOLE buffer.
   *
   * AI-40 (found in review, before release) — normalising each chunk on its own is wrong: a
   * network write can end between `\r` and `\n`, so the pair is never seen together, `\r\n`
   * survives into the buffer, `\n\n` never matches, and a CRLF gateway delivers **no events at
   * all** until EOF — silently turning streaming into one late paint, which is the exact failure
   * this file exists to prevent. The `sse-crlf` case fails if this moves back to a per-chunk
   * replace.
   */
  const append = (text: string): void => {
    buffer = (buffer + text).replace(/\r\n/g, '\n');
  };

  const drain = (flush = false): void => {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      emit(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim() !== '') {
      emit(buffer);
      buffer = '';
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
      drain();
    }
    append(decoder.decode());
    drain(true);
  } catch (err) {
    if ((err as { name?: unknown })?.name === 'AbortError') {
      if (signal?.aborted) throw new AiAbandoned();
      console.error(`AI provider ${providerName} stream timed out after ${timeoutMs}ms`);
      throw new AiProviderError(
        'The AI service took too long to respond. Please try again.',
        undefined,
        undefined,
        'timeout',
      );
    }
    // `onEvent` throws from inside this loop when the provider reports an error event or the
    // assembler rejects a malformed one, and those must travel unchanged: they already carry the
    // right class (and, for a mid-stream error event, the right status).
    if (err instanceof AiProviderError || err instanceof AiQuotaExceeded || err instanceof AiAbandoned) {
      throw err;
    }
    console.error(`AI provider ${providerName} stream ended unexpectedly: ${(err as { message?: unknown })?.message ?? 'unknown'}`);
    throw new AiProviderError(
      'The AI service returned an unexpected response.',
      undefined,
      undefined,
      'network',
    );
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be closed by the error path; nothing to release then.
    }
  }

  if (seen === 0) {
    // A 2xx with no event at all is NOT an empty answer. The gateway ignored `stream: true` and
    // sent JSON, and the caller's fallback is the ordinary non-streamed request.
    console.error(`AI provider ${providerName} stream ended without a single event`);
    throw new AiProviderError(
      'The AI service returned an unexpected response.',
      undefined,
      undefined,
      'invalid_response',
    );
  }

  return { quota };
}

export default { postJson, postSse };
