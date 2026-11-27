import type { Response } from 'express';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import {
  getAuditOutboxReport,
  getIntegrityReport,
  getReadinessReport,
} from '../services/platformSignals.service.ts';

/**
 * Read-only operational signals.
 *
 * Three endpoints, all behind `platform.metrics.read`, and none of them changes
 * anything: no index is created, no outbox row is retried and no monitor file is
 * written. Each records one audit read entry with counts, never row contents.
 */

function actor(req: PlatformRequest) {
  return {
    adminId: req.platformAdmin!.id,
    email: req.platformAdmin!.email,
    role: req.platformAdmin!.role,
  };
}

const platformSignalsController = {
  async integrity(req: PlatformRequest, res: Response) {
    const report = await getIntegrityReport();
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.INTEGRITY_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.metrics.read',
      metadata: {
        heartbeatState: report.heartbeat.view?.state ?? 'unavailable',
        hostAvailable: report.host.available,
        historyRows: report.history.length,
        newCount: report.latest?.comparison.newCount ?? null,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },

  async readiness(req: PlatformRequest, res: Response) {
    const report = await getReadinessReport();
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.READINESS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.metrics.read',
      metadata: { ready: report.ready, failures: report.failures.map((failure) => failure.name) },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },

  async auditOutbox(req: PlatformRequest, res: Response) {
    const report = await getAuditOutboxReport();
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.OUTBOX_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.metrics.read',
      metadata: { available: report.available, pending: report.counts.pending, failed: report.counts.failed },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },
};

export default platformSignalsController;
