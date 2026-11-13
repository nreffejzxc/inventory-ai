/**
 * AI-6 — a reached usage limit must not be reported as a broken service.
 *
 * THE DEFECT. The app rendered an exhausted assistant allowance with the
 * provider-outage sentence: *"The AI service is temporarily unavailable. Please
 * try again in a moment."* Re-measured on the hardware on 2026-10-13 (§27BF), a
 * `429 free-models-per-day` quota answer turned out to be the DOMINANT failure at
 * this tier, so this was the common case rather than the rare one — and it was
 * wrong twice over. Nothing upstream was unavailable, and "in a moment" cannot
 * refill a daily allowance, so the sentence prescribed an action that could never
 * work and sent the member round the same loop.
 *
 * WHAT THIS FILE PINS.
 *   1. `AI_QUOTA_EXCEEDED` has its OWN sentence — one that names a limit and asks
 *      for a wait that could actually help.
 *   2. It is not any of the sentences it used to collapse into: not the provider
 *      outage, not the unreachable server, not the timeout, not the rate limit.
 *   3. The two 429s stay apart, because their remedies are opposites.
 *   4. Every other code's copy is unchanged.
 *   5. A GUARD on the join between the two systems: the code the client switches
 *      on is read out of the SERVER's own source, so the client cannot be correct
 *      against a string the server does not emit. Two hand-copied literals are
 *      how this class of defect returns.
 *
 * WHAT IT DOES NOT PROVE: that the quota sentence is reached end to end from a
 * real gateway refusal. That is the DB-backed wire test on the server side
 * (`server/test/AI6-ai-quota-limit.test.mjs`) and, ultimately, a device run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sendErrorMessage } from '../components/AiChat';

// Changed 2026-10-19: the sentence names WHEN, because the provider's own counter was read at
// its ceiling (50 of 50 free requests) and a real turn was refused — "try again later" gives a
// member nothing to act on, while the allowance resets at a known moment.
// Changed 2026-11-13: the reset is stated in UTC only. The old "8AM in Manila" parenthetical
// was a city-specific local time in a sentence every member sees, whether or not they are in
// that city. UTC is unambiguous without pretending to know the device's time zone.
const QUOTA =
  "The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app works as usual.";
const UNREACHABLE = 'Cannot reach the server. Check your connection and try again.';
const TOO_LONG = 'The assistant took too long to answer. Please try again.';

/** The code the server actually emits, read from its own source rather than retyped. */
function serverQuotaCode(): string {
  const source = readFileSync(
    join(__dirname, '..', '..', 'server', 'src', 'services', 'ai', 'aiErrors.ts'),
    'utf8',
  );
  const match = source.match(/AI_QUOTA_EXCEEDED\s*=\s*'([^']+)'/);
  if (!match) {
    throw new Error(
      'could not read AI_QUOTA_EXCEEDED from the server source — the guard would be blind',
    );
  }
  return match[1];
}

describe('AI-6 — a reached limit is reported as a limit', () => {
  it('names the usage limit and says WHEN the allowance returns', () => {
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).toBe(QUOTA);
    // The named reset is the point: an unspecified "later" was the defect.
    expect(QUOTA).toMatch(/midnight UTC/);
    // It must not read as an outage, and it must not tell the member the app is unusable.
    expect(QUOTA).toMatch(/rest of the app works as usual/);
  });

  it('never reports it as a provider outage — the defect this fixes', () => {
    const message = sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' });
    expect(message).not.toMatch(/temporarily unavailable/i);
    expect(message).not.toMatch(/in a moment/i);
  });

  it('never reports it as an unreachable server, even though the screen loads it as one', () => {
    // The request FAILED from the transport's point of view; the code must win.
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED', isNetwork: true })).toBe(QUOTA);
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).not.toBe(UNREACHABLE);
  });

  it('never reports it as a timeout', () => {
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).not.toBe(TOO_LONG);
  });
});

describe('AI-6 — the two 429s stay apart, because their remedies are opposites', () => {
  it('the rate limit still says a moment will do', () => {
    expect(sendErrorMessage({ code: 'AI_RATE_LIMITED' })).toMatch(/too quickly/);
  });

  it('the quota limit does NOT say a moment will do', () => {
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).not.toMatch(/too quickly/i);
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED' })).not.toMatch(/wait a moment/i);
  });

  it('neither 429 falls through to the generic network sentence', () => {
    expect(sendErrorMessage({ code: 'AI_RATE_LIMITED', isNetwork: true })).not.toBe(UNREACHABLE);
    expect(sendErrorMessage({ code: 'AI_QUOTA_EXCEEDED', isNetwork: true })).not.toBe(UNREACHABLE);
  });
});

describe('AI-6 — every other assistant failure keeps its existing copy', () => {
  it('AI_NOT_CONFIGURED still points at an administrator', () => {
    expect(sendErrorMessage({ code: 'AI_NOT_CONFIGURED' })).toMatch(/not enabled on this server/);
  });

  it('AI_UNAVAILABLE still says temporarily unavailable', () => {
    expect(sendErrorMessage({ code: 'AI_UNAVAILABLE' })).toMatch(/temporarily unavailable/);
  });

  it('a real network failure is still the unreachable sentence', () => {
    expect(sendErrorMessage({ code: 'NETWORK_ERROR', isNetwork: true })).toBe(UNREACHABLE);
    expect(sendErrorMessage({ isNetwork: true })).toBe(UNREACHABLE);
  });

  it('a timeout is still the timeout sentence', () => {
    expect(sendErrorMessage({ code: 'NETWORK_TIMEOUT', isNetwork: true })).toBe(TOO_LONG);
    expect(sendErrorMessage({ code: 'AI_TIMEOUT' })).toBe(TOO_LONG);
  });

  it('a field-level problem is still surfaced verbatim', () => {
    expect(sendErrorMessage({ fields: [{ field: 'message', message: 'Message is too long.' }] })).toBe(
      'Message is too long.',
    );
  });
});

describe('AI-6 — the client switches on the code the SERVER actually emits', () => {
  it('the server constant, read from source, resolves to the quota sentence', () => {
    // If the server renamed the code, every literal above would still pass while
    // the app quietly fell through to the outage sentence — the exact regression
    // this suite exists to prevent.
    expect(serverQuotaCode()).toBe('AI_QUOTA_EXCEEDED');
    expect(sendErrorMessage({ code: serverQuotaCode() })).toBe(QUOTA);
  });

  it('choosing the quota sentence is not reachable by an unknown code', () => {
    expect(sendErrorMessage({ code: 'AI_SOMETHING_NEW' })).not.toBe(QUOTA);
  });
});
