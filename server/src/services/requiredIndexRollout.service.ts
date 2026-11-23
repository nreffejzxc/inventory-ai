import AuditLog, { AUDIT_DEDUPE_INDEX } from '../models/auditLog.model.ts';
import AuditOutbox, {
  AUDIT_OUTBOX_DELIVERED_TTL_INDEX,
} from '../models/auditOutbox.model.ts';
import InventoryTransaction, {
  TRANSFER_LEDGER_INDEX,
} from '../models/inventoryTransaction.model.ts';
import PurchaseOrder, {
  PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX,
  PURCHASE_ORDER_REQUEST_KEY_INDEX,
} from '../models/purchaseOrder.model.ts';
import StockMovementOperation, {
  MOVEMENT_AUDIT_REPAIR_INDEX,
} from '../models/stockMovementOperation.model.ts';
import {
  evaluateRequiredIndex,
  type RequiredIndexSpec,
} from '../config/indexReadiness.ts';

/**
 * Deployment-side rollout for the six indexes that `/api/health/ready` and the
 * production boot log already require: the transfer-ledger, Draft PO request-key
 * and audit-dedupe unique guards, the DELIVERED outbox TTL, and the movement and
 * PO-receive audit-repair scans.
 *
 * The readiness checker only reads. This service is the matching write path for
 * an operator: it inspects the exact declared spec, performs a duplicate-key
 * preflight when applying a unique index, and creates only that one index. It
 * never calls `syncIndexes()`, never drops an index, and never removes a document.
 *
 * Existing duplicate keys are a data decision. The service reports the groups
 * and stops before creating anything, so an operator can resolve them by hand.
 */

export type RequiredIndexCollection = {
  indexes: () => Promise<unknown[]>;
  aggregate: (
    pipeline: Record<string, unknown>[],
    options?: { allowDiskUse?: boolean; maxTimeMS?: number },
  ) => { toArray: () => Promise<unknown[]> };
  createIndex: (
    key: Readonly<Record<string, number>>,
    options: {
      name?: string;
      unique?: true;
      partialFilterExpression?: Readonly<Record<string, unknown>>;
      expireAfterSeconds?: number;
    },
  ) => Promise<unknown>;
};

export type RequiredIndexTarget = {
  label: string;
  spec: RequiredIndexSpec;
  collection: RequiredIndexCollection;
};

export type RequiredIndexRolloutStatus =
  | 'READY'
  | 'MISSING'
  | 'WRONG_SHAPE'
  | 'BLOCKED_DUPLICATES'
  | 'CREATED'
  | 'FAILED';

export type DuplicateGroup = {
  _id?: Record<string, unknown>;
  count?: number;
};

export type DuplicatePreflight = {
  total: number;
  sample: DuplicateGroup[];
  truncated: boolean;
};

export type RequiredIndexResult = {
  label: string;
  name: string;
  status: RequiredIndexRolloutStatus;
  reason: string | null;
  duplicateGroups?: number;
  duplicateSample?: DuplicateGroup[];
  truncated?: boolean;
};

export type RequiredIndexRolloutSummary = {
  apply: boolean;
  ready: boolean;
  changed: number;
  attention: number;
  results: RequiredIndexResult[];
};

export const DEFAULT_DUPLICATE_LIMIT = 100;
export const MAX_DUPLICATE_LIMIT = 1_000;

/**
 * The live collection bindings, in the same order as readiness. A caller may
 * inject fakes; the CLI uses these defaults after connecting with `autoIndex:
 * false`, so merely importing the service does not create an index.
 */
export const REQUIRED_INDEX_TARGETS: readonly RequiredIndexTarget[] = [
  {
    label: 'inventory_transactions',
    spec: TRANSFER_LEDGER_INDEX,
    collection: InventoryTransaction.collection as unknown as RequiredIndexCollection,
  },
  {
    label: 'purchase_orders',
    spec: PURCHASE_ORDER_REQUEST_KEY_INDEX,
    collection: PurchaseOrder.collection as unknown as RequiredIndexCollection,
  },
  {
    label: 'audit_logs',
    spec: AUDIT_DEDUPE_INDEX,
    collection: AuditLog.collection as unknown as RequiredIndexCollection,
  },
  {
    label: 'audit_outbox',
    spec: AUDIT_OUTBOX_DELIVERED_TTL_INDEX,
    collection: AuditOutbox.collection as unknown as RequiredIndexCollection,
  },
  {
    label: 'stock_movement_operations',
    spec: MOVEMENT_AUDIT_REPAIR_INDEX,
    collection: StockMovementOperation.collection as unknown as RequiredIndexCollection,
  },
  {
    label: 'purchase_orders',
    spec: PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX,
    collection: PurchaseOrder.collection as unknown as RequiredIndexCollection,
  },
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameOrderedKey(actual: unknown, expected: Readonly<Record<string, number>>): boolean {
  const entries = Object.entries(record(actual) ?? {});
  const expectedEntries = Object.entries(expected);
  return (
    entries.length === expectedEntries.length &&
    entries.every(
      ([field, direction], index) =>
        field === expectedEntries[index]?.[0] && direction === expectedEntries[index]?.[1],
    )
  );
}

function hasExactKey(indexes: unknown[], spec: RequiredIndexSpec): boolean {
  return indexes.some((index) => sameOrderedKey(record(index)?.key, spec.key));
}

function safeFailureCode(err: unknown): string {
  const value = record(err);
  const code = value?.codeName ?? value?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'unknown error';
}

function isMissingNamespace(err: unknown): boolean {
  return record(err)?.codeName === 'NamespaceNotFound';
}

async function listIndexes(collection: RequiredIndexCollection): Promise<unknown[]> {
  try {
    return await collection.indexes();
  } catch (err) {
    if (isMissingNamespace(err)) return [];
    throw err;
  }
}

/**
 * The exact duplicate preflight for one required unique partial index.
 *
 * `$match` is the index's own partial filter, so rows outside the index are
 * excluded exactly as MongoDB would exclude them. Grouping by every key field
 * finds the collisions that would make the unique build fail. `$facet` returns
 * a bounded sample plus the full group count, so a large result cannot flood a
 * terminal or hide the fact that more groups exist.
 */
export function duplicatePreflightPipeline(
  spec: RequiredIndexSpec,
  limit: number = DEFAULT_DUPLICATE_LIMIT,
): Record<string, unknown>[] {
  if (spec.unique !== true) {
    throw new Error('duplicate preflight requires a unique index spec');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DUPLICATE_LIMIT) {
    throw new RangeError(`duplicate limit must be an integer from 1 to ${MAX_DUPLICATE_LIMIT}`);
  }
  const groupId = Object.fromEntries(
    Object.keys(spec.key).map((field) => [field, `$${field}`]),
  );
  return [
    { $match: spec.partialFilterExpression },
    { $group: { _id: groupId, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    {
      $facet: {
        total: [{ $count: 'groups' }],
        sample: [{ $limit: limit }],
      },
    },
  ];
}

async function readDuplicates(
  collection: RequiredIndexCollection,
  spec: RequiredIndexSpec,
  limit: number,
): Promise<DuplicatePreflight> {
  const rows = await collection
    .aggregate(duplicatePreflightPipeline(spec, limit), {
      allowDiskUse: true,
      maxTimeMS: 60_000,
    })
    .toArray();
  const facet = record(rows[0]);
  const totals = Array.isArray(facet?.total) ? facet.total : [];
  const sample = (Array.isArray(facet?.sample) ? facet.sample : [])
    .map(record)
    .filter((group): group is DuplicateGroup => group != null);
  const reported = Number(record(totals[0])?.groups);
  const total = Number.isInteger(reported) && reported >= 0 ? reported : sample.length;
  return { total, sample, truncated: total > sample.length };
}

function createIndexOptions(spec: RequiredIndexSpec): {
  name?: string;
  unique?: true;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
  expireAfterSeconds?: number;
} {
  const options: {
    name?: string;
    unique?: true;
    partialFilterExpression?: Readonly<Record<string, unknown>>;
    expireAfterSeconds?: number;
  } = {};
  // A plain repair index has no option worth naming it for. Letting MongoDB
  // generate the name keeps this create path identical to the model's unnamed
  // declaration, so a later boot adopts the index instead of conflicting.
  if (spec.unique === true || spec.expireAfterSeconds !== undefined) {
    options.name = spec.name;
  }
  if (spec.unique === true) options.unique = true;
  if (spec.partialFilterExpression !== undefined) {
    options.partialFilterExpression = spec.partialFilterExpression;
  }
  if (spec.expireAfterSeconds !== undefined) {
    options.expireAfterSeconds = spec.expireAfterSeconds;
  }
  return options;
}

function baseResult(
  target: RequiredIndexTarget,
  status: RequiredIndexRolloutStatus,
  reason: string | null,
  extra: Partial<RequiredIndexResult> = {},
): RequiredIndexResult {
  return {
    label: target.label,
    name: target.spec.name,
    status,
    reason,
    ...extra,
  };
}

/**
 * Inspect or apply every required index in order.
 *
 * Without `apply` this is a read-only report. With `apply`, a target is created
 * only when its duplicate preflight is empty. A failure on one target does not
 * prevent later independent targets from being inspected or created.
 */
export async function rolloutRequiredIndexes({
  apply = false,
  duplicateLimit = DEFAULT_DUPLICATE_LIMIT,
  targets = REQUIRED_INDEX_TARGETS,
}: {
  apply?: boolean;
  duplicateLimit?: number;
  targets?: readonly RequiredIndexTarget[];
} = {}): Promise<RequiredIndexRolloutSummary> {
  if (
    !Number.isInteger(duplicateLimit) ||
    duplicateLimit < 1 ||
    duplicateLimit > MAX_DUPLICATE_LIMIT
  ) {
    throw new RangeError(
      `duplicate limit must be an integer from 1 to ${MAX_DUPLICATE_LIMIT}`,
    );
  }

  const results: RequiredIndexResult[] = [];

  for (const target of targets) {
    let indexes: unknown[];
    try {
      indexes = await listIndexes(target.collection);
    } catch {
      results.push(
        baseResult(target, 'FAILED', 'the index list could not be inspected; nothing was changed'),
      );
      continue;
    }

    const readiness = evaluateRequiredIndex(indexes, target.spec);
    if (readiness.ready) {
      results.push(baseResult(target, 'READY', null));
      continue;
    }

    if (!apply) {
      const status = hasExactKey(indexes, target.spec) ? 'WRONG_SHAPE' : 'MISSING';
      results.push(baseResult(target, status, readiness.reason));
      continue;
    }

    if (target.spec.unique === true) {
      let duplicates: DuplicatePreflight;
      try {
        duplicates = await readDuplicates(target.collection, target.spec, duplicateLimit);
      } catch (err) {
        results.push(
          baseResult(
            target,
            'FAILED',
            `the duplicate preflight failed (${safeFailureCode(err)}); nothing was created`,
          ),
        );
        continue;
      }

      if (duplicates.total > 0) {
        results.push(
          baseResult(
            target,
            'BLOCKED_DUPLICATES',
            `${duplicates.total} duplicate key group(s) exist; resolve them before building the index`,
            {
              duplicateGroups: duplicates.total,
              duplicateSample: duplicates.sample,
              ...(duplicates.truncated ? { truncated: true } : {}),
            },
          ),
        );
        continue;
      }
    }

    try {
      await target.collection.createIndex(
        target.spec.key,
        createIndexOptions(target.spec),
      );
    } catch (err) {
      results.push(
        baseResult(
          target,
          'FAILED',
          `index creation failed (${safeFailureCode(err)}); no index was dropped`,
        ),
      );
      continue;
    }

    let after: unknown[];
    try {
      after = await listIndexes(target.collection);
    } catch {
      results.push(
        baseResult(target, 'FAILED', 'the new index could not be re-inspected'),
      );
      continue;
    }

    const verified = evaluateRequiredIndex(after, target.spec);
    results.push(
      verified.ready
        ? baseResult(target, 'CREATED', null)
        : baseResult(
            target,
            'FAILED',
            `the index was created but does not match the required definition: ${
              verified.reason ?? 'unknown mismatch'
            }`,
          ),
    );
  }

  const ready = results.every(
    (result) => result.status === 'READY' || result.status === 'CREATED',
  );
  return {
    apply,
    ready,
    changed: results.filter((result) => result.status === 'CREATED').length,
    attention: results.filter(
      (result) => result.status !== 'READY' && result.status !== 'CREATED',
    ).length,
    results,
  };
}
