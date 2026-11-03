// OpenRouter provider validation (server-side).
//
// OpenRouter is the supported Anthropic-compatible gateway provider. This suite
// validates it against a local HTTP stub so it is fully deterministic, offline,
// and needs no OpenRouter credential.
//
// Covered here:
//   - provider selection + the production fail-fast contract for its env vars
//   - /v1/messages URL construction from OPENROUTER_BASE_URL
//   - Bearer-only authentication, and the ABSENCE of the claude-cli / claude-code
//     client-fingerprint headers some gateway services require
//   - Anthropic request/response mapping, tool-call parsing, error mapping
//   - the existing orchestration loop (runAiChat) driven through this provider
//     (DB-free: only tool paths that decide before the database are used here)
//   - the real 9 read-only tools executed over MongoDB (DB-backed suite below)
//
// It does NOT exercise a live OpenRouter endpoint: without a real
// OPENROUTER_API_KEY in the environment no runtime call is made and none is
// claimed. The stub stands in for the gateway, so everything asserted here is
// about what Inventory AI SENDS and how it INTERPRETS the reply.

import { it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { AI_OUTPUT_LIMIT, AiNotConfigured, AiProviderError, AiOutputLimit, AiQuotaExceeded } from '../src/services/ai/aiErrors.ts';
import { createOpenrouterProvider } from '../src/services/ai/providers/openrouterProvider.ts';
import { providerRequiredEnv, selectProvider } from '../src/services/ai/providers/index.ts';
import { validateProductionConfig } from '../src/config/validateConfig.ts';
import { AI_TOOL_DEFS } from '../src/services/ai/tools.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { ROLES } from '../src/constants/roles.ts';
import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { unitSuite, dbSuite } from './testEnv.mjs';

const TEST_KEY = 'or_wire_test_key';
const MODEL = 'test-vendor/tool-capable-model';

/** The shipped read-only catalogue, pinned by name so a rename cannot slip by. */
const EXPECTED_TOOLS = [
  'searchProducts',
  // AI-45: everyday discovery across name, brand and description.
  'findProducts',
  // AI-46: catalogue contents and recorded-data coverage.
  'getCatalogOverview',
  'getProduct',
  'getInventory',
  'getLowStockProducts',
  'getOutOfStockProducts',
  'getInventorySummary',
  'getInventoryHistory',
  'getProductsByLocation',
  'getReorderNeededProducts',
  // AI-14: the two reference lists the id-taking tools needed to be usable.
  'listLocations',
  'listCategories',
  // AI-44: recorded brands, one read for "what brands do we carry".
  'listBrands',
  // AI-23: the per-location breakdown, so a comparison is one lookup rather than one per
  // shelf. Listed here because this array is the wire-level statement of what ships.
  'getLocationBreakdown',
];

const { dbOk, baseUrl, server: appServer } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

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

/**
 * Build the provider with the three OpenRouter variables set, pinned for the
 * WHOLE TEST rather than only for the construction call.
 *
 * The provider does not freeze all of its configuration at construction time:
 * anthropicWire.ts reads the API key once, but resolves the model per request
 * (`aiConfig()[modelKey] || defaultModel`), and aiConfig() reads process.env
 * lazily. Restoring the values the moment the provider is built would therefore
 * leave complete() reading whatever AI_MODEL_OPENROUTER the ambient environment
 * holds — and this file imports support.mjs, which imports `dotenv/config`, so on
 * a developer machine that is the real server/.env model (the production one)
 * rather than the stub's. Restoring after the test keeps the suite deterministic
 * and leaves it owning its own inputs.
 */
let pendingRestores = [];

function providerFor(base, { key = TEST_KEY, model = MODEL } = {}) {
  pendingRestores.push(
    withEnv('OPENROUTER_API_KEY', key),
    withEnv('OPENROUTER_BASE_URL', base),
    withEnv('AI_MODEL_OPENROUTER', model)
  );
  return createOpenrouterProvider();
}

/** Undo, in reverse, every env value this file pinned; never leaks a stub value. */
afterEach(() => {
  [...pendingRestores].reverse().forEach((r) => r());
  pendingRestores = [];
});

// ---------------------------------------------------------------------------
// Local OpenRouter stub: one record per received request, scripted responses.
// ---------------------------------------------------------------------------
let server;
let port;
const requests = [];
let responder = () => ({ status: 200, json: {} });

function lastRequest() {
  return requests[requests.length - 1];
}

/**
 * Every tool_result block the loop sent back, in order.
 *
 * The orchestration loop pushes ONE neutral message per tool call; the Anthropic
 * mapping batches ADJACENT results into a single `user` message (AI-22), so a turn
 * with parallel calls arrives as one message carrying N blocks. This helper scans
 * every message rather than the last one on purpose: it must keep seeing every
 * result whichever shape the mapping produces, which is what makes it usable as the
 * assertion for both.
 */
function toolResultBlocks(body) {
  const out = [];
  for (const m of body?.messages ?? []) {
    if (Array.isArray(m?.content)) out.push(...m.content.filter((b) => b?.type === 'tool_result'));
  }
  return out;
}

/** The parsed JSON payloads of those tool results, in order. */
function parsedToolResults(body) {
  return toolResultBlocks(body).map((b) => {
    try {
      return JSON.parse(b.content);
    } catch {
      return null;
    }
  });
}

/** The assistant tool_use blocks of the previous request's last message. */
function assistantToolUseBlocks(body) {
  for (let i = (body?.messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = body.messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      const calls = m.content.filter((b) => b?.type === 'tool_use');
      if (calls.length) return calls;
    }
  }
  return [];
}

const okText = (text, extra = {}) => ({
  status: 200,
  json: {
    id: 'msg_text',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  },
});

const okTools = (calls) => ({
  status: 200,
  json: {
    id: 'msg_tools',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 7 },
  },
});

before(async () => {
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
      const turn = requests.length + 1;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
      const out = responder(body, turn);
      res.writeHead(out.status ?? 200, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await tracker.cleanup();
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

beforeEach(() => {
  requests.length = 0;
  responder = () => okText('ok');
});

/** Select the OpenRouter provider for the loop tests, pointing at the stub. */
function useOpenrouter({ model = MODEL, key = TEST_KEY } = {}) {
  return [
    withEnv('AI_PROVIDER', 'openrouter'),
    withEnv('OPENROUTER_API_KEY', key),
    withEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}`),
    withEnv('AI_MODEL_OPENROUTER', model),
  ];
}

function restoreAll(restores) {
  [...restores].reverse().forEach((r) => r());
}

/**
 * Run a call with console.error AND console.warn silenced. The failure paths
 * under test log upstream diagnostics (by design, for operators); those lines are
 * noise here. `warn` joined in AI-10, which logs the output limit at the provider
 * layer rather than at the HTTP layer — that line is asserted where it belongs
 * (`AI10-output-limit-not-an-outage.test.mjs`) and suppressed here.
 */
async function quiet(fn) {
  const original = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// Selection, configuration, and the production fail-fast contract.
// ---------------------------------------------------------------------------
unitSuite('OpenRouter provider — selection and configuration', () => {
  it('declares exactly the three environment variables it needs', () => {
    assert.deepEqual(providerRequiredEnv('openrouter'), [
      'OPENROUTER_API_KEY',
      'OPENROUTER_BASE_URL',
      'AI_MODEL_OPENROUTER',
    ]);
  });

  it('is selected by AI_PROVIDER=openrouter when fully configured', () => {
    const restores = useOpenrouter();
    try {
      const p = selectProvider();
      assert.equal(p.name, 'openrouter');
      assert.equal(typeof p.complete, 'function');
    } finally {
      restoreAll(restores);
    }
  });

  it('without OPENROUTER_API_KEY it refuses to build (503, never a crash)', () => {
    const restores = [
      withEnv('AI_PROVIDER', 'openrouter'),
      withEnv('OPENROUTER_API_KEY', undefined),
      withEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api'),
      withEnv('AI_MODEL_OPENROUTER', MODEL),
    ];
    try {
      assert.throws(() => selectProvider(), (err) => {
        assert.ok(err instanceof AiNotConfigured);
        assert.match(err.message, /OPENROUTER_API_KEY/);
        return true;
      });
    } finally {
      restoreAll(restores);
    }
  });

  it('with a key but no base URL it refuses to build', () => {
    const restores = [
      withEnv('AI_PROVIDER', 'openrouter'),
      withEnv('OPENROUTER_API_KEY', TEST_KEY),
      withEnv('OPENROUTER_BASE_URL', undefined),
      withEnv('AI_MODEL_OPENROUTER', MODEL),
    ];
    try {
      assert.throws(() => selectProvider(), (err) => {
        assert.ok(err instanceof AiNotConfigured);
        assert.match(err.message, /OPENROUTER_BASE_URL/);
        return true;
      });
    } finally {
      restoreAll(restores);
    }
  });

  it('with a key and base URL but NO model it refuses to build (no guessing)', () => {
    const restores = [
      withEnv('AI_PROVIDER', 'openrouter'),
      withEnv('OPENROUTER_API_KEY', TEST_KEY),
      withEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api'),
      withEnv('AI_MODEL_OPENROUTER', undefined),
    ];
    try {
      assert.throws(() => selectProvider(), (err) => {
        assert.ok(err instanceof AiNotConfigured);
        assert.match(err.message, /AI_MODEL_OPENROUTER/);
        return true;
      });
    } finally {
      restoreAll(restores);
    }
  });

  it('an unsupported provider name now lists openrouter among the supported ones', () => {
    const restore = withEnv('AI_PROVIDER', 'gpt-9');
    try {
      assert.throws(() => selectProvider(), (err) => {
        assert.ok(err instanceof AiNotConfigured);
        assert.match(err.message, /not supported/);
        assert.match(err.message, /openrouter/);
        return true;
      });
    } finally {
      restore();
    }
  });

  it('production config validation names every missing OpenRouter variable', () => {
    const problems = validateProductionConfig({
      MONGODB_URI: 'mongodb://example/test',
      JWT_SECRET: 'x'.repeat(48),
      AI_PROVIDER: 'openrouter',
    });
    const named = problems.map((p) => p.variable);
    assert.ok(named.includes('OPENROUTER_API_KEY'));
    assert.ok(named.includes('OPENROUTER_BASE_URL'));
    assert.ok(named.includes('AI_MODEL_OPENROUTER'));
  });

  it('production config validation passes when OpenRouter is fully configured', () => {
    const problems = validateProductionConfig({
      MONGODB_URI: 'mongodb://example/test',
      JWT_SECRET: 'x'.repeat(48),
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api',
      AI_MODEL_OPENROUTER: MODEL,
    });
    const aiProblems = problems.filter(
      (p) => p.variable === 'AI_PROVIDER' || p.variable.startsWith('OPENROUTER_') || p.variable === 'AI_MODEL_OPENROUTER'
    );
    assert.deepEqual(aiProblems, []);
  });
});

// ---------------------------------------------------------------------------
// Wire mapping against the local stub — neither a database nor a key is needed.
// ---------------------------------------------------------------------------
unitSuite('OpenRouter provider — Anthropic /v1/messages wire mapping', () => {
  it('appends /v1/messages to the documented base (https://openrouter.ai/api)', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => okText('hi');
    await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(lastRequest().url, '/api/v1/messages');
    assert.equal(lastRequest().method, 'POST');
  });

  it('tolerates a trailing slash and does not double-append /v1/messages', async () => {
    responder = () => okText('hi');
    const a = providerFor(`http://127.0.0.1:${port}/api/`);
    await a.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(lastRequest().url, '/api/v1/messages');

    const b = providerFor(`http://127.0.0.1:${port}/api/v1/messages`);
    await b.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(lastRequest().url, '/api/v1/messages');
  });

  it('authenticates with Bearer only and sends no impersonation headers', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => okText('hi');
    await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });

    const { headers } = lastRequest();
    assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(headers['x-api-key'], undefined, 'OpenRouter uses Authorization, not x-api-key');
    assert.equal(headers['anthropic-beta'], undefined, 'no claude-code beta header may be sent');
    assert.equal(headers['anthropic-version'], undefined, 'not required by the documented endpoint');
    assert.ok(
      !String(headers['user-agent'] ?? '').includes('claude-cli'),
      'no client-fingerprint header may be sent'
    );
    // The key must appear in no other header value.
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'authorization') continue;
      assert.ok(!String(value).includes(TEST_KEY), `key leaked into header ${name}`);
    }
  });

  it('sends the configured model, token cap, system prompt, tools as input_schema and mapped messages', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => okText('hi');
    await provider.complete({
      system: 'You are the read-only inventory assistant.',
      messages: [
        { role: 'user', content: 'Any low stock?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'getLowStockProducts', input: { limit: 5 } }] },
        { role: 'tool', name: 'getLowStockProducts', toolCallId: 'tu_1', content: JSON.stringify({ ok: true }) },
      ],
      tools: AI_TOOL_DEFS,
    });

    const { body } = lastRequest();
    const cfg = aiConfig();
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, cfg.maxOutputTokens);
    assert.equal(body.system, 'You are the read-only inventory assistant.');

    // Every shipped tool travels with the JSON Schema under input_schema.
    // (Compared as a set: the catalogue's own order is tools.ts's to define.)
    assert.equal(body.tools.length, EXPECTED_TOOLS.length);
    assert.deepEqual([...body.tools.map((t) => t.name)].sort(), [...EXPECTED_TOOLS].sort());
    for (const tool of body.tools) {
      assert.equal(tool.parameters, undefined, 'Anthropic tools use input_schema, not parameters');
      assert.equal(tool.input_schema.type, 'object');
      assert.equal(tool.input_schema.additionalProperties, false, 'strict schemas must survive the mapping');
      assert.equal(typeof tool.description, 'string');
    }

    const [user, assistant, toolResult] = body.messages;
    assert.deepEqual(user, { role: 'user', content: 'Any low stock?' });
    assert.equal(assistant.content[0].type, 'tool_use');
    assert.equal(assistant.content[0].id, 'tu_1');
    assert.equal(toolResult.role, 'user');
    assert.equal(toolResult.content[0].type, 'tool_result');
    assert.equal(toolResult.content[0].tool_use_id, 'tu_1');
  });

  it('parses text, tool_use, usage and the model label', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => ({
      status: 200,
      json: {
        id: 'msg_1',
        model: MODEL,
        content: [
          { type: 'text', text: 'Here: ' },
          { type: 'tool_use', id: 'tu_9', name: 'getInventorySummary', input: {} },
          { type: 'text', text: '2 items.' },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    const out = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: AI_TOOL_DEFS });
    assert.equal(out.text, 'Here: 2 items.');
    assert.deepEqual(out.toolCalls, [{ id: 'tu_9', name: 'getInventorySummary', input: {} }]);
    assert.equal(out.model, MODEL);
    assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
  });

  it('parses parallel tool calls in order and names the model the REQUEST asked for when the body omits one (AI-12)', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => ({
      status: 200,
      json: {
        id: 'msg_p',
        content: [
          { type: 'tool_use', id: 'a', name: 'getInventorySummary', input: {} },
          { type: 'tool_use', id: 'b', name: 'getLowStockProducts', input: { limit: 5 } },
        ],
        stop_reason: 'tool_use',
      },
    });
    const out = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: AI_TOOL_DEFS });
    assert.deepEqual(out.toolCalls.map((c) => c.id), ['a', 'b']);
    // AI-12 changed this from the provider label `'openrouter'` to the model the request
    // named. The label was not a model, and because an empty completion is exactly a body
    // that omits `model`, it hid the model on every failing turn in the stored record.
    assert.equal(out.model, MODEL);
    assert.equal(out.usage, null);
  });

  it('survives a malformed response body without throwing (empty content / non-object input)', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => ({
      status: 200,
      json: { model: MODEL, content: 'not-an-array', stop_reason: 'end_turn' },
    });
    const out = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(out.text, '');
    assert.deepEqual(out.toolCalls, []);

    responder = () => ({
      status: 200,
      json: { content: [{ type: 'tool_use', id: 'x', name: 'getProduct', input: 'oops' }], stop_reason: 'tool_use' },
    });
    const out2 = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.deepEqual(out2.toolCalls, [{ id: 'x', name: 'getProduct', input: {} }]);
  });

  it('maps a max_tokens stop with no content to the OUTPUT LIMIT, not to a provider error (AI-10)', async () => {
    // AI-10 changed this classification, and the change IS the fix: this used to be an
    // `AiProviderError`, which the controller maps to 502 AI_UNAVAILABLE — "temporarily
    // unavailable, please try again in a moment" for a 2xx that answered fine, with the
    // model having spent its budget. Asserted in both directions, because "not a provider
    // error" is the whole content of the change.
    const provider = providerFor(`http://127.0.0.1:${port}/api`);
    responder = () => ({
      status: 200,
      json: { model: MODEL, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 900, output_tokens: 800 } },
    });
    await quiet(() =>
      assert.rejects(
        provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
        (err) => {
          assert.ok(err instanceof AiOutputLimit);
          assert.equal(err.code, AI_OUTPUT_LIMIT);
          assert.equal(err instanceof AiProviderError, false, 'nothing upstream failed: the gateway answered 2xx');
          assert.match(err.message, /out of room|length limit/i);
          assert.doesNotMatch(err.message, /unavailable|in a moment/i);
          return true;
        }
      )
    );
  });

  // AI-6 SPLIT. This test used to assert one thing about five statuses: every
  // non-2xx becomes an `AiProviderError`. 429 and 402 no longer do, deliberately —
  // the gateway was not failing, it was refusing because an allowance was spent,
  // and reporting that as a provider outage produced *"temporarily unavailable,
  // please try again in a moment"*, an action that cannot refill a spent
  // allowance (§27BF measured it as the DOMINANT failure at this tier).
  //
  // Coverage is therefore not reduced: the two statuses moved to the test below,
  // where they are asserted more strongly — the class AND the code — while the
  // key-leak check runs in both. `phase06-ai-wire.test.mjs` (protected) still
  // pins the same contract for 401, and it never sent a 429 or a 402.
  it('maps upstream failures to safe AiProviderErrors that never echo the key', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);

    for (const [status, contentType, raw] of [
      [401, 'application/json', JSON.stringify({ error: { message: `bad key ${TEST_KEY}` } })],
      [500, 'text/html', '<!DOCTYPE html><html>gateway</html>'],
      [200, 'text/event-stream', 'data: {"type":"message_start"}\n\n'],
    ]) {
      responder = () => ({ status, contentType, raw });
      await quiet(() =>
        assert.rejects(
          provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
          (err) => {
            assert.ok(err instanceof AiProviderError, `${status} must become an AiProviderError`);
            assert.ok(!(err instanceof AiQuotaExceeded), `${status} is an outage, not a reached limit`);
            assert.ok(!err.message.includes(TEST_KEY), 'the key must never reach the caller');
            return true;
          }
        )
      );
    }
  });

  it('maps a REACHED LIMIT (429 / 402) to an AiQuotaExceeded, never as an outage', async () => {
    const provider = providerFor(`http://127.0.0.1:${port}/api`);

    for (const [status, message] of [
      [429, 'rate limit exceeded'],
      [402, 'insufficient credits'],
    ]) {
      responder = () => ({
        status,
        contentType: 'application/json',
        raw: JSON.stringify({ error: { message: `${message} ${TEST_KEY}` } }),
      });
      await quiet(() =>
        assert.rejects(
          provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
          (err) => {
            assert.ok(err instanceof AiQuotaExceeded, `${status} must become an AiQuotaExceeded`);
            assert.equal(err.code, 'AI_QUOTA_EXCEEDED', `${status} must carry the quota code`);
            assert.ok(!err.message.includes(TEST_KEY), 'the key must never reach the caller');
            // The sentence must not prescribe a wait that cannot help.
            assert.doesNotMatch(err.message, /in a moment/i);
            return true;
          }
        )
      );
    }
  });

  it('maps an unreachable endpoint to a generic network error', async () => {
    const provider = providerFor('http://127.0.0.1:9/api');
    await quiet(() =>
      assert.rejects(
        provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
        (err) => {
          assert.ok(err instanceof AiProviderError);
          assert.match(err.message, /could not be reached/);
          assert.ok(!err.message.includes(TEST_KEY));
          return true;
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// The existing orchestration loop, driven through this provider (DB-free).
// Every tool used here decides BEFORE the database: an unknown name, a role
// denial, or a schema violation. Real tool execution is the DB suite below.
// ---------------------------------------------------------------------------
unitSuite('OpenRouter provider — AI loop compatibility (DB-free)', () => {
  const ctx = { businessId: '64b000000000000000000001', userId: '64b000000000000000000002', role: ROLES.OWNER };

  it('returns provider text unchanged for a conversational question (1 iteration, no tools)', async () => {
    const restores = useOpenrouter();
    try {
      responder = () => okText('Hello! I can help with your inventory.');
      const out = await runAiChat({ ...ctx, message: 'Hi there' });
      assert.equal(out.content, 'Hello! I can help with your inventory.');
      assert.deepEqual(out.toolsUsed, []);
      assert.equal(out.iterations, 1);
      assert.equal(out.model, MODEL);
      assert.equal(requests.length, 1);
    } finally {
      restoreAll(restores);
    }
  });

  it('executes a tool call, feeds the result back, and continues to a final answer', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1
          ? okTools([{ id: 'c1', name: 'createProduct', input: { name: 'Nope' } }])
          : okText('That is not available in this version.');
      const out = await runAiChat({ ...ctx, message: 'Create a product' });
      assert.equal(out.iterations, 2);
      assert.deepEqual(out.toolsUsed, ['createProduct']);
      assert.match(out.content, /not available/);

      // The continuation carries the assistant tool_use and a matching tool_result.
      const second = requests[1].body;
      assert.deepEqual(assistantToolUseBlocks(second).map((b) => b.id), ['c1']);
      const results = parsedToolResults(second);
      assert.equal(results.length, 1);
      assert.equal(results[0].code, 'TOOL_NOT_FOUND');
      assert.equal(toolResultBlocks(second)[0].tool_use_id, 'c1');
    } finally {
      restoreAll(restores);
    }
  });

  it('soft-denies malformed tool arguments without touching the database', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1
          ? okTools([{ id: 'm1', name: 'getLowStockProducts', input: { limit: 'many', bogus: true } }])
          : okText('I could not read that.');
      const out = await runAiChat({ ...ctx, message: 'low stock?' });
      assert.equal(out.iterations, 2);
      const [result] = parsedToolResults(requests[1].body);
      assert.equal(result.code, 'TOOL_INVALID_ARGUMENTS');
      assert.match(result.error, /limit/);
    } finally {
      restoreAll(restores);
    }
  });

  it('threads parallel tool calls in one turn, each with its own result', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1
          ? okTools([
              { id: 'p1', name: 'getInventorySummary', input: { plantedBusinessId: 'attacker' } },
              { id: 'p2', name: 'writeSomething', input: {} },
            ])
          : okText('done');
      const out = await runAiChat({ ...ctx, message: 'summarize and write' });
      assert.equal(out.iterations, 2);
      assert.deepEqual(out.toolsUsed, ['getInventorySummary', 'writeSomething']);

      const second = requests[1].body;
      assert.deepEqual(assistantToolUseBlocks(second).map((b) => b.id), ['p1', 'p2']);
      const blocks = toolResultBlocks(second);
      assert.deepEqual(blocks.map((b) => b.tool_use_id), ['p1', 'p2']);
      // AI-22 — and they arrive BATCHED: one user message carrying both results, which is
      // the canonical shape rather than two consecutive user turns the gateway has to
      // merge. Asserted here, at the HTTP level, as well as in the wire suite.
      const batch = second.messages.filter((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'));
      assert.equal(batch.length, 1, 'parallel results travel as ONE tool_result message');
      assert.equal(batch[0].content.filter((b) => b?.type === 'tool_result').length, 2);
      const results = parsedToolResults(second);
      // A smuggled businessId is an unknown argument; a write-shaped tool does not exist.
      assert.equal(results[0].code, 'TOOL_INVALID_ARGUMENTS');
      assert.equal(results[1].code, 'TOOL_NOT_FOUND');
    } finally {
      restoreAll(restores);
    }
  });

  it('preserves the role permission gate through the new provider', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1 ? okTools([{ id: 'r1', name: 'getInventorySummary', input: {} }]) : okText('denied for you');
      const out = await runAiChat({ ...ctx, role: ROLES.STAFF, message: 'how is my inventory' });
      const [result] = parsedToolResults(requests[1].body);
      assert.equal(result.code, 'TOOL_FORBIDDEN');
      assert.equal(out.iterations, 2);
    } finally {
      restoreAll(restores);
    }
  });

  it('bounds a model that never stops calling tools by AI_MAX_TOOL_ITERATIONS', async () => {
    const restores = [...useOpenrouter(), withEnv('AI_MAX_TOOL_ITERATIONS', '2')];
    try {
      responder = () => okTools([{ id: 'loop', name: 'createProduct', input: {} }]);
      const out = await runAiChat({ ...ctx, message: 'go forever' });
      assert.equal(out.iterations, 2);
      assert.equal(requests.length, 2);
      assert.match(out.content, /could not finish that request within the allowed number of steps/);
    } finally {
      restoreAll(restores);
    }
  });

  it('surfaces a truncated (max_tokens) reply as the output limit, not as empty text and not as an outage (AI-10)', async () => {
    const restores = useOpenrouter();
    try {
      responder = () => ({
        status: 200,
        json: { model: MODEL, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1200, output_tokens: 800 } },
      });
      await quiet(() =>
        assert.rejects(runAiChat({ ...ctx, message: 'a very long question' }), (err) => {
          assert.equal(err.code, AI_OUTPUT_LIMIT);
          assert.equal(err instanceof AiProviderError, false, 'a limit is not an outage');
          assert.ok(!err.message.includes(TEST_KEY));
          return true;
        })
      );
    } finally {
      restoreAll(restores);
    }
  });

  it('maps a provider HTTP failure to a safe AiProviderError (no key, no upstream body)', async () => {
    const restores = useOpenrouter();
    try {
      responder = () => ({ status: 502, contentType: 'application/json', raw: JSON.stringify({ error: { message: `bad ${TEST_KEY}` } }) });
      await quiet(() =>
        assert.rejects(runAiChat({ ...ctx, message: 'hi' }), (err) => {
          assert.ok(err instanceof AiProviderError);
          assert.equal(err.message, 'The AI service returned an error. Please try again.');
          assert.ok(!err.message.includes(TEST_KEY));
          return true;
        })
      );
    } finally {
      restoreAll(restores);
    }
  });

  it('carries Cebuano/Bisaya text byte-identically in both directions', async () => {
    const restores = useOpenrouter();
    try {
      const question = 'Pila ka produkto ang nahabilin sa akong bodega?';
      const answer = 'Aduna kay 3 ka produkto nga ubos ang stock: saging, semento, ug mantika.';
      responder = () => okText(answer);
      const out = await runAiChat({ ...ctx, message: question });
      // The prompt reaches the provider unmodified (UTF-8, no ASCII-fication).
      assert.equal(requests[0].body.messages[0].content, question);
      assert.ok(!requests[0].body.system.toLowerCase().includes('english only'));
      // And the reply is returned unmodified.
      assert.equal(out.content, answer);
    } finally {
      restoreAll(restores);
    }
  });

  it('replays prior turns to the provider in order and honours AI_CONTEXT_MESSAGES', async () => {
    const restores = [...useOpenrouter(), withEnv('AI_CONTEXT_MESSAGES', '2')];
    try {
      responder = () => okText('ok');
      await runAiChat({
        ...ctx,
        message: 'bag-o nga pangutana',
        history: [
          { role: 'user', content: 'turn-1' },
          { role: 'assistant', content: 'turn-2' },
          { role: 'user', content: 'turn-3' },
          { role: 'assistant', content: 'turn-4' },
        ],
      });
      const sent = requests[0].body.messages;
      assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user']);
      // User turns carry a plain string; assistant turns carry text blocks.
      assert.equal(sent[0].content, 'turn-3');
      assert.deepEqual(sent[1].content, [{ type: 'text', text: 'turn-4' }]);
      assert.equal(sent[2].content, 'bag-o nga pangutana');
      assert.equal(sent.length, 3, 'AI_CONTEXT_MESSAGES=2 keeps only the last two prior turns');
    } finally {
      restoreAll(restores);
    }
  });
});

// ---------------------------------------------------------------------------
// The real read-only workload: every tool in the catalogue executed over MongoDB.
// ---------------------------------------------------------------------------
dbSuite('OpenRouter provider — real full-catalogue workload', dbOk, () => {
  let owner;
  let productId;
  let locationId;

  before(async () => {
    owner = await registerOwner(api, tracker);
    const product = await api('POST', '/api/products', {
      token: owner.token,
      body: { name: uniqueName('OpenRouter Widget'), sku: 'OR-SKU-1', minimumStock: 5 },
    });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const location = await api('POST', '/api/locations', { token: owner.token, body: { name: uniqueName('OR-Loc') } });
    assert.equal(location.status, 201, JSON.stringify(location.json));
    locationId = location.json.id;

    const stockIn = await api('POST', '/api/inventory/stock-in', {
      token: owner.token,
      body: { productId, locationId, quantity: 7 },
    });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.json));
  });

  /** One valid call per shipped tool, so every executor answers ok:true. */
  function allToolCalls() {
    return [
      { id: 't1', name: 'searchProducts', input: { q: 'OpenRouter' } },
      { id: 't2', name: 'getProduct', input: { id: productId } },
      { id: 't3', name: 'getInventory', input: { productId } },
      { id: 't4', name: 'getLowStockProducts', input: { limit: 5 } },
      { id: 't5', name: 'getOutOfStockProducts', input: { limit: 5 } },
      { id: 't6', name: 'getInventorySummary', input: {} },
      { id: 't7', name: 'getInventoryHistory', input: { productId, limit: 5 } },
      { id: 't8', name: 'getProductsByLocation', input: { locationId, limit: 5 } },
      { id: 't9', name: 'getReorderNeededProducts', input: { limit: 5 } },
      // AI-14: the reference lookups travel and execute like every other tool — this
      // case is the only place the whole catalogue is run in one turn, so a tool that
      // was advertised but could not execute would be caught here and nowhere else.
      { id: 't10', name: 'listLocations', input: { limit: 5 } },
      { id: 't11', name: 'listCategories', input: { limit: 5 } },
      // AI-23: takes no arguments by design, which is also why it is the safest entry in
      // this all-tools case — there is nothing for a model to get wrong.
      { id: 't12', name: 'getLocationBreakdown', input: {} },
      // AI-44: the brand read is part of the shipped catalogue.
      { id: 't13', name: 'listBrands', input: {} },
      // AI-45: the natural search is part of the shipped catalogue.
      { id: 't14', name: 'findProducts', input: { keywords: 'OpenRouter' } },
      // AI-46: the no-argument catalogue coverage read.
      { id: 't15', name: 'getCatalogOverview', input: {} },
    ];
  }

  it('executes every read-only tool in one turn and feeds every result back', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1 ? okTools(allToolCalls()) : okText('Every tool answered.');
      const ctx = { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER };
      const out = await runAiChat({ ...ctx, message: 'Give me a full picture of my inventory' });

      assert.equal(out.iterations, 2);
      assert.deepEqual([...out.toolsUsed].sort(), [...EXPECTED_TOOLS].sort());

      const results = parsedToolResults(requests[1].body);
      assert.equal(results.length, EXPECTED_TOOLS.length);
      for (const [i, result] of results.entries()) {
        assert.equal(result.ok, true, `tool ${allToolCalls()[i].name} failed: ${JSON.stringify(result)}`);
      }

      // The wire carried every tool schema in the same request.
      assert.deepEqual([...requests[0].body.tools.map((t) => t.name)].sort(), [...EXPECTED_TOOLS].sort());
    } finally {
      restoreAll(restores);
    }
  });

  it('rejects malformed arguments against the real tool schemas (no database write)', async () => {
    const restores = useOpenrouter();
    try {
      responder = (_body, turn) =>
        turn === 1 ? okTools([{ id: 'x1', name: 'getProduct', input: { businessId: owner.businessId } }]) : okText('blocked');
      const ctx = { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER };
      await runAiChat({ ...ctx, message: 'show me that product' });
      const [result] = parsedToolResults(requests[1].body);
      assert.equal(result.code, 'TOOL_INVALID_ARGUMENTS');
      assert.match(result.error, /businessId/);
    } finally {
      restoreAll(restores);
    }
  });

  it('answers a Cebuano question from real tool data and leaves the catalog untouched', async () => {
    const restores = useOpenrouter();
    try {
      const before = await api('GET', '/api/products', { token: owner.token });
      const answer = 'Naay 1 ka produkto sa imong lista, ug 7 ka unit ang naa sa stock.';
      responder = (_body, turn) =>
        turn === 1 ? okTools([{ id: 'c1', name: 'getInventorySummary', input: {} }]) : okText(answer);

      const ctx = { businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER };
      const out = await runAiChat({ ...ctx, message: 'Unsa ang kahimtang sa akong inventory?' });

      assert.equal(out.content, answer);
      const [result] = parsedToolResults(requests[1].body);
      assert.equal(result.ok, true, JSON.stringify(result));
      // dashboard.service.summary's own field name (not the mobile alias).
      assert.equal(result.result.totalProducts, 1);
      assert.equal(result.result.totalInventoryQuantity, 7);

      const after = await api('GET', '/api/products', { token: owner.token });
      assert.deepEqual(after.json, before.json, 'the AI layer is read-only');
    } finally {
      restoreAll(restores);
    }
  });

  it('records local per-iteration overhead for the loop through this provider', async (t) => {
    const restores = useOpenrouter();
    try {
      responder = () => okText('timed');
      const started = Date.now();
      await runAiChat({ businessId: owner.businessId, userId: owner.userId, role: ROLES.OWNER, message: 'hi' });
      const elapsed = Date.now() - started;
      t.diagnostic(`local loop overhead (stub, no network): ${elapsed}ms over ${requests.length} request(s)`);
      assert.ok(elapsed >= 0);
      assert.equal(requests.length, 1);
    } finally {
      restoreAll(restores);
    }
  });
});
