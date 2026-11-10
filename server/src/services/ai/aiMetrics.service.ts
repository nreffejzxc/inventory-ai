/**
 * AI-102 — durable per-turn metrics and the aggregation behind GET /api/ai/metrics.
 *
 * The monitoring lines from AI-101 are still the diagnostic record. This module adds the
 * queryable store those lines cannot be: one row per turn, written from the same `reportTurn`
 * exit that prints the closing line, and read only for the requested UTC day window.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   * No prompt, answer, tool argument, tool result, URL or credential is stored.
 *   * No cost estimate is fabricated. Only the provider-reported charge is summed; a missing
 *     charge stays `unknown`, and a partial sum is labelled `partial`.
 *   * No count of provider calls is presented as a count of turns. `calls`, `retries`,
 *     `reasks`, `failovers` and `escalations` are separate fields.
 */

import mongoose from 'mongoose';

import AiTurnMetric from '../../models/aiTurnMetric.model.ts';
import { modelTier, turnStatus } from './aiMonitor.ts';

export const DEFAULT_AI_METRICS_DAYS = 7;
export const MAX_AI_METRICS_DAYS = 90;

/** Everything `reportTurn` knows when a turn exits. */
export interface AiTurnMetricInput {
  turnId: string;
  businessId: string;
  userId?: string;
  startedAt: Date;
  completedAt: Date;
  outcome: string;
  route: string;
  model: string | null;
  upstream: string | null;
  durationMs: number;
  providerMs: number;
  toolMs: number;
  calls: number;
  emptyResponses: number;
  retries: number;
  failovers: number;
  reasks: number;
  escalations: number;
  iterations: number;
  toolRuns: number;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number | null;
  unknownCostCalls: number;
  quota: string;
  web: string;
}

/** The exact document shape written to `ai_turn_metrics`. */
export interface AiTurnMetricDocument {
  turnId: string;
  businessId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  startedAt: Date;
  completedAt: Date;
  outcome: string;
  status: 'ok' | 'degraded' | 'failed';
  route: string;
  model: string | null;
  tier: 'free' | 'paid' | 'unknown';
  upstream: string | null;
  durationMs: number;
  providerMs: number;
  toolMs: number;
  calls: number;
  emptyResponses: number;
  retries: number;
  failovers: number;
  reasks: number;
  escalations: number;
  iterations: number;
  toolRuns: number;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number | null;
  providerCostComplete: boolean;
  unknownCostCalls: number;
  costStatus: 'provider' | 'partial' | 'unknown';
  quota: string;
  web: string;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function costStatusFor(
  providerCostUsd: number | null,
  unknownCostCalls: number,
): 'provider' | 'partial' | 'unknown' {
  if (providerCostUsd === null) return 'unknown';
  return unknownCostCalls > 0 ? 'partial' : 'provider';
}

/**
 * Turn input -> the one document. Exported so the shape can be pinned without a database.
 *
 * `providerCostUsd` is accepted only when it is a finite, non-negative number. A malformed
 * value is treated as missing rather than coerced to zero, which is the one mistake this
 * feature must never make.
 */
export function buildAiTurnMetricDocument(input: AiTurnMetricInput): AiTurnMetricDocument {
  const providerCostUsd =
    typeof input.providerCostUsd === 'number' &&
    Number.isFinite(input.providerCostUsd) &&
    input.providerCostUsd >= 0
      ? input.providerCostUsd
      : null;
  const unknownCostCalls = Math.trunc(finiteNonNegative(input.unknownCostCalls));
  const costStatus = costStatusFor(providerCostUsd, unknownCostCalls);
  const model = input.model?.trim() || null;
  const tools = [...new Set(input.tools.map((tool) => tool.trim()).filter(Boolean))].slice(0, 64);

  return {
    turnId: input.turnId,
    businessId: new mongoose.Types.ObjectId(input.businessId),
    ...(input.userId ? { userId: new mongoose.Types.ObjectId(input.userId) } : {}),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    outcome: input.outcome,
    status: turnStatus(input.outcome),
    route: input.route,
    model,
    tier: model ? modelTier(model) : 'unknown',
    upstream: input.upstream?.trim() || null,
    durationMs: finiteNonNegative(input.durationMs),
    providerMs: finiteNonNegative(input.providerMs),
    toolMs: finiteNonNegative(input.toolMs),
    calls: Math.trunc(finiteNonNegative(input.calls)),
    emptyResponses: Math.trunc(finiteNonNegative(input.emptyResponses)),
    retries: Math.trunc(finiteNonNegative(input.retries)),
    failovers: Math.trunc(finiteNonNegative(input.failovers)),
    reasks: Math.trunc(finiteNonNegative(input.reasks)),
    escalations: Math.trunc(finiteNonNegative(input.escalations)),
    iterations: Math.trunc(finiteNonNegative(input.iterations)),
    toolRuns: Math.trunc(finiteNonNegative(input.toolRuns)),
    tools,
    inputTokens: Math.trunc(finiteNonNegative(input.inputTokens)),
    outputTokens: Math.trunc(finiteNonNegative(input.outputTokens)),
    providerCostUsd,
    providerCostComplete: costStatus === 'provider',
    unknownCostCalls,
    costStatus,
    quota: input.quota,
    web: input.web,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 11000);
}

/**
 * Write one turn. Best-effort and non-blocking: metrics must never change how a turn answers.
 *
 * The unique key includes `startedAt`, so a retry of the SAME turn updates its row while two
 * real turns that happen to share the short turn id remain two rows. A write attempted before
 * the database is connected is skipped rather than buffered, because a buffered write on a
 * process that is shutting down would be lost anyway and tests must not touch a database they
 * did not ask for.
 */
export async function recordAiTurnMetric(input: AiTurnMetricInput): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;

  let doc: AiTurnMetricDocument;
  try {
    doc = buildAiTurnMetricDocument(input);
  } catch (err) {
    console.error(
      `AI metrics record skipped turn=${input.turnId}: ${err instanceof Error ? err.message : 'invalid input'}`,
    );
    return false;
  }

  const filter = {
    businessId: doc.businessId,
    turnId: doc.turnId,
    startedAt: doc.startedAt,
  };
  try {
    await AiTurnMetric.updateOne(filter, { $set: doc }, { upsert: true });
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) {
      try {
        await AiTurnMetric.updateOne(filter, { $set: doc });
        return true;
      } catch (retryErr) {
        console.error(
          `AI metrics retry failed turn=${input.turnId}: ` +
            `${retryErr instanceof Error ? retryErr.message : 'unknown error'}`,
        );
        return false;
      }
    }
    console.error(
      `AI metrics write failed turn=${input.turnId}: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return false;
  }
}

/** Parse `?days=` without trusting the query value's type. */
export function parseAiMetricsDays(raw: unknown): { days: number; problem: string | null } {
  if (raw === undefined || raw === null || raw === '') {
    return { days: DEFAULT_AI_METRICS_DAYS, problem: null };
  }
  const value = Array.isArray(raw) ? '' : String(raw).trim();
  if (!value || !/^\d+$/.test(value)) {
    return {
      days: DEFAULT_AI_METRICS_DAYS,
      problem: `days must be an integer from 1 to ${MAX_AI_METRICS_DAYS}`,
    };
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_AI_METRICS_DAYS) {
    return {
      days: DEFAULT_AI_METRICS_DAYS,
      problem: `days must be an integer from 1 to ${MAX_AI_METRICS_DAYS}`,
    };
  }
  return { days, problem: null };
}

type RawRow = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rounded(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function integer(value: unknown): number {
  return Math.max(0, Math.trunc(num(value) ?? 0));
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function money(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n * 1_000_000) / 1_000_000;
}

function percentile(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  return rounded(value[0]);
}

function rangeStart(now: Date, days: number): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
}

function costSummary(row: RawRow, turns: number) {
  const reportedCostTurns = integer(row.reportedCostTurns);
  const completeCostTurns = integer(row.completeCostTurns);
  const partialCostTurns = integer(row.partialCostTurns);
  const unknownCostTurns = integer(row.unknownCostTurns);
  return {
    providerReportedUsd: reportedCostTurns > 0 ? money(row.providerReportedUsd) : null,
    reportedCostTurns,
    completeCostTurns,
    partialCostTurns,
    unknownCostTurns,
    complete: turns > 0 && completeCostTurns === turns,
    // Reserved for a future token-price estimator. It is null on purpose: this endpoint only
    // reports what the provider actually charged, and never turns an omission into a guess.
    estimatedUsd: null,
    estimatedAvailable: false,
    note: 'Provider-reported charges only. Unknown costs stay unknown; no estimate is fabricated.',
  };
}

function normalizeTotals(row: RawRow | undefined) {
  const source = row ?? {};
  const turns = integer(source.turns);
  const freeTurns = integer(source.freeTurns);
  const paidTurns = integer(source.paidTurns);
  const unknownTierTurns = integer(source.unknownTierTurns);
  const failoverTurns = integer(source.failoverTurns);
  return {
    turns,
    freeTurns,
    paidTurns,
    unknownTierTurns,
    freeRate: ratio(freeTurns, turns),
    paidRate: ratio(paidTurns, turns),
    okTurns: integer(source.okTurns),
    degradedTurns: integer(source.degradedTurns),
    failedTurns: integer(source.failedTurns),
    failoverTurns,
    failoverRate: ratio(failoverTurns, turns),
    failovers: integer(source.failovers),
    retries: integer(source.retries),
    reasks: integer(source.reasks),
    emptyResponses: integer(source.emptyResponses),
    simpleEscalationTurns: integer(source.simpleEscalationTurns),
    simpleEscalations: integer(source.simpleEscalations),
    latency: {
      sampleSize: turns,
      avgMs: rounded(source.avgMs),
      medianMs: percentile(source.medianMs),
      p95Ms: percentile(source.p95Ms),
      minMs: rounded(source.minMs),
      maxMs: rounded(source.maxMs),
      percentileMethod: 'approximate' as const,
    },
    cost: costSummary(source, turns),
  };
}

function normalizeDaily(date: string, row: RawRow | undefined) {
  const source = row ?? {};
  const turns = integer(source.turns);
  return {
    date,
    turns,
    freeTurns: integer(source.freeTurns),
    paidTurns: integer(source.paidTurns),
    unknownTierTurns: integer(source.unknownTierTurns),
    okTurns: integer(source.okTurns),
    degradedTurns: integer(source.degradedTurns),
    failedTurns: integer(source.failedTurns),
    failoverTurns: integer(source.failoverTurns),
    failovers: integer(source.failovers),
    retries: integer(source.retries),
    reasks: integer(source.reasks),
    avgMs: rounded(source.avgMs),
    medianMs: percentile(source.medianMs),
    p95Ms: percentile(source.p95Ms),
    minMs: rounded(source.minMs),
    maxMs: rounded(source.maxMs),
    ...costSummary(source, turns),
  };
}

const GROUP_FIELDS = {
  turns: { $sum: 1 },
  freeTurns: { $sum: { $cond: [{ $eq: ['$tier', 'free'] }, 1, 0] } },
  paidTurns: { $sum: { $cond: [{ $eq: ['$tier', 'paid'] }, 1, 0] } },
  unknownTierTurns: { $sum: { $cond: [{ $eq: ['$tier', 'unknown'] }, 1, 0] } },
  okTurns: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 1, 0] } },
  degradedTurns: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
  failedTurns: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
  failoverTurns: { $sum: { $cond: [{ $gt: ['$failovers', 0] }, 1, 0] } },
  failovers: { $sum: '$failovers' },
  retries: { $sum: '$retries' },
  reasks: { $sum: '$reasks' },
  emptyResponses: { $sum: '$emptyResponses' },
  simpleEscalationTurns: { $sum: { $cond: [{ $gt: ['$escalations', 0] }, 1, 0] } },
  simpleEscalations: { $sum: '$escalations' },
  avgMs: { $avg: '$durationMs' },
  medianMs: { $percentile: { input: '$durationMs', p: [0.5], method: 'approximate' } },
  p95Ms: { $percentile: { input: '$durationMs', p: [0.95], method: 'approximate' } },
  minMs: { $min: '$durationMs' },
  maxMs: { $max: '$durationMs' },
  providerReportedUsd: { $sum: '$providerCostUsd' },
  reportedCostTurns: { $sum: { $cond: [{ $ne: ['$providerCostUsd', null] }, 1, 0] } },
  completeCostTurns: { $sum: { $cond: ['$providerCostComplete', 1, 0] } },
  partialCostTurns: { $sum: { $cond: [{ $eq: ['$costStatus', 'partial'] }, 1, 0] } },
  unknownCostTurns: { $sum: { $cond: [{ $eq: ['$costStatus', 'unknown'] }, 1, 0] } },
};

export interface AiMetricsResult {
  asOf: string;
  range: {
    from: string;
    to: string;
    days: number;
    timeZone: 'UTC';
  };
  totals: ReturnType<typeof normalizeTotals>;
  daily: Array<ReturnType<typeof normalizeDaily>>;
}

/**
 * The metrics report for one business over the last `days` UTC calendar days, including today.
 *
 * The database does the counting and percentiles in one tenant-scoped aggregation. The route
 * only reads this window (`days` <= 90), never the whole history, and the (businessId,
 * completedAt) index serves the match. Days with no turns are emitted as zeros so a chart has
 * a continuous axis rather than gaps that look like missing data.
 */
export async function getAiMetrics(
  businessId: string,
  { days, now = new Date() }: { days: number; now?: Date },
): Promise<AiMetricsResult> {
  const boundedDays = Math.min(MAX_AI_METRICS_DAYS, Math.max(1, Math.trunc(days)));
  const from = rangeStart(now, boundedDays);
  const to = now;

  const [facet] = await AiTurnMetric.aggregate([
    {
      $match: {
        businessId: new mongoose.Types.ObjectId(businessId),
        completedAt: { $gte: from, $lte: to },
      },
    },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...GROUP_FIELDS } }],
        daily: [
          {
            $group: {
              _id: {
                $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'UTC' },
              },
              ...GROUP_FIELDS,
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  const rawTotals = (facet?.totals?.[0] ?? undefined) as RawRow | undefined;
  const rawDaily = Array.isArray(facet?.daily) ? (facet.daily as RawRow[]) : [];
  const byDate = new Map<string, RawRow>();
  for (const row of rawDaily) {
    const key = typeof row._id === 'string' ? row._id : '';
    if (key) byDate.set(key, row);
  }

  const daily: AiMetricsResult['daily'] = [];
  for (let i = 0; i < boundedDays; i += 1) {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = day.toISOString().slice(0, 10);
    daily.push(normalizeDaily(key, byDate.get(key)));
  }

  return {
    asOf: to.toISOString(),
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: boundedDays,
      timeZone: 'UTC',
    },
    totals: normalizeTotals(rawTotals),
    daily,
  };
}

export default {
  DEFAULT_AI_METRICS_DAYS,
  MAX_AI_METRICS_DAYS,
  buildAiTurnMetricDocument,
  recordAiTurnMetric,
  parseAiMetricsDays,
  getAiMetrics,
};
