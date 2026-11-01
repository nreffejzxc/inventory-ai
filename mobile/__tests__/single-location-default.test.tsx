import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { inventoryApi, productsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { useActiveRef } from '../hooks/useReferences';
import useInventoryRow from '../hooks/useInventoryRow';
import { ThemeProvider } from '../lib/theme-context';

import MovementForm from '../components/MovementForm';

/**
 * THE SINGLE-LOCATION DEFAULT, AT THE TIMING A PHONE ACTUALLY PRODUCES.
 *
 * A business with one location should not be asked to choose it on every movement.
 * The existing guard (`movement-workflow-guards`) proves the submitted payload for
 * a stock-in — but it hands the form a reference list that is already loaded. On a
 * phone the form mounts first and the list arrives a moment later, and the default
 * is applied by an effect that runs when `loading` flips. That is a different code
 * path, and until now it was the untested one.
 *
 * What this file pins:
 *
 *   * the default is applied when the list arrives after mount, for stock-in,
 *     stock-out and adjust (the three kinds share the form);
 *   * the chosen name is VISIBLE, not merely sent — a member who cannot see the
 *     location cannot catch the wrong one;
 *   * a two-location business is still asked, so the behaviour is "the only
 *     location", not "any location".
 */

jest.mock('../lib/auth', () => ({ useSession: jest.fn() }));

jest.mock('expo-router', () => ({
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

const mockUseSession = useSession as jest.Mock;
const mockUseActiveRef = useActiveRef as jest.Mock;
const mockUseInventoryRow = useInventoryRow as jest.Mock;
const stockIn = inventoryApi.stockIn as jest.Mock;
const stockOut = inventoryApi.stockOut as jest.Mock;
const adjust = inventoryApi.adjust as jest.Mock;

const MAIN = { id: 'l1', name: 'Main Warehouse' };
const SHOP = { id: 'l2', name: 'Shop Front' };

type Kind = 'stock-in' | 'stock-out' | 'adjust';

function mount(kind: Kind): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <MovementForm
        kind={kind}
        initialProductId="p1"
        initialProductName="Compact Kettle"
        lockProduct
      />
    </ThemeProvider>
  );
}

/** The reference list as the phone first sees it: a request still in flight. */
function setLocations(items: { id: string; name: string }[], loading: boolean): void {
  mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
    api === productsApi
      ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
      : { items, loading, reload: jest.fn() }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  mockUseInventoryRow.mockReturnValue({
    row: { id: 'row1', quantity: 10, availableQuantity: 10 },
    loading: false,
    loaded: true,
  });
  stockIn.mockResolvedValue({ previousQuantity: 0, newQuantity: 5, transaction: { id: 't1' } });
  stockOut.mockResolvedValue({ previousQuantity: 10, newQuantity: 8, transaction: { id: 't2' } });
  adjust.mockResolvedValue({ previousQuantity: 10, newQuantity: 8, transaction: { id: 't3' } });
});

describe('one location, arriving after the form has mounted', () => {
  it('fills the only location for a stock-in and shows it', async () => {
    setLocations([], true);
    const view = await mount('stock-in');
    expect(view.getByText('Choose a location…')).toBeTruthy();

    setLocations([MAIN], false);
    view.rerender(
      <ThemeProvider>
        <MovementForm
          kind="stock-in"
          initialProductId="p1"
          initialProductName="Compact Kettle"
          lockProduct
        />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();

    await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), '5');
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Add stock' }).props.accessibilityState?.disabled
      ).toBe(false)
    );
    await fireEvent.press(view.getByRole('button', { name: 'Add stock' }));

    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(1));
    expect(stockIn.mock.calls[0][1]).toMatchObject({ productId: 'p1', locationId: MAIN.id, quantity: 5 });
  });

  it('fills the only location for a stock-out and shows it', async () => {
    setLocations([], true);
    const view = await mount('stock-out');
    expect(view.getByText('Choose a location…')).toBeTruthy();

    setLocations([MAIN], false);
    view.rerender(
      <ThemeProvider>
        <MovementForm kind="stock-out" initialProductId="p1" initialProductName="Compact Kettle" lockProduct />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();

    await fireEvent.changeText(view.getByPlaceholderText('How many are you removing?'), '2');
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Remove stock' }).props.accessibilityState?.disabled
      ).toBe(false)
    );
    await fireEvent.press(view.getByRole('button', { name: 'Remove stock' }));

    await waitFor(() => expect(stockOut).toHaveBeenCalledTimes(1));
    expect(stockOut.mock.calls[0][1]).toMatchObject({ productId: 'p1', locationId: MAIN.id, quantity: 2 });
  });

  it('fills the only location for an adjustment and shows it', async () => {
    setLocations([], true);
    const view = await mount('adjust');
    expect(view.getByText('Choose a location…')).toBeTruthy();

    setLocations([MAIN], false);
    view.rerender(
      <ThemeProvider>
        <MovementForm kind="adjust" initialProductId="p1" initialProductName="Compact Kettle" lockProduct />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.getByText(MAIN.name)).toBeTruthy());
    expect(view.queryByText('Choose a location…')).toBeNull();

    await fireEvent.changeText(view.getByPlaceholderText('Set the quantity to this value'), '8');
    await fireEvent.changeText(
      view.getByPlaceholderText('e.g. supplier delivery, damaged, recount'),
      'Cycle count'
    );
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Set quantity' }).props.accessibilityState?.disabled
      ).toBe(false)
    );
    await fireEvent.press(view.getByRole('button', { name: 'Set quantity' }));

    await waitFor(() => expect(adjust).toHaveBeenCalledTimes(1));
    expect(adjust.mock.calls[0][1]).toMatchObject({
      productId: 'p1',
      locationId: MAIN.id,
      quantity: 8,
      reason: 'Cycle count',
    });
  });
});

describe('two locations', () => {
  it('still asks, and will not submit an unchosen location', async () => {
    setLocations([], true);
    const view = await mount('stock-in');

    setLocations([MAIN, SHOP], false);
    view.rerender(
      <ThemeProvider>
        <MovementForm
          kind="stock-in"
          initialProductId="p1"
          initialProductName="Compact Kettle"
          lockProduct
        />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.queryByText(MAIN.name)).toBeNull());
    expect(view.getByText('Choose a location…')).toBeTruthy();

    await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), '5');
    expect(view.getByRole('button', { name: 'Add stock' }).props.accessibilityState?.disabled).toBe(true);
    expect(stockIn).not.toHaveBeenCalled();
  });
});
