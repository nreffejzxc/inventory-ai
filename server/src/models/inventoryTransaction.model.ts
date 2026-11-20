import mongoose from 'mongoose';

const { Schema } = mongoose;

// Stock movement types. TRANSFER (Phase 19) moves one product between two
// locations and is recorded as one row per leg, correlated by `reference`.
const transactionTypes = ['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT', 'TRANSFER'];

/**
 * The unique partial guard shared by the migration, the readiness gate and the
 * index audit. Keeping one definition in the schema's own module prevents the
 * checker from drifting away from the index Mongoose actually declares.
 */
export const TRANSFER_LEDGER_INDEX = {
  key: { businessId: 1, transferOperationId: 1, locationId: 1 },
  name: 'uniq_transfer_operation_location',
  unique: true,
  partialFilterExpression: { transferOperationId: { $type: 'objectId' } },
} as const;

/**
 * One keyed stock-in/out/adjustment owns at most one ledger row.
 *
 * The movement receipt's recovery path may decide that an inventory change landed
 * but its ledger row did not, and write the missing row. Two reconcilers can reach
 * that decision at once; this partial unique index lets exactly one insert win.
 * Ordinary movements and PO receipts carry no `movementOperationId`, so the
 * partial filter keeps them out of the index entirely.
 */
export const MOVEMENT_LEDGER_INDEX = {
  key: { businessId: 1, movementOperationId: 1 },
  name: 'uniq_movement_operation',
  unique: true,
  partialFilterExpression: { movementOperationId: { $type: 'objectId' } },
} as const;

const inventoryTransactionSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'productId is required'],
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: [true, 'locationId is required'],
    },
    type: {
      type: String,
      enum: transactionTypes,
      required: [true, 'Transaction type is required'],
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Transaction quantity must be a positive number'],
    },
    previousQuantity: {
      type: Number,
      required: true,
      min: [0, 'previousQuantity cannot be negative'],
    },
    newQuantity: {
      type: Number,
      required: true,
      min: [0, 'newQuantity cannot be negative'],
    },
    reason: {
      type: String,
      trim: true,
    },
    reference: {
      type: String,
      trim: true,
    },
    // The transfer operation that wrote this leg. Null for every ordinary
    // movement. Recovery uses it instead of a display reference, which a caller
    // may reuse or leave blank.
    transferOperationId: {
      type: Schema.Types.ObjectId,
      ref: 'StockTransferOperation',
    },
    // The PO receive claim that produced this STOCK_IN. A claim can outlive the
    // process that made the movement; this is how the stale-claim reaper finds
    // the exact movement to undo.
    purchaseOrderClaimId: {
      type: Schema.Types.ObjectId,
    },
    // The keyed movement receipt that owns this row. Present only for a plain
    // stock-in/out/adjustment delivered with an Idempotency-Key.
    movementOperationId: {
      type: Schema.Types.ObjectId,
      ref: 'StockMovementOperation',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
  },
  { collection: 'inventory_transactions', timestamps: true }
);

inventoryTransactionSchema.index({ businessId: 1, productId: 1, locationId: 1 });
inventoryTransactionSchema.index({ businessId: 1, productId: 1 });
inventoryTransactionSchema.index({ businessId: 1, locationId: 1 });
inventoryTransactionSchema.index({ businessId: 1, createdAt: 1 });
// Phase 20C (H-1): inventory history sorts `{ createdAt: -1, _id: -1 }` in the
// aggregation pipeline (transactions.service.js). As with audit logs, the plain
// `{ businessId: 1, createdAt: 1 }` index cannot order the `_id` tiebreaker, so the
// $sort blocked. This shape matches the pipeline's sort exactly.
inventoryTransactionSchema.index({ businessId: 1, createdAt: -1, _id: -1 });
// One transfer operation owns at most one ledger row per location. This is the
// concurrency guard behind recovery: two reconcilers may observe the same missing
// leg and both attempt the insert, but only one can win. Ordinary movements have
// no `transferOperationId`, so the partial filter keeps them out of the index and
// avoids treating every missing field as a duplicate null.
//
// The key is also a prefix match for `{ businessId, transferOperationId }`, so it
// replaces the former non-unique index rather than duplicating it.
inventoryTransactionSchema.index(TRANSFER_LEDGER_INDEX.key, {
  name: TRANSFER_LEDGER_INDEX.name,
  unique: TRANSFER_LEDGER_INDEX.unique,
  partialFilterExpression: TRANSFER_LEDGER_INDEX.partialFilterExpression,
});
inventoryTransactionSchema.index({ businessId: 1, purchaseOrderClaimId: 1 });
inventoryTransactionSchema.index(MOVEMENT_LEDGER_INDEX.key, {
  name: MOVEMENT_LEDGER_INDEX.name,
  unique: MOVEMENT_LEDGER_INDEX.unique,
  partialFilterExpression: MOVEMENT_LEDGER_INDEX.partialFilterExpression,
});

const InventoryTransaction = mongoose.model(
  'InventoryTransaction',
  inventoryTransactionSchema
);

export default InventoryTransaction;
