import mongoose from 'mongoose';

import PurchaseOrder from '../models/purchaseOrder.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import {
  enqueueAndDeliverAudit,
  type AuditOutboxEvent,
} from './auditOutbox.service.ts';

type IdLike = string | mongoose.Types.ObjectId;

export type PoReceiveAuditAppliedLine = {
  productId: unknown;
  quantity: unknown;
  inventoryTransactionId: unknown;
};

type PoReceiveAuditReceipt = {
  receiveId?: mongoose.Types.ObjectId | null;
  userId?: mongoose.Types.ObjectId | null;
  reference?: string | null;
  auditEnqueuedAt?: Date | null;
  lines?: Array<{
    productId?: unknown;
    quantity?: unknown;
    inventoryTransactionId?: unknown;
  }>;
};

type PoReceiveAuditSource = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  number: string;
  status?: string;
  receipts?: PoReceiveAuditReceipt[];
  updatedAt?: Date;
};

export type PoReceiveAuditHandoff = {
  businessId: IdLike;
  poId: IdLike;
  number: string;
  receiveId: IdLike;
  userId?: IdLike | null;
  reference?: string | null;
  status: string;
  partial?: boolean;
  applied: PoReceiveAuditAppliedLine[];
};

export type PoReceiveAuditRecoverySummary = {
  scanned: number;
  groups: number;
  enqueued: number;
  delivered: number;
  failed: number;
  skipped: number;
};

function oid(value: IdLike): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
}

/**
 * One durable audit event per receive operation. `receiveId` is generated when
 * the request starts and stamped on every receipt it finalizes, so all lines of
 * one batch name the same event even when the process dies before the batch's
 * normal audit call. A retry that finds its stored receipts reuses their
 * `receiveId`, which makes the dedupe key stable.
 */
export function poReceiveAuditEvent(handoff: PoReceiveAuditHandoff): AuditOutboxEvent {
  return {
    businessId: String(handoff.businessId),
    userId: handoff.userId == null ? null : String(handoff.userId),
    action: AUDIT_ACTIONS.PURCHASE_ORDER_RECEIVED,
    entityType: AUDIT_ENTITY_TYPES.PURCHASE_ORDER,
    entityId: String(handoff.poId),
    metadata: {
      number: handoff.number,
      status: handoff.status,
      ...(handoff.partial ? { partial: true } : {}),
      reference: handoff.reference || undefined,
      receivedLines: handoff.applied.map((line) => ({
        productId: String(line.productId),
        quantity: Number(line.quantity),
        inventoryTransactionId: String(line.inventoryTransactionId),
      })),
    },
    dedupeKey: `po-receive:${String(handoff.poId)}:${String(handoff.receiveId)}`,
  };
}

async function markAuditEnqueued({
  businessId,
  poId,
  receiveId,
}: {
  businessId: IdLike;
  poId: IdLike;
  receiveId: IdLike;
}) {
  // The marker is a repair fence, not the durability boundary. It is written
  // only after the outbox row exists; losing this update just makes recovery
  // enqueue the same key again, which is a no-op.
  await PurchaseOrder.updateOne(
    { _id: oid(poId), businessId: oid(businessId) },
    { $set: { 'receipts.$[r].auditEnqueuedAt': new Date() } },
    { arrayFilters: [{ 'r.receiveId': oid(receiveId) }] },
  );
}

/**
 * Enqueue and try the receive audit once. The PO and its receipts are already
 * durable, so an audit failure must never turn a successful receive into a 500.
 * A failed enqueue/delivery leaves the outbox row (or the unmarked receipts that
 * the repair scan finds) for the integrity pass.
 */
export async function enqueueAndDeliverPoReceiveAudit(
  handoff: PoReceiveAuditHandoff,
): Promise<'delivered' | 'failed' | 'pending' | 'missing'> {
  const event = poReceiveAuditEvent(handoff);
  try {
    return await enqueueAndDeliverAudit(event, {
      onEnqueued: async () => markAuditEnqueued(handoff),
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: handoff.businessId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      error: err,
    });
    return 'failed';
  }
}

function auditedLines(receipts: PoReceiveAuditReceipt[]): PoReceiveAuditAppliedLine[] {
  return receipts.flatMap((receipt) =>
    (receipt.lines ?? []).map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      inventoryTransactionId: line.inventoryTransactionId,
    })),
  );
}

/**
 * Repair receive operations whose receipts were finalized but whose batch audit
 * never reached the outbox. Only receipts carrying a `receiveId` are considered:
 * historical receipts predate the dedupe key and their existing plain audit rows
 * must not be replayed as a second event. One row is returned per PO; each
 * distinct `receiveId` on it becomes one event, so a crash after one of several
 * lines still records exactly what landed.
 */
export async function recoverPoReceiveAudits({
  olderThanMs = 60_000,
  now = new Date(),
  limit = 50,
  businessId,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  businessId?: IdLike;
} = {}): Promise<PoReceiveAuditRecoverySummary> {
  const filter: Record<string, unknown> = {
    receipts: {
      $elemMatch: {
        receiveId: { $exists: true },
        auditEnqueuedAt: null,
      },
    },
    updatedAt: { $lte: new Date(now.getTime() - olderThanMs) },
  };
  if (businessId) filter.businessId = oid(businessId);

  const rows = await PurchaseOrder.find(filter)
    .sort({ updatedAt: 1, _id: 1 })
    .limit(Math.max(0, limit))
    .lean<PoReceiveAuditSource[]>();

  const summary: PoReceiveAuditRecoverySummary = {
    scanned: rows.length,
    groups: 0,
    enqueued: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
  };

  for (const po of rows) {
    const pending = (po.receipts ?? []).filter(
      (receipt) => receipt.receiveId && !receipt.auditEnqueuedAt,
    );
    const byReceive = new Map<string, PoReceiveAuditReceipt[]>();
    for (const receipt of pending) {
      const key = String(receipt.receiveId);
      const group = byReceive.get(key);
      if (group) group.push(receipt);
      else byReceive.set(key, [receipt]);
    }

    for (const [receiveId, receipts] of byReceive) {
      const applied = auditedLines(receipts);
      if (applied.length === 0) {
        summary.skipped += 1;
        continue;
      }
      summary.groups += 1;
      const result = await enqueueAndDeliverPoReceiveAudit({
        businessId: po.businessId,
        poId: po._id,
        number: po.number,
        receiveId,
        userId: receipts[0]?.userId ?? null,
        reference: receipts.find((receipt) => receipt.reference)?.reference ?? null,
        status: po.status === 'RECEIVED' ? 'RECEIVED' : 'OPEN',
        applied,
      });
      if (result === 'missing') {
        summary.skipped += 1;
        continue;
      }
      summary.enqueued += 1;
      if (result === 'delivered') summary.delivered += 1;
      else if (result === 'failed') summary.failed += 1;
    }
  }

  return summary;
}

export default {
  enqueueAndDeliverPoReceiveAudit,
  poReceiveAuditEvent,
  recoverPoReceiveAudits,
};
