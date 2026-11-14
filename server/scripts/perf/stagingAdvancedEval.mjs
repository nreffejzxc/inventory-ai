// Staging advanced-task evaluation: research, multi-tool, complex stock reasoning and language.
//
// This is a diagnostic, not a hard pass/fail gate. It records the actual answer, model, tools,
// duration and observed checks for four questions in ONE conversation, then the operator reviews
// the transcript. The checks are deliberately narrow: they flag missing facts or missing research
// citations, but they do not claim that a long answer is stylistically good.
//
// Required:
//   NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db
//   P5_CONFIRM=staging-advanced-eval
//   P5_BASE=http://127.0.0.1:4000
//   The PERF SEED staging tenant must exist.
//
// AI access is a local session; no Firebase token is needed.

import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../../src/config/env.ts';
import Business from '../../src/models/business.model.ts';
import Session from '../../src/models/session.model.ts';
import User from '../../src/models/user.model.ts';
import { signAccessToken } from '../../src/config/jwt.ts';
import { createSessionForToken, newSessionId } from '../../src/services/session.service.ts';

const CONFIRM = 'staging-advanced-eval';
const BASE_URL = (process.env.P5_BASE || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const STAGING_DATABASES = new Set([DATABASE_NAMES.development, 'inventoryai_staging_db']);
const BUSINESS_NAME = 'PERF SEED — AI assistant stress test (do not use)';
const OWNER_EMAIL = 'perf-seed-ai@example.invalid';
const OUT = '.tmp-staging-advanced.json';

const QUESTIONS = [
  {
    id: 'research-compare',
    kind: 'research + inventory comparison',
    message:
      'What do current online reviews say about the Keychron K8 Pro and Royal Kludge RK61? ' +
      'Compare them and cite the source URLs you used.',
    check: (answer) => {
      const text = String(answer ?? '');
      const reasons = [];
      if (!/keychron\s+k8\s+pro/i.test(text)) reasons.push('missing Keychron K8 Pro');
      if (!/royal\s+kludge\s+rk61/i.test(text)) reasons.push('missing Royal Kludge RK61');
      if (!/https?:\/\//i.test(text)) reasons.push('no source URL in the answer');
      return { ok: reasons.length === 0, reasons };
    },
  },
  {
    id: 'multi-location-value',
    kind: 'multi-tool location comparison',
    message:
      'What is the total stock value of my Main Warehouse and my Shop Front? Compare the two locations.',
    check: (answer) => {
      const text = String(answer ?? '');
      const reasons = [];
      if (!/main\s+warehouse/i.test(text)) reasons.push('missing Main Warehouse');
      if (!/shop\s+front/i.test(text)) reasons.push('missing Shop Front');
      if (!/(?:₱|php|p)\s*[\d,]+|\d[\d,]{3,}/i.test(text)) reasons.push('missing a currency amount');
      if (!/worth|value|higher|more/i.test(text)) reasons.push('missing a comparison');
      return { ok: reasons.length === 0, reasons };
    },
  },
  {
    id: 'complex-coverage',
    kind: 'complex stock calculation',
    message:
      'Compare the stock of the product with SKU SEEDSKU-0 (Logitech MX Keys S) across ' +
      'Main Warehouse and Shop Front, and tell me whether we can cover 500 units.',
    check: (answer) => {
      // Models bold the negative word ("does **not** cover"); strip Markdown emphasis before
      // matching so a correct answer is not failed by the harness.
      const text = String(answer ?? '').replace(/[*_`]/g, '');
      const reasons = [];
      if (!/SEEDSKU-0|logitech\s+mx\s+keys\s+s/i.test(text)) reasons.push('missing the product/SKU');
      if (!/\b401\b/.test(text)) reasons.push('missing total stock 401');
      if (!/\b200\b/.test(text)) reasons.push('missing Main Warehouse 200');
      if (!/\b201\b/.test(text)) reasons.push('missing Shop Front 201');
      if (!/\b500\b/.test(text)) reasons.push('missing the requested 500 units');
      if (!/not\s+cover|not enough|insufficient|short|does not|doesn't|cannot|can't|no\b/i.test(text)) {
        reasons.push('missing a not-enough answer');
      }
      return { ok: reasons.length === 0, reasons };
    },
  },
  {
    id: 'language-tagalog',
    kind: 'local-language answer',
    message: 'Ilan ang mga produktong kailangang i-restock?',
    check: (answer) => {
      const text = String(answer ?? '');
      const reasons = [];
      if (!/\b1,?535\b/.test(text)) reasons.push('missing the restock count 1,535');
      if (!/produkto|kailangan|restock|stock/i.test(text)) reasons.push('missing Tagalog/Taglish vocabulary');
      return { ok: reasons.length === 0, reasons };
    },
  },
];

async function request(token, method, path, body) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // Keep the raw prefix for diagnosis.
  }
  return { status: response.status, json, raw };
}

async function ask(token, conversationId, question) {
  const started = Date.now();
  const result = await request(token, 'POST', '/ai/chat', {
    message: question,
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
    turnId: result.json?.turnId ?? assistant?.turnId ?? null,
    degraded: result.json?.degraded ?? assistant?.degraded ?? null,
    code: result.json?.code ?? null,
    error: result.status >= 400 ? (result.json?.error ?? result.json?.message ?? result.raw.slice(0, 300)) : null,
  };
}

async function main() {
  if (process.env.P5_CONFIRM !== CONFIRM) {
    console.error(`[advanced] set P5_CONFIRM=${CONFIRM}`);
    process.exit(2);
  }
  if (env.nodeEnv !== 'development' || !STAGING_DATABASES.has(env.mongodbDbName)) {
    console.error(`[advanced] refusing database ${env.mongodbDbName} in ${env.nodeEnv}`);
    process.exit(2);
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(BASE_URL)) {
    console.error('[advanced] P5_BASE must be loopback HTTP');
    process.exit(2);
  }

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

  const jti = newSessionId();
  const token = signAccessToken(owner._id, jti);
  await createSessionForToken({
    userId: owner._id,
    businessId: owner.businessId,
    token,
    deviceLabel: 'staging advanced evaluation',
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
      title: 'staging advanced evaluation',
    });
    if (created.status !== 201 || !created.json?.conversation?.id) {
      throw new Error(`conversation create returned HTTP ${created.status}: ${created.raw.slice(0, 200)}`);
    }
    const conversationId = created.json.conversation.id;
    console.log(`[advanced] database=${mongoose.connection.name} conversation=${conversationId}`);

    const results = [];
    for (const question of QUESTIONS) {
      const result = await ask(token, conversationId, question.message);
      const check = result.status === 201 ? question.check(result.content) : { ok: false, reasons: [result.error] };
      results.push({
        id: question.id,
        kind: question.kind,
        question: question.message,
        ...result,
        check,
      });
      console.log(
        `[advanced] ${question.id} status=${result.status} model=${result.model ?? '-'} ` +
          `tools=${result.toolsUsed.join(',') || '-'} duration=${result.durationMs}ms ` +
          `check=${check.ok ? 'ok' : check.reasons.join('|')}`,
      );
      console.log(`[advanced] answer: ${result.content.replace(/\s+/g, ' ').slice(0, 500)}`);
    }

    const failures = results.filter((result) => result.status !== 201);
    if (failures.length) {
      throw new Error(
        `${failures.length} advanced turn(s) failed: ` +
          failures.map((result) => `${result.id}=${result.status} ${result.error ?? ''}`).join('; '),
      );
    }
    const summary = {
      result: 'RECORDED',
      database: mongoose.connection.name,
      baseUrl: BASE_URL,
      tenant: String(business._id),
      conversationId,
      questions: results,
      summary: {
        total: results.length,
        answered: results.filter((result) => result.status === 201).length,
        checksPassed: results.filter((result) => result.check.ok).length,
        checksFailed: results.filter((result) => !result.check.ok).map((result) => result.id),
        models: [...new Set(results.map((result) => result.model).filter(Boolean))],
        tools: [...new Set(results.flatMap((result) => result.toolsUsed))],
        totalDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
      },
    };
    fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error(`[advanced] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
