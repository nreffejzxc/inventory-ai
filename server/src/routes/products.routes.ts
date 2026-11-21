import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import productsController from '../controllers/products.controller.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

// Catalog reads: products.view, which every role holds (OWNER, ADMIN, MANAGER,
// STAFF per spec §7) — so this is behavior-neutral today, but it makes the
// capability the route depends on explicit rather than implied by "any
// authenticated member". Mutations: those with products.manage (OWNER, ADMIN,
// MANAGER per spec §7). Phase 22 pinned both bindings in
// test/phase22-authorization-contract.test.mjs.
router.get('/', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.list);
router.post('/', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), idempotent(), productsController.create);
// Static path must be registered before the parameterized /:id routes below.
router.get('/reorder', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.reorder);
router.get('/barcode', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.byBarcode);
router.get('/:id', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.get);
router.patch('/:id', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), productsController.update);
router.post(
  '/:id/currency-correction',
  requireAuth,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  productsController.correctCurrency
);
router.post('/:id/archive', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), productsController.archive);
router.post('/:id/restore', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), productsController.restore);
router.post('/:id/generate-barcode', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), productsController.generateBarcode);

export default router;
