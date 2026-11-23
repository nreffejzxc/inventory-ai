import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import { categoriesApi, productsApi } from '../lib/api';
import { isSessionError, useSession } from '../lib/auth';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

import RestockScreen from '../app/(app)/restock';

/**
 * The restock list — the screen the 50 000-product phone pass proved was missing.
 *
 * THE DEFECT (§27CQ). On the member's own 50 626-product catalogue, 1 492 products
 * were at or below minimum stock. The dashboard showed the first **five** and its
 * "View inventory" link went to `/inventory` with **no restock filter**, so the list
 * it promised did not exist; the assistant could not help either — asked to "list
 * them all", it was cut off by the 800-token answer cap after eight rows. The server
 * had the whole thing already: `GET /api/products/reorder` is paginated, worst-first
 * and returns a total. Nothing client-side read more than five rows of it.
 *
 * So this screen adds **no backend surface**: it renders an endpoint that already
 * existed and was already permission-checked (`products.view`) and exercised by the
 * AI tool. The properties pinned here are the ones that make it a real replacement
 * for reading five rows and guessing:
 *
 *   - the **total** is stated, not just "a list" — the number is the point at scale;
 *   - paging goes through the shared list hook, so the second page is a real request;
 *   - search reaches the endpoint's own `q` (name/SKU/barcode), not a client filter;
 *   - an out-of-stock row is distinguishable from a low-stock one;
 *   - a row opens the product it names;
 *   - an expired session signs out instead of rendering an empty list.
 */

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: jest.fn(() => false),
}));

let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useFocusEffect: () => {},
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../lib/api', () => ({
  productsApi: { reorder: jest.fn() },
  categoriesApi: { list: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const mockedIsSessionError = isSessionError as unknown as jest.Mock;
const reorder = productsApi.reorder as jest.Mock;
const categoriesList = categoriesApi.list as jest.Mock;
const push = router.push as jest.Mock;

const LOW_ROW = {
  id: 'p-low',
  name: 'Compact Kettle',
  sku: 'CK-1',
  availableQuantity: 12,
  minimumStock: 20,
  unitsBelowMinimum: 8,
  stockStatus: 'LOW_STOCK',
};

const OUT_ROW = {
  id: 'p-out',
  name: 'Heavy Duty Torch',
  sku: 'HT-9',
  availableQuantity: 0,
  minimumStock: 4,
  unitsBelowMinimum: 4,
  stockStatus: 'OUT_OF_STOCK',
};

const signIn = (): void => {
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: ROLES.MANAGER },
    token: 'token-1',
    signOut: jest.fn(),
  });
};

const mount = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

beforeEach(() => {
  jest.clearAllMocks();
  mockedIsSessionError.mockReturnValue(false);
  signIn();
  mockParams = {};
  reorder.mockResolvedValue({ items: [OUT_ROW, LOW_ROW], total: 2 });
  categoriesList.mockResolvedValue({ items: [], total: 0, totalPages: 1 });
});

describe('restock category filter lifecycle', () => {
  it('★ ignores an archived deep-linked category and explains the repair', async () => {
    mockParams = { categoryId: 'cat-archived' };
    categoriesList.mockResolvedValue({
      items: [{ id: 'cat-active', name: 'Active category' }],
      total: 1,
      totalPages: 1,
    });

    const { getByTestId, getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByTestId('restock-category-unavailable')).toBeTruthy());
    expect(
      getByText('That category is archived or unavailable. Showing every category.')
    ).toBeTruthy();
    await waitFor(() =>
      expect(reorder).toHaveBeenLastCalledWith(
        'token-1',
        expect.not.objectContaining({ categoryId: 'cat-archived' })
      )
    );
  });
});

describe('restock list', () => {
  it('★ lists the rows the endpoint returned, worst first, and states the total', async () => {
    const { getByText, getByTestId } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText('Compact Kettle')).toBeTruthy());
    expect(getByText('Heavy Duty Torch')).toBeTruthy();
    // The count is the thing the five-row preview could never say. The text is built
    // from interpolated children, so it is read as the sentence the member sees.
    expect((getByTestId('restock-count').props.children as unknown[]).join('')).toContain('2 products');
    // The first request is page 1 with the shared page size, and no filters.
    expect(reorder).toHaveBeenCalledWith('token-1', expect.objectContaining({ page: 1 }));
  });

  it('distinguishes an out-of-stock row from a low-stock one', async () => {
    const { getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText('Out')).toBeTruthy());
    expect(getByText('Low')).toBeTruthy();
  });

  it('shows available stock against the row’s own minimum and the shortfall', async () => {
    const { getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText(/12 available/)).toBeTruthy());
    expect(getByText(/minimum 20/)).toBeTruthy();
    expect(getByText(/8 below minimum/)).toBeTruthy();
    expect(getByText(/0 available/)).toBeTruthy();
    expect(getByText(/4 below minimum/)).toBeTruthy();
  });

  it('opens the product a row names', async () => {
    const { getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText('Compact Kettle')).toBeTruthy());
    fireEvent.press(getByText('Compact Kettle'));

    expect(push).toHaveBeenCalledWith('/products/p-low');
  });

  it('★ opens the multi-row draft purchase-order screen', async () => {
    const { getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText('Create draft PO')).toBeTruthy());
    fireEvent.press(getByText('Create draft PO'));

    expect(push).toHaveBeenCalledWith('/purchase-orders/from-restock');
  });

  it('does not offer a draft purchase order to a role that cannot manage them', async () => {
    mockedUseSession.mockReturnValue({
      user: { id: 'u1', name: 'Test User', role: ROLES.STAFF },
      token: 'token-1',
      signOut: jest.fn(),
    });
    const { queryByText, getByText } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText('Compact Kettle')).toBeTruthy());
    expect(queryByText('Create draft PO')).toBeNull();
  });

  it('sends the search term to the endpoint rather than filtering on the client', async () => {
    const { getByPlaceholderText } = await mount(<RestockScreen />);

    fireEvent.changeText(getByPlaceholderText(/Search restock/), 'kettle');

    await waitFor(() =>
      expect(reorder).toHaveBeenLastCalledWith('token-1', expect.objectContaining({ q: 'kettle', page: 1 })),
    );
  });

  it('★ says how much of the list is on screen while more remains', async () => {
    // The list pages silently (20 at a time), so without this a member at the bottom of
    // page 1 has no way to know 16 more rows exist. Observed on the phone 2026-10-19.
    reorder.mockResolvedValue({ items: [OUT_ROW, LOW_ROW], total: 36 });
    const { getByTestId } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByTestId('restock-footer')).toBeTruthy());
    expect((getByTestId('restock-footer').props.children as string)).toContain('Showing 2 of 36');
  });

  it('says when the whole list is shown', async () => {
    const { getByTestId } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByTestId('restock-footer')).toBeTruthy());
    expect((getByTestId('restock-footer').props.children as string)).toContain('All 2 products shown');
  });

  it('says so plainly when nothing needs restocking', async () => {
    reorder.mockResolvedValue({ items: [], total: 0 });
    const { getByText, queryByTestId } = await mount(<RestockScreen />);

    await waitFor(() => expect(getByText(/Nothing needs restocking right now/)).toBeTruthy());
    // No count line when the answer is zero — "0 products" is noise, not information.
    expect(queryByTestId('restock-count')).toBeNull();
    expect(queryByTestId('restock-footer')).toBeNull();
  });

  it('signs out on an expired session instead of presenting an empty list', async () => {
    const signOut = jest.fn();
    mockedUseSession.mockReturnValue({
      user: { id: 'u1', name: 'Test User', role: ROLES.MANAGER },
      token: 'token-1',
      signOut,
    });
    mockedIsSessionError.mockReturnValue(true);
    reorder.mockRejectedValue(new Error('SESSION_EXPIRED'));

    await mount(<RestockScreen />);

    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
