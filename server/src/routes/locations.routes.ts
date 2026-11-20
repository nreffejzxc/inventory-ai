import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import { locationService } from '../services/reference.service.ts';
import { createReferenceController } from '../controllers/reference.controller.ts';
import { validateLocation } from '../utils/validate.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();
const c = createReferenceController(locationService, validateLocation);

router.get('/', requireAuth, c.list);
router.post('/', requireAuth, requirePermission(PERMISSIONS.LOCATIONS_MANAGE), idempotent(), c.create);
router.get('/:id', requireAuth, c.get);
router.patch('/:id', requireAuth, requirePermission(PERMISSIONS.LOCATIONS_MANAGE), c.update);
router.post('/:id/archive', requireAuth, requirePermission(PERMISSIONS.LOCATIONS_MANAGE), c.archive);
router.post('/:id/restore', requireAuth, requirePermission(PERMISSIONS.LOCATIONS_MANAGE), c.restore);

export default router;
