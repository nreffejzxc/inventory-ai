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
    `Refusing to run the disposable evaluation outside the development database (resolved ${env.mongodbDbName}).`,
  );
}

const allQuestions = [
  {
    label: 'Q1',
    usesWebSearch: false,
    text: 'Find our compact wireless mechanical keyboards and compare the Keychron K8 Pro with the Royal Kludge RK61 for a small desk. Use the recorded specifications and current stock, and recommend one only if the recorded facts support it.',
  },
  {
    label: 'Q2',
    usesWebSearch: true,
    text: 'Research the web for reliability evidence on the mechanical keyboards we stock and recommend one for an office. Recommend only products we carry, include the source URLs, and keep recorded specifications separate from web findings.',
  },
];
const requestedQuestion = Number.parseInt(process.env.AI48_EVAL_QUESTION ?? '', 10);
const questions =
  requestedQuestion >= 1 && requestedQuestion <= allQuestions.length
    ? [allQuestions[requestedQuestion - 1]]
    : allQuestions;

const paidSearchEnabled = (process.env.AI_ALLOW_PAID_WEB_SEARCH || '').trim().toLowerCase() === 'true';
const paidSearchQuestions = paidSearchEnabled
  ? questions.filter((question) => question.usesWebSearch).map((question) => question.label)
  : [];
try {
  const models = assertFreeTestingModels();
  assertPaidSearchApproved({ labels: paidSearchQuestions });
  console.log(
    `[AI-48 eval] cost guard: free models only${models.length ? ` (${models.join(', ')})` : ''}; ` +
      `paid web search ${paidSearchEnabled ? 'enabled' : 'disabled (free fallback)'}`,
  );
} catch (error) {
  console.error(`[AI-48 eval] ${error.message}`);
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
    name: `AI-48 disposable evaluation ${new Date().toISOString()}`,
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

  console.log(`[AI-48 eval] database=${env.mongodbDbName} products=${products.length} rows=${DEMO_STOCK.length}`);

  for (const question of questions) {
    const message = question.text;
    console.log(`\n=== ${question.label} ===\n${message}`);
    const started = Date.now();
    try {
      const result = await runAiChat({
        businessId: String(businessId),
        userId: String(userId),
        role: 'OWNER',
        message,
        timeZone: 'Asia/Manila',
      });
      console.log(
        JSON.stringify(
          {
            elapsedMs: Date.now() - started,
            toolsUsed: result.toolsUsed,
            iterations: result.iterations,
            model: result.model,
            degraded: result.degraded ?? null,
            answer: result.content,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            elapsedMs: Date.now() - started,
            error: error?.constructor?.name ?? 'Error',
            code: error?.code ?? null,
            message: error?.message ?? String(error),
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  try {
    await cleanup();
    console.log('\n[AI-48 eval] disposable tenant removed');
  } finally {
    await mongoose.disconnect();
  }
}
