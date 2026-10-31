import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import { purchaseOrdersController } from '../controllers/purchase-orders.controller.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

// Reads: purchase-orders.view, which every role holds (Phase 22 — the binding is
// now explicit and guarded rather than implied by requireAuth alone). Mutations:
// purchase-orders.manage (OWNER, ADMIN, MANAGER) for create/edit/issue/cancel.
// STAFF may view and (Phase 13C) receive — receiving is its own permission key
// so it is provably distinct from managing the order.
router.get('/', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW), purchaseOrdersController.list);
// Creating an order and receiving one are the two writes that leave a durable
// document behind and can move stock. A retried delivery carrying the same
// `Idempotency-Key` replays the first answer instead of creating a second DRAFT or
// a second receipt; a request without the header is untouched.
router.post('/', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE), idempotent(), purchaseOrdersController.create);
router.get('/:id', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW), purchaseOrdersController.get);
router.patch('/:id', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE), purchaseOrdersController.update);
router.post('/:id/issue', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE), purchaseOrdersController.issue);
router.post('/:id/cancel', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE), purchaseOrdersController.cancel);
router.post('/:id/receive', requireAuth, requirePermission(PERMISSIONS.PURCHASE_ORDERS_RECEIVE), idempotent(), purchaseOrdersController.receive);

export default router;
