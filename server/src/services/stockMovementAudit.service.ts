import mongoose from 'mongoose';

import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import StockMovementOperation from '../models/stockMovementOperation.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import {
  enqueueAndDeliverAudit,
  type AuditOutboxEvent,
} from './auditOutbox.service.ts';

type IdLike = string | mongoose.Types.ObjectId;

type MovementKind = 'STOCK_IN' | 'STOCK_OUT' | 'ADJUST';

type MovementAuditReceipt = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  kind: MovementKind;
  createdBy: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  quantity: number;
  previousQuantity?: number | null;
  newQuantity?: number | null;
  inventoryTransactionId?: mongoose.Types.ObjectId | null;
  auditTracked?: boolean;
  auditEnqueuedAt?: Date | null;
  updatedAt?: Date;
};

type MovementAuditTransaction = {
  _id: mongoose.Types.ObjectId;
  type?: unknown;
  quantity?: unknown;
  previousQuantity?: unknown;
  newQuantity?: unknown;
  productId?: unknown;
  locationId?: unknown;
};

export type MovementAuditResponse = {
  transaction: {
    id?: unknown;
    type?: unknown;
    quantity?: unknown;
    previousQuantity?: unknown;
    newQuantity?: unknown;
    productId?: unknown;
    locationId?: unknown;
  };
  previousQuantity?: unknown;
  newQuantity?: unknown;
};

export type MovementAuditRecoverySummary = {
  scanned: number;
  enqueued: number;
  delivered: number;
  failed: number;
  skipped: number;
};

const ACTION_BY_KIND: Record<MovementKind, string> = {
  STOCK_IN: AUDIT_ACTIONS.INVENTORY_STOCK_IN,
  STOCK_OUT: AUDIT_ACTIONS.INVENTORY_STOCK_OUT,
  ADJUST: AUDIT_ACTIONS.INVENTORY_ADJUSTED,
};

const LEDGER_TYPE_BY_KIND: Record<MovementKind, string> = {
  STOCK_IN: 'STOCK_IN',
  STOCK_OUT: 'STOCK_OUT',
  ADJUST: 'ADJUSTMENT',
};

function oid(value: IdLike): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The one audit event for a keyed movement. `receiptId` is both the entity's
 * durable operation id and the dedupe key, so a retry, a replay after a lost
 * response and a recovery sweep all name the same fact.
 */
export function movementAuditEvent(
  receipt: MovementAuditReceipt,
  response: MovementAuditResponse,
  transactionId: unknown,
): AuditOutboxEvent {
  const entityId = transactionId ?? response.transaction.id;
  const inventoryTransactionId =
    entityId == null ? undefined : String(entityId);
  return {
    businessId: String(receipt.businessId),
    userId: String(receipt.createdBy),
    action: ACTION_BY_KIND[receipt.kind],
    entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
    entityId: inventoryTransactionId,
    metadata: {
      productId: String(receipt.productId),
      locationId: String(receipt.locationId),
      inventoryTransactionId,
      type:
        typeof response.transaction.type === 'string'
          ? response.transaction.type
          : LEDGER_TYPE_BY_KIND[receipt.kind],
      quantity: numberOrNull(response.transaction.quantity) ?? receipt.quantity,
      previousQuantity:
        numberOrNull(response.previousQuantity) ??
        numberOrNull(receipt.previousQuantity),
      newQuantity:
        numberOrNull(response.newQuantity) ?? numberOrNull(receipt.newQuantity),
    },
    dedupeKey: `movement:${String(receipt._id)}:completed`,
  };
}

async function markAuditEnqueued(receiptId: mongoose.Types.ObjectId) {
  // The marker is a repair fence, not the durability boundary. It is written
  // after the outbox row exists; a crash before this update only makes recovery
  // enqueue the same dedupe key again, which is a no-op.
  await StockMovementOperation.updateOne(
    { _id: receiptId, state: 'COMPLETED' },
    { $set: { auditEnqueuedAt: new Date() } },
  );
}

/**
 * Hand a completed keyed movement to the durable outbox. Called by the normal
 * completion path and by a replay of an already-completed receipt, so a retry
 * repairs the same crash window without appending a second audit. Never throws:
 * the ledger movement is already durable and must not be turned into a failure
 * by an audit outage. The recovery scan remains the final backstop.
 */
export async function enqueueAndDeliverMovementAudit(
  receiptId: IdLike | null | undefined,
  response: MovementAuditResponse,
  transactionId?: unknown,
): Promise<'delivered' | 'failed' | 'pending' | 'missing' | 'skipped'> {
  if (!receiptId) return 'skipped';

  let receipt: MovementAuditReceipt | null;
  try {
    receipt = await StockMovementOperation.findOne({
      _id: oid(receiptId),
      state: 'COMPLETED',
    }).lean<MovementAuditReceipt | null>();
  } catch (err) {
    await monitorAuditFailure({
      businessId: null,
      action: 'MOVEMENT_AUDIT_HANDOFF',
      entityType: AUDIT_ENTITY_TYPES.STOCK_MOVEMENT_OPERATION,
      entityId: receiptId,
      error: err,
    });
    return 'failed';
  }

  // Historical receipts have a plain audit row without a dedupe key. Replaying
  // one now would append the same event a second time, so they are not tracked.
  if (!receipt || !receipt.auditTracked) return 'skipped';

  const event = movementAuditEvent(receipt, response, transactionId ?? receipt.inventoryTransactionId);
  try {
    return await enqueueAndDeliverAudit(event, {
      onEnqueued: async () => markAuditEnqueued(receipt._id),
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: receipt.businessId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      error: err,
    });
    return 'failed';
  }
}

/**
 * Repair tracked COMPLETED receipts whose audit hand-off never ran. The scan is
 * fenced by `auditEnqueuedAt`, bounded by `limit`, and ignores receipts older
 * than the grace window so an in-flight completion is not raced. A missing
 * ledger row is reported, not guessed at; the receipt remains available for a
 * later pass.
 */
export async function recoverMovementAudits({
  olderThanMs = 60_000,
  now = new Date(),
  limit = 50,
  businessId,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  businessId?: IdLike;
} = {}): Promise<MovementAuditRecoverySummary> {
  const filter: Record<string, unknown> = {
    state: 'COMPLETED',
    auditTracked: true,
    auditEnqueuedAt: null,
    updatedAt: { $lte: new Date(now.getTime() - olderThanMs) },
  };
  if (businessId) filter.businessId = oid(businessId);

  const rows = await StockMovementOperation.find(filter)
    .sort({ updatedAt: 1, _id: 1 })
    .limit(Math.max(0, limit))
    .lean<MovementAuditReceipt[]>();

  const summary: MovementAuditRecoverySummary = {
    scanned: rows.length,
    enqueued: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    try {
      let txn = row.inventoryTransactionId
        ? await InventoryTransaction.findOne({
            _id: row.inventoryTransactionId,
            businessId: row.businessId,
          }).lean<MovementAuditTransaction | null>()
        : null;
      if (!txn) {
        txn = await InventoryTransaction.findOne({
          businessId: row.businessId,
          movementOperationId: row._id,
        }).lean<MovementAuditTransaction | null>();
      }
      if (!txn) {
        summary.failed += 1;
        console.error(
          `[movement-audit-recovery] receipt ${String(row._id)} has no ledger row; audit hand-off remains pending`,
        );
        continue;
      }

      const result = await enqueueAndDeliverMovementAudit(
        row._id,
        {
          transaction: {
            id: txn._id,
            type: txn.type,
            quantity: txn.quantity,
            previousQuantity: txn.previousQuantity,
            newQuantity: txn.newQuantity,
            productId: txn.productId,
            locationId: txn.locationId,
          },
          previousQuantity: row.previousQuantity ?? txn.previousQuantity,
          newQuantity: row.newQuantity ?? txn.newQuantity,
        },
        txn._id,
      );
      if (result === 'skipped' || result === 'missing') {
        summary.skipped += 1;
        continue;
      }
      summary.enqueued += 1;
      if (result === 'delivered') summary.delivered += 1;
      else if (result === 'failed') summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[movement-audit-recovery] receipt ${String(row._id)} could not hand off its audit: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  return summary;
}

export default {
  enqueueAndDeliverMovementAudit,
  movementAuditEvent,
  recoverMovementAudits,
};
