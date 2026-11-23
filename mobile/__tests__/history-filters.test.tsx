import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import HistoryScreen from '../app/(app)/history';
import { inventoryApi, locationsApi, productsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ThemeProvider } from '../lib/theme-context';

/**
 * History's product and location filters must read every active-reference
 * page. A saved/deep-linked filter can name a row after the first 100, and it
 * must remain selected and continue to scope the history request.
 */

let mockRouteParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockRouteParams,
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: () => false,
}));

jest.mock('../lib/api', () => ({
  inventoryApi: { history: jest.fn() },
  productsApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const history = inventoryApi.history as jest.Mock;
const productsList = productsApi.list as jest.Mock;
const locationsList = locationsApi.list as jest.Mock;

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

const firstPage = (prefix: string, label: string) =>
  Array.from({ length: 100 }, (_, index) => ({
    id: `${prefix}-page-one-${index}`,
    name: `${label} ${index}`,
  }));

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = {};
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'History User', role: 'MANAGER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  history.mockResolvedValue({ items: [], total: 0, totalPages: 1 });
  productsList.mockImplementation(async (_token: string, params: { page?: number } = {}) => {
    if (params.page === 2) {
      return {
        items: [{ id: 'product-page-two', name: 'Page-two product' }],
        total: 101,
        totalPages: 2,
      };
    }
    return { items: firstPage('product', 'Product'), total: 101, totalPages: 2 };
  });
  locationsList.mockImplementation(async (_token: string, params: { page?: number } = {}) => {
    if (params.page === 2) {
      return {
        items: [{ id: 'location-page-two', name: 'Page-two location' }],
        total: 101,
        totalPages: 2,
      };
    }
    return { items: firstPage('location', 'Location'), total: 101, totalPages: 2 };
  });
});

const lastHistoryQuery = (): Record<string, unknown> => history.mock.calls.at(-1)?.[1] ?? {};

it('★ keeps saved product and location filters from page two selected and applied', async () => {
  mockRouteParams = {
    productId: 'product-page-two',
    locationId: 'location-page-two',
  };

  const view = await render(<HistoryScreen />, { wrapper });

  await waitFor(() =>
    expect(productsList).toHaveBeenCalledWith('token-1', {
      status: 'ACTIVE',
      page: 2,
      limit: 100,
    })
  );
  await waitFor(() =>
    expect(locationsList).toHaveBeenCalledWith('token-1', {
      status: 'ACTIVE',
      page: 2,
      limit: 100,
    })
  );
  await waitFor(() => expect(view.getByText('Page-two product')).toBeTruthy());
  expect(view.getByText('Page-two location')).toBeTruthy();
  expect(lastHistoryQuery()).toMatchObject({
    productId: 'product-page-two',
    locationId: 'location-page-two',
  });
});

it('resolves a saved location name from the second active page', async () => {
  mockRouteParams = { locationName: 'Page-two location' };

  render(<HistoryScreen />, { wrapper });

  await waitFor(() => expect(lastHistoryQuery().locationId).toBe('location-page-two'));
  expect(history).toHaveBeenCalledWith(
    'token-1',
    expect.objectContaining({ locationId: 'location-page-two' })
  );
});

it('★ waits for every active page before applying a name-only filter', async () => {
  mockRouteParams = { locationName: 'Location 0' };

  let releasePageTwo: ((value: unknown) => void) | undefined;
  const pageTwo = new Promise((resolve) => {
    releasePageTwo = resolve;
  });
  locationsList.mockImplementation(async (_token: string, params: { page?: number } = {}) => {
    if (params.page === 2) return pageTwo;
    return { items: firstPage('location', 'Location'), total: 101, totalPages: 2 };
  });

  render(<HistoryScreen />, { wrapper });

  await waitFor(() => expect(locationsList).toHaveBeenCalledWith('token-1', {
    status: 'ACTIVE',
    page: 1,
    limit: 100,
  }));
  // A matching name is on page one, but the server says another page exists: do
  // not scope the history query to a row the incomplete list merely happens to hold.
  expect(lastHistoryQuery().locationId).toBeUndefined();

  releasePageTwo?.({ items: [{ id: 'location-page-two', name: 'Page-two location' }], total: 101, totalPages: 2 });

  await waitFor(() => expect(lastHistoryQuery().locationId).toBe('location-page-one-0'));
  expect(history).toHaveBeenCalledWith(
    'token-1',
    expect.objectContaining({ locationId: 'location-page-one-0' })
  );
});
