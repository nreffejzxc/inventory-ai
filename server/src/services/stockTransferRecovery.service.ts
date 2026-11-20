import mongoose from 'mongoose';

import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import StockTransferOperation from '../models/stockTransferOperation.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { recordAudit } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';

export const TRANSFER_RECOVERY_AFTER_MS = 60_000;

type Journal = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  fromLocationId: mongoose.Types.ObjectId;
  toLocationId: mongoose.Types.ObjectId;
  quantity: number;
  reason?: string;
  reference: string;
  state: string;
  createdBy: mongoose.Types.ObjectId;
  sourceRowId?: mongoose.Types.ObjectId;
  sourcePreviousQuantity?: number;
  sourceNewQuantity?: number;
  destinationRowId?: mongoose.Types.ObjectId;
  destinationPreviousQuantity?: number;
  destinationNewQuantity?: number;
  destinationCreated?: boolean;
  inventoryTransactionIds?: mongoose.Types.ObjectId[];
  response?: unknown;
};

type InventoryRow = {
  _id: mongoose.Types.ObjectId;
  quantity: number;
  transferOperationIds: mongoose.Types.ObjectId[];
};

type TxnRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  type?: string;
  quantity?: number;
  previousQuantity?: number;
  newQuantity?: number;
  reason?: string;
  reference?: string;
  userId: mongoose.Types.ObjectId;
  createdAt?: Date;
};

function publicTransaction(doc: TxnRow) {
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    productId: String(doc.productId),
    locationId: String(doc.locationId),
    type: doc.type,
    quantity: doc.quantity,
    previousQuantity: doc.previousQuantity,
    newQuantity: doc.newQuantity,
    reason: doc.reason ?? undefined,
    reference: doc.reference ?? undefined,
    userId: String(doc.userId),
    createdAt: doc.createdAt,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 11000;
}

/**
 * Order a validated ledger pair as source then destination. The rows are read
 * sorted by `_id`, but an id does not encode which location is which; pairing
 * by `locationId` keeps the response and audit metadata correct even when a
 * row was created by a different recovery pass.
 */
function orderedLedger(op: Journal, txns: TxnRow[]): [TxnRow, TxnRow] | null {
  const source = txns.find((row) => String(row.locationId) === String(op.fromLocationId));
  const destination = txns.find((row) => String(row.locationId) === String(op.toLocationId));
  if (!source || !destination || source === destination) return null;
  return [source, destination];
}

function completedResponse(op: Journal, txns: TxnRow[]) {
  const pair = orderedLedger(op, txns);
  if (!pair) return null;
  const [source, destination] = pair;
  return {
    reference: op.reference,
    transaction: publicTransaction(source),
    destinationTransaction: publicTransaction(destination),
    previousQuantity: op.sourcePreviousQuantity,
    newQuantity: op.sourceNewQuantity,
    destinationPreviousQuantity: op.destinationPreviousQuantity,
    destinationNewQuantity: op.destinationNewQuantity,
  };
}

async function clearMarkers(op: Journal) {
  const pull = { $pull: { transferOperationIds: op._id } };
  await Promise.all([
    Inventory.updateOne({ _id: op.sourceRowId, businessId: op.businessId }, pull),
    Inventory.updateOne({ _id: op.destinationRowId, businessId: op.businessId }, pull),
  ]);
}

async function markAttention(op: Journal, reason: string) {
  await StockTransferOperation.updateOne(
    { _id: op._id, state: { $nin: ['COMPLETED', 'COMPENSATED'] } },
    { $set: { state: 'REQUIRES_ATTENTION', failure: reason.slice(0, 1000), reconciledAt: new Date() } }
  );
  return { state: 'REQUIRES_ATTENTION' as const, action: 'flagged' as const, reason };
}

/**
 * Undo both legs only while each row still holds the exact quantity this
 * operation wrote. A row that has moved on is left untouched: restoring it
 * would overwrite a newer legitimate movement. That is the same quantity-
 * anchored rule the synchronous compensation uses.
 */
async function undoInventoryLegs(op: Journal): Promise<boolean> {
  if (!op.sourceRowId || op.sourceNewQuantity === undefined) return false;
  const source = await Inventory.updateOne(
    {
      _id: op.sourceRowId,
      businessId: op.businessId,
      quantity: op.sourceNewQuantity,
      transferOperationIds: op._id,
    },
    {
      $inc: { quantity: op.quantity },
      $pull: { transferOperationIds: op._id },
    }
  );
  if (source.modifiedCount !== 1) return false;

  if (op.destinationRowId && op.destinationNewQuantity !== undefined) {
    if (op.destinationCreated) {
      const deleted = await Inventory.deleteOne({
        _id: op.destinationRowId,
        businessId: op.businessId,
        quantity: op.destinationNewQuantity,
        reservedQuantity: 0,
        transferOperationIds: op._id,
      });
      // If the row was not exactly as this operation left it, the source is
      // already restored but the destination remains a visible ambiguity.
      if (deleted.deletedCount !== 1) return false;
    } else {
      const destination = await Inventory.updateOne(
        {
          _id: op.destinationRowId,
          businessId: op.businessId,
          quantity: op.destinationNewQuantity,
          transferOperationIds: op._id,
        },
        {
          $inc: { quantity: -op.quantity },
          $pull: { transferOperationIds: op._id },
        }
      );
      if (destination.modifiedCount !== 1) return false;
    }
  }
  return true;
}

type LedgerLeg = {
  locationId: mongoose.Types.ObjectId;
  previousQuantity?: number;
  newQuantity?: number;
};

function ledgerLegs(op: Journal): [LedgerLeg, LedgerLeg] {
  return [
    {
      locationId: op.fromLocationId,
      previousQuantity: op.sourcePreviousQuantity,
      newQuantity: op.sourceNewQuantity,
    },
    {
      locationId: op.toLocationId,
      previousQuantity: op.destinationPreviousQuantity,
      newQuantity: op.destinationNewQuantity,
    },
  ];
}

function readLedger(op: Journal): Promise<TxnRow[]> {
  return InventoryTransaction.find({
    businessId: op.businessId,
    transferOperationId: op._id,
    type: 'TRANSFER',
  })
    .sort({ _id: 1 })
    .lean() as unknown as Promise<TxnRow[]>;
}

/**
 * An existing row is only proof when it is exactly the leg this journal
 * intended. A row written by another attempt, a duplicate location, or one
 * whose quantities no longer match the snapshots must become
 * REQUIRES_ATTENTION rather than be accepted as a completed ledger.
 */
function ledgerRowsMatch(op: Journal, rows: TxnRow[]): boolean {
  const legs = ledgerLegs(op);
  if (rows.length > legs.length) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const location = String(row.locationId);
    const leg = legs.find((candidate) => String(candidate.locationId) === location);
    if (
      !leg ||
      seen.has(location) ||
      String(row.productId) !== String(op.productId) ||
      row.quantity !== op.quantity ||
      row.previousQuantity !== leg.previousQuantity ||
      row.newQuantity !== leg.newQuantity
    ) {
      return false;
    }
    seen.add(location);
  }
  return true;
}

async function createLedgerLeg(op: Journal, leg: LedgerLeg): Promise<void> {
  if (leg.previousQuantity === undefined || leg.newQuantity === undefined) {
    throw new Error('transfer journal is missing a ledger quantity snapshot');
  }
  try {
    await InventoryTransaction.create({
      businessId: op.businessId,
      productId: op.productId,
      locationId: leg.locationId,
      type: 'TRANSFER',
      quantity: op.quantity,
      previousQuantity: leg.previousQuantity,
      newQuantity: leg.newQuantity,
      reason: op.reason || undefined,
      reference: op.reference,
      transferOperationId: op._id,
      userId: op.createdBy,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // A concurrent recovery pass inserted this exact leg after our read. That
    // is success, not a second row: the unique operation/location guard made
    // one writer win, and the next read proves the winning row's quantities.
    const winner = await InventoryTransaction.findOne({
      businessId: op.businessId,
      transferOperationId: op._id,
      locationId: leg.locationId,
      type: 'TRANSFER',
    }).lean();
    if (!winner) throw err;
  }
}

async function rollForwardLedger(op: Journal): Promise<TxnRow[] | null> {
  let existing = await readLedger(op);
  if (!ledgerRowsMatch(op, existing)) return null;
  const byLocation = new Map(existing.map((row) => [String(row.locationId), row]));
  for (const leg of ledgerLegs(op)) {
    if (byLocation.has(String(leg.locationId))) continue;
    if (leg.previousQuantity === undefined || leg.newQuantity === undefined) return null;
    await createLedgerLeg(op, leg);
  }
  existing = await readLedger(op);
  if (existing.length !== 2 || !ledgerRowsMatch(op, existing)) return null;
  return orderedLedger(op, existing);
}

/**
 * Reconcile one journal. This is deliberately a sequence of safe observations:
 * it never assumes a stage happened, it proves each one from inventory + the
 * operation-id markers, and it refuses to touch a row that no longer matches
 * the exact quantity the journal recorded.
 *
 * It can finish a transfer whose inventory legs landed but whose ledger/audit
 * did not, or undo a transfer whose source landed and destination did not. Any
 * state it cannot prove becomes REQUIRES_ATTENTION, which keeps the row visible
 * to an operator and never invents stock.
 */
export async function recoverTransferOperation(id: unknown): Promise<{
  state: string;
  action: 'completed' | 'compensated' | 'flagged' | 'noop';
  response?: unknown;
} | null> {
  const op = (await StockTransferOperation.findById(id).lean()) as unknown as Journal | null;
  if (!op) return null;
  if (op.state === 'COMPLETED' && op.response) {
    return { state: op.state, action: 'completed', response: op.response };
  }
  if (op.state === 'COMPENSATED') return { state: op.state, action: 'compensated' };
  if (op.state === 'REQUIRES_ATTENTION') return { state: op.state, action: 'flagged' };

  // Prefer the recorded row, but fall back to the operation marker. A process
  // can die after writing a leg and before journaling its row id; the marker is
  // written by the same atomic inventory update as the quantity, so it is the
  // proof that survives that window.
  const source = op.sourceRowId
    ? ((await Inventory.findOne({ _id: op.sourceRowId, businessId: op.businessId }).lean()) as unknown as InventoryRow | null)
    : ((await Inventory.findOne({
        businessId: op.businessId,
        productId: op.productId,
        locationId: op.fromLocationId,
        transferOperationIds: op._id,
      }).lean()) as unknown as InventoryRow | null);
  const destination = op.destinationRowId
    ? ((await Inventory.findOne({ _id: op.destinationRowId, businessId: op.businessId }).lean()) as unknown as InventoryRow | null)
    : ((await Inventory.findOne({
        businessId: op.businessId,
        productId: op.productId,
        locationId: op.toLocationId,
        transferOperationIds: op._id,
      }).lean()) as unknown as InventoryRow | null);
  // The marker fallback found a row the journal did not yet name; adopt its id
  // so the undo/CAS and marker cleanup target the row that actually holds stock.
  if (source) op.sourceRowId = source._id;
  if (destination) op.destinationRowId = destination._id;
  const sourceMarked = Boolean(
    source?.transferOperationIds?.some((value: unknown) => String(value) === String(op._id))
  );
  const destinationMarked = Boolean(
    destination?.transferOperationIds?.some((value: unknown) => String(value) === String(op._id))
  );

  // A PREPARED/FAILED journal with no marker never changed inventory.
  if (!sourceMarked && !destinationMarked) {
    const txns = await readLedger(op);
    if (txns.length === 2) {
      // No marker means no inventory movement can be proved. Two ledger rows are
      // accepted only when they are exactly this journal's two legs; otherwise
      // the previous code would have blessed any pair with the right count.
      if (!ledgerRowsMatch(op, txns)) {
        return markAttention(op, 'ledger rows exist without inventory operation markers');
      }
      const response = completedResponse(op, txns);
      await StockTransferOperation.updateOne(
        { _id: op._id },
        { $set: { state: 'COMPLETED', response, failure: undefined, reconciledAt: new Date() } }
      );
      return { state: 'COMPLETED', action: 'completed', response };
    }
    if (txns.length > 0) {
      return markAttention(op, 'ledger rows exist without inventory operation markers');
    }
    await StockTransferOperation.updateOne(
      { _id: op._id },
      { $set: { state: 'COMPENSATED', reconciledAt: new Date() } }
    );
    return { state: 'COMPENSATED', action: 'compensated' };
  }

  // Both legs are present and exact: finish the ledger rather than undo a
  // transfer whose stock already reached the destination.
  if (sourceMarked && destinationMarked) {
    if (
      source!.quantity !== op.sourceNewQuantity ||
      destination!.quantity !== op.destinationNewQuantity
    ) {
      return markAttention(op, 'inventory changed after both transfer legs were written');
    }
    const txns = await rollForwardLedger(op);
    if (!txns) {
      return markAttention(op, 'both legs present but ledger could not be completed');
    }
    await StockTransferOperation.updateOne(
      { _id: op._id },
      {
        $set: {
          state: 'LEDGER_WRITTEN',
          inventoryTransactionIds: txns.map((row) => row._id),
          reconciledAt: new Date(),
        },
      }
    );
    const response = completedResponse(op, txns);
    await clearMarkers(op);
    try {
      await recordAudit({
        businessId: op.businessId,
        userId: op.createdBy,
        action: AUDIT_ACTIONS.INVENTORY_TRANSFERRED,
        entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
        entityId: txns[0]!._id,
        metadata: {
          productId: String(op.productId),
          fromLocationId: String(op.fromLocationId),
          toLocationId: String(op.toLocationId),
          inventoryTransactionIds: txns.map((row) => String(row._id)),
          reference: op.reference,
          type: 'TRANSFER',
          quantity: op.quantity,
          recovered: true,
        },
      });
    } catch (err) {
      await monitorAuditFailure({
        businessId: op.businessId,
        action: AUDIT_ACTIONS.INVENTORY_TRANSFERRED,
        entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
        entityId: txns[0]!._id,
        error: err,
      });
    }
    await StockTransferOperation.updateOne(
      { _id: op._id },
      { $set: { state: 'COMPLETED', response, failure: undefined, reconciledAt: new Date() } }
    );
    return { state: 'COMPLETED', action: 'completed', response };
  }

  // Source only: the normal crash window. Undo it exactly.
  if (sourceMarked && !destinationMarked) {
    if (source!.quantity !== op.sourceNewQuantity) {
      return markAttention(op, 'source moved after its transfer debit');
    }
    const undone = await undoInventoryLegs(op);
    if (!undone) return markAttention(op, 'source debit could not be undone exactly');
    await StockTransferOperation.updateOne(
      { _id: op._id },
      { $set: { state: 'COMPENSATED', reconciledAt: new Date() } }
    );
    return { state: 'COMPENSATED', action: 'compensated' };
  }

  return markAttention(op, 'destination marker exists without a source marker');
}

export type TransferRecoverySummary = {
  scanned: number;
  completed: number;
  compensated: number;
  flagged: number;
  failed: number;
};

/**
 * Reap unfinished transfer journals. Only rows older than the request budget
 * are candidates, so a healthy in-flight transfer is never stolen. One bad row
 * cannot stop the batch; it is counted as failed and the next run retries it.
 */
export async function recoverStaleTransferOperations({
  olderThanMs = TRANSFER_RECOVERY_AFTER_MS,
  now = new Date(),
  limit = 50,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
} = {}): Promise<TransferRecoverySummary> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await StockTransferOperation.find({
    state: { $in: ['PREPARED', 'SOURCE_DEBITED', 'DESTINATION_CREDITED', 'LEDGER_WRITTEN', 'FAILED'] },
    updatedAt: { $lte: cutoff },
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .select('_id');

  const summary: TransferRecoverySummary = {
    scanned: rows.length,
    completed: 0,
    compensated: 0,
    flagged: 0,
    failed: 0,
  };
  for (const row of rows) {
    try {
      const result = await recoverTransferOperation(row._id);
      if (result?.action === 'completed') summary.completed += 1;
      else if (result?.action === 'compensated') summary.compensated += 1;
      else if (result?.action === 'flagged') summary.flagged += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[transfer-recovery] ${String(row._id)} could not be reconciled: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
  return summary;
}
