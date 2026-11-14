// Staging P4 concurrency drill: two users, several conversations, two simultaneous waves.
//
// WHAT THIS PROVES. The route admits independent conversations at the same time, while a duplicate
// request for the SAME conversation is refused by the single-flight guard before the provider is
// reached. It also checks that the staging HTTP server stays healthy under a small concurrent burst
// and that every admitted turn persisted exactly one USER and one ASSISTANT message.
//
// WHAT THIS IS NOT. It is not a load test of the provider, a multi-instance test, or a production
// run. The single-flight guard is process-local by design.
//
// Required:
//   NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db
//   P4_CONFIRM=staging-concurrency-drill
//   P4_BASE=http://127.0.0.1:4000
//   The PERF SEED staging tenant must exist.
// Optional:
//   P4_WAVES=2 P4_CONCURRENCY=4
//
// AI access is a local session; no Firebase token or password is needed.

import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../../src/config/env.ts';
import Business from '../../src/models/business.model.ts';
import Session from '../../src/models/session.model.ts';
import User from '../../src/models/user.model.ts';
import productService from '../../src/services/product.service.ts';
import { signAccessToken } from '../../src/config/jwt.ts';
import { createSessionForToken, newSessionId } from '../../src/services/session.service.ts';

const CONFIRM = 'staging-concurrency-drill';
const BASE_URL = (process.env.P4_BASE || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const STAGING_DATABASES = new Set([DATABASE_NAMES.development, 'inventoryai_staging_db']);
const BUSINESS_NAME = 'PERF SEED — AI assistant stress test (do not use)';
const OWNER_EMAIL = 'perf-seed-ai@example.invalid';
const MANAGER_EMAIL = 'perf-p4-manager@example.invalid';
const WAVES = Math.max(1, Number.parseInt(process.env.P4_WAVES || '2', 10));
const CONCURRENCY = Math.max(2, Number.parseInt(process.env.P4_CONCURRENCY || '4', 10));
// The restock-count question is the stable free-route tool path: the gate called
// getReorderNeededProducts for it 4/4 times. A per-SKU question is deliberately not used here;
// the free model intermittently answered that one without its required getInventory read, which
// is a separate reliability finding and would turn this concurrency drill into a retry test.
const QUESTION = 'How many products need restocking?';
const REQUIRED_TOOL = 'getReorderNeededProducts';
const OUT = '.tmp-staging-concurrency.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`[concurrency] ${message}`);
  process.exit(2);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function answerLooksCorrect(result, expected) {
  const text = String(result.content ?? '');
  const number = new RegExp(`\\b${String(expected).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*')}\\b`);
  return (
    number.test(text) &&
    /\b(?:products?|items?|skus?)\b/i.test(text) &&
    result.toolsUsed.includes(REQUIRED_TOOL)
  );
}

async function request(token, method, path, body) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // The status and raw prefix below remain enough to diagnose a non-JSON failure.
  }
  return { status: response.status, json, raw };
}

async function createConversation(token, title) {
  const result = await request(token, 'POST', '/ai/conversations', { title });
  if (result.status !== 201 || !result.json?.conversation?.id) {
    throw new Error(`conversation create returned HTTP ${result.status}: ${result.raw.slice(0, 200)}`);
  }
  return result.json.conversation.id;
}

async function messages(token, conversationId) {
  const result = await request(token, 'GET', `/ai/conversations/${conversationId}/messages?limit=50`);
  if (result.status !== 200) {
    throw new Error(`message read returned HTTP ${result.status}: ${result.raw.slice(0, 200)}`);
  }
  return result.json;
}

async function ask(token, conversationId, question) {
  const started = Date.now();
  const body = { message: question, timeZone: 'Asia/Manila' };
  if (conversationId) body.conversationId = conversationId;
  const result = await request(token, 'POST', '/ai/chat', body);
  const assistant = result.json?.assistantMessage;
  return {
    status: result.status,
    durationMs: Date.now() - started,
    conversationId: result.json?.conversation?.id ?? assistant?.conversationId ?? conversationId ?? null,
    content: assistant?.content ?? '',
    model: assistant?.model ?? null,
    toolsUsed: Array.isArray(assistant?.toolsUsed) ? assistant.toolsUsed : [],
    turnId: result.json?.turnId ?? assistant?.turnId ?? null,
    degraded: result.json?.degraded ?? assistant?.degraded ?? null,
    code: result.json?.code ?? null,
    error: result.status >= 400 ? (result.json?.error ?? result.json?.message ?? result.raw.slice(0, 200)) : null,
  };
}

async function health() {
  const result = await request(null, 'GET', '/health');
  if (result.status !== 200) throw new Error(`health returned HTTP ${result.status}`);
  return result.json;
}

async function main() {
  if (process.env.P4_CONFIRM !== CONFIRM) fail(`set P4_CONFIRM=${CONFIRM}`);
  if (env.nodeEnv !== 'development' || !STAGING_DATABASES.has(env.mongodbDbName)) {
    fail(`refusing database ${env.mongodbDbName} in ${env.nodeEnv}; use the staging/dev database`);
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(BASE_URL)) fail('P4_BASE must be loopback HTTP');

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  const business = await Business.findOne({ name: BUSINESS_NAME }).lean();
  if (!business) throw new Error('the staging PERF SEED tenant does not exist');
  const owner = await User.findOne({
    businessId: business._id,
    email: OWNER_EMAIL,
    role: 'OWNER',
    status: 'ACTIVE',
  })
    .select('_id businessId email')
    .lean();
  if (!owner) throw new Error('the staging PERF SEED tenant has no active owner');

  // Ground truth comes from the same service the tool calls, not from the answer or a
  // hard-coded seed count. The gate normalises its tenant to five low-stock products; a
  // fresh 10k seed has many more, so a fixed 5 would make a correct answer look wrong.
  const reorder = await productService.listReorder(business._id, { limit: 1 });
  const expectedRestock = reorder.total;
  if (!Number.isInteger(expectedRestock) || expectedRestock < 0) {
    throw new Error(`could not read the restock ground truth: ${expectedRestock}`);
  }
  console.log(`[concurrency] restock ground truth=${expectedRestock}`);

  let manager = await User.findOne({ businessId: business._id, email: MANAGER_EMAIL }).lean();
  if (!manager) {
    manager = await User.create({
      businessId: business._id,
      name: 'P4 concurrency manager',
      email: MANAGER_EMAIL,
      role: 'MANAGER',
      status: 'ACTIVE',
      emailVerified: true,
    });
    manager = manager.toObject();
  } else {
    await User.updateOne(
      { _id: manager._id },
      { $set: { businessId: business._id, role: 'MANAGER', status: 'ACTIVE', emailVerified: true } },
    );
  }

  const sessions = [];
  const makeSession = async (user, label) => {
    const jti = newSessionId();
    const token = signAccessToken(user._id, jti);
    await createSessionForToken({
      userId: user._id,
      businessId: user.businessId,
      token,
      deviceLabel: label,
    });
    sessions.push(jti);
    return token;
  };
  const ownerToken = await makeSession(owner, 'p4 owner');
  const managerToken = await makeSession(manager, 'p4 manager');

  let sessionDeleted = false;
  const cleanup = async () => {
    if (sessionDeleted) return;
    sessionDeleted = true;
    if (sessions.length) await Session.deleteMany({ jti: { $in: sessions } });
    await mongoose.disconnect();
  };

  try {
    const healthBefore = await health();

    // 1. Same conversation: the first turn runs, the duplicate must be refused, then release.
    const duplicateConversation = await createConversation(ownerToken, 'p4 duplicate');
    const duplicateQuestion = QUESTION;
    const firstPromise = ask(ownerToken, duplicateConversation, duplicateQuestion);
    await sleep(500);
    const duplicate = await ask(ownerToken, duplicateConversation, QUESTION);
    const first = await firstPromise;
    if (first.status !== 201) {
      throw new Error(`first duplicate-test turn returned HTTP ${first.status}: ${first.error}`);
    }
    if (duplicate.status !== 409 || duplicate.code !== 'AI_TURN_IN_PROGRESS') {
      throw new Error(
        `duplicate returned HTTP ${duplicate.status} code=${duplicate.code}; expected 409 AI_TURN_IN_PROGRESS`,
      );
    }
    const duplicateMessages = await messages(ownerToken, duplicateConversation);
    const duplicateUserMessages = duplicateMessages.items.filter((message) => message.role === 'USER');
    const duplicateAssistantMessages = duplicateMessages.items.filter(
      (message) => message.role === 'ASSISTANT',
    );
    if (duplicateUserMessages.length !== 1 || duplicateAssistantMessages.length !== 1) {
      throw new Error(
        `duplicate test persisted ${duplicateUserMessages.length} USER and ` +
          `${duplicateAssistantMessages.length} ASSISTANT messages; expected 1 and 1`,
      );
    }
    if (duplicateUserMessages[0].content !== duplicateQuestion) {
      throw new Error('the persisted USER message is not the admitted question');
    }
    const followUp = await ask(ownerToken, duplicateConversation, QUESTION);
    if (followUp.status !== 201) {
      throw new Error(`follow-up after release returned HTTP ${followUp.status}: ${followUp.error}`);
    }
    const afterFollowUp = await messages(ownerToken, duplicateConversation);
    if (afterFollowUp.items.length !== 4) {
      throw new Error(`follow-up expected 4 messages, found ${afterFollowUp.items.length}`);
    }

    // 2. Concurrent waves: owner and manager, distinct conversations, one question per turn.
    const conversations = [];
    for (let i = 0; i < CONCURRENCY; i += 1) {
      const ownerTurn = i % 2 === 0;
      const token = ownerTurn ? ownerToken : managerToken;
      conversations.push({
        owner: ownerTurn,
        token,
        conversationId: await createConversation(
          token,
          `p4 ${ownerTurn ? 'owner' : 'manager'} ${i + 1}`,
        ),
      });
    }

    const waves = [];
    for (let wave = 1; wave <= WAVES; wave += 1) {
      const started = Date.now();
      const results = await Promise.all(
        conversations.map(async (entry) => {
          const result = await ask(entry.token, entry.conversationId, QUESTION);
          return {
            wave,
            user: entry.owner ? 'OWNER' : 'MANAGER',
            expected: expectedRestock,
            question: QUESTION,
            ...result,
            correct: result.status === 201 && answerLooksCorrect(result, expectedRestock),
          };
        }),
      );
      waves.push({ wave, durationMs: Date.now() - started, results });
      console.log(
        `[concurrency] wave=${wave} duration=${Date.now() - started}ms ` +
          results
            .map((result) => `${result.user}:${result.status}/${result.durationMs}ms`)
            .join(' '),
      );
    }

    const admitted = waves.flatMap((wave) => wave.results);
    const failures = admitted.filter((result) => result.status !== 201 || !result.correct);
    if (failures.length) {
      throw new Error(
        `${failures.length} concurrent turn(s) failed: ` +
          failures
            .map((result) => `${result.user}=${result.status} ${result.error ?? ''}`)
            .join('; '),
      );
    }
    const paid = admitted.filter((result) => !String(result.model ?? '').endsWith(':free'));
    const turnIds = new Set(admitted.map((result) => result.turnId).filter(Boolean));
    if (turnIds.size !== admitted.length) {
      throw new Error(`expected ${admitted.length} distinct turn ids, found ${turnIds.size}`);
    }

    for (const entry of conversations) {
      const stored = await messages(entry.token, entry.conversationId);
      const userMessages = stored.items.filter((message) => message.role === 'USER');
      const assistantMessages = stored.items.filter((message) => message.role === 'ASSISTANT');
      if (userMessages.length !== WAVES || assistantMessages.length !== WAVES) {
        throw new Error(
          `conversation ${entry.conversationId} has ${userMessages.length} USER / ` +
            `${assistantMessages.length} ASSISTANT messages; expected ${WAVES} each`,
        );
      }
    }

    const healthAfter = await health();
    const delta5xx =
      (healthAfter?.counters?.byStatusClass?.['5xx'] ?? 0) -
      (healthBefore?.counters?.byStatusClass?.['5xx'] ?? 0);
    const deltaServerErrors =
      (healthAfter?.counters?.serverErrors ?? 0) - (healthBefore?.counters?.serverErrors ?? 0);
    if (delta5xx !== 0 || deltaServerErrors !== 0) {
      throw new Error(`health counters moved: 5xx +${delta5xx}, serverErrors +${deltaServerErrors}`);
    }

    const latencies = admitted.map((result) => result.durationMs);
    const summary = {
      result: 'PASS',
      database: mongoose.connection.name,
      baseUrl: BASE_URL,
      tenant: String(business._id),
      settings: { waves: WAVES, concurrentRequestsPerWave: CONCURRENCY, users: 2 },
      duplicate: {
        firstStatus: first.status,
        firstDurationMs: first.durationMs,
        duplicateStatus: duplicate.status,
        duplicateCode: duplicate.code,
        persistedUserMessages: duplicateUserMessages.length,
        persistedAssistantMessages: duplicateAssistantMessages.length,
        followUpStatus: followUp.status,
        messagesAfterFollowUp: afterFollowUp.items.length,
      },
      waves: waves.map((wave) => ({
        wave: wave.wave,
        durationMs: wave.durationMs,
        results: wave.results,
      })),
      summary: {
        admittedTurns: admitted.length,
        distinctTurnIds: turnIds.size,
        allFree: paid.length === 0,
        freeServed: admitted.length - paid.length,
        paidServed: paid.length,
        allCorrect: failures.length === 0,
        minMs: Math.min(...latencies),
        medianMs: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        maxMs: Math.max(...latencies),
        health5xxDelta: delta5xx,
        healthServerErrorsDelta: deltaServerErrors,
      },
      healthBefore,
      healthAfter,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error(`[concurrency] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
