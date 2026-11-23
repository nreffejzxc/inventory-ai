import { fireEvent, render, waitFor } from '@testing-library/react-native';

import DashboardScreen from '../app/(app)/dashboard';
import { dashboardApi, locationsApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

/**
 * The Dashboard's Needs attention section has two distinct destinations:
 * - the existing product-level Restock list; and
 * - the per-location stock ROWS, opened with needsAttention=true.
 *
 * The labels have to keep those populations distinct: one product can be low at
 * one location and healthy at another, so the row total is not the product total.
 */

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href), setParams: jest.fn() },
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
  poList.mockResolvedValue({ items: [], total: 0 });
  locationsList.mockResolvedValue({ items: [], total: 0 });
});

it('does not offer the row-level action when nothing needs attention', async () => {
  summary.mockResolvedValue({
    inStockProducts: 14,
    lowStockProducts: 0,
    outOfStockProducts: 0,
    totalProducts: 14,
    totalInventoryQuantity: 136,
  });
  reorder.mockResolvedValue({ items: [] });

  const view = await render(
    <ThemeProvider>
      <DashboardScreen />
    </ThemeProvider>
  );

  await waitFor(() => expect(summary).toHaveBeenCalled());
  await waitFor(() => expect(view.getByText('All caught up')).toBeTruthy());
  await waitFor(() => expect(view.getByText('No open purchase orders — nothing is awaiting receipt.')).toBeTruthy());
  expect(view.queryByTestId('dashboard-attention-rows')).toBeNull();
  expect(reorder).not.toHaveBeenCalled();

  view.unmount();
});

it('★ offers both the row-level attention route and the existing Restock link', async () => {
  const view = await render(
    <ThemeProvider>
      <DashboardScreen />
    </ThemeProvider>
  );

  await waitFor(() => expect(summary).toHaveBeenCalled());
  await waitFor(() => expect(reorder).toHaveBeenCalled());
  await waitFor(() => expect(view.getByTestId('dashboard-attention-rows')).toBeTruthy());
  await waitFor(() => expect(view.getByText('No open purchase orders — nothing is awaiting receipt.')).toBeTruthy());

  fireEvent.press(view.getByTestId('dashboard-attention-rows'));
  expect(mockPush).toHaveBeenCalledWith('/inventory?needsAttention=true');

  fireEvent.press(view.getByText('View all'));
  expect(mockPush).toHaveBeenCalledWith('/restock');

  view.unmount();
});
