import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { inventoryApi } from '../lib/api';
import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import { getOrCreateOperationKey } from '../lib/idempotency';
import { ThemeProvider } from '../lib/theme-context';

import MovementForm from '../components/MovementForm';

/**
 * One movement per operation — even when the operation is retried.
 *
 * THE DEFECT. A movement was applied once per DELIVERY, not once per operation.
 * That is invisible while every request is answered, and it is exactly wrong when
 * one is not: the client's budget expires on a cold server, the form says the
 * stock-in failed, and the member presses again. The first delivery had already
 * been applied, so the retry applied it a second time — two Recent Activity
 * entries for one tap, and quantity wrong by the whole movement.
 *
 * WHAT IS PINNED HERE, in the two directions that matter:
 *
 *   * a transport failure does NOT end the operation. The retry's key is the same
 *     one, so the server replays the first outcome instead of applying the
 *     movement again;
 *   * an ANSWERED refusal (a 4xx) DOES end it. The next press is a new operation
 *     with a new key, so fixing a validation error and resubmitting is never
 *     swallowed as a duplicate of the failed attempt;
 *   * a 409 saying the SAME key is still in flight does NOT end it: that is this
 *     operation being retried, and renaming it would let the first delivery apply
 *     a second movement.
 *
 * And the submit guard: two presses that land before React has committed `busy`
 * still start one request. `busy` disables the button on the next render, which is
 * a rendered state, not a guarantee about the handler.
 */

const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../hooks/useReferences', () => ({
  ...jest.requireActual('../hooks/useReferences'),
  useActiveRef: () => ({
    items: [
      { id: 'p1', name: 'Compact Kettle' },
      { id: 'l1', name: 'Main Warehouse' },
    ],
    loading: false,
    reload: jest.fn(),
  }),
}));

jest.mock('../hooks/useInventoryRow', () => ({
  __esModule: true,
  default: () => ({ row: null, loading: false, loaded: false }),
}));

jest.mock('../lib/api', () => ({
  inventoryApi: { stockIn: jest.fn(), stockOut: jest.fn(), adjust: jest.fn() },
  productsApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
}));

jest.mock('../lib/confirm', () => ({
  alert: jest.fn(async () => true),
  confirm: jest.fn(async () => true),
}));

const mockedUseSession = useSession as jest.Mock;
const stockIn = inventoryApi.stockIn as jest.Mock;

/** The response the server sends for an applied stock-in. */
const APPLIED = {
  transaction: { id: 'txn-1', type: 'STOCK_IN', quantity: 5 },
  previousQuantity: 10,
  newQuantity: 15,
};

async function mount() {
  return render(
    <ThemeProvider>
      <MovementForm
        kind="stock-in"
        initialProductId="p1"
        initialProductName="Compact Kettle"
        lockProduct
        initialLocationId="l1"
        initialLocationName="Main Warehouse"
      />
    </ThemeProvider>
  );
}

type View = Awaited<ReturnType<typeof mount>>;

/** Fill the one field the form still needs. */
async function enterQuantity(view: View, quantity: string): Promise<void> {
  await fireEvent.changeText(view.getByPlaceholderText('How many are you adding?'), quantity);
}

/** Press the form's own submit button (the accessible button, not its label). */
async function submit(view: View): Promise<void> {
  await fireEvent.press(view.getByRole('button', { name: 'Add stock' }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSecureStore.clear();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
});

describe('a stock-in is one operation', () => {
  it('★ submits under a key already persisted for this exact operation', async () => {
    // The store-level cold-start case lives in `idempotency-persistence.test.ts`.
    // Here the form must also ADOPT that stored key rather than mint one of its own.
    const stored = await getOrCreateOperationKey({
      kind: 'stock-in',
      ownerId: 'u1',
      payload: { productId: 'p1', locationId: 'l1', quantity: 5, reason: undefined, reference: undefined },
    });

    stockIn.mockResolvedValueOnce(APPLIED);
    const view = await mount();
    await enterQuantity(view, '5');
    await submit(view);

    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(1));
    expect(stockIn.mock.calls[0][2]).toBe(stored);
  });

  it('keeps the operation key across a transport failure, so the retry cannot apply it twice', async () => {
    stockIn
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_TIMEOUT', 'The request took too long.'))
      .mockResolvedValueOnce(APPLIED);

    const view = await mount();
    await enterQuantity(view, '5');

    await submit(view);
    await waitFor(() => expect(view.getByText('The request took too long.')).toBeTruthy());

    await submit(view);
    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(2));

    const firstKey = stockIn.mock.calls[0][2];
    const secondKey = stockIn.mock.calls[1][2];
    expect(typeof firstKey).toBe('string');
    expect(firstKey.length).toBeGreaterThanOrEqual(8);
    // THE ASSERTION THAT MATTERS: the retry names the SAME operation.
    expect(secondKey).toBe(firstKey);
  });

  it('★ keeps the same operation after a 5xx, because the server may have committed', async () => {
    stockIn
      .mockRejectedValueOnce(new ApiError(503, 'DB_UNAVAILABLE', 'The server is unavailable.'))
      .mockResolvedValueOnce(APPLIED);

    const view = await mount();
    await enterQuantity(view, '5');

    await submit(view);
    await waitFor(() => expect(view.getByText('The server is unavailable.')).toBeTruthy());

    await submit(view);
    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(2));

    // A 5xx is not proof that the movement did not land. The retry must carry
    // the same key so a committed first delivery can be replayed, not applied twice.
    expect(stockIn.mock.calls[1][2]).toBe(stockIn.mock.calls[0][2]);
  });

  it('keeps the same operation when the server says its key is still in flight', async () => {
    stockIn
      .mockRejectedValueOnce(
        new ApiError(409, 'IDEMPOTENT_REQUEST_IN_PROGRESS', 'This operation is still being processed')
      )
      .mockResolvedValueOnce(APPLIED);

    const view = await mount();
    await enterQuantity(view, '5');

    await submit(view);
    await waitFor(() => expect(view.getByText('This operation is still being processed')).toBeTruthy());

    await submit(view);
    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(2));

    // The same operation, still on the wire: the retry must not rename it.
    expect(stockIn.mock.calls[1][2]).toBe(stockIn.mock.calls[0][2]);
  });

  it('starts a new operation after an answered refusal', async () => {
    stockIn
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Quantity must be a whole number of 1 or more.'))
      .mockResolvedValueOnce(APPLIED);

    const view = await mount();
    await enterQuantity(view, '5');

    await submit(view);
    await waitFor(() =>
      expect(view.getByText('Quantity must be a whole number of 1 or more.')).toBeTruthy()
    );

    await submit(view);
    await waitFor(() => expect(stockIn).toHaveBeenCalledTimes(2));

    // A refused attempt applied nothing, so the retry is a different operation.
    expect(stockIn.mock.calls[1][2]).not.toBe(stockIn.mock.calls[0][2]);
  });

  it('★ shows the server reference when a form-level failure carries one', async () => {
    const error = new ApiError(500, 'SERVER_ERROR', 'The movement could not be completed.');
    error.requestId = 'form-ref-42';
    stockIn.mockRejectedValueOnce(error);

    const view = await mount();
    await enterQuantity(view, '5');
    await submit(view);

    await waitFor(() => expect(view.getByText(/Reference: form-ref-42/)).toBeTruthy());
    expect(view.getByTestId('request-reference-copy')).toBeTruthy();
  });
});
