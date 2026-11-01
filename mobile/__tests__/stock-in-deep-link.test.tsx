import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import StockInScreen from '../app/(app)/stock-in';
import { useSession } from '../lib/auth';
import { useActiveRef } from '../hooks/useReferences';
import useInventoryRow from '../hooks/useInventoryRow';
import { ThemeProvider } from '../lib/theme-context';

/**
 * A LOCATION THE LINK NAMED MUST BE SHOWN, NOT SILENTLY DROPPED.
 *
 * Stock In is reachable from a stock row and from an external link, both of which
 * can name the location the member is already looking at. The form seeded its
 * state from the prop once, at mount. A deep link that resolves its query params
 * after the first render therefore left the field on "Choose a location…" while
 * the movement was still aimed at the supplied id — the screen said "not chosen"
 * about a location it would submit.
 *
 * The screen is mounted here rather than the form, so the test covers the param
 * plumbing too: a renamed or dropped query key fails it.
 */

jest.mock('../lib/auth', () => ({ useSession: jest.fn() }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/api', () => ({
  inventoryApi: { stockIn: jest.fn(), stockOut: jest.fn(), adjust: jest.fn() },
  productsApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
}));

jest.mock('../hooks/useReferences', () => ({ useActiveRef: jest.fn() }));

jest.mock('../hooks/useInventoryRow', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../lib/confirm', () => ({
  alert: jest.fn(async () => true),
  confirm: jest.fn(async () => true),
}));

const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockUseSession = useSession as jest.Mock;
const mockUseActiveRef = useActiveRef as jest.Mock;
const mockUseInventoryRow = useInventoryRow as jest.Mock;
const productsApi = jest.requireMock('../lib/api').productsApi;
const inventoryApi = jest.requireMock('../lib/api').inventoryApi;

const MAIN = { id: 'l1', name: 'Main Warehouse' };

function mounted(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <StockInScreen />
    </ThemeProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
    api === productsApi
      ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
      : { items: [MAIN], loading: false, reload: jest.fn() }
  );
  mockUseInventoryRow.mockReturnValue({ row: null, loading: false, loaded: false });
});

describe('a stock-in deep link shows the location it names', () => {
  it('shows the location and its name from the link, before the list answers', async () => {
    mockUseLocalSearchParams.mockReturnValue({
      productId: 'p1',
      productName: 'Compact Kettle',
      locationId: MAIN.id,
      locationName: MAIN.name,
    });
    // The reference list is still empty: the supplied name must stand on its own.
    mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
      api === productsApi
        ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
        : { items: [], loading: true, reload: jest.fn() }
    );

    const view = await mounted();

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();
  });

  it('resolves an id-only link against the loaded locations', async () => {
    mockUseLocalSearchParams.mockReturnValue({ locationId: MAIN.id });

    const view = await mounted();

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();
  });

  it('adopts a location whose params resolve after the first render', async () => {
    // Two locations, so the single-location default cannot mask the defect.
    mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
      api === productsApi
        ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
        : {
            items: [MAIN, { id: 'l2', name: 'Shop Front' }],
            loading: false,
            reload: jest.fn(),
          }
    );
    // The first render of a cold deep link can precede its query params.
    mockUseLocalSearchParams.mockReturnValue({});
    const view = await mounted();
    expect(view.getByText('Choose a location…')).toBeTruthy();

    mockUseLocalSearchParams.mockReturnValue({
      locationId: MAIN.id,
      locationName: MAIN.name,
    });
    view.rerender(
      <ThemeProvider>
        <StockInScreen />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();
  });

  it('never replaces the location the member chose', async () => {
    mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
      api === productsApi
        ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
        : {
            items: [MAIN, { id: 'l2', name: 'Shop Front' }, { id: 'l3', name: 'Overflow' }],
            loading: false,
            reload: jest.fn(),
          }
    );
    mockUseLocalSearchParams.mockReturnValue({
      locationId: MAIN.id,
      locationName: MAIN.name,
    });
    const view = await mounted();
    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());

    fireEvent.press(view.getByText(MAIN.name));
    await waitFor(() => expect(view.getByText('Shop Front')).toBeTruthy());
    fireEvent.press(view.getByText('Shop Front'));
    await waitFor(() => expect(view.getByText('Shop Front')).toBeTruthy());

    // A link param that changes after the member chose must not undo that choice.
    mockUseLocalSearchParams.mockReturnValue({
      locationId: 'l3',
      locationName: 'Overflow',
    });
    view.rerender(
      <ThemeProvider>
        <StockInScreen />
      </ThemeProvider>
    );
    expect(view.getByText('Shop Front')).toBeTruthy();
    expect(view.queryByText('Overflow')).toBeNull();
  });
});

describe('a stock-in deep link shows the product it names', () => {
  it('adopts and submits a product whose params resolve after the first render', async () => {
    inventoryApi.stockIn.mockResolvedValue({ previousQuantity: 0, newQuantity: 5 });
    mockUseLocalSearchParams.mockReturnValue({});
    const view = await mounted();
    expect(view.getByText('Choose a product…')).toBeTruthy();

    // The product id and name arrive after the form has mounted, which is the
    // cold-link timing that left the field empty while the payload named p1.
    mockUseLocalSearchParams.mockReturnValue({
      productId: 'p1',
      productName: 'Compact Kettle',
      lock: '1',
    });
    view.rerender(
      <ThemeProvider>
        <StockInScreen />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.getByText('Compact Kettle')).toBeTruthy());
    expect(view.queryByText('Choose a product…')).toBeNull();

    // The card naming the product is not enough: the form must actually be
    // able to submit it. On the old code the card appeared while `productId`
    // stayed empty, so the button remained disabled.
    await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), '5');
    await fireEvent.press(view.getByRole('button', { name: 'Add stock' }));
    await waitFor(() => expect(inventoryApi.stockIn).toHaveBeenCalledTimes(1));
    expect(inventoryApi.stockIn.mock.calls[0][1]).toMatchObject({
      productId: 'p1',
      locationId: MAIN.id,
      quantity: 5,
    });
  });

  it('never replaces the product the member chose', async () => {
    inventoryApi.stockIn.mockResolvedValue({ previousQuantity: 0, newQuantity: 3 });
    mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
      api === productsApi
        ? {
            items: [
              { id: 'p1', name: 'Compact Kettle' },
              { id: 'p2', name: 'Rice' },
            ],
            loading: false,
            reload: jest.fn(),
          }
        : { items: [MAIN], loading: false, reload: jest.fn() }
    );
    mockUseLocalSearchParams.mockReturnValue({});
    const view = await mounted();

    fireEvent.press(view.getByText('Choose a product…'));
    await waitFor(() => expect(view.getByText('Rice')).toBeTruthy());
    fireEvent.press(view.getByText('Rice'));
    await waitFor(() => expect(view.getByText('Rice')).toBeTruthy());

    // A product param that resolves after the member chose must not undo that choice.
    mockUseLocalSearchParams.mockReturnValue({
      productId: 'p1',
      productName: 'Compact Kettle',
    });
    view.rerender(
      <ThemeProvider>
        <StockInScreen />
      </ThemeProvider>
    );
    expect(view.getByText('Rice')).toBeTruthy();
    expect(view.queryByText('Compact Kettle')).toBeNull();

    await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), '3');
    await fireEvent.press(view.getByRole('button', { name: 'Add stock' }));
    await waitFor(() => expect(inventoryApi.stockIn).toHaveBeenCalledTimes(1));
    expect(inventoryApi.stockIn.mock.calls[0][1]).toMatchObject({
      productId: 'p2',
      locationId: MAIN.id,
      quantity: 3,
    });
  });
});
