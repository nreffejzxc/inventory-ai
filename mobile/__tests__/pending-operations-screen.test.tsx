import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { useSession } from '../lib/auth';
import { confirm } from '../lib/confirm';
import {
  checkPendingOperation,
  listPendingOperations,
  retryPendingOperation,
} from '../lib/idempotency';
import { ThemeProvider } from '../lib/theme-context';

import PendingOperationsScreen from '../app/(app)/pending-operations';

/**
 * Pending Operations is the member-facing end of the durable receipt system.
 * The service tests prove what the server can recover; these cases mount the
 * real screen so its empty, completed, attention, confirmation and failure
 * states cannot drift into different wording or an accidental retry.
 */

jest.mock('../lib/auth', () => ({ useSession: jest.fn() }));

jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  return {
    router: { push: jest.fn() },
    useFocusEffect: (callback: () => void) => {
      React.useEffect(() => {
        callback();
      }, [callback]);
    },
  };
});

jest.mock('../lib/idempotency', () => ({
  listPendingOperations: jest.fn(),
  checkPendingOperation: jest.fn(),
  retryPendingOperation: jest.fn(),
}));

jest.mock('../lib/confirm', () => ({ confirm: jest.fn() }));

const mockedUseSession = useSession as jest.Mock;
const mockedList = listPendingOperations as jest.Mock;
const mockedCheck = checkPendingOperation as jest.Mock;
const mockedRetry = retryPendingOperation as jest.Mock;
const mockedConfirm = confirm as jest.Mock;

const ITEM = {
  id: 'stock-in:abc123',
  kind: 'stock-in' as const,
  label: 'Stock in · Compact Kettle',
  target: 'product-1',
  createdAt: Date.parse('2026-11-20T08:00:00.000Z'),
  expiresAt: Date.parse('2026-11-21T08:00:00.000Z'),
  requestAvailable: true,
};

const mount = async () =>
  await render(
    <ThemeProvider>
      <PendingOperationsScreen />
    </ThemeProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Dana Owner', role: 'OWNER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  mockedList.mockResolvedValue([]);
  mockedCheck.mockResolvedValue({ state: 'UNKNOWN', reference: null, checkedAt: new Date().toISOString() });
  mockedRetry.mockResolvedValue({});
  mockedConfirm.mockResolvedValue(false);
});

describe('Pending Operations screen', () => {
  it('★ shows an empty state when this device has no unfinished operation', async () => {
    const screen = await mount();

    expect(await screen.findByText('Nothing is waiting')).toBeTruthy();
    expect(screen.getByText(/Unfinished stock changes and new records appear here/)).toBeTruthy();
    expect(mockedList).toHaveBeenCalledWith('u1');
  });

  it('★ removes a completed operation and confirms it was already applied', async () => {
    mockedList.mockResolvedValueOnce([ITEM]).mockResolvedValueOnce([]);
    mockedCheck.mockResolvedValue({
      state: 'COMPLETED',
      reference: null,
      checkedAt: '2026-11-20T08:01:00.000Z',
    });
    const screen = await mount();

    fireEvent.press(await screen.findByText('Check status'));

    expect(
      await screen.findByText(
        'That operation was already completed. Its record has been removed from this device.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Nothing is waiting')).toBeTruthy();
    expect(mockedCheck).toHaveBeenCalledWith('u1', ITEM.id, 'token-1');
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('★ shows the support reference for an operation that needs a person', async () => {
    mockedList.mockResolvedValue([ITEM]);
    mockedCheck.mockResolvedValue({
      state: 'REQUIRES_ATTENTION',
      reference: 'REF-7',
      checkedAt: '2026-11-20T08:02:00.000Z',
    });
    const screen = await mount();

    fireEvent.press(await screen.findByText('Check status'));

    expect(await screen.findByText(/needs a person to verify it/)).toBeTruthy();
    expect(screen.getByText(/Quote reference REF-7/)).toBeTruthy();
    expect(screen.getByText(/Do not repeat it/)).toBeTruthy();
    expect(mockedRetry).not.toHaveBeenCalled();
  });

  it('★ asks before retrying and sends nothing when the member cancels', async () => {
    mockedList.mockResolvedValue([ITEM]);
    mockedConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockedList.mockResolvedValueOnce([ITEM]).mockResolvedValueOnce([]);
    const screen = await mount();

    fireEvent.press(await screen.findByText('Retry'));
    await waitFor(() => expect(mockedConfirm).toHaveBeenCalledTimes(1));
    expect(mockedConfirm).toHaveBeenCalledWith(
      'Retry this operation?',
      expect.stringContaining('same request'),
      { confirmText: 'Retry' },
    );
    expect(mockedRetry).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Retry'));
    await waitFor(() => expect(mockedRetry).toHaveBeenCalledWith('u1', ITEM.id, 'token-1'));
    expect(
      await screen.findByText(
        'The operation finished and its record has been removed from this device.',
      ),
    ).toBeTruthy();
  });

  it('★ surfaces a retry failure without removing the operation', async () => {
    mockedList.mockResolvedValue([ITEM]);
    mockedConfirm.mockResolvedValue(true);
    mockedRetry.mockRejectedValue(new Error('The server could not be reached.'));
    const screen = await mount();

    fireEvent.press(await screen.findByText('Retry'));

    expect(await screen.findByText('The server could not be reached.')).toBeTruthy();
    expect(screen.getByText(ITEM.label)).toBeTruthy();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('★ offers a real retry when the list itself cannot be read', async () => {
    mockedList
      .mockRejectedValueOnce(new Error('Could not reach the server.'))
      .mockResolvedValueOnce([]);
    const screen = await mount();

    expect(await screen.findByText('Could not read unfinished operations')).toBeTruthy();
    expect(screen.getAllByText('Could not reach the server.').length).toBeGreaterThan(0);

    fireEvent.press(screen.getByText('Try again'));

    expect(await screen.findByText('Nothing is waiting')).toBeTruthy();
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});