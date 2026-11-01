import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { inventoryApi, productsApi } from '../lib/api';
import { confirm } from '../lib/confirm';
import { useSession } from '../lib/auth';
import { useActiveRef } from '../hooks/useReferences';
import useInventoryRow from '../hooks/useInventoryRow';
import { ThemeProvider } from '../lib/theme-context';

import MovementForm from '../components/MovementForm';

/**
 * Two guards the movement forms were missing.
 *
 * 1. AN ADJUSTMENT MUST SAY WHY. It is the one movement with no external document
 *    behind it: a stock-in has a delivery, a stock-out a sale, an adjustment just
 *    a different number. The server now refuses one without a reason, and the form
 *    must not let a member discover that after typing a target.
 *
 * 2. ONE LOCATION NEEDS NO CHOICE. A single-warehouse business was asked to pick
 *    its only location on every movement. The form now preselects it; the test
 *    proves the submitted payload names it, not merely that a label is visible.
 *
 * The confirmation itself is pinned too: cancelling it must not send anything, and
 * confirming must send the target with the reason.
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
const mockConfirm = confirm as jest.Mock;
const adjust = inventoryApi.adjust as jest.Mock;
const stockIn = inventoryApi.stockIn as jest.Mock;

let locations: { id: string; name: string }[] = [];

async function mount(
  kind: 'adjust' | 'stock-in',
  initialLocationId?: string
): Promise<Awaited<ReturnType<typeof render>>> {
  return render(
    <ThemeProvider>
      <MovementForm
        kind={kind}
        initialProductId="p1"
        initialProductName="Compact Kettle"
        lockProduct
        initialLocationId={initialLocationId}
        initialLocationName={initialLocationId ? 'Main Warehouse' : undefined}
      />
    </ThemeProvider>
  );
}

async function editTarget(view: Awaited<ReturnType<typeof render>>, value: string): Promise<void> {
  await fireEvent.changeText(view.getByPlaceholderText('Set the quantity to this value'), value);
}

async function editReason(view: Awaited<ReturnType<typeof render>>, value: string): Promise<void> {
  await fireEvent.changeText(
    view.getByPlaceholderText('e.g. supplier delivery, damaged, recount'),
    value
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  locations = [{ id: 'l1', name: 'Main Warehouse' }];
  mockUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  mockUseActiveRef.mockImplementation((_token: string, api: unknown) =>
    api === productsApi
      ? { items: [{ id: 'p1', name: 'Compact Kettle' }], loading: false, reload: jest.fn() }
      : { items: locations, loading: false, reload: jest.fn() }
  );
  mockUseInventoryRow.mockReturnValue({
    row: { id: 'row1', quantity: 10, availableQuantity: 10 },
    loading: false,
    loaded: true,
  });
  mockConfirm.mockResolvedValue(true);
  adjust.mockResolvedValue({ previousQuantity: 10, newQuantity: 8, transaction: { id: 'txn-1' } });
  stockIn.mockResolvedValue({ previousQuantity: 0, newQuantity: 5, transaction: { id: 'txn-2' } });
});

describe('a single-location business does not have to choose its location', () => {
  it('submits the only location without the member selecting one', async () => {
    const view = await mount('stock-in');
    await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), '5');

    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Add stock' }).props.accessibilityState?.disabled
      ).toBe(false)
    );
    await fireEvent.press(view.getByRole('button', { name: 'Add stock' }));

    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(1));
    expect(stockIn.mock.calls[0][1]).toMatchObject({ productId: 'p1', locationId: 'l1', quantity: 5 });
  });
});

describe('an adjustment needs a reason and a confirmation', () => {
  it('does not allow the target to be submitted with no reason', async () => {
    const view = await mount('adjust', 'l1');
    await editTarget(view, '8');

    expect(view.getByRole('button', { name: 'Set quantity' }).props.accessibilityState?.disabled).toBe(true);

    await editReason(view, 'Cycle count');
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Set quantity' }).props.accessibilityState?.disabled
      ).toBe(false)
    );
  });

  it('cancelling the confirmation sends nothing', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const view = await mount('adjust', 'l1');
    await editTarget(view, '8');
    await editReason(view, 'Cycle count');

    await fireEvent.press(view.getByRole('button', { name: 'Set quantity' }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    const [title, message] = mockConfirm.mock.calls[0];
    expect(title).toMatch(/adjust/i);
    expect(message).toContain('Cycle count');
    expect(message).toContain('10');
    expect(message).toContain('8');
    expect(adjust).not.toHaveBeenCalled();
  });

  it('confirming sends the target, the reason and one operation key', async () => {
    const view = await mount('adjust', 'l1');
    await editTarget(view, '8');
    await editReason(view, 'Cycle count');

    await fireEvent.press(view.getByRole('button', { name: 'Set quantity' }));

    await waitFor(() => expect(adjust).toHaveBeenCalledTimes(1));
    const [token, payload, key] = adjust.mock.calls[0];
    expect(token).toBe('token-1');
    expect(payload).toMatchObject({ productId: 'p1', locationId: 'l1', quantity: 8, reason: 'Cycle count' });
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThanOrEqual(8);
  });
});
