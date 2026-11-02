import mongoose from 'mongoose';

const { Schema } = mongoose;

const productStatuses = ['ACTIVE', 'ARCHIVED'];

const productSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
    },
    brand: {
      type: String,
      trim: true,
    },
    sku: {
      type: String,
      trim: true,
    },
    barcode: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
    },
    costPrice: {
      type: Number,
      min: [0, 'costPrice cannot be negative'],
      default: 0,
    },
    sellingPrice: {
      type: Number,
      min: [0, 'sellingPrice cannot be negative'],
      default: 0,
    },
    unit: {
      type: String,
      trim: true,
    },
    minimumStock: {
      type: Number,
      min: [0, 'minimumStock cannot be negative'],
      default: 0,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: productStatuses,
      default: 'ACTIVE',
    },
  },
  { collection: 'products', timestamps: true }
);

// SKU and barcode must be unique within a business — but only among products
// that actually define them. A plain compound *sparse* unique index cannot give
// that here: any document already carries the prefix field (businessId), and
// MongoDB still indexes such a document when the trailing field (sku) is
// missing, treating it as null. Two SKU-less products in the same business
// would then collide on (businessId, null). A partial index filters on the
// value being a real string, so SKU-less / undefined products stay out of the
// uniqueness check entirely.
productSchema.index(
  { businessId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } } }
);
productSchema.index(
  { businessId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } }
);
productSchema.index({ businessId: 1, name: 1 });
productSchema.index({ businessId: 1, brand: 1 });
productSchema.index({ businessId: 1, categoryId: 1 });
productSchema.index({ businessId: 1, status: 1 });

// Phase 20G: the product catalog list is read newest-first with a deterministic
// tiebreaker — `sort({ createdAt: -1, _id: -1 })` over `{ businessId }` plus
// optional status/categoryId/q filters (product.service.js listSimple, which also
// backs the AI searchProducts/getProducts tools). The indexes above each carry a
// `businessId` prefix, so they serve the equality match but none can supply the
// order: the winning plan was `SORT -> FETCH -> IXSCAN`, a blocking in-memory sort
// over the whole tenant partition. Declaring the sort keys after the equality key
// makes the order index-provided. `_id` is last because it is the tiebreaker in
// every sort clause and must share `createdAt`'s direction. status/categoryId stay
// OUT of the key: both are optional, and an index led by an optional field cannot
// serve the request that omits it. Every index above is kept unchanged.
productSchema.index({ businessId: 1, createdAt: -1, _id: -1 });

const Product = mongoose.model('Product', productSchema);

export default Product;
