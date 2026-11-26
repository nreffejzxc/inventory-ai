import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import DashboardScreen from '../app/(app)/dashboard';
import WhatsNewScreen from '../app/(app)/whats-new';
import WhatsNewCard from '../components/WhatsNewCard';
import { useReleaseNotes } from '../hooks/useReleaseNotes';
import { dashboardApi, productsApi, purchaseOrdersApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { LATEST_RELEASE_NOTE, RELEASE_NOTES, formatReleaseDate } from '../lib/releaseNotes';
import {
  MAX_REMEMBERED_RELEASE_NOTES,
  markReleaseNoteSeen,
  readSeenReleaseNoteIds,
} from '../lib/releaseNotesSeen';
import { ThemeProvider } from '../lib/theme-context';

/**
 * Release notes (2026-10-25) — the app telling its own users what changed.
 *
 * WHAT THESE CASES ARE FOR. The feature has one ordering invariant (newest first), one durable
 * marker (the ids this device has acknowledged), and one rule the whole thing hangs on: a note
 * announces itself ONCE, and a bundle that carries no new note announces nothing. A broken marker
 * shows the same card on every launch, which is the failure mode that would actually annoy a user
 * — so the marker, not just the rendering, is what is asserted here.
 *
 * The marker was a single id until 2026-10-25, when the first live publish of a note was rolled
 * back by hand and the card came back. The cases marked *rollback* below are that defect: they
 * fail against the old `seenId !== latest.id` rule and pass only because the marker is a set.
 *
 * The storage read failing is also pinned. It must show the card, not crash and not silence it:
 * missing a message about a change is worse than showing one twice.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('expo-router', () => {
  // Stable identities, exactly as the real hooks behave: a fresh object per call would
  // re-subscribe `useFocusEffect` on every render.
  const navigation = { addListener: () => () => {} };
  const params = {};
  return {
    Stack: { Screen: () => null },
    router: {
      push: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
      canGoBack: jest.fn(() => true),
    },
    useNavigation: () => navigation,
    useLocalSearchParams: () => params,
    useFocusEffect: () => {},
  };
});

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: () => false,
}));

const mockFocusRefetch: { current: (() => void) | null } = { current: null };
jest.mock('../hooks/useRefetchOnFocus', () => ({
  __esModule: true,
  default: (callback: () => void) => {
    mockFocusRefetch.current = callback;
  },
}));

jest.mock('../lib/api', () => ({
  dashboardApi: { summary: jest.fn(async () => ({})) },
  productsApi: { reorder: jest.fn(async () => ({ items: [] })) },
  purchaseOrdersApi: { list: jest.fn(async () => ({ items: [], total: 0 })) },
}));

const secureStore = jest.requireMock('expo-secure-store') as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
};
const routerMock = jest.requireMock('expo-router').router as {
  push: jest.Mock;
  replace: jest.Mock;
  back: jest.Mock;
  canGoBack: jest.Mock;
};
const mockedUseSession = useSession as jest.Mock;
const summary = dashboardApi.summary as jest.Mock;
const reorder = productsApi.reorder as jest.Mock;
const poList = purchaseOrdersApi.list as jest.Mock;

const LATEST = LATEST_RELEASE_NOTE;
if (!LATEST) throw new Error('The app ships no release note; the dashboard card would never appear.');

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;
const mount = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

/** Every note id written to storage, in call order — the marker's value is a JSON array. */
const writtenIds = (): string[] =>
  secureStore.setItemAsync.mock.calls.flatMap(([, value]: [string, string]) => {
    try {
      const parsed: unknown = JSON.parse(String(value));
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  });

beforeEach(() => {
  jest.clearAllMocks();
  secureStore.getItemAsync.mockResolvedValue(null);
  secureStore.setItemAsync.mockResolvedValue(undefined);
  routerMock.canGoBack.mockReturnValue(true);
  summary.mockResolvedValue({});
  reorder.mockResolvedValue({ items: [] });
  poList.mockResolvedValue({ items: [], total: 0 });
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Mia Manager', role: 'MANAGER' },
    token: 'token',
    signOut: jest.fn(),
    refresh: jest.fn(),
  });
});

// ---------------------------------------------------------------------------
// The content itself
// ---------------------------------------------------------------------------

describe('the note list', () => {
  it('gives every note a unique, non-empty id', () => {
    // The id is the only thing that decides whether the card appears. A duplicate would
    // silently suppress the newer note, which is the one bug here nobody would notice.
    const ids = RELEASE_NOTES.map((note) => note.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.trim()).not.toBe('');
  });

  it('is ordered newest first', () => {
    const dates = RELEASE_NOTES.map((note) => note.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('announces the first note and only the first note', () => {
    expect(LATEST_RELEASE_NOTE).toBe(RELEASE_NOTES[0]);
  });

  it('writes every note for a person, not as a changelog entry', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
    for (const note of RELEASE_NOTES) {
      expect(note.title.trim().length).toBeGreaterThan(0);
      expect(note.summary.trim().length).toBeGreaterThan(0);
      // No hype, and no internal jargon a business owner would have to decode.
      expect(note.title).not.toMatch(/!/);
      expect(note.title).not.toMatch(/phase/i);
    }
  });
});

describe('formatReleaseDate', () => {
  it('renders the day as written rather than through a Date', () => {
    // `new Date('2026-01-01')` is UTC midnight, which renders as Dec 31 in any negative UTC
    // offset. A note's date is a calendar date, so this must not be able to shift.
    expect(formatReleaseDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatReleaseDate('2026-10-25')).toBe('Oct 25, 2026');
    expect(formatReleaseDate('2026-12-31')).toBe('Dec 31, 2026');
  });

  it('renders nothing for a value that is not a calendar date', () => {
    expect(formatReleaseDate('')).toBe('');
    expect(formatReleaseDate('2026-13-01')).toBe('');
    expect(formatReleaseDate('2026-00-10')).toBe('');
    expect(formatReleaseDate('yesterday')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe('the dashboard card', () => {
  it('names the note and offers both actions', async () => {
    const onOpen = jest.fn();
    const onDismiss = jest.fn();
    const { getByText } = await mount(<WhatsNewCard note={LATEST} onOpen={onOpen} onDismiss={onDismiss} />);

    expect(getByText(LATEST.title)).toBeTruthy();
    expect(getByText(LATEST.summary)).toBeTruthy();

    await fireEvent.press(getByText("See what's new"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    await fireEvent.press(getByText('Got it'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The marker file
// ---------------------------------------------------------------------------

describe('the stored marker', () => {
  const LEGACY_KEY = 'inventoryai.releaseNotes.seenId';

  it('reads a list back in the order it was written', async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify(['a', 'b']));
    await expect(readSeenReleaseNoteIds()).resolves.toEqual(['a', 'b']);
  });

  it('reads the single id the old build wrote, so an upgrade re-announces nothing', async () => {
    // A device that dismissed a note before 2026-10-25 holds one bare id under the old key.
    secureStore.getItemAsync.mockImplementation(async (key: string) =>
      key === LEGACY_KEY ? '2026-10-20-a-note' : null,
    );
    await expect(readSeenReleaseNoteIds()).resolves.toEqual(['2026-10-20-a-note']);
  });

  it('merges on write instead of replacing, and stores an id once', async () => {
    await markReleaseNoteSeen('c', ['a', 'b', 'a']);
    expect(JSON.parse(secureStore.setItemAsync.mock.calls[0][1])).toEqual(['a', 'b', 'c']);
  });

  it('keeps the newest ids when the list is full', async () => {
    const many = Array.from({ length: MAX_REMEMBERED_RELEASE_NOTES + 5 }, (_, i) => `id-${i}`);
    await markReleaseNoteSeen('newest', many);
    const written = JSON.parse(secureStore.setItemAsync.mock.calls[0][1]) as string[];
    expect(written).toHaveLength(MAX_REMEMBERED_RELEASE_NOTES);
    expect(written[written.length - 1]).toBe('newest');
    expect(written).not.toContain('id-0');
  });

  it('reports nothing seen when storage cannot be read, so the card shows rather than hides', async () => {
    secureStore.getItemAsync.mockRejectedValue(new Error('unavailable'));
    await expect(readSeenReleaseNoteIds()).resolves.toEqual([]);
  });

  it('does not throw when the write fails', async () => {
    secureStore.setItemAsync.mockRejectedValue(new Error('disk full'));
    await expect(markReleaseNoteSeen('a', [])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

describe('useReleaseNotes', () => {
  it('announces the newest note when this device has acknowledged nothing', async () => {
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(true);
    expect(view.result.current.latest).toBe(LATEST);
  });

  it('stays quiet when the newest note is already acknowledged', async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify([LATEST.id]));
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(false);
  });

  it('*rollback*: stays quiet when a newer note was acknowledged before this older bundle', async () => {
    // The defect a single stored id had: this list is what a device holds after acknowledging a
    // note from a newer bundle and then being rolled back (or after that note is deleted from
    // RELEASE_NOTES). Under `seenId !== latest.id` the older note announced itself again.
    secureStore.getItemAsync.mockResolvedValue(
      JSON.stringify(['2026-12-01-a-note-from-a-later-bundle', LATEST.id]),
    );
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(false);
  });

  it('*rollback*: an unacknowledged note still announces itself after one from a later bundle', async () => {
    // The other half of the same rule: a set suppresses only what is IN it. A device that never
    // saw this note must still be told about it, whatever else it has acknowledged.
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify(['2026-12-01-a-note-from-a-later-bundle']));
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(true);
  });

  it('keeps every earlier acknowledgement when a new one is made', async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify(['2026-09-01-older']));
    const view = await renderHook(() => useReleaseNotes(), { wrapper });
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await act(() => view.result.current.acknowledge());

    expect(writtenIds()).toEqual(['2026-09-01-older', LATEST.id]);
  });

  it('cannot replace the stored list before it has been read', async () => {
    // Writing during the read window would store this one id over every earlier dismissal.
    let release: (value: string | null) => void = () => {};
    secureStore.getItemAsync.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await act(async () => {
      view.result.current.acknowledge();
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();

    await act(async () => {
      release(JSON.stringify(['2026-09-01-older']));
    });
    await waitFor(() => expect(view.result.current.unseen).toBe(true));
  });

  it('re-announces only when a newer note than the acknowledged one arrives', async () => {
    // An older id in storage is what a fresh bundle looks like: the device saw last month's
    // note, and this month's must still show once.
    secureStore.getItemAsync.mockResolvedValue('2020-01-01-something-old');
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(true);
  });

  it('records the acknowledgement so the card does not return', async () => {
    const view = await renderHook(() => useReleaseNotes(), { wrapper });
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await act(() => view.result.current.acknowledge());

    expect(view.result.current.unseen).toBe(false);
    expect(writtenIds()).toContain(LATEST.id);
  });

  it('still shows the card when storage cannot be read', async () => {
    secureStore.getItemAsync.mockRejectedValue(new Error('secure storage unavailable'));
    const view = await renderHook(() => useReleaseNotes(), { wrapper });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.unseen).toBe(true);
  });

  it('does not wait on the write: a failed save leaves the card dismissed for this run', async () => {
    secureStore.setItemAsync.mockRejectedValue(new Error('disk full'));
    const view = await renderHook(() => useReleaseNotes(), { wrapper });
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await act(() => view.result.current.acknowledge());

    expect(view.result.current.unseen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe("the What's New screen", () => {
  it('lists every note in the bundle', async () => {
    const { getByText } = await mount(<WhatsNewScreen />);

    for (const note of RELEASE_NOTES) {
      expect(getByText(note.title)).toBeTruthy();
      expect(getByText(note.summary)).toBeTruthy();
    }
  });

  it('marks the newest note read and goes back', async () => {
    const { getByText } = await mount(<WhatsNewScreen />);
    await waitFor(() => expect(getByText('Mark as read')).toBeTruthy());

    await fireEvent.press(getByText('Mark as read'));

    expect(writtenIds()).toContain(LATEST.id);
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('says Done rather than Mark as read when there is nothing new', async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify([LATEST.id]));
    const { getByText, queryByText } = await mount(<WhatsNewScreen />);

    await waitFor(() => expect(getByText('Done')).toBeTruthy());
    expect(queryByText('Mark as read')).toBeNull();
  });

  it('replaces instead of going back when it was opened without history', async () => {
    // A deep link or a cold start onto this screen has nothing to go back to; pressing a button
    // that does nothing would strand the tap.
    routerMock.canGoBack.mockReturnValue(false);
    const { getByText } = await mount(<WhatsNewScreen />);
    await waitFor(() => expect(getByText('Mark as read')).toBeTruthy());

    await fireEvent.press(getByText('Mark as read'));

    expect(routerMock.back).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/dashboard');
  });
});

// ---------------------------------------------------------------------------
// The wiring that actually matters: the dashboard
// ---------------------------------------------------------------------------

describe('the dashboard', () => {
  it('shows the card for a note this device has not seen', async () => {
    const { findByText } = await mount(<DashboardScreen />);

    expect(await findByText(LATEST.title)).toBeTruthy();
    expect(await findByText("See what's new")).toBeTruthy();
  });

  it('opens the list and acknowledges in the same tap', async () => {
    const { findByText, queryByText } = await mount(<DashboardScreen />);

    await fireEvent.press(await findByText("See what's new"));

    expect(routerMock.push).toHaveBeenCalledWith('/whats-new');
    expect(writtenIds()).toContain(LATEST.id);
    // The card is gone as soon as the tap lands — it does not wait for a re-render from storage.
    await waitFor(() => expect(queryByText(LATEST.title)).toBeNull());
  });

  it('dismisses without navigating', async () => {
    const { findByText, queryByText } = await mount(<DashboardScreen />);

    await fireEvent.press(await findByText('Got it'));

    expect(routerMock.push).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByText(LATEST.title)).toBeNull());
  });

  it('shows nothing once the note has been acknowledged', async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify([LATEST.id]));
    const { queryByText } = await mount(<DashboardScreen />);

    await waitFor(() => expect(summary).toHaveBeenCalled());
    expect(queryByText(LATEST.title)).toBeNull();
  });

  it('keeps earlier data visible with an honest stale warning, and retries from it', async () => {
    const view = await mount(<DashboardScreen />);
    await waitFor(() => expect(view.getByText('Overview')).toBeTruthy());
    expect(view.queryByText('Showing earlier data — pull to retry.')).toBeNull();

    await waitFor(() => expect(mockFocusRefetch.current).toBeTruthy());
    summary.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await mockFocusRefetch.current?.();
    });

    expect(await view.findByText('Showing earlier data — tap to retry.')).toBeTruthy();
    // The figures may be old, but the change note is still reachable below the warning.
    expect(view.getByText(LATEST.title)).toBeTruthy();

    await fireEvent.press(view.getByText('Showing earlier data — tap to retry.'));
    await waitFor(() => expect(view.queryByText('Showing earlier data — tap to retry.')).toBeNull());
  });
});
