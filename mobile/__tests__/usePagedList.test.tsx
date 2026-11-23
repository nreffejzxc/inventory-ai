import { act, renderHook, waitFor } from '@testing-library/react-native';

import usePagedList, { type PageEnvelope } from '../hooks/usePagedList';

/**
 * MOD-08 — ref-safety guard for `usePagedList`.
 *
 * The hook keeps its `fetcher` and `onSessionError` in refs so that a caller
 * passing a fresh closure on every render cannot re-trigger the load effect.
 * MOD-08 moves those ref writes out of render (where React forbids them) and
 * into a commit-phase effect, so the properties pinned here are the ones that
 * must survive that move: *when* a request is issued, *which closure* it uses,
 * and which response wins when several are in flight.
 *
 * `lib/auth` is mocked because the hook imports `isSessionError` from it and
 * that module pulls in the session provider; nothing else is mocked, so
 * pagination, the paging guards and the supersede logic under test are the
 * real ones.
 */

const mockIsSessionError = jest.fn(() => false);

jest.mock('../lib/auth', () => ({
  isSessionError: (...args: unknown[]) => mockIsSessionError(...(args as [])),
}));

type Item = { id: string };

const page = (ids: string[], total = ids.length): PageEnvelope<Item> => ({ items: ids.map((id) => ({ id })), total });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSessionError.mockReturnValue(false);
});

describe('usePagedList — request timing', () => {
  it('fetches page 1 with the current fetcher on mount', async () => {
    const fetcher = jest.fn(async () => page(['a']));
    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 20 }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(1, 20);
    expect(result.current.items).toEqual([{ id: 'a' }]);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('reloads page 1 when params change', async () => {
    const fetcher = jest.fn(async () => page([]));
    const { rerender } = await renderHook(
      ({ params }: { params: Record<string, unknown> }) => usePagedList<Item>(fetcher, { params, limit: 20 }),
      { initialProps: { params: { q: 'a' } } }
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await rerender({ params: { q: 'b' } });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenLastCalledWith(1, 20);
  });

  it('does not refetch when a new params object has the same serialization', async () => {
    const fetcher = jest.fn(async () => page([]));
    const { rerender } = await renderHook(
      ({ params }: { params: Record<string, unknown> }) => usePagedList<Item>(fetcher, { params, limit: 20 }),
      { initialProps: { params: { q: 'a' } } }
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await rerender({ params: { q: 'a' } });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('usePagedList — callback freshness', () => {
  it('uses the newest fetcher for reload(), not the one captured at mount', async () => {
    const first = jest.fn(async () => page(['first']));
    const second = jest.fn(async () => page(['second']));

    const { result, rerender } = await renderHook(
      ({ fetcher }: { fetcher: typeof first }) => usePagedList<Item>(fetcher, { limit: 20 }),
      { initialProps: { fetcher: first } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(first).toHaveBeenCalledTimes(1);

    // A new fetcher alone must not re-issue the initial request.
    await rerender({ fetcher: second });
    expect(second).not.toHaveBeenCalled();

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'second' }]));

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('uses the newest fetcher for loadMore()', async () => {
    const first = jest.fn(async (targetPage: number) => page([`first-${targetPage}`], 2));
    const second = jest.fn(async (targetPage: number) => page([`second-${targetPage}`], 2));

    const { result, rerender } = await renderHook(
      ({ fetcher }: { fetcher: typeof first }) => usePagedList<Item>(fetcher, { limit: 1 }),
      { initialProps: { fetcher: first } }
    );
    await waitFor(() => expect(result.current.totalPages).toBe(2));

    await rerender({ fetcher: second });
    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'first-1' }, { id: 'second-2' }]));
    expect(second).toHaveBeenCalledWith(2, 1);
  });

  it('calls the newest onSessionError when a session error surfaces', async () => {
    const failure = Object.assign(new Error('token expired'), { status: 401 });
    const failing = jest.fn(async () => {
      throw failure;
    });
    const firstOnSessionError = jest.fn();
    const secondOnSessionError = jest.fn();

    mockIsSessionError.mockReturnValue(true);

    const { result, rerender } = await renderHook(
      ({ onSessionError }: { onSessionError: () => void }) =>
        usePagedList<Item>(failing, { limit: 20, onSessionError }),
      { initialProps: { onSessionError: firstOnSessionError } }
    );
    await waitFor(() => expect(result.current.error).toBe(failure));

    await rerender({ onSessionError: secondOnSessionError });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(secondOnSessionError).toHaveBeenCalledTimes(1));

    expect(firstOnSessionError).toHaveBeenCalledTimes(1);
  });
});

describe('usePagedList — pagination', () => {
  it('appends the next page on loadMore()', async () => {
    const fetcher = jest.fn(async (targetPage: number) => page([`p${targetPage}`], 2));
    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalPages).toBe(2);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.page).toBe(2));

    expect(fetcher).toHaveBeenLastCalledWith(2, 1);
    expect(result.current.items).toEqual([{ id: 'p1' }, { id: 'p2' }]);
  });

  it('keeps page-1 counts while paging and clears them when a reload omits them', async () => {
    let includeCounts = true;
    const fetcher = jest.fn(async (targetPage: number) => ({
      ...page([`p${targetPage}`], 2),
      ...(targetPage === 1 && includeCounts
        ? { counts: { all: 2, needsAttention: 1, low: 1, out: 0 } }
        : {}),
    }));
    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 1 }));

    await waitFor(() => expect(result.current.counts).toEqual({ all: 2, needsAttention: 1, low: 1, out: 0 }));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.page).toBe(2));
    expect(result.current.counts).toEqual({ all: 2, needsAttention: 1, low: 1, out: 0 });

    includeCounts = false;
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.page).toBe(1));
    expect(result.current.counts).toBeNull();
  });

  it('does not page past the last page', async () => {
    const fetcher = jest.fn(async () => page(['only'], 1));
    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 20 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      result.current.loadMore();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clears the list when the first page fails', async () => {
    const failure = new Error('boom');
    const fetcher = jest.fn(async () => {
      throw failure;
    });
    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 20 }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(failure);
    expect(result.current.items).toEqual([]);
  });
});

describe('usePagedList — in-flight protection', () => {
  it('discards a superseded response so the newest request wins', async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;

    const fetcher = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        await gate;
        return page(['stale']);
      }
      return page(['fresh']);
    });

    const { result } = await renderHook(() => usePagedList<Item>(fetcher, { limit: 20 }));

    // The mount request is still in flight; a reload supersedes it.
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'fresh' }]));

    // Let the superseded response land late: it must not overwrite the winner.
    await act(async () => {
      releaseFirst();
    });
    expect(result.current.items).toEqual([{ id: 'fresh' }]);
    expect(result.current.loading).toBe(false);
  });
});
