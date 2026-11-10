/**
 * AI-28 — the configured model is checked, not assumed.
 *
 * THE INCIDENT THIS EXISTS FOR (2026-10-21). Every assistant turn began failing with
 * `502 AI_UNAVAILABLE` — *"The AI service is temporarily unavailable. Please try again in a
 * moment."* — and the server log could not say which model had failed:
 *
 *   [ai:openrouter] upstream HTTP 404
 *   bodyPrefix="… not_found_error … Function '<uuid>': Not found for account '<uuid>' … provider_name":"Nvidia" …"
 *   [ai] turn outcome=AI_UNAVAILABLE … calls=1 … model=unknown iterations=1
 *
 * Direct measurement showed the model ID was still listed by the gateway while its upstream
 * refused every call, and that a different free model answered the same request with a tool use.
 * So two things were missing, and both are fixed here rather than only in the deployment:
 *
 *   1. A MODEL MISMATCH IS DETECTABLE BEFORE A MEMBER MEETS IT. `checkModelCatalogue` asks the
 *      provider's own model list whether the configured id exists (no completion, so no quota is
 *      spent); `probeModel` goes further on demand (`npm run ai:check --probe`) and proves the
 *      model really answers tool-shaped requests.
 *   2. A FAILING TURN NAMES THE MODEL. `model=unknown` was the line's most useless field at the
 *      one moment it mattered.
 *
 * WHAT THIS FILE PINS, and why each case is worth a test rather than a comment:
 *
 *   * a listed model is `ok`; an absent one is `missing` **and the message names it**, because
 *     "not found" without the id sends an operator back to the environment file to guess;
 *   * a catalogue that cannot be reached is `unreachable`, never an exception — a boot check that
 *     can crash a deployment is worse than no check;
 *   * nothing is checked when AI is not configured, so a deployment without AI does not contact
 *     the provider at boot;
 *   * the provider key never appears in a result, because these results are logged;
 *   * the probe distinguishes **unusable** from **quota** — a 429 says nothing about the model,
 *     so reporting it as a bad model would send the operator to change a working configuration;
 *   * the probe spends exactly one request and sends the configured model;
 *   * the boot check is a WARNING and only for a missing model — never fatal, and silent when the
 *     check itself could not run.
 *
 * No network is used: every case injects its own `fetchImpl`.
 */

import { it, describe } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { startServer } from '../src/config/startup.ts';
import { aiConfig } from '../src/services/ai/aiConfig.ts';
import { checkModelCatalogue, probeModel } from '../src/services/ai/modelCheck.ts';

const MODEL = 'vendor/model-one:free';
const BASE = 'https://openrouter.example/api';
const KEY = 'sk-or-v1-super-secret-value'; // secret-guard:allow — a deliberate non-working fixture

/** The environment a configured OpenRouter deployment has. */
const env = (over = {}) => ({
  AI_PROVIDER: 'openrouter',
  OPENROUTER_API_KEY: KEY,
  OPENROUTER_BASE_URL: BASE,
  AI_MODEL_OPENROUTER: MODEL,
  ...over,
});

/** Apply model settings for one test and restore the ambient environment afterwards. */
function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A catalogue response listing `ids`. */
function catalogue(ids, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
}

/** A probe response carrying the given Anthropic content blocks. */
function probeResponse(blocks, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ content: blocks }),
    text: async () => JSON.stringify({ content: blocks }),
  });
}

unitSuite('AI-28 model configuration check (DB-free)', () => {
  describe('checkModelCatalogue — is the configured id one the provider lists?', () => {
    it('★ accepts a listed model and names it', async () => {
      const result = await checkModelCatalogue({
        env: env(),
        fetchImpl: catalogue(['other/model', MODEL]),
      });

      assert.equal(result.status, 'ok');
      assert.equal(result.model, MODEL);
    });

    it('★ reports a model the catalogue does NOT list, naming it in the message', async () => {
      const result = await checkModelCatalogue({
        env: env(),
        fetchImpl: catalogue(['other/model', 'another/model']),
      });

      assert.equal(result.status, 'missing');
      assert.equal(result.model, MODEL);
      // The id, not merely the fact: an operator can only fix what they can see.
      assert.match(result.message, new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('★ treats an unreachable catalogue as NOT VERIFIED rather than throwing', async () => {
      // A boot check that can crash a deployment is worse than no check.
      const result = await checkModelCatalogue({
        env: env(),
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      });

      assert.equal(result.status, 'unreachable');
      // The upstream message is not relayed: it is not this layer's to display, and a network
      // error can carry a hostname an operator did not intend to publish.
      assert.ok(!result.message.includes('ENOTFOUND'));
    });

    it('★ does nothing at all when the provider is not configured', async () => {
      let called = false;
      const result = await checkModelCatalogue({
        env: {},
        fetchImpl: async () => {
          called = true;
          throw new Error('must not be consulted');
        },
      });

      assert.equal(result.status, 'not_applicable');
      assert.equal(called, false, 'a deployment without AI must not contact a provider at boot');
    });

    it('asks the provider\'s own model list, with the key in the header only', async () => {
      let seenUrl = null;
      let seenKey = null;
      const result = await checkModelCatalogue({
        env: env(),
        fetchImpl: async (url, init) => {
          seenUrl = String(url);
          seenKey = init?.headers?.authorization;
          return { ok: true, status: 200, json: async () => ({ data: [{ id: MODEL }] }) };
        },
      });

      assert.equal(seenUrl, `${BASE}/v1/models`);
      assert.equal(seenKey, `Bearer ${KEY}`);
      // THE RESULT IS LOGGED, SO IT MAY NOT CARRY THE CREDENTIAL.
      assert.ok(!JSON.stringify(result).includes(KEY));
    });

    it('refuses to check a provider it does not know how to ask', async () => {
      const result = await checkModelCatalogue({
        env: env({ AI_PROVIDER: 'fake' }),
        fetchImpl: async () => {
          throw new Error('must not be consulted');
        },
      });

      assert.equal(result.status, 'not_applicable');
    });
  });

  describe('probeModel — does the model actually answer, with tools?', () => {
    it('★ reports a model that answers with a tool call as usable', async () => {
      const result = await probeModel({
        env: env(),
        fetchImpl: probeResponse([{ type: 'tool_use', id: 'tool-1', name: 'getInventorySummary' }]),
      });

      assert.equal(result.status, 'usable');
      assert.equal(result.model, MODEL);
    });

    it('★ treats a 200 with only prose as usable too — an answer is an answer', async () => {
      const result = await probeModel({
        env: env(),
        fetchImpl: probeResponse([{ type: 'text', text: 'I would call the summary tool.' }]),
      });

      assert.equal(result.status, 'usable');
    });

    it('★ names the model when the upstream refuses it, and says why in one word', async () => {
      const result = await probeModel({
        env: env(),
        fetchImpl: probeResponse([{ type: 'error' }], { status: 404 }),
      });

      assert.equal(result.status, 'unusable');
      assert.equal(result.model, MODEL);
    });

    it('★ does NOT call a spent allowance a broken model', async () => {
      // A 429 says nothing about the id: changing the model would be the wrong remedy, and this
      // is exactly the reading that would send an operator to do it.
      const result = await probeModel({
        env: env(),
        fetchImpl: probeResponse([{ type: 'error' }], { status: 429 }),
      });

      assert.equal(result.status, 'quota');
    });

    it('sends the CONFIGURED model, in the Anthropic shape the app uses, exactly once', async () => {
      let calls = 0;
      let body = null;
      let url = null;
      await probeModel({
        env: env(),
        fetchImpl: async (seenUrl, init) => {
          calls += 1;
          url = String(seenUrl);
          body = JSON.parse(init.body);
          return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
        },
      });

      assert.equal(calls, 1, 'a probe costs one request, because requests are the scarce resource');
      assert.equal(url, `${BASE}/v1/messages`);
      assert.equal(body.model, MODEL);
      assert.ok(Array.isArray(body.tools) && body.tools.length === 1, 'tools are what the app needs');
    });

    it('reports an unreachable provider as unreachable, never as an unusable model', async () => {
      const result = await probeModel({
        env: env(),
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
      });

      assert.equal(result.status, 'unreachable');
    });

    it('is not applicable when there is nothing configured to probe', async () => {
      const result = await probeModel({ env: {}, fetchImpl: probeResponse([{ type: 'text', text: 'x' }]) });
      assert.equal(result.status, 'not_applicable');
    });
  });

  describe('AI-85 switching the assistant model from .env', () => {
    const PAID = 'openai/gpt-oss-120b';
    const FREE = 'nvidia/nemotron-3.5-lightning:free';
    const FREE_ALT = 'nvidia/nemotron-3-ultra-550b-a55b:free';

    it('★ reads the paid primary and its explicit fallback chain from the environment', () => {
      const restore = withEnv({
        AI_MODEL_OPENROUTER: PAID,
        AI_FALLBACK_MODELS_OPENROUTER: `${FREE}, ${FREE_ALT}`,
      });
      try {
        const cfg = aiConfig();
        assert.equal(cfg.openrouterModel, PAID);
        assert.deepEqual(cfg.fallbackModels, [FREE, FREE_ALT]);
      } finally {
        restore();
      }
    });

    it('★ a free configuration contains no implicit paid model', () => {
      const restore = withEnv({
        AI_MODEL_OPENROUTER: FREE,
        AI_FALLBACK_MODELS_OPENROUTER: FREE_ALT,
      });
      try {
        const cfg = aiConfig();
        const chain = [cfg.openrouterModel, ...cfg.fallbackModels];
        assert.deepEqual(chain, [FREE, FREE_ALT]);
        assert.ok(chain.every((id) => id.endsWith(':free')), 'no paid id is added implicitly');
      } finally {
        restore();
      }
    });

    it('★ sends whichever selected model is configured, with tools, for both paid and free', async () => {
      for (const model of [PAID, FREE]) {
        let body = null;
        const result = await probeModel({
          env: env({ AI_MODEL_OPENROUTER: model }),
          fetchImpl: async (_url, init) => {
            body = JSON.parse(init.body);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                content: [{ type: 'tool_use', id: 'tool-1', name: 'getInventorySummary' }],
              }),
            };
          },
        });

        assert.equal(result.status, 'usable');
        assert.equal(body.model, model);
        assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'the selected model gets the tool catalog');
      }
    });
  });

  describe('the boot check', () => {
    /** A minimal app so `listen` is real but nothing else is. */
    const app = () => ({ listen: (port, cb) => {
      const server = {
        listening: true,
        on: () => server,
        once: (event, handler) => {
          if (event === 'listening') setImmediate(handler);
          return server;
        },
        address: () => ({ port: 0 }),
        close: () => {},
      };
      setImmediate(cb);
      return server;
    } });

    const boot = async (modelCheck, lines = []) =>
      startServer({
        nodeEnv: 'development',
        appInstance: app(),
        port: 0,
        connectFn: async () => true,
        validator: () => [],
        readiness: () => ({ db: 'ok', mail: 'ok', firebase: 'ok', ai: 'ok' }),
        modelCheck,
        logger: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
      });

    it('★ warns, once, when the configured model is not listed', async () => {
      const lines = [];
      await boot(async () => ({ status: 'missing', model: MODEL, message: `model ${MODEL} is not listed` }), lines);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // AI-100's boot line names `free-model reasoning`; match the check's own warning text,
      // not every line that happens to contain the word "model".
      const warnings = lines.filter((line) => line.includes('is not listed'));
      assert.equal(warnings.length, 1, `expected exactly one warning, got:\n${lines.join('\n')}`);
      assert.match(warnings[0], new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('★ says nothing when the model is fine, and nothing when the check could not run', async () => {
      for (const status of ['ok', 'unreachable', 'not_applicable']) {
        const lines = [];
        await boot(async () => ({ status, model: MODEL, message: 'irrelevant' }), lines);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          lines.filter((line) => line.includes('is not listed')).length,
          0,
          `model-check status ${status} must be silent, got:\n${lines.join('\n')}`
        );
      }
    });

    it('★ a check that throws cannot stop the server from booting', async () => {
      const lines = [];
      const result = await boot(async () => {
        throw new Error('check exploded');
      }, lines);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(result && result.server, 'the server is up regardless');
    });
  });
});
