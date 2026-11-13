// Deployed counterpart to `eval-simple-inventory-scale.mjs --phase=gate`.
//
// The permanent evaluator owns a disposable DEVELOPMENT tenant: it seeds, normalizes and removes
// it. The deployed server reads the PRODUCTION database, so this runner uses the existing
// synthetic PERF SEED tenant there, snapshots its inventory quantities, applies the SAME
// five-low-stock normalization for the duration of the gate, and restores the snapshot in
// `finally`. It never creates or deletes a tenant, product or account.
//
// Hard stops: a paid model, an unknown or nonzero cost, an unreadable/depleted free allowance, an
// inventory shape change it did not cause, a provider paid-usage delta, or an error/degraded turn.
// On a stop it restores the snapshot, writes the partial artifact and exits non-zero.
//
// Authentication is the app's own production path: Firebase custom token -> ID token ->
// POST /api/auth/firebase/exchange. No JWT secret is read or needed.
//
// Required environment:
//   NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db
//   GATE_PRODUCTION_CONFIRM=production-simple-gate
//   FIREBASE_SERVICE_ACCOUNT_JSON, OPENROUTER_API_KEY
//   EXPO_PUBLIC_FIREBASE_API_KEY (loaded from ../mobile/.env)

import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import env, { DATABASE_NAMES } from '../../src/config/env.ts';
import Business from '../../src/models/business.model.ts';
import Inventory from '../../src/models/inventory.model.ts';
import Product from '../../src/models/product.model.ts';
import User from '../../src/models/user.model.ts';
import { exchangeForAccessToken } from './firebaseLogin.mjs';
import { readProviderUsage } from '../ai-usage.mjs';
import { existenceCheck, normalise } from './answerCheckers.mjs';
import {
  assertDatasetUnchanged,
  assertFreeAllowance,
  assertFreeZeroCost,
  assertPaidUsageUnchanged,
  assertRestored,
  datasetFingerprint,
} from './productionGateGuards.mjs';

const BASE_URL = (process.env.GATE_BASE || 'https://ai-inventory-l1mi.onrender.com').replace(/\/+$/, '');
const OUT = '.tmp-simple-inventory-scale-gate-deployed.json';
const BACKUP = '.tmp-deployed-gate-inventory-backup.json';
const GATE_REQUESTS = 25;
const GAP_MS = 10000;
const BUSINESS_NAME = 'PERF SEED — AI assistant stress test (do not use)';
const OWNER_EMAIL = 'perf-seed-ai@example.invalid';
const PRODUCT_STOCK_READS = new Set(['getInventory', 'getProduct', 'findProducts']);
const SHORTAGE_READS = new Set(['getReorderNeededProducts', 'getLowStockProducts', 'getOutOfStockProducts']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`[deployed-gate] ${message}`);
  process.exit(2);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sentenceHas(text, value, label) {
  const number = new RegExp(`\\b${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*')}\\b`, 'i');
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
      !/\b(?:out of stock|0 units?|zero units?|no units?|no stock|none on hand|none in stock|not in stock|not stocked|no inventory record)\b/i.test(text)
    ) {
      reasons.push('missing an out-of-stock / zero statement');
    }
  } else if (!sentenceHas(text, expected, /\b(?:units?|on hand|stock|quantity|available|qty)\b/i)) {
    reasons.push(`missing ${expected} with a stock/unit label`);
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

function estimatedCost(row, pricing) {
  if (row.freeServed && !row.error) return 0;
  if (!pricing || pricing.error || !row.usage) return null;
  const input = finiteNumber(row.usage.inputTokens);
  const output = finiteNumber(row.usage.outputTokens);
  if (input === null || output === null) return null;
  return input * pricing.prompt + output * pricing.completion;
}

function summarise(rows) {
  const answered = rows.filter((row) => !row.error);
  const accurate = rows.filter((row) => row.check.ok);
  const free = answered.filter((row) => row.freeServed);
  const paid = answered.filter((row) => !row.freeServed);
  const errors = rows.filter((row) => row.error);
  const times = answered.map((row) => row.totalMs).filter(Number.isFinite);
  const costs = rows.map((row) => row.costUsd);
  const costComplete = rows.length > 0 && costs.every((value) => value !== null);
  return {
    phase: 'gate',
    requests: GATE_REQUESTS,
    concurrency: 1,
    waves: GATE_REQUESTS,
    gapMs: GAP_MS,
    answered: answered.length,
    accurate: accurate.length,
    accuracyRate: accurate.length / GATE_REQUESTS,
    answeredAccuracy: answered.length ? accurate.length / answered.length : null,
    errors: errors.length,
    errorRate: errors.length / GATE_REQUESTS,
    degraded: rows.filter((row) => row.degraded).length,
    freeServed: free.length,
    paidServed: paid.length,
    freeSuccessRate: answered.length ? free.length / answered.length : null,
    paidFallbackRate: answered.length ? paid.length / answered.length : null,
    medianMs: median(times),
    p95Ms: p95(times),
    meanMs: mean(times),
    minMs: times.length ? Math.min(...times) : null,
    maxMs: times.length ? Math.max(...times) : null,
    totalCostUsd: costComplete ? costs.reduce((sum, value) => sum + value, 0) : null,
    costComplete,
  };
}

async function fetchPricing(model) {
  const base = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api').replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const body = await response.json();
    const row = Array.isArray(body?.data) ? body.data.find((entry) => entry?.id === model) : undefined;
    const prompt = Number(row?.pricing?.prompt);
    const completion = Number(row?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
      return { error: 'the catalogue did not publish pricing for the paid primary' };
    }
    return { prompt, completion, promptPerMillion: prompt * 1_000_000, completionPerMillion: completion * 1_000_000 };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

async function usage() {
  try {
    return await readProviderUsage({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL,
    });
  } catch (error) {
    return { status: 'UNREADABLE', detail: error?.message ?? String(error) };
  }
}

async function backupInventory(rows) {
  const snapshot = rows.map((row) => ({
    _id: String(row._id),
    quantity: Number(row.quantity),
    reservedQuantity: Number(row.reservedQuantity ?? 0),
  }));
  writeJson(BACKUP, snapshot);
  return snapshot;
}

async function restoreInventory(snapshot) {
  const operations = snapshot.map((row) => ({
    updateOne: {
      filter: { _id: row._id },
      update: { $set: { quantity: row.quantity, reservedQuantity: row.reservedQuantity } },
    },
  }));
  for (let index = 0; index < operations.length; index += 2000) {
    await Inventory.bulkWrite(operations.slice(index, index + 2000), { ordered: false, timestamps: false });
  }
  console.log(`[deployed-gate] restored ${operations.length} inventory row(s) from the snapshot`);
}

async function inventoryFingerprint(businessId) {
  const [products, inventoryRows, totals] = await Promise.all([
    Product.countDocuments({ businessId, status: 'ACTIVE' }),
    Inventory.countDocuments({ businessId }),
    Inventory.aggregate([
      { $match: { businessId } },
      {
        $group: {
          _id: null,
          quantity: { $sum: '$quantity' },
          reserved: { $sum: '$reservedQuantity' },
        },
      },
    ]),
  ]);
  return datasetFingerprint({
    products,
    inventoryRows,
    totalQuantity: totals[0]?.quantity ?? 0,
    reserved: totals[0]?.reserved ?? 0,
  });
}

function loadMobileFirebaseKey() {
  if ((process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '').trim()) return;
  try {
    const text = fs.readFileSync('../mobile/.env', 'utf8');
    const match = text.match(/^EXPO_PUBLIC_FIREBASE_API_KEY=(.*)$/m);
    if (match) process.env.EXPO_PUBLIC_FIREBASE_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // The check below reports the missing key without printing a path or value.
  }
}

async function main() {
  loadMobileFirebaseKey();
  if (process.env.GATE_PRODUCTION_CONFIRM !== 'production-simple-gate') {
    fail('set GATE_PRODUCTION_CONFIRM=production-simple-gate to run against the deployed URL');
  }
  if (env.nodeEnv !== 'production' || env.mongodbDbName !== DATABASE_NAMES.production) {
    fail(`refusing database ${env.mongodbDbName} in ${env.nodeEnv}; run NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db`);
  }
  if (!/^https:\/\//i.test(BASE_URL)) fail('GATE_BASE must be an https URL');
  if (!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()) fail('FIREBASE_SERVICE_ACCOUNT_JSON is unset');
  if (!(process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '').trim()) fail('EXPO_PUBLIC_FIREBASE_API_KEY is unset');

  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  console.log(`[deployed-gate] database=${mongoose.connection.name} target=${BASE_URL}`);

  const business = await Business.findOne({ name: BUSINESS_NAME }).lean();
  if (!business) throw new Error('the production PERF SEED tenant does not exist');
  const businessId = business._id;
  const owner = await User.findOne({ businessId, email: OWNER_EMAIL, role: 'OWNER', status: 'ACTIVE' })
    .select('_id firebaseUid')
    .lean();
  if (!owner?.firebaseUid) throw new Error('the production PERF SEED tenant has no active Firebase-linked owner');

  const products = await Product.find({ businessId, status: 'ACTIVE' })
    .select('_id name sku minimumStock')
    .lean();
  const inventoryRows = await Inventory.find({ businessId })
    .select('_id productId quantity reservedQuantity')
    .lean();
  if (!products.length || !inventoryRows.length) throw new Error('the production PERF SEED tenant has no data');

  // Restore a snapshot left by an interrupted run before taking a new one.
  if (fs.existsSync(BACKUP)) {
    const stale = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    await restoreInventory(stale);
    fs.unlinkSync(BACKUP);
  }

  const snapshot = await backupInventory(inventoryRows);
  const initialFingerprint = await inventoryFingerprint(businessId);
  console.log(
    `[deployed-gate] snapshot: ${snapshot.length} inventory row(s) -> ${BACKUP}; ` +
      `shape=${JSON.stringify(initialFingerprint)}`,
  );

  let restored = false;
  const restoreOnce = async () => {
    if (restored) return;
    restored = true;
    await restoreInventory(snapshot);
    const restoredRows = await Inventory.find({ businessId })
      .select('_id quantity reservedQuantity')
      .lean();
    assertRestored(snapshot, restoredRows);
    assertDatasetUnchanged(initialFingerprint, await inventoryFingerprint(businessId));
    console.log(`[deployed-gate] restore verified exactly for ${restoredRows.length} row(s)`);
    if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
  };

  try {
    const low = [];
    const usedNames = new Set();
    const candidates = products
      .filter((product) => {
        const index = Number(String(product.sku).replace(/^SEEDSKU-/, ''));
        return Number.isInteger(index) && index >= 5000 && index <= 9000;
      })
      .sort((left, right) => String(left.sku).localeCompare(String(right.sku), undefined, { numeric: true }));
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
      await Inventory.bulkWrite(operations.slice(index, index + 2000), { ordered: false, timestamps: false });
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
      throw new Error(`restock normalization failed: found ${restock.length} restock product(s)`);
    }
    const duringFingerprint = await inventoryFingerprint(businessId);
    if (
      duringFingerprint.products !== initialFingerprint.products ||
      duringFingerprint.inventoryRows !== initialFingerprint.inventoryRows
    ) {
      throw new Error(
        `normalization changed the row shape: ${JSON.stringify(initialFingerprint)} -> ` +
          `${JSON.stringify(duringFingerprint)}`,
      );
    }
    console.log(`[deployed-gate] normalized shape=${JSON.stringify(duringFingerprint)}`);

    const healthy = products
      .filter((product) => !lowIds.has(String(product._id)))
      .sort((left, right) => String(left.sku).localeCompare(String(right.sku), undefined, { numeric: true }));
    const stockProducts = [low[0], ...healthy.slice(0, 14)];
    if (stockProducts.length !== 15) throw new Error('expected 15 stock samples');

    const stockQuestions = stockProducts.map((product) => ({
      id: `stock-${product.sku}`,
      operation: 'product_stock',
      sku: product.sku,
      name: product.name,
      expected: totalById.get(String(product._id)) ?? 0,
      message: `How many units of the product with SKU ${product.sku} are in stock?`,
      check: (answer) => productCheck(answer, totalById.get(String(product._id)) ?? 0, product.sku, product.name),
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
    if (gateQuestions.length !== GATE_REQUESTS) throw new Error(`built ${gateQuestions.length} gate questions`);

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
    };
    console.log(
      `[deployed-gate] tenant=${String(businessId)} products=${products.length} ` +
        `inventoryRows=${inventoryRows.length} restock=${restock.length}`,
    );
    console.log(`[deployed-gate] low SKUs: ${low.map((product) => product.sku).join(', ')}`);
    console.log(
      `[deployed-gate] samples: ${dataset.stockSamples
        .slice(0, 5)
        .map((sample) => `${sample.sku}=${sample.expected}`)
        .join(', ')}`,
    );
    console.log(`[deployed-gate] restock names: ${restockNames.join('; ')}`);

    const pricing = await fetchPricing('openai/gpt-oss-20b');
    console.log(
      `[deployed-gate] pricing: ${
        pricing.error
          ? `unavailable (${pricing.error})`
          : `$${pricing.promptPerMillion.toFixed(3)}/M input, $${pricing.completionPerMillion.toFixed(3)}/M output`
      }`,
    );

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
    const customToken = await getAuth().createCustomToken(String(owner.firebaseUid));
    const signInResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(
        process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
      )}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      },
    );
    const signInBody = await signInResponse.json().catch(() => null);
    if (!signInResponse.ok || typeof signInBody?.idToken !== 'string') {
      throw new Error(
        `Firebase custom-token sign-in failed: ${signInBody?.error?.message ?? `HTTP ${signInResponse.status}`}`,
      );
    }
    const exchanged = await exchangeForAccessToken({
      baseUrl: BASE_URL,
      idToken: signInBody.idToken,
      deviceLabel: 'simple-10k deployed gate',
    });
    const token = exchanged.token;
    if (!token) throw new Error('the Firebase exchange returned no access token');
    console.log('[deployed-gate] auth=firebase custom token -> /api/auth/firebase/exchange (token not logged)');

    const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(30000) })
      .then((res) => res.json())
      .catch(() => null);
    console.log(`[deployed-gate] deployed commit=${health?.commit ?? 'unknown'} status=${health?.status ?? 'unknown'}`);

    const allowanceBefore = await usage();
    const freeRemaining = assertFreeAllowance(allowanceBefore, GATE_REQUESTS);
    console.log(
      `[deployed-gate] allowance before: ${freeRemaining} free requests left; ` +
        `paid usage ${allowanceBefore?.paidUsage ?? 'unknown'}`,
    );

    const rows = [];
    let abortReason = null;
    const writeArtifact = (extra = {}) =>
      writeJson(OUT, {
        generatedAt: new Date().toISOString(),
        phase: 'gate',
        partial: rows.length < GATE_REQUESTS,
        target: BASE_URL,
        config: {
          transport: 'http',
          baseUrl: BASE_URL,
          size: products.length,
          seed: 1,
          primary: 'openai/gpt-oss-20b',
          free: 'nvidia/nemotron-3.5-lightning:free',
          concurrency: 1,
          requests: GATE_REQUESTS,
          gapMs: GAP_MS,
        },
        dataset,
        deployedCommit: health?.commit ?? null,
        rows,
        summary: summarise(rows),
        ...extra,
      });
    const started = Date.now();
    for (let index = 0; index < gateQuestions.length; index += 1) {
      const question = gateQuestions[index];
      const turnStarted = Date.now();
      let result = null;
      let error = null;
      try {
        const response = await fetch(`${BASE_URL}/api/ai/chat`, {
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
          const message = (payload && (payload.error || payload.message)) || raw.slice(0, 200) || `HTTP ${response.status}`;
          const httpError = new Error(`HTTP ${response.status}: ${String(message)}`);
          httpError.code = payload?.code || 'HTTP_ERROR';
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
          degraded: payload?.degraded ?? assistant.degraded,
        };
      } catch (caught) {
        error = caught;
      }

      const totalMs = Date.now() - turnStarted;
      const answer = result?.content ?? '';
      const model = result?.model ?? null;
      const freeServed = Boolean(model && /:free$/i.test(model));
      const check = error
        ? { ok: false, reasons: [`${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}`] }
        : question.check(answer);
      if (!error) {
        const allowed =
          question.operation === 'restock_list' || question.operation === 'restock_count'
            ? SHORTAGE_READS
            : PRODUCT_STOCK_READS;
        if (!(result?.toolsUsed ?? []).some((tool) => allowed.has(tool))) {
          check.reasons.push('no required tool read in result');
        }
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
              message: error?.message ?? String(error),
            }
          : null,
        workIndex: index,
        wave: index + 1,
        sequence: index + 1,
      };
      row.costUsd = estimatedCost(row, pricing);
      rows.push(row);
      writeArtifact();

      console.log(
        `[deployed-gate] gate ${String(index + 1).padStart(2, '0')}/${GATE_REQUESTS} ` +
          `${row.check.ok ? 'OK' : 'FAIL'} ${question.id} model=${model ?? '-'} ` +
          `${totalMs}ms cost=${money(row.costUsd)}` +
          (row.check.ok ? '' : ` ${row.check.reasons.join('; ')}`),
      );

      if (error) {
        abortReason = `turn failed: ${error?.message ?? String(error)}`;
      } else if (row.degraded) {
        abortReason = `turn degraded: ${row.degraded}`;
      } else {
        try {
          assertFreeZeroCost({ model, costUsd: row.costUsd, label: question.id });
        } catch (caught) {
          abortReason = caught.message;
        }
      }
      if (!abortReason) {
        try {
          assertDatasetUnchanged(duringFingerprint, await inventoryFingerprint(businessId));
        } catch (caught) {
          abortReason = caught.message;
        }
      }
      if (abortReason) {
        const stopped = { ...row, check: { ...row.check, ok: false, reasons: [...row.check.reasons, abortReason] } };
        rows[rows.length - 1] = stopped;
        writeArtifact({ aborted: true, abortReason });
        console.error(`[deployed-gate] ABORT after ${rows.length}/${GATE_REQUESTS}: ${abortReason}`);
        break;
      }
      if (index + 1 < gateQuestions.length) await sleep(GAP_MS);
    }

    const finished = Date.now();
    const allowanceAfter = await usage();
    const summary = summarise(rows);
    summary.startedAt = new Date(started).toISOString();
    summary.finishedAt = new Date(finished).toISOString();
    summary.durationMs = finished - started;
    summary.providerPaidUsageDelta =
      finiteNumber(allowanceBefore?.paidUsage) !== null && finiteNumber(allowanceAfter?.paidUsage) !== null
        ? allowanceAfter.paidUsage - allowanceBefore.paidUsage
        : null;
    summary.freeRequestsRemainingBefore = allowanceBefore?.daily?.remaining ?? null;
    summary.freeRequestsRemainingAfter = allowanceAfter?.daily?.remaining ?? null;

    if (!abortReason) {
      try {
        assertPaidUsageUnchanged(allowanceBefore, allowanceAfter);
        if (summary.paidServed !== 0 || summary.totalCostUsd !== 0) {
          throw new Error(
            `summary is not zero-cost: paid=${summary.paidServed} cost=${money(summary.totalCostUsd)}`,
          );
        }
      } catch (caught) {
        abortReason = caught.message;
      }
    }

    await restoreOnce();
    writeArtifact({
      allowanceBefore,
      allowanceAfter,
      summary,
      aborted: Boolean(abortReason),
      abortReason: abortReason ?? null,
    });
    console.log(
      `[deployed-gate] RESULTS ${summary.accurate}/${summary.requests} accurate, ` +
        `free=${summary.freeServed}, paid=${summary.paidServed}, errors=${summary.errors}, ` +
        `degraded=${summary.degraded}, median=${Math.round(summary.medianMs ?? 0)}ms, ` +
        `p95=${Math.round(summary.p95Ms ?? 0)}ms, cost=${money(summary.totalCostUsd)}`,
    );
    console.log(`[deployed-gate] artifact: ${OUT}`);
    if (abortReason) {
      console.error(`[deployed-gate] ABORTED: ${abortReason}`);
      process.exitCode = 3;
    } else if (summary.accurate !== summary.requests || summary.errors > 0 || summary.degraded > 0) {
      process.exitCode = 1;
    }
  } finally {
    await restoreOnce().catch((error) => {
      console.error(`[deployed-gate] RESTORE FAILED: ${error?.message ?? error}`);
      console.error(`[deployed-gate] snapshot retained at ${BACKUP}`);
      process.exitCode = 2;
    });
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`[deployed-gate] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
