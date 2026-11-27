// Runner-side failure alerts.
//
// The runner is the only process that knows a backup failed, and the only one
// that notices a previous execution never finished. It calls these two functions
// *after* the archive work is done and after the run row is written, so an alert
// can never change the outcome of a backup.
//
// EVERY CALL HERE IS OPTIONAL. No recipient, no mail provider, no database and no
// network all mean "log it and carry on". Each delivery is also bounded in time:
// a mail server that accepts the connection and then stalls must not hold the
// scheduled task open past its own runtime limit.
import 'dotenv/config';

import { deliverBackupAlert } from '../../src/services/backupAlerts.service.ts';
import { listInterruptedBackupRuns } from '../../src/services/backupRuns.service.ts';
import { ensureRunStore } from './runStore.mjs';

/** Upper bound for one alert attempt, including the SMTP/API round trip. */
const ALERT_BUDGET_MS = 15_000;

function warn(message) {
  console.warn(`[backup:alert] ${message}`);
}

async function bounded(work) {
  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ sent: false, reason: 'timeout' }), ALERT_BUDGET_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Report one failed run. Never throws, never rejects, never returns a value the
 * caller has to act on.
 */
export async function notifyRunFailure(runId) {
  if (!runId) return;
  try {
    if (!(await ensureRunStore())) return;
    const result = await bounded(deliverBackupAlert(runId, 'FAILED'));
    if (result && result.sent === false && result.reason !== 'duplicate') {
      warn(`failed run ${runId}: no alert delivered (${result.reason})`);
    }
  } catch (error) {
    warn(`failed run ${runId}: alert path errored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Report runs that are still marked RUNNING long after they started.
 *
 * This is where INTERRUPTED becomes actionable: the process that would have
 * written the result is gone, so the next execution is the first thing that can
 * notice. Runs that already received an alert are skipped by the service's own
 * claim, so a repeated daily check cannot mail the same run twice.
 */
export async function notifyInterruptedRuns() {
  try {
    if (!(await ensureRunStore())) return;
    const runs = await listInterruptedBackupRuns(5);
    for (const run of runs) {
      if (run.alert && run.alert.sentAt) continue;
      const result = await bounded(deliverBackupAlert(run.runId, 'INTERRUPTED'));
      if (result && result.sent === false && result.reason !== 'duplicate') {
        warn(`interrupted run ${run.runId}: no alert delivered (${result.reason})`);
      }
    }
  } catch (error) {
    warn(`interrupted-run check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
