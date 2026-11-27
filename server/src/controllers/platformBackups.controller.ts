import type { Response } from 'express';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import {
  PlatformBackupError,
  deleteArchive,
  getBackupReport,
  startBackupRun,
  updateSchedule,
} from '../services/platformBackups.service.ts';

/**
 * The backup surface of the internal console.
 *
 * Every route here is mounted behind `requirePlatformAdmin` and a capability:
 * reading the report needs `platform.metrics.read`, while running, rescheduling
 * and deleting need `platform.admin.manage` (SUPERADMIN). Deletion additionally
 * requires a fresh step-up proof, because it removes a recovery point.
 *
 * The service owns every path decision; this controller only validates shape,
 * records the audit entry and never echoes a filesystem error verbatim.
 */

function actor(req: PlatformRequest) {
  return {
    adminId: req.platformAdmin!.id,
    email: req.platformAdmin!.email,
    role: req.platformAdmin!.role,
  };
}

function fail(res: Response, error: unknown) {
  if (error instanceof PlatformBackupError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(`[platform-backups] ${(error as Error)?.message}`);
  return res.status(500).json({ error: 'The backup operation failed.', code: 'PLATFORM_BACKUP_FAILED' });
}

const platformBackupsController = {
  async list(req: PlatformRequest, res: Response) {
    let report;
    try {
      report = await getBackupReport();
    } catch (error) {
      return fail(res, error);
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.BACKUPS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.metrics.read',
      metadata: { archives: report.archives.length, hostAvailable: report.host.available },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },

  async run(req: PlatformRequest, res: Response) {
    let result;
    try {
      result = await startBackupRun();
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.BACKUP_RUN_STARTED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        reason: error instanceof PlatformBackupError ? error.code : 'backup_run_failed',
        req,
      });
      return fail(res, error);
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.BACKUP_RUN_STARTED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: { started: result.started, alreadyRunning: result.alreadyRunning },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(result.started ? 202 : 200).json(result);
  },

  async schedule(req: PlatformRequest, res: Response) {
    const body = (req.body ?? {}) as { time?: unknown; archiveDir?: unknown; copyDir?: unknown };
    let report;
    try {
      report = await updateSchedule(
        {
          time: String(body.time ?? ''),
          archiveDir: String(body.archiveDir ?? ''),
          copyDir: String(body.copyDir ?? ''),
        },
        req.platformAdmin!.email,
      );
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.BACKUP_SCHEDULE_UPDATED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        reason: error instanceof PlatformBackupError ? error.code : 'backup_schedule_failed',
        req,
      });
      return fail(res, error);
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.BACKUP_SCHEDULE_UPDATED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: {
        time: report.schedule.time,
        archiveDir: report.host.archiveDir,
        copyDir: report.host.copyDir,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },

  async remove(req: PlatformRequest, res: Response) {
    const name = String(req.params.name ?? '');
    let result;
    try {
      result = await deleteArchive(name);
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.BACKUP_DELETED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        reason: error instanceof PlatformBackupError ? error.code : 'backup_delete_failed',
        metadata: { name: name.slice(0, 120) },
        req,
      });
      return fail(res, error);
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.BACKUP_DELETED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.admin.manage',
      metadata: result,
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  },
};

export default platformBackupsController;
