#!/usr/bin/env node
/**
 * A local, controllable OpenRouter-shaped provider for AI quota walkthroughs.
 *
 * WHY THIS EXISTS. The quota-refusal device runs used a hand-written scratch server that was never
 * kept, so every future walkthrough had to reconstruct the same wire shape and control endpoint.
 * This is the reusable version: it binds loopback only, never contacts a provider, and can refuse
 * the next completion on demand while streaming normal answers otherwise.
 *
 * USAGE
 *   node scripts/device/quota-stub.mjs
 *   node scripts/device/quota-stub.mjs --port=5999 --log=.scratch/quota-stub.jsonl
 *   node scripts/device/quota-stub.mjs --answer='Hello from the local quota stub.'
 *   node scripts/device/quota-stub.mjs --self-test
 *
 * CONTROL
 *   GET /control              -> { failNext }
 *   GET /control?fail=1       -> refuse the next POST /v1/messages with HTTP 429
 *   GET /control?fail=0       -> clear a pending refusal
 *
 * WIRE
 *   POST /v1/messages with stream=true returns an Anthropic-style SSE answer; stream=false returns
 *   the equivalent JSON body. A controlled refusal always returns the JSON 429 envelope, even when
 *   the request asked to stream, because the refusal happens before any stream opens.
 *
 * SAFETY
 *   - Binds 127.0.0.1 only. Nothing on the network can reach it.
 *   - No credentials are read or required; OPENROUTER_API_KEY can be any local placeholder.
 *   - Logs contain the message text sent by the app. Keep log files under ignored `.scratch/` and
 *     never commit them.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = 'stub/model-1';
const DEFAULT_ANSWER = 'Hello from the local quota stub. I can help with your inventory.';
const REFUSAL_BODY = JSON.stringify({
  error: { message: 'stub daily allowance spent', type: 'rate_limit_error' },
});

const USAGE = `Usage: node scripts/device/quota-stub.mjs [options]

Options:
  --port=<port>      Port to bind on 127.0.0.1 (default: 5999)
  --answer=<text>    Text every successful completion returns
  --log=<path>       Append request records to this file; default is stdout
  --self-test        Exercise control, stream, refusal and JSON paths without a phone
  --help             Show this help

Control the next completion:
  curl -s 'http://127.0.0.1:5999/control?fail=1'
  curl -s 'http://127.0.0.1:5999/control?fail=0'
`;

function sse(answer) {
  return [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: { model: MODEL, usage: { input_tokens: 11, output_tokens: 1 } },
    })}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: answer },
    })}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Create the stub without listening. The returned server is the caller's to start and stop, which
 * is what lets the self-test run on an ephemeral port inside this process.
 */
export function createQuotaStub({ answer = DEFAULT_ANSWER, logger = () => {} } = {}) {
  let failNext = false;
  let completions = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/control') {
      const fail = url.searchParams.get('fail');
      if (fail !== null && fail !== '0' && fail !== '1') {
        json(res, 400, { error: 'fail must be 0 or 1' });
        return;
      }
      if (fail === '1') failNext = true;
      if (fail === '0') failNext = false;
      logger({ method: req.method, path, kind: 'control', failNext });
      json(res, 200, { failNext });
      return;
    }

    if (req.method === 'GET') {
      // Model-health probes reach this shape. They are acknowledged; quota recovery does not need
      // a real model catalogue.
      logger({ method: req.method, path, kind: 'probe' });
      json(res, 200, { object: 'list', data: [] });
      return;
    }

    if (req.method !== 'POST' || path !== '/v1/messages') {
      logger({ method: req.method, path, kind: 'other' });
      json(res, 404, { error: { message: 'not found' } });
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      const messages = Array.isArray(parsed?.messages)
        ? parsed.messages.map((message) => ({ role: message.role, content: message.content }))
        : [];
      completions += 1;
      logger({
        method: req.method,
        path,
        kind: 'completion',
        completion: completions,
        stream: parsed?.stream === true,
        messages,
      });

      if (failNext) {
        failNext = false;
        json(
          res,
          429,
          JSON.parse(REFUSAL_BODY),
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '50' },
        );
        return;
      }

      if (parsed?.stream === false) {
        json(res, 200, {
          model: MODEL,
          content: [{ type: 'text', text: answer }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 7 },
        });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(sse(answer));
    });
  });

  return { server };
}

function makeLogger(file) {
  if (!file) {
    return (entry) => {
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    };
  }

  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  return (entry) => {
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
}

function parseArgs(argv) {
  const args = { port: 5999, answer: DEFAULT_ANSWER };
  for (const raw of argv) {
    const [flag, ...rest] = raw.replace(/^--/, '').split('=');
    const value = rest.join('=');
    switch (flag) {
      case 'port':
        args.port = Number(value);
        break;
      case 'answer':
        args.answer = value;
        break;
      case 'log':
        args.log = value;
        break;
      case 'self-test':
        args.selfTest = true;
        break;
      case 'help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${raw}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return args;
}

async function selfTest() {
  const { server } = createQuotaStub({ logger: () => {} });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const post = (stream) =>
    fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream,
        messages: [{ role: 'user', content: 'self-test' }],
      }),
    });

  try {
    let res = await fetch(`${base}/control`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { failNext: false });

    res = await post(true);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(await res.text(), /Hello from the local quota stub/);

    res = await fetch(`${base}/control?fail=1`);
    assert.deepEqual(await res.json(), { failNext: true });

    res = await post(true);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(res.headers.get('x-ratelimit-limit'), '50');
    assert.match(await res.text(), /stub daily allowance spent/);

    res = await post(true);
    assert.equal(res.status, 200, 'the next completion after a refusal must succeed');
    assert.match(await res.text(), /Hello from the local quota stub/);

    res = await post(false);
    assert.equal(res.status, 200);
    const jsonBody = await res.json();
    assert.equal(jsonBody.content[0].text, DEFAULT_ANSWER);

    console.log('quota-stub self-test: passed');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.selfTest) {
    await selfTest();
    return;
  }

  const { server } = createQuotaStub({ answer: args.answer, logger: makeLogger(args.log) });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(args.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const { port } = server.address();
  process.stderr.write(`[quota-stub] listening on http://127.0.0.1:${port}\n`);
  process.stderr.write('[quota-stub] refuse the next completion: /control?fail=1\n');

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[quota-stub] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
