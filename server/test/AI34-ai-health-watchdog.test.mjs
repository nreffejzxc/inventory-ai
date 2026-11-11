/**
 * AI-34 — the scheduled model-health watchdog.
 *
 * WHY THIS EXISTS. AI-28 made a dead model visible when an operator asked; AI-29/30/31 made
 * a turn survive one. None of them noticed anything while nobody was asking. The deployment
 * therefore learned about an outage from a member, which is the worst possible detector.
 *
 * This watchdog asks the provider's own endpoint-health API on a schedule. That read is a
 * `GET /v1/models/{author}/{slug}/endpoints`: no completion, so no request is taken from the
 * free tier's allowance. It alerts on a CHANGE, not on every run, so a model that stays down
 * for an hour produces one message rather than twelve, and it reports the recovery.
 *
 * WHAT IS PINNED HERE:
 *
 *   * a healthy endpoint is ok; a current non-zero status is degraded or unavailable;
 *   * 5-minute and 30-minute uptime below their thresholds is degraded before the status
 *     turns, which is the "deteriorating" half of the requirement;
 *   * `unreachable` is unknown, never "the model is down" — the check could not run;
 *   * one alert per state change, no repeat while the state is unchanged;
 *   * a recovery is reported once, including after an unknown-state alert;
 *   * an unknown reading does not clear a known problem;
 *   * the configured primary and ordered fallbacks are what is checked;
 *   * every request is a GET, and the API key never reaches an alert;
 *   * the scheduler runs on its interval and stops cleanly;
 *   * an alert is emailed through the existing mail boundary, with a log fallback.
 *
 * No network is used: every case injects its own `readHealth` or `fetchImpl`.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import {
  DEFAULT_THRESHOLDS,
  classifyModelHealth,
  configuredModels,
  createHealthWatcher,
  healthWatchEnabled,
  startAiHealthWatch,
} from '../src/services/ai/healthWatch.ts';
import { startServer } from '../src/config/startup.ts';
import { operationalAlertEmail } from '../src/services/mail/templates/operationalAlert.ts';
import {
  registerFakeMailProvider,
  deregisterFakeMailProvider,
  setFakeMailScenario,
  sentMessages,
  clearSentMessages,
  fakeMailSuccess,
} from './fakes/mailProvider.mjs';

const PRIMARY = 'vendor/primary:free';
const FALLBACK = 'vendor/fallback:free';
const SECOND_FALLBACK = 'vendor/second:free';
const API_KEY = 'sk-or-v1-watchdog-secret-that-must-not-leak'; // secret-guard:allow — a deliberate non-working fixture

const ENV = {
  AI_PROVIDER: 'openrouter',
  OPENROUTER_API_KEY: API_KEY,
  OPENROUTER_BASE_URL: 'https://openrouter.example/api',
  AI_MODEL_OPENROUTER: PRIMARY,
  AI_FALLBACK_MODELS_OPENROUTER: `${FALLBACK}, ${SECOND_FALLBACK}`,
};

/** One endpoint row, in the shape `readModelHealth` returns. */
function endpoint(over = {}) {
  return {
    provider: 'Vendor',
    status: 0,
    uptime5m: 100,
    uptime30m: 100,
    uptime1d: 100,
    ...over,
  };
}

/** A successful `readModelHealth` result. */
function health(over = {}) {
  return {
    status: 'ok',
    model: PRIMARY,
    message: 'the provider published endpoint health',
    endpoints: [endpoint()],
    ...over,
  };
}

function verdictFor(result, thresholds = DEFAULT_THRESHOLDS) {
  return classifyModelHealth({
    model: PRIMARY,
    role: 'primary',
    health: result,
    thresholds,
  });
}

/** A fetch that answers every endpoint read with the same endpoint list. */
function fetchEndpoints(endpoints = [endpoint()], { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: { endpoints } }),
    };
  };
  return { impl, calls };
}

/** Runs a watcher over a sequence of results per model. */
function sequenceWatcher(sequence, options = {}) {
  const alerts = [];
  const positions = new Map();
  const readHealth = async ({ model }) => {
    // Every unlisted model is healthy: the tests below are about one model's transitions,
    // not about the fallbacks having their own scripted history.
    const values = sequence[model] ?? sequence.default ?? [health()];
    const index = positions.get(model) ?? 0;
    positions.set(model, index + 1);
    const value = values[Math.min(index, values.length - 1)];
    if (typeof value === 'function') return value();
    return value;
  };
  const watcher = createHealthWatcher({
    env: ENV,
    readHealth,
    sendAlert: async (alert) => {
      alerts.push(alert);
      return 'log';
    },
    logger: { log() {}, error() {} },
    now: () => Date.UTC(2026, 9, 21, 12, 0, 0),
    ...options,
  });
  return { watcher, alerts };
}

unitSuite('AI-34 model-health watchdog (DB-free)', () => {
  describe('classifying one model', () => {
    it('★ calls a currently healthy endpoint ok', () => {
      const verdict = verdictFor(health());
      assert.equal(verdict.level, 'ok');
      assert.equal(verdict.role, 'primary');
      assert.match(verdict.reason, /healthy|status 0/i);
    });

    it('★ degrades on a falling 5-minute uptime before the status changes', () => {
      const verdict = verdictFor(
        health({ endpoints: [endpoint({ status: 0, uptime5m: 72, uptime30m: 99 })] }),
      );
      assert.equal(verdict.level, 'degraded');
      assert.match(verdict.reason, /5m|5-minute|uptime/i);
    });

    it('★ degrades on a falling 30-minute uptime', () => {
      const verdict = verdictFor(
        health({ endpoints: [endpoint({ status: 0, uptime5m: 100, uptime30m: 90 })] }),
      );
      assert.equal(verdict.level, 'degraded');
      assert.match(verdict.reason, /30m|30-minute|uptime/i);
    });

    it('★ degrades when one of several endpoints is currently down', () => {
      const verdict = verdictFor(
        health({
          endpoints: [endpoint({ status: 0 }), endpoint({ provider: 'Backup', status: -5, uptime5m: 0 })],
        }),
      );
      assert.equal(verdict.level, 'degraded');
      assert.match(verdict.reason, /backup|endpoint|status/i);
    });

    it('★ is unavailable when no endpoint currently reports status 0 and no uptime is measurable', () => {
      const verdict = verdictFor(
        health({ endpoints: [endpoint({ status: -5, uptime5m: 0, uptime30m: 0 })] }),
      );
      assert.equal(verdict.level, 'unavailable');
      assert.match(verdict.reason, /status 0|no endpoint|uptime/i);
    });

    it('★ calls a negative status with live uptime degraded, not unavailable', () => {
      // Measured 2026-10-21: the provider published status -2 with 100% 5-minute uptime for a
      // model that was still serving. A watchdog that called this unavailable would send an
      // operator to replace a working model; the truthful reading is "degraded but serving".
      const verdict = verdictFor(
        health({ endpoints: [endpoint({ status: -2, uptime5m: 100, uptime30m: 96.7 })] }),
      );
      assert.equal(verdict.level, 'degraded');
      assert.match(verdict.reason, /still|uptime|status 0/i);
    });

    it('★ treats a model the provider does not publish as unavailable', () => {
      const verdict = verdictFor(
        health({ status: 'not_found', endpoints: [], message: 'the provider does not publish endpoint health' }),
      );
      assert.equal(verdict.level, 'unavailable');
    });

    it('★ treats an unreadable health record as unknown, not as a model outage', () => {
      for (const status of ['unreachable', 'not_applicable']) {
        const verdict = verdictFor(health({ status, endpoints: [], message: 'could not read' }));
        assert.equal(verdict.level, 'unknown', status);
      }
    });

    it('★ ignores a missing uptime field rather than inventing a failure', () => {
      const verdict = verdictFor(
        health({ endpoints: [endpoint({ status: 0, uptime5m: null, uptime30m: null })] }),
      );
      assert.equal(verdict.level, 'ok');
    });
  });

  describe('which models are watched', () => {
    it('★ watches the configured primary first, then the ordered fallbacks', () => {
      assert.deepEqual(
        configuredModels(ENV).map((entry) => [entry.model, entry.role]),
        [
          [PRIMARY, 'primary'],
          [FALLBACK, 'fallback'],
          [SECOND_FALLBACK, 'fallback'],
        ],
      );
    });

    it('★ does not watch the primary twice when it is repeated in the fallback list', () => {
      const models = configuredModels({
        ...ENV,
        AI_FALLBACK_MODELS_OPENROUTER: `${PRIMARY},${FALLBACK},${FALLBACK}`,
      });
      assert.deepEqual(models.map((entry) => entry.model), [PRIMARY, FALLBACK]);
      assert.equal(models.filter((entry) => entry.role === 'primary').length, 1);
    });

    it('★ watches nothing when no model is configured', () => {
      assert.deepEqual(configuredModels({ AI_PROVIDER: 'openrouter' }), []);
    });
  });

  describe('alerting on change, not on every check', () => {
    it('★ alerts once when a model is unavailable, and not again while it stays down', async () => {
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [down, down, down] });

      const first = await watcher.run();
      const second = await watcher.run();
      const third = await watcher.run();

      assert.equal(alerts.length, 1, 'one alert for one state change');
      assert.equal(first.changes.length, 1);
      assert.equal(second.changes.length, 0);
      assert.equal(third.changes.length, 0);
      assert.match(alerts[0].subject, /unavailable/i);
      assert.match(alerts[0].text, /primary/i);
      assert.ok(alerts[0].text.includes(PRIMARY), 'the model is named');
    });

    it('★ reports a recovery once, then goes quiet', async () => {
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const up = health();
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [down, up, up] });

      await watcher.run();
      const recovered = await watcher.run();
      const quiet = await watcher.run();

      assert.equal(alerts.length, 2, 'the outage and the recovery');
      assert.equal(recovered.changes.length, 1);
      assert.equal(recovered.changes[0].to, 'ok');
      assert.match(alerts[1].subject, /recovered/i);
      assert.equal(quiet.changes.length, 0);
    });

    it('★ reports a worsening from degraded to unavailable', async () => {
      const degraded = health({ endpoints: [endpoint({ status: 0, uptime5m: 70 })] });
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [degraded, down] });

      await watcher.run();
      const worsened = await watcher.run();

      assert.equal(alerts.length, 2);
      assert.equal(worsened.changes[0].from, 'degraded');
      assert.equal(worsened.changes[0].to, 'unavailable');
      assert.match(alerts[1].subject, /unavailable/i);
    });

    it('★ reports an improvement from unavailable to degraded without calling it a recovery', async () => {
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const degraded = health({ endpoints: [endpoint({ status: 0, uptime5m: 70 })] });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [down, degraded] });

      await watcher.run();
      const improved = await watcher.run();

      assert.equal(alerts.length, 2);
      assert.equal(improved.changes[0].to, 'degraded');
      assert.match(alerts[1].subject, /degraded/i);
      assert.doesNotMatch(alerts[1].subject, /recovered/i);
    });

    it('★ does not alert at all for a healthy first check', async () => {
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [health(), health()] });
      const result = await watcher.run();
      assert.equal(result.changes.length, 0);
      assert.equal(alerts.length, 0);
    });

    it('★ skips a deployment that has no OpenRouter model instead of alerting twice an hour', async () => {
      const alerts = [];
      const watcher = createHealthWatcher({
        env: { AI_PROVIDER: 'fake', AI_MODEL_OPENROUTER: PRIMARY },
        sendAlert: async (alert) => {
          alerts.push(alert);
          return 'log';
        },
        logger: { log() {}, error() {} },
      });

      const first = await watcher.run();
      const second = await watcher.run();

      assert.match(first.skipped, /OpenRouter/i);
      assert.equal(second.verdicts.length, 0);
      assert.equal(alerts.length, 0);
    });
  });

  describe('when the check itself cannot run', () => {
    it('★ does not call a model down on the first unreadable check', async () => {
      const unknown = health({ status: 'unreachable', endpoints: [], message: 'the provider could not be reached' });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [unknown] });

      const result = await watcher.run();
      assert.equal(alerts.length, 0);
      assert.equal(result.verdicts[0].level, 'unknown');
    });

    it('★ alerts after two consecutive unreadable checks, and reports the recovery', async () => {
      const unknown = health({ status: 'unreachable', endpoints: [], message: 'the provider could not be reached' });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [unknown, unknown, health(), health()] });

      await watcher.run();
      const second = await watcher.run();
      const recovered = await watcher.run();
      const quiet = await watcher.run();

      assert.equal(alerts.length, 2, 'the cannot-check alert and the recovery');
      assert.equal(second.changes.length, 1);
      assert.match(alerts[0].subject, /cannot|unreachable|check/i);
      assert.equal(recovered.changes[0].to, 'ok');
      assert.match(alerts[1].subject, /recovered/i);
      assert.equal(quiet.changes.length, 0);
    });

    it('★ an unreadable check does not clear a known outage', async () => {
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const unknown = health({ status: 'unreachable', endpoints: [], message: 'the provider could not be reached' });
      const { watcher, alerts } = sequenceWatcher({ [PRIMARY]: [down, unknown, down] });

      await watcher.run();
      const afterUnknown = await watcher.run();
      const stillDown = await watcher.run();

      assert.equal(alerts.length, 1, 'the known outage is not replaced by an unknown reading');
      assert.equal(afterUnknown.changes.length, 0);
      assert.equal(stillDown.changes.length, 0);
    });
  });

  describe('what the alert is allowed to contain', () => {
    it('★ every health read is a GET, and the API key never reaches the alert', async () => {
      const { impl, calls } = fetchEndpoints([endpoint({ status: -5, uptime5m: 0 })]);
      const alerts = [];
      const watcher = createHealthWatcher({
        env: ENV,
        fetchImpl: impl,
        sendAlert: async (alert) => {
          alerts.push(alert);
          return 'log';
        },
        logger: { log() {}, error() {} },
      });

      await watcher.run();

      assert.ok(calls.length >= 3, 'the primary and both fallbacks are checked');
      assert.deepEqual([...new Set(calls.map((call) => call.method))], ['GET']);
      assert.ok(alerts.length >= 1);
      for (const alert of alerts) {
        assert.ok(!alert.subject.includes(API_KEY), 'the key must not be in the subject');
        assert.ok(!alert.text.includes(API_KEY), 'the key must not be in the body');
        assert.ok(!JSON.stringify(alert).includes(API_KEY), 'the key must not be anywhere in the alert');
      }
    });

    it('★ a failed alert send does not throw out of the check', async () => {
      const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
      const { watcher } = sequenceWatcher(
        { [PRIMARY]: [down] },
        {
          sendAlert: async () => {
            throw new Error('transport exploded');
          },
        },
      );

      const result = await watcher.run();
      assert.equal(result.changes.length, 1);
      assert.ok(['log', 'none'].includes(result.delivered));
    });
  });

  describe('the scheduler', () => {
    it('★ runs on its interval and stops cleanly', async () => {
      let runs = 0;
      const handle = startAiHealthWatch({
        env: ENV,
        intervalMs: 10,
        initialDelayMs: 1,
        logger: { log() {}, error() {} },
        run: async () => {
          runs += 1;
          return { verdicts: [], changes: [], alert: null, delivered: 'none' };
        },
      });

      // Wait for the condition rather than for a fixed number of milliseconds: the full suite
      // runs many files in parallel, and a loaded CPU can delay two 10 ms timers past 40 ms.
      const deadline = Date.now() + 1000;
      while (runs < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(runs >= 2, `expected at least two scheduled runs, saw ${runs}`);

      handle.stop();
      const stoppedAt = runs;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(runs, stoppedAt, 'a stopped scheduler must not keep running');
    });

    it('★ is on in production, off in development and tests, and explicitly overridable', () => {
      assert.equal(healthWatchEnabled('production', {}), true);
      assert.equal(healthWatchEnabled('development', {}), false);
      assert.equal(healthWatchEnabled('test', {}), false);
      assert.equal(healthWatchEnabled('test', { AI_HEALTH_WATCH_ENABLED: 'true' }), false);
      assert.equal(healthWatchEnabled('development', { AI_HEALTH_WATCH_ENABLED: 'true' }), true);
      assert.equal(healthWatchEnabled('production', { AI_HEALTH_WATCH_ENABLED: 'false' }), false);
    });
  });

  describe('the boot wiring', () => {
    it('★ starts the watchdog after listening and stops it on shutdown', async () => {
      let startedWith = null;
      let stopped = false;
      const lines = [];
      const app = () => ({
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
            close: (callback) => callback?.( ),
          };
          setImmediate(callback);
          return server;
        },
      });

      const result = await startServer({
        nodeEnv: 'development',
        appInstance: app(),
        port: 0,
        connectFn: async () => true,
        validator: () => [],
        readiness: () => ({ db: 'ok', mail: 'ok', firebase: 'ok', ai: 'ok', aiProvider: 'openrouter' }),
        modelCheck: null,
        capabilities: null,
        exit: () => {},
        signalTarget: { on: () => {}, listeners: () => [] },
        logger: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
        healthWatch: (options) => {
          startedWith = options;
          return {
            runNow: async () => ({ verdicts: [], changes: [], alert: null, delivered: 'none' }),
            stop: () => { stopped = true; },
          };
        },
      });

      assert.ok(result, 'the server starts');
      assert.ok(startedWith, 'the watchdog starter is given the boot context');
      assert.ok(typeof startedWith.logger.log === 'function');
      assert.ok(lines.some((line) => line.includes('AI watchdog scheduled')));

      await result.shutdown('SIGTERM');
      assert.equal(stopped, true, 'shutdown stops the watchdog before the drain');
    });
  });

  describe('the alert template', () => {
    it('★ escapes the report in HTML and keeps the plain-text body whole', () => {
      const rendered = operationalAlertEmail({
        subject: 'Inventory AI assistant: model unavailable',
        text: 'model <script>alert(1)</script> & endpoint status -5',
        appName: 'Inventory <AI>',
      });

      assert.equal(rendered.text, 'model <script>alert(1)</script> & endpoint status -5');
      assert.ok(rendered.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(rendered.html.includes('&amp; endpoint'));
      assert.ok(rendered.html.includes('Inventory &lt;AI&gt;'));
      assert.ok(!rendered.html.includes('<script>'), 'the report must never become markup');
    });

    it('★ refuses an empty subject or body instead of sending a blank alert', () => {
      assert.throws(() => operationalAlertEmail({ subject: ' ', text: 'body' }), /subject/);
      assert.throws(() => operationalAlertEmail({ subject: 'subject', text: ' ' }), /text/);
    });
  });

  describe('the email path', () => {
    after(() => {
      deregisterFakeMailProvider();
      clearSentMessages();
      setFakeMailScenario(fakeMailSuccess());
    });

    it('★ sends the alert through the configured mail provider', async () => {
      const saved = {
        MAIL_PROVIDER: process.env.MAIL_PROVIDER,
        MAIL_FROM: process.env.MAIL_FROM,
        MAIL_APP_NAME: process.env.MAIL_APP_NAME,
        AI_HEALTH_ALERT_EMAIL: process.env.AI_HEALTH_ALERT_EMAIL,
      };
      registerFakeMailProvider();
      setFakeMailScenario(fakeMailSuccess());
      clearSentMessages();
      process.env.MAIL_PROVIDER = 'fake-mail';
      process.env.MAIL_FROM = 'Inventory AI <no-reply@inventory-ai.test>';
      process.env.MAIL_APP_NAME = 'Inventory AI';
      process.env.AI_HEALTH_ALERT_EMAIL = 'ops@inventory-ai.test';

      try {
        const down = health({ endpoints: [endpoint({ status: -5, uptime5m: 0 })] });
        const watcher = createHealthWatcher({
          env: { ...ENV, AI_HEALTH_ALERT_EMAIL: 'ops@inventory-ai.test' },
          readHealth: async ({ model }) => ({ ...down, model }),
          logger: { log() {}, error() {} },
        });

        const result = await watcher.run();
        const messages = sentMessages();

        assert.equal(result.delivered, 'email');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].to, 'ops@inventory-ai.test');
        assert.match(messages[0].subject, /Inventory AI/i);
        assert.ok(messages[0].text.includes(PRIMARY));
        assert.ok(!messages[0].text.includes(API_KEY));
        assert.ok(!messages[0].html.includes(API_KEY));
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
