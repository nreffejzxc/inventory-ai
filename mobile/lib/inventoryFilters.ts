/**
 * The Inventory screen's last location and row-status choice, per account.
 *
 * WHY THIS IS PERSISTED. Multi-location staff open Inventory repeatedly for the
 * same branch, and the screen's location selector is otherwise reset on every
 * launch. Only an identifier and a status token are stored — never quantities,
 * row content or anything another account could use. The storage key is derived
 * from a short digest of the authenticated user id, so one account on a shared
 * device cannot see or overwrite another account's choice.
 *
 * Route parameters always win on entry. This module has no knowledge of the
 * route; the screen merges these values only for dimensions the route did not
 * supply, and an explicit Reset deletes the record.
 */

import * as SecureStore from 'expo-secure-store';

/** The mutually exclusive row choices shown under the Inventory search field. */
export type InventoryStatusFilter = '' | 'needsAttention' | 'low' | 'out';

export interface InventoryFilterSnapshot {
  locationId: string;
  status: InventoryStatusFilter;
}

export const EMPTY_INVENTORY_FILTERS: InventoryFilterSnapshot = {
  locationId: '',
  status: '',
};

const STORAGE_PREFIX = 'inventoryai.inventoryFilters.v1.';
const STORED_STATUSES: readonly InventoryStatusFilter[] = ['', 'needsAttention', 'low', 'out'];
const LOCATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Process-local fallback when SecureStore is unavailable (web or a locked device). */
const memory = new Map<string, InventoryFilterSnapshot>();

function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A stable, non-reversible account segment for the storage key. */
function ownerSegment(ownerId: string): string {
  return `${hash32(ownerId, 2166136261)}${hash32(ownerId, 2166136261 ^ 0x9e3779b9)}`;
}

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerSegment(ownerId)}`;
}

function parseSnapshot(raw: string | null): InventoryFilterSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<InventoryFilterSnapshot> | null;
    if (!value || typeof value !== 'object') return null;
    const locationId = typeof value.locationId === 'string' && LOCATION_ID.test(value.locationId)
      ? value.locationId
      : '';
    const status = STORED_STATUSES.includes(value.status as InventoryStatusFilter)
      ? (value.status as InventoryStatusFilter)
      : '';
    return { locationId, status };
  } catch {
    return null;
  }
}

/**
 * Restore this account's choice. A corrupt or partially invalid record degrades
 * to the valid fields (or empty), so a bad write can never block the screen.
 */
export async function loadInventoryFilters(ownerId: string | null | undefined): Promise<InventoryFilterSnapshot> {
  const owner = String(ownerId ?? '').trim();
  if (!owner) return EMPTY_INVENTORY_FILTERS;
  try {
    const raw = await SecureStore.getItemAsync(storageKey(owner));
    if (raw) {
      const parsed = parseSnapshot(raw);
      if (parsed) {
        memory.set(owner, parsed);
        return parsed;
      }
      // A corrupt record is unusable; the next save replaces it.
      memory.delete(owner);
      return EMPTY_INVENTORY_FILTERS;
    }
  } catch {
    // SecureStore can be unavailable; the in-memory copy keeps this launch useful.
  }
  return memory.get(owner) ?? EMPTY_INVENTORY_FILTERS;
}

/** Save this account's choice; persistence is best-effort and never blocks the screen. */
export async function saveInventoryFilters(
  ownerId: string | null | undefined,
  snapshot: InventoryFilterSnapshot,
): Promise<void> {
  const owner = String(ownerId ?? '').trim();
  if (!owner) return;
  const next: InventoryFilterSnapshot = {
    locationId: LOCATION_ID.test(snapshot.locationId) ? snapshot.locationId : '',
    status: STORED_STATUSES.includes(snapshot.status) ? snapshot.status : '',
  };
  memory.set(owner, next);
  try {
    await SecureStore.setItemAsync(
      storageKey(owner),
      JSON.stringify({ version: 1, ...next }),
    );
  } catch {
    // The current launch still has the in-memory copy.
  }
}

/** Forget this account's choice. Used by the explicit Reset control. */
export async function clearInventoryFilters(ownerId: string | null | undefined): Promise<void> {
  const owner = String(ownerId ?? '').trim();
  if (!owner) return;
  memory.delete(owner);
  try {
    await SecureStore.deleteItemAsync(storageKey(owner));
  } catch {
    // Best effort: a stale record would restore one old choice, never data.
  }
}
