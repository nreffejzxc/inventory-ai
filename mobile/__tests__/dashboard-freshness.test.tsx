import { fireEvent, render, waitFor } from '@testing-library/react-native';

import DashboardScreen from '../app/(app)/dashboard';
import { dashboardApi, locationsApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

/**
 * The summary, the restock preview and open purchase orders are one screen but
 * three independent reads. A failure in either secondary section must leave the
 * summary and the other section visible, and each failure must have its own
 * retry rather than forcing a full reload.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), setParams: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: () => false,
}));

jest.mock('../lib/api', () => ({
  dashboardApi: { summary: jest.fn() },
  productsApi: { list: jest.fn(), reorder: jest.fn() },
  purchaseOrdersApi: { list: jest.fn() },
  categoriesApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const summary = dashboardApi.summary as jest.Mock;
const reorder = productsApi.reorder as jest.Mock;
const poList = purchaseOrdersApi.list as jest.Mock;
const locationsList = locationsApi.list as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: ROLES.MANAGER },
    token: 'token-1',
    signOut: jest.fn(),
  });
  summary.mockResolvedValue({
    inStockProducts: 9,
    lowStockProducts: 4,
    outOfStockProducts: 1,
    totalProducts: 14,
    totalInventoryQuantity: 136,
  });
  locationsList.mockResolvedValue({ items: [], total: 0 });
});

it('★ retries the restock preview without discarding the summary', async () => {
  reorder.mockRejectedValueOnce(new Error('preview unavailable'));
  poList.mockResolvedValue({ items: [], total: 0 });

  const view = await render(
    <ThemeProvider>
      <DashboardScreen />
    </ThemeProvider>
  );

  await waitFor(() => expect(view.getByText('Restock preview unavailable')).toBeTruthy());
  expect(view.getByText('In stock')).toBeTruthy();
  expect(view.getByText('No open purchase orders — nothing is awaiting receipt.')).toBeTruthy();
  expect(view.getByText(/^Last updated /)).toBeTruthy();
  expect(view.getByTestId('dashboard-summary-updated')).toBeTruthy();

  reorder.mockResolvedValueOnce({
    items: [
      {
        id: 'p1',
        name: 'Recovered product',
        availableQuantity: 1,
        minimumStock: 3,
        stockStatus: 'LOW_STOCK',
      },
    ],
  });
  fireEvent.press(view.getByTestId('dashboard-retry-restock'));

  await waitFor(() => expect(view.getByText('Recovered product')).toBeTruthy());
  expect(view.queryByText('Restock preview unavailable')).toBeNull();
  expect(view.queryByTestId('dashboard-retry-restock')).toBeNull();
  expect(summary).toHaveBeenCalledTimes(1);
  expect(poList).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('dashboard-summary-updated')).toBeTruthy();

  view.unmount();
});

it('★ keeps the restock rows when purchase orders fail, and retries only purchase orders', async () => {
  reorder.mockResolvedValue({
    items: [
      {
        id: 'p1',
        name: 'Low product',
        availableQuantity: 1,
        minimumStock: 3,
        stockStatus: 'LOW_STOCK',
      },
    ],
  });
  poList.mockRejectedValueOnce(new Error('procurement unavailable'));

  const view = await render(
    <ThemeProvider>
      <DashboardScreen />
    </ThemeProvider>
  );

  await waitFor(() => expect(view.getByText('Low product')).toBeTruthy());
  await waitFor(() => expect(view.getByText('Open purchase orders unavailable')).toBeTruthy());
  expect(view.queryByText('Restock preview unavailable')).toBeNull();

  poList.mockResolvedValueOnce({ items: [], total: 0 });
  fireEvent.press(view.getByTestId('dashboard-retry-open-pos'));

  await waitFor(() =>
    expect(view.getByText('No open purchase orders — nothing is awaiting receipt.')).toBeTruthy()
  );
  expect(view.queryByTestId('dashboard-retry-open-pos')).toBeNull();
  expect(summary).toHaveBeenCalledTimes(1);
  expect(reorder).toHaveBeenCalledTimes(1);

  view.unmount();
});
