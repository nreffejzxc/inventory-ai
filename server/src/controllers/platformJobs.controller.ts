import type { Response } from 'express';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import {
  PlatformJobError,
  getJobsReport,
  rescheduleJob,
  setJobEnabled,
} from '../services/platformJobs.service.ts';

/**
 * Background jobs: monitoring plus three narrowly scoped management actions.
 *
 * Reading needs `platform.metrics.read`. Enabling, disabling and rescheduling a
 * Windows Scheduled Task need `platform.admin.manage` (SUPERADMIN), and enabling
 * or disabling additionally needs a fresh step-up proof: both change what runs
 * unattended on the operation machine.
 *
 * No route here registers a task. A task that is not registered is reported as
 * not registered; making it exist is a deliberate run of its own script by an
 * operator, not a side effect of this console.
 */

function actor(req: PlatformRequest) {
  return {
    adminId: req.platformAdmin!.id,
    email: req.platformAdmin!.email,
    role: req.platformAdmin!.role,
  };
}

function fail(res: Response, error: unknown) {
  if (error instanceof PlatformJobError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(`[platform-jobs] ${(error as Error)?.message}`);
  return res.status(500).json({ error: 'The job operation failed.', code: 'PLATFORM_JOB_FAILED' });
}

const platformJobsController = {
  async list(req: PlatformRequest, res: Response) {
    let report;
    try {
      report = await getJobsReport();
    } catch (error) {
      return fail(res, error);
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.JOBS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.metrics.read',
      metadata: {
        hostAvailable: report.host.available,
        ready: report.summary.ready,
        disabled: report.summary.disabled,
        missing: report.summary.missing,
        unknown: report.summary.unknown,
      },
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(report);
  },

  async enable(req: PlatformRequest, res: Response) {
    const id = String(req.params.id ?? '');
    try {
      const report = await setJobEnabled(id, true);
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_ENABLED,
        outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id },
        req,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(report);
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_ENABLED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id, code: error instanceof PlatformJobError ? error.code : 'PLATFORM_JOB_FAILED' },
        req,
      });
      return fail(res, error);
    }
  },

  async disable(req: PlatformRequest, res: Response) {
    const id = String(req.params.id ?? '');
    try {
      const report = await setJobEnabled(id, false);
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_DISABLED,
        outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id },
        req,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(report);
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_DISABLED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id, code: error instanceof PlatformJobError ? error.code : 'PLATFORM_JOB_FAILED' },
        req,
      });
      return fail(res, error);
    }
  },

  async schedule(req: PlatformRequest, res: Response) {
    const id = String(req.params.id ?? '');
    const time = String((req.body as { time?: unknown } | undefined)?.time ?? '');
    try {
      const report = await rescheduleJob(id, time, req.platformAdmin!.email);
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_RESCHEDULED,
        outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id, time },
        req,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(report);
    } catch (error) {
      await recordPlatformAudit({
        action: PLATFORM_AUDIT_ACTIONS.JOB_RESCHEDULED,
        outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
        actor: actor(req),
        capability: 'platform.admin.manage',
        metadata: { job: id, time, code: error instanceof PlatformJobError ? error.code : 'PLATFORM_JOB_FAILED' },
        req,
      });
      return fail(res, error);
    }
  },
};

export default platformJobsController;
