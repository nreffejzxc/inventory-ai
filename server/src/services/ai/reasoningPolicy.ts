/**
 * AI-55 — reasoning is a PER-MODEL setting, resolved from the environment at request time.
 *
 * WHY THIS EXISTS. AI-54 measured that hidden reasoning shares `max_tokens` with the answer on
 * this gateway, so the assistant asked for it to be OFF — for every model, in one global flag.
 * That is correct for the free chain (a 400-token budget once went 400/400 to `thinking` and
 * produced no answer), but it is wrong for models that REQUIRE reasoning. OpenRouter refuses
 * such a model with:
 *
 *   invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be disabled."
 *
 * `openai/gpt-oss-*` is one of them, so switching `AI_MODEL_OPENROUTER` to a paid gpt-oss id was
 * enough to break every turn even though the model itself was fine. There is no global value
 * that suits both families, so the setting is chosen per model.
 *
 * CONFIGURATION, NOT CODE. `AI_REASONING_MODELS_OPENROUTER` is an ordered list of
 * `pattern=mode` rules; `AI_REASONING_DEFAULT` is the fallback. Adding a model of either kind
 * is one `.env` line, and because the rule is resolved from the model the REQUEST names, a
 * failover candidate gets its own policy — the two mechanisms cannot disagree.
 *
 * MODES.
 *   `off`       ask the gateway to disable reasoning. The AI-54 default: the answer owns the
 *               whole output budget.
 *   `auto`      send no reasoning field and let the model use its own default. The correct
 *               value for a mandatory-reasoning model.
 *   `budget:N`  allow up to N reasoning tokens (N >= 1024 and below `AI_MAX_OUTPUT_TOKENS`).
 *               Useful for a signed-reasoning model; see the replay note in `anthropicWire.ts`.
 *
 * An unrecognised value never changes behaviour silently: it is returned in `ignored` (or
 * `defaultProblem`) so `npm run ai:check` can name it, while the safe default still applies.
 */

export type ReasoningMode = 'off' | 'auto' | 'budget';

export interface ReasoningPolicy {
  mode: ReasoningMode;
  /** Only for `budget`: the most tokens the model may spend reasoning. */
  budgetTokens?: number;
}

export interface ReasoningRule {
  pattern: string;
  policy: ReasoningPolicy;
}

export interface ReasoningSettings {
  rules: ReasoningRule[];
  /** Rule entries that could not be parsed, verbatim, for an operator-facing warning. */
  ignored: string[];
  defaultPolicy: ReasoningPolicy;
  /** Set when `AI_REASONING_DEFAULT` was present but unusable. */
  defaultProblem: string | null;
}

export interface ResolvedReasoningPolicy {
  policy: ReasoningPolicy;
  source: 'model' | 'default';
}

/** Anthropic's documented floor for `budget_tokens`; below it the gateway refuses the request. */
export const MIN_REASONING_BUDGET = 1024;

/**
 * One mode value -> a policy, or null when the value is not a mode this module understands.
 *
 * `false`/`true` are accepted as aliases because `AI_THINKING_DISABLED` used booleans, and an
 * operator moving an old value across should not have to relearn the spelling.
 */
export function parseReasoningPolicy(raw: string | undefined | null): ReasoningPolicy | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'off' || value === 'disabled' || value === 'none' || value === 'false') {
    return { mode: 'off' };
  }
  if (value === 'auto' || value === 'default' || value === 'on' || value === 'true') {
    return { mode: 'auto' };
  }
  const budget = /^(?:budget|budget_tokens|enabled)[:=](\d+)$/.exec(value);
  if (budget) {
    const tokens = Number.parseInt(budget[1] ?? '', 10);
    if (Number.isFinite(tokens) && tokens >= MIN_REASONING_BUDGET) {
      return { mode: 'budget', budgetTokens: tokens };
    }
  }
  return null;
}

/**
 * `openai/gpt-oss-*=auto, * = off` -> ordered rules plus anything that did not parse.
 *
 * First match wins, so specificity is the operator's ordering decision rather than a rule this
 * module tries to infer. Duplicate patterns keep the first and are not reported: the second
 * could never run, which is harmless rather than a configuration mistake worth a warning.
 */
export function parseReasoningRules(raw: string | undefined | null): {
  rules: ReasoningRule[];
  ignored: string[];
} {
  const rules: ReasoningRule[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const entry of String(raw ?? '').split(',')) {
    const text = entry.trim();
    if (!text) continue;
    const at = text.indexOf('=');
    if (at <= 0) {
      ignored.push(text);
      continue;
    }
    const pattern = text.slice(0, at).trim();
    const policy = parseReasoningPolicy(text.slice(at + 1));
    if (!pattern || /\s/.test(pattern) || !policy) {
      ignored.push(text);
      continue;
    }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    rules.push({ pattern, policy });
  }
  return { rules, ignored };
}

/** A model id or glob (`*` only) -> does it name this model? Case-insensitive. */
export function reasoningPatternMatches(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(model);
}

/**
 * The environment as one settings object.
 *
 * `AI_REASONING_DEFAULT` wins when set. When it is unset, the legacy `AI_THINKING_DISABLED`
 * keeps its old meaning — only an explicit `false` restores the model's own default — so an
 * existing deployment that never adopted the new variable behaves exactly as it did after AI-54.
 */
export function reasoningSettings(env: Record<string, string | undefined> = process.env): ReasoningSettings {
  const { rules, ignored } = parseReasoningRules(env.AI_REASONING_MODELS_OPENROUTER);
  const configuredDefault = (env.AI_REASONING_DEFAULT ?? '').trim();
  let defaultPolicy: ReasoningPolicy = { mode: 'off' };
  let defaultProblem: string | null = null;

  if (configuredDefault) {
    const parsed = parseReasoningPolicy(configuredDefault);
    if (parsed) defaultPolicy = parsed;
    else {
      defaultProblem =
        'AI_REASONING_DEFAULT must be off, auto or budget:<tokens> (at least 1024); using off.';
    }
  } else if ((env.AI_THINKING_DISABLED ?? '').trim().toLowerCase() === 'false') {
    defaultPolicy = { mode: 'auto' };
  }

  return { rules, ignored, defaultPolicy, defaultProblem };
}

/** The first rule naming this model, else the default. */
export function resolveReasoningPolicy(
  model: string,
  settings: ReasoningSettings,
): ResolvedReasoningPolicy {
  const id = String(model ?? '').trim();
  if (id) {
    for (const rule of settings.rules) {
      if (reasoningPatternMatches(rule.pattern, id)) {
        return { policy: rule.policy, source: 'model' };
      }
    }
  }
  return { policy: settings.defaultPolicy, source: 'default' };
}

/**
 * The request field for a policy, or `{}` when the field must be omitted.
 *
 * A `budget` that cannot fit under the output cap is omitted rather than sent: Anthropic
 * requires `budget_tokens < max_tokens`, and a request that the gateway rejects is worse than
 * one that lets the model use its default. This can only happen when the operator set a budget
 * at or above `AI_MAX_OUTPUT_TOKENS`; the guide says to keep the cap above it.
 */
export type ThinkingRequestField =
  | { thinking: { type: 'disabled' } }
  | { thinking: { type: 'enabled'; budget_tokens: number } }
  | Record<string, never>;

export function thinkingFieldFor(policy: ReasoningPolicy, maxOutputTokens: number): ThinkingRequestField {
  if (policy.mode === 'off') return { thinking: { type: 'disabled' } };
  if (policy.mode === 'budget') {
    const budget = policy.budgetTokens ?? 0;
    if (budget >= MIN_REASONING_BUDGET && budget < maxOutputTokens) {
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    }
  }
  return {};
}

/** One short, operator-facing label (`off`, `auto`, `budget 1024`). */
export function describeReasoningPolicy(policy: ReasoningPolicy): string {
  return policy.mode === 'budget' ? `budget ${policy.budgetTokens ?? 0}` : policy.mode;
}

export default {
  parseReasoningPolicy,
  parseReasoningRules,
  reasoningPatternMatches,
  reasoningSettings,
  resolveReasoningPolicy,
  thinkingFieldFor,
  describeReasoningPolicy,
};
