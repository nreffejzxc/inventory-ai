import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiResponse } from '../lib/api';
import type { QueryParams } from '../lib/client';

/**
 * The `list` surface shared by every reference api (categories, locations,
 * suppliers, products). Naming just this one method keeps the hook independent
 * of which catalogue it is pointed at.
 */
export interface ReferenceListApi {
  list: (token: string, params?: QueryParams) => Promise<ApiResponse>;
}

export type ReferenceAvailability = 'none' | 'checking' | 'available' | 'missing';

/**
 * Whether a saved/selected id is still in the COMPLETE active list.
 *
 * `checking` is deliberately not `missing`: a failed or unfinished read must
 * never make a form clear a valid selection or make a filter hide rows. Callers
 * may repair only after `missing`.
 */
export function referenceAvailability(
  id: string | null | undefined,
  ref: { items: ApiResponse[]; complete: boolean },
): ReferenceAvailability {
  if (!id) return 'none';
  if (!ref.complete) return 'checking';
  return ref.items.some((item) => item.id === id) ? 'available' : 'missing';
}

/**
 * Loads the active list of a reference resource (categories/locations) for use
 * in filters and pickers.
 *
 * `complete` is deliberately separate from `loading`: a picker may show the rows
 * from page 1 while a larger active list is still being read, and a failed read
 * must never look like "every saved id is gone". A caller that deletes or clears
 * a saved reference must wait for `complete`, not merely `!loading`.
 */
export function useActiveRef(
  token: string | null,
  api: ReferenceListApi,
  { limit = 100, allPages = false }: { limit?: number; allPages?: boolean } = {}
): { items: ApiResponse[]; loading: boolean; complete: boolean; reload: () => Promise<void> } {
  const [items, setItems] = useState<ApiResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [complete, setComplete] = useState(false);
  const requestRef = useRef(0);
  // The account that produced the current `items`. A token change is an account
  // boundary: keeping the old rows while the new account's first page is in
  // flight (or after it fails) would let a picker show another account's
  // references. The rows are cleared synchronously with the new read; a retry
  // under the SAME token deliberately keeps its partial pages.
  const sourceRef = useRef<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    const source = token ?? '';
    if (sourceRef.current !== source) {
      sourceRef.current = source;
      setItems([]);
    }
    if (!token) {
      setItems([]);
      setLoading(false);
      setComplete(false);
      return;
    }
    setLoading(true);
    setComplete(false);
    const collected: ApiResponse[] = [];
    try {
      let page = 1;
      let expectedPages: number | null = null;
      let total: number | null = null;

      while (true) {
        const res = await api.list(token, { status: 'ACTIVE', page, limit });
        const pageItems: ApiResponse[] = Array.isArray(res?.items) ? res.items : [];
        collected.push(...pageItems);

        const resTotal = typeof res?.total === 'number' ? res.total : null;
        const resPages = typeof res?.totalPages === 'number' ? res.totalPages : null;
        if (resTotal !== null) total = resTotal;
        // Prefer the server's page count: it reflects the page size the server
        // actually applied, which may be smaller than the requested `limit`.
        expectedPages = resPages !== null
          ? Math.max(1, resPages)
          : resTotal !== null
            ? Math.max(1, Math.ceil(resTotal / limit))
            : null;

        if (expectedPages === null) break;
        if (!allPages || page >= expectedPages || pageItems.length === 0) break;
        page += 1;
      }

      const unique = uniqueItems(collected);
      if (requestId !== requestRef.current) return;
      setItems(unique);
      setComplete(
        expectedPages !== null &&
          page >= expectedPages &&
          (total === null || unique.length >= total)
      );
    } catch {
      if (requestId !== requestRef.current) return;
      // A failed later page must not erase the pages already read. Preserve them
      // (and keep `complete` false) so a picker still shows usable options while
      // a caller can see that the list is not proven complete.
      const partial = uniqueItems(collected);
      if (partial.length > 0) setItems(partial);
      setComplete(false);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [allPages, api, token, limit]);

  // First load uses a synchronous loading transition intentionally. `loading` is
  // a lifecycle signal, not derived data: `items.length === 0` cannot distinguish
  // an initial load from a successfully loaded empty catalogue. MovementForm,
  // PoForm and TransferForm all depend on `loading && items.length === 0` for
  // their initial-loading UI. Deriving `loading` from `items` would therefore
  // change the empty-catalogue behaviour.
  //
  // A reload can overlap a previous load; the request id protects the state from
  // a late response. The cleanup invalidates any in-flight request on unmount or
  // when the resource/token changes.
  useEffect(() => {
    // Deliberate, narrow exception at this one call site — not a suppression of
    // any dependency rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  return { items, loading, complete, reload };
}

/** Stable de-duplication by id; malformed rows without an id are preserved. */
function uniqueItems(items: ApiResponse[]): ApiResponse[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = typeof item?.id === 'string' ? item.id : null;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
