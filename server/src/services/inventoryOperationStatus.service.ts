import mongoose from 'mongoose';

import IdempotencyRecord from '../models/idempotencyRecord.model.ts';
import StockMovementOperation from '../models/stockMovementOperation.model.ts';

/** The only operation existence/state information a member needs to see. */
export type InventoryOperationStatus =
  | 'COMPLETED'
  | 'PROCESSING'
  | 'RECOVERY_PENDING'
  | 'REQUIRES_ATTENTION'
  | 'UNKNOWN';

export type InventoryOperationStatusResult = {
  state: InventoryOperationStatus;
  /** A support reference, never the idempotency key. */
  reference: string | null;
  checkedAt: string;
};

const STALE_CLAIM_MS = 60_000;

function ageMs(updatedAt: unknown, now: number): number {
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Number.NaN;
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

/**
 * Resolve what the server knows about one key without returning its stored
 * answer or any other tenant data. The receipt is authoritative for a keyed
 * movement; the transport record covers creates and other idempotent writes.
 */
export async function inventoryOperationStatus({
  businessId,
  key,
  now = Date.now(),
}: {
  businessId: string;
  key: string;
  now?: number;
}): Promise<InventoryOperationStatusResult> {
  const biz = new mongoose.Types.ObjectId(businessId);
  const [receipt, transport] = await Promise.all([
    StockMovementOperation.findOne({ businessId: biz, requestKey: key })
      .select('_id state updatedAt')
      .lean(),
    IdempotencyRecord.findOne({ businessId: biz, key })
      .select('_id state createdAt')
      .lean(),
  ]);

  const checkedAt = new Date(now).toISOString();
  if (receipt) {
    const reference = String(receipt._id);
    if (receipt.state === 'COMPLETED') return { state: 'COMPLETED', reference, checkedAt };
    if (receipt.state === 'REQUIRES_ATTENTION') {
      return { state: 'REQUIRES_ATTENTION', reference, checkedAt };
    }
    return {
      state:
        ageMs(receipt.updatedAt, now) > STALE_CLAIM_MS ? 'RECOVERY_PENDING' : 'PROCESSING',
      reference,
      checkedAt,
    };
  }

  if (transport) {
    if (transport.state === 'COMPLETED') {
      return { state: 'COMPLETED', reference: String(transport._id), checkedAt };
    }
    // A stale transport claim proves only that no answer was stored. The handler
    // may have committed before the process died or the claim was released, so
    // this is not a safe "not applied" claim.
    return {
      state: ageMs(transport.createdAt, now) > STALE_CLAIM_MS ? 'UNKNOWN' : 'PROCESSING',
      reference: String(transport._id),
      checkedAt,
    };
  }

  return { state: 'UNKNOWN', reference: null, checkedAt };
}