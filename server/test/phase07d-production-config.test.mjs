// Phase 07D — production configuration (H7), health endpoints (M1), graceful
// shutdown (M2), and startup gating (H7/H8).
//
// This file is deliberately DATABASE-FREE: every test stubs the database /
// shutdown dependencies or exercises pure logic, so it always runs — even when
// MongoDB is unreachable. DB-backed readiness/disconnect behavior lives in
// phase07d-db-reliability.test.mjs.

import 'dotenv/config';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';

import { validateProductionConfig, JWT_SECRET_MIN_LENGTH } from '../src/config/validateConfig.ts';
import { signAccessToken, verifyAccessToken } from '../src/config/jwt.ts';
import env from '../src/config/env.ts';
import { createHealthRouter } from '../src/routes/health.routes.ts';
import { createShutdownHandler, registerSignalHandlers } from '../src/config/shutdown.ts';
import { startServer } from '../src/config/startup.ts';

// ---------------------------------------------------------------------------
// process.env isolation helpers. Validator/startup read live env; each test
// pins exactly the variables it cares about and restores the rest afterwards.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'MONGODB_URI',
  'JWT_SECRET',
  'AI_PROVIDER',
  // The one built-in provider's settings (AI-25).
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'AI_MODEL_OPENROUTER',
  // The removed direct providers are no longer read by anything, but a developer's local
  // `.env` may still set them: they are saved and restored so no case can be influenced by one.
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
];

const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/** Pin process.env to `patch`, run `fn`, restore. Values `undefined` delete the var. */
async function withEnv(patch, fn) {
  const before = {};
  for (const key of Object.keys(patch)) before[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

const LONG_SECRET = 'x'.repeat(JWT_SECRET_MIN_LENGTH + 10); // valid-length sentinel
const DUMMY_URI = 'mongodb://127.0.0.1:27017/prodvalidate';

/** Collect every problem message so tests can scan them for secret leakage. */
const messages = (problems) => problems.map((p) => p.message);
const hasVariable = (problems, variable) => problems.some((p) => p.variable === variable);

after(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// H7 — production configuration validation
// ---------------------------------------------------------------------------
describe('H7 production config validation (Phase 07D)', () => {
  it('flags a missing MONGODB_URI by variable name (never the connection string)', async () => {
    await withEnv(
      { MONGODB_URI: undefined, JWT_SECRET: LONG_SECRET, AI_PROVIDER: '' },
      () => {
        const problems = validateProductionConfig();
        assert.ok(hasVariable(problems, 'MONGODB_URI'));
        assert.match(problems.find((p) => p.variable === 'MONGODB_URI').message, /MONGODB_URI/);
        assert.ok(messages(problems).every((m) => !m.includes('mongodb://')), 'no connection string in messages');
      }
    );
  });

  it('flags a JWT_SECRET that is too short (never its value)', async () => {
    await withEnv(
      { MONGODB_URI: DUMMY_URI, JWT_SECRET: 'short-secret', AI_PROVIDER: '' },
      () => {
        const problems = validateProductionConfig();
        const jwt = problems.find((p) => p.variable === 'JWT_SECRET');
        assert.ok(jwt, 'JWT_SECRET problem expected');
        assert.match(jwt.message, /at least \d+ characters/);
        assert.ok(!jwt.message.includes('short-secret'), 'weak secret value must never be echoed');
      }
    );
  });

  it('flags a missing JWT_SECRET', async () => {
    await withEnv(
      { MONGODB_URI: DUMMY_URI, JWT_SECRET: undefined, AI_PROVIDER: '' },
      () => {
        const problems = validateProductionConfig();
        assert.ok(hasVariable(problems, 'JWT_SECRET'));
        assert.match(problems.find((p) => p.variable === 'JWT_SECRET').message, /Missing required/);
      }
    );
  });

  it('requires the configured AI provider key but never an unused provider key', async () => {
    // AI-25 — OpenRouter is the only built-in provider now, so this keeps the property it was
    // written for (the configured provider's settings are required, an unrelated key never is)
    // against the one provider that remains, with the removed names planted as unused secrets.
    await withEnv(
      {
        MONGODB_URI: DUMMY_URI,
        JWT_SECRET: LONG_SECRET,
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: '',
        OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1',
        AI_MODEL_OPENROUTER: 'vendor/model',
        ANTHROPIC_API_KEY: 'sentinel-anthropic-key-not-required', // secret-guard:allow (deliberate fixture)
        GEMINI_API_KEY: 'sentinel-gemini-key-not-required',
      },
      () => {
        const problems = validateProductionConfig();
        assert.ok(hasVariable(problems, 'OPENROUTER_API_KEY'), 'the configured provider key is required');
        assert.ok(!hasVariable(problems, 'ANTHROPIC_API_KEY'), 'a removed provider key must NOT be required');
        assert.ok(!hasVariable(problems, 'GEMINI_API_KEY'), 'a removed provider key must NOT be required');
        assert.ok(
          messages(problems).every(
            (m) =>
              !m.includes('sentinel-gemini-key-not-required') &&
              !m.includes('sentinel-anthropic-key-not-required'),
          ),
          'unused key values never leak'
        );
      }
    );
  });

  it('rejects an unknown AI_PROVIDER in production', async () => {
    await withEnv(
      { MONGODB_URI: DUMMY_URI, JWT_SECRET: LONG_SECRET, AI_PROVIDER: 'watson' },
      () => {
        const problems = validateProductionConfig();
        assert.ok(hasVariable(problems, 'AI_PROVIDER'));
      }
    );
  });

  it('accepts a complete production config with AI disabled', () => {
    // An EXPLICIT values bag rather than the live process.env. What is under test
    // is the validator's own contract, so the developer's server/.env must not be
    // able to change the answer — and it can: a locally configured Firebase
    // service account makes the AUTH-04 code pepper required (AUTH-04-A), which
    // would turn this case red for a reason that has nothing to do with it.
    // This is the same explicit-values shape phase32b-firebase-admin.test.mjs
    // uses for its production-config cases.
    assert.deepEqual(
      validateProductionConfig({ MONGODB_URI: DUMMY_URI, JWT_SECRET: LONG_SECRET, AI_PROVIDER: '' }),
      [],
      'valid config -> no problems'
    );
  });

  it('error messages name variables but never planted secret values', () => {
    // An EXPLICIT values bag, for the same reason as the "complete production config"
    // case above: the validator's own contract is what is under test, so the
    // developer's server/.env must not be able to change the answer. It previously
    // could, and that is exactly how this case broke — a machine with
    // OPENROUTER_BASE_URL and AI_MODEL_OPENROUTER set reported only the two planted
    // keys, while CI (which has neither) also reported those two variables with the
    // text "required by the configured AI provider \"openrouter\"", and the secret
    // scan below then failed on the provider NAME. A test that passes locally and
    // fails in CI is reporting the environment, not the code.
    const planted = {
      MONGODB_URI: undefined,
      JWT_SECRET: 'planted-very-secret-jwt-value-0123456789',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-planted-openrouter-secret', // secret-guard:allow (deliberate fixture)
      OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1',
      AI_MODEL_OPENROUTER: 'vendor/model',
      ANTHROPIC_API_KEY: 'sk-planted-anthropic-secret', // secret-guard:allow (deliberate fixture)
      GEMINI_API_KEY: 'planted-gemini-secret',
    };
    const problems = validateProductionConfig(planted);
    assert.ok(problems.length > 0);
    // The secrets that must never be echoed. AI_PROVIDER is deliberately NOT in this
    // list: it is a provider name the messages legitimately quote, not a credential.
    const secrets = [
      planted.JWT_SECRET,
      planted.OPENROUTER_API_KEY,
      planted.ANTHROPIC_API_KEY,
      planted.GEMINI_API_KEY,
    ];
    const text = messages(problems).join('\n');
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `message must never contain secret ${secret.slice(0, 12)}...`);
    }
    // Every problem names the variable that is wrong.
    for (const p of problems) assert.ok(p.message.includes(p.variable));
  });

  it('flags a malformed JWT_EXPIRES_IN so it fails at boot, never on the first login', async () => {
    await withEnv(
      { MONGODB_URI: DUMMY_URI, JWT_SECRET: LONG_SECRET, AI_PROVIDER: '', JWT_EXPIRES_IN: 'not-a-timespan' },
      () => {
        const problems = validateProductionConfig();
        const problem = problems.find((p) => p.variable === 'JWT_EXPIRES_IN');
        assert.ok(problem, 'a value jsonwebtoken cannot parse must be flagged');
        assert.match(problem.message, /JWT_EXPIRES_IN/);
        assert.ok(!problem.message.includes('not-a-timespan'), 'the bad value must never be echoed');
      }
    );
  });

  it('accepts a valid JWT_EXPIRES_IN timespan', () => {
    // Explicit values for the same reason as the case above: the probe under
    // test is the validator's, and the live environment must not be an input.
    assert.deepEqual(
      validateProductionConfig({
        MONGODB_URI: DUMMY_URI,
        JWT_SECRET: LONG_SECRET,
        AI_PROVIDER: '',
        JWT_EXPIRES_IN: '15m',
      }),
      [],
      'a valid timespan is not a problem'
    );
  });

  it('treats an absent JWT_EXPIRES_IN as fine (env.ts applies the "1h" default since AUTH-02)', () => {
    // The key is OMITTED from the bag, which is exactly what "absent" means to
    // the validator — the same state the previous `undefined` env patch produced,
    // without reaching into the live environment to produce it.
    assert.deepEqual(
      validateProductionConfig({ MONGODB_URI: DUMMY_URI, JWT_SECRET: LONG_SECRET, AI_PROVIDER: '' }),
      []
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 07G — JWT verification is pinned to HS256 (defense-in-depth; the token
// carries only `sub` and jsonwebtoken with a string secret already restricts to
// HMAC — this locks the algorithm in as an explicit contract).
// ---------------------------------------------------------------------------
describe('JWT algorithm pinning (Phase 07G)', () => {
  // Pin the jwt helpers' secret to a local throwaway so the assertions are
  // deterministic and independent of whatever JWT_SECRET server/.env holds.
  const PROBE_SECRET = 'x'.repeat(JWT_SECRET_MIN_LENGTH + 10);
  const savedSecret = env.jwtSecret;
  before(() => {
    env.jwtSecret = PROBE_SECRET;
  });
  after(() => {
    env.jwtSecret = savedSecret;
  });

  it('verifyAccessToken accepts a token signed by signAccessToken (HS256)', () => {
    const token = signAccessToken('507f1f77bcf86cd799439011', 'session-abc');
    const payload = verifyAccessToken(token);
    assert.equal(payload.sub, '507f1f77bcf86cd799439011');
    // Phase 26A: the session id is mandatory and must survive the round trip —
    // it is the only thing that ties a token to a revocable session.
    assert.equal(payload.jti, 'session-abc');
  });

  it('verifyAccessToken rejects a token signed with a different HMAC algorithm (HS384)', () => {
    const rogue = jwt.sign({ sub: '507f1f77bcf86cd799439011' }, PROBE_SECRET, { algorithm: 'HS384' });
    assert.throws(() => verifyAccessToken(rogue), /algorithm/i, 'non-HS256 signatures must be refused');
  });
});

// ---------------------------------------------------------------------------
// M1 — health endpoints (stubbed DB so no database is needed)
// ---------------------------------------------------------------------------
function healthApp(getState, isReady) {
  const app = express();
  app.use(
    '/api/health',
    createHealthRouter({
      getState,
      isReady,
      checkIndexes: async () => ({ ready: true, failures: [] }),
    }),
  );
  return app;
}

describe('M1 health endpoints (Phase 07D)', () => {
  let baseUrl;
  let stop;

  async function listen(app) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    stop = () => new Promise((resolve) => server.close(resolve));
  }

  const get = (path) => fetch(`${baseUrl}${path}`).then(async (r) => ({ status: r.status, json: await r.json() }));

  it('GET /live is 200 even when the database is disconnected', async () => {
    await listen(healthApp(() => 'disconnected', () => false));
    try {
      const res = await get('/api/health/live');
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'live');
    } finally {
      await stop();
    }
  });

  it('GET /ready is 503 when disconnected and 200 when connected', async () => {
    await listen(healthApp(() => 'disconnected', () => false));
    try {
      const down = await get('/api/health/ready');
      assert.equal(down.status, 503);
      assert.equal(down.json.status, 'not ready');
      assert.equal(down.json.db, 'disconnected');
      // No stack traces / driver internals.
      assert.ok(!JSON.stringify(down.json).includes('at '));
    } finally {
      await stop();
    }

    await listen(healthApp(() => 'connected', () => true));
    try {
      const up = await get('/api/health/ready');
      assert.equal(up.status, 200);
      assert.equal(up.json.status, 'ready');
      assert.equal(up.json.db, 'connected');
    } finally {
      await stop();
    }
  });

  it('legacy GET /api/health stays 200 and keeps reporting db state', async () => {
    await listen(healthApp(() => 'disconnected', () => false));
    try {
      const res = await get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'ok');
      assert.equal(res.json.db, 'disconnected');
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Startup gating (H7 fail-fast + H8 dev-leniency) — no real database needed.
// ---------------------------------------------------------------------------
describe('startup gating (Phase 07D)', () => {
  const captureExit = () => {
    const codes = [];
    return { codes, exit: (code) => codes.push(code) };
  };

  it('production refuses to boot on invalid config — exits non-zero before listening', async () => {
    const { codes, exit } = captureExit();
    let connected = false;
    const result = await startServer({
      nodeEnv: 'production',
      appInstance: express(),
      validator: () => [{ variable: 'MONGODB_URI', message: 'Missing required environment variable: MONGODB_URI' }],
      connectFn: async () => {
        connected = true;
        return true;
      },
      exit,
    });
    assert.equal(result, null, 'must not return a running server');
    assert.deepEqual(codes, [1], 'must exit non-zero');
    assert.equal(connected, false, 'must not attempt a DB connect on invalid config');
  });

  it('production exits non-zero when MongoDB cannot be connected at startup', async () => {
    const { codes, exit } = captureExit();
    const result = await startServer({
      nodeEnv: 'production',
      appInstance: express(),
      validator: () => [],
      connectFn: async () => {
        throw new Error('simulated connect failure');
      },
      exit,
    });
    assert.equal(result, null, 'must not start a server on a failed production connect');
    assert.deepEqual(codes, [1], 'must exit non-zero');
  });

  it('development/test stays reachable but reports not-ready when MongoDB is down', async () => {
    // Default shipped app (real /api/health/ready reads the real driver state).
    const { default: app } = await import('../src/app.ts');
    const { codes, exit } = captureExit();
    const result = await startServer({
      nodeEnv: 'development',
      appInstance: app,
      port: 0,
      validator: () => [{ variable: 'JWT_SECRET', message: 'irrelevant in development' }],
      connectFn: async () => {
        throw new Error('simulated connect failure');
      },
      exit,
    });
    assert.ok(result && result.server, 'dev server starts even with the DB down');
    assert.equal(result.connected, false);
    assert.deepEqual(codes, [], 'development must not exit on DB-down startup');

    await new Promise((resolve) => result.server.once('listening', resolve));
    const port = result.server.address().port;
    try {
      const live = await fetch(`http://127.0.0.1:${port}/api/health/live`);
      assert.equal(live.status, 200, 'liveness is independent of the database');
      const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      assert.equal(ready.status, 503, 'readiness must report not-ready while the DB is down');
      assert.equal((await ready.json()).status, 'not ready');
    } finally {
      await new Promise((resolve) => result.server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// M2 — graceful shutdown orchestration (injected server/db/exit)
// ---------------------------------------------------------------------------
function listenOn(server) {
  return new Promise((resolve) => server.once('listening', resolve));
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

describe('M2 graceful shutdown (Phase 07D)', () => {
  it('drains in-flight requests, stops accepting new ones, closes the DB, exits 0', async () => {
    const app = express();
    // Resolve when the handler has actually STARTED, rather than assuming a fixed 60 ms is
    // enough for the fetch to reach it. Under a loaded CI runner the old fixed sleep could
    // leave the connection idle when shutdown closed the listener, which produced a
    // `fetch failed: ECONNRESET` in an otherwise passing suite (observed 2026-10-21).
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    app.get('/slow', (req, res) => {
      startedResolve();
      setTimeout(() => res.json({ ok: true }), 150);
    });
    const server = app.listen(0);
    await listenOn(server);
    const port = server.address().port;

    const dbCloses = [];
    const exitCodes = [];
    const shutdown = createShutdownHandler({
      server,
      closeDatabase: async () => dbCloses.push('closed'),
      timeoutMs: 3000,
      exit: (code) => exitCodes.push(code),
    });

    // A request is in-flight when shutdown begins: wait for the handler itself, not a clock.
    const slow = fetch(`http://127.0.0.1:${port}/slow`);
    await started;

    const draining = shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 30));

    // New connections must be refused once shutdown started.
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/after-shutdown`);
    } catch {
      refused = true;
    }
    assert.equal(refused, true, 'server must stop accepting new requests during drain');

    // The in-flight request still completes normally.
    const slowRes = await slow;
    assert.equal(slowRes.status, 200);
    assert.deepEqual(await slowRes.json(), { ok: true });

    await draining;
    assert.deepEqual(dbCloses, ['closed'], 'MongoDB closed exactly once, after the drain');
    assert.deepEqual(exitCodes, [0], 'clean exit code');
  });

  it('is idempotent — a second signal during shutdown does nothing', async () => {
    const app = express();
    app.get('/', (req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    await listenOn(server);

    const dbCloses = [];
    const exitCodes = [];
    const shutdown = createShutdownHandler({
      server,
      closeDatabase: async () => dbCloses.push('closed'),
      timeoutMs: 1000,
      exit: (code) => exitCodes.push(code),
    });

    await shutdown('SIGTERM');
    await shutdown('SIGINT'); // second call -> no-op
    await shutdown('SIGTERM');

    assert.deepEqual(dbCloses, ['closed'], 'database closed exactly once');
    assert.deepEqual(exitCodes, [0], 'exits once with code 0');
    assert.equal(server.listening, false, 'server is fully closed');
  });

  it('force-exits when the grace period elapses (no indefinite hang)', async () => {
    // A server whose close() never completes -> drain can never finish.
    const stuckServer = {
      listening: true,
      close() {},
      closeIdleConnections() {},
      once() {},
      removeListener() {},
      on() {},
    };
    const dbCloses = [];
    const exitCodes = [];
    const shutdown = createShutdownHandler({
      server: stuckServer,
      closeDatabase: async () => dbCloses.push('closed'),
      timeoutMs: 40,
      exit: (code) => exitCodes.push(code),
    });

    shutdown('SIGTERM'); // not awaited: it never resolves on its own
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(exitCodes, [1], 'must force-exit with a non-zero code');
    assert.deepEqual(dbCloses, [], 'database close must not run if the drain never finished');
  });

  it('registerSignalHandlers never registers the same handler twice', () => {
    const target = new EventEmitter();
    const handler = () => {};
    const first = registerSignalHandlers(target, handler);
    const second = registerSignalHandlers(target, handler);
    assert.equal(first, 2, 'SIGINT + SIGTERM registered on first install');
    assert.equal(second, 0, 're-installing the same handler is a no-op');
    assert.equal(target.listenerCount('SIGINT'), 1);
    assert.equal(target.listenerCount('SIGTERM'), 1);
  });

  it('a shutdown handler works against a server that is already closed', async () => {
    const server = express().listen(0);
    await listenOn(server);
    await closeServer(server);

    const exitCodes = [];
    const shutdown = createShutdownHandler({ server, closeDatabase: async () => {}, exit: (c) => exitCodes.push(c) });
    await shutdown('SIGTERM');
    assert.deepEqual(exitCodes, [0], 'already-closed server drains cleanly');
  });
});
