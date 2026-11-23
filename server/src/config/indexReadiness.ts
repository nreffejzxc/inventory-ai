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

/**
 * Fail-closed readiness for the indexes durable writes and recovery depend on.
 *
 * `/api/health/ready` is what an orchestrator uses to decide whether this
 * process may receive traffic. A reachable database is not enough: the exact
 * unique partial indexes that guard replayable writes must be present, and the
 * retention/repair indexes that keep the outbox bounded and recovery cheap must
 * exist too. A missing, differently-keyed, differently-filtered, wrongly unique
 * or wrongly expiring index is reported as not ready instead of being mistaken
 * for a healthy deployment.
 *
 * The checker only reads `listIndexes`; it never creates, drops or repairs an
 * index. That keeps readiness safe to poll and leaves index changes to the
 * reviewed migration command.
 */

export type IndexReadiness = {
  ready: boolean;
  name: string;
  reason: string | null;
};

export type RequiredIndexesReadiness = {
  ready: boolean;
  failures: Array<{ name: string; reason: string }>;
};

/**
 * The exact shape a required index must have in MongoDB. `unique`, the partial
 * filter and the TTL are optional so one evaluator can cover a write guard, a
 * partial TTL and a plain repair scan without weakening any of them.
 */
export type RequiredIndexSpec = {
  readonly name: string;
  readonly key: Readonly<Record<string, number>>;
  readonly unique?: true;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly expireAfterSeconds?: number;
};

/** Used by the boot line so the count cannot drift from the checks below. */
export const REQUIRED_INDEX_SPECS: readonly RequiredIndexSpec[] = [
  TRANSFER_LEDGER_INDEX,
  PURCHASE_ORDER_REQUEST_KEY_INDEX,
  AUDIT_DEDUPE_INDEX,
  AUDIT_OUTBOX_DELIVERED_TTL_INDEX,
  MOVEMENT_AUDIT_REPAIR_INDEX,
  PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX,
];

/** A readiness probe must not wait indefinitely on a wedged database. */
export const INDEX_INSPECTION_TIMEOUT_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('index inspection timed out')),
      timeoutMs
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

type IndexDescription = {
  name?: unknown;
  key?: unknown;
  unique?: unknown;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: unknown;
};

type IndexModel = {
  collection: {
    indexes: () => Promise<unknown[]>;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Stable JSON for deeply nested filter documents, independent of key order. */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function keyEquals(actual: unknown, expected: Readonly<Record<string, number>>): boolean {
  const entries = Object.entries(record(actual) ?? {});
  const expectedEntries = Object.entries(expected);
  return (
    entries.length === expectedEntries.length &&
    entries.every(
      ([field, direction], index) =>
        field === expectedEntries[index]?.[0] && direction === expectedEntries[index]?.[1]
    )
  );
}

function sameFieldSet(actual: unknown, expected: Readonly<Record<string, number>>): boolean {
  const fields = Object.keys(record(actual) ?? {}).sort();
  return fields.join(',') === Object.keys(expected).sort().join(',');
}

function samePartialFilter(index: IndexDescription, spec: RequiredIndexSpec): boolean {
  return (
    canonical(index.partialFilterExpression ?? null) ===
    canonical(spec.partialFilterExpression ?? null)
  );
}

function sameUniqueness(index: IndexDescription, spec: RequiredIndexSpec): boolean {
  return spec.unique === true ? index.unique === true : index.unique !== true;
}

function sameTtl(index: IndexDescription, spec: RequiredIndexSpec): boolean {
  return spec.expireAfterSeconds === undefined
    ? index.expireAfterSeconds === undefined
    : index.expireAfterSeconds === spec.expireAfterSeconds;
}

function matchesSpec(index: IndexDescription, spec: RequiredIndexSpec): boolean {
  return (
    sameUniqueness(index, spec) &&
    samePartialFilter(index, spec) &&
    sameTtl(index, spec)
  );
}

function requiredIndexLabel(spec: RequiredIndexSpec): string {
  const qualifiers = [
    spec.unique === true ? 'unique' : null,
    spec.partialFilterExpression !== undefined ? 'partial' : null,
  ].filter((value): value is string => value !== null);
  const kind = spec.expireAfterSeconds !== undefined ? 'TTL index' : 'index';
  return `required ${qualifiers.length > 0 ? `${qualifiers.join(' ')} ` : ''}${kind}`;
}

function reasonForCandidate(index: IndexDescription, spec: RequiredIndexSpec): string {
  const name = String(index.name ?? '(unnamed)');
  const problems: string[] = [];
  if (spec.unique === true && index.unique !== true) problems.push('is not unique');
  if (spec.unique !== true && index.unique === true) problems.push('is unexpectedly unique');
  if (!samePartialFilter(index, spec)) {
    problems.push(
      spec.partialFilterExpression !== undefined
        ? 'has a different partial filter'
        : 'has an unexpected partial filter'
    );
  }
  if (!sameTtl(index, spec)) {
    problems.push(
      spec.expireAfterSeconds !== undefined
        ? 'has a different TTL'
        : 'has an unexpected TTL'
    );
  }
  return `index "${name}" ${problems.join(' and ') || 'does not match the required index'}`;
}

/**
 * Evaluate already-listed index descriptions against one required spec. Pure,
 * so every rejection branch can be pinned without a database.
 */
export function evaluateRequiredIndex(
  indexes: unknown[],
  spec: RequiredIndexSpec
): IndexReadiness {
  const descriptions = (Array.isArray(indexes) ? indexes : [])
    .map(record)
    .filter((index): index is IndexDescription => index != null);
  const exactKey = descriptions.filter((index) => keyEquals(index.key, spec.key));
  const compatible = exactKey.find((index) => matchesSpec(index, spec));
  if (compatible) {
    return {
      ready: true,
      name: String(compatible.name ?? spec.name),
      reason: null,
    };
  }
  if (exactKey.length > 0) {
    return {
      ready: false,
      name: spec.name,
      reason: reasonForCandidate(exactKey[0]!, spec),
    };
  }
  const sameFields = descriptions.some((index) => sameFieldSet(index.key, spec.key));
  return {
    ready: false,
    name: spec.name,
    reason: sameFields
      ? `index "${spec.name}" has the required fields in the wrong order`
      : `${requiredIndexLabel(spec)} "${spec.name}" is missing`,
  };
}

/** Backward-compatible named evaluator for the original ledger guard. */
export function evaluateTransferLedgerIndex(indexes: unknown[]): IndexReadiness {
  return evaluateRequiredIndex(indexes, TRANSFER_LEDGER_INDEX);
}

/** Inspect one model's live index list. Any inspection failure is not ready. */
export async function checkRequiredIndex(
  model: IndexModel,
  spec: RequiredIndexSpec
): Promise<IndexReadiness> {
  try {
    const indexes = await withTimeout(
      model.collection.indexes(),
      INDEX_INSPECTION_TIMEOUT_MS
    );
    return evaluateRequiredIndex(indexes, spec);
  } catch (err) {
    if ((err as { codeName?: unknown } | null)?.codeName === 'NamespaceNotFound') {
      return {
        ready: false,
        name: spec.name,
        reason: `${requiredIndexLabel(spec)} "${spec.name}" is missing`,
      };
    }
    return {
      ready: false,
      name: spec.name,
      reason: `the ${spec.name} index could not be inspected`,
    };
  }
}

export async function checkTransferLedgerIndex({
  model = InventoryTransaction,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, TRANSFER_LEDGER_INDEX);
}

export async function checkPurchaseOrderRequestKeyIndex({
  model = PurchaseOrder,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, PURCHASE_ORDER_REQUEST_KEY_INDEX);
}

export async function checkAuditDedupeIndex({
  model = AuditLog,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, AUDIT_DEDUPE_INDEX);
}

export async function checkAuditOutboxTtlIndex({
  model = AuditOutbox,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, AUDIT_OUTBOX_DELIVERED_TTL_INDEX);
}

export async function checkMovementAuditRepairIndex({
  model = StockMovementOperation,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, MOVEMENT_AUDIT_REPAIR_INDEX);
}

export async function checkPoReceiveAuditRepairIndex({
  model = PurchaseOrder,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  return checkRequiredIndex(model, PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX);
}

type RequiredIndexCheck = {
  spec: RequiredIndexSpec;
  check: () => Promise<IndexReadiness>;
};

/**
 * Every required readiness index. The checks run in parallel so all bounded
 * inspections cost one timeout, not one per index.
 */
export async function checkRequiredIndexes({
  checkTransferLedger = checkTransferLedgerIndex,
  checkPurchaseOrderRequestKey = checkPurchaseOrderRequestKeyIndex,
  checkAuditDedupe = checkAuditDedupeIndex,
  checkAuditOutboxTtl = checkAuditOutboxTtlIndex,
  checkMovementAuditRepair = checkMovementAuditRepairIndex,
  checkPoReceiveAuditRepair = checkPoReceiveAuditRepairIndex,
}: {
  checkTransferLedger?: () => Promise<IndexReadiness>;
  checkPurchaseOrderRequestKey?: () => Promise<IndexReadiness>;
  checkAuditDedupe?: () => Promise<IndexReadiness>;
  checkAuditOutboxTtl?: () => Promise<IndexReadiness>;
  checkMovementAuditRepair?: () => Promise<IndexReadiness>;
  checkPoReceiveAuditRepair?: () => Promise<IndexReadiness>;
} = {}): Promise<RequiredIndexesReadiness> {
  const checks: RequiredIndexCheck[] = [
    { spec: TRANSFER_LEDGER_INDEX, check: checkTransferLedger },
    { spec: PURCHASE_ORDER_REQUEST_KEY_INDEX, check: checkPurchaseOrderRequestKey },
    { spec: AUDIT_DEDUPE_INDEX, check: checkAuditDedupe },
    { spec: AUDIT_OUTBOX_DELIVERED_TTL_INDEX, check: checkAuditOutboxTtl },
    { spec: MOVEMENT_AUDIT_REPAIR_INDEX, check: checkMovementAuditRepair },
    { spec: PURCHASE_ORDER_RECEIVE_AUDIT_REPAIR_INDEX, check: checkPoReceiveAuditRepair },
  ];
  const results = await Promise.all(
    checks.map(async ({ spec, check }): Promise<{ name: string; reason: string } | null> => {
      try {
        const result = await check();
        return result.ready
          ? null
          : { name: result.name, reason: result.reason ?? 'not ready' };
      } catch {
        return {
          name: spec.name,
          reason: `the ${spec.name} index check could not run`,
        };
      }
    })
  );
  const failures = results.filter(
    (failure): failure is { name: string; reason: string } => failure !== null
  );
  return { ready: failures.length === 0, failures };
}
