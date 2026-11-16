import type { Response } from 'express';

import env from '../config/env.ts';
import { buildInfo } from '../config/deploymentReadiness.ts';
import { getDatabaseState } from '../config/db.ts';
import { operationalCounters } from '../config/operationalCounters.ts';
import { parseOperationsDays } from '../services/operations.service.ts';
import { getPlatformOperationsSummary } from '../services/platformOperations.service.ts';
import { getPlatformMonitoringExtras } from '../services/platformMonitoring.service.ts';
import { getPlatformInfrastructure } from '../services/platformInfrastructure.service.ts';
import { throwValidation } from '../utils/errors.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';

/**
 * GET /api/platform/operations -> the platform-wide operations report.
 *
 * The route is mounted at `/api/platform`, requires `requirePlatformAdmin` and
 * `platform.metrics.read`, and accepts NO tenant selector. `?days=` is the only
 * input, bounded to 1–30. The business scope is not read from the request at all
 * — the report is the whole platform by construction.
 *
 * `service` is process/build context already public on `/api/health`; it is
 * repeated so the console can show which build and database produced the report.
 * The response is no-store because it describes internal reliability and usage.
 */
const platformOperationsController = {
  /** Health-only read for READ_ONLY auditors; contains no cross-tenant metrics. */
  async status(_req: PlatformRequest, res: Response) {
    const build = buildInfo();
    const counters = operationalCounters();
    const infrastructure = await getPlatformInfrastructure();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      metricsAvailable: false,
      service: {
        status: 'ok',
        database: getDatabaseState(),
        environment: env.nodeEnv,
        commit: build.commit,
        uptimeSeconds: build.uptimeSeconds,
        counters: {
          responsesSinceBoot: counters.responses,
          serverErrorsSinceBoot: counters.serverErrors,
          lastServerErrorAt: counters.lastServerErrorAt,
        },
      },
      infrastructure,
    });
  },

  async summary(req: PlatformRequest, res: Response) {
    const parsed = parseOperationsDays(req.query.days);
    if (parsed.problem) throwValidation([{ field: 'days', message: parsed.problem }]);

    const [report, extras, infrastructure] = await Promise.all([
      getPlatformOperationsSummary({ days: parsed.days }),
      getPlatformMonitoringExtras({ days: parsed.days }),
      getPlatformInfrastructure(),
    ]);
    const build = buildInfo();
    const counters = operationalCounters();

    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.OPERATIONS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: {
        adminId: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
      capability: 'platform.metrics.read',
      metadata: { days: parsed.days },
      req,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...report,
      metricsAvailable: true,
      platform: {
        ...report.platform,
        businesses: {
          ...report.platform.businesses,
          newInWindow: extras.businesses.newInWindow,
        },
      },
      support: extras.support,
      inventory: extras.inventory,
      security: extras.security,
      infrastructure,
      service: {
        status: 'ok',
        database: getDatabaseState(),
        environment: env.nodeEnv,
        commit: build.commit,
        uptimeSeconds: build.uptimeSeconds,
        counters: {
          responsesSinceBoot: counters.responses,
          serverErrorsSinceBoot: counters.serverErrors,
          lastServerErrorAt: counters.lastServerErrorAt,
        },
      },
    });
  },
};

export default platformOperationsController;
