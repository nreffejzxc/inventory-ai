import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Durable receipt for one keyed stock-in, stock-out or adjustment.
 *
 * WHY THIS EXISTS. `idempotency_records` makes a repeated DELIVERY replay the
 * first answer, but it is a transport record: a 5xx releases the claim (a failure
 * that changed nothing must be retryable), and the record expires after 24 hours.
 * A movement can commit and then fail while the response is produced; the member
 * is told it failed, retries under the same key, and — with the transport record
 * gone — the movement would be applied a second time.
 *
 * This row is the domain receipt that closes that gap. It is written BEFORE the
 * inventory change, carries the request fingerprint so a reused key cannot answer
 * a different movement, and records the exact ledger transaction once committed.
 * A retry under the same key replays the stored response, or recovers it from the
 * ledger row when the process died between the two writes.
 *
 * THE LEDGER REMAINS THE TRUTH. This row is operational evidence and a replay
 * handle, never a quantity source: stock is read from `inventory`, completed
 * movements from `inventory_transactions`. `inventoryTransactionId` and the
 * transaction's own `movementOperationId` are the two directions of the link.
 *
 * STATES
 *   IN_PROGRESS         the receipt exists; no inventory change is confirmed
 *   INVENTORY_WRITTEN   the stock change landed; the ledger row is not confirmed
 *   COMPLETED           the ledger row exists and the response is stored
 *   REQUIRES_ATTENTION  recovery cannot prove whether stock moved; a human decides
 *
 * Unlike the transfer journal this row is unique per `(businessId, requestKey)`:
 * a movement has exactly one committed outcome, so a second attempt under the same
 * key may replay or recover it but must never create a sibling.
 */
const stockMovementOperationSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    requestKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    /** SHA-256 of kind + business + product + location + quantity + text fields. */
    requestFingerprint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    kind: {
      type: String,
      enum: ['STOCK_IN', 'STOCK_OUT', 'ADJUST'],
      required: true,
    },
    state: {
      type: String,
      enum: ['IN_PROGRESS', 'INVENTORY_WRITTEN', 'COMPLETED', 'REQUIRES_ATTENTION'],
      default: 'IN_PROGRESS',
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
    },
    /** The movement's own magnitude: a stock-in/out delta, or an adjustment target. */
    quantity: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    reference: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    /** The exact inventory row the change targeted, and the quantities it wrote. */
    inventoryRowId: {
      type: Schema.Types.ObjectId,
      ref: 'Inventory',
    },
    previousQuantity: Number,
    newQuantity: Number,
    /** Stock-in only: the upsert inserted the row, so an undo deletes it. */
    createdRow: Boolean,
    inventoryTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'InventoryTransaction',
    },
    /** Stored only after the whole operation is durable, for exact replay. */
    response: {
      type: Schema.Types.Mixed,
    },
    failure: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { collection: 'stock_movement_operations', timestamps: true }
);

// One key, one movement outcome. The duplicate-key error from this index is how a
// concurrent duplicate delivery discovers the existing receipt instead of writing
// a second one.
stockMovementOperationSchema.index({ businessId: 1, requestKey: 1 }, { unique: true });
// Operational scans (attention triage, a future reaper) read unfinished rows.
stockMovementOperationSchema.index({ state: 1, updatedAt: 1 });

const StockMovementOperation = mongoose.model(
  'StockMovementOperation',
  stockMovementOperationSchema
);

export default StockMovementOperation;
