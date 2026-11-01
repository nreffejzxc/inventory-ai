import { Stack, router } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';

import { dashboardApi, inventoryApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

import DashboardScreen from '../app/(app)/dashboard';
import InventoryRowScreen from '../app/(app)/inventory/[id]';
import PurchaseOrderDetailScreen from '../app/(app)/purchase-orders/[id]/index';

/**
 * MOD-10C — one request on mount, one more on refocus.
 *
 * These three screens used to combine their initial load and their focus
 * refresh in a single effect:
 *
 *     useEffect(() => {
 *       load();
 *       const unsub = navigation.addListener('focus', load);
 *       return () => unsub?.();
 *     }, [load, navigation]);
 *
 * React Navigation emits `focus` for the initially focused route on its first
 * commit — after the screen's own effect has already subscribed — so the mount
 * itself satisfied the listener and every open fetched **twice**. The screens
 * now keep the initial-load effect and delegate the refresh to
 * `useRefetchOnFocus`, which deliberately skips the first focus.
 *
 * The hook has its own suite, but that suite mocks `useFocusEffect` and so
 * cannot see the behaviour that actually caused the defect: an extra `focus`
 * emitted by the real navigator on mount. These cases therefore run the real
 * expo-router tree via `renderRouter` and count the real API calls, which is
 * the level the regression lives at.
 *
 * Rollback contract: if any screen goes back to a raw `focus` listener, the
 * mount assertion for that screen fails with 2 calls instead of 1.
 */

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: () => false,
}));

jest.mock('../lib/api', () => ({
  dashboardApi: { summary: jest.fn() },
  productsApi: { reorder: jest.fn() },
  purchaseOrdersApi: {
    get: jest.fn(),
    list: jest.fn(),
    issue: jest.fn(),
    cancel: jest.fn(),
  },
  inventoryApi: { get: jest.fn() },
  // Reached transitively through `components/PoForm`; never called here.
  locationsApi: {},
  suppliersApi: {},
}));

const mockedUseSession = useSession as jest.Mock;
const summary = dashboardApi.summary as jest.Mock;
const reorder = productsApi.reorder as jest.Mock;
const poList = purchaseOrdersApi.list as jest.Mock;
const poGet = purchaseOrdersApi.get as jest.Mock;
const inventoryGet = inventoryApi.get as jest.Mock;

// A module constant, not a fresh function per render: `load` is memoized on
// `signOut`, and a new identity each render would re-run the load effect.
const mockSignOut = jest.fn();

const signInAsManager = (): void => {
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: ROLES.MANAGER },
    token: 'token-1',
    signOut: mockSignOut,
  });
};

const StackLayout = () => <Stack />;
const ChildScreen = () => <Text>Child screen</Text>;

/** A real navigator: real focus/blur events, real `useNavigation`. */
const ROUTES = {
  _layout: StackLayout,
  index: DashboardScreen,
  child: ChildScreen,
  'inventory/[id]': InventoryRowScreen,
  'purchase-orders/[id]/index': PurchaseOrderDetailScreen,
};

const mountAt = (initialUrl: string) => renderRouter(ROUTES, { initialUrl, wrapper: ThemeProvider });

/** Push a child (the screen blurs), then come back (it regains focus). */
const leaveAndReturn = async (): Promise<void> => {
  await act(async () => {
    router.push('/child');
  });
  await act(async () => {
    router.back();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  signInAsManager();
  // `lowStockProducts` > 0 is what makes the dashboard also fetch the restock
  // preview, so all three of its mount requests are counted.
  summary.mockResolvedValue({ lowStockProducts: 2, outOfStockProducts: 0 });
  reorder.mockResolvedValue({ items: [] });
  poList.mockResolvedValue({ items: [], total: 0 });
  poGet.mockResolvedValue({ id: 'po-1', number: 'PO-1', status: 'DRAFT', items: [], receipts: [], totals: {} });
  inventoryGet.mockResolvedValue({
    product: { id: 'p1', name: 'Widget', sku: 'SKU-1', unit: 'pc', minimumStock: 1, status: 'ACTIVE' },
    location: { id: 'l1', name: 'Main' },
    quantity: 5,
    reservedQuantity: 0,
    availableQuantity: 5,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

describe('dashboard', () => {
  it('loads the summary, restock preview and open orders once on mount', async () => {
    await mountAt('/');

    expect(summary).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(poList).toHaveBeenCalledTimes(1);
  });

  it('refetches exactly once when the screen regains focus', async () => {
    await mountAt('/');

    await leaveAndReturn();

    expect(summary).toHaveBeenCalledTimes(2);
    expect(reorder).toHaveBeenCalledTimes(2);
    expect(poList).toHaveBeenCalledTimes(2);
  });

  it('does not refetch merely because a child was pushed over it', async () => {
    await mountAt('/');

    await act(async () => {
      router.push('/child');
    });

    expect(summary).toHaveBeenCalledTimes(1);
  });
});

describe('inventory record', () => {
  it('loads the record once on mount', async () => {
    await mountAt('/inventory/p1');

    expect(inventoryGet).toHaveBeenCalledTimes(1);
    expect(inventoryGet).toHaveBeenCalledWith('token-1', 'p1');
  });

  it('refetches exactly once when the screen regains focus', async () => {
    await mountAt('/inventory/p1');

    await leaveAndReturn();

    expect(inventoryGet).toHaveBeenCalledTimes(2);
  });

  it('offers a transfer from the row itself, not only from the dashboard', async () => {
    const view = await mountAt('/inventory/p1');

    expect(view.getByText('Transfer to another location')).toBeTruthy();
  });

  it('does not offer a transfer to a role that cannot transfer', async () => {
    mockedUseSession.mockReturnValue({
      user: { id: 'u2', name: 'Staff User', role: ROLES.STAFF },
      token: 'token-1',
      signOut: mockSignOut,
    });

    const view = await mountAt('/inventory/p1');

    expect(view.queryByText('Transfer to another location')).toBeNull();
  });
});

describe('purchase order detail', () => {
  it('loads the order once on mount', async () => {
    await mountAt('/purchase-orders/po-1');

    expect(poGet).toHaveBeenCalledTimes(1);
    expect(poGet).toHaveBeenCalledWith('token-1', 'po-1');
  });

  it('refetches exactly once when the screen regains focus', async () => {
    await mountAt('/purchase-orders/po-1');

    await leaveAndReturn();

    expect(poGet).toHaveBeenCalledTimes(2);
  });
});
