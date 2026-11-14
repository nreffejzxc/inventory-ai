// Staging P6: sustained provider-wide 503s across consecutive requests, then recovery.
//
// Unlike the P3 single-failure drill, this proxy fails EVERY configured model in the ordinary
// chain. Three consecutive turns must fail with a bounded API error (no partial answer, no
// unbounded retry loop), and two ordinary turns must succeed after the proxy is restored.
//
// Required:
//   NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db
//   DRILL_CONFIRM=staging-sustained-503
//   DRILL_BASE=http://127.0.0.1:4001
//   DRILL_PROXY=http://127.0.0.1:5055
//   DRILL_MODELS=openai/gpt-oss-20b,nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-ultra-550b-a55b:free
//   DRILL_TURNS=3 (default)
//
// The server must be started with OPENROUTER_BASE_URL pointing at the proxy and
// AI_MODEL_FAILURE_THRESHOLD high enough that the breaker does not skip models during the
// three-turn burst. That threshold is staging-only; production keeps its configured default.

import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../../src/config/env.ts';
import Business from '../../src/models/business.model.ts';
import Session from '../../src/models/session.model.ts';
import User from '../../src/models/user.model.ts';
import { signAccessToken } from '../../src/config/jwt.ts';
import { createSessionForToken, newSessionId } from '../../src/services/session.service.ts';
import productService from '../../src/services/product.service.ts';

const CONFIRM = 'staging-sustained-503';
const BASE_URL = (process.env.DRILL_BASE || 'http://127.0.0.1:4001').replace(/\/+$/, '');
const PROXY_URL = (process.env.DRILL_PROXY || 'http://127.0.0.1:5055').replace(/\/+$/, '');
const FAIL_MODELS = (process.env.DRILL_MODELS || '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const TURNS = Math.min(6, Math.max(1, Number.parseInt(process.env.DRILL_TURNS || '3', 10) || 3));
const QUESTION = 'What is the total stock value of my inventory?';
const BUSINESS_NAME = 'PERF SEED — AI assistant stress test (do not use)';
const OWNER_EMAIL = 'perf-seed-ai@example.invalid';
const STAGING_DATABASES = new Set([DATABASE_NAMES.development, 'inventoryai_staging_db']);
const OUT = '.tmp-staging-sustained-503.json';

function fail(message) {
  console.error(`[sustained-503] ${message}`);
  process.exit(2);
}

async function control(path) {
  const response = await fetch(`${PROXY_URL}/__control/${path}`, { method: 'POST' });
  if (!response.ok) throw new Error(`proxy ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function proxyStatus() {
  const response = await fetch(`${PROXY_URL}/__status`);
  if (!response.ok) throw new Error(`proxy status returned HTTP ${response.status}`);
  return response.json();
}

async function health() {
  const response = await fetch(`${BASE_URL}/api/health`);
  if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
  return response.json();
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
    // Keep the HTTP status and raw prefix for diagnosis.
  }
  return { status: response.status, json, raw };
}

async function ask(token, conversationId) {
  const started = Date.now();
  const result = await request(token, 'POST', '/ai/chat', {
    message: QUESTION,
    conversationId,
    timeZone: 'Asia/Manila',
  });
  const assistant = result.json?.assistantMessage;
  return {
    status: result.status,
    durationMs: Date.now() - started,
    content: assistant?.content ?? '',
    model: assistant?.model ?? null,
    toolsUsed: Array.isArray(assistant?.toolsUsed) ? assistant.toolsUsed : [],
    degraded: result.json?.degraded ?? assistant?.degraded ?? null,
    code: result.json?.code ?? null,
    error: result.status >= 400 ? (result.json?.error ?? result.json?.message ?? result.raw.slice(0, 300)) : null,
  };
}

async function main() {
  if (process.env.DRILL_CONFIRM !== CONFIRM) fail(`set DRILL_CONFIRM=${CONFIRM}`);
  if (env.nodeEnv !== 'development' || !STAGING_DATABASES.has(env.mongodbDbName)) {
    fail(`refusing database ${env.mongodbDbName} in ${env.nodeEnv}`);
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(BASE_URL)) fail('DRILL_BASE must be loopback');
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(PROXY_URL)) fail('DRILL_PROXY must be loopback');
  if (FAIL_MODELS.length < 1) fail('DRILL_MODELS must name at least one model');

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  const business = await Business.findOne({ name: BUSINESS_NAME }).lean();
  if (!business) throw new Error('the staging PERF SEED tenant does not exist');
  const owner = await User.findOne({
    businessId: business._id,
    email: OWNER_EMAIL,
    role: 'OWNER',
    status: 'ACTIVE',
  })
    .select('_id businessId')
    .lean();
  if (!owner) throw new Error('the staging PERF SEED tenant has no active owner');
  const groundTruth = await productService.stockValue(business._id, { limit: 1 });
  const expectedTotalValue = groundTruth.totalValue;
  if (typeof expectedTotalValue !== 'number' || !Number.isFinite(expectedTotalValue)) {
    throw new Error('the staging tenant has no finite stock-value total');
  }
  const expectedTotalText = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(
    expectedTotalValue,
  );

  const jti = newSessionId();
  const token = signAccessToken(owner._id, jti);
  await createSessionForToken({
    userId: owner._id,
    businessId: owner.businessId,
    token,
    deviceLabel: 'staging sustained 503 drill',
  });

  let sessionDeleted = false;
  const cleanup = async () => {
    if (sessionDeleted) return;
    sessionDeleted = true;
    await Session.deleteOne({ jti });
    await mongoose.disconnect();
  };

  try {
    const created = await request(token, 'POST', '/ai/conversations', {
      title: 'staging sustained provider outage',
    });
    if (created.status !== 201 || !created.json?.conversation?.id) {
      throw new Error(`conversation create returned HTTP ${created.status}`);
    }
    const conversationId = created.json.conversation.id;

    console.log(`[sustained-503] database=${mongoose.connection.name} base=${BASE_URL} proxy=${PROXY_URL}`);
    console.log(
    `[sustained-503] failing=${FAIL_MODELS.join(',')} turns=${TURNS} expectedTotal=${expectedTotalText}`,
  );

    const healthBefore = await health();
    const before5xx = healthBefore.counters?.byStatusClass?.['5xx'] ?? 0;
    const beforeServerErrors = healthBefore.counters?.serverErrors ?? 0;
    const beforeProxy = await proxyStatus();
    if (!FAIL_MODELS.every((model) => beforeProxy.failModels?.includes(model))) {
      throw new Error(
        `proxy does not fail every DRILL_MODELS entry: configured=${JSON.stringify(beforeProxy.failModels)}`,
      );
    }

    await control('fail');
    const failures = [];
    for (let index = 1; index <= TURNS; index += 1) {
      const before = (await proxyStatus()).failedRequests;
      const result = await ask(token, conversationId);
      const after = (await proxyStatus()).failedRequests;
      const record = {
        turn: index,
        ...result,
        proxyFailedDelta: after - before,
      };
      failures.push(record);
      console.log(
        `[sustained-503] failure ${index}/${TURNS} status=${result.status} code=${result.code ?? '-'} ` +
          `model=${result.model ?? '-'} providerCalls=${after - before} duration=${result.durationMs}ms ` +
          `error=${String(result.error ?? '').replace(/\s+/g, ' ').slice(0, 160)}`,
      );
      if (![502, 503].includes(result.status) || result.code !== 'AI_UNAVAILABLE') {
        throw new Error(
          `expected a bounded AI_UNAVAILABLE failure on turn ${index}, got ` +
            `HTTP ${result.status} code=${result.code ?? '-'}: ${result.error ?? ''}`,
        );
      }
      if (result.proxyFailedDelta < 1 || result.proxyFailedDelta > FAIL_MODELS.length) {
        throw new Error(
          `turn ${index} made ${result.proxyFailedDelta} provider calls; ` +
            `expected 1..${FAIL_MODELS.length} (no unbounded retry)`,
        );
      }
    }

    const healthAfterFailures = await health();
    const failure5xxDelta =
      (healthAfterFailures.counters?.byStatusClass?.['5xx'] ?? 0) - before5xx;
    const failureServerErrorDelta =
      (healthAfterFailures.counters?.serverErrors ?? 0) - beforeServerErrors;
    console.log(
      `[sustained-503] outage health: 5xxDelta=${failure5xxDelta} ` +
        `serverErrorDelta=${failureServerErrorDelta} ` +
        `proxyFailed=${(await proxyStatus()).failedRequests - beforeProxy.failedRequests}`,
    );
    if (failure5xxDelta !== TURNS || failureServerErrorDelta !== TURNS) {
      throw new Error(
        `outage did not produce exactly ${TURNS} 5xx/server errors: ` +
          `5xxDelta=${failure5xxDelta} serverErrorDelta=${failureServerErrorDelta}`,
      );
    }

    const passed = await control('pass');
    console.log(`[sustained-503] proxy failing=${passed.failing}; sending recovery turns`);

    const recovery = [];
    for (let index = 1; index <= 2; index += 1) {
      const before = (await proxyStatus()).forwardedRequests;
      const result = await ask(token, conversationId);
      const after = (await proxyStatus()).forwardedRequests;
      recovery.push({ turn: index, ...result, forwardedDelta: after - before });
      console.log(
        `[sustained-503] recovery ${index}/2 status=${result.status} model=${result.model ?? '-'} ` +
          `tools=${result.toolsUsed.join(',') || '-'} duration=${result.durationMs}ms ` +
          `answer=${result.content.length} chars`,
      );
      if (result.status !== 201 || !result.content.trim()) {
        throw new Error(`recovery turn ${index} did not answer: HTTP ${result.status} ${result.error ?? ''}`);
      }
      if (!result.model) throw new Error(`recovery turn ${index} did not name a model`);
      if (!result.toolsUsed.includes('getStockValue')) {
        throw new Error(`recovery turn ${index} did not read getStockValue`);
      }
      if (!result.content.includes(expectedTotalText)) {
        throw new Error(
          `recovery turn ${index} did not quote the tool total ${expectedTotalText}: ` +
            result.content.replace(/\s+/g, ' ').slice(0, 240),
        );
      }
    }

    const healthAfterRecovery = await health();
    const recovery5xxDelta =
      (healthAfterRecovery.counters?.byStatusClass?.['5xx'] ?? 0) -
      (healthAfterFailures.counters?.byStatusClass?.['5xx'] ?? 0);
    if (recovery5xxDelta !== 0) {
      throw new Error(`recovery produced ${recovery5xxDelta} new 5xx responses`);
    }

    const summary = {
      result: 'PASS',
      database: mongoose.connection.name,
      baseUrl: BASE_URL,
      proxyUrl: PROXY_URL,
      failModels: FAIL_MODELS,
      expectedTotalValue,
      consecutiveFailures: TURNS,
      failures,
      recovery,
      health: {
        before: healthBefore.counters,
        afterFailures: healthAfterFailures.counters,
        afterRecovery: healthAfterRecovery.counters,
        failure5xxDelta,
        failureServerErrorDelta,
        recovery5xxDelta,
      },
      proxy: await proxyStatus(),
    };
    fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error(`[sustained-503] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
