/**
 * AUTH-03 — the transport half of session renewal (`lib/client.ts`).
 *
 * These cases drive `apiFetch` directly against a stubbed `fetch`, with the
 * provider's hooks registered manually, so every branch of the renewal/recovery
 * behavior is exercised without React:
 *
 *   * classification is by APPLICATION CODE, not HTTP status;
 *   * a recoverable `SESSION_EXPIRED` is recovered once and retried EXACTLY once;
 *   * a second expiry on the retry is thrown, never recovered again (no loop);
 *   * a failed recovery does NOT report session loss;
 *   * a terminal refusal DOES report session loss and never attempts recovery;
 *   * a 429 carries `retryAfter` and is never session loss;
 *   * proactive renewal runs before the request and its token is used;
 *   * the renewal REQUEST itself bypasses those hooks, so the single-flight promise
 *     cannot end up waiting on itself.
 */

import {
  ApiError,
  SESSION_EXPIRED_CODE,
  SESSION_REFRESH_FAILED_MESSAGE,
  apiFetch,
  isRecoverableAuthError,
  setSessionLostHandler,
  setSessionRecoveryHandler,
  setSessionRenewalHandler,
} from '../lib/client';
import { renew } from '../lib/api';

type FakeResponse = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  headers: { get: (name: string) => string | null };
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const fetchMock = jest.fn();

beforeEach(() => {
  setSessionLostHandler(null);
  setSessionRecoveryHandler(null);
  setSessionRenewalHandler(null);
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

const authHeaderOf = (callIndex: number): string | undefined =>
  (fetchMock.mock.calls[callIndex]?.[1] as { headers?: Record<string, string> } | undefined)?.headers
    ?.Authorization;

describe('AUTH-03 — classification is by application code', () => {
  it('treats only SESSION_EXPIRED as recoverable', () => {
    expect(isRecoverableAuthError(new ApiError(401, 'SESSION_EXPIRED', 'x'))).toBe(true);
    expect(isRecoverableAuthError(new ApiError(401, 'SESSION_REVOKED', 'x'))).toBe(false);
    expect(isRecoverableAuthError(new ApiError(401, 'AUTH_REQUIRED', 'x'))).toBe(false);
    expect(isRecoverableAuthError(new ApiError(500, 'SESSION_EXPIRED', 'x'))).toBe(true);
  });
});

const idempotencyHeaderOf = (callIndex: number): string | undefined =>
  (fetchMock.mock.calls[callIndex]?.[1] as { headers?: Record<string, string> } | undefined)?.headers?.[
    'Idempotency-Key'
  ];

describe('AUTH-03 — the retried delivery is the same operation', () => {
  it('carries the Idempotency-Key across the recovery retry', async () => {
    setSessionRecoveryHandler(async () => 'new-token');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED' }))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true }));

    await apiFetch('/api/inventory/stock-in', {
      token: 'old-token',
      method: 'POST',
      body: { quantity: 5 },
      idempotencyKey: 'op-retry-12345678',
    });

    // Dropping the key on the retry would let a movement that outlived its token be
    // applied a second time by the retried delivery.
    expect(idempotencyHeaderOf(0)).toBe('op-retry-12345678');
    expect(idempotencyHeaderOf(1)).toBe('op-retry-12345678');
  });
});

describe('AUTH-03 — recovery and exactly-one retry', () => {
  it('recovers a SESSION_EXPIRED, retries once, and uses the recovered token', async () => {
    const recovery = jest.fn(async () => 'new-token');
    setSessionRecoveryHandler(recovery);
    const lost = jest.fn();
    setSessionLostHandler(lost);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED', error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(apiFetch('/api/products', { token: 'old-token' })).resolves.toEqual({ ok: true });

    expect(recovery).toHaveBeenCalledTimes(1);
    expect(lost).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOf(0)).toBe('Bearer old-token');
    expect(authHeaderOf(1)).toBe('Bearer new-token');
    // The handler is told WHICH token was refused, so a request whose token has
    // already been replaced can be retried without minting another one.
    expect(recovery).toHaveBeenCalledWith(expect.any(ApiError), 'old-token');
  });

  it('does NOT recover twice: a second SESSION_EXPIRED on the retry is thrown', async () => {
    const recovery = jest.fn(async () => 'new-token');
    setSessionRecoveryHandler(recovery);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED' }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED' }));

    await expect(apiFetch('/api/products', { token: 'old' })).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never reports a recoverable expiry as session loss, even when recovery fails', async () => {
    setSessionRecoveryHandler(async () => null);
    const lost = jest.fn();
    setSessionLostHandler(lost);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED' }));

    await expect(apiFetch('/api/x', { token: 't' })).rejects.toBeInstanceOf(ApiError);
    expect(lost).not.toHaveBeenCalled();
  });

  /**
   * The COPY fix (2026-10-22). A failed refresh keeps the session alive and retries later, so
   * repeating the server's "Session expired — please sign in again" would send the member to
   * re-authenticate for nothing — measured on a phone, on a live 14-day session. The CODE must
   * not move with it: screens classify on `SESSION_EXPIRED` and the recovery rule depends on it.
   */
  it('says the sign-in could not be refreshed, and does not claim the session ended', async () => {
    setSessionRecoveryHandler(async () => null);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        code: SESSION_EXPIRED_CODE,
        error: 'Session expired — please sign in again',
      }),
    );

    await expect(apiFetch('/api/x', { token: 't' })).rejects.toMatchObject({
      code: SESSION_EXPIRED_CODE,
      message: SESSION_REFRESH_FAILED_MESSAGE,
    });
    expect(SESSION_REFRESH_FAILED_MESSAGE).not.toMatch(/expired/i);
  });
});

describe('AUTH-03 — terminal and transient failures', () => {
  it('reports a terminal 401 and never attempts recovery', async () => {
    const recovery = jest.fn();
    setSessionRecoveryHandler(recovery);
    const lost = jest.fn();
    setSessionLostHandler(lost);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_REVOKED' }));

    await expect(apiFetch('/api/x', { token: 't' })).rejects.toBeInstanceOf(ApiError);
    expect(recovery).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('a 429 carries retryAfter and is NOT session loss', async () => {
    const lost = jest.fn();
    setSessionLostHandler(lost);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { code: 'SESSION_RENEW_RATE_LIMITED' }, { 'retry-after': '60' }),
    );

    await expect(
      apiFetch('/api/auth/renew', { token: 't', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'SESSION_RENEW_RATE_LIMITED', retryAfter: 60 });
    expect(lost).not.toHaveBeenCalled();
  });

  it('without any handler a 401 still reports session loss (unchanged default)', async () => {
    const lost = jest.fn();
    setSessionLostHandler(lost);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_REVOKED' }));
    await expect(apiFetch('/api/x', { token: 't' })).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('AUTH-03 — proactive renewal before a request', () => {
  it('asks the provider first and uses the token it returns', async () => {
    const renewal = jest.fn(async () => 'fresh-token');
    setSessionRenewalHandler(renewal);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/api/x', { token: 'old-token' });

    expect(renewal).toHaveBeenCalledWith('old-token');
    expect(authHeaderOf(0)).toBe('Bearer fresh-token');
  });

  it('uses the original token when the provider declines (returns null)', async () => {
    setSessionRenewalHandler(async () => null);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/api/x', { token: 'unchanged' });

    expect(authHeaderOf(0)).toBe('Bearer unchanged');
  });

  it('does not renew a request that carries no token', async () => {
    const renewal = jest.fn(async () => 'fresh');
    setSessionRenewalHandler(renewal);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/api/public');

    expect(renewal).not.toHaveBeenCalled();
  });

  it('does not proactively renew a temporary session (the N-4 opt-out)', async () => {
    const renewal = jest.fn(async () => 'fresh');
    setSessionRenewalHandler(renewal);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/api/private', { token: 'temp', temporarySession: true });

    expect(renewal).not.toHaveBeenCalled();
  });
});

describe('AUTH-03 — the renewal request never re-enters the renewal hooks', () => {
  // THE COMPOSITION THAT WAS MISSING. Every other case here drives `apiFetch` with
  // the hooks registered by hand, and the provider suite mocks `lib/api` — so neither
  // one sends `api.renew` back through the transport, which is the only place the
  // cycle can form. `api.renew` is the call `performRenewal` makes while it holds the
  // single-flight promise, so if the proactive hook runs for it, the promise resolves
  // to itself and nothing ever settles.

  it('does not invoke the proactive renewal hook for `api.renew`', async () => {
    const renewal = jest.fn(async () => 'fresh-token');
    setSessionRenewalHandler(renewal);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'rotated' }));

    await expect(renew('app-token', { idToken: 'firebase-id-token' })).resolves.toEqual({
      token: 'rotated',
    });

    expect(renewal).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOf(0)).toBe('Bearer app-token');
  });

  it('still completes when the renewal hook would never settle (the deadlock)', async () => {
    // Before the fix this case hangs: `api.renew` would await the hook, the hook would
    // return the in-flight `performRenewal` promise, and that promise is awaiting THIS
    // request. The assertion below is therefore the regression guard — it can only
    // pass if the renewal request bypasses the hook entirely.
    setSessionRenewalHandler(() => new Promise<string | null>(() => {}));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'rotated' }));

    await expect(renew('app-token', { idToken: 'firebase-id-token' })).resolves.toEqual({
      token: 'rotated',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not report a refused renewal as session loss', async () => {
    // `performRenewal` owns the terminal/transient decision for this response; the
    // generic report would clear the session the transient branch exists to keep.
    const lost = jest.fn();
    setSessionLostHandler(lost);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_REVOKED' }));

    await expect(renew('app-token', { idToken: 'firebase-id-token' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(lost).not.toHaveBeenCalled();
  });
});
