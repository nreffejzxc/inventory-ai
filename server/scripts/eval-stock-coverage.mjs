// Bounded LIVE evaluation of AI-118's run-out tool selection.
//
// WHY THIS EXISTS. The DB-backed Q7/Q8 turns use a scripted provider: they prove the
// offer -> selection (including the corrective re-ask) -> execution -> persistence path,
// not that the configured live model chooses `getProductStockCoverage` for real paraphrases.
// This harness runs the real `runAiChat` loop against the CURRENT configured model and a
// disposable development tenant. It records each turn's first tool, all tools used, whether
// coverage was selected and whether the corrective re-ask fired.
//
// WHAT IT DOES NOT DO. It never changes a model id, fallback list, reasoning setting or
// other AI configuration. It does not run in CI and does not touch a real tenant: it starts
// only against the development database, seeds a disposable business, and removes it in
// `finally`. Questions are inventory-only, so the paid web plugin is not used.
//
// COST. This spends live-model quota. The owner must approve that explicitly:
//   AI_TEST_ALLOW_PAID_MODELS=true npm run eval:stock-coverage -- --limit=2
// Then the bounded six-question sample:
//   AI_TEST_ALLOW_PAID_MODELS=true npm run eval:stock-coverage
// A no-call structural check is safe and free:
//   npm run eval:stock-coverage -- --validate-only
//
// Results are written to `.tmp-stock-coverage-live.json` (ignored by `.tmp-*`). Set
// STOCK_COVERAGE_EVAL_OUT to keep a run separate.

import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { ROLES } from '../src/constants/roles.ts';
import Business from '../src/models/business.model.ts';
import Category from '../src/models/category.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import { asksForStockCoverage } from '../src/services/ai/answerCompletion.ts';
import { simpleInventoryIntent } from '../src/services/ai/simpleInventory.ts';
import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_MOVEMENTS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
} from './demo/fixture.mjs';
import { PAID_MODELS_APPROVAL_ENV, assertFreeTestingModels } from './live-test-guard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QUESTIONS = 6;
const OUT_NAME = (process.env.STOCK_COVERAGE_EVAL_OUT || '.tmp-stock-coverage-live.json').replace(
  /^\.?\//,
  '',
);
const OUT = new URL(`../${OUT_NAME}`, import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag) {
  const hit = process.argv.find((value) => value.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

const byKey = new Map(DEMO_PRODUCTS.map((product) => [product.key, product]));
const productName = (key) => byKey.get(key)?.name ?? key;

const questions = [
  {
    id: 'how-long',
    product: 'mx-keys-s',
    message: `How long will the ${productName('mx-keys-s')} last?`,
  },
  {
    id: 'days-of-cover',
    product: 'keychron-k8-pro',
    message: `How many days of cover does the ${productName('keychron-k8-pro')} have?`,
  },
  {
    id: 'run-out-soon',
    product: 'razer-blackwidow-v4-pro',
    message: `Are we going to run out of the ${productName('razer-blackwidow-v4-pro')} soon?`,
  },
  {
    id: 'stock-coverage',
    product: 'sony-wh-1000xm5',
    message: `What is the stock coverage for the ${productName('sony-wh-1000xm5')}?`,
  },
  {
    id: 'until-runs-out',
    product: 'royal-kludge-rk61',
    message: `How long until the ${productName('royal-kludge-rk61')} runs out?`,
  },
  {
    id: 'longer-at-rate',
    product: 'samsung-t7-shield',
    message: `How much longer will the ${productName('samsung-t7-shield')} last at the current rate?`,
  },
];

for (const question of questions) {
  if (!asksForStockCoverage(question.message)) {
    throw new Error(`[stock-coverage-live] ${question.id} is not recognised as a run-out question`);
  }
  if (simpleInventoryIntent(question.message)) {
    throw new Error(`[stock-coverage-live] ${question.id} would take the simple route`);
  }
}

if (process.argv.includes('--validate-only')) {
  console.log(
    `[stock-coverage-live] ${questions.length} run-out questions classify; no provider or database call was made.`,
  );
  process.exit(0);
}

const cfg = aiConfig();
if (env.mongodbDbName !== DATABASE_NAMES.development) {
  console.error(
    `[stock-coverage-live] refusing database ${env.mongodbDbName}; this harness only runs against ${DATABASE_NAMES.development}.`,
  );
  process.exit(2);
}
if (cfg.provider !== 'openrouter') {
  console.error(`[stock-coverage-live] AI_PROVIDER is ${cfg.provider || 'unset'}; this harness needs openrouter.`);
  process.exit(2);
}
if (!cfg.openrouterModel) {
  console.error('[stock-coverage-live] AI_MODEL_OPENROUTER is unset.');
  process.exit(2);
}
if (!(process.env.OPENROUTER_API_KEY || '').trim()) {
  console.error('[stock-coverage-live] OPENROUTER_API_KEY is unset.');
  process.exit(2);
}
if (process.env[PAID_MODELS_APPROVAL_ENV] !== 'true') {
  console.error(
    `[stock-coverage-live] refusing to run: live-model turns spend quota. ` +
      `Set ${PAID_MODELS_APPROVAL_ENV}=true only after the owner has approved this measurement.`,
  );
  process.exit(2);
}
try {
  assertFreeTestingModels();
} catch (error) {
  console.error(`[stock-coverage-live] ${error.message}`);
  process.exit(2);
}

const requestedLimit = Number.parseInt(
  argValue('--limit') ?? process.env.STOCK_COVERAGE_EVAL_LIMIT ?? '',
  10,
);
const selected =
  Number.isInteger(requestedLimit) && requestedLimit > 0
    ? questions.slice(0, Math.min(requestedLimit, MAX_QUESTIONS))
    : questions.slice(0, MAX_QUESTIONS);

console.log(
  `[stock-coverage-live] configured model: provider=${cfg.provider} primary=${cfg.openrouterModel}` +
    ` fallbacks=${cfg.fallbackModels.length} questions=${selected.length}`,
);
console.log(
  '[stock-coverage-live] no model, fallback, reasoning or web configuration is changed by this run.',
);

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
    'ai_turn_metrics',
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

function parseTurnLine(line) {
  const field = (name) => {
    const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line ?? '');
    return match ? match[1] : null;
  };
  return {
    outcome: field('outcome'),
    calls: Number.parseInt(field('calls') ?? '', 10) || 0,
    toolRuns: Number.parseInt(field('toolRuns') ?? '', 10) || 0,
    iterations: Number.parseInt(field('iterations') ?? '', 10) || 0,
    route: field('route'),
    model: field('model'),
    total: field('total'),
  };
}

async function runTurn(question, { business, user }) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) =>
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const started = Date.now();
  let result = null;
  let error = null;
  try {
    result = await runAiChat({
      businessId: String(business),
      userId: String(user),
      role: ROLES.OWNER,
      message: question.message,
      timeZone: 'Asia/Manila',
    });
  } catch (err) {
    error = err;
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  const totalMs = Date.now() - started;
  const turnLine = lines.find((line) => line.startsWith('AI turn')) ?? null;
  const metrics = parseTurnLine(turnLine);
  const tools = Array.isArray(result?.toolsUsed) ? result.toolsUsed : [];
  const coverageSelected = tools.includes('getProductStockCoverage');
  const coverageFirst = tools[0] === 'getProductStockCoverage';
  const answer = result?.content ?? '';
  return {
    id: question.id,
    product: productName(question.product),
    message: question.message,
    error: error
      ? { name: error?.constructor?.name ?? 'Error', message: error?.message ?? String(error) }
      : null,
    tools,
    firstTool: tools[0] ?? null,
    coverageSelected,
    coverageFirst,
    selection: coverageFirst ? 'selected-first' : coverageSelected ? 'selected-later' : 'not-selected',
    corrected: lines.some((line) => line.includes('answered without getProductStockCoverage')),
    route: metrics.route,
    model: result?.model ?? metrics.model,
    calls: metrics.calls,
    toolRuns: metrics.toolRuns,
    iterations: metrics.iterations,
    totalMs,
    degraded: result?.degraded ?? null,
    answerMentionsProxyCaveat: /movement proxy|not confirmed sales/i.test(answer),
    answerClaimsInfiniteCover: /\b(?:forever|infinite|infinity)\b/i.test(answer),
    answerExcerpt: answer.slice(0, 500),
    turnLine,
  };
}

await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
const rows = [];
let exitCode = 0;
try {
  const business = await Business.create({
    name: `AI stock coverage live evaluation ${new Date().toISOString()}`,
    status: 'ACTIVE',
  });
  businessId = business._id;
  const userId = new mongoose.Types.ObjectId();

  const categories = await Category.insertMany(
    DEMO_CATEGORIES.map((category) => ({
      businessId,
      name: category.name,
      status: 'ACTIVE',
    })),
  );
  const categoryId = new Map(categories.map((doc, index) => [DEMO_CATEGORIES[index].key, doc._id]));

  const locations = await Location.insertMany(
    DEMO_LOCATIONS.map((location) => ({
      businessId,
      name: location.name,
      status: 'ACTIVE',
    })),
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
      currency: product.currency,
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
        reference: `STOCK-COVERAGE-${row.product}-${row.daysAgo}`,
        userId,
        createdAt: when,
        updatedAt: when,
      };
    }),
  );

  const seeded = {
    products: await Product.countDocuments({ businessId }),
    inventory: await Inventory.countDocuments({ businessId }),
    movements: await InventoryTransaction.countDocuments({ businessId }),
  };
  if (
    seeded.products !== DEMO_PRODUCTS.length ||
    seeded.inventory !== DEMO_STOCK.length ||
    seeded.movements !== DEMO_MOVEMENTS.length
  ) {
    throw new Error(`[stock-coverage-live] seeded data did not verify: ${JSON.stringify(seeded)}`);
  }
  console.log(
    `[stock-coverage-live] seeded ${seeded.products} products, ${seeded.inventory} stock rows, ` +
      `${seeded.movements} movements in a disposable tenant`,
  );

  for (const question of selected) {
    const row = await runTurn(question, { business: businessId, user: userId });
    rows.push(row);
    console.log(
      `[stock-coverage-live] ${row.id.padEnd(16)} first=${String(row.firstTool).padEnd(26)} ` +
        `selection=${row.selection.padEnd(15)} corrected=${row.corrected} ` +
        `calls=${row.calls} ${row.totalMs}ms ${row.error ? `ERROR ${row.error.message}` : 'OK'}`,
    );
    await sleep(3500);
  }
} finally {
  try {
    // Metrics and conversation writes are fire-and-forget; let the last one land before
    // removing the disposable tenant. This waits for this script, not for a model.
    await sleep(300);
    await cleanup();
    console.log('[stock-coverage-live] disposable tenant removed');
  } finally {
    await mongoose.disconnect();
  }
}

const errors = rows.filter((row) => row.error).length;
const selectedFirst = rows.filter((row) => row.coverageFirst).length;
const selectedAny = rows.filter((row) => row.coverageSelected).length;
const corrected = rows.filter((row) => row.corrected).length;
const summary = {
  questions: rows.length,
  errors,
  selectedFirst,
  selectedAny,
  corrected,
  selectionRateFirst: rows.length ? selectedFirst / rows.length : null,
  selectionRateAny: rows.length ? selectedAny / rows.length : null,
  proxyCaveatAnswers: rows.filter((row) => row.answerMentionsProxyCaveat).length,
  infiniteCoverClaims: rows.filter((row) => row.answerClaimsInfiniteCover).length,
};

console.log('\n[stock-coverage-live] RESULTS');
console.log(
  `[stock-coverage-live] first-read coverage ${selectedFirst}/${rows.length}; ` +
    `coverage anywhere ${selectedAny}/${rows.length}; corrected by re-ask ${corrected}; ` +
    `errors ${errors}; proxy caveat ${summary.proxyCaveatAnswers}/${rows.length}; ` +
    `infinite claims ${summary.infiniteCoverClaims}`,
);

const artifact = {
  generatedAt: new Date().toISOString(),
  sample: selected.length,
  configuration: {
    provider: cfg.provider,
    primary: cfg.openrouterModel,
    fallbackCount: cfg.fallbackModels.length,
    changed: false,
  },
  questions,
  summary,
  rows,
};
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`[stock-coverage-live] artifact: ${OUT.pathname}`);

if (errors > 0 || selectedAny < rows.length) exitCode = 1;
process.exitCode = exitCode;
