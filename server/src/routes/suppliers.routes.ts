import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import { supplierService } from '../services/reference.service.ts';
import { createReferenceController } from '../controllers/reference.controller.ts';
import { validateSupplier } from '../utils/validate.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();
const c = createReferenceController(supplierService, validateSupplier);

// Reads: suppliers.view, which every role holds (Phase 22 — the binding is now
// explicit and guarded rather than implied by requireAuth alone). Mutations:
// suppliers.manage (OWNER, ADMIN, MANAGER).
router.get('/', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_VIEW), c.list);
router.post('/', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_MANAGE), idempotent(), c.create);
router.get('/:id', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_VIEW), c.get);
router.patch('/:id', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_MANAGE), c.update);
router.post('/:id/archive', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_MANAGE), c.archive);
router.post('/:id/restore', requireAuth, requirePermission(PERMISSIONS.SUPPLIERS_MANAGE), c.restore);

export default router;
