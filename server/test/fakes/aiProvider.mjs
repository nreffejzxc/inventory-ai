/**
 * Fake AI provider for Phase 06 tests.
 *
 * Registered under the name "fake" (AI_PROVIDER=fake) so the real aiService +
 * tool loop + HTTP routes can be exercised with NO external API key. The
 * scenario callback receives the same neutral { messages, tools, system } the
 * real providers get and returns a provider-shaped response; helpers below
 * build those responses and read back what the loop sent.
 */

import { registerProvider, deregisterProvider } from '../../src/services/ai/providers/index.ts';

let current = null;

/** Set (or clear with null) the active scenario callback. */
export function setFakeScenario(fn) {
  current = fn || null;
}

/** Register the fake provider factory under a name (idempotent). Call once per test file. */
export function registerFakeProvider(name = 'fake') {
  registerProvider(name, () => ({
    name,
    // AI-28 — the model this provider is CONFIGURED to use. The real factory exposes the same
    // value, which is what lets a failing turn name its model instead of reporting `unknown`.
    model: 'fake-model',
    async complete(ctx) {
      if (current) return current(ctx);
      return { model: 'fake-model', text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  }));
}

export function deregisterFakeProvider() {
  deregisterProvider('fake');
  current = null;
}

/** Provider-shaped final-text response. */
export function fakeText(text, over = {}) {
  return { model: 'fake-model', text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, ...over };
}

/** Provider-shaped tool-call response (no final text yet). */
export function fakeCalls(calls) {
  return { model: 'fake-model', text: '', toolCalls: calls, usage: { inputTokens: 0, outputTokens: 0 } };
}

export function lastUserMessage(ctx) {
  for (let i = ctx.messages.length - 1; i >= 0; i -= 1) {
    if (ctx.messages[i].role === 'user') return ctx.messages[i].content;
  }
  return '';
}

/** The most recent tool result the loop produced, parsed. */
export function lastToolResult(ctx) {
  for (let i = ctx.messages.length - 1; i >= 0; i -= 1) {
    const m = ctx.messages[i];
    if (m.role === 'tool') {
      try {
        return JSON.parse(m.content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** All tool results seen so far (parsed). */
export function toolResults(ctx) {
  const out = [];
  for (const m of ctx.messages) {
    if (m.role === 'tool') {
      try {
        out.push(JSON.parse(m.content));
      } catch {
        out.push(null);
      }
    }
  }
  return out;
}

export default { registerFakeProvider, deregisterFakeProvider, setFakeScenario, fakeText, fakeCalls, lastUserMessage, lastToolResult, toolResults };
