import mongoose from 'mongoose';

import AuditOutbox from '../models/auditOutbox.model.ts';
import ProductImport from '../models/productImport.model.ts';
import PurchaseOrder from '../models/purchaseOrder.model.ts';
import StockMovementOperation from '../models/stockMovementOperation.model.ts';

const { ObjectId } = mongoose.Types;

export const AUDIT_OUTBOX_STATUSES = ['PENDING', 'SENDING', 'DELIVERED', 'FAILED'] as const;
export type AuditOutboxStatus = (typeof AUDIT_OUTBOX_STATUSES)[number];

/** A FAILED row that has not retried for this long is treated as overdue. */
export const AUDIT_FAILED_OVERDUE_MS = 15 * 60_000;
/** A completed receipt with no audit hand-off after this long is overdue. */
export const AUDIT_UNMARKED_OVERDUE_MS = 10 * 60_000;

type IdLike = string | mongoose.Types.ObjectId;

type SummaryCounts = {
  scanned?: number;
  groups?: number;
  enqueued?: number;
  delivered?: number;
  failed?: number;
  skipped?: number;
};

export type AuditRepairPassInput = {
  movementAudits?: SummaryCounts | null;
  poAudits?: SummaryCounts | null;
  importAudits?: SummaryCounts | null;
  auditOutbox?: SummaryCounts | null;
};

type RepairTotals = {
  scanned: number;
  groups: number;
  enqueued: number;
  delivered: number;
  failed: number;
  skipped: number;
};

export type AuditRepairTotals = {
  passes: number;
  lastPassAt: string | null;
  movement: RepairTotals;
  po: RepairTotals;
  imports: RepairTotals;
  outbox: RepairTotals;
};

export type AuditHealthSnapshot = {
  now: string;
  outbox: {
    counts: Record<AuditOutboxStatus, number>;
    oldest: Record<
      AuditOutboxStatus,
      { at: string | null; ageMs: number | null; statusSince: string | null; statusAgeMs: number | null }
    >;
  };
  failedOverdue: {
    count: number;
    thresholdMs: number;
    oldestAt: string | null;
    oldestAgeMs: number | null;
  };
  unmarked: {
    total: number;
    overdue: number;
    thresholdMs: number;
    oldestAt: string | null;
    oldestAgeMs: number | null;
    overdueOldestAt: string | null;
    overdueOldestAgeMs: number | null;
    byProducer: {
      productImports: number;
      movements: number;
      poReceipts: number;
    };
    overdueByProducer: {
      productImports: number;
      movements: number;
      poReceipts: number;
    };
  };
  repair: AuditRepairTotals;
  alerts: string[];
};

function emptyRepairTotals(): RepairTotals {
  return { scanned: 0, groups: 0, enqueued: 0, delivered: 0, failed: 0, skipped: 0 };
}

function emptyAuditRepairTotals(): AuditRepairTotals {
  return {
    passes: 0,
    lastPassAt: null,
    movement: emptyRepairTotals(),
    po: emptyRepairTotals(),
    imports: emptyRepairTotals(),
    outbox: emptyRepairTotals(),
  };
}

let repairTotals = emptyAuditRepairTotals();

function addCounts(target: RepairTotals, source: SummaryCounts | null | undefined): void {
  if (!source) return;
  for (const key of Object.keys(target) as Array<keyof RepairTotals>) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      target[key] += value;
    }
  }
}

/**
 * Record one scheduled repair pass. The totals are process-local by design:
 * they describe what this serving process has attempted since boot and are
 * emitted with the same health record as the database snapshot. They are never
 * a substitute for the durable receipt/outbox rows.
 */
export function recordAuditRepairPass(input: AuditRepairPassInput): AuditRepairTotals {
  repairTotals.passes += 1;
  repairTotals.lastPassAt = new Date().toISOString();
  addCounts(repairTotals.movement, input.movementAudits);
  addCounts(repairTotals.po, input.poAudits);
  addCounts(repairTotals.imports, input.importAudits);
  addCounts(repairTotals.outbox, input.auditOutbox);
  return auditRepairTotals();
}

/** Return a copy so a caller cannot mutate the process-local totals. */
export function auditRepairTotals(): AuditRepairTotals {
  return {
    passes: repairTotals.passes,
    lastPassAt: repairTotals.lastPassAt,
    movement: { ...repairTotals.movement },
    po: { ...repairTotals.po },
    imports: { ...repairTotals.imports },
    outbox: { ...repairTotals.outbox },
  };
}

/** Test seam: a suite can start from a known set of pass totals. */
export function resetAuditRepairTotals(): void {
  repairTotals = emptyAuditRepairTotals();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function ageMs(value: Date | null, now: Date): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

function oldestDate(values: Array<Date | null>): Date | null {
  const present = values.filter((value): value is Date => value != null);
  if (present.length === 0) return null;
  return new Date(Math.min(...present.map((value) => value.getTime())));
}

function businessFilter(businessId?: IdLike): Record<string, unknown> {
  return businessId ? { businessId: new ObjectId(String(businessId)) } : {};
}

type CountFacet = {
  total: number;
  overdue: number;
  oldest: Date | null;
  overdueOldest: Date | null;
};

function facetResult(row: unknown): CountFacet {
  const root = record(row);
  const allRows = Array.isArray(root?.all) ? root.all : [];
  const overdueRows = Array.isArray(root?.overdue) ? root.overdue : [];
  const all = record(allRows[0]);
  const overdue = record(overdueRows[0]);
  const total = Number(all?.count);
  const overdueCount = Number(overdue?.count);
  return {
    total: Number.isFinite(total) && total > 0 ? total : 0,
    overdue: Number.isFinite(overdueCount) && overdueCount > 0 ? overdueCount : 0,
    oldest: asDate(all?.oldest),
    overdueOldest: asDate(overdue?.oldest),
  };
}

type CountModel = {
  aggregate: (pipeline: Record<string, unknown>[]) => Promise<unknown[]>;
};

async function countFacet(
  model: CountModel,
  filter: Record<string, unknown>,
  cutoff: Date,
): Promise<CountFacet> {
  const rows = await model.aggregate([
    { $match: filter },
    {
      $facet: {
        all: [{ $group: { _id: null, count: { $sum: 1 }, oldest: { $min: '$updatedAt' } } }],
        overdue: [
          { $match: { updatedAt: { $lte: cutoff } } },
          { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: '$updatedAt' } } },
        ],
      },
    },
  ]);
  return facetResult(rows[0]);
}

/**
 * Count UNMARKED PO RECEIPTS, not purchase orders. One order can carry several
 * finalized batches; a `$elemMatch` over the embedded array would count that
 * whole order once and understate the repair backlog. Each batch is its own
 * audit event (`receiveId`), so each batch is its own unit here. Age comes from
 * the receipt's own `receivedAt`, not the order's later `updatedAt`, which a
 * later marked receipt can advance.
 */
async function countPoReceiptFacet(
  filter: Record<string, unknown>,
  cutoff: Date,
): Promise<CountFacet> {
  const rows = await PurchaseOrder.aggregate([
    { $match: filter },
    { $unwind: '$receipts' },
    {
      $match: {
        'receipts.receiveId': { $exists: true },
        'receipts.auditEnqueuedAt': null,
      },
    },
    {
      $facet: {
        all: [
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              oldest: { $min: '$receipts.receivedAt' },
            },
          },
        ],
        overdue: [
          { $match: { 'receipts.receivedAt': { $lte: cutoff } } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              oldest: { $min: '$receipts.receivedAt' },
            },
          },
        ],
      },
    },
  ]);
  return facetResult(rows[0]);
}

async function outboxByStatus(businessId: IdLike | undefined, now: Date): Promise<{
  counts: Record<AuditOutboxStatus, number>;
  oldest: Record<
    AuditOutboxStatus,
    { at: string | null; ageMs: number | null; statusSince: string | null; statusAgeMs: number | null }
  >;
}> {
  const counts = Object.fromEntries(
    AUDIT_OUTBOX_STATUSES.map((status) => [status, 0]),
  ) as Record<AuditOutboxStatus, number>;
  const rows = await AuditOutbox.aggregate([
    { $match: businessFilter(businessId) },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        oldestCreatedAt: { $min: '$createdAt' },
        oldestUpdatedAt: { $min: '$updatedAt' },
      },
    },
  ]);

  const oldest = Object.fromEntries(
    AUDIT_OUTBOX_STATUSES.map((status) => [
      status,
      { at: null, ageMs: null, statusSince: null, statusAgeMs: null },
    ]),
  ) as Record<
    AuditOutboxStatus,
    { at: string | null; ageMs: number | null; statusSince: string | null; statusAgeMs: number | null }
  >;

  for (const row of rows) {
    const value = record(row);
    const status = String(value?._id ?? '');
    if (!AUDIT_OUTBOX_STATUSES.includes(status as AuditOutboxStatus)) continue;
    const key = status as AuditOutboxStatus;
    const count = Number(value?.count);
    counts[key] = Number.isFinite(count) && count > 0 ? count : 0;
    const createdAt = asDate(value?.oldestCreatedAt);
    const updatedAt = asDate(value?.oldestUpdatedAt);
    oldest[key] = {
      at: createdAt?.toISOString() ?? null,
      ageMs: ageMs(createdAt, now),
      statusSince: updatedAt?.toISOString() ?? null,
      statusAgeMs: ageMs(updatedAt, now),
    };
  }
  return { counts, oldest };
}

/**
 * Read a bounded, tenant-scoped health snapshot. Counts and ages are aggregate
 * values; no row identifier, audit metadata or upstream error message is
 * returned. `businessId` exists for tests and an operator's single-tenant read.
 */
export async function readAuditHealth({
  now = new Date(),
  failedOverdueMs = AUDIT_FAILED_OVERDUE_MS,
  unmarkedOverdueMs = AUDIT_UNMARKED_OVERDUE_MS,
  businessId,
}: {
  now?: Date;
  failedOverdueMs?: number;
  unmarkedOverdueMs?: number;
  businessId?: IdLike;
} = {}): Promise<AuditHealthSnapshot> {
  const failedCutoff = new Date(now.getTime() - failedOverdueMs);
  const unmarkedCutoff = new Date(now.getTime() - unmarkedOverdueMs);
  const base = businessFilter(businessId);
  const { counts, oldest } = await outboxByStatus(businessId, now);

  const failedOverdueFilter: Record<string, unknown> = {
    ...base,
    status: 'FAILED',
    updatedAt: { $lte: failedCutoff },
  };
  const [failedOverdueCount, failedOverdueOldest] = await Promise.all([
    AuditOutbox.countDocuments(failedOverdueFilter),
    AuditOutbox.findOne(failedOverdueFilter)
      .sort({ updatedAt: 1, _id: 1 })
      .select('updatedAt')
      .lean<{ updatedAt?: Date }>(),
  ]);
  const failedOldestAt = asDate(failedOverdueOldest?.updatedAt);

  const [imports, movements, poReceipts] = await Promise.all([
    countFacet(
      ProductImport as unknown as CountModel,
      { ...base, status: 'COMPLETED', auditEnqueuedAt: null },
      unmarkedCutoff,
    ),
    countFacet(
      StockMovementOperation as unknown as CountModel,
      { ...base, state: 'COMPLETED', auditTracked: true, auditEnqueuedAt: null },
      unmarkedCutoff,
    ),
    countPoReceiptFacet(base, unmarkedCutoff),
  ]);

  const unmarkedTotal = imports.total + movements.total + poReceipts.total;
  const unmarkedOverdue = imports.overdue + movements.overdue + poReceipts.overdue;
  const unmarkedOldest = oldestDate([imports.oldest, movements.oldest, poReceipts.oldest]);
  const unmarkedOverdueOldest = oldestDate([
    imports.overdueOldest,
    movements.overdueOldest,
    poReceipts.overdueOldest,
  ]);

  const alerts: string[] = [];
  if (failedOverdueCount > 0) {
    alerts.push(
      `${failedOverdueCount} FAILED audit-outbox row(s) have not retried for ${Math.round(
        failedOverdueMs / 60_000,
      )} minutes; oldest ${failedOldestAt?.toISOString() ?? 'unknown'}.`,
    );
  }
  if (unmarkedOverdue > 0) {
    alerts.push(
      `${unmarkedOverdue} completed receipt(s) have no audit hand-off for ${Math.round(
        unmarkedOverdueMs / 60_000,
      )} minutes (imports=${imports.overdue}, movements=${movements.overdue}, ` +
        `poReceipts=${poReceipts.overdue}); oldest ${unmarkedOverdueOldest?.toISOString() ?? 'unknown'}.`,
    );
  }

  return {
    now: now.toISOString(),
    outbox: { counts, oldest },
    failedOverdue: {
      count: failedOverdueCount,
      thresholdMs: failedOverdueMs,
      oldestAt: failedOldestAt?.toISOString() ?? null,
      oldestAgeMs: ageMs(failedOldestAt, now),
    },
    unmarked: {
      total: unmarkedTotal,
      overdue: unmarkedOverdue,
      thresholdMs: unmarkedOverdueMs,
      oldestAt: unmarkedOldest?.toISOString() ?? null,
      oldestAgeMs: ageMs(unmarkedOldest, now),
      overdueOldestAt: unmarkedOverdueOldest?.toISOString() ?? null,
      overdueOldestAgeMs: ageMs(unmarkedOverdueOldest, now),
      byProducer: {
        productImports: imports.total,
        movements: movements.total,
        poReceipts: poReceipts.total,
      },
      overdueByProducer: {
        productImports: imports.overdue,
        movements: movements.overdue,
        poReceipts: poReceipts.overdue,
      },
    },
    repair: auditRepairTotals(),
    alerts,
  };
}

/**
 * Read and report one health snapshot. Alerts are error lines, not a pager:
 * this project has no hosted alerting channel, so an operator or the existing
 * log collector is the consumer. The record is deliberately compact and never
 * includes a tenant id or a row payload.
 */
export async function monitorAuditHealth({
  logger = console,
  ...options
}: {
  now?: Date;
  failedOverdueMs?: number;
  unmarkedOverdueMs?: number;
  businessId?: IdLike;
  logger?: { log: (message: string) => void; error: (message: string) => void };
} = {}): Promise<AuditHealthSnapshot | null> {
  try {
    const snapshot = await readAuditHealth(options);
    const totalOutbox = Object.values(snapshot.outbox.counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (totalOutbox > 0 || snapshot.unmarked.total > 0 || snapshot.repair.passes > 0) {
      logger.log(
        `[audit-health] outbox pending=${snapshot.outbox.counts.PENDING} ` +
          `sending=${snapshot.outbox.counts.SENDING} delivered=${snapshot.outbox.counts.DELIVERED} ` +
          `failed=${snapshot.outbox.counts.FAILED} ` +
          `oldestFailedAge=${snapshot.outbox.oldest.FAILED.ageMs ?? 'none'}ms ` +
          `unmarked=${snapshot.unmarked.total} ` +
          `repairPasses=${snapshot.repair.passes}`,
      );
    }
    for (const alert of snapshot.alerts) {
      logger.error(`[audit-health] ALERT: ${alert}`);
    }
    return snapshot;
  } catch {
    logger.error('[audit-health] could not read the outbox/repair health snapshot.');
    return null;
  }
}

export default {
  AUDIT_FAILED_OVERDUE_MS,
  AUDIT_UNMARKED_OVERDUE_MS,
  readAuditHealth,
  monitorAuditHealth,
  recordAuditRepairPass,
  resetAuditRepairTotals,
};
