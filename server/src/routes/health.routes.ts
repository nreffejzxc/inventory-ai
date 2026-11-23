import { Router, type Request, type Response } from 'express';

import env from '../config/env.ts';
import { buildInfo } from '../config/deploymentReadiness.ts';
import { getDatabaseState, isDatabaseReady } from '../config/db.ts';
import { operationalCounters } from '../config/operationalCounters.ts';
import { readIntegrityHeartbeat } from '../services/integrityHeartbeat.service.ts';
import { checkRequiredIndexes } from '../config/indexReadiness.ts';
import { exchangeRateAvailability } from '../services/ai/exchangeRates.ts';

/**
 * Health endpoints (Phase 07D / M1). Three complementary signals:
 *
 *   GET /api/health        (legacy, unchanged) 200 always — process is up and
 *                          reports the current database state for observability.
 *                          It is a liveness signal, NOT a readiness gate.
 *                          Since 2026-10-15 it also reports WHICH BUILD is
 *                          answering — the deployed commit and the process
 *                          uptime.
 *   GET /api/health/live   200 always — process is alive. Never consults MongoDB.
 *   GET /api/health/ready  200 only when MongoDB is reachable right now AND the
 *                          six exact required indexes are present: the transfer
 *                          ledger, Draft PO request key and audit dedupe unique
 *                          guards, the DELIVERED outbox TTL, and the movement and
 *                          PO receive audit-repair indexes. Otherwise 503. This is
 *                          the operational readiness gate a load balancer /
 *                          orchestrator should poll.
 *
 * None of these expose the MongoDB URI, credentials, driver internals, or stack
 * traces. `/ready` performs bounded `listIndexes` reads after the driver's
 * connection check, so a reachable database missing any required write or
 * audit-maintenance index cannot be mistaken for a ready deployment. It never
 * creates or repairs an index.
 *
 * OPS-2 — WHY `/api/health` ALSO CARRIES COUNTERS, AND WHY THE OTHER TWO DO NOT.
 *
 * Liveness and readiness answer a question about the process and the database; neither can say
 * whether requests are **succeeding**. Nothing outside the hosting dashboard could, which left
 * "is it failing right now?" answerable only by reading logs a person had to go and read. The
 * legacy endpoint publishes the counts since boot — total responses, by status class, and the 5xx
 * count with the time of the most recent one — so an uptime watcher can alert on the second
 * consecutive 5xx rather than on the process merely being up. It is the same endpoint and the same
 * exposure class as the commit id already published there, for the same reason: it identifies
 * behaviour, not people. No path, no identifier, no duration and no message is published, and
 * `/live` and `/ready` stay exactly what they were — a dependency-free probe and a gate.
 *
 * WHY THE LEGACY ENDPOINT CARRIES A COMMIT ID, AND WHY NOTHING ELSE DOES.
 *
 * The question "is the deployed build the one I just merged?" had no answer from outside the
 * hosting dashboard, and this project has already paid for a stale-build assumption twice —
 * once when a device run was measuring an old bundle until a reload was produced (§27CE), and
 * once when a healthy-looking service was inferred to be routing somewhere it was not
 * (§27CE's correction). A commit id is not a credential, not a host name, not a tenant and
 * not a configuration value: it identifies a build, and it is published **only** here.
 *
 * WHY THE LEGACY ENDPOINT ALSO NAMES THE POSTURE. The commit id answers "which build is this?";
 * the posture answers "which environment does it think it is?" — and those are different
 * questions. A service deployed with `NODE_ENV=development` in its environment boots happily,
 * validates nothing, and writes to the development database; from outside, it looks healthy. One
 * word on the same endpoint that already identifies the build makes that state observable without
 * reading the host's dashboard, and it is a posture name, never a value from the environment.
 *
 * The narrow scope is deliberate. `/ready` stays a gate that reports readiness and nothing
 * else, `/live` stays dependency-free, and the deployment's *integration* state (which
 * optional services are configured) is deliberately NOT published: those states are already
 * observable, precisely and per-flow, by the callers they affect (`503 MAIL_NOT_CONFIGURED`),
 * and a public inventory of what a server has switched on would widen the surface for
 * convenience alone. The boot line in `config/deploymentReadiness.ts` states it to the
 * operator instead, where it belongs.
 */
function timestamp() {
  return new Date().toISOString();
}

/**
 * Build a health router. Defaults read the real MongoDB connection state; tests
 * inject stubs to exercise the 200/503 readiness branches deterministically
 * without a database.
 *
 * @param {object} [options]
 * @param {() => string} [options.getState]     Human-readable db state
 * @param {() => boolean} [options.isReady]     true when MongoDB is reachable
 * @param {() => {commit: string, uptimeSeconds: number}} [options.build]
 *        Which build is answering (commit + process uptime). Injectable for
 *        the same reason the database state is: a suite pins both halves
 *        without depending on the environment it runs in.
 * @param {() => object} [options.counters]
 *        The OPS-2 response counters. Injectable so a suite can pin the payload
 *        shape without manufacturing traffic, and so the number it asserts on is
 *        the number the route published rather than one it counted itself.
 * @param {() => string} [options.environment]
 *        The posture this process serves in — `production`, `development` or
 *        `test` (`config/env.ts` never yields anything else to a booted server).
 *        Published on the legacy endpoint for the same reason as the commit id:
 *        "is the deployed process actually in the posture I configured?" had no
 *        answer from outside the host, and a deployment silently serving from
 *        the development database is exactly the fault that question catches.
 *        It is a posture name, never a value from the environment.
 * @param {() => Promise<IntegrityHeartbeatView>} [options.readIntegrity]
 *        The hosted freshness signal. Injectable so the 200/503 branches can be
 *        pinned without writing a heartbeat or waiting for a scheduled task.
 * @param {() => Promise<{ready: boolean, failures: Array<{name: string, reason: string}>}>} [options.checkIndexes]
 *        Fail-closed required-index readiness. Injectable so the route can be
 *        pinned against a missing/incorrect index without a database.
 * @param {() => ExchangeRateAvailability} [options.exchangeRates]
 *        Process-local exchange-rate availability. Published on the legacy
 *        endpoint as inert operational context; it is never a readiness input.
 */
export function createHealthHandlers({
  getState = getDatabaseState,
  isReady = isDatabaseReady,
  build = buildInfo,
  counters = operationalCounters,
  environment = () => env.nodeEnv,
  readIntegrity = readIntegrityHeartbeat,
  checkIndexes = checkRequiredIndexes,
  exchangeRates = exchangeRateAvailability,
} = {}) {
  return {
    // Legacy liveness + db state (kept for compatibility).
    health(_req: Request, res: Response) {
      const { commit, uptimeSeconds } = build();
      res.status(200).json({
        status: 'ok',
        db: getState(),
        environment: environment(),
        commit,
        uptimeSeconds,
        counters: counters(),
        // The same exposure class as the response counters: aggregate process
        // state, no tenant, request, URL or credential. An ECB failure must not
        // make /ready fail, so this is observation only.
        exchangeRates: exchangeRates(),
        timestamp: timestamp(),
      });
    },

    // Liveness: the process is up. No database involvement.
    live(_req: Request, res: Response) {
      res.status(200).json({ status: 'live', timestamp: timestamp() });
    },

    // Readiness: MongoDB reachable AND the required ledger guard present?
    async ready(_req: Request, res: Response) {
      if (!isReady()) {
        return res.status(503).json({
          status: 'not ready',
          db: getState(),
          timestamp: timestamp(),
        });
      }

      let indexReadiness;
      try {
        const result = await checkIndexes();
        if (!result || typeof result.ready !== 'boolean' || !Array.isArray(result.failures)) {
          throw new Error('invalid required-index readiness result');
        }
        indexReadiness = result;
      } catch {
        indexReadiness = {
          ready: false,
          failures: [{ name: 'required-indexes', reason: 'the required index check could not run' }],
        };
      }
      if (!indexReadiness.ready) {
        return res.status(503).json({
          status: 'not ready',
          db: getState(),
          reason:
            indexReadiness.failures.map((failure) => failure.reason).join('; ') ||
            'a required database index is missing or incorrect',
          timestamp: timestamp(),
        });
      }
      return res.status(200).json({
        status: 'ready',
        db: getState(),
        timestamp: timestamp(),
      });
    },

    // Hosted freshness: is the laptop-based audit still reporting? The endpoint
    // is public because it is a monitor target, but it publishes only the audit's
    // freshness and aggregate counts — no tenant, product, location or user data.
    // A missing, malformed, stale or NOT CHECKED heartbeat is a 503 on purpose:
    // an uptime monitor must be able to treat it as an incident with no parsing.
    async integrity(_req: Request, res: Response) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const heartbeat = await readIntegrity();
        return res.status(heartbeat.fresh ? 200 : 503).json({
          ...heartbeat,
          timestamp: timestamp(),
        });
      } catch {
        return res.status(503).json({
          state: 'not_checked',
          fresh: false,
          lastCheckedAt: null,
          ageSeconds: null,
          maxAgeSeconds: null,
          auditStatus: null,
          newCount: 0,
          resolvedCount: 0,
          scannedStockIns: null,
          timestamp: timestamp(),
        });
      }
    },
  };
}

/**
 * The canonical four-route health router. `createHealthHandlers` is separate so
 * the backward-compatible bare `/health` and `/ready` aliases in `app.ts` use the
 * exact same handlers rather than a second implementation.
 */
export function createHealthRouter(
  options: Parameters<typeof createHealthHandlers>[0] = {},
) {
  const router = Router();
  const handlers = createHealthHandlers(options);
  router.get('/', handlers.health);
  router.get('/live', handlers.live);
  router.get('/ready', handlers.ready);
  router.get('/integrity', handlers.integrity);
  return router;
}

const router = createHealthRouter();

export default router;
