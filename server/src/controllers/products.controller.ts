import type { Request, Response } from 'express';

import { parsePagination, pageResult } from '../utils/pagination.ts';
import { isObjectId, optionalObjectId, optionalSearch, optionalEnum, requiredString, validateProduct, ACTIVE_ARCHIVED_STATUSES, CODE_MAX } from '../utils/validate.ts';
import { throwValidation, invalidId } from '../utils/errors.ts';
import { productService } from '../services/product.service.ts';

/**
 * The request context this controller reads. Local and structural, following
 * `middlewares/authenticate.ts`: declaring `user` on Express's global `Request`
 * would let any module read an authoritative-looking `req.user` on a public
 * route.
 *
 * `user` is optional, matching `middlewares/authorize.ts` exactly, because a
 * handler is registered against Express's `RequestHandler`, whose parameter is a
 * plain `Request`; a required `user` would make that `Request` unassignable and
 * every route registration a type error. The reads below assert it with `!`
 * instead, which is justified by the route table: every route in
 * `routes/products.routes.ts` is registered `requireAuth, requirePermission(...),
 * controller` — a binding Phase 22 pins — so the middleware has always run by
 * the time these handlers execute. Optional chaining was NOT used: it would
 * silently pass `undefined` on where the code would previously have thrown,
 * which is a behaviour change.
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

  const categoryId = optionalObjectId(req.query.categoryId, 'categoryId');
  problems.push(...categoryId.problems);
  const locationId = optionalObjectId(req.query.locationId, 'locationId');
  problems.push(...locationId.problems);

  const lowStock = parseFlag(req.query.lowStock);
  const outOfStock = parseFlag(req.query.outOfStock);

  return {
    q: search.value,
    status: status.value,
    categoryId: categoryId.value,
    locationId: locationId.value,
    lowStock,
    outOfStock,
    page,
    limit,
    skip,
    problems,
  };
}

const productsController = {
  async list(req: AuthenticatedRequest, res: Response) {
    const parsed = parseQueryList(req);
    if (parsed.problems.length) throwValidation(parsed.problems);
    const { items, total } = await productService.list(req.user!.businessId, parsed);
    res.json(pageResult(items.map(productService.toProductDTO), total, parsed.page, parsed.limit));
  },

  /**
   * Products that need restocking: ACTIVE (by default) products whose summed
   * availability is at or below their minimum stock, worst first, each tagged
   * OUT_OF_STOCK or LOW_STOCK. Read-only, same role surface as the product list.
   */
  async reorder(req: AuthenticatedRequest, res: Response) {
    const parsed = parseQueryList(req);
    if (parsed.problems.length) throwValidation(parsed.problems);
    const { items, total } = await productService.listReorder(req.user!.businessId, {
      q: parsed.q,
      status: parsed.status ?? 'ACTIVE',
      categoryId: parsed.categoryId,
      skip: parsed.skip,
      limit: parsed.limit,
    });
    res.json(pageResult(items.map(productService.reorderItemPublic), total, parsed.page, parsed.limit));
  },

  async get(req: AuthenticatedRequest, res: Response) {
    const doc = await productService.get(req.user!.businessId, paramId(req));
    res.json(productService.toProductDTO(doc));
  },

  /**
   * Look up one product by an exact barcode, scoped to the authenticated
   * business. Barcodes are unique within a business (partial unique index), so
   * this returns at most one product; ARCHIVED products are returned with their
   * status. 404 when the barcode is unknown here.
   */
  async byBarcode(req: AuthenticatedRequest, res: Response) {
    const b = requiredString(req.query.barcode, 'barcode', CODE_MAX);
    if (b.problems.length) throwValidation(b.problems);
    const doc = await productService.getByBarcode(req.user!.businessId, b.value);
    res.json(productService.toProductDTO(doc));
  },

  async create(req: AuthenticatedRequest, res: Response) {
    const v = validateProduct(req.body ?? {});
    if (v.problems.length) throwValidation(v.problems);
    const doc = await productService.create(req.user!.businessId, req.user!.id, {
      name: v.name,
      brand: v.brand,
      sku: v.sku,
      barcode: v.barcode,
      description: v.description,
      categoryId: v.categoryId,
      costPrice: v.costPrice,
      sellingPrice: v.sellingPrice,
      unit: v.unit,
      minimumStock: v.minimumStock,
      imageUrl: v.imageUrl,
    });
    res.status(201).json(productService.toProductDTO(doc));
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const id = paramId(req);
    const v = validateProduct(req.body ?? {}, { partial: true });
    if (v.problems.length) throwValidation(v.problems);
    const doc = await productService.update(req.user!.businessId, id, req.user!.id, {
      name: v.name,
      brand: v.brand,
      sku: v.sku,
      barcode: v.barcode,
      description: v.description,
      categoryId: v.categoryId,
      costPrice: v.costPrice,
      sellingPrice: v.sellingPrice,
      unit: v.unit,
      minimumStock: v.minimumStock,
      imageUrl: v.imageUrl,
    });
    res.json(productService.toProductDTO(doc));
  },

  async archive(req: AuthenticatedRequest, res: Response) {
    const doc = await productService.setStatus(req.user!.businessId, paramId(req), req.user!.id, 'ARCHIVED');
    res.json(productService.toProductDTO(doc));
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const doc = await productService.setStatus(req.user!.businessId, paramId(req), req.user!.id, 'ACTIVE');
    res.json(productService.toProductDTO(doc));
  },

  /**
   * Issue an internal EAN-13 barcode for a product without one (Phase 12D).
   * PRODUCTS_MANAGE (OWNER/ADMIN/MANAGER). Never overwrites an existing barcode;
   * refuses ARCHIVED products; business-scoped like every product write.
   */
  async generateBarcode(req: AuthenticatedRequest, res: Response) {
    const doc = await productService.generateBarcode(req.user!.businessId, paramId(req), req.user!.id);
    res.json(productService.toProductDTO(doc));
  },
};

export default productsController;
