/**
 * Cost guards for the manual live AI evaluation scripts.
 *
 * WHY THIS EXISTS. A free model is not a free turn. OpenRouter's web plugin is
 * billed separately (currently about $0.007 per search through Exa), even when
 * the model id ends in `:free`, and that charge is not part of the free-model
 * daily request allowance. The live evaluations must never spend either kind of
 * credit unless the owner has explicitly approved it.
 *
 * These functions are imported only by `eval-ai-stress.mjs` and
 * `eval-ai48.mjs`. They are not a production guard and do not change the
 * assistant's configured model or the web-research implementation.
 */

const MODEL_ENV_VARS = [
  'AI_MODEL_OPENROUTER',
  'AI_FALLBACK_MODELS_OPENROUTER',
  'AI_WEB_RESEARCH_MODEL',
  'AI_WEB_PRICE_MODEL',
];

export const PAID_MODELS_APPROVAL_ENV = 'AI_TEST_ALLOW_PAID_MODELS';
export const PAID_SEARCH_APPROVAL_ENV = 'AI_TEST_ALLOW_PAID_SEARCH';

/** Every model id the live process could select, including ordered fallbacks. */
export function configuredModelIds(env = process.env) {
  return MODEL_ENV_VARS.flatMap((name) =>
    String(env[name] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Refuse a live evaluation unless every configured model is a free endpoint.
 * `:free` is OpenRouter's explicit zero-price variant; a display name or a
 * paid model with a similar name is not accepted.
 */
export function assertFreeTestingModels({ env = process.env, allowPaid } = {}) {
  const models = configuredModelIds(env);
  const nonFree = models.filter((id) => !id.endsWith(':free'));
  const approved = allowPaid ?? env[PAID_MODELS_APPROVAL_ENV] === 'true';
  if (nonFree.length && !approved) {
    throw new Error(
      `Refusing live test: non-free model(s) configured (${nonFree.join(', ')}). ` +
        `Set ${PAID_MODELS_APPROVAL_ENV}=true only after the owner explicitly approves paid models.`,
    );
  }
  return models;
}

/**
 * Refuse questions that will invoke OpenRouter's paid web plugin unless that
 * separate charge has been approved. Free-model approval is deliberately not
 * enough: the model can be free while every search still costs credits.
 */
export function assertPaidSearchApproved({ labels = [], env = process.env, allowPaid } = {}) {
  if (labels.length === 0) return;
  const approved = allowPaid ?? env[PAID_SEARCH_APPROVAL_ENV] === 'true';
  if (approved) return;
  throw new Error(
    `Refusing live test: ${labels.join(', ')} use OpenRouter web search, which is billed at about ` +
      '$0.007 per search even when the model is free. Set ' +
      `${PAID_SEARCH_APPROVAL_ENV}=true only after the owner explicitly approves that charge.`,
  );
}
