import { Router } from 'express';

import requireAuth from '../middlewares/authenticate.ts';
import { requirePermission } from '../middlewares/authorize.ts';
import { idempotent } from '../middlewares/idempotency.ts';
import productsController from '../controllers/products.controller.ts';
import { PERMISSIONS } from '../constants/roles.ts';

const router = Router();

/**
 * A 500-row CSV import can legitimately run for several minutes. The transport's
 * default 60 s stale-claim takeover would let a timeout retry start a second
 * writer while the first is still creating products, so this route keeps its
 * claim for ten minutes. A truly abandoned claim is still recovered after that.
 */
const IMPORT_CLAIM_STALE_MS = 10 * 60_000;

// Catalog reads: products.view, which every role holds (OWNER, ADMIN, MANAGER,
// STAFF per spec §7) — so this is behavior-neutral today, but it makes the
// capability the route depends on explicit rather than implied by "any
// authenticated member". Mutations: those with products.manage (OWNER, ADMIN,
// MANAGER per spec §7). Phase 22 pinned both bindings in
// test/phase22-authorization-contract.test.mjs.
router.get('/', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.list);
router.post('/', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), idempotent(), productsController.create);
// Static paths must be registered before the parameterized /:id routes below.
router.get('/reorder', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.reorder);
router.get('/barcode', requireAuth, requirePermission(PERMISSIONS.PRODUCTS_VIEW), productsController.byBarcode);
// FW-01 is deliberately OWNER/ADMIN, narrower than products.manage (which also
// includes MANAGER): a whole-file catalogue write is an onboarding operation.
router.post(
  '/import',
  requireAuth,
  requirePermission(PERMISSIONS.PRODUCTS_IMPORT),
  idempotent({ staleMs: IMPORT_CLAIM_STALE_MS }),
  productsController.importProducts
);
// Progress for a key whose HTTP answer was lost to the client budget. Same
// OWNER/ADMIN permission and same business scope as the apply itself, and static
// `/import/...` is registered before the parameterized `/:id` route below.
router.get(
  '/import/:key',
  requireAuth,
  requirePermission(PERMISSIONS.PRODUCTS_IMPORT),
  productsController.importStatus
);
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
