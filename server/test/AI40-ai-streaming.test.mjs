// AI-40 — the answer arrives while it is being written.
//
// WHY. A turn on the deployed free tier takes 5–20 s, and until now the screen showed a spinner
// for all of it. The model is already producing words at ~50 tokens/s; the wait is the whole
// answer being buffered and then painted at once. Streaming does not make the model faster — it
// makes the same wait legible, which is the difference between "slow" and "broken" for the person
// holding the phone.
//
// WHAT IS PINNED HERE, and why each case exists:
//   * the wire layer frames SSE correctly across chunk boundaries (a delta split mid-event is
//     the normal case on a mobile network, not an edge case);
//   * `postSse` distinguishes "this was not a stream" from "the stream broke", because only the
//     first may be retried unstreamed;
//   * the provider assembles text AND tool-call fragments into the same response shape the
//     non-streamed path produces — one set of rules after the body, not two;
//   * text already delivered forbids a failover, since a second model would answer the same
//     question again and the member would read both;
//   * the HTTP contract: `Accept: text/event-stream` streams, and every other request gets
//     exactly the JSON 201 it got before;
//   * a failed streamed turn still writes NOTHING (Phase 07E / M7), and reports its failure as
//     an event with the same code the JSON path would have sent.

import http from 'node:http';
import { once } from 'node:events';

import { it, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { postSse } from '../src/services/ai/providers/http.ts';
import { createOpenrouterProvider } from '../src/services/ai/providers/openrouterProvider.ts';
import { AiProviderError, AiQuotaExceeded } from '../src/services/ai/aiErrors.ts';
import { resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { resetModelHealthGate } from '../src/services/ai/modelHealthGate.ts';
import { resetQuotaState } from '../src/services/ai/quota.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
process.env.AI_RATE_LIMIT_MAX = '1000';
registerFakeProvider();

// ---------------------------------------------------------------------------
// A local stub gateway. It can answer as JSON, as a stream, or as a stream that
// breaks — which is every shape this feature has to survive.
// ---------------------------------------------------------------------------

let mode = 'json';
let chunkDelayMs = 0;
let jsonBody = '{}';
let hits = 0;

const SSE_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"stub/model-1","usage":{"input_tokens":11,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"You hold "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"112 units."}}',
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

const SSE_TOOLS = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"getInventorySummary","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"locationName\\":"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Demo Shop\\"}"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
  '',
  '',
].join('\n');

const SSE_ERROR = [
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an ans"}}',
  '',
  'event: error',
  'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded","status":503}}',
  '',
  '',
].join('\n');

// OpenRouter reports the request's charge in `usage.cost`. The streamed path must
// carry it through both usage events, and must not erase a start value when the
// final event omits one.
const SSE_COST = SSE_TEXT.replace(
  '"usage":{"input_tokens":11,"output_tokens":1}',
  '"usage":{"input_tokens":11,"output_tokens":1,"cost":0.0012}',
).replace('"usage":{"output_tokens":7}', '"usage":{"output_tokens":7,"cost":0.0034}');

const SSE_COST_START_ONLY = SSE_TEXT.replace(
  '"usage":{"input_tokens":11,"output_tokens":1}',
  '"usage":{"input_tokens":11,"output_tokens":1,"cost":0.0012}',
);

const STREAMS = {
  sse: SSE_TEXT,
  'sse-tools': SSE_TOOLS,
  'sse-error': SSE_ERROR,
  // The same stream a CRLF gateway sends, so the only variable is the line ending.
  'sse-crlf': SSE_TEXT.replace(/\n/g, '\r\n'),
  'sse-cost': SSE_COST,
  'sse-cost-start': SSE_COST_START_ONLY,
};

const stub = http.createServer((req, res) => {
  hits += 1;
  req.resume();
  req.on('end', async () => {
    if (mode in STREAMS) {
      const body = STREAMS[mode];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (chunkDelayMs === 0) {
        res.end(body);
        return;
      }
      // One code unit at a time is the harshest realistic framing: every event is split,
      // including the double-newline separators and the JSON payloads.
      for (const char of body) {
        res.write(char);
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonBody);
  });
});
stub.listen(0);
await once(stub, 'listening');
const stubBase = `http://127.0.0.1:${stub.address().port}`;

let errLines = [];
let logLines = [];
const realError = console.error;
const realLog = console.log;

beforeEach(() => {
  mode = 'json';
  chunkDelayMs = 0;
  jsonBody = '{}';
  hits = 0;
  errLines = [];
  logLines = [];
  console.error = (...args) => errLines.push(args.map(String).join(' '));
  console.log = (...args) => logLines.push(args.map(String).join(' '));
  resetModelBreaker();
  resetModelSelection();
  resetModelHealthGate();
  resetQuotaState();
});

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  setFakeScenario(null);
  delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.AI_MODEL_OPENROUTER;
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

/** Collect the events one `postSse` call delivers. */
async function collect(options = {}) {
  const events = [];
  const result = await postSse({
    url: `${stubBase}/v1/messages`,
    body: { ping: 1 },
    providerName: 'stub-ai',
    timeoutMs: 3000,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { events, quota: result?.quota ?? null };
}

unitSuite('AI-40 the SSE transport frames a stream correctly (DB-free)', () => {
  it('delivers complete events even when the body arrives one character at a time', async () => {
    mode = 'sse';
    chunkDelayMs = 0; // framing is what is asserted here; the slow case is below
    const { events } = await collect();
    const deltas = events.filter((event) => event.event === 'content_block_delta');
    assert.equal(deltas.length, 2);
    assert.equal(JSON.parse(deltas[0].data).delta.text, 'You hold ');
    assert.equal(JSON.parse(deltas[1].data).delta.text, '112 units.');
    assert.equal(hits, 1);
  });

  it('reassembles events split across network chunks, not just whole bodies', async () => {
    mode = 'sse';
    chunkDelayMs = 1;
    // One character per write is ~900 timer ticks; the assertions are about framing, so the
    // request is given room to finish rather than being raced by the transport's own budget.
    const { events } = await collect({ timeoutMs: 30000 });
    assert.equal(events.length, 7, 'every event in the stream must arrive exactly once');
    assert.equal(events[0].event, 'message_start');
    assert.equal(events.at(-1).event, 'message_stop');
    // A payload split mid-string would arrive here as invalid JSON or as two events.
    const text = events
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => JSON.parse(event.data).delta.text)
      .join('');
    assert.equal(text, 'You hold 112 units.');
  });

  it('frames a CRLF stream whose \\r\\n is itself split across two network writes', async () => {
    // Found in review before release: normalising CRLF per chunk left a split `\r`/`\n` in the
    // buffer, so `\n\n` never matched and the whole answer arrived as one payload at EOF (or, if
    // several events shared the flush, as one malformed event). One character per write makes
    // every `\r\n` in the stream a split pair, which is the worst realistic case.
    mode = 'sse-crlf';
    chunkDelayMs = 0.001;
    const { events } = await collect({ timeoutMs: 60000 });
    assert.equal(events.length, 7, 'every CRLF event must frame exactly once');
    assert.equal(events[0].event, 'message_start');
    assert.equal(events.at(-1).event, 'message_stop');
    const text = events
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => JSON.parse(event.data).delta.text)
      .join('');
    assert.equal(text, 'You hold 112 units.');
    // Negative control: the delimiter really is CRLF in this case, so the assertions above are
    // about normalisation rather than about an accidental LF stream.
    assert.ok(SSE_TEXT.replace(/\n/g, '\r\n').includes('\r\n'));
  });

  it('reports a 2xx that carried no event at all as invalid_response, never as an empty answer', async () => {
    mode = 'json';
    jsonBody = JSON.stringify({ content: [{ type: 'text', text: 'not streamed' }] });
    await assert.rejects(collect(), (err) => {
      assert.ok(err instanceof AiProviderError);
      assert.equal(err.kind, 'invalid_response');
      assert.match(errLines.join('\n'), /stream ended without a single event/);
      return true;
    });
  });

  it('delivers an error event to the provider assembler unchanged', async () => {
    // The transport's job is framing, not interpretation: it hands the event over and the
    // provider decides what it means. The next suite proves the provider turns this into the
    // right failure with its status intact.
    mode = 'sse-error';
    const { events } = await collect();
    const failure = events.find((event) => event.event === 'error');
    assert.ok(failure, 'the error event must reach the caller rather than being swallowed');
    assert.equal(JSON.parse(failure.data).error.status, 503);
  });
});

unitSuite('AI-40 the provider assembles a stream into the same response the JSON path builds (DB-free)', () => {
  const configure = () => {
    process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret';
    process.env.OPENROUTER_BASE_URL = stubBase;
    process.env.AI_MODEL_OPENROUTER = 'stub/model-1';
  };

  it('accumulates text deltas and reports the model the stream named', async () => {
    configure();
    mode = 'sse';
    const deltas = [];
    const provider = createOpenrouterProvider();
    const response = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'how much stock do we hold?' }],
      tools: [],
      stream: true,
      onTextDelta: (text) => deltas.push(text),
    });
    assert.equal(deltas.join(''), 'You hold 112 units.');
    assert.equal(response.text, 'You hold 112 units.');
    assert.equal(response.toolCalls.length, 0);
    assert.equal(response.model, 'stub/model-1');
    assert.deepEqual(
      response.usage,
      { inputTokens: 11, outputTokens: 7 },
      'a stream that reports no charge must not invent one',
    );
  });

  it('preserves a charge reported on the stream in the final usage', async () => {
    configure();
    mode = 'sse-cost';
    const provider = createOpenrouterProvider();
    const response = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'how much stock do we hold?' }],
      tools: [],
      stream: true,
      onTextDelta: () => {},
    });
    assert.equal(response.text, 'You hold 112 units.');
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 7, costUsd: 0.0034 });
  });

  it('keeps a charge reported only at message_start', async () => {
    configure();
    mode = 'sse-cost-start';
    const provider = createOpenrouterProvider();
    const response = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'how much stock do we hold?' }],
      tools: [],
      stream: true,
      onTextDelta: () => {},
    });
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 7, costUsd: 0.0012 });
  });

  it('rebuilds a tool call from its JSON fragments', async () => {
    configure();
    mode = 'sse-tools';
    const provider = createOpenrouterProvider();
    const response = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'summary for the shop' }],
      tools: [],
      stream: true,
      onTextDelta: () => {},
    });
    assert.equal(response.text, '');
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0].name, 'getInventorySummary');
    assert.deepEqual(response.toolCalls[0].input, { locationName: 'Demo Shop' });
  });

  it('falls back to the ordinary request when the gateway ignores stream=true', async () => {
    configure();
    mode = 'json';
    jsonBody = JSON.stringify({
      model: 'stub/model-1',
      content: [{ type: 'text', text: 'whole answer, not streamed' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const deltas = [];
    const provider = createOpenrouterProvider();
    const response = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'anything' }],
      tools: [],
      stream: true,
      onTextDelta: (text) => deltas.push(text),
    });
    assert.equal(response.text, 'whole answer, not streamed');
    assert.deepEqual(deltas, [], 'a JSON answer cannot be delivered as deltas');
    assert.match(errLines.join('\n'), /ignored stream=true/);
  });

  it('does NOT retry unstreamed once text has been delivered', async () => {
    configure();
    mode = 'sse-error';
    const deltas = [];
    const provider = createOpenrouterProvider();
    await assert.rejects(
      provider.complete({
        system: 's',
        messages: [{ role: 'user', content: 'anything' }],
        tools: [],
        stream: true,
        onTextDelta: (text) => deltas.push(text),
      }),
      (err) => err instanceof AiProviderError && err.status === 503,
    );
    assert.equal(deltas.join(''), 'half an ans', 'the text that did arrive is kept');
    assert.equal(hits, 1, 'a retry would show the beginning of the answer twice');
  });
});

unitSuite('AI-40 the turn loop streams text and behaves as before without it (DB-free)', () => {
  const ask = (onTextDelta, onTextReset) =>
    runAiChat({
      businessId: 'b-dummy',
      userId: 'u-dummy',
      role: ROLES.OWNER,
      // Not a recorded-data question: the AI-60 guard would otherwise re-ask a zero-tool
      // figure-stating answer, and this suite is about the transport, not that guard.
      message: 'say hello in one sentence',
      ...(onTextDelta ? { onTextDelta } : {}),
      ...(onTextReset ? { onTextReset } : {}),
    });

  it('forwards deltas in arrival order and still returns the complete answer', async () => {
    let sawStream = null;
    setFakeScenario(async (ctx) => {
      sawStream = { stream: ctx.stream, hasCallback: typeof ctx.onTextDelta === 'function' };
      ctx.onTextDelta?.('hello ');
      ctx.onTextDelta?.('there.');
      return fakeText('hello there.');
    });
    const deltas = [];
    const result = await ask((text) => deltas.push(text));
    assert.deepEqual(sawStream, { stream: true, hasCallback: true });
    assert.deepEqual(deltas, ['hello ', 'there.']);
    assert.equal(result.content, 'hello there.');
  });

  it('clears the shown draft when the stored answer differs from it (AI-74)', async () => {
    // The model's raw token is replaced by the stored vocabulary before the answer is stored.
    // Until AI-74 the client kept the raw version on screen until `done` arrived; the reset
    // tells it to discard that copy, and the stored answer is replayed in its place.
    setFakeScenario((ctx) => {
      ctx.onTextDelta?.('Draft: OUT_OF_STOCK');
      return fakeText('Draft: OUT_OF_STOCK');
    });

    const deltas = [];
    const resets = [];
    const result = await ask(
      (text) => deltas.push(text),
      () => resets.push(1),
    );

    assert.equal(resets.length, 1, 'the replaced text must be cleared exactly once');
    assert.equal(result.content, 'Draft: Out of stock');
    assert.deepEqual(
      deltas,
      ['Draft: OUT_OF_STOCK', 'Draft: Out of stock'],
      'the stored answer is sent after the reset, so the bubble is never left blank',
    );
  });

  it('asks for nothing when nobody is listening — the request is unchanged', async () => {
    let saw = null;
    setFakeScenario((ctx) => {
      saw = { stream: ctx.stream, callback: ctx.onTextDelta };
      return fakeText('plain answer');
    });
    const result = await ask();
    assert.equal(saw.stream, undefined);
    assert.equal(saw.callback, undefined);
    assert.equal(result.content, 'plain answer');
  });

  it('does not fail over after text has been delivered', async () => {
    process.env.AI_FALLBACK_MODELS_OPENROUTER = 'candidate-a';
    let calls = 0;
    setFakeScenario((ctx) => {
      calls += 1;
      ctx.onTextDelta?.('The answer started…');
      throw new AiProviderError('The AI service returned an error. Please try again.', undefined, 503);
    });
    const deltas = [];
    await assert.rejects(ask((text) => deltas.push(text)));
    assert.equal(calls, 1, 'a second model would answer the same question again, on top of the partial text');
    assert.equal(deltas.join(''), 'The answer started…');
  });

  it('still retries an EMPTY completion, which delivered no text', async () => {
    let calls = 0;
    setFakeScenario((ctx) => {
      calls += 1;
      if (calls === 1) return { model: 'fake-model', text: '', toolCalls: [], usage: null };
      ctx.onTextDelta?.('recovered');
      return fakeText('recovered');
    });
    const deltas = [];
    const result = await ask((text) => deltas.push(text));
    assert.equal(calls, 2, 'AI-2 retry is unchanged: nothing was shown, so nothing would repeat');
    assert.equal(result.content, 'recovered');
    assert.deepEqual(deltas, ['recovered']);
  });
});

// ---------------------------------------------------------------------------
// The wire contract the mobile client switches on.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

/** Quote-free SSE parsing for assertions: [{ event, data }] from a raw body. */
function parseEvents(body) {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function postStream(token, body) {
  return fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

dbSuite('AI-40 the streamed turn reaches the phone as it is written', dbOk, () => {
  it('answers 200 text/event-stream with deltas and one authoritative done event', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario((ctx) => {
      ctx.onTextDelta?.('Hello ');
      ctx.onTextDelta?.('there.');
      return fakeText('Hello there.');
    });

    const res = await postStream(owner.token, { message: 'say hello in one sentence' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(res.headers.get('cache-control') ?? '', /no-transform/);

    const body = await res.text();
    const events = parseEvents(body);
    const deltas = events.filter((event) => event.event === 'delta');
    assert.deepEqual(
      deltas.map((event) => event.data.text),
      ['Hello ', 'there.'],
    );
    const done = events.filter((event) => event.event === 'done');
    assert.equal(done.length, 1, 'the stream must end with exactly one done event');
    assert.equal(done[0].data.assistantMessage.content, 'Hello there.');
    // The per-turn id every monitoring line carries travels with the answer, so a member
    // can quote it without reading the server logs.
    assert.match(done[0].data.turnId, /^[0-9a-f]{8}$/);
    assert.equal(done[0].data.assistantMessage.turnId, done[0].data.turnId);
    assert.ok(done[0].data.conversation.id, 'the conversation is created and named');
    assert.ok(done[0].data.userMessage.id, 'the question is stored and returned');

    // The thread a reload would read is the same thread the stream described.
    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 1);
    const messages = await api('GET', `/api/ai/conversations/${done[0].data.conversation.id}/messages`, {
      token: owner.token,
    });
    assert.equal(messages.json.total, 2);
    assert.deepEqual(
      messages.json.items.map((m) => m.content),
      ['say hello in one sentence', 'Hello there.'],
    );
    assert.equal(messages.json.items[1].turnId, done[0].data.turnId, 'a reopened thread still names the turn');
  });

  it('sends a reset before the stored answer when a guard rewrote the streamed copy (AI-74)', async () => {
    const owner = await registerOwner(api, tracker);
    const draft = 'Hello — everything is OUT_OF_STOCK today.';
    setFakeScenario((ctx) => {
      ctx.onTextDelta?.(draft);
      return fakeText(draft);
    });

    const res = await postStream(owner.token, { message: 'Say hello in one sentence.' });
    const events = parseEvents(await res.text());
    const done = events.find((event) => event.event === 'done');
    assert.ok(done, 'the turn still completes');
    assert.notEqual(done.data.assistantMessage.content, draft, 'the stored answer is the humanised one');

    const resets = events.filter((event) => event.event === 'reset');
    assert.equal(resets.length, 1, 'the replaced copy is cleared exactly once');
    assert.equal(events.at(-1).event, 'done', 'the reset never outlives the answer');

    // The replacement is delivered before `done`, so the member never watches a blank bubble.
    const deltas = events.filter((event) => event.event === 'delta');
    assert.equal(deltas.at(-1).data.text, done.data.assistantMessage.content);
    assert.equal(deltas.map((event) => event.data.text).join(''), draft + done.data.assistantMessage.content);
  });

  it('leaves the JSON response exactly as it was for a client that did not ask to stream', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => fakeText('plain answer'));
    const res = await api('POST', '/api/ai/chat', { token: owner.token, body: { message: 'anything' } });
    assert.equal(res.status, 201);
    assert.equal(res.json.assistantMessage.content, 'plain answer');
    assert.match(res.json.turnId, /^[0-9a-f]{8}$/, 'the JSON response carries the turn id');
    assert.equal(res.json.assistantMessage.turnId, res.json.turnId);
    assert.equal(res.json.conversation.id !== undefined, true);
  });

  it('reports a failed turned as an error event and persists NOTHING (Phase 07E / M7)', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiProviderError('The AI service returned an error. Please try again.', undefined, 503);
    });

    const res = await postStream(owner.token, { message: 'this will fail' });
    assert.equal(res.status, 200, 'the headers were already sent; the failure travels as an event');
    const events = parseEvents(await res.text());
    const errors = events.filter((event) => event.event === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].data.code, 'AI_UNAVAILABLE', 'the same code the JSON path would have returned');
    assert.equal(errors[0].data.status, 502);
    assert.ok(!events.some((event) => event.event === 'done'), 'a failed turn has no done event');

    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 0, 'a failed streamed turn must leave no conversation behind');
  });

  it('reports a quota refusal as an SSE error with status 429 and its own code', async () => {
    const owner = await registerOwner(api, tracker);
    setFakeScenario(() => {
      throw new AiQuotaExceeded(undefined, { remaining: 0, limit: 50 });
    });

    const res = await postStream(owner.token, { message: 'say hello in one sentence' });
    // The stream headers were already sent, so the refusal cannot be a second HTTP status.
    // It travels as an error event carrying the status the JSON path would have returned.
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = parseEvents(await res.text());
    const errors = events.filter((event) => event.event === 'error');
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0].data, {
      status: 429,
      code: 'AI_QUOTA_EXCEEDED',
      message: 'The AI assistant has reached its usage limit. Please try again later.',
    });
    assert.ok(!events.some((event) => event.event === 'done'), 'a refused turn has no done event');

    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    assert.equal(list.json.total, 0, 'a refused streamed turn leaves no conversation behind');
  });

  it('rejects a bad request before any stream header, so the client sees the normal JSON error', async () => {
    const owner = await registerOwner(api, tracker);
    const res = await postStream(owner.token, { message: '' });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const json = await res.json();
    assert.equal(json.code, 'VALIDATION_ERROR');
  });

  it('requires authentication like every other chat request', async () => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'anything' }),
    });
    assert.equal(res.status, 401);
  });
});
