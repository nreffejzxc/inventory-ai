/**
 * Is there a verified offsite backup recent enough to restore from?
 *
 * WHY THIS IS A SERVER-SIDE READ. The scheduled backup now runs on GitHub's
 * runners, not on the owner's laptop and not on this API host. Nothing local can
 * answer "did last night's backup land", so the only durable evidence is the
 * `backup_runs` collection the runner writes. This module turns that history
 * into one fresh/stale verdict an uptime monitor can poll.
 *
 * WHAT COUNTS AS A BACKUP. A SUCCESS row is not enough. The row must also carry
 * the archive name and its SHA-256 and record `offsite: 'verified'`, which the
 * runner sets only after re-downloading the archive from Google Drive and
 * matching the digest. A run that encrypted and uploaded but could not prove the
 * bytes therefore never satisfies the monitor.
 *
 * WHAT IT PUBLISHES. The verdict, when the newest verified archive was made, its
 * age, the threshold and its name. Nothing else: no tenant, no connection
 * string, no credentials, no passphrase — the same exposure class as
 * `/api/health/integrity`.
 *
 * FAIL-CLOSED. A database that cannot be read, or no matching run at all, is
 * `fresh: false`, because a monitor must be able to treat this as an incident
 * without parsing a reason.
 */
import { listBackupRunRecords, type BackupRunRecord } from './backupRuns.service.ts';

/** One missed daily run plus slack: the schedule is daily, the alarm is not. */
export const DEFAULT_BACKUP_MAX_AGE_HOURS = 30;

export type BackupFreshnessView = {
  state: 'fresh' | 'stale' | 'missing' | 'unreadable';
  fresh: boolean;
  lastVerifiedAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
  archive: string | null;
  sha256: string | null;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  detail: string | null;
};

function positiveHours(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isVerified(record: BackupRunRecord): boolean {
  return (
    record.outcome === 'SUCCESS' &&
    record.offsite === 'verified' &&
    typeof record.archive === 'string' &&
    /^[0-9a-f]{64}$/.test(record.sha256 ?? '') &&
    typeof record.finishedAt === 'string'
  );
}

export type ReadBackupFreshnessOptions = {
  maxAgeHours?: number;
  now?: Date;
  listRuns?: (limit: number) => Promise<BackupRunRecord[]>;
};

export async function readBackupFreshness({
  maxAgeHours = positiveHours(process.env.BACKUP_MAX_AGE_HOURS, DEFAULT_BACKUP_MAX_AGE_HOURS),
  now = new Date(),
  listRuns = listBackupRunRecords,
}: ReadBackupFreshnessOptions = {}): Promise<BackupFreshnessView> {
  const threshold = positiveHours(maxAgeHours, DEFAULT_BACKUP_MAX_AGE_HOURS);
  const empty = {
    lastVerifiedAt: null,
    ageHours: null,
    maxAgeHours: threshold,
    archive: null,
    sha256: null,
    lastOutcome: null,
    lastOutcomeAt: null,
    detail: null,
  };

  let runs: BackupRunRecord[];
  try {
    runs = await listRuns(20);
  } catch (error) {
    return {
      ...empty,
      state: 'unreadable',
      fresh: false,
      detail: `the backup run history could not be read (${(error as Error).message})`.slice(0, 300),
    };
  }

  const latest = runs[0] ?? null;
  const verified = runs.find(isVerified) ?? null;
  const outcome = {
    lastOutcome: latest ? latest.outcome : null,
    lastOutcomeAt: latest ? (latest.finishedAt ?? latest.startedAt) : null,
    detail: latest ? latest.detail : null,
  };

  if (!verified) {
    return {
      ...empty,
      ...outcome,
      state: 'missing',
      fresh: false,
      detail: latest
        ? `no run has recorded a verified offsite archive yet; the newest run is ${latest.outcome}.`
        : 'no backup run has been recorded yet.',
    };
  }

  const verifiedAt = Date.parse(verified.finishedAt as string);
  const ageHours = Number.isFinite(verifiedAt)
    ? Math.max(0, (now.getTime() - verifiedAt) / 3_600_000)
    : null;
  const fresh = ageHours !== null && ageHours <= threshold;

  return {
    state: fresh ? 'fresh' : 'stale',
    fresh,
    // A stored timestamp that does not parse is not a date this can publish; the
    // verdict above already failed closed, so the field is null rather than a
    // thrown RangeError from `toISOString()`.
    lastVerifiedAt: ageHours === null ? null : new Date(verifiedAt).toISOString(),
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    maxAgeHours: threshold,
    archive: verified.archive,
    sha256: verified.sha256,
    ...outcome,
  };
}

export default { DEFAULT_BACKUP_MAX_AGE_HOURS, readBackupFreshness };
