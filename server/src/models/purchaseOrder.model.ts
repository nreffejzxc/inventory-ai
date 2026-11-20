import mongoose from 'mongoose';

const { Schema } = mongoose;

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'OPEN', 'RECEIVED', 'CANCELED'];

/**
 * One ordered product line. Snapshot productName/sku at order time so the PO
 * keeps its own record if the product is later renamed or archived. quantityReceived
 * starts at 0 and is only ever increased by receiving (Phase 13C) — never edited.
 *
 * quantityCommitted is the claim-first receiving counter: quantity durably received
 * PLUS quantity held by in-flight receive claims (reservations that have won the PO
 * race but whose inventory movement + final receipt may not have landed yet). At rest
 * quantityCommitted == quantityReceived and `claims` is empty; while a receive is
 * mid-flight a line can have quantityCommitted > quantityReceived. It exists because a
 * cross-field `quantityReceived + claimed <= quantityOrdered` guard is not expressible
 * in Mongo arrayFilters/$elemMatch — a single filterable scalar is. quantityReceived
 * itself must stay durable/receipt-linked (it drives auto-RECEIVED and reconciliation),
 * so claims reserve in this separate counter, never in quantityReceived.
 */
const poItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'productId is required'],
    },
    productName: {
      type: String,
      required: [true, 'productName is required'],
      trim: true,
    },
    sku: {
      type: String,
      trim: true,
    },
    quantityOrdered: {
      type: Number,
      required: [true, 'quantityOrdered is required'],
      min: [1, 'quantityOrdered must be at least 1'],
    },
    quantityReceived: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'quantityReceived cannot be negative'],
    },
    quantityCommitted: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'quantityCommitted cannot be negative'],
    },
    unitCost: {
      type: Number,
      min: [0, 'unitCost cannot be negative'],
    },
  },
  { _id: false }
);

/**
 * One in-flight receive claim on a PO line (claim-first receiving, Phase 13C
 * redesign). Created by Op1 CLAIM before any inventory is moved and removed by
 * Op3 FINALIZE (claim -> durable receipt) or Op4 RELEASE (compensation). Its
 * sub-document _id is KEPT (unlike items/receipts): it is generated up front so
 * every compensation is a targeted, idempotent `$pull` by that exact id — it can
 * never touch another request's claim.
 */
const poClaimSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'productId is required'],
    },
    quantity: {
      type: Number,
      required: [true, 'quantity is required'],
      min: [1, 'quantity must be at least 1'],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
    },
    // The client's Idempotency-Key for the receive that owns this claim. It lets a
    // retry recognise its own in-flight claim instead of reserving the same quantity
    // again. Optional: requests without a key keep the old behaviour.
    requestKey: {
      type: String,
      trim: true,
      maxlength: [200, 'requestKey must be at most 200 characters'],
    },
    // SHA-256 of this receive's canonical lines + reference. A reused key with a
    // different request is refused instead of replaying somebody else's receipt.
    requestFingerprint: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    // Recovery marker for a claim whose movement may already exist. `CLAIMED`
    // means no stock-in has been confirmed; `MOVED` is set after the stock-in;
    // `REQUIRES_ATTENTION` means a reaper could not prove a safe undo.
    phase: {
      type: String,
      enum: ['CLAIMED', 'MOVED', 'REQUIRES_ATTENTION'],
      default: 'CLAIMED',
    },
    inventoryTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'InventoryTransaction',
    },
    lastAttemptAt: Date,
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }
);

/**
 * One line of a receiving receipt (Phase 13C). Records the exact inventory
 * movement the receive caused so a receipt can be traced to its ledger
 * transaction (inventoryTransactionId) and back via the movement's reference
 * (= the PO number). previousQuantity/newQuantity mirror the stock-in's ledger
 * transaction for reconciliation.
 */
const receiptLineSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'productId is required'],
    },
    quantity: {
      type: Number,
      required: [true, 'quantity is required'],
      min: [1, 'quantity must be at least 1'],
    },
    inventoryTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'InventoryTransaction',
      required: [true, 'inventoryTransactionId is required'],
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
  },
  { _id: false }
);

/**
 * One receiving event against this PO (Phase 13C). Embedded on the purchase
 * order — receipts are only ever read with the PO, never queried independently,
 * so a separate collection would add joins/cleanup for nothing in V1. The
 * `$inc` of each item's quantityReceived and the `$push` of this record are one
 * atomic document update, so the PO can never record a receipt without
 * advancing the counter (or vice-versa).
 */
const receiptSchema = new Schema(
  {
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    // Optional invoice / delivery note, displayed only.
    reference: {
      type: String,
      trim: true,
      maxlength: [200, 'reference must be at most 200 characters'],
      default: '',
    },
    // The Idempotency-Key that produced this receipt, stored so a retry after an
    // ambiguous finalize can be answered from the durable receipt instead of adding
    // the same stock a second time. Optional for historical receipts.
    requestKey: {
      type: String,
      trim: true,
      maxlength: [200, 'requestKey must be at most 200 characters'],
    },
    requestFingerprint: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    lines: {
      type: [receiptLineSchema],
      default: [],
    },
  },
  { _id: false }
);

const purchaseOrderSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
      index: true,
    },
    number: {
      type: String,
      required: [true, 'number is required'],
      trim: true,
    },
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier',
      required: [true, 'supplierId is required'],
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: [true, 'locationId is required'],
    },
    status: {
      type: String,
      enum: PURCHASE_ORDER_STATUSES,
      default: 'DRAFT',
    },
    expectedAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    items: {
      type: [poItemSchema],
      default: [],
    },
    receipts: {
      type: [receiptSchema],
      default: [],
    },
    // In-flight receive claims (claim-first receiving). Empty at rest. Each entry
    // reserves quantity on a line that a receive is between its PO claim and its
    // durable receipt; if the process dies mid-receive a claim can remain (ghost),
    // blocking over-receiving while the on-hand stays truthful — visible via the
    // detail endpoint's pendingClaims and recoverable by cancel + re-create.
    claims: {
      type: [poClaimSchema],
      default: [],
    },
  },
  { collection: 'purchase_orders', timestamps: true }
);

// PO numbers are sequential per business and never reused, so the compound
// index is plain-unique. It is the final authority under concurrency: number
// allocation computes max+1 and the create retries on a duplicate-key race.
purchaseOrderSchema.index({ businessId: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ businessId: 1, status: 1 });
purchaseOrderSchema.index({ businessId: 1, supplierId: 1 });
purchaseOrderSchema.index({ businessId: 1, locationId: 1 });

// Phase 20G: the purchase-order list is read newest-first with a deterministic
// tiebreaker — `sort({ createdAt: -1, _id: -1 })` over `{ businessId }` plus
// optional status/supplierId filters (purchase-orders.service.js list). The
// indexes above serve those equality matches but none can supply the order, so
// the winning plan was `SORT -> FETCH -> IXSCAN`, a blocking in-memory sort over
// the whole tenant partition. Declaring the sort keys after the equality key makes
// the order index-provided. `_id` is last because it is the tiebreaker in every
// sort clause and must share `createdAt`'s direction. status/supplierId stay OUT
// of the key for the same reason as products: both are optional, and an index led
// by an optional field cannot serve the request that omits it. Every index above
// is kept unchanged.
purchaseOrderSchema.index({ businessId: 1, createdAt: -1, _id: -1 });

const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);

export default PurchaseOrder;
