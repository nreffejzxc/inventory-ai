/**
 * An unfinished bulk import must survive an app restart: the same CSV and the
 * same operation key are the client's proof that a retry is the same operation,
 * not a second catalogue. These tests pin the storage contract:
 *
 *   • a cold start restores the exact file name, CSV and key;
 *   • another account on the same device cannot see or clear the draft;
 *   • a completed import clears it, and a late completion cannot delete a newer
 *     operation's draft;
 *   • the raw account id never appears in a storage key or file path.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

type DraftModule = typeof import('../lib/productImportDraft');

const mockSecureStore = new Map<string, string>();
const mockFiles = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  makeDirectoryAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async (uri: string) => {
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    return [...mockFiles.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => path.slice(prefix.length));
  }),
  writeAsStringAsync: jest.fn(async (uri: string, contents: string) => {
    mockFiles.set(uri, contents);
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const value = mockFiles.get(uri);
    if (value === undefined) throw new Error('file not found');
    return value;
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const path of [...mockFiles.keys()]) {
      if (path === uri || path.startsWith(uri)) mockFiles.delete(path);
    }
  }),
}));

function coldStart(): DraftModule {
  let loaded: DraftModule | null = null;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh registry is the cold app start
    loaded = require('../lib/productImportDraft') as DraftModule;
  });
  if (!loaded) throw new Error('productImportDraft module did not load');
  return loaded;
}

const CSV = 'name,currency,openingQuantity\nWidget,PHP,3\nGadget,PHP,1\n';
const DRAFT = { fileName: 'products.csv', csv: CSV, key: 'op-test-abcdefgh' };

function directoryOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/') + 1);
}

beforeEach(() => {
  mockSecureStore.clear();
  mockFiles.clear();
  jest.clearAllMocks();
});

it('★ restores the exact CSV and operation key after a cold start', async () => {
  await expect(coldStart().saveProductImportDraft('user-1', DRAFT)).resolves.toBe(true);

  const afterRestart = coldStart();
  await expect(afterRestart.loadProductImportDraft('user-1')).resolves.toEqual(DRAFT);

  expect(mockFiles.size).toBe(1);
  const [fileUri] = [...mockFiles.keys()];
  expect(fileUri).toContain('file:///documents/product-imports/');
  expect(fileUri).not.toContain('user-1');
  expect([...mockSecureStore.keys()][0]).not.toContain('user-1');
});

it('★ isolates drafts by account and clearing one leaves the other resumable', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  await module.saveProductImportDraft('user-2', {
    ...DRAFT,
    fileName: 'other.csv',
    csv: 'name,currency\nOther,PHP\n',
    key: 'op-test-ijklmnop',
  });

  await expect(module.loadProductImportDraft('user-1')).resolves.toMatchObject({
    fileName: 'products.csv',
    key: DRAFT.key,
  });
  await expect(module.loadProductImportDraft('user-2')).resolves.toMatchObject({
    fileName: 'other.csv',
    key: 'op-test-ijklmnop',
  });
  await expect(module.loadProductImportDraft('user-3')).resolves.toBeNull();

  await expect(module.clearProductImportDraft('user-1', DRAFT.key)).resolves.toBe(true);
  await expect(module.loadProductImportDraft('user-1')).resolves.toBeNull();
  await expect(module.loadProductImportDraft('user-2')).resolves.toMatchObject({
    key: 'op-test-ijklmnop',
  });
});

it('★ clears a completed import but preserves a newer key', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);

  await expect(module.clearProductImportDraft('user-1', 'op-test-olderkey')).resolves.toBe(false);
  await expect(module.loadProductImportDraft('user-1')).resolves.toEqual(DRAFT);

  await expect(module.clearProductImportDraft('user-1', DRAFT.key)).resolves.toBe(true);
  await expect(module.loadProductImportDraft('user-1')).resolves.toBeNull();
  expect(mockFiles.size).toBe(0);
  expect([...mockSecureStore.keys()].some((key) => key.includes('productImportDraft'))).toBe(false);
});

it('★ expires an old draft instead of offering a stale Resume after a week', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  const now = Date.now();

  await expect(
    module.loadProductImportDraft('user-1', now + module.PRODUCT_IMPORT_DRAFT_TTL_MS + 1),
  ).resolves.toBeNull();
  expect(mockFiles.size).toBe(0);
  expect([...mockSecureStore.keys()]).toHaveLength(0);
  await expect(module.loadProductImportDraft('user-1')).resolves.toBeNull();
});

it('★ removes orphan files without touching another account or the live draft', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  await module.saveProductImportDraft('user-2', {
    ...DRAFT,
    fileName: 'other.csv',
    csv: 'name,currency\nOther,PHP\n',
    key: 'op-test-ijklmnop',
  });
  const user1Uri = [...mockFiles.keys()].find((uri) => mockFiles.get(uri) === CSV) as string;
  const user2Uri = [...mockFiles.keys()].find((uri) => mockFiles.get(uri) === 'name,currency\nOther,PHP\n') as string;
  const orphan = `${directoryOf(user1Uri)}draft-op-orphan.csv`;
  mockFiles.set(orphan, 'name,currency\nOrphan,PHP\n');

  await expect(module.cleanupProductImportDrafts('user-1')).resolves.toBe(1);
  expect(mockFiles.has(orphan)).toBe(false);
  expect(mockFiles.has(user1Uri)).toBe(true);
  expect(mockFiles.has(user2Uri)).toBe(true);
  await expect(module.loadProductImportDraft('user-1')).resolves.toEqual(DRAFT);
  await expect(module.loadProductImportDraft('user-2')).resolves.toMatchObject({
    key: 'op-test-ijklmnop',
  });

  await expect(
    module.cleanupProductImportDrafts('user-1', Date.now() + module.PRODUCT_IMPORT_DRAFT_TTL_MS + 1),
  ).resolves.toBe(1);
  expect(mockFiles.has(user1Uri)).toBe(false);
  expect(mockFiles.has(user2Uri)).toBe(true);
  await expect(module.loadProductImportDraft('user-2')).resolves.toMatchObject({
    key: 'op-test-ijklmnop',
  });
});

it('★ preserves a valid draft when metadata or directory reads fail transiently', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  const [fileUri] = [...mockFiles.keys()];
  const [metaKey] = [...mockSecureStore.keys()];
  const getItem = SecureStore.getItemAsync as jest.Mock;
  const readDirectory = FileSystem.readDirectoryAsync as jest.Mock;

  // A locked SecureStore says nothing about the file on disk. Cleanup must not
  // treat the unreadable metadata as "missing" and delete the CSV.
  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(module.cleanupProductImportDrafts('user-1')).resolves.toBe(0);
  expect(mockFiles.has(fileUri!)).toBe(true);
  expect(mockSecureStore.has(metaKey!)).toBe(true);

  // The same holds when the metadata is readable but the directory is not.
  readDirectory.mockRejectedValueOnce(new Error('storage busy'));
  await expect(module.cleanupProductImportDrafts('user-1')).resolves.toBe(0);
  expect(mockFiles.has(fileUri!)).toBe(true);
  expect(mockSecureStore.has(metaKey!)).toBe(true);

  // Loading and expected-key clearing also preserve the file when the read
  // fails; only a later successful read may settle it.
  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(module.loadProductImportDraft('user-1')).resolves.toBeNull();
  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(module.clearProductImportDraft('user-1', DRAFT.key)).resolves.toBe(false);
  expect(mockFiles.has(fileUri!)).toBe(true);
  expect(mockSecureStore.has(metaKey!)).toBe(true);

  await expect(module.loadProductImportDraft('user-1')).resolves.toEqual(DRAFT);
});

it('★ reports an unreadable saved attempt as error rather than missing', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  const [fileUri] = [...mockFiles.keys()];
  const [metaKey] = [...mockSecureStore.keys()];
  const getItem = SecureStore.getItemAsync as jest.Mock;
  const readFile = FileSystem.readAsStringAsync as jest.Mock;

  getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(module.readProductImportDraft('user-1')).resolves.toEqual({ status: 'error' });

  readFile.mockRejectedValueOnce(new Error('storage busy'));
  await expect(module.readProductImportDraft('user-1')).resolves.toEqual({ status: 'error' });

  expect(mockFiles.has(fileUri!)).toBe(true);
  expect(mockSecureStore.has(metaKey!)).toBe(true);
  await expect(module.readProductImportDraft('user-1')).resolves.toEqual({
    status: 'ok',
    draft: DRAFT,
  });
  await expect(module.readProductImportDraft('user-2')).resolves.toEqual({ status: 'missing' });
});

it('★ purges the CSV even when SecureStore metadata deletion fails', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  const [fileUri] = [...mockFiles.keys()];
  const deleteItem = SecureStore.deleteItemAsync as jest.Mock;
  deleteItem.mockRejectedValueOnce(new Error('keychain unavailable'));

  await expect(module.purgeProductImportDraft('user-1')).resolves.toBe(true);
  expect(mockFiles.has(fileUri!)).toBe(false);
  await expect(module.loadProductImportDraft('user-1')).resolves.toBeNull();
});

it('★ keeps the metadata when the purge cannot delete the CSV', async () => {
  const module = coldStart();
  await module.saveProductImportDraft('user-1', DRAFT);
  const [fileUri] = [...mockFiles.keys()];
  const [metaKey] = [...mockSecureStore.keys()];
  const deleteFile = FileSystem.deleteAsync as jest.Mock;
  deleteFile.mockRejectedValueOnce(new Error('file busy'));

  await expect(module.purgeProductImportDraft('user-1')).resolves.toBe(false);
  expect(mockFiles.has(fileUri!)).toBe(true);
  expect(mockSecureStore.has(metaKey!)).toBe(true);
  await expect(module.loadProductImportDraft('user-1')).resolves.toEqual(DRAFT);
});
