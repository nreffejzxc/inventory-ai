import { useCallback, useEffect, useRef, useState } from 'react';
import { isSessionError } from '../lib/auth';
import type { ApiResponse } from '../lib/api';

/** The pagination envelope the backend sends: `{ items, total, ... }`. */
export interface PageEnvelope<T> {
  items?: T[] | null;
  total?: number | null;
  /** Optional server-computed totals for the screen's filter choices. */
  counts?: Record<string, number> | null;
}

/**
 * The one call shape every list screen builds: page + page size in, one
 * pagination envelope out. The element type is the API boundary type unless a
 * caller names a narrower one (see the ApiResponse note in lib/api.ts).
 */
export type PageFetcher<T = ApiResponse> = (page: number, limit: number) => Promise<PageEnvelope<T> | null | undefined>;

export interface UsePagedListOptions {
  params?: Record<string, unknown>;
  limit?: number;
  onSessionError?: (() => void) | null;
}

export interface PagedList<T = ApiResponse> {
  items: T[];
  total: number;
  /** Server-computed filter totals, when the endpoint sends them. */
  counts: Record<string, number> | null;
  totalPages: number;
  page: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: unknown;
  reload: () => void;
  refresh: () => void;
  loadMore: () => void;
}

/**
 * Paginated-list hook shared by every list screen.
 *
 * `fetcher(page, limit)` must return a pagination envelope
 * `{ items, total }` (as the backend sends). The list reloads automatically
 * whenever the serialized `params` change (search text, filters, paging size).
 *
 * Sessions that expire mid-session surface through `onSessionError`, which
 * screens wire to `signOut` so the app returns to login.
 */
export default function usePagedList<T = ApiResponse>(
  fetcher: PageFetcher<T>,
  { params = {}, limit = 20, onSessionError }: UsePagedListOptions = {}
): PagedList<T> {
  const paramsKey = JSON.stringify(params ?? {});
  const fetcherRef = useRef(fetcher);
  const onSessionErrorRef = useRef(onSessionError);
  const runRef = useRef(0);

  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Keep latest closures without re-triggering effects.
  //
  // This runs on commit rather than during render: a render-time ref write is
  // discarded along with a render React never commits, which would leave these
  // refs holding a stale closure. Declaring the effect *before* the load effect
  // below is what makes it correct — effects flush in declaration order, so the
  // load effect always observes the closures from the current render.
  useEffect(() => {
    fetcherRef.current = fetcher;
    onSessionErrorRef.current = onSessionError;
  });

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const fetchPage = useCallback(
    async (target: number, { more = false, refresh = false }: { more?: boolean; refresh?: boolean } = {}): Promise<void> => {
      const id = ++runRef.current;
      if (more) setLoadingMore(true);
      else if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetcherRef.current(target, limit);
        if (id !== runRef.current) return; // superseded by a newer request
        const next: T[] = res?.items ?? [];
        setItems((prev) => (target === 1 ? next : [...prev, ...next]));
        setTotal(res?.total ?? 0);
        // Page 1 carries the fresh totals; later pages keep them. A first-page
        // response without counts clears stale totals rather than showing them.
        if (res?.counts) setCounts(res.counts);
        else if (target === 1) setCounts(null);
        setPage(target);
        setError(null);
      } catch (err) {
        if (id !== runRef.current) return;
        setError(err);
        if (target === 1) {
          setItems([]);
          setCounts(null);
        }
        if (isSessionError(err)) onSessionErrorRef.current?.();
      } finally {
        if (id === runRef.current) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [limit]
  );

  // First load + automatic reload when filters change.
  //
  // `fetchPage` opens with a synchronous loading-mode transition: before its
  // first await it sets exactly one of `loading`, `refreshing` or `loadingMore`
  // true. That write is deliberate, and the same transition is shared by every
  // entry point — this Effect's initial load and its paramsKey reloads,
  // `reload` (retry), `refresh` (pull-to-refresh) and `loadMore` (pagination).
  // The three flags are consumer-visible state-machine signals rather than a
  // projection of the render inputs: the same serialized `params` stand behind a
  // refresh and a load-more, so deriving them would collapse those two modes.
  // What reads the stored flag is the `RefreshControl` spinner, the "Loading
  // more…" footer and `loadMore`'s own re-entrancy guard.
  //
  // This is a lint-only exception, not a race-condition workaround. Supersession
  // is already handled: every request bumps `runRef`, the success, catch and
  // finally commit paths are each guarded against a superseded id, and this
  // Effect's cleanup invalidates whatever is still in flight when the params
  // change. Deferring the call behind a microtask would only move the request
  // outside the lifetime that cleanup bounds.
  useEffect(() => {
    // Deliberate, narrow exception at this one call site — not a suppression of
    // any dependency rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPage(1);
    return () => {
      runRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, limit]);

  const reload = useCallback((): void => {
    void fetchPage(1);
  }, [fetchPage]);
  const refresh = useCallback((): void => {
    void fetchPage(1, { refresh: true });
  }, [fetchPage]);
  const loadMore = useCallback((): void => {
    if (loading || loadingMore || refreshing || page >= totalPages) return;
    void fetchPage(page + 1, { more: true });
  }, [loading, loadingMore, refreshing, page, totalPages, fetchPage]);

  return { items, total, counts, totalPages, page, loading, refreshing, loadingMore, error, reload, refresh, loadMore };
}
