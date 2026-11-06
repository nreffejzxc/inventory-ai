import 'dotenv/config';

import mongoose from 'mongoose';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import Business from '../src/models/business.model.ts';
import Category from '../src/models/category.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import Location from '../src/models/location.model.ts';
import Product from '../src/models/product.model.ts';
import { runAiChat } from '../src/services/ai/ai.service.ts';
import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
} from './demo/fixture.mjs';
import { assertFreeTestingModels, assertPaidSearchApproved } from './live-test-guard.mjs';

if (env.mongodbDbName !== DATABASE_NAMES.development) {
  throw new Error(
    `Refusing to run the disposable stress test outside the development database (resolved ${env.mongodbDbName}).`,
  );
}

const QUESTIONS = [
  'Do we have any computer parts or peripherals? List the matching products and brands from our inventory.',
  'Which keyboard and mouse brands do we carry, and how many units of each product are on hand?',
  'Research the reviews, quality, affordability and reliability of the mechanical keyboards we stock. Recommend one for an office and cite your sources.',
  'Compare the prices of the Keychron K8 Pro and Royal Kludge RK61 in our inventory with current online prices on Shopee, Lazada and Amazon. Include source URLs and say when a price is unavailable.',
  'Which products under 10,000 are good value for a small home office? Use recorded prices and stock, and research quality where useful.',
  'Is the Logitech MX Master 3S reliable according to owner reviews? Summarise the evidence and cite your sources.',
];

const requested = String(process.env.AI_STRESS_QUESTIONS ?? '')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 1 && value <= QUESTIONS.length);
const selected = requested.length ? [...new Set(requested)] : QUESTIONS.map((_, index) => index + 1);

// These questions call researchInventoryProducts or researchMarketPrices. Each
// research request uses OpenRouter's paid web plugin, even with a free model.
const PAID_SEARCH_QUESTIONS = new Set([3, 4, 5, 6]);
const paidSearchEnabled = (process.env.AI_ALLOW_PAID_WEB_SEARCH || '').trim().toLowerCase() === 'true';
const selectedWebQuestions = selected
  .filter((number) => PAID_SEARCH_QUESTIONS.has(number))
  .map((number) => `Q${number}`);
const paidSearchQuestions = paidSearchEnabled ? selectedWebQuestions : [];

try {
  const models = assertFreeTestingModels();
  assertPaidSearchApproved({ labels: paidSearchQuestions });
  console.log(
    `[AI stress] cost guard: free models only${models.length ? ` (${models.join(', ')})` : ''}; ` +
      `paid web search ${paidSearchEnabled ? 'enabled' : 'disabled (free fallback)'}`,
  );
  if (!paidSearchEnabled && selectedWebQuestions.length) {
    console.log('[AI stress] free web fallback active; price research will report unavailable.');
  }
} catch (error) {
  console.error(`[AI stress] ${error.message}`);
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
    name: `AI stress disposable evaluation ${new Date().toISOString()}`,
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

  console.log(
    `[AI stress] database=${env.mongodbDbName} products=${products.length} rows=${DEMO_STOCK.length} questions=${selected.join(',')}`,
  );

  const results = [];
  for (const questionNumber of selected) {
    const message = QUESTIONS[questionNumber - 1];
    console.log(`\n=== Q${questionNumber} ===`);
    const started = Date.now();
    try {
      const result = await runAiChat({
        businessId: String(businessId),
        userId: String(userId),
        role: 'OWNER',
        message,
        timeZone: 'Asia/Manila',
      });
      const row = {
        questionNumber,
        question: message,
        elapsedMs: Date.now() - started,
        toolsUsed: result.toolsUsed,
        iterations: result.iterations,
        model: result.model,
        degraded: result.degraded ?? null,
        answer: result.content,
      };
      results.push(row);
      console.log(
        `Q${questionNumber} tools=${row.toolsUsed.join(',') || 'none'} elapsedMs=${row.elapsedMs} chars=${row.answer.length}`,
      );
    } catch (error) {
      const row = {
        questionNumber,
        question: message,
        elapsedMs: Date.now() - started,
        error: error?.constructor?.name ?? 'Error',
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
      results.push(row);
      console.log(`Q${questionNumber} ERROR ${row.code ?? row.error}: ${row.message}`);
    }
  }

  const outPath = new URL('../.tmp-ai-stress-results.json', import.meta.url);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(`\n[AI stress] results written to ${outPath.pathname}`);
} finally {
  try {
    await cleanup();
    console.log('\n[AI stress] disposable tenant removed');
  } finally {
    await mongoose.disconnect();
  }
}
