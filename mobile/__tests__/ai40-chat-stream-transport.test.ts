/**
 * AI-40 — the streamed request must always settle.
 *
 * WHY THIS FILE EXISTS. Every other AI-40 case stubs the API at the screen boundary, so the
 * transport's own failure modes were covered by assumption rather than by a test. The phone
 * then showed the gap on 2026-10-23: a stream cut after its headers left `reader.read()`
 * parked forever, the 75 s budget aborted a request whose promise never rejected, and the
 * screen stayed on its spinner with no answer, no sentence and no way out but killing the app.
 * These cases pin the two ways a read can fail to finish — the budget expiring and the member
 * pressing Stop — and the happy path beside them.
 */

import { aiApi } from '../lib/api';
import { REQUEST_CANCELLED } from '../lib/client';

// The transport is injected rather than mocked at the module boundary: `expo/fetch` is loaded
// through a dynamic import, which a Jest module mock does not intercept, and the failure this
// file exists for (a reader that never settles) cannot be produced by the real implementation.
const mockStreamingFetch = jest.fn();
const streamOptions = (extra: Record<string, unknown> = {}) => ({ fetchImpl: mockStreamingFetch, ...extra });

/** Let the lazy import, the fetch and the reader setup run before asserting. */
async function flush(turns = 24): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A body whose reader never delivers another byte — the measured wedge. */
function wedgedBody() {
  const reader = {
    read: jest.fn(() => new Promise(() => {})),
    cancel: jest.fn(() => Promise.resolve()),
    releaseLock: jest.fn(),
  };
  return { body: { getReader: () => reader }, reader };
}

/** A body that keeps sending a heartbeat forever and never finishes — the live-but-silent case. */
function heartbeatBody() {
  const encoder = new TextEncoder();
  const reader = {
    read: jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ done: false, value: encoder.encode(': ping\n\n') }), 10_000),
        ),
    ),
    cancel: jest.fn(() => Promise.resolve()),
    releaseLock: jest.fn(),
  };
  return { body: { getReader: () => reader }, reader };
}

/** A body that delivers one chunk and then the end of the stream. */
function bodyOf(chunks: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  const reader = {
    read: jest.fn(async () =>
      index < chunks.length
        ? { done: false, value: encoder.encode(chunks[index++]) }
        : { done: true, value: undefined },
    ),
    cancel: jest.fn(() => Promise.resolve()),
    releaseLock: jest.fn(),
  };
  return { body: { getReader: () => reader }, reader };
}

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  body,
  text: async () => '',
});

beforeEach(() => {
  mockStreamingFetch.mockReset();
});

afterEach(() => {
  // A wedged reader is deliberately left unsettled, so any timer still armed by the fake clock is
  // dropped here rather than keeping Jest's process alive after the assertions pass.
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('AI-40 — chatStream settles even when the body does not', () => {
  it('★ gives up on a silent connection at the heartbeat window, not the whole 75 s budget', async () => {
    jest.useFakeTimers();
    mockStreamingFetch.mockResolvedValue(okResponse(wedgedBody().body));

    const pending = aiApi.chatStream('token-1', { message: 'How much stock do we hold?' }, streamOptions());
    // The rejection is asserted below; this keeps an early unhandled rejection from failing the run.
    pending.catch(() => {});
    await flush();

    await jest.advanceTimersByTimeAsync(20_001);

    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('★ still reports a NETWORK_TIMEOUT when the server keeps the connection alive but never answers', async () => {
    // Heartbeats reset the idle window, so only the turn's own budget can end this one — which is
    // the distinction the two failures exist to keep apart: "the line went dead" versus "it is
    // still talking and never finished".
    jest.useFakeTimers();
    mockStreamingFetch.mockResolvedValue(okResponse(heartbeatBody().body));

    const pending = aiApi.chatStream('token-1', { message: 'x' }, streamOptions());
    pending.catch(() => {});
    await flush();

    await jest.advanceTimersByTimeAsync(75_001);

    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT', status: 0 });
  });

  it('★ rejects with REQUEST_CANCELLED when the member stops a parked reader', async () => {
    mockStreamingFetch.mockResolvedValue(okResponse(wedgedBody().body));

    const controller = new AbortController();
    const pending = aiApi.chatStream(
      'token-1',
      { message: 'How much stock do we hold?' },
      streamOptions({ signal: controller.signal }),
    );
    pending.catch(() => {});
    await flush();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: REQUEST_CANCELLED, status: 0 });
  });

  it('cancels the body it gave up on, so the connection is released rather than leaked', async () => {
    const wedged = wedgedBody();
    mockStreamingFetch.mockResolvedValue(okResponse(wedged.body));

    const controller = new AbortController();
    const pending = aiApi.chatStream('token-1', { message: 'x' }, streamOptions({ signal: controller.signal }));
    pending.catch(() => {});
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: REQUEST_CANCELLED });
    await flush(4);

    expect(wedged.reader.cancel).toHaveBeenCalled();
  });

  it('still delivers deltas and the stored turn when the stream is healthy', async () => {
    const events =
      'event: delta\ndata: {"text":"You hold "}\n\n' +
      'event: delta\ndata: {"text":"112 units."}\n\n' +
      'event: done\ndata: {"assistantMessage":{"id":"m1","role":"ASSISTANT","content":"You hold 112 units."}}\n\n';
    mockStreamingFetch.mockResolvedValue(okResponse(bodyOf([events]).body));

    const deltas: string[] = [];
    const result = await aiApi.chatStream(
      'token-1',
      { message: 'x' },
      streamOptions({ onDelta: (text: string) => deltas.push(text) }),
    );

    expect(deltas.join('')).toBe('You hold 112 units.');
    expect(result?.assistantMessage?.content).toBe('You hold 112 units.');
  });

  it('reports a reset and keeps delivering the replacement (AI-74)', async () => {
    const events =
      'event: delta\ndata: {"text":"Draft: OUT_OF_STOCK"}\n\n' +
      'event: reset\ndata: {}\n\n' +
      'event: delta\ndata: {"text":"Draft: Out of stock"}\n\n' +
      'event: done\ndata: {"assistantMessage":{"id":"m1","role":"ASSISTANT","content":"Draft: Out of stock"}}\n\n';
    mockStreamingFetch.mockResolvedValue(okResponse(bodyOf([events]).body));

    const deltas: string[] = [];
    let resets = 0;
    const result = await aiApi.chatStream(
      'token-1',
      { message: 'x' },
      streamOptions({
        onDelta: (text: string) => deltas.push(text),
        onReset: () => {
          resets += 1;
        },
      }),
    );

    expect(resets).toBe(1);
    expect(deltas).toEqual(['Draft: OUT_OF_STOCK', 'Draft: Out of stock']);
    expect(result?.assistantMessage?.content).toBe('Draft: Out of stock');
  });

  it('negative control: the same wedged reader is what makes the two failures possible', async () => {
    // Without an unsettled read the cases above would prove nothing about the race: a body that
    // ends immediately settles on its own and reports the missing answer, not a timeout.
    mockStreamingFetch.mockResolvedValue(okResponse(bodyOf([]).body));

    await expect(aiApi.chatStream('token-1', { message: 'x' }, streamOptions())).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });
});
