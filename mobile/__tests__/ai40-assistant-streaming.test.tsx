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
const QUESTION = 'How much stock do we hold in total?';
const QUOTA =
  "The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app works as usual.";
const RATE_LIMITED = "You're sending messages too quickly — wait a moment and try again.";
const OUTAGE = 'The AI service is temporarily unavailable. Please try again in a moment.';
const NOT_CONFIGURED =
  'The AI assistant is not enabled on this server yet. Ask an administrator to turn it on.';
const TIMEOUT = 'The assistant took too long to answer. Please try again.';

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
  text = QUESTION,
) => {
  await fireEvent.changeText(view.getByPlaceholderText(PLACEHOLDER), text);
  void fireEvent.press(view.getByRole('button', { name: 'Send' }));
};

/** A refused turn must put the question back in the composer so it can be retried. */
const expectQuestionRestored = async (view: Awaited<ReturnType<typeof withTheme>>) => {
  await waitFor(() =>
    expect(view.getByPlaceholderText(PLACEHOLDER).props.value).toBe(QUESTION),
  );
};

/**
 * Make the chat call the REAL streaming transport with a single SSE error frame.
 *
 * The route has already answered 200 and opened the stream when the provider refuses, so the
 * error arrives as an event rather than as a rejected HTTP response. Keeping this at the
 * transport layer means every error case exercises the same path a phone uses.
 */
function mockChatStreamError(status: number, code: string, message: string): void {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return {
          done: false,
          value: encoder.encode(
            `event: error\ndata: ${JSON.stringify({ status, code, message })}\n\n`,
          ),
        };
      },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }),
  };
  const actualChatStream = jest.requireActual('../lib/api').aiApi.chatStream as typeof aiApi.chatStream;
  chatStream.mockImplementation((...args: Parameters<typeof actualChatStream>) => {
    const [token, body, options] = args;
    return actualChatStream(token, body, {
      ...options,
      fetchImpl: async () => ({ ok: true, status: 200, body: stream, text: async () => '' }),
    });
  });
}

/**
 * Make the real transport receive the ordinary JSON error envelope before a stream opens.
 *
 * A pre-stream refusal is an HTTP response, not an SSE event; `chatStream` must map both shapes
 * to the same `ApiError` so the screen's copy and composer recovery stay identical.
 */
function mockChatStreamHttpError(status: number, code: string, message: string): void {
  const actualChatStream = jest.requireActual('../lib/api').aiApi.chatStream as typeof aiApi.chatStream;
  chatStream.mockImplementation((...args: Parameters<typeof actualChatStream>) => {
    const [token, body, options] = args;
    return actualChatStream(token, body, {
      ...options,
      fetchImpl: async () => ({
        ok: false,
        status,
        body: null,
        text: async () => JSON.stringify({ error: message, code }),
      }),
    });
  });
}

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

  it('renders the exact UTC sentence from a streamed AI_QUOTA_EXCEEDED error event', async () => {
    mockChatStreamError(
      429,
      'AI_QUOTA_EXCEEDED',
      'The AI assistant has reached its usage limit. Please try again later.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(QUOTA)).toBeTruthy());
    expect(view.queryByText(OUTAGE)).toBeNull();
    await expectQuestionRestored(view);
    expect(view.queryByText(QUESTION)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('reuses the restored question after the daily quota resets', async () => {
    mockChatStreamError(
      429,
      'AI_QUOTA_EXCEEDED',
      'The AI assistant has reached its usage limit. Please try again later.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(QUOTA)).toBeTruthy());
    await expectQuestionRestored(view);

    // Midnight UTC has passed; the allowance is available again. Pressing Send must reuse the
    // restored question, not require it to be retyped.
    chatStream.mockResolvedValue(TURN);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][1].message).toBe(QUESTION);
    expect(view.queryByText(QUOTA)).toBeNull();
    expect(view.getByPlaceholderText(PLACEHOLDER).props.value).toBe('');
    expect(chat).not.toHaveBeenCalled();
  });

  it('recovers a brand-new conversation whose first question was refused', async () => {
    mockChatStreamError(
      429,
      'AI_QUOTA_EXCEEDED',
      'The AI assistant has reached its usage limit. Please try again later.',
    );

    const view = await mount();
    expect(messages).not.toHaveBeenCalled();

    await ask(view);

    await waitFor(() => expect(view.getByText(QUOTA)).toBeTruthy());
    await expectQuestionRestored(view);
    expect(chatStream).toHaveBeenCalledTimes(1);
    // The first refusal created nothing, so the retry must still be sent without a conversation id.
    expect(chatStream.mock.calls[0][1]).toEqual({ conversationId: null, message: QUESTION });

    chatStream.mockResolvedValue(TURN);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][1]).toEqual({ conversationId: null, message: QUESTION });
    expect(view.queryByText(QUOTA)).toBeNull();
    expect(view.getByPlaceholderText(PLACEHOLDER).props.value).toBe('');
    // A brand-new chat loads no thread and sends no prior history.
    expect(messages).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('uses the conversation created by the retry on the next message', async () => {
    mockChatStreamError(
      429,
      'AI_QUOTA_EXCEEDED',
      'The AI assistant has reached its usage limit. Please try again later.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(QUOTA)).toBeTruthy());
    await expectQuestionRestored(view);

    chatStream.mockResolvedValue(TURN);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());

    const followUp = 'Which products are low?';
    await fireEvent.changeText(view.getByPlaceholderText(PLACEHOLDER), followUp);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(3));
    expect(chatStream.mock.calls[2][1]).toEqual({
      conversationId: 'conv-1',
      message: followUp,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it('renders the wait-a-moment sentence from a streamed AI_RATE_LIMITED error event', async () => {
    mockChatStreamError(
      429,
      'AI_RATE_LIMITED',
      'The assistant is receiving too many requests.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(RATE_LIMITED)).toBeTruthy());
    // A rate limit is not the spent daily allowance: neither the quota sentence nor its reset
    // time may leak into this banner, and the JSON fallback must not run either.
    expect(view.queryByText(QUOTA)).toBeNull();
    expect(view.queryByText(/used today's request allowance/i)).toBeNull();
    expect(view.queryByText(/midnight UTC/)).toBeNull();
    expect(view.queryByText(OUTAGE)).toBeNull();
    await expectQuestionRestored(view);
    expect(view.queryByText(QUESTION)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('reuses the restored question after the rate limit clears', async () => {
    mockChatStreamHttpError(
      429,
      'AI_RATE_LIMITED',
      'The assistant is receiving too many requests.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(RATE_LIMITED)).toBeTruthy());
    await expectQuestionRestored(view);

    // The limit clears and the member presses Send again without retyping: the restored
    // composer text must be sent, and the successful answer must replace the refusal banner.
    chatStream.mockResolvedValue(TURN);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][1].message).toBe(QUESTION);
    expect(view.queryByText(RATE_LIMITED)).toBeNull();
    expect(view.getByPlaceholderText(PLACEHOLDER).props.value).toBe('');
    expect(chat).not.toHaveBeenCalled();
  });

  it('restores the question again when the retry fails with a different error', async () => {
    mockChatStreamHttpError(
      429,
      'AI_RATE_LIMITED',
      'The assistant is receiving too many requests.',
    );

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(RATE_LIMITED)).toBeTruthy());
    await expectQuestionRestored(view);

    // The retry is sent from the restored composer and fails for a new reason. The newest error
    // must replace the old banner, and the question must come back again.
    mockChatStreamError(504, 'AI_TIMEOUT', 'The assistant took too long to answer. Please try again.');
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(view.getByText(TIMEOUT)).toBeTruthy());
    expect(view.queryByText(RATE_LIMITED)).toBeNull();
    await expectQuestionRestored(view);
    expect(view.queryByText(QUESTION)).toBeNull();
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][1].message).toBe(QUESTION);
    expect(chat).not.toHaveBeenCalled();
  });

  it('keeps the question through three failures and succeeds on the fourth attempt', async () => {
    const failures = [
      {
        arm: () =>
          mockChatStreamHttpError(
            429,
            'AI_RATE_LIMITED',
            'The assistant is receiving too many requests.',
          ),
        expected: RATE_LIMITED,
      },
      {
        arm: () =>
          mockChatStreamError(
            504,
            'AI_TIMEOUT',
            'The assistant took too long to answer. Please try again.',
          ),
        expected: TIMEOUT,
      },
      {
        arm: () => mockChatStreamError(502, 'AI_UNAVAILABLE', OUTAGE),
        expected: OUTAGE,
      },
    ];

    const view = await mount();
    const seen: string[] = [];

    for (const [attempt, failure] of failures.entries()) {
      failure.arm();
      if (attempt === 0) await ask(view);
      else void fireEvent.press(view.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(view.getByText(failure.expected)).toBeTruthy());
      for (const stale of seen) expect(view.queryByText(stale)).toBeNull();
      await expectQuestionRestored(view);
      expect(view.queryByText(QUESTION)).toBeNull();
      seen.push(failure.expected);
    }

    expect(chatStream).toHaveBeenCalledTimes(3);
    for (const call of chatStream.mock.calls) {
      expect(call[1].message).toBe(QUESTION);
    }
    expect(view.getByRole('button', { name: 'Send' }).props.accessibilityState?.disabled).toBe(
      false,
    );

    // The fourth attempt is sent from the same restored composer text and succeeds.
    chatStream.mockResolvedValue(TURN);
    void fireEvent.press(view.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(view.getByText('You hold 112 units in total.')).toBeTruthy());
    expect(chatStream).toHaveBeenCalledTimes(4);
    expect(chatStream.mock.calls[3][1].message).toBe(QUESTION);
    expect(view.queryByText(OUTAGE)).toBeNull();
    expect(view.getByPlaceholderText(PLACEHOLDER).props.value).toBe('');
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

describe('AI-40 — the remaining streamed AI errors keep their own sentences', () => {
  // AI_ABANDONED is deliberately absent: it is a server-side record, not an Android banner.
  const CASES = [
    {
      status: 503,
      code: 'AI_NOT_CONFIGURED',
      serverMessage:
        'The AI assistant is not configured on this server yet. Ask an administrator to enable it.',
      expected: NOT_CONFIGURED,
      notExpected: [OUTAGE, QUOTA, RATE_LIMITED],
    },
    {
      status: 502,
      code: 'AI_UNAVAILABLE',
      serverMessage: OUTAGE,
      expected: OUTAGE,
      notExpected: [QUOTA, RATE_LIMITED],
    },
    {
      status: 502,
      code: 'AI_OUTPUT_LIMIT',
      serverMessage:
        'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.',
      expected:
        'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.',
      notExpected: [OUTAGE, QUOTA, RATE_LIMITED],
    },
    {
      status: 504,
      code: 'AI_TIMEOUT',
      serverMessage: TIMEOUT,
      expected: TIMEOUT,
      notExpected: [OUTAGE, QUOTA, RATE_LIMITED],
    },
  ];

  it.each(CASES)('$code keeps its own sentence and restores the question', async ({
    status,
    code,
    serverMessage,
    expected,
    notExpected,
  }) => {
    mockChatStreamError(status, code, serverMessage);

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(expected)).toBeTruthy());
    for (const wrong of notExpected) {
      expect(view.queryByText(wrong)).toBeNull();
    }
    await expectQuestionRestored(view);
    expect(view.queryByText(QUESTION)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('AI-40 — pre-stream HTTP refusals keep their sentences and restore the question', () => {
  const CASES = [
    {
      status: 429,
      code: 'AI_RATE_LIMITED',
      message: 'The assistant is receiving too many requests.',
      expected: RATE_LIMITED,
    },
    {
      status: 503,
      code: 'AI_NOT_CONFIGURED',
      message:
        'The AI assistant is not configured on this server yet. Ask an administrator to enable it.',
      expected: NOT_CONFIGURED,
    },
  ];

  it.each(CASES)('$code keeps its sentence and restores the question', async ({
    status,
    code,
    message,
    expected,
  }) => {
    mockChatStreamHttpError(status, code, message);

    const view = await mount();
    await ask(view);

    await waitFor(() => expect(view.getByText(expected)).toBeTruthy());
    expect(view.queryByText(QUOTA)).toBeNull();
    await expectQuestionRestored(view);
    expect(view.queryByText(QUESTION)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
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
