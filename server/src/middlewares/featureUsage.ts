import type { NextFunction, Request, Response } from 'express';

import { featureForPath, recordFeatureUse } from '../services/operations.service.ts';

type AuthenticatedRequest = Request & {
  user?: { id?: string; businessId?: string };
};

/**
 * OPS-8 — record a member's successful use of a tracked feature.
 *
 * The listener runs on `finish`, after the response is sent, so this can never
 * delay or change a response. `req.user` is populated by `requireAuth` inside
 * the route, and the request object is still reachable when the response
 * finishes; a public or refused request has no user and records nothing.
 *
 * Only 2xx/3xx responses count. A 403 is not adoption of a feature, and a 500 is
 * already recorded as an operations error.
 */
export default function recordFeatureUsage(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  // Capture the feature BEFORE routing. Express restores `req.url` to `/` while
  // unwinding a mounted router, so reading `req.path` inside the `finish` listener
  // lost every successful request (the 401/403 path still looked right because
  // routing never reached a router). `originalUrl` is stable at entry.
  const feature = featureForPath(req.originalUrl || req.path || '');
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const userId = req.user?.id;
    const businessId = req.user?.businessId;
    if (!userId || !businessId || !feature) return;
    void recordFeatureUse({ businessId, userId, feature, at: new Date() });
  });
  next();
}
