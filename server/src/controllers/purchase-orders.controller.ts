import type { Request, Response } from 'express';

import { parsePagination, pageResult } from '../utils/pagination.ts';
import {
  isObjectId,
  validatePurchaseOrder,
  validateReceive,
  validatePurchaseOrderList,
  validateDraftFromRestock,
} from '../utils/validate.ts';
import { throwValidation, invalidId } from '../utils/errors.ts';
import { PURCHASE_ORDER_STATUSES } from '../models/purchaseOrder.model.ts';
import { purchaseOrderService } from '../services/purchase-orders.service.ts';
import ApiError from '../utils/ApiError.ts';

/**
 * The request context this controller reads. Local and structural, following
 * `products.controller.ts`, `inventory.controller.ts` and `users.controller.ts`:
 * declaring `user` on Express's global `Request` would let any module read an
 * authoritative-looking `req.user` on a public route.
 *
 * `user` is optional, matching `middlewares/authorize.ts` exactly, because a
 * handler is registered against Express's `RequestHandler`, whose parameter is a
 * plain `Request`; a required `user` would make that `Request` unassignable and
 * every route registration a type error. The reads below assert it with `!`
 * instead, which is justified by the route table: every route in
 * `routes/purchase-orders.routes.ts` is registered `requireAuth,
 * requirePermission(...), controller` — a binding Phase 22 pins — so the
 * middleware has always run by the time these handlers execute. Optional
 * chaining was NOT used: it would silently pass `undefined` on where the code
 * would previously have thrown, which is a behaviour change.
 */
type AuthenticatedRequest = Request & {
  user?: { id: string; businessId: string };
  idempotencyKey?: string;
};

/**
 * One validated receive line (`parseReceiveLine`). `validateReceive` reports a
 * missing productId or quantity through `problems`, so a line that reaches the
 * service has both — the same correlation the payload assertions below describe.
 */
type ValidatedReceiveLine = { productId: string; quantity: number };

/**
 * The payload each service method takes, taken from the service itself rather
 * than re-declared here: `Parameters<typeof …>[2]` is `purchaseOrderService.create`'s
 * third parameter, and `[3]` is `update`'s fourth. Deriving them means the
 * assertion below cannot drift from the signatures it is asserting against — the
 * same reason the list filter in the service is derived from the model instead of
 * hand-written. Both are erased; neither adds a runtime value.
 */
type CreatePayload = Parameters<typeof purchaseOrderService.create>[2];
type UpdatePayload = Parameters<typeof purchaseOrderService.update>[3];

const paramId = (req: AuthenticatedRequest) => {
  // `req.params` is Express's `{ [key: string]: string | string[] }`, so the
  // property reads as `string | string[] | undefined`. The guard is the real
  // check and is unchanged; the assertion is only what tells the checker, and it
  // is needed because `invalidId`'s return type is inferred rather than
  // annotated `never` — so a call to it does not terminate control flow the way
  // `notFound()` does, and the true branch's narrowing is merged away again
  // afterwards.
  if (!isObjectId(req.params.id)) invalidId();
  return req.params.id as string;
};

/**
 * Purchase order controllers. businessId/userId always come from the
 * authenticated request (req.user) — never the body. Reads are open to any
 * authenticated member; mutations are gated by requirePermission at the route.
 */
export const purchaseOrdersController = {
  async list(req: AuthenticatedRequest, res: Response) {
    const { page, limit, skip } = parsePagination(req.query);
    const v = validatePurchaseOrderList(req.query, PURCHASE_ORDER_STATUSES);
    if (v.problems.length) throwValidation(v.problems);
    const { items, total } = await purchaseOrderService.list(req.user!.businessId, {
      ...v.filters,
      skip,
      limit,
    });
    res.json(pageResult(items, total, page, limit));
  },

  async create(req: AuthenticatedRequest, res: Response) {
    const v = validatePurchaseOrder(req.body ?? {});
    if (v.problems.length) throwValidation(v.problems);
    // The validator's result is passed through whole — the same object the
    // untyped controller passed — and `as CreatePayload` is the necessary strict
    // assertion at the boundary. It is a correlation no type can express:
    // `validatePurchaseOrder` reports a missing supplier/location, a bad line id
    // or a bad quantity through `problems`, and `throwValidation` above returns
    // only when that array is empty, so every field is present and well-formed by
    // this line even though each is still typed as possibly-`undefined`. The
    // assertion is erased, so nothing about the runtime call changes — the
    // validator's inert `problems` field rides along exactly as it always did
    // (`purchaseOrderService.create` reads only the keys it names), and no
    // `undefined`-meaning-omitted value is defaulted. `parseMovementInput` in
    // `inventory.controller.ts` documents the same boundary; it happens to build
    // its payload field by field because the original did.
    const po = await purchaseOrderService.create(req.user!.businessId, req.user!.id, v as CreatePayload);
    res.status(201).json(po);
  },

  /**
   * Create exactly one DRAFT from selected restock rows. The service re-reads
   * the location-scoped rows and refuses stale values; this handler never calls
   * issue or any supplier/transmission path.
   */
  async createFromRestock(req: AuthenticatedRequest, res: Response) {
    // This route always creates a durable document, so the key is part of the
    // contract rather than an optional retry convenience. Without it, a lost
    // response would make the client's next delivery a second DRAFT.
    if (!req.idempotencyKey) {
      throw new ApiError(
        400,
        'An Idempotency-Key header is required to create a draft from restock',
        'IDEMPOTENCY_KEY_REQUIRED'
      );
    }
    const v = validateDraftFromRestock(req.body ?? {});
    if (v.problems.length) throwValidation(v.problems);
    const po = await purchaseOrderService.createFromRestock(
      req.user!.businessId,
      req.user!.id,
      v as Parameters<typeof purchaseOrderService.createFromRestock>[2],
      req.idempotencyKey,
    );
    res.status(201).json(po);
  },

  async get(req: AuthenticatedRequest, res: Response) {
    const po = await purchaseOrderService.get(req.user!.businessId, paramId(req));
    res.json(po);
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const id = paramId(req);
    const v = validatePurchaseOrder(req.body ?? {}, { partial: true });
    if (v.problems.length) throwValidation(v.problems);
    // Same boundary as `create`, with the partial shape: every field stays
    // possibly-`undefined` because `undefined` is exactly the distinction
    // `purchaseOrderService.update` tests for (`payload.supplierId !== undefined`),
    // so each key is passed through as the validator returned it rather than
    // defaulted. The whole result is passed through, exactly as the untyped
    // controller passed it.
    const po = await purchaseOrderService.update(req.user!.businessId, id, req.user!.id, v as UpdatePayload);
    res.json(po);
  },

  async issue(req: AuthenticatedRequest, res: Response) {
    const po = await purchaseOrderService.issue(req.user!.businessId, paramId(req), req.user!.id);
    res.json(po);
  },

  async cancel(req: AuthenticatedRequest, res: Response) {
    const po = await purchaseOrderService.cancel(req.user!.businessId, paramId(req), req.user!.id);
    res.json(po);
  },

  /** Receive stock against an OPEN purchase order (Phase 13C). */
  async receive(req: AuthenticatedRequest, res: Response) {
    if (!req.idempotencyKey) {
      throw new ApiError(
        400,
        'An Idempotency-Key header is required to receive stock',
        'IDEMPOTENCY_KEY_REQUIRED'
      );
    }
    const v = validateReceive(req.body ?? {});
    if (v.problems.length) throwValidation(v.problems);
    const result = await purchaseOrderService.receive(req.user!.businessId, req.user!.id, paramId(req), {
      // Same correlation as `create`: `validateReceive` reports a missing
      // productId or quantity through `problems`, so a line that reaches the
      // service has both.
      lines: v.lines as ValidatedReceiveLine[],
      reference: v.reference,
      idempotencyKey: req.idempotencyKey,
    });
    res.json(result);
  },
};

export default purchaseOrdersController;
