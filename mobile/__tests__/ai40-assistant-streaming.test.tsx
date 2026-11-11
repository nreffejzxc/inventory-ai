/**
 * AI-40 — the answer appears while it is being written, and nothing else changes.
 *
 * WHAT THE MEMBER GETS. Before this, a turn on the free tier held a spinner for 6–20 s and then
 * painted the whole answer at once. The model was already writing; only the screen was waiting.
 * These cases pin the three behaviours that make that safe:
 *
 *   1. TEXT ARRIVES PROGRESSIVELY and is then REPLACED by the stored message, because the server
 *      may rewrite what it streamed (status constants) or trim a cut-off unit. A screen that kept
 *      its own streamed copy beside the stored one would disagree with a reloaded thread.
 *   2. A STREAM THAT NEVER STARTED falls back to the ordinary route, so an older server, a proxy
 *      that cannot stream, or a connection that failed before the first byte still answers — but
 *      a timeout does not, because the server may still be running that turn and a retry would
 *      start a second billable turn.
 *   3. A STREAM THAT BROKE AFTER SHOWING TEXT does NOT retry: the text was read, and a second
 *      attempt would print the answer twice. The question stays on screen beside the part that
 *      arrived, and the failure is named.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import AiChat, { sendErrorMessage, streamFallbackAllowed } from '../components/AiChat';
import { aiApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ApiError, REQUEST_CANCELLED } from '../lib/client';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: (err: { status?: number } | null) => err?.status === 401,
}));

jest.mock('../lib/api', () => ({
  aiApi: { chat: jest.fn(), chatStream: jest.fn(), messages: jest.fn() },
}));

const chat = aiApi.chat as jest.Mock;
const chatStream = aiApi.chatStream as jest.Mock;
const messages = aiApi.messages as jest.Mock;
const mockedUseSession = useSession as jest.Mock;
const signOut = jest.fn();

const PLACEHOLDER = 'Ask about your stock…';

/** The payload both transports return for a successful turn. */
const TURN = {
  conversation: { id: 'conv-1', title: 'How much stock?', createdAt: '2026-10-23T09:00:00.000Z', updatedAt: '2026-10-23T09:00:05.000Z' },
  userMessage: {
    id: 'msg-user',
    conversationId: 'conv-1',
    role: 'USER',
    content: 'How much stock do we hold in total?',
    createdAt: '2026-10-23T09:00:00.000Z',
  },
  assistantMessage: {
    id: 'msg-answer',
    conversationId: 'conv-1',
    role: 'ASSISTANT',
    content: 'You hold 112 units in total.',
    toolsUsed: ['getInventorySummary'],
    createdAt: '2026-10-23T09:00:05.000Z',
  },
};

/** A promise the test resolves by hand, so a turn can be observed mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const mount = async () => {
  const view = await withTheme(<AiChat />);
  await waitFor(() => expect(view.getByText('Ask about your inventory')).toBeTruthy());
  return view;
};

/**
 * Type a question and press Send without awaiting the turn it starts.
 *
 * The typing IS awaited (RNTL 14 settles the state update in the promise) and the press is not:
 * a turn that is meant to stay in flight settles only when the test releases it, so awaiting
 * the press would deadlock until jest's own timeout.
 */
const ask = async (
  view: Awaited<ReturnType<typeof withTheme>>,
  text = 'How much stock do we hold in total?',
) => {
  await fireEvent.changeText(view.getByPlaceholderText(PLACEHOLDER), text);
  void fireEvent.press(view.getByRole('button', { name: 'Send' }));
};

beforeEach(() => {
  jest.clearAllMocks();
  messages.mockResolvedValue({ items: [], total: 0 });
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test Member' },
    token: 'token-1',
    signOut,
  });
  chatStream.mockResolvedValue(TURN);
  chat.mockResolvedValue(TURN);
});

describe('AI-40 — the assistant streams its answer', () => {
  it('shows text as it arrives, then replaces it with the stored message', async () => {
    const gate = deferred<typeof TURN>();
    chatStream.mockImplementation(async (_token: string, _body: unknown, options: { onDelta?: (t: string) => void }) => {
      options.onDelta?.('You hold 112');
      return gate.promise;
    });

    const view = await mount();
    await ask(view);

    // The partial answer is on screen BEFORE the turn completes — that is the whole feature.
    await waitFor(() => expect(view.getByText('You hold 112')).toBeTruthy());
    expect(view.queryByText('Thinking…')).toBeNull();

    await act(async () => {
      gate.resolve(TURN);
    });

    // The server's copy wins: the streamed text is gone, not kept beside it.
    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(view.queryByText('You hold 112')).toBeNull();
    expect(view.getByText('Read: Inventory summary')).toBeTruthy();
    expect(chat).not.toHaveBeenCalled();
  });

  it('clears a replaced draft before the stored answer arrives (AI-74)', async () => {
    const allowReset = deferred<void>();
    const allowReplacement = deferred<void>();
    const gate = deferred<typeof TURN>();
    chatStream.mockImplementation(
      async (
        _token: string,
        _body: unknown,
        options: { onDelta?: (t: string) => void; onReset?: () => void },
      ) => {
        options.onDelta?.('Draft: OUT_OF_STOCK');
        await allowReset.promise;
        options.onReset?.();
        await allowReplacement.promise;
        options.onDelta?.('Draft: Out of stock');
        return gate.promise;
      },
    );

    const view = await mount();
    await ask(view);

    // The draft is on screen first — that is what the reset has to clear.
    await waitFor(() => expect(view.getByText('Draft: OUT_OF_STOCK')).toBeTruthy());
    await act(async () => {
      allowReset.resolve();
    });

    // The replaced copy is gone before the stored answer arrives; the screen says the
    // answer is being corrected, not that the original analysis has restarted.
    await waitFor(() => expect(view.queryByText('Draft: OUT_OF_STOCK')).toBeNull());
    expect(view.getByText(/Correcting the answer/)).toBeTruthy();
    expect(view.queryByText(/Analyzing your inventory/)).toBeNull();
    await act(async () => {
      allowReplacement.resolve();
    });
    await waitFor(() => expect(view.getByText('Draft: Out of stock')).toBeTruthy());
    expect(view.queryByText(/Correcting the answer/)).toBeNull();

    await act(async () => {
      gate.resolve(TURN);
    });
    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
  });

  it('falls back to the ordinary request when the stream never started', async () => {
    chatStream.mockRejectedValue(new ApiError(404, null, 'Not found'));

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('does not start a second turn when the stream budget expires', async () => {
    // The first turn may still be running in its tool. A JSON retry would bill the same
    // question twice, so the timeout is shown immediately and no second request is made.
    chatStream.mockRejectedValue(new ApiError(0, 'NETWORK_TIMEOUT', 'x'));

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(/took too long/)).toBeTruthy());
    expect(chat).not.toHaveBeenCalled();
  });

  it('does NOT retry after text was shown, and keeps what the member has read', async () => {
    chatStream.mockImplementation(async (_token: string, _body: unknown, options: { onDelta?: (t: string) => void }) => {
      options.onDelta?.('You hold 112');
      throw new ApiError(0, 'NETWORK_ERROR', 'The connection dropped.');
    });

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText('You hold 112')).toBeTruthy());
    await waitFor(() =>
      expect(view.getByText('Cannot reach the server. Check your connection and try again.')).toBeTruthy(),
    );
    expect(chat).not.toHaveBeenCalled();
    // The question stays: it was asked and partly answered, so removing the bubble would hide
    // what the member is looking at.
    expect(view.getByText('How much stock do we hold in total?')).toBeTruthy();
  });

  it('keeps a quota refusal as a quota refusal — it is not a stream failure', async () => {
    chatStream.mockRejectedValue(new ApiError(429, 'AI_QUOTA_EXCEEDED', 'The AI assistant has reached its usage limit.'));

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(/used today's request allowance/)).toBeTruthy());
    expect(chat).not.toHaveBeenCalled();
  });

  it('signs out on an ended session instead of retrying it', async () => {
    chatStream.mockRejectedValue(new ApiError(401, 'SESSION_INVALIDATED', 'Session ended.'));

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports a stop as a stop, not as a failure', async () => {
    chatStream.mockImplementation(
      (_token: string, _body: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new ApiError(0, REQUEST_CANCELLED, 'The request was cancelled.')),
          );
        }),
    );

    const view = await mount();
    await ask(view);
    await waitFor(() => expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Stop' }));
    });

    await waitFor(() => expect(view.getByText(/You stopped waiting/)).toBeTruthy());
    expect(view.queryByText('Cannot reach the server. Check your connection and try again.')).toBeNull();
  });
});

describe('AI-40 — which failures may be retried over the ordinary route', () => {
  it('allows a transport failure but never a timeout or a refusal that names the turn', () => {
    expect(streamFallbackAllowed(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(true);
    // A timeout means the server may still be working; a retry would be a second full turn.
    expect(streamFallbackAllowed(new ApiError(0, 'NETWORK_TIMEOUT', 'x'))).toBe(false);
    expect(streamFallbackAllowed(new ApiError(404, null, 'x'))).toBe(true);
    expect(streamFallbackAllowed(new ApiError(405, null, 'x'))).toBe(true);
  });

  it('refuses every failure that is an answer rather than a transport problem', () => {
    expect(streamFallbackAllowed(new ApiError(429, 'AI_QUOTA_EXCEEDED', 'x'))).toBe(false);
    expect(streamFallbackAllowed(new ApiError(429, 'AI_RATE_LIMITED', 'x'))).toBe(false);
    expect(streamFallbackAllowed(new ApiError(401, 'SESSION_INVALIDATED', 'x'))).toBe(false);
    expect(streamFallbackAllowed(new ApiError(503, 'AI_NOT_CONFIGURED', 'x'))).toBe(false);
    expect(streamFallbackAllowed(new ApiError(400, 'VALIDATION_ERROR', 'x'))).toBe(false);
  });

  it('leaves the existing sentences untouched', () => {
    // The mapping is shared by both transports; streaming must not invent a new vocabulary.
    expect(sendErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(/Cannot reach the server/);
    expect(sendErrorMessage(new ApiError(0, 'AI_TIMEOUT', 'x'))).toMatch(/took too long/);
  });
});
