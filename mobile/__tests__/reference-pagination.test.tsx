import { renderHook, waitFor } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';

import { referenceAvailability, useActiveRef } from '../hooks/useReferences';

/**
 * Active-reference pickers must read every page, not only the first. The
 * resource list is paged by the server, so a single page silently hides every
 * active product/location/category after row 100 — including a value restored
 * from a draft or deep link.
 *
 * A failed later page is not an empty catalogue: the pages already read stay
 * usable and `complete` stays false, which also prevents a caller from treating
 * an unknown id as deleted.
 */

const page = (ids: string[], total: number, totalPages: number) => ({
  items: ids.map((id) => ({ id, name: `Item ${id}` })),
  total,
  totalPages,
});

describe('useActiveRef all-pages selection', () => {
  it('★ walks every page and marks the list complete', async () => {
    const api = {
      list: jest
        .fn()
        .mockResolvedValueOnce(page(['1'], 3, 3))
        .mockResolvedValueOnce(page(['2'], 3, 3))
        .mockResolvedValueOnce(page(['3'], 3, 3)),
    };

    const { result } = await renderHook(() => useActiveRef('token', api, { allPages: true, limit: 1 }));

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.items.map((item) => item.id)).toEqual(['1', '2', '3']);
    expect(api.list.mock.calls.map((call) => call[1].page)).toEqual([1, 2, 3]);
  });

  it('★ uses the server page count when it applies a smaller page size', async () => {
    const api = {
      list: jest
        .fn()
        .mockResolvedValueOnce({ items: [{ id: '1' }], total: 3, totalPages: 3 })
        .mockResolvedValueOnce({ items: [{ id: '2' }], total: 3, totalPages: 3 })
        .mockResolvedValueOnce({ items: [{ id: '3' }], total: 3, totalPages: 3 }),
    };

    const { result } = await renderHook(() => useActiveRef('token', api, { allPages: true, limit: 100 }));

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.items.map((item) => item.id)).toEqual(['1', '2', '3']);
    expect(api.list.mock.calls.map((call) => call[1].page)).toEqual([1, 2, 3]);
  });

  it('★ keeps the pages already read when a later page fails', async () => {
    const api = {
      list: jest
        .fn()
        .mockResolvedValueOnce(page(['1'], 2, 2))
        .mockRejectedValueOnce(new Error('page two unavailable')),
    };

    const { result } = await renderHook(() => useActiveRef('token', api, { allPages: true, limit: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((item) => item.id)).toEqual(['1']);
    expect(result.current.complete).toBe(false);
  });

  it('de-duplicates repeated ids without claiming a complete list', async () => {
    const api = {
      list: jest
        .fn()
        .mockResolvedValueOnce(page(['1'], 20, 2))
        .mockResolvedValueOnce(page(['1', '2'], 20, 2)),
    };

    const { result } = await renderHook(() => useActiveRef('token', api, { allPages: true, limit: 10 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((item) => item.id)).toEqual(['1', '2']);
    expect(result.current.complete).toBe(false);
  });

  it('does not read a second page when allPages is not requested', async () => {
    const api = { list: jest.fn().mockResolvedValue(page(['1'], 2, 2)) };

    const { result } = await renderHook(() => useActiveRef('token', api, { limit: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(result.current.complete).toBe(false);
  });

  it('★ clears the previous account rows when the token changes and the new read fails', async () => {
    // A shared device can sign out of one account and into another. The old
    // account's rows must not remain visible while the new account's first page
    // is in flight, nor after that page fails.
    const api = {
      list: jest
        .fn()
        .mockResolvedValueOnce(page(['account-a'], 1, 1))
        .mockRejectedValueOnce(new Error('new account unavailable')),
    };

    const { result, rerender } = await renderHook(
      ({ token }: { token: string }) => useActiveRef(token, api, { allPages: true }),
      { initialProps: { token: 'token-a' } },
    );

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.items.map((item) => item.id)).toEqual(['account-a']);

    rerender({ token: 'token-b' });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.complete).toBe(false);
  });
});

describe('referenceAvailability', () => {
  it('only calls an id missing after the complete list is known', () => {
    const items = [{ id: 'loc-1' }];
    expect(referenceAvailability('loc-1', { items, complete: true })).toBe('available');
    expect(referenceAvailability('loc-gone', { items, complete: true })).toBe('missing');
    expect(referenceAvailability('loc-gone', { items, complete: false })).toBe('checking');
    expect(referenceAvailability('', { items, complete: true })).toBe('none');
  });
});

describe('picker and filter call sites request every active page', () => {
  const root = path.join(__dirname, '..');
  const sources: [string, string[]][] = [
    ['components/MovementForm.tsx', ['productsApi', 'locationsApi']],
    ['components/TransferForm.tsx', ['productsApi', 'locationsApi']],
    ['components/PoForm.tsx', ['suppliersApi', 'locationsApi', 'productsApi']],
    ['components/ProductForm.tsx', ['categoriesApi']],
    ['app/(app)/products/index.tsx', ['categoriesApi', 'locationsApi']],
    ['app/(app)/restock.tsx', ['categoriesApi']],
    ['app/(app)/purchase-orders/from-restock.tsx', ['suppliersApi', 'locationsApi']],
    ['app/(app)/history.tsx', ['productsApi', 'locationsApi']],
  ];

  it.each(sources)('%s', (relative, apis) => {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const api of apis) {
      expect(source).toMatch(
        new RegExp(`useActiveRef\\(token, ${api}, \\{ allPages: true \\}\\)`),
      );
    }
  });
});
