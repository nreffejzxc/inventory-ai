import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import aiController from '../controllers/ai.controller.ts';
import { aiRateLimiter } from '../services/ai/rateLimiter.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

// Chat is the only cost-bearing route, so it is rate-limited per user.
router.post('/chat', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiRateLimiter, aiController.sendMessage);

// AI-102 — aggregate turn metrics. Internal operational data, so it binds the
// ai.metrics.view capability, held only by OWNER and ADMIN; the controller scopes every
// aggregation to req.user.businessId.
router.get('/metrics', requireAuth, requirePermission(PERMISSIONS.AI_METRICS_VIEW), aiController.metrics);

// Conversation/message retrieval.
router.get('/conversations', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.listConversations);
router.post('/conversations', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.createConversation);
router.get('/conversations/:id/messages', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.listMessages);

export default router;
