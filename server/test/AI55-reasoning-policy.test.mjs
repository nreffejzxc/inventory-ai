/**
 * AI-55 — reasoning is configured PER MODEL, and the request proves it.
 *
 * WHY THIS EXISTS. AI-54 pinned one global request field — `thinking: { type: 'disabled' }` —
 * because hidden reasoning once consumed an entire 400-token budget and returned no answer.
 * That is right for the free chain and wrong for a model that REQUIRES reasoning: OpenRouter
 * answers `invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be
 * disabled."`, so `openai/gpt-oss-20b` failed every turn after working before AI-54 shipped.
 *
 * WHAT IS PINNED HERE:
 *
 *   * no configuration still means `off`, so every existing free-model deployment is byte-for-byte
 *     unchanged (AI-54's behaviour);
 *   * `AI_REASONING_PAID_MODELS=enable|disable` is the paid-model switch: enable omits the field and lets a
 *     paid model use its own default; disable sends `thinking: disabled`;
 *   * a valid simple switch overrides the advanced rules; an invalid one is reported and the
 *     advanced/default path keeps the safe behaviour;
 *   * `auto` omits the field and lets the model use its own default;
 *   * a per-model rule overrides the default for THAT model only, and the resolution follows the
 *     model the request names — which is the model a failover candidate names;
 *   * first match wins, `*` is a glob, and a malformed rule is reported rather than silently
 *     applied;
 *   * `budget:N` sends `enabled` only when N fits under the output cap, and is omitted otherwise;
 *   * the legacy `AI_THINKING_DISABLED=false` still means `auto` when the new default is unset.
 *
 * No request leaves this file: `globalThis.fetch` is stubbed and the body is inspected.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { createAnthropicCompatibleProvider } from '../src/services/ai/providers/anthropicWire.ts';
import {
  parseReasoningPolicy,
  parseSimpleReasoning,
  reasoningSettings,
  resolveReasoningPolicy,
  thinkingFieldFor,
} from '../src/services/ai/reasoningPolicy.ts';

process.env.AI_INVENTORY_TEST_KEY = 'not-a-real-key'; // secret-guard:allow — a fixture

const KEYS = [
  'AI_MODEL_OPENROUTER',
  'AI_REASONING_PAID_MODELS',
  'AI_REASONING',
  'AI_REASONING_FREE_MODELS',
  'AI_REASONING_DEFAULT',
  'AI_REASONING_MODELS_OPENROUTER',
  'AI_THINKING_DISABLED',
  'AI_MAX_OUTPUT_TOKENS',
];

/** Run `fn` with exactly these reasoning variables, then restore the process environment. */
async function withEnv(values, fn) {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function textResponse() {
  return new Response(
    JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function provider() {
  return createAnthropicCompatibleProvider({
    name: 'test',
    apiKeyEnv: 'AI_INVENTORY_TEST_KEY',
    messagesUrl: 'https://example.invalid/v1/messages',
    modelKey: 'openrouterModel',
    defaultModel: 'default/model',
  });
}

function stubFetch() {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return textResponse();
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

async function ask(model) {
  return provider().complete({
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    timeoutMs: 1_000,
    ...(model ? { model } : {}),
  });
}

unitSuite('AI-55 reasoning uses a simple switch with per-model overrides', () => {
  it('keeps AI-54 behaviour when nothing is configured: reasoning is off', async () => {
    await withEnv({}, async () => {
      const stub = stubFetch();
      try {
        await ask();
        assert.deepEqual(stub.bodies[0].thinking, { type: 'disabled' });
      } finally {
        stub.restore();
      }
    });
  });

  it('honours the legacy AI_THINKING_DISABLED=false as auto', async () => {
    await withEnv({ AI_THINKING_DISABLED: 'false' }, async () => {
      const stub = stubFetch();
      try {
        await ask();
        assert.equal('thinking' in stub.bodies[0], false);
      } finally {
        stub.restore();
      }
    });
  });

  it('AI_REASONING_PAID_MODELS=enable lets a paid model use its own default, overriding rules', async () => {
    const settings = reasoningSettings({
      AI_REASONING_PAID_MODELS: 'enable',
      AI_REASONING_MODELS_OPENROUTER: '*=off',
    });
    assert.equal(settings.rules.length, 0, 'the simple switch ignores advanced rules');
    assert.deepEqual(resolveReasoningPolicy('any/model', settings), {
      policy: { mode: 'auto' },
      source: 'paid',
    });

    await withEnv(
      { AI_REASONING_PAID_MODELS: 'enable', AI_REASONING_MODELS_OPENROUTER: '*=off' },
      async () => {
        const stub = stubFetch();
        try {
          await ask('openai/gpt-oss-120b');
          assert.equal('thinking' in stub.bodies[0], false);
        } finally {
          stub.restore();
        }
      },
    );
  });

  it('AI_REASONING_PAID_MODELS=disable sends disabled for a paid model, overriding rules', async () => {
    await withEnv(
      { AI_REASONING_PAID_MODELS: 'disable', AI_REASONING_MODELS_OPENROUTER: '*=auto' },
      async () => {
        const stub = stubFetch();
        try {
          await ask('anthropic/claude-sonnet-4.5');
          assert.deepEqual(stub.bodies[0].thinking, { type: 'disabled' });
        } finally {
          stub.restore();
        }
      },
    );
  });

  it('reports an invalid AI_REASONING_PAID_MODELS and keeps the advanced fallback', () => {
    assert.deepEqual(parseSimpleReasoning('enable'), { mode: 'auto' });
    assert.deepEqual(parseSimpleReasoning('disable'), { mode: 'off' });
    assert.equal(parseSimpleReasoning('budget:1024'), null, 'AI_REASONING_PAID_MODELS is enable/disable only');

    const settings = reasoningSettings({
      AI_REASONING_PAID_MODELS: 'sometimes',
      AI_REASONING_DEFAULT: 'auto',
    });
    assert.equal(settings.simplePolicy, null);
    assert.match(settings.simpleProblem, /AI_REASONING_PAID_MODELS must be enable or disable/);
    assert.deepEqual(resolveReasoningPolicy('any/model', settings), {
      policy: { mode: 'auto' },
      source: 'default',
    });
  });

  it('AI_REASONING_DEFAULT=auto omits the field for every model', async () => {
    await withEnv({ AI_REASONING_DEFAULT: 'auto' }, async () => {
      const stub = stubFetch();
      try {
        await ask();
        assert.equal('thinking' in stub.bodies[0], false);
      } finally {
        stub.restore();
      }
    });
  });

  it('a rule applies to its model only, and a failover candidate keeps its own policy', async () => {
    await withEnv({ AI_REASONING_MODELS_OPENROUTER: 'openai/gpt-oss-*=auto' }, async () => {
      const stub = stubFetch();
      try {
        // The first call is the primary (a mandatory-reasoning paid model); the second is the
        // model a failover would name. The override follows each request, so the primary's
        // policy cannot leak into the candidate.
        await ask('openai/gpt-oss-20b');
        await ask('nvidia/nemotron-3.5-lightning:free');
        assert.equal('thinking' in stub.bodies[0], false);
        assert.deepEqual(stub.bodies[1].thinking, { type: 'disabled' });
      } finally {
        stub.restore();
      }
    });
  });

  it('uses the first matching rule, with * as a glob', () => {
    const settings = reasoningSettings({
      AI_REASONING_DEFAULT: 'off',
      AI_REASONING_MODELS_OPENROUTER: 'openai/gpt-oss-20b=auto,*=budget:2048',
    });
    assert.deepEqual(resolveReasoningPolicy('openai/gpt-oss-20b', settings), {
      policy: { mode: 'auto' },
      source: 'model',
    });
    assert.deepEqual(resolveReasoningPolicy('other/model', settings), {
      policy: { mode: 'budget', budgetTokens: 2048 },
      source: 'model',
    });
  });

  it('reports a malformed rule instead of applying it, and keeps the safe default', () => {
    const settings = reasoningSettings({
      AI_REASONING_MODELS_OPENROUTER: 'nonsense,openai/gpt-oss-*=sometimes',
    });
    assert.equal(settings.ignored.length, 2);
    assert.equal(settings.rules.length, 0);
    assert.equal(settings.defaultPolicy.mode, 'off');
  });

  it('reports an unusable default and falls back to off', () => {
    const settings = reasoningSettings({ AI_REASONING_DEFAULT: 'sometimes' });
    assert.equal(settings.defaultPolicy.mode, 'off');
    assert.match(settings.defaultProblem, /AI_REASONING_DEFAULT/);
  });

  it('sends a budget only when it fits under the output cap', async () => {
    assert.deepEqual(thinkingFieldFor({ mode: 'budget', budgetTokens: 1024 }, 1200), {
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    assert.deepEqual(thinkingFieldFor({ mode: 'budget', budgetTokens: 1024 }, 512), {});
    assert.deepEqual(thinkingFieldFor({ mode: 'budget', budgetTokens: 1024 }, 1024), {});
    assert.equal(parseReasoningPolicy('budget:100'), null, 'below the documented floor is invalid');

    await withEnv(
      { AI_REASONING_MODELS_OPENROUTER: 'anthropic/claude-*=budget:1024', AI_MAX_OUTPUT_TOKENS: '4096' },
      async () => {
        const stub = stubFetch();
        try {
          await ask('anthropic/claude-sonnet-4.5');
          assert.deepEqual(stub.bodies[0].thinking, { type: 'enabled', budget_tokens: 1024 });
        } finally {
          stub.restore();
        }
      },
    );
  });
});
