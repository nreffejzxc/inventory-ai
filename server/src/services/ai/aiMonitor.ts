/**
 * AI-101 — the assistant's monitoring vocabulary.
 *
 * WHY THIS IS ONE MODULE. The assistant already recorded what it spent (AI-5) and what the
 * provider was configured to do (AI-55/AI-100), but those facts lived in different lines with
 * different shapes: `[ai] turn …` for cost, `[ai:openrouter] free-model reasoning=…` per
 * request, and three more boot lines. An operator asking "which model answered this, was it
 * free, did reasoning or a web tool run, which upstream served it, and what did it cost" had
 * to join four lines by model id and time. One formatter per record means the answer is one
 * line, and the fields cannot drift apart between exits.
 *
 * WHAT IS DELIBERATELY UNCHANGED. Every key the existing tooling reads — `outcome`, `total`,
 * `providerMs`, `toolMs`, `calls`, `toolRuns`, `tools`, `in`, `out`, `cost`, `model`,
 * `iterations`, `route`, `failovers` — keeps its name and position in the value syntax. The
 * prefix is descriptive (`AI turn`, not `[ai] turn`), and the added keys are appended, so
 * `scripts/ai-usage.mjs` and the turn tests keep parsing real fields instead of a snapshot.
 *
 * NOTHING SENSITIVE IS FORMATTED HERE. Callers pass counts, ids, labels and durations only.
 * No prompt, message, tool result, URL, page content or credential has a field on these
 * records by construction.
 */

import { randomUUID } from 'node:crypto';

import { isFreeModel, reasoningState, type ReasoningSettings } from './reasoningPolicy.ts';

/**
 * One short id shared by every monitoring record a single turn writes.
 *
 * Eight hex characters are enough to join the request, each provider attempt and the result in a
 * log viewer, and short enough that the id does not dominate the line. Uniqueness only has to
 * hold across the turns a person is reading, not forever.
 */
export function newTurnId(): string {
  return randomUUID().slice(0, 8);
}

/** Which allowance the model spends: the daily free requests, or account credits. */
export type ModelTier = 'free' | 'paid';

export function modelTier(model: string | null | undefined): ModelTier {
  return isFreeModel(model) ? 'free' : 'paid';
}

/** A readable status for the turn, while `outcome` keeps the precise error code. */
export function turnStatus(outcome: string): 'ok' | 'degraded' | 'failed' {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'degraded') return 'degraded';
  return 'failed';
}

/**
 * Milliseconds -> the same duration in seconds, and in minutes once it passes one
 * (`8284` -> `8.28s`, `75210` -> `1m 15.21s`). The raw `total=` field keeps the exact
 * milliseconds, so this is only the readable copy.
 */
export function durationSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(2)}s`;
}

function switchState(value: boolean): string {
  return value ? 'enabled' : 'disabled';
}

export interface TurnRequestView {
  /** The id shared by every record this turn writes. */
  turn: string;
  /** `inventory`, `inventory:<operation>` or `web-research`. */
  intent: string;
  route: string;
  /** The model this turn will start on, before any failover. */
  model: string | null;
  reasoning: ReasoningSettings;
  /** The raw legacy `AI_REASONING` value, or an empty string when unset. */
  legacyReasoning: string;
  webSearch: boolean;
  webFetch: boolean;
  /** Whether the turn may use the research tools at all. */
  researchTools: boolean;
}

/**
 * The turn's opening record: what the assistant decided to do, and with what configuration.
 *
 * Emitted once per submitted question, before the first provider request, so a turn that never
 * reaches a provider (quota block, abandoned request, missing key) still states the policy that
 * would have applied.
 */
export function turnRequestLine(view: TurnRequestView): string {
  const paid = view.reasoning.simplePolicy
    ? reasoningState(view.reasoning.simplePolicy)
    : 'advanced';
  return (
    `AI request intent=${view.intent} route=${view.route}` +
    ` model=${view.model ?? 'none'} tier=${view.model ? modelTier(view.model) : 'none'}` +
    ` reasoning-free=${reasoningState(view.reasoning.freePolicy)}` +
    ` reasoning-free-source=${view.reasoning.freeSource}` +
    ` reasoning-paid=${paid}` +
    ` reasoning-paid-source=${view.reasoning.paidSource}` +
    ` reasoning-legacy=${view.legacyReasoning || 'unset'}` +
    ` web-search=${switchState(view.webSearch)}` +
    ` web-fetch=${switchState(view.webFetch)}` +
    ` tools=${view.researchTools ? 'inventory+research' : 'inventory'}` +
    ` turn=${view.turn}`
  );
}

export interface TurnResultView {
  /** The id shared by every record this turn writes. */
  turn: string;
  outcome: string;
  totalMs: number;
  providerMs: number;
  toolMs: number;
  calls: number;
  /** Empty completions the turn had to retry (the AI-2 signal, kept for the usage report). */
  emptyResponses: number;
  /** Corrective re-requests: empty completions plus every grounding/read re-ask. */
  retries: number;
  failovers: number;
  /** Simple-route re-asks that asked the free model to perform its required read. */
  reasks: number;
  tools: readonly string[];
  toolRuns: number;
  inputTokens: number;
  outputTokens: number;
  /** `$0.000000`, `>=$0.002000` or `unknown` — already formatted by the caller. */
  cost: string;
  quota: string;
  web: string;
  /** The upstream provider the gateway named, or null when it named none. */
  upstream: string | null;
  model: string | null;
  route: string;
  escalations: number;
  iterations: number;
}

/**
 * The turn's closing record: status, duration, model, upstream, tools, tokens, credits and
 * attempts. Emitted from every exit, including the throwing ones, so a failed turn still
 * reports what it spent before it died.
 */
export function turnResultLine(view: TurnResultView): string {
  return (
    `AI turn outcome=${view.outcome} status=${turnStatus(view.outcome)}` +
    ` duration=${durationSeconds(view.totalMs)} total=${view.totalMs}ms` +
    ` providerMs=${view.providerMs}ms toolMs=${view.toolMs}ms` +
    ` calls=${view.calls} attempts=${view.calls} empty=${view.emptyResponses}` +
    ` retries=${view.retries} failovers=${view.failovers} reasks=${view.reasks}` +
    ` tools=${view.tools.join(',') || 'none'} toolRuns=${view.toolRuns}` +
    ` in=${view.inputTokens} out=${view.outputTokens} cost=${view.cost}` +
    ` quota=${view.quota} web=${view.web}` +
    ` upstream=${view.upstream ?? 'unknown'}` +
    ` model=${view.model ?? 'unknown'} tier=${view.model ? modelTier(view.model) : 'unknown'}` +
    ` route=${view.route} simpleEscalations=${view.escalations}` +
    ` iterations=${view.iterations} turn=${view.turn}`
  );
}

export interface ModelCallView {
  /** The id of the turn this request belongs to. */
  turn: string;
  /** The configured provider name (`openrouter`). Not the upstream model host. */
  provider: string;
  model: string;
  reasoning: 'enabled' | 'disabled';
  /** `disabled`, `omitted` or `enabled` — what the request actually carried. */
  field: string;
  source: string;
}

/** One provider request: the model, its tier, and the reasoning field actually sent. */
export function modelCallLine(view: ModelCallView): string {
  return (
    `AI model call provider=${view.provider} model=${view.model}` +
    ` tier=${modelTier(view.model)} reasoning=${view.reasoning}` +
    ` field=${view.field} source=${view.source} turn=${view.turn}`
  );
}

export interface ConfigurationView {
  /** The configured chain, primary first. */
  models: readonly string[];
  reasoning: ReasoningSettings;
  legacyReasoning: string;
  webSearch: boolean;
  webFetch: boolean;
}

/**
 * The boot record: what this process will do before any member asks a question.
 *
 * It answers the three environment questions an operator checks after a deploy — which models
 * are configured, which reasoning switches are on and where each value came from, and whether
 * the billable web tools are enabled — in one place instead of three lines an operator has to
 * correlate with the per-turn record.
 */
export function configurationLine(view: ConfigurationView): string {
  const paid = view.reasoning.simplePolicy
    ? reasoningState(view.reasoning.simplePolicy)
    : 'advanced';
  return (
    `AI configuration models=${view.models.join('->') || 'none'}` +
    ` reasoning-free=${reasoningState(view.reasoning.freePolicy)}` +
    ` reasoning-free-source=${view.reasoning.freeSource}` +
    ` reasoning-paid=${paid}` +
    ` reasoning-paid-source=${view.reasoning.paidSource}` +
    ` reasoning-legacy=${view.legacyReasoning || 'unset'}` +
    ` web-search=${switchState(view.webSearch)}` +
    ` web-fetch=${switchState(view.webFetch)}`
  );
}

export default {
  newTurnId,
  modelTier,
  turnStatus,
  durationSeconds,
  turnRequestLine,
  turnResultLine,
  modelCallLine,
  configurationLine,
};
