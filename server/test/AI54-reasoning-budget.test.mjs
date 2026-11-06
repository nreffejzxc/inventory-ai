/**
 * AI-54 — the assistant asks the gateway NOT to spend its answer budget on hidden reasoning.
 *
 * WHY THIS EXISTS. A device turn on 2026-11-04 came back at 154 words carrying
 * `degraded=OUTPUT_LIMIT`, so the provider was measured directly on the endpoint and model the
 * assistant uses. With `max_tokens: 400` the response was `stop_reason: max_tokens`,
 * `output_tokens: 400`, `thinking_tokens: 400`, and its only content block was `thinking` —
 * the entire budget went to reasoning and no answer existed. The same request with
 * `thinking: { type: 'disabled' }` answered in 43 output tokens and a fifth of the time. So the
 * cap was never the problem: reasoning shares it with the answer.
 *
 * WHAT IS PINNED HERE:
 *
 *   * the default request carries `thinking: { type: 'disabled' }` and still carries
 *     `max_tokens` from config, so the answer owns the whole budget;
 *   * the flag is opt-OUT: only an explicit `false` omits the field, and a blank or malformed
 *     value keeps reasoning off;
 *   * a normal response is parsed exactly as before, so nothing downstream changes.
 *
 * No request leaves this file: `globalThis.fetch` is stubbed and the body is inspected.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import {
  createAnthropicCompatibleProvider,
  parseAnthropicResponse,
  toAnthropicMessages,
} from '../src/services/ai/providers/anthropicWire.ts';

process.env.AI_INVENTORY_TEST_KEY = 'not-a-real-key'; // secret-guard:allow — a fixture

function stubFetch(respond) {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return respond();
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

function textResponse() {
  return new Response(
    JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function provider() {
  return createAnthropicCompatibleProvider({
    name: 'test',
    apiKeyEnv: 'AI_INVENTORY_TEST_KEY',
    messagesUrl: 'https://example.invalid/v1/messages',
    modelKey: 'openrouterModel',
    defaultModel: 'm',
  });
}

async function ask() {
  return provider().complete({ system: 's', messages: [{ role: 'user', content: 'q' }], timeoutMs: 1_000 });
}

async function withFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'AI_THINKING_DISABLED');
  const previous = process.env.AI_THINKING_DISABLED;
  if (value === undefined) delete process.env.AI_THINKING_DISABLED;
  else process.env.AI_THINKING_DISABLED = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.AI_THINKING_DISABLED = previous;
    else delete process.env.AI_THINKING_DISABLED;
  }
}

unitSuite('AI-54 reasoning shares the answer budget', () => {
  it('asks for reasoning to be off by default, so the answer owns the whole budget', async () => {
    await withFlag(undefined, async () => {
      const stub = stubFetch(textResponse);
      try {
        const response = await ask();
        assert.equal(stub.bodies.length, 1);
        assert.deepEqual(stub.bodies[0].body.thinking, { type: 'disabled' });
        assert.ok(stub.bodies[0].body.max_tokens > 0, 'the answer cap is still sent');
        assert.equal(response.text, 'ok', 'a normal answer is parsed exactly as before');
        assert.equal(response.truncated, false);
      } finally {
        stub.restore();
      }
    });
  });

  it('preserves reasoning blocks and replays them before the tool call they produced', () => {
    const thinking = [{ type: 'thinking', thinking: 'check stock first', signature: 'sig-1' }];
    const parsed = parseAnthropicResponse({
      model: 'm',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'check stock first', signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'getInventory', input: { productId: 'p1' } },
      ],
    });
    assert.deepEqual(parsed.thinking, thinking);
    assert.deepEqual(parsed.toolCalls.map((call) => call.name), ['getInventory']);

    const wire = toAnthropicMessages([
      {
        role: 'assistant',
        content: '',
        thinking,
        toolCalls: [{ id: 't1', name: 'getInventory', input: { productId: 'p1' } }],
      },
    ]);
    assert.deepEqual(wire[0].content[0], {
      type: 'thinking',
      thinking: 'check stock first',
      signature: 'sig-1',
    });
    assert.equal(wire[0].content[1].type, 'tool_use');
  });

  it('does not replay an unsigned reasoning block the gateway cannot validate', () => {
    const wire = toAnthropicMessages([
      {
        role: 'assistant',
        content: '',
        thinking: [{ type: 'thinking', thinking: 'unsigned trace' }],
        toolCalls: [{ id: 't1', name: 'getInventory', input: {} }],
      },
    ]);
    assert.deepEqual(wire[0].content, [{ type: 'tool_use', id: 't1', name: 'getInventory', input: {} }]);
  });

  it('is opt-out only for an explicit false, and keeps reasoning off for anything else', async () => {
    const cases = [
      { value: '', off: true },
      { value: 'nonsense', off: true },
      { value: 'true', off: true },
      { value: 'false', off: false },
      { value: 'FALSE', off: false },
    ];
    for (const { value, off } of cases) {
      await withFlag(value, async () => {
        const stub = stubFetch(textResponse);
        try {
          await ask();
          if (off) assert.deepEqual(stub.bodies[0].body.thinking, { type: 'disabled' }, `value ${JSON.stringify(value)}`);
          else assert.equal('thinking' in stub.bodies[0].body, false, `value ${JSON.stringify(value)}`);
        } finally {
          stub.restore();
        }
      });
    }
  });
});
