import crypto from 'node:crypto';
import mongoose from 'mongoose';

import PurchaseOrder from '../models/purchaseOrder.model.ts';
import Supplier from '../models/supplier.model.ts';
import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import AuditLog from '../models/auditLog.model.ts';
import { inventoryService } from './inventory.service.ts';
import ApiError from '../utils/ApiError.ts';
import { recordAudit } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';

const { ObjectId } = mongoose.Types;

/**
 * An identifier as it reaches this service. Both forms occur at real call sites:
 * a hex string — the request layer stringifies `req.user.businessId` and
 * `req.user.id` — and an ObjectId already loaded from a document, which `update`
 * passes as `existing.supplierId._id` and `receive` as the PO's own
 * `locationId`. `oid()` accepts either, so the alias names the pair rather than
 * asserting which one a given caller holds. Same alias as
 * `inventory.service.ts`, which documents the same two call shapes.
 */
type IdLike = string | mongoose.Types.ObjectId;

const oid = (id: IdLike) => new ObjectId(id);

const PO_NUMBER_PREFIX = 'PO-';
const PO_NUMBER_PAD = 4;
const PO_NUMBER_MAX_ATTEMPTS = 10;
// Every received line's stock-in shares this reason plus the PO number as its
// reference, so the ledger history reads uniformly (spec §15 three-type enum is
// unchanged — receiving IS a stock-in, never a new movement type).
const PO_RECEIVE_REASON = 'PO receipt';
const RECEIVE_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * Canonical fingerprint of one receive request. Lines are sorted by product id
 * so reordering the same lines is the same request, while changing a quantity,
 * the invoice reference or the purchase order is not. This is deliberately
 * independent of the transport middleware's fingerprint: the durable receipt
 * must be able to defend itself even when the middleware's 24-hour row expired.
 */
function receiveFingerprint(id: IdLike, lines: ReceiveLine[], reference?: string): string {
  const canonical = {
    po: String(id),
    lines: lines
      .map((line) => ({ productId: String(line.productId).toLowerCase(), quantity: line.quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId) || a.quantity - b.quantity),
    reference: (reference ?? '').trim(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * A reference field that has been populated by `fetchPo`/`list`: the referenced
 * document. The fields are `unknown` rather than a declared document type for
 * the reason `InventoryRowSource` gives — Mongoose types a populated field as the
 * raw `ObjectId` it replaced, so at the type level `supplierId` is an ObjectId
 * even though at runtime it is the whole supplier. The untyped code read
 * `_id`/`name`/`status` off it either way, so each read is narrowed where it
 * happens instead of asserting a shape the compiler cannot confirm.
 */
type SupplierRefSource = { _id?: unknown; name?: unknown; status?: unknown };
type LocationRefSource = { _id?: unknown; name?: unknown };

/**
 * One stored order line — the fields `itemPublic`/`totalsOf` read. `quantityOrdered`
 * is required (the schema requires it, min 1) because `itemPublic` subtracts it,
 * and `unitCost` is an optional number because `totalsOf` multiplies it.
 */
type PoItemSource = {
  productId?: unknown;
  productName?: unknown;
  sku?: unknown;
  quantityOrdered: number;
  quantityReceived?: number;
  quantityCommitted?: number;
  unitCost?: number;
};

/** One stored receipt line / receipt — the fields `receiptsPublic` reads. */
type ReceiptLineSource = {
  productId?: unknown;
  quantity?: unknown;
  inventoryTransactionId?: unknown;
  previousQuantity?: unknown;
  newQuantity?: unknown;
};

type ReceiptSource = {
  receivedAt?: unknown;
  userId?: unknown;
  reference?: unknown;
  requestKey?: unknown;
  requestFingerprint?: unknown;
  lines?: ReceiptLineSource[];
};

/** One stored in-flight claim — the fields `pendingClaimsPublic` reads. */
type ClaimSource = {
  _id?: unknown;
  productId?: unknown;
  quantity?: unknown;
  requestKey?: unknown;
  requestFingerprint?: unknown;
  phase?: unknown;
  inventoryTransactionId?: unknown;
  createdAt?: unknown;
};

/**
 * A purchase order as read back — the lean, optionally-populated result of
 * `fetchPo` and `list`, and the snapshot `receive` plans against.
 *
 * `items` is required rather than optional because the schema defaults it to `[]`,
 * so a stored order always carries the array; that is what lets `receive` iterate
 * `po.items` directly, exactly as the untyped code did. `number` is a real string
 * for the same reason — the schema requires it — and it is typed as one because
 * `receive` passes it straight through as the stock-in's ledger `reference`, which
 * is a string. The reference fields stay `unknown` for the reason
 * `SupplierRefSource` documents.
 */
type PurchaseOrderSource = {
  _id?: unknown;
  businessId?: unknown;
  number: string;
  status?: unknown;
  supplierId?: unknown;
  locationId?: unknown;
  expectedAt?: unknown;
  notes?: unknown;
  items: PoItemSource[];
  receipts?: ReceiptSource[];
  claims?: ClaimSource[];
  createdAt?: unknown;
  updatedAt?: unknown;
};

/**
 * One order line as `resolveOperational` builds it and `$set.items` writes it —
 * the product name/sku snapshot taken at order time. `productId` is the lean
 * product's own `_id`, so it is an ObjectId by the time it reaches the document.
 */
type PoItemWrite = {
  productId: IdLike;
  productName: string;
  sku: string | undefined;
  quantityOrdered: number;
  quantityReceived: number;
  quantityCommitted: number;
  unitCost: number | undefined;
};

/**
 * The `$set` a PATCH builds. Only the keys the request actually supplied are
 * present — that presence is what `changed` counts and what the audit row
 * reports, so nothing here is defaulted.
 */
type PoUpdateSet = {
  supplierId?: IdLike;
  locationId?: IdLike;
  expectedAt?: Date;
  notes?: string;
  items?: PoItemWrite[];
};

/** One validated order line (`parsePoLine`), asserted at the controller. */
type PoLineInput = { productId: string; quantityOrdered: number; unitCost?: number };

/** The validated create payload (`validatePurchaseOrder`). */
type PoCreatePayload = {
  supplierId: string;
  locationId: string;
  expectedAt?: Date;
  notes?: string;
  items: PoLineInput[];
};

/** The validated update payload (`validatePurchaseOrder` with `{ partial: true }`). */
type PoUpdatePayload = {
  supplierId?: string;
  locationId?: string;
  expectedAt?: Date;
  notes?: string;
  items?: PoLineInput[];
};

/** The validated list filters (`validatePurchaseOrderList`) plus pagination. */
type PoListFilters = {
  q?: string;
  status?: string;
  supplierId?: string;
  skip: number;
  limit: number;
};

/** One validated receive line (`parseReceiveLine`), asserted at the controller. */
type ReceiveLine = { productId: string; quantity: number };

/** The validated receive payload (`validateReceive`). */
type ReceivePayload = {
  lines: ReceiveLine[];
  reference?: string;
  /**
   * The HTTP Idempotency-Key. The HTTP controller requires it; the service
   * still accepts an absent key so direct internal callers and historical
   * tests can exercise a single receive without the transport contract.
   */
  idempotencyKey?: string;
};

/** One line the receive loop durably applied, as reported in a partial result. */
type AppliedLine = {
  productId: string;
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  inventoryTransactionId: string;
};

/**
 * The movement `undoStockInMovement` has to reverse — derived from
 * `inventoryService.stockIn` itself so the undo cannot drift from the shape the
 * stock-in actually returns.
 */
type StockInMovement = Awaited<ReturnType<typeof inventoryService.stockIn>>;

function isDuplicateKey(err: unknown) {
  // `err?.code === 11000`, narrowed: the optional access reproduces the original
  // short-circuit, so a thrown `null`/`undefined`/primitive still compares
  // unequal rather than raising.
  return (err as { code?: unknown } | null | undefined)?.code === 11000;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Business-scoped sequential PO number. Reads the highest existing numeric
 * suffix in this business and returns that + 1 (padded, e.g. PO-0001). The
 * unique (businessId, number) index is the final authority: the create loop
 * recomputes and retries if a concurrent create races this read.
 */
async function nextPurchaseOrderNumber(businessId: IdLike) {
  const docs = await PurchaseOrder.find(
    { businessId: oid(businessId), number: { $regex: /^PO-\d+$/ } },
    { number: 1 }
  ).lean();
  let max = 0;
  for (const doc of docs) {
    const n = Number(doc.number.slice(PO_NUMBER_PREFIX.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${PO_NUMBER_PREFIX}${String(max + 1).padStart(PO_NUMBER_PAD, '0')}`;
}

/** Supplier must exist in the business and not be archived (mirrors inventory asserts). */
async function assertOperationalSupplier(businessId: IdLike, supplierId: IdLike) {
  const supplier = await Supplier.findOne({ _id: oid(supplierId), businessId: oid(businessId) }).lean();
  if (!supplier) throw new ApiError(404, 'Supplier not found', 'SUPPLIER_NOT_FOUND');
  if (supplier.status === 'ARCHIVED') {
    throw new ApiError(409, 'Archived suppliers cannot be used on a purchase order', 'SUPPLIER_ARCHIVED');
  }
  return supplier;
}

/** A PO's own audit event; the PO document is authoritative, so a logging
 * failure is reported but never rolls a durable state change back. */
async function recordPoAudit(
  businessId: IdLike,
  userId: IdLike,
  action: string,
  entityId: IdLike,
  metadata: unknown
) {
  try {
    await recordAudit({
      businessId,
      userId,
      action,
      entityType: AUDIT_ENTITY_TYPES.PURCHASE_ORDER,
      entityId,
      metadata,
    });
  } catch (err) {
    // `${err.message}`, narrowed. The template interpolation is left exactly as it
    // was rather than wrapped in `String()`: interpolation performs the same
    // ToString for every value the original could hold, and keeping it bare means
    // the emitted JavaScript is unchanged.
    console.error(`[purchase-orders] audit record failed for ${action} ${String(entityId)}: ${(err as { message?: unknown }).message}`);
    await monitorAuditFailure({
      businessId,
      action,
      entityType: AUDIT_ENTITY_TYPES.PURCHASE_ORDER,
      entityId,
      error: err,
    });
  }
}

function supplierRef(po: PurchaseOrderSource) {
  const s = po.supplierId as SupplierRefSource | null | undefined;
  if (s && s._id) return { id: String(s._id), name: s.name, status: s.status };
  return { id: String(s), name: null, status: null };
}

function locationRef(po: PurchaseOrderSource) {
  const l = po.locationId as LocationRefSource | null | undefined;
  if (l && l._id) return { id: String(l._id), name: l.name };
  return { id: String(l), name: null };
}

function itemPublic(item: PoItemSource) {
  const quantityReceived = item.quantityReceived ?? 0;
  return {
    productId: String(item.productId),
    productName: item.productName,
    sku: item.sku ?? undefined,
    quantityOrdered: item.quantityOrdered,
    quantityReceived,
    remainingQuantity: item.quantityOrdered - quantityReceived,
    unitCost: item.unitCost ?? undefined,
  };
}

/** Totals are computed (never stored) so they cannot drift from the lines. */
function totalsOf(items: PoItemSource[]) {
  const quantityOrdered = items.reduce((sum, i) => sum + (i.quantityOrdered || 0), 0);
  const quantityReceived = items.reduce((sum, i) => sum + (i.quantityReceived || 0), 0);
  const estimatedCost = items.reduce(
    (sum, i) => sum + (i.quantityOrdered || 0) * (i.unitCost ?? 0),
    0
  );
  return {
    quantityOrdered,
    quantityReceived,
    remainingQuantity: quantityOrdered - quantityReceived,
    estimatedCost,
  };
}

/** List/header shape — no item lines, just the count + computed totals. */
function headerPublic(po: PurchaseOrderSource) {
  const items = po.items || [];
  return {
    id: String(po._id),
    businessId: String(po.businessId),
    number: po.number,
    status: po.status,
    supplier: supplierRef(po),
    location: locationRef(po),
    expectedAt: po.expectedAt ?? undefined,
    notes: po.notes ?? undefined,
    totals: totalsOf(items),
    itemCount: items.length,
    createdAt: po.createdAt,
    updatedAt: po.updatedAt,
  };
}

/**
 * Receiving records on the PO (Phase 13C) — one embedded receipt per received
 * line, each line carrying the exact inventory transaction it caused, so a
 * receipt can be traced to the ledger and back (the transaction's reference is
 * the PO number).
 */
function receiptsPublic(po: PurchaseOrderSource) {
  return (po.receipts || []).map((receipt) => ({
    receivedAt: receipt.receivedAt,
    userId: String(receipt.userId),
    reference: receipt.reference || undefined,
    lines: (receipt.lines || []).map((line) => ({
      productId: String(line.productId),
      quantity: line.quantity,
      inventoryTransactionId: String(line.inventoryTransactionId),
      previousQuantity: line.previousQuantity,
      newQuantity: line.newQuantity,
    })),
  }));
}

/**
 * In-flight receive claims (claim-first receiving) exposed read-only so an
 * interrupted receive is visible to the operator and the mobile client can
 * subtract pending from the offered receive quantity. Empty at rest; a ghost
 * claim left by a crash mid-receive stays visible here until cancel + re-create.
 */
function pendingClaimsPublic(po: PurchaseOrderSource) {
  return (po.claims || []).map((claim) => ({
    productId: String(claim.productId),
    quantity: claim.quantity,
    createdAt: claim.createdAt,
  }));
}

/** Detail shape — header plus the full item lines and receiving records. */
function detailPublic(po: PurchaseOrderSource) {
  return {
    ...headerPublic(po),
    items: (po.items || []).map(itemPublic),
    receipts: receiptsPublic(po),
    pendingClaims: pendingClaimsPublic(po),
  };
}

async function fetchPo(businessId: IdLike, id: IdLike) {
  const po = await PurchaseOrder.findOne({ _id: oid(id), businessId: oid(businessId) })
    .populate({ path: 'supplierId', select: 'name status' })
    .populate({ path: 'locationId', select: 'name' })
    .lean<PurchaseOrderSource>();
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  return po;
}

/**
 * Re-verify + snapshot a supplier/location/item set that is being placed on a
 * PO. Every reference must belong to the business and be ACTIVE (server-side —
 * never a client businessId), reusing inventory's operational asserts so PO
 * behaviour matches stock movements exactly. Snapshot product name/sku at order
 * time; quantityReceived always starts at 0 (only receiving advances it).
 */
async function resolveOperational(
  businessId: IdLike,
  supplierId: IdLike,
  locationId: IdLike,
  lines: PoLineInput[]
) {
  const supplier = await assertOperationalSupplier(businessId, supplierId);
  const location = await inventoryService.assertOperationalLocation(businessId, locationId);
  const items: PoItemWrite[] = [];
  for (const line of lines) {
    const product = await inventoryService.assertOperationalProduct(businessId, line.productId);
    items.push({
      productId: product._id,
      productName: product.name,
      sku: product.sku || undefined,
      quantityOrdered: line.quantityOrdered,
      quantityReceived: 0,
      quantityCommitted: 0,
      unitCost: line.unitCost,
    });
  }
  return { supplier, location, items };
}

/** Create a PO in DRAFT. Allocates a business-scoped number under the unique
 * index and retries on a duplicate-key race (bounded). Never writes stock. */
async function create(businessId: IdLike, userId: IdLike, payload: PoCreatePayload) {
  const refs = await resolveOperational(businessId, payload.supplierId, payload.locationId, payload.items);

  for (let attempt = 0; attempt < PO_NUMBER_MAX_ATTEMPTS; attempt += 1) {
    const number = await nextPurchaseOrderNumber(businessId);
    let po;
    try {
      po = await PurchaseOrder.create({
        businessId: oid(businessId),
        number,
        supplierId: oid(payload.supplierId),
        locationId: oid(payload.locationId),
        expectedAt: payload.expectedAt,
        notes: payload.notes,
        status: 'DRAFT',
        items: refs.items,
      });
    } catch (err) {
      if (isDuplicateKey(err)) continue; // a concurrent create took this number
      throw err;
    }
    await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_CREATED, po._id, {
      number: po.number,
      supplierId: String(refs.supplier._id),
      locationId: String(refs.location._id),
    });
    return detailPublic(await fetchPo(businessId, String(po._id)));
  }

  throw new ApiError(409, 'Could not allocate a unique purchase order number; retry the request', 'PO_NUMBER_CONFLICT');
}

/**
 * The list filter, derived from the model itself rather than hand-written —
 * `audit.service.ts`'s `AuditFilter` is the same construction, and a local shape
 * would not satisfy the driver's own filter type. Named (rather than inlined at
 * the one `match` declaration) so that declaration stays on one line and emits
 * exactly what the untyped original did.
 */
type PurchaseOrderFilter = mongoose.QueryFilter<mongoose.HydratedDocFromModel<typeof PurchaseOrder>>;

/** List PO headers with optional status / supplier / number (q) filters. */
async function list(businessId: IdLike, { status, supplierId, q, skip, limit }: PoListFilters) {
  const match: PurchaseOrderFilter = { businessId: oid(businessId) };
  // Phase 20D: both filters are validated at the controller, so whatever arrives
  // here is valid by construction. The guards are deliberately unconditional —
  // the old `PURCHASE_ORDER_STATUSES.includes(status)` / `isObjectId(supplierId)`
  // checks silently DROPPED an unrecognized filter, which answered with every
  // purchase order in the business while appearing to be filtered.
  if (status) match.status = status;
  if (supplierId) match.supplierId = oid(supplierId);
  if (q) match.number = { $regex: escapeRegExp(q), $options: 'i' };

  const [total, rows] = await Promise.all([
    PurchaseOrder.countDocuments(match),
    PurchaseOrder.find(match)
      .populate({ path: 'supplierId', select: 'name status' })
      .populate({ path: 'locationId', select: 'name' })
      // `_id` breaks createdAt ties in the same direction as the primary sort so
      // paging cannot repeat or skip an order.
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean<PurchaseOrderSource[]>(),
  ]);
  return { items: rows.map(headerPublic), total };
}

/** Full detail (header + items). Any authenticated member of the business. */
async function get(businessId: IdLike, id: IdLike) {
  return detailPublic(await fetchPo(businessId, id));
}

/**
 * Edit a DRAFT only. Any supplied reference is re-validated against the
 * business; a supplied `items` array replaces the full line set (a DRAFT has
 * never received, so lines reset to quantityReceived 0 safely). Once OPEN the
 * order is frozen — fix a mistake by cancel + re-create.
 */
async function update(businessId: IdLike, id: IdLike, userId: IdLike, payload: PoUpdatePayload) {
  const existing = await fetchPo(businessId, id);
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'Only a DRAFT purchase order can be edited', 'PO_NOT_DRAFT');
  }

  const set: PoUpdateSet = {};
  if (payload.supplierId !== undefined) {
    await assertOperationalSupplier(businessId, payload.supplierId);
    set.supplierId = oid(payload.supplierId);
  }
  if (payload.locationId !== undefined) {
    await inventoryService.assertOperationalLocation(businessId, payload.locationId);
    set.locationId = oid(payload.locationId);
  }
  if (payload.expectedAt !== undefined) set.expectedAt = payload.expectedAt;
  if (payload.notes !== undefined) set.notes = payload.notes;
  if (payload.items !== undefined) {
    // The PO being edited was fetched with both references populated, so the
    // `_id` read off each is the referenced document's own id; the cast is the
    // boundary that says so, exactly as `supplierRef`/`locationRef` do above.
    const { items } = await resolveOperational(
      businessId,
      (existing.supplierId as SupplierRefSource)._id as IdLike,
      (existing.locationId as LocationRefSource)._id as IdLike,
      payload.items
    );
    set.items = items;
  }

  const changed = Object.keys(set);
  if (changed.length === 0) return detailPublic(existing);

  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: oid(id), businessId: oid(businessId), status: 'DRAFT' },
    { $set: set },
    { returnDocument: 'after', runValidators: true }
  );
  if (!updated) {
    throw new ApiError(409, 'Purchase order changed concurrently; refresh and retry', 'PO_STATE_CONFLICT');
  }
  await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_UPDATED, updated._id, {
    number: updated.number,
    updated: changed,
  });
  return detailPublic(await fetchPo(businessId, id));
}

/** Issue a DRAFT -> OPEN. Only OPEN orders can be received (Phase 13C). */
async function issue(businessId: IdLike, id: IdLike, userId: IdLike) {
  const existing = await fetchPo(businessId, id);
  if (existing.status === 'CANCELED') {
    throw new ApiError(409, 'A canceled purchase order cannot be issued', 'PO_CANCELED');
  }
  if (existing.status === 'RECEIVED') {
    throw new ApiError(409, 'This purchase order has already been received', 'PO_ALREADY_RECEIVED');
  }
  if (existing.status === 'OPEN') {
    throw new ApiError(409, 'This purchase order is already open', 'PO_ALREADY_OPEN');
  }

  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: existing._id, businessId: oid(businessId), status: 'DRAFT' },
    { $set: { status: 'OPEN' } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    throw new ApiError(409, 'Purchase order changed concurrently; refresh and retry', 'PO_STATE_CONFLICT');
  }
  await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_ISSUED, updated._id, {
    number: updated.number,
    status: 'OPEN',
  });
  return detailPublic(await fetchPo(businessId, id));
}

/** Cancel a DRAFT or OPEN order. Blocks all further work on it. */
async function cancel(businessId: IdLike, id: IdLike, userId: IdLike) {
  const existing = await fetchPo(businessId, id);
  if (existing.status === 'CANCELED') {
    throw new ApiError(409, 'This purchase order is already canceled', 'PO_ALREADY_CANCELED');
  }
  if (existing.status === 'RECEIVED') {
    throw new ApiError(409, 'A received purchase order cannot be canceled', 'PO_ALREADY_RECEIVED');
  }

  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: existing._id, businessId: oid(businessId), status: { $in: ['DRAFT', 'OPEN'] } },
    { $set: { status: 'CANCELED' } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    throw new ApiError(409, 'Purchase order changed concurrently; refresh and retry', 'PO_STATE_CONFLICT');
  }
  await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_CANCELED, updated._id, {
    number: updated.number,
    status: 'CANCELED',
  });
  return detailPublic(await fetchPo(businessId, id));
}

/**
 * Full precise undo of one received line whose PO finalize lost a race (Phase 13C
 * compensation, owner-approved). Reverts exactly what this call's stock-in wrote:
 * the inventory row (deleting a row this call created, else restoring a pre-existing
 * one), then that movement's InventoryTransaction and its audit row. Cross-document,
 * so each step is anchored — if a concurrent movement has built on the row, the
 * restore no-ops, the movement is left durable (it is part of history now) and the
 * transaction/audit are kept; a newer value is never clobbered (H4/L5 parity). A
 * step that still cannot restore logs loudly and leaves a visible reference-tagged
 * STOCK_IN in history for manual reconciliation — never a silent partial.
 *
 * Returns true when the inventory row was restored (the movement is fully off the
 * shelf) and false when the row restore no-oped and the movement stays durable —
 * the caller uses that to decide whether releasing its PO claim is safe (release
 * only when no orphan stock remains, otherwise keep the claim to block over-receiving).
 */
async function undoStockInMovement(businessId: IdLike, move: StockInMovement) {
  const oidBiz = oid(businessId);
  const txnId = oid(move.transaction.id);
  const rowFilter = {
    businessId: oidBiz,
    productId: oid(move.transaction.productId),
    locationId: oid(move.transaction.locationId),
  };

  let restored = false;
  // Only one of the two counts exists on either result, which is exactly what the
  // `??` already relied on; the annotation names both as optional so the union of
  // the two Mongoose result types can be read for each.
  let failure: string | null = null;
  try {
    const res: { deletedCount?: number; modifiedCount?: number } = move.createdRow
      ? await Inventory.deleteOne({ ...rowFilter, quantity: move.newQuantity, reservedQuantity: 0 })
      : await Inventory.updateOne(
          { ...rowFilter, quantity: move.newQuantity },
          { $set: { quantity: move.previousQuantity } }
        );
    restored = (res.deletedCount ?? res.modifiedCount) === 1;
  } catch (err) {
    // The raw caught value, exactly as the untyped code stored it: it is only ever
    // interpolated into the log line below, which stringifies it the same way.
    failure = (err as { message?: unknown }).message as string;
  }
  if (!restored) {
    console.error(
      `[purchase-orders] receive undo: txn ${String(txnId)} not undone (${failure ?? 'row moved on — keeping the durable movement'})`
    );
    return false;
  }

  try {
    await InventoryTransaction.deleteOne({ _id: txnId, businessId: oidBiz });
  } catch (err) {
    console.error(`[purchase-orders] receive undo: transaction delete failed for txn ${String(txnId)}:`, (err as { message?: unknown }).message);
  }
  try {
    await AuditLog.deleteOne({
      businessId: oidBiz,
      action: AUDIT_ACTIONS.INVENTORY_STOCK_IN,
      'metadata.inventoryTransactionId': move.transaction.id,
    });
  } catch (err) {
    console.error(`[purchase-orders] receive undo: audit delete failed for txn ${String(txnId)}:`, (err as { message?: unknown }).message);
  }
  return true;
}

/**
 * Claim-first receive operations (Phase 13C redesign). Each is ONE single-document
 * atomic write; the redesign reserves the PO remaining quantity BEFORE any
 * inventory write, so a concurrent losing receive never calls stockIn and can
 * never leave a surviving orphan STOCK_IN.
 *
 * Guard rule (Phase 13C lesson, retained): the no-over-receive bound is enforced
 * in the DOCUMENT filter via $elemMatch — arrayFilters alone only suppress the
 * positional $inc when a bound is exceeded, they do NOT fail the update.
 */

/**
 * Op1 CLAIM — atomically reserve `quantity` of a line's remaining on the PO and
 * register this request's claim in one write. The claim _id is generated by the
 * caller up front so every compensation is a targeted $pull by that exact id.
 * Returns the updated doc, or null when the remaining was already consumed by a
 * concurrent claim (or the PO left OPEN, e.g. a racing CANCEL) — the caller then
 * must NOT move stock.
 */
type ClaimRemainingArgs = {
  poId: IdLike;
  oidBiz: IdLike;
  productId: IdLike;
  quantity: number;
  remainingBound: number;
  userId: IdLike;
  claimId: mongoose.Types.ObjectId;
  requestKey?: string;
  requestFingerprint?: string;
};

async function claimRemaining({
  poId,
  oidBiz,
  productId,
  quantity,
  remainingBound,
  userId,
  claimId,
  requestKey,
  requestFingerprint,
}: ClaimRemainingArgs) {
  return PurchaseOrder.findOneAndUpdate(
    {
      _id: poId,
      businessId: oidBiz,
      status: 'OPEN',
      items: { $elemMatch: { productId, quantityCommitted: { $lte: remainingBound } } },
    },
    {
      $inc: { 'items.$[l].quantityCommitted': quantity },
      $push: {
        claims: {
          _id: claimId,
          productId,
          quantity,
          createdBy: oid(userId),
          ...(requestKey ? { requestKey } : {}),
          ...(requestFingerprint ? { requestFingerprint } : {}),
          createdAt: new Date(),
        },
      },
    },
    {
      arrayFilters: [{ 'l.productId': productId, 'l.quantityCommitted': { $lte: remainingBound } }],
      returnDocument: 'after',
    }
  );
}

/**
 * Op3 FINALIZE — turn a claim into a durable receipt in ONE atomic write: advance
 * the line's quantityReceived, remove OUR claim and record the embedded receipt
 * (which references the stock-in's exact inventory transaction). quantityCommitted
 * is unchanged — the reserved quantity simply moves from "outstanding claim" to
 * "received". Guarded on status OPEN + our own claimId, so it can only ever
 * finalize our own reservation and only while the PO is still open. Returns the
 * updated doc, or null when a concurrent CANCEL defeated it (the only status that
 * can, see receive()).
 */
type FinalizeClaimArgs = {
  poId: IdLike;
  oidBiz: IdLike;
  productId: IdLike;
  quantity: number;
  claimId: mongoose.Types.ObjectId;
  receipt: Record<string, unknown>;
};

async function finalizeClaim({ poId, oidBiz, productId, quantity, claimId, receipt }: FinalizeClaimArgs) {
  return PurchaseOrder.findOneAndUpdate(
    {
      _id: poId,
      businessId: oidBiz,
      status: 'OPEN',
      claims: { $elemMatch: { _id: claimId } },
    },
    {
      $inc: { 'items.$[l].quantityReceived': quantity },
      $pull: { claims: { _id: claimId } },
      $push: { receipts: receipt },
    },
    {
      arrayFilters: [{ 'l.productId': productId }],
      returnDocument: 'after',
    }
  );
}

/**
 * Op4 RELEASE — targeted, idempotent compensation that returns an un-finalized
 * claim's reservation: removes OUR claim and restores the line's
 * quantityCommitted. Matches ONLY claimId (never another request's claim) and has
 * no status guard (it must also work on a PO a concurrent CANCEL just closed).
 * modifiedCount 1 = released; 0 = already gone (a finalize already pulled it, or a
 * double release) — a safe no-op either way.
 */
type ReleaseClaimArgs = {
  poId: IdLike;
  oidBiz: IdLike;
  productId: IdLike;
  quantity: number;
  claimId: mongoose.Types.ObjectId;
};

async function releaseClaim({ poId, oidBiz, productId, quantity, claimId }: ReleaseClaimArgs) {
  return PurchaseOrder.updateOne(
    {
      _id: poId,
      businessId: oidBiz,
      claims: { $elemMatch: { _id: claimId } },
    },
    {
      $pull: { claims: { _id: claimId } },
      $inc: { 'items.$[l].quantityCommitted': -quantity },
    },
    {
      arrayFilters: [{ 'l.productId': productId }],
    }
  );
}

/**
 * Receive stock into the ledger against an OPEN purchase order (Phase 13C,
 * claim-first).
 *
 * Claim-first per line, so a concurrent losing receive never moves stock: each
 * line (1) CLAIMs the remaining quantity on the PO atomically BEFORE any inventory
 * write, (2) stock-ins — the authoritative, atomic, self-compensating movement
 * (row + its InventoryTransaction + its INVENTORY_STOCK_IN audit; reason 'PO
 * receipt', reference = the PO number) — then (3) FINALIZEs: advances
 * quantityReceived, drops the claim and records the embedded receipt in ONE
 * atomic document update. A lost claim (concurrent same-line consume, or a racing
 * CANCEL) rejects the line with 409 RECEIVE_CONFLICT and zero movement — the
 * loser never calls stockIn, so no orphan STOCK_IN can survive a failed claim.
 * Compensation: a stock-in that fails after its claim is fully released (Op4); a
 * finalize that returns null (concurrent CANCEL) precisely undoes the movement
 * and releases only if the row was restored; a finalize that throws is ambiguous
 * and is never compensated. Earlier committed lines of a mid-batch conflict stay
 * durable and are reported as a 409 RECEIVE_CONFLICT `applied` list — never a
 * silent partial. When every line is complete the PO auto-flips OPEN -> RECEIVED.
 * Stock always lands at the PO's own location (the validator accepts no
 * locationId); every write is scoped to the server-derived businessId. A crash
 * mid-receive can leave a visible ghost claim (see detailPublic pendingClaims),
 * recoverable by cancel + re-create.
 */
async function receive(
  businessId: IdLike,
  userId: IdLike,
  id: IdLike,
  { lines, reference, idempotencyKey }: ReceivePayload
) {
  if (idempotencyKey !== undefined && !RECEIVE_KEY_PATTERN.test(idempotencyKey)) {
    throw new ApiError(
      400,
      'The Idempotency-Key is not in the accepted format',
      'INVALID_IDEMPOTENCY_KEY'
    );
  }
  const requestFingerprint = idempotencyKey
    ? receiveFingerprint(id, lines, reference)
    : undefined;
  const po = await fetchPo(businessId, id);

  // Retry gate. A finalize that throws AFTER its atomic write has already moved stock
  // and stored a receipt, but the client saw a 5xx. The idempotency middleware releases
  // a 5xx key (it cannot know work landed), so the retry reaches the service again.
  // Recognise our own durable receipt by the client's key and replay it — never claim or
  // stock-in again. A receipt for only part of this batch is a partial outcome, not a
  // fresh request: report the lines that landed and let the client decide, because
  // claiming the rest could double-count a line whose receipt exists.
  if (idempotencyKey) {
    const ownReceipts = (po.receipts ?? []).filter((receipt) => receipt.requestKey === idempotencyKey);
    if (ownReceipts.length > 0) {
      const conflictingReceipt = ownReceipts.find(
        (receipt) =>
          typeof receipt.requestFingerprint === 'string' &&
          receipt.requestFingerprint !== requestFingerprint
      );
      if (conflictingReceipt) {
        throw new ApiError(
          422,
          'This idempotency key was already used for a different receive request',
          'IDEMPOTENCY_KEY_REUSED'
        );
      }
      const receiptLines = ownReceipts.flatMap((receipt) => receipt.lines ?? []);
      const appliedByProduct = new Map<string, number>();
      for (const line of receiptLines) {
        const key = String(line.productId);
        appliedByProduct.set(key, (appliedByProduct.get(key) ?? 0) + Number(line.quantity ?? 0));
      }
      const allRequestedApplied = lines.every(
        (line) => (appliedByProduct.get(String(line.productId)) ?? 0) >= line.quantity
      );
      const applied = receiptLines.map((line) => ({
        productId: String(line.productId),
        quantity: Number(line.quantity),
        previousQuantity: Number(line.previousQuantity),
        newQuantity: Number(line.newQuantity),
        inventoryTransactionId: String(line.inventoryTransactionId),
      }));
      if (allRequestedApplied) {
        return {
          allReceived: po.items.every((item) => (item.quantityReceived || 0) >= item.quantityOrdered),
          applied,
          po: detailPublic(po),
          replayed: true,
        };
      }
      const err = new ApiError(
        409,
        'Part of this receive was already applied; refresh the purchase order before retrying the remainder',
        'RECEIVE_CONFLICT'
      );
      (err as ApiError & { applied: AppliedLine[] }).applied = applied;
      throw err;
    }
    // A claim with this key but no receipt means the previous attempt never finalized.
    // It may or may not have stock-in applied, so refusing without moving stock is the
    // only safe answer; a visible pending claim can be recovered by cancel + re-create.
    if ((po.claims ?? []).some((claim) => claim.requestKey === idempotencyKey)) {
      const ownClaim = (po.claims ?? []).find((claim) => claim.requestKey === idempotencyKey);
      if (
        ownClaim &&
        typeof ownClaim.requestFingerprint === 'string' &&
        ownClaim.requestFingerprint !== requestFingerprint
      ) {
        throw new ApiError(
          422,
          'This idempotency key was already used for a different receive request',
          'IDEMPOTENCY_KEY_REUSED'
        );
      }
      throw new ApiError(
        409,
        'This receive is already in progress; refresh the purchase order before retrying',
        'RECEIVE_IN_PROGRESS'
      );
    }
  }

  if (po.status === 'DRAFT') throw new ApiError(409, 'Issue the purchase order before receiving it', 'PO_NOT_ISSUED');
  if (po.status === 'RECEIVED') throw new ApiError(409, 'This purchase order has already been received', 'PO_ALREADY_RECEIVED');
  if (po.status === 'CANCELED') throw new ApiError(409, 'A canceled purchase order cannot be received', 'PO_CANCELED');

  // Validate the whole batch against ONE fresh snapshot before anything moves:
  // every line must be an item on this PO and fit inside its remaining quantity.
  const byProduct = new Map<string, PoItemSource>();
  for (const item of po.items) byProduct.set(String(item.productId).toLowerCase(), item);

  const plan: { productId: string; quantity: number; ordered: number }[] = [];
  for (const line of lines) {
    const item = byProduct.get(String(line.productId).toLowerCase());
    if (!item) {
      throw new ApiError(409, 'This product is not on this purchase order', 'PO_LINE_NOT_FOUND');
    }
    // Remaining is measured against quantityCommitted (received + in-flight claims),
    // so a batch that would collide with a concurrent receive already holding a
    // claim fails up front with zero applied. At rest committed == received.
    const remaining = item.quantityOrdered - (item.quantityCommitted ?? item.quantityReceived ?? 0);
    if (line.quantity > remaining) {
      throw new ApiError(409, `Quantity exceeds the remaining ${remaining} for this product`, 'PO_REMAINING_EXCEEDED');
    }
    // Fail fast on archived products too — stockIn would reject each line, but
    // catching it up front keeps the whole batch untouched (a product archived
    // mid-flight is still caught and surfaced as a partial by the loop below).
    await inventoryService.assertOperationalProduct(businessId, line.productId);
    plan.push({ productId: String(line.productId), quantity: line.quantity, ordered: item.quantityOrdered });
  }

  const oidBiz = oid(businessId);
  const poId = oid(id);
  // `fetchPo` populates `locationId`, so it is normally the location document; the
  // `oid(...)` fallback still covers the unpopulated-id case, exactly as before.
  const receivingAt = po.locationId && (po.locationId as LocationRefSource)._id ? oid((po.locationId as LocationRefSource)._id as IdLike) : oid(po.locationId as IdLike);
  const applied: AppliedLine[] = [];

  // Abort the batch with an explicit partial result. Lines already applied stay
  // durable and recorded on the PO; the client retries only the remainder.
  // Annotated `Promise<never>` because every path through it ends in a throw.
  // That annotation is a statement of fact, NOT a control-flow aid: the checker
  // does not treat `await <never-returning arrow>()` as terminating (measured —
  // an explicit `: never` on a function *declaration* would, but this is a `const`
  // arrow because the original was, and its runtime shape is not ours to change),
  // so each result the callers below read past a `throwPartial()` call carries the
  // type-level assertion it needs instead.
  const throwPartial = async (): Promise<never> => {
    if (applied.length > 0) {
      await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_RECEIVED, poId, {
        number: po.number,
        status: 'OPEN',
        partial: true,
        reference: reference || undefined,
        receivedLines: applied.map((a) => ({
          productId: a.productId,
          quantity: a.quantity,
          inventoryTransactionId: a.inventoryTransactionId,
        })),
      });
    }
    const err = new ApiError(
      409,
      'Only part of this receive could be applied; refresh and retry the remaining lines',
      'RECEIVE_CONFLICT'
    );
    // `applied` is attached to the thrown error for the client; ApiError declares
    // no such field, so the assertion names the extra property it is given.
    (err as ApiError & { applied: AppliedLine[] }).applied = applied;
    throw err;
  };

  for (const step of plan) {
    const productId = oid(step.productId);
    const claimId = new ObjectId();
    // The remaining bound is a constant while OPEN (quantityOrdered never
    // changes), so Op1 enforces it in the DOCUMENT filter via $elemMatch.
    const remainingBound = step.ordered - step.quantity;

    // (a) Op1 CLAIM — atomically reserve the remaining BEFORE any inventory
    // write and register this request's claim in the same update. A null result
    // means a concurrent claim already consumed the remaining (or the PO left
    // OPEN, e.g. a racing CANCEL): we do NOT call stock-in and this line is
    // rejected with zero movement — a rejected receive can never create an orphan
    // STOCK_IN (the movement-first residual this redesign removes).
    let claimed;
    try {
      claimed = await claimRemaining({
        poId,
        oidBiz,
        productId,
        quantity: step.quantity,
        remainingBound,
        userId,
        claimId,
        requestKey: idempotencyKey,
        requestFingerprint,
      });
    } catch (err) {
      // Ambiguous whether the claim inserted. Release by id (a no-op if it did
      // not) so a reservation that never moved stock is never leaked, then
      // surface like any other pre-movement failure.
      try {
        await releaseClaim({ poId, oidBiz, productId, quantity: step.quantity, claimId });
      } catch (releaseErr) {
        console.error(
          `[purchase-orders] receive: could not release claim ${String(claimId)} after a failed claim: ${(releaseErr as { message?: unknown }).message} — PO may hold a ghost claim`
        );
      }
      if (applied.length === 0) throw err;
      await throwPartial();
    }
    if (!claimed) {
      await throwPartial();
    }

    // (b) Op2 stock-in — the authoritative, atomic, self-compensating movement
    // (row + its InventoryTransaction + its INVENTORY_STOCK_IN audit), only after
    // the claim won. A durable-record failure restores its own row and rejects.
    // The definite-assignment assertion states a runtime fact the checker cannot
    // derive: the `catch` below either rethrows or ends in `throwPartial()`, which
    // always throws, so every read of `move` after this statement — including the
    // ones after the `catch` — happens only when the assignment completed. It is
    // erased, so the declaration still emits the original `let move;`.
    let move!: StockInMovement;
    try {
      move = await inventoryService.stockIn(businessId, userId, {
        productId: step.productId,
        locationId: receivingAt,
        quantity: step.quantity,
        reason: PO_RECEIVE_REASON,
        reference: po.number,
        purchaseOrderClaimId: claimId,
      });
    } catch (err) {
      // stockIn already restored its own row before rejecting, so no movement
      // survived — releasing our claim is safe.
      try {
        await releaseClaim({ poId, oidBiz, productId, quantity: step.quantity, claimId });
      } catch (releaseErr) {
        console.error(
          `[purchase-orders] receive: could not release claim ${String(claimId)} after a failed stock-in: ${(releaseErr as { message?: unknown }).message} — PO may hold a ghost claim`
        );
      }
      if (applied.length === 0) throw err;
      await throwPartial();
    }

    // Mark the claim as moved BEFORE finalize. If the process dies between the
    // stock-in and finalize, the reaper uses this marker plus the transaction's
    // purchaseOrderClaimId to prove the movement and undo it exactly. A failure
    // to write this marker is not fatal: the transaction itself carries the same
    // claim id, which is the stronger proof.
    try {
      await PurchaseOrder.updateOne(
        { _id: poId, businessId: oidBiz, 'claims._id': claimId },
        {
          $set: {
            'claims.$.phase': 'MOVED',
            'claims.$.inventoryTransactionId': oid(move.transaction.id),
            'claims.$.lastAttemptAt': new Date(),
          },
        }
      );
    } catch (markerErr) {
      console.error(
        `[purchase-orders] receive: could not mark claim ${String(claimId)} MOVED; the stock-in transaction remains the recovery proof: ${(markerErr as { message?: unknown }).message}`
      );
    }

    // (c) Op3 FINALIZE — movement -> durable receipt in ONE atomic write guarded
    // on status OPEN + OUR claimId: advance quantityReceived, drop the claim and
    // record the embedded receipt together. quantityCommitted is unchanged (the
    // reservation moves from outstanding to received).
    let finalized;
    try {
      finalized = await finalizeClaim({
        poId,
        oidBiz,
        productId,
        quantity: step.quantity,
        claimId,
        receipt: {
          receivedAt: new Date(),
          userId: oid(userId),
          reference: reference || '',
          ...(idempotencyKey ? { requestKey: idempotencyKey } : {}),
          requestFingerprint,
          lines: [
            {
              productId,
              quantity: step.quantity,
              inventoryTransactionId: oid(move.transaction.id),
              previousQuantity: move.previousQuantity,
              newQuantity: move.newQuantity,
            },
          ],
        },
      });
    } catch (err) {
      // Ambiguous — the finalize may or may not have applied (a receipt may now
      // reference this movement). Never compensate a possibly-finalized receipt
      // (that would delete a transaction a receipt references). Earlier applied
      // lines stay durable; the client refetches the PO to see the true state.
      console.error(
        `[purchase-orders] receive: finalize threw for claim ${String(claimId)} — leaving the movement uncompensated (ambiguous; may be receipted). txn ${move ? String(move.transaction.id) : 'unknown'}: ${(err as { message?: unknown }).message}`
      );
      throw err;
    }
    if (!finalized) {
      // Only a concurrent CANCEL can defeat a finalize (a line with an
      // outstanding claim cannot auto-flip to RECEIVED by another request). Our
      // movement is durable but the PO will not record it: precisely undo it, and
      // release the claim ONLY if the row was actually restored. If the undo
      // no-ops (H4 — a concurrent movement built on the row) we KEEP the claim so
      // the remaining stays blocked and nothing can over-receive on top of the
      // durable orphan; the on-hand is still truthful.
      const restored = await undoStockInMovement(businessId, move);
      if (restored) {
        try {
          await releaseClaim({ poId, oidBiz, productId, quantity: step.quantity, claimId });
        } catch (releaseErr) {
          console.error(
            `[purchase-orders] receive: could not release claim ${String(claimId)} after a precise undo: ${(releaseErr as { message?: unknown }).message}`
          );
        }
      } else {
        console.error(
          `[purchase-orders] receive: finalize lost for claim ${String(claimId)} and its movement could not be undone (txn ${String(move.transaction.id)}) — KEEPING the claim so the durable orphan cannot be over-received`
        );
      }
      await throwPartial();
    }

    applied.push({
      productId: step.productId,
      quantity: step.quantity,
      previousQuantity: move.previousQuantity,
      newQuantity: move.newQuantity,
      inventoryTransactionId: String(move.transaction.id),
    });
  }

  // Whole batch landed. If every line is now complete, flip OPEN -> RECEIVED
  // (guarded and idempotent; a concurrent winner or a racing cancel is left
  // untouched — the fresh detail in the response shows the true state).
  // `poId`/`oidBiz` name the order `fetchPo` loaded a moment ago, so the read is
  // present; the assertion is what says so, since `.lean()` types it as nullable.
  const fresh = await PurchaseOrder.findOne({ _id: poId, businessId: oidBiz }).lean<PurchaseOrderSource>();
  const allReceived = fresh!.items.every((item) => (item.quantityReceived || 0) >= item.quantityOrdered);
  if (allReceived) {
    await PurchaseOrder.findOneAndUpdate(
      { _id: poId, businessId: oidBiz, status: 'OPEN' },
      { $set: { status: 'RECEIVED' } }
    );
  }

  await recordPoAudit(businessId, userId, AUDIT_ACTIONS.PURCHASE_ORDER_RECEIVED, poId, {
    number: po.number,
    status: allReceived ? 'RECEIVED' : 'OPEN',
    reference: reference || undefined,
    receivedLines: applied.map((a) => ({
      productId: a.productId,
      quantity: a.quantity,
      inventoryTransactionId: a.inventoryTransactionId,
    })),
  });

  return { allReceived, applied, po: detailPublic(await fetchPo(businessId, id)) };
}

export const purchaseOrderService = {
  create,
  list,
  get,
  update,
  issue,
  cancel,
  receive,
};

// Claim/finalize/release primitives exported for the DB-backed test suite
// (phase13-receiving) so release/finalize-by-claimId exactness and idempotence
// can be exercised deterministically against seeded claims. Not part of the
// service object consumed by the controllers.
export { claimRemaining, finalizeClaim, releaseClaim };

export default purchaseOrderService;
