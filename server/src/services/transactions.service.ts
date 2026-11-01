import mongoose from 'mongoose';
import type { PipelineStage } from 'mongoose';

import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import { transactionPublic } from './inventory.service.ts';

/** The ledger filter this service builds, typed from the model itself. */
type TransactionFilter = mongoose.QueryFilter<mongoose.HydratedDocFromModel<typeof InventoryTransaction>>;

/** The filters `list` accepts, already validated by the caller. */
type HistoryFilters = {
  productId?: string;
  locationId?: string;
  type?: string;
  from?: string;
  to?: string;
  skip: number;
  limit: number;
};

const { ObjectId } = mongoose.Types;
const oid = (id: string | mongoose.Types.ObjectId) => new ObjectId(id);

/** The filters that identify a history set, before the page window is applied. */
type HistoryFilterInput = Omit<HistoryFilters, 'skip' | 'limit'>;

/**
 * One definition of what a history query selects, shared by the page and by the
 * transfer statistics. Keeping them together is what stops the logical count from
 * describing a different set of rows than the page it is attached to.
 */
function historyMatch(businessId: string, { productId, locationId, type, from, to }: HistoryFilterInput): TransactionFilter {
  const match: TransactionFilter = { businessId: oid(businessId) };
  if (productId) match.productId = oid(productId);
  if (locationId) match.locationId = oid(locationId);
  if (type) match.type = type;

  const created: { $gte?: Date; $lte?: Date } = {};
  if (from) created.$gte = new Date(from);
  if (to) created.$lte = new Date(to);
  if (created.$gte || created.$lte) match.createdAt = created;
  return match;
}

export const TRANSACTION_TYPES = Object.freeze(['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT', 'TRANSFER']);

/** The `$lookup`-joined product/location document, read only for `_id`/`name`. */
type RefSource = { _id?: unknown; name?: unknown };

function ref(obj: RefSource | null | undefined) {
  return obj && obj._id ? { id: String(obj._id), name: obj.name } : null;
}

/**
 * A ledger row after the `$lookup` stages, so it carries the joined product and
 * location alongside the fields `transactionPublic` reads.
 */
type HistoryRow = Parameters<typeof transactionPublic>[0] & {
  product?: RefSource | null;
  location?: RefSource | null;
};

/** Transaction history item: transaction fields plus product/location names. */
export function historyItemPublic(item: HistoryRow) {
  return {
    ...transactionPublic(item),
    product: ref(item.product),
    location: ref(item.location),
  };
}

/**
 * Read-only inventory transaction history (the "Inventory History" screen).
 * Always newest-first; optionally filtered by product, location, type, and a
 * createdAt range. Every query is scoped by the server-derived businessId.
 *
 * Also the ledger behind the assistant's `getInventoryHistory` tool, whose cost is
 * why the page window sits above the joins — see the comment on the pipeline.
 */
export const transactionsService = {
  async list(businessId: string, { productId, locationId, type, from, to, skip, limit }: HistoryFilters) {
    const bizOid = oid(businessId);
    const match = historyMatch(businessId, { productId, locationId, type, from, to });

    // The page is selected BEFORE the joins, not after them.
    //
    // Measured 2026-10-13 against a synthetic 10 000-product tenant (20 105
    // inventory rows, 19 944 transactions): the two `$lookup` stages below ran once
    // per MATCHED TRANSACTION — about 0.15 ms each, but 19 944 of them, so the joins
    // cost 3.0 s and 2.8 s to fill a 15-row page. `explain('executionStats')` showed
    // the fan-out plainly: nReturned=19944 at each join, 0.036 s for the `$match`
    // itself. The old shape could not avoid it, because the page window lived in the
    // `$facet` at the very bottom of the pipeline and a facet cannot be reached
    // without running everything above it.
    //
    // Moving `$skip`/`$limit` up is safe here and provably output-identical:
    //
    //   * `{ createdAt: -1, _id: -1 }` is a TOTAL order and is served by the Phase
    //     20C index, so the first `limit` rows of the sorted stream are the same rows
    //     the facet used to select — the page cannot shift.
    //   * Nothing between this `$match` and the old `$facet` filtered anything: the
    //     joins only ADD `product`/`location`, and a transaction whose product or
    //     location is missing already came back with a null ref rather than being
    //     dropped. So `metadata` counted exactly the documents `{ $match }` matches,
    //     which is what the separate `$count` below counts — the totals are equal by
    //     construction, not by assumption.
    //
    // After the move, the joins run for at most `limit` rows, which is what makes
    // this page O(page) instead of O(tenant history).
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'products',
          let: { pid: '$productId' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$businessId', bizOid] }, { $eq: ['$_id', '$$pid'] }] } } },
          ],
          as: 'product',
        },
      },
      {
        $lookup: {
          from: 'locations',
          let: { lid: '$locationId' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$businessId', bizOid] }, { $eq: ['$_id', '$$lid'] }] } } },
          ],
          as: 'location',
        },
      },
      {
        $addFields: {
          product: { $arrayElemAt: ['$product', 0] },
          location: { $arrayElemAt: ['$location', 0] },
        },
      },
    ];

    // The count stays a separate aggregation over the SAME `$match` (run in
    // parallel, so it costs the page nothing): `$count` on an indexed match is an
    // index scan, where the old `$facet.metadata` had to receive every doc after
    // the joins. `$count` yields no document at all when nothing matches, hence the
    // `?? 0`.
    const [rows, counted] = await Promise.all([
      InventoryTransaction.aggregate(pipeline),
      InventoryTransaction.aggregate([{ $match: match }, { $count: 'total' }]),
    ]);

    const items = rows.map(historyItemPublic);
    const total = counted[0]?.total ?? 0;
    return { items, total };
  },

  /**
   * The transfer rows and distinct transfer references in the SAME history set.
   *
   * A transfer is one event and two ledger rows, so the assistant's logical count is
   * `rows - transferRows + transferReferences`: every non-transfer row is one event, and
   * every reference is one event however many of its legs match the filter. A location
   * filter leaves one leg per reference, which is still one event at that location.
   *
   * The History screen keeps the raw `total`; only the assistant asks for this.
   */
  async transferStats(businessId: string, filters: HistoryFilterInput) {
    const match = historyMatch(businessId, filters);
    const [stats] = await InventoryTransaction.aggregate([
      { $match: { ...match, type: 'TRANSFER', reference: { $ne: null } } },
      { $group: { _id: '$reference', legs: { $sum: 1 } } },
      { $group: { _id: null, rows: { $sum: '$legs' }, events: { $sum: 1 } } },
    ]);
    return { rows: stats?.rows ?? 0, events: stats?.events ?? 0 };
  },
};

export default transactionsService;
