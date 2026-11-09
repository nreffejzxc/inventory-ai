/**
 * AI-99 — a bounded daily budget for simple-inventory PAID fallbacks.
 *
 * The simple route deliberately starts on a free model. When that model times out, returns an
 * empty completion, spends its output budget, or is refused by the free daily allowance, the
 * turn escalates to the configured paid primary. That is the right availability trade, but a
 * sustained load can turn every free-quota failure into a paid request. This module puts one
 * reservation in front of that escalation.
 *
 * WHY A RESERVATION, NOT ONLY A COMPLETED-SPEND CHECK. Concurrent turns reserve before they
 * call the provider, so ten simultaneous free failures cannot all observe the same remaining
 * budget and then spend it ten times. The provider's reported `turnCostUsd` settles the
 * reservation when the turn ends; if the provider does not report a charge, the reservation
 * itself is treated as spent. The reserve is therefore a conservative per-turn ceiling, not an
 * estimate that can silently become zero.
 *
 * WHAT IT IS. A per-process, UTC-day accumulator. The cap is `AI_SIMPLE_PAID_DAILY_BUDGET_USD`;
 * the per-turn reservation is `AI_SIMPLE_PAID_TURN_RESERVE_USD`. A budget of 0 blocks all simple
 * paid fallback (the route then answers its limitation instead of spending). The day rolls at
 * 00:00 UTC, matching OpenRouter's free-model accounting day.
 *
 * WHAT IT IS NOT. It is not the provider's account ledger and it is not shared between server
 * processes. The provider reports the actual charge per call, so this guard bounds the spend it
 * can see in the process that made the calls; a restart resets the local day. The provider's
 * own account dashboard remains the authority for total credits. That scope is deliberate: the
 * simple route is the one path this guard owns, and a process-local reservation needs no
 * database write inside the AI request path.
 */

export interface SimplePaidBudgetReservation {
  /** UTC day (`YYYY-MM-DD`) the reservation belongs to. */
  day: string;
  /** Conservative amount reserved before the paid call. */
  reservedUsd: number;
  settled: boolean;
}

export interface SimplePaidBudgetSnapshot {
  day: string;
  spentUsd: number;
  reservedUsd: number;
}

export interface SimplePaidReserveResult {
  ok: boolean;
  reason?: string;
  reservation?: SimplePaidBudgetReservation;
  day: string;
  spentUsd: number;
  reservedUsd: number;
  budgetUsd: number;
}

const EPSILON = 1e-9;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

let day = utcDay(Date.now());
let spentUsd = 0;
let reservedUsd = 0;

function rollDay(now: number): void {
  const next = utcDay(now);
  if (next === day) return;
  day = next;
  spentUsd = 0;
  reservedUsd = 0;
}

function snapshot(now: number): SimplePaidBudgetSnapshot {
  rollDay(now);
  return { day, spentUsd, reservedUsd };
}

/**
 * Reserve one simple paid fallback against today's budget.
 *
 * A failed reservation carries the current spend and budget in its result so the caller can log
 * the decision without reading module state separately. `reserveUsd` must be positive; a zero
 * reserve still enforces the completed-spend cap but cannot prevent concurrent overshoot.
 */
export function reserveSimplePaidFallback({
  dailyBudgetUsd,
  turnReserveUsd,
  now = Date.now(),
}: {
  dailyBudgetUsd: number;
  turnReserveUsd: number;
  now?: number;
}): SimplePaidReserveResult {
  rollDay(now);
  const budget = Number.isFinite(dailyBudgetUsd) && dailyBudgetUsd >= 0 ? dailyBudgetUsd : 0;
  const reserve = Number.isFinite(turnReserveUsd) && turnReserveUsd > 0 ? turnReserveUsd : 0;
  const base = { day, spentUsd, reservedUsd, budgetUsd: budget };

  if (budget <= 0) {
    return { ok: false, reason: 'the daily paid budget is disabled', ...base };
  }
  if (spentUsd + reservedUsd + reserve > budget + EPSILON) {
    return { ok: false, reason: 'the daily paid budget is exhausted', ...base };
  }

  reservedUsd += reserve;
  return {
    ok: true,
    reservation: { day, reservedUsd: reserve, settled: false },
    day,
    spentUsd,
    reservedUsd,
    budgetUsd: budget,
  };
}

/**
 * Settle a reservation with the actual provider-reported charge.
 *
 * `actualCostUsd` is the turn's summed `costUsd`. When it is absent the reservation is charged
 * conservatively: a provider omission must not make a paid call look free. A settlement from a
 * previous day is released without charging the new day; the spend already happened before the
 * rollover and the new day's budget starts clean.
 */
export function settleSimplePaidFallback(
  reservation: SimplePaidBudgetReservation | null | undefined,
  actualCostUsd: number | null | undefined,
  now: number = Date.now(),
): SimplePaidBudgetSnapshot {
  rollDay(now);
  if (!reservation || reservation.settled) return snapshot(now);
  reservation.settled = true;
  if (reservation.day !== day) return snapshot(now);

  reservedUsd = Math.max(0, reservedUsd - reservation.reservedUsd);
  const actual =
    typeof actualCostUsd === 'number' && Number.isFinite(actualCostUsd) && actualCostUsd >= 0
      ? actualCostUsd
      : reservation.reservedUsd;
  spentUsd += actual;
  return snapshot(now);
}

/** The current local day's spend, for diagnostics and tests. */
export function simplePaidBudgetSnapshot(now: number = Date.now()): SimplePaidBudgetSnapshot {
  return snapshot(now);
}

/** Test-only: start a fresh day with no reservations. */
export function resetSimplePaidBudget(now: number = Date.now()): void {
  day = utcDay(now);
  spentUsd = 0;
  reservedUsd = 0;
}

export default {
  reserveSimplePaidFallback,
  settleSimplePaidFallback,
  simplePaidBudgetSnapshot,
  resetSimplePaidBudget,
};
