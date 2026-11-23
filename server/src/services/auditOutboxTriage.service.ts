import mongoose from 'mongoose';

import AuditOutbox from '../models/auditOutbox.model.ts';

/**
 * Read-only operator view of FAILED audit-outbox rows.
 *
 * A FAILED row is deliberately outside the DELIVERED TTL: it is evidence that
 * an audit event has not been appended. This service does not retry, resolve or
 * delete it. It returns the bounded set whose age OR attempt count crosses the
 * operator's threshold, with only the fields needed to identify the event and
 * its error class. `metadata`, `userId` and `businessId` are deliberately not
 * returned; the caller supplies a tenant scope when one is needed.
 */

export const AUDIT_TRIAGE_DEFAULT_LIMIT = 100;
export const AUDIT_TRIAGE_MAX_LIMIT = 1_000;
export const AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS = 15 * 60_000;
export const AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS = 3;

type IdLike = string | mongoose.Types.ObjectId;

export type AuditOutboxTriageRow = {
  id: string;
  dedupeKey: string;
  action: string;
  entityType: string;
  entityId: string | null;
  attempts: number;
  status: 'FAILED';
  createdAt: string | null;
  updatedAt: string | null;
  availableAt: string | null;
  lastError: string | null;
  ageMs: number | null;
};

export type AuditOutboxTriageReport = {
  command: 'triage:audit-outbox';
  readOnly: true;
  generatedAt: string;
  thresholds: {
    minAgeMs: number;
    minAttempts: number;
  };
  scope: {
    businessId: string | null;
    limit: number;
  };
  counts: {
    failed: number;
    matching: number;
    returned: number;
  };
  rows: AuditOutboxTriageRow[];
  note: string;
};

type TriageRowInput = {
  _id: unknown;
  dedupeKey?: unknown;
  action?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  attempts?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  availableAt?: unknown;
  lastError?: unknown;
};

function iso(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function safeError(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function rowView(row: TriageRowInput, now: Date): AuditOutboxTriageRow {
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : null;
  return {
    id: String(row._id),
    dedupeKey: typeof row.dedupeKey === 'string' ? row.dedupeKey : '',
    action: typeof row.action === 'string' ? row.action : '',
    entityType: typeof row.entityType === 'string' ? row.entityType : '',
    entityId: row.entityId == null ? null : String(row.entityId),
    attempts: positiveInteger(row.attempts) ?? 0,
    status: 'FAILED',
    createdAt: iso(row.createdAt),
    updatedAt: iso(updatedAt),
    availableAt: iso(row.availableAt),
    lastError: safeError(row.lastError),
    ageMs: updatedAt ? Math.max(0, now.getTime() - updatedAt.getTime()) : null,
  };
}

/**
 * Read the bounded FAILED triage set. A row is included when it is at least
 * `minAgeMs` old OR has reached `minAttempts`; both defaults are high enough to
 * exclude a fresh transient failure while still surfacing a hot retry loop.
 */
export async function readAuditOutboxTriage({
  now = new Date(),
  businessId,
  minAgeMs = AUDIT_TRIAGE_DEFAULT_MIN_AGE_MS,
  minAttempts = AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS,
  limit = AUDIT_TRIAGE_DEFAULT_LIMIT,
}: {
  now?: Date;
  businessId?: IdLike;
  minAgeMs?: number;
  minAttempts?: number;
  limit?: number;
} = {}): Promise<AuditOutboxTriageReport> {
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new RangeError('minAgeMs must be a non-negative number');
  }
  if (!Number.isInteger(minAttempts) || minAttempts < 1) {
    throw new RangeError('minAttempts must be a positive integer');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_TRIAGE_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${AUDIT_TRIAGE_MAX_LIMIT}`);
  }

  const base: Record<string, unknown> = { status: 'FAILED' };
  if (businessId) {
    base.businessId =
      businessId instanceof mongoose.Types.ObjectId
        ? businessId
        : new mongoose.Types.ObjectId(String(businessId));
  }
  const cutoff = new Date(now.getTime() - minAgeMs);
  const attention = {
    ...base,
    $or: [{ updatedAt: { $lte: cutoff } }, { attempts: { $gte: minAttempts } }],
  };

  const [failed, matching, rows] = await Promise.all([
    AuditOutbox.countDocuments(base),
    AuditOutbox.countDocuments(attention),
    AuditOutbox.find(attention)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .select('dedupeKey action entityType entityId attempts status createdAt updatedAt availableAt lastError')
      .lean<TriageRowInput[]>(),
  ]);

  return {
    command: 'triage:audit-outbox',
    readOnly: true,
    generatedAt: now.toISOString(),
    thresholds: { minAgeMs, minAttempts },
    scope: { businessId: businessId ? String(businessId) : null, limit },
    counts: { failed, matching, returned: rows.length },
    rows: rows.map((row) => rowView(row, now)),
    note:
      'READ-ONLY: these FAILED audit-outbox rows have not been retried, resolved or deleted. ' +
      'Inspect the error class, fix the dependency, and let the normal flusher retry; never delete a FAILED row as cleanup.',
  };
}

export default readAuditOutboxTriage;
