// The AI usage report — read-only, and the instrument the provider decision needs.
//
// WHY THIS EXISTS. `perf:turns` measures real turns and **spends** provider quota (~50 free
// requests a day IN TOTAL, §27BF); the per-turn cost line (`AI turn …`, AI-5) records what
// every real turn actually cost, but nothing read those lines back, so "how much of the
// allowance are we using, and what is failing?" could only be answered by spending more of
// it. That is the question ISS-22 is waiting on, and it is the opposite of a measurement
// instrument: the thing being measured is consumed by measuring it.
//
// THIS SUITE PINS THE TOOL, NOT A READING OF THE PROVIDER. The live numbers depend on the
// day and on the account, so nothing here asserts them; what it pins is that the report is
// ARITHMETICALLY RIGHT on a known log, that a line which is not a turn cannot inflate the
// count, that a truncated turn line is reported as malformed rather than dropped, that a
// missing log is a refusal (exit 2, "nothing was measured") rather than an empty report,
// and — the one that matters most — that no credential-shaped string can reach the output
// even when the log it read contains one.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, makeApi, createTracker, registerOwner, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { AIMessage, AIConversation } from '../src/models/index.ts';

const run = promisify(execFile);
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(SERVER_ROOT, 'scripts', 'ai-usage.mjs');

/** A line that only LOOKS like a credential, so the leak control has something to catch. */
const PLANTED_KEY = 'sk-or-v1-PLANTED-0000000000000000000000000000000000000000'; // secret-guard:allow (a deliberate fixture: the leak control needs a key-shaped string to prove the report cannot print one)

/**
 * A log fragment shaped like the server's real output: one access-log line (the JSON the
 * http logger writes), one AI-2 degraded warning, three real turns, and one turn line that
 * was cut short by a restart. Exactly one field of each is chosen so the arithmetic is
 * checkable by hand: calls 3 + 1 + 1 = 5 requests, empty 1 + 0 + 0 = 1, toolRuns 1.
 */
const FIXTURE = [
  `{"ts":"2026-10-17T02:39:29.638Z","level":"info","type":"http","method":"POST","path":"/api/ai/chat","status":201}`,
  `OPENROUTER_API_KEY=${PLANTED_KEY}`,
  `AI degraded turn reason=EMPTY_COMPLETION attempts=3 empty=2 model=stub/model calls=3`,
  `AI turn outcome=ok total=12598ms providerMs=11973ms calls=3 toolMs=625ms toolRuns=1 tools=getInventorySummary empty=1 in=3399 out=499 model=stub/model iterations=3`,
  `AI turn outcome=AI_ABANDONED total=12794ms providerMs=12794ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=0 out=0 model=unknown iterations=1`,
  `AI turn outcome=AI_OUTPUT_LIMIT total=213ms providerMs=213ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=1200 out=800 model=stub/model iterations=1`,
  `AI turn outcome=ok total=905ms providerMs=900ms calls=2 toolMs=5ms toolRuns=1 tools=`,
].join('\n');

let dir = '';
let logPath = '';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-'));
  logPath = path.join(dir, 'server.log');
  fs.writeFileSync(logPath, `${FIXTURE}\n`, 'utf8');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * How long one CLI invocation may take before it is killed AND SAID TO HAVE BEEN KILLED.
 * Generous on purpose: a `--db` run opens its own Atlas connection, and this host has been
 * measured at ~16s just to select a server — but unbounded is not the answer either, because
 * a hung child would stall the whole suite with no explanation.
 */
const CLI_TIMEOUT_MS = 120_000;

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      cwd: SERVER_ROOT,
      timeout: CLI_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { code: 0, stdout, stderr, killed: false };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      killed: Boolean(err.killed),
    };
  }
}

/**
 * Parse the CLI's JSON — ASSERTING THE RUN FIRST.
 *
 * `JSON.parse(res.stdout)` on its own is how a real failure became a mystery on 2026-10-19: the
 * child died mid-read (empty stdout, a stack trace on stderr), and the suite reported
 * `Unexpected end of JSON input`, which names neither the exit code nor the cause. The cause
 * was a mongoose connection `error` event with no listener in the script — fixed there — but
 * this helper is what would have named it in one line instead of an hour. Every case reads its
 * output through here, so a broken run is reported AS a broken run.
 */
function json(res, label = 'the report') {
  if (res.killed) {
    assert.fail(`${label}: the CLI was killed after ${CLI_TIMEOUT_MS}ms without finishing`);
  }
  assert.equal(
    res.code,
    0,
    `${label}: exit code ${res.code}${res.stderr ? ` — ${String(res.stderr).trim()}` : ' — nothing on stderr'}`,
  );
  assert.notEqual(res.stdout.trim(), '', `${label}: exit 0 but nothing was printed`);
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    assert.fail(`${label}: exit 0 but stdout was not JSON (${err.message}): ${res.stdout.slice(0, 200)}`);
  }
}

/**
 * The database half, asserted to be a READING rather than a refusal. Without this a failed
 * connect answers `database.status: 'UNREADABLE'` with no counts, and the case fails several
 * assertions later on a value that was never computed — instead of on the connection.
 */
function dbReport(res, label) {
  const report = json(res, label);
  assert.equal(
    report.database?.status,
    'OK',
    `${label}: the database half is ${report.database?.status} — ${report.database?.detail}`,
  );
  return report.database;
}

// ---------------------------------------------------------------------------
// The database half. `AIMessage` already stores model, toolsUsed, usage and the AI-8
// `degraded` mark on every assistant turn — its own comment says the reason is that "the
// rate of each reason becomes countable from the database rather than only from a log file
// that rotation will eat" — so production usage figures need no schema change and no log
// sink. What the database CANNOT show is a FAILED turn: nothing is persisted until an answer
// exists (Phase 07E / M7), which is why the log half still exists.
// ---------------------------------------------------------------------------

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

after(async () => {
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});

dbSuite('the usage report can read the turns the database already stores', dbOk, () => {
  it('★ counts one business\' stored turns, their tokens, tools and degraded split', async () => {
    const owner = await registerOwner(api, tracker);
    const conv = await AIConversation.create({ businessId: owner.businessId, userId: owner.userId, title: 'fixture' });
    await AIMessage.create([
      { conversationId: conv._id, role: 'USER', content: 'q1' },
      {
        conversationId: conv._id,
        role: 'ASSISTANT',
        content: 'a1',
        model: 'stub/model',
        toolsUsed: ['getInventorySummary'],
        usage: { inputTokens: 1200, outputTokens: 800 },
      },
      {
        conversationId: conv._id,
        role: 'ASSISTANT',
        content: 'a2',
        model: 'stub/model',
        degraded: 'OUTPUT_LIMIT',
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]);
    // One turn just outside the default window, written raw because `timestamps: true` owns
    // createdAt — the same technique support.mjs uses for a deliberate tie.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await AIMessage.collection.insertOne({
      conversationId: conv._id,
      role: 'ASSISTANT',
      content: 'a3',
      model: 'stub/model',
      usage: { inputTokens: 7, outputTokens: 3 },
      createdAt: old,
      updatedAt: old,
    });

    const res = await cli([
      '--db',
      `--business=${owner.businessId}`,
      '--days=7',
      '--no-provider',
      '--json',
    ]);
    const db = dbReport(res, 'the database report');

    // The database name is asserted rather than assumed: a report that silently read the
    // wrong database would look perfectly plausible and be worthless.
    assert.match(db.database, /_test_db$/, 'a test run must read the test database');
    assert.equal(db.turns, 2, 'assistant turns only — the USER message is not a turn');
    assert.equal(db.conversations, 1);
    assert.equal(db.healthyTurns, 1);
    assert.deepEqual(db.degradedReasons, { OUTPUT_LIMIT: 1 });
    assert.deepEqual(db.tokens, { input: 1300, output: 850 }, 'summed from the Mixed `usage` the provider reported');
    assert.deepEqual(db.tools, { getInventorySummary: 1 });
    assert.deepEqual(db.models, { 'stub/model': 2 });
    assert.equal(
      db.perDay.reduce((n, d) => n + d.turns, 0),
      2,
      'the per-day series covers the window and nothing outside it',
    );
  });

  it('★ widens with --days, which is how the 30-day turn is seen', async () => {
    const owner = await registerOwner(api, tracker);
    const conv = await AIConversation.create({ businessId: owner.businessId, userId: owner.userId, title: 'window' });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await AIMessage.collection.insertOne({
      conversationId: conv._id,
      role: 'ASSISTANT',
      content: 'old',
      model: 'stub/model',
      createdAt: old,
      updatedAt: old,
    });

    const narrow = await cli(['--db', `--business=${owner.businessId}`, '--days=7', '--no-provider', '--json']);
    assert.equal(dbReport(narrow, '--days=7').turns, 0, 'outside the window');
    const wide = await cli(['--db', `--business=${owner.businessId}`, '--days=60', '--no-provider', '--json']);
    assert.equal(dbReport(wide, '--days=60').turns, 1, 'inside a wider one');
  });

  it('★ the database half is opt-in — no --db means no connection at all', async () => {
    const res = await cli([`--log=${logPath}`, '--no-provider', '--json']);
    const report = json(res);
    assert.equal('database' in report, false, 'the report must not touch the database unless asked');
    assert.equal(report.turns, 4, 'and the log half is unaffected');
  });
});

unitSuite('the AI usage report reads the log it is given, and nothing else', () => {
  it('★ counts turns, outcomes, requests and empty completions from the cost lines alone', async () => {
    const res = await cli([`--log=${logPath}`, '--no-provider', '--json']);
    const report = json(res);
    // The degraded warning and the access-log line are not turns. A count that included
    // either would overstate usage on exactly the turns that had trouble.
    assert.equal(report.turns, 4, 'only the four `AI turn` lines are turns');
    assert.deepEqual(report.outcomes, { ok: 2, AI_ABANDONED: 1, AI_OUTPUT_LIMIT: 1 });
    assert.equal(report.providerRequests, 7, '3 + 1 + 1 + 2 provider calls');
    assert.equal(report.toolRuns, 2);
    assert.equal(report.emptyResponses, 1);
    assert.equal(report.tokens.input, 3399 + 0 + 1200 + 0);
    assert.equal(report.tokens.output, 499 + 0 + 800 + 0);
    assert.equal(report.malformed, 1, 'the truncated line is reported, never silently dropped');
    assert.equal(report.degradedWarnings, 1, 'the AI-2 warning IS recognised — it is counted as a warning and not as a turn');
    // Named once, and `unknown` (a model the line could not name) is not a model.
    assert.deepEqual(report.models, ['stub/model']);
  });

  it('★ divides the allowance by what a turn actually costs, measured rather than assumed', async () => {
    const res = await cli([`--log=${logPath}`, '--no-provider', '--json']);
    const report = json(res);

    // 7 requests across 4 turns. This ratio is the whole reason the tool exists: a
    // 50-request day is ~28 turns at the cheap end and ~11 at this end, and only the log
    // can say which one a member is having.
    assert.equal(report.requestsPerTurn, 1.75);
    assert.equal(report.providerMs, 11973 + 12794 + 213 + 900);
    assert.equal(report.totalMs, 12598 + 12794 + 213 + 905);
    // A literal, not the same arithmetic re-run: the share is the ratio of the two SUMS
    // (what a member waits for), not the average of per-turn shares (which a fast turn
    // would drag down out of proportion).
    assert.equal(report.providerShare, 0.9762);
    assert.equal(
      report.tokens.input + report.tokens.output,
      4599 + 1299,
      'the truncated line contributed no tokens: an absent field is absent, never a zero',
    );
  });

  it('★ cannot print a credential, even when the log it read contained one', async () => {
    const text = await cli([`--log=${logPath}`, '--no-provider']);
    // A leak control that passes when the tool CRASHES is decoration, so the run itself is
    // asserted first: the planted key is only "not printed" if something was printed.
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /turns: 4/, 'positive control: the report really was produced');
    const all = `${text.stdout}\n${text.stderr}`;
    assert.ok(!all.includes(PLANTED_KEY), 'the report never echoes the log verbatim');
    assert.ok(!/sk-or-v1-[A-Za-z0-9-]{10,}/.test(all), 'no key-shaped string reaches stdout or stderr');
  });

  it('★ a missing log is a refusal, not an empty report', async () => {
    const res = await cli([`--log=${path.join(dir, 'nope.log')}`, '--no-provider']);
    // Exit 2 is the project's "NOT VERIFIED — nothing was checked" code (§27BP): reporting
    // zero turns here would read as "the assistant was never used".
    assert.equal(res.code, 2);
    assert.match(res.stderr, /could not read|not verified/i);
  });

  it('reads stdin when no log is named, so it can sit on the end of a pipe', () => {
    // spawnSync rather than execFile: only the sync form takes `input`. (The first version
    // of this case used execFile and would have passed an option the API ignores, testing
    // nothing.)
    const res = spawnSync(process.execPath, [SCRIPT, '--no-provider', '--json'], {
      cwd: SERVER_ROOT,
      input: FIXTURE,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(json({ code: res.status, stdout: res.stdout, stderr: res.stderr, killed: false }).turns, 4);
  });

  it('★ its own controls pass, and a control that cannot fail is not a control', async () => {
    const res = await cli(['--self-test']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /control\(s\) passed/i);
    assert.match(res.stdout, /must-fire/i, 'the controls are labelled by what they assert');
  });

  it('★ a dropped connection is a row in the report, never an unhandled error', async () => {
    // MEASURED THE HARD WAY. A full-suite run on 2026-10-19 failed this file with an empty
    // stdout and, once the helper above named the cause, an unhandled `MongoNetworkError:
    // connect ETIMEDOUT`. Two separate mistakes: the script had no `error` listener at all
    // (a mongoose `Connection` is an EventEmitter, so such an event is THROWN), and the first
    // fix detached the listener in `finally` — which the very next run caught, because a
    // pending socket times out DURING `disconnect()`. The report promises "an unreachable
    // database is a row, not a crash"; this pins the wiring that makes it true, against a
    // regression that is invisible to every other test in this file.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(source, /mongoose\.connection\.on\('error'/, 'the connection needs an error listener');
    assert.match(source, /mongoose\.connection\.on\('disconnected'/, 'a drop is reported, not thrown');
    assert.equal(
      /\.(off|removeListener)\(\s*'(error|disconnected)'/.test(source),
      false,
      'detaching the listener lets a teardown-time error crash the process — the defect this pins',
    );
    // Order matters: a listener added after the first `connect()` cannot absorb a failure
    // that happens during it.
    assert.ok(
      source.indexOf("connection.on('error'") < source.indexOf('await mongoose.connect('),
      'the error listener must be attached BEFORE connecting',
    );
  });

  it('★ the tool never writes anything, anywhere', async () => {
    // The read-only claim is the whole reason this can be run against production, so it is
    // pinned the way §27BF pinned the assistant's own read-only tools: by scanning the
    // source, with a control that proves the scanner can still fail.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const WRITE_CALL = /\.(create|insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|bulkWrite|save)\s*\(/;
    assert.equal(WRITE_CALL.test(source), false, 'the usage report must contain no write call');
    assert.equal(
      WRITE_CALL.test('await AIMessage.create({ role: \'ASSISTANT\' })'),
      true,
      'positive control: the scan must fail on a planted write',
    );
    assert.equal(
      WRITE_CALL.test('await AIMessage.countDocuments({ role: \'ASSISTANT\' })'),
      false,
      'negative control: a read verb is not a write',
    );
  });
});
