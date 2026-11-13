// Staging P3 drill: one real provider-boundary 503, then a normal request through the same server.
//
// The server must point OPENROUTER_BASE_URL at `provider503Proxy.mjs`; the proxy returns 503 for
// the configured primary model until the drill flips it to pass-through. This proves the deployed
// HTTP/AI/tool path can survive a provider-wide 5xx without touching production configuration.
//
// Required:
//   NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db
//   DRILL_CONFIRM=staging-503-drill
//   DRILL_BASE=http://127.0.0.1:4001
//   DRILL_PROXY=http://127.0.0.1:5055
//   DRILL_MODEL=openai/gpt-oss-20b (the model the proxy fails)
//   DRILL_QUESTION (optional; must route to the primary, not the simple free route)
//   AI access via a local session (no Firebase token is needed).

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../../src/config/env.ts';
import Business from '../../src/models/business.model.ts';
import Session from '../../src/models/session.model.ts';
import User from '../../src/models/user.model.ts';
import { signAccessToken } from '../../src/config/jwt.ts';
import { createSessionForToken, newSessionId } from '../../src/services/session.service.ts';

const CONFIRM = 'staging-503-drill';
const BASE_URL = (process.env.DRILL_BASE || 'http://127.0.0.1:4001').replace(/\/+$/, '');
const PROXY_URL = (process.env.DRILL_PROXY || 'http://127.0.0.1:5055').replace(/\/+$/, '');
const FAIL_MODEL = (process.env.DRILL_MODEL || 'openai/gpt-oss-20b').trim();
const STAGING_DATABASES = new Set([DATABASE_NAMES.development, 'inventoryai_staging_db']);
const BUSINESS_NAME = 'PERF SEED — AI assistant stress test (do not use)';
const OWNER_EMAIL = 'perf-seed-ai@example.invalid';
// A value question deliberately routes to the ordinary paid primary. A simple inventory
// question would be served by the free route without touching the proxy, which would make a
// "failover" run pass without ever producing a 503. The failed-request assertion below is the
// second guard against that false pass.
const QUESTION =
  process.env.DRILL_QUESTION || 'What is the total stock value of my inventory?';

function fail(message) {
  console.error(`[503-drill] ${message}`);
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

async function ask(token, question) {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/api/ai/chat`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: question, timeZone: 'Asia/Manila' }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // Leave payload null; the HTTP status and raw prefix below carry the error.
  }
  const assistant = payload?.assistantMessage;
  return {
    status: response.status,
    durationMs: Date.now() - started,
    content: assistant?.content ?? '',
    model: assistant?.model ?? null,
    toolsUsed: Array.isArray(assistant?.toolsUsed) ? assistant.toolsUsed : [],
    degraded: payload?.degraded ?? assistant?.degraded ?? null,
    error: response.ok ? null : (payload?.error ?? payload?.message ?? raw.slice(0, 200)),
  };
}

async function main() {
  if (process.env.DRILL_CONFIRM !== CONFIRM) fail(`set DRILL_CONFIRM=${CONFIRM}`);
  if (env.nodeEnv !== 'development' || !STAGING_DATABASES.has(env.mongodbDbName)) {
    fail(`refusing database ${env.mongodbDbName} in ${env.nodeEnv}; use the staging/dev database`);
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(BASE_URL)) fail('DRILL_BASE must be loopback');
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(PROXY_URL)) fail('DRILL_PROXY must be loopback');
  if (!FAIL_MODEL) fail('DRILL_MODEL is required');

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

  const jti = newSessionId();
  const token = signAccessToken(owner._id, jti);
  await createSessionForToken({
    userId: owner._id,
    businessId: owner.businessId,
    token,
    deviceLabel: 'staging 503 drill',
  });

  let sessionDeleted = false;
  const cleanup = async () => {
    if (sessionDeleted) return;
    sessionDeleted = true;
    await Session.deleteOne({ jti });
    await mongoose.disconnect();
  };

  try {
    console.log(`[503-drill] database=${mongoose.connection.name} base=${BASE_URL} proxy=${PROXY_URL}`);
    console.log(`[503-drill] failing model=${FAIL_MODEL}`);
    await control('fail');
    const failedBefore = (await proxyStatus()).failedRequests;
    console.log(`[503-drill] question: ${QUESTION}`);

    const first = await ask(token, QUESTION);
    console.log(
      `[503-drill] failover status=${first.status} model=${first.model ?? '-'} ` +
        `tools=${first.toolsUsed.join(',') || '-'} duration=${first.durationMs}ms ` +
        `degraded=${first.degraded ?? '-'} answer=${first.content.length} chars`,
    );
    console.log(`[503-drill] failover answer: ${first.content.replace(/\s+/g, ' ').slice(0, 400)}`);

    if (first.status !== 201) throw new Error(`failover turn returned HTTP ${first.status}: ${first.error}`);
    if (!first.content.trim()) throw new Error('failover turn returned an empty answer');
    if (first.model === FAIL_MODEL) {
      throw new Error(`the failing model ${FAIL_MODEL} still answered; the proxy did not intercept it`);
    }
    const afterFailover = await proxyStatus();
    if (afterFailover.failedRequests !== failedBefore + 1) {
      throw new Error(
        `expected exactly one provider 503, saw ${afterFailover.failedRequests - failedBefore}; ` +
          'the question may have been served by the simple free route',
      );
    }

    const pass = await control('pass');
    console.log(`[503-drill] proxy failing=${pass.failing}; sending the ordinary control turn`);

    const second = await ask(token, QUESTION);
    console.log(
      `[503-drill] normal status=${second.status} model=${second.model ?? '-'} ` +
        `tools=${second.toolsUsed.join(',') || '-'} duration=${second.durationMs}ms ` +
        `degraded=${second.degraded ?? '-'} answer=${second.content.length} chars`,
    );
    if (second.status !== 201) throw new Error(`normal turn returned HTTP ${second.status}: ${second.error}`);
    if (!second.content.trim()) throw new Error('normal turn returned an empty answer');

    console.log(
      JSON.stringify(
        {
          result: 'PASS',
          failModel: FAIL_MODEL,
          failover: first,
          normal: second,
          proxy: await proxyStatus(),
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error(`[503-drill] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
