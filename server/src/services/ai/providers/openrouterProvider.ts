/**
 * OpenRouter provider — an Anthropic-compatible gateway.
 *
 * OpenRouter serves the Anthropic Messages API at /api/v1/messages ("Creates a
 * message using the Anthropic Messages API format. Supports text, images, PDFs,
 * tools, and extended thinking") and documents its "Anthropic Skin" as behaving
 * like the Anthropic API, passing through native tool use. Because it speaks the
 * Anthropic shape, this provider is a thin configuration over the shared wire
 * layer in anthropicWire.ts — the same tool_use / tool_result mapping and the
 * same parse the Claude provider uses. Only the endpoint, the key, and the model
 * differ.
 *
 * DELIBERATE DIFFERENCES FROM THE CLAUDE PROVIDER
 *
 *   - Authentication is a bare `Authorization: Bearer <key>`. OpenRouter
 *     documents exactly that header, so no `anthropic-version` is sent.
 *   - NO client impersonation. This provider sends no claude-cli User-Agent and
 *     no claude-code beta header: OpenRouter documents no client-fingerprint
 *     requirement, so there is nothing to impersonate, and doing so would be a
 *     terms-of-service problem rather than a compatibility measure.
 *
 * MODEL SELECTION IS REQUIRED, NOT DEFAULTED
 *
 * OpenRouter fronts hundreds of models with very different tool-calling ability,
 * so there is no defensible default model the way there is for a first-party
 * provider. AI_MODEL_OPENROUTER is therefore REQUIRED: with it unset the provider
 * refuses to build (AiNotConfigured -> the chat route answers 503), and
 * production config validation fails fast at startup, rather than silently
 * routing inventory questions at a model that may not support tools at all.
 *
 * Server-side configuration (server/.env, never committed, never sent to the
 * mobile app or to MongoDB):
 *   AI_PROVIDER=openrouter
 *   OPENROUTER_API_KEY=...                              (server-side only)
 *   OPENROUTER_BASE_URL=https://openrouter.ai/api       (/v1/messages is appended)
 *   AI_MODEL_OPENROUTER=<provider>/<model>              (required; a tool-capable model)
 *
 * The key travels in the Authorization: Bearer header only. It is never logged,
 * never returned to the client, and never shown in error bodies.
 */

import { aiConfig } from '../aiConfig.ts';
import { AiNotConfigured } from '../aiErrors.ts';
import { createAnthropicCompatibleProvider } from './anthropicWire.ts';
import type { AIProvider } from './index.ts';

/**
 * Turn an origin/base URL into the Anthropic messages endpoint.
 *
 * The base is an origin-ish prefix (OpenRouter's documented value is
 * https://openrouter.ai/api) and /v1/messages is appended, unless the base
 * already names the endpoint.
 */
function messagesUrlFromBase(base: string) {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  return `${trimmed}/v1/messages`;
}

export function createOpenrouterProvider(): AIProvider {
  const cfg = aiConfig();

  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    throw new AiNotConfigured('OPENROUTER_API_KEY is not set, so the OpenRouter AI provider is unavailable.');
  }

  const baseUrl = cfg.openrouterBaseUrl;
  if (!baseUrl) {
    throw new AiNotConfigured('OPENROUTER_BASE_URL is not set, so the OpenRouter AI provider is unavailable.');
  }

  const model = (process.env.AI_MODEL_OPENROUTER || '').trim();
  if (!model) {
    throw new AiNotConfigured('AI_MODEL_OPENROUTER is not set, so the OpenRouter AI provider is unavailable.');
  }

  return createAnthropicCompatibleProvider({
    name: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyMissingMessage: 'OPENROUTER_API_KEY is not set, so the OpenRouter AI provider is unavailable.',
    messagesUrl: messagesUrlFromBase(baseUrl),
    modelKey: 'openrouterModel',
    defaultModel: model,
    // NO `fallbackModel` (AI-12). It used to be the provider's own name, so any response
    // whose body omitted `model` was recorded as the model `openrouter` — and since an
    // empty completion is exactly such a body, **every** failing turn in the record was
    // labelled with the provider instead of a model. The factory now falls back to the
    // model the request named, which is true by construction and answers "is it this
    // model?", the question a provider-tier decision actually has to ask.
    // OpenRouter documents a bearer token and nothing else. No impersonation
    // headers, and no anthropic-version: the endpoint does not require one.
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    // AI-85 — opt-in OpenRouter server tools. Read lazily so editing .env and
    // restarting is the only change; the same tools travel with every model,
    // including a failover candidate, and reasoning remains per-model.
    serverTools: () => aiConfig().webServerTools,
  });
}

export default { createOpenrouterProvider };
