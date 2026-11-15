import mongoose from 'mongoose';

/**
 * The hosted half of the inventory-integrity monitor.
 *
 * The audit itself stays read-only. The Windows task writes one small
 * operational document after each run — never an inventory, ledger or purchase
 * order row — and the public `/api/health/integrity` endpoint reports whether
 * that document is fresh. UptimeRobot can then alert when the laptop stops
 * running the task, which the process-local health counters cannot see.
 *
 * The threshold is deliberately longer than the daily interval: a task that
 * starts late (`StartWhenAvailable`) is still healthy, while a full missed day
 * is stale.
 */

export const INTEGRITY_HEARTBEAT_COLLECTION = 'integrity_monitor_heartbeats';
export const INTEGRITY_HEARTBEAT_ID = 'production';
export const INTEGRITY_HEARTBEAT_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type IntegrityHeartbeatAuditStatus = 'UNCHANGED' | 'NEW_FINDINGS' | 'NOT_CHECKED';
export type IntegrityHeartbeatState =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'not_checked'
  | 'invalid';

export interface StoredIntegrityHeartbeat {
  _id: string;
  checkedAt: Date | string;
  status: IntegrityHeartbeatAuditStatus;
  scannedStockIns?: number;
  orphanStockIns?: number;
  unreceiptedPoStockIns?: number;
  newCount?: number;
  resolvedCount?: number;
  database?: string;
  source?: string;
  updatedAt?: Date | string;
}

export interface IntegrityHeartbeatView {
  state: IntegrityHeartbeatState;
  fresh: boolean;
  lastCheckedAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  auditStatus: IntegrityHeartbeatAuditStatus | null;
  newCount: number;
  resolvedCount: number;
  scannedStockIns: number | null;
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Classify one stored heartbeat. Pure, so every branch can be pinned without a
 * database or a server clock. Any value that cannot be trusted is not fresh.
 */
export function classifyIntegrityHeartbeat(
  row: StoredIntegrityHeartbeat | null,
  { now = new Date(), maxAgeMs = INTEGRITY_HEARTBEAT_MAX_AGE_MS }: { now?: Date; maxAgeMs?: number } = {}
): IntegrityHeartbeatView {
  const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
  if (!row) {
    return {
      state: 'missing',
      fresh: false,
      lastCheckedAt: null,
      ageSeconds: null,
      maxAgeSeconds,
      auditStatus: null,
      newCount: 0,
      resolvedCount: 0,
      scannedStockIns: null,
    };
  }

  const checkedAt = row.checkedAt instanceof Date ? row.checkedAt : new Date(row.checkedAt);
  const validDate = !Number.isNaN(checkedAt.getTime());
  const ageMs = validDate ? now.getTime() - checkedAt.getTime() : Number.NaN;
  const status = row.status;
  const validStatus =
    status === 'UNCHANGED' || status === 'NEW_FINDINGS' || status === 'NOT_CHECKED';

  let state: IntegrityHeartbeatState;
  if (!validDate || ageMs < -FUTURE_TOLERANCE_MS) state = 'invalid';
  else if (!validStatus) state = 'invalid';
  else if (status === 'NOT_CHECKED') state = 'not_checked';
  else if (ageMs > maxAgeMs) state = 'stale';
  else state = 'fresh';

  return {
    state,
    fresh: state === 'fresh',
    lastCheckedAt: validDate ? checkedAt.toISOString() : null,
    ageSeconds: validDate ? Math.max(0, Math.floor(ageMs / 1000)) : null,
    maxAgeSeconds,
    auditStatus: validStatus ? status : null,
    newCount: finiteCount(row.newCount),
    resolvedCount: finiteCount(row.resolvedCount),
    scannedStockIns:
      typeof row.scannedStockIns === 'number' && Number.isFinite(row.scannedStockIns)
        ? row.scannedStockIns
        : null,
  };
}

/** Read the one production heartbeat. The endpoint is the only caller. */
export async function readIntegrityHeartbeat(): Promise<IntegrityHeartbeatView> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('database is not connected');
  const row = (await db.collection<StoredIntegrityHeartbeat>(INTEGRITY_HEARTBEAT_COLLECTION).findOne({
    _id: INTEGRITY_HEARTBEAT_ID,
  })) as StoredIntegrityHeartbeat | null;
  return classifyIntegrityHeartbeat(row);
}
