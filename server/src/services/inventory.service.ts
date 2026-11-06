import mongoose from 'mongoose';
import type { PipelineStage } from 'mongoose';

import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import Product from '../models/product.model.ts';
import Location from '../models/location.model.ts';
import ApiError from '../utils/ApiError.ts';
import { recordAudit } from './audit.service.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';

const { ObjectId } = mongoose.Types;

/**
 * An identifier as it reaches this service. Both forms occur at real call sites:
 * a hex string — the request layer stringifies `req.user.businessId` and
 * `req.user.id` — and an ObjectId already loaded from a document, which
 * `purchase-orders.service.js` passes as `line.productId` and
 * `existing.locationId._id`. `oid()` accepts either, so the alias names the
 * pair rather than asserting which one a given caller holds.
 */
type IdLike = string | mongoose.Types.ObjectId;

const oid = (id: IdLike) => new ObjectId(id);

const AUDIT_ACTION_BY_TYPE = {
  STOCK_IN: AUDIT_ACTIONS.INVENTORY_STOCK_IN,
  STOCK_OUT: AUDIT_ACTIONS.INVENTORY_STOCK_OUT,
  ADJUSTMENT: AUDIT_ACTIONS.INVENTORY_ADJUSTED,
};

/**
 * The stock movements recorded through `recordMovement`, named as the keys of
 * the action table above so the audit lookup is an index of a known key rather
 * than of `string`. TRANSFER is deliberately absent: a transfer writes its two
 * ledger rows directly and records one audit for the pair.
 */
type MovementType = keyof typeof AUDIT_ACTION_BY_TYPE;

/** The movement payloads the public service methods accept. */
type MovementInput = {
  productId: IdLike;
  locationId: IdLike;
  quantity: number;
  reason?: string;
  reference?: string;
};

/** The transfer payload, which names two locations instead of one. */
type TransferInput = {
  productId: IdLike;
  fromLocationId: IdLike;
  toLocationId: IdLike;
  quantity: number;
  reason?: string;
  reference?: string;
};

/** The inventory list query, already parsed and validated by the controller. */
type InventoryListFilters = {
  productId?: string;
  locationId?: string;
  q?: string;
  status?: string;
  lowStock?: boolean;
  outOfStock?: boolean;
  skip: number;
  limit: number;
};

/** The movement recorded by `recordMovement`, before defaults are applied. */
type MovementRecord = {
  businessId: IdLike;
  userId: IdLike;
  productId: IdLike;
  locationId: IdLike;
  type: MovementType;
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  reason?: string;
  reference?: string;
};

/**
 * The shape `compensateTransfer` is handed. `dstPrev`/`dstNew` describe the
 * destination leg and are absent when there is nothing to undo there — a
 * destination credit that failed has no post-write quantity, which is how this
 * function knows to compensate the source alone. Only `_id` is ever read off
 * `srcPrev`/`dstPrev`, so those are typed as the one field the rollback anchors
 * on rather than as a whole document.
 */
type TransferCompensation = {
  businessId: IdLike;
  productId: IdLike;
  toLocationId: IdLike;
  quantity: number;
  srcPrev: { _id: unknown };
  srcNew: number;
  dstPrev?: { _id: unknown } | null;
  dstNew?: number;
  label: string;
};

/**
 * The product fields `pickProductRef` reads. Structural rather than the `Product`
 * document type because this is also handed a raw `$lookup` result from
 * `listRows`, which is a plain BSON document rather than a hydrated model. The
 * identifier fields are narrowed where they are read; everything else is copied
 * through untouched, so it is typed as the value the document actually holds.
 */
type ProductRefSource = {
  _id?: unknown;
  id?: unknown;
  name?: unknown;
  sku?: unknown;
  barcode?: unknown;
  unit?: unknown;
  status?: unknown;
  minimumStock?: number;
  sellingPrice?: unknown;
  currency?: unknown;
};

/** The public product reference. `minimumStock` is defaulted, so it is a number. */
type ProductRef = {
  id: string;
  name: unknown;
  sku: unknown;
  barcode: unknown;
  unit: unknown;
  status: unknown;
  minimumStock: number;
  // AI-58 — the recorded price travels with the row. Without it a stock question that
  // needs a value ("what is this shelf worth?") gave the assistant no grounded figure
  // and it invented one: measured on the device 2026-11-05, where rows whose recorded
  // price was PHP 139,995 were reported as PHP 45,000. Null means never recorded, which
  // is the answer the assistant must give rather than a number it makes up.
  sellingPrice: unknown;
  currency: unknown;
};

type LocationRefSource = { _id?: unknown; id?: unknown; name?: unknown };

type LocationRef = { id: string; name: unknown };

/**
 * The inventory row shapes `inventoryRowPublic` accepts: an aggregation row from
 * `listRows` (nested `product`/`location` objects) or a populated Mongoose doc
 * from `getRow`.
 *
 * The reference fields are `unknown` rather than a declared document type
 * because Mongoose types a populated field as the raw `ObjectId` it replaced, so
 * at the type level `getRow`'s `productId` is an ObjectId even though at runtime
 * it is the whole product. The untyped code read `_id` off it either way, so the
 * read is narrowed at the one place it happens instead of asserting a shape the
 * compiler cannot confirm.
 */
type InventoryRowSource = {
  _id: unknown;
  businessId: unknown;
  quantity?: number;
  reservedQuantity?: number;
  availableQuantity?: number;
  updatedAt?: unknown;
  product?: unknown;
  productId?: unknown;
  location?: unknown;
  locationId?: unknown;
};

/** A reference field that has been populated: the referenced document, with `_id`. */
type PopulatedRef = { _id?: unknown };

/** The transaction fields `transactionPublic` reads off a ledger document. */
type TransactionSource = {
  _id: unknown;
  businessId: unknown;
  productId: unknown;
  locationId: unknown;
  userId: unknown;
  type?: unknown;
  quantity?: unknown;
  previousQuantity?: unknown;
  newQuantity?: unknown;
  reason?: unknown;
  reference?: unknown;
  createdAt?: unknown;
};

function isDuplicateKey(err: unknown) {
  // `err?.code === 11000`, narrowed. The optional access reproduces the original
  // short-circuit, so a thrown `null`/`undefined`/primitive still compares
  // unequal rather than raising.
  return (err as { code?: unknown } | null | undefined)?.code === 11000;
}

function pickProductRef(p: unknown): ProductRef | null {
  if (!p) return null;
  const { _id, id, name, sku, barcode, unit, status, minimumStock, sellingPrice, currency } =
    p as ProductRefSource;
  return {
    id: String(_id ?? id),
    name,
    sku: sku ?? null,
    barcode: barcode ?? null,
    unit: unit ?? null,
    status,
    minimumStock: minimumStock ?? 0,
    // Only a finite number is a price. A NaN/Infinity or a numeric string is not one the
    // assistant can quote, so it is reported as never recorded rather than passed through.
    sellingPrice: typeof sellingPrice === 'number' && Number.isFinite(sellingPrice) ? sellingPrice : null,
    // A whitespace-only currency would render as an empty label beside a price.
    currency: typeof currency === 'string' && currency.trim() !== '' ? currency : null,
  };
}

function pickLocationRef(l: unknown): LocationRef | null {
  if (!l) return null;
  const { _id, id, name } = l as LocationRefSource;
  return { id: String(_id ?? id), name };
}

/**
 * Public shape for an inventory row. Accepts either an aggregation doc with
 * nested `product`/`location` objects or a populated Mongoose doc (productId/
 * locationId populated). Stock-status flags follow SYSTEM_SPECIFICATION.md §19.
 */
export function inventoryRowPublic(row: InventoryRowSource) {
  const product =
    row.product != null
      ? pickProductRef(row.product)
      : (row.productId as PopulatedRef | null | undefined)?._id
        ? pickProductRef(row.productId)
        : null;
  const location =
    row.location != null
      ? pickLocationRef(row.location)
      : (row.locationId as PopulatedRef | null | undefined)?._id
        ? pickLocationRef(row.locationId)
        : null;
  const quantity = row.quantity ?? 0;
  const reservedQuantity = row.reservedQuantity ?? 0;
  const availableQuantity = row.availableQuantity ?? quantity - reservedQuantity;
  return {
    id: String(row._id),
    businessId: String(row.businessId),
    product,
    location,
    quantity,
    reservedQuantity,
    availableQuantity,
    isLowStock: product ? availableQuantity <= product.minimumStock : false,
    isOutOfStock: availableQuantity <= 0,
    updatedAt: row.updatedAt,
  };
}

/** Safe API/DTO shape for an inventory transaction record. */
export function transactionPublic(txn: TransactionSource) {
  return {
    id: String(txn._id),
    businessId: String(txn.businessId),
    productId: String(txn.productId),
    locationId: String(txn.locationId),
    type: txn.type,
    quantity: txn.quantity,
    previousQuantity: txn.previousQuantity,
    newQuantity: txn.newQuantity,
    reason: txn.reason ?? undefined,
    reference: txn.reference ?? undefined,
    userId: String(txn.userId),
    createdAt: txn.createdAt,
  };
}

/**
 * Makes a stock movement durable by creating the inventory transaction and the
 * audit log. Runs only AFTER the inventory quantity was updated atomically.
 *
 * The InventoryTransaction is the authoritative, durable record of the change.
 * Once it is written the movement must stand: an audit-logging failure is
 * therefore logged and swallowed, never propagated — surfacing it would make
 * the caller compensate an already-durable change and orphan the transaction
 * (Phase 07A / H3). The only failure that propagates is
 * InventoryTransaction.create itself, i.e. no transaction row was created by
 * this call, which is exactly the safe point for the caller to compensate.
 */
async function recordMovement({
  businessId,
  userId,
  productId,
  locationId,
  type,
  quantity,
  previousQuantity,
  newQuantity,
  reason,
  reference,
}: MovementRecord) {
  const txn = await InventoryTransaction.create({
    businessId,
    productId,
    locationId,
    type,
    quantity,
    previousQuantity,
    newQuantity,
    reason: reason || undefined,
    reference: reference || undefined,
    userId,
  });
  try {
    await recordAudit({
      businessId,
      userId,
      action: AUDIT_ACTION_BY_TYPE[type],
      entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
      entityId: txn._id,
      metadata: {
        productId: String(productId),
        locationId: String(locationId),
        // Link the audit row to the exact transaction so a compensation can
        // delete precisely the audit it caused (Phase 13C receiving undo).
        inventoryTransactionId: String(txn._id),
        type,
        quantity,
        previousQuantity,
        newQuantity,
      },
    });
  } catch (err) {
    // `${err.message}`, narrowed: a caught value is `unknown`, and the template
    // stringifies it exactly as the untyped code did. `String()` is what the
    // interpolation itself would have produced, for every value.
    console.error(
      `[inventory] audit record failed for ${type} transaction ${String(txn._id)} (movement preserved): ${String((err as { message?: unknown }).message)}`
    );
  }
  return txn;
}

/**
 * Concurrency-safe compensation for an inventory change whose transaction
 * record could not be persisted (SYSTEM_SPECIFICATION.md §16 — the inventory
 * must never move without its transaction). Reverts ONLY the quantity this
 * operation wrote, and ONLY while the row is still exactly at that quantity
 * (`filter` must anchor on the current quantity this operation produced). If a
 * concurrent movement has already committed a newer quantity, the update
 * matches nothing and the rollback no-ops — it never blindly overwrites a newer
 * value (Phase 07A / H4). The rollback restores a previously legal,
 * non-negative quantity in a single atomic update, so it can never create a
 * negative quantity (Phase 07A / H5). Compensation failures are logged, never
 * masked, so the original error still reaches the caller.
 */
async function rollbackInventory(
  filter: Record<string, unknown>,
  operation: Record<string, unknown>,
  label: string
) {
  try {
    const res = await Inventory.updateOne(filter, operation);
    if (res.modifiedCount !== 1) {
      console.error(`[inventory] ${label}: rollback skipped (row no longer at the written quantity)`);
    }
  } catch (err) {
    // `err.message`, narrowed. The raw value is passed through exactly as
    // before, so `console.error` still receives whatever the caught value held.
    console.error(`[inventory] ${label}: rollback failed:`, (err as { message?: unknown }).message);
  }
}

/**
 * Compensation for a first stock-in whose row this operation created (upsert).
 * Deletes the row instead of decrementing it, and only while the row is still
 * exactly as this operation left it (quantity + reservedQuantity anchored), so
 * a failed first stock-in can never leave a zero-quantity orphan row (Phase 07A
 * / L5) and a concurrent movement that built on the new row is never removed.
 * Best-effort like rollbackInventory.
 */
async function rollbackCreatedRow(
  businessId: IdLike,
  productId: IdLike,
  locationId: IdLike,
  quantity: number,
  label: string
) {
  try {
    const res = await Inventory.deleteOne({
      businessId,
      productId,
      locationId,
      quantity,
      reservedQuantity: 0,
    });
    if (res.deletedCount !== 1) {
      console.error(`[inventory] ${label}: created-row rollback skipped (row no longer at quantity ${quantity})`);
    }
  } catch (err) {
    console.error(`[inventory] ${label}: created-row rollback failed:`, (err as { message?: unknown }).message);
  }
}

/**
 * Compensation for a failed transfer (Phase 19). Undoes whichever inventory legs
 * already landed, DESTINATION FIRST and then the SOURCE — the reverse of the
 * order they were applied — because the source debit is what the guard proved
 * was affordable.
 *
 * Every rollback is anchored on the exact quantity this transfer wrote, so a
 * concurrent movement landing in the window makes the rollback a no-op instead
 * of clobbering a newer value (Phase 07A / H4), and a compensated debit can
 * never drive the source negative (Phase 07A / H5). Best-effort throughout:
 * every failure is logged, never masked, so the original error still surfaces.
 *
 * A leg is only touched when its post-write quantity was supplied, which is how
 * a destination-credit failure compensates just the source.
 */
async function compensateTransfer({
  businessId,
  productId,
  toLocationId,
  quantity,
  srcPrev,
  srcNew,
  dstPrev,
  dstNew,
  label,
}: TransferCompensation) {
  if (dstNew !== undefined) {
    if (dstPrev == null) {
      // This transfer created the destination row (upsert insert) — delete it
      // rather than decrementing it to zero and leaving an orphan (L5).
      await rollbackCreatedRow(oid(businessId), oid(productId), oid(toLocationId), dstNew, `${label} destination`);
    } else {
      await rollbackInventory(
        { _id: dstPrev._id, quantity: dstNew },
        { $inc: { quantity: -quantity } },
        `${label} destination`
      );
    }
  }
  if (srcNew !== undefined) {
    await rollbackInventory(
      { _id: srcPrev._id, quantity: srcNew },
      { $inc: { quantity } },
      `${label} source`
    );
  }
}

/**
 * Inventory core service. Every operation is scoped by the server-derived
 * businessId. Quantity changes are single-document atomic updates with
 * conditional guards (no read/modify/save races, no multi-document transaction
 * required), then recorded as an InventoryTransaction + AuditLog.
 */
export const inventoryService = {
  /** Product must exist in the business and not be archived. */
  async assertOperationalProduct(businessId: IdLike, productId: IdLike) {
    const product = await Product.findOne({ _id: oid(productId), businessId: oid(businessId) }).lean();
    if (!product) throw new ApiError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    if (product.status === 'ARCHIVED') {
      throw new ApiError(409, 'Archived products cannot be used in stock movements', 'PRODUCT_ARCHIVED');
    }
    return product;
  },

  /** Location must exist in the business and not be archived. */
  async assertOperationalLocation(businessId: IdLike, locationId: IdLike) {
    const location = await Location.findOne({ _id: oid(locationId), businessId: oid(businessId) }).lean();
    if (!location) throw new ApiError(404, 'Location not found', 'LOCATION_NOT_FOUND');
    if (location.status === 'ARCHIVED') {
      throw new ApiError(409, 'Archived locations cannot be used in stock movements', 'LOCATION_ARCHIVED');
    }
    return location;
  },

  /**
   * Increase on-hand quantity at a product+location. Creates the inventory row
   * on first stock-in (upsert). Atomic; retried once if a concurrent upsert
   * races the unique (businessId, productId, locationId) index.
   */
  async stockIn(businessId: IdLike, userId: IdLike, { productId, locationId, quantity, reason, reference }: MovementInput) {
    await this.assertOperationalProduct(businessId, productId);
    await this.assertOperationalLocation(businessId, locationId);

    const filter = { businessId: oid(businessId), productId: oid(productId), locationId: oid(locationId) };
    const inc = { $inc: { quantity } };

    let prev;
    try {
      prev = await Inventory.findOneAndUpdate(filter, inc, {
        returnDocument: 'before',
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Another stock-in created the row between our assert and this upsert.
      prev = await Inventory.findOneAndUpdate(filter, inc, { returnDocument: 'before', runValidators: true });
    }

    const previousQuantity = prev?.quantity ?? 0;
    const newQuantity = previousQuantity + quantity;

    try {
      const txn = await recordMovement({
        businessId,
        userId,
        productId,
        locationId,
        type: 'STOCK_IN',
        quantity,
        previousQuantity,
        newQuantity,
        reason,
        reference,
      });
      return {
        transaction: transactionPublic(txn),
        previousQuantity,
        newQuantity,
        // True when this stock-in created the inventory row (upsert inserted a
        // new row). Lets a caller that must undo this movement choose between
        // deleting the freshly created row and reverting a pre-existing one.
        createdRow: prev == null,
      };
    } catch (err) {
      if (prev == null) {
        // This stock-in created the row (first stock-in, upsert inserted it).
        // Compensate by deleting the freshly created row — never by decrementing
        // it to zero and leaving an orphan row (L5). The delete is anchored on
        // the exact quantity we wrote so a concurrent movement that built on
        // the new row is preserved.
        await rollbackCreatedRow(filter.businessId, filter.productId, filter.locationId, newQuantity, 'stock-in');
      } else {
        // Existing row: revert only while it is still exactly at the quantity
        // this operation produced; a concurrent movement makes it a no-op.
        await rollbackInventory(
          { _id: prev._id, quantity: newQuantity },
          { $inc: { quantity: -quantity } },
          'stock-in'
        );
      }
      throw err;
    }
  },

  /**
   * Decrease on-hand quantity. The conditional guard (available >= quantity)
   * is evaluated atomically with the decrement, so concurrent stock-outs can
   * never drive available below zero. Missing row vs insufficient stock are
   * distinguished with a follow-up read when the guard rejects the update.
   */
  async stockOut(businessId: IdLike, userId: IdLike, { productId, locationId, quantity, reason, reference }: MovementInput) {
    await this.assertOperationalProduct(businessId, productId);
    await this.assertOperationalLocation(businessId, locationId);

    const filter = {
      businessId: oid(businessId),
      productId: oid(productId),
      locationId: oid(locationId),
      $expr: { $gte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, quantity] },
    };

    const prev = await Inventory.findOneAndUpdate(filter, { $inc: { quantity: -quantity } }, { returnDocument: 'before' });
    if (!prev) {
      const row = await Inventory.findOne({
        businessId: oid(businessId),
        productId: oid(productId),
        locationId: oid(locationId),
      });
      if (!row) {
        throw new ApiError(404, 'No inventory exists for this product at this location', 'INVENTORY_NOT_FOUND');
      }
      throw new ApiError(409, 'Insufficient available stock', 'INSUFFICIENT_STOCK');
    }

    const previousQuantity = prev.quantity;
    const newQuantity = previousQuantity - quantity;

    try {
      const txn = await recordMovement({
        businessId,
        userId,
        productId,
        locationId,
        type: 'STOCK_OUT',
        quantity,
        previousQuantity,
        newQuantity,
        reason,
        reference,
      });
      return { transaction: transactionPublic(txn), previousQuantity, newQuantity };
    } catch (err) {
      // Revert only while the row is still exactly at the quantity this
      // stock-out produced; a concurrent movement makes it a no-op.
      await rollbackInventory(
        { _id: prev._id, quantity: newQuantity },
        { $inc: { quantity } },
        'stock-out'
      );
      throw err;
    }
  },

  /**
   * Move stock of one product between two locations of the same business
   * (Phase 19).
   *
   * A transfer is TWO inventory legs that must move together:
   *   1. DEBIT the source with the same atomic availability guard stockOut uses,
   *      so the source can never go negative and two concurrent transfers can
   *      never spend the same units twice.
   *   2. CREDIT the destination with the same upsert stockIn uses, retried once
   *      on a duplicate-key race, creating the row on first arrival.
   *
   * Only once both legs have landed are the ledger rows written — one TRANSFER
   * row per leg, correlated by `reference` — followed by a single
   * INVENTORY_TRANSFERRED audit event. The ordering is the guarantee: the
   * destination is never credited unless the source leg already succeeded, and
   * any failure after the debit compensates it, so stock can be neither lost nor
   * duplicated. Cross-business access is impossible because every filter carries
   * the caller's businessId; no client-supplied businessId is ever read.
   *
   * No multi-document transaction is used: this follows the repository's
   * single-document-guard + quantity-anchored-compensation architecture
   * (Phase 07A), which the H3/H4/H5/L5 suites already pin down.
   */
  async transfer(
    businessId: IdLike,
    userId: IdLike,
    { productId, fromLocationId, toLocationId, quantity, reason, reference }: TransferInput
  ) {
    if (String(fromLocationId) === String(toLocationId)) {
      throw new ApiError(409, 'Source and destination must be different locations', 'TRANSFER_SAME_LOCATION');
    }

    await this.assertOperationalProduct(businessId, productId);
    await this.assertOperationalLocation(businessId, fromLocationId);
    await this.assertOperationalLocation(businessId, toLocationId);

    const bizOid = oid(businessId);
    const prodOid = oid(productId);
    const fromOid = oid(fromLocationId);
    const toOid = oid(toLocationId);
    // Correlates the two ledger rows (and the audit) as one transfer.
    const transferRef = reference || `TRF-${new ObjectId().toString()}`;

    // Leg 1 — debit the source. The guard is evaluated atomically with the
    // decrement, so concurrent transfers/stock-outs can never overspend.
    const srcPrev = await Inventory.findOneAndUpdate(
      {
        businessId: bizOid,
        productId: prodOid,
        locationId: fromOid,
        $expr: { $gte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, quantity] },
      },
      { $inc: { quantity: -quantity } },
      { returnDocument: 'before' }
    );
    if (!srcPrev) {
      const row = await Inventory.findOne({ businessId: bizOid, productId: prodOid, locationId: fromOid });
      if (!row) {
        throw new ApiError(
          404,
          'No inventory exists for this product at the source location',
          'INVENTORY_NOT_FOUND'
        );
      }
      throw new ApiError(409, 'Insufficient available stock at the source location', 'INSUFFICIENT_STOCK');
    }
    const srcNew = srcPrev.quantity - quantity;

    // Leg 2 — credit the destination (created on first arrival).
    const dstFilter = { businessId: bizOid, productId: prodOid, locationId: toOid };
    const dstInc = { $inc: { quantity } };
    let dstPrev;
    try {
      dstPrev = await Inventory.findOneAndUpdate(dstFilter, dstInc, {
        returnDocument: 'before',
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) {
        // The debit already landed — put it back before surfacing.
        await compensateTransfer({
          businessId,
          productId,
          toLocationId,
          quantity,
          srcPrev,
          srcNew,
          label: 'transfer (destination write failed)',
        });
        throw err;
      }
      // Another movement created the row between our read and this upsert.
      dstPrev = await Inventory.findOneAndUpdate(dstFilter, dstInc, {
        returnDocument: 'before',
        runValidators: true,
      });
    }

    const dstPrevQty = dstPrev?.quantity ?? 0;
    const dstNew = dstPrevQty + quantity;

    // Ledger — one TRANSFER row per leg, then ONE audit event for the transfer
    // as a whole. The rows are created directly rather than through
    // recordMovement, which writes one audit per row by design; a transfer is a
    // single business event and must not appear as two.
    const created = [];
    try {
      for (const leg of [
        { locationId: fromOid, previousQuantity: srcPrev.quantity, newQuantity: srcNew },
        { locationId: toOid, previousQuantity: dstPrevQty, newQuantity: dstNew },
      ]) {
        created.push(
          await InventoryTransaction.create({
            businessId: bizOid,
            productId: prodOid,
            locationId: leg.locationId,
            type: 'TRANSFER',
            quantity,
            previousQuantity: leg.previousQuantity,
            newQuantity: leg.newQuantity,
            reason: reason || undefined,
            reference: transferRef,
            userId,
          })
        );
      }
    } catch (err) {
      // The ledger is all-or-nothing: a transfer with one leg recorded is not a
      // transfer. Drop any row already written (Phase 13C undo idiom), then undo
      // both inventory legs so the attempt leaves no trace.
      for (const row of created) {
        try {
          await InventoryTransaction.deleteOne({ _id: row._id, businessId: bizOid });
        } catch (cleanupErr) {
          console.error(
            `[inventory] transfer: ledger cleanup failed for txn ${String(row._id)}:`,
            (cleanupErr as { message?: unknown }).message
          );
        }
      }
      await compensateTransfer({
        businessId,
        productId,
        toLocationId,
        quantity,
        srcPrev,
        srcNew,
        dstPrev,
        dstNew,
        label: 'transfer (ledger write failed)',
      });
      throw err;
    }

    // Once both ledger rows are durable the transfer stands, so an audit failure
    // is logged and swallowed — never compensated away (Phase 07A / H3).
    try {
      await recordAudit({
        businessId,
        userId,
        action: AUDIT_ACTIONS.INVENTORY_TRANSFERRED,
        entityType: AUDIT_ENTITY_TYPES.INVENTORY_TRANSACTION,
        // Both ledger rows were pushed above, or the catch threw — so `created`
        // holds exactly two here.
        entityId: created[0]!._id,
        metadata: {
          productId: String(productId),
          fromLocationId: String(fromLocationId),
          toLocationId: String(toLocationId),
          // Both ledger rows, so a future compensation can find the whole pair.
          inventoryTransactionIds: created.map((r) => String(r._id)),
          reference: transferRef,
          type: 'TRANSFER',
          quantity,
          fromPreviousQuantity: srcPrev.quantity,
          fromNewQuantity: srcNew,
          toPreviousQuantity: dstPrevQty,
          toNewQuantity: dstNew,
        },
      });
    } catch (err) {
      console.error(
        `[inventory] audit record failed for TRANSFER ${transferRef} (movement preserved): ${String((err as { message?: unknown }).message)}`
      );
    }

    return {
      transaction: transactionPublic(created[0]!),
      destinationTransaction: transactionPublic(created[1]!),
      reference: transferRef,
      previousQuantity: srcPrev.quantity,
      newQuantity: srcNew,
      destinationPreviousQuantity: dstPrevQty,
      destinationNewQuantity: dstNew,
    };
  },

  /**
   * Set on-hand quantity to an absolute target. The stored transaction delta is
   * the magnitude of the change; an adjustment to the current quantity is a 409
   * NO_CHANGE (no zero-quantity transaction is ever created). The update is
   * guarded so the resulting available quantity can never be negative.
   */
  async adjust(businessId: IdLike, userId: IdLike, { productId, locationId, quantity: target, reason, reference }: MovementInput) {
    await this.assertOperationalProduct(businessId, productId);
    await this.assertOperationalLocation(businessId, locationId);

    const base = { businessId: oid(businessId), productId: oid(productId), locationId: oid(locationId) };
    const guard = {
      $and: [{ $ne: ['$quantity', target] }, { $gte: [target, '$reservedQuantity'] }],
    };

    let prev = await Inventory.findOneAndUpdate({ ...base, $expr: guard }, { $set: { quantity: target } }, { returnDocument: 'before' });
    if (!prev) {
      const row = await Inventory.findOne(base);
      if (!row) {
        throw new ApiError(404, 'No inventory exists for this product at this location', 'INVENTORY_NOT_FOUND');
      }
      if (row.quantity === target) {
        throw new ApiError(409, 'Inventory is already at the requested quantity', 'NO_CHANGE');
      }
      if (target < row.reservedQuantity) {
        throw new ApiError(409, 'Target quantity is below the reserved quantity', 'ADJUSTMENT_BELOW_RESERVED');
      }
      // A concurrent operation finished between our attempt and this read; the
      // guard now passes, so apply the change once more.
      prev = await Inventory.findOneAndUpdate({ _id: row._id, $expr: guard }, { $set: { quantity: target } }, { returnDocument: 'before' });
      if (!prev) {
        throw new ApiError(409, 'Inventory changed concurrently; retry the adjustment', 'ADJUSTMENT_CONFLICT');
      }
    }

    const previousQuantity = prev.quantity;
    const delta = Math.abs(target - previousQuantity); // >= 1: equality was rejected above

    try {
      const txn = await recordMovement({
        businessId,
        userId,
        productId,
        locationId,
        type: 'ADJUSTMENT',
        quantity: delta,
        previousQuantity,
        newQuantity: target,
        reason,
        reference,
      });
      return { transaction: transactionPublic(txn), previousQuantity, newQuantity: target };
    } catch (err) {
      // Revert only while the row is still exactly at the target quantity this
      // adjustment wrote; a concurrent movement makes it a no-op.
      await rollbackInventory(
        { _id: prev._id, quantity: target },
        { $set: { quantity: previousQuantity } },
        'adjust'
      );
      throw err;
    }
  },

  /** A single inventory row by its row id, scoped to the business. */
  async getRow(businessId: IdLike, id: IdLike) {
    const doc = await Inventory.findOne({ _id: oid(id), businessId: oid(businessId) })
      .populate('productId')
      .populate('locationId');
    if (!doc) throw new ApiError(404, 'Inventory record not found', 'INVENTORY_NOT_FOUND');
    return inventoryRowPublic(doc);
  },

  /**
   * Inventory rows for the business with optional product/location filters.
   * `q` searches product name/sku/barcode; `status` filters product status;
   * `lowStock`/`outOfStock` filter rows by per-row available quantity (per
   * §19: low = available <= minimumStock, out = available <= 0).
   *
   * TWO SHAPES, chosen by whether the request filters on the JOINED PRODUCT. Both
   * are business-scoped at every stage and return the same DTO; only the position
   * of the page window differs.
   */
  async listRows(businessId: IdLike, { productId, locationId, q, status, lowStock, outOfStock, skip, limit }: InventoryListFilters) {
    const bizOid = oid(businessId);
    // A MongoDB filter document whose keys are added conditionally below, so it
    // is a record rather than the single-key object literal it is seeded with.
    const match: Record<string, unknown> = { businessId: bizOid };
    if (productId) match.productId = oid(productId);
    if (locationId) match.locationId = oid(locationId);

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /**
     * The product document the row DTO carries, scoped to the business.
     *
     * THE LOOKUP IS THE SIMPLE FORM, AND THAT IS A MEASUREMENT (§27DE). These two lookups
     * used to be `$lookup` pipelines matched with `$expr` against the row's id, which is
     * correct and **~9x slower per row** than `localField`/`foreignField`: measured on the
     * 50 000-product tenant (100 143 inventory rows), a full scan of the partition cost
     * **19 965 ms** with the `$expr` form and **2 166 ms** with the simple form, same rows
     * in the same order. The `$expr` form cannot use the equivalent of a batched index
     * join, and the cost is per row, so it multiplied exactly where it hurt.
     *
     * TENANT ISOLATION IS PRESERVED, IN A DIFFERENT PLACE. The simple form resolves a
     * document by `_id` alone, so a row that referenced another business's product would
     * resolve it — the filter below drops any joined document whose `businessId` is not
     * this business, before the row is unwound or returned. Every row is already scoped by
     * `businessId` in `$match`, so this is defence in depth for a reference the application
     * cannot create, and it keeps the old guarantee exactly: a foreign document never
     * reaches a DTO.
     */
    const productLookup: PipelineStage = {
      $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' },
    };
    const productTenantGuard: PipelineStage = {
      $addFields: {
        product: { $filter: { input: '$product', cond: { $eq: ['$$this.businessId', bizOid] } } },
      },
    };

    /**
     * The row's own availability, `quantity - reservedQuantity` (§19). It exists as an
     * expression, not only as {@link availableField}, because the row-local `outOfStock`
     * predicate has to be evaluable BEFORE the page window and before the product join
     * (§27DF) — the same arithmetic, in the two positions it is needed.
     */
    const rowAvailableExpr = {
      $subtract: [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$reservedQuantity', 0] }],
    };

    /** availableQuantity = quantity - reservedQuantity, as §19 defines it. */
    const availableField: PipelineStage = {
      $addFields: { availableQuantity: rowAvailableExpr },
    };

    /** The location document the row DTO carries, scoped to the business — same shape and
     *  same tenant guard as {@link productLookup}, for the same measured reason. */
    const locationLookup: PipelineStage = {
      $lookup: { from: 'locations', localField: 'locationId', foreignField: '_id', as: 'location' },
    };
    const locationTenantGuard: PipelineStage = {
      $addFields: {
        location: { $filter: { input: '$location', cond: { $eq: ['$$this.businessId', bizOid] } } },
      },
    };
    const locationUnwind: PipelineStage = { $unwind: { path: '$location', preserveNullAndEmptyArrays: true } };

    /**
     * A product-dependent filter cannot be evaluated from the inventory row alone,
     * so the product join has to happen BEFORE the page window for these requests —
     * which is the slow shape, kept deliberately and covered by the comment on the
     * fast path below.
     *
     * `outOfStock` IS NOT ONE OF THEM (§27DF). Its predicate is `available <= 0`, read
     * from the row's own `quantity`/`reservedQuantity`; no product field participates. It
     * was routed here only because it sits beside `lowStock` in the same request, and the
     * join is what a partition-sized scan pays for: measured on the 131 000-product tenant
     * (261 918 inventory rows), the product join costs ~55 µs PER ROW, so using it to
     * evaluate a row-local predicate made a 15-row page cost **5.4 s**; the identical
     * predicate with no join is ~0.45 s and lands on the fast path below.
     */
    const productOnlyFilters = Boolean(q) || status === 'ACTIVE' || status === 'ARCHIVED';
    const filtersOnProduct = productOnlyFilters || Boolean(lowStock);
    /** `outOfStock` alone: row-local, so the page window stays above every join. */
    const rowLocalOutOfStock = Boolean(outOfStock) && !filtersOnProduct;

    if (!filtersOnProduct) {
      // THE FAST PATH: page first, join the page.
      //
      // Measured 2026-10-13 on a synthetic 10 000-product tenant (20 105 inventory
      // rows): the joins below used to run once per TENANT ROW — `explain` showed
      // nReturned=20105 at the product join (+3.1 s) and again (+3.2 s) at the
      // location join — to produce a 25-row page, because the `$skip`/`$limit` sat at
      // the very bottom inside a `$facet`, and a facet cannot run without everything
      // above it running first. Each individual join is an index lookup; the COUNT of
      // them is the cost. Selecting the page first makes this query O(page) and the
      // same call now costs ~0.2 s.
      //
      // `{ updatedAt: -1, _id: -1 }` is a total order (the `_id` tiebreaker is why a
      // transfer's two legs, written in one millisecond, still page stably), so the
      // first `limit` rows of the sorted stream are exactly the rows the facet used to
      // pick, and the order is index-provided by the inventory model's
      // `{ businessId: 1, updatedAt: -1, _id: -1 }` index.
      //
      // The `product.0` existence filter moves BELOW the window, which changes one
      // thing only for data the application cannot produce: an inventory row whose
      // product is missing is now dropped from the page rather than from the total.
      // Products are archive-only and never hard-deleted (§4), so no such row exists
      // in an application-written database; the filter is retained as read-path
      // hygiene, and the total counts the rows the query scoped, not the rows a join
      // happened to resolve.
      // The scope this page and its count share. It is exactly `[$match]` for an
      // unfiltered request — the shape this path has always had — and gains ONE row-local
      // `$match` when the request asked for `outOfStock` (§27DF): the predicate reads only
      // the row, so applying it above the window is both correct and free of joins, and the
      // count runs over the same scope so the total and the page cannot disagree.
      const scope: PipelineStage[] = [{ $match: match }];
      if (rowLocalOutOfStock) scope.push({ $match: { $expr: { $lte: [rowAvailableExpr, 0] } } });

      const pipeline: PipelineStage[] = [
        ...scope,
        { $sort: { updatedAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        productLookup,
        productTenantGuard,
        { $match: { 'product.0': { $exists: true } } },
        { $unwind: '$product' },
        availableField,
        locationLookup,
        locationTenantGuard,
        locationUnwind,
      ];

      // The count is a separate aggregation over the SAME scope, run in parallel
      // with the page: `$count` on this indexed match never touches a document.
      // `allowDiskUse` on the page only, and only as the backstop it is elsewhere: an
      // unfiltered request sorts by index and never spills, while the row-local `outOfStock`
      // predicate above the window makes the sort re-order whatever survives it, which is a
      // set MongoDB sizes in memory.
      const [rows, counted] = await Promise.all([
        Inventory.aggregate(pipeline, { allowDiskUse: true }),
        Inventory.aggregate([...scope, { $count: 'total' }]),
      ]);
      return {
        items: rows.map((row) => inventoryRowPublic(row)),
        total: counted[0]?.total ?? 0,
      };
    }

    // THE PRODUCT-FIRST PATH: the filter is on the PRODUCT's own fields (`q` against its
    // name/sku/barcode, `status` against its status), so the matching products are resolved
    // in ONE query and the page is then an index read over `productId`, joined only for the
    // rows actually returned.
    //
    // WHY (measured 2026-10-18, §27DD). This branch used to run the product `$lookup` once per
    // INVENTORY row before the page window. On a 50 000-product tenant (100 143 inventory rows)
    // that cost **14 795–28 950 ms** for a 25-row page, through the service the Inventory screen
    // itself calls and through the assistant's `getInventory` tool — the 499-row `q`
    // "Professional Towel" case proved the cost was the partition, not the result. The same four
    // shapes now cost **546–1 063 ms**, with **identical rows, order and totals** (checked against
    // the old path on every shape, and against `perf:golden` before/after).
    //
    // THE ORDER IS THE SAME ORDER. `{ updatedAt: -1, _id: -1 }` is applied before `$skip`/`$limit`
    // exactly as it was, so a page boundary lands on the same row; the `$in` only narrows which
    // rows can appear in it. `lowStock` is deliberately NOT on this path: it compares a row's
    // availability with its PRODUCT's `minimumStock`, a per-row joined value, so it keeps the
    // shape below rather than pretending to be a product-only filter. `outOfStock` is not on
    // this path either, and for the opposite reason — it needs no product at all, so it rides
    // the fast path above with one row-local predicate (§27DF).
    if (!lowStock) {
      const productFilter: Record<string, unknown> = { businessId: bizOid };
      if (status === 'ACTIVE' || status === 'ARCHIVED') productFilter.status = status;
      if (q) {
        const re = { $regex: escapeRegExp(q), $options: 'i' };
        productFilter.$or = [{ name: re }, { sku: re }, { barcode: re }];
      }
      const productIds = await Product.find(productFilter).select('_id').lean();
      if (productIds.length === 0) return { items: [], total: 0 };

      const scoped: Record<string, unknown> = { ...match, productId: { $in: productIds.map((p) => p._id) } };
      const [rows, counted] = await Promise.all([
        Inventory.aggregate([
          { $match: scoped },
          { $sort: { updatedAt: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          productLookup,
          productTenantGuard,
          { $match: { 'product.0': { $exists: true } } },
          { $unwind: '$product' },
          availableField,
          locationLookup,
          locationTenantGuard,
          locationUnwind,
        ]),
        // The same scope the page used: rows whose product matched. A separate `$count` over an
        // indexed match, so the total does not pay for the page's joins.
        Inventory.countDocuments(scoped),
      ]);
      return { items: rows.map((row) => inventoryRowPublic(row)), total: counted };
    }

    // THE FILTERED PATH: the join runs above the window because the filter needs the
    // joined product (`q` against its name/sku/barcode, `status` against its status,
    // `lowStock` against its `minimumStock`). Output shape and total are exactly what
    // this method has always returned.
    //
    // `lowStock` gets a row-local pre-filter ABOVE the join, read from the products
    // themselves (§27DF): the predicate is `available <= minimumStock`, so a row whose own
    // availability exceeds the LARGEST `minimumStock` in the business cannot satisfy it for
    // any product and need not be joined at all. That is exact rather than a heuristic — the
    // maximum is a property of the stored data, not a schema assumption, and a product with
    // no `minimumStock` never satisfies the `$lte` comparison either way. On the
    // 131 000-product tenant it keeps 147 225 of 261 918 rows out of the join.
    const pipeline: PipelineStage[] = [{ $match: match }];

    if (lowStock) {
      const [threshold] = await Product.aggregate(
        [
          { $match: { businessId: bizOid } },
          { $group: { _id: null, max: { $max: '$minimumStock' } } },
        ],
        { allowDiskUse: true }
      );
      const maxMinimumStock = threshold?.max;
      if (typeof maxMinimumStock === 'number') {
        pipeline.push({ $match: { $expr: { $lte: [rowAvailableExpr, maxMinimumStock] } } });
      }
    }

    pipeline.push(productLookup, productTenantGuard);

    const productMatch: Record<string, unknown> = { 'product.0': { $exists: true } };
    if (status === 'ACTIVE' || status === 'ARCHIVED') productMatch['product.status'] = status;
    if (q) {
      const re = { $regex: escapeRegExp(q), $options: 'i' };
      productMatch.$or = [{ 'product.name': re }, { 'product.sku': re }, { 'product.barcode': re }];
    }
    pipeline.push({ $match: productMatch });
    pipeline.push({ $unwind: '$product' });
    pipeline.push(availableField);
    if (outOfStock) pipeline.push({ $match: { $expr: { $lte: ['$availableQuantity', 0] } } });
    if (lowStock) pipeline.push({ $match: { $expr: { $lte: ['$availableQuantity', '$product.minimumStock'] } } });

    // The location join is BELOW the page window, inside the data branch, because it
    // cannot change the result set: it augments a row with the location document and
    // unwinds with `preserveNullAndEmptyArrays`, so it neither filters a row nor moves
    // it (§27DF). Running it above the window made it pay for every row the low/out
    // filter had just admitted — at 131 000 products that is the whole partition — while
    // only `limit` rows ever carry a location into a DTO. The count branch reads the
    // filtered stream independently, exactly as before, so the total is unchanged.
    pipeline.push({
      $facet: {
        metadata: [{ $count: 'total' }],
        // Most-recently-changed first. A transfer updates its two rows in the
        // same millisecond, so `_id` is what keeps an offset page boundary
        // inside that tie stable.
        data: [
          { $sort: { updatedAt: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          locationLookup,
          locationTenantGuard,
          locationUnwind,
        ],
      },
    });

    // `allowDiskUse` is the backstop for the one sort this path still runs above the page
    // window, and it is belt-and-braces rather than a fix: the low/out predicates are
    // evaluated with the row's own `availableQuantity` against its product's
    // `minimumStock`, so this scan is inherent to the semantics and the only lever left
    // is the sort's memory (§27DF).
    const [result] = await Inventory.aggregate(pipeline, { allowDiskUse: true });
    const items = (result?.data ?? []).map(inventoryRowPublic);
    const total = result?.metadata?.[0]?.total ?? 0;
    return { items, total };
  },

  /**
   * AI-23 — stock per location, as ONE read.
   *
   * WHY THIS IS A SERVICE METHOD RATHER THAN SOMETHING THE ASSISTANT COMPOSED. Before it,
   * "how many products are in each location?" had to be asked one location at a time, and the
   * member's own words do not name them — so the measured device turn spent a provider call
   * learning the names and then a call per location (3 calls / 29.3 s, §27DO). The shape that
   * answers the question in one round-trip is a per-location aggregate, and a read the
   * Inventory screen may also want belongs in the service, not in a tool.
   *
   * WHAT THE NUMBERS MEAN. `products` is the number of DISTINCT products with a row at that
   * location — a product held on two shelves is one product on each, which is why the
   * per-location counts deliberately sum to more than `totals.products`. `units` is the
   * on-hand quantity (`quantity`, not `quantity - reservedQuantity`), so it matches what the
   * location's own rows show.
   *
   * WHAT IS DELIBERATELY NOT FILTERED. Every location is returned, including one with no
   * stock (`0 / 0`) and one that is ARCHIVED — archiving retains its inventory (§Product
   * archive-only lifecycle), so hiding it would understate the business's stock and make
   * "which location is empty" unanswerable. A row whose location document no longer exists
   * would otherwise vanish from the report while still holding stock, so those are summed
   * into an `Unassigned` entry instead of being dropped quietly.
   */
  async locationBreakdown(businessId: string) {
    const bizOid = oid(businessId);

    // Two stages, both inside the database: collapse the ledger to one entry per
    // (location, product) pair, then answer both questions from that reduced set. The
    // `$facet` is what keeps `totals.products` honest — counting distinct products across
    // the business from the SAME reduced rows, rather than summing the per-location counts,
    // which deliberately double-count a product held in two places.
    const [result] = await Inventory.aggregate(
      [
        { $match: { businessId: bizOid } },
        {
          $group: {
            _id: { locationId: '$locationId', productId: '$productId' },
            units: { $sum: '$quantity' },
          },
        },
        {
          $facet: {
            perLocation: [
              { $group: { _id: '$_id.locationId', products: { $sum: 1 }, units: { $sum: '$units' } } },
            ],
            overall: [{ $group: { _id: '$_id.productId' } }, { $count: 'products' }],
          },
        },
      ],
      // The reduced set is one entry per (location, product), so a tenant far larger than
      // the engine's memory group limit is bounded by disk rather than by luck.
      { allowDiskUse: true }
    );

    const counted = new Map<string, { products: number; units: number }>();
    for (const row of result?.perLocation ?? []) {
      counted.set(String(row._id), { products: Number(row.products), units: Number(row.units) });
    }

    const locations = await Location.find({ businessId: bizOid }).select('name status').lean();
    const rows: {
      id: string | null;
      name: unknown;
      status: unknown;
      products: number;
      units: number;
    }[] = locations.map((loc) => {
      const key = String(loc._id);
      const own = counted.get(key) ?? { products: 0, units: 0 };
      // Removed as we go: whatever is left afterwards is stock whose location is gone.
      counted.delete(key);
      return { id: key, name: loc.name, status: loc.status, products: own.products, units: own.units };
    });

    const orphaned = [...counted.values()];
    if (orphaned.length > 0) {
      rows.push({
        id: null,
        name: 'Unassigned',
        status: null,
        products: orphaned.reduce((n, row) => n + row.products, 0),
        units: orphaned.reduce((n, row) => n + row.units, 0),
      });
    }

    // Biggest shelf first, then by name so the order of two equal locations is stable.
    rows.sort((a, b) => b.units - a.units || String(a.name).localeCompare(String(b.name)));

    return {
      locations: rows,
      totals: {
        products: Number(result?.overall?.[0]?.products ?? 0),
        units: rows.reduce((n, row) => n + row.units, 0),
      },
    };
  },
};

export default inventoryService;
