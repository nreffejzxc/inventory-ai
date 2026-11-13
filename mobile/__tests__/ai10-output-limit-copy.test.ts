/**
 * AI-10 — a question the model could not fit inside its own output budget is a
 * LIMIT, not an outage.
 *
 * THE DEFECT (measured 2026-10-16, §27BG Q4). "How many products are completely out
 * of stock, and what percentage of the active catalogue is that?" answered
 * `502 AI_UNAVAILABLE` twice, at 31 421 ms and 31 789 ms, with the turn's tool already
 * run and answered. Nothing upstream was unavailable — the gateway answered 2xx, and
 * the model had spent its whole output cap without producing a token of answer or a
 * tool call — and the remedy the member was given ("try again in a moment") cannot
 * work, because the same question spends the same budget again.
 *
 * WHAT THIS FILE PINS.
 *   1. `AI_OUTPUT_LIMIT` has its OWN sentence, and it asks for the thing that would
 *      actually work: less at once.
 *   2. It is not any of the sentences it used to collapse into: not the provider
 *      outage, not the unreachable server, not the timeout, not either 429.
 *   3. The CODE wins over the transport's own classification. The server's `error`
 *      string is carried on the same object, so a screen that fell through to it would
 *      still be correct today and could not be missed tomorrow — the copy is read from
 *      the code, and the code is the contract.
 *   4. A GUARD on the join between the two systems: the code the client switches on is
 *      read out of the SERVER's own source, so the client cannot be correct against a
 *      string the server never emits.
 *
 * WHAT IT DOES NOT PROVE: that the sentence is reached end to end from a real gateway
 * answer. That is the DB-backed wire test on the server side, which drives the whole
 * chain against a stub gateway (`server/test/AI10-output-limit-not-an-outage.test.mjs`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sendErrorMessage } from '../components/AiChat';

const OUT_OF_ROOM =
  'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.';
const QUOTA =
  "The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app works as usual.";
const UNREACHABLE = 'Cannot reach the server. Check your connection and try again.';
const TOO_LONG = 'The assistant took too long to answer. Please try again.';

/** The code the server actually emits, read from its own source rather than retyped. */
function serverOutputLimitCode(): string {
  const source = readFileSync(
    join(__dirname, '..', '..', 'server', 'src', 'services', 'ai', 'aiErrors.ts'),
    'utf8',
  );
  const match = source.match(/AI_OUTPUT_LIMIT\s*=\s*'([^']+)'/);
  if (!match) {
    throw new Error(
      'could not read AI_OUTPUT_LIMIT from the server source — the guard would be blind',
    );
  }
  return match[1];
}

describe('AI-10 — a spent output budget is reported as a limit', () => {
  it('★ names the limit and asks for the question that would fit', () => {
    expect(sendErrorMessage({ code: 'AI_OUTPUT_LIMIT' })).toBe(OUT_OF_ROOM);
  });

  it('never reports it as a provider outage — the defect this fixes', () => {
    const message = sendErrorMessage({ code: 'AI_OUTPUT_LIMIT' });
    expect(message).not.toMatch(/temporarily unavailable/i);
    expect(message).not.toMatch(/in a moment/i);
  });

  it('asks for less at once rather than for another try', () => {
    // The whole point: a retry spends the same budget again, so the copy must not
    // invite one. "Ask a shorter or more specific question" is the actionable half.
    expect(sendErrorMessage({ code: 'AI_OUTPUT_LIMIT' })).toMatch(/shorter or more specific/i);
  });

  it('reads the code, not the sentence the server sent with it', () => {
    // `ApiError.message` carries the server's own `error` field, so a screen that fell
    // through to it would pass every other case in this file while owning no copy at
    // all. Here the fallback is deliberately the WRONG sentence: the code must win.
    expect(
      sendErrorMessage({
        code: 'AI_OUTPUT_LIMIT',
        message: 'The AI service is temporarily unavailable. Please try again in a moment.',
      }),
    ).toBe(OUT_OF_ROOM);
  });

  it('is not the unreachable sentence, even though the request failed as one', () => {
    expect(sendErrorMessage({ code: 'AI_OUTPUT_LIMIT', isNetwork: true })).toBe(OUT_OF_ROOM);
  });
});

describe('AI-10 — the neighbours keep their own copy', () => {
  it('an outage is still an outage', () => {
    expect(sendErrorMessage({ code: 'AI_UNAVAILABLE' })).toMatch(/temporarily unavailable/);
    expect(sendErrorMessage({ code: 'AI_UNAVAILABLE' })).not.toBe(OUT_OF_ROOM);
  });

  it('a spent ALLOWANCE is not a spent OUTPUT BUDGET', () => {
    // Two limits with opposite remedies: one refills on its own schedule, the other
    // cannot be waited out but can be worked around.
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).toBe(QUOTA);
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).not.toBe(OUT_OF_ROOM);
    expect(sendErrorMessage({ code: 'AI_OUTPUT_LIMIT' })).not.toBe(QUOTA);
    expect(sendErrorMessage({ code: 'AI_OUTPUT_LIMIT' })).not.toMatch(/usage limit/i);
  });

  it('neither the timeout nor the rate limit borrows it', () => {
    expect(sendErrorMessage({ code: 'AI_TIMEOUT' })).toBe(TOO_LONG);
    expect(sendErrorMessage({ code: 'AI_RATE_LIMITED' })).toMatch(/too quickly/);
    expect(sendErrorMessage({ code: 'NETWORK_ERROR', isNetwork: true })).toBe(UNREACHABLE);
  });

  it('an unknown code does not reach the limit sentence', () => {
    // The negative control for every `toBe(OUT_OF_ROOM)` above: the sentence is
    // selected, not fallen into.
    expect(sendErrorMessage({ code: 'AI_SOMETHING_NEW' })).not.toBe(OUT_OF_ROOM);
  });
});

describe('AI-10 — the client switches on the code the SERVER actually emits', () => {
  it('the server constant, read from source, resolves to the limit sentence', () => {
    // If the server renamed the code, every literal above would still pass while the
    // app quietly fell through to the outage sentence — the exact regression this
    // suite exists to prevent.
    expect(serverOutputLimitCode()).toBe('AI_OUTPUT_LIMIT');
    expect(sendErrorMessage({ code: serverOutputLimitCode() })).toBe(OUT_OF_ROOM);
  });
});
