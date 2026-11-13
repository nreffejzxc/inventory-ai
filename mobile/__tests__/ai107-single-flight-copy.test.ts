/**
 * AI-107 — a second send while the first turn is still running has its own sentence.
 *
 * The server refuses the duplicate with `409 AI_TURN_IN_PROGRESS`. Falling through to the
 * generic/unreachable copy would tell the member to "check your connection", which is false and
 * would invite another retry while the first turn is still spending the conversation's slot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sendErrorMessage, streamFallbackAllowed } from '../components/AiChat';

const IN_PROGRESS =
  'The assistant is still answering your previous message. Wait for it to finish and try again.';

describe('AI-107 — a turn already in progress', () => {
  it('★ asks the member to wait for the active answer instead of retrying into it', () => {
    expect(sendErrorMessage({ code: 'AI_TURN_IN_PROGRESS' })).toBe(IN_PROGRESS);
  });

  it('is not the rate-limit, outage, timeout or connection sentence', () => {
    const message = sendErrorMessage({ code: 'AI_TURN_IN_PROGRESS' });
    expect(message).not.toMatch(/too quickly/i);
    expect(message).not.toMatch(/temporarily unavailable/i);
    expect(message).not.toMatch(/took too long/i);
    expect(message).not.toMatch(/check your connection/i);
  });

  it('reads the code even when the transport carried a different sentence', () => {
    expect(
      sendErrorMessage({
        code: 'AI_TURN_IN_PROGRESS',
        message: 'The AI service is temporarily unavailable. Please try again in a moment.',
      }),
    ).toBe(IN_PROGRESS);
  });

  it('the streaming path does not retry the refused duplicate over JSON', () => {
    expect(streamFallbackAllowed({ status: 409, code: 'AI_TURN_IN_PROGRESS' })).toBe(false);
  });

  it('the server emits the same code and sentence this screen knows', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'server', 'src', 'services', 'ai', 'singleFlight.ts'),
      'utf8',
    );
    expect(source).toContain("'AI_TURN_IN_PROGRESS'");
    expect(source).toContain(IN_PROGRESS);
  });
});
