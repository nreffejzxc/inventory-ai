/**
 * AI-34 — a scheduled watchdog for the assistant's model chain.
 *
 * WHY THIS EXISTS. AI-28 can answer "is the configured model still listed?" when an operator
 * asks, and AI-29/30/31 keep a turn alive when the primary breaks. None of them notices
 * anything while nobody is asking. On 2026-10-21 the deployment learned that its model was
 * dead from a member's failed question; the watchdog exists so the next outage is discovered
 * by a timer, before the first member of the day.
 *
 * WHAT IT READS, AND WHAT IT COSTS. `readModelHealth` calls the provider's own endpoint-health
 * API: `GET /v1/models/{author}/{slug}/endpoints`. It sends no completion, so it spends none
 * of the free tier's request allowance. This module never calls `probeModel`, which is the one
 * check that costs a request.
 *
 * WHAT COUNTS AS A PROBLEM.
 *
 *   unavailable — the provider does not publish the model, publishes no endpoint, or no
 *                 endpoint currently reports status 0 AND no recent uptime is measurable.
 *                 This is the state that means "a turn will fail".
 *   degraded    — an endpoint is currently down while another is up, or no endpoint reports
 *                 status 0 but the model is still serving measurable traffic, or the best
 *                 5-minute / 30-minute uptime has fallen below its threshold. This is the
 *                 "deteriorating" half of the requirement: it warns before the status turns.
 *                 (A non-zero provider status is not proof of an outage: on 2026-10-21 the
 *                 provider published status -2 with 100% five-minute uptime for a serving model,
 *                 and the first draft of this module wrongly called that unavailable.)
 *   unknown     — the health record could not be read. NOT a claim that the model is down:
 *                 the check itself may be the thing that is broken. Two consecutive unknown
 *                 readings are alerted, because a provider that cannot be reached is also an
 *                 outage the operator needs to know about.
 *   ok          — a current healthy endpoint with uptime at or above the thresholds.
 *
 * ALERT ON CHANGE, NOT ON EVERY CHECK. The watcher keeps the last level per model, so a model
 * that stays down for an hour produces one message rather than twelve, and the recovery is
 * reported once. That state is process-local: a restart re-sends one alert for a still-broken
 * model, which is the correct trade for a deployment that has one instance and no shared store.
 * The breaker (AI-30) is process-local for the same reason.
 *
 * WHERE THE ALERT GOES. Operator email through the existing provider-agnostic mail boundary,
 * to `AI_HEALTH_ALERT_EMAIL`. If no recipient or no mail is configured, the alert is logged at
 * error level — an alert that cannot be delivered must still be recorded. Nothing here names a
 * key, a base URL, a tenant or a user.
 *
 * SCHEDULING. `startAiHealthWatch` is started by `startServer` in production (or explicitly with
 * `AI_HEALTH_WATCH_ENABLED=true`). It is deliberately not started in tests, and its timers are
 * unref'd so a watchdog can never keep the process alive. A free hosting instance that sleeps
 * stops checking while it sleeps; `npm run ai:health` is the one-shot equivalent for an external
 * scheduler or an operator.
 */

import { MAX_FALLBACK_MODELS } from './aiConfig.ts';
import { readModelHealth } from './modelCheck.ts';
import type { EndpointHealth, ModelHealthResult } from './modelCheck.ts';
import { applyHealthVerdicts, DEFAULT_HEALTH_MARK_TTL_MS } from './modelHealthGate.ts';
import { activeModel, promotedModel, resetModelSelection } from './modelSelection.ts';
import { isModelCooling } from './modelBreaker.ts';
import { quotaSnapshot } from './quota.ts';
import { isMailConfigured, sendOperationalAlertEmail } from '../mail/index.ts';

export type ModelRole = 'primary' | 'fallback';
export type ModelHealthLevel = 'ok' | 'degraded' | 'unavailable' | 'unknown';
export type AlertDelivery = 'email' | 'log' | 'none';

/** The uptime thresholds, as percentages. */
export interface WatchThresholds {
  minUptime5m: number;
  minUptime30m: number;
}

/**
 * The shipped thresholds. A 5-minute window at 90% and a 30-minute window at 95% warn about a
 * model that is failing some requests while its status still reads healthy; both are compared
 * against the BEST current endpoint, so a redundant provider with one healthy route is not
 * called degraded merely because a second route exists.
 */
export const DEFAULT_THRESHOLDS: WatchThresholds = {
  minUptime5m: 90,
  minUptime30m: 95,
};

/** How many consecutive unreadable checks before "the check cannot run" is alerted. */
export const DEFAULT_UNKNOWN_ALERT_AFTER = 2;

/**
 * AI-37 — how many CONSECUTIVE healthy readings of the configured model end a promotion.
 *
 * Two, not one: a single sample can land between two failures, and returning on it would churn
 * the active model exactly as eagerly as AI-31 refuses to. Two consecutive readings at the
 * watchdog's cadence is a recovery an hour-long outage cannot fake.
 */
export const DEFAULT_PRIMARY_RECOVERY_CHECKS = 2;

/** The shipped schedule: every 30 minutes, first check one minute after boot. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface ModelVerdict {
  model: string;
  role: ModelRole;
  level: ModelHealthLevel;
  /** A fixed, credential-free sentence an operator can act on. */
  reason: string;
  /** Every endpoint the provider published, for the alert body. */
  endpoints: EndpointHealth[];
}

export interface HealthChange {
  model: string;
  role: ModelRole;
  from: ModelHealthLevel | 'first';
  to: ModelHealthLevel;
  reason: string;
  endpoints: EndpointHealth[];
}

export interface WatchAlert {
  subject: string;
  text: string;
}

export interface WatchRunResult {
  verdicts: ModelVerdict[];
  changes: HealthChange[];
  alert: WatchAlert | null;
  delivered: AlertDelivery;
  /** Set when there was nothing to check, so a caller can tell "quiet" from "skipped". */
  skipped?: string;
}

export interface HealthWatcherOptions {
  env?: Record<string, string | undefined>;
  readHealth?: (input: { model: string }) => Promise<ModelHealthResult>;
  sendAlert?: (alert: WatchAlert, context: { env: Record<string, string | undefined>; logger: Logger }) => Promise<AlertDelivery>;
  logger?: Logger;
  thresholds?: Partial<WatchThresholds>;
  unknownAlertAfter?: number;
  /** The clock, for a deterministic alert timestamp. Accepts a Date or epoch milliseconds. */
  now?: () => Date | number;
  fetchImpl?: typeof fetch;
  /**
   * AI-35 — how long an `unavailable` reading holds a model out of selection. Defaults to one
   * watchdog interval plus a minute, so the next reading (not the clock) is what releases it.
   */
  healthTtlMs?: number;
  /**
   * AI-37 — how many CONSECUTIVE healthy readings of the configured primary are needed before the
   * deployment returns to it after a promotion. Two: one reading is a sample, two is a recovery.
   */
  primaryRecoveryChecks?: number;
  /**
   * AI-37 — the act of returning to the configured model. Injectable so a suite can observe it
   * without touching process-wide state; returns true only when it actually changed something.
   */
  returnToPrimary?: () => boolean;
}

export interface HealthWatcher {
  run(): Promise<WatchRunResult>;
}

export interface HealthWatchHandle {
  runNow(): Promise<WatchRunResult>;
  stop(): void;
}

interface StateEntry {
  level: ModelHealthLevel;
  unknownStreak: number;
  /** True once an alert has been sent for this model and a recovery is therefore owed. */
  alerted: boolean;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentThreshold(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

/** The thresholds this deployment watches with. Invalid values fall back, never disable. */
export function watchThresholds(env: Record<string, string | undefined> = process.env): WatchThresholds {
  return {
    minUptime5m: percentThreshold(env.AI_HEALTH_MIN_UPTIME_5M, DEFAULT_THRESHOLDS.minUptime5m),
    minUptime30m: percentThreshold(env.AI_HEALTH_MIN_UPTIME_30M, DEFAULT_THRESHOLDS.minUptime30m),
  };
}

/** The schedule and detection settings, read lazily so an operator can change them without code. */
export function healthWatchConfig(env: Record<string, string | undefined> = process.env) {
  return {
    intervalMs: positiveInt(env.AI_HEALTH_WATCH_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    initialDelayMs: positiveInt(env.AI_HEALTH_WATCH_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS),
    unknownAlertAfter: positiveInt(env.AI_HEALTH_UNKNOWN_ALERT_AFTER, DEFAULT_UNKNOWN_ALERT_AFTER),
    thresholds: watchThresholds(env),
  };
}

/**
 * Is the watchdog enabled for this process?
 *
 * Production is on by default; development is off unless `AI_HEALTH_WATCH_ENABLED=true`, so a
 * local `npm start` does not contact the provider on a timer. Tests are always off, because a
 * suite must never reach a provider — the same rule the boot model check follows.
 */
export function healthWatchEnabled(
  nodeEnv: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if ((nodeEnv || '').trim().toLowerCase() === 'test') return false;
  const raw = (env.AI_HEALTH_WATCH_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return (nodeEnv || '').trim().toLowerCase() === 'production';
}

/**
 * The models a turn could use: the configured primary first, then the ordered, deduplicated,
 * capped fallback chain. The primary is never watched twice, exactly as the turn loop skips it
 * in the candidate list.
 */
export function configuredModels(
  env: Record<string, string | undefined> = process.env,
): Array<{ model: string; role: ModelRole }> {
  const primary = (env.AI_MODEL_OPENROUTER || '').trim();
  if (!primary) return [];

  const out: Array<{ model: string; role: ModelRole }> = [{ model: primary, role: 'primary' }];
  const seen = new Set([primary]);
  for (const part of String(env.AI_FALLBACK_MODELS_OPENROUTER ?? '').split(',')) {
    const model = part.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push({ model, role: 'fallback' });
    if (out.length > MAX_FALLBACK_MODELS) break;
  }
  return out;
}

function formatPercent(value: number | null): string {
  if (value === null) return 'n/a';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function endpointLine(endpoint: EndpointHealth): string {
  return (
    `${endpoint.provider} status ${endpoint.status === null ? 'n/a' : endpoint.status}; ` +
    `5m ${formatPercent(endpoint.uptime5m)}, 30m ${formatPercent(endpoint.uptime30m)}`
  );
}

function bestUptime(endpoints: EndpointHealth[], key: 'uptime5m' | 'uptime30m'): number | null {
  let best: number | null = null;
  for (const endpoint of endpoints) {
    const value = endpoint[key];
    if (value === null) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function thresholdNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : fallback;
}

/**
 * Classify one model. Pure: it makes no request and reads no clock, so every branch is
 * asserted directly.
 */
export function classifyModelHealth({
  model,
  role,
  health,
  thresholds = DEFAULT_THRESHOLDS,
}: {
  model: string;
  role: ModelRole;
  health: ModelHealthResult;
  thresholds?: Partial<WatchThresholds>;
}): ModelVerdict {
  const min5 = thresholdNumber(thresholds.minUptime5m, DEFAULT_THRESHOLDS.minUptime5m);
  const min30 = thresholdNumber(thresholds.minUptime30m, DEFAULT_THRESHOLDS.minUptime30m);
  const base = { model, role, endpoints: Array.isArray(health.endpoints) ? health.endpoints : [] };

  if (health.status === 'not_applicable') {
    return { ...base, level: 'unknown', reason: health.message || 'the health check is not configured' };
  }
  if (health.status === 'unreachable') {
    return {
      ...base,
      level: 'unknown',
      reason: health.message || 'the provider could not be reached, so the model was not verified',
    };
  }
  if (health.status === 'not_found' || health.status === 'no_endpoints') {
    return {
      ...base,
      level: 'unavailable',
      reason: health.message || 'the provider publishes no endpoint for this model',
    };
  }

  const endpoints = base.endpoints;
  if (endpoints.length === 0) {
    return { ...base, level: 'unavailable', reason: 'the provider reported no endpoints for this model' };
  }

  const current = endpoints.filter((endpoint) => endpoint.status === 0);
  if (current.length === 0) {
    const detail = endpoints.map(endpointLine).join(' | ');
    const best5 = bestUptime(endpoints, 'uptime5m');
    const best30 = bestUptime(endpoints, 'uptime30m');

    // A non-zero provider status does not by itself mean "cannot serve". The provider uses
    // negative codes for a degraded endpoint that is still answering some requests (measured
    // 2026-10-21: status -2 with 100% 5-minute uptime), and calling that unavailable would send
    // an operator to replace a working model. Unavailable is reserved for no healthy status AND
    // no measurable recent uptime; anything still serving is degraded.
    if (best5 === null || best5 <= 0) {
      return {
        ...base,
        level: 'unavailable',
        reason: `no endpoint currently reports status 0 and no recent uptime is measurable (${detail})`,
      };
    }

    return {
      ...base,
      level: 'degraded',
      reason:
        `no endpoint currently reports status 0, but the best 5-minute uptime is ` +
        `${formatPercent(best5)} (30m ${formatPercent(best30)}) (${detail})`,
    };
  }

  const down = endpoints.filter((endpoint) => endpoint.status !== 0);
  if (down.length > 0) {
    return {
      ...base,
      level: 'degraded',
      reason:
        `${down.length} of ${endpoints.length} endpoint(s) not currently healthy ` +
        `(${down.map(endpointLine).join(' | ')})`,
    };
  }

  const best5 = bestUptime(current, 'uptime5m');
  const best30 = bestUptime(current, 'uptime30m');
  if (best5 !== null && best5 < min5) {
    return {
      ...base,
      level: 'degraded',
      reason: `best 5-minute uptime is ${formatPercent(best5)}, below the ${min5}% threshold`,
    };
  }
  if (best30 !== null && best30 < min30) {
    return {
      ...base,
      level: 'degraded',
      reason: `best 30-minute uptime is ${formatPercent(best30)}, below the ${min30}% threshold`,
    };
  }

  return {
    ...base,
    level: 'ok',
    reason:
      `${endpoints.length} endpoint(s) healthy; best 5m ${formatPercent(best5)}, ` +
      `30m ${formatPercent(best30)}`,
  };
}

function severityLabel(level: ModelHealthLevel): string {
  if (level === 'unavailable') return 'UNAVAILABLE';
  if (level === 'degraded') return 'DEGRADED';
  if (level === 'unknown') return 'CANNOT VERIFY';
  return 'OK';
}

function alertSeverity(changes: HealthChange[]): 'unavailable' | 'degraded' | 'unknown' | 'recovered' {
  if (changes.some((change) => change.to === 'unavailable')) return 'unavailable';
  if (changes.some((change) => change.to === 'degraded')) return 'degraded';
  if (changes.some((change) => change.to === 'unknown')) return 'unknown';
  return 'recovered';
}

function alertSubject(severity: ReturnType<typeof alertSeverity>): string {
  if (severity === 'unavailable') return 'Inventory AI assistant: model unavailable';
  if (severity === 'degraded') return 'Inventory AI assistant: model degraded';
  if (severity === 'unknown') return 'Inventory AI assistant: health check cannot run';
  return 'Inventory AI assistant: model recovered';
}

/**
 * The operator-facing report. A change is stated with its previous level, the reason, and the
 * endpoint rows that produced it; the current state of every model follows, so one mail answers
 * "what changed?" and "what is the state now?" without opening the provider dashboard.
 */
export function buildHealthAlert({
  changes,
  verdicts,
  at = new Date(),
}: {
  changes: HealthChange[];
  verdicts: ModelVerdict[];
  at?: Date;
}): WatchAlert {
  const severity = alertSeverity(changes);
  const lines: string[] = [
    `Inventory AI assistant model-health change at ${at.toISOString()}.`,
    '',
  ];

  const grouped = new Map<ModelHealthLevel, HealthChange[]>();
  for (const change of changes) {
    const bucket = grouped.get(change.to) ?? [];
    bucket.push(change);
    grouped.set(change.to, bucket);
  }

  for (const level of ['unavailable', 'degraded', 'unknown', 'ok'] as const) {
    const bucket = grouped.get(level);
    if (!bucket || bucket.length === 0) continue;
    lines.push(severityLabel(level));
    for (const change of bucket) {
      const from = change.from === 'first' ? 'first check' : `was ${change.from}`;
      lines.push(`- ${change.role} ${change.model} (${from})`);
      lines.push(`  ${change.reason}`);
      for (const endpoint of change.endpoints) {
        lines.push(`  ${endpointLine(endpoint)}`);
      }
    }
    lines.push('');
  }

  lines.push('Current state');
  for (const verdict of verdicts) {
    lines.push(`- ${verdict.role} ${verdict.model}: ${severityLabel(verdict.level).toLowerCase()}`);
    lines.push(`  ${verdict.reason}`);
  }
  lines.push('');
  lines.push('This check reads only the provider endpoint-health API (GET, no completion, no quota).');

  return {
    subject: alertSubject(severity),
    text: lines.join('\n'),
  };
}

/**
 * Compare this run with the last one and return only the changes worth a message.
 *
 * The rules are deliberately asymmetric:
 *   * a healthy first check is silent;
 *   * a problem on the first check is announced (the deployment was already broken);
 *   * an unchanged problem is silent;
 *   * a recovery is announced once;
 *   * `unknown` is not allowed to overwrite a known problem — the check failing is not evidence
 *     that the model recovered — and it is announced only after consecutive failures.
 */
function applyVerdicts(
  verdicts: ModelVerdict[],
  state: Map<string, StateEntry>,
  unknownAlertAfter: number,
): HealthChange[] {
  const changes: HealthChange[] = [];
  const seen = new Set<string>();

  for (const verdict of verdicts) {
    seen.add(verdict.model);
    const previous = state.get(verdict.model);

    if (verdict.level === 'unknown') {
      const streak = (previous?.unknownStreak ?? 0) + 1;
      if (previous?.alerted) {
        // A known problem stays known. The check could not run; that is not a recovery.
        state.set(verdict.model, { ...previous, unknownStreak: streak });
        continue;
      }
      if (streak >= unknownAlertAfter) {
        changes.push({
          model: verdict.model,
          role: verdict.role,
          from: previous?.level ?? 'first',
          to: 'unknown',
          reason: verdict.reason,
          endpoints: verdict.endpoints,
        });
        state.set(verdict.model, { level: 'unknown', unknownStreak: streak, alerted: true });
      } else {
        state.set(verdict.model, {
          level: previous?.level ?? 'unknown',
          unknownStreak: streak,
          alerted: false,
        });
      }
      continue;
    }

    if (!previous || previous.level !== verdict.level) {
      const needsAlert = verdict.level !== 'ok' || previous?.alerted === true;
      if (needsAlert) {
        changes.push({
          model: verdict.model,
          role: verdict.role,
          from: previous?.level ?? 'first',
          to: verdict.level,
          reason: verdict.reason,
          endpoints: verdict.endpoints,
        });
      }
    }

    state.set(verdict.model, {
      level: verdict.level,
      unknownStreak: 0,
      alerted: verdict.level !== 'ok',
    });
  }

  // A model removed from configuration is no longer the operator's problem.
  for (const model of [...state.keys()]) {
    if (!seen.has(model)) state.delete(model);
  }

  return changes;
}

async function defaultSendAlert(
  alert: WatchAlert,
  { env, logger }: { env: Record<string, string | undefined>; logger: Logger },
): Promise<AlertDelivery> {
  const to = (env.AI_HEALTH_ALERT_EMAIL || '').trim();
  if (!to) {
    logger.error(`AI watchdog: ${alert.subject} — AI_HEALTH_ALERT_EMAIL is not set; the report is in this log.`);
    return 'log';
  }
  if (!isMailConfigured()) {
    logger.error(`AI watchdog: ${alert.subject} — mail is not configured; the report is in this log.`);
    return 'log';
  }
  try {
    await sendOperationalAlertEmail({ to, subject: alert.subject, text: alert.text });
    logger.error(`AI watchdog: ${alert.subject} — alert emailed to the configured recipient.`);
    return 'email';
  } catch {
    // No upstream message, no recipient and no key in the log. The report above is the alert.
    logger.error(`AI watchdog: ${alert.subject} — the alert email could not be sent; the report is in this log.`);
    return 'log';
  }
}

/**
 * Build a watcher. The state is per instance and per process: the scheduler holds one for the
 * life of the deployment, and `runAiHealthWatch` builds a fresh one for a one-shot CLI run.
 */
export function createHealthWatcher(options: HealthWatcherOptions = {}): HealthWatcher {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? watchThresholds(env)) };
  const unknownAlertAfter = Math.max(1, options.unknownAlertAfter ?? positiveInt(env.AI_HEALTH_UNKNOWN_ALERT_AFTER, DEFAULT_UNKNOWN_ALERT_AFTER));
  const now = options.now ?? (() => new Date());
  const atDate = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const readHealth =
    options.readHealth ??
    (({ model }: { model: string }) =>
      readModelHealth({ model, env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }));
  const sendAlert = options.sendAlert ?? defaultSendAlert;
  const state = new Map<string, StateEntry>();
  const recoveryChecks = Math.max(1, options.primaryRecoveryChecks ?? DEFAULT_PRIMARY_RECOVERY_CHECKS);
  // AI-37 — the act of returning to the configured model. The default is deliberately the real
  // one: a promotion that is no longer justified is dropped, and nothing is written to `.env`.
  const returnToPrimary =
    options.returnToPrimary ??
    (() => {
      if (!promotedModel()) return false;
      resetModelSelection();
      return true;
    });
  // Consecutive healthy readings of the CONFIGURED model, per watcher instance.
  let primaryOkStreak = 0;

  return {
    async run(): Promise<WatchRunResult> {
      const provider = (env.AI_PROVIDER || '').trim().toLowerCase();
      if (provider !== 'openrouter') {
        // The endpoint-health API this watchdog reads belongs to OpenRouter. A deployment with
        // no AI, or with a different provider, must not be reported as "cannot verify" twice an
        // hour — there is simply nothing here to ask.
        logger.log('AI watchdog no OpenRouter model is configured, so there is nothing to watch');
        return {
          verdicts: [],
          changes: [],
          alert: null,
          delivered: 'none',
          skipped: 'AI is not configured for OpenRouter',
        };
      }

      const models = configuredModels(env);
      if (models.length === 0) {
        logger.log('AI watchdog no AI model is configured, so there is nothing to watch');
        return {
          verdicts: [],
          changes: [],
          alert: null,
          delivered: 'none',
          skipped: 'no configured model',
        };
      }

      const verdicts = await collectVerdicts(models, readHealth, thresholds);

      // AI-35 — the same reading that alerts also decides which models the NEXT turn may start
      // on. It is applied here rather than only at boot so a model that breaks (or recovers)
      // while the process is serving is reflected in selection at the next check.
      applyHealthVerdicts(verdicts, {
        primary: models[0]?.model,
        ttlMs: options.healthTtlMs ?? DEFAULT_HEALTH_MARK_TTL_MS,
      });

      // AI-37 — the other half of failing over: coming back. A promotion is sticky while the
      // promoted model serves, which is what keeps the active model stable; without this it was
      // *only* a restart that ended one. The configured model returning to healthy twice in a
      // row is the evidence that ends it now.
      const configuredPrimary = models[0]?.model ?? null;
      const primaryVerdict = configuredPrimary
        ? verdicts.find((verdict) => verdict.model === configuredPrimary)
        : undefined;
      primaryOkStreak = primaryVerdict?.level === 'ok' ? primaryOkStreak + 1 : 0;
      if (configuredPrimary && primaryOkStreak >= recoveryChecks && returnToPrimary()) {
        logger.error(
          `AI watchdog the configured model is healthy again (${primaryOkStreak} consecutive` +
            ` check(s)) — returning to it: ${configuredPrimary}`,
        );
      }

      const changes = applyVerdicts(verdicts, state, unknownAlertAfter);
      const counts = {
        ok: verdicts.filter((verdict) => verdict.level === 'ok').length,
        degraded: verdicts.filter((verdict) => verdict.level === 'degraded').length,
        unavailable: verdicts.filter((verdict) => verdict.level === 'unavailable').length,
        unknown: verdicts.filter((verdict) => verdict.level === 'unknown').length,
      };
      // AI-39 — the LIVE state, beside the readings it came from: which model a new turn would
      // start on (a promotion is a runtime fact), the configured choice, the ids in cooldown, and
      // the last allowance reading. Without this, "is production on its preferred model right
      // now?" could only be answered by grepping for a promotion that may be hours old.
      const cooling = models
        .filter((entry) => isModelCooling(entry.model))
        .map((entry) => entry.model);
      const configuredLabel = models[0]?.model ?? 'none';
      const active = activeModel(configuredLabel === 'none' ? null : configuredLabel) ?? 'none';
      const allowance = quotaSnapshot();
      const quotaText = !allowance
        ? 'unknown'
        : `${allowance.remaining === null ? 'unknown' : allowance.remaining}` +
          (allowance.limit === null ? '' : `/${allowance.limit}`);
      logger.log(
        `AI watchdog checked ${verdicts.length} model(s): ${counts.ok} ok, ` +
          `${counts.degraded} degraded, ${counts.unavailable} unavailable, ${counts.unknown} unknown` +
          `; active=${active} (configured=${configuredLabel})` +
          ` cooling=${cooling.join(',') || 'none'} quota=${quotaText}` +
          (changes.length > 0 ? `; ${changes.length} change(s)` : ''),
      );

      if (changes.length === 0) {
        return { verdicts, changes, alert: null, delivered: 'none' };
      }

      const alert = buildHealthAlert({ changes, verdicts, at: atDate() });
      let delivered: AlertDelivery;
      try {
        delivered = await sendAlert(alert, { env, logger });
      } catch {
        // A transport failure must never be the reason the watchdog stops running.
        delivered = 'log';
        logger.error('AI watchdog: the alert could not be delivered; the report is in this log.');
      }
      return { verdicts, changes, alert, delivered };
    },
  };
}

/**
 * AI-35 — read every configured model's endpoint health ONCE and apply it to selection.
 *
 * This is the boot half of the feature: `startServer` fires it unawaited (like the catalogue and
 * capability reads), so a cold process starts a turn on a model that is serving instead of paying
 * for a model the provider already publishes as broken. It sends no completion, so it spends no
 * request from the free tier's allowance.
 *
 * It NEVER throws and never refuses service: a failed reading is `unreachable`, which marks
 * nothing. With no OpenRouter deployment it does not contact a provider at all.
 */
export interface HealthGateRefreshOptions {
  env?: Record<string, string | undefined>;
  readHealth?: (input: { model: string }) => Promise<ModelHealthResult>;
  ttlMs?: number;
  now?: number;
  logger?: Logger;
}

export interface HealthGateRefreshResult {
  status: 'ok' | 'skipped' | 'not_applicable';
  blocked: string[];
  cleared: string[];
  released: string[];
}

/** Read one verdict per configured model. Shared by the watchdog and the boot refresh. */
async function collectVerdicts(
  models: Array<{ model: string; role: ModelRole }>,
  readHealth: (input: { model: string }) => Promise<ModelHealthResult>,
  thresholds: WatchThresholds,
): Promise<ModelVerdict[]> {
  const verdicts: ModelVerdict[] = [];
  for (const entry of models) {
    let result: ModelHealthResult;
    try {
      result = await readHealth({ model: entry.model });
      if (!result || typeof result !== 'object') {
        result = {
          status: 'unreachable',
          model: entry.model,
          message: 'the health check returned no result',
          endpoints: [],
        };
      }
    } catch {
      result = {
        status: 'unreachable',
        model: entry.model,
        message: 'the health check threw before it could report a result',
        endpoints: [],
      };
    }
    verdicts.push(classifyModelHealth({ model: entry.model, role: entry.role, health: result, thresholds }));
  }
  return verdicts;
}

export async function refreshModelHealthGate(
  options: HealthGateRefreshOptions = {},
): Promise<HealthGateRefreshResult> {
  const env = options.env ?? process.env;
  const empty: HealthGateRefreshResult = { status: 'skipped', blocked: [], cleared: [], released: [] };
  if ((env.AI_PROVIDER || '').trim().toLowerCase() !== 'openrouter') {
    return { ...empty, status: 'not_applicable' };
  }
  const models = configuredModels(env);
  if (models.length === 0) return empty;

  const readHealth =
    options.readHealth ?? (({ model }: { model: string }) => readModelHealth({ model, env }));
  const verdicts = await collectVerdicts(models, readHealth, watchThresholds(env));
  const outcome = applyHealthVerdicts(verdicts, {
    primary: models[0]?.model,
    ttlMs: options.ttlMs ?? DEFAULT_HEALTH_MARK_TTL_MS,
    now: options.now ?? Date.now(),
  });

  if (outcome.blocked.length > 0 || outcome.cleared.length > 0) {
    const logger = options.logger ?? console;
    logger.log(
      `AI model health model selection: unavailable=${outcome.blocked.join(',') || 'none'}` +
        ` recovered=${outcome.cleared.join(',') || 'none'}` +
        (outcome.released.length > 0
          ? ` (released the configured primary so the assistant still has one attempt: ${outcome.released.join(', ')})`
          : ''),
    );
  }

  return { status: 'ok', blocked: outcome.blocked, cleared: outcome.cleared, released: outcome.released };
}

/** One check with no remembered state. Used by `npm run ai:health` and by a one-off test. */
export async function runAiHealthWatch(options: HealthWatcherOptions = {}): Promise<WatchRunResult> {
  return createHealthWatcher(options).run();
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (maybe && typeof maybe.unref === 'function') maybe.unref();
}

export interface HealthWatchScheduleOptions extends HealthWatcherOptions {
  /** Overrides the watcher's run, for a scheduler test that should not touch the provider. */
  run?: () => Promise<WatchRunResult>;
  intervalMs?: number;
  initialDelayMs?: number;
}

/**
 * Start the periodic check and return a handle that can stop it.
 *
 * The next check is scheduled only after the previous one settles, so a slow provider cannot
 * produce overlapping runs. Every timer is unref'd: the watchdog may never keep the process
 * alive during shutdown.
 */
export function startAiHealthWatch(options: HealthWatchScheduleOptions = {}): HealthWatchHandle {
  const config = healthWatchConfig(options.env ?? process.env);
  const intervalMs = options.intervalMs ?? config.intervalMs;
  const initialDelayMs = options.initialDelayMs ?? config.initialDelayMs;
  const logger = options.logger ?? console;
  const watcher = options.run ? null : createHealthWatcher(options);
  const run = options.run ?? (() => watcher!.run());

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<WatchRunResult> | null = null;

  const runOnce = (): Promise<WatchRunResult> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await run();
      } catch {
        logger.error('AI watchdog the scheduled check failed; the next run is still scheduled.');
        return { verdicts: [], changes: [], alert: null, delivered: 'none' };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().finally(() => schedule(intervalMs));
    }, delay);
    unrefTimer(timer);
  };

  schedule(initialDelayMs);

  return {
    runNow: runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export default {
  DEFAULT_THRESHOLDS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_UNKNOWN_ALERT_AFTER,
  DEFAULT_PRIMARY_RECOVERY_CHECKS,
  watchThresholds,
  healthWatchConfig,
  healthWatchEnabled,
  configuredModels,
  classifyModelHealth,
  buildHealthAlert,
  createHealthWatcher,
  refreshModelHealthGate,
  runAiHealthWatch,
  startAiHealthWatch,
};
