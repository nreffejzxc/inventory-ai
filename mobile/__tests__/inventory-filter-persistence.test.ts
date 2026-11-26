/**
 * Inventory remembers one location id and one status token per account.
 *
 * The stored value is not stock data and not a secret, but it is still scoped by
 * a digest of the authenticated user id: on a shared device, signing into
 * another account must not restore or overwrite the first account's choice.
 * Corrupt records and an unavailable SecureStore degrade to empty without
 * breaking the screen.
 */

import {
  clearInventoryFilters,
  EMPTY_INVENTORY_FILTERS,
  loadInventoryFilters,
  saveInventoryFilters,
} from '../lib/inventoryFilters';

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

beforeEach(async () => {
  mockSecureStore.clear();
  jest.clearAllMocks();
  await clearInventoryFilters('user-1');
  await clearInventoryFilters('user-2');
});

it('★ restores only the account that saved the choice', async () => {
  await saveInventoryFilters('user-1', { locationId: 'loc-front', status: 'needsAttention' });
  await saveInventoryFilters('user-2', { locationId: 'loc-back', status: 'out' });

  await expect(loadInventoryFilters('user-1')).resolves.toEqual({
    locationId: 'loc-front',
    status: 'needsAttention',
  });
  await expect(loadInventoryFilters('user-2')).resolves.toEqual({
    locationId: 'loc-back',
    status: 'out',
  });
  await expect(loadInventoryFilters('user-3')).resolves.toEqual(EMPTY_INVENTORY_FILTERS);
});

it('keys the record by a digest, not the raw account id', async () => {
  await saveInventoryFilters('user-1', { locationId: 'loc-front', status: 'low' });

  expect(mockSecureStore.size).toBe(1);
  const [key] = [...mockSecureStore.keys()];
  expect(key).toMatch(/^inventoryai\.inventoryFilters\.v1\./);
  expect(key).not.toContain('user-1');
});

it('Reset deletes one account’s choice without touching another account', async () => {
  await saveInventoryFilters('user-1', { locationId: 'loc-front', status: 'low' });
  await saveInventoryFilters('user-2', { locationId: 'loc-back', status: 'out' });

  await clearInventoryFilters('user-1');

  await expect(loadInventoryFilters('user-1')).resolves.toEqual(EMPTY_INVENTORY_FILTERS);
  await expect(loadInventoryFilters('user-2')).resolves.toEqual({
    locationId: 'loc-back',
    status: 'out',
  });
});

it('ignores corrupt and invalid records field by field', async () => {
  await saveInventoryFilters('user-1', { locationId: 'loc-front', status: 'low' });
  const [key] = [...mockSecureStore.keys()];

  mockSecureStore.set(key, '{not json');
  await expect(loadInventoryFilters('user-1')).resolves.toEqual(EMPTY_INVENTORY_FILTERS);

  mockSecureStore.set(
    key,
    JSON.stringify({ version: 1, locationId: 'loc-front', status: 'not-a-status' }),
  );
  await expect(loadInventoryFilters('user-1')).resolves.toEqual({
    locationId: 'loc-front',
    status: '',
  });

  mockSecureStore.set(
    key,
    JSON.stringify({ version: 1, locationId: 'bad id with spaces', status: 'out' }),
  );
  await expect(loadInventoryFilters('user-1')).resolves.toEqual({
    locationId: '',
    status: 'out',
  });
});

it('keeps working in memory when SecureStore is unavailable', async () => {
  const SecureStore = jest.requireMock('expo-secure-store') as {
    getItemAsync: jest.Mock;
    setItemAsync: jest.Mock;
    deleteItemAsync: jest.Mock;
  };
  SecureStore.getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
  await expect(loadInventoryFilters('user-1')).resolves.toEqual(EMPTY_INVENTORY_FILTERS);

  SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
  await saveInventoryFilters('user-1', { locationId: 'loc-front', status: 'low' });

  SecureStore.getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
  await expect(loadInventoryFilters('user-1')).resolves.toEqual({
    locationId: 'loc-front',
    status: 'low',
  });
});
