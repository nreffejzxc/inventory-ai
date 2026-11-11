/**
 * Shared Anthropic Messages wire mapping for Anthropic-compatible providers.
 *
 * Both the Claude provider and the OpenRouter gateway provider speak this exact
 * protocol over HTTPS. OpenRouter is an Anthropic-compatible gateway (it exposes
 * /v1/messages and routes the request to the model it is asked for), so the
 * neutral provider contract (see the provider interfaces in index.ts) maps
 * to/from the Anthropic shape in exactly one place. A future Anthropic-compatible
 * gateway is then a short factory call, not another ~100 lines of mapping.
 *
 * The factory reads its API key from the environment at creation time (never at
 * module load, and never from the client). Keys are sent only in the request
 * header; they are never logged or returned.
 */

import { aiConfig } from '../aiConfig.ts';
import { modelCallLine } from '../aiMonitor.ts';
import {
  isFreeModel,
  reasoningState,
  resolveReasoningPolicy,
  thinkingFieldFor,
} from '../reasoningPolicy.ts';
import { AiNotConfigured, AiOutputLimit, AiProviderError } from '../aiErrors.ts';
import {
  webToolLabel,
  webToolNames,
  webToolsUsedFromResponse,
  type OpenRouterServerTool,
} from '../webCapabilities.ts';
import { nativeWebSources } from '../webResearch.ts';
import type { QuotaInfo } from '../quota.ts';
import { postJson, postSse, type SseEvent, type UpstreamJsonBody } from './http.ts';
import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderThinkingBlock,
  ProviderUsage,
  ToolCall,
  ToolDefinition,
} from './index.ts';

/** Neutral tools -> Anthropic tools (they expect `input_schema`). */
export function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Neutral messages -> Anthropic messages.
 *
 * A neutral 'tool' message maps to a Claude 'user' message containing a
 * tool_result block; it must follow the assistant message whose tool_use it
 * answers, which our orchestration loop always guarantees.
 */
export function toAnthropicMessages(messages: ProviderMessage[]) {
  // `content` is annotated rather than inferred because the filter below has
  // always tested it against null: the neutral contract never produces one, but
  // the check is the drop-empty-turns guard and must stay live.
  const out: { role: string; content: string | unknown[] | null }[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      // A mandatory-reasoning model binds its tool calls to the reasoning that produced them.
      // Replay those blocks, in order, before the text and tool calls they belong to.
      //
      // OpenRouter emits UNSIGNED thinking blocks for non-Anthropic models, and an unsigned
      // block is rejected on replay (`invalid_union` / `expected string`). There is no signature
      // to reconstruct, so only signed blocks can travel back; the unsigned trace is dropped
      // rather than being turned into visible assistant text.
      for (const thinking of m.thinking || []) {
        if (
          thinking.type === 'thinking' &&
          typeof thinking.thinking === 'string' &&
          typeof thinking.signature === 'string' &&
          thinking.signature.trim()
        ) {
          content.push({ type: 'thinking', thinking: thinking.thinking, signature: thinking.signature });
        } else if (thinking.type === 'redacted_thinking' && typeof thinking.data === 'string' && thinking.data) {
          content.push({ type: 'redacted_thinking', data: thinking.data });
        }
      }
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: String(call.id), name: String(call.name), input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // AI-22 — the results of ONE assistant turn travel as ONE user message.
      //
      // The loop pushes a neutral message per tool call, and this mapping used to emit a
      // `user` message per result, relying on the gateway to merge consecutive user turns
      // (which the Anthropic Messages API documents). That reliance was invisible while the
      // deployed model never asked for two tools at once — and it stopped being invisible on
      // 2026-10-19, when a two-location question cost 5 round-trips and the prompt began
      // asking for the lookups together. N `tool_result` blocks in one user message is the
      // canonical shape and depends on no merging behaviour, so parallel results are batched
      // here. The single-result case is byte-identical to what this function produced before.
      const block = { type: 'tool_result', tool_use_id: String(m.toolCallId), content: m.content };
      const previous = out[out.length - 1];
      if (previous && previous.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  // Anthropic forbids a bare assistant message right before a user message that
  // is not a tool_result and expects turns to alternate; empty assistant turns
  // are dropped defensively.
  return out.filter((m) => m.content !== null && !(Array.isArray(m.content) && m.content.length === 0));
}

/**
 * The slice of an Anthropic Messages response this layer reads. It is declared
 * so the parser has something to narrow against at each level it descends;
 * every field is optional and untrusted, and the body below — not this
 * declaration — is what validates them: `Array.isArray` for `content`, `typeof`
 * for each block's `text`, and `??` for the token counts, which is also what
 * tolerates a provider that reports no usage. `usage` is an object of untrusted
 * counts rather than a pair of numbers, so the counts are asserted into the
 * neutral shape rather than assumed to be well-typed.
 */
interface AnthropicResponse extends UpstreamJsonBody {
  content?: unknown;
  usage?: Record<string, unknown>;
  stop_reason?: unknown;
  model?: unknown;
  annotations?: unknown;
  /** AI-101 — the upstream host OpenRouter routed to, when the gateway reports it. */
  provider?: unknown;
}

/**
 * How many top-level field names the empty-completion line prints. A body can carry any
 * number; the point is to identify the SHAPE, and twelve names is more than any Messages
 * response has. Past it the line says so rather than growing unbounded.
 */
const SHAPE_KEYS_MAX = 12;

/**
 * AI-12 — a bounded, content-free description of a response body that carried no answer.
 *
 * WHY IT EXISTS. This shape left NO trace at all. A 2xx carrying nothing usable is not a
 * non-2xx (the http layer logs those), not an unparseable body (that branch logs
 * diagnostics), not a timeout and not a quota refusal (both throw). So the one thing an
 * operator needs in order to identify it — what the body actually was — was never written
 * down, and the 2026-10-17 investigation of the stored degraded turns could report only
 * that it happened eleven times, never what arrived.
 *
 * ONLY SCHEMA LABELS ARE RETURNED: top-level FIELD NAMES, content block TYPES and counts.
 * No value, no prompt, no model output. That rule is what makes the `thinking` case safe
 * to report at all — its body DOES contain text (the model's reasoning, and the stored
 * usage says such a turn spent tokens on it), and that text must not be copied into a log.
 *
 * `out` is the provider's own count and `null` when it reported none, because "the model
 * spent its budget reasoning" and "the gateway sent nothing at all" are the two candidate
 * explanations this line exists to tell apart — and a zero would collapse them.
 */
function emptyResponseShape(data: AnthropicResponse) {
  const content = Array.isArray(data.content) ? (data.content as UpstreamJsonBody[]) : null;
  const blocks = (content ?? [])
    .map((block) => (block && typeof block === 'object' && typeof block.type === 'string' ? block.type : '?'))
    .join(',');
  const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
  const outputTokens = usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  const names = Object.keys(data);
  const keys = names.slice(0, SHAPE_KEYS_MAX).join(',');
  return [
    `stop=${typeof data.stop_reason === 'string' ? data.stop_reason : 'none'}`,
    `blocks=${blocks || 'none'}`,
    `contentBlocks=${content ? content.length : 'none'}`,
    `hasModel=${typeof data.model === 'string' && data.model !== ''}`,
    `hasUsage=${usage !== null}`,
    `out=${outputTokens ?? 'none'}`,
    `bodyBytes=${JSON.stringify(data).length}`,
    `keys=${keys || 'none'}${names.length > SHAPE_KEYS_MAX ? ',…' : ''}`,
  ].join(', ');
}

/**
 * Read token usage from either wire shape the gateway has used.
 *
 * OpenRouter's Anthropic bridge normally reports `input_tokens`/`output_tokens`,
 * but some upstreams answer with the OpenAI names (`prompt_tokens`/`completion_tokens`).
 * Cache reads and cache writes are billed input, so they are added when present:
 * Anthropic reports them SEPARATELY from `input_tokens`, and ignoring them made the
 * turn line understate what a research-heavy prompt actually cost.
 *
 * OpenRouter also reports the total charge for the request in `usage.cost` (USD,
 * including server-tool charges). It is carried through when present so the turn
 * line can show real credit spend; an older or different gateway that omits it
 * stays an absence rather than being reported as a free call.
 */
export function readUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const count = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const input = count('input_tokens', 'prompt_tokens');
  const output = count('output_tokens', 'completion_tokens');
  if (input === null && output === null) return null;
  const cacheRead = count('cache_read_input_tokens') ?? 0;
  const cacheWrite = count('cache_creation_input_tokens') ?? 0;
  const cost = count('cost');
  return {
    inputTokens: (input ?? 0) + cacheRead + cacheWrite,
    outputTokens: output ?? 0,
    ...(cost !== null ? { costUsd: cost } : {}),
  };
}

/**
 * @param data            the untrusted response body
 * @param requestedModel  the model the REQUEST named, used only when the body omits one.
 *
 * AI-12 — why the fallback is the requested model and not a provider label. It used to be
 * the provider's name (`'openrouter'`, `'claude'`), and the effect was that a response
 * omitting `model` was recorded as if the provider were a model: **12 of 44 stored turns in
 * the development database carried `openrouter` in their model column, including every
 * empty completion**, so the one question a provider-tier decision has to answer — *is this
 * model the unreliable one?* — could not be answered from the record at all. The model the
 * request named is true by construction of the request and answers that question; a
 * provider name wearing a model's field answers a different one. The default keeps the
 * function's standalone behaviour for callers that have no model to offer (tests, a future
 * provider without a model env var).
 */
export function parseAnthropicResponse(data: AnthropicResponse, requestedModel = 'anthropic'): ProviderResponse {
  const content: unknown[] = Array.isArray(data.content) ? data.content : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  const thinking: ProviderThinkingBlock[] = [];
  for (const block of content as UpstreamJsonBody[]) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as UpstreamJsonBody : {} as UpstreamJsonBody;
      toolCalls.push({ id: String(block.id), name: String(block.name), input });
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      thinking.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
      });
    } else if (block?.type === 'redacted_thinking' && typeof block.data === 'string') {
      thinking.push({ type: 'redacted_thinking', data: block.data });
    }
  }
  // Native web citations arrive in tool-result blocks (and, on some gateways, as
  // OpenAI-style annotations). Keep the URLs the provider actually returned so the
  // turn can append a source list even when the model wrote only `【source N】`.
  const webSources = nativeWebSources(content, data.annotations);
  const usage = readUsage(data.usage);
  if (data.stop_reason === 'max_tokens' && toolCalls.length === 0 && !text) {
    // AI-10 — this used to throw an AiProviderError, which the controller maps to
    // 502 AI_UNAVAILABLE: *"temporarily unavailable, please try again in a moment"* for a
    // 2xx in which nothing was unavailable and a moment's wait cannot help, because the
    // same question spends the same output budget again. The classification is the fix;
    // the sentence and the log line live where the cap is known (see `complete` below).
    //
    // The model and the spend travel WITH the failure. Both are parsed right here and
    // were previously dropped, so the turn line reported `in=0 out=0 model=unknown` for
    // the one turn whose entire story is that the model spent everything it had
    // (measured on the device 2026-10-17). A caller who reads only the message sees
    // exactly the sentence it saw before.
    throw new AiOutputLimit(undefined, {
      model: (typeof data.model === 'string' && data.model) || requestedModel,
      usage,
    });
  }
  // AI-8 — the stop reason is REPORTED, not merely tested. The throw above covers the
  // case where the cap left nothing usable; this covers every other one, where the cap
  // left a partial answer that used to arrive looking complete.
  // `?? requestedModel` is the only guard on `model`, exactly as before; the
  // assertion is what says the neutral contract reports it as a string.
  return {
    model: data.model as string ?? requestedModel,
    text,
    toolCalls,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(typeof data.provider === 'string' && data.provider.trim()
      ? { provider: data.provider.trim() }
      : {}),
    usage,
    ...(webSources.length > 0 ? { webSources } : {}),
    truncated: data.stop_reason === 'max_tokens',
  };
}

/**
 * AI-40 — one streamed Anthropic Messages call, assembled into the SAME response shape the JSON
 * path produces.
 *
 * WHY ASSEMBLE RATHER THAN PARSE AS IT GOES. `parseAnthropicResponse` already owns every rule
 * that matters after the body arrives — which stop reasons are truncation, which are a spent
 * output budget, how usage is reported, what an empty completion is. Rebuilding that for the
 * stream would be a second copy of those rules, and the two would drift. So the events are
 * folded back into the body shape the parser already understands, and the parser runs once, at
 * the end. A streamed turn and an unstreamed turn are therefore indistinguishable downstream.
 *
 * TOOL CALLS ARE ASSEMBLED TOO. Anthropic sends a tool call as a start block plus a series of
 * `input_json_delta` fragments — the arguments as a JSON STRING, in pieces. They are joined and
 * parsed once the block completes; malformed JSON (a cut-off stream at the output cap) becomes
 * `{}` rather than a thrown turn, so the tool layer reports the missing arguments to the model
 * and the turn continues. Nothing is executed from a partial argument set.
 *
 * `progress.emitted` is how the caller decides whether a failure may be retried unstreamed: text
 * already delivered cannot be un-delivered, so a retry after it would show the answer twice.
 */
interface StreamProgress {
  emitted: number;
}

interface StreamTarget {
  url: string;
  providerName: string;
  headers: Record<string, string>;
  requestBody: UpstreamJsonBody;
  timeoutMs: number;
  signal?: AbortSignal;
  model: string;
  onTextDelta: (text: string) => void;
}

type StreamBlock =
  | { type: 'text'; text: string; citations?: unknown[] }
  | { type: 'tool_use'; id: string; name: string; json: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  // AI-85 — preserve server-tool block labels so the request log can report
  // actual use. A result block's `content` is kept only to extract public source
  // URLs for the answer; it is never logged.
  | { type: 'server_tool'; blockType: string; name: string; content?: unknown };

/** Tool arguments that arrived in pieces; an unparseable set is empty, never a thrown turn. */
function parseToolInput(raw: string): UpstreamJsonBody {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UpstreamJsonBody) : {};
  } catch {
    return {};
  }
}

/** One folded event stream -> the body `parseAnthropicResponse` expects. */
async function readAnthropicStream(
  target: StreamTarget,
  progress: StreamProgress,
): Promise<{ data: AnthropicResponse; quota: QuotaInfo | null }> {
  const blocks = new Map<number, StreamBlock>();
  let reportedModel = target.model;
  let stopReason: string | null = null;
  let annotations: unknown = undefined;
  // A holder, not a bare `let`: the assignments happen inside the SSE callback, and
  // TypeScript narrows a bare variable to its initial `null` at the read below.
  const usageState: { value: ProviderUsage | null } = { value: null };

  const handle = ({ event, data }: SseEvent): void => {
    // Some gateways terminate with an OpenAI-style sentinel even on an Anthropic wire.
    if (data === '[DONE]') return;
    let payload: UpstreamJsonBody;
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      payload = parsed as UpstreamJsonBody;
    } catch {
      return;
    }
    const type = typeof payload.type === 'string' ? payload.type : event;
    const index = typeof payload.index === 'number' ? payload.index : 0;

    if (type === 'message_start') {
      const message = payload.message && typeof payload.message === 'object' ? (payload.message as UpstreamJsonBody) : null;
      if (message && typeof message.model === 'string' && message.model) reportedModel = message.model;
      if (message && Array.isArray(message.annotations)) annotations = message.annotations;
      const startUsage = readUsage(message?.usage);
      if (startUsage) usageState.value = startUsage;
      return;
    }

    if (type === 'content_block_start') {
      const block = payload.content_block && typeof payload.content_block === 'object' ? (payload.content_block as UpstreamJsonBody) : {};
      if (block.type === 'tool_use') {
        blocks.set(index, { type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' });
      } else if (block.type === 'thinking') {
        blocks.set(index, {
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
        });
      } else if (block.type === 'redacted_thinking') {
        blocks.set(index, { type: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' });
      } else if (
        block.type === 'server_tool_use' ||
        (typeof block.type === 'string' && /web_(?:search|fetch)/i.test(block.type))
      ) {
        blocks.set(index, {
          type: 'server_tool',
          blockType: String(block.type),
          name: typeof block.name === 'string' ? block.name : '',
          ...(block.content !== undefined ? { content: block.content } : {}),
        });
      } else {
        const initial = typeof block.text === 'string' ? block.text : '';
        blocks.set(index, { type: 'text', text: initial });
        if (initial) {
          progress.emitted += initial.length;
          target.onTextDelta(initial);
        }
      }
      return;
    }

    if (type === 'content_block_delta') {
      const delta = payload.delta && typeof payload.delta === 'object' ? (payload.delta as UpstreamJsonBody) : {};
      const block = blocks.get(index);
      if (delta.type === 'citations_delta' && delta.citation && typeof delta.citation === 'object') {
        const textBlock =
          block && block.type === 'text' ? block : { type: 'text' as const, text: '' };
        textBlock.citations = [...(textBlock.citations ?? []), delta.citation];
        blocks.set(index, textBlock);
        return;
      }
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) return;
        if (block && block.type === 'text') block.text += text;
        else blocks.set(index, { type: 'text', text });
        progress.emitted += text.length;
        target.onTextDelta(text);
        return;
      }
      if (delta.type === 'input_json_delta' && block && block.type === 'tool_use') {
        block.json += typeof delta.partial_json === 'string' ? delta.partial_json : '';
        return;
      }
      if (delta.type === 'thinking_delta' && block && block.type === 'thinking') {
        block.thinking += typeof delta.thinking === 'string' ? delta.thinking : '';
        return;
      }
      if (delta.type === 'signature_delta' && block && block.type === 'thinking') {
        block.signature += typeof delta.signature === 'string' ? delta.signature : '';
      }
      return;
    }

    if (type === 'message_delta') {
      const delta = payload.delta && typeof payload.delta === 'object' ? (payload.delta as UpstreamJsonBody) : null;
      if (delta && typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
      if (Array.isArray(payload.annotations)) annotations = payload.annotations;
      const endUsage = readUsage(payload.usage);
      if (endUsage) {
        // Events are not guaranteed to repeat every field: `message_start` usually has
        // the prompt count, `message_delta` the final output count. Taking the larger
        // value keeps a later event with only one counter from erasing the other.
        //
        // The charge is not a counter, it is the request total: the latest event that
        // reports one wins, and an event that omits it must not erase the earlier value.
        // Dropping it here made every streamed turn log `cost=unknown` while the JSON
        // path reported the same provider's charge exactly.
        const current = usageState.value;
        const costUsd = endUsage.costUsd ?? current?.costUsd;
        usageState.value = {
          inputTokens: Math.max(current?.inputTokens ?? 0, endUsage.inputTokens),
          outputTokens: Math.max(current?.outputTokens ?? 0, endUsage.outputTokens),
          ...(costUsd !== undefined ? { costUsd } : {}),
        };
      }
      return;
    }

    if (type === 'error') {
      // A mid-stream refusal. The status, when the gateway sends one, is what lets the turn loop
      // tell a broken model from a broken request — the same classification the JSON path gets.
      const error = payload.error && typeof payload.error === 'object' ? (payload.error as UpstreamJsonBody) : {};
      const status = typeof error.status === 'number' ? error.status : undefined;
      throw new AiProviderError('The AI service returned an error. Please try again.', undefined, status);
    }
  };

  const { quota } = await postSse({
    url: target.url,
    providerName: target.providerName,
    headers: target.headers,
    body: { ...target.requestBody, stream: true },
    timeoutMs: target.timeoutMs,
    signal: target.signal,
    onEvent: handle,
  });

  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => {
      if (block.type === 'text') {
        return {
          type: 'text',
          text: block.text,
          ...(block.citations && block.citations.length > 0 ? { citations: block.citations } : {}),
        };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.json) };
      }
      if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
      if (block.type === 'server_tool') {
        return {
          type: block.blockType,
          ...(block.name ? { name: block.name } : {}),
          ...(block.content !== undefined ? { content: block.content } : {}),
        };
      }
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    });

  const finalUsage = usageState.value;
  const data = {
    model: reportedModel,
    content,
    stop_reason: stopReason ?? undefined,
    usage: finalUsage
      ? {
          input_tokens: finalUsage.inputTokens,
          output_tokens: finalUsage.outputTokens,
          ...(finalUsage.costUsd !== undefined ? { cost: finalUsage.costUsd } : {}),
        }
      : undefined,
    ...(annotations !== undefined ? { annotations } : {}),
  } as unknown as AnthropicResponse;

  return { data, quota };
}

/**
 * The aiConfig() keys whose value is a STRING — the only ones that can hold a model name.
 *
 * AI-12 — found by `tsc`, not by a test. With `modelKey: keyof ReturnType<typeof aiConfig>`,
 * `cfg[modelKey]` has the union of every config value's type, so a model reached its call
 * sites as `string | number` and compiled only because the one consumer took a loose shape.
 * Narrowing the KEY fixes it at the source: a numeric knob can no longer be named as a
 * model, and the compiler enforces that here instead of at each call site.
 */
type StringConfigKey = {
  [K in keyof ReturnType<typeof aiConfig>]: ReturnType<typeof aiConfig>[K] extends string ? K : never;
}[keyof ReturnType<typeof aiConfig>];

/**
 * What a factory built on this wire layer must be told. `modelKey` names the
 * aiConfig() field holding the model, so each provider keeps its own environment
 * variable without this module knowing the variable's name.
 */
export interface AnthropicCompatibleOptions {
  /** provider id used in logs and the instance name */
  name?: string;
  /** env var holding the API key (server-side only) */
  apiKeyEnv: string;
  /** AiNotConfigured message when the key is absent */
  apiKeyMissingMessage?: string;
  /** full /v1/messages URL to POST to */
  messagesUrl: string;
  /** aiConfig() key holding the model name — a string-valued key, never a numeric knob */
  modelKey: StringConfigKey;
  /** fallback when the model env var is empty */
  defaultModel: string;
  /** header map for the key */
  authHeaders?: (apiKey: string) => Record<string, string>;
  /** static headers merged over authHeaders (e.g. a gateway-mandated User-Agent / beta header) */
  extraHeaders?: Record<string, string>;
  /**
   * OpenRouter server tools to append to a normal tool-capable request.
   *
   * A callback, not a captured array, because `aiConfig()` is read at request
   * time. The wire only adds these when the caller supplied client tools; the
   * turn loop deliberately withholds all tools on its final answer round (AI-50),
   * and a server-side search must not be the exception that keeps that round
   * searching instead of answering.
   */
  serverTools?: () => OpenRouterServerTool[];
}

/**
 * Build an Anthropic-Messages provider instance.
 *
 * @param {object} opts
 * @param {string} opts.name            provider id used in logs and the instance name
 * @param {string} opts.apiKeyEnv       env var holding the API key (server-side only)
 * @param {string} opts.apiKeyMissingMessage  AiNotConfigured message when the key is absent
 * @param {string} opts.messagesUrl     full /v1/messages URL to POST to
 * @param {string} opts.modelKey        aiConfig() key holding the model name
 * @param {string} opts.defaultModel    fallback when the model env var is empty
 * @param {(apiKey:string) => object} opts.authHeaders  header map for the key
 * @param {object} [opts.extraHeaders] static headers merged over authHeaders
 *   (e.g. a gateway-mandated User-Agent / beta header)
 */
export function createAnthropicCompatibleProvider(opts: AnthropicCompatibleOptions = {} as AnthropicCompatibleOptions): AIProvider {
  const {
    name = 'anthropic',
    apiKeyEnv,
    apiKeyMissingMessage = `${apiKeyEnv} is not set, so this AI provider is unavailable.`,
    messagesUrl,
    modelKey,
    defaultModel,
    authHeaders,
    extraHeaders = {},
    serverTools,
  } = opts;

  const apiKey = (process.env[apiKeyEnv] || '').trim();
  if (!apiKey) {
    throw new AiNotConfigured(apiKeyMissingMessage);
  }

  return {
    name,

    /**
     * AI-28 — the model a request from this provider would carry, reported on the CONTRACT rather
     * than only on a successful response.
     *
     * A getter, not a captured value: `aiConfig()` reads the environment at call time everywhere in
     * this service, and a module-load snapshot here would disagree with the model the very next
     * request sends — the exact drift a check must not have. `ai.service` seeds its turn line from
     * this, so a turn whose provider call FAILED still names the model instead of `unknown`.
     */
    get model() {
      return aiConfig()[modelKey] || defaultModel;
    },

    async complete({
      system,
      messages,
      tools,
      timeoutMs,
      signal,
      model: requestedModel,
      maxOutputTokens: requestedMaxOutputTokens,
      reasoningBudgetTokens,
      stream,
      onTextDelta,
      webResearch,
      nativeWeb,
      turnId,
    }) {
      const cfg = aiConfig();
      // AI-29 — a per-request override, used by the turn loop's failover. It stays a
      // parameter rather than a second environment variable so the request itself
      // records which model answered, and the parsed response reports that model.
      const model = requestedModel || cfg[modelKey] || defaultModel;
      // AI-100 — resolve the policy for THIS model before building the request. Free
      // endpoints use their own switch; paid endpoints keep AI_REASONING_PAID_MODELS and the
      // advanced per-model rules. The resolved field is also what the free-model log
      // reports, so the log and the wire body cannot disagree.
      // AI-105 — the turn loop's output-limit retry may raise the cap and reserve
      // reasoning space for this call only. Both values are absent on every normal
      // request, so the configured cap and per-model policy remain the defaults.
      const maxOutputTokens =
        typeof requestedMaxOutputTokens === 'number' &&
        Number.isFinite(requestedMaxOutputTokens) &&
        requestedMaxOutputTokens > 0
          ? Math.floor(requestedMaxOutputTokens)
          : cfg.maxOutputTokens;
      const resolvedReasoning = reasoningBudgetTokens
        ? {
            policy: { mode: 'budget' as const, budgetTokens: reasoningBudgetTokens },
            source: 'model' as const,
          }
        : resolveReasoningPolicy(model, cfg.reasoning);
      const thinkingField = thinkingFieldFor(resolvedReasoning.policy, maxOutputTokens);
      // The turn's remaining budget when the orchestrator supplied one, so a
      // call can never outlive the turn's single deadline (AI-1).
      const budget = timeoutMs ?? cfg.requestTimeoutMs;
      // AI-85 — OpenRouter's built-in server tools live in the SAME `tools` array as
      // the assistant's client tools, but they are raw entries with a `type`, not
      // `input_schema` function definitions. They are added only when this call is
      // allowed to use tools at all, preserving AI-50's final-answer round. Keep the
      // configured list separately for the log: it answers "was the switch on?", while
      // the offered list answers "did this request actually carry the tool?".
      const configuredServerTools = serverTools?.() ?? [];
      // AI-86 — the turn loop sets this false for plain inventory questions. Keeping the
      // configured list separate lets the request log explain that the switches are on
      // while neither paid tool was offered. Undefined preserves direct-call behaviour.
      const webToolsAllowed = webResearch !== false && nativeWeb !== false;
      const serverToolDefs = tools && tools.length > 0 && webToolsAllowed ? configuredServerTools : [];
      const requestTools = [
        ...(tools && tools.length > 0 ? toAnthropicTools(tools) : []),
        ...serverToolDefs,
      ];
      const requestBody = {
        model,
        max_tokens: maxOutputTokens,
        system,
        messages: toAnthropicMessages(messages),
        // AI-50 — a turn's answer round passes no tools, and an empty `tools: []` is not the
        // same request as none: the key is omitted entirely when there is nothing to offer.
        ...(requestTools.length > 0 ? { tools: requestTools } : {}),
        // AI-54 — reasoning shares `max_tokens` with the answer on this gateway, and the
        // measured model spent the ENTIRE budget on `thinking` blocks (400/400, no text),
        // so the assistant asks for it to be off. The reason, the measurements and the
        // per-model rules live in `aiConfig().reasoning`; nothing about the neutral
        // response contract changes, because a disabled model simply returns text.
        // AI-55 — the policy is resolved for THIS request's model, not for the deployment, so a
        // failover candidate that requires reasoning does not inherit the primary's `off`.
        ...thinkingField,
      };
      // AI-100 — every provider request gets its own line, before the network call, so
      // Render shows the policy that was actually sent even when the provider then
      // refuses the request. `field=disabled` is the observable proof that reasoning
      // was turned off; `field=omitted` means the model's own default is enabled.
      const free = isFreeModel(model);
      const reasoningField = 'thinking' in thinkingField ? thinkingField.thinking.type : 'omitted';
      const reasoningSource = free
        ? cfg.reasoning.freeSource
        : resolvedReasoning.source === 'paid'
          ? cfg.reasoning.paidSource
          : resolvedReasoning.source;
      console.log(
        modelCallLine({
          turn: turnId ?? 'none',
          provider: name,
          model,
          reasoning: reasoningState(resolvedReasoning.policy),
          field: reasoningField,
          source: reasoningSource,
        }),
      );
      const requestHeaders = { ...(authHeaders ? authHeaders(apiKey) : {}), ...extraHeaders };

      /**
       * One parsed body -> the neutral response, logged the same way on BOTH paths.
       *
       * Kept as one function so a streamed answer cannot skip the empty-completion warning
       * (AI-12) or report a spent output budget differently from an unstreamed one (AI-10).
       */
      const finish = (body: AnthropicResponse, quota: QuotaInfo | null): ProviderResponse => {
        // AI-85 — one greppable line per provider request, in the same spirit as the
        // failover line: what was configured, what this request offered, and what the
        // provider actually ran. Only labels and the model id are printed; no prompt,
        // query, URL, page content or credential can reach it. `used=none` is the
        // important distinction: the feature was enabled, but this request did not use
        // it. A final answer round can legitimately say `offered=none used=none` because
        // AI-50 withholds all tools there.
        const enabledWebTools = webToolNames(configuredServerTools);
        const offeredWebTools = webToolNames(serverToolDefs);
        const usedWebTools = webToolsUsedFromResponse(body.content, body.usage);
        if (enabledWebTools.length > 0 || usedWebTools.length > 0) {
          console.log(
            `AI model web tools enabled=${webToolLabel(enabledWebTools)}` +
              ` offered=${webToolLabel(offeredWebTools)}` +
              ` used=${webToolLabel(usedWebTools)}` +
              ` intent=${webToolsAllowed ? 'web-research' : 'inventory'} model=${model}` +
              ` turn=${turnId ?? 'none'}`,
          );
        }
        try {
          const parsed = parseAnthropicResponse(body, model);
          // AI-36 — the allowance rides on the successful response so the turn loop can report it
          // and lift a fail-fast window. It is attached AFTER parsing, so the parser's contract and
          // its diagnostics (which print the body's field names) are untouched.
          const withQuota = quota ? { ...parsed, quota } : parsed;
          // AI-86 — expose the server tools this response actually ran so the turn
          // loop can treat a native search/fetch as a real research read instead of
          // re-asking for a custom tool and paying for the same research twice.
          const withWebTools = usedWebTools.length > 0
            ? { ...withQuota, webToolsUsed: usedWebTools }
            : withQuota;
          // AI-12 — and an empty completion is named ONCE PER OCCURRENCE, before it is
          // returned, because the AI-2 retry means the turn-level warning appears only when
          // a turn GIVES UP: an empty response the retry rescues used to be invisible, and
          // the failure rate could not be counted, let alone explained. The shape is printed
          // and never the body, for the reason `emptyResponseShape` gives.
          if (!parsed.text && parsed.toolCalls.length === 0) {
            console.warn(
              `AI model empty completion (provider=${name}, model=${model}, ${emptyResponseShape(body)}) — the provider answered 2xx with neither text nor a tool call; the turn retries once, then degrades (AI-2) turn=${turnId ?? 'none'}`
            );
          }
          return withWebTools;
        } catch (err) {
          if (err instanceof AiOutputLimit) {
            console.warn(
              `AI model hit its output limit with nothing usable (provider=${name}, model=${model},` +
                ` maxTokens=${maxOutputTokens}, stop=max_tokens) — the model spent its` +
                ` whole output budget before answering turn=${turnId ?? 'none'}`
            );
          }
          throw err;
        }
      };

      // AI-40 — the streamed path, when the caller asked for live text. It is deliberately
      // OPTIONAL rather than the only way in: the deployed gateway is a free tier whose models
      // vary in what they support, so a provider that answers without streaming falls back to
      // the ordinary request for the SAME call. That fallback is allowed only before any text
      // has been delivered — after that a retry would show the answer twice — and only for the
      // one failure that means "this was not a stream" (`invalid_response`).
      if (stream && onTextDelta) {
        const progress: StreamProgress = { emitted: 0 };
        try {
          const streamed = await readAnthropicStream(
            {
              url: messagesUrl,
              providerName: name,
              headers: requestHeaders,
              requestBody,
              timeoutMs: budget,
              signal,
              model,
              onTextDelta,
            },
            progress,
          );
          return finish(streamed.data, streamed.quota);
        } catch (err) {
          const answeredUnstreamed =
            err instanceof AiProviderError && err.kind === 'invalid_response' && progress.emitted === 0;
          if (!answeredUnstreamed) throw err;
          console.error(
            `AI model ignored stream=true (provider=${name}, model=${model}, turn=${turnId ?? 'none'}); retrying the same call unstreamed`,
          );
        }
      }

      const { data, quota } = await postJson({
        url: messagesUrl,
        providerName: name,
        timeoutMs: budget,
        signal,
        headers: requestHeaders,
        body: requestBody,
      });
      // AI-10 — the one failure on this path that used to leave NO trace. Every sibling
      // in providers/http.ts logs before it throws; this shape is a 2xx, so it had no
      // status line either, and the only evidence of the Q4 failure was a missing answer
      // — which is why identifying it took elimination (§27BG). Logged in `finish` rather
      // than in the parser because this is where the cap is known, and the cap is the number
      // an operator acts on: a model that consistently spends `maxTokens` without
      // answering is a cap that is too small (or a question that needs narrowing).
      //
      // AI-12 — the model the request names is the fallback for a body that omits one (see
      // `parseAnthropicResponse`): a provider label in a model column answers the wrong
      // question, and it hid the model on every failing turn in the record.
      return finish(data as AnthropicResponse, quota);
    },
  };
}

export default { toAnthropicTools, toAnthropicMessages, parseAnthropicResponse, createAnthropicCompatibleProvider };
