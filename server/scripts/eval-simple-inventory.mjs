// Controlled LIVE evaluation of AI-99's free-first simple inventory route.
//
// WHY THIS EXISTS. The unit suite proves the routing with a fake provider; it cannot answer
// the questions the owner actually has: does the free model answer these turns, how often
// does the paid primary have to finish one, how accurate are the answers against real
// inventory rows, what does it cost, and how long does a member wait? This harness runs the
// real `runAiChat` loop against real OpenRouter models and a DISPOSABLE tenant seeded from
// the curated demo fixture, so every expected quantity is known before the first request.
//
// WHAT IT MEASURES. Each question runs twice:
//   * `baseline`   — AI_FALLBACK_MODELS_OPENROUTER is empty, so the configured paid primary
//                    handles it exactly as it did before the free route existed.
//   * `free-first` — the configured chain is restored, so a simple question starts on the
//                    first tool-capable `:free` fallback and may escalate to the paid primary.
// Every turn records the route, final model, escalation count, provider calls, wall-clock and
// provider time, tokens, the provider's own USD charge, and whether the answer matches the
// fixture. The difference between the two phases is the measured saving for this sample.
//
// WHAT IT DOES NOT DO. It does not deploy, change `.env`, or touch a real tenant. It refuses
// any database other than the development one, seeds a disposable business, and removes it in
// `finally`. It never enables OpenRouter's paid web plugin; the questions are inventory reads.
//
// COST. The baseline deliberately spends paid-model credits for measurement, and the free
// phase spends the free daily requests. Run the pilot first:
//   AI_TEST_ALLOW_PAID_MODELS=true SIMPLE_EVAL_LIMIT=1 node scripts/eval-simple-inventory.mjs
// Then the full ten-question sample:
//   AI_TEST_ALLOW_PAID_MODELS=true node scripts/eval-simple-inventory.mjs
//
// The free-model preflight refuses a known shortfall below 24 requests unless
// SIMPLE_EVAL_FORCE=1 is set. Results are written to `.tmp-simple-inventory-live.json`
// (git-ignored by `.tmp-*`). Set SIMPLE_EVAL_OUT to keep a run separate.
//
// For a free-only reasoning-policy comparison, skip the paid baseline and set the
// advanced policy explicitly (an empty AI_REASONING_PAID_MODELS lets it apply):
//   AI_REASONING_PAID_MODELS= AI_REASONING_DEFAULT=off \
//     AI_REASONING_MODELS_OPENROUTER='openai/gpt-oss-*=auto' \
//     AI_TEST_ALLOW_PAID_MODELS=true SIMPLE_EVAL_OUT=.tmp-simple-inventory-live-off.json \
//     node scripts/eval-simple-inventory.mjs --free-only --limit=25

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
import { resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { refreshModelCapabilities, declaresToolSupport } from '../src/services/ai/modelCapabilities.ts';
import { resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { selectSimpleModel, simpleInventoryIntent } from '../src/services/ai/simpleInventory.ts';
import {
  DEMO_CATEGORIES,
  DEMO_LOCATIONS,
  DEMO_MOVEMENTS,
  DEMO_PRODUCTS,
  DEMO_STOCK,
  expectedRestock,
  expectedSummary,
  stockByProduct,
} from './demo/fixture.mjs';
import { allowanceLine, readProviderUsage, shortfall } from './ai-usage.mjs';
import { assertFreeTestingModels } from './live-test-guard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const OUT_NAME = (process.env.SIMPLE_EVAL_OUT || '.tmp-simple-inventory-live.json').replace(/^\.?\//, '');
const OUT = new URL(`../${OUT_NAME}`, import.meta.url);
const PAID_APPROVAL_ENV = 'AI_TEST_ALLOW_PAID_MODELS';
const FREE_REQUEST_BUDGET = 24;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag) {
  const hit = process.argv.find((value) => value.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise the typography a model may use without changing its meaning. */
function normalise(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    // Markdown emphasis is presentation, not a different quantity. A correct answer
    // ("**0** units on hand") was rejected only because the zero was bold (2026-11-09).
    .replace(/\*\*|__/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

/** A number in the same sentence/line as a label. Thousands separators are accepted. */
function sentenceHas(text, value, label) {
  const number = new RegExp(
    `\\b${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*')}\\b`,
    'i',
  );
  return normalise(text)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .some((part) => number.test(part) && label.test(part));
}

function stockCheck(productName, quantity) {
  return (answer) => {
    const text = normalise(answer);
    const reasons = [];
    if (quantity <= 0) {
      if (
        !/\b(?:out of stock|0 units?|zero units?|no units?|no stock|none on hand|none in stock|not in stock|not stocked|no inventory record)\b/i.test(
          text,
        )
      ) {
        reasons.push('missing an out-of-stock / zero statement');
      }
    } else if (!sentenceHas(text, quantity, /\b(?:units?|on hand|stock|quantity|available|qty)\b/i)) {
      reasons.push(`missing ${quantity} with a stock/unit label`);
    }
    return {
      ok: reasons.length === 0,
      reasons,
      named: new RegExp(escapeRegExp(productName), 'i').test(text),
    };
  };
}

function existenceCheck(present) {
  return (answer) => {
    const text = normalise(answer);
    const reasons = [];
    // A present product needs a positive statement and must not be denied. An absent one
    // needs a denial. The denial check is deliberately separate: a good answer may mention
    // a similarly named product it DOES carry (the fixture's Steam Deck / Stream Deck pair),
    // and that must not be read as a claim that the asked-for product exists. A negative
    // sentence about stock status ("No stock level is marked low") is not a denial of
    // existence; require a denial phrase, or a sentence-initial "No," for an absent item.
    const negative = present
      ? /\b(?:do not|don't|does not|doesn't|isn't|aren't|not in (?:our )?inventory|not in stock|not stocked|not carried|not available|unavailable)\b/i.test(
          text,
        )
      : /^(?:no|nope)\s*(?:[,.:;!-]|$)|\b(?:do not|don't|does not|doesn't|isn't|aren't|not in (?:our|this|the) (?:inventory|catalog(?:ue)?)|not in stock|not recorded|not part of|not stocked|not carried|not available|unavailable|no such|no (?:products?|items?|records?|matches?|matching)|(?:have|carry|stock|found)\s+no)\b/i.test(
          text,
        );
    const affirmative =
      /\b(?:yes|we (?:have|carry|stock)\b|we do (?:have|carry|stock)\b|in (?:our )?inventory\b|in stock|available|on hand)\b/i.test(text);
    if (present) {
      if (!affirmative) reasons.push('missing yes / have / in stock');
      if (negative) reasons.push('answer is negative');
    } else if (!negative) {
      reasons.push('missing no / not carried / not recorded / unavailable');
    }
    return { ok: reasons.length === 0, reasons };
  };
}

const RESTOCK_ALIASES = [
  /ROG (?:Strix )?Flare II/i,
  /Keychron K8 Pro/i,
  /MX Master 3S/i,
  /U2723QE/i,
  /Stream Deck MK\.?2/i,
];

function restockListCheck(answer) {
  const text = normalise(answer);
  const reasons = RESTOCK_ALIASES.filter((pattern) => !pattern.test(text)).map(
    (pattern) => `missing ${String(pattern)}`,
  );
  return { ok: reasons.length === 0, reasons };
}

function restockCountCheck(answer) {
  const text = normalise(answer);
  const reasons = [];
  if (!sentenceHas(text, 5, /\b(?:products?|items?|skus?)\b/i)) {
    reasons.push('missing 5 labeled as products/items');
  }
  return { ok: reasons.length === 0, reasons };
}

function parseTurnLine(line) {
  if (!line) return {};
  const field = (name) => {
    const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line);
    return match ? match[1] : null;
  };
  return {
    outcome: field('outcome'),
    total: field('total'),
    providerMs: field('providerMs'),
    calls: field('calls'),
    toolMs: field('toolMs'),
    toolRuns: field('toolRuns'),
    tools: field('tools'),
    empty: field('empty'),
    failovers: field('failovers'),
    route: field('route'),
    simpleEscalations: field('simpleEscalations'),
    quota: field('quota'),
    input: field('in'),
    output: field('out'),
    cost: field('cost'),
    model: field('model'),
    iterations: field('iterations'),
  };
}

function numeric(value) {
  const parsed = Number.parseInt(String(value ?? '').replace(/ms$/i, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCost(raw) {
  if (!raw || raw === 'unknown') return { value: null, lowerBound: false };
  const lowerBound = raw.startsWith('>');
  const amount = Number.parseFloat(raw.replace(/^>=?/, '').replace('$', ''));
  return Number.isFinite(amount) ? { value: amount, lowerBound } : { value: null, lowerBound };
}

async function fetchPricing(model, cfg) {
  const base = String(cfg.openrouterBaseUrl || 'https://openrouter.ai/api').trim().replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const row = Array.isArray(body?.data)
      ? body.data.find((entry) => entry?.id === model)
      : undefined;
    const prompt = Number(row?.pricing?.prompt);
    const completion = Number(row?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
      return { error: 'the catalogue did not publish pricing for this model' };
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

function estimateCost(inputTokens, outputTokens, pricing) {
  if (!pricing || pricing.error) return null;
  const input = Number(inputTokens);
  const output = Number(outputTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (!Number.isFinite(pricing.prompt) || !Number.isFinite(pricing.completion)) return null;
  return input * pricing.prompt + output * pricing.completion;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function money(value) {
  return value === null || value === undefined ? 'unknown' : `$${value.toFixed(6)}`;
}

function percentage(value) {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}%`;
}

function summarisePhase(phase, rows) {
  const phaseRows = rows.filter((row) => row.phase === phase);
  const answered = phaseRows.filter((row) => !row.error);
  const accurate = answered.filter((row) => row.check.ok);
  const freeServed = phaseRows.filter((row) => row.freeServed);
  const escalated = phaseRows.filter((row) => row.escalated);
  const defaultRoute = phaseRows.filter((row) => row.route === 'default');
  const errors = phaseRows.filter((row) => row.error);
  const times = answered.map((row) => row.totalMs);
  const providerTimes = answered
    .map((row) => row.providerMs)
    .filter((value) => Number.isFinite(value));
  const costs = phaseRows.map((row) => row.costUsd).filter((value) => value !== null);
  const costComplete = phaseRows.length > 0 && phaseRows.every((row) => row.costUsd !== null);
  const totalCost = costs.reduce((sum, value) => sum + value, 0);
  const inputTokens = phaseRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const outputTokens = phaseRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const calls = phaseRows.reduce((sum, row) => sum + (row.calls ?? 0), 0);
  return {
    phase,
    questions: phaseRows.length,
    answered: answered.length,
    accurate: accurate.length,
    accuracy: answered.length ? accurate.length / answered.length : null,
    freeServed: freeServed.length,
    freeServedAccurate: freeServed.filter((row) => row.check.ok).length,
    escalated: escalated.length,
    escalatedAccurate: escalated.filter((row) => row.check.ok).length,
    defaultRoute: defaultRoute.length,
    errors: errors.length,
    quotaFallForward: phaseRows.filter((row) => row.quotaFallForward).length,
    readEscalation: phaseRows.filter((row) => row.readEscalation).length,
    medianMs: median(times),
    meanMs: mean(times),
    freeMedianMs: median(freeServed.map((row) => row.totalMs)),
    providerMedianMs: median(providerTimes),
    calls,
    inputTokens,
    outputTokens,
    totalCost,
    costComplete,
    costLabel: costComplete ? money(totalCost) : `>= ${money(totalCost)}`,
  };
}

// ---------------------------------------------------------------------------
// Preflight: never spend a request on a misconfigured or unknown target.
// ---------------------------------------------------------------------------

if (env.mongodbDbName !== DATABASE_NAMES.development) {
  console.error(
    `[simple-live] refusing database ${env.mongodbDbName}; this harness only runs against ${DATABASE_NAMES.development}.`,
  );
  process.exit(2);
}

const cfg = aiConfig();
if (cfg.provider !== 'openrouter') {
  console.error(`[simple-live] AI_PROVIDER is ${cfg.provider || 'unset'}; this harness needs openrouter.`);
  process.exit(2);
}
if (!cfg.openrouterModel) {
  console.error('[simple-live] AI_MODEL_OPENROUTER is unset.');
  process.exit(2);
}
if (!(process.env.OPENROUTER_API_KEY || '').trim()) {
  console.error('[simple-live] OPENROUTER_API_KEY is unset.');
  process.exit(2);
}
if (process.env[PAID_APPROVAL_ENV] !== 'true') {
  console.error(
    `[simple-live] refusing to run: the baseline intentionally uses the paid primary. ` +
      `Set ${PAID_APPROVAL_ENV}=true only after the owner has approved this measurement.`,
  );
  process.exit(2);
}
try {
  assertFreeTestingModels();
} catch (error) {
  console.error(`[simple-live] ${error.message}`);
  process.exit(2);
}

const capabilityStatus = await refreshModelCapabilities();
const freeModel = selectSimpleModel(cfg.fallbackModels);
if (!freeModel) {
  console.error(
    '[simple-live] no configured fallback is a tool-capable `:free` model, so the simple route cannot start. ' +
      'Run `npm run ai:models` and correct AI_FALLBACK_MODELS_OPENROUTER.',
  );
  process.exit(2);
}

const allowance = await readProviderUsage({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: cfg.openrouterBaseUrl,
});
const short = shortfall(allowance, FREE_REQUEST_BUDGET);
console.log(
  `[simple-live] models: primary=${cfg.openrouterModel} free=${freeModel} research=${cfg.openrouterResearchModel || '(same as primary)'}`,
);
console.log(
  `[simple-live] capability catalogue: ${capabilityStatus}; free tools=${String(declaresToolSupport(freeModel))}`,
);
console.log(`[simple-live] allowance: ${allowanceLine(allowance)}`);
if (short && process.env.SIMPLE_EVAL_FORCE !== '1') {
  console.error(
    `[simple-live] refusing to start: ${short.remaining} of ${short.limit} free requests are left, ` +
      `below the ${short.needed}-request pilot budget. Nothing was sent to the provider. ` +
      'Re-run once the window rolls over, or set SIMPLE_EVAL_FORCE=1 deliberately.',
  );
  process.exit(2);
}
if (short) {
  console.warn(
    `[simple-live] SIMPLE_EVAL_FORCE=1: proceeding with ${short.remaining} of ${short.limit} free requests left.`,
  );
}

const paidPricing = await fetchPricing(cfg.openrouterModel, cfg);
if (paidPricing.error) {
  console.log(`[simple-live] paid pricing: unavailable (${paidPricing.error}); token counts and provider cost will still be recorded.`);
} else {
  console.log(
    `[simple-live] paid pricing: ${cfg.openrouterModel} ` +
      `$${paidPricing.promptPerMillion.toFixed(3)}/M input, $${paidPricing.completionPerMillion.toFixed(3)}/M output`,
  );
}

// ---------------------------------------------------------------------------
// Questions and exact ground truth from the disposable fixture.
// ---------------------------------------------------------------------------

const stock = stockByProduct();
const byKey = new Map(DEMO_PRODUCTS.map((product) => [product.key, product]));
const productName = (key) => byKey.get(key)?.name ?? key;
const restock = expectedRestock();
const summary = expectedSummary();

const questions = [
  {
    id: 'stock-mx-keys',
    operation: 'product_stock',
    message: `How many units of the ${productName('mx-keys-s')} are in stock?`,
    expected: `${stock.get('mx-keys-s')} units across all locations`,
    check: stockCheck(productName('mx-keys-s'), stock.get('mx-keys-s')),
  },
  {
    id: 'stock-rog-flare',
    operation: 'product_stock',
    message: `How many units of the ${productName('rog-flare-ii')} are in stock?`,
    expected: '0 units / out of stock',
    check: stockCheck(productName('rog-flare-ii'), stock.get('rog-flare-ii')),
  },
  {
    id: 'exists-keychron',
    operation: 'product_existence',
    message: `Do we have the ${productName('keychron-k8-pro')} in our inventory?`,
    expected: `yes (${stock.get('keychron-k8-pro')} units on hand)`,
    check: existenceCheck(true),
  },
  {
    id: 'exists-steam-deck',
    operation: 'product_existence',
    message: 'Do we carry the Steam Deck?',
    expected: 'no',
    check: existenceCheck(false),
  },
  {
    id: 'restock-list',
    operation: 'restock_list',
    message: 'Which products need to be restocked?',
    expected: restock.map((row) => row.name).join('; '),
    check: restockListCheck,
  },
  {
    id: 'restock-count',
    operation: 'restock_count',
    message: 'How many products need restocking?',
    expected: String(restock.length),
    check: restockCountCheck,
  },
  {
    id: 'minimum-list',
    operation: 'restock_list',
    message: 'What products have reached their minimum stock levels?',
    expected: restock.map((row) => row.name).join('; '),
    check: restockListCheck,
  },
  {
    id: 'stock-rk61',
    operation: 'product_stock',
    message: `How many units of the ${productName('royal-kludge-rk61')} are on hand?`,
    expected: `${stock.get('royal-kludge-rk61')} units`,
    check: stockCheck(productName('royal-kludge-rk61'), stock.get('royal-kludge-rk61')),
  },
  {
    id: 'exists-anker',
    operation: 'product_existence',
    message: `Do we have the ${productName('anker-737')}?`,
    expected: `yes (${stock.get('anker-737')} units on hand)`,
    check: existenceCheck(true),
  },
  {
    id: 'stock-dell',
    operation: 'product_stock',
    message: `How many units of the ${productName('dell-u2723qe')} are in stock?`,
    expected: `${stock.get('dell-u2723qe')} units`,
    check: stockCheck(productName('dell-u2723qe'), stock.get('dell-u2723qe')),
  },
  {
    id: 'stock-razer',
    operation: 'product_stock',
    message: `How many units of the ${productName('razer-blackwidow-v4-pro')} are in stock?`,
    expected: `${stock.get('razer-blackwidow-v4-pro')} units across all locations`,
    check: stockCheck(productName('razer-blackwidow-v4-pro'), stock.get('razer-blackwidow-v4-pro')),
  },
  {
    id: 'stock-sony',
    operation: 'product_stock',
    message: `How many units of the ${productName('sony-wh-1000xm5')} are in stock?`,
    expected: `${stock.get('sony-wh-1000xm5')} units across all locations`,
    check: stockCheck(productName('sony-wh-1000xm5'), stock.get('sony-wh-1000xm5')),
  },
  {
    id: 'stock-arctis',
    operation: 'product_stock',
    message: `How many units of the ${productName('arctis-nova-7')} are in stock?`,
    expected: `${stock.get('arctis-nova-7')} units across all locations`,
    check: stockCheck(productName('arctis-nova-7'), stock.get('arctis-nova-7')),
  },
  {
    id: 'stock-lg',
    operation: 'product_stock',
    message: `How many units of the ${productName('lg-27gp850-b')} are in stock?`,
    expected: `${stock.get('lg-27gp850-b')} units`,
    check: stockCheck(productName('lg-27gp850-b'), stock.get('lg-27gp850-b')),
  },
  {
    id: 'stock-samsung',
    operation: 'product_stock',
    message: `How many units of the ${productName('samsung-t7-shield')} are in stock?`,
    expected: `${stock.get('samsung-t7-shield')} units across all locations`,
    check: stockCheck(productName('samsung-t7-shield'), stock.get('samsung-t7-shield')),
  },
  {
    id: 'stock-c920',
    operation: 'product_stock',
    message: `How many units of the ${productName('logitech-c920s')} are in stock?`,
    expected: `${stock.get('logitech-c920s')} units`,
    check: stockCheck(productName('logitech-c920s'), stock.get('logitech-c920s')),
  },
  {
    id: 'stock-stream-deck',
    operation: 'product_stock',
    message: `How many units of the ${productName('elgato-stream-deck-mk2')} are in stock?`,
    expected: `${stock.get('elgato-stream-deck-mk2')} units`,
    check: stockCheck(productName('elgato-stream-deck-mk2'), stock.get('elgato-stream-deck-mk2')),
  },
  {
    id: 'stock-mx-master',
    operation: 'product_stock',
    message: `How many units of the ${productName('mx-master-3s')} are in stock?`,
    expected: `${stock.get('mx-master-3s')} units across all locations`,
    check: stockCheck(productName('mx-master-3s'), stock.get('mx-master-3s')),
  },
  {
    id: 'exists-lg',
    operation: 'product_existence',
    message: `Do we have the ${productName('lg-27gp850-b')} in our inventory?`,
    expected: `yes (${stock.get('lg-27gp850-b')} units on hand)`,
    check: existenceCheck(true),
  },
  {
    id: 'exists-stream-deck',
    operation: 'product_existence',
    message: `Do we have the ${productName('elgato-stream-deck-mk2')}?`,
    expected: `yes (${stock.get('elgato-stream-deck-mk2')} units on hand)`,
    check: existenceCheck(true),
  },
  {
    id: 'exists-sony-xm4',
    operation: 'product_existence',
    message: 'Do we have the Sony WH-1000XM4?',
    expected: 'no (the fixture carries the XM5, not the XM4)',
    check: existenceCheck(false),
  },
  {
    id: 'exists-ultrafine',
    operation: 'product_existence',
    message: 'Do we carry the LG UltraFine 5K?',
    expected: 'no',
    check: existenceCheck(false),
  },
  {
    id: 'restock-below-list',
    operation: 'restock_list',
    message: 'Which products are at or below their minimum stock?',
    expected: restock.map((row) => row.name).join('; '),
    check: restockListCheck,
  },
  {
    id: 'restock-below-count',
    operation: 'restock_count',
    message: 'How many items are below their minimum stock?',
    expected: String(restock.length),
    check: restockCountCheck,
  },
  {
    id: 'restock-reorder-list',
    operation: 'restock_list',
    message: 'List the products that need to be reordered.',
    expected: restock.map((row) => row.name).join('; '),
    check: restockListCheck,
  },
];

for (const question of questions) {
  const intent = simpleInventoryIntent(question.message);
  if (!intent || intent.operation !== question.operation) {
    throw new Error(
      `[simple-live] ${question.id} no longer classifies as ${question.operation}: ${JSON.stringify(intent)}`,
    );
  }
  question.classifiedAs = intent.operation;
}

if (process.argv.includes('--validate-only')) {
  console.log(`[simple-live] ${questions.length} questions classify; no provider call was made.`);
  process.exit(0);
}

const requestedLimit = Number.parseInt(argValue('--limit') ?? process.env.SIMPLE_EVAL_LIMIT ?? '', 10);
const selected =
  Number.isInteger(requestedLimit) && requestedLimit > 0
    ? questions.slice(0, requestedLimit)
    : questions;
if (selected.length === 0) throw new Error('[simple-live] no questions selected');
const freeOnly = process.argv.includes('--free-only') || process.env.SIMPLE_EVAL_FREE_ONLY === '1';

// ---------------------------------------------------------------------------
// Disposable tenant. Same seed as the existing stress evaluator, no real data.
// ---------------------------------------------------------------------------

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

async function runTurn(question, phase, { business, user, pricing }) {
  resetModelBreaker();
  resetModelSelection();

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
  const answer = result?.content ?? '';
  const check = error
    ? { ok: false, reasons: [`${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`] }
    : question.check(answer);
  const model = metrics.model || result?.model || null;
  const route = metrics.route ?? null;
  const escalations = numeric(metrics.simpleEscalations) ?? 0;
  const routeCalls = numeric(metrics.calls) ?? 0;
  const freeServed = route === 'simple' && Boolean(model && /:free$/i.test(model));
  const escalated = route === 'simple' && escalations > 0;
  const providerCost = parseCost(metrics.cost);
  const inputTokens = numeric(metrics.input) ?? result?.usage?.inputTokens ?? 0;
  const outputTokens = numeric(metrics.output) ?? result?.usage?.outputTokens ?? 0;
  let costUsd = providerCost.value;
  let costSource = costUsd !== null ? 'provider' : 'unknown';
  if (costUsd === null && phase === 'free-first' && freeServed) {
    // A free endpoint's charge is zero even when the gateway omits usage.cost. Do not price
    // it with the paid model's catalogue rates: that would turn the saving into a cost.
    costUsd = 0;
    costSource = 'free';
  } else if (costUsd === null) {
    const estimated = estimateCost(inputTokens, outputTokens, pricing);
    if (estimated !== null) {
      costUsd = estimated;
      costSource = 'estimated';
    }
  }

  return {
    phase,
    id: question.id,
    operation: question.operation,
    message: question.message,
    expected: question.expected,
    error: error
      ? {
          name: error?.constructor?.name ?? 'Error',
          code: error?.code ?? null,
          message: error?.message ?? String(error),
        }
      : null,
    answer,
    check,
    route,
    model,
    freeServed,
    escalated,
    simpleEscalations: escalations,
    calls: routeCalls,
    totalMs,
    providerMs: numeric(metrics.providerMs),
    toolMs: numeric(metrics.toolMs),
    toolRuns: numeric(metrics.toolRuns),
    iterations: numeric(metrics.iterations),
    tools: metrics.tools && metrics.tools !== 'none' ? metrics.tools.split(',') : result?.toolsUsed ?? [],
    inputTokens,
    outputTokens,
    quota: metrics.quota,
    costUsd,
    costSource,
    costLowerBound: providerCost.lowerBound,
    quotaFallForward: lines.some((line) => line.includes('refused by quota')),
    readEscalation: lines.some((line) => line.includes('escalating to the paid primary')),
    turnLine,
    routeWarnings: lines.filter((line) => line.startsWith('AI simple route')),
  };
}

await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
const rows = [];
let exitCode = 0;
try {
  const business = await Business.create({
    name: `AI simple live evaluation ${new Date().toISOString()}`,
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
        reference: `SIMPLE-${row.product}-${row.daysAgo}`,
        userId,
        createdAt: when,
        updatedAt: when,
      };
    }),
  );

  const written = {
    products: await Product.countDocuments({ businessId }),
    inventory: await Inventory.countDocuments({ businessId }),
    movements: await InventoryTransaction.countDocuments({ businessId }),
  };
  const units = await Inventory.aggregate([
    { $match: { businessId } },
    { $group: { _id: null, total: { $sum: '$quantity' } } },
  ]);
  if (
    written.products !== summary.totalProducts ||
    written.inventory !== DEMO_STOCK.length ||
    written.movements !== DEMO_MOVEMENTS.length ||
    (units[0]?.total ?? 0) !== summary.totalInventoryQuantity
  ) {
    throw new Error(
      `[simple-live] seeded data did not verify: ${JSON.stringify({ written, units: units[0]?.total })}`,
    );
  }
  console.log(
    `[simple-live] seeded ${written.products} products, ${written.inventory} stock rows, ` +
      `${written.movements} movements, ${units[0].total} units; low=${summary.lowStockProducts}, out=${summary.outOfStockProducts}`,
  );

  if (!freeOnly) {
    const originalFallbacks = process.env.AI_FALLBACK_MODELS_OPENROUTER;
    try {
      console.log(`[simple-live] phase 1/2: paid-only baseline (${selected.length} questions)`);
      process.env.AI_FALLBACK_MODELS_OPENROUTER = '';
      for (const question of selected) {
        const row = await runTurn(question, 'baseline', {
          business: businessId,
          user: userId,
          pricing: paidPricing,
        });
        rows.push(row);
        console.log(
          `[simple-live] baseline ${row.id} route=${row.route} model=${row.model} ` +
            `calls=${row.calls} ${row.totalMs}ms cost=${money(row.costUsd)} ` +
            `${row.check.ok ? 'OK' : `FAIL ${row.check.reasons.join('; ')}`}`,
        );
        await sleep(2000);
      }
    } finally {
      if (originalFallbacks === undefined) delete process.env.AI_FALLBACK_MODELS_OPENROUTER;
      else process.env.AI_FALLBACK_MODELS_OPENROUTER = originalFallbacks;
    }
  } else {
    console.log('[simple-live] baseline skipped (--free-only)');
  }

  console.log(
    `[simple-live] phase ${freeOnly ? '1/1' : '2/2'}: free-first route (${selected.length} questions)`,
  );
  for (const question of selected) {
    const row = await runTurn(question, 'free-first', {
      business: businessId,
      user: userId,
      pricing: paidPricing,
    });
    rows.push(row);
    const status = row.check.ok
      ? 'OK'
      : `FAIL ${row.check.reasons.join('; ')} answer=${JSON.stringify(row.answer)}`;
    console.log(
      `[simple-live] free ${row.id} route=${row.route} model=${row.model} ` +
        `escalations=${row.simpleEscalations} calls=${row.calls} ${row.totalMs}ms ` +
        `cost=${money(row.costUsd)} ${status}`,
    );
    await sleep(Math.max(3500, (row.calls || 1) * 3500));
  }

  const baseline = freeOnly ? null : summarisePhase('baseline', rows);
  const freeFirst = summarisePhase('free-first', rows);
  const savings =
    baseline && baseline.totalCost !== null && freeFirst.totalCost !== null
      ? baseline.totalCost - freeFirst.totalCost
      : null;
  const savingsPct =
    savings !== null && baseline.totalCost > 0 ? (savings / baseline.totalCost) * 100 : null;
  const costComplete = (baseline ? baseline.costComplete : true) && freeFirst.costComplete;

  console.log('\n[simple-live] RESULTS');
  if (baseline) {
    console.log(
      `[simple-live] baseline: ${baseline.accurate}/${baseline.answered} accurate, ` +
        `median ${Math.round(baseline.medianMs ?? 0)}ms, cost ${baseline.costLabel}`,
    );
  } else {
    console.log('[simple-live] baseline: skipped (--free-only)');
  }
  console.log(
    `[simple-live] free-first: ${freeFirst.accurate}/${freeFirst.answered} accurate, ` +
      `free-served ${freeFirst.freeServed}/${freeFirst.questions}, escalated ${freeFirst.escalated}, ` +
      `default ${freeFirst.defaultRoute}, errors ${freeFirst.errors}, ` +
      `median ${Math.round(freeFirst.medianMs ?? 0)}ms, cost ${freeFirst.costLabel}`,
  );
  console.log(
    `[simple-live] savings: ${savings === null ? 'unknown' : money(savings)} ` +
      `(${percentage(savingsPct)}) across ${selected.length} questions` +
      (costComplete ? '' : ' — partial, at least one turn reported no cost'),
  );
  console.log(
    `[simple-live] free-model accuracy: ${freeFirst.freeServedAccurate}/${freeFirst.freeServed}; ` +
      `escalation causes: quota=${freeFirst.quotaFallForward}, read=${freeFirst.readEscalation}`,
  );

  for (const row of rows) {
    console.log(
      `[simple-live] ${row.phase.padEnd(10)} ${row.id.padEnd(20)} ` +
        `route=${String(row.route ?? '-').padEnd(8)} model=${String(row.model ?? '-').padEnd(44)} ` +
        `esc=${row.simpleEscalations} calls=${row.calls} ${row.totalMs}ms ` +
        `cost=${money(row.costUsd)} ${row.check.ok ? 'OK' : `FAIL: ${row.check.reasons.join('; ')}`}`,
    );
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    sample: selected.length,
    environment: {
      primary: cfg.openrouterModel,
      free: freeModel,
      research: cfg.openrouterResearchModel || null,
      reasoning: {
        AI_REASONING_PAID_MODELS: process.env.AI_REASONING_PAID_MODELS ?? null,
        AI_REASONING_DEFAULT: process.env.AI_REASONING_DEFAULT ?? null,
        AI_REASONING_MODELS_OPENROUTER: process.env.AI_REASONING_MODELS_OPENROUTER ?? null,
        settings: cfg.reasoning,
      },
      capabilityStatus,
      freeToolSupport: declaresToolSupport(freeModel),
      allowance,
      paidPricing,
    },
    baseline,
    freeFirst,
    savings,
    savingsPct,
    costComplete,
    rows,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`[simple-live] artifact: ${OUT.pathname}`);

  if (freeFirst.errors > 0 || freeFirst.defaultRoute > 0) exitCode = 1;
  if (freeFirst.accurate < freeFirst.answered) exitCode = 1;
  if (freeFirst.freeServed === 0) exitCode = 1;
  if (baseline && baseline.errors > 0) exitCode = 1;
  if (baseline && baseline.accurate < baseline.answered) {
    console.warn('[simple-live] the paid baseline itself was inaccurate; compare accuracy with care.');
  }
} finally {
  try {
    await cleanup();
    console.log('[simple-live] disposable tenant removed');
  } finally {
    await mongoose.disconnect();
  }
}

process.exitCode = exitCode;
