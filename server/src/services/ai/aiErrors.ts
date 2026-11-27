/**
 * AI error types. These are deliberately distinct from the general ApiError
 * envelope so the AI controller can map them to clean client responses:
 *
 *   AiNotConfigured  -> 503 AI_NOT_CONFIGURED (operator must configure the server)
 *   AiProviderError  -> 502 AI_UNAVAILABLE    (transient upstream failure)
 *   AiQuotaExceeded  -> 429 AI_QUOTA_EXCEEDED (a LIMIT was reached, not an outage, AI-6)
 *   AiTimeout        -> 504 AI_TIMEOUT        (the turn outlasted its own deadline, AI-1)
 *   AiAbandoned      -> 499 AI_ABANDONED      (the CALLER went away, AI-1)
 *   AiOutputLimit    -> 502 AI_OUTPUT_LIMIT   (the model spent its own output budget, AI-10)
 *
 * A FAILURE CAN STILL KNOW WHAT IT COST. `AiOutputLimit` may carry the model it
 * happened on and the token spend the gateway reported, because that class is raised
 * at the one place where both are already parsed — and a spent output budget is
 * exactly the turn whose cost an operator needs. Before this, the AI-5 turn line
 * reported `in=0 out=0 model=unknown` for it (found on the device 2026-10-17), which
 * is the opposite of the truth: the model burned its entire budget. Nothing else
 * carries accounting today, so the reader stays narrow on purpose.
 *
 * No type carries secrets, stack traces, or internal URIs. Provider internals
 * (raw upstream bodies, keys) are logged server-side only.
 *
 * Each error has its OWN status and its OWN code because each failure needs a
 * different thing from the reader: configure the server, retry the service, wait,
 * stop retrying and come back later, ask for less at once. Collapsing any two of
 * them is what made a spent allowance look like a broken server (AI-6) and what
 * made a spent output budget look like one too (AI-10).
 */

import type { QuotaInfo } from './quota.ts';

export const AI_NOT_CONFIGURED = 'AI_NOT_CONFIGURED';
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_QUOTA_EXCEEDED = 'AI_QUOTA_EXCEEDED';
export const AI_TIMEOUT = 'AI_TIMEOUT';
export const AI_ABANDONED = 'AI_ABANDONED';
export const AI_OUTPUT_LIMIT = 'AI_OUTPUT_LIMIT';

export class AiNotConfigured extends Error {
  declare code: string;

  constructor(message = 'The AI assistant is not configured on this server.') {
    super(message);
    this.name = 'AiNotConfigured';
    this.code = AI_NOT_CONFIGURED;
  }
}

export class AiProviderError extends Error {
  declare code: string;

  /**
   * The upstream HTTP status, when the failure came from an ANSWER rather than from
   * the transport (AI-29).
   *
   * It exists so the turn loop can tell "this MODEL is gone" (404/410, or a 5xx that a
   * dead upstream returns) from "our key, our request or the network is wrong" — a
   * distinction the fallback decision depends on and that used to be erased here,
   * because every non-quota status became the same shapeless error. Absent for a
   * timeout, a network failure and an unparseable body: none of those carries a status.
   */
  status?: number;

  /**
   * How the call failed when no HTTP status names it (AI-31).
   *
   * A transport failure is still not evidence that a *model* is bad — another model
   * would travel the same broken network, which is why it never triggers an in-turn
   * failover (AI-29). It IS evidence that the assistant cannot currently serve anyone,
   * so repeated ones count toward the same breaker that any other availability failure
   * counts toward; after the threshold the deployment stops paying for them on every
   * turn and waits out a cooldown. Kept as a separate field rather than inferred from
   * the message, because string matching on error copy is exactly how a timeout becomes
   * a 404 the day someone rewords a sentence.
   */
  kind?: AiProviderFailureKind;

  constructor(
    message = 'The AI service could not be reached.',
    code = AI_UNAVAILABLE,
    status?: number,
    kind?: AiProviderFailureKind,
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    // Adopted only when it is a real status. Anything else (undefined, NaN, a string a
    // caller guessed at) stays absent rather than becoming a classification input.
    if (typeof status === 'number' && Number.isInteger(status) && status > 0) this.status = status;
    // Same rule for the kind: only a value this module declares is adopted, so a provider
    // cannot smuggle an arbitrary string into a classification input.
    if (kind && MODEL_AVAILABILITY_FAILURE_KINDS.has(kind)) this.kind = kind;
  }
}

/**
 * The ways a provider call can fail without an HTTP status (AI-31).
 *
 *   network           `fetch` itself rejected: DNS, TLS, a refused or dropped socket.
 *   timeout           this layer's own clock ran out before a response arrived.
 *   invalid_response  a 2xx whose body could not be parsed as a JSON object.
 *
 * All three are availability facts about the assistant's path to the model. None of
 * them says *which* model is at fault, which is why they count but do not fail over.
 */
export type AiProviderFailureKind = 'network' | 'timeout' | 'invalid_response';

export const MODEL_AVAILABILITY_FAILURE_KINDS: ReadonlySet<AiProviderFailureKind> = new Set([
  'network',
  'timeout',
  'invalid_response',
]);

/**
 * The statuses that mean "this MODEL cannot answer", and are therefore worth a second
 * model (AI-29).
 *
 * WHY THESE AND NOT EVERYTHING. The measured incident was a 404 — the gateway routed to
 * an upstream that refused the call — and a dead upstream also surfaces as 5xx. What is
 * deliberately absent matters more than what is present: 400 is our request shape, 401
 * and 403 are credentials, and **402/429 are the account's allowance**, which every model
 * shares. Those four are exactly where a retry would spend the refusal a second time and
 * change nothing.
 */
export const MODEL_FAILOVER_STATUSES: ReadonlySet<number> = new Set([404, 410, 500, 502, 503, 504, 529]);

/**
 * True when a failure is best explained by the chosen model rather than by us.
 *
 * A transport failure is NOT one: another model would travel the same broken network.
 * A quota refusal never reaches here at all — it is an `AiQuotaExceeded`, not an
 * `AiProviderError` (AI-6) — which is what keeps the two rules from having to agree.
 */
export function isModelSpecificProviderFailure(err: unknown): boolean {
  if (!(err instanceof AiProviderError)) return false;
  return typeof err.status === 'number' && MODEL_FAILOVER_STATUSES.has(err.status);
}

/**
 * True when a failure is evidence that the assistant cannot serve a turn right now,
 * whether or not it is the model's own fault (AI-31).
 *
 * This is the BREAKER's question, and it is deliberately broader than the failover's:
 * a model-specific status counts, and so does a classified transport failure (see
 * `AiProviderFailureKind`). It is not broader in the other direction, though — a 400, a
 * 401/403, a quota refusal, a configuration error and a provider error that carries
 * neither a status nor a kind all stay out, because none of them is evidence that the
 * assistant is unavailable for a while.
 */
export function isModelAvailabilityFailure(err: unknown): boolean {
  if (isModelSpecificProviderFailure(err)) return true;
  if (!(err instanceof AiProviderError)) return false;
  return err.kind !== undefined && MODEL_AVAILABILITY_FAILURE_KINDS.has(err.kind);
}

/**
 * The AI gateway refused the call because a LIMIT was reached (AI-6).
 *
 * Deliberately NOT an AiProviderError, for the same reason AiTimeout is not one:
 * "the plan's allowance is spent" and "the service is broken" are different
 * facts. Measured on the hardware 2026-10-13 (§27BF), the dominant failure at this
 * tier is a `429 free-models-per-day` quota answer — and it used to reach the
 * member as `502 AI_UNAVAILABLE`, *"temporarily unavailable, please try again in
 * a moment"*, which is false twice over: nothing upstream is unavailable, and
 * retrying in a moment cannot help while a daily allowance is spent.
 *
 * Raised in two places, both of which mean the same thing: a 429/402 in providers/http.ts, and
 * AI-36's turn-level fail-fast when a refusal already reported ZERO remaining. Every other
 * non-2xx stays an AiProviderError on purpose: a 5xx really is an outage, and reclassifying one
 * as a limit would tell a member to wait for something that is broken. The converse direction
 * matters just as much: a rate limit is NOT retried by the turn loop, because AI-2's rule is that
 * a provider refusal is never answered by paying for it twice while the cause is hidden.
 */
export class AiQuotaExceeded extends Error {
  declare code: string;

  /**
   * AI-36 — what the response said about the allowance, when the refusal carried headers.
   *
   * Absent for a 429 whose headers published nothing, and for a refusal this application
   * synthesised. It exists so the turn loop can record the reading and, only when it says ZERO,
   * stop spending requests to rediscover an exhausted account.
   */
  quota?: QuotaInfo;

  constructor(message = 'The AI assistant has reached its usage limit. Please try again later.', quota?: QuotaInfo) {
    super(message);
    this.name = 'AiQuotaExceeded';
    this.code = AI_QUOTA_EXCEEDED;
    if (quota && (typeof quota.remaining === 'number' || typeof quota.limit === 'number')) {
      this.quota = quota;
    }
  }
}

/**
 * OPS-3 — this deployment's OWN daily paid-spend ceiling was reached.
 *
 * A SUBCLASS on purpose. Every existing `instanceof AiQuotaExceeded` check in the turn loop keeps
 * treating it as a quota refusal (never retried, never answered by paying twice), while the HTTP
 * layer can tell the member the specific fact: the assistant's daily AI spending limit, which
 * clears tomorrow. A provider's own 429 keeps the generic allowance sentence, because "wait for
 * your plan to reset" and "this deployment stopped spending for today" are different answers.
 */
export const AI_SPEND_LIMIT_MESSAGE =
  'The assistant has reached its daily AI spending limit. Please try again tomorrow.';

export class AiSpendLimitExceeded extends AiQuotaExceeded {
  // No message parameter: the sentence a member reads belongs to the HTTP mapper, so a throw site
  // cannot quietly change the client copy — and nothing here could observe the difference.
  constructor() {
    super(AI_SPEND_LIMIT_MESSAGE);
    this.name = 'AiSpendLimitExceeded';
  }
}

/**
 * One chat turn exceeded its own wall-clock deadline (AI-1).
 *
 * Deliberately NOT an AiProviderError: "we gave up waiting" and "the provider
 * failed" are different facts, need different client copy, and must not be
 * reported to a user as an unreachable server. The turn deadline in
 * ai.service.ts is what raises it.
 */
export class AiTimeout extends Error {
  declare code: string;

  constructor(message = 'The assistant took too long to answer. Please try again.') {
    super(message);
    this.name = 'AiTimeout';
    this.code = AI_TIMEOUT;
  }
}

/**
 * The caller went away before the answer existed (AI-1).
 *
 * Its own type so that an abandoned turn is not logged as a timeout and, above
 * all, is not turned into a 502 written to a socket nobody is reading. The 499
 * it maps to is the conventional nginx "client closed request" status, and it
 * exists here for the same reason the abort probe mattered: before AI-1 an
 * abandoned turn left no server-side trace at all, so a request the client had
 * given up on was indistinguishable from a response the client never asked for.
 */
export class AiAbandoned extends Error {
  declare code: string;

  constructor(message = 'The request was cancelled before the assistant answered.') {
    super(message);
    this.name = 'AiAbandoned';
    this.code = AI_ABANDONED;
  }
}

/**
 * The model spent its whole output budget (`AI_MAX_OUTPUT_TOKENS`) before producing
 * anything usable — no text, no tool call (AI-10).
 *
 * Deliberately NOT an AiProviderError, for the same reason AiTimeout, AiAbandoned and
 * AiQuotaExceeded are not: nothing upstream failed and nothing is unavailable. The
 * gateway answered 2xx with an empty body because the model was still working when it
 * hit its own cap, and the correct thing to tell the member is therefore *not* "try
 * again in a moment" — the same question spends the same budget again. It is the one
 * class the controller maps to its own sentence, and the one that used to arrive as a
 * provider outage: measured twice on the 50 000-product tenant 2026-10-16 (§27BG Q4,
 * §27CK) at 31 421 ms and 31 789 ms, with the turn's tool already run and answered.
 */
export class AiOutputLimit extends Error {
  declare code: string;

  /** The model whose output budget was spent, when the wire named one. */
  model?: string;

  /** What it burned before it ran out of room, when the gateway reported it. */
  usage?: { inputTokens: number; outputTokens: number } | null;

  constructor(
    message = 'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.',
    accounting: AiErrorAccounting = {},
  ) {
    super(message);
    this.name = 'AiOutputLimit';
    this.code = AI_OUTPUT_LIMIT;
    // Adopted only when present: an absent report stays absent rather than becoming
    // a zero, so a turn line can never present "not measured" as "cost nothing".
    if (typeof accounting.model === 'string' && accounting.model) this.model = accounting.model;
    if (accounting.usage) this.usage = accounting.usage;
  }
}

/**
 * The accounting a failure may know: the model it happened on and the tokens spent.
 *
 * A shape rather than an import, so this module keeps depending on nothing — the
 * neutral `ProviderUsage` it mirrors is structurally identical, and the service
 * assigns it straight back into its own usage variable.
 */
export interface AiErrorAccounting {
  model?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

/**
 * Read whatever accounting an error carries, and nothing else.
 *
 * Deliberately defensive about the two known fields and silent about everything
 * else: these values end up in a log line, so a malformed one must be dropped
 * rather than printed. Undefined fields stay undefined, so a failure that knows
 * nothing cannot make the service's counters look measured.
 */
export function aiErrorAccounting(err: unknown): AiErrorAccounting {
  const e = err as { model?: unknown; usage?: unknown } | null | undefined;
  const out: AiErrorAccounting = {};
  if (typeof e?.model === 'string' && e.model) out.model = e.model;
  const raw = e?.usage as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
  if (raw && typeof raw.inputTokens === 'number' && typeof raw.outputTokens === 'number') {
    out.usage = { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
  }
  return out;
}

/**
 * True for every error the AI layer raises on purpose. ai.service.ts uses this to
 * let its own failures through its provider-failure catch untouched — which is
 * what keeps an AiTimeout an AiTimeout rather than a 502.
 */
export function isAiError(err: unknown) {
  return (
    err instanceof AiNotConfigured ||
    err instanceof AiProviderError ||
    err instanceof AiQuotaExceeded ||
    err instanceof AiTimeout ||
    err instanceof AiAbandoned ||
    err instanceof AiOutputLimit
  );
}

export default {
  AiNotConfigured,
  AiProviderError,
  MODEL_FAILOVER_STATUSES,
  MODEL_AVAILABILITY_FAILURE_KINDS,
  isModelSpecificProviderFailure,
  isModelAvailabilityFailure,
  AiQuotaExceeded,
  AiTimeout,
  AiAbandoned,
  AiOutputLimit,
  AI_NOT_CONFIGURED,
  AI_UNAVAILABLE,
  AI_QUOTA_EXCEEDED,
  AI_TIMEOUT,
  AI_ABANDONED,
  AI_OUTPUT_LIMIT,
  isAiError,
  aiErrorAccounting,
};
