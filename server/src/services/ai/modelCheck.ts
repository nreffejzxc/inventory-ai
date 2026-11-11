/**
 * AI-28 — is the configured model one the provider will actually answer with?
 *
 * WHY THIS EXISTS. On 2026-10-21 every assistant turn failed with `502 AI_UNAVAILABLE` and the
 * server's own log could not name the model that failed:
 *
 *   AI provider openrouter upstream HTTP 404
 *   bodyPrefix="… not_found_error … Function '<uuid>': Not found for account '<uuid>' … provider_name":"Nvidia" …"
 *   AI turn outcome=AI_UNAVAILABLE … calls=1 … model=unknown iterations=1
 *
 * Two separate blind spots produced that. A wrong or withdrawn model was only discoverable when a
 * member asked a question, and the turn line then said `unknown` at the one moment its `model=`
 * field mattered. This module closes the first; `ai.service` and the provider contract close the
 * second.
 *
 * TWO QUESTIONS, DELIBERATELY KEPT APART.
 *
 *   `checkModelCatalogue` — "is the configured id one the gateway still lists?" It reads
 *   `GET {base}/v1/models` and compares ids. **It spends no completion quota**, which is why it can
 *   run at boot and in CI on a free tier metered by requests rather than tokens (AI-6).
 *
 *   `probeModel` — "does this model answer a real, tool-shaped request?" It sends ONE Anthropic-shape
 *   message with one tool definition and reads the status. This is the check that would have caught
 *   the incident, because the gateway still LISTED the broken model: only a completion revealed
 *   that its upstream refused every call. It costs one request, so it is never automatic — it runs
 *   when an operator asks (`npm run ai:check --probe`) and after a model change.
 *
 * WHAT NEITHER OF THEM DOES. Neither retries, neither changes a model, neither stores anything, and
 * neither throws. A boot check that can crash a deployment is worse than no check, so every failure
 * is a status; a network error is `unreachable` rather than a claim about the model, and a 429 is
 * `quota` rather than `unusable`, because a spent allowance says nothing about the id and telling an
 * operator otherwise sends them to change a working configuration.
 *
 * NO CREDENTIAL LEAVES THIS MODULE. The key travels in the request header only; results carry a
 * status, the model id and a fixed sentence, and are safe to log.
 */

import {
  reasoningSettings,
  resolveReasoningPolicy,
  thinkingFieldFor,
} from './reasoningPolicy.ts';

/** The statuses `checkModelCatalogue` can return. */
export type CatalogueStatus = 'ok' | 'missing' | 'unreachable' | 'not_applicable';

/** The statuses `probeModel` can return. `quota` is deliberately not `unusable`. */
export type ProbeStatus = 'usable' | 'unusable' | 'quota' | 'unreachable' | 'not_applicable';

/** The statuses `readModelHealth` can return. */
export type ModelHealthStatus = 'ok' | 'not_found' | 'no_endpoints' | 'unreachable' | 'not_applicable';

/** One provider endpoint, reduced to the facts an operator chooses a model by. */
export interface EndpointHealth {
  provider: string;
  /** The provider's own health code (0 is healthy); null when it did not publish one. */
  status: number | null;
  uptime5m: number | null;
  uptime30m: number | null;
  uptime1d: number | null;
}

export interface ModelHealthResult {
  status: ModelHealthStatus;
  model: string;
  message: string;
  /** Every endpoint the provider published, in its own order. */
  endpoints: EndpointHealth[];
  /** The HTTP status the read saw, for an operator; absent when nothing was sent. */
  httpStatus?: number;
}

export interface CatalogueResult {
  status: CatalogueStatus;
  model: string;
  message: string;
}

export interface ProbeResult {
  status: ProbeStatus;
  model: string;
  message: string;
  /** The HTTP status the probe saw, for an operator; absent when nothing was sent. */
  httpStatus?: number;
}

interface CheckOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * The model to check instead of the configured one (AI-29).
   *
   * Used to prove that the FALLBACK model can answer a tool-shaped request before the day
   * it is needed — a fallback that cannot call tools is worse than none, because it would
   * answer an inventory question without reading the inventory.
   */
  model?: string;
}

/** The model a configured OpenRouter deployment would send. */
function configuredModel(env: Record<string, string | undefined>): string {
  return (env.AI_MODEL_OPENROUTER || '').trim();
}

/** `{base}/v1/<rest>`, tolerating a trailing slash and a base that already names the API root. */
function endpoint(base: string, rest: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${rest}`;
}

/**
 * The provider settings this module needs, or the first one that is missing.
 *
 * `not_applicable` is returned for a provider this module does not know how to ask, and for a
 * deployment with no AI at all: a server without AI must not contact a provider at boot.
 * The model is checked separately, because endpoint health can be read for an arbitrary id
 * (`--check=<id>`) even when no default is configured.
 */
function providerProblem(env: Record<string, string | undefined>): string | null {
  const provider = (env.AI_PROVIDER || '').trim().toLowerCase();
  if (provider === '') return 'AI_PROVIDER is not set';
  if (provider !== 'openrouter') return `AI_PROVIDER=${provider} is not a provider this check knows`;
  if (!(env.OPENROUTER_API_KEY || '').trim()) return 'OPENROUTER_API_KEY is not set';
  if (!(env.OPENROUTER_BASE_URL || '').trim()) return 'OPENROUTER_BASE_URL is not set';
  return null;
}

/** The first of the configuration settings `checkModelCatalogue`/`probeModel` need. */
function unusableConfig(env: Record<string, string | undefined>): string | null {
  const problem = providerProblem(env);
  if (problem) return problem;
  if (!configuredModel(env)) return 'AI_MODEL_OPENROUTER is not set';
  return null;
}

/** `{base}/v1/models/{author}/{slug}/endpoints`, without doubling a `/v1` base. */
function modelEndpointsUrl(base: string, model: string): string {
  const encodedModel = model
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const trimmed = base.trim().replace(/\/+$/, '');
  const apiRoot = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${apiRoot}/models/${encodedModel}/endpoints`;
}

/** A finite number published by the provider, or null — never NaN, never a guessed zero. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One published endpoint, with the fields this module promises and nothing else. */
function endpointHealth(value: unknown): EndpointHealth {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const provider = typeof row.provider_name === 'string' ? row.provider_name.trim() : '';
  return {
    provider: provider || 'unknown',
    status: finiteNumber(row.status),
    uptime5m: finiteNumber(row.uptime_last_5m),
    uptime30m: finiteNumber(row.uptime_last_30m),
    uptime1d: finiteNumber(row.uptime_last_1d),
  };
}

/** A fixed, credential-free sentence for a result that is logged. */
function sentence(parts: string[]): string {
  return parts.join(' ');
}

/**
 * Ask the provider's model list whether the configured id exists.
 *
 * Never throws. The returned message names the model whenever there is one to name, because an
 * operator can only fix what they can see — and `AI_MODEL_OPENROUTER` is the value this whole
 * check exists to question.
 */
export async function checkModelCatalogue({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: CheckOptions = {}): Promise<CatalogueResult> {
  const model = configuredModel(env);
  const problem = unusableConfig(env);
  if (problem) {
    return { status: 'not_applicable', model, message: sentence(['model check skipped:', problem]) };
  }

  try {
    const res = await fetchImpl(endpoint(env.OPENROUTER_BASE_URL as string, 'v1/models'), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${(env.OPENROUTER_API_KEY as string).trim()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // NOT a claim about the model: an expired key and a gateway outage both land here, and
      // neither is fixed by changing the id.
      return {
        status: 'unreachable',
        model,
        message: sentence([
          'the model catalogue could not be read (HTTP',
          String(res.status) + '), so the configured model was NOT verified:',
          model,
        ]),
      };
    }

    const body = (await res.json()) as { data?: unknown };
    const ids = Array.isArray(body?.data)
      ? body.data
          .map((entry) => (entry && typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : ''))
          .filter((id) => id !== '')
      : [];

    if (ids.includes(model)) {
      return { status: 'ok', model, message: sentence(['the configured model is listed:', model]) };
    }

    return {
      status: 'missing',
      model,
      message: sentence([
        'AI_MODEL_OPENROUTER names a model the provider does not list:',
        model,
        '— choose an id from GET',
        endpoint(env.OPENROUTER_BASE_URL as string, 'v1/models'),
      ]),
    };
  } catch {
    // The upstream message is deliberately not relayed: it is not this layer's to publish, and a
    // network error may carry a host an operator did not intend to expose.
    return {
      status: 'unreachable',
      model,
      message: sentence([
        'the provider could not be reached, so the configured model was NOT verified:',
        model,
      ]),
    };
  }
}

/**
 * Read the provider's live endpoint health for a model.
 *
 * This is the decision the model ORDER should be made from: it is free (a GET, no completion),
 * so `npm run ai:models` can show it every time instead of relying on a remembered measurement.
 * It never throws, for the same reason the other checks do not: a diagnostic that can take the
 * server or an operator's shell down is worse than no diagnostic.
 *
 * `not_found` means the provider does not publish this model, `no_endpoints` means it publishes
 * the model but no endpoint rows, and `unreachable` means the question could not be asked. None
 * of those is `ok`, and none is a claim that the model cannot answer — `probeModel` is the only
 * check that makes that claim.
 */
export async function readModelHealth({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5000,
  model: overrideModel,
}: CheckOptions = {}): Promise<ModelHealthResult> {
  const model = (overrideModel || '').trim() || configuredModel(env);
  const problem = providerProblem(env);
  if (problem) {
    return {
      status: 'not_applicable',
      model,
      endpoints: [],
      message: sentence(['endpoint health skipped:', problem]),
    };
  }
  if (!model) {
    return {
      status: 'not_applicable',
      model,
      endpoints: [],
      message: 'endpoint health skipped: no model is configured or named',
    };
  }

  try {
    const res = await fetchImpl(modelEndpointsUrl(env.OPENROUTER_BASE_URL as string, model), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${(env.OPENROUTER_API_KEY as string).trim()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
      return {
        status: 'not_found',
        model,
        endpoints: [],
        httpStatus: 404,
        message: sentence(['the provider does not publish endpoint health for:', model]),
      };
    }

    if (!res.ok) {
      return {
        status: 'unreachable',
        model,
        endpoints: [],
        httpStatus: res.status,
        message: sentence([
          'endpoint health could not be read (HTTP',
          String(res.status) + '), so',
          model,
          'was NOT verified',
        ]),
      };
    }

    const body = (await res.json()) as { data?: { endpoints?: unknown } };
    const rows = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
    const endpoints = rows
      .filter((row) => row !== null && typeof row === 'object')
      .map((row) => endpointHealth(row));

    if (endpoints.length === 0) {
      return {
        status: 'no_endpoints',
        model,
        endpoints: [],
        message: sentence(['the provider published no endpoints for:', model]),
      };
    }

    return {
      status: 'ok',
      model,
      endpoints,
      message: sentence(['the provider published', String(endpoints.length), 'endpoint(s) for:', model]),
    };
  } catch {
    return {
      status: 'unreachable',
      model,
      endpoints: [],
      message: sentence(['the provider could not be reached, so', model, 'was NOT verified']),
    };
  }
}

/** The one tool a probe offers. Its shape is what the assistant needs, nothing more. */
const PROBE_TOOL = {
  name: 'getInventorySummary',
  description: 'Return the total stock held by the business.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

/**
 * Send ONE tool-shaped message and report whether the model answered.
 *
 * The request is the smallest thing that is still representative: the same Anthropic shape, the
 * same `model` field and a real tool definition. A model that answers prose instead of calling the
 * tool is still `usable` — the assistant survives that (it is an empty COMPLETION that is the
 * failure mode, AI-2), and calling a chatty model broken would be the wrong reading.
 *
 * Never throws. 429 and 402 are `quota`; every other non-2xx is `unusable`, which is the status
 * that means "change the model".
 */
export async function probeModel({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 60000,
  model: overrideModel,
}: CheckOptions = {}): Promise<ProbeResult> {
  const model = (overrideModel || '').trim() || configuredModel(env);
  const problem = unusableConfig(env);
  if (problem) {
    return { status: 'not_applicable', model, message: sentence(['model probe skipped:', problem]) };
  }

  try {
    const res = await fetchImpl(endpoint(env.OPENROUTER_BASE_URL as string, 'v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${(env.OPENROUTER_API_KEY as string).trim()}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        // AI-55 — the probe sends the SAME reasoning setting the assistant would, so a model
        // that is misconfigured for its reasoning mode fails here rather than on a member's
        // turn. A `budget` cannot fit under this probe's 32-token cap, so it is omitted.
        ...thinkingFieldFor(
          resolveReasoningPolicy(model, reasoningSettings(env)).policy,
          32,
        ),
        tools: [PROBE_TOOL],
        messages: [{ role: 'user', content: 'How much stock do we hold? Use the tool.' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429 || res.status === 402) {
      return {
        status: 'quota',
        model,
        httpStatus: res.status,
        message: sentence([
          'the probe was refused by the account\'s allowance (HTTP',
          String(res.status) + '), which says nothing about',
          model,
        ]),
      };
    }

    if (!res.ok) {
      return {
        status: 'unusable',
        model,
        httpStatus: res.status,
        message: sentence([
          'the model did not answer a tool-shaped request (HTTP',
          String(res.status) + '):',
          model,
        ]),
      };
    }

    return {
      status: 'usable',
      model,
      httpStatus: res.status,
      message: sentence(['the model answered:', model]),
    };
  } catch {
    return {
      status: 'unreachable',
      model,
      message: sentence([
        'the provider could not be reached, so the model was NOT exercised:',
        model,
      ]),
    };
  }
}

export default { checkModelCatalogue, readModelHealth, probeModel };
