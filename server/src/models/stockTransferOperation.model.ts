import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Durable intent and recovery record for one stock transfer.
 *
 * WHY THIS EXISTS. A transfer is two inventory updates plus two ledger rows,
 * and the existing design deliberately does not use a multi-document
 * transaction. Its compensation handles a *thrown* failure, but a process that
 * dies between the source debit and the destination credit leaves no durable
 * record of what was intended. This row is written BEFORE the first inventory
 * change, so a later process can answer one question: is the transfer still
 * safe to finish, safe to undo, or ambiguous and requiring a human?
 *
 * THE JOURNAL IS NOT THE LEDGER. Inventory remains the source of truth for
 * quantities, and `inventory_transactions` remains the source of truth for
 * completed movements. This row records intent, stage, snapshots and the
 * operation id carried by both ledger rows. It is retained as an operational
 * audit trail, not used to calculate stock.
 *
 * STATES
 *   PREPARED             intent written, no inventory change confirmed
 *   SOURCE_DEBITED       source decrement confirmed
 *   DESTINATION_CREDITED destination increment confirmed
 *   LEDGER_WRITTEN       both TRANSFER rows exist
 *   COMPLETED            both rows, markers cleared, response stored
 *   COMPENSATED          inventory restored after a clean failure
 *   FAILED               failure before any inventory change
 *   REQUIRES_ATTENTION   recovery cannot prove a safe finish or undo
 */
const stockTransferOperationSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    /**
     * The client's Idempotency-Key that owned the attempt. Not unique: a retry
     * after a terminal failure may legitimately create a new journal row, and
     * the transport layer remains the authority on response replay.
     */
    requestKey: {
      type: String,
      trim: true,
      maxlength: 200,
      index: true,
    },
    /**
     * SHA-256 of the canonical transfer fields. The transport middleware also
     * fingerprints a live delivery, but its row expires after 24 hours while
     * this journal is retained; the durable retry path must not replay a
     * completed transfer for a key that now describes different stock.
     */
    requestFingerprint: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    fromLocationId: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
    },
    toLocationId: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    /** Client correlation label; ALSO the ledger reference for both legs. */
    reference: {
      type: String,
      trim: true,
      maxlength: 200,
      required: true,
    },
    state: {
      type: String,
      enum: [
        'PREPARED',
        'SOURCE_DEBITED',
        'DESTINATION_CREDITED',
        'LEDGER_WRITTEN',
        'COMPLETED',
        'COMPENSATED',
        'FAILED',
        'REQUIRES_ATTENTION',
      ],
      default: 'PREPARED',
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sourceRowId: {
      type: Schema.Types.ObjectId,
      ref: 'Inventory',
    },
    sourcePreviousQuantity: Number,
    sourceNewQuantity: Number,
    destinationRowId: {
      type: Schema.Types.ObjectId,
      ref: 'Inventory',
    },
    destinationPreviousQuantity: Number,
    destinationNewQuantity: Number,
    destinationCreated: Boolean,
    inventoryTransactionIds: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
    /** Stored only after the whole operation is durable, for ambiguous-retry replay. */
    response: {
      type: Schema.Types.Mixed,
    },
    failure: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    reconciledAt: Date,
  },
  { collection: 'stock_transfer_operations', timestamps: true }
);

stockTransferOperationSchema.index({ businessId: 1, createdAt: -1 });
stockTransferOperationSchema.index({ businessId: 1, requestKey: 1, createdAt: -1 });
// Recovery scans only unfinished operations. `state` leading and `updatedAt`
// after it is the shape the reaper reads.
stockTransferOperationSchema.index({ state: 1, updatedAt: 1 });

const StockTransferOperation = mongoose.model(
  'StockTransferOperation',
  stockTransferOperationSchema
);

export default StockTransferOperation;
