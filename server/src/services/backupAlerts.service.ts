/**
 * Failure notifications for the durable backup-run history.
 *
 * WHY THIS EXISTS. The run records answer "did the backup work", but nobody is
 * looking at the console at 03:00. A `FAILED` row and a `RUNNING` row that never
 * finished are the two states that need a human, and both were silent.
 *
 * THE RECORD IS THE SOURCE OF TRUTH. A notification is derived from one
 * `backup_runs` row — never from the scheduler log — so the alert, the console
 * and any later investigation all describe the same execution, by `runId`.
 *
 * NOTHING HERE MAY BREAK A BACKUP. `deliverBackupAlert` never throws and never
 * rejects: a missing recipient, a mail outage and a database that cannot record
 * the claim are all reported and swallowed. The runner calls it *after* the
 * archive exists and after the run row is written.
 *
 * ONE ALERT PER RUN. The claim in `claimBackupAlert` is atomic, so a retried
 * delivery, a second runner and a repeated call cannot send the same failure
 * twice. A claim that never completed expires, so a genuine retry can still get
 * through.
 */
import {
  BACKUP_RUN_INTERRUPTED_AFTER_MS,
  claimBackupAlert,
  finishBackupAlert,
  getBackupRunRecord,
  type BackupAlertKind,
  type BackupRunRecord,
} from './backupRuns.service.ts';
import { isMailConfigured, sendOperationalAlertEmail } from './mail/index.ts';

export type BackupAlertMessage = { subject: string; text: string };

export type DeliverBackupAlertResult = {
  sent: boolean;
  reason:
    | 'sent'
    | 'not-configured'
    | 'duplicate'
    | 'missing-run'
    | 'claim-failed'
    | 'delivery-failed';
  detail?: string;
};

export type DeliverBackupAlertDeps = {
  recipient: () => string;
  mailConfigured: () => boolean;
  send: (input: { to: string; subject: string; text: string }) => Promise<unknown>;
  claim: (runId: string, kind: BackupAlertKind) => Promise<boolean>;
  finish: (runId: string, error: string | null) => Promise<void>;
  loadRun: (runId: string) => Promise<BackupRunRecord | null>;
  log: (line: string) => void;
};

function label(kind: BackupAlertKind): string {
  return kind === 'INTERRUPTED' ? 'did not finish' : 'FAILED';
}

/**
 * The alert body. Deliberately plain text with the identifiers a person needs to
 * find the run again — the console row, the archive and the failure text.
 */
export function backupAlertMessage(
  run: Pick<
    BackupRunRecord,
    'runId' | 'trigger' | 'startedAt' | 'finishedAt' | 'archive' | 'sizeBytes' | 'offsite' | 'detail'
  >,
  kind: BackupAlertKind,
  interruptedAfterMinutes: number,
): BackupAlertMessage {
  const lines = [
    `A backup run ${label(kind)}.`,
    '',
    `Run id     : ${run.runId}`,
    `Outcome    : ${kind}`,
    `Trigger    : ${run.trigger}`,
    `Started    : ${run.startedAt}`,
    `Finished   : ${run.finishedAt ?? 'no completion was recorded'}`,
    `Archive    : ${run.archive ?? 'none'}`,
    `Size       : ${run.sizeBytes === null ? 'unknown' : `${run.sizeBytes} bytes`}`,
    `Off-site   : ${run.offsite}`,
  ];
  if (kind === 'INTERRUPTED') {
    lines.push(
      '',
      `The run was still marked RUNNING more than ${interruptedAfterMinutes} minutes after it started, so the process that writes the archive is gone. No success can be assumed for this execution.`,
    );
  }
  lines.push('', 'Reason', run.detail ? run.detail : 'the runner recorded no failure text');
  lines.push(
    '',
    'The run history is the durable record: open the Backups & Restore console and look up this run id.',
    'This alert contains no passphrase and no key material; the archive is encrypted and the private key is offline.',
  );
  return {
    subject: `Backup run ${kind} — ${run.runId}`,
    text: lines.join('\n'),
  };
}

const REAL_DEPS: DeliverBackupAlertDeps = {
  recipient: () => (process.env.BACKUP_ALERT_EMAIL || '').trim(),
  mailConfigured: () => {
    try {
      return isMailConfigured();
    } catch {
      return false;
    }
  },
  send: (input) => sendOperationalAlertEmail(input),
  claim: (runId, kind) => claimBackupAlert(runId, kind),
  finish: (runId, error) => finishBackupAlert(runId, error),
  loadRun: (runId) => getBackupRunRecord(runId),
  log: (line) => console.error(line),
};

/**
 * Deliver one alert for one run. Never throws.
 *
 * `kind` is passed in because INTERRUPTED is derived, not stored: only the
 * caller knows it is looking at a stale `RUNNING` row.
 */
export async function deliverBackupAlert(
  runId: string,
  kind: BackupAlertKind,
  overrides: Partial<DeliverBackupAlertDeps> = {},
): Promise<DeliverBackupAlertResult> {
  const deps: DeliverBackupAlertDeps = { ...REAL_DEPS, ...overrides };
  try {
    const to = deps.recipient();
    if (!to) {
      deps.log(
        `[backup:alert] ${kind} run ${runId}: BACKUP_ALERT_EMAIL is not set; no alert was sent and the run record is the only notification.`,
      );
      return { sent: false, reason: 'not-configured' };
    }
    if (!deps.mailConfigured()) {
      deps.log(
        `[backup:alert] ${kind} run ${runId}: the mail provider is not configured; no alert was sent.`,
      );
      return { sent: false, reason: 'not-configured' };
    }

    const run = await deps.loadRun(runId);
    if (!run) {
      deps.log(`[backup:alert] ${kind} run ${runId}: no run record to describe; no alert was sent.`);
      return { sent: false, reason: 'missing-run' };
    }

    const claimed = await deps.claim(runId, kind);
    if (!claimed) {
      // Either an alert was already sent for this run, or another delivery holds
      // the claim. Both mean this call must stay silent.
      return { sent: false, reason: 'duplicate' };
    }

    const { subject, text } = backupAlertMessage(
      run,
      kind,
      Math.round(BACKUP_RUN_INTERRUPTED_AFTER_MS / 60_000),
    );
    try {
      await deps.send({ to, subject, text });
      await deps.finish(runId, null);
      return { sent: true, reason: 'sent' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await deps.finish(runId, detail).catch(() => {});
      deps.log(`[backup:alert] ${kind} run ${runId}: delivery failed: ${detail}`);
      return { sent: false, reason: 'delivery-failed', detail };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log(`[backup:alert] ${kind} run ${runId}: alert path failed: ${detail}`);
    return { sent: false, reason: 'claim-failed', detail };
  }
}

export default { backupAlertMessage, deliverBackupAlert };
