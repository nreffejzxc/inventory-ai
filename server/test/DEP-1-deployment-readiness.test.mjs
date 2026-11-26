/**
 * DEP-1 — the deployment's own account of itself.
 *
 * WHAT THIS SUITE IS FOR. On 2026-10-15 the deployed production service answered
 * every liveness and readiness probe perfectly (`200`, `db: "connected"`), passed
 * CI, and satisfied the production configuration validator — and could not onboard
 * a single new member, because `MAIL_PROVIDER` was unset on that host, so the
 * AUTH-04 verification-code request answers `503 EMAIL_VERIFICATION_NOT_CONFIGURED`
 * before it touches a challenge. Nothing was broken; something was missing, and
 * nothing said so. `config/deploymentReadiness.ts` says so, once, at boot.
 *
 * WHAT IS PINNED, AND WHY EACH PART IS WORTH A CASE.
 *
 *   1. THE LINE states every integration in one greppable line, and it is ONE line
 *      (`split('\n')` — a multi-line report is a log-scanning problem).
 *   2. THE LINE AGREES WITH THE CODE. The report asks `isMailConfigured`,
 *      `isFirebaseConfigured` and `isEmailVerificationConfigured` rather than
 *      re-deriving their rules, so this suite drives the REAL predicates through a
 *      controlled environment. If any of those rules changed, the line would change
 *      with them instead of lying.
 *   3. THE WARNINGS ARE PURE, AND THEIR ABSENCE IS ASSERTED TOO. `deploymentNotes`
 *      is a function of a report, so each of its cases is driven directly — and the
 *      healthy answer (no notes) is asserted in every shape that produces it. A
 *      warning that always fires is a warning an operator learns to scroll past.
 *   4. NOTHING SECRET CAN REACH EITHER. Sentinels are planted in the pepper, both
 *      provider keys and the service-account private key, with a positive control
 *      that each sentinel is really in the environment — so "not present in the
 *      output" cannot pass because the variable was never set.
 *   5. A WARNING IS NEVER A REFUSAL. `startServer` still boots, still listens and
 *      never exits when a note fires, in production included: refusing to boot over
 *      an optional integration would turn a degraded feature into a dead
 *      deployment.
 *   6. THE BUILD IDENTITY IS A COMMIT ID OR `unknown`, IT IS SHAPED, AND ITS SURFACE
 *      IS NARROW. The value comes from the host's environment, which is untrusted
 *      input as far as the module is concerned, and it is published on a public
 *      endpoint — so anything that is not 7–40 hex characters is reported as
 *      `unknown`, and only the legacy `/api/health` carries it (`/ready` stays a
 *      readiness gate, `/live` stays dependency-free).
 *
 * The suite is DB-free, so it belongs to the `unit` classification and needs no
 * MongoDB. That is also why the routing check uses `createHealthRouter`'s injected
 * seam rather than the real database state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  buildInfo,
  deploymentLine,
  deploymentNotes,
  integrationReport,
  proxyTrustNote,
} from '../src/config/deploymentReadiness.ts';
import { createHealthRouter } from '../src/routes/health.routes.ts';
import { startServer } from '../src/config/startup.ts';
import { registerProvider, deregisterProvider } from '../src/services/mail/providers/index.ts';

/**
 * Every environment variable this suite touches. Deliberately a closed list: the
 * environment is cleared of exactly these before each case, so a case cannot pass
 * because of something the machine running the suite happens to have set, and no
 * unrelated variable (testEnv's own, for instance) is disturbed.
 */
const MANAGED_ENV = [
  'MAIL_PROVIDER',
  'MAIL_FROM',
  'BREVO_API_KEY',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'EMAIL_VERIFICATION_CODE_PEPPER',
  'AI_PROVIDER',
  'AI_MODEL_OPENROUTER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'RENDER_GIT_COMMIT',
  'GIT_COMMIT',
  'GITHUB_SHA',
];

/** A syntactically complete service account — never used, never sent anywhere. */
const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'dep1-project',
  client_email: 'dep1@dep1-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nDEP1_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n',
});

/**
 * Run `fn` with the managed variables cleared and `patch` applied on top, then put
 * the environment back exactly as it was. Synchronous on purpose: an `await`
 * inside would let a concurrent suite observe the doctored environment.
 */
function withEnv(patch, fn) {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of MANAGED_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A registered mail provider: no environment, no network, nothing to clean up but the registry entry. */
const SEAM_PROVIDER = 'dep-1-seam';
const SEAM_FACTORY = () => ({ name: SEAM_PROVIDER, send: async () => ({ id: null }) });

before(() => registerProvider(SEAM_PROVIDER, SEAM_FACTORY));
after(() => deregisterProvider(SEAM_PROVIDER));

/** The environment of a fully-configured deployment, as a patch. */
const FULL = {
  MAIL_PROVIDER: SEAM_PROVIDER,
  MAIL_FROM: 'no-reply@example.com',
  FIREBASE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
  EMAIL_VERIFICATION_CODE_PEPPER: 'dep1-pepper-value-long-enough-to-pass',
  AI_PROVIDER: 'openrouter',
};

/** A report bag, for the pure functions. */
function report(overrides = {}) {
  return {
    mail: false,
    mailProvider: '',
    firebase: false,
    emailVerification: false,
    ai: false,
    aiProvider: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1–2. The line, and its agreement with the code it describes.
// ---------------------------------------------------------------------------
describe('DEP-1 the boot line', () => {
  it('states every integration in ONE greppable line', () => {
    const line = deploymentLine(
      report({
        mail: true,
        mailProvider: 'brevo',
        firebase: true,
        emailVerification: true,
        ai: true,
        aiProvider: 'openrouter',
      }),
    );

    assert.equal(
      line,
      '[config] integrations mail=on(brevo) firebase=on emailVerification=on ai=on(openrouter)',
    );
    assert.equal(line.split('\n').length, 1, 'the report must stay one line');
    assert.ok(line.startsWith('[config] integrations '), 'one token must find it in a deploy log');
  });

  it('says "off" rather than naming nothing, for every disabled integration', () => {
    const line = deploymentLine(report());
    assert.equal(line, '[config] integrations mail=off firebase=off emailVerification=off ai=off');
    assert.ok(
      !line.includes('()'),
      'an unconfigured integration must not render an empty provider name',
    );
  });

  it('reads the real predicates, and reports them accurately for a full deployment', () => {
    withEnv(FULL, () => {
      const live = integrationReport();
      assert.equal(live.mail, true);
      assert.equal(live.mailProvider, SEAM_PROVIDER);
      assert.equal(live.firebase, true);
      assert.equal(live.emailVerification, true);
      assert.equal(live.ai, true);
      assert.equal(live.aiProvider, 'openrouter');
      assert.equal(deploymentNotes(live).length, 0, 'a full deployment has nothing to warn about');
    });
  });

  it('reports every integration off on a bare environment', () => {
    withEnv({}, () => {
      const live = integrationReport();
      assert.deepEqual(live, report(), 'a bare deployment is the all-off report');
      assert.deepEqual(deploymentNotes(live), [], 'and it is not a degraded deployment');
    });
  });

  it('names a provider that is selected but incomplete, while reporting mail as unusable', () => {
    // The production case, inverted: an operator DID set the variable, and the
    // provider still cannot send. Both facts matter, and neither may be hidden.
    withEnv({ ...FULL, MAIL_PROVIDER: 'brevo' }, () => {
      const live = integrationReport();
      assert.equal(live.mail, false, 'a built-in provider without its key cannot send');
      assert.equal(live.mailProvider, 'brevo', 'the selected name is still worth reporting');
      assert.equal(
        deploymentNotes(live).length,
        1,
        'and the deployment is degraded even though a provider was chosen',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 3–5. The warnings: the states that are legal, silent and unusable.
// ---------------------------------------------------------------------------
describe('DEP-1 the deployment warnings', () => {
  it('names the production gap — verification enabled, no mail — with the variables to set', () => {
    const notes = deploymentNotes(report({ firebase: true, emailVerification: true, mail: false }));

    assert.equal(notes.length, 1, 'exactly one note for this state');
    const note = notes[0];
    assert.match(note, /email verification is ENABLED but mail is not configured/);
    for (const variable of ['MAIL_PROVIDER', 'MAIL_FROM', 'BREVO_API_KEY']) {
      assert.ok(note.includes(variable), `the note must name ${variable} to set`);
    }
    for (const code of ['EMAIL_VERIFICATION_NOT_CONFIGURED', 'MAIL_NOT_CONFIGURED']) {
      assert.ok(note.includes(code), `the note must name the ${code} answer a caller gets`);
    }
    assert.match(note, /no new member can complete registration/);
    for (const endpoint of [
      'POST /api/auth/email-verification/request',
      'POST /api/auth/forgot-password',
    ]) {
      assert.ok(note.includes(endpoint), `the note must name ${endpoint}`);
    }
  });

  it('names the pepper gap, and says production refuses to boot in that state', () => {
    const notes = deploymentNotes(report({ firebase: true, emailVerification: false }));

    assert.equal(notes.length, 1);
    assert.match(notes[0], /AUTH-04 flow is unavailable/);
    assert.ok(notes[0].includes('EMAIL_VERIFICATION_CODE_PEPPER'), 'the variable must be named');
    assert.match(notes[0], /Production refuses to boot/);
  });

  it('says nothing in each of the four shapes that are not degraded', () => {
    const shapes = [
      // Nothing on: every existing deployment before any of this existed.
      report(),
      // The additive property, stated as a case: with the AUTH-04 flow switched
      // off there is nothing that NEEDS mail, so its absence is not a warning.
      report({ emailVerification: false, mail: false, firebase: false }),
      // Mail without Firebase is a password-recovery deployment — supported, not
      // degraded, because nothing about it needs a verification code.
      report({ mail: true, mailProvider: 'brevo' }),
      // And everything on at once.
      report({
        mail: true,
        mailProvider: 'brevo',
        firebase: true,
        emailVerification: true,
        ai: true,
        aiProvider: 'openrouter',
      }),
    ];

    for (const shape of shapes) {
      assert.deepEqual(deploymentNotes(shape), [], `unexpected warning for ${JSON.stringify(shape)}`);
    }
  });

  it('ignores the integration states the warning deliberately does not own', () => {
    // An AI provider without its keys is a validation concern (it fails fast at
    // boot in production), so this module must not duplicate it — a doubled
    // warning is how a warning list stops being read.
    assert.deepEqual(deploymentNotes(report({ ai: true, aiProvider: 'openrouter' })), []);
  });

  // -------------------------------------------------------------------------
  // 2026-10-23 security audit — the warning that is about the HOST rather than an
  // integration. A production process behind a reverse proxy that does not declare
  // it resolves `req.ip` to the proxy, so every per-IP auth limiter counts ONE
  // bucket for the whole world. Nothing in any response reveals it; only this line
  // does, which is why its absence in the well-configured case is asserted too.
  // -------------------------------------------------------------------------
  it('warns when a PRODUCTION service does not trust the proxy in front of it', () => {
    const note = proxyTrustNote({ nodeEnv: 'production', trustProxy: 0 });

    assert.ok(note, 'production without a trusted proxy must say so');
    assert.match(note, /TRUST_PROXY is not set on this PRODUCTION service/);
    assert.ok(note.includes('TRUST_PROXY=1'), 'the safe value must be stated explicitly');
    assert.match(note, /ONE global bucket/, 'the consequence, not a vague "check your proxy"');
    assert.ok(note.includes('60 failures / 15 min'), 'the login bucket is stated with its cap');
    assert.match(note, /sixty failed logins/, 'the attack that produces it is spelled out');
  });

  it('is silent once a proxy hop is trusted, and outside production always', () => {
    assert.equal(proxyTrustNote({ nodeEnv: 'production', trustProxy: 1 }), null);
    assert.equal(proxyTrustNote({ nodeEnv: 'production', trustProxy: 2 }), null);
    assert.equal(proxyTrustNote({ nodeEnv: 'development', trustProxy: 0 }), null);
    assert.equal(proxyTrustNote({ nodeEnv: 'test', trustProxy: 0 }), null);
  });

  it('treats an unusable hop count as untrusted rather than as configured', () => {
    // A NaN (or a value the process never received) cannot mean "one hop".
    // Reading it as configured would hide exactly the deployment this note exists for.
    assert.ok(proxyTrustNote({ nodeEnv: 'production', trustProxy: Number.NaN }));
    assert.ok(proxyTrustNote({ nodeEnv: 'production', trustProxy: undefined }));
  });

  it('cannot leak a secret through the line or the notes', () => {
    const SECRETS = {
      EMAIL_VERIFICATION_CODE_PEPPER: 'DEP1_SENTINEL_PEPPER_0123456789abcdef',
      BREVO_API_KEY: 'DEP1_SENTINEL_BREVO_KEY',
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: 'DEP1_SENTINEL_PROJECT',
        client_email: 'DEP1_SENTINEL_EMAIL@example.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nDEP1_SENTINEL_PRIVATE_KEY\n-----END PRIVATE KEY-----\n',
      }),
      MAIL_FROM: 'DEP1_SENTINEL_FROM@example.com',
      AI_PROVIDER: 'DEP1_SENTINEL_AI',
    };

    withEnv(SECRETS, () => {
      // Positive control: every sentinel really is in the environment, so the
      // absence assertions below cannot pass vacuously.
      for (const sentinel of [
        'DEP1_SENTINEL_PEPPER_0123456789abcdef',
        'DEP1_SENTINEL_BREVO_KEY',
        'DEP1_SENTINEL_PROJECT',
        'DEP1_SENTINEL_EMAIL',
        'DEP1_SENTINEL_PRIVATE_KEY',
        'DEP1_SENTINEL_FROM',
        'DEP1_SENTINEL_AI',
      ]) {
        assert.ok(
          Object.values(process.env).some((value) => String(value).includes(sentinel)),
          `the control sentinel ${sentinel} must be present in the environment`,
        );
      }

      const live = integrationReport();
      const output = [deploymentLine(live), ...deploymentNotes(live)].join('\n');

      for (const sentinel of [
        'DEP1_SENTINEL_PEPPER',
        'DEP1_SENTINEL_BREVO_KEY',
        'DEP1_SENTINEL_PROJECT',
        'DEP1_SENTINEL_EMAIL',
        'DEP1_SENTINEL_PRIVATE_KEY',
        'DEP1_SENTINEL_FROM',
      ]) {
        assert.ok(!output.includes(sentinel), `${sentinel} must never reach the boot output`);
      }

      // The two states that DO cause a warning, with secrets planted, so the
      // warning paths themselves are covered rather than only the healthy one.
      withEnv({ ...SECRETS, EMAIL_VERIFICATION_CODE_PEPPER: '' }, () => {
        const degraded = [deploymentLine(integrationReport()), ...deploymentNotes(integrationReport())].join('\n');
        assert.ok(degraded.includes('EMAIL_VERIFICATION_CODE_PEPPER'), 'the pepper note fires');
        for (const sentinel of ['DEP1_SENTINEL_PRIVATE_KEY', 'DEP1_SENTINEL_EMAIL']) {
          assert.ok(!degraded.includes(sentinel), `${sentinel} must not reach a warning`);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The build identity published on the health endpoint.
// ---------------------------------------------------------------------------
describe('DEP-1 the build identity', () => {
  it('prefers the host-specific commit, then the generic ones, in a stated order', () => {
    const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    assert.equal(buildInfo({ RENDER_GIT_COMMIT: commit }).commit, commit);
    assert.equal(buildInfo({ GIT_COMMIT: commit }).commit, commit);
    assert.equal(buildInfo({ GITHUB_SHA: commit }).commit, commit);
    assert.equal(
      buildInfo({ RENDER_GIT_COMMIT: commit, GIT_COMMIT: 'fffffff', GITHUB_SHA: 'eeeeeee' }).commit,
      commit,
      'the most specific source wins',
    );
    assert.equal(
      buildInfo({ GIT_COMMIT: 'fffffff', GITHUB_SHA: 'eeeeeee' }).commit,
      'fffffff',
      'and the fallback order is deterministic',
    );
  });

  it('reports "unknown" for anything that is not a commit id', () => {
    // The value is host-supplied, so it is untrusted input that would otherwise be
    // published verbatim on a public endpoint.
    for (const value of [
      undefined,
      '',
      '   ',
      'not-a-commit',
      'abc123', // too short
      'z'.repeat(40), // not hex
      'a'.repeat(41), // too long
      'a1b2c3d4; rm -rf /', // a plausible injection
      'https://github.com/owner/repo/commit/a1b2c3d4',
    ]) {
      assert.equal(
        buildInfo({ RENDER_GIT_COMMIT: value }).commit,
        'unknown',
        `${JSON.stringify(value)} must not be echoed as a commit id`,
      );
    }
  });

  it('normalises an accepted commit to lower case and trims it', () => {
    assert.equal(buildInfo({ GITHUB_SHA: '  ABCDEF1\n' }).commit, 'abcdef1');
    assert.equal(buildInfo({ GITHUB_SHA: 'A1B2C3D' }).commit, 'a1b2c3d');
  });

  it('reports uptime as whole seconds, and never as a negative or a NaN', () => {
    const values = { RENDER_GIT_COMMIT: 'abcdef1' };

    assert.equal(buildInfo(values, () => 12.6).uptimeSeconds, 13);
    assert.equal(buildInfo(values, () => 0).uptimeSeconds, 0);
    assert.equal(buildInfo(values, () => -3).uptimeSeconds, 0);
    assert.equal(buildInfo(values, () => Number.NaN).uptimeSeconds, 0);
    assert.equal(buildInfo(values, () => Number.POSITIVE_INFINITY).uptimeSeconds, 0);
  });

  it('exposes exactly two fields, so a new one is a deliberate decision', () => {
    assert.deepEqual(Object.keys(buildInfo({})).sort(), ['commit', 'uptimeSeconds']);
  });

  it('reads the real process environment by default', () => {
    withEnv({ RENDER_GIT_COMMIT: 'abcdef1' }, () => {
      const live = buildInfo();
      assert.equal(live.commit, 'abcdef1');
      assert.ok(live.uptimeSeconds >= 0 && Number.isInteger(live.uptimeSeconds));
    });
    withEnv({}, () => {
      assert.equal(buildInfo().commit, 'unknown', 'a host that states nothing says unknown');
    });
  });
});

// ---------------------------------------------------------------------------
// 6b. Where the build identity is published, over a real HTTP surface.
// ---------------------------------------------------------------------------
describe('DEP-1 the health surface', () => {
  async function withHealthApp(build, run) {
    const app = express();
    app.use(
      '/api/health',
      createHealthRouter({
        getState: () => 'connected',
        isReady: () => true,
        checkIndexes: async () => ({ ready: true, failures: [] }),
        build,
      }),
    );
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      return await run(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const injected = () => ({ commit: 'abcdef1', uptimeSeconds: 42 });

  it('publishes the commit on the legacy endpoint, alongside its existing fields', async () => {
    await withHealthApp(injected, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200, 'the legacy endpoint is still always a 200');
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.db, 'connected', 'the database state is unchanged');
      assert.equal(body.commit, 'abcdef1');
      assert.equal(body.uptimeSeconds, 42);
      assert.ok(typeof body.timestamp === 'string');
    });
  });

  it('names the posture on the legacy endpoint, from the process and from nothing else', async () => {
    await withHealthApp(injected, async (port) => {
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();

      // One of the three names, never a raw environment value and never a database name.
      assert.ok(
        ['production', 'development', 'test'].includes(health.environment),
        `unexpected posture ${JSON.stringify(health.environment)}`,
      );
      assert.equal(JSON.stringify(health).includes('inventoryai_'), false);
    });

    // And it is the INJECTED posture that is published, so the field cannot be hard-coded.
    const app = express();
    app.use('/api/health', createHealthRouter({
      getState: () => 'connected',
      isReady: () => true,
      checkIndexes: async () => ({ ready: true, failures: [] }),
      build: injected,
      environment: () => 'production',
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
      assert.equal(body.environment, 'production');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps /ready a readiness gate and /live dependency-free', async () => {
    await withHealthApp(injected, async (port) => {
      const ready = await (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).json();
      assert.deepEqual(
        Object.keys(ready).sort(),
        ['db', 'status', 'timestamp'],
        'the readiness gate reports readiness and nothing else',
      );

      const live = await (await fetch(`http://127.0.0.1:${port}/api/health/live`)).json();
      assert.deepEqual(
        Object.keys(live).sort(),
        ['status', 'timestamp'],
        'liveness must not grow a dependency',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The boot wiring: a warning is never a refusal, and it comes first.
// ---------------------------------------------------------------------------
describe('DEP-1 the boot wiring', () => {
  /** A logger that keeps what was said, in order. */
  function captureLogger(events) {
    return {
      log: (message) => events.push({ channel: 'log', message }),
      error: (message) => events.push({ channel: 'error', message }),
    };
  }

  const signalTarget = { on: () => {}, listeners: () => [] };

  async function boot({ readiness, nodeEnv = 'development', events, proxyTrust = 1, indexCheck }) {
    const exits = [];
    const result = await startServer({
      nodeEnv,
      ...(indexCheck ? { indexCheck } : {}),
      // A boot that is not about the proxy warning declares a correctly configured
      // proxy, so its log assertions stay about the readiness report alone.
      proxyTrust,
      appInstance: express(),
      port: 0,
      validator: () => [],
      connectFn: async () => {
        events.push({ channel: 'event', message: 'connect' });
        return true;
      },
      readiness,
      // This suite is about the READINESS report, so the boot gate is satisfied explicitly rather
      // than by whatever `NODE_ENV`/`TEST_MODE` the runner happens to export.
      environment: () => ({ kind: 'development', testProcess: false }),
      exit: (code) => exits.push(code),
      logger: captureLogger(events),
      signalTarget,
    });
    return { result, exits };
  }

  it('★ reports missing required indexes in the boot log without refusing to serve', async () => {
    const events = [];
    const { result, exits } = await boot({
      events,
      readiness: () => report({}),
      indexCheck: async () => ({
        ready: false,
        failures: [
          { name: 'uniq_purchase_order_request_key', reason: 'Draft PO index is missing' },
          { name: 'uniq_audit_business_dedupe_key', reason: 'audit dedupe index is missing' },
        ],
      }),
    });

    try {
      assert.ok(result && result.server, 'the HTTP server still starts');
      assert.deepEqual(exits, [], 'readiness owns the traffic gate, not process exit');
      await new Promise((resolve) => setImmediate(resolve));
      const errors = events.filter((entry) => entry.channel === 'error').map((entry) => entry.message);
      assert.ok(errors.some((line) => line.includes('required database indexes are NOT ready')));
      assert.ok(errors.some((line) => line.includes('Draft PO index is missing')));
      assert.ok(errors.some((line) => line.includes('audit dedupe index is missing')));
    } finally {
      if (result) await close(result.server);
    }
  });

  const close = (server) => new Promise((resolve) => server.close(resolve));

  it('states what it is, then what it is missing, before it touches the database', async () => {
    const events = [];
    const { result, exits } = await boot({
      events,
      readiness: () => report({ firebase: true, emailVerification: true, mail: false }),
    });

    try {
      assert.ok(result && result.server, 'the server boots');
      assert.deepEqual(exits, [], 'a warning must never refuse to boot');
      assert.equal(events[0].message, deploymentLine(report({ firebase: true, emailVerification: true, mail: false })));
      assert.equal(events[0].channel, 'log');

      const warnings = events.filter(
        (entry) => entry.channel === 'error' && entry.message.startsWith('[config] warning: '),
      );
      assert.equal(warnings.length, 1, 'exactly one warning for one missing integration');
      assert.match(warnings[0].message, /MAIL_PROVIDER/);

      const connectIndex = events.findIndex((entry) => entry.message === 'connect');
      assert.ok(connectIndex > 0, 'the connect happened');
      assert.ok(
        events.indexOf(warnings[0]) < connectIndex,
        'the warnings are emitted BEFORE the database is touched',
      );
    } finally {
      await close(result.server);
    }
  });

  // 2026-10-23 security audit — the host-level warning reaches the boot log, before
  // the database, and is still never a refusal.
  it('warns about an untrusted proxy in production, before the connect, and still boots', async () => {
    const events = [];
    const healthy = report({
      mail: true,
      mailProvider: SEAM_PROVIDER,
      firebase: true,
      emailVerification: true,
      ai: true,
      aiProvider: 'openrouter',
    });
    const { result, exits } = await boot({
      events,
      nodeEnv: 'production',
      proxyTrust: 0,
      readiness: () => healthy,
    });

    try {
      assert.ok(result && result.server, 'the server still listens');
      assert.deepEqual(exits, [], 'a host-level warning must not take the service down');

      const warnings = events.filter(
        (entry) => entry.channel === 'error' && entry.message.startsWith('[config] warning: '),
      );
      assert.equal(warnings.length, 1, 'exactly one warning for a healthy-but-untrusted host');
      assert.match(warnings[0].message, /TRUST_PROXY/);

      const connectIndex = events.findIndex((entry) => entry.message === 'connect');
      assert.ok(
        events.indexOf(warnings[0]) < connectIndex,
        'the warning is emitted BEFORE the database is touched',
      );
    } finally {
      await close(result.server);
    }
  });

  it('boots a degraded deployment in production too, warning instead of exiting', async () => {
    const events = [];
    const { result, exits } = await boot({
      events,
      nodeEnv: 'production',
      readiness: () => report({ firebase: true, emailVerification: true, mail: false }),
    });

    try {
      assert.ok(result && result.server, 'production still listens with a warning outstanding');
      assert.deepEqual(exits, [], 'and the process does not exit');
    } finally {
      await close(result.server);
    }
  });

  it('stays silent when there is nothing to say', async () => {
    const events = [];
    const healthy = report({
      mail: true,
      mailProvider: SEAM_PROVIDER,
      firebase: true,
      emailVerification: true,
      ai: true,
      aiProvider: 'openrouter',
    });
    const { result } = await boot({ events, readiness: () => healthy });

    try {
      assert.equal(events.filter((entry) => entry.channel === 'error').length, 0);
      assert.equal(
        events.filter((entry) => entry.message.startsWith('[config] integrations')).length,
        1,
        'the line is emitted exactly once',
      );
    } finally {
      await close(result.server);
    }
  });
});
