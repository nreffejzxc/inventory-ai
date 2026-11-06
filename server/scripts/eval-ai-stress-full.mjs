// Live 120-question AI stress runner.
//
// Seeds a disposable tenant from the curated demo fixture (14 real products, 3 locations,
// 22 inventory rows and a 30-row ledger), verifies the written totals, then runs every
// question through the real `runAiChat` loop. Free models only; paid web search stays off.
//
// Usage:
//   node scripts/eval-ai-stress-full.mjs
//   AI_STRESS_LIMIT=8 node scripts/eval-ai-stress-full.mjs       # pilot
//   AI_STRESS_CONCURRENCY=3 AI_STRESS_LIMIT=120 node ...
//
// Results: .tmp-ai-stress-full.json. The disposable tenant is removed in `finally`.

import 'dotenv/config';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import Category from '../src/models/category.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_MOVEMENTS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
  expectedLocationBreakdown,
  expectedSummary,
} from './demo/fixture.mjs';
import { buildStressQuestions } from './ai-stress-questions.mjs';
import { assessStressResult } from './ai-stress-assertions.mjs';
import { assertFreeTestingModels } from './live-test-guard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const OUT = new URL('../.tmp-ai-stress-full.json', import.meta.url);

if (env.mongodbDbName !== DATABASE_NAMES.development) {
  throw new Error(`Refusing to run the disposable stress test outside the development database (resolved ${env.mongodbDbName}).`);
}

const questions = buildStressQuestions();
const offset = Number.parseInt(process.env.AI_STRESS_OFFSET ?? '0', 10);
const requestedLimit = Number.parseInt(process.env.AI_STRESS_LIMIT ?? String(questions.length), 10);
const concurrency = Math.max(1, Math.min(Number.parseInt(process.env.AI_STRESS_CONCURRENCY ?? '1', 10) || 1, 2));
const retries = Math.max(0, Math.min(Number.parseInt(process.env.AI_STRESS_RETRIES ?? '2', 10) || 0, 4));
const paceMs = Math.max(0, Math.min(Number.parseInt(process.env.AI_STRESS_PACE_MS ?? '3500', 10) || 0, 10000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
  throw new Error('AI_STRESS_OFFSET must be >= 0 and AI_STRESS_LIMIT must be >= 1.');
}
const selected = questions.slice(offset, offset + requestedLimit);

try {
  const models = assertFreeTestingModels();
  console.log(
    `[AI stress full] cost guard: free models only${models.length ? ` (${models.join(', ')})` : ''}; ` +
      'paid web search disabled',
  );
} catch (error) {
  console.error(`[AI stress full] ${error.message}`);
  process.exit(1);
}

let businessId = null;

async function cleanup() {
  if (!businessId) return;
  const filter = { businessId };
  const db = mongoose.connection.db;
  for (const collection of [
    'inventory_transactions',
    'inventory',
    'products',
    'categories',
    'locations',
    'suppliers',
    'purchase_orders',
    'audit_logs',
  ]) {
    await db.collection(collection).deleteMany(filter);
  }
  const conversations = await db
    .collection('ai_conversations')
    .find(filter, { projection: { _id: 1 } })
    .toArray();
  if (conversations.length) {
    await db.collection('ai_messages').deleteMany({
      conversationId: { $in: conversations.map((row) => row._id) },
    });
  }
  await db.collection('ai_conversations').deleteMany(filter);
  await Business.deleteOne({ _id: businessId });
}

await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
try {
  const business = await Business.create({
    name: `AI stress full ${new Date().toISOString()}`,
    status: 'ACTIVE',
  });
  businessId = business._id;
  const userId = new mongoose.Types.ObjectId();

  const categories = await Category.insertMany(
    DEMO_CATEGORIES.map((category) => ({ businessId, name: category.name, status: 'ACTIVE' })),
  );
  const categoryId = new Map(categories.map((doc, index) => [DEMO_CATEGORIES[index].key, doc._id]));

  const locations = await Location.insertMany(
    DEMO_LOCATIONS.map((location) => ({ businessId, name: location.name, status: 'ACTIVE' })),
  );
  const locationId = new Map(locations.map((doc, index) => [DEMO_LOCATIONS[index].key, doc._id]));

  const products = await Product.insertMany(
    DEMO_PRODUCTS.map((product) => ({
      businessId,
      name: product.name,
      brand: product.brand,
      sku: product.sku,
      description: product.description,
      specifications: product.specifications,
      categoryId: categoryId.get(product.category),
      costPrice: product.costPrice,
      sellingPrice: product.sellingPrice,
      unit: product.unit,
      minimumStock: product.minimumStock,
      status: 'ACTIVE',
    })),
  );
  const productId = new Map(products.map((doc, index) => [DEMO_PRODUCTS[index].key, doc._id]));

  await Inventory.insertMany(
    DEMO_STOCK.map((row) => ({
      businessId,
      productId: productId.get(row.product),
      locationId: locationId.get(row.location),
      quantity: row.quantity,
      reservedQuantity: 0,
    })),
  );

  const now = Date.now();
  await InventoryTransaction.insertMany(
    DEMO_MOVEMENTS.map((row) => {
      const when = new Date(now - row.daysAgo * DAY_MS);
      return {
        businessId,
        productId: productId.get(row.product),
        locationId: locationId.get(row.location),
        type: row.type,
        quantity: row.quantity,
        previousQuantity: row.previousQuantity,
        newQuantity: row.newQuantity,
        reason: row.reason,
        reference: `STRESS-${row.product}-${row.daysAgo}`,
        userId,
        createdAt: when,
        updatedAt: when,
      };
    }),
  );

  const written = {
    products: await Product.countDocuments({ businessId }),
    inventory: await Inventory.countDocuments({ businessId }),
    transactions: await InventoryTransaction.countDocuments({ businessId }),
  };
  const units = await Inventory.aggregate([
    { $match: { businessId } },
    { $group: { _id: null, total: { $sum: '$quantity' } } },
  ]);
  const expected = expectedSummary();
  const locationTruth = expectedLocationBreakdown();
  if (
    written.products !== expected.totalProducts ||
    written.inventory !== DEMO_STOCK.length ||
    written.transactions !== DEMO_MOVEMENTS.length ||
    (units[0]?.total ?? 0) !== expected.totalInventoryQuantity
  ) {
    throw new Error(
      `Seeded data did not verify: ${JSON.stringify({ written, units: units[0]?.total, expected })}`,
    );
  }
  console.log(
    `[AI stress full] seeded and verified: products=${written.products}, inventory=${written.inventory}, ` +
      `movements=${written.transactions}, units=${units[0].total}, ` +
      `low=${expected.lowStockProducts}, out=${expected.outOfStockProducts}, ` +
      `locations=${locationTruth.locations.map((row) => `${row.name}:${row.units}`).join(' ')}`,
  );
  console.log(
    `[AI stress full] database=${env.mongodbDbName} questions=${selected.length}/${questions.length} ` +
      `offset=${offset} concurrency=${concurrency}`,
  );

  const started = Date.now();
  const results = new Array(selected.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const question = selected[index];
      const questionStarted = Date.now();
      try {
        let result;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            result = await runAiChat({
              businessId: String(businessId),
              userId: String(userId),
              role: 'OWNER',
              message: question.question,
              timeZone: 'Asia/Manila',
            });
            break;
          } catch (error) {
            const retryable =
              error?.code === 'AI_QUOTA_EXCEEDED' ||
              /rate.?limit|429|quota/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
            if (!retryable || attempt >= retries) throw error;
            console.log(
              `[AI stress full] Q${question.id} provider limit; waiting 35s before retry ` +
                `${attempt + 1}/${retries}`,
            );
            await sleep(35000);
          }
        }
        const elapsedMs = Date.now() - questionStarted;
        const checks = assessStressResult(question, result);
        results[index] = {
          id: question.id,
          category: question.category,
          question: question.question,
          expectedTools: question.tools,
          elapsedMs,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          model: result.model,
          degraded: result.degraded ?? null,
          checks,
          answer: result.content,
        };
        completed += 1;
        console.log(
          `[AI stress full] ${String(completed).padStart(3)}/${selected.length} ` +
            `${checks.ok ? 'OK  ' : 'FAIL'} Q${question.id} ${question.category} ` +
            `tools=${(result.toolsUsed ?? []).join(',') || 'none'} ${elapsedMs}ms` +
            (checks.missing.length ? ` missing=${checks.missing.join('|')}` : '') +
            (checks.failureNotice ? ' failure-notice' : '') +
            (checks.toolHit ? '' : ' tool-route-mismatch'),
        );
        // The free tier allows 20 requests a minute. One call is made per model step, so
        // pacing on iterations keeps a 3-4 step turn below the limit without a fixed sleep
        // long enough to slow a short turn down unnecessarily.
        if (concurrency === 1 && paceMs > 0) {
          await sleep(Math.max(3000, (result.iterations || 1) * paceMs));
        }
      } catch (error) {
        results[index] = {
          id: question.id,
          category: question.category,
          question: question.question,
          expectedTools: question.tools,
          elapsedMs: Date.now() - questionStarted,
          error: error?.constructor?.name ?? 'Error',
          code: error?.code ?? null,
          message: error?.message ?? String(error),
          checks: { ok: false, toolHit: false, missing: [], failureNotice: false },
        };
        completed += 1;
        console.log(
          `[AI stress full] ${String(completed).padStart(3)}/${selected.length} ` +
            `FAIL Q${question.id} ${error?.code ?? error?.constructor?.name ?? 'Error'}: ` +
            `${error?.message ?? String(error)}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsedMs = Date.now() - started;
  const summary = {
    total: results.length,
    ok: results.filter((row) => row.checks?.ok).length,
    failed: results.filter((row) => !row.checks?.ok).length,
    toolMiss: results.filter((row) => !row.checks?.toolHit).length,
    error: results.filter((row) => row.error).length,
    degraded: results.filter((row) => row.degraded).length,
    elapsedMs,
    categories: {},
    tools: {},
  };
  for (const row of results) {
    summary.categories[row.category] ??= { total: 0, ok: 0, failed: 0 };
    summary.categories[row.category].total += 1;
    summary.categories[row.category][row.checks?.ok ? 'ok' : 'failed'] += 1;
    for (const tool of row.toolsUsed ?? []) summary.tools[tool] = (summary.tools[tool] ?? 0) + 1;
  }

  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    OUT,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `\n[AI stress full] complete: ${summary.ok}/${summary.total} answer-correct, ` +
      `${summary.failed} failed, ${summary.toolMiss} tool-route mismatches, ` +
      `${summary.error} errors, ${summary.degraded} degraded, ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(`[AI stress full] results: ${OUT.pathname}`);
  if (summary.failed > 0) process.exitCode = 1;
} finally {
  try {
    await cleanup();
    console.log('[AI stress full] disposable tenant removed');
  } finally {
    await mongoose.disconnect();
  }
}
