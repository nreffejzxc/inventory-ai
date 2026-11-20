import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Clipboard } from 'react-native';
import type { ReactNode } from 'react';

import Banner from '../components/Banner';
import { ErrorState, errorRequestId } from '../components/ListState';
import ListScreen from '../components/ListScreen';
import { ApiError, apiFetch, isSafeRequestId } from '../lib/client';
import { alertError } from '../lib/confirm';
import { withRequestReference } from '../lib/errors';
import { ThemeProvider } from '../lib/theme-context';

/**
 * FW-07 — the server's request reference is useful only if the client keeps it
 * safely and shows it where a member can copy it. These tests pin both halves:
 * the transport's header handling and the shared error presentation.
 *
 * No token, response body, email or tenant value is passed to the reference UI.
 * The copied value is exactly the server id, not a sentence or a synthesized id.
 */

const fetchMock = jest.fn();

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    json: async () => body,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

function withTheme(node: ReactNode) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FW-07 — ApiError request reference', () => {
  it('★ carries a safe X-Request-ID from a failed response', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        400,
        { code: 'VALIDATION_ERROR', error: 'Check the form' },
        { 'x-request-id': 'abc-123' },
      ),
    );

    await expect(apiFetch('/api/products')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      requestId: 'abc-123',
    });
  });

  it('keeps an absent or unsafe header as null, without inventing an id', async () => {
    const cases: Record<string, string>[] = [
      {},
      { 'x-request-id': '' },
      { 'x-request-id': '   ' },
      { 'x-request-id': 'abc 123' },
      { 'x-request-id': 'abc\r\nInjected: yes' },
      { 'x-request-id': 'abc/123' },
      { 'x-request-id': 'a'.repeat(129) },
    ];

    for (const headers of cases) {
      fetchMock.mockResolvedValueOnce(
        response(400, { code: 'VALIDATION_ERROR', error: 'Bad request' }, headers),
      );
      await expect(apiFetch('/api/products')).rejects.toMatchObject({
        status: 400,
        requestId: null,
      });
    }
  });

  it('accepts the server rule at the boundary and rejects one character beyond it', () => {
    expect(isSafeRequestId('a'.repeat(128))).toBe(true);
    expect(isSafeRequestId('a'.repeat(129))).toBe(false);
    expect(isSafeRequestId('abc_123:def.ghi-jkl')).toBe(true);
    expect(isSafeRequestId('abc/123')).toBe(false);
  });

  it('leaves a network failure without a reference', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));

    await expect(apiFetch('/api/products')).rejects.toMatchObject({
      status: 0,
      requestId: null,
    });
  });

  it('still builds the normal ApiError when a response stub has no headers', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 503,
      json: async () => ({ code: 'DB_UNAVAILABLE', error: 'Unavailable' }),
    });

    await expect(apiFetch('/api/products')).rejects.toMatchObject({
      status: 503,
      code: 'DB_UNAVAILABLE',
      requestId: null,
    });
  });

  it('exposes only a safe value through errorRequestId', () => {
    const error = new ApiError(500, 'SERVER_ERROR', 'Failed');
    error.requestId = 'req-123';
    expect(errorRequestId(error)).toBe('req-123');
    expect(errorRequestId({ requestId: 'bad id' })).toBeNull();
    expect(errorRequestId(new Error('plain error'))).toBeNull();
    expect(errorRequestId(null)).toBeNull();
  });
});

describe('FW-07 — shared error state', () => {
  it('★ renders a copyable reference only when the server supplied one', async () => {
    const spy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    const { getByTestId, getByText, queryByTestId } = await withTheme(
      <ErrorState
        title="Couldn't load the dashboard"
        message="Unable to load."
        requestId="abc-123"
      />,
    );

    expect(getByTestId('request-reference')).toBeTruthy();
    expect(getByText(/Reference: abc-123/)).toBeTruthy();

    fireEvent.press(getByTestId('request-reference-copy'));

    expect(spy).toHaveBeenCalledWith('abc-123');
    await waitFor(() => expect(getByText('Copied')).toBeTruthy());

    expect(queryByTestId('request-reference')).toBeTruthy();
  });

  it('renders no reference when the error carried none', async () => {
    const { queryByTestId } = await withTheme(
      <ErrorState title="Couldn't load" message="Unable to load." requestId={null} />,
    );

    expect(queryByTestId('request-reference')).toBeNull();
  });

  it('does not render an unsafe value as a reference', async () => {
    const { queryByTestId } = await withTheme(
      <ErrorState title="Couldn't load" message="Unable to load." requestId="bad value" />,
    );

    expect(queryByTestId('request-reference')).toBeNull();
  });

  it('★ a list load error reaches the shared state without a per-screen change', async () => {
    const error = new ApiError(500, 'SERVER_ERROR', 'Unable to load.');
    error.requestId = 'list-abc-123';

    const { getByTestId, getByText } = await withTheme(
      <ListScreen
        items={[]}
        renderItem={() => null}
        error={error}
        errorTitle="Couldn't load the list"
        onRetry={() => undefined}
      />,
    );

    expect(getByTestId('request-reference')).toBeTruthy();
    expect(getByText(/Reference: list-abc-123/)).toBeTruthy();
  });
});

describe('FW-07 — form Banners and Alerts', () => {
  it('★ a form Banner shows and copies the same safe reference', async () => {
    const spy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    const { getByTestId, getByText } = await withTheme(
      <Banner type="error" text="Unable to save the product." requestId="form-ref-1" />,
    );

    expect(getByTestId('request-reference')).toBeTruthy();
    expect(getByText(/Reference: form-ref-1/)).toBeTruthy();

    fireEvent.press(getByTestId('request-reference-copy'));
    expect(spy).toHaveBeenCalledWith('form-ref-1');
  });

  it('adds no reference line for an absent or unsafe id', () => {
    expect(withRequestReference('Unable to save.', null)).toBe('Unable to save.');
    expect(withRequestReference('Unable to save.', 'bad id')).toBe('Unable to save.');
    expect(withRequestReference('Unable to save.', 'ref-1')).toBe(
      'Unable to save.\n\nReference: ref-1',
    );
  });

  it('★ an Alert shows the reference and offers a copy action', async () => {
    const copy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const error = new ApiError(500, 'SERVER_ERROR', 'Unable to save.');
    error.requestId = 'alert-ref-1';

    const result = alertError('Could not save', error);

    expect(alertSpy).toHaveBeenCalledWith(
      'Could not save',
      'Unable to save.\n\nReference: alert-ref-1',
      expect.any(Array),
      { cancelable: false },
    );
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    expect(buttons.map((b) => b.text)).toEqual(['Copy reference', 'OK']);

    buttons[0].onPress?.();
    expect(copy).toHaveBeenCalledWith('alert-ref-1');
    await expect(result).resolves.toBe(true);
  });

  it('does not add a copy button when the failure carried no reference', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const result = alertError('Could not save', new Error('Network down'), 'Try again.');

    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    expect(buttons.map((b) => b.text)).toEqual(['OK']);
    buttons[0].onPress?.();
    await expect(result).resolves.toBe(true);
  });
});
