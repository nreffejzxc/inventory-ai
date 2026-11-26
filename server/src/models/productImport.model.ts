import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Durable receipt for one bulk product import attempt (FW-01).
 *
 * The HTTP idempotency middleware protects a retry only while its row exists.
 * This receipt is the domain-level record that survives that row: it stores the
 * operator's key, the exact file fingerprint, which product rows already
 * became products, and which opening-stock movements already landed. A retry
 * with the same key resumes instead of creating a second catalogue.
 *
 * The unique (businessId, key) index is the final guard against two concurrent
 * attempts with the same key. No key material, token or raw CSV row is stored
 * here; the file name and counts are enough for the audit trail.
 */
const createdProductSchema = new Schema(
  {
    line: { type: Number, required: true, min: 1 },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  },
  { _id: false },
);

const stockOperationSchema = new Schema(
  {
    line: { type: Number, required: true, min: 1 },
    quantity: { type: Number, required: true, min: 1 },
    inventoryTransactionId: { type: Schema.Types.ObjectId, ref: 'InventoryTransaction' },
  },
  { _id: false },
);

const importErrorSchema = new Schema(
  {
    line: { type: Number, required: true, min: 1 },
    field: { type: String, default: null },
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const productImportSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    key: { type: String, required: true, trim: true },
    fingerprint: { type: String, required: true },
    /** The operator who started the import; retained for audit repair after a crash. */
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    fileName: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['IN_PROGRESS', 'PARTIAL', 'COMPLETED', 'FAILED'],
      default: 'IN_PROGRESS',
      required: true,
    },
    totalRows: { type: Number, default: 0, min: 0 },
    createdProducts: { type: [createdProductSchema], default: [] },
    stockOperations: { type: [stockOperationSchema], default: [] },
    // `errors` is a reserved Mongoose schema path; `failures` carries the same
    // row-level report without shadowing document validation errors.
    failures: { type: [importErrorSchema], default: [] },
    result: { type: Schema.Types.Mixed },
    finishedAt: { type: Date },
    /**
     * Set only after the durable audit outbox row exists. Recovery scans
     * completed receipts where this is still null, which is the crash window
     * between the business commit and the audit hand-off.
     */
    auditEnqueuedAt: { type: Date },
  },
  { collection: 'product_imports', timestamps: true },
);

productImportSchema.index({ businessId: 1, key: 1 }, { unique: true });
productImportSchema.index({ businessId: 1, createdAt: -1 });
productImportSchema.index({ status: 1, auditEnqueuedAt: 1, updatedAt: 1 });

const ProductImport = mongoose.model('ProductImport', productImportSchema);

export default ProductImport;
