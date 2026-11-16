import type { Response } from 'express';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { buildInfo } from '../config/deploymentReadiness.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import { listPlatformDeployments } from '../services/platformDeployments.service.ts';
import { throwValidation } from '../utils/errors.ts';

const platformDeploymentsController = {
  async list(req: PlatformRequest, res: Response) {
    const rawLimit = req.query.limit === undefined ? 25 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      throwValidation([{ field: 'limit', message: 'limit must be an integer from 1 to 100' }]);
    }
    const build = buildInfo();
    const deployments = await listPlatformDeployments(rawLimit);
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.DEPLOYMENTS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: {
        adminId: req.platformAdmin!.id,
        email: req.platformAdmin!.email,
        role: req.platformAdmin!.role,
      },
      capability: 'platform.deployments.read',
      metadata: { returned: deployments.length },
      req,
    });
    return res.status(200).json({
      current: {
        commit: build.commit,
        uptimeSeconds: build.uptimeSeconds,
        environment: process.env.NODE_ENV || 'unknown',
        nodeVersion: process.version,
      },
      deployments,
      note: 'History records observed process boots after this console was enabled; failed builds before boot are not observable from the application.',
    });
  },
};

export default platformDeploymentsController;