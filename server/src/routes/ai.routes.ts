import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import aiController from '../controllers/ai.controller.ts';
import { aiRateLimiter } from '../services/ai/rateLimiter.ts';
import { aiSingleFlight } from '../services/ai/singleFlight.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

// Chat is the only cost-bearing route, so it is rate-limited per user.
router.post('/chat', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiRateLimiter, aiSingleFlight, aiController.sendMessage);

// AI-102 — aggregate turn metrics. Internal operational data, so it binds the
// ai.metrics.view capability, held only by OWNER and ADMIN; the controller scopes every
// aggregation to req.user.businessId.
router.get('/metrics', requireAuth, requirePermission(PERMISSIONS.AI_METRICS_VIEW), aiController.metrics);

// AI-115 — a member rates one stored assistant answer. The body names the answer
// and the opinion only; business, member and turn are derived server-side.
router.post('/feedback', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.submitFeedback);

// AI-115 — the review queue for the owner/admin who can already read AI quality
// data. It returns bounded excerpts of the reported question and answer, never a
// member's whole conversation.
router.get('/feedback', requireAuth, requirePermission(PERMISSIONS.AI_METRICS_VIEW), aiController.listFeedback);
// AI-117 — the explicit full-answer view behind one report. The queue stays
// excerpt-only; this read is the bounded expansion an OWNER/ADMIN needs before
// marking the report reviewed.
router.get('/feedback/:id/conversation', requireAuth, requirePermission(PERMISSIONS.AI_METRICS_VIEW), aiController.feedbackConversation);
router.patch('/feedback/:id', requireAuth, requirePermission(PERMISSIONS.AI_METRICS_VIEW), aiController.reviewFeedback);

// Conversation/message retrieval.
router.get('/conversations', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.listConversations);
router.post('/conversations', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.createConversation);
router.get('/conversations/:id/messages', requireAuth, requirePermission(PERMISSIONS.AI_USE), aiController.listMessages);

export default router;
