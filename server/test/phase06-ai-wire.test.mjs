// Phase 06 — OpenRouter wire mapping (no database, no live credentials).
//
// Verifies the OpenRouter provider (an Anthropic-compatible gateway) sends the
// exact /v1/messages payload, carries its key only in the Authorization header,
// sends no client-impersonation headers, parses tool_use/text responses, and
// sanitizes upstream failures so no secret ever reaches the caller. Runs against
// a local HTTP server so it is fully deterministic and offline.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { AiProviderError } from '../src/services/ai/aiErrors.ts';
import { createOpenrouterProvider } from '../src/services/ai/providers/openrouterProvider.ts';

const TEST_KEY = 'or_wire_test_key';
// AI_MODEL_OPENROUTER is required (a gateway has no defensible default model), so
// the stub always supplies one and the payload assertion below names it here.
const TEST_MODEL = 'openrouter/test-model';
const TEST_TOOLS = [
  {
    name: 'getLowStockProducts',
    description: 'Products whose available quantity is at or below their minimum stock.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    },
  },
];

/** Temporarily set (or unset) an env var, returning a restore function. */
function withEnv(key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

let server;
let port;
const requests = [];
// `raw` (a verbatim body) and `contentType` exist so the non-JSON branch is
// reachable from a test at all; unset, the stub behaves exactly as before.
// `headers` carries any extra response header (e.g. a `Location`) that the
// Phase 31D.6 non-2xx diagnostic reports.
let respond = { status: 200, json: {}, raw: undefined, contentType: 'application/json', headers: {} };

async function listen() {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { _raw: raw };
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(respond.status, { 'content-type': respond.contentType, ...respond.headers });
      res.end(respond.raw !== undefined ? respond.raw : JSON.stringify(respond.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}

function lastRequest() {
  return requests[requests.length - 1];
}

function providerFor(baseUrl) {
  const restoreKey = withEnv('OPENROUTER_API_KEY', TEST_KEY);
  const restoreBase = withEnv('OPENROUTER_BASE_URL', baseUrl);
  const restoreModel = withEnv('AI_MODEL_OPENROUTER', TEST_MODEL);
  try {
    return createOpenrouterProvider();
  } finally {
    restoreKey();
    restoreBase();
    restoreModel();
  }
}

before(async () => {
  await listen();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
  respond = { status: 200, json: {}, raw: undefined, contentType: 'application/json', headers: {} };
});

/** Run a provider call with console.error captured, returning logs + the error. */
async function completeCapturingLogs(provider) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map((a) => String(a)).join(' '));
  try {
    await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TEST_TOOLS });
    return { lines, err: null };
  } catch (err) {
    return { lines, err };
  } finally {
    console.error = original;
  }
}

function diagnosticsLine(lines) {
  return lines.find((l) => l.includes('upstream non-JSON diagnostics'));
}

function httpErrorDiagnosticsLine(lines) {
  return lines.find((l) => l.includes('upstream HTTP error diagnostics'));
}

describe('Phase 06 — OpenRouter (Anthropic-compatible) wire mapping', () => {
  it('posts an Anthropic /v1/messages request with Bearer auth and the configured model', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.json = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'getLowStockProducts', input: { limit: 5 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
    };

    const out = await provider.complete({
      system: 'You are read-only.',
      messages: [{ role: 'user', content: 'Any low stock?' }],
      tools: TEST_TOOLS,
    });

    const req = lastRequest();
    assert.equal(new URL(req.url, `http://127.0.0.1:${port}`).pathname, '/v1/messages');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    // Key travels only in the Authorization header.
    assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
    // OpenRouter documents a bare bearer token and nothing else: it requires no
    // anthropic-version, no client fingerprint and no claude-code beta header, so
    // none may be sent.
    assert.equal(req.headers['anthropic-version'], undefined);
    assert.ok(!String(req.headers['user-agent'] ?? '').includes('claude-cli'));
    assert.equal(req.headers['anthropic-beta'], undefined);

    const cfg = aiConfig();
    assert.equal(req.body.model, TEST_MODEL);
    assert.equal(req.body.max_tokens, cfg.maxOutputTokens);
    assert.equal(req.body.system, 'You are read-only.');
    assert.equal(req.body.tools[0].name, 'getLowStockProducts');
    assert.equal(req.body.tools[0].input_schema.type, 'object');
    assert.equal(req.body.messages[req.body.messages.length - 1].role, 'user');

    // tool_use parses back into the neutral contract.
    assert.deepEqual(out.toolCalls, [{ id: 'tu_1', name: 'getLowStockProducts', input: { limit: 5 } }]);
    assert.equal(out.text, '');
    assert.equal(out.model, 'deepseek-v4-flash');
    assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
  });

  it('feeds tool results back as Anthropic tool_result blocks and parses final text', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.json = {
      id: 'msg_2',
      model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: 'Low stock: 3 products.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 130, output_tokens: 11 },
    };

    const out = await provider.complete({
      system: 'You are read-only.',
      messages: [
        { role: 'user', content: 'Any low stock?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'getLowStockProducts', input: { limit: 5 } }],
        },
        {
          role: 'tool',
          name: 'getLowStockProducts',
          toolCallId: 'tu_1',
          content: JSON.stringify({ ok: true, result: { count: 3 } }),
        },
      ],
      tools: TEST_TOOLS,
    });

    const req = lastRequest();
    const [user, assistant, toolResult] = req.body.messages;
    assert.equal(user.role, 'user');
    assert.equal(user.content, 'Any low stock?');
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content[0].type, 'tool_use');
    assert.equal(assistant.content[0].id, 'tu_1');
    assert.equal(toolResult.role, 'user', 'tool results are wrapped in a user message');
    assert.equal(toolResult.content[0].type, 'tool_result');
    assert.equal(toolResult.content[0].tool_use_id, 'tu_1');
    assert.equal(toolResult.content[0].content, JSON.stringify({ ok: true, result: { count: 3 } }));

    assert.equal(out.text, 'Low stock: 3 products.');
    assert.deepEqual(out.toolCalls, []);
    assert.equal(out.model, 'deepseek-v4-flash');
  });

  it('does not double-append /v1/messages when the base URL already ends with it', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/v1/messages`);
    respond.json = { id: 'm', model: 'deepseek-v4-flash', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

    await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TEST_TOOLS,
    });

    const req = lastRequest();
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    assert.equal(path, '/v1/messages');
    assert.ok(!path.endsWith('/v1/messages/v1/messages'));
  });

  it('maps upstream HTTP errors to an AiProviderError whose body leaks nothing', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 401;
    respond.json = { error: { type: 'authentication_error', message: `invalid api key ${TEST_KEY} (secret)` } };

    await assert.rejects(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TEST_TOOLS }),
      (err) => {
        assert.ok(err instanceof AiProviderError);
        assert.ok(!err.message.includes(TEST_KEY), 'api key must never appear in the error message');
        assert.ok(!err.message.includes('secret'));
        return true;
      }
    );
  });

  it('maps network failures to a generic AiProviderError with no key echo', async () => {
    // Point at a closed loopback port so fetch fails fast with ECONNREFUSED.
    const provider = providerFor('http://127.0.0.1:9');
    await assert.rejects(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TEST_TOOLS }),
      (err) => {
        assert.ok(err instanceof AiProviderError);
        assert.ok(!err.message.includes(TEST_KEY));
        assert.match(err.message, /could not be reached/);
        return true;
      }
    );
  });

  // --- Phase 31D.3 temporary non-JSON diagnostics ---------------------------

  it('classifies an HTML non-JSON body and still rejects with AiProviderError', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    const html = '<!DOCTYPE html><html><body>gateway</body></html>';
    respond.status = 200;
    respond.contentType = 'text/html';
    respond.raw = html;

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError, 'non-JSON still becomes an AiProviderError');
    assert.match(err.message, /unexpected response/);

    const line = diagnosticsLine(lines);
    assert.ok(line, 'diagnostics are generated');
    assert.match(line, /status=200/);
    assert.match(line, /contentType=text\/html/);
    assert.ok(line.includes(`bodyLength=${html.length}`));
    assert.match(line, /classification=HTML/);
    assert.match(line, /bodyPrefix="<!DOCTYPE html>/);
  });

  it('classifies an empty 2xx body as EMPTY', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 200;
    respond.contentType = 'application/json';
    respond.raw = '';

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = diagnosticsLine(lines);
    assert.match(line, /bodyLength=0/);
    assert.match(line, /classification=EMPTY/);
  });

  it('classifies an SSE body as SSE', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 200;
    respond.contentType = 'text/event-stream';
    respond.raw = 'data: {"type":"message_start"}\n\n';

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    assert.match(diagnosticsLine(lines), /classification=SSE/);
  });

  it('withholds a body prefix that looks like credential material', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    const body = '<html>Authorization: Bearer sk-live-abc123XYZ</html>';
    respond.status = 200;
    respond.contentType = 'text/html';
    respond.raw = body;

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = diagnosticsLine(lines);
    assert.match(line, /WITHHELD/);
    assert.ok(!line.includes('abc123XYZ'), 'secret material must never be logged');
    assert.ok(!line.includes('sk-live'), 'secret material must never be logged');
    // The non-secret classifications survive the withholding.
    assert.match(line, /classification=HTML/);
    assert.ok(line.includes(`bodyLength=${body.length}`));
  });

  // --- Phase 31D.6 temporary non-2xx diagnostics ----------------------------

  it('captures the status, headers and body of a 401 carrying JSON', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    const payload = JSON.stringify({ error: { message: 'invalid credentials' } });
    respond.status = 401;
    respond.contentType = 'application/json';
    respond.raw = payload;

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = httpErrorDiagnosticsLine(lines);
    assert.ok(line, 'non-2xx diagnostics are generated');
    assert.match(line, /status=401/);
    assert.match(line, /contentType=application\/json/);
    assert.match(line, /contentLength=/);
    assert.ok(line.includes(`bodyLength=${payload.length}`));
    assert.match(line, /classification=JSON_LIKE/);
    assert.match(line, /invalid credentials/);
  });

  it('reports a Location header and classifies a 401 text body as TEXT', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 401;
    respond.contentType = 'text/plain';
    respond.raw = 'Unauthorized';
    respond.headers = { location: 'https://openrouter.ai/api/v1/messages' };

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = httpErrorDiagnosticsLine(lines);
    assert.match(line, /location=https:\/\/openrouter\.ai\/api\/v1\/messages/);
    assert.match(line, /classification=TEXT/);
    assert.match(line, /Unauthorized/);
  });

  it('classifies a 401 HTML body as HTML', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    const html = '<!DOCTYPE html><html><body>denied</body></html>';
    respond.status = 401;
    respond.contentType = 'text/html';
    respond.raw = html;

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = httpErrorDiagnosticsLine(lines);
    assert.match(line, /status=401/);
    assert.match(line, /classification=HTML/);
    assert.ok(line.includes(`bodyLength=${html.length}`));
    assert.match(line, /bodyPrefix="<!DOCTYPE html>/);
  });

  it('withholds a 401 body prefix that looks like credential material', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 401;
    respond.contentType = 'text/plain';
    respond.raw = 'Bearer sk-live-abc123XYZ rejected';

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    const line = httpErrorDiagnosticsLine(lines);
    assert.match(line, /WITHHELD/);
    assert.ok(!line.includes('abc123XYZ'), 'secret material must never be logged');
    assert.ok(!line.includes('sk-live'), 'secret material must never be logged');
    // The non-secret fields survive the withholding.
    assert.match(line, /status=401/);
    assert.match(line, /classification=TEXT/);
  });

  it('leaves the non-2xx error mapping and the status line unchanged', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 401;
    respond.contentType = 'application/json';
    respond.raw = JSON.stringify({ error: { message: 'invalid credentials' } });

    const { lines, err } = await completeCapturingLogs(provider);

    assert.ok(err instanceof AiProviderError);
    assert.equal(err.message, 'The AI service returned an error. Please try again.');
    assert.ok(!err.message.includes('invalid credentials'), 'the upstream body never reaches the client');
    // The pre-existing one-line status log is still emitted, ahead of the detail.
    assert.ok(lines.includes('AI provider openrouter upstream HTTP 401'));
  });

  it('parses a BOM-prefixed JSON body exactly as res.json() did', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}`);
    respond.status = 200;
    respond.contentType = 'application/json';
    respond.raw =
      String.fromCharCode(0xfeff) +
      JSON.stringify({
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      });

    const out = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TEST_TOOLS,
    });

    assert.equal(out.text, 'ok');
  });
});
