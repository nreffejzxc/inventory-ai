/**
 * The Restock → Draft PO attempt must survive a restart with the exact body and
 * operation key. These tests pin the storage contract:
 *
 *   • a cold start restores the exact request;
 *   • another account cannot read or clear it;
 *   • a late clear cannot remove a newer attempt;
 *   • a transient SecureStore read failure does not look like “no attempt”.
 */

import * as SecureStore from 'expo-secure-store';

type DraftModule = typeof import('../lib/restockPurchaseOrderDraft');

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

function coldStart(): DraftModule {
  let loaded: DraftModule | null = null;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh registry is the cold app start
    loaded = require('../lib/restockPurchaseOrderDraft') as DraftModule;
  });
  if (!loaded) throw new Error('restockPurchaseOrderDraft module did not load');
  return loaded;
}

const DRAFT = {
  payload: {
    supplierId: 'sup-1',
    locationId: 'loc-1',
    items: [
      { productId: 'prod-1', availableQuantity: 2, minimumStock: 5 },
      { productId: 'prod-2', availableQuantity: 0, minimumStock: 3 },
    ],
  },
  key: 'op-draft-abcdefgh',
  savedAt: Date.now(),
};

beforeEach(() => {
  mockSecureStore.clear();
  jest.clearAllMocks();
});

it('★ restores the exact request and key after a cold start without storing the raw account id', async () => {
  await expect(coldStart().saveRestockPurchaseOrderDraft('user-1', DRAFT)).resolves.toBe(true);

  const afterRestart = coldStart();
  await expect(afterRestart.loadRestockPurchaseOrderDraft('user-1')).resolves.toEqual({
    status: 'found',
    draft: DRAFT,
  });
  await expect(afterRestart.loadRestockPurchaseOrderDraft('user-2')).resolves.toEqual({
    status: 'missing',
  });

  const [key] = [...mockSecureStore.keys()];
  expect(key).not.toContain('user-1');
});

it('★ isolates attempts by account and never lets a late clear remove a newer one', async () => {
  const module = coldStart();
  await module.saveRestockPurchaseOrderDraft('user-1', DRAFT);
  await module.saveRestockPurchaseOrderDraft('user-2', {
    ...DRAFT,
    payload: {
      ...DRAFT.payload,
      items: [{ productId: 'prod-9', availableQuantity: 1, minimumStock: 2 }],
    },
    key: 'op-draft-ijklmnop',
  });

  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toMatchObject({
    status: 'found',
    draft: { key: DRAFT.key },
  });
  await expect(module.loadRestockPurchaseOrderDraft('user-2')).resolves.toMatchObject({
    status: 'found',
    draft: { key: 'op-draft-ijklmnop' },
  });

  await expect(
    module.clearRestockPurchaseOrderDraft('user-1', 'op-draft-olderkey'),
  ).resolves.toBe(false);
  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toMatchObject({
    status: 'found',
    draft: { key: DRAFT.key },
  });

  const newer = { ...DRAFT, key: 'op-draft-newerkey', savedAt: Date.now() + 1 };
  await module.saveRestockPurchaseOrderDraft('user-1', newer);
  await expect(
    module.clearRestockPurchaseOrderDraft('user-1', DRAFT.key),
  ).resolves.toBe(false);
  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toMatchObject({
    status: 'found',
    draft: { key: newer.key },
  });

  await expect(
    module.clearRestockPurchaseOrderDraft('user-1', newer.key),
  ).resolves.toBe(true);
  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toEqual({
    status: 'missing',
  });
  await expect(module.loadRestockPurchaseOrderDraft('user-2')).resolves.toMatchObject({
    status: 'found',
    draft: { key: 'op-draft-ijklmnop' },
  });
});

it('★ distinguishes a transient read failure from an absent or clearable attempt', async () => {
  const module = coldStart();
  await module.saveRestockPurchaseOrderDraft('user-1', DRAFT);
  const getItem = SecureStore.getItemAsync as jest.Mock;

  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toEqual({
    status: 'error',
  });

  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(
    module.clearRestockPurchaseOrderDraft('user-1', DRAFT.key),
  ).resolves.toBe(false);

  await expect(module.loadRestockPurchaseOrderDraft('user-1')).resolves.toEqual({
    status: 'found',
    draft: DRAFT,
  });
});
