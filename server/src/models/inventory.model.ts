import mongoose from 'mongoose';

const { Schema } = mongoose;

const inventorySchema = new Schema(
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
    quantity: {
      type: Number,
      required: true,
      min: [0, 'Quantity cannot be negative'],
      default: 0,
    },
    // V1 keeps reservations at 0; the field preserves the architecture for later.
    reservedQuantity: {
      type: Number,
      required: true,
      min: [0, 'reservedQuantity cannot be negative'],
      default: 0,
    },
    // Operation ids of stock transfers that have touched this row but not yet
    // cleared their marker. A crash between the source debit and the rest of a
    // transfer leaves the id here, which is what lets the recovery service prove
    // whether a quantity it sees is the one that transfer wrote. It is an array
    // because two concurrent transfers to the same destination must not conflict.
    transferOperationIds: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
  },
  { collection: 'inventory', timestamps: true }
);

// availableQuantity = quantity - reservedQuantity (derived, never stored).
// Business logic (Phase 04) must prevent availableQuantity < 0 on writes.
inventorySchema.virtual('availableQuantity').get(function availableQuantity() {
  return (this.quantity || 0) - (this.reservedQuantity || 0);
});

inventorySchema.set('toJSON', { virtuals: true });

// One inventory record per product + location within a business.
inventorySchema.index(
  { businessId: 1, productId: 1, locationId: 1 },
  { unique: true }
);
inventorySchema.index({ businessId: 1, productId: 1 });
inventorySchema.index({ businessId: 1, locationId: 1 });

// The inventory list reads newest-changed-first with a deterministic tiebreaker —
// `sort({ updatedAt: -1, _id: -1 })` over `{ businessId }` plus optional
// productId/locationId filters (inventoryService.listRows, which also backs the AI
// assistant's getInventory and getProductsByLocation tools). Same reasoning as the
// product catalog's Phase 20G index: every index above carries a `businessId` prefix
// and can serve the equality match, but none can SUPPLY that order, so the page sort
// was a blocking in-memory sort. It matters more here than anywhere else, because
// `listRows` now applies `$skip`/`$limit` ABOVE its product/location joins (measured
// 2026-10-13: the joins previously ran once per tenant row — 20 105 of them — and
// cost 6.3 s to fill a 25-row page). With this key the sort is index-provided, so the
// window is read straight off the index and only the page is joined. Declaring the
// sort keys after the equality key is what makes the order index-provided; `_id` is
// last because it is the tiebreaker and must share `updatedAt`'s direction. The
// optional filters stay OUT of the key, since an index led by an optional field
// cannot serve the request that omits it. `createdAt` is deliberately NOT used: the
// page follows the row's last change, and a transfer rewrites two rows in place.
// Every index above is kept unchanged.
inventorySchema.index({ businessId: 1, updatedAt: -1, _id: -1 });

// The SAME page order, for a request that names ONE location (§27DG).
//
// The index above supplies `{ updatedAt: -1, _id: -1 }` for the tenant-wide list, but a
// request with `locationId` has to combine an equality on `locationId` with that sort,
// and no declared key could supply both: `{ businessId, locationId }` carries no sort
// key, and `{ businessId, updatedAt, _id }` carries no `locationId`. The planner was
// therefore choosing between an index-ordered scan that filters on `locationId` and a
// blocking in-memory sort of every row at that location — and at 523 918 inventory rows
// (131 000 products × 6 locations, one location holding 131 000 of them) it chose the
// sort: the location-filtered page measured **2 395 ms**, `explain` captured a `SORT`
// winning plan over the location's rows with `optimizationTimeMillis: 2052`, and the same
// query on the same tenant had measured 98–125 ms earlier that day. That is plan-choice
// instability, not a fixed cost — which is why the remedy is an index that makes the
// wanted plan the only sensible one, rather than a pipeline rewrite.
//
// Declaring the equality key first and the complete page order after it is what makes
// the order index-provided: Mongo reads the location's rows in `updatedAt`/`_id` order
// and can stop after `$limit` of them. Kept alongside `{ businessId, locationId }`, which
// is a prefix of this key — the same deliberate choice as the page-sort index above, so
// no existing environment has an index dropped underneath it.
//
// Measured after the build on the 100 143-row perf tenant: every location reads in
// 100–226 ms through the service the Inventory screen and the assistant's `getInventory`
// tool call, and `explain` now names this index with no `SORT` stage.
inventorySchema.index({ businessId: 1, locationId: 1, updatedAt: -1, _id: -1 });

const Inventory = mongoose.model('Inventory', inventorySchema);

export default Inventory;
