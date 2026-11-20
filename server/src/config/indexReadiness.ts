import InventoryTransaction, {
  TRANSFER_LEDGER_INDEX,
} from '../models/inventoryTransaction.model.ts';

/**
 * Fail-closed readiness for the unique transfer-ledger guard.
 *
 * `/api/health/ready` is what an orchestrator uses to decide whether this
 * process may receive traffic. The ledger guard is a correctness boundary for
 * transfer recovery, so a reachable database is not enough: the exact unique
 * partial index must be present too. A missing, non-unique, differently-keyed
 * or differently-filtered index is reported as not ready instead of being
 * mistaken for a healthy deployment.
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

function keyEquals(actual: unknown, expected: Record<string, number>): boolean {
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

function sameFieldSet(actual: unknown, expected: Record<string, number>): boolean {
  const fields = Object.keys(record(actual) ?? {}).sort();
  return fields.join(',') === Object.keys(expected).sort().join(',');
}

function reasonForCandidate(index: IndexDescription): string {
  const name = String(index.name ?? '(unnamed)');
  const problems: string[] = [];
  if (index.unique !== true) problems.push('is not unique');
  if (
    canonical(index.partialFilterExpression ?? null) !==
    canonical(TRANSFER_LEDGER_INDEX.partialFilterExpression)
  ) {
    problems.push('has a different partial filter');
  }
  return `index "${name}" ${problems.join(' and ') || 'does not match the required index'}`;
}

/**
 * Evaluate the already-listed index descriptions. Pure, so every rejection
 * branch can be pinned without a database.
 */
export function evaluateTransferLedgerIndex(indexes: unknown[]): IndexReadiness {
  const descriptions = (Array.isArray(indexes) ? indexes : [])
    .map(record)
    .filter((index): index is IndexDescription => index != null);
  const exactKey = descriptions.filter((index) =>
    keyEquals(index.key, TRANSFER_LEDGER_INDEX.key)
  );
  const compatible = exactKey.find(
    (index) =>
      index.unique === true &&
      canonical(index.partialFilterExpression ?? null) ===
        canonical(TRANSFER_LEDGER_INDEX.partialFilterExpression)
  );
  if (compatible) {
    return {
      ready: true,
      name: String(compatible.name ?? TRANSFER_LEDGER_INDEX.name),
      reason: null,
    };
  }
  if (exactKey.length > 0) {
    return {
      ready: false,
      name: TRANSFER_LEDGER_INDEX.name,
      reason: reasonForCandidate(exactKey[0]!),
    };
  }
  const sameFields = descriptions.some((index) =>
    sameFieldSet(index.key, TRANSFER_LEDGER_INDEX.key)
  );
  return {
    ready: false,
    name: TRANSFER_LEDGER_INDEX.name,
    reason: sameFields
      ? `index "${TRANSFER_LEDGER_INDEX.name}" has the required fields in the wrong order`
      : `required unique partial index "${TRANSFER_LEDGER_INDEX.name}" is missing`,
  };
}

/** Read the live index list. Any inspection failure is not ready, never ready. */
export async function checkTransferLedgerIndex({
  model = InventoryTransaction,
}: {
  model?: IndexModel;
} = {}): Promise<IndexReadiness> {
  try {
    const indexes = await withTimeout(
      model.collection.indexes(),
      INDEX_INSPECTION_TIMEOUT_MS
    );
    return evaluateTransferLedgerIndex(indexes);
  } catch (err) {
    if ((err as { codeName?: unknown } | null)?.codeName === 'NamespaceNotFound') {
      return {
        ready: false,
        name: TRANSFER_LEDGER_INDEX.name,
        reason: `required unique partial index "${TRANSFER_LEDGER_INDEX.name}" is missing`,
      };
    }
    return {
      ready: false,
      name: TRANSFER_LEDGER_INDEX.name,
      reason: 'the transfer-ledger index could not be inspected',
    };
  }
}

/**
 * Every required readiness index. Today there is one; the shape is a list so a
 * second guard can be added without changing the route contract.
 */
export async function checkRequiredIndexes({
  checkTransferLedger = checkTransferLedgerIndex,
}: {
  checkTransferLedger?: () => Promise<IndexReadiness>;
} = {}): Promise<RequiredIndexesReadiness> {
  const failures: Array<{ name: string; reason: string }> = [];
  try {
    const result = await checkTransferLedger();
    if (!result.ready) failures.push({ name: result.name, reason: result.reason ?? 'not ready' });
  } catch {
    failures.push({
      name: TRANSFER_LEDGER_INDEX.name,
      reason: 'the transfer-ledger index check could not run',
    });
  }
  return { ready: failures.length === 0, failures };
}
