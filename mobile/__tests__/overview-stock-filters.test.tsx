import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { dashboardApi, categoriesApi, locationsApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

import DashboardScreen from '../app/(app)/dashboard';
import ProductsScreen from '../app/(app)/products/index';

/**
 * OVERVIEW → PRODUCTS — the four product cards must open the product-level list
 * that is the source of their counts.
 *
 * The cards used to open `/inventory` for Low/Out, where one product with stock
 * at several locations appeared once per row. The canonical, mutually exclusive
 * status now travels in the URL and the API receives it as `stockStatus`. Two
 * halves are pinned here:
 *
 * 1. Each Overview card pushes the product route with ACTIVE status and the
 *    matching stockStatus (or none for Active products).
 * 2. The Products route turns those params into the API query. The legacy broad
 *    low/out flags must not override the canonical status, and the list is pinned
 *    to ACTIVE so the count beside the filter stays the card's count.
 */

const mockPush = jest.fn();
const mockSetParams = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href), setParams: (params: Record<string, string>) => mockSetParams(params) },
  useLocalSearchParams: () => mockParams,
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
const productsList = productsApi.list as jest.Mock;
const poList = purchaseOrdersApi.list as jest.Mock;
const categoriesList = categoriesApi.list as jest.Mock;
const locationsList = locationsApi.list as jest.Mock;

const paramsOfLastProductCall = (): Record<string, unknown> => {
  const call = productsList.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return call?.[1] as Record<string, unknown>;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
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
  reorder.mockResolvedValue({ items: [] });
  poList.mockResolvedValue({ items: [], total: 0 });
  productsList.mockResolvedValue({ items: [], total: 4 });
  categoriesList.mockResolvedValue({ items: [] });
  locationsList.mockResolvedValue({ items: [] });
});

describe('Overview card navigation', () => {
  it.each([
    ['In stock', '/products?status=ACTIVE&stockStatus=IN_STOCK'],
    ['Low stock', '/products?status=ACTIVE&stockStatus=LOW_STOCK'],
    ['Out of stock', '/products?status=ACTIVE&stockStatus=OUT_OF_STOCK'],
    ['Active products', '/products?status=ACTIVE'],
  ])('%s opens the matching product filter', async (label, route) => {
    const view = await render(
      <ThemeProvider>
        <DashboardScreen />
      </ThemeProvider>
    );
    await waitFor(() => expect(summary).toHaveBeenCalled());

    fireEvent.press(view.getByText(label));

    expect(mockPush).toHaveBeenCalledWith(route);
  });
});

describe('Products route applies the Overview filter', () => {
  const renderProducts = async () => {
    const view = await render(
      <ThemeProvider>
        <ProductsScreen />
      </ThemeProvider>
    );
    await waitFor(() => expect(productsList).toHaveBeenCalled());
    return view;
  };

  it.each([
    ['IN_STOCK', '4 products in stock'],
    ['LOW_STOCK', '4 products low stock'],
    ['OUT_OF_STOCK', '4 products out of stock'],
  ] as const)('passes %s with status ACTIVE to the API', async (stockStatus, count) => {
    mockParams = { status: 'ACTIVE', stockStatus };

    const view = await renderProducts();

    expect(paramsOfLastProductCall()).toMatchObject({ status: 'ACTIVE', stockStatus });
    expect(view.getByTestId('product-stock-count')).toHaveTextContent(count);
  });

  it('sends no stockStatus for the Active products card', async () => {
    mockParams = { status: 'ACTIVE' };

    const view = await renderProducts();

    expect(paramsOfLastProductCall()).toMatchObject({ status: 'ACTIVE' });
    expect(paramsOfLastProductCall().stockStatus).toBeUndefined();
    expect(view.queryByTestId('product-stock-count')).toBeNull();
  });

  it('pins ACTIVE and drops legacy low/out flags when stockStatus is present', async () => {
    mockParams = { status: 'ARCHIVED', stockStatus: 'LOW_STOCK', lowStock: 'true', outOfStock: 'true' };

    const view = await renderProducts();

    expect(paramsOfLastProductCall()).toMatchObject({
      status: 'ACTIVE',
      stockStatus: 'LOW_STOCK',
    });
    expect(paramsOfLastProductCall().lowStock).toBeUndefined();
    expect(paramsOfLastProductCall().outOfStock).toBeUndefined();
    expect(view.getByText('Active products')).toBeTruthy();
    expect(view.queryByText('Archived')).toBeNull();
  });

  it('maps a legacy lowStock-only link onto the visible canonical filter', async () => {
    mockParams = { lowStock: 'true' };

    const view = await renderProducts();

    expect(paramsOfLastProductCall()).toMatchObject({ stockStatus: 'LOW_STOCK' });
    expect(paramsOfLastProductCall().lowStock).toBeUndefined();
    expect(view.getByText('4 products low stock')).toBeTruthy();
    expect(view.getByText('Active products')).toBeTruthy();
  });

  it('shows In, Low and Out chips and pins ACTIVE when one is chosen', async () => {
    mockParams = {};

    const view = await renderProducts();
    expect(view.getByText('In stock')).toBeTruthy();
    expect(view.getByText('Low stock')).toBeTruthy();
    expect(view.getByText('Out of stock')).toBeTruthy();

    fireEvent.press(view.getByText('Low stock'));

    expect(mockSetParams).toHaveBeenCalledWith({
      status: 'ACTIVE',
      stockStatus: 'LOW_STOCK',
      lowStock: '',
      outOfStock: '',
    });
  });

  it('clears a selected stock chip while keeping ACTIVE pinned', async () => {
    mockParams = { status: 'ACTIVE', stockStatus: 'LOW_STOCK' };

    const view = await renderProducts();
    fireEvent.press(view.getByText('Clear'));

    expect(mockSetParams).toHaveBeenCalledWith({
      status: 'ACTIVE',
      stockStatus: '',
      lowStock: '',
      outOfStock: '',
    });
  });

  it('shows the Active products tile count on the list it opens', async () => {
    mockParams = { status: 'ACTIVE' };
    productsList.mockResolvedValue({ items: [], total: 314 });

    const view = await renderProducts();

    expect(view.getByTestId('product-status-count')).toHaveTextContent('314 active products');
  });
});
