import mongoose from 'mongoose';

import InventoryTransaction, {
  TRANSFER_LEDGER_INDEX,
} from '../models/inventoryTransaction.model.ts';

// Re-exported for the migration CLI and tests that imported the guard here
// before it moved next to the schema declaration.
export { TRANSFER_LEDGER_INDEX };

export const TRANSFER_LEDGER_QUARANTINE_COLLECTION = 'inventory_transaction_quarantine';

export type LedgerRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  productId?: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  transferOperationId?: mongoose.Types.ObjectId;
  type?: string;
  quantity?: number;
  previousQuantity?: number;
  newQuantity?: number;
  reason?: string;
  reference?: string;
  purchaseOrderClaimId?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

export type DuplicateGroup = {
  key: {
    businessId: string;
    transferOperationId: string;
    locationId: string;
  };
  rows: LedgerRow[];
};

export type MigrationPlan = {
  groups: DuplicateGroup[];
  exact: DuplicateGroup[];
  ambiguous: DuplicateGroup[];
  duplicateRows: number;
};

export type MigrationSummary = {
  status: 'CLEAN' | 'READY' | 'BLOCKED' | 'APPLIED';
  database: string;
  apply: boolean;
  indexPresent: boolean;
  indexCreated: boolean;
  duplicateGroups: number;
  duplicateRows: number;
  exactGroups: number;
  ambiguousGroups: number;
  /** A same-key index that is not the unique partial guard; apply must refuse before writing. */
  indexConflict: string | null;
  /** Why apply is blocked; null when the plan can proceed. */
  blockedReason: string | null;
  quarantined: number;
  removed: number;
  kept: number;
  ambiguous: Array<{
    businessId: string;
    transferOperationId: string;
    locationId: string;
    reasons: string[];
  }>;
};

function id(value: unknown): string {
  return value == null ? '' : String(value);
}

function comparable(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'object') return String(value);
  return value as string | number | boolean;
}

/**
 * The fields that make two ledger rows the same movement. `_id`, `createdAt` and
 * `updatedAt` are deliberately excluded: a racing retry writes the same leg a
 * moment later, and those differences are not different stock. Anything else
 * that differs makes the group ambiguous, including its quantities, product,
 * user, reference and PO claim.
 */
function rowIdentity(row: LedgerRow): Record<string, string | number | boolean | null> {
  return {
    businessId: id(row.businessId),
    transferOperationId: id(row.transferOperationId),
    locationId: id(row.locationId),
    productId: id(row.productId),
    type: comparable(row.type),
    quantity: comparable(row.quantity),
    previousQuantity: comparable(row.previousQuantity),
    newQuantity: comparable(row.newQuantity),
    reason: comparable(row.reason),
    reference: comparable(row.reference),
    purchaseOrderClaimId: id(row.purchaseOrderClaimId) || null,
    userId: id(row.userId),
  };
}

/** A group is exact only when every row would pass the same unique guard as the same movement. */
export function isExactDuplicateGroup(rows: LedgerRow[]): boolean {
  if (rows.length < 2) return true;
  const first = JSON.stringify(rowIdentity(rows[0]!));
  return rows.every((row) => JSON.stringify(rowIdentity(row)) === first);
}

/** Why a group cannot be deduplicated automatically; empty for an exact group. */
export function duplicateGroupProblems(rows: LedgerRow[]): string[] {
  if (rows.length < 2 || isExactDuplicateGroup(rows)) return [];
  const fields = [
    'productId',
    'type',
    'quantity',
    'previousQuantity',
    'newQuantity',
    'reason',
    'reference',
    'purchaseOrderClaimId',
    'userId',
  ] as const;
  const problems: string[] = [];
  for (const field of fields) {
    const values = new Set(rows.map((row) => JSON.stringify(comparable(row[field]))));
    if (values.size > 1) problems.push(`${field} differs`);
  }
  return problems.length > 0 ? problems : ['rows differ outside the compared fields'];
}

function timestampOf(row: LedgerRow): number {
  const value = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Oldest row first; `_id` breaks a timestamp tie deterministically. */
export function orderDuplicateRows(rows: LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) => {
    const byTime = timestampOf(a) - timestampOf(b);
    if (byTime !== 0) return byTime;
    return String(a._id).localeCompare(String(b._id));
  });
}

export function buildMigrationPlan(groups: DuplicateGroup[]): MigrationPlan {
  const exact: DuplicateGroup[] = [];
  const ambiguous: DuplicateGroup[] = [];
  for (const group of groups) {
    if (isExactDuplicateGroup(group.rows)) exact.push(group);
    else ambiguous.push(group);
  }
  return {
    groups,
    exact,
    ambiguous,
    duplicateRows: groups.reduce((sum, group) => sum + Math.max(0, group.rows.length - 1), 0),
  };
}

/** Every duplicate key carrying a real transfer operation id. Bounded for an operator run. */
export async function findTransferLedgerDuplicates({
  limit = 500,
}: { limit?: number } = {}): Promise<DuplicateGroup[]> {
  const rows = await InventoryTransaction.aggregate<{
    _id: {
      businessId: mongoose.Types.ObjectId;
      transferOperationId: mongoose.Types.ObjectId;
      locationId: mongoose.Types.ObjectId;
    };
    count: number;
  }>([
    {
      // Match the index predicate, not a narrower type filter: a row of any
      // type carrying a real operation id occupies the same unique key.
      $match: {
        transferOperationId: { $type: 'objectId' },
      },
    },
    {
      $group: {
        _id: {
          businessId: '$businessId',
          transferOperationId: '$transferOperationId',
          locationId: '$locationId',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    {
      $sort: {
        '_id.businessId': 1,
        '_id.transferOperationId': 1,
        '_id.locationId': 1,
      },
    },
    { $limit: Math.max(1, Math.min(limit, 5_000)) },
  ]).allowDiskUse(true);

  const groups: DuplicateGroup[] = [];
  for (const entry of rows) {
    const { businessId, transferOperationId, locationId } = entry._id;
    const documents = (await InventoryTransaction.find({
      businessId,
      transferOperationId,
      locationId,
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as LedgerRow[];
    groups.push({
      key: {
        businessId: id(businessId),
        transferOperationId: id(transferOperationId),
        locationId: id(locationId),
      },
      rows: documents,
    });
  }
  return groups;
}

type IndexInspection = {
  compatible: Record<string, unknown> | null;
  conflict: string | null;
};

function keyOf(index: Record<string, unknown>): Record<string, unknown> | undefined {
  return index.key as Record<string, unknown> | undefined;
}

function hasTransferLedgerKey(index: Record<string, unknown>): boolean {
  const key = keyOf(index);
  return key?.businessId === 1 && key?.transferOperationId === 1 && key?.locationId === 1;
}

/**
 * The key alone is not enough: a legacy non-unique or non-partial index with the
 * same key cannot coexist with a unique build, and creating it would fail only
 * after duplicates had already been removed. Treat any other same-key index as
 * a conflict that blocks apply before the first write.
 */
async function inspectIndex(): Promise<IndexInspection> {
  let indexes: Array<Record<string, unknown>>;
  try {
    indexes = (await InventoryTransaction.collection.indexes()) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    if ((err as { codeName?: unknown }).codeName === 'NamespaceNotFound') {
      return { compatible: null, conflict: null };
    }
    throw err;
  }
  const sameKey = indexes.filter(hasTransferLedgerKey);
  const compatible =
    sameKey.find(
      (index) =>
        index.unique === true &&
        JSON.stringify(index.partialFilterExpression ?? null) ===
          JSON.stringify(TRANSFER_LEDGER_INDEX.partialFilterExpression)
    ) ?? null;
  if (compatible) return { compatible, conflict: null };
  const conflict = sameKey[0];
  return {
    compatible: null,
    conflict: conflict ? String(conflict.name ?? '(unnamed)') : null,
  };
}

async function quarantineRow(
  row: LedgerRow,
  { keptId, now }: { keptId: string; now: Date }
): Promise<boolean> {
  const collection = mongoose.connection.collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION);
  const existing = (await collection.findOne({ _id: row._id })) as unknown as LedgerRow | null;
  if (existing) {
    // A retry normally finds the same copy. A different copy means the row was
    // edited after an earlier quarantine, so deleting it now would destroy
    // evidence that no longer matches the copy. Stop before the delete.
    if (JSON.stringify(rowIdentity(existing)) !== JSON.stringify(rowIdentity(row))) {
      throw new Error(
        `the quarantine copy for ${String(row._id)} differs from the current ledger row; ` +
          'nothing was deleted. Resolve the duplicate by hand.'
      );
    }
    return false;
  }
  const { _id, ...fields } = row;
  await collection.updateOne(
    { _id },
    {
      $setOnInsert: {
        ...fields,
        quarantineReason: 'DUPLICATE_TRANSFER_LEDGER_LEG',
        quarantinedAt: now,
        keptId,
      },
    },
    { upsert: true }
  );
  return true;
}

/**
 * Delete only rows whose full movement identity still matches the quarantined
 * copy. If a concurrent writer changed the row after the snapshot, the delete
 * matches nothing and the migration stops instead of destroying new evidence.
 */
async function removeDuplicateRow(row: LedgerRow): Promise<boolean> {
  const result = await InventoryTransaction.deleteOne({
    _id: row._id,
    businessId: row.businessId,
    transferOperationId: row.transferOperationId,
    locationId: row.locationId,
    productId: row.productId,
    type: row.type,
    quantity: row.quantity,
    previousQuantity: row.previousQuantity,
    newQuantity: row.newQuantity,
    reason: row.reason ?? null,
    reference: row.reference ?? null,
    purchaseOrderClaimId: row.purchaseOrderClaimId ?? null,
    userId: row.userId,
    ...(row.userId ? {} : { userId: { $exists: false } }),
  });
  return result.deletedCount === 1;
}

/**
 * Preflight or apply the migration. Ambiguity is decided before the first write,
 * so a blocked run never changes a row. Apply writes every duplicate copy to the
 * quarantine collection before deleting it; a crash between those two steps is
 * idempotent because the quarantine upsert is keyed by the original `_id`.
 */
export async function runTransferLedgerMigration({
  apply = false,
  limit = 500,
  now = new Date(),
}: {
  apply?: boolean;
  limit?: number;
  now?: Date;
} = {}): Promise<MigrationSummary> {
  const database = mongoose.connection.name || '(unconnected)';
  const groups = await findTransferLedgerDuplicates({ limit });
  const plan = buildMigrationPlan(groups);
  const index = await inspectIndex();
  const summary: MigrationSummary = {
    status: 'CLEAN',
    database,
    apply,
    indexPresent: index.compatible != null,
    indexCreated: false,
    duplicateGroups: groups.length,
    duplicateRows: plan.duplicateRows,
    exactGroups: plan.exact.length,
    ambiguousGroups: plan.ambiguous.length,
    indexConflict: index.conflict,
    blockedReason: null,
    quarantined: 0,
    removed: 0,
    kept: 0,
    ambiguous: plan.ambiguous.map((group) => ({
      ...group.key,
      reasons: duplicateGroupProblems(group.rows),
    })),
  };

  if (plan.ambiguous.length > 0) {
    summary.status = 'BLOCKED';
    summary.blockedReason = `${plan.ambiguous.length} duplicate group(s) are ambiguous`;
    return summary;
  }

  if (index.conflict) {
    summary.status = 'BLOCKED';
    summary.blockedReason =
      `index "${index.conflict}" has the transfer-ledger key but is not the unique ` +
      'partial guard; drop or rebuild it after review before applying';
    return summary;
  }

  // A capped scan cannot prove that nothing was left behind. Building the index
  // after removing only the first page would fail after partial writes, so stop
  // before any write and make the operator raise --limit.
  if (groups.length >= limit) {
    summary.status = 'BLOCKED';
    summary.blockedReason =
      `duplicate scan reached --limit=${limit}; rerun with a larger limit so ` +
      'the whole collection is inspected';
    return summary;
  }

  if (!apply) {
    summary.status = groups.length > 0 || !index.compatible ? 'READY' : 'CLEAN';
    return summary;
  }

  for (const group of plan.exact) {
    const ordered = orderDuplicateRows(group.rows);
    const keep = ordered[0]!;
    for (const row of ordered.slice(1)) {
      const inserted = await quarantineRow(row, { keptId: String(keep._id), now });
      if (inserted) summary.quarantined += 1;
      if (!(await removeDuplicateRow(row))) {
        throw new Error(
          `a duplicate transfer ledger row changed during migration (${String(row._id)}); ` +
            'its quarantine copy exists and the index was not built. Re-run the preflight.'
        );
      }
      summary.removed += 1;
    }
    summary.kept += 1;
  }

  if (!index.compatible) {
    await InventoryTransaction.collection.createIndex(TRANSFER_LEDGER_INDEX.key, {
      name: TRANSFER_LEDGER_INDEX.name,
      unique: true,
      partialFilterExpression: TRANSFER_LEDGER_INDEX.partialFilterExpression,
    });
    summary.indexCreated = true;
  }
  const after = await inspectIndex();
  if (!after.compatible) {
    throw new Error('the unique transfer ledger index was not present after creation');
  }
  summary.indexPresent = true;
  summary.status = 'APPLIED';
  return summary;
}
