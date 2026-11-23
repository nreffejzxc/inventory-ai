import mongoose from 'mongoose';

import ProductImport from '../models/productImport.model.ts';
import AuditLog from '../models/auditLog.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import {
  enqueueAndDeliverAudit,
  type AuditOutboxEvent,
} from './auditOutbox.service.ts';

export const PRODUCT_IMPORT_AUDIT_STALE_MS = 60_000;

type IdLike = string | mongoose.Types.ObjectId;

type ProductImportAuditSource = {
  _id: IdLike;
  businessId: IdLike;
  userId?: IdLike | null;
  fileName: string;
  totalRows?: number;
  createdCount?: number;
  openingStockCount?: number;
  openingStockUnits?: number;
  result?: unknown;
  createdProducts?: unknown[];
  stockOperations?: Array<{ quantity?: number }>;
};

type ProductImportRecoveryRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  fileName: string;
  totalRows?: number;
  result?: unknown;
  createdProducts?: unknown[];
  stockOperations?: Array<{ quantity?: number }>;
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resultCount(result: unknown, key: string): number | null {
  if (!result || typeof result !== 'object') return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The one durable event for a completed import. `receiptId` is the entity and
 * the dedupe key, so a retry, a crashed request and a recovery sweep all name
 * the same fact rather than appending duplicates.
 */
export function productImportAuditEvent(source: ProductImportAuditSource): AuditOutboxEvent {
  const totalRows = source.totalRows ?? resultCount(source.result, 'totalRows') ?? 0;
  const createdCount =
    source.createdCount ??
    resultCount(source.result, 'createdCount') ??
    source.createdProducts?.length ??
    0;
  const openingStockCount =
    source.openingStockCount ??
    resultCount(source.result, 'openingStockCount') ??
    source.stockOperations?.length ??
    0;
  const openingStockUnits =
    source.openingStockUnits ??
    resultCount(source.result, 'openingStockUnits') ??
    (source.stockOperations ?? []).reduce((sum, row) => sum + count(row.quantity), 0);
  return {
    businessId: String(source.businessId),
    userId: source.userId == null ? null : String(source.userId),
    action: AUDIT_ACTIONS.PRODUCTS_IMPORTED,
    entityType: AUDIT_ENTITY_TYPES.PRODUCT_IMPORT,
    entityId: String(source._id),
    metadata: {
      fileName: source.fileName,
      totalRows,
      createdCount,
      openingStockCount,
      openingStockUnits,
    },
    dedupeKey: `product-import:${String(source._id)}:completed`,
  };
}

async function markAuditEnqueued(receiptId: IdLike) {
  // This field is a scan fence, not the durability boundary. It is set after
  // the outbox row exists; a crash before the update only makes recovery
  // re-enqueue the same dedupe key, which is a no-op.
  await ProductImport.updateOne(
    { _id: receiptId, status: 'COMPLETED' },
    { $set: { auditEnqueuedAt: new Date() } },
  );
}

/**
 * Enqueue before the audit attempt and mark the receipt once the outbox row is
 * durable. Returns the delivery result, but never throws: the business import
 * is already committed, so an audit failure must not turn it into a 500 that
 * invites a second upload. Any remaining work is retried by the flusher.
 */
export async function enqueueAndDeliverProductImportAudit(
  source: ProductImportAuditSource,
  event = productImportAuditEvent(source),
) {
  try {
    return await enqueueAndDeliverAudit(event, {
      onEnqueued: async () => markAuditEnqueued(source._id),
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: event.businessId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      error: err,
    });
    return 'failed' as const;
  }
}

/**
 * Repair the crash window between a completed receipt and its outbox row. The
 * scan is fenced by `auditEnqueuedAt`, so it revisits only imports that never
 * got a durable hand-off. An import whose audit row already exists is still
 * safe: `recordAuditOnce` returns the existing row.
 */
export async function recoverProductImportAudits({
  olderThanMs = PRODUCT_IMPORT_AUDIT_STALE_MS,
  now = new Date(),
  limit = 50,
  businessId,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  businessId?: IdLike;
} = {}): Promise<{ scanned: number; enqueued: number; delivered: number; failed: number }> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await ProductImport.find({
    ...(businessId ? { businessId: new mongoose.Types.ObjectId(String(businessId)) } : {}),
    status: 'COMPLETED',
    auditEnqueuedAt: null,
    updatedAt: { $lte: cutoff },
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(Math.max(0, limit))
    .lean<ProductImportRecoveryRow[]>();

  // Receipts completed before dedupe keys existed already have a legacy audit
  // row without a key. Fence those receipts without appending the same
  // historical event a second time; only a receipt with no audit needs repair.
  const legacyAudits = rows.length
    ? await AuditLog.find({
        businessId: { $in: rows.map((row) => row.businessId) },
        action: AUDIT_ACTIONS.PRODUCTS_IMPORTED,
        entityType: AUDIT_ENTITY_TYPES.PRODUCT_IMPORT,
        entityId: { $in: rows.map((row) => String(row._id)) },
      })
        .select('businessId entityId')
        .lean<Array<{ businessId: mongoose.Types.ObjectId; entityId?: string }>>()
    : [];
  const alreadyAudited = new Set(
    legacyAudits.map((audit) => `${String(audit.businessId)}:${String(audit.entityId)}`),
  );

  let enqueued = 0;
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    if (alreadyAudited.has(`${String(row.businessId)}:${String(row._id)}`)) {
      try {
        await markAuditEnqueued(row._id);
      } catch {
        failed += 1;
      }
      continue;
    }
    const event = productImportAuditEvent(row);
    const result = await enqueueAndDeliverProductImportAudit(row, event);
    if (result === 'missing') {
      failed += 1;
      continue;
    }
    enqueued += 1;
    if (result === 'delivered') delivered += 1;
    else if (result === 'failed') failed += 1;
  }
  return { scanned: rows.length, enqueued, delivered, failed };
}
