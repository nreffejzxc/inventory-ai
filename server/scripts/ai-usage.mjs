// `npm run ai:usage` — the assistant's own usage and failure report, READ-ONLY.
//
// WHY THIS EXISTS. The decision that is still open (ISS-22: whether the assistant stays on
// the free tier) needs one kind of evidence: how much of the allowance real turns spend, and
// what is failing. The tools that existed could not supply it. `perf:turns` measures real
// turns and SPENDS quota (~50 free requests a day IN TOTAL, §27BF) — the instrument consumes
// the thing being measured; the per-turn cost line (`AI turn …`, AI-5) records what every
// real turn actually cost, but nothing read those lines back. This script reads them, and
// asks the provider's own account how much of the allowance is left.
//
// IT MEASURES TWO THINGS AND JOINS THEM:
//   1. THE LOG, from `AI turn …` lines (AI-5) — turns, outcomes, provider requests, tool
//      rounds, empty completions, tokens, the model, and the provider/tool time split. The
//      number that matters most for a REQUEST-counting allowance is `calls`, summed: a
//      single member turn costs 1–3 provider requests (a tool round costs another call), so
//      "turns per day" is only derivable from the log.
//   2. THE PROVIDER, from `GET {OPENROUTER_BASE_URL}/v1/key` — the authoritative daily
//      free-model counter (`free_model_daily_requests`) and whether this key is on the free
//      tier at all. A GET is free and reads no model.
//
// IT IS READ-ONLY IN BOTH DIRECTIONS, and that is the whole point: no model is called, no
// database is touched, nothing is written, and no request spends quota — which is what makes
// it safe to run whenever the question comes up, rather than once.
//
// NO CREDENTIAL CAN REACH THE OUTPUT. The key is read from the environment and sent only in
// the request header. The provider's own body carries a masked `label`, which is omitted
// here rather than echoed, and nothing from the log is reprinted verbatim — a log line can
// contain a credential (a bad `.env` echo or a crash dump), and this tool prints NUMBERS it
// has parsed out of lines, never the lines.
//
// HOW TO RUN. `npm run ai:usage -- --log=<path>` reads a saved log; with no `--log` it reads
// stdin, so `npm start > server.log` (or a pipe) works. `--no-provider` skips the network.
// `--json` prints the same figures as one object. `--self-test` runs the controls only.
//
// EXIT CODES, kept apart for the reason §27BP gives — each one is a distinct claim:
//   0  a report was produced (an UNREADABLE provider section is a row in it, never a failure)
//   1  a control failed, so the report was not produced at all
//   2  NOT VERIFIED — no log could be read (a missing path, or no `--log` on a terminal), so
//      nothing was measured. Reporting zero turns here would read as "never used".
//
// ABSENT IS NOT ZERO, in both directions: a turn line missing a field contributes NOTHING to
// that sum (and is counted as malformed so the reader knows the columns are partial), and a
// provider body missing a counter reports `null` rather than 0. That rule is AI-10's, applied
// to a report whose entire job is to be trusted: "not measured" must never print as "none".

import 'dotenv/config';
import fs from 'node:fs';
import process from 'node:process';
import mongoose from 'mongoose';

import env from '../src/config/env.ts';
// The models BARREL, not the single model this reads: it registers every schema, which is
// what the sibling measurement scripts found they needed the hard way.
import { AIMessage } from '../src/models/index.ts';

/** Every field a complete `AI turn` line carries (AI-5's shape, in ai.service.ts). */
const TURN_FIELDS = [
  'outcome',
  'total',
  'providerMs',
  'toolMs',
  'calls',
  'toolRuns',
  'empty',
  'in',
  'out',
  'model',
  'iterations',
  'tools',
];

// Exported since AI-27: `perf:turns` reads the same allowance through this module's reader,
// and a second copy of the provider's base URL is how two tools end up asking two different
// hosts about the same account.
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api';

/** First match of `name=<value>` in a line, or null. Values stop at whitespace. */
function field(line, name) {
  const m = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line);
  return m ? m[1] : null;
}

/** First match of `name=<digits>` in a line as a number, or null when absent. */
function numField(line, name) {
  const raw = field(line, name);
  if (raw === null) return null;
  const stripped = raw.endsWith('ms') ? raw.slice(0, -2) : raw;
  if (!/^\d+$/.test(stripped)) return null;
  return Number.parseInt(stripped, 10);
}

/**
 * Parse a log (or any text) into the turns it recorded.
 *
 * A `AI turn` line is counted even when it is incomplete — a restart can cut one in half,
 * and dropping it would UNDERSTATE usage, which is the one direction a quota report must not
 * err in. Its present fields are used; its absent ones contribute nothing; and it is named in
 * `malformed` so a reader knows some columns are partial.
 *
 * `AI degraded turn …` (AI-2) is deliberately NOT a turn: it is a second line about a turn
 * already recorded, so counting it would inflate the turn count on exactly the turns that had
 * trouble.
 */
export function parseLog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const turns = [];
  let malformed = 0;
  let degradedWarnings = 0;

  for (const line of lines) {
    if (line.includes('AI degraded turn')) {
      degradedWarnings += 1;
      continue;
    }
    if (!line.includes('AI turn outcome=')) continue;

    const record = {};
    for (const name of TURN_FIELDS) record[name] = name === 'tools' ? (field(line, 'tools') ?? null) : numField(line, name);
    record.outcome = field(line, 'outcome');
    record.model = field(line, 'model');
    record.tools = field(line, 'tools');
    const complete = TURN_FIELDS.every((name) => record[name] !== null && record[name] !== '');
    if (!complete) malformed += 1;
    record.malformed = !complete;
    turns.push(record);
  }

  return { turns, malformed, degradedWarnings };
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * The figures a reader wants, computed from the parsed turns.
 *
 * `providerShare` is the ratio of the two SUMS rather than the average of per-turn shares:
 * it answers "where did this member's waiting go overall", and averaging per-turn shares
 * would let a 200 ms turn weigh as much as a 20 s one.
 */
export function summarize(parsed) {
  const turns = parsed.turns;
  const outcomeCounts = {};
  for (const t of turns) {
    const key = t.outcome ?? 'UNKNOWN';
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
  }
  const providerMs = sum(turns.map((t) => t.providerMs ?? 0));
  const toolMs = sum(turns.map((t) => t.toolMs ?? 0));
  const totalMs = sum(turns.map((t) => t.total ?? 0));
  const providerRequests = sum(turns.map((t) => t.calls ?? 0));
  const models = [...new Set(turns.map((t) => t.model).filter((m) => m && m !== 'unknown'))].sort();

  return {
    turns: turns.length,
    outcomes: outcomeCounts,
    malformed: parsed.malformed,
    degradedWarnings: parsed.degradedWarnings,
    providerRequests,
    toolRuns: sum(turns.map((t) => t.toolRuns ?? 0)),
    emptyResponses: sum(turns.map((t) => t.empty ?? 0)),
    tokens: { input: sum(turns.map((t) => t.in ?? 0)), output: sum(turns.map((t) => t.out ?? 0)) },
    providerMs,
    toolMs,
    totalMs,
    providerShare: totalMs ? Number((providerMs / totalMs).toFixed(4)) : null,
    requestsPerTurn: turns.length ? Number((providerRequests / turns.length).toFixed(2)) : null,
    models,
  };
}

/** A number, or `null` when the provider did not report one — never a zero. */
function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The safe slice of the provider's `/v1/key` body.
 *
 * `label` is DELIBERATELY NOT RETURNED. The provider masks it as `sk-or-v1-e38...8ec`, but a
 * masked credential is still a credential fragment, and this report is written to be
 * pasted into a record.
 */
export function providerUsage(body) {
  const d = body?.data ?? body ?? {};
  const daily = d.free_model_daily_requests ?? null;
  return {
    isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    daily: daily
      ? {
          used: numOrNull(daily.used),
          limit: numOrNull(daily.limit),
          remaining: numOrNull(daily.remaining),
        }
      : null,
    paidUsage: numOrNull(d.usage),
    paidUsageDaily: numOrNull(d.usage_daily),
    paidUsageMonthly: numOrNull(d.usage_monthly),
    creditLimit: numOrNull(d.limit),
    creditRemaining: numOrNull(d.limit_remaining),
  };
}

/** How many whole turns the remaining allowance buys at the measured cost per turn. */
export function capacity(remaining, requestsPerTurn) {
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  if (!Number.isFinite(requestsPerTurn) || requestsPerTurn <= 0) return null;
  return Math.floor(remaining / requestsPerTurn);
}

/**
 * One sentence about a reading, for the two places that print it (`--provider-only` and the
 * `perf:turns` preflight).
 *
 * IT EXISTS BECAUSE THE FIRST VERSION DID NOT: the preflight printed `${status} — ${detail}`
 * unconditionally, and an `OK` reading with no free-model counter has no `detail`, so the live
 * run against the stub printed `[turns] allowance: OK — undefined`. A reading that came back
 * fine and a reading that failed must not be able to share a sentence, and a missing counter is
 * a third case: it is not a failure, it is a key with no cap to report.
 */
export function allowanceLine(usage) {
  if (usage?.status !== 'OK') {
    return `${usage?.status ?? 'UNKNOWN'} — ${usage?.detail ?? 'no detail reported'}`;
  }
  const daily = usage.daily;
  if (!daily || !Number.isFinite(daily.remaining)) {
    return 'the provider reported no free-model daily counter (a paid key has none)';
  }
  return `${daily.remaining} of ${daily.limit} free-model request(s) left today (used ${daily.used})`;
}

/**
 * Is there enough allowance left for `needed` more requests?
 *
 * The one place this judgement lives, so `perf:turns` (AI-27) refuses to spend a day's
 * allowance on turns that cannot succeed, using the same reading this report prints.
 *
 * Returns `null` when there is nothing to refuse on — a reading that FAILED
 * (`UNREADABLE`, `NOT_CONFIGURED`, `SKIPPED`) or one where the provider reported no
 * free-model counter (a paid key has none). A diagnostic that cannot see must not
 * pretend a shortfall it cannot measure: the caller reports the reading and proceeds,
 * and the turn itself remains the source of truth about a 429.
 *
 * Returns `{ remaining, limit, used, needed }` when the shortfall is KNOWN.
 */
export function shortfall(usage, needed) {
  if (usage?.status !== 'OK') return null;
  const remaining = usage?.daily?.remaining;
  if (!Number.isFinite(remaining)) return null;
  if (!Number.isFinite(needed) || needed <= 0) return null;
  if (remaining >= needed) return null;
  return { remaining, limit: usage.daily.limit, used: usage.daily.used, needed };
}

/**
 * Ask the provider's own account. A GET, so it is free and reads no model.
 *
 * Nothing here can throw: an unreachable or undecodable answer is `UNREADABLE`, which the
 * report prints as a row. That is the same rule the upgrade watches follow — a reading that
 * failed must not look like a reading that came back clean.
 */
export async function readProviderUsage({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  // BOUNDED, because a report and a preflight are both things a person waits for. An
  // unanswered socket used to hold the command open indefinitely; the same reading now
  // gives up and says so, which is the same contract every other failure here follows.
  timeoutMs = 15000,
} = {}) {
  const key = (apiKey ?? '').trim();
  if (!key) return { status: 'NOT_CONFIGURED', detail: 'OPENROUTER_API_KEY is not set in this environment' };
  const url = `${String(baseUrl).trim().replace(/\/+$/, '')}/v1/key`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return { status: 'UNREADABLE', detail: `HTTP ${res.status}` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { status: 'UNREADABLE', detail: 'the answer was not JSON' };
    }
    return { status: 'OK', ...providerUsage(body) };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'UNREADABLE', detail: `no answer within ${timeoutMs} ms` };
    }
    return { status: 'UNREADABLE', detail: `the request failed (${err?.name ?? 'error'})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The durable half: what the DATABASE already knows about stored turns.
 *
 * WHY THIS IS POSSIBLE WITHOUT A SCHEMA CHANGE. `AIMessage` has stored `model`, `toolsUsed`,
 * `usage` and (since AI-8) `degraded` on every assistant turn all along, and its own comment
 * says why: *"the rate of each reason becomes countable from the database rather than only
 * from a log file that rotation will eat."* That is exactly the gap this source closes —
 * production usage figures with no new field, no log sink and no credential.
 *
 * WHAT IT CANNOT SHOW, said plainly because the alternative is a report that lies by
 * omission: a FAILED turn persists NOTHING (Phase 07E / M7 — a conversation's messages are
 * written together only once an answer exists), so a timeout, an abandoned turn, an output
 * limit and a quota refusal appear only in the log. The two halves are complements, not
 * alternatives: the database is durable and production-visible and covers what was ANSWERED;
 * the log covers what was NOT.
 *
 * EVERY FIGURE IS COMPUTED INSIDE MONGODB. One aggregation returns one document per group,
 * the same rule SCALE-dashboard-counts pins for the dashboard: moving documents to the app to
 * count them is what turns a report into a load test. Only the aggregate is read.
 */
export async function readDatabaseUsage({ businessId, days = 7, model = AIMessage, connection = mongoose } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const match = { role: 'ASSISTANT', createdAt: { $gte: since } };
  if (businessId) {
    // Scoped through the conversation, because a message carries no businessId of its own.
    const conversations = await connection.connection.db
      .collection('ai_conversations')
      .find({ businessId: new mongoose.Types.ObjectId(String(businessId)) }, { projection: { _id: 1 } })
      .toArray();
    match.conversationId = { $in: conversations.map((c) => c._id) };
  }

  const group = (id, extra = {}) => [{ $match: match }, { $group: { _id: id, turns: { $sum: 1 }, ...extra } }];

  const [totals, perDay, perModel, degraded, tokens, tools] = await Promise.all([
    model.aggregate(group('$conversationId')),
    model.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, turns: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    model.aggregate(group({ $ifNull: ['$model', 'unnamed'] })),
    model.aggregate(group({ $ifNull: ['$degraded', ''] })),
    model.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: null,
          input: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
          output: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
        },
      },
    ]),
    model.aggregate([{ $match: match }, { $unwind: '$toolsUsed' }, { $group: { _id: '$toolsUsed', turns: { $sum: 1 } } }, { $sort: { turns: -1 } }]),
  ]);

  const fromRows = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.turns]));
  const degradedReasons = {};
  let healthyTurns = 0;
  for (const row of degraded) {
    const reason = String(row._id ?? '');
    if (reason) degradedReasons[reason] = row.turns;
    else healthyTurns += row.turns;
  }

  return {
    status: 'OK',
    database: env.mongodbDbName,
    days,
    // Counted in MongoDB, so `turns` is the sum of one number per conversation rather than
    // the length of an array of documents.
    turns: totals.reduce((n, r) => n + r.turns, 0),
    conversations: totals.length,
    // Named `perDay` rather than `series` (vague in JSON) and not `days` (which is the window).
    perDay: perDay.map((r) => ({ day: String(r._id), turns: r.turns })),
    models: fromRows(perModel),
    tools: fromRows(tools),
    // "not marked degraded" rather than "verified healthy": a message written before AI-8
    // cannot carry the mark, so this is a lower bound on the degraded count, not an upper one.
    healthyTurns,
    degradedReasons,
    tokens: tokens.length ? { input: tokens[0].input, output: tokens[0].output } : { input: 0, output: 0 },
  };
}

/** The human report. Reads `summary` and `provider`; never reads the log or the key. */
export function formatReport({ summary, provider, source, database }) {
  const out = [];
  const dash = (v) => (v === null || v === undefined ? 'n/a' : String(v));
  out.push('[ai-usage] read-only report — no model was called and no quota was spent');
  out.push(`  source: ${source}`);
  out.push('');
  out.push(`  turns: ${summary.turns}${summary.malformed ? ` (${summary.malformed} malformed — counted, with partial columns)` : ''}`);
  const outcomes = Object.entries(summary.outcomes).sort((a, b) => b[1] - a[1]);
  out.push(`  outcomes: ${outcomes.length ? outcomes.map(([k, v]) => `${k}=${v}`).join(' ') : 'none'}`);
  out.push(`  provider requests: ${summary.providerRequests} across ${summary.turns} turn(s) → ${dash(summary.requestsPerTurn)} per turn`);
  out.push(`  tool rounds: ${summary.toolRuns} · empty completions: ${summary.emptyResponses} · degraded warnings: ${summary.degradedWarnings}`);
  out.push(`  time: provider ${summary.providerMs} ms · tools ${summary.toolMs} ms · total ${summary.totalMs} ms (provider share ${summary.providerShare === null ? 'n/a' : summary.providerShare})`);
  out.push(`  tokens: in ${summary.tokens.input} · out ${summary.tokens.output}`);
  out.push(`  models: ${summary.models.length ? summary.models.join(', ') : 'none named'}`);
  out.push('');
  if (database && database.status === 'OK') {
    const entries = (map) =>
      Object.entries(map ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    out.push(`  stored turns (database ${database.database}, last ${database.days} day(s)):`);
    out.push(`    turns: ${database.turns} across ${database.conversations} conversation(s)`);
    out.push(`    not-marked-degraded: ${database.healthyTurns} · degraded: ${entries(database.degradedReasons) || 'none'}`);
    out.push(`    tokens: in ${database.tokens.input} · out ${database.tokens.output}`);
    out.push(`    models: ${entries(database.models) || 'none'} · tools: ${entries(database.tools) || 'none'}`);
    out.push(`    per day (UTC): ${database.perDay.map((d) => `${d.day}=${d.turns}`).join(' ') || 'none'}`);
    // The sentence that keeps this half from being read as a complete usage picture.
    out.push('    only ANSWERED turns are stored: a failed turn persists nothing (Phase 07E / M7), so');
    out.push('    timeouts, abandonment, output limits and quota refusals appear in the log half alone.');
    out.push('    "not-marked-degraded" is a lower bound — a turn written before AI-8 cannot carry the mark.');
  } else if (database && database.status !== 'SKIPPED') {
    out.push(`  stored turns: ${database.status} — ${database.detail}`);
  }
  out.push('');
  if (provider.status === 'OK') {
    out.push('  provider account (GET /v1/key — read-only):');
    out.push(`    free tier: ${dash(provider.isFreeTier)}`);
    if (provider.daily) {
      out.push(`    free-model requests today: ${dash(provider.daily.used)} used of ${dash(provider.daily.limit)} · ${dash(provider.daily.remaining)} remaining`);
      const turns = capacity(provider.daily.remaining, summary.requestsPerTurn);
      out.push(
        `    → at ${dash(summary.requestsPerTurn)} request(s) per turn, the remaining allowance is about ${dash(turns)} more turn(s)`,
      );
    } else {
      out.push('    the provider reported no daily free-model counter (the key may not be on the free tier)');
    }
    out.push(`    paid usage: ${dash(provider.paidUsage)} (today ${dash(provider.paidUsageDaily)}, this month ${dash(provider.paidUsageMonthly)})`);
  } else {
    // Reported, never counted as a pass — and deliberately not fatal: the log half of the
    // report is still a real measurement.
    out.push(`  provider account: ${provider.status} — ${provider.detail}`);
  }
  out.push('');
  // The one place this report could mislead, said out loud: the ratio is from the given log.
  out.push('  The provider counter is authoritative and its day boundary is UTC; the figures');
  out.push('  from the log describe only the log this was given. The requests-per-turn ratio comes');
  out.push('  from that same log — a turn that runs a tool costs more than one request, so a log of');
  out.push('  cheap turns overstates how many turns the remaining allowance buys.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Controls. A report whose arithmetic nobody checks is a comfortable fiction, so every
// property this tool claims is one case here, labelled by what it asserts.
// ---------------------------------------------------------------------------

const PLANTED_KEY = 'sk-or-v1-PLANTED-0000000000000000000000000000000000000000'; // secret-guard:allow (a deliberate fixture: the leak control needs a key-shaped string to prove the report cannot print one)

function runControls() {
  const failures = [];
  const mustFire = [];
  const mustNotFire = [];
  const check = (list, name, fn) => {
    try {
      fn();
      list.push(name);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  };
  const mustFireCase = (name, fn) => check(mustFire, name, fn);
  const mustNotFireCase = (name, fn) => check(mustNotFire, name, fn);
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label ?? 'value'} expected ${e}, got ${a}`);
  };

  const healthy =
    'AI turn outcome=ok total=12598ms providerMs=11973ms calls=3 toolMs=625ms toolRuns=1 tools=getInventorySummary empty=1 in=3399 out=499 model=stub/model iterations=3';

  mustFireCase('a complete turn line is parsed', () => {
    const s = summarize(parseLog(healthy));
    eq(s.turns, 1, 'turns');
    eq(s.providerRequests, 3, 'requests');
    eq(s.tokens, { input: 3399, output: 499 }, 'tokens');
    eq(s.models, ['stub/model'], 'models');
  });

  mustNotFireCase('a degraded warning is not a second turn', () => {
    const p = parseLog(`AI degraded turn reason=EMPTY_COMPLETION attempts=3 empty=2 model=stub/model\n${healthy}`);
    eq(p.turns.length, 1, 'turns');
    eq(p.degradedWarnings, 1, 'degraded warnings');
  });

  mustNotFireCase('an access-log line is not a turn', () => {
    eq(parseLog('{"type":"http","path":"/api/ai/chat","status":201}').turns.length, 0, 'turns');
  });

  mustFireCase('a turn with no provider call (an abandoned turn) still counts', () => {
    const s = summarize(
      parseLog('AI turn outcome=AI_ABANDONED total=12794ms providerMs=12794ms calls=0 toolMs=0ms toolRuns=0 tools=none empty=0 in=0 out=0 model=unknown iterations=1'),
    );
    eq(s.turns, 1, 'turns');
    eq(s.outcomes, { AI_ABANDONED: 1 }, 'outcomes');
  });

  mustFireCase('a truncated turn line is counted AND reported malformed', () => {
    const p = parseLog('AI turn outcome=ok total=905ms providerMs=900ms calls=2 toolMs=5ms toolRuns=1 tools=');
    eq(p.turns.length, 1, 'turns');
    eq(p.malformed, 1, 'malformed');
    eq(summarize(p).providerRequests, 2, 'requests');
  });

  mustNotFireCase('an absent field contributes nothing to a sum (absent, never zeroed)', () => {
    const p = parseLog('AI turn outcome=ok total=905ms providerMs=900ms calls=2 toolMs=5ms toolRuns=1 tools=');
    eq(summarize(p).tokens, { input: 0, output: 0 }, 'tokens');
  });

  mustFireCase('an unknown outcome is still counted as a turn', () => {
    eq(summarize(parseLog('AI turn outcome=SOMETHING_NEW total=1ms providerMs=1ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=1 out=1 model=m iterations=1')).outcomes, { SOMETHING_NEW: 1 }, 'outcomes');
  });

  mustFireCase('requests per turn is the measured ratio', () => {
    const seven = `${healthy}\nAI turn outcome=ok total=1ms providerMs=1ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=1 out=1 model=m iterations=1`;
    const four = `${seven}\nAI turn outcome=ok total=1ms providerMs=1ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=1 out=1 model=m iterations=1\nAI turn outcome=ok total=1ms providerMs=1ms calls=2 toolMs=0ms toolRuns=0 tools=none empty=0 in=1 out=1 model=m iterations=1`;
    // 3+1+1+2 requests over four turns.
    eq(summarize(parseLog(four)).requestsPerTurn, 1.75, 'requests per turn');
  });

  mustFireCase('the provider share is the ratio of the sums, not an average of shares', () => {
    const log = `${healthy}\nAI turn outcome=AI_ABANDONED total=12794ms providerMs=12794ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=0 out=0 model=unknown iterations=1\nAI turn outcome=AI_OUTPUT_LIMIT total=213ms providerMs=213ms calls=1 toolMs=0ms toolRuns=0 tools=none empty=0 in=1200 out=800 model=stub/model iterations=1\nAI turn outcome=ok total=905ms providerMs=900ms calls=2 toolMs=5ms toolRuns=1 tools=`;
    const s = summarize(parseLog(log));
    eq(s.providerShare, 0.9762, 'provider share');
    eq(s.turns, 4, 'turns');
    eq(s.malformed, 1, 'malformed');
  });

  mustNotFireCase('the report cannot print a credential planted in the log', () => {
    const text = formatReport({
      summary: summarize(parseLog(`OPENROUTER_API_KEY=${PLANTED_KEY}\n${healthy}`)),
      provider: { status: 'NOT_CONFIGURED', detail: 'OPENROUTER_API_KEY is not set in this environment' },
      source: 'stdin',
    });
    if (text.includes(PLANTED_KEY)) throw new Error('the report echoed the planted key');
    if (/sk-or-v1-[A-Za-z0-9-]{10,}/.test(text)) throw new Error('a key-shaped string reached the report');
  });

  mustFireCase('the provider counters are read, and the masked label is dropped', () => {
    const u = providerUsage({
      data: {
        label: 'sk-or-v1-e38...8ec',
        is_free_tier: true,
        free_model_daily_requests: { used: 37, limit: 50, remaining: 13 },
        usage: 0,
        usage_daily: 0,
        usage_monthly: 0,
        limit: null,
        limit_remaining: null,
      },
    });
    eq(u.daily, { used: 37, limit: 50, remaining: 13 }, 'daily');
    eq(u.isFreeTier, true, 'free tier');
    if ('label' in u) throw new Error('the provider label is returned and would be printed');
  });

  mustNotFireCase('a counter the provider omitted stays null, never zero', () => {
    const u = providerUsage({ data: { is_free_tier: true, free_model_daily_requests: { used: 4 } } });
    eq(u.daily, { used: 4, limit: null, remaining: null }, 'daily');
  });

  mustNotFireCase('capacity is null rather than a division by an unmeasured zero', () => {
    eq(capacity(null, 1.75), null, 'no remaining');
    eq(capacity(13, 0), null, 'no turns measured');
    eq(capacity(13, 1.75), 7, 'capacity');
  });

  mustNotFireCase('the report is produced when the provider section is unreadable', () => {
    const text = formatReport({
      summary: summarize(parseLog(healthy)),
      provider: { status: 'UNREADABLE', detail: 'HTTP 429' },
      source: 'server.log',
    });
    if (!text.includes('UNREADABLE')) throw new Error('an unreadable provider section was not reported');
    if (!text.includes('turns: 1')) throw new Error('the log half of the report was dropped');
  });

  return { failures, mustFire, mustNotFire };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

/** Where the log comes from: a named file, or stdin — and a refusal when neither can work. */
export async function readSource({ logPath, stdinIsTty, readFile, readInput }) {
  if (logPath) {
    try {
      return { ok: true, source: logPath, text: await readFile(logPath, 'utf8') };
    } catch (err) {
      return { ok: false, detail: `the log at ${logPath} could not be read (${err?.code ?? 'error'})` };
    }
  }
  if (stdinIsTty) {
    return { ok: false, detail: 'no --log was given and stdin is a terminal, so there is nothing to read' };
  }
  return { ok: true, source: 'stdin', text: await readInput() };
}

async function main() {
  const controls = runControls();
  if (process.argv.includes('--self-test') || controls.failures.length) {
    const total = controls.mustFire.length + controls.mustNotFire.length;
    if (controls.failures.length) {
      console.error(`[ai-usage] ${controls.failures.length} control(s) FAILED — the report was not produced:`);
      for (const failure of controls.failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(
      `[ai-usage] ${total} control(s) passed (${controls.mustFire.length} must-fire, ${controls.mustNotFire.length} must-not-fire)`,
    );
    process.exit(0);
  }

  // THE ALLOWANCE ON ITS OWN (AI-27). "Is there quota left to run a measurement?" is the
  // cheapest question this tool can answer and used to be the most expensive to ask: the
  // report needs a log file (or `--db`), so a person holding a spent day had to produce a
  // log before they could be told the day was spent. `--provider-only` reads the provider's
  // own counters and nothing else — no log, no database, no model, no quota.
  if (process.argv.includes('--provider-only')) {
    const provider = await readProviderUsage({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    });
    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify(
          { readAt: new Date().toISOString(), source: 'not requested (--provider-only)', provider },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    console.log('[ai-usage] provider allowance — read-only, no log, no database, no model call');
    if (provider.status === 'OK') {
      const tier = provider.isFreeTier === null ? 'not reported' : provider.isFreeTier ? 'yes' : 'no';
      console.log(`  free tier            : ${tier}`);
      console.log(`  free-model requests  : ${allowanceLine(provider)} (UTC day; resets 00:00 UTC)`);
    } else {
      console.log(`  ${provider.status}: ${provider.detail}`);
    }
    process.exit(0);
  }

  const logPath = argValue('--log');
  const wantDb = process.argv.includes('--db');
  const days = Number.parseInt(argValue('--days') ?? '7', 10) || 7;
  const businessId = argValue('--business');

  // THE LOG HALF IS OPTIONAL WHEN --db IS GIVEN. Without this, `--db` on a terminal would
  // fall through to the stdin branch and refuse for having no log, which is the wrong refusal:
  // the database half needs no log at all.
  let read = { ok: true, source: 'not requested (--db was given)', text: '' };
  if (logPath || !wantDb) {
    read = await readSource({
      logPath,
      stdinIsTty: Boolean(process.stdin.isTTY),
      readFile: fs.promises.readFile,
      readInput: readStdin,
    });
    if (!read.ok) {
      console.error(`[ai-usage] NOT VERIFIED — ${read.detail}.`);
      process.exit(2);
    }
  }
  const summary = summarize(parseLog(read.text));

  let database = { status: 'SKIPPED', detail: 'not requested (no --db)' };
  if (wantDb) {
    // A DROPPED CONNECTION IS A ROW, NOT A CRASH — pinned here because it was not, and it
    // cost an investigation. `config/db.ts` attaches these handlers for the server; this
    // script deliberately does not import it (it must work with no app booted), so until
    // 2026-10-19 it connected with NO `error` listener at all. A mongoose `Connection` is an
    // EventEmitter: an `error` event with no listener is THROWN, so a transient drop in the
    // middle of a read killed the process with a stack trace and — this is the damaging
    // part — EMPTY stdout, because the report is printed only after the read returns. A
    // full-suite run then reported `Unexpected end of JSON input` and the real cause (an
    // Atlas blip) had been thrown away. The status line above promises "an unreachable
    // database is a row in the report, not a crash"; these two listeners are what makes
    // that promise true for a failure that arrives asynchronously.
    // THE LISTENERS ARE NEVER REMOVED, and that is the correction the first version of this
    // fix needed: it detached them in `finally`, and the very next full-suite run failed
    // again with `connect ETIMEDOUT …:27017` arriving DURING `disconnect()` — a pending
    // socket's timeout surfaces after the read is over, when no `catch` can see it and no
    // listener was left to absorb it. A one-shot report process has nothing to leak, so they
    // stay attached for the life of the process.
    const connectionFaults = [];
    mongoose.connection.on('error', (err) => connectionFaults.push(err?.name ?? 'Error'));
    mongoose.connection.on('disconnected', () => connectionFaults.push('disconnected'));
    try {
      // No `serverSelectionTimeoutMS` override: the default 30s is what this host needs
      // (measured 2026-10-19 — the same cluster took 15.8s to select and a 5s bound failed
      // outright), and a wrong bound here would turn a slow network into a false UNREADABLE.
      await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
      database = await readDatabaseUsage({ businessId, days });
    } catch (err) {
      // Read-only and best-effort: an unreachable database is a row in the report, not a
      // crash — but if it was the ONLY source asked for, the whole run measured nothing.
      database = {
        status: 'UNREADABLE',
        detail: `the database could not be read (${err?.name ?? connectionFaults.at(-1) ?? 'error'})`,
      };
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
    if (database.status !== 'OK' && !logPath && read.source.startsWith('not requested')) {
      console.error(`[ai-usage] NOT VERIFIED — ${database.detail}.`);
      process.exit(2);
    }
  }

  const provider = process.argv.includes('--no-provider')
    ? { status: 'SKIPPED', detail: 'not requested (--no-provider)' }
    : await readProviderUsage({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
      });

  if (process.argv.includes('--json')) {
    const payload = { readAt: new Date().toISOString(), source: read.source, ...summary, provider };
    // Absent unless asked for, so a reader can tell "not requested" from "zero turns".
    if (wantDb) payload.database = database;
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log(formatReport({ summary, provider, source: read.source, database: wantDb ? database : null }));
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('ai-usage.mjs');
if (invokedDirectly) {
  await main();
}
