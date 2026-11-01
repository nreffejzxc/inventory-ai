import type { Request, Response } from 'express';

import { parsePagination, pageResult } from '../utils/pagination.ts';
import { isObjectId, optionalObjectId, optionalSearch, optionalEnum, validateStockMovement, validateTransfer, ACTIVE_ARCHIVED_STATUSES } from '../utils/validate.ts';
import { throwValidation, invalidId } from '../utils/errors.ts';
import inventoryService from '../services/inventory.service.ts';

/**
 * The request context this controller reads. Local and structural, following
 * `dashboard.controller.ts`: declaring `user` on Express's global `Request`
 * would let any module read an authoritative-looking `req.user` on a public
 * route.
 *
 * `user` is optional, matching `middlewares/authorize.ts` exactly, because a
 * handler is registered against Express's `RequestHandler`, whose parameter is a
 * plain `Request`; a required `user` would make that `Request` unassignable and
 * every route registration a type error. The reads below assert it with `!`
 * instead, which is justified by the route table: every route in
 * `routes/inventory.routes.ts` is registered `requireAuth,
 * requirePermission(...), controller` — a binding Phase 22 pins — so the
 * middleware has always run by the time these handlers execute. Optional
 * chaining was NOT used: it would silently pass `undefined` on where the code
 * would previously have thrown, which is a behaviour change.
 */
type AuthenticatedRequest = Request & { user?: { id: string; businessId: string } };

function paramId(req: AuthenticatedRequest) {
  // `req.params` is Express's `{ [key: string]: string | string[] }`, so the
  // property reads as `string | string[] | undefined`. The guard is the real
  // check and is unchanged; the assertion is only what tells the checker, and it
  // is needed because `invalidId`'s return type is inferred rather than
  // annotated `never` — so a call to it does not terminate control flow the way
  // `notFound()` does, and the true branch's narrowing is merged away again
  // afterwards.
  if (!isObjectId(req.params.id)) invalidId();
  return req.params.id as string;
}

function parseFlag(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return !(s === 'false' || s === '0' || s === '');
}

function parseQueryList(req: AuthenticatedRequest) {
  const { page, limit, skip } = parsePagination(req.query);
  const problems = [];

  const search = optionalSearch(req.query.q, 'q');
  problems.push(...search.problems);

  const status = optionalEnum(req.query.status, 'status', ACTIVE_ARCHIVED_STATUSES, {
    message: 'status must be ACTIVE or ARCHIVED',
  });
  problems.push(...status.problems);

  const productId = optionalObjectId(req.query.productId, 'productId');
  problems.push(...productId.problems);
  const locationId = optionalObjectId(req.query.locationId, 'locationId');
  problems.push(...locationId.problems);

  const lowStock = parseFlag(req.query.lowStock);
  const outOfStock = parseFlag(req.query.outOfStock);

  return {
    q: search.value,
    status: status.value,
    productId: productId.value,
    locationId: locationId.value,
    lowStock,
    outOfStock,
    page,
    limit,
    skip,
    problems,
  };
}

/**
 * Validates a stock-movement body and requires productId/locationId.
 *
 * The `!` assertions on the returned fields are justified by the guard directly
 * above them: `validateStockMovement` reports a missing id or quantity through
 * `problems`, and the two explicit pushes cover the blank-id case that
 * `optionalObjectId` accepts without reporting. So reaching the `return` means
 * `problems` was empty, which in turn means productId, locationId and quantity
 * are all present. That is a correlation between the contents of one value and
 * the definedness of three others — not something a type can express — and the
 * assertions are erased at runtime.
 */
function parseMovementInput(
  req: AuthenticatedRequest,
  { allowZero = false, requireReason = false }: { allowZero?: boolean; requireReason?: boolean } = {}
) {
  const v = validateStockMovement(req.body ?? {}, { allowZero, requireReason });
  const problems = [...v.problems];
  if (!v.productId) problems.push({ field: 'productId', message: 'productId is required' });
  if (!v.locationId) problems.push({ field: 'locationId', message: 'locationId is required' });
  if (problems.length) throwValidation(problems);
  return {
    productId: v.productId!,
    locationId: v.locationId!,
    quantity: v.quantity!,
    reason: v.reason,
    reference: v.reference,
  };
}

/** Validates a transfer body and requires productId + both locations. */
function parseTransferInput(req: AuthenticatedRequest) {
  const v = validateTransfer(req.body ?? {});
  const problems = [...v.problems];
  if (!v.productId) problems.push({ field: 'productId', message: 'productId is required' });
  if (!v.fromLocationId) problems.push({ field: 'fromLocationId', message: 'fromLocationId is required' });
  if (!v.toLocationId) problems.push({ field: 'toLocationId', message: 'toLocationId is required' });
  if (problems.length) throwValidation(problems);
  return {
    productId: v.productId!,
    fromLocationId: v.fromLocationId!,
    toLocationId: v.toLocationId!,
    quantity: v.quantity!,
    reason: v.reason,
    reference: v.reference,
  };
}

const inventoryController = {
  async list(req: AuthenticatedRequest, res: Response) {
    const parsed = parseQueryList(req);
    if (parsed.problems.length) throwValidation(parsed.problems);
    const { items, total } = await inventoryService.listRows(req.user!.businessId, parsed);
    res.json(pageResult(items, total, parsed.page, parsed.limit));
  },

  async get(req: AuthenticatedRequest, res: Response) {
    const row = await inventoryService.getRow(req.user!.businessId, paramId(req));
    res.json(row);
  },

  async stockIn(req: AuthenticatedRequest, res: Response) {
    const input = parseMovementInput(req);
    const out = await inventoryService.stockIn(req.user!.businessId, req.user!.id, input);
    res.status(201).json({
      transaction: out.transaction,
      previousQuantity: out.previousQuantity,
      newQuantity: out.newQuantity,
    });
  },

  async stockOut(req: AuthenticatedRequest, res: Response) {
    const input = parseMovementInput(req);
    const out = await inventoryService.stockOut(req.user!.businessId, req.user!.id, input);
    res.json({
      transaction: out.transaction,
      previousQuantity: out.previousQuantity,
      newQuantity: out.newQuantity,
    });
  },

  /** Moves stock between two locations of the caller's business (Phase 19). */
  async transfer(req: AuthenticatedRequest, res: Response) {
    const input = parseTransferInput(req);
    const out = await inventoryService.transfer(req.user!.businessId, req.user!.id, input);
    res.status(201).json({
      reference: out.reference,
      transaction: out.transaction,
      destinationTransaction: out.destinationTransaction,
      previousQuantity: out.previousQuantity,
      newQuantity: out.newQuantity,
      destinationPreviousQuantity: out.destinationPreviousQuantity,
      destinationNewQuantity: out.destinationNewQuantity,
    });
  },

  async adjust(req: AuthenticatedRequest, res: Response) {
    // An adjustment is the only movement with no external document behind it, so
    // the reason is what makes the row explicable later. Required here, not just
    // in the form: an older client cannot skip the audit trail either.
    const input = parseMovementInput(req, { allowZero: true, requireReason: true });
    const out = await inventoryService.adjust(req.user!.businessId, req.user!.id, input);
    res.json({
      transaction: out.transaction,
      previousQuantity: out.previousQuantity,
      newQuantity: out.newQuantity,
    });
  },
};

export default inventoryController;
