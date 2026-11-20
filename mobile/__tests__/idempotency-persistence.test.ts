/**
 * Idempotency keys must outlive the component and the process, without becoming a
 * permanent name for "the same form". These tests pin the storage contract:
 *
 *   • the same operation (kind + owner + target + payload) resumes the same key
 *     after the module is reloaded, which is what a cold app start does;
 *   • a different operation, owner, target or payload gets a different key;
 *   • a key older than the server's 24-hour TTL is not resumed;
 *   • a completed key is removed, so a later identical operation is genuinely new;
 *   • corrupt records and an unavailable SecureStore fail safe.
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

type IdempotencyModule = typeof import('../lib/idempotency');
type ClientModule = typeof import('../lib/client');

/** A fresh module instance is a cold start: module memory is gone, SecureStore is not. */
function coldStart(): IdempotencyModule {
  let loaded: IdempotencyModule | null = null;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the isolated registry is what makes this a cold start
    loaded = require('../lib/idempotency') as IdempotencyModule;
  });
  if (!loaded) throw new Error('idempotency module did not load');
  return loaded;
}

/** Load the client and idempotency modules in the SAME isolated registry. */
function coldStartWithClient(): {
  idempotency: IdempotencyModule;
  ApiError: ClientModule['ApiError'];
} {
  const loaded: { idempotency?: IdempotencyModule; client?: ClientModule } = {};
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- match the idempotency registry
    loaded.idempotency = require('../lib/idempotency') as IdempotencyModule;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- same registry as the module above
    loaded.client = require('../lib/client') as ClientModule;
  });
  if (!loaded.idempotency || !loaded.client) throw new Error('isolated modules did not load');
  return { idempotency: loaded.idempotency, ApiError: loaded.client.ApiError };
}

const OPERATION = {
  kind: 'stock-in' as const,
  ownerId: 'user-1',
  payload: { productId: 'p1', locationId: 'l1', quantity: 5 },
};

beforeEach(() => {
  mockSecureStore.clear();
  jest.clearAllMocks();
});

it('★ resumes the same key after a cold start', async () => {
  const first = await coldStart().getOrCreateOperationKey(OPERATION);
  const afterRestart = await coldStart().getOrCreateOperationKey(OPERATION);

  expect(afterRestart).toBe(first);
});

it('does not reuse a key for a different kind, owner, target or payload', async () => {
  const first = await coldStart().getOrCreateOperationKey(OPERATION);

  await expect(
    coldStart().getOrCreateOperationKey({ ...OPERATION, kind: 'adjust' }),
  ).resolves.not.toBe(first);
  await expect(
    coldStart().getOrCreateOperationKey({ ...OPERATION, ownerId: 'user-2' }),
  ).resolves.not.toBe(first);
  await expect(
    coldStart().getOrCreateOperationKey({ ...OPERATION, target: 'po-1' }),
  ).resolves.not.toBe(first);
  await expect(
    coldStart().getOrCreateOperationKey({
      ...OPERATION,
      payload: { ...OPERATION.payload, quantity: 6 },
    }),
  ).resolves.not.toBe(first);
});

it('ignores an expired key instead of extending its life', async () => {
  const { PENDING_OPERATION_TTL_MS, getOrCreateOperationKey } = coldStart();
  const first = await getOrCreateOperationKey(OPERATION);

  const [storageKey] = [...mockSecureStore.keys()];
  const bucket = JSON.parse(mockSecureStore.get(storageKey) as string) as {
    version: 2;
    operations: Record<string, unknown>[];
  };
  bucket.operations[0]!.createdAt = Date.now() - PENDING_OPERATION_TTL_MS - 1;
  mockSecureStore.set(storageKey, JSON.stringify(bucket));

  const afterExpiry = await coldStart().getOrCreateOperationKey(OPERATION);
  expect(afterExpiry).not.toBe(first);
});

it('★ keeps two same-kind operations and resumes the first after switching', async () => {
  const module = coldStart();
  const other = {
    ...OPERATION,
    payload: { ...OPERATION.payload, quantity: 7 },
  };

  const first = await module.getOrCreateOperationKey(OPERATION);
  const second = await module.getOrCreateOperationKey(other);
  expect(second).not.toBe(first);

  // Switching back is the regression: the single-slot store used to have
  // overwritten the first operation's key with the second one.
  expect(await coldStart().getOrCreateOperationKey(OPERATION)).toBe(first);
  expect(await coldStart().getOrCreateOperationKey(other)).toBe(second);

  // Completing the second must not disturb the first unresolved operation.
  await module.completeOperation(other.kind, second, OPERATION.ownerId);
  expect(await coldStart().getOrCreateOperationKey(OPERATION)).toBe(first);
  expect(await coldStart().getOrCreateOperationKey(other)).not.toBe(second);
});

it('refuses a new operation when the bounded bucket is full, without evicting one', async () => {
  const module = coldStart();
  const keys: string[] = [];
  for (let i = 0; i < module.MAX_PENDING_OPERATIONS_PER_KIND; i += 1) {
    keys.push(
      await module.getOrCreateOperationKey({
        ...OPERATION,
        payload: { ...OPERATION.payload, quantity: i + 1 },
      }),
    );
  }

  await expect(
    module.getOrCreateOperationKey({
      ...OPERATION,
      payload: { ...OPERATION.payload, quantity: 99 },
    }),
  ).rejects.toBeInstanceOf(module.PendingOperationsFullError);

  // Every unresolved operation is still resumable after the refusal.
  for (let i = 0; i < keys.length; i += 1) {
    await expect(
      module.getOrCreateOperationKey({
        ...OPERATION,
        payload: { ...OPERATION.payload, quantity: i + 1 },
      }),
    ).resolves.toBe(keys[i]);
  }
});

it('migrates a v1 single record into the v2 bucket without losing the key', async () => {
  const module = coldStart();
  const first = await module.getOrCreateOperationKey(OPERATION);
  const [v2Key] = [...mockSecureStore.keys()];
  const v2 = JSON.parse(mockSecureStore.get(v2Key) as string) as {
    operations: Record<string, unknown>[];
  };
  mockSecureStore.delete(v2Key);
  mockSecureStore.set(
    'inventoryai.idempotency.v1.stock-in',
    JSON.stringify(v2.operations[0]),
  );

  expect(await coldStart().getOrCreateOperationKey(OPERATION)).toBe(first);
  expect(mockSecureStore.has(v2Key)).toBe(true);
  expect(mockSecureStore.has('inventoryai.idempotency.v1.stock-in')).toBe(false);
});

it('keeps keys for every 5xx, timeout and in-flight answer, but ends on a definite 4xx', () => {
  const { idempotency, ApiError } = coldStartWithClient();
  const { endsOperation } = idempotency;

  for (let status = 500; status <= 599; status += 1) {
    expect(endsOperation(new ApiError(status, 'SERVER_ERROR', 'Failed'))).toBe(false);
  }
  expect(endsOperation(new ApiError(0, 'NETWORK_TIMEOUT', 'Timed out'))).toBe(false);
  expect(endsOperation(new ApiError(408, 'REQUEST_TIMEOUT', 'Timed out'))).toBe(false);
  expect(
    endsOperation(new ApiError(409, 'IDEMPOTENT_REQUEST_IN_PROGRESS', 'In progress')),
  ).toBe(false);
  expect(endsOperation(new ApiError(409, 'RECEIVE_IN_PROGRESS', 'In progress'))).toBe(false);

  expect(endsOperation(new ApiError(400, 'VALIDATION_ERROR', 'Bad request'))).toBe(true);
  expect(endsOperation(new ApiError(404, 'NOT_FOUND', 'Missing'))).toBe(true);
  expect(endsOperation(new ApiError(429, 'RATE_LIMITED', 'Slow down'))).toBe(true);
});

it('★ resumes a product create across a cold start and isolates tenant owners', async () => {
  const product = {
    kind: 'product.create' as const,
    ownerId: 'owner-a',
    payload: { name: 'Kettle', sellingPrice: 10, currency: 'USD' },
  };

  const first = await coldStart().getOrCreateOperationKey(product);
  expect(await coldStart().getOrCreateOperationKey(product)).toBe(first);
  await expect(
    coldStart().getOrCreateOperationKey({ ...product, ownerId: 'owner-b' }),
  ).resolves.not.toBe(first);
});

it('★ scopes a receive key to the purchase order and canonical lines', async () => {
  const receive = {
    kind: 'purchase-order.receive' as const,
    ownerId: 'owner-a',
    target: 'po-1',
    payload: { lines: [{ productId: 'p1', quantity: 3 }], reference: 'INV-1' },
  };

  const first = await coldStart().getOrCreateOperationKey(receive);
  expect(await coldStart().getOrCreateOperationKey(receive)).toBe(first);

  // A different key order in the same payload is the same operation.
  expect(
    await coldStart().getOrCreateOperationKey({
      ...receive,
      payload: { reference: 'INV-1', lines: [{ quantity: 3, productId: 'p1' }] },
    }),
  ).toBe(first);

  await expect(
    coldStart().getOrCreateOperationKey({ ...receive, target: 'po-2' }),
  ).resolves.not.toBe(first);
  await expect(
    coldStart().getOrCreateOperationKey({
      ...receive,
      payload: { ...receive.payload, reference: 'INV-2' },
    }),
  ).resolves.not.toBe(first);
});

it('removes a completed key so the next identical operation is new', async () => {
  const firstModule = coldStart();
  const first = await firstModule.getOrCreateOperationKey(OPERATION);
  await firstModule.completeOperation(OPERATION.kind, first, OPERATION.ownerId);

  const next = await coldStart().getOrCreateOperationKey(OPERATION);
  expect(next).not.toBe(first);
  expect(mockSecureStore.size).toBe(1);
});

it('does not let a stale completion erase a newer key', async () => {
  const module = coldStart();
  const first = await module.getOrCreateOperationKey(OPERATION);
  await module.completeOperation(OPERATION.kind, first, OPERATION.ownerId);
  const second = await module.getOrCreateOperationKey(OPERATION);

  await module.completeOperation(OPERATION.kind, first, OPERATION.ownerId);

  expect(await coldStart().getOrCreateOperationKey(OPERATION)).toBe(second);
});

it('fails safe when SecureStore is unavailable, without breaking one launch', async () => {
  const SecureStore = jest.requireMock('expo-secure-store') as {
    getItemAsync: jest.Mock;
    setItemAsync: jest.Mock;
  };
  SecureStore.getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
  SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));

  const module = coldStart();
  const first = await module.getOrCreateOperationKey(OPERATION);
  const retry = await module.getOrCreateOperationKey(OPERATION);

  expect(retry).toBe(first);
});

it('refuses a corrupt stored record rather than resuming it', async () => {
  const first = await coldStart().getOrCreateOperationKey(OPERATION);
  const [storageKey] = [...mockSecureStore.keys()];
  mockSecureStore.set(storageKey, '{not json');

  const next = await coldStart().getOrCreateOperationKey(OPERATION);
  expect(next).not.toBe(first);
});

/** A v2 record, as the previous release wrote it. */
function previousRecord(key: string, ownerId: string) {
  return {
    version: 1,
    key,
    ownerId,
    target: '',
    fingerprint: `previous-${ownerId}`,
    createdAt: Date.now(),
  };
}

it('★ scopes the bucket by account, so one account cannot fill another\'s', async () => {
  const module = coldStart();
  const ownerA = 'shared-device-a';
  const ownerB = 'shared-device-b';

  // Account A leaves the bucket full — eight unresolved operations.
  const keysA: string[] = [];
  for (let i = 0; i < module.MAX_PENDING_OPERATIONS_PER_KIND; i += 1) {
    keysA.push(
      await module.getOrCreateOperationKey({
        kind: 'stock-in',
        ownerId: ownerA,
        payload: { productId: 'p1', locationId: 'l1', quantity: i + 1 },
      }),
    );
  }
  await expect(
    module.getOrCreateOperationKey({
      kind: 'stock-in',
      ownerId: ownerA,
      payload: { productId: 'p1', locationId: 'l1', quantity: 99 },
    }),
  ).rejects.toBeInstanceOf(module.PendingOperationsFullError);

  // Account B signs in on the same device and still has the full allowance.
  const keysB: string[] = [];
  for (let i = 0; i < module.MAX_PENDING_OPERATIONS_PER_KIND; i += 1) {
    keysB.push(
      await module.getOrCreateOperationKey({
        kind: 'stock-in',
        ownerId: ownerB,
        payload: { productId: 'p1', locationId: 'l1', quantity: i + 1 },
      }),
    );
  }
  expect(new Set([...keysA, ...keysB]).size).toBe(
    module.MAX_PENDING_OPERATIONS_PER_KIND * 2,
  );

  // The buckets are separate storage items: one account never rewrites the other's.
  const buckets = [...mockSecureStore.keys()].filter((key) =>
    key.startsWith('inventoryai.idempotency.v3.') && key.endsWith('.stock-in'),
  );
  expect(buckets).toHaveLength(2);
});

it('★ keeps each account\'s unresolved keys across a sign-out/sign-in cycle', async () => {
  const payload = { productId: 'p1', locationId: 'l1', quantity: 5 };
  const ownerA = 'account-a';
  const ownerB = 'account-b';

  // A submits, then signs out. B signs in and submits the same movement.
  const a = await coldStart().getOrCreateOperationKey({
    kind: 'stock-in',
    ownerId: ownerA,
    payload,
  });
  const b = await coldStart().getOrCreateOperationKey({
    kind: 'stock-in',
    ownerId: ownerB,
    payload,
  });
  expect(b).not.toBe(a);

  // Both accounts sign in again after a restart and resume their OWN key. A
  // shared bucket would have made the second submit inherit the first key (or, at
  // capacity, refuse it outright).
  expect(
    await coldStart().getOrCreateOperationKey({ kind: 'stock-in', ownerId: ownerA, payload }),
  ).toBe(a);
  expect(
    await coldStart().getOrCreateOperationKey({ kind: 'stock-in', ownerId: ownerB, payload }),
  ).toBe(b);

  // Completing B's operation cannot remove A's unresolved key.
  const second = coldStart();
  await second.completeOperation('stock-in', b, ownerB);
  expect(
    await coldStart().getOrCreateOperationKey({ kind: 'stock-in', ownerId: ownerA, payload }),
  ).toBe(a);
  expect(
    await coldStart().getOrCreateOperationKey({ kind: 'stock-in', ownerId: ownerB, payload }),
  ).not.toBe(b);
});

it('★ serializes concurrent submissions so no pending key is overwritten', async () => {
  const module = coldStart();
  const requests = Array.from({ length: module.MAX_PENDING_OPERATIONS_PER_KIND }, (_, i) => ({
    ...OPERATION,
    payload: { ...OPERATION.payload, quantity: i + 1 },
  }));

  // Without the mutation queue each call reads the same empty bucket and the last
  // write wins, leaving one key where eight operations were started.
  const keys = await Promise.all(
    requests.map((request) => module.getOrCreateOperationKey(request)),
  );
  expect(new Set(keys).size).toBe(module.MAX_PENDING_OPERATIONS_PER_KIND);

  // Every one of them is resumable after a cold start, not just the last write.
  const afterRestart = coldStart();
  for (let i = 0; i < requests.length; i += 1) {
    expect(await afterRestart.getOrCreateOperationKey(requests[i]!)).toBe(keys[i]);
  }
});

it('★ serializes concurrent copies of the same operation to one key', async () => {
  const module = coldStart();

  // A double tap that lands inside one JS task: both reads must not mint a key.
  const keys = await Promise.all(
    Array.from({ length: 6 }, () => module.getOrCreateOperationKey(OPERATION)),
  );
  expect(new Set(keys).size).toBe(1);
  expect(await coldStart().getOrCreateOperationKey(OPERATION)).toBe(keys[0]);
});

it('★ moves only the signed-in account out of a shared v2 bucket', async () => {
  mockSecureStore.set(
    'inventoryai.idempotency.v2.stock-in',
    JSON.stringify({
      version: 2,
      operations: [
        previousRecord('op-previous-a', 'owner-a'),
        previousRecord('op-previous-b', 'owner-b'),
      ],
    }),
  );

  const module = coldStart();
  await module.getOrCreateOperationKey({
    kind: 'stock-in',
    ownerId: 'owner-a',
    payload: { quantity: 1 },
  });

  // A's old record moved to its own v3 bucket and remains resumable there; B's
  // record was left untouched for B's first read.
  const afterA = JSON.parse(
    mockSecureStore.get('inventoryai.idempotency.v2.stock-in') as string,
  ) as { operations: { ownerId: string }[] };
  expect(afterA.operations.map((record) => record.ownerId)).toEqual(['owner-b']);

  const aBucket = [...mockSecureStore.keys()].find((key) =>
    key.startsWith('inventoryai.idempotency.v3.') && key.endsWith('.stock-in'),
  );
  expect(aBucket).toBeTruthy();
  const aRecords = JSON.parse(mockSecureStore.get(aBucket as string) as string) as {
    operations: { key: string; ownerId: string }[];
  };
  expect(aRecords.operations.some((record) => record.key === 'op-previous-a')).toBe(true);
  expect(aRecords.operations.every((record) => record.ownerId === 'owner-a')).toBe(true);

  await module.getOrCreateOperationKey({
    kind: 'stock-in',
    ownerId: 'owner-b',
    payload: { quantity: 1 },
  });
  expect(mockSecureStore.has('inventoryai.idempotency.v2.stock-in')).toBe(false);
});

it('migrates a v1 record even when a v2 bucket exists for another account', async () => {
  const request = { kind: 'stock-in' as const, ownerId: 'owner-mine', payload: { quantity: 1 } };
  const first = await coldStart().getOrCreateOperationKey(request);
  const v3Key = [...mockSecureStore.keys()].find(
    (key) => key.startsWith('inventoryai.idempotency.v3.') && key.endsWith('.stock-in'),
  ) as string;
  const record = JSON.parse(mockSecureStore.get(v3Key) as string).operations[0];
  mockSecureStore.delete(v3Key);
  mockSecureStore.set('inventoryai.idempotency.v1.stock-in', JSON.stringify(record));
  mockSecureStore.set(
    'inventoryai.idempotency.v2.stock-in',
    JSON.stringify({ version: 2, operations: [previousRecord('op-other-account', 'other-owner')] }),
  );

  // The v2 item exists, but it is not this account's. The older v1 record must
  // still migrate instead of being stranded behind the other account's bucket.
  expect(await coldStart().getOrCreateOperationKey(request)).toBe(first);
  expect(mockSecureStore.has('inventoryai.idempotency.v1.stock-in')).toBe(false);
  const remaining = JSON.parse(
    mockSecureStore.get('inventoryai.idempotency.v2.stock-in') as string,
  ) as { operations: { key: string }[] };
  expect(remaining.operations.map((operation) => operation.key)).toEqual(['op-other-account']);
});
