import mongoose from 'mongoose';

import PurchaseOrder from '../models/purchaseOrder.model.ts';
import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import AuditLog from '../models/auditLog.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { recordAuditOnce } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import { releaseClaim } from './purchase-orders.service.ts';

const { ObjectId } = mongoose.Types;

/**
 * A claim older than this is abandoned. It is deliberately longer than any
 * normal receive request: a live request holds its claim only across two
 * database writes, while a crashed one is never coming back.
 */
export const PO_CLAIM_RECOVERY_AFTER_MS = 10 * 60_000;

type Claim = {
  _id?: mongoose.Types.ObjectId;
  productId?: mongoose.Types.ObjectId;
  quantity?: unknown;
  phase?: unknown;
  inventoryTransactionId?: mongoose.Types.ObjectId;
  createdAt?: unknown;
};

type PoRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  number?: string;
  claims?: Claim[];
  receipts?: Array<{ lines?: Array<{ inventoryTransactionId?: mongoose.Types.ObjectId }> }>;
};

type TxnRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  userId: mongoose.Types.ObjectId;
};

export type ClaimRecoverySummary = {
  scanned: number;
  released: number;
  undone: number;
  receipted: number;
  flagged: number;
  failed: number;
};

function asObjectId(value: unknown): mongoose.Types.ObjectId | null {
  if (value == null || !ObjectId.isValid(String(value))) return null;
  return new ObjectId(String(value));
}

async function auditClaimRecovery(
  po: PoRow,
  claimId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId | undefined,
  metadata: Record<string, unknown>,
) {
  try {
    await recordAuditOnce({
      businessId: po.businessId,
      userId,
      action: AUDIT_ACTIONS.PURCHASE_ORDER_CLAIM_RECOVERED,
      entityType: AUDIT_ENTITY_TYPES.PURCHASE_ORDER,
      entityId: po._id,
      metadata: { number: po.number, claimId: String(claimId), ...metadata },
      // One claim can produce exactly one recovery outcome. Two reapers that
      // both read the claim before either released it still append one event.
      dedupeKey: `po-claim:${String(po._id)}:${String(claimId)}:recovered`,
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: po.businessId,
      action: AUDIT_ACTIONS.PURCHASE_ORDER_CLAIM_RECOVERED,
      entityType: AUDIT_ENTITY_TYPES.PURCHASE_ORDER,
      entityId: po._id,
      error: err,
    });
  }
}

async function flagClaim(
  poId: mongoose.Types.ObjectId,
  businessId: mongoose.Types.ObjectId,
  claimId: mongoose.Types.ObjectId,
  reason: string
) {
  await PurchaseOrder.updateOne(
    { _id: poId, businessId, 'claims._id': claimId },
    {
      $set: {
        'claims.$.phase': 'REQUIRES_ATTENTION',
        'claims.$.lastAttemptAt': new Date(),
      },
    }
  );
  console.error(
    `[po-claim-recovery] claim ${String(claimId)} on PO ${String(poId)} requires attention: ${reason}`,
  );
}

/**
 * Reconcile abandoned receive claims (one PO line reservation each).
 *
 * The proof order is strict:
 *   1. A receipt already references the stock-in -> the receive committed; drop
 *      only the redundant claim and its reservation (never move stock).
 *   2. A stock-in transaction carrying this claim id exists -> it is the only
 *      write this claim could have made, so undo it only while the inventory row
 *      is still exactly at that transaction's newQuantity, then remove the
 *      transaction/audit and release the claim.
 *   3. No transaction exists -> no stock moved, so release the reservation.
 *   4. A claim marked MOVED with no transaction is contradictory -> flag it.
 *
 * The reaper never guesses. If a row has moved since the stock-in, the exact
 * undo no-ops and the claim is flagged for a human instead of overwriting newer
 * stock.
 */
export async function recoverStalePurchaseOrderClaims({
  olderThanMs = PO_CLAIM_RECOVERY_AFTER_MS,
  now = new Date(),
  limit = 50,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
} = {}): Promise<ClaimRecoverySummary> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = (await PurchaseOrder.find({
    'claims.createdAt': { $lte: cutoff },
  })
    .select('_id businessId number claims receipts')
    .limit(limit)
    .lean()) as unknown as PoRow[];

  const summary: ClaimRecoverySummary = {
    scanned: 0,
    released: 0,
    undone: 0,
    receipted: 0,
    flagged: 0,
    failed: 0,
  };

  for (const po of rows) {
    for (const claim of po.claims ?? []) {
      const createdAt = claim.createdAt instanceof Date ? claim.createdAt : null;
      if (!createdAt || createdAt > cutoff) continue;
      summary.scanned += 1;
      const claimId = asObjectId(claim._id);
      const productId = asObjectId(claim.productId);
      const quantity = Number(claim.quantity);
      if (!claimId || !productId || !Number.isInteger(quantity) || quantity < 1) {
        summary.failed += 1;
        continue;
      }

      try {
        const txn = (await InventoryTransaction.findOne({
          businessId: po.businessId,
          purchaseOrderClaimId: claimId,
        }).lean()) as unknown as TxnRow | null;

        const receipted = (po.receipts ?? []).some((receipt) =>
          (receipt.lines ?? []).some(
            (line) => line.inventoryTransactionId != null && String(line.inventoryTransactionId) === String(txn?._id)
          )
        );

        if (txn && receipted) {
          // The receipt is authoritative and already includes this quantity.
          // Removing the duplicate reservation moves committed back to received.
          await releaseClaim({
            poId: po._id,
            oidBiz: po.businessId,
            productId,
            quantity,
            claimId,
          });
          await auditClaimRecovery(po, claimId, txn.userId, {
            recovery: 'RECEIPT_ALREADY_EXISTS',
            productId: String(productId),
            quantity,
            inventoryTransactionId: String(txn._id),
          });
          summary.receipted += 1;
          continue;
        }

        if (!txn) {
          if (claim.phase === 'MOVED') {
            await flagClaim(po._id, po.businessId, claimId, 'claim is MOVED but its stock-in does not exist');
            summary.flagged += 1;
            continue;
          }
          await releaseClaim({
            poId: po._id,
            oidBiz: po.businessId,
            productId,
            quantity,
            claimId,
          });
          await auditClaimRecovery(po, claimId, undefined, {
            recovery: 'CLAIM_RELEASED',
            productId: String(productId),
            quantity,
          });
          summary.released += 1;
          continue;
        }

        if (claim.phase === 'REQUIRES_ATTENTION') {
          summary.flagged += 1;
          continue;
        }

        // Undo the exact stock-in this claim made. The quantity guard is the
        // safety property: a row that any later movement touched is left alone.
        const undo = await Inventory.updateOne(
          {
            businessId: po.businessId,
            productId,
            locationId: txn.locationId,
            quantity: txn.newQuantity,
          },
          { $set: { quantity: txn.previousQuantity } }
        );
        if (undo.modifiedCount !== 1) {
          await flagClaim(
            po._id,
            po.businessId,
            claimId,
            'inventory row moved after the abandoned stock-in; exact undo refused'
          );
          summary.flagged += 1;
          continue;
        }

        await InventoryTransaction.deleteOne({
          _id: txn._id,
          businessId: po.businessId,
          purchaseOrderClaimId: claimId,
        });
        await AuditLog.deleteOne({
          businessId: po.businessId,
          action: AUDIT_ACTIONS.INVENTORY_STOCK_IN,
          entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
          entityId: String(txn._id),
        });
        await releaseClaim({
            poId: po._id,
            oidBiz: po.businessId,
            productId,
          quantity,
            claimId,
        });
        await auditClaimRecovery(po, claimId, txn.userId, {
          recovery: 'STOCK_IN_UNDONE',
          productId: String(productId),
          quantity,
          inventoryTransactionId: String(txn._id),
          previousQuantity: txn.previousQuantity,
          restoredQuantity: txn.previousQuantity,
        });
        summary.undone += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[po-claim-recovery] claim ${String(claim._id)} on PO ${String(po._id)} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
  }

  return summary;
}
