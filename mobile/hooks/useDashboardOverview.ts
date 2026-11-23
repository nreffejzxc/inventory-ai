import { useCallback, useEffect, useRef, useState } from 'react';

import { dashboardApi, productsApi, purchaseOrdersApi } from '../lib/api';
import type { ApiResponse } from '../lib/api';
import { isSessionError } from '../lib/auth';

export type DashboardSectionState = 'idle' | 'loading' | 'ok' | 'error';

export interface DashboardSection<T> {
  data: T | null;
  state: DashboardSectionState;
}

/** Only the summary has a rendered error and a displayed last-read time. */
export interface DashboardSummarySection extends DashboardSection<ApiResponse> {
  error: unknown;
  updatedAt: number | null;
}

export interface DashboardOverview {
  summary: DashboardSummarySection;
  restock: DashboardSection<ApiResponse[]>;
  openPos: DashboardSection<ApiResponse[]>;
  /** True only while the summary is loading and there is nothing to show yet. */
  loading: boolean;
  /** True while a full refresh is running, including its dependent sections. */
  refreshing: boolean;
  reload: () => Promise<void>;
  reloadRestock: () => Promise<void>;
  reloadOpenPos: () => Promise<void>;
}

const idleSection = <T,>(): DashboardSection<T> => ({
  data: null,
  state: 'idle',
});

const loadingSection = <T,>(current: DashboardSection<T>): DashboardSection<T> => ({
  ...current,
  state: 'loading',
});

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function attentionCount(summary: ApiResponse | null): number {
  return count(summary?.lowStockProducts) + count(summary?.outOfStockProducts);
}

/**
 * One Dashboard snapshot with independently observable sections.
 *
 * The summary owns the screen; the restock preview and open purchase orders are
 * secondary. Each section therefore has its own state, error and retry, so one
 * failed request cannot make another section look empty or make the whole
 * screen look stale. Sequence numbers discard late answers from an older
 * reload.
 */
export function useDashboardOverview({
  token,
  signOut,
  canSeePos,
}: {
  token: string | null;
  signOut: () => Promise<void>;
  canSeePos: boolean;
}): DashboardOverview {
  const [summary, setSummary] = useState<DashboardSummarySection>({
    data: null,
    state: 'loading',
    error: null,
    updatedAt: null,
  });
  const [restock, setRestock] = useState<DashboardSection<ApiResponse[]>>(idleSection());
  const [openPos, setOpenPos] = useState<DashboardSection<ApiResponse[]>>(idleSection());
  const [refreshing, setRefreshing] = useState(true);

  const summarySeq = useRef(0);
  const restockSeq = useRef(0);
  const openPosSeq = useRef(0);
  const refreshSeq = useRef(0);
  const signedOut = useRef(false);

  const handleError = useCallback(
    async (err: unknown): Promise<void> => {
      if (isSessionError(err) && !signedOut.current) {
        signedOut.current = true;
        await signOut();
      }
    },
    [signOut]
  );

  const loadRestock = useCallback(
    async (attention: number): Promise<void> => {
      const requestId = ++restockSeq.current;
      if (!token) {
        setRestock(idleSection());
        return;
      }
      if (attention === 0) {
        setRestock({ data: [], state: 'ok' });
        return;
      }
      setRestock(loadingSection);
      try {
        const res = await productsApi.reorder(token, { limit: 5 });
        if (requestId !== restockSeq.current) return;
        setRestock({ data: res.items ?? [], state: 'ok' });
      } catch (err) {
        if (requestId !== restockSeq.current) return;
        setRestock((current) => ({ ...current, state: 'error' }));
        await handleError(err);
      }
    },
    [handleError, token]
  );

  const loadOpenPos = useCallback(async (): Promise<void> => {
    const requestId = ++openPosSeq.current;
    if (!canSeePos || !token) {
      setOpenPos(idleSection());
      return;
    }
    setOpenPos(loadingSection);
    try {
      const res = await purchaseOrdersApi.list(token, { status: 'OPEN', limit: 3 });
      if (requestId !== openPosSeq.current) return;
      setOpenPos({ data: res.items ?? [], state: 'ok' });
    } catch (err) {
      if (requestId !== openPosSeq.current) return;
      setOpenPos((current) => ({ ...current, state: 'error' }));
      await handleError(err);
    }
  }, [canSeePos, handleError, token]);

  const reload = useCallback(async (): Promise<void> => {
    if (!token) {
      setRefreshing(false);
      return;
    }
    const refreshId = ++refreshSeq.current;
    const thisSummarySeq = ++summarySeq.current;
    // Invalidate section requests from the previous refresh before starting new
    // ones; their answers are no longer part of this snapshot.
    restockSeq.current += 1;
    signedOut.current = false;
    setRefreshing(true);
    setSummary((current) => ({ ...current, state: 'loading', error: null }));
    if (canSeePos) setOpenPos(loadingSection);
    else {
      openPosSeq.current += 1;
      setOpenPos(idleSection());
    }
    setRestock(loadingSection);

    // The purchase-order list does not depend on the summary, so it starts in
    // parallel. The restock preview does: only a summary that reports attention
    // should ask for it. The refresh stays active until all of them settle.
    const openPosPromise = canSeePos ? loadOpenPos() : Promise.resolve();
    try {
      const data = await dashboardApi.summary(token);
      if (thisSummarySeq !== summarySeq.current) return;
      setSummary({ data, state: 'ok', error: null, updatedAt: Date.now() });
      await loadRestock(attentionCount(data));
    } catch (err) {
      if (thisSummarySeq !== summarySeq.current) return;
      restockSeq.current += 1;
      setSummary((current) => ({ ...current, state: 'error', error: err }));
      setRestock(idleSection());
      await handleError(err);
    } finally {
      await openPosPromise;
      if (refreshId === refreshSeq.current) setRefreshing(false);
    }
  }, [canSeePos, handleError, loadOpenPos, loadRestock, token]);

  const reloadRestock = useCallback(async (): Promise<void> => {
    await loadRestock(attentionCount(summary.data));
  }, [loadRestock, summary.data]);

  const reloadOpenPos = useCallback(async (): Promise<void> => {
    await loadOpenPos();
  }, [loadOpenPos]);

  useEffect(() => {
    reload();
    return () => {
      summarySeq.current += 1;
      restockSeq.current += 1;
      openPosSeq.current += 1;
      refreshSeq.current += 1;
    };
  }, [reload]);

  return {
    summary,
    restock,
    openPos,
    loading: summary.state === 'loading' && summary.data === null,
    refreshing,
    reload,
    reloadRestock,
    reloadOpenPos,
  };
}
