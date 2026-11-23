/**
 * Cross-restart resume state for the FW-01 bulk product import.
 *
 * A large import can outlive the screen, the request budget and the process. The
 * server keeps the durable receipt, but the client still needs the SAME CSV and
 * operation key after a relaunch; otherwise a retry either cannot continue or
 * starts a second catalogue.
 *
 * WHY THE CSV IS NOT IN SECURESTORE. SecureStore is for small secrets, and Expo
 * warns that large values can be rejected by the underlying platform. A CSV may
 * legitimately reach 512 KiB, so only the small metadata record and the operation
 * key live in SecureStore. The CSV is written to the app's sandbox document
 * directory under a directory derived from the same account digest. Nothing is
 * exported or shared.
 *
 * Account scope is deliberate: a shared device can sign out of one business and
 * into another, and neither account may read or overwrite the other's draft.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

/** The server's FW-01 route cap; the picker and the restored file both obey it. */
export const MAX_IMPORT_CSV_BYTES = 512 * 1024;

/**
 * How long an unfinished import stays useful on this device. The receipt on the
 * server has no TTL, but a CSV is product data and should not sit in the app's
 * sandbox indefinitely. One week is long enough to survive a weekend or a
 * vacation without keeping an abandoned draft forever.
 */
export const PRODUCT_IMPORT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STORAGE_PREFIX = 'inventoryai.productImportDraft.v1.';
const STORED_KEY = /^op-[A-Za-z0-9._:-]{8,200}$/;
const MAX_FILE_NAME = 255;
const DRAFT_DIRECTORY = 'product-imports/';

export interface ProductImportDraft {
  fileName: string;
  csv: string;
  key: string;
}

interface StoredMeta {
  version: 1;
  fileName: string;
  key: string;
  /** Epoch ms. Absent in drafts written before expiry support; kept only for migration. */
  savedAt: number | null;
}

/** UTF-8 byte length without allocating a second copy of a 512 KiB string. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stable per-account path/key segment; the raw user id is never stored. */
function ownerSegment(ownerId: string): string {
  return `${hash32(ownerId, 2166136261)}${hash32(ownerId, 2166136261 ^ 0x9e3779b9)}`;
}

function metaKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerSegment(ownerId)}`;
}

function draftDirectory(ownerId: string): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${DRAFT_DIRECTORY}${ownerSegment(ownerId)}/` : null;
}

function csvUri(ownerId: string, key: string): string | null {
  const directory = draftDirectory(ownerId);
  return directory ? `${directory}draft-${key}.csv` : null;
}

function ownerOf(ownerId: string | null | undefined): string {
  return String(ownerId ?? '').trim();
}

function parseMeta(raw: string | null): StoredMeta | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredMeta> | null;
    if (
      value?.version !== 1 ||
      typeof value.fileName !== 'string' ||
      !value.fileName.trim() ||
      value.fileName.length > MAX_FILE_NAME ||
      typeof value.key !== 'string' ||
      !STORED_KEY.test(value.key)
    ) {
      return null;
    }
    return {
      version: 1,
      fileName: value.fileName,
      key: value.key,
      savedAt:
        typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) && value.savedAt >= 0
          ? value.savedAt
          : null,
    };
  } catch {
    return null;
  }
}

function isExpired(meta: StoredMeta, now: number): boolean {
  return meta.savedAt !== null && now - meta.savedAt > PRODUCT_IMPORT_DRAFT_TTL_MS;
}

/**
 * A metadata read has four distinct outcomes, and only three of them are safe to
 * clean up. A locked device or a transient SecureStore failure says nothing about
 * the draft on disk, so callers must not treat it as "missing" and delete the
 * CSV.
 */
type MetaRead =
  | { status: 'ok'; meta: StoredMeta }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'error' };

async function readMetaState(ownerId: string): Promise<MetaRead> {
  try {
    const raw = await SecureStore.getItemAsync(metaKey(ownerId));
    if (raw === null) return { status: 'missing' };
    const meta = parseMeta(raw);
    return meta ? { status: 'ok', meta } : { status: 'corrupt' };
  } catch {
    return { status: 'error' };
  }
}

async function writeMeta(ownerId: string, meta: StoredMeta): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(metaKey(ownerId), JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

async function deleteMeta(ownerId: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(metaKey(ownerId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the selected CSV and its operation key. Returns false when either the
 * file or the metadata could not be written. The caller decides whether that is
 * safe; the import screen refuses to send an unresumable new operation.
 */
async function saveProductImportDraftUnlocked(
  ownerId: string | null | undefined,
  draft: ProductImportDraft,
): Promise<boolean> {
  const owner = ownerOf(ownerId);
  const fileName = draft.fileName.trim();
  if (
    !owner ||
    !fileName ||
    fileName.length > MAX_FILE_NAME ||
    !STORED_KEY.test(draft.key) ||
    utf8ByteLength(draft.csv) > MAX_IMPORT_CSV_BYTES
  ) {
    return false;
  }
  const directory = draftDirectory(owner);
  const uri = csvUri(owner, draft.key);
  if (!directory || !uri) return false;

  // A failed read must not be mistaken for "no previous draft": deleting the
  // previous CSV on that assumption could destroy a valid import. Leaving it in
  // place is safe; cleanup will remove it once metadata is readable again.
  const previousRead = await readMetaState(owner);
  const previous = previousRead.status === 'ok' ? previousRead.meta : null;
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.writeAsStringAsync(uri, draft.csv, { encoding: 'utf8' });
    const meta: StoredMeta = { version: 1, fileName, key: draft.key, savedAt: Date.now() };
    await SecureStore.setItemAsync(metaKey(owner), JSON.stringify(meta));
  } catch {
    return false;
  }

  // The new metadata is durable. Removing the previous CSV is hygiene; a failed
  // delete leaves an unreferenced file, never a draft with the wrong contents.
  if (previous && previous.key !== draft.key) {
    const previousUri = csvUri(owner, previous.key);
    if (previousUri) {
      try {
        await FileSystem.deleteAsync(previousUri, { idempotent: true });
      } catch {
        // Ignored: no metadata points at it any more.
      }
    }
  }
  return true;
}

/**
 * The result of looking for a saved import. `error` is deliberately distinct
 * from `missing`: a locked SecureStore or an unreadable CSV says nothing about
 * whether a resumable operation exists, so the screen must not unlock a new
 * import until the attempt can actually be verified.
 */
export type ProductImportDraftRead =
  | { status: 'ok'; draft: ProductImportDraft }
  | { status: 'missing' }
  | { status: 'error' };

/** Restore this account's unfinished import, preserving a transient read failure. */
async function readProductImportDraftUnlocked(
  ownerId: string | null | undefined,
  now = Date.now(),
): Promise<ProductImportDraftRead> {
  const owner = ownerOf(ownerId);
  if (!owner) return { status: 'missing' };
  const read = await readMetaState(owner);
  if (read.status === 'error') return { status: 'error' };
  if (read.status !== 'ok') return { status: 'missing' };
  const meta = read.meta;
  if (isExpired(meta, now)) {
    await clearProductImportDraftUnlocked(owner, meta.key);
    return { status: 'missing' };
  }
  // A draft from the first release has no timestamp. Start its week now rather
  // than expiring a resumable import the moment the app upgrades.
  if (meta.savedAt === null) {
    await writeMeta(owner, { ...meta, savedAt: now });
  }
  const uri = csvUri(owner, meta.key);
  if (!uri) return { status: 'error' };
  try {
    const csv = await FileSystem.readAsStringAsync(uri, { encoding: 'utf8' });
    if (utf8ByteLength(csv) > MAX_IMPORT_CSV_BYTES) return { status: 'error' };
    return { status: 'ok', draft: { fileName: meta.fileName, csv, key: meta.key } };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Remove this account's unreferenced CSV files and expired metadata. Only the
 * current account's hashed directory is touched; another account's draft is
 * never visible here. Returns the number of files removed.
 */
async function cleanupProductImportDraftsUnlocked(
  ownerId: string | null | undefined,
  now = Date.now(),
): Promise<number> {
  const owner = ownerOf(ownerId);
  if (!owner) return 0;
  const directory = draftDirectory(owner);
  if (!directory) return 0;

  const read = await readMetaState(owner);
  // A transient read failure is not evidence that the files are orphans. Abort
  // the whole pass rather than deleting a draft this launch cannot see.
  if (read.status === 'error') return 0;
  const meta = read.status === 'ok' ? read.meta : null;
  let referenced = meta && !isExpired(meta, now) ? `draft-${meta.key}.csv` : null;
  let files: string[];
  try {
    files = await FileSystem.readDirectoryAsync(directory);
  } catch {
    // A missing directory and a permission/locked-storage failure look the same
    // here. Preserve the metadata rather than turning a transient read failure
    // into data loss; the next mount can retry.
    return 0;
  }
  if (referenced && !files.includes(referenced)) referenced = null;

  let removed = 0;
  for (const file of files) {
    if (file === referenced) continue;
    try {
      await FileSystem.deleteAsync(`${directory}${file}`, { idempotent: true });
      removed += 1;
    } catch {
      // Best effort: an undeletable orphan must not block the picker.
    }
  }

  if (!referenced) {
    // Also removes an unreadable/corrupt record, which `readMeta` reports as null.
    await deleteMeta(owner);
    try {
      await FileSystem.deleteAsync(directory, { idempotent: true });
    } catch {
      // Metadata is gone, so nothing can restore the remaining files as a draft.
    }
  }
  return removed;
}

/**
 * Clear a draft. `expectedKey` makes completion race-safe: a late completion for
 * attempt A cannot delete a newer draft B that was saved afterwards. Returns true
 * when no newer draft was preserved.
 */
async function clearProductImportDraftUnlocked(
  ownerId: string | null | undefined,
  expectedKey?: string,
): Promise<boolean> {
  const owner = ownerOf(ownerId);
  if (!owner) return false;
  const read = await readMetaState(owner);
  if (expectedKey && read.status === 'error') return false;
  if (expectedKey && read.status === 'ok' && read.meta.key !== expectedKey) return false;

  if (!(await deleteMeta(owner))) return false;

  const directory = draftDirectory(owner);
  if (directory) {
    try {
      await FileSystem.deleteAsync(directory, { idempotent: true });
    } catch {
      // The metadata is gone, so the orphan cannot be restored as a draft.
    }
  }
  return true;
}

/**
 * Delete this account's local CSV even when SecureStore metadata cannot be
 * removed. Account deletion cannot leave product data behind because a key read
 * failed; the CSV goes first, and metadata removal is best effort after that.
 *
 * Returns whether the account's directory is gone. A failed directory delete
 * keeps the metadata untouched so a later cleanup can retry, rather than turning
 * the CSV into an orphan nobody can name.
 */
async function purgeProductImportDraftUnlocked(
  ownerId: string | null | undefined,
): Promise<boolean> {
  const owner = ownerOf(ownerId);
  if (!owner) return false;
  const directory = draftDirectory(owner);
  if (!directory) return false;
  try {
    await FileSystem.deleteAsync(directory, { idempotent: true });
  } catch {
    return false;
  }
  await deleteMeta(owner);
  return true;
}

/**
 * Serialize the draft's read-modify-write operations. Without this, a cleanup
 * that scanned the directory before a save could delete the file the save just
 * wrote. All work is in one process, so one queue is sufficient.
 */
let draftQueue: Promise<void> = Promise.resolve();

function serializeDraft<T>(work: () => Promise<T>): Promise<T> {
  const result = draftQueue.then(work, work);
  draftQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function saveProductImportDraft(
  ownerId: string | null | undefined,
  draft: ProductImportDraft,
): Promise<boolean> {
  return serializeDraft(() => saveProductImportDraftUnlocked(ownerId, draft));
}

export function readProductImportDraft(
  ownerId: string | null | undefined,
  now = Date.now(),
): Promise<ProductImportDraftRead> {
  return serializeDraft(() => readProductImportDraftUnlocked(ownerId, now));
}

/** Compatibility helper for callers that only need a draft or null. */
export async function loadProductImportDraft(
  ownerId: string | null | undefined,
  now = Date.now(),
): Promise<ProductImportDraft | null> {
  const result = await readProductImportDraft(ownerId, now);
  return result.status === 'ok' ? result.draft : null;
}

export function cleanupProductImportDrafts(
  ownerId: string | null | undefined,
  now = Date.now(),
): Promise<number> {
  return serializeDraft(() => cleanupProductImportDraftsUnlocked(ownerId, now));
}

export function clearProductImportDraft(
  ownerId: string | null | undefined,
  expectedKey?: string,
): Promise<boolean> {
  return serializeDraft(() => clearProductImportDraftUnlocked(ownerId, expectedKey));
}

export function purgeProductImportDraft(
  ownerId: string | null | undefined,
): Promise<boolean> {
  return serializeDraft(() => purgeProductImportDraftUnlocked(ownerId));
}
