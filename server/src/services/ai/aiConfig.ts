/**
 * AI configuration, read lazily from environment variables at call time.
 *
 * Reading process.env on every access (rather than caching at module load)
 * lets node:test switch AI_PROVIDER between test files, and means a missing
 * AI key or a bad provider name can never prevent the server from booting —
 * chat simply fails with a clean 503 until an operator fixes the config.
 *
 * Every value here lives server-side only. Nothing in this module is ever
 * sent to the mobile application or to the AI provider's training process.
 */

function positiveInt(raw: string | undefined, fallback: number) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like `positiveInt`, but 0 is a meaningful value (0 = disabled). */
function nonNegativeInt(raw: string | undefined, fallback: number) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * AI-29 — the most candidates one turn may ever attempt.
 *
 * A bound, not a preference: the list is operator-supplied configuration, and a turn's extra
 * requests must be capped by something that is not the configuration itself. Five is the
 * documented candidate set, so a longer list is truncated rather than trusted.
 */
export const MAX_FALLBACK_MODELS = 5;

/**
 * `a, b ,,a` -> five models, with anything past the cap RETURNED rather than dropped silently.
 *
 * AI-39 — the cap used to truncate with no message, so a pasted sixth id looked configured and
 * was never used. The ignored ids are reported separately (they are not deduplicated duplicates:
 * a repeat is harmless, a truncated candidate is a configuration mistake worth a warning).
 */
function parseModelList(raw: string | undefined): { models: string[]; ignored: string[] } {
  const seen = new Set<string>();
  const models: string[] = [];
  const ignored: string[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (models.length >= MAX_FALLBACK_MODELS) {
      ignored.push(id);
      continue;
    }
    models.push(id);
  }
  return { models, ignored };
}

export function aiConfig() {
  const fallbacks = parseModelList(process.env.AI_FALLBACK_MODELS_OPENROUTER);
  return {
    // Provider + keys (keys are read here but never returned/logged).
    provider: (process.env.AI_PROVIDER || '').trim().toLowerCase(),
    // AI-25 — the direct Claude and Gemini models were removed with their providers. A model
    // is still a choice here, and a wide one: OpenRouter reaches both families (and many
    // others) through `AI_MODEL_OPENROUTER`, so flexibility lives in one variable rather than
    // in two code paths and two more keys.
    //
    // OpenRouter is an Anthropic-compatible gateway (see openrouterProvider.ts).
    // No default model on purpose: OpenRouter fronts hundreds of models with very
    // different tool-calling ability, so the model is REQUIRED — the provider
    // factory refuses to build without it rather than silently guessing one here.
    openrouterModel: (process.env.AI_MODEL_OPENROUTER || '').trim(),
    // AI-29 — the candidate models a turn fails over to, in preference order, when the
    // configured model's upstream refuses the call (a 404/410 or 5xx, never a quota
    // refusal). Comma-separated; optional on purpose, because unset means "no failover",
    // which is a supported deployment and leaves every turn exactly as it was.
    //
    // Parsed here rather than at use so the shape is stated once: trimmed, empties dropped,
    // duplicates collapsed (paying for the same model twice is not a second attempt) and
    // capped, so a pasted catalogue cannot turn one turn into an unbounded sweep. The
    // service removes the primary and any candidate the catalogue says cannot call tools.
    fallbackModels: fallbacks.models,
    /** AI-39 — candidates past the five-model cap, named so a boot warning can point at them. */
    fallbackModelsIgnored: fallbacks.ignored,

    // AI-31 — how many consecutive model-specific failures make a model temporarily
    // unhealthy, and how long it is then left out of selection. Both are operator-owned
    // configuration: a deployment that wants a jumpier or calmer policy edits `.env`, not
    // this file. The defaults are the documented policy (5 failures, 30 s); a value that is
    // not a positive integer falls back to the default rather than disabling the breaker.
    modelFailureThreshold: positiveInt(process.env.AI_MODEL_FAILURE_THRESHOLD, 5),
    modelCooldownMs: positiveInt(process.env.AI_MODEL_COOLDOWN_MS, 30000),
    // AI-35 — how long the provider's OWN health reading holds a model out of selection. One
    // watchdog interval (30 min) plus a minute, so the next reading releases the model rather
    // than the clock: a reading is a claim about right now, and it should be replaced by fresher
    // evidence, not expire into an unverified guess between checks.
    modelHealthTtlMs: positiveInt(process.env.AI_MODEL_HEALTH_TTL_MS, 31 * 60 * 1000),
    // AI-36 — how long a refusal that reported ZERO remaining stops further provider calls. Long
    // enough to stop a burst of turns each paying a round-trip to be refused, short enough that a
    // reading which is already stale (the allowance reset, another key was added) costs at most
    // this much. A success lifts it immediately, whatever this says.
    quotaBlockMs: positiveInt(process.env.AI_QUOTA_BLOCK_MS, 30_000),
    // AI-38 — how long ONE attempt may take while another candidate remains. 0 (the default)
    // disables it, because the correct value is a measurement rather than a guess: the last
    // attempt always keeps the whole remaining budget, so an enabled cap only ever cuts short a
    // model there was an alternative to. Enable with a value above the slowest legitimate answer
    // measured on the deployment (5.3–19.4 s on the free tier, §27DZ/§27EA), e.g. 25000.
    attemptMaxMs: nonNegativeInt(process.env.AI_ATTEMPT_MAX_MS, 0),
    openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || '').trim(),
    // PAID TOOL GATE. OpenRouter's web plugin is billed separately (about $0.007 per
    // search through Exa) even when the model id ends in \`:free\`. The free-model
    // allowance does not cover it, so it is OFF by default. Review research then uses
    // the keyless HTML result fallback; price research reports unavailable instead of
    // spending credits. Set AI_ALLOW_PAID_WEB_SEARCH=true only with owner approval.
    allowPaidWebSearch: (process.env.AI_ALLOW_PAID_WEB_SEARCH || '').trim().toLowerCase() === 'true',

    // Cost / rate protection (V1). See SYSTEM_SPECIFICATION.md §25.
    maxMessageChars: positiveInt(process.env.AI_MAX_MESSAGE_CHARS, 4000),
    // AI-20 — raised from 800 to 1200 on 2026-10-19, on device evidence rather than taste.
    //
    // The cap exists so a runaway answer cannot spend the turn's whole budget (AI-8), and it
    // worked — but three device turns on the deployed free-tier model hit 800 EXACTLY, and two
    // of them were already obeying AI-18's "at most five items": a five-row movement table with
    // its intro is ~900–1000 tokens in this model's own wording, so the answer was cut off at
    // row three of five while doing what it was told. The cap is not what makes an answer short
    // — the prompt is — so it is set above the largest compliant answer observed instead of
    // inside it. Output tokens are not what the free tier meters (requests are), but they do
    // cost generation time, which is why this is 1200 and not unlimited: the AI-1 turn deadline
    // still bounds the turn, and a longer answer now has further to run before it is saved.
    maxOutputTokens: positiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 1200),
    // AI-54 — hidden reasoning is turned OFF on the Anthropic-compatible wire by default.
    //
    // WHY. The 2026-11-04 device run could not explain why a 1,200-token answer came back
    // at 154 words with `degraded=OUTPUT_LIMIT`, so the provider was measured directly on
    // the same endpoint and model the assistant uses. With `max_tokens: 400` and a question
    // needing one short paragraph, the response was `stop_reason: max_tokens`,
    // `output_tokens: 400`, `output_tokens_details.thinking_tokens: 400`, and its only
    // content block was `thinking` (1,827 characters). The whole budget went to reasoning
    // and NO answer was produced — in 3.8 s. Repeating the same request with
    // `thinking: { type: 'disabled' }` returned a 213-character answer in 43 output tokens
    // and 0.8 s, and a tool round still chose `findProducts` correctly in 0.76 s.
    //
    // So the failures recorded as AI-10 (`OUTPUT_LIMIT`), AI-12 (empty completion) and the
    // AI-52/53 retries were not the cap being too small: on this model the reasoning shares
    // the SAME budget as the answer, and at 1,200 it routinely left only a few hundred
    // tokens for the visible text — occasionally none. Raising the cap would have bought
    // time rather than correctness, and paid for it in latency.
    //
    // A bounded budget (`thinking: { type: 'enabled', budget_tokens }`) also works on this
    // gateway (measured: 58 thinking tokens with a 400 budget), but tool rounds then require
    // the thinking blocks to be replayed in the assistant turn, which this wire does not do
    // yet, so a budget above zero is not offered as a supported setting.
    //
    // Set AI_THINKING_DISABLED=false only to restore the provider's own default (its
    // extended thinking on, if it has any) for an experiment; everything else, including an
    // empty or malformed value, keeps it off.
    thinkingDisabled: (process.env.AI_THINKING_DISABLED || '').trim().toLowerCase() !== 'false',
    maxToolIterations: positiveInt(process.env.AI_MAX_TOOL_ITERATIONS, 6),
    // AI-2 — how many times a turn retries a provider response that carries NO
    // usable content (neither text nor a tool call). The deployed free-tier gateway
    // returned one in roughly three turns out of five on 2026-10-12 (§27BE), and the
    // turn used to be handed to the user as a canned 201 sentence with nothing
    // recorded anywhere. Minimum 1. The retry consumes iterations from
    // maxToolIterations and is clamped by turnDeadlineMs like any other call, so it
    // can neither extend a turn nor run unbounded.
    emptyRetryMax: positiveInt(process.env.AI_EMPTY_RETRY_MAX, 1),
    maxToolResultChars: positiveInt(process.env.AI_MAX_TOOL_RESULT_CHARS, 12000),
    contextMessages: positiveInt(process.env.AI_CONTEXT_MESSAGES, 20),
    requestTimeoutMs: positiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000),
    // One wall-clock budget for a WHOLE chat turn, across every provider call and
    // tool round (AI-1). Without it a turn's ceiling was the PRODUCT of
    // requestTimeoutMs and maxToolIterations and was stated nowhere, while the
    // mobile client aborted at a fixed 15000ms — so a slow-but-successful answer
    // was killed by the phone and reported as "cannot reach the server".
    // ai.service.ts derives ONE absolute deadline from this and clamps each call
    // to the time remaining, so the loop can never exceed it.
    turnDeadlineMs: positiveInt(process.env.AI_TURN_DEADLINE_MS, 60000),
    rateLimitWindowMs: positiveInt(process.env.AI_RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: positiveInt(process.env.AI_RATE_LIMIT_MAX, 20),
  };
}

export default { aiConfig };
