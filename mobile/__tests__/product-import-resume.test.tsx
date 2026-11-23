import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';

import ProductImportScreen from '../app/(app)/products/import';
import { productsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ApiError } from '../lib/client';
import { alert, confirm } from '../lib/confirm';
import {
  readProductImportDraft,
  clearProductImportDraft,
  saveProductImportDraft,
} from '../lib/productImportDraft';
import { ROLES } from '../lib/permissions';
import { ThemeProvider } from '../lib/theme-context';

/**
 * The screen consumes the account-scoped draft on mount. A restored PARTIAL
 * receipt must show the same key's Resume import path; a COMPLETED receipt must
 * clear the saved draft instead of offering a resume that could never be needed.
 */

const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href), push: jest.fn(), setParams: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn() }));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: () => false,
}));

jest.mock('../lib/api', () => ({
  productsApi: { importProducts: jest.fn(), importStatus: jest.fn() },
}));

jest.mock('../lib/confirm', () => ({
  alert: jest.fn(async () => {}),
  confirm: jest.fn(async () => true),
}));

jest.mock('../lib/idempotency', () => ({
  newIdempotencyKey: jest.fn(() => 'op-test-newkey1234'),
  endsOperation: jest.fn(() => false),
}));

jest.mock('../lib/productImportDraft', () => ({
  MAX_IMPORT_CSV_BYTES: 512 * 1024,
  utf8ByteLength: jest.fn((value: string) => value.length),
  saveProductImportDraft: jest.fn(async () => true),
  readProductImportDraft: jest.fn(),
  loadProductImportDraft: jest.fn(),
  clearProductImportDraft: jest.fn(async () => true),
  cleanupProductImportDrafts: jest.fn(async () => 0),
}));

const mockedUseSession = useSession as jest.Mock;
const importProducts = productsApi.importProducts as jest.Mock;
const importStatus = productsApi.importStatus as jest.Mock;
const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.Mock;
const readDraft = readProductImportDraft as jest.Mock;
const clearDraft = clearProductImportDraft as jest.Mock;
const saveDraft = saveProductImportDraft as jest.Mock;
const readFile = readAsStringAsync as jest.Mock;
const mockAlert = alert as jest.Mock;
const mockConfirm = confirm as jest.Mock;

const DRAFT = {
  fileName: 'resume-products.csv',
  csv: 'name,currency,openingQuantity\nWidget,PHP,3\n',
  key: 'op-test-resume1234',
};

const PREVIEW = {
  valid: true,
  fileName: DRAFT.fileName,
  summary: { totalRows: 1, validRows: 1, productCount: 1, openingStockRows: 1, openingStockUnits: 3 },
  errors: [],
};

const STATUS_BASE = {
  key: DRAFT.key,
  fileName: DRAFT.fileName,
  totalRows: 1,
  createdCount: 0,
  openingStockCount: 0,
  openingStockUnits: 0,
  failures: [],
  finishedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Owner', role: ROLES.OWNER },
    token: 'token-1',
    signOut: jest.fn(),
  });
  readDraft.mockResolvedValue({ status: 'ok', draft: DRAFT });
  clearDraft.mockResolvedValue(true);
  importProducts.mockResolvedValue(PREVIEW);
  mockAlert.mockResolvedValue(undefined);
  mockConfirm.mockResolvedValue(true);
});

it('★ sends no import when a new resume key cannot be saved', async () => {
  readDraft.mockResolvedValue({ status: 'missing' });
  getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///products.csv', name: 'products.csv', size: 40 }],
  });
  readFile.mockResolvedValue('name,currency\nWidget,PHP\n');
  importProducts.mockResolvedValueOnce(PREVIEW);
  saveDraft.mockResolvedValueOnce(false);

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  const picker = await view.findByRole('button', { name: /Choose CSV file/ });
  fireEvent.press(picker);
  await waitFor(() => expect(view.getByText('1 product(s) will be created; 1 opening-stock movement(s) covering 3 unit(s).')).toBeTruthy());
  fireEvent.press(view.getByText('Import products'));

  await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
  expect(importProducts).toHaveBeenCalledTimes(1);
  expect(importProducts).toHaveBeenCalledWith('token-1', {
    fileName: 'products.csv',
    csv: 'name,currency\nWidget,PHP\n',
    dryRun: true,
  });
  expect(importProducts).not.toHaveBeenCalledWith(
    'token-1',
    expect.objectContaining({ dryRun: false }),
    expect.anything(),
  );
  expect(
    view.getByText(
      'The import was not sent because its resume key could not be saved on this device. Try again.'
    )
  ).toBeTruthy();
  expect(view.getByText('Import products')).toBeTruthy();

  view.unmount();
});

it('★ restores the saved CSV and key from the receipt without a dry run', async () => {
  importStatus.mockResolvedValue({ ...STATUS_BASE, status: 'PARTIAL' });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(readDraft).toHaveBeenCalledWith('u1'));
  await waitFor(() => expect(importStatus).toHaveBeenCalledWith('token-1', DRAFT.key));
  await waitFor(() => expect(view.getByText('Resume import')).toBeTruthy());
  // A dry run is not what decides whether this saved operation can resume: rows
  // already applied would now look like duplicate SKUs.
  expect(importProducts).not.toHaveBeenCalled();
  expect(view.getByText(DRAFT.fileName)).toBeTruthy();
  expect(clearDraft).not.toHaveBeenCalled();

  view.unmount();
});

it('★ shows partial counts and keeps the CSV picker locked on the partial key', async () => {
  importStatus.mockResolvedValue({
    ...STATUS_BASE,
    status: 'PARTIAL',
    totalRows: 24,
    createdCount: 24,
    openingStockCount: 12,
    openingStockUnits: 12,
    failures: [
      {
        line: 14,
        field: 'openinglocation',
        code: 'LOCATION_ARCHIVED',
        message: 'Archived locations cannot be used in stock movements',
      },
    ],
  });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Import partly applied')).toBeTruthy());
  expect(
    view.getByText('24 of 24 product row(s) created; 12 opening-stock movement(s) recorded.'),
  ).toBeTruthy();
  expect(
    view.getByText('Part of this file was applied. Press Resume import to finish it.'),
  ).toBeTruthy();
  expect(view.getByText('Resume import')).toBeTruthy();

  // The file and its operation key stay selected: starting a different file here
  // would abandon the resumable receipt and invite a second catalogue.
  const lockedPicker = view.getByRole('button', { name: /Finish this import first/ });
  expect(lockedPicker.props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(lockedPicker);
  expect(getDocumentAsync).not.toHaveBeenCalled();
  expect(clearDraft).not.toHaveBeenCalled();

  view.unmount();
});

it('★ keeps the same-key Resume available even when validation would now fail', async () => {
  importStatus.mockResolvedValue({
    ...STATUS_BASE,
    status: 'PARTIAL',
    createdCount: 1,
    openingStockCount: 1,
    openingStockUnits: 3,
    failures: [{ line: 2, field: 'sku', code: 'SKU_ALREADY_EXISTS', message: 'sku already exists' }],
  });
  importProducts.mockImplementation(() => new Promise(() => {}));

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Import partly applied')).toBeTruthy());
  const resume = view.getByRole('button', { name: 'Resume import' });
  expect(resume.props.accessibilityState?.disabled).toBe(false);
  expect(importProducts).not.toHaveBeenCalled();

  fireEvent.press(resume);
  await waitFor(() =>
    expect(importProducts).toHaveBeenCalledWith(
      'token-1',
      { fileName: DRAFT.fileName, csv: DRAFT.csv, dryRun: false },
      DRAFT.key,
    ),
  );

  view.unmount();
});

it('★ does not hide Resume when the status lookup fails', async () => {
  importStatus.mockRejectedValue(new ApiError(503, 'SERVER_UNAVAILABLE', 'unavailable'));

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Resume import')).toBeTruthy());
  expect(importProducts).not.toHaveBeenCalled();
  expect(view.getByText(/Progress could not be checked/)).toBeTruthy();
  expect(view.getByRole('button', { name: 'Discard saved import' })).toBeTruthy();

  view.unmount();
});

it('★ locks a new import when the saved attempt cannot be read, then retries verification', async () => {
  readDraft
    .mockResolvedValueOnce({ status: 'error' })
    .mockResolvedValueOnce({ status: 'ok', draft: DRAFT });
  importStatus.mockResolvedValue({ ...STATUS_BASE, status: 'PARTIAL' });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Check saved import again')).toBeTruthy());
  expect(view.getByText(/could not be checked/)).toBeTruthy();
  const lockedPicker = view.getByRole('button', { name: /Check saved import first/ });
  expect(lockedPicker.props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(lockedPicker);
  expect(getDocumentAsync).not.toHaveBeenCalled();
  expect(importProducts).not.toHaveBeenCalled();

  fireEvent.press(view.getByText('Check saved import again'));
  await waitFor(() => expect(readDraft).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.getByText('Resume import')).toBeTruthy());
  expect(importStatus).toHaveBeenCalledWith('token-1', DRAFT.key);

  view.unmount();
});

it('★ unlocks a new import when retry confirms there is no saved draft', async () => {
  readDraft
    .mockResolvedValueOnce({ status: 'error' })
    .mockResolvedValueOnce({ status: 'missing' });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Check saved import again')).toBeTruthy());
  fireEvent.press(view.getByText('Check saved import again'));
  await waitFor(() =>
    expect(view.getByRole('button', { name: /Choose CSV file/ })).toBeTruthy(),
  );
  const picker = view.getByRole('button', { name: /Choose CSV file/ });
  expect(picker.props.accessibilityState?.disabled).toBe(false);
  expect(importStatus).not.toHaveBeenCalled();
  expect(view.queryByText(/could not be checked/)).toBeNull();

  view.unmount();
});

it('★ lets the member discard a permanently unreadable saved copy', async () => {
  readDraft.mockResolvedValue({ status: 'error' });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Discard unreadable saved import')).toBeTruthy());
  fireEvent.press(view.getByText('Discard unreadable saved import'));
  await waitFor(() => expect(clearDraft).toHaveBeenCalledWith('u1'));
  await waitFor(() =>
    expect(view.getByRole('button', { name: /Choose CSV file/ })).toBeTruthy(),
  );
  const picker = view.getByRole('button', { name: /Choose CSV file/ });
  expect(picker.props.accessibilityState?.disabled).toBe(false);
  expect(view.queryByText('Check saved import again')).toBeNull();
  expect(readDraft).toHaveBeenCalledTimes(1);

  view.unmount();
});

it('★ makes a failed receipt discardable instead of leaving a locked picker', async () => {
  importStatus.mockResolvedValue({
    ...STATUS_BASE,
    status: 'FAILED',
    failures: [{ line: 2, field: 'sku', code: 'INVALID', message: 'sku is invalid' }],
  });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Import not completed')).toBeTruthy());
  expect(view.queryByText('Resume import')).toBeNull();
  await act(async () => {
    fireEvent.press(view.getByRole('button', { name: 'Discard saved import' }));
  });
  await waitFor(() => expect(clearDraft).toHaveBeenCalledWith('u1', DRAFT.key));
  await waitFor(() => expect(view.queryByText(DRAFT.fileName)).toBeNull());
  expect(view.getByRole('button', { name: /Choose CSV file/ })).toBeTruthy();

  view.unmount();
});

it('★ clears the previous account’s file when the signed-in account changes', async () => {
  importStatus.mockResolvedValue({ ...STATUS_BASE, status: 'PARTIAL' });
  readDraft.mockImplementation(async (owner: string) =>
    owner === 'u1' ? { status: 'ok', draft: DRAFT } : { status: 'missing' },
  );

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );
  await waitFor(() => expect(view.getByText(DRAFT.fileName)).toBeTruthy());

  mockedUseSession.mockReturnValue({
    user: { id: 'u2', name: 'Other Owner', role: ROLES.OWNER },
    token: 'token-2',
    signOut: jest.fn(),
  });
  view.rerender(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(view.queryByText(DRAFT.fileName)).toBeNull());
  expect(view.queryByText('Resume import')).toBeNull();
  expect(view.getByRole('button', { name: /Choose CSV file/ })).toBeTruthy();
  expect(readDraft).toHaveBeenCalledWith('u2');

  view.unmount();
});

it('★ retries a failed completed-import cleanup and keeps a truthful retry state', async () => {
  importStatus.mockResolvedValue({
    ...STATUS_BASE,
    status: 'COMPLETED',
    createdCount: 1,
    openingStockCount: 1,
    openingStockUnits: 3,
    result: { createdCount: 1, openingStockCount: 1, openingStockUnits: 3 },
  });
  clearDraft.mockResolvedValue(false);

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(clearDraft).toHaveBeenCalledTimes(2));
  expect(mockReplace).not.toHaveBeenCalled();
  expect(
    view.getByText(
      'The import completed, but this device could not clear the saved import. Press Resume import to retry; the same key cannot create a second catalogue.'
    )
  ).toBeTruthy();
  expect(view.getByText('Resume import')).toBeTruthy();

  clearDraft.mockResolvedValue(true);
  importProducts.mockResolvedValue({ createdCount: 1, openingStockCount: 1, openingStockUnits: 3 });
  fireEvent.press(view.getByText('Resume import'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/products'));
  expect(clearDraft).toHaveBeenCalledTimes(3);
  view.unmount();
});

it('★ clears a completed restored import instead of offering it again', async () => {
  importStatus.mockResolvedValue({
    ...STATUS_BASE,
    status: 'COMPLETED',
    createdCount: 1,
    openingStockCount: 1,
    openingStockUnits: 3,
    result: { createdCount: 1, openingStockCount: 1, openingStockUnits: 3 },
  });

  const view = await render(
    <ThemeProvider>
      <ProductImportScreen />
    </ThemeProvider>,
  );

  await waitFor(() => expect(clearDraft).toHaveBeenCalledWith('u1', DRAFT.key));
  await waitFor(() => expect(mockAlert).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledWith('/products');

  view.unmount();
});
