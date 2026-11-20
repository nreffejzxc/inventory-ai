import mongoose from 'mongoose';

import AuditFailure from '../models/auditFailure.model.ts';

export const AUDIT_FAILURE_RETENTION_DAYS = 90;

type IdLike = string | mongoose.Types.ObjectId;

export type AuditFailureInput = {
  businessId?: IdLike | null;
  action: string;
  entityType: string;
  entityId?: IdLike | null;
  error?: unknown;
  now?: Date;
};

const MAX_ACTION = 100;
const MAX_ENTITY_TYPE = 100;
const MAX_ENTITY_ID = 200;

function safeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Build the bounded row. Never stores the upstream error message: it can contain
 * a URI, a provider response or a piece of customer data. The code names the
 * class of failure; the action/entity fields name what could not be audited.
 */
export function buildAuditFailure(input: AuditFailureInput): {
  businessId: mongoose.Types.ObjectId | null;
  action: string;
  entityType: string;
  entityId?: string;
  errorCode: string;
  occurredAt: Date;
  expiresAt: Date;
} {
  const now = input.now instanceof Date ? input.now : new Date();
  const businessId =
    input.businessId && mongoose.Types.ObjectId.isValid(String(input.businessId))
      ? new mongoose.Types.ObjectId(String(input.businessId))
      : null;
  const entityId = safeText(input.entityId == null ? '' : String(input.entityId), MAX_ENTITY_ID);
  return {
    businessId,
    action: safeText(input.action, MAX_ACTION) || 'UNKNOWN',
    entityType: safeText(input.entityType, MAX_ENTITY_TYPE) || 'UNKNOWN',
    ...(entityId ? { entityId } : {}),
    errorCode: 'AUDIT_WRITE_FAILED',
    occurredAt: now,
    expiresAt: new Date(now.getTime() + AUDIT_FAILURE_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Persist one audit-write gap. Called from best-effort audit wrappers after the
 * business write has committed. It NEVER throws: monitoring must not turn a
 * saved movement into a failed request, and an unavailable database is exactly
 * when the original response matters most. The console line remains the
 * immediate signal; the row is the durable one an operator can count later.
 */
export async function monitorAuditFailure(input: AuditFailureInput): Promise<boolean> {
  const row = buildAuditFailure(input);
  // The console line is immediate operator signal, not a second copy of the
  // upstream error. A MongoDB URI or provider response can contain a password;
  // the class of failure is enough to find the audit path that failed.
  const errorName = input.error instanceof Error ? input.error.name : 'Error';
  console.error(
    `[audit-gap] ${row.action} ${row.entityType}${row.entityId ? ` ${row.entityId}` : ''} could not be audited` +
      ` (${errorName})`,
  );
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await AuditFailure.create(row);
    return true;
  } catch (err) {
    console.error(
      `[audit-gap] failure record could not be stored: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return false;
  }
}

export type AuditFailureSummary = {
  total: number;
  latestAt: Date | null;
  byAction: Array<{ action: string; count: number }>;
  byTenant: Array<{ businessId: string; count: number }>;
};

/**
 * Bounded, tenant-scoped read used by the `audit:failures` operator command.
 * No message, user id, request body or entity name is returned; those never
 * entered the collection in the first place.
 */
export async function summarizeAuditFailures({
  businessId,
  from,
  to,
}: {
  businessId?: string;
  from: Date;
  to: Date;
}): Promise<AuditFailureSummary> {
  const match: Record<string, unknown> = { occurredAt: { $gte: from, $lte: to } };
  if (businessId) match.businessId = new mongoose.Types.ObjectId(businessId);

  const [rows] = await AuditFailure.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              latestAt: { $max: '$occurredAt' },
            },
          },
        ],
        actions: [
          { $group: { _id: '$action', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 20 },
        ],
        tenants: [{ $group: { _id: '$businessId', count: { $sum: 1 } } }],
      },
    },
  ]);

  const totals = (rows?.totals?.[0] ?? {}) as { total?: unknown; latestAt?: unknown };
  const actions = (rows?.actions ?? []) as Array<{ _id?: unknown; count?: unknown }>;
  const tenants = (rows?.tenants ?? []) as Array<{ _id?: unknown; count?: unknown }>;
  return {
    total: typeof totals.total === 'number' ? totals.total : 0,
    latestAt: totals.latestAt instanceof Date ? totals.latestAt : null,
    byAction: actions
      .filter((row) => typeof row._id === 'string')
      .map((row) => ({ action: row._id as string, count: Number(row.count) || 0 })),
    byTenant: tenants
      .filter((row) => row._id != null)
      .map((row) => ({ businessId: String(row._id), count: Number(row.count) || 0 }))
      .sort((a, b) => b.count - a.count || a.businessId.localeCompare(b.businessId)),
  };
}
