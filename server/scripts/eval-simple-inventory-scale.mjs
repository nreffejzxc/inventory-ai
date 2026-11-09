// Controlled LIVE evaluation of AI-99 at the 10,256-product scale.
//
// This is the permanent companion to `eval-simple-inventory.mjs` (the small fixture
// evaluator). It owns the full disposable-data lifecycle:
//   * refuses anything except the development database (via assertSafeTarget);
//   * creates a deterministic `seed:perf --size=10256 --seed=1` tenant;
//   * normalises stock so exactly five distinct products are at/below minimum, which
//     makes the restock list answerable and every expected value computable;
//   * runs a sequential 25-question gate, a one-shot burst at 10/25/40 concurrent
//     requests, or a sustained wave phase;
//   * verifies accuracy from the returned rows, not the model's claim;
//   * records free/paid service, latency, errors, degraded answers, token usage and
//     estimated cost, plus the provider's own allowance/paid-usage deltas;
//   * writes each result to `.tmp-simple-inventory-scale-<phase>[-<n>].json`;
//   * removes the seeded tenant in `finally` unless `--keep` is passed.
//
// WHY THE TEST DATA IS REBUILT EACH PHASE. The seed is deterministic, so every phase
// sees the same 10,256 products and the same five restock names. Rebuilding prevents a
// phase from accidentally reusing mutated rows and makes automatic cleanup safe.
//
// PREREQUISITES:
//   SEED_CONFIRM=seed-perf-ai
//   NODE_ENV=development
//   AI_TEST_ALLOW_PAID_MODELS=true   (only when the owner has approved paid fallback)
//   OPENROUTER_API_KEY set
//
// EXAMPLES:
//   SEED_CONFIRM=seed-perf-ai npm run eval:simple-10k -- --phase=prepare
//   SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
//     npm run eval:simple-10k -- --phase=gate
//   SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
//     npm run eval:simple-10k -- --phase=gate --transport=http --base=http://127.0.0.1:4107
//   SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
//     npm run eval:simple-10k -- --phase=burst --concurrency=40
//   SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
//     npm run eval:simple-10k -- --phase=sustained --concurrency=10 --requests=30
//
// `--keep` leaves the seed tenant for inspection; without it cleanup runs even when
// a phase fails. `--out=...` chooses a different result path. `--prepare` makes no
// model calls.
//
// RESUMABILITY. A checkpoint beside the artifact records the completed request indices.
// After a host timeout the next run removes the orphan tenant in preflight, reseeds the
// same deterministic dataset, and resumes at the first uncompleted request. SIGINT and
// SIGTERM make a best-effort cleanup; a hard SIGKILL is covered by the next preflight.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import Product from '../src/models/product.model.ts';
import User from '../src/models/user.model.ts';
import { ROLES } from '../src/constants/roles.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { signAccessToken } from '../src/config/jwt.ts';
import { selectSimpleModel, simpleInventoryIntent } from '../src/services/ai/simpleInventory.ts';
import { createSessionForToken, newSessionId } from '../src/services/session.service.ts';
import { assertFreeTestingModels } from './live-test-guard.mjs';
import {
  SEED_BUSINESS_NAME,
  SEED_OWNER_EMAIL,
  assertSafeTarget,
  findSeedTenantIds,
  removeTenant,
} from './perf/lib.mjs';
import { readProviderUsage } from './ai-usage.mjs';
import {
  CHECKPOINT_VERSION,
  checkpointConfig,
  checkpointPathFor,
  checkpointRows,
  completedWorkIndices,
  datasetFingerprint,
  readCheckpoint,
  removeCheckpoint,
  sameCheckpointConfig,
  writeCheckpoint,
} from './perf/eval-checkpoint.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(SCRIPT_DIR, '..');
const SEED_SCRIPT = path.join(SCRIPT_DIR, 'seed-perf-data.mjs');
const DEFAULT_SIZE = 10256;
const DEFAULT_SEED = 1;
const GATE_REQUESTS = 25;
const LOAD_SAMPLE = 40;
const MAX_CONCURRENCY = 40;
const MAX_SUSTAINED_REQUESTS = 80;
const PRODUCT_STOCK_READS = new Set(['getInventory', 'getProduct', 'findProducts']);
const SHORTAGE_READS = new Set([
  'getReorderNeededProducts',
  'getLowStockProducts',
  'getOutOfStockProducts',
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag) {
  const prefix = `${flag}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function fail(message, code = 2) {
  console.error(`[simple-10k] ${message}`);
  process.exit(code);
}

function runNodeScript(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: SERVER_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} exited with status ${result.status}`);
  }
}

function normalise(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\*\*|__|`/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

/** A number in the same sentence/line as a stock label. */
function sentenceHas(text, value, label) {
  const number = new RegExp(
    `\\b${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*')}\\b`,
    'i',
  );
  return normalise(text)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .some((part) => number.test(part) && label.test(part));
}

function productCheck(answer, expected, sku, name) {
  const text = normalise(answer);
  const named =
    text.toLowerCase().includes(String(sku).toLowerCase()) ||
    text.toLowerCase().includes(String(name).toLowerCase());
  const reasons = [];
  if (!named) reasons.push(`missing SKU or product name (${sku})`);
  if (expected === 0) {
    if (
      !/\b(?:out of stock|0 units?|zero units?|no units?|no stock|none on hand|none in stock|not in stock|not stocked|no inventory record)\b/i.test(
        text,
      )
    ) {
      reasons.push('missing an out-of-stock / zero statement');
    }
  } else if (!sentenceHas(text, expected, /\b(?:units?|on hand|stock|quantity|available|qty)\b/i)) {
    reasons.push(`missing ${expected} with a stock/unit label`);
  }
  return { ok: reasons.length === 0, reasons };
}

function existenceCheck(answer, present) {
  const text = normalise(answer);
  const affirmative =
    /\b(?:yes|we (?:have|carry|stock)\b|we do (?:have|carry|stock)\b|exists?\b|in (?:our|the) (?:inventory|catalog(?:ue)?)\b|recorded in (?:our|the) (?:inventory|catalog(?:ue)?)\b|in stock\b|on hand)\b/i.test(
      text,
    );
  // A negative STOCK statement ("none are out of stock", "not low stock") or an
  // unrelated missing field ("price not recorded") is not a denial of existence.
  const denial =
    /\b(?:we (?:do not|don't) (?:have|carry|stock)|does not exist|doesn't exist|not in (?:our|the) (?:inventory|catalog(?:ue)?)|not carried|not stocked|not found|no such (?:product|item|sku)|not recorded in (?:our|the) (?:inventory|catalog(?:ue)?))\b/i.test(
      text,
    );
  const reasons = [];
  if (present) {
    if (!affirmative) reasons.push('missing yes / have / in stock');
    if (denial) reasons.push('answer denies existence');
  } else if (!(denial || /\b(?:not in stock|out of stock)\b/i.test(text))) {
    reasons.push('missing a denial');
  }
  return { ok: reasons.length === 0, reasons };
}

function restockListCheck(answer, names) {
  const text = normalise(answer);
  const reasons = names
    .filter((name) => !text.toLowerCase().includes(String(name).toLowerCase()))
    .map((name) => `missing ${name}`);
  return { ok: reasons.length === 0, reasons };
}

function restockCountCheck(answer, expected) {
  const ok = sentenceHas(answer, expected, /\b(?:products?|items?|skus?)\b/i);
  return { ok, reasons: ok ? [] : [`missing ${expected} labeled as products/items`] };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function money(value) {
  return value === null || value === undefined ? 'unknown' : `$${value.toFixed(6)}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchPricing(model, cfg) {
  const base = String(cfg.openrouterBaseUrl || 'https://openrouter.ai/api')
    .trim()
    .replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const body = await response.json();
    const row = Array.isArray(body?.data)
      ? body.data.find((entry) => entry?.id === model)
      : undefined;
    const prompt = Number(row?.pricing?.prompt);
    const completion = Number(row?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
      return { error: 'the catalogue did not publish pricing for the paid primary' };
    }
    return {
      prompt,
      completion,
      promptPerMillion: prompt * 1_000_000,
      completionPerMillion: completion * 1_000_000,
    };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

function estimatedCost(row, pricing) {
  if (row.freeServed && !row.error) return 0;
  if (!pricing || pricing.error || !row.usage) return null;
  const input = finiteNumber(row.usage.inputTokens);
  const output = finiteNumber(row.usage.outputTokens);
  if (input === null || output === null) return null;
  return input * pricing.prompt + output * pricing.completion;
}

function summarise(rows, { phase, requests, concurrency, waves, gapMs }) {
  const answered = rows.filter((row) => !row.error);
  const accurate = rows.filter((row) => row.check.ok);
  const free = answered.filter((row) => row.freeServed);
  const paid = answered.filter((row) => !row.freeServed);
  const errors = rows.filter((row) => row.error);
  const times = answered.map((row) => row.totalMs).filter(Number.isFinite);
  const costs = rows.map((row) => row.costUsd);
  const costComplete = rows.length > 0 && costs.every((value) => value !== null);
  const totalCost = costComplete ? costs.reduce((sum, value) => sum + value, 0) : null;
  return {
    phase,
    requests,
    concurrency,
    waves,
    gapMs,
    answered: answered.length,
    accurate: accurate.length,
    accuracyRate: requests > 0 ? accurate.length / requests : null,
    answeredAccuracy: answered.length > 0 ? accurate.length / answered.length : null,
    errors: errors.length,
    errorRate: requests > 0 ? errors.length / requests : null,
    degraded: rows.filter((row) => row.degraded).length,
    freeServed: free.length,
    paidServed: paid.length,
    freeSuccessRate: answered.length > 0 ? free.length / answered.length : null,
    paidFallbackRate: answered.length > 0 ? paid.length / answered.length : null,
    medianMs: median(times),
    p95Ms: p95(times),
    meanMs: mean(times),
    minMs: times.length ? Math.min(...times) : null,
    maxMs: times.length ? Math.max(...times) : null,
    totalCostUsd: totalCost,
    costComplete,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const phase = String(argValue('--phase') ?? 'gate').trim().toLowerCase();
  if (!['gate', 'burst', 'sustained', 'prepare'].includes(phase)) {
    fail(`unknown --phase "${phase}"; use gate, burst, sustained or prepare`);
  }
  const size = Number.parseInt(argValue('--size') ?? String(DEFAULT_SIZE), 10);
  if (!Number.isInteger(size) || size < 100) {
    fail('--size must be an integer of at least 100');
  }
  const seed = Number.parseInt(argValue('--seed') ?? String(DEFAULT_SEED), 10);
  if (!Number.isInteger(seed) || seed < 0) fail('--seed must be a non-negative integer');

  const requestedConcurrency = Number.parseInt(
    argValue('--concurrency') ?? (phase === 'burst' ? '10' : '10'),
    10,
  );
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    fail('--concurrency must be a positive integer');
  }
  if (requestedConcurrency > MAX_CONCURRENCY) {
    fail(`--concurrency ${requestedConcurrency} exceeds the safe maximum ${MAX_CONCURRENCY}`);
  }
  if (phase === 'burst' && ![10, 25, 40].includes(requestedConcurrency)) {
    fail('burst evaluation is defined for --concurrency=10, 25 or 40');
  }
  const requested = Number.parseInt(argValue('--requests') ?? '30', 10);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_SUSTAINED_REQUESTS) {
    fail(`--requests must be between 1 and ${MAX_SUSTAINED_REQUESTS}`);
  }
  const gapMs = Number.parseInt(
    argValue('--gap') ?? (phase === 'gate' ? '1000' : '5000'),
    10,
  );
  if (!Number.isInteger(gapMs) || gapMs < 0) fail('--gap must be a non-negative integer');
  const warmupMs = Number.parseInt(argValue('--warmup') ?? '0', 10);
  if (!Number.isInteger(warmupMs) || warmupMs < 0 || warmupMs > 120000) {
    fail('--warmup must be an integer between 0 and 120000 milliseconds');
  }
  const transport = String(argValue('--transport') ?? 'service').trim().toLowerCase();
  if (!['service', 'http'].includes(transport)) {
    fail('--transport must be service or http');
  }
  const baseUrl = String(argValue('--base') ?? 'http://127.0.0.1:4000')
    .trim()
    .replace(/\/+$/, '');
  if (transport === 'http' && !/^https?:\/\//i.test(baseUrl)) {
    fail('--base must be an absolute http(s) URL when --transport=http');
  }
  const keep = process.argv.includes('--keep');
  const outName =
    argValue('--out') ||
    `.tmp-simple-inventory-scale-${phase}` +
      (phase === 'burst' ? `-${requestedConcurrency}` : '') +
      '.json';
  const outPath = path.resolve(SERVER_ROOT, outName);

  if (env.mongodbDbName !== DATABASE_NAMES.development) {
    fail(`refusing database ${env.mongodbDbName}; this evaluator only runs on ${DATABASE_NAMES.development}`);
  }
  assertSafeTarget(env, 'eval-simple-inventory-scale');

  const cfg = aiConfig();
  if (phase !== 'prepare') {
    if (cfg.provider !== 'openrouter') fail(`AI_PROVIDER is ${cfg.provider || 'unset'}; openrouter is required`);
    if (!cfg.openrouterModel) fail('AI_MODEL_OPENROUTER is unset');
    if (!(process.env.OPENROUTER_API_KEY || '').trim()) fail('OPENROUTER_API_KEY is unset');
    if (process.env.AI_TEST_ALLOW_PAID_MODELS !== 'true') {
      fail('paid fallback is not approved; set AI_TEST_ALLOW_PAID_MODELS=true only after owner approval');
    }
    try {
      assertFreeTestingModels();
    } catch (error) {
      fail(error.message);
    }
    const freeModel = selectSimpleModel(cfg.fallbackModels);
    if (!freeModel) fail('no tool-capable :free fallback is configured');
  }

  console.log(
    `[simple-10k] phase=${phase} size=${size} seed=${seed} ` +
      `transport=${transport} ` +
      `concurrency=${phase === 'gate' ? 1 : requestedConcurrency} ` +
      `requests=${phase === 'gate' ? GATE_REQUESTS : phase === 'burst' ? requestedConcurrency : phase === 'sustained' ? requested : 'prepare'}`,
  );
  console.log(`[simple-10k] output=${outPath}`);

  let seedAttempted = false;
  let cleaning = false;

  const connectIfNeeded = async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
    }
  };

  // A host timeout can kill this process before the `finally` below. Preflight removes
  // the tenant left by such a run, and these handlers make a best-effort cleanup when
  // the host sends SIGINT/SIGTERM. SIGKILL is covered by the next run's preflight.
  const cleanupSeedTenant = async (reason) => {
    if (!seedAttempted || keep || cleaning) return;
    cleaning = true;
    try {
      await connectIfNeeded();
      const ids = await findSeedTenantIds();
      if (!ids.length) {
        console.log(`[simple-10k] cleanup (${reason}): no seed tenant found`);
        return;
      }
      const { removed } = await removeTenant(ids);
      console.log(
        `[simple-10k] cleanup (${reason}): removed ${ids.length} seed tenant(s) (${removed} documents)`,
      );
    } catch (error) {
      console.error(`[simple-10k] cleanup (${reason}) failed: ${error?.message ?? error}`);
      process.exitCode = 2;
    }
  };

  const onSignal = (signal) => {
    console.warn(`[simple-10k] ${signal} received — cleaning up before exit`);
    void cleanupSeedTenant(signal).finally(async () => {
      await mongoose.disconnect().catch(() => {});
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await connectIfNeeded();

    // Preflight: a run killed by the host cannot clean its own tenant. Remove the
    // orphan before seeding, so the next run cannot create a second seed business.
    const stale = await findSeedTenantIds();
    if (stale.length) {
      const { removed } = await removeTenant(stale);
      console.log(
        `[simple-10k] preflight: removed ${stale.length} stale seed tenant(s) (${removed} documents)`,
      );
    } else {
      console.log('[simple-10k] preflight: no stale seed tenant');
    }

    seedAttempted = true;
    runNodeScript(SEED_SCRIPT, [`--size=${size}`, `--seed=${seed}`]);

    const ids = await findSeedTenantIds();
    if (ids.length !== 1) throw new Error(`expected one seed tenant, found ${ids.length}`);
    const businessId = new mongoose.Types.ObjectId(ids[0]);
    const business = await Business.findById(businessId).lean();
    if (!business || business.name !== SEED_BUSINESS_NAME) {
      throw new Error(`business ${businessId} is not the named seed tenant`);
    }
    const owner = await User.findOne({
      businessId,
      email: SEED_OWNER_EMAIL,
      role: ROLES.OWNER,
      status: 'ACTIVE',
    })
      .select('_id')
      .lean();
    if (!owner) throw new Error('seed tenant has no active owner');

    // A live HTTP run authenticates exactly as a local login does: a signed access token plus
    // the server-side session row it names. The token is never printed and is removed with the
    // seed tenant (sessions are part of the account teardown plan).
    let httpToken = null;
    if (transport === 'http') {
      const jti = newSessionId();
      httpToken = signAccessToken(owner._id, jti);
      await createSessionForToken({
        userId: owner._id,
        businessId,
        token: httpToken,
        deviceLabel: 'simple-10k HTTP gate',
      });
      console.log(`[simple-10k] HTTP gate target=${baseUrl} auth=local session (token not logged)`);
    }

    const products = await Product.find({ businessId, status: 'ACTIVE' })
      .select('_id name sku minimumStock')
      .lean();
    const inventoryRows = await Inventory.find({ businessId })
      .select('_id productId quantity')
      .lean();
    if (products.length !== size) {
      throw new Error(`expected ${size} products, found ${products.length}`);
    }
    if (!inventoryRows.length) throw new Error('seed tenant has no inventory rows');

    // ---- deterministic five-product restock set ----
    const low = [];
    const usedNames = new Set();
    const candidates = products
      .filter((product) => {
        const index = Number(String(product.sku).replace(/^SEEDSKU-/, ''));
        return Number.isInteger(index) && index >= 5000 && index <= 9000;
      })
      .sort((left, right) =>
        String(left.sku).localeCompare(String(right.sku), undefined, { numeric: true }),
      );
    for (const product of candidates) {
      if (usedNames.has(product.name)) continue;
      low.push(product);
      usedNames.add(product.name);
      if (low.length === 5) break;
    }
    if (low.length !== 5) throw new Error('could not select five distinct restock names');
    const lowIds = new Set(low.map((product) => String(product._id)));

    const byProduct = new Map();
    for (const row of inventoryRows) {
      const key = String(row.productId);
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key).push(row);
    }

    const operations = [];
    for (const product of products) {
      const rows = byProduct.get(String(product._id)) ?? [];
      if (rows.length === 0) throw new Error(`${product.sku} has no inventory row`);
      const isLow = lowIds.has(String(product._id));
      const target = isLow ? 0 : Math.max(1, Number(product.minimumStock) + 10);
      const perRow = Math.floor(target / rows.length);
      let remaining = target;
      for (let index = 0; index < rows.length; index += 1) {
        const isLast = index === rows.length - 1;
        const quantity = isLast ? remaining : perRow;
        remaining -= quantity;
        operations.push({
          updateOne: {
            filter: { _id: rows[index]._id },
            update: { $set: { quantity, reservedQuantity: 0 } },
          },
        });
      }
    }
    for (let index = 0; index < operations.length; index += 2000) {
      await Inventory.bulkWrite(operations.slice(index, index + 2000), { ordered: false });
    }

    const totals = await Inventory.aggregate([
      { $match: { businessId } },
      { $group: { _id: '$productId', quantity: { $sum: '$quantity' } } },
    ]);
    const totalById = new Map(totals.map((row) => [String(row._id), row.quantity]));
    const restock = products.filter(
      (product) => (totalById.get(String(product._id)) ?? 0) <= Number(product.minimumStock),
    );
    const restockNames = low.map((product) => product.name);
    if (
      restock.length !== 5 ||
      restock.some((product) => !lowIds.has(String(product._id))) ||
      low.some((product) => !totalById.has(String(product._id)))
    ) {
      throw new Error(
        `restock normalization failed: expected 5 selected products, found ${restock
          .map((product) => product.sku)
          .join(', ')}`,
      );
    }

    const healthy = products
      .filter((product) => !lowIds.has(String(product._id)))
      .sort((left, right) =>
        String(left.sku).localeCompare(String(right.sku), undefined, { numeric: true }),
      )
      .slice(0, LOAD_SAMPLE);
    if (healthy.length !== LOAD_SAMPLE) {
      throw new Error(`expected ${LOAD_SAMPLE} healthy load samples, found ${healthy.length}`);
    }
    const stockProducts = [low[0], ...healthy.slice(0, 14)];
    if (stockProducts.length !== 15) throw new Error('expected 15 stock samples');

    const stockQuestions = stockProducts.map((product) => ({
      id: `stock-${product.sku}`,
      operation: 'product_stock',
      sku: product.sku,
      name: product.name,
      expected: totalById.get(String(product._id)) ?? 0,
      message: `How many units of the product with SKU ${product.sku} are in stock?`,
      check: (answer) =>
        productCheck(answer, totalById.get(String(product._id)) ?? 0, product.sku, product.name),
    }));

    const gateQuestions = [...stockQuestions];
    for (const product of [healthy[0], healthy[1], low[0], healthy[2], healthy[3]]) {
      gateQuestions.push({
        id: `exists-${product.sku}`,
        operation: 'product_existence',
        sku: product.sku,
        expected: true,
        message: `Do we have the product with SKU ${product.sku} in our inventory?`,
        check: (answer) => existenceCheck(answer, true),
      });
    }
    gateQuestions.push({
      id: 'exists-absent',
      operation: 'product_existence',
      sku: 'SEEDSKU-999999',
      expected: false,
      message: 'Do we have the product with SKU SEEDSKU-999999 in our inventory?',
      check: (answer) => existenceCheck(answer, false),
    });
    for (const [id, message] of [
      ['restock-list-1', 'Which products need to be restocked?'],
      ['restock-list-2', 'Which products are at or below their minimum stock?'],
    ]) {
      gateQuestions.push({
        id,
        operation: 'restock_list',
        expected: restockNames,
        message,
        check: (answer) => restockListCheck(answer, restockNames),
      });
    }
    for (const [id, message] of [
      ['restock-count-1', 'How many products need restocking?'],
      ['restock-count-2', 'How many items are below their minimum stock?'],
    ]) {
      gateQuestions.push({
        id,
        operation: 'restock_count',
        expected: 5,
        message,
        check: (answer) => restockCountCheck(answer, 5),
      });
    }
    if (gateQuestions.length !== GATE_REQUESTS) {
      throw new Error(`expected ${GATE_REQUESTS} gate questions, built ${gateQuestions.length}`);
    }
    for (const question of gateQuestions) {
      const intent = simpleInventoryIntent(question.message);
      if (!intent || intent.operation !== question.operation) {
        throw new Error(`${question.id} classified as ${JSON.stringify(intent)}`);
      }
    }

    const loadQuestions = healthy.map((product) => ({
      id: `load-${product.sku}`,
      operation: 'product_stock',
      sku: product.sku,
      name: product.name,
      expected: totalById.get(String(product._id)) ?? 0,
      message: `How many units of the product with SKU ${product.sku} are in stock?`,
      check: (answer) =>
        productCheck(answer, totalById.get(String(product._id)) ?? 0, product.sku, product.name),
    }));

    const dataset = {
      products: products.length,
      inventoryRows: inventoryRows.length,
      restockCount: restock.length,
      restockNames,
      lowSkus: low.map((product) => product.sku),
      stockSamples: stockProducts.map((product) => ({
        sku: product.sku,
        name: product.name,
        expected: totalById.get(String(product._id)) ?? 0,
      })),
      loadSamples: loadQuestions.map((question) => ({
        sku: question.sku,
        expected: question.expected,
      })),
    };

    console.log(
      `[simple-10k] tenant=${String(businessId)} products=${products.length} ` +
        `inventoryRows=${inventoryRows.length} restock=${restock.length}`,
    );
    console.log(`[simple-10k] restock names: ${restockNames.join('; ')}`);
    console.log(
      `[simple-10k] stock samples: ${dataset.stockSamples
        .map((sample) => `${sample.sku}=${sample.expected}`)
        .join(', ')}`,
    );

    if (phase === 'prepare') {
      const artifact = {
        generatedAt: new Date().toISOString(),
        phase,
        config: { size, seed },
        dataset,
        gateQuestions: gateQuestions.map((question) => ({
          id: question.id,
          operation: question.operation,
          message: question.message,
          expected: question.expected,
        })),
        loadQuestions: loadQuestions.map((question) => ({
          id: question.id,
          message: question.message,
          expected: question.expected,
        })),
        modelCalls: 0,
      };
      writeJson(outPath, artifact);
      console.log(`[simple-10k] prepared ${gateQuestions.length} gate questions and ${loadQuestions.length} load samples; no model call was made`);
      console.log(`[simple-10k] artifact: ${outPath}`);
      return;
    }

    const pricing = await fetchPricing(cfg.openrouterModel, cfg);
    console.log(
      `[simple-10k] paid pricing: ${
        pricing.error
          ? `unavailable (${pricing.error})`
          : `$${pricing.promptPerMillion.toFixed(3)}/M input, $${pricing.completionPerMillion.toFixed(3)}/M output`
      }`,
    );

    const freeModel = selectSimpleModel(cfg.fallbackModels);
    const work =
      phase === 'gate'
        ? gateQuestions
        : phase === 'burst'
          ? loadQuestions.slice(0, requestedConcurrency)
          : Array.from({ length: requested }, (_, index) => loadQuestions[index % loadQuestions.length]);
    const concurrency = phase === 'gate' ? 1 : phase === 'burst' ? requestedConcurrency : requestedConcurrency;
    const waves = Math.ceil(work.length / concurrency);
    const effectiveGap = phase === 'burst' ? 0 : gapMs;

    // Checkpoint state is keyed to the artifact. A mismatched config or dataset is
    // ignored rather than merged: old rows are only evidence about the same questions.
    const checkpointFile = checkpointPathFor(outPath);
    const runConfig = checkpointConfig({
      phase,
      size,
      seed,
      concurrency,
      requests: work.length,
      gapMs: effectiveGap,
      transport,
      baseUrl,
      primary: cfg.openrouterModel,
      free: freeModel,
    });
    const loaded = readCheckpoint(checkpointFile);
    const resumeRows = [];
    if (loaded.checkpoint) {
      const configMatches = sameCheckpointConfig(loaded.checkpoint.config, runConfig);
      const datasetMatches =
        datasetFingerprint(loaded.checkpoint.dataset) === datasetFingerprint(dataset);
      if (configMatches && datasetMatches) {
        const seen = new Set();
        for (const row of checkpointRows(loaded.checkpoint)) {
          if (!Number.isInteger(row?.workIndex)) continue;
          if (row.workIndex < 0 || row.workIndex >= work.length) continue;
          if (seen.has(row.workIndex)) continue;
          seen.add(row.workIndex);
          resumeRows.push(row);
        }
        console.log(
          `[simple-10k] resuming ${resumeRows.length}/${work.length} completed request(s) from ${path.basename(checkpointFile)}`,
        );
      } else {
        console.log(
          `[simple-10k] checkpoint ignored (${configMatches ? 'dataset changed' : 'config changed'})`,
        );
      }
    } else if (loaded.reason) {
      console.log(`[simple-10k] checkpoint ignored (${loaded.reason})`);
    }
    const checkpointBase = {
      version: CHECKPOINT_VERSION,
      state: 'running',
      phase,
      config: runConfig,
      dataset,
      startedAt:
        resumeRows.length > 0
          ? loaded.checkpoint?.startedAt ?? new Date().toISOString()
          : new Date().toISOString(),
      rows: resumeRows,
    };
    writeCheckpoint(checkpointFile, {
      ...checkpointBase,
      updatedAt: new Date().toISOString(),
    });

    if (warmupMs > 0 && phase !== 'gate') {
      console.log(`[simple-10k] warm-up: ${warmupMs}ms before the first ${phase} request`);
      await sleep(warmupMs);
    }

    const allowanceBefore = await safeUsage(cfg);
    console.log(
      `[simple-10k] allowance before: ${allowanceBefore?.daily?.remaining ?? 'unknown'} free requests left; ` +
        `paid usage ${allowanceBefore?.paidUsage ?? 'unknown'}`,
    );

    const phaseResult = await runPhase({
      phase,
      work,
      concurrency,
      gapMs: effectiveGap,
      outPath,
      businessId,
      ownerId: owner._id,
      pricing,
      transport,
      baseUrl,
      token: httpToken,
      checkpointFile,
      resumeRows,
      checkpointBase,
      config: {
        size,
        seed,
        transport,
        baseUrl: transport === 'http' ? baseUrl : null,
        primary: cfg.openrouterModel,
        free: freeModel,
        concurrency,
        requests: work.length,
        waves,
        gapMs: effectiveGap,
        warmupMs,
      },
    });

    const allowanceAfter = await safeUsage(cfg);
    phaseResult.allowanceAfter = allowanceAfter;
    phaseResult.summary.providerPaidUsageDelta =
      finiteNumber(allowanceBefore?.paidUsage) !== null &&
      finiteNumber(allowanceAfter?.paidUsage) !== null
        ? allowanceAfter.paidUsage - allowanceBefore.paidUsage
        : null;
    phaseResult.summary.freeRequestsRemainingBefore = allowanceBefore?.daily?.remaining ?? null;
    phaseResult.summary.freeRequestsRemainingAfter = allowanceAfter?.daily?.remaining ?? null;

    const artifact = {
      generatedAt: new Date().toISOString(),
      phase,
      config: phaseResult.config,
      dataset,
      allowanceBefore,
      allowanceAfter,
      summary: phaseResult.summary,
      rows: phaseResult.rows,
      logs: phaseResult.logs,
    };
    writeJson(outPath, artifact);
    removeCheckpoint(checkpointFile);
    console.log('[simple-10k] checkpoint cleared after the completed phase');

    console.log(
      `[simple-10k] RESULTS ${phase} ${phaseResult.summary.accurate}/${phaseResult.summary.requests} accurate, ` +
        `free=${phaseResult.summary.freeServed}, paid=${phaseResult.summary.paidServed}, ` +
        `errors=${phaseResult.summary.errors}, degraded=${phaseResult.summary.degraded}, ` +
        `median=${Math.round(phaseResult.summary.medianMs ?? 0)}ms, ` +
        `p95=${Math.round(phaseResult.summary.p95Ms ?? 0)}ms, ` +
        `cost=${money(phaseResult.summary.totalCostUsd)}`,
    );
    console.log(`[simple-10k] artifact: ${outPath}`);

    if (
      phaseResult.summary.accurate !== phaseResult.summary.requests ||
      phaseResult.summary.errors > 0 ||
      phaseResult.summary.degraded > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    if (keep) {
      console.log('[simple-10k] seed tenant kept (--keep)');
    } else {
      await cleanupSeedTenant('finally');
    }
    await mongoose.disconnect();
  }
}

async function safeUsage(cfg) {
  try {
    return await readProviderUsage({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: cfg.openrouterBaseUrl,
    });
  } catch (error) {
    return { status: 'UNREADABLE', detail: error?.message ?? String(error) };
  }
}

async function runTurn(question, { businessId, ownerId, pricing, transport, baseUrl, token }) {
  const started = Date.now();
  let result = null;
  let error = null;
  try {
    if (transport === 'http') {
      if (!token) throw new Error('HTTP gate is missing its session token');
      const response = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: question.message, timeZone: 'Asia/Manila' }),
        signal: AbortSignal.timeout(120000),
      });
      const raw = await response.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      if (response.status !== 201) {
        const message =
          (payload && typeof payload === 'object' && (payload.error || payload.message)) ||
          raw.slice(0, 200) ||
          `HTTP ${response.status}`;
        const httpError = new Error(`HTTP ${response.status}: ${String(message)}`);
        httpError.code = (payload && payload.code) || 'HTTP_ERROR';
        httpError.status = response.status;
        throw httpError;
      }
      const assistant = payload?.assistantMessage;
      if (!assistant) throw new Error('HTTP 201 response has no assistantMessage');
      result = {
        content: assistant.content ?? '',
        model: assistant.model ?? null,
        toolsUsed: Array.isArray(assistant.toolsUsed) ? assistant.toolsUsed : [],
        usage: assistant.usage ?? null,
        degraded: payload.degraded ?? assistant.degraded,
      };
    } else {
      result = await runAiChat({
        businessId: String(businessId),
        userId: String(ownerId),
        role: ROLES.OWNER,
        message: question.message,
        timeZone: 'Asia/Manila',
      });
    }
  } catch (caught) {
    error = caught;
  }

  const totalMs = Date.now() - started;
  const answer = result?.content ?? '';
  const model = result?.model ?? null;
  const freeServed = Boolean(model && /:free$/i.test(model));
  const check = error
    ? {
        ok: false,
        reasons: [
          `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        ],
      }
    : question.check(answer);
  if (!error) {
    const allowed =
      question.operation === 'restock_list' || question.operation === 'restock_count'
        ? SHORTAGE_READS
        : PRODUCT_STOCK_READS;
    const readTool = (result?.toolsUsed ?? []).find((tool) => allowed.has(tool));
    if (!readTool) check.reasons.push('no required tool read in result');
    if (result?.degraded) check.reasons.push(`degraded: ${result.degraded}`);
    if (!String(answer).trim()) check.reasons.push('empty answer');
  }
  check.ok = check.reasons.length === 0;

  const row = {
    id: question.id,
    operation: question.operation,
    sku: question.sku ?? null,
    message: question.message,
    expected: question.expected,
    answer,
    check,
    model,
    freeServed,
    totalMs,
    usage: result?.usage ?? null,
    toolsUsed: result?.toolsUsed ?? [],
    degraded: result?.degraded ?? null,
    error: error
      ? {
          name: error?.constructor?.name ?? 'Error',
          code: error?.code ?? null,
          status: error?.status ?? null,
          kind: error?.kind ?? null,
          message: error?.message ?? String(error),
        }
      : null,
  };
  row.costUsd = estimatedCost(row, pricing);
  return row;
}

async function runPhase({
  phase,
  work,
  concurrency,
  gapMs,
  outPath,
  businessId,
  ownerId,
  pricing,
  transport,
  baseUrl,
  token,
  config,
  checkpointFile,
  resumeRows,
  checkpointBase,
}) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const capture = (...args) => lines.push(args.map(String).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const rows = [...resumeRows];
  const completed = completedWorkIndices(resumeRows);
  let executed = 0;
  const started = Date.now();
  const turnContext = { businessId, ownerId, pricing, transport, baseUrl, token };
  const persist = (row) => {
    rows.push(row);
    executed += 1;
    writePartial(outPath, phase, config, rows, started);
    try {
      writeCheckpoint(checkpointFile, {
        ...checkpointBase,
        state: 'running',
        updatedAt: new Date().toISOString(),
        rows,
      });
    } catch (error) {
      console.error(`[simple-10k] checkpoint write failed: ${error?.message ?? error}`);
    }
  };
  try {
    if (phase === 'gate') {
      for (let index = 0; index < work.length; index += 1) {
        if (completed.has(index)) continue;
        const question = work[index];
        const row = await runTurn(question, turnContext);
        row.workIndex = index;
        row.wave = Math.floor(index / concurrency) + 1;
        row.sequence = rows.length + 1;
        persist(row);
        real.log(
          `[simple-10k] gate ${String(index + 1).padStart(2, '0')}/${work.length} ` +
            `${row.check.ok ? 'OK' : 'FAIL'} ${question.id} model=${row.model ?? '-'} ` +
            `${row.totalMs}ms cost=${money(row.costUsd)}` +
            (row.check.ok ? '' : ` ${row.check.reasons.join('; ')}`),
        );
        if (index + 1 < work.length) await sleep(gapMs);
      }
    } else {
      const chunks = Math.ceil(work.length / concurrency);
      for (let wave = 0; wave < chunks; wave += 1) {
        const batch = [];
        for (let offset = 0; offset < concurrency; offset += 1) {
          const index = wave * concurrency + offset;
          if (index >= work.length || completed.has(index)) continue;
          batch.push({ index, question: work[index] });
        }
        if (batch.length === 0) continue;
        await Promise.all(
          batch.map(async ({ index, question }) => {
            let row;
            try {
              row = await runTurn(question, turnContext);
            } catch (error) {
              row = {
                id: question.id,
                operation: question.operation,
                sku: question.sku ?? null,
                message: question.message,
                expected: question.expected,
                answer: '',
                check: { ok: false, reasons: ['turn rejected'] },
                model: null,
                freeServed: false,
                totalMs: null,
                usage: null,
                toolsUsed: [],
                degraded: null,
                error: { name: 'Error', message: String(error) },
                costUsd: null,
              };
            }
            row.workIndex = index;
            row.wave = wave + 1;
            row.sequence = rows.length + 1;
            persist(row);
          }),
        );
        const batchRows = rows.slice(-batch.length);
        real.log(
          `[simple-10k] ${phase} wave ${wave + 1}/${chunks} ` +
            `${batchRows.filter((row) => row.check.ok).length}/${batchRows.length} OK ` +
            `(${rows.length}/${work.length} complete)`,
        );
        if (wave + 1 < chunks) await sleep(gapMs);
      }
    }
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }

  const finished = Date.now();
  const durationMs = finished - started;
  // Throughput describes the work this process actually did; a resumed run must not
  // count the rows that were already completed before its first request.
  const throughputRps =
    durationMs > 0 && executed > 0 ? executed / (durationMs / 1000) : null;
  const summary = summarise(rows, {
    phase,
    requests: work.length,
    concurrency,
    waves: Math.ceil(work.length / concurrency),
    gapMs,
  });
  summary.resumedRows = resumeRows.length;
  summary.executedThisRun = executed;

  return {
    rows,
    logs: lines,
    config,
    summary: {
      ...summary,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs,
      throughputRps,
      throughputPerMinute: throughputRps === null ? null : Number((throughputRps * 60).toFixed(2)),
    },
  };
}

function writePartial(outPath, phase, config, rows, started) {
  try {
    writeJson(outPath, {
      generatedAt: new Date().toISOString(),
      phase,
      partial: true,
      config,
      summary: summarise(rows, {
        phase,
        requests: config.requests,
        concurrency: config.concurrency,
        waves: config.waves,
        gapMs: config.gapMs,
      }),
      rows,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    console.error(`[simple-10k] could not write progress: ${error?.message ?? error}`);
  }
}

main().catch((error) => {
  console.error(`[simple-10k] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
