/**
 * AI-100 — free-model reasoning is independent from paid-model reasoning.
 *
 * WHY THIS EXISTS. AI-55 made `AI_REASONING_PAID_MODELS` one switch for the whole chain. That is wrong for
 * the cost-balanced deployment: the paid gpt-oss models require reasoning, while the free
 * fallback used by the simple inventory route should spend its answer budget on the answer.
 * `AI_REASONING_FREE_MODELS` is a separate, strict `enable`/`disable` switch for any model id
 * ending in `:free`.
 *
 * WHAT IS PINNED HERE:
 *
 *   * free models default to `off` when the new variable is unset;
 *   * `AI_REASONING_FREE_MODELS=enable` omits the reasoning field for a free model;
 *   * `AI_REASONING_FREE_MODELS=disable` sends `thinking: { type: 'disabled' }`;
 *   * `AI_REASONING_PAID_MODELS` continues to govern a paid model in the same process;
 *   * only `enable` and `disable` are accepted by either reasoning switch or either web switch;
 *   * the per-request log names the policy, the field and the configuration source;
 *   * production validation rejects an alias before the deploy starts.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { createAnthropicCompatibleProvider } from '../src/services/ai/providers/anthropicWire.ts';
import {
  parseSimpleReasoning,
  reasoningConfigProblems,
  reasoningSettings,
  resolveReasoningPolicy,
} from '../src/services/ai/reasoningPolicy.ts';
import { webCapabilities } from '../src/services/ai/webCapabilities.ts';
import { validateProductionConfig } from '../src/config/validateConfig.ts';

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
  'AI_WEB_SEARCH',
  'AI_WEB_FETCH',
];

/** Run `fn` with exactly these variables, then restore the process environment. */
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
    defaultModel: 'paid/model',
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
    model,
  });
}

unitSuite('AI-100 free-model reasoning is independent and observable', () => {
  it('defaults every free model to reasoning off, without inheriting AI_REASONING_PAID_MODELS', () => {
    const settings = reasoningSettings({ AI_REASONING_PAID_MODELS: 'enable' });
    assert.deepEqual(settings.freePolicy, { mode: 'off' });
    assert.equal(settings.freeSource, 'default');
    assert.deepEqual(resolveReasoningPolicy('nvidia/free:free', settings), {
      policy: { mode: 'off' },
      source: 'free',
    });
    assert.deepEqual(resolveReasoningPolicy('openai/gpt-oss-20b', settings), {
      policy: { mode: 'auto' },
      source: 'paid',
    });
  });

  it('uses the free switch and the paid switch in the same process', () => {
    const settings = reasoningSettings({
      AI_REASONING_PAID_MODELS: 'enable',
      AI_REASONING_FREE_MODELS: 'disable',
    });
    assert.deepEqual(resolveReasoningPolicy('nvidia/free:free', settings), {
      policy: { mode: 'off' },
      source: 'free',
    });
    assert.deepEqual(resolveReasoningPolicy('openai/gpt-oss-20b', settings), {
      policy: { mode: 'auto' },
      source: 'paid',
    });

    const enabled = reasoningSettings({
      AI_REASONING_PAID_MODELS: 'disable',
      AI_REASONING_FREE_MODELS: 'enable',
    });
    assert.deepEqual(resolveReasoningPolicy('nvidia/free:free', enabled), {
      policy: { mode: 'auto' },
      source: 'free',
    });
    assert.deepEqual(resolveReasoningPolicy('openai/gpt-oss-20b', enabled), {
      policy: { mode: 'off' },
      source: 'paid',
    });
  });

  it('accepts the old AI_REASONING name only as a deprecated fallback, and the new name wins', () => {
    const legacy = reasoningSettings({ AI_REASONING: 'enable' });
    assert.deepEqual(legacy.simplePolicy, { mode: 'auto' });
    assert.equal(legacy.paidSource, 'AI_REASONING');

    const both = reasoningSettings({
      AI_REASONING: 'enable',
      AI_REASONING_PAID_MODELS: 'disable',
    });
    assert.deepEqual(both.simplePolicy, { mode: 'off' });
    assert.equal(both.paidSource, 'AI_REASONING_PAID_MODELS');

    const problems = reasoningConfigProblems({ AI_REASONING: 'on' });
    assert.deepEqual(problems.map((problem) => problem.variable), ['AI_REASONING']);
  });

  it('rejects aliases for both reasoning switches', () => {
    for (const alias of ['enabled', 'on', 'true', 'yes', '1', 'auto']) {
      assert.equal(parseSimpleReasoning(alias), null, alias);
    }
    const settings = reasoningSettings({ AI_REASONING_FREE_MODELS: 'true' });
    assert.deepEqual(settings.freePolicy, { mode: 'off' });
    assert.match(settings.freeProblem, /AI_REASONING_FREE_MODELS must be enable or disable/);

    const problems = reasoningConfigProblems({
      AI_REASONING_PAID_MODELS: 'on',
      AI_REASONING_FREE_MODELS: 'true',
    });
    assert.deepEqual(
      problems.map((problem) => problem.variable).sort(),
      ['AI_REASONING_FREE_MODELS', 'AI_REASONING_PAID_MODELS'],
    );
  });

  it('sends disabled for a free model and logs the field and source', async () => {
    await withEnv(
      {
        AI_MODEL_OPENROUTER: 'paid/model',
        AI_REASONING_PAID_MODELS: 'enable',
        AI_REASONING_FREE_MODELS: 'disable',
        AI_MAX_OUTPUT_TOKENS: '1200',
      },
      async () => {
        const stub = stubFetch();
        const logs = [];
        const realLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
          await ask('nvidia/free:free');
          assert.deepEqual(stub.bodies[0].thinking, { type: 'disabled' });
          const line = logs.find((entry) => entry.includes('[ai:test] free-model reasoning'));
          assert.ok(line, 'the free-model request must write one line');
          assert.match(line, /reasoning=disabled/);
          assert.match(line, /field=disabled/);
          assert.match(line, /source=AI_REASONING_FREE_MODELS/);
          assert.match(line, /model=nvidia\/free:free/);
        } finally {
          console.log = realLog;
          stub.restore();
        }
      },
    );
  });

  it('enables a free model by omitting the reasoning field, while a paid model follows AI_REASONING_PAID_MODELS', async () => {
    await withEnv(
      {
        AI_MODEL_OPENROUTER: 'paid/model',
        AI_REASONING_PAID_MODELS: 'disable',
        AI_REASONING_FREE_MODELS: 'enable',
        AI_MAX_OUTPUT_TOKENS: '1200',
      },
      async () => {
        const stub = stubFetch();
        const logs = [];
        const realLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
          await ask('nvidia/free:free');
          await ask('paid/model');
          assert.equal('thinking' in stub.bodies[0], false);
          assert.deepEqual(stub.bodies[1].thinking, { type: 'disabled' });
          const line = logs.find((entry) => entry.includes('[ai:test] free-model reasoning'));
          assert.ok(line);
          assert.match(line, /reasoning=enabled/);
          assert.match(line, /field=omitted/);
          assert.match(line, /source=AI_REASONING_FREE_MODELS/);
          const paidLine = logs.find((entry) => entry.includes('[ai:test] paid-model reasoning'));
          assert.ok(paidLine, 'the paid-model request must write one line too');
          assert.match(paidLine, /reasoning=disabled/);
          assert.match(paidLine, /field=disabled/);
          assert.match(paidLine, /source=AI_REASONING_PAID_MODELS/);
          assert.match(paidLine, /model=paid\/model/);
        } finally {
          console.log = realLog;
          stub.restore();
        }
      },
    );
  });

  it('keeps the web switches strict too', () => {
    const enabled = webCapabilities({ AI_WEB_SEARCH: 'enable', AI_WEB_FETCH: 'disable' });
    assert.equal(enabled.searchEnabled, true);
    assert.equal(enabled.fetchEnabled, false);
    assert.equal(enabled.problems.length, 0);

    const invalid = webCapabilities({ AI_WEB_SEARCH: 'true', AI_WEB_FETCH: 'on' });
    assert.equal(invalid.searchEnabled, false);
    assert.equal(invalid.fetchEnabled, false);
    assert.deepEqual(
      invalid.problems.map((problem) => problem.variable).sort(),
      ['AI_WEB_FETCH', 'AI_WEB_SEARCH'],
    );
  });

  it('rejects an invalid reasoning or web switch in production validation', () => {
    const problems = validateProductionConfig({
      MONGODB_URI: 'mongodb://example/test',
      JWT_SECRET: 'x'.repeat(48),
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'not-a-real-key',
      OPENROUTER_BASE_URL: 'https://example.invalid/api',
      AI_MODEL_OPENROUTER: 'paid/model',
      AI_REASONING_PAID_MODELS: 'on',
      AI_REASONING_FREE_MODELS: 'true',
      AI_WEB_SEARCH: 'yes',
      AI_WEB_FETCH: 'no',
    });
    const named = new Set(problems.map((problem) => problem.variable));
    for (const variable of [
      'AI_REASONING_PAID_MODELS',
      'AI_REASONING_FREE_MODELS',
      'AI_WEB_SEARCH',
      'AI_WEB_FETCH',
    ]) {
      assert.ok(named.has(variable), variable);
    }
  });
});