import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import inventoryController from '../controllers/inventory.controller.ts';
import transactionsController from '../controllers/transactions.controller.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

// Static sub-routes must be registered before the parameterized GET /:id.
// Reads: INVENTORY_VIEW / INVENTORY_HISTORY_VIEW.
// Mutations: stock-in/stock-out/adjust use their coarse permissions (§7).
router.get('/', requireAuth, requirePermission(PERMISSIONS.INVENTORY_VIEW), inventoryController.list);
// The four movement writes accept an `Idempotency-Key` (phase: inventory duplicate writes).
// A retried delivery — a timed-out request the member was told had failed, or a
// double tap — replays the first answer instead of applying the movement twice.
// Without the header nothing changes, so an older build keeps working.
router.post('/stock-in', requireAuth, requirePermission(PERMISSIONS.INVENTORY_STOCK_IN), idempotent(), inventoryController.stockIn);
router.post('/stock-out', requireAuth, requirePermission(PERMISSIONS.INVENTORY_STOCK_OUT), idempotent(), inventoryController.stockOut);
router.post('/adjust', requireAuth, requirePermission(PERMISSIONS.INVENTORY_MANAGE), idempotent(), inventoryController.adjust);
// Transfers reuse the inventory.manage gate (Phase 19): a transfer moves stock
// between locations, so it needs the same managerial authority as an adjustment.
// Deliberately NO new permission — the RBAC matrix is unchanged.
router.post('/transfer', requireAuth, requirePermission(PERMISSIONS.INVENTORY_MANAGE), idempotent(), inventoryController.transfer);
router.get('/history', requireAuth, requirePermission(PERMISSIONS.INVENTORY_HISTORY_VIEW), transactionsController.list);
router.get('/:id', requireAuth, requirePermission(PERMISSIONS.INVENTORY_VIEW), inventoryController.get);

export default router;
