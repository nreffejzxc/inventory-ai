/**
 * OPS-2 — the deployment's own pulse.
 *
 * WHY THIS EXISTS. Every failure this project has paid for was found by a person looking: a stale
 * server (§27CW), a provider limit spent at 02:00 (§27CJ), five assistant tools broken for two days
 * at 131 000 products (§27DF), a database whose writes were blocked by a storage quota while the
 * process still reported `ready` (§27DF). The logs carry all of it and **nothing watches them** — so
 * the gap this closes is not measurement, it is **a signal an outside watcher can read without
 * credentials, without reading logs, and without trusting the same process that is failing**.
 *
 * WHAT IS PUBLISHED, AND WHY SO LITTLE. Three integers and a timestamp, on the legacy `/api/health`
 * endpoint that already publishes the commit id: total responses, responses by status class, and how
 * many of them were 5xx with the last one's time. Deliberately NOT published: paths, request ids,
 * user or tenant identifiers, durations, error messages, and the request rate as a window. A count
 * since boot with no names attached tells an uptime check **that something is failing now**, which is
 * exactly the question it is polled to answer, and tells nobody who is using the product. Findings
 * stay in the logs, where they already are, behind credentials.
 *
 * WHY 5xx AND NOT 4xx. A 4xx is the API working — the caller sent something it would not accept. A
 * 5xx is the API failing, and it is the only class worth waking someone for. Counting them separately
 * is what makes an alert rule possible at all.
 *
 * WHY A COLLAPSE IS MEASURED FROM BOOT. These are process-local and reset when the process does, which
 * is honest for one instance and misleading for several: four instances each report their own counts,
 * and a watcher polling one of them sees one quarter of the traffic. That is the limit of this
 * implementation, stated here rather than discovered later — a shared counter needs a shared store,
 * which this project does not have (the same reason B2 and E3 are deferred, §29). For a single
 * deployed instance — which is what is running today — it is the whole picture.
 *
 * Memory is bounded by construction: fixed keys, integers, one timestamp. Nothing here grows with
 * traffic, and nothing here can be made to grow by a caller.
 */

/** Status classes as the payload reports them. Anything outside 100–599 is `other`. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'other';

export type OperationalCountersSnapshot = {
  /** Whole seconds since this process started counting. */
  uptimeSeconds: number;
  /** Responses finished since boot, all classes. */
  responses: number;
  byStatusClass: Record<StatusClass, number>;
  /** 5xx only — the class that means the API failed. */
  serverErrors: number;
  /** ISO time of the most recent 5xx, or null when there has not been one. */
  lastServerErrorAt: string | null;
};

/**
 * How many distinct 5xx statuses are tracked individually. A server can only answer a handful of
 * them (500, 502, 503, 504 here), and a bounded map is what stops a hostile or buggy caller from
 * growing this object — the one place where "fixed keys" could otherwise be violated.
 */
const MAX_TRACKED_ERROR_STATUSES = 8;

/**
 * 5xx answers that are a MONITORING STATE rather than a failed request.
 *
 * `/api/health/integrity` answers 503 while the independent laptop audit is
 * stale — deliberately, so an uptime monitor can alert without parsing a body.
 * That is the monitoring plane reporting a condition; it is not this API failing
 * a caller's request. Counting it in `serverErrors` made the process counter climb
 * every five minutes while the durable 5xx store stayed empty, which is exactly
 * the discrepancy the OPS-2/OPS-8 review found. It is still counted as a response
 * and as a 5xx in `byStatusClass` (that census is literal), but it no longer
 * increments the failure metric or moves `lastServerErrorAt`.
 *
 * `/api/health/ready` is deliberately NOT in this set: a readiness 503 is a real
 * availability failure. It must keep counting, and it cannot be written durably
 * while the database is unreachable — the health endpoint is the signal for that
 * case.
 */
const MONITORING_ONLY_5XX_PATHS = new Set(['/api/health/integrity']);

type State = {
  startedAt: number;
  responses: number;
  byStatusClass: Record<StatusClass, number>;
  serverErrors: number;
  serverErrorsByStatus: Record<string, number>;
  lastServerErrorAt: string | null;
};

function freshState(): State {
  return {
    startedAt: Date.now(),
    responses: 0,
    byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
    serverErrors: 0,
    serverErrorsByStatus: {},
    lastServerErrorAt: null,
  };
}

const state: State = freshState();

/** Classify an HTTP status code. Exported because the mapping is the rule, not an implementation detail. */
export function statusClass(status: number): StatusClass {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'other';
  const hundred = Math.floor(status / 100);
  if (hundred === 2) return '2xx';
  if (hundred === 3) return '3xx';
  if (hundred === 4) return '4xx';
  if (hundred === 5) return '5xx';
  return 'other';
}

/**
 * Record one finished response. Called from the `finish` listener in `app.ts`, so it runs AFTER the
 * response is sent — the counter can never delay or alter a response, and a route that throws still
 * counts because `finish` fires for the error handler's response too.
 *
 * `path` is used only to distinguish a monitoring-state 503 from a real server failure; it is never
 * stored. A 500 on the same route still counts, because only the intentional 503 is a state signal.
 */
export function recordResponse(status: number, path = ''): void {
  const klass = statusClass(status);
  state.responses += 1;
  state.byStatusClass[klass] += 1;

  if (klass !== '5xx') return;
  if (status === 503 && MONITORING_ONLY_5XX_PATHS.has(path)) return;
  state.serverErrors += 1;
  state.lastServerErrorAt = new Date().toISOString();

  const key = String(status);
  const tracked = Object.keys(state.serverErrorsByStatus);
  if (key in state.serverErrorsByStatus || tracked.length < MAX_TRACKED_ERROR_STATUSES) {
    state.serverErrorsByStatus[key] = (state.serverErrorsByStatus[key] ?? 0) + 1;
  } else {
    state.serverErrorsByStatus.other = (state.serverErrorsByStatus.other ?? 0) + 1;
  }
}

/**
 * A copy of the counters, safe to serialize.
 *
 * A COPY, not the live object: the caller is a route handler serializing to JSON, and handing it the
 * internal object would let one careless mutation — or a future `res.json(mutate(snapshot))` — change
 * the process's own state from outside this module.
 */
export function operationalCounters(): OperationalCountersSnapshot {
  return {
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
    responses: state.responses,
    byStatusClass: { ...state.byStatusClass },
    serverErrors: state.serverErrors,
    lastServerErrorAt: state.lastServerErrorAt,
  };
}

/**
 * Per-status 5xx detail, for the operator's log line and for tests. Kept OUT of the HTTP payload: it
 * names a failure mode (502 vs 504 vs 500), which is useful to an operator and unnecessary for a
 * watcher that only needs "is this instance failing".
 */
export function serverErrorsByStatus(): Record<string, number> {
  return { ...state.serverErrorsByStatus };
}

/** Reset to boot state. For tests only — nothing in `src/` calls this. */
export function resetOperationalCounters(): void {
  Object.assign(state, freshState());
}

export default {
  statusClass,
  recordResponse,
  operationalCounters,
  serverErrorsByStatus,
  resetOperationalCounters,
};
