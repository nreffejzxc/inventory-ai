// AI-12 — the empty completion's own shape, and the model the record must name.
//
// THE INVESTIGATION THIS CLOSES (owner request, 2026-10-17: *"investigate the 11 empty
// completions … determine whether these cases are related to the free AI model, provider
// limits, response timeouts, or other underlying causes"*). Reading every stored assistant
// turn in both databases found the following, and the first two are the reason this suite
// exists:
//
//   1. **A valid JSON 2xx with nothing usable in it leaves NO trace.** It is not a non-2xx
//      (no `[ai:openrouter] upstream HTTP …` line), not a non-JSON body (no diagnostics
//      line), not a timeout (`AiTimeout`, 504, persists nothing) and not a quota refusal
//      (`AiQuotaExceeded`, 429/402). `parseAnthropicResponse` maps it to
//      `{ text: '', toolCalls: [] }`, the service retries once (AI-2) and then degrades —
//      and the one thing an operator needs in order to identify the shape, the body
//      itself, was never recorded anywhere. §27BS measured exactly this on the device
//      ("no `[ai:openrouter]` diagnostic line, so it was not an error") and could only
//      report `in=0 out=0`.
//   2. **The model column read `openrouter` on 12 of 44 turns — including every failing
//      one.** That is the provider's LABEL, not a model, and it was substituted by the
//      fallback for any response whose body omitted `model`. So the one question a
//      provider-tier decision has to answer — *is it this model?* — could not be answered
//      from the record, even though the same turn's earlier round or the request itself
//      knew the model.
//
// WHAT SHIPS. Both fixes are DIAGNOSTIC ONLY: no status, code, sentence, route, schema,
// permission, dependency, cap or model changes, and the member-visible behaviour of an
// empty completion is exactly what AI-2 shipped (one retry, then a marked degraded turn).
//
//   * The model a response omits is now labelled with **the model the request named** —
//     `parseAnthropicResponse(data, requestedModel)` — because that is what the gateway
//     was asked for and it is true by construction of the request, whereas a provider
//     name in a model column is a different fact wearing the same field.
//   * A response carrying neither text nor a tool call is logged **once per occurrence**
//     with a bounded, content-free description of its body: `stop=`, `blocks=` (block
//     TYPES only), `contentBlocks=`, `hasModel=`, `hasUsage=`, `out=` (the output tokens
//     the model actually spent, so a thinking-only response is distinguishable from a
//     gateway that sent nothing) and `keys=` (top-level FIELD NAMES). Field names and
//     block types are schema labels; no value, no prompt and no model output reaches the
//     line — which matters most for the `thinking` case, where the body DOES contain text.
//
// WHY THIS IS THE ROOT-CAUSE INSTRUMENT RATHER THAN A FIX. The surviving data can prove
// what the failure is NOT (see above) and that it is intermittent (a healthy turn landed
// 11 seconds between two failing ones, same model, same tenant). It cannot distinguish
// "the model thought and produced nothing but the token counts say so" from "the gateway
// answered 2xx with a body that is not a Messages response at all", because those two
// differ precisely in fields that were never logged. The next occurrence is diagnosable
// from one line instead of being unanswerable forever.

import http from 'node:http';
import { once } from 'node:events';

import { it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { unitSuite, dbSuite } from './testEnv.mjs';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { ROLES } from '../src/constants/roles.ts';
import { createOpenrouterProvider } from '../src/services/ai/providers/openrouterProvider.ts';
import { AI_OUTPUT_LIMIT, AiOutputLimit } from '../src/services/ai/aiErrors.ts';
import { registerProvider, deregisterProvider } from '../src/services/ai/providers/index.ts';

// ---------------------------------------------------------------------------
// A local stub gateway. Nothing here can spend provider quota, and the body is
// whatever the case sets — which is the only way an unobserved upstream shape can
// be exercised deterministically.
// ---------------------------------------------------------------------------

const MODEL = 'stub-vendor/stub-model';

let respond = { status: 200, body: '{}', contentType: 'application/json' };
let hits = 0;
const stub = http.createServer((req, res) => {
  hits += 1;
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(respond.status, { 'content-type': respond.contentType });
    res.end(respond.body);
  });
});
stub.listen(0);
await once(stub, 'listening');
const stubOrigin = `http://127.0.0.1:${stub.address().port}`;

process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'stub-key-not-real';
process.env.OPENROUTER_BASE_URL = `${stubOrigin}/api`;
process.env.AI_MODEL_OPENROUTER = MODEL;

let warnings = [];
let logLines = [];
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  respond = { status: 200, body: '{}', contentType: 'application/json' };
  hits = 0;
  warnings = [];
  logLines = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  console.log = (...args) => logLines.push(args.map(String).join(' '));
  console.error = () => {};
});

afterEach(() => {
  console.warn = realWarn;
  console.log = realLog;
  console.error = realError;
});

/** One call through the real provider, with the stub's answer in place. */
async function callProvider(body) {
  respond = { status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json' };
  const provider = createOpenrouterProvider();
  return provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });
}

const shapeLines = () => warnings.filter((l) => l.includes('empty completion'));
const allOutput = () => [...warnings, ...logLines].join('\n');

unitSuite('AI-12 an empty completion is diagnosable (DB-free)', () => {
  it('★ reports a valid 2xx that carried nothing, and names the model it asked for', async () => {
    // The shape that has no explanation in the record: valid JSON, `{}`, nothing in it.
    const out = await callProvider({});

    assert.equal(hits, 1, 'the request really reached the stub');
    const line = shapeLines();
    assert.equal(line.length, 1, `exactly one line per occurrence, got: ${JSON.stringify(warnings)}`);
    assert.match(line[0], /model=stub-vendor\/stub-model/, 'the model asked for is named');
    assert.match(line[0], /stop=none/);
    assert.match(line[0], /blocks=none/);
    assert.match(line[0], /hasModel=false/);
    assert.match(line[0], /hasUsage=false/);
    assert.match(line[0], /out=none/, 'absent is not zero — nothing was reported, so nothing is printed');
    assert.match(line[0], /bodyBytes=2/);

    // And the RESPONSE is unchanged: still an empty completion the service retries.
    assert.equal(out.text, '');
    assert.deepEqual(out.toolCalls, []);
    assert.equal(out.model, MODEL, 'a body that omits `model` must not be labelled `openrouter`');
  });

  it('★ says a thinking-only body spent tokens and produced nothing usable', async () => {
    // The F-52 shape: the model reasoned, the wire carried no text and no tool call.
    // `out=` is the field that separates "the model spent its budget thinking" from
    // "the gateway sent nothing at all", and it is only knowable from the body.
    const planted = 'PLANTED-REASONING-TEXT-DO-NOT-LOG';
    const out = await callProvider({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'thinking', thinking: `${planted} the user asks about stock, I should call a tool` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2575, output_tokens: 137 },
    });

    const line = shapeLines();
    assert.equal(line.length, 1, 'one line, again');
    assert.match(line[0], /stop=end_turn/);
    assert.match(line[0], /blocks=thinking/, 'the block TYPE is the finding');
    assert.match(line[0], /contentBlocks=1/);
    assert.match(line[0], /hasModel=true/);
    assert.match(line[0], /hasUsage=true/);
    assert.match(line[0], /out=137/, 'the spend the body reported');
    assert.ok(!allOutput().includes(planted), 'the reasoning text itself must never be logged');
    assert.equal(out.model, MODEL);
    assert.equal(out.text, '');
  });

  it('★ reports an error-shaped 2xx body by its fields, without printing the error text', async () => {
    // A gateway that answers 200 with an error object parses as "no content" today, so
    // it is one of the candidate explanations for the unlogged shape. `keys=` is what
    // would identify it on the next occurrence; the message itself is not logged.
    const planted = 'upstream provider exploded';
    await callProvider({ error: { message: planted, code: 502 } });

    const line = shapeLines();
    assert.equal(line.length, 1);
    assert.match(line[0], /keys=error/, 'the field names are the evidence');
    assert.match(line[0], /hasUsage=false/);
    assert.ok(!allOutput().includes(planted), 'an upstream message is not republished to the log');
  });

  it('★ must-not-fire: a healthy answer is not an empty completion', async () => {
    const out = await callProvider({ model: MODEL, content: [{ type: 'text', text: 'Everything is fine.' }], stop_reason: 'end_turn' });

    assert.equal(shapeLines().length, 0, 'a real answer must not produce this line');
    assert.equal(out.text, 'Everything is fine.');
  });

  it('★ must-not-fire: a tool round with no prose is normal', async () => {
    const out = await callProvider({
      model: MODEL,
      content: [{ type: 'tool_use', id: 'tu_1', name: 'getInventorySummary', input: {} }],
      stop_reason: 'tool_use',
    });

    assert.equal(shapeLines().length, 0, 'the model legitimately answers with no prose while it asks for data');
    assert.deepEqual(out.toolCalls.map((c) => c.name), ['getInventorySummary']);
  });

  it('★ must-not-fire: the output limit keeps its OWN single line (AI-10)', async () => {
    // The two diagnostics must not both fire for one response: a spent budget reaches
    // its own branch in the parser and throws, so it never reaches the new check.
    let thrown = null;
    try {
      await callProvider({ model: MODEL, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1200, output_tokens: 800 } });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof AiOutputLimit, 'the cap-spent body is still its own failure');
    assert.equal(thrown.code, AI_OUTPUT_LIMIT);
    assert.equal(shapeLines().length, 0, 'one response, one line — never two');
    assert.equal(warnings.filter((l) => l.includes('output limit reached')).length, 1, 'AI-10 keeps its line');
  });

  it('★ a rescued turn still counts what it saw (one empty, then an answer)', async () => {
    // The counting property the failure rate needs: the shipped degraded warning only
    // appears when a turn GIVES UP, so an empty response the retry rescues would leave a
    // *healthy* turn looking clean. AI-5's `empty=` is what makes it countable, and this
    // is the shape the free tier produces most often — empty first, answer on the retry.
    let call = 0;
    registerProvider('stub-sequence', () => ({
      name: 'stub-sequence',
      async complete() {
        call += 1;
        if (call === 1) return { model: MODEL, text: '', toolCalls: [], usage: null };
        return { model: MODEL, text: 'Three products are low.', toolCalls: [], usage: null };
      },
    }));
    const restore = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'stub-sequence';
    try {
      const result = await runAiChat({ businessId: 'b-1', userId: 'u-1', role: ROLES.OWNER, message: 'how much stock do we hold?' });
      assert.equal(result.content, 'Three products are low.', 'the retry-rescued turn answered');
      assert.equal(result.degraded, undefined, 'and it is NOT a degraded turn');
      const turnLine = logLines.find((l) => l.includes('[ai] turn outcome='));
      assert.match(turnLine ?? '', /outcome=ok/, 'the outcome is a healthy one');
      assert.match(turnLine ?? '', /empty=1/, 'and the line still says one response came back empty');
    } finally {
      if (restore === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = restore;
      deregisterProvider('stub-sequence');
    }
  });
});

// ---------------------------------------------------------------------------
// The boundary a member actually goes through: the real route, the real provider,
// the real parser and the real persistence — only the gateway is a stub. The wire
// cases above prove the LINE; these prove the TURN it belongs to, and that the two
// halves the investigation depends on (the log line and the stored model column) are
// both right after a real request.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

dbSuite('AI-12 an empty completion over the real route, and the model it records', dbOk, () => {
  it('★ two content-less 2xxs degrade the turn, and the SHAPE is in the log twice', async () => {
    const owner = await registerOwner(api, tracker);
    respond = { status: 200, body: '{}', contentType: 'application/json' };

    const res = await api('POST', '/api/ai/chat', {
      token: owner.token,
      body: { message: 'how much stock do we hold?' },
    });

    // Positive control: one attempt plus AI-2's one retry, both through the stub.
    assert.equal(hits, 2, `the turn must reach the gateway twice — base=${process.env.OPENROUTER_BASE_URL}`);
    assert.equal(res.status, 201, 'a degraded turn is a COMPLETED turn — AI-2 is unchanged');
    assert.equal(res.json.degraded, 'EMPTY_COMPLETION');
    assert.match(res.json.assistantMessage.content, /could not generate a response/i);

    const shape = warnings.filter((w) => w.includes('empty completion'));
    assert.equal(shape.length, 2, 'one line per OCCURRENCE — which is what makes a rescued turn countable');
    for (const line of shape) {
      assert.ok(line.includes(`model=${MODEL}`), 'the model the request named, on every occurrence');
      assert.match(line, /hasModel=false/);
      assert.match(line, /hasUsage=false/);
      assert.match(line, /out=none/);
    }
    assert.equal(warnings.filter((w) => w.includes('degraded turn')).length, 1, 'AI-2 keeps its own warning');

    const turn = logLines.find((l) => l.includes('[ai] turn'));
    assert.match(turn ?? '', /outcome=degraded/);
    assert.match(turn ?? '', /empty=2/);
    assert.ok(turn.includes(`model=${MODEL}`), 'the turn line names the model too');
    assert.ok(!turn.includes('model=openrouter'), 'the provider name can no longer appear in a model column');
    assert.ok(!turn.includes('model=unknown'), 'and a turn that ran real calls is not nameless');
  });

  it('★ the STORED message names the model for a body that omitted one', async () => {
    const owner = await registerOwner(api, tracker);
    // A healthy answer whose body names no model: the exact shape that used to be
    // stored as `openrouter`, and the column the usage report reads.
    respond = {
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'Hello there.' }], stop_reason: 'end_turn' }),
      contentType: 'application/json',
    };

    const res = await api('POST', '/api/ai/chat', { token: owner.token, body: { message: 'say hello in one sentence' } });
    assert.equal(res.status, 201);

    const list = await api('GET', '/api/ai/conversations', { token: owner.token });
    const messages = await api('GET', `/api/ai/conversations/${list.json.items[0].id}/messages`, { token: owner.token });
    const assistant = messages.json.items.find((m) => m.role === 'ASSISTANT');

    assert.equal(assistant.model, MODEL, 'the stored model must answer "which model", not "which provider"');
    assert.equal(assistant.degraded, undefined, 'and a real answer is not marked degraded');
    assert.equal(warnings.filter((w) => w.includes('empty completion')).length, 0, 'no line for an answer that arrived');
    assert.equal(hits, 1, 'positive control: the turn really reached the stub');
  });
});

// Cleanup — the last root-level hook in the file, for the reason AI-10 documents: a hook
// registered above the suites belongs to the root suite as it existed at that moment, and
// `node --test` runs it as soon as that root's first child finishes, which would close the
// gateway before the wire cases use it.
after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
  await disconnectDb();
});
