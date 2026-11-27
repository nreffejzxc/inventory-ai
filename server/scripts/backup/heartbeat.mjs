// The outbound half of the dead-man switch.
//
// WHAT THIS IS FOR. Every existing signal is a proxy: an uptime monitor polls
// `/api/health/backup`, which reads a row the runner writes best-effort. Break any link —
// the row write, the endpoint, the monitor being paused or deleted — and silence looks
// exactly like health. A heartbeat inverts the direction: the run reports to an outside
// service AFTER it has produced and verified an archive, and the service alerts on the
// ABSENCE of that report. "Nothing happened" becomes the alarm condition.
//
// THREE RULES:
//
//   1. THE URL IS A SECRET. It is a write capability: anyone holding it can fake liveness.
//      It is read from the environment, never logged, never printed, and never placed in an
//      error message or a run record. Success is reported as `sent`/`not sent`, nothing else.
//   2. UNCONFIGURED IS SILENT, NOT LOUD. With no URL the function returns
//      `{ sent: false, reason: 'not-configured' }`. This is what keeps a developer's local
//      backup from satisfying a monitor that is supposed to prove the GitHub pipeline.
//   3. A FAILED PING NEVER FAILS THE RUN. The archive is already made and verified by the
//      time this is called; throwing here would turn a monitoring outage into a backup
//      failure. The alarm for a broken ping is the missing ping itself.
const DEFAULT_TIMEOUT_MS = 10_000;

/** `/fail` is healthchecks.io's explicit failure signal; success is the bare URL. */
export function heartbeatTarget(url, outcome) {
  const base = String(url ?? '').trim();
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  return outcome === 'failure' ? `${trimmed}/fail` : trimmed;
}

/**
 * Report one execution to the heartbeat endpoint.
 *
 * @param {object} input
 * @param {string} [input.url]          the ping URL (secret); absent means "not configured"
 * @param {'success'|'failure'} [input.outcome]
 * @param {typeof fetch} [input.fetchImpl] injectable for tests
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{sent: boolean, status: number|null, reason: string|null}>}
 */
export async function sendHeartbeat({
  url,
  outcome = 'success',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = heartbeatTarget(url, outcome);
  if (!target) return { sent: false, status: null, reason: 'not-configured' };
  if (!/^https?:\/\//i.test(target)) return { sent: false, status: null, reason: 'invalid-url' };

  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      sent: Boolean(response?.ok),
      status: typeof response?.status === 'number' ? response.status : null,
      reason: response?.ok ? null : 'rejected',
    };
  } catch {
    // The error object can carry the URL in a message or a cause; it is dropped, not logged.
    return { sent: false, status: null, reason: 'unreachable' };
  }
}

/** One log line that proves the attempt without ever printing the credential. */
export function describeHeartbeat(result, outcome = 'success') {
  const verb = outcome === 'failure' ? 'failure signal' : 'heartbeat';
  if (result?.sent) return `${verb} delivered${result.status ? ` (HTTP ${result.status})` : ''}`;
  return `${verb} NOT delivered (${result?.reason ?? 'unknown'})`;
}

export default { heartbeatTarget, sendHeartbeat, describeHeartbeat };
