import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import PoForm from '../components/PoForm';
import { purchaseOrdersApi, productsApi, locationsApi, suppliersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ApiError } from '../lib/client';
import { ThemeProvider } from '../lib/theme-context';

/**
 * After a draft is created, the member lands on it (§27CZ).
 *
 * THE DEFECT. `submit()` ended with `router.back()` for both create and edit, so creating a draft dismissed the
 * form to **whatever was underneath it**. From the list that is the list — the draft is one more tap away, and the
 * success alert's own advice ("issue it when you're ready") is two. From a **deep link** there is nothing
 * underneath at all: §27CX's device pass created a draft through `inventoryai://purchase-orders/new` and the alert
 * dismissed to the **AI hub**, with the order it had just made nowhere on screen. The write was correct in every
 * case; only the destination was arbitrary.
 *
 * WHAT IS PINNED HERE
 *
 *   - create **replaces** the form with the new draft's detail (`/purchase-orders/<id>`), using the id the
 *     server returns with its 201 — and does not *also* pop the stack, because back must go to the list rather
 *     than to a second copy of the create form;
 *   - edit still goes **back** to the detail it was opened from, where the change is re-read on focus;
 *   - a create response without an id (nothing the server sends, but the fallback exists) still leaves the app
 *     somewhere sane;
 *   - the client-side mirror blocks an empty form **before** any request, so an obviously-invalid order never
 *     spends a round trip;
 *   - a server field error and a server code error both reach the member as copy rather than as a raw code.
 *
 * This is the first suite for `PoForm`, which is the write path for purchase orders — the screen §27CX exercised
 * by hand and nothing exercised by machine.
 */

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
  alert: jest.fn(() => Promise.resolve(true)),
  confirm: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../lib/api', () => ({
  suppliersApi: { list: jest.fn() },
  locationsApi: { list: jest.fn() },
  productsApi: { list: jest.fn() },
  purchaseOrdersApi: { create: jest.fn(), update: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const create = purchaseOrdersApi.create as jest.Mock;
const update = purchaseOrdersApi.update as jest.Mock;
const replace = router.replace as jest.Mock;
const back = router.back as jest.Mock;

const SUPPLIER = { id: 'sup-1', name: 'Eco Industries' };
const LOCATION = { id: 'loc-1', name: 'Shop Front' };
const PRODUCT = { id: 'prod-1', name: 'Everyday Battery' };

const CREATED = {
  id: 'po-1',
  number: 'PO-0001',
  status: 'DRAFT',
  supplier: SUPPLIER,
  location: LOCATION,
  items: [{ productId: PRODUCT.id, productName: PRODUCT.name, quantityOrdered: 3 }],
};

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({ user: { id: 'u1', role: 'MANAGER' }, token: 'token-1', signOut: jest.fn() });
  (suppliersApi.list as jest.Mock).mockResolvedValue({ items: [SUPPLIER], total: 1, totalPages: 1 });
  (locationsApi.list as jest.Mock).mockResolvedValue({ items: [LOCATION], total: 1, totalPages: 1 });
  (productsApi.list as jest.Mock).mockResolvedValue({ items: [PRODUCT], total: 1, totalPages: 1 });
});

/**
 * Fill the form the way a member does.
 *
 * Each picker is a closed `Modal` until it is pressed — its options do not exist in the tree before that — so a
 * test that looked for "Eco Industries" without opening the sheet would wait for something the screen never
 * renders. The options are found with `findByText` because they appear one commit after the press.
 */
async function fillValidOrder(view: Awaited<ReturnType<typeof withTheme>>): Promise<void> {
  await waitFor(() => expect(view.getByText('Choose a supplier…')).toBeTruthy());

  // Every press is AWAITED: RNTL 14's `fireEvent.press` returns a promise that resolves after the handler's
  // updates have been flushed, so an unawaited press is a press that has not happened yet when the next line
  // reads the tree. (This suite's first draft did exactly that and spent its time looking for a line the screen
  // had not been asked to add.)
  await fireEvent.press(view.getByText('Choose a supplier…'));
  await fireEvent.press(await view.findByText('Eco Industries'));

  await fireEvent.press(view.getByText('Where stock will land…'));
  await fireEvent.press(await view.findByText('Shop Front'));

  await fireEvent.press(view.getByText('Add line'));
  await fireEvent.press(await view.findByText('Choose a product…'));
  await fireEvent.press(await view.findByText('Everyday Battery'));

  await fireEvent.changeText(view.getByPlaceholderText('e.g. 24'), '3');
}

describe('PO form — where create lands', () => {
  it('★ creating a draft opens the draft, and does not also pop the stack', async () => {
    create.mockResolvedValue(CREATED);
    const view = await withTheme(<PoForm />);
    await fillValidOrder(view);

    await fireEvent.press(view.getByText('Create draft order'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/purchase-orders/po-1'));
    expect(back).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toBe('token-1');
    expect(create.mock.calls[0][1]).toEqual({
      supplierId: 'sup-1',
      locationId: 'loc-1',
      items: [{ productId: 'prod-1', quantityOrdered: 3 }],
    });
  });

  it('editing still returns to the detail it was opened from', async () => {
    update.mockResolvedValue({ ...CREATED, id: 'po-9', number: 'PO-0009' });
    const view = await withTheme(<PoForm initial={CREATED} />);

    await fireEvent.press(view.getByText('Save changes'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toBe('po-1');
    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('a create response with no id falls back to popping, rather than leaving the member on a stale form', async () => {
    create.mockResolvedValue({ number: 'PO-0002' });
    const view = await withTheme(<PoForm />);
    await fillValidOrder(view);

    await fireEvent.press(view.getByText('Create draft order'));

    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('PO form — what is refused before a request', () => {
  it('★ an empty form is rejected client-side, and nothing is sent', async () => {
    const view = await withTheme(<PoForm />);
    await waitFor(() => expect(view.getByText('Create draft order')).toBeTruthy());

    await fireEvent.press(view.getByText('Create draft order'));
    await flush();

    expect(view.getByText('Supplier is required.')).toBeTruthy();
    expect(view.getByText('Location is required.')).toBeTruthy();
    expect(view.getByText('Add at least one product line.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    // …and the form is still usable afterwards, not stuck in its busy state.
    expect(view.getByText('Create draft order')).toBeTruthy();
  });
});

describe('PO form — server errors reach the member as copy', () => {
  it('a field error is attached to the field it names', async () => {
    create.mockRejectedValue(
      new ApiError(400, 'VALIDATION_ERROR', 'Invalid order', [{ field: 'items[0].quantityOrdered', message: 'Quantity is required.' }]),
    );
    const view = await withTheme(<PoForm />);
    await fillValidOrder(view);

    await fireEvent.press(view.getByText('Create draft order'));

    await waitFor(() => expect(view.getByText('Quantity is required.')).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('a code error is translated, never shown as the code itself', async () => {
    create.mockRejectedValue(Object.assign(new Error('PO_NUMBER_CONFLICT'), { code: 'PO_NUMBER_CONFLICT' }));
    const view = await withTheme(<PoForm />);
    await fillValidOrder(view);

    await fireEvent.press(view.getByText('Create draft order'));

    await waitFor(() =>
      expect(view.getByText('Could not allocate a unique order number. Please try again.')).toBeTruthy(),
    );
    expect(view.queryByText('PO_NUMBER_CONFLICT')).toBeNull();
  });
});

describe('PO form — archived references on a saved draft', () => {
  it('★ refuses the archived receiving location and repairs it with an active one', async () => {
    update.mockResolvedValue({ ...CREATED, location: LOCATION });
    const archivedLocation = { id: 'loc-archived', name: 'Closed warehouse' };
    const view = await withTheme(
      <PoForm initial={{ ...CREATED, location: archivedLocation }} />
    );

    await waitFor(() => expect(view.getByTestId('po-reference-unavailable')).toBeTruthy());
    expect(
      view.getByText(
        'A selected supplier or receiving location is archived. Choose an active replacement before saving.'
      )
    ).toBeTruthy();

    await fireEvent.press(view.getByText('Save changes'));
    await waitFor(() =>
      expect(
        view.getByText('The selected location is archived. Choose an active location.')
      ).toBeTruthy()
    );
    expect(update).not.toHaveBeenCalled();

    await fireEvent.press(view.getByText('Clear archived location'));
    await fireEvent.press(view.getByText('Where stock will land…'));
    await fireEvent.press(await view.findByText('Shop Front'));
    await fireEvent.press(view.getByText('Save changes'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toMatchObject({ locationId: 'loc-1' });
  });
});
