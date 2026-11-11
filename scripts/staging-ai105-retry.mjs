#!/usr/bin/env node
/**
 * AI-105 staging drill — deliberately reproduce an empty output-limit completion
 * against an isolated local OpenRouter-compatible stub, then prove the retry uses
 * a 2,400-token cap with a 1,200-token reasoning budget and returns readable text.
 *
 * WHY A LOCAL STUB, NOT PRODUCTION. The production deployment and its provider
 * configuration must not be broken to reproduce an intermittent upstream failure.
 * This harness starts an HTTP server on 127.0.0.1, points the real OpenRouter
 * provider at it through OPENROUTER_BASE_URL, and runs the real `runAiChat` turn
 * loop. The first response is a 2xx with `stop_reason: max_tokens` and no content
 * (the measured AI-105 shape); the second is a normal text response. The stub
 * records every request body, so the retry's `max_tokens` and `thinking` fields
 * are verified at the wire, not inferred from a mock object.
 *
 * Run from the repository root:
 *   node scripts/staging-ai105-retry.mjs
 *
 * Exit 0 = retry verified, 1 = assertion or stub failure. Nothing is sent to
 * OpenRouter, no real API key is used, and no database connection is required.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

const requests = [];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'staging stub only serves POST /v1/messages' }));
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    requests.push(body);

    const common = {
      id: `msg_staging_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'openai/gpt-oss-20b',
    };

    if (requests.length === 1) {
      // The measured failure: the model spent the whole output cap on hidden
      // reasoning and returned no text. The real wire maps this to AiOutputLimit.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...common,
          content: [],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 11, output_tokens: 1200 },
        }),
      );
      return;
    }

    // The retry answers normally, so the turn must complete with readable text.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...common,
        content: [{ type: 'text', text: 'Staging retry produced a readable answer.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 13, output_tokens: 9 },
      }),
    );
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'staging-dummy-key-not-a-credential';
process.env.OPENROUTER_BASE_URL = baseUrl;
process.env.AI_MODEL_OPENROUTER = 'openai/gpt-oss-20b';
process.env.AI_MAX_OUTPUT_TOKENS = '1200';
process.env.AI_REASONING_PAID_MODELS = 'enable';
process.env.AI_TURN_DEADLINE_MS = '30000';
process.env.AI_EMPTY_RETRY_MAX = '1';

const [{ runAiChat }, { ROLES }] = await Promise.all([
  import('../server/src/services/ai/ai.service.ts'),
  import('../server/src/constants/roles.ts'),
]);

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '));
};

let result;
try {
  result = await runAiChat({
    businessId: 'staging-business',
    userId: 'staging-user',
    role: ROLES.OWNER,
    message: 'say hello in one sentence',
  });
} finally {
  console.warn = originalWarn;
  await new Promise((resolve) => server.close(resolve));
}

const report = {
  staging: 'local-stub-openrouter',
  requests: requests.map((body) => ({
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking ?? null,
  })),
  answer: result?.content ?? null,
  warnings,
};

try {
  assert.equal(requests.length, 2, 'exactly one output-limit retry, never a third call');
  assert.equal(requests[0].max_tokens, 1200, 'the normal turn keeps the configured 1,200 cap');
  assert.equal(requests[1].max_tokens, 2400, 'the retry raises only its own cap to 2,400');
  assert.deepEqual(
    requests[1].thinking,
    { type: 'enabled', budget_tokens: 1200 },
    'the retry reserves 1,200 tokens for reasoning on a paid model',
  );
  assert.equal(result?.content, 'Staging retry produced a readable answer.');
  assert.ok(
    warnings.some((line) => line.includes('AI output limit retry: cap=2400')),
    'the retry logs its raised cap',
  );
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error), ...report }, null, 2));
  process.exitCode = 1;
}
