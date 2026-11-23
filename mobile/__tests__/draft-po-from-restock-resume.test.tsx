import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import DraftFromRestockScreen from '../app/(app)/purchase-orders/from-restock';
import { locationsApi, productsApi, purchaseOrdersApi, suppliersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ApiError } from '../lib/client';
import {
  clearRestockPurchaseOrderDraft,
  loadRestockPurchaseOrderDraft,
  saveRestockPurchaseOrderDraft,
} from '../lib/restockPurchaseOrderDraft';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: jest.fn(() => false),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({}),
}));

jest.mock('../lib/confirm', () => ({
  confirm: jest.fn(async () => true),
  alert: jest.fn(async () => true),
}));

jest.mock('../lib/api', () => ({
  suppliersApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
  productsApi: { reorder: jest.fn() },
  purchaseOrdersApi: { createFromRestock: jest.fn() },
}));

jest.mock('../lib/restockPurchaseOrderDraft', () => ({
  loadRestockPurchaseOrderDraft: jest.fn(async () => ({ status: 'missing' })),
  saveRestockPurchaseOrderDraft: jest.fn(async () => true),
  clearRestockPurchaseOrderDraft: jest.fn(async () => true),
}));

const mockedUseSession = useSession as jest.Mock;
const createFromRestock = purchaseOrdersApi.createFromRestock as jest.Mock;
const loadDraft = loadRestockPurchaseOrderDraft as jest.Mock;
const saveDraft = saveRestockPurchaseOrderDraft as jest.Mock;
const clearDraft = clearRestockPurchaseOrderDraft as jest.Mock;
const replace = router.replace as jest.Mock;

const SUPPLIER = { id: 'sup-1', name: 'Eco Industries' };
const LOCATION = { id: 'loc-1', name: 'Shop Front' };
const ROW = {
  id: 'prod-1',
  name: 'Everyday Battery',
  sku: 'EB-1',
  availableQuantity: 2,
  minimumStock: 5,
  stockStatus: 'LOW_STOCK',
};

const mount = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

async function chooseOrderDetails(view: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await waitFor(() => expect(view.getByText('Choose a supplier…')).toBeTruthy());
  await fireEvent.press(view.getByText('Choose a supplier…'));
  await fireEvent.press(await view.findByText('Eco Industries'));
  await fireEvent.press(view.getByText('Choose a location…'));
  await fireEvent.press(await view.findByText('Shop Front'));
  await waitFor(() => expect(view.getByText('Everyday Battery')).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', role: 'MANAGER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  (suppliersApi.list as jest.Mock).mockResolvedValue({ items: [SUPPLIER], total: 1, totalPages: 1 });
  (locationsApi.list as jest.Mock).mockResolvedValue({ items: [LOCATION], total: 1, totalPages: 1 });
  (productsApi.reorder as jest.Mock).mockResolvedValue({ items: [ROW], total: 1 });
  loadDraft.mockResolvedValue({ status: 'missing' });
  saveDraft.mockResolvedValue(true);
  clearDraft.mockResolvedValue(true);
});

it('★ ignores an older restock answer after the location changes', async () => {
  const secondLocation = { id: 'loc-2', name: 'Overflow Warehouse' };
  (locationsApi.list as jest.Mock).mockResolvedValue({
    items: [LOCATION, secondLocation],
    total: 2,
    totalPages: 1,
  });
  let resolveFirst!: (value: { items: (typeof ROW)[]; total: number }) => void;
  let resolveSecond!: (value: { items: (typeof ROW)[]; total: number }) => void;
  (productsApi.reorder as jest.Mock)
    .mockImplementationOnce(
      () =>
        new Promise<{ items: (typeof ROW)[]; total: number }>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<{ items: (typeof ROW)[]; total: number }>((resolve) => {
          resolveSecond = resolve;
        }),
    );

  const view = await mount(<DraftFromRestockScreen />);
  await waitFor(() => expect(view.getByText('Choose a supplier…')).toBeTruthy());
  await fireEvent.press(view.getByText('Choose a supplier…'));
  await fireEvent.press(await view.findByText('Eco Industries'));
  await fireEvent.press(view.getByText('Choose a location…'));
  await fireEvent.press(await view.findByText('Shop Front'));
  await waitFor(() => expect(productsApi.reorder).toHaveBeenCalledTimes(1));

  // The first answer is still in flight. Change the receiving location; the
  // screen must only accept the rows for the location now selected.
  await fireEvent.press(view.getByText('Shop Front'));
  await fireEvent.press(await view.findByText('Overflow Warehouse'));
  await waitFor(() => expect(productsApi.reorder).toHaveBeenCalledTimes(2));

  await act(async () => {
    resolveSecond({
      items: [{ ...ROW, id: 'prod-second', name: 'Second location row' }],
      total: 1,
    });
  });
  await waitFor(() => expect(view.getByText('Second location row')).toBeTruthy());

  await act(async () => {
    resolveFirst({
      items: [{ ...ROW, id: 'prod-first', name: 'First location row' }],
      total: 1,
    });
  });
  expect(view.queryByText('First location row')).toBeNull();
  expect(view.getByText('Second location row')).toBeTruthy();
  view.unmount();
});

it('★ sends no request when the resume key cannot be saved', async () => {
  saveDraft.mockResolvedValueOnce(false);

  const view = await mount(<DraftFromRestockScreen />);
  await chooseOrderDetails(view);
  await fireEvent.press(view.getByText('Everyday Battery'));
  await fireEvent.press(view.getByText('Create draft order (1 item)'));

  await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
  expect(createFromRestock).not.toHaveBeenCalled();
  expect(
    view.getByText(
      'The draft was not sent because its resume key could not be saved on this device. Try again.'
    )
  ).toBeTruthy();
  expect(view.getByText('Create draft order (1 item)')).toBeTruthy();
  expect(view.queryByText(/^Resume draft creation/)).toBeNull();
  view.unmount();
});

it('★ keeps a truthful retry state when post-success local cleanup still fails', async () => {
  createFromRestock.mockResolvedValue({ id: 'po-1', number: 'PO-0001', status: 'DRAFT' });
  clearDraft.mockResolvedValue(false);

  const view = await mount(<DraftFromRestockScreen />);
  await chooseOrderDetails(view);
  await fireEvent.press(view.getByText('Everyday Battery'));
  await fireEvent.press(view.getByText('Create draft order (1 item)'));

  await waitFor(() => expect(clearDraft).toHaveBeenCalledTimes(2));
  expect(createFromRestock).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  expect(
    view.getByText(
      'The draft order was created, but this device could not clear the saved resume attempt. Press Resume draft creation to retry; the same key cannot create a second order.'
    )
  ).toBeTruthy();
  expect(view.getByText('Resume draft creation (1 item)')).toBeTruthy();

  clearDraft.mockResolvedValue(true);
  await fireEvent.press(view.getByText('Resume draft creation (1 item)'));

  await waitFor(() => expect(replace).toHaveBeenCalledWith('/purchase-orders/po-1'));
  expect(createFromRestock).toHaveBeenCalledTimes(2);
  expect(clearDraft).toHaveBeenCalledTimes(3);
  expect(createFromRestock.mock.calls[1][2]).toBe(createFromRestock.mock.calls[0][2]);
  view.unmount();
});

it('★ blocks resuming a saved draft whose location is archived, then repairs by starting over', async () => {
  const savedDraft = {
    payload: {
      supplierId: SUPPLIER.id,
      locationId: 'loc-archived',
      items: [{ productId: ROW.id, availableQuantity: 2, minimumStock: 5 }],
    },
    key: 'op-draft-archived',
    savedAt: Date.now(),
  };
  loadDraft.mockResolvedValue({ status: 'found', draft: savedDraft });

  const view = await mount(<DraftFromRestockScreen />);

  await waitFor(() =>
    expect(
      view.getByText(
        'The saved attempt names a supplier or location that is now archived. It cannot be resumed safely; check Purchase orders, then Start over to choose active references.'
      )
    ).toBeTruthy()
  );
  expect(
    view.getByRole('button', { name: 'Resume draft creation (1 item)' }).props.accessibilityState?.disabled
  ).toBe(true);
  expect(createFromRestock).not.toHaveBeenCalled();

  await fireEvent.press(view.getByText('Start over'));

  await waitFor(() => expect(clearDraft).toHaveBeenCalledWith('u1', savedDraft.key));
  await waitFor(() => expect(view.getByText('Create draft order (0 items)')).toBeTruthy());
  expect(view.queryByText(/archived/)).toBeNull();
  expect(createFromRestock).not.toHaveBeenCalled();
  view.unmount();
});

it('★ blocks a new draft when the saved-attempt read fails, and retries the check', async () => {
  loadDraft
    .mockResolvedValueOnce({ status: 'error' })
    .mockResolvedValueOnce({ status: 'missing' });

  const view = await mount(<DraftFromRestockScreen />);
  await waitFor(() => expect(view.getByText('Check saved attempt again')).toBeTruthy());
  expect(view.queryByText(/^Create draft order/)).toBeNull();
  expect(createFromRestock).not.toHaveBeenCalled();

  await fireEvent.press(view.getByText('Check saved attempt again'));
  await waitFor(() => expect(view.getByText('Choose a supplier…')).toBeTruthy());
  expect(view.getByText('Create draft order (0 items)')).toBeTruthy();
  view.unmount();
});

it('★ sends the stored snapshot, not changed rows, while an attempt is unresolved', async () => {
  const savedDraft = {
    payload: {
      supplierId: SUPPLIER.id,
      locationId: LOCATION.id,
      items: [{ productId: ROW.id, availableQuantity: 2, minimumStock: 5 }],
    },
    key: 'op-draft-abcdefgh',
    savedAt: Date.now(),
  };
  loadDraft.mockResolvedValue({ status: 'found', draft: savedDraft });
  // The live row moved after the attempt was saved. The resume must still send
  // the stored values so the server can replay or answer RESTOCK_ROWS_STALE;
  // substituting the new row would silently change the keyed body.
  (productsApi.reorder as jest.Mock).mockResolvedValue({
    items: [{ ...ROW, availableQuantity: 1 }],
    total: 1,
  });
  createFromRestock.mockResolvedValue({ id: 'po-2', number: 'PO-0002', status: 'DRAFT' });

  const view = await mount(<DraftFromRestockScreen />);
  await waitFor(() =>
    expect(view.getByText('Resume draft creation (1 item)')).toBeTruthy(),
  );
  await fireEvent.press(view.getByText('Everyday Battery'));
  await fireEvent.press(view.getByText('Resume draft creation (1 item)'));

  await waitFor(() => expect(createFromRestock).toHaveBeenCalledTimes(1));
  expect(createFromRestock.mock.calls[0][1]).toEqual(savedDraft.payload);
  expect(createFromRestock.mock.calls[0][2]).toBe(savedDraft.key);
  view.unmount();
});

it('★ resumes the same key after an ambiguous failure and a cold reopen', async () => {
  createFromRestock
    .mockRejectedValueOnce(new ApiError(503, 'SERVER_ERROR', 'Service unavailable'))
    .mockResolvedValueOnce({ id: 'po-1', number: 'PO-0001', status: 'DRAFT' });

  const first = await mount(<DraftFromRestockScreen />);
  await chooseOrderDetails(first);
  await fireEvent.press(first.getByText('Everyday Battery'));
  await fireEvent.press(first.getByText('Create draft order (1 item)'));

  await waitFor(() => expect(createFromRestock).toHaveBeenCalledTimes(1));
  const firstKey = createFromRestock.mock.calls[0][2] as string;
  const firstPayload = createFromRestock.mock.calls[0][1];
  const savedDraft = saveDraft.mock.calls[0][1] as {
    key: string;
    payload: typeof firstPayload;
  };
  expect(savedDraft.key).toBe(firstKey);
  expect(savedDraft.payload).toEqual(firstPayload);
  await waitFor(() => expect(first.getByText(/could not be confirmed/i)).toBeTruthy());
  expect(clearDraft).not.toHaveBeenCalled();
  first.unmount();

  // A cold reopen restores only the persisted attempt. The same body must be
  // resent under the same key; a new key is the duplicate-DRAFT bug.
  loadDraft.mockResolvedValue({ status: 'found', draft: savedDraft });
  const reopened = await mount(<DraftFromRestockScreen />);
  await waitFor(() =>
    expect(reopened.getByText('Resume draft creation (1 item)')).toBeTruthy(),
  );
  await fireEvent.press(reopened.getByText('Resume draft creation (1 item)'));

  await waitFor(() => expect(createFromRestock).toHaveBeenCalledTimes(2));
  expect(createFromRestock.mock.calls[1][1]).toEqual(firstPayload);
  expect(createFromRestock.mock.calls[1][2]).toBe(firstKey);
  await waitFor(() => expect(clearDraft).toHaveBeenCalledWith('u1', firstKey));
  expect(replace).toHaveBeenCalledWith('/purchase-orders/po-1');
  reopened.unmount();
});
