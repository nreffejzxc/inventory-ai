/**
 * AI provider registry.
 *
 * selectProvider() resolves the provider named by AI_PROVIDER at call time by
 * reading process.env lazily (see aiConfig.ts for why). ONE built-in provider
 * exists: `openrouter`, an Anthropic-compatible gateway (see openrouterProvider.ts).
 * Test suites register a 'fake' provider via registerProvider so the full
 * orchestration loop and routes can be exercised without an API key.
 *
 * AI-25 (owner decision, 2026-10-19) — the direct Claude and Gemini providers were
 * REMOVED, not disabled. Both were reachable through OpenRouter as MODEL choices, so the
 * direct implementations bought no capability, while they cost two API keys, two model
 * variables, a second wire mapping and parser, and a production path nothing exercised (a
 * "fallback" that would need its own account and billing to be real). The abstraction is
 * deliberately KEPT: `AIProvider`, this registry and the shared Anthropic-compatible wire
 * all remain — OpenRouter is built on that wire — so restoring a direct provider later is
 * one small factory plus one entry here, and git keeps the Gemini mapping if it is wanted.
 *
 * Never expose provider keys to the mobile app — selection happens server-side
 * and only the resulting text reaches the client.
 */

import { AiNotConfigured } from '../aiErrors.ts';
import type { QuotaInfo } from '../quota.ts';
import type { WebToolName } from '../webCapabilities.ts';
import type { ResearchSource } from '../webResearch.ts';
import { createOpenrouterProvider } from './openrouterProvider.ts';

/**
 * A tool call the model asked for: the id it must be answered by, the tool's
 * name, and the arguments the model produced. `input` is an object of untrusted
 * model output — each parser below admits a value only after checking it is a
 * non-array object, and substitutes {} otherwise.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A reasoning block the provider returned, kept verbatim so it can be replayed.
 *
 * Mandatory-reasoning models bind tool calls to the reasoning that produced them; dropping these
 * blocks between a tool call and its result makes the next round invalid. Optional fields are
 * provider-specific: Anthropic-style thinking carries `thinking` + `signature`, while a redacted
 * block carries opaque `data` instead.
 */
export interface ProviderThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  signature?: string;
  data?: string;
}

/**
 * A tool as the model sees it, in the neutral shape the tool registry uses:
 * `parameters` is a JSON Schema object.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One entry of the neutral message list handed to a provider (the contract is
 * spelled out in anthropicWire.ts). `toolCalls` belongs to assistant turns and
 * `name`/`toolCallId` to tool turns; `content` is a JSON string on a tool turn.
 */
export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  /** Reasoning blocks returned with this assistant turn, replayed before its tool calls. */
  thinking?: ProviderThinkingBlock[];
  name?: string;
  toolCallId?: string;
}

/** What one completion is asked for. */
export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  /**
   * The tools this call may use. Optional because a turn's final round withholds them
   * (AI-50) so the model answers from what it already gathered; absent and empty are
   * both sent as "no tools", never as an empty tool list.
   */
  tools?: ToolDefinition[];
  /**
   * AI-86 — whether this turn asks for public-web research.
   *
   * Optional and provider-neutral: a provider with built-in server tools can withhold
   * them when this is explicitly false. Undefined preserves the provider's normal
   * behavior for direct callers and tests. The turn loop always supplies a boolean, so
   * a simple inventory question never exposes paid web tools.
   */
  webResearch?: boolean;
  /**
   * AI-86 — whether the provider may offer its OWN native web tools on this call.
   *
   * `webResearch` says the turn needs public-web research; this says the native
   * server-tool path is still usable. The turn loop sets it false when it falls
   * back to the local research tools, so the two paths never compete in one
   * request and one turn cannot pay for both.
   */
  nativeWeb?: boolean;
  /**
   * The model to call INSTEAD of the configured one (AI-29).
   *
   * It exists for one caller: the turn loop's failover, after the configured model's
   * upstream refused the call. Absent on every normal request, so a provider's own
   * configuration stays the single place a model is chosen — this is an override, not a
   * second setting. A provider that ignores it simply keeps using its configured model.
   */
  model?: string;
  /**
   * Wall-clock budget for THIS call, in ms (AI-1). runAiChat passes the time
   * remaining in the turn's single deadline, so the turn's total cost is bounded
   * by that deadline rather than by (per-call cap x tool iterations). Optional:
   * a provider that ignores it is still bounded by the loop's own race.
   */
  timeoutMs?: number;
  /**
   * Aborted when the caller has gone away (AI-1). Threaded from the inbound HTTP
   * request so an abandoned turn cancels its model call instead of paying for an
   * answer nobody will read.
   */
  signal?: AbortSignal;
  /**
   * AI-101 — the monitoring id of the turn this request belongs to.
   *
   * Optional so a direct provider call (a test or a drill) needs no invented turn; the turn
   * loop always supplies one, and the wire prints `turn=none` when it is absent.
   */
  turnId?: string;
  /**
   * AI-40 — ask the provider to deliver the answer while it is being written.
   *
   * OPTIONAL BY CONTRACT. A provider that cannot stream simply ignores both fields and returns
   * the whole answer, which is exactly what every provider did before streaming existed — so
   * this is an optimisation a provider opts into, not a second way for a turn to fail.
   */
  stream?: boolean;
  /**
   * AI-40 — one piece of answer text, in arrival order.
   *
   * Only called when `stream` is true. Text passed here is DISPLAY ONLY: the turn's stored
   * answer is still the response's `text`, which may differ (the server rewrites status
   * constants and trims a cut-off unit), and the client replaces what it rendered with the
   * final message when the turn completes. Nothing here is persisted as it arrives.
   */
  onTextDelta?: (text: string) => void;
}

/** Usage accounting as the provider reported it, or null when it reported none. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * The total provider charge for THIS response in USD, when the provider
   * reports one. OpenRouter's Anthropic-compatible usage carries `cost`.
   *
   * Optional on purpose: absent means the cost was not reported, not that the
   * response was free. The turn loop sums this across calls and prints
   * `cost=unknown` rather than turning an omission into `$0`.
   */
  costUsd?: number;
}

/** What one completion returns, normalised across providers. */
export interface ProviderResponse {
  model: string;
  /**
   * AI-101 — the UPSTREAM provider that actually served this response, when the gateway names
   * one (OpenRouter routes a model id across several hosts and reports which one ran).
   *
   * It is separate from the configured provider name on purpose: `openrouter` is the gateway
   * this server calls, while the upstream is the host that answered — the fact an operator
   * needs when one host is slow or degraded. Optional because not every wire reports it, and
   * absent must stay an absence rather than being printed as a name.
   */
  provider?: string;
  text: string;
  toolCalls: ToolCall[];
  /**
   * Native server tools this response actually exercised (AI-86). The turn loop
   * uses this as a genuine research read; it cannot execute these calls itself
   * because OpenRouter runs them inside the provider request.
   */
  webToolsUsed?: WebToolName[];
  /**
   * Public source URLs the native web tools returned on this response.
   *
   * The turn loop appends them to the stored answer, so a model that cites only
   * `【source N】` still leaves the member a clickable list. Absent when the
   * response ran no native web tool.
   */
  webSources?: ResearchSource[];
  /** Raw reasoning blocks, present only when the provider returned them. */
  thinking?: ProviderThinkingBlock[];
  usage: ProviderUsage | null;
  /**
   * AI-36 — the account allowance the response published, when it published one.
   *
   * Optional because a provider may not meter requests, and because a test double does not
   * have to imitate a header. The turn loop records it and reports it; absence is never read
   * as zero.
   */
  quota?: QuotaInfo | null;
  /**
   * AI-8 — whether the provider STOPPED because it reached the output cap.
   *
   * It is reported on every response, including the ones that carry text, because that
   * is precisely the case that was invisible: `stop_reason === 'max_tokens'` was read
   * only to decide whether to throw, and a truncation that carried any text therefore
   * discarded the fact. This is the provider's own signal, not a count — the cap itself
   * lives in `aiConfig().maxOutputTokens` — so a provider that reports nothing simply
   * omits it (`undefined`, which is not a truncation).
   */
  truncated?: boolean;
}

/**
 * The provider contract. Both registries — here and services/mail/providers —
 * resolve to one of these, and it is declared here because this is the module
 * that hands providers out: `registerProvider`'s second argument and
 * `selectProvider`'s return are the two ends of the same seam.
 */
export interface AIProvider {
  name: string;
  /**
   * The model this provider is CONFIGURED to call, when it has one (AI-28).
   *
   * WHY IT BELONGS ON THE CONTRACT. `ProviderResponse.model` only exists when a call SUCCEEDS, so
   * a turn whose every call failed could not name the model it was trying — the log said
   * `model=unknown` exactly when the question "is it this model?" was the one that mattered (a
   * provider-side 404 for a withdrawn or broken model, 2026-10-21). This is the value the request
   * would have carried, so a failing turn can report it. Optional: a provider with no single model
   * (or a test double) simply omits it.
   */
  model?: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export type AIProviderFactory = () => AIProvider;

/** One built-in: how to build it, and what the environment must supply first. */
interface AIProviderEntry {
  factory: AIProviderFactory;
  requiredEnv: readonly string[];
}

const registry = new Map<string, AIProviderFactory>();

/**
 * Built-in providers: which factory resolves each name, and which server-side
 * environment variables that factory requires at creation time (its key, and for
 * the gateway also its base URL). Kept next to selectProvider() so production
 * config validation (Phase 07D / H7) checks the SAME requirements the chat route
 * would hit — one source of truth for provider names and their keys. A registry
 * override (tests) is not covered here; those run outside production.
 */
const BUILTINS: Record<string, AIProviderEntry> = {
  // The one shipped provider (AI-25). OpenRouter also demands a model: it fronts
  // hundreds of models with different tool-calling ability, so there is no safe
  // default to fall back on.
  openrouter: {
    factory: createOpenrouterProvider,
    requiredEnv: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'AI_MODEL_OPENROUTER'],
  },
};

/** Register (or override) a provider factory, primarily for tests. */
export function registerProvider(name: unknown, factory: AIProviderFactory) {
  registry.set(String(name).toLowerCase(), factory);
}

export function deregisterProvider(name: unknown) {
  registry.delete(String(name).toLowerCase());
}

export function registeredProviders() {
  return [...registry.keys()];
}

/** Environment variables a built-in provider needs at creation, or null when unknown. */
export function providerRequiredEnv(name: unknown) {
  const entry = BUILTINS[String(name || '').trim().toLowerCase()];
  return entry ? [...entry.requiredEnv] : null;
}

/**
 * Resolve the configured provider. Throws AiNotConfigured when AI_PROVIDER is
 * unset/unknown or the provider's API key is missing, so the chat route can
 * return a clean 503 instead of crashing. An unknown name includes the two
 * removed built-ins: `claude` and `gemini` are refused as unsupported (AI-25),
 * never reported as a missing key for a provider that no longer exists.
 */
export function selectProvider(): AIProvider {
  const raw = (process.env.AI_PROVIDER || '').trim();
  const name = raw.toLowerCase();
  if (!name) {
    throw new AiNotConfigured('AI_PROVIDER is not set, so the AI assistant is disabled on this server.');
  }
  if (registry.has(name)) return registry.get(name)!();
  const builtin = BUILTINS[name];
  if (builtin) return builtin.factory();
  throw new AiNotConfigured(
    `The configured AI provider "${raw}" is not supported. Set AI_PROVIDER to "openrouter", or leave it empty to disable the AI assistant.`
  );
}

export default { registerProvider, deregisterProvider, registeredProviders, selectProvider, providerRequiredEnv };
