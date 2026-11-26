import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import InventoryScreen from '../app/(app)/inventory';
import { inventoryApi, locationsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import {
  clearInventoryFilters,
  loadInventoryFilters,
  saveInventoryFilters,
} from '../lib/inventoryFilters';
import { ThemeProvider } from '../lib/theme-context';

/**
 * Inventory's four status choices and their restored state.
 *
 * Every chosen count is the server's total for that exact scoped query, not a
 * local count of the loaded page. Low and Out are canonical and disjoint; Needs
 * attention is their union. Route parameters win over the stored choice for the
 * dimensions they carry, and Reset deletes the stored choice.
 */

let mockRouteParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    setParams: jest.fn((next: Record<string, string>) => {
      mockRouteParams = { ...mockRouteParams, ...next };
    }),
  },
  useLocalSearchParams: () => mockRouteParams,
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
}));

jest.mock('../hooks/useRefetchOnFocus', () => ({
  __esModule: true,
  default: () => {},
}));

jest.mock('../lib/api', () => ({
  inventoryApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
}));

jest.mock('../lib/inventoryFilters', () => ({
  ...jest.requireActual('../lib/inventoryFilters'),
  loadInventoryFilters: jest.fn(),
  saveInventoryFilters: jest.fn(),
  clearInventoryFilters: jest.fn(),
}));

const mockedUseSession = useSession as jest.Mock;
const inventoryList = inventoryApi.list as jest.Mock;
const locationsList = locationsApi.list as jest.Mock;
const loadFilters = loadInventoryFilters as jest.Mock;
const saveFilters = saveInventoryFilters as jest.Mock;
const clearFilters = clearInventoryFilters as jest.Mock;
const setRouteParams = router.setParams as jest.Mock;

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

const COUNTS = { all: 12, low: 7, out: 2, needsAttention: 9 };

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = {};
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Inventory User', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  locationsList.mockResolvedValue({
    items: [
      { id: 'loc-saved', name: 'Saved Branch' },
      { id: 'route-loc', name: 'Route Branch' },
    ],
    total: 2,
  });
  loadFilters.mockResolvedValue({ locationId: '', status: '' });
  saveFilters.mockResolvedValue(undefined);
  clearFilters.mockResolvedValue(undefined);
  inventoryList.mockImplementation(async (_token: string, params: Record<string, unknown> = {}) => {
    const total = params.needsAttention
      ? COUNTS.needsAttention
      : params.stockStatus === 'LOW_STOCK'
        ? COUNTS.low
        : params.stockStatus === 'OUT_OF_STOCK'
          ? COUNTS.out
          : COUNTS.all;
    return { items: [], total, counts: COUNTS };
  });
});

const renderScreen = () => render(<InventoryScreen />, { wrapper });

const lastQuery = (): Record<string, unknown> => inventoryList.mock.calls.at(-1)?.[1] ?? {};

describe('Inventory status filters and counts', () => {
  it('★ shows the four server-backed counts and keeps the status choices exclusive', async () => {
    const view = await renderScreen();
    await waitFor(() => expect(inventoryList).toHaveBeenCalled());

    await waitFor(() => expect(view.getByText('All · 12')).toBeTruthy());
    expect(view.getByText('Needs attention · 9')).toBeTruthy();
    expect(view.getByText('Low stock · 7')).toBeTruthy();
    expect(view.getByText('Out of stock · 2')).toBeTruthy();
    expect(lastQuery()).toMatchObject({ includeCounts: true });

    fireEvent.press(view.getByText(/^Low stock/));
    await waitFor(() => expect(lastQuery().stockStatus).toBe('LOW_STOCK'));
    expect(lastQuery().lowStock).toBeUndefined();
    expect(lastQuery().outOfStock).toBeUndefined();
    expect(lastQuery().needsAttention).toBeUndefined();
    expect(view.getByText('7 stock rows low on stock')).toBeTruthy();
    expect(saveFilters).toHaveBeenCalledWith('u1', { locationId: '', status: 'low' });
    expect(setRouteParams).toHaveBeenCalledWith(
      expect.objectContaining({ needsAttention: '', stockStatus: '', lowStock: '', outOfStock: '' }),
    );

    fireEvent.press(view.getByText(/^Out of stock/));
    await waitFor(() => expect(lastQuery().stockStatus).toBe('OUT_OF_STOCK'));
    expect(lastQuery().stockStatus).not.toBe('LOW_STOCK');
    expect(lastQuery().needsAttention).toBeUndefined();
    expect(view.getByText('2 stock rows out of stock')).toBeTruthy();

    fireEvent.press(view.getByText(/^Needs attention/));
    await waitFor(() => expect(lastQuery().needsAttention).toBe(true));
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(view.getByText('9 stock rows needing attention')).toBeTruthy();

    fireEvent.press(view.getByText('All · 12'));
    await waitFor(() => expect(lastQuery().needsAttention).toBeUndefined());
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(view.queryByTestId('inventory-filter-count')).toBeNull();
    expect(saveFilters).toHaveBeenLastCalledWith('u1', { locationId: '', status: '' });
  });

  it('applies the Dashboard needsAttention deep link', async () => {
    mockRouteParams = { needsAttention: 'true' };
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().needsAttention).toBe(true));
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(view.getByText('9 stock rows needing attention')).toBeTruthy();
  });

  it('★ restores the signed-in user’s saved location and status', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: 'low' });
    const view = await renderScreen();

    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        locationId: 'loc-saved',
        stockStatus: 'LOW_STOCK',
        includeCounts: true,
      }),
    );
    expect(loadFilters).toHaveBeenCalledWith('u1');
    expect(lastQuery().needsAttention).toBeUndefined();
    expect(view.getByText('7 stock rows low on stock')).toBeTruthy();
    expect(view.getByTestId('inventory-reset-filters')).toBeTruthy();
  });

  it('★ gives explicit route parameters precedence over the saved choice', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: 'low' });
    mockRouteParams = { needsAttention: 'true', locationId: 'route-loc' };

    const view = await renderScreen();
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        locationId: 'route-loc',
        needsAttention: true,
      }),
    );
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(loadFilters).not.toHaveBeenCalled();
    expect(view.getByText('9 stock rows needing attention')).toBeTruthy();
  });

  it('restores the saved location when only the route status is supplied', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: 'low' });
    mockRouteParams = { needsAttention: 'true' };

    await renderScreen();
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        locationId: 'loc-saved',
        needsAttention: true,
      }),
    );
    expect(lastQuery().stockStatus).toBeUndefined();
  });

  it('★ applies a new deep link over the filter already on screen', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: 'low' });
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().stockStatus).toBe('LOW_STOCK'));
    mockRouteParams = { needsAttention: 'true' };
    view.rerender(<InventoryScreen />);

    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        locationId: 'loc-saved',
        needsAttention: true,
      }),
    );
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(view.getByText('9 stock rows needing attention')).toBeTruthy();
  });

  it('applies a new q deep link over the screen already open', async () => {
    const view = await renderScreen();
    await waitFor(() => expect(inventoryList).toHaveBeenCalled());

    mockRouteParams = { q: 'Widget' };
    view.rerender(<InventoryScreen />);

    await waitFor(() => expect(lastQuery().q).toBe('Widget'));
  });

  it('★ ignores a saved location that is no longer active and offers Reset', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-gone', status: '' });
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().locationId).toBeUndefined());
    expect(view.getByTestId('inventory-reset-filters')).toBeTruthy();
  });

  it('★ ignores an archived deep-linked location and explains the repair', async () => {
    mockRouteParams = { locationId: 'loc-gone' };
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().locationId).toBeUndefined());
    expect(view.getByTestId('inventory-location-unavailable')).toBeTruthy();
    expect(view.getByText('That location is archived or unavailable. Showing all locations.')).toBeTruthy();
    expect(view.getByTestId('inventory-reset-filters')).toBeTruthy();
  });

  it('★ preserves a saved location that is beyond the first active-locations page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `loc-page-one-${index}`,
      name: `Location ${index}`,
    }));
    locationsList.mockImplementation(async (_token: string, params: { page?: number } = {}) => {
      if (params.page === 2) {
        return { items: [{ id: 'loc-saved', name: 'Saved Branch' }], total: 101, totalPages: 2 };
      }
      return { items: firstPage, total: 101, totalPages: 2 };
    });
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: '' });

    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().locationId).toBe('loc-saved'));
    await waitFor(() =>
      expect(locationsList).toHaveBeenCalledWith('token-1', {
        status: 'ACTIVE',
        page: 2,
        limit: 100,
      }),
    );
    expect(view.getByText('Saved Branch')).toBeTruthy();
  });

  it('does not clear a saved location when the active list cannot be completed', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `loc-page-one-${index}`,
      name: `Location ${index}`,
    }));
    locationsList.mockImplementation(async (_token: string, params: { page?: number } = {}) => {
      if (params.page === 2) throw new Error('active locations unavailable');
      return { items: firstPage, total: 101, totalPages: 2 };
    });
    loadFilters.mockResolvedValue({ locationId: 'loc-on-second-page', status: '' });

    await renderScreen();

    await waitFor(() =>
      expect(locationsList).toHaveBeenCalledWith('token-1', {
        status: 'ACTIVE',
        page: 2,
        limit: 100,
      }),
    );
    await waitFor(() => expect(inventoryList).toHaveBeenCalled());
    expect(lastQuery().locationId).toBe('loc-on-second-page');
  });

  it('★ resets both filters and deletes the saved choice', async () => {
    loadFilters.mockResolvedValue({ locationId: 'loc-saved', status: 'low' });
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().stockStatus).toBe('LOW_STOCK'));
    fireEvent.press(view.getByTestId('inventory-reset-filters'));

    await waitFor(() => expect(lastQuery().stockStatus).toBeUndefined());
    expect(lastQuery().locationId).toBeUndefined();
    expect(lastQuery().needsAttention).toBeUndefined();
    expect(clearFilters).toHaveBeenCalledWith('u1');
    expect(setRouteParams).toHaveBeenCalledWith({ locationId: '', location: '' });
    expect(view.queryByTestId('inventory-filter-count')).toBeNull();
    expect(view.queryByTestId('inventory-reset-filters')).toBeNull();
  });

  it('Clear removes only the active status and saves the cleared choice', async () => {
    mockRouteParams = { needsAttention: 'true' };
    const view = await renderScreen();

    await waitFor(() => expect(lastQuery().needsAttention).toBe(true));
    fireEvent.press(view.getByText('Clear'));
    // The real router re-renders with the cleared params; the mock's
    // setParams updates the backing object, so make that transition explicit.
    view.rerender(<InventoryScreen />);

    await waitFor(() => expect(lastQuery().needsAttention).toBeUndefined());
    expect(lastQuery().stockStatus).toBeUndefined();
    expect(saveFilters).toHaveBeenCalledWith('u1', { locationId: '', status: '' });
  });
});
