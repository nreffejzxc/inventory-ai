/**
 * The client half of inventory write de-duplication.
 *
 * WHY A KEY EXISTS AT ALL. The form's submit is not one event on the wire, it is
 * one event the member sees and up to two the server can receive: the request can
 * outlive the client's own budget (a Render cold start is the measured case), the
 * form is told it failed and re-enables its button, and the member submits again.
 * Both deliveries reach the server, so without a shared name for the operation the
 * movement is applied twice — two ledger rows, two Recent Activity entries, and a
 * stock level wrong by the whole movement.
 *
 * The key is that shared name. One is minted per operation ATTEMPT and kept only
 * while the same attempt might still be retried; the server answers the second
 * delivery with the first delivery's response instead of applying it again.
 *
 * WHY IT IS PERSISTED. A process death or the operating system reclaiming the app
 * is another way the answer can be lost. An in-memory key cannot survive that, so
 * the next launch would retry under a fresh name and apply the operation twice.
 * The key therefore lives in SecureStore, beside the session token, and is looked
 * up again from the operation's scope and payload on the next submit.
 *
 * WHY IT IS ACCOUNT-SCOPED. A phone can be handed to a colleague, and the same
 * device can sign out of one business and into another. A single bucket per kind
 * made one account's unresolved operations consume the shared capacity and made
 * the next account's submit read (and then rewrite) records it could never resume.
 * Every bucket is therefore stored under a short, non-reversible digest of the
 * authenticated user id: signing out does not delete an account's unresolved keys
 * (the server may still hold their outcome), but no other account can see, fill or
 * overwrite that account's bucket. Within one account the identity is still
 * `kind + owner + target + payload`, so the last line of defence does not change.
 *
 * WHY MUTATIONS ARE SERIALIZED. Minting and completing a key are both
 * read-modify-write operations over the same SecureStore item. Two submissions
 * running at once could each read the same bucket and the later write would erase
 * the earlier operation's key — the exact lost key that lets a retry apply twice.
 * One promise queue through this module makes every mutation observe the previous
 * one's result. The queue is process-local, which is the correct scope: SecureStore
 * has no compare-and-swap, and two app processes cannot edit one account's items at
 * the same time in a way this app can create.
 *
 * WHAT IT IS NOT. Not a secret, not a hash of the payload and not a marker of "the
 * same form". Two deliberate, identical stock-ins minutes apart are two
 * operations and mint two keys — the stored key is the attempt, so legitimate
 * repeats are never swallowed as duplicates.
 */

import * as SecureStore from 'expo-secure-store';

import { ApiError } from './client';

/**
 * Whether an answer ENDS the operation, so the next press is a new one.
 *
 * These failures are NOT an answer and therefore do not end the operation:
 *
 *   • status 0 (timed out, unreachable) — the movement may already have landed.
 *     This is the measured case: the member is told it failed and taps again.
 *   • status 408 or any 5xx — the server may have committed and then failed while
 *     producing the response. The server cannot prove that nothing happened from
 *     the status alone, so the safe client rule is to keep the key and let a retry
 *     replay the stored outcome. The domain receipt/replay paths (transfers, PO
 *     receives and now plain stock movements) are the strongest form; the
 *     transport's idempotency record is the fallback.
 *   • `IDEMPOTENT_REQUEST_IN_PROGRESS` / `RECEIVE_IN_PROGRESS` (409) — the server
 *     is saying the SAME key is still being processed. That is this operation, not
 *     a new one; renaming it would let a delivery that is still running be applied
 *     a second time.
 *   • `MOVEMENT_REQUIRES_ATTENTION` (409) — the server holds a receipt for this key
 *     whose inventory write it cannot prove or safely finish. Keeping the key is
 *     deliberate: a fresh key would apply a second movement over an ambiguous one.
 *     The member is told to contact support with the reference; support resolves the
 *     receipt, after which a retry replays the resolved outcome.
 *
 * A definite 4xx refusal (validation, conflict, rate limit, authorization) ends
 * the operation: those answers are produced before any durable write. The PO
 * receive's `RECEIVE_CONFLICT` is handled by that screen explicitly because it
 * carries the `applied` lines and rebuilds the remaining operation from them.
 */
export function endsOperation(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0 || err.status === 408 || err.status >= 500) return false;
  if (err.code === 'MOVEMENT_REQUIRES_ATTENTION') return false;
  return err.code !== 'IDEMPOTENT_REQUEST_IN_PROGRESS' && err.code !== 'RECEIVE_IN_PROGRESS';
}

/**
 * Raised rather than evicting an unresolved operation. A full bucket is rare; a
 * lost key is not rare in its consequences — the retry can apply the same stock
 * movement twice. The forms surface this message and leave the screen usable.
 *
 * The bucket is per account, so a colleague's eight unfinished operations can no
 * longer refuse this member's first one on a shared device.
 */
export class PendingOperationsFullError extends Error {
  readonly kind: IdempotencyKind;
  readonly limit: number;

  constructor(kind: IdempotencyKind, limit: number) {
    super(
      'Too many unfinished operations are waiting for confirmation. Retry one of them before starting another.',
    );
    this.name = 'PendingOperationsFullError';
    this.kind = kind;
    this.limit = limit;
  }
}

/** The finite set of client operations whose retry could duplicate durable work. */
export type IdempotencyKind =
  | 'product.create'
  | 'purchase-order.create'
  | 'reference.create'
  | 'stock-in'
  | 'stock-out'
  | 'adjust'
  | 'transfer'
  | 'purchase-order.receive';

/**
 * How long a stored attempt may be resumed. This matches the server's
 * `idempotency_records` TTL: after it, the server has forgotten the key and a
 * retry is honestly a new operation. A clock that moved backwards also makes the
 * record unusable rather than extending its life.
 */
export const PENDING_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * v3 is the account-scoped layout. The two earlier prefixes are read once, per
 * account, so an upgrade cannot strand an unresolved operation.
 */
const STORAGE_PREFIX = 'inventoryai.idempotency.v3.';
const PREVIOUS_STORAGE_PREFIX = 'inventoryai.idempotency.v2.';
const LEGACY_STORAGE_PREFIX = 'inventoryai.idempotency.v1.';
const STORED_KEY = /^op-[A-Za-z0-9._:-]{8,200}$/;

/**
 * A small bucket, not a cache: unresolved operations may still be retried, so
 * they are never evicted to make room. Eight covers switching between the forms
 * a member can realistically leave in flight and keeps the SecureStore item tiny.
 * It is now eight PER ACCOUNT per kind, not eight shared by every account.
 */
export const MAX_PENDING_OPERATIONS_PER_KIND = 8;

interface PendingOperation {
  version: 1;
  key: string;
  ownerId: string;
  target: string;
  fingerprint: string;
  createdAt: number;
}

interface PendingBucket {
  version: 3;
  operations: PendingOperation[];
}

/** The shape written by the previous release; read only during migration. */
interface PreviousBucket {
  version: 2;
  operations: PendingOperation[];
}

export interface OperationKeyRequest {
  kind: IdempotencyKind;
  /** The authenticated user, so one device account cannot resume another's work. */
  ownerId?: string | null;
  /** A resource the operation names (a PO id, or a reference resource). */
  target?: string | null;
  /** The business payload; only its canonical digest is stored. */
  payload: unknown;
}

/** One bounded bucket per account and kind, mirrored in memory when SecureStore is unavailable. */
const memory = new Map<string, PendingOperation[]>();

/**
 * Every key-store mutation runs through this one promise chain. `mutationQueue`
 * always settles, so one failed task cannot block the next; the caller still gets
 * the task's own rejection through the returned promise.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Deterministic JSON: object key order cannot change the operation identity. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stable, non-reversible account segment for a storage key.
 *
 * Two hashes give 64 bits, so two accounts on one device cannot realistically
 * share a bucket; the record's own `ownerId` is still compared before a key is
 * resumed, so even a collision could not hand one account another's key. An empty
 * owner is the anonymous namespace used before a session is available; it is not
 * an account and never receives a key the server could apply on a member's behalf.
 */
function ownerSegment(ownerId: string): string {
  if (!ownerId) return 'anonymous';
  return `${hash32(ownerId, 2166136261)}${hash32(ownerId, 2166136261 ^ 0x9e3779b9)}`;
}

function storageScope(ownerId: string, kind: IdempotencyKind): string {
  return `${ownerSegment(ownerId)}.${kind.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function storageKey(ownerId: string, kind: IdempotencyKind): string {
  return `${STORAGE_PREFIX}${storageScope(ownerId, kind)}`;
}

/**
 * The two earlier layouts were GLOBAL per kind — they carried no account — so
 * their names are not derived from an owner. They are read once and rewritten
 * without the records that belong to another account.
 */
function previousStorageKey(kind: IdempotencyKind, prefix: string): string {
  return `${prefix}${kind.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * A 128-bit local fingerprint, not the server's SHA-256. It only decides whether
 * THIS device may resume the stored attempt; the server still compares the full
 * request body under its own fingerprint and refuses a changed payload.
 */
function fingerprintOf({
  kind,
  ownerId,
  target,
  payload,
}: {
  kind: IdempotencyKind;
  ownerId: string;
  target: string;
  payload: unknown;
}): string {
  const input = canonical({ kind, ownerId, target, payload });
  return (
    hash32(input, 2166136261) +
    hash32(input, 2166136261 ^ 0x9e3779b9) +
    hash32(input, 2166136261 ^ 0x85ebca6b) +
    hash32(input, 2166136261 ^ 0xc2b2ae35)
  );
}

function parseRecordValue(value: unknown): PendingOperation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<PendingOperation>;
  if (
    record.version !== 1 ||
    typeof record.key !== 'string' ||
    !STORED_KEY.test(record.key) ||
    typeof record.ownerId !== 'string' ||
    typeof record.target !== 'string' ||
    typeof record.fingerprint !== 'string' ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt)
  ) {
    return null;
  }
  return {
    version: 1,
    key: record.key,
    ownerId: record.ownerId,
    target: record.target,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
  };
}

/** Read a v1 single record during the upgrade. New writes only use v3. */
function parseRecord(raw: string | null): PendingOperation | null {
  if (!raw) return null;
  try {
    return parseRecordValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Drop a corrupt entry; the valid operations in the same bucket stay resumable. */
function parseBucket(raw: string | null, version: 3 | 2 = 3): PendingOperation[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingBucket | PreviousBucket> | null;
    if (value?.version !== version || !Array.isArray(value.operations)) return null;
    return value.operations
      .map(parseRecordValue)
      .filter((record): record is PendingOperation => record !== null);
  } catch {
    return null;
  }
}

/**
 * Move only THIS account's records out of a shared v2 bucket, or its single v1
 * record, after the v3 copy is durable. Other accounts' records are left exactly
 * where they are, so they migrate under their own first read.
 *
 * Returns `null` when no earlier bucket exists at all, so the caller can stop
 * looking; an empty array means the earlier bucket had nothing for this account.
 */
async function migratePreviousBuckets(
  ownerId: string,
  kind: IdempotencyKind,
): Promise<PendingOperation[] | null> {
  const previousKey = previousStorageKey(kind, PREVIOUS_STORAGE_PREFIX);
  const previousRaw = await SecureStore.getItemAsync(previousKey);
  if (previousRaw) {
    const parsed = parseBucket(previousRaw, 2);
    if (!parsed) {
      // A corrupt v2 bucket must never be resumed. Remove it so the next read
      // does not keep failing over the same bytes, then still look for this
      // account's older v1 record.
      try {
        await SecureStore.deleteItemAsync(previousKey);
      } catch {
        // Ignored: the next write replaces it.
      }
    } else {
      const mine = parsed.filter((record) => record.ownerId === ownerId);
      const theirs = parsed.filter((record) => record.ownerId !== ownerId);
      if (mine.length > 0) {
        if (await writeBucket(ownerId, kind, mine)) {
          try {
            if (theirs.length > 0) {
              await SecureStore.setItemAsync(
                previousKey,
                JSON.stringify({ version: 2, operations: theirs } satisfies PreviousBucket),
              );
            } else {
              await SecureStore.deleteItemAsync(previousKey);
            }
          } catch {
            // The v3 copy is durable; a leftover v2 record is ignored from now on.
          }
        }
        return mine;
      }
      // This v2 bucket belongs to another account. Fall through to v1: an older
      // account's single record can still be sitting there from the v1 release.
    }
  }

  const legacyKey = previousStorageKey(kind, LEGACY_STORAGE_PREFIX);
  const legacyRaw = await SecureStore.getItemAsync(legacyKey);
  if (!legacyRaw) return null;

  const legacy = parseRecord(legacyRaw);
  if (!legacy) {
    try {
      await SecureStore.deleteItemAsync(legacyKey);
    } catch {
      // Ignored: an unreadable single record can never be resumed.
    }
    return [];
  }
  if (legacy.ownerId !== ownerId) return [];

  if (await writeBucket(ownerId, kind, [legacy])) {
    try {
      await SecureStore.deleteItemAsync(legacyKey);
    } catch {
      // v3 is already durable; a stale v1 copy is ignored on subsequent reads.
    }
  }
  return [legacy];
}

async function readBucket(
  ownerId: string,
  kind: IdempotencyKind,
): Promise<PendingOperation[]> {
  const scope = storageScope(ownerId, kind);
  try {
    const raw = await SecureStore.getItemAsync(storageKey(ownerId, kind));
    if (raw) {
      const parsed = parseBucket(raw);
      if (parsed) {
        memory.set(scope, parsed);
        return parsed;
      }
      // A corrupt bucket must never be resumed. The next submit overwrites it.
      memory.delete(scope);
      return [];
    }

    const migrated = await migratePreviousBuckets(ownerId, kind);
    if (migrated !== null) {
      memory.set(scope, migrated);
      return migrated;
    }
  } catch {
    // SecureStore is unavailable on web and can fail on a locked device. The
    // in-memory copy keeps the current launch safe; persistence is best-effort.
  }
  return memory.get(scope) ?? [];
}

async function writeBucket(
  ownerId: string,
  kind: IdempotencyKind,
  operations: PendingOperation[],
): Promise<boolean> {
  const scope = storageScope(ownerId, kind);
  if (operations.length === 0) {
    memory.delete(scope);
    try {
      await SecureStore.deleteItemAsync(storageKey(ownerId, kind));
    } catch {
      // Bounded by the TTL. A stale bucket can at worst replay a stored answer.
    }
    return true;
  }

  memory.set(scope, operations);
  try {
    await SecureStore.setItemAsync(
      storageKey(ownerId, kind),
      JSON.stringify({ version: 3, operations } satisfies PendingBucket),
    );
    return true;
  } catch {
    // The keys still protect this launch. They cannot survive a restart, which is
    // exactly the pre-persistence behaviour and never worse than minting afresh.
    return false;
  }
}

function isFresh(record: PendingOperation, now: number): boolean {
  const age = now - record.createdAt;
  return age >= 0 && age <= PENDING_OPERATION_TTL_MS;
}

function isReusable(
  record: PendingOperation,
  expected: Pick<PendingOperation, 'ownerId' | 'target' | 'fingerprint'>,
  now: number,
): boolean {
  return (
    record.ownerId === expected.ownerId &&
    record.target === expected.target &&
    record.fingerprint === expected.fingerprint &&
    isFresh(record, now)
  );
}

/**
 * Resume the same operation across a crash or restart, or mint a new one.
 *
 * The identity is `kind + owner + target + payload`, so changing a quantity,
 * opening a different purchase order, signing in as another user or submitting a
 * different form cannot inherit an old key. Only the digest is persisted. The
 * bucket itself is under the account, and every bucket mutation is serialized.
 *
 * A second operation of the same kind ADDS to the bucket; it does not replace the
 * first. That is the defect this bucket fixes: switching forms and retrying the
 * first one must still find its key, because the first delivery may have landed
 * before the server answered.
 */
export async function getOrCreateOperationKey({
  kind,
  ownerId,
  target,
  payload,
}: OperationKeyRequest): Promise<string> {
  const owner = String(ownerId ?? '').trim();
  const resource = String(target ?? '').trim();

  return serialize(async () => {
    const fingerprint = fingerprintOf({ kind, ownerId: owner, target: resource, payload });
    const now = Date.now();
    const stored = await readBucket(owner, kind);
    const live = stored.filter((record) => isFresh(record, now));
    const expected = { ownerId: owner, target: resource, fingerprint };
    const reusable = live.find((record) => isReusable(record, expected, now));

    if (reusable) {
      if (live.length !== stored.length) await writeBucket(owner, kind, live);
      return reusable.key;
    }

    if (live.length >= MAX_PENDING_OPERATIONS_PER_KIND) {
      if (live.length !== stored.length) await writeBucket(owner, kind, live);
      throw new PendingOperationsFullError(kind, MAX_PENDING_OPERATIONS_PER_KIND);
    }

    const key = newIdempotencyKey();
    await writeBucket(owner, kind, [
      ...live,
      {
        version: 1,
        key,
        ownerId: owner,
        target: resource,
        fingerprint,
        createdAt: now,
      },
    ]);
    return key;
  });
}

/**
 * Drop a stored attempt after a success or a definite refusal. Only the matching
 * key is removed, and only from the named account's bucket, so a slow completion
 * cannot erase another operation's key on a shared device.
 *
 * `ownerId` is required because the bucket name is derived from it; there is no
 * enumeration API that could find the right bucket otherwise.
 */
export async function completeOperation(
  kind: IdempotencyKind,
  key: string,
  ownerId: string | null | undefined,
): Promise<void> {
  const owner = String(ownerId ?? '').trim();
  await serialize(async () => {
    const stored = await readBucket(owner, kind);
    const remaining = stored.filter((record) => record.key !== key);
    if (remaining.length === stored.length) return;
    await writeBucket(owner, kind, remaining);
  });
}

/**
 * A fresh operation key: `op-` + base-36 time + 16 random characters.
 *
 * `Math.random()` rather than a CSPRNG because this value authorizes nothing. It
 * only has to be distinct from the keys this member's own operations use, and the
 * server scopes every key by `businessId` besides. It stays within the server's
 * accepted shape (`[A-Za-z0-9._:-]{8,200}`).
 */
export function newIdempotencyKey(): string {
  const random = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `op-${Date.now().toString(36)}-${random}`;
}
