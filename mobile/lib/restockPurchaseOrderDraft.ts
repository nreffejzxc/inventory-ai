/**
 * Durable state for a Restock → Draft PO attempt.
 *
 * The screen used to keep its operation key in component state. A restart after
 * a lost response forgot the key, and selecting the same rows again created a
 * second DRAFT. This record stores the exact request body and key account-scoped
 * in SecureStore so a reopen can resend the SAME operation instead of minting a
 * new one.
 *
 * The payload is stored verbatim, not reconstructed from current rows. That is
 * the key-mismatch guard: an unresolved attempt can only be retried with the
 * values the server may already have accepted. Changed rows are refused by the
 * server as `RESTOCK_ROWS_STALE`; this layer never silently changes the body.
 *
 * The expected-key-protected clear mirrors the import draft: a late success for
 * attempt A cannot delete attempt B saved afterwards.
 */
import * as SecureStore from 'expo-secure-store';

import type { PurchaseOrderFromRestockInput } from './api';

const STORAGE_PREFIX = 'inventoryai.restockPurchaseOrderDraft.v1.';
const STORED_KEY = /^op-[A-Za-z0-9._:-]{8,200}$/;

export interface RestockPurchaseOrderDraft {
  payload: PurchaseOrderFromRestockInput;
  key: string;
  savedAt: number;
}

export type RestockPurchaseOrderDraftLookup =
  | { status: 'found'; draft: RestockPurchaseOrderDraft }
  | { status: 'missing' }
  | { status: 'error' };

interface Stored extends RestockPurchaseOrderDraft {
  version: 1;
}

function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function ownerSegment(ownerId: string): string {
  return `${hash32(ownerId, 2166136261)}${hash32(ownerId, 2166136261 ^ 0x9e3779b9)}`;
}

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerSegment(ownerId)}`;
}

function ownerOf(ownerId: string | null | undefined): string {
  return String(ownerId ?? '').trim();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parse(raw: string | null): RestockPurchaseOrderDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored> | null;
    if (
      value?.version !== 1 ||
      typeof value.savedAt !== 'number' ||
      !Number.isFinite(value.savedAt) ||
      !nonEmptyString(value.key) ||
      !STORED_KEY.test(value.key) ||
      !value.payload ||
      typeof value.payload !== 'object'
    ) {
      return null;
    }
    const payload = value.payload;
    if (
      !nonEmptyString(payload.supplierId) ||
      !nonEmptyString(payload.locationId) ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      return null;
    }
    for (const item of payload.items) {
      if (
        !item ||
        !nonEmptyString(item.productId) ||
        typeof item.availableQuantity !== 'number' ||
        !Number.isFinite(item.availableQuantity) ||
        typeof item.minimumStock !== 'number' ||
        !Number.isFinite(item.minimumStock)
      ) {
        return null;
      }
    }
    return { payload, key: value.key, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

async function saveUnlocked(
  ownerId: string | null | undefined,
  draft: RestockPurchaseOrderDraft,
): Promise<boolean> {
  const owner = ownerOf(ownerId);
  if (
    !owner ||
    !nonEmptyString(draft.payload?.supplierId) ||
    !nonEmptyString(draft.payload?.locationId) ||
    !Array.isArray(draft.payload?.items) ||
    draft.payload.items.length === 0 ||
    !STORED_KEY.test(draft.key) ||
    !Number.isFinite(draft.savedAt)
  ) {
    return false;
  }
  const stored: Stored = { version: 1, ...draft };
  try {
    await SecureStore.setItemAsync(storageKey(owner), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

async function loadUnlocked(
  ownerId: string | null | undefined,
): Promise<RestockPurchaseOrderDraftLookup> {
  const owner = ownerOf(ownerId);
  if (!owner) return { status: 'missing' };
  try {
    const draft = parse(await SecureStore.getItemAsync(storageKey(owner)));
    return draft ? { status: 'found', draft } : { status: 'missing' };
  } catch {
    // A locked or unavailable SecureStore is not evidence that there is no
    // attempt. The screen must not mint a new key until this read succeeds.
    return { status: 'error' };
  }
}

async function clearUnlocked(
  ownerId: string | null | undefined,
  expectedKey?: string,
): Promise<boolean> {
  const owner = ownerOf(ownerId);
  if (!owner) return false;
  let stored: RestockPurchaseOrderDraft | null;
  try {
    stored = parse(await SecureStore.getItemAsync(storageKey(owner)));
  } catch {
    return false;
  }
  if (expectedKey && stored && stored.key !== expectedKey) return false;
  try {
    await SecureStore.deleteItemAsync(storageKey(owner));
    return true;
  } catch {
    return false;
  }
}

let draftQueue: Promise<void> = Promise.resolve();

function serializeDraft<T>(work: () => Promise<T>): Promise<T> {
  const result = draftQueue.then(work, work);
  draftQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function saveRestockPurchaseOrderDraft(
  ownerId: string | null | undefined,
  draft: RestockPurchaseOrderDraft,
): Promise<boolean> {
  return serializeDraft(() => saveUnlocked(ownerId, draft));
}

export function loadRestockPurchaseOrderDraft(
  ownerId: string | null | undefined,
): Promise<RestockPurchaseOrderDraftLookup> {
  return serializeDraft(() => loadUnlocked(ownerId));
}

export function clearRestockPurchaseOrderDraft(
  ownerId: string | null | undefined,
  expectedKey?: string,
): Promise<boolean> {
  return serializeDraft(() => clearUnlocked(ownerId, expectedKey));
}
