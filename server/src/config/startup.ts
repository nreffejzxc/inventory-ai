/**
 * Server startup orchestration (Phase 07D / H7 + H8 + M2).
 *
 * Order of operations is deliberate:
 *   1. Production configuration is validated FIRST — a broken deploy exits
 *      non-zero before it ever binds a port or accepts a request.
 *   2. MongoDB connect is attempted before listening. In production a failed
 *      connect is fatal (exit non-zero) so the app is never alive-but-useless.
 *      Outside production the process stays reachable for diagnostics, but the
 *      readiness endpoint reports not-ready and every database request answers
 *      503 (see errorHandler) instead of buffering/hanging.
 *   3. Only then does the HTTP server start accepting traffic, and shutdown
 *      handlers (SIGINT/SIGTERM) are installed for a bounded graceful drain.
 *
 * Every side-effecting dependency is injectable so tests exercise fail-fast,
 * dev-leniency, and readiness deterministically without real sockets or exits.
 */

import app from '../app.ts';
import env, {
  classifyNodeEnv,
  isRecognisedNodeEnv,
  isTestProcess,
  KNOWN_NODE_ENVS,
} from './env.ts';
import type { NodeEnvKind } from './env.ts';
import { connectDatabase, disconnectDatabase } from './db.ts';
import { deploymentLine, deploymentNotes, proxyTrustNote, integrationReport } from './deploymentReadiness.ts';
import type { IntegrationReport } from './deploymentReadiness.ts';
import {
  createShutdownHandler,
  registerSignalHandlers,
} from './shutdown.ts';
import type { Logger, ShutdownHandler, ShutdownServer, SignalTarget } from './shutdown.ts';
import { validateProductionConfig } from './validateConfig.ts';
import type { ConfigProblem } from './validateConfig.ts';
import { INSTANCE_ID } from './instanceIdentity.ts';
import { checkModelCatalogue } from '../services/ai/modelCheck.ts';
import type { CatalogueResult } from '../services/ai/modelCheck.ts';
import { refreshModelCapabilities, declaresToolSupport } from '../services/ai/modelCapabilities.ts';
import { aiConfig } from '../services/ai/aiConfig.ts';
import { reasoningState } from '../services/ai/reasoningPolicy.ts';
import {
  healthWatchConfig,
  healthWatchEnabled,
  refreshModelHealthGate,
  startAiHealthWatch,
} from '../services/ai/healthWatch.ts';
import type { HealthWatchHandle } from '../services/ai/healthWatch.ts';
import { boundPortOf, verifyBoundPort } from './portGuard.ts';
import type { PortProbeResult } from './portGuard.ts';

/**
 * What the live process says about itself, for the boot gate above.
 *
 * A named function rather than two reads in the body so the gate's input is one thing a caller
 * can replace, and so `TEST_MODE` is judged in exactly one place.
 */
function defaultEnvironment(): { kind: NodeEnvKind; testProcess: boolean } {
  return { kind: classifyNodeEnv(process.env.NODE_ENV), testProcess: isTestProcess() };
}

/**
 * Everything `startServer` reaches the outside world through, injectable so the
 * fail-fast, dev-leniency and readiness paths are exercised deterministically
 * without real sockets or process exits.
 *
 * `appInstance` is structural rather than `Express` for the same reason
 * `ShutdownServer` is: the only thing this module does with it is `listen`, and
 * a test fake supplies exactly that.
 */
type StartServerOptions = {
  appInstance?: { listen(port: number, callback: () => void): ShutdownServer };
  nodeEnv?: string;
  port?: number;
  connectFn?: () => unknown;
  closeFn?: () => unknown;
  validator?: () => ConfigProblem[];
  readiness?: () => IntegrationReport;
  exit?: (code: number) => void;
  logger?: Logger;
  signalTarget?: SignalTarget;
  shutdownTimeoutMs?: number;
  /**
   * 2026-10-23 security audit — `TRUST_PROXY` as a hop count, for the boot warning that a
   * PRODUCTION service behind a proxy has not declared it. Defaults to the live value;
   * injectable so a suite can pin the warning without rewriting the environment of a process
   * it did not start (the same reason `environment` is injectable).
   */
  proxyTrust?: number;
  probe?: (port: number) => Promise<PortProbeResult>;
  /**
   * What `NODE_ENV` says, and whether this declares itself a test process.
   *
   * Defaults to the live process. Injectable so a suite can pin every posture — missing,
   * mistyped, development, test — without rewriting the environment of a process it did not
   * start, which is what made an earlier version of this suite depend on the runner.
   */
  environment?: () => { kind: NodeEnvKind; testProcess: boolean };
  /**
   * AI-28 — the boot-time question "is the configured AI model still one the provider lists?"
   *
   * Injectable for the same reason the port probe is: a test must be able to answer it without a
   * network. `null` means "do not check", which is what `NODE_ENV=test` defaults to so the suite
   * never contacts a provider.
   */
  modelCheck?: (() => Promise<CatalogueResult>) | null;
  /**
   * AI-29 — the boot-time read of which models the provider DECLARES can call tools.
   *
   * Same contract as `modelCheck`: unawaited, non-fatal, and `null` means "do not read", which is
   * the `NODE_ENV=test` default so a suite never contacts a provider. It is free (no completion, so
   * no quota), and the turn loop reads the resulting cache synchronously to skip a fallback that
   * could never have grounded an answer.
   */
  capabilities?: (() => Promise<unknown>) | null;
  /**
   * AI-35 — the boot read that holds provider-reported-unavailable models out of selection.
   *
   * Same contract as `capabilities`: unawaited, non-fatal, free (endpoint GETs, no completion),
   * and `null` means "do not read", which is the `NODE_ENV=test` default so a suite never contacts
   * a provider. The watchdog repeats this reading on its schedule.
   */
  healthGate?: (() => Promise<unknown>) | null;
  /**
   * AI-34 — the scheduled model-health watchdog.
   *
   * `undefined` decides from `healthWatchEnabled(nodeEnv)` (production on, development/test
   * off) AND whether a model is configured; `null` disables it; a function is the test seam.
   * The watchdog only sends endpoint-health GETs, so starting it costs no completion quota.
   */
  healthWatch?: ((options: { nodeEnv: string; logger: Logger }) => HealthWatchHandle) | null;
};

/**
 * Boot the server.
 *
 * @param {object}  [options]
 * @param {object}  [options.appInstance]      Express app to listen on
 * @param {string}  [options.nodeEnv]          'production' enables fail-fast gating
 * @param {number}  [options.port]             listen port
 * @param {Function}[options.connectFn]        async DB connect (true/false or throws)
 * @param {Function}[options.closeFn]          async DB close (shutdown)
 * @param {Function}[options.validator]        () => [{ variable, message }]
 * @param {Function}[options.readiness]        () => IntegrationReport (boot line + warnings)
 * @param {Function}[options.exit]             default process.exit (inject to capture)
 * @param {object}  [options.logger]           { log, error }
 * @param {object}  [options.signalTarget]     default process
 * @param {number}  [options.shutdownTimeoutMs]graceful-shutdown grace period
 * @returns {Promise<{ server, shutdown, connected } | null>} null when production
 *          validation/connect failed (the process exits in real boots).
 */
export async function startServer({
  appInstance = app,
  nodeEnv = env.nodeEnv,
  port = env.port,
  connectFn = connectDatabase,
  closeFn = disconnectDatabase,
  validator = validateProductionConfig,
  readiness = integrationReport,
  exit,
  logger = console,
  signalTarget = process,
  shutdownTimeoutMs = env.shutdownTimeoutMs,
  proxyTrust = env.trustProxy,
  environment = defaultEnvironment,
  probe,
  modelCheck,
  capabilities,
  healthGate,
  healthWatch,
}: StartServerOptions = {}): Promise<{
  server: ShutdownServer;
  shutdown: ShutdownHandler;
  connected: boolean;
} | null> {
  const exitFn = exit || ((code: number) => process.exit(code));

  // A SERVER MUST STATE THE ENVIRONMENT IT SERVES, AND NOTHING INFERS IT.
  //
  // `NODE_ENV` decides three things at once: whether the production configuration checks run,
  // which database is selected, and whether error detail is released. A value this process cannot
  // name therefore does not fail at the thing it is wrong about — it boots happily into the
  // development posture and serves real traffic out of the development database with the
  // production checks switched off.
  //
  // So the refusal is host-independent and explicit: `production`, `development` or `test`, or a
  // process that declares `TEST_MODE` (which pins the test database and refuses to run as
  // production). Nothing about the platform is consulted — a deployment must not learn its
  // environment from a marker that happens to be set, because that would make the same mistake
  // fatal on one host and silent on another.
  //
  // The cost is deliberate: `npm start` without a `.env` now refuses with a one-variable fix
  // instead of starting on a guess. That guess is the thing this gate exists to delete.
  const stated = environment();
  if (!isRecognisedNodeEnv(stated.kind) && !stated.testProcess) {
    // The distinction is the diagnostic: a variable nobody set is fixed somewhere different from
    // one somebody mistyped. The VALUE is never echoed — a typo is an arbitrary string and this
    // line goes to logs.
    const which =
      stated.kind === 'missing'
        ? 'NODE_ENV is not set'
        : `NODE_ENV does not name one of ${KNOWN_NODE_ENVS.join(', ')}`;
    logger.error(
      `[config] refusing to start: ${which}, and a server must state the environment it serves — ` +
        'NODE_ENV decides the production configuration checks, the database and the error detail ' +
        'at once. Set NODE_ENV=production on a deployed service (development on a laptop); ' +
        'TEST_MODE is accepted for a test run only. Nothing was connected or served.'
    );
    exitFn(1);
    return null;
  }

  // H7 — production fail-fast on invalid configuration.
  if (nodeEnv === 'production') {
    const problems = validator();
    if (problems.length > 0) {
      for (const problem of problems) {
        logger.error(`[config] ${problem.message}`);
      }
      logger.error('[config] refusing to start in production with invalid configuration');
      exitFn(1);
      return null;
    }
  }

  // What this deployment IS, and what it cannot do — said once, before anything else is
  // attempted. Validation above refuses to boot on a configuration that is outright broken;
  // this reports the states that are legal, silent and unusable instead (see
  // config/deploymentReadiness.ts). It is deliberately a WARNING and never a failure: an
  // optional integration that cannot work degrades a feature, and refusing to boot over one
  // would turn that into a dead deployment on its next restart.
  const report = readiness();
  logger.log(deploymentLine(report));
  for (const note of deploymentNotes(report)) {
    logger.error(`[config] warning: ${note}`);
  }

  // 2026-10-23 security audit — the one readiness state that is about the HOST rather than an
  // integration: a production process whose per-IP limiters all share the proxy's address. It is
  // a warning for the same reason the notes above are (a degraded deployment keeps serving), but
  // it is emitted before the database is touched, next to the other warnings, because it is the
  // one an operator must not scroll past.
  const proxyNote = proxyTrustNote({ nodeEnv, trustProxy: proxyTrust });
  if (proxyNote) logger.error(`[config] warning: ${proxyNote}`);

  // H8 — connect before accepting traffic. Production treats a failed connect
  // as fatal (the app must never sit alive while every request 500s/buffers);
  // non-production stays reachable for diagnostics with readiness reporting
  // not-ready. connectDatabase logs failures in sanitized form.
  let connected = false;
  try {
    connected = (await connectFn()) === true;
  } catch (err) {
    if (nodeEnv === 'production') {
      // `${err && err.name ? err.name : 'Error'}`, narrowed. The original
      // interpolated into a template, which stringifies the branch it took, so
      // `String()` yields the same text for every value; the `err &&`
      // short-circuit is reproduced by the optional access.
      const name = (err as { name?: unknown } | null | undefined)?.name;
      logger.error(
        `[db] could not connect to MongoDB at startup (${name ? String(name) : 'Error'}) — exiting`
      );
      exitFn(1);
      return null;
    }
    // The message states what the connect actually did before giving up. In development
    // `connectDatabase` has already retried (3 attempts, 30 s bound each) because this host
    // measured 15.8 s to select; in test it made its single attempt. Either way, mongoose
    // does not retry a REJECTED initial connect, so a restart really is the remedy — the
    // sentence has to say so rather than pretend the process will recover on its own.
    logger.error(
      '[db] could not connect to MongoDB at startup, after every boot attempt — the API stays ' +
        'up for diagnostics, but readiness will report not ready and database requests will ' +
        'return 503. Restart once MongoDB is reachable.'
    );
  }

  type BootServer = {
    on?: (event: string, handler: (err: { code?: unknown; message?: unknown }) => void) => unknown;
    listening?: boolean;
    once?: (event: string, handler: () => void) => unknown;
    address?: () => unknown;
  };
  // Declared before `listen` because the listening callback may run inside it (a test fake calls it synchronously),
  // and filling in `server` afterwards is what lets that callback read the port actually bound.
  const bootRef: { server?: BootServer; listening: boolean } = { listening: false };

  const server = appInstance.listen(port, () => {
    // An ephemeral `0` becomes a real number here, and the boot line should name the port that was actually taken —
    // `localhost:0` tells an operator nothing, and this line is what a stale server imitates.
    const bound = boundPortOf(bootRef.server);
    bootRef.listening = true;
    logger.log(
      `[server] environment=${nodeEnv} listening on http://localhost:${bound ?? port} instance=${INSTANCE_ID}` +
        (connected ? '' : ' (MongoDB NOT connected — /api/health/ready reports not ready)')
    );
  });
  bootRef.server = server as unknown as BootServer;
  const bootServer = bootRef.server;

  // A port this process could not take at all is a boot failure, and it must read as one instead of as an
  // unhandled 'error' event.
  //
  // EADDRINUSE IS ALWAYS FATAL, INCLUDING AFTER THE 'listening' CALLBACK — measured on this host on 2026-10-18, and
  // the measurement is the whole reason that clause exists. The second boot printed `listening on
  // http://localhost:4011 instance=521c…` (its listening callback really did fire), and the EADDRINUSE error
  // arrived AFTERWARDS; treating "already listening" as proof of serving let that process stay up for 30 s as a
  // zombie with no working listener — precisely the trap this guard exists to prevent, wearing the guard's own
  // exemption. A port that cannot be taken is never a normal runtime event, so its code is decisive.
  //
  // Other codes remain non-fatal once the socket is listening: killing a server that is genuinely serving over a
  // stray socket error would be its own defect, so they are logged and the process keeps running.
  if (bootServer && typeof bootServer.on === 'function') {
    bootServer.on('error', (err) => {
      const code = err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
      if (code === 'EADDRINUSE') {
        logger.error(
          `[server] port ${port} is already in use — refusing to start. Find the owner with ` +
            `netstat -ano | findstr :${port} (or lsof -nP -iTCP:${port} -sTCP:LISTEN) and stop it.`
        );
        exitFn(1);
        return;
      }
      if (bootRef.listening) {
        logger.error(`[server] the HTTP server reported an error after it was listening (${code}).`);
        return;
      }
      logger.error(`[server] the HTTP server could not start (${code}) — refusing to start.`);
      exitFn(1);
    });
  }

  // AI-28 — the model check, fired unawaited for the same reason the port guard is: a boot must not
  // wait on an outbound request, and a wrong model is a warning rather than a reason to refuse to
  // start. It was added after every assistant turn failed with `model=unknown` and nothing in the
  // deployment said which model — the id is the one fact an operator needs when the assistant stops
  // answering, and this is the earliest place it can be questioned.
  //
  // `NODE_ENV=test` defaults to no check at all: a unit suite must not reach a provider, and a
  // check that silently spent a free-tier request per test file would be a cost, not a guard.
  const resolvedModelCheck = modelCheck === undefined ? (nodeEnv === 'test' ? null : checkModelCatalogue) : modelCheck;
  if (resolvedModelCheck) {
    void (async () => {
      const result = await resolvedModelCheck();
      // ONLY a model the provider does not list is worth a line. `unreachable` means the check could
      // not run, which is not evidence of anything and would train an operator to ignore the line.
      if (result?.status === 'missing') {
        logger.error(`[config] warning: ${result.message}`);
      }
    })().catch(() => {
      // A check that cannot run must never be the reason a server is down.
    });
  }

  // AI-29 — the fallback capability map, fired unawaited next to the model check and for the same
  // reason: a boot must not wait on an outbound request. A candidate the catalogue says cannot call
  // tools is skipped by the turn loop instead of being spent on, and the ONE thing worth a boot line
  // is a configured fallback that is in that state — it is otherwise discovered only on the day the
  // primary breaks, which is the worst possible day to learn it.
  const resolvedCapabilities =
    capabilities === undefined ? (nodeEnv === 'test' ? null : refreshModelCapabilities) : capabilities;
  if (resolvedCapabilities) {
    void (async () => {
      const status = await resolvedCapabilities();
      // `unreachable` is silence: it says nothing about any model, and a line that fires when the check
      // could not run trains an operator to ignore the line that matters.
      if (status !== 'ok') return;
      const ai = aiConfig();
      const unusable = ai.fallbackModels.filter(
        (id) => id !== ai.openrouterModel && declaresToolSupport(id) === false,
      );
      if (unusable.length > 0) {
        logger.error(
          `[config] warning: fallback model(s) declare no tool support and will be skipped: ${unusable.join(', ')}`,
        );
      }
    })().catch(() => {
      // A capability read that cannot run must never be the reason a server is down.
    });
  }

  // AI-35 — and the health reading that decides which models a turn may start on.
  //
  // A cold process used to try the configured model first even when the provider was publishing
  // that model's endpoint as down: up to five refused requests (a tenth of a free tier's daily
  // allowance) before AI-30's cooldown opened, all inside a member's turn. This read is free — a
  // `GET`, no completion — so it runs at boot like the catalogue check, and the watchdog replaces
  // it every cycle. It can never stop the server, and it never marks a model on a failed reading.
  const resolvedHealthGate =
    healthGate === undefined
      ? nodeEnv === 'test'
        ? null
        : () => refreshModelHealthGate({ ttlMs: aiConfig().modelHealthTtlMs })
      : healthGate;
  if (resolvedHealthGate) {
    void (async () => {
      await resolvedHealthGate();
    })().catch(() => {
      // A reading that cannot run must never be the reason a server is down.
    });
  }

  // AI-34 — the scheduled model-health watchdog. Fired only after the process is up, and only
  // when a model is actually configured: a deployment without AI must not contact a provider on a
  // timer. It is unattended, so a failure to start is logged and the server keeps serving.
  const ai = aiConfig();

  // AI-39 — the configuration is stated ONCE, in the boot log, in the words the turn loop will
  // act on. Two silences made this necessary: a list longer than the five-model cap was truncated
  // without a word (so a pasted candidate looked configured and was never tried), and the
  // effective order existed only in `.env` and in a source file. Neither line is a refusal —
  // configuration problems never stop a server — and neither contacts a provider.
  if (ai.openrouterModel) {
    logger.log(`[ai] chain order: ${[ai.openrouterModel, ...ai.fallbackModels].join(' -> ')}`);
  }
  // AI-100 — state the free-model policy once at boot. The per-turn line and the
  // per-request provider line prove the policy actually applied; this one lets an
  // operator verify a Render environment change before a member asks a question.
  logger.log(
    `[ai] free-model reasoning: ${reasoningState(ai.reasoning.freePolicy)}` +
      ` (${ai.reasoning.freeSource === 'AI_REASONING_FREE_MODELS' ? 'AI_REASONING_FREE_MODELS' : 'default'})`,
  );
  logger.log(
    `[ai] paid-model reasoning: ${
      ai.reasoning.simplePolicy ? reasoningState(ai.reasoning.simplePolicy) : 'advanced'
    } (${ai.reasoning.paidSource === 'advanced' ? 'advanced rules' : ai.reasoning.paidSource})`,
  );
  if (ai.reasoning.paidSource === 'AI_REASONING') {
    logger.error('[config] warning: AI_REASONING is deprecated; rename it to AI_REASONING_PAID_MODELS.');
  }
  for (const problem of [ai.reasoning.simpleProblem, ai.reasoning.freeProblem]) {
    if (problem) logger.error(`[config] warning: ${problem}`);
  }
  // AI-85 — say when the opt-in web tools are on, and name an invalid switch
  // without ever enabling it. These are configuration lines, not refusals: the
  // server still serves inventory turns with the safe disabled value.
  if (ai.webProblems.length > 0) {
    logger.error(`[config] warning: ${ai.webProblems.map((problem) => problem.message).join(' ')}`);
  }
  if (ai.webSearchEnabled || ai.webFetchEnabled) {
    const enabled = [
      ai.webSearchEnabled ? 'search' : null,
      ai.webFetchEnabled ? 'fetch' : null,
    ].filter(Boolean);
    logger.log(`[ai] web tools enabled: ${enabled.join(', ')}`);
  }
  if (ai.fallbackModelsIgnored.length > 0) {
    logger.error(
      `[config] warning: AI_FALLBACK_MODELS_OPENROUTER lists more than ${ai.fallbackModels.length}` +
        ` model(s); only the first ${ai.fallbackModels.length} are used, so these are ignored: ` +
        ai.fallbackModelsIgnored.join(', '),
    );
  }

  const wantsHealthWatch =
    healthWatch === undefined
      ? healthWatchEnabled(nodeEnv) && ai.provider === 'openrouter' && Boolean(ai.openrouterModel)
      : healthWatch !== null;
  let healthWatchHandle: HealthWatchHandle | null = null;
  if (wantsHealthWatch) {
    try {
      const start = healthWatch ?? startAiHealthWatch;
      healthWatchHandle = start({ nodeEnv, logger });
      const schedule = healthWatchConfig();
      const intervalMinutes = Math.max(1, Math.round(schedule.intervalMs / 60000));
      const alertsByEmail = Boolean(process.env.AI_HEALTH_ALERT_EMAIL) && report.mail;
      logger.log(
        `[ai:watchdog] scheduled every ${intervalMinutes}m; first check in ` +
          `${Math.max(0, Math.round(schedule.initialDelayMs / 1000))}s; ` +
          (alertsByEmail ? 'alerts emailed to the configured recipient' : 'alerts logged only'),
      );
    } catch {
      logger.error('[ai:watchdog] the model-health watchdog could not start; the assistant is still served.');
    }
  }

  // The port-ownership guard (2026-10-18). Fired unawaited, after the socket is listening, because a boot must
  // not wait on a loopback round trip; it exits the process only on the one unambiguous outcome (another
  // instance answering), and is silent when this process is provably the owner.
  void (async () => {
    await waitForListening(bootRef.server ?? {});
    await verifyBoundPort({
      server: bootServer,
      logger,
      exit: exitFn,
      ...(probe ? { probe } : {}),
    });
  })().catch(() => {
    // A guard that cannot run must never be the reason a server is down.
  });

  // M2 — bounded, idempotent graceful shutdown.
  const shutdown = createShutdownHandler({
    server,
    closeDatabase: closeFn,
    timeoutMs: shutdownTimeoutMs,
    logger,
    exit: exitFn,
  });
  // Stop the watchdog before the drain. Its timers are unref'd, so this is hygiene rather than
  // the thing that lets the process exit, but a stopped scheduler cannot start a health request
  // while the database is closing.
  const shutdownWithWatch: ShutdownHandler = (signal) => {
    healthWatchHandle?.stop();
    healthWatchHandle = null;
    return shutdown(signal);
  };
  registerSignalHandlers(signalTarget, shutdownWithWatch);

  return { server, shutdown: shutdownWithWatch, connected };
}

/**
 * Resolve once the server is listening.
 *
 * The guard needs `address()`, which is null until the socket binds, and the boot must not block on the loopback
 * probe, so this is awaited inside the unawaited guard rather than in the boot path. A server that already reports
 * `listening` resolves immediately; one that never becomes listening (a fake) simply never probes, which is the
 * same outcome as having no bound address.
 */
function waitForListening(server: { listening?: boolean; once?: (e: string, h: () => void) => unknown }) {
  if (server.listening === true) return Promise.resolve();
  if (typeof server.once !== 'function') return Promise.resolve();
  return new Promise<void>((resolve) => server.once!('listening', resolve));
}

export default { startServer };
