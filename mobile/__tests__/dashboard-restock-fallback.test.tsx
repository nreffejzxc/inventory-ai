import { fireEvent, render, waitFor } from '@testing-library/react-native';

import DashboardScreen from '../app/(app)/dashboard';
import { dashboardApi, locationsApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

/**
 * The restock preview is optional; the summary counts are not. When the preview
 * request fails, the Overview must still offer the row-level Needs attention
 * route rather than hiding the whole section.
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
  reorder.mockRejectedValue(new Error('preview unavailable'));
  poList.mockResolvedValue({ items: [], total: 0 });
  locationsList.mockResolvedValue({ items: [], total: 0 });
});

it('★ keeps a summary-backed row route when the restock preview fails', async () => {
  const view = await render(
    <ThemeProvider>
      <DashboardScreen />
    </ThemeProvider>
  );

  await waitFor(() => expect(summary).toHaveBeenCalled());
  await waitFor(() => expect(view.getByText('Restock preview unavailable')).toBeTruthy());
  expect(view.getByText(/4 low and 1 out of stock/)).toBeTruthy();

  fireEvent.press(view.getByTestId('dashboard-attention-rows'));
  expect(mockPush).toHaveBeenCalledWith('/inventory?needsAttention=true');

  view.unmount();
});
