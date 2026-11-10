/**
 * AI-55 / AI-100 — reasoning is configured per model class, with optional per-model rules.
 *
 * AI-54 disabled reasoning globally, which is correct for the free chain but wrong for a model
 * that REQUIRES it. OpenRouter answers such a model with:
 *
 *   invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be disabled."
 *
 * `openai/gpt-oss-*` is one of them, so switching `AI_MODEL_OPENROUTER` to a paid gpt-oss id was
 * enough to break every turn. `AI_REASONING_PAID_MODELS` makes the choice explicit without a source change:
 * `enable` sends no reasoning field (the model's own default), and `disable` sends
 * `thinking: { type: 'disabled' }` (the AI-54 behaviour).
 *
 * FREE MODELS HAVE THEIR OWN SWITCH. A paid gpt-oss primary needs `AI_REASONING_PAID_MODELS=enable`, but the
 * simple inventory route starts on a `:free` fallback that should spend its output budget on the
 * answer. `AI_REASONING_FREE_MODELS` governs every id ending in `:free`, defaults to `disable`,
 * and is resolved before the paid policy and advanced rules. It never inherits `AI_REASONING_PAID_MODELS`.
 *
 * ADVANCED. `AI_REASONING_MODELS_OPENROUTER` is an ordered list of `pattern=mode` rules and
 * `AI_REASONING_DEFAULT` is the fallback. When `AI_REASONING_PAID_MODELS` is set, it deliberately overrides
 * both for PAID models, so one value applies to the primary and every paid failover candidate.
 * The rules remain supported for deployments that need a different paid-model policy.
 *
 * MODES.
 *   `off`       ask the gateway to disable reasoning. The AI-54 default: the answer owns the
 *               whole output budget.
 *   `auto`      send no reasoning field and let the model use its own default. The correct
 *               value for a mandatory-reasoning model.
 *   `budget:N`  allow up to N reasoning tokens (N >= 1024 and below `AI_MAX_OUTPUT_TOKENS`).
 *
 * An unrecognised value never changes behaviour silently: it is returned in `ignored` (or
 * `defaultProblem`/`simpleProblem`/`freeProblem`) so `npm run ai:check` can name it, while the
 * safe default still applies. The two simple switches accept only `enable` or `disable`.
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
  /** Set when `AI_REASONING_PAID_MODELS` (or its deprecated `AI_REASONING` fallback) is valid. */
  simplePolicy: ReasoningPolicy | null;
  /** Set when the paid switch is present but is not enable/disable. */
  simpleProblem: string | null;
  /** The paid switch actually supplying `simplePolicy`, or `advanced` when it is unset. */
  paidSource: 'AI_REASONING_PAID_MODELS' | 'AI_REASONING' | 'advanced';
  /**
   * The policy for any model whose id ends in `:free`. This is independent of
   * `AI_REASONING_PAID_MODELS`: a paid model may require reasoning while a free fallback must not
   * spend its answer budget reasoning. Unset means `off`; it never inherits a paid
   * model's setting.
   */
  freePolicy: ReasoningPolicy;
  /** Where `freePolicy` came from, for logs and `ai:check`. */
  freeSource: 'AI_REASONING_FREE_MODELS' | 'default';
  /** Set when `AI_REASONING_FREE_MODELS` is present but is not enable/disable. */
  freeProblem: string | null;
  defaultPolicy: ReasoningPolicy;
  /** Set when `AI_REASONING_DEFAULT` was present but unusable. */
  defaultProblem: string | null;
}

export interface ResolvedReasoningPolicy {
  policy: ReasoningPolicy;
  source: 'paid' | 'model' | 'default' | 'free';
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
 * `AI_REASONING_PAID_MODELS` / `AI_REASONING_FREE_MODELS` -> the simple switch policy, or null when
 * the value is not exactly enable or disable.
 *
 * The two documented values map to the same modes the advanced rules use (`enable` -> auto,
 * `disable` -> off). Boolean and convenience spellings are deliberately REJECTED: a typo
 * must fail `ai:check` and production validation rather than silently enabling reasoning.
 */
export function parseSimpleReasoning(raw: string | undefined | null): ReasoningPolicy | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'enable') return { mode: 'auto' };
  if (value === 'disable') return { mode: 'off' };
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
 * The simple `AI_REASONING_PAID_MODELS` switch wins when present and valid. It returns early with empty
 * advanced rules, so a stale `AI_REASONING_MODELS_OPENROUTER` cannot override the one setting the
 * operator chose. When it is absent, the advanced rules/default apply; when it is invalid, the
 * value is reported in `simpleProblem` and the advanced/default path still supplies a safe
 * policy. Legacy `AI_THINKING_DISABLED=false` keeps its old meaning when no new default is set.
 */
export function reasoningSettings(env: Record<string, string | undefined> = process.env): ReasoningSettings {
  const configuredPaid = (env.AI_REASONING_PAID_MODELS ?? '').trim();
  const configuredLegacy = (env.AI_REASONING ?? '').trim();
  const paidVariable = configuredPaid
    ? 'AI_REASONING_PAID_MODELS'
    : configuredLegacy
      ? 'AI_REASONING'
      : null;
  const configuredSimple = configuredPaid || configuredLegacy;
  const simplePolicy = configuredSimple ? parseSimpleReasoning(configuredSimple) : null;
  const simpleProblem =
    configuredSimple && !simplePolicy
      ? `${paidVariable} must be enable or disable; using the existing reasoning settings.`
      : null;
  const paidSource: ReasoningSettings['paidSource'] = simplePolicy
    ? paidVariable ?? 'advanced'
    : 'advanced';

  const configuredFree = (env.AI_REASONING_FREE_MODELS ?? '').trim();
  const configuredFreePolicy = configuredFree ? parseSimpleReasoning(configuredFree) : null;
  const freeProblem =
    configuredFree && !configuredFreePolicy
      ? 'AI_REASONING_FREE_MODELS must be enable or disable; free models use reasoning off.'
      : null;
  const freePolicy: ReasoningPolicy = configuredFreePolicy ?? { mode: 'off' };
  const freeSource: ReasoningSettings['freeSource'] =
    configuredFreePolicy ? 'AI_REASONING_FREE_MODELS' : 'default';

  if (simplePolicy) {
    return {
      rules: [],
      ignored: [],
      defaultPolicy: simplePolicy,
      defaultProblem: null,
      simplePolicy,
      simpleProblem: null,
      paidSource,
      freePolicy,
      freeSource,
      freeProblem,
    };
  }

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

  return {
    rules,
    ignored,
    defaultPolicy,
    defaultProblem,
    simplePolicy: null,
    simpleProblem,
    paidSource,
    freePolicy,
    freeSource,
    freeProblem,
  };
}

/** The first rule naming this model, else the default. */
export function resolveReasoningPolicy(
  model: string,
  settings: ReasoningSettings,
): ResolvedReasoningPolicy {
  const id = String(model ?? '').trim();
  // Free models have their own switch. It is deliberately checked BEFORE the paid-model
  // simple policy: AI_REASONING_PAID_MODELS=enable is required by gpt-oss paid models, and must not
  // silently enable hidden reasoning on the free fallback that answers a simple read.
  if (isFreeModel(id)) return { policy: settings.freePolicy, source: 'free' };
  if (settings.simplePolicy) return { policy: settings.simplePolicy, source: 'paid' };

  if (id) {
    for (const rule of settings.rules) {
      if (reasoningPatternMatches(rule.pattern, id)) {
        return { policy: rule.policy, source: 'model' };
      }
    }
  }
  return { policy: settings.defaultPolicy, source: 'default' };
}

/** True for an OpenRouter free endpoint (`:free` suffix), case-insensitively. */
export function isFreeModel(model: string | null | undefined): boolean {
  return /:free$/i.test(String(model ?? '').trim());
}

/** The operator-facing state: `off` is disabled, every other mode lets reasoning run. */
export function reasoningState(policy: ReasoningPolicy): 'enabled' | 'disabled' {
  return policy.mode === 'off' ? 'disabled' : 'enabled';
}

/** Strict problems for the two simple reasoning switches, named for production validation. */
export function reasoningConfigProblems(
  env: Record<string, string | undefined> = process.env,
): Array<{ variable: string; message: string }> {
  const problems: Array<{ variable: string; message: string }> = [];
  const paidNew = (env.AI_REASONING_PAID_MODELS ?? '').trim();
  const paidLegacy = (env.AI_REASONING ?? '').trim();
  const paid = paidNew || paidLegacy;
  if (paid && !parseSimpleReasoning(paid)) {
    problems.push({
      variable: paidNew ? 'AI_REASONING_PAID_MODELS' : 'AI_REASONING',
      message: `${paidNew ? 'AI_REASONING_PAID_MODELS' : 'AI_REASONING'} must be enable or disable`,
    });
  }
  const free = (env.AI_REASONING_FREE_MODELS ?? '').trim();
  if (free && !parseSimpleReasoning(free)) {
    problems.push({
      variable: 'AI_REASONING_FREE_MODELS',
      message: 'AI_REASONING_FREE_MODELS must be enable or disable',
    });
  }
  return problems;
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
  parseSimpleReasoning,
  parseReasoningRules,
  reasoningPatternMatches,
  reasoningSettings,
  resolveReasoningPolicy,
  isFreeModel,
  reasoningState,
  reasoningConfigProblems,
  thinkingFieldFor,
  describeReasoningPolicy,
};
