/**
 * AI-39 — the deployment STATES its AI configuration at boot, and the watchdog states its live
 * state on every run, so an operator can see what the assistant will actually do without reading
 * source or grepping for a promotion.
 *
 * WHY THIS EXISTS. Two silences cost real time. A fallback list longer than the five-model cap was
 * TRUNCATED with no message, so a pasted sixth id looked configured and was never used — and a
 * candidate that is silently dropped is discovered on the worst possible day. And after AI-30/31,
 * the active model is a runtime fact that existed only in one log line at the moment of promotion:
 * "is production on its configured model right now?" could not be answered from the process.
 *
 * WHAT IS PINNED HERE:
 *
 *   * `aiConfig` keeps five candidates and NAMES the ones it ignored;
 *   * a duplicate is not "ignored" — deduplication is not a mistake to warn about;
 *   * `startServer` logs the effective chain once and warns about ignored ids, without refusing;
 *   * the watchdog's per-run line carries the active and configured models, the cooling ids, and
 *     the last allowance reading;
 *   * nothing is claimed when the provider has published no allowance.
 *
 * No network and no database: the boot harness uses fakes, and the watchdog injects `readHealth`.
 */

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { startServer } from '../src/config/startup.ts';
import { createHealthWatcher, DEFAULT_THRESHOLDS } from '../src/services/ai/healthWatch.ts';
import { recordModelFailure, resetModelBreaker } from '../src/services/ai/modelBreaker.ts';
import { promoteModel, resetModelSelection } from '../src/services/ai/modelSelection.ts';
import { noteQuotaSuccess, resetQuotaState } from '../src/services/ai/quota.ts';
import { resetModelHealthGate } from '../src/services/ai/modelHealthGate.ts';

const PRIMARY = 'vendor/primary:free';
const FALLBACK = 'vendor/fallback:free';

const ENV_KEYS = ['AI_MODEL_OPENROUTER', 'AI_FALLBACK_MODELS_OPENROUTER', 'AI_PROVIDER'];

function setEnv(env) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

function fakeApp() {
  return {
    listen: (port, callback) => {
      const server = {
        listening: true,
        on: () => server,
        once: (event, handler) => {
          if (event === 'listening') setImmediate(handler);
          return server;
        },
        removeListener: () => server,
        address: () => ({ port: 0 }),
        close: (callback) => callback?.(),
      };
      setImmediate(callback);
      return server;
    },
  };
}

/** Boot the server with every outbound seam disabled, collecting its log lines. */
async function boot() {
  const lines = [];
  const logger = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const result = await startServer({
    nodeEnv: 'development',
    appInstance: fakeApp(),
    port: 0,
    connectFn: async () => true,
    validator: () => [],
    readiness: () => ({ db: 'ok', mail: 'ok', firebase: 'ok', ai: 'ok', aiProvider: 'openrouter' }),
    modelCheck: null,
    capabilities: null,
    healthGate: null,
    healthWatch: null,
    exit: () => {},
    signalTarget: { on: () => {}, listeners: () => [] },
    logger,
  });
  return { result, lines };
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetModelBreaker();
  resetModelSelection();
  resetQuotaState();
  resetModelHealthGate();
});

unitSuite('AI-39 boot configuration is stated', () => {
  it('keeps five candidates and names every one it ignored', () => {
    const restore = setEnv({
      AI_PROVIDER: 'openrouter',
      AI_MODEL_OPENROUTER: PRIMARY,
      AI_FALLBACK_MODELS_OPENROUTER: 'a,b,c,d,e,f,g',
    });
    try {
      const cfg = aiConfig();
      assert.deepEqual(cfg.fallbackModels, ['a', 'b', 'c', 'd', 'e']);
      assert.deepEqual(cfg.fallbackModelsIgnored, ['f', 'g'], 'the dropped ids are reported, not hidden');
    } finally {
      restore();
    }
  });

  it('does not treat a duplicate as an ignored model', () => {
    const restore = setEnv({
      AI_PROVIDER: 'openrouter',
      AI_MODEL_OPENROUTER: PRIMARY,
      AI_FALLBACK_MODELS_OPENROUTER: 'a,a,b',
    });
    try {
      const cfg = aiConfig();
      assert.deepEqual(cfg.fallbackModels, ['a', 'b']);
      assert.deepEqual(cfg.fallbackModelsIgnored, []);
    } finally {
      restore();
    }
  });

  it('logs the effective chain and a warning for ignored ids, without refusing to boot', async () => {
    const restore = setEnv({
      AI_PROVIDER: 'openrouter',
      AI_MODEL_OPENROUTER: PRIMARY,
      AI_FALLBACK_MODELS_OPENROUTER: `${FALLBACK},b,c,d,e,ignored-one,ignored-two`,
    });
    try {
      const { result, lines } = await boot();
      assert.ok(result, 'a configuration problem must never stop the server');

      const chain = lines.find((line) => line.includes('AI configuration'));
      assert.ok(chain, 'the order the turn loop will use is stated once at boot');
      assert.ok(chain.includes(PRIMARY));
      assert.ok(chain.indexOf(PRIMARY) < chain.indexOf(FALLBACK), 'the configured primary is first');

      const warning = lines.find((line) => line.includes('ignored'));
      assert.ok(warning, 'the truncation is warned about');
      assert.ok(warning.includes('ignored-one') && warning.includes('ignored-two'));
    } finally {
      restore();
    }
  });

  it('says nothing about a chain when no model is configured', async () => {
    const restore = setEnv({ AI_PROVIDER: undefined, AI_MODEL_OPENROUTER: undefined, AI_FALLBACK_MODELS_OPENROUTER: undefined });
    try {
      const { result, lines } = await boot();
      assert.ok(result);
      assert.equal(lines.filter((line) => line.includes('AI configuration')).length, 0);
      assert.equal(lines.filter((line) => line.includes('ignored')).length, 0);
    } finally {
      restore();
    }
  });
});

unitSuite('AI-39 live state on the watchdog line', () => {
  const ENV = {
    AI_PROVIDER: 'openrouter',
    AI_MODEL_OPENROUTER: PRIMARY,
    AI_FALLBACK_MODELS_OPENROUTER: FALLBACK,
  };

  function watcherWith(lines) {
    return createHealthWatcher({
      env: ENV,
      readHealth: async ({ model }) => ({
        status: 'ok',
        model,
        message: 'published',
        endpoints: [{ provider: 'Vendor', status: 0, uptime5m: 100, uptime30m: 100, uptime1d: 100 }],
      }),
      sendAlert: async () => 'log',
      logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
      thresholds: DEFAULT_THRESHOLDS,
    });
  }

  it('reports the active model, the cooling ids and the allowance', async () => {
    promoteModel(FALLBACK, PRIMARY);
    recordModelFailure(PRIMARY, Date.now(), { threshold: 1, cooldownMs: 60_000 });
    noteQuotaSuccess({ remaining: 12, limit: 50 });

    const lines = [];
    await watcherWith(lines).run();

    const summary = lines.find((line) => line.includes('AI watchdog checked'));
    assert.ok(summary, 'the run states what it saw');
    assert.ok(summary.includes(`active=${FALLBACK}`), 'a promotion is visible without grepping history');
    assert.ok(summary.includes(`configured=${PRIMARY}`));
    assert.ok(summary.includes(`cooling=${PRIMARY}`), 'the model in cooldown is named');
    assert.ok(summary.includes('quota=12/50'));
  });

  it('says unknown rather than inventing an allowance', async () => {
    const lines = [];
    await watcherWith(lines).run();

    const summary = lines.find((line) => line.includes('AI watchdog checked'));
    assert.ok(summary.includes('quota=unknown'));
    assert.ok(summary.includes('cooling=none'));
  });
});
