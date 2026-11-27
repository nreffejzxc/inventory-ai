/**
 * Durable backup-run history.
 *
 * The runner (`server/scripts/backup-daily.mjs`) writes here at the start and at
 * the end of every execution; the platform console reads here. The writes are
 * deliberately idempotent on `runId`, so a retry, a second write or a crash
 * followed by a restore of the same execution cannot create a duplicate row.
 *
 * NOTHING HERE MAY BREAK A BACKUP. Both writers are called from a process whose
 * job is to produce an archive; if MongoDB is unreachable the archive still
 * gets made and the caller logs the gap. The console then falls back to the
 * scheduler log, and says so.
 */

import BackupRun from '../models/backupRun.model.ts';

/** A `RUNNING` row older than this is treated as interrupted, not in progress. */
export const BACKUP_RUN_INTERRUPTED_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * How long a failure-alert claim is honoured before another delivery may retry.
 * A process that dies between claiming and sending must not silence the alert
 * for that run forever.
 */
export const BACKUP_ALERT_CLAIM_TTL_MS = 10 * 60 * 1000;

export type BackupAlertKind = 'FAILED' | 'INTERRUPTED';

export type BackupRunAlert = {
  kind: BackupAlertKind | null;
  sentAt: string | null;
  error: string | null;
};

export type BackupRunTrigger = 'SCHEDULED' | 'MANUAL' | 'CONSOLE' | 'UNKNOWN';
export type BackupRunOffsite = 'verified' | 'copied' | 'present' | 'missing' | 'unknown';

export type BackupRunRecord = {
  runId: string;
  trigger: BackupRunTrigger;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'INTERRUPTED' | 'UNKNOWN';
  archive: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  offsite: BackupRunOffsite;
  pruned: string[];
  detail: string | null;
  alert: BackupRunAlert;
};

export type StartRunInput = {
  runId: string;
  trigger: BackupRunTrigger;
  startedAt?: Date;
  archiveDir?: string | null;
  copyDir?: string | null;
  host?: string | null;
};

export type FinishRunInput = {
  runId: string;
  outcome: 'SUCCESS' | 'FAILED';
  finishedAt?: Date;
  archive?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  offsite?: BackupRunOffsite;
  pruned?: string[];
  detail?: string | null;
};

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function iso(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Open the row for one execution. Upsert: a repeated call cannot duplicate it. */
export async function startBackupRunRecord(input: StartRunInput): Promise<void> {
  const runId = String(input.runId ?? '').trim();
  if (!runId) throw new Error('a backup run id is required');
  const startedAt = input.startedAt instanceof Date ? input.startedAt : new Date();
  await BackupRun.updateOne(
    { runId },
    {
      $setOnInsert: {
        runId,
        trigger: input.trigger,
        startedAt,
        finishedAt: null,
        outcome: 'RUNNING',
        archive: null,
        sha256: null,
        sizeBytes: null,
        offsite: 'unknown',
        pruned: [],
        archiveDir: clip(input.archiveDir, 500),
        copyDir: clip(input.copyDir, 500),
        host: clip(input.host, 120),
        detail: null,
      },
    },
    { upsert: true },
  ).exec();
}

/** Close the row. Only the fields actually known are written. */
export async function finishBackupRunRecord(input: FinishRunInput): Promise<void> {
  const runId = String(input.runId ?? '').trim();
  if (!runId) throw new Error('a backup run id is required');
  const finishedAt = input.finishedAt instanceof Date ? input.finishedAt : new Date();
  const set: Record<string, unknown> = {
    outcome: input.outcome,
    finishedAt,
    detail: clip(input.detail, 1_000),
  };
  if (input.archive !== undefined) set.archive = clip(input.archive, 200);
  if (input.sha256 !== undefined) {
    const digest = typeof input.sha256 === 'string' ? input.sha256.trim().toLowerCase() : '';
    set.sha256 = /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  }
  if (input.sizeBytes !== undefined) {
    set.sizeBytes =
      typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0
        ? Math.trunc(input.sizeBytes)
        : null;
  }
  if (input.offsite !== undefined) set.offsite = input.offsite;
  if (input.pruned !== undefined) {
    set.pruned = Array.isArray(input.pruned)
      ? input.pruned.filter((name) => typeof name === 'string').map((name) => name.slice(0, 200)).slice(0, 50)
      : [];
  }
  await BackupRun.updateOne({ runId }, { $set: set }, { upsert: false }).exec();
}

/** The stored fields this module reads, before they are normalised. */
type BackupRunRow = {
  runId?: unknown;
  trigger?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  outcome?: unknown;
  archive?: unknown;
  sha256?: unknown;
  sizeBytes?: unknown;
  offsite?: unknown;
  pruned?: unknown;
  detail?: unknown;
  alert?: { kind?: unknown; sentAt?: unknown; error?: unknown } | null;
};

/** One stored row, in the shape the console and the alerts both read. */
function toRecord(row: BackupRunRow, now: number): BackupRunRecord {
  const startedAt = iso(row.startedAt) ?? new Date(0).toISOString();
  const finishedAt = iso(row.finishedAt);
  let outcome = row.outcome as BackupRunRecord['outcome'];
  if (outcome === 'RUNNING' && now - Date.parse(startedAt) > BACKUP_RUN_INTERRUPTED_AFTER_MS) {
    outcome = 'INTERRUPTED';
  }
  const rawAlert = row.alert && typeof row.alert === 'object' ? row.alert : {};
  const alertKind = rawAlert.kind === 'FAILED' || rawAlert.kind === 'INTERRUPTED' ? rawAlert.kind : null;
  return {
    runId: String(row.runId ?? ''),
    trigger: (row.trigger as BackupRunTrigger) ?? 'UNKNOWN',
    startedAt,
    finishedAt,
    outcome,
    archive: typeof row.archive === 'string' ? row.archive : null,
    sha256: typeof row.sha256 === 'string' ? row.sha256 : null,
    sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : null,
    offsite: (row.offsite as BackupRunOffsite) ?? 'unknown',
    pruned: Array.isArray(row.pruned) ? row.pruned.filter((n): n is string => typeof n === 'string') : [],
    detail: typeof row.detail === 'string' ? row.detail : null,
    alert: {
      kind: alertKind,
      sentAt: iso(rawAlert.sentAt),
      error: typeof rawAlert.error === 'string' ? rawAlert.error : null,
    },
  };
}

/**
 * The newest executions, durable, newest first.
 *
 * A `RUNNING` row older than the interruption window is reported as
 * `INTERRUPTED`: the archive process is gone, so "still running" would be a lie.
 */
export async function listBackupRunRecords(limit = 25): Promise<BackupRunRecord[]> {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await BackupRun.find({})
    .sort({ startedAt: -1, _id: -1 })
    .limit(bounded)
    .lean()
    .exec();

  const now = Date.now();
  return rows.map((row) => toRecord(row as BackupRunRow, now));
}

/** One run by id, for the alert body. Null when the row does not exist. */
export async function getBackupRunRecord(
  runId: string,
  now: Date = new Date(),
): Promise<BackupRunRecord | null> {
  const id = String(runId ?? '').trim();
  if (!id) return null;
  const row = await BackupRun.findOne({ runId: id }).lean().exec();
  return row ? toRecord(row as BackupRunRow, now.getTime()) : null;
}

/**
 * Runs that are still `RUNNING` after the interruption window — the executions
 * that will never write their own result, and whose failure nobody has seen.
 */
export async function listInterruptedBackupRuns(
  limit = 5,
  now: Date = new Date(),
): Promise<BackupRunRecord[]> {
  const bounded = Math.min(25, Math.max(1, Math.trunc(limit)));
  const rows = await BackupRun.find({
    outcome: 'RUNNING',
    startedAt: { $lt: new Date(now.getTime() - BACKUP_RUN_INTERRUPTED_AFTER_MS) },
  })
    .sort({ startedAt: 1, _id: 1 })
    .limit(bounded)
    .lean()
    .exec();
  return rows.map((row) => toRecord(row as BackupRunRow, now.getTime()));
}

/**
 * Take the one claim that allows an alert for this run.
 *
 * The filter is the deduplication: a run whose `sentAt` is set can never be
 * claimed again, and a live claim held by another delivery blocks this one until
 * it either succeeds or expires.
 */
export async function claimBackupAlert(
  runId: string,
  kind: BackupAlertKind,
  now: Date = new Date(),
): Promise<boolean> {
  const id = String(runId ?? '').trim();
  if (!id) return false;
  const expired = new Date(now.getTime() - BACKUP_ALERT_CLAIM_TTL_MS);
  const row = await BackupRun.findOneAndUpdate(
    {
      runId: id,
      $and: [
        { $or: [{ 'alert.sentAt': { $exists: false } }, { 'alert.sentAt': null }] },
        {
          $or: [
            { 'alert.claimedAt': { $exists: false } },
            { 'alert.claimedAt': null },
            { 'alert.claimedAt': { $lt: expired } },
          ],
        },
      ],
    },
    { $set: { 'alert.kind': kind, 'alert.claimedAt': now }, $unset: { 'alert.error': '' } },
    { returnDocument: 'before' },
  )
    .lean()
    .exec();
  return Boolean(row);
}

/**
 * Close the claim: `error === null` marks the alert as sent (and final), any
 * other value records the delivery failure and releases the claim so a later run
 * can retry it.
 */
export async function finishBackupAlert(
  runId: string,
  error: string | null,
  now: Date = new Date(),
): Promise<void> {
  const id = String(runId ?? '').trim();
  if (!id) return;
  if (error === null) {
    await BackupRun.updateOne(
      { runId: id },
      { $set: { 'alert.sentAt': now, 'alert.error': null } },
    ).exec();
    return;
  }
  await BackupRun.updateOne(
    { runId: id },
    { $set: { 'alert.error': clip(error, 300) }, $unset: { 'alert.claimedAt': '' } },
  ).exec();
}

export default {
  BACKUP_ALERT_CLAIM_TTL_MS,
  BACKUP_RUN_INTERRUPTED_AFTER_MS,
  claimBackupAlert,
  finishBackupAlert,
  finishBackupRunRecord,
  getBackupRunRecord,
  listBackupRunRecords,
  listInterruptedBackupRuns,
  startBackupRunRecord,
};
