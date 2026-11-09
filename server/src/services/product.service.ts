import mongoose from 'mongoose';
import type { PipelineStage } from 'mongoose';

import Product from '../models/product.model.ts';
import Category from '../models/category.model.ts';
import ApiError from '../utils/ApiError.ts';
import { recordAudit } from './audit.service.ts';
import { notFound } from '../utils/errors.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { classifyStockStatus } from '../constants/stockStatus.ts';
import { internalEan13Candidates } from '../utils/internalBarcode.ts';

/**
 * A business/user id as it arrives here: the request layer stringifies it
 * (`req.user.businessId`, `req.user.id`) while a caller holding an already-loaded
 * document passes a real ObjectId. Neither form can be dropped, so both are
 * accepted and `new ObjectId(...)` normalises them.
 */
type IdLike = string | mongoose.Types.ObjectId;

/**
 * The catalog fields `toProductDTO` reads. Written against BOTH shapes it is
 * handed — a hydrated document and a raw aggregation row — so the scalars that
 * the DTO passes on to `classifyStockStatus` keep their real types (`null` is
 * included because Mongoose types a non-required path as `T | null | undefined`)
 * and the rest stay `unknown` rather than being asserted.
 */
type ProductDTOsource = {
  _id?: unknown;
  businessId?: unknown;
  name?: unknown;
  brand?: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  specifications?: string | null;
  categoryId?: unknown;
  costPrice?: number | null;
  sellingPrice?: number | null;
  currency?: string | null;
  unit?: string | null;
  minimumStock?: number | null;
  imageUrl?: string | null;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

/** A populated `categoryId` as it appears on either a document or an aggregate row. */
type CategoryRefSource = { _id?: unknown; name?: unknown; status?: unknown };

/** A restock row: the DTO fields plus the availability the aggregation computed. */
type ReorderItemSource = ProductDTOsource & { available?: number | null };

/** The create/update payload the products controller has already validated. */
type ProductWritePayload = {
  name?: string;
  brand?: string;
  sku?: string;
  barcode?: string;
  description?: string;
  specifications?: string;
  categoryId?: string;
  costPrice?: number;
  sellingPrice?: number;
  currency?: string;
  unit?: string;
  minimumStock?: number;
  imageUrl?: string;
};

/**
 * List filters. `skip`/`limit` are required rather than optional because
 * `listWithStock` feeds them straight to `$skip`/`$limit` aggregation stages,
 * which need a real number; every caller (the controller's `parsePagination`
 * and the AI tools) supplies both.
 */
type ProductListFilters = {
  q?: string;
  terms?: string[];
  /**
   * Exact name/SKU/barcode values. `findProducts` uses this for its exact-product
   * fallback: a term like "Dell UltraSharp U2723QE 10232" must be able to bring
   * that one row back even when the ordinary OR search fills its page with newer
   * variants of the same family.
   */
  exactTerms?: string[];
  includeDescription?: boolean;
  status?: string;
  categoryId?: string;
  /** Catalogue discovery price ceiling: only products priced BELOW this amount. */
  maxSellingPrice?: number;
  locationId?: string;
  lowStock?: boolean;
  outOfStock?: boolean;
  inStockOnly?: boolean;
  withStock?: boolean;
  /** AI-71 — product ids to leave out, so a dead-stock read can filter in the database. */
  excludeIds?: string[];
  skip: number;
  limit: number;
};

/** Restock filters — `listReorder` defaults `status`/`skip`/`limit` itself. */
type ProductReorderFilters = {
  q?: string;
  status?: string;
  categoryId?: string;
  skip?: number;
  limit?: number;
};

type BrandSummaryFilters = {
  q?: string;
  categoryId?: string;
  limit: number;
};

const { ObjectId } = mongoose.Types;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BRAND_DESCRIPTION_MAX = 160;

/**
 * One OR clause for the everyday search. `q` keeps the existing exact-substring
 * contract; `terms` is the natural-search list and may look in `description` as
 * well. Each term is matched independently, so "engine oil, motor oil, 10W-40"
 * finds a row whose recorded facts use only one of those phrases.
 */
function textSearchOr({
  q,
  terms,
  exactTerms,
  includeDescription,
}: Pick<ProductListFilters, 'q' | 'terms' | 'exactTerms' | 'includeDescription'>) {
  const values = [q, ...(terms ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const exactValues = (exactTerms ?? [])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (values.length === 0 && exactValues.length === 0) return null;
  const fields = includeDescription
    ? (['name', 'brand', 'description', 'specifications', 'sku', 'barcode'] as const)
    : (['name', 'brand', 'sku', 'barcode'] as const);
  // An exact term is anchored and deliberately does not search `brand` or free text:
  // "Dell" is a brand, not the Dell UltraSharp U2723QE 10232 the member named.
  const exactFields = ['name', 'sku', 'barcode'] as const;
  return [
    ...exactValues.flatMap((value) => {
      const re = { $regex: `^${escapeRegExp(value)}$`, $options: 'i' };
      return exactFields.map((field) => ({ [field]: re }));
    }),
    ...values.flatMap((value) => {
      const re = { $regex: escapeRegExp(value), $options: 'i' };
      return fields.map((field) => ({ [field]: re }));
    }),
  ];
}

function duplicateError(payload: { sku?: unknown; barcode?: unknown }) {
  const { sku, barcode } = payload;
  if (sku && barcode) {
    return new ApiError(
      409,
      'A product with this SKU or barcode already exists',
      'PRODUCT_SKU_OR_BARCODE_EXISTS'
    );
  }
  if (sku) return new ApiError(409, 'A product with this SKU already exists', 'PRODUCT_SKU_EXISTS');
  if (barcode) return new ApiError(409, 'A product with this barcode already exists', 'PRODUCT_BARCODE_EXISTS');
  return new ApiError(409, 'A product with these details already exists', 'PRODUCT_CONFLICT');
}

/** Map a Mongo duplicate-key error to a 409 with the offending field. */
function mapDuplicateKey(err: unknown) {
  // `err?.keyPattern || err?.keyValue || {}`, narrowed: the optional access keeps
  // the original `&&` short-circuit and the cast is type-only, so a driver error
  // carrying a non-object `keyPattern` still reaches `in` exactly as it did.
  const source = err as { keyPattern?: unknown; keyValue?: unknown } | null | undefined;
  const pattern = (source?.keyPattern || source?.keyValue || {}) as Record<string, unknown>;
  if ('sku' in pattern) {
    return new ApiError(409, 'A product with this SKU already exists', 'PRODUCT_SKU_EXISTS');
  }
  if ('barcode' in pattern) {
    return new ApiError(409, 'A product with this barcode already exists', 'PRODUCT_BARCODE_EXISTS');
  }
  return err;
}

function isDuplicateKey(err: unknown) {
  return (err as { code?: unknown } | null | undefined)?.code === 11000;
}

function toProductDTO(doc: ProductDTOsource) {
  // `categoryId` is either an ObjectId (unpopulated) or a hydrated category; the
  // cast is the boundary that lets both branches read the fields they actually
  // have. `String(cat)` still covers the ObjectId case, exactly as before.
  const cat = doc.categoryId as CategoryRefSource | string | null | undefined;
  let category: { id: string; name?: unknown; status?: unknown } | null = null;
  if (cat) {
    const isPopulated = typeof cat === 'object' && cat._id;
    category = isPopulated
      ? { id: String(cat._id), name: cat.name, status: cat.status }
      : { id: String(cat) };
  }
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    name: doc.name,
    brand: doc.brand || null,
    sku: doc.sku ?? null,
    barcode: doc.barcode ?? null,
    description: doc.description ?? null,
    specifications: doc.specifications ?? null,
    category,
    costPrice: doc.costPrice ?? 0,
    sellingPrice: doc.sellingPrice ?? 0,
    currency: doc.currency ?? null,
    unit: doc.unit ?? null,
    minimumStock: doc.minimumStock ?? 0,
    imageUrl: doc.imageUrl ?? null,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Product-level restock item: the catalog fields a restock decision needs plus
 * the product's summed availability and its stock status (OUT_OF_STOCK vs
 * LOW_STOCK, §19). Shared by the /api/products/reorder endpoint and the
 * read-only AI restock tool so both surfaces return identical data.
 */
function reorderItemPublic(doc: ReorderItemSource) {
  const base = toProductDTO(doc);
  return {
    id: base.id,
    name: base.name,
    sku: base.sku,
    barcode: base.barcode,
    unit: base.unit,
    status: base.status,
    minimumStock: base.minimumStock,
    category: base.category,
    sellingPrice: base.sellingPrice,
    // The assistant's low-stock subtotal is computed from these rows, so the currency must
    // travel with the price rather than being assumed from the business's locale.
    currency: base.currency,
    availableQuantity: Number.isFinite(doc.available) ? doc.available : null,
    stockStatus: classifyStockStatus(doc.available, base.minimumStock),
  };
}

/**
 * Aggregation stages that attach each product's summed availability: $lookup
 * its inventory rows (optionally narrowed by extra $expr conditions) then
 * reduce to available = quantity − reservedQuantity across every location that
 * matches. Shared by listWithStock and listReorder so every stock list uses the
 * same §19 math and can never disagree with the dashboard.
 */
/**
 * Per-product availability, computed by MERGING two streams instead of one join per
 * product — and in ID SPACE, because the first version of this merge could not survive
 * a large tenant.
 *
 * WHAT THIS REPLACES. The previous shape ran a `$lookup` into `inventory` once per
 * product of the tenant. Measured 2026-10-13 on a synthetic 10 000-product tenant
 * (20 105 inventory rows), `explain('executionStats')` showed 10 000 sub-pipeline
 * executions examining 20 105 rows and costing 2.0–2.2 s — to produce a 20-row page.
 * Each individual join was an INDEX lookup; the COUNT of them was the cost, and no
 * index can fix a fan-out of one query per row, which is why this is a restructure
 * rather than an index.
 *
 * WHAT IT DOES INSTEAD. The products stream stays in place and a single `$unionWith`
 * brings in inventory ALREADY GROUPED BY PRODUCT — one pass, one hash aggregate —
 * after which one `$group` joins the two sides on their shared key (`_id`: a
 * product's own `_id` on the product side, the grouped `productId` on the inventory
 * side). Every filter, sort and `$regex` therefore stays inside MongoDB; nothing
 * about matching semantics moves into application code, which is what makes this
 * output-identical rather than merely similar.
 *
 * WHY IT CARRIES SO LITTLE (§27DF). The merge is one `$group` whose memory holds one
 * entry PER GROUP, so a first version that carried the product document itself
 * (`$project: { __product: '$$ROOT' }` → `$max: '$__product'`) held the whole
 * catalog in RAM. On a **131 000-product** tenant (261 918 inventory rows) that
 * `$group` crossed MongoDB's 100 MB in-memory limit and **failed the query**:
 * `Exceeded memory limit for $group … Pass allowDiskUse:true to opt in`, surfaced as
 * `TOOL_ERROR` from four assistant tools (`getLowStockProducts`,
 * `getOutOfStockProducts`, `getReorderNeededProducts`, `getProductsByLocation`) and
 * as a 500 from `GET /api/products?lowStock=true` on the Inventory/Restock screens.
 * The cost was never the row count — it was the PAYLOAD PER GROUP.
 *
 * So the merge now publishes the four scalars the page needs to SELECT a row, and the
 * page is hydrated afterwards for at most one page of products:
 *
 *   available    — quantity - reservedQuantity, summed across the product's rows, and
 *                  0 when it has no inventory at all. §19: a missing row is zero
 *                  stock, not missing stock. Identical arithmetic to the `$ifNull`
 *                  pair this replaces.
 *   hasRow       — whether ANY inventory row contributed. This is what a
 *                  location-scoped request needs to mean "only products actually
 *                  stocked at that location"; the old shape tested `$size(inv) > 0`
 *                  on the lookup result array.
 *   minimumStock — the product's own threshold, carried because `lowStock` compares
 *                  it with `available` ABOVE the facet, where a join cannot help.
 *   createdAt    — the catalog's page order, so the sort stays index-free but exact.
 *
 * `$max` is the merge operator on purpose: it IGNORES missing values, so each
 * accumulator simply takes the side of the union that carries it. `__product` is a
 * literal `true` rather than the document, and it is what still drops the groups whose
 * rows the catalog `$match` excluded (an ARCHIVED product, another filter).
 *
 * The hydration in {@link hydrateStockPage} puts the product document back byte for
 * byte — same fields, same `category`/`categoryId` normalisation — so every DTO below
 * is unchanged, which is why `perf:golden` stays identical.
 */
function availabilityIdStages(
  bizOid: mongoose.Types.ObjectId,
  locationId?: string
): PipelineStage[] {
  // The inventory side is filtered by a plain equality match, not an `$expr`, so the
  // Phase 20D `{ businessId, locationId }` index serves it directly.
  const invMatch: Record<string, unknown> = { businessId: bizOid };
  if (locationId) invMatch.locationId = new ObjectId(locationId);

  return [
    // Carry the product's IDENTITY and the three scalars the page needs — never the
    // document. `__product` is a presence marker: `$max` ignores missing values, so it
    // is `true` on every group that owns a catalog document and absent on the groups
    // that hold inventory for a product this filter excluded.
    {
      $project: {
        __product: { $literal: true },
        __minimumStock: '$minimumStock',
        __createdAt: '$createdAt',
      },
    },
    {
      $unionWith: {
        coll: 'inventory',
        pipeline: [
          { $match: invMatch },
          {
            $group: {
              _id: '$productId',
              __quantity: { $sum: '$quantity' },
              __reserved: { $sum: '$reservedQuantity' },
            },
          },
          // `_id` stays as the productId: it is the merge key on both sides.
          { $project: { __quantity: 1, __reserved: 1, __hasRow: { $literal: true } } },
        ],
      },
    },
    {
      $group: {
        _id: '$_id',
        __product: { $max: '$__product' },
        __minimumStock: { $max: '$__minimumStock' },
        __createdAt: { $max: '$__createdAt' },
        __quantity: { $max: '$__quantity' },
        __reserved: { $max: '$__reserved' },
        __hasRow: { $max: '$__hasRow' },
      },
    },
    // A group with no catalog document holds inventory rows for a product the
    // catalogue filter excluded (an ARCHIVED product, another filter below). Those are
    // dropped here, exactly as the products-side `$match` dropped them before.
    { $match: { __product: true } },
    {
      $project: {
        minimumStock: '$__minimumStock',
        createdAt: '$__createdAt',
        available: {
          $subtract: [{ $ifNull: ['$__quantity', 0] }, { $ifNull: ['$__reserved', 0] }],
        },
        hasRow: { $eq: ['$__hasRow', true] },
      },
    },
  ];
}

/**
 * The product documents behind one page of {@link availabilityIdStages} ids.
 *
 * The merge above deliberately stops at four scalars per product, so the page — at most
 * `limit` rows by construction — is hydrated here in two indexed reads instead of being
 * carried through the `$group`. Output is what the old single-aggregation shape
 * produced: the stored document, `available` and `hasRow` merged onto it, and the same
 * `category`/`categoryId` normalisation the previous `$lookup` performed (the category
 * document when it exists and belongs to this business, `null` when the reference is
 * missing). The `page` array's order is preserved exactly, so every sort the pipeline
 * applied still decides the order.
 */
async function hydrateStockPage(
  bizOid: mongoose.Types.ObjectId,
  page: Array<{ _id: mongoose.Types.ObjectId; available?: number; hasRow?: boolean }>
): Promise<Record<string, unknown>[]> {
  if (page.length === 0) return [];

  const ids = page.map((row) => row._id);
  const docs = await Product.find({ _id: { $in: ids }, businessId: bizOid }).lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc as Record<string, unknown>]));

  // One category read for the page's distinct references, still tenant-guarded. A
  // category that does not resolve (or belongs to another business) is `null`, which is
  // what the old join's `$arrayElemAt` produced for an empty match, and what the
  // normalisation below the pipeline consumes.
  const categoryIds = [
    ...new Set(
      docs
        .map((doc) => (doc as { categoryId?: unknown }).categoryId)
        .filter((id): id is mongoose.Types.ObjectId => Boolean(id))
        .map((id) => String(id))
    ),
  ];
  const categories = categoryIds.length
    ? await Category.find({ _id: { $in: categoryIds }, businessId: bizOid }).lean()
    : [];
  const categoryById = new Map(categories.map((cat) => [String(cat._id), cat as Record<string, unknown>]));

  const items: Record<string, unknown>[] = [];
  for (const row of page) {
    const doc = byId.get(String(row._id));
    // Cannot happen while the page ids and the catalog agree, and kept as read-path
    // hygiene rather than a possibility: a product is never hard-deleted (§4).
    if (!doc) continue;
    const category = doc.categoryId ? categoryById.get(String(doc.categoryId)) ?? null : null;
    doc.available = row.available ?? 0;
    doc.hasRow = row.hasRow ?? false;
    doc.category = category;
    doc.categoryId = category;
    items.push(doc);
  }
  return items;
}

/**
 * Product business service. Every read/write is scoped by the server-derived
 * businessId. SKU/barcode uniqueness is enforced within the business (partial
 * unique index + friendly 409 mapping).
 */
export const productService = {
  toProductDTO,
  reorderItemPublic,

  async assertCategoryOfBusiness(businessId: IdLike, categoryId: string | undefined) {
    if (!categoryId) return null;
    const category = await Category.findOne({ _id: categoryId, businessId });
    if (!category) {
      throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
    }
    return category;
  },

  async create(businessId: IdLike, userId: IdLike, payload: ProductWritePayload) {
    await this.assertCategoryOfBusiness(businessId, payload.categoryId);

    const data = {
      businessId,
      name: payload.name,
      brand: payload.brand,
      sku: payload.sku,
      barcode: payload.barcode,
      description: payload.description,
      specifications: payload.specifications,
      categoryId: payload.categoryId,
      costPrice: payload.costPrice ?? 0,
      sellingPrice: payload.sellingPrice ?? 0,
      currency: payload.currency,
      unit: payload.unit,
      minimumStock: payload.minimumStock ?? 0,
      imageUrl: payload.imageUrl,
      status: 'ACTIVE',
    };

    const [skuDup, barcodeDup] = await Promise.all([
      data.sku ? Product.exists({ businessId, sku: data.sku }) : null,
      data.barcode ? Product.exists({ businessId, barcode: data.barcode }) : null,
    ]);
    if (skuDup || barcodeDup) throw duplicateError(data);

    let doc;
    try {
      doc = await Product.create(data);
    } catch (err) {
      if (isDuplicateKey(err)) throw mapDuplicateKey(err);
      throw err;
    }

    await recordAudit({
      businessId,
      userId,
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      entityType: AUDIT_ENTITY_TYPES.PRODUCT,
      entityId: doc._id,
      metadata: { name: doc.name, sku: doc.sku, categoryId: doc.categoryId ? String(doc.categoryId) : null },
    });
    return doc;
  },

  async get(businessId: IdLike, id: IdLike) {
    const doc = await Product.findOne({ _id: id, businessId }).populate('categoryId', 'name status');
    if (!doc) notFound('Product not found');
    return doc;
  },

  /**
   * Find a single product by id, SKU, or barcode, scoped to the business.
   * Returns null (never throws) when nothing matches or the identifier is
   * malformed — used by the read-only AI getProduct tool so "not found" is
   * data the assistant can report instead of an internal error.
   */
  async getByIdentifier(
    businessId: IdLike,
    { id, sku, barcode }: { id?: unknown; sku?: unknown; barcode?: unknown } = {}
  ) {
    let by: Record<string, unknown>;
    if (id) {
      if (!/^[0-9a-fA-F]{24}$/.test(String(id))) return null;
      by = { _id: id };
    } else if (sku) {
      by = { sku: String(sku) };
    } else if (barcode) {
      by = { barcode: String(barcode) };
    } else {
      return null;
    }
    return Product.findOne({ ...by, businessId }).populate('categoryId', 'name status');
  },

  /**
   * Single-product barcode lookup for the REST endpoint. Barcodes are unique
   * within a business (partial unique index), so this resolves to at most one
   * product; ARCHIVED products are returned with their status (never treated as
   * active — the caller sees `status`). 404 when the barcode is unknown here.
   */
  async getByBarcode(businessId: IdLike, barcode: unknown) {
    const doc = await this.getByIdentifier(businessId, { barcode });
    if (!doc) notFound('Product not found');
    return doc;
  },

  async update(businessId: IdLike, id: IdLike, userId: IdLike, payload: ProductWritePayload) {
    const doc = await Product.findOne({ _id: id, businessId }).populate('categoryId', 'name status');
    if (!doc) notFound('Product not found');

    if (payload.categoryId !== undefined && String(payload.categoryId ?? '') !== String(doc.categoryId?._id ?? doc.categoryId ?? '')) {
      await this.assertCategoryOfBusiness(businessId, payload.categoryId);
    }

    const updatedFields: string[] = [];
    // The document is written through here so the field name may be a variable.
    // It IS the same object, so every assignment still runs the schema setters;
    // only the static type is widened.
    const target = doc as unknown as Record<string, unknown>;
    const apply = (field: string, value: unknown) => {
      if (value === undefined) return;
      if (value !== target[field]) {
        target[field] = value;
        updatedFields.push(field);
      }
    };

    apply('name', payload.name);
    apply('brand', payload.brand);
    apply('sku', payload.sku);
    apply('barcode', payload.barcode);
    apply('description', payload.description);
    apply('specifications', payload.specifications);
    apply('costPrice', payload.costPrice);
    apply('sellingPrice', payload.sellingPrice);
    apply('currency', payload.currency);
    apply('unit', payload.unit);
    apply('minimumStock', payload.minimumStock);
    apply('imageUrl', payload.imageUrl);
    // categoryId: apply only when explicitly provided
    if (payload.categoryId !== undefined && String(payload.categoryId) !== String(doc.categoryId?._id ?? doc.categoryId ?? '')) {
      // A validated ObjectId string; Mongoose casts it to ObjectId on assignment.
      target.categoryId = payload.categoryId || null;
      updatedFields.push('categoryId');
    }

    // Uniqueness pre-check (excluding this document) for friendlier errors.
    if (updatedFields.includes('sku') && doc.sku) {
      const dup = await Product.exists({ businessId, sku: doc.sku, _id: { $ne: doc._id } });
      if (dup) throw new ApiError(409, 'A product with this SKU already exists', 'PRODUCT_SKU_EXISTS');
    }
    if (updatedFields.includes('barcode') && doc.barcode) {
      const dup = await Product.exists({ businessId, barcode: doc.barcode, _id: { $ne: doc._id } });
      if (dup) throw new ApiError(409, 'A product with this barcode already exists', 'PRODUCT_BARCODE_EXISTS');
    }

    if (updatedFields.length > 0) {
      try {
        await doc.save();
      } catch (err) {
        if (isDuplicateKey(err)) throw mapDuplicateKey(err);
        throw err;
      }
      await recordAudit({
        businessId,
        userId,
        action: AUDIT_ACTIONS.PRODUCT_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.PRODUCT,
        entityId: doc._id,
        metadata: { updated: updatedFields },
      });
    }
    return doc;
  },

  /**
   * Issue an internal EAN-13 barcode (Phase 12D) for a product that has none.
   * Manufacturer barcodes are never overwritten and ARCHIVED products are
   * refused — only ACTIVE products without a barcode can receive one. The value
   * is deterministic from the product's ObjectId and unique within the business;
   * the partial (businessId, barcode) index is the final authority.
   */
  async generateBarcode(businessId: IdLike, id: IdLike, userId: IdLike) {
    const doc = await this.get(businessId, id); // 404 when not in this business
    if (doc.status === 'ARCHIVED') {
      throw new ApiError(409, 'Archived products cannot receive a new barcode', 'PRODUCT_ARCHIVED');
    }
    if (doc.barcode) {
      throw new ApiError(
        409,
        'This product already has a barcode and it will not be overwritten',
        'PRODUCT_ALREADY_HAS_BARCODE'
      );
    }

    let barcode = null;
    for (const candidate of internalEan13Candidates(doc._id.toHexString())) {
      const taken = await Product.exists({ businessId, barcode: candidate });
      if (!taken) {
        barcode = candidate;
        break;
      }
    }
    if (!barcode) {
      throw new ApiError(
        409,
        'Could not allocate a unique internal barcode for this product',
        'PRODUCT_CONFLICT'
      );
    }

    // Atomic claim: only succeeds while the product still has no barcode, so two
    // concurrent generates can never both overwrite/lose a manufacturer code.
    let updated;
    try {
      updated = await Product.findOneAndUpdate(
        { _id: doc._id, businessId, status: 'ACTIVE', barcode: { $in: [null, ''] } },
        { $set: { barcode } },
        { returnDocument: 'after' }
      );
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ApiError(
          409,
          'A conflicting barcode was added concurrently — try again',
          'PRODUCT_CONFLICT'
        );
      }
      throw err;
    }

    if (!updated) {
      const fresh = await Product.findOne({ _id: doc._id, businessId });
      if (fresh?.status === 'ARCHIVED') {
        throw new ApiError(409, 'Archived products cannot receive a new barcode', 'PRODUCT_ARCHIVED');
      }
      if (fresh?.barcode) {
        throw new ApiError(
          409,
          'This product already has a barcode and it will not be overwritten',
          'PRODUCT_ALREADY_HAS_BARCODE'
        );
      }
      throw new ApiError(409, 'The product changed while the barcode was being generated — try again', 'PRODUCT_CONFLICT');
    }

    await recordAudit({
      businessId,
      userId,
      action: AUDIT_ACTIONS.PRODUCT_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.PRODUCT,
      entityId: doc._id,
      metadata: { updated: ['barcode'], internalBarcode: true },
    });
    // Re-read so the DTO carries the populated category like every other read.
    return this.get(businessId, id);
  },

  async setStatus(businessId: IdLike, id: IdLike, userId: IdLike, status: string) {
    const doc = await Product.findOne({ _id: id, businessId });
    if (!doc) notFound('Product not found');
    if (doc.status === status) return doc;

    doc.status = status;
    await doc.save();
    await recordAudit({
      businessId,
      userId,
      action: status === 'ARCHIVED' ? AUDIT_ACTIONS.PRODUCT_ARCHIVED : AUDIT_ACTIONS.PRODUCT_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.PRODUCT,
      entityId: doc._id,
      metadata: { status },
    });
    return doc;
  },

  /** Plain catalog list + search (name/sku/barcode) + category/status filters. */
  async listSimple(
    businessId: IdLike,
    {
      q,
      terms,
      exactTerms,
      includeDescription,
      status,
      categoryId,
      maxSellingPrice,
      excludeIds,
      skip,
      limit,
    }: ProductListFilters
  ) {
    const filter: Record<string, unknown> = { businessId };
    if (status === 'ACTIVE' || status === 'ARCHIVED') filter.status = status;
    if (categoryId) filter.categoryId = new ObjectId(categoryId);
    if (maxSellingPrice !== undefined) filter.sellingPrice = { $lt: maxSellingPrice };
    // AI-71 — "which products never sold" must be answered by the database, not by a page
    // compared against another page: the exclusion set is every product that HAS moved.
    if (excludeIds?.length) filter._id = { $nin: excludeIds.map((id) => new ObjectId(id)) };
    const textOr = textSearchOr({ q, terms, exactTerms, includeDescription });
    if (textOr) filter.$or = textOr;
    const total = await Product.countDocuments(filter);
    const docs = await Product.find(filter)
      .populate('categoryId', 'name status')
      // `_id` breaks createdAt ties in the same direction as the primary sort,
      // so paging a page boundary that falls inside a tie cannot repeat or skip
      // a product (see the Phase 16 audit list for the same convention).
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit);
    return { items: docs, total };
  },

  /**
   * Product list that also evaluates stock status. When a locationId is given,
   * only products stocked at that location are returned and availability is
   * computed there; otherwise availability is summed across the business.
   * lowStock  -> available <= minimumStock
   * outOfStock -> available <= 0
   * (SYSTEM_SPECIFICATION.md §19 — availability, never total quantity.)
   */
  async listWithStock(
    businessId: IdLike,
    {
      q,
      terms,
      exactTerms,
      includeDescription,
      status,
      categoryId,
      maxSellingPrice,
      locationId,
      lowStock,
      outOfStock,
      inStockOnly,
      excludeIds,
      skip,
      limit,
    }: ProductListFilters
  ) {
    const bizOid = new ObjectId(businessId);
    // Loose filter document: keys are added conditionally below.
    const match: Record<string, unknown> = { businessId: bizOid };
    if (status === 'ACTIVE' || status === 'ARCHIVED') match.status = status;
    if (categoryId) match.categoryId = new ObjectId(categoryId);
    if (maxSellingPrice !== undefined) match.sellingPrice = { $lt: maxSellingPrice };
    // AI-71 — same exclusion as `listSimple`, applied before the stock merge so the page
    // window only ever counts products that have not moved.
    if (excludeIds?.length) match._id = { $nin: excludeIds.map((id) => new ObjectId(id)) };
    const textOr = textSearchOr({ q, terms, exactTerms, includeDescription });
    if (textOr) match.$or = textOr;

    const pipeline: PipelineStage[] = [
      { $match: match },
      // No `$sort` here, and no per-product `$lookup` either.
      //
      // Phase 20H moved the sort above the first `$lookup` so the planner could take
      // `$match + $sort` together and walk the Phase 20G index
      // `{ businessId: 1, createdAt: -1, _id: -1 }`. That advice was right for the
      // shape it was written against, and this method is no longer that shape: the
      // availability merge in `availabilityIdStages` has to read the whole inventory
      // partition to answer a STOCK-FILTERED question at all, so no index can supply
      // the page order while a stock predicate is applied above it — the rows that
      // survive the predicate are not a contiguous run of any index. What matters is
      // the relative cost: the merge replaces 10 000 index-lookups (2.0–2.2 s
      // measured) with one grouped pass, while the sort it pushes into the facet
      // branch below is a few tens of milliseconds over the same rows. The page
      // window is unchanged — `$skip`/`$limit` — and `_id` still breaks `createdAt`
      // ties in the same direction, so a page boundary inside a tie is stable.
      // (Unfiltered catalogue reads never reach this method: `list()` sends them to
      // `listSimple`, whose order is still index-provided.)
      ...availabilityIdStages(bizOid, locationId),
    ];

    // Only products actually stocked at the chosen location — the merge reports
    // whether any inventory row contributed.
    if (locationId) {
      pipeline.push({ $match: { hasRow: true } });
    }
    if (inStockOnly) {
      pipeline.push({ $match: { $expr: { $gt: ['$available', 0] } } });
    }
    if (outOfStock) {
      pipeline.push({ $match: { $expr: { $lte: ['$available', 0] } } });
    }
    if (lowStock) {
      pipeline.push({ $match: { $expr: { $lte: ['$available', '$minimumStock'] } } });
    }

    pipeline.push({
      $facet: {
        // Counted after the stock filters, as it always has been, and counted on the
        // documents reaching the facet — so the page's own sort and joins cannot
        // affect it (a $facet's branches read the same input independently).
        metadata: [{ $count: 'total' }],
        data: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
        ],
      },
    });

    // `allowDiskUse` is the BACKSTOP, not the mechanism: the merge's group now carries
    // four scalars per product rather than the document (`availabilityIdStages`), so
    // spilling should never be needed. It is set anyway so that a tenant an order of
    // magnitude beyond today's degrades slowly instead of failing on MongoDB's 100 MB
    // in-memory `$group` limit — the failure §27DF measured, which surfaced as a 500
    // and as four assistant `TOOL_ERROR`s rather than as a slow answer.
    const [result] = await Product.aggregate(pipeline, { allowDiskUse: true });
    const items = await hydrateStockPage(bizOid, result?.data ?? []);
    const total = result?.metadata?.[0]?.total ?? 0;
    return { items, total };
  },

  /**
   * Products that need restocking — by default ACTIVE products whose summed
   * availability is at or below their configured minimum stock (§19 low-stock
   * definition, over the product catalog). Out-of-stock items (available <= 0)
   * sort before low-stock items so the worst-off products come first. Rows are
   * tagged OUT_OF_STOCK vs LOW_STOCK by reorderItemPublic.
   */
  async listReorder(
    businessId: IdLike,
    { q, status = 'ACTIVE', categoryId, skip = 0, limit = 20 }: ProductReorderFilters
  ) {
    const bizOid = new ObjectId(businessId);
    // Loose filter document: keys are added conditionally below.
    const match: Record<string, unknown> = { businessId: bizOid };
    if (status === 'ACTIVE' || status === 'ARCHIVED') match.status = status;
    if (categoryId) match.categoryId = new ObjectId(categoryId);
    if (q) {
      const re = { $regex: escapeRegExp(q), $options: 'i' };
      match.$or = [{ name: re }, { brand: re }, { sku: re }, { barcode: re }];
    }

    const pipeline: PipelineStage[] = [
      { $match: match },
      ...availabilityIdStages(bizOid),
      { $match: { $expr: { $lte: ['$available', '$minimumStock'] } } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          // Worst-off first (available ascending), then newest, then `_id` so a
          // tie on both leading keys still pages deterministically. The sort sits in
          // this branch rather than above the facet because the count does not depend
          // on order — the same reason this branch held the sort before the
          // availability merge (see `availabilityIdStages`). `available` and `createdAt`
          // are two of the four scalars that merge publishes, so the branch sorts the
          // page order without needing the product document at all.
          data: [
            { $sort: { available: 1, createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
          ],
        },
      },
    ];

    // Same backstop, same reason, as `listWithStock`.
    const [result] = await Product.aggregate(pipeline, { allowDiskUse: true });
    const items = await hydrateStockPage(bizOid, result?.data ?? []);
    const total = result?.metadata?.[0]?.total ?? 0;
    return { items, total };
  },

  /**
   * Stock value at the RECORDED selling price: for each active product, its available
   * quantity (summed across locations, the same figure every stock read uses) times its
   * sellingPrice. Products with no recorded price are counted apart rather than valued
   * at zero, so a missing price cannot make a product look worthless. Ranked by value.
   *
   * AI-59: `locationId` narrows both the quantity and the product set to one location, and
   * `categoryId` narrows the catalogue side, so "what is this shelf worth" or "what are our
   * keyboards worth" is one computed figure instead of arithmetic the model performs on rows.
   */
  async stockValue(
    businessId: IdLike,
    {
      limit = 10,
      locationId,
      categoryId,
    }: { limit?: number; locationId?: string; categoryId?: string } = {}
  ) {
    const bizOid = new ObjectId(businessId);
    // AI-59 — the same valuation, narrowed to one location or one category. Both sides of
    // the read take the same filter, so the quantity and the price are always describing
    // the same set of products.
    const productMatch: Record<string, unknown> = { businessId: bizOid, status: 'ACTIVE' };
    if (categoryId) productMatch.categoryId = new ObjectId(categoryId);
    // The availability merge carries only identity and stock scalars, so the price,
    // name and SKU are read from the catalogue itself. Both reads are business-scoped.
    const [stock, products] = await Promise.all([
      Product.aggregate(
        [{ $match: productMatch }, ...availabilityIdStages(bizOid, locationId)],
        { allowDiskUse: true }
      ),
      Product.find(productMatch).select({ name: 1, sku: 1, sellingPrice: 1, currency: 1 }).lean(),
    ]);
    const byId = new Map(products.map((doc) => [String(doc._id), doc as Record<string, unknown>]));

    let unitsOnHand = 0;
    let productsCounted = 0;
    let unpricedProducts = 0;
    let unpricedUnits = 0;
    // Value is accumulated PER RECORDED CURRENCY. Adding a PHP price to a USD price gives
    // a number in no currency at all, and the previous single total did exactly that as
    // soon as a tenant recorded two. A single-currency tenant still gets the familiar
    // `totalValue`; a mixed one gets `totalValue: null` plus the parts.
    const totals = new Map<
      string,
      { currency: string | null; totalValue: number; productsCounted: number; unitsOnHand: number }
    >();
    const valued: Array<{
      id: string;
      name: unknown;
      sku: unknown;
      sellingPrice: number;
      currency: string | null;
      availableQuantity: number;
      value: number;
    }> = [];
    for (const row of stock) {
      const doc = byId.get(String(row._id));
      if (!doc) continue;
      const units = Math.max(Number(row.available) || 0, 0);
      const price = typeof doc.sellingPrice === 'number' ? doc.sellingPrice : 0;
      const currency =
        typeof doc.currency === 'string' && doc.currency.trim()
          ? doc.currency.trim().toUpperCase()
          : null;
      // AI-59 — a location-scoped read is about what that place holds, so a product with
      // nothing there is not "counted". The merge returns every ACTIVE product for the
      // location (zero when it has no row there), and counting those would report a shelf
      // as holding the whole catalogue. Business-wide keeps the original meaning: every
      // active product is counted, which is the figure the member was shown before.
      if (locationId && units <= 0) continue;
      productsCounted += 1;
      unitsOnHand += units;
      if (price > 0) {
        const value = price * units;
        const key = currency ?? '';
        const group = totals.get(key) ?? {
          currency,
          totalValue: 0,
          productsCounted: 0,
          unitsOnHand: 0,
        };
        group.totalValue += value;
        group.productsCounted += 1;
        group.unitsOnHand += units;
        totals.set(key, group);
        if (units > 0) {
          valued.push({
            id: String(row._id),
            name: doc.name,
            sku: doc.sku ?? null,
            sellingPrice: price,
            currency,
            availableQuantity: units,
            value,
          });
        }
      } else {
        unpricedProducts += 1;
        unpricedUnits += units;
      }
    }
    valued.sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const totalsByCurrency = [...totals.values()].sort(
      (a, b) => b.totalValue - a.totalValue || String(a.currency).localeCompare(String(b.currency)),
    );
    const mixedCurrency = totalsByCurrency.length > 1;

    return {
      totalValue: mixedCurrency ? null : (totalsByCurrency[0]?.totalValue ?? 0),
      currency: mixedCurrency ? null : (totalsByCurrency[0]?.currency ?? null),
      mixedCurrency,
      totalsByCurrency,
      productsCounted,
      unitsOnHand,
      unpricedProducts,
      unpricedUnits,
      topByValue: valued.slice(0, limit),
      // Echoed so an answer can say exactly what it is describing ("at Main Warehouse").
      scope: locationId || categoryId ? { locationId: locationId ?? null, categoryId: categoryId ?? null } : null,
      // Stated in words because a null `totalValue` can otherwise read as "nothing is worth
      // anything" rather than "these totals are in different currencies".
      note: mixedCurrency
        ? 'totalsByCurrency holds one total per recorded currency. Do not add or convert them; report each separately.'
        : null,
    };
  },

  /**
   * One read for "what does the catalogue contain?": active-product and category
   * counts, plus how much of the optional brand/description data is actually
   * recorded. It deliberately returns no stock, price or quality field — those
   * belong to the inventory/product reads, and a count is not evidence of quality.
   * The assistant uses this to explain the catalogue and its gaps without probing
   * category by category, and without turning an empty field into a claim.
   */
  async catalogOverview(businessId: IdLike) {
    const bizOid = new ObjectId(businessId);
    const brandRecorded = { $and: [{ $eq: [{ $type: '$brand' }, 'string'] }, { $ne: ['$brand', ''] }] };
    const descriptionRecorded = {
      $and: [{ $eq: [{ $type: '$description' }, 'string'] }, { $ne: ['$description', ''] }],
    };

    const [result] = await Product.aggregate([
      { $match: { businessId: bizOid, status: 'ACTIVE' } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                withBrand: { $sum: { $cond: [brandRecorded, 1, 0] } },
                withDescription: { $sum: { $cond: [descriptionRecorded, 1, 0] } },
              },
            },
          ],
          categories: [
            {
              $group: {
                _id: '$categoryId',
                productCount: { $sum: 1 },
                withBrand: { $sum: { $cond: [brandRecorded, 1, 0] } },
                withDescription: { $sum: { $cond: [descriptionRecorded, 1, 0] } },
              },
            },
            { $sort: { productCount: -1, _id: 1 } },
          ],
          brands: [
            { $match: { brand: { $type: 'string', $ne: '' } } },
            { $group: { _id: '$brand' } },
            { $count: 'total' },
          ],
        },
      },
    ]);

    const totals = result?.totals?.[0] ?? {};
    const totalActiveProducts = Number(totals.total ?? 0);
    const productsWithBrand = Number(totals.withBrand ?? 0);
    const productsWithDescription = Number(totals.withDescription ?? 0);
    const categoryRows = (result?.categories ?? []) as Array<{
      _id?: unknown;
      productCount?: unknown;
      withBrand?: unknown;
      withDescription?: unknown;
    }>;
    const categoryIds = categoryRows.map((row) => row._id).filter(Boolean).map((id) => String(id));
    const categoryDocs = categoryIds.length
      ? await Category.find({ _id: { $in: categoryIds }, businessId: bizOid }).lean()
      : [];
    const categoryNames = new Map(categoryDocs.map((cat) => [String(cat._id), String(cat.name)]));

    return {
      totalActiveProducts,
      categoryCount: categoryRows.length,
      categories: categoryRows.map((row) => ({
        id: row._id ? String(row._id) : null,
        name: row._id ? categoryNames.get(String(row._id)) ?? 'Unnamed category' : 'Uncategorised',
        productCount: Number(row.productCount ?? 0),
        productsWithBrand: Number(row.withBrand ?? 0),
        productsWithDescription: Number(row.withDescription ?? 0),
      })),
      recordedBrands: Number(result?.brands?.[0]?.total ?? 0),
      productsWithBrand,
      productsWithoutBrand: totalActiveProducts - productsWithBrand,
      productsWithDescription,
      productsWithoutDescription: totalActiveProducts - productsWithDescription,
      note: 'Counts cover ACTIVE products only. Brand is optional: no brand recorded is not the same as no brand existing, and a blank is not a brand. A description is free text, not a specification field. This read has no stock, price or quality data — use findProducts, getProduct or getInventory for those, and never infer quality from a count.',
    };
  },

  /**
   * Recorded brands, with the active products that carry them. Brand is optional:
   * a missing or blank value is not a brand, so it is excluded rather than grouped
   * under an empty name. Stock is deliberately not joined here; the assistant can
   * check one brand's products with searchProducts/getProduct/getInventory.
   */
  async brandSummary(businessId: IdLike, { q, categoryId, limit }: BrandSummaryFilters) {
    const bizOid = new ObjectId(businessId);
    const brand: Record<string, unknown> = { $type: 'string', $ne: '' };
    if (q) {
      brand.$regex = escapeRegExp(q);
      brand.$options = 'i';
    }
    const match: Record<string, unknown> = { businessId: bizOid, status: 'ACTIVE', brand };
    if (categoryId) match.categoryId = new ObjectId(categoryId);

    const [result] = await Product.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$brand',
          productCount: { $sum: 1 },
          categoryIds: { $addToSet: '$categoryId' },
          minPrice: { $min: '$sellingPrice' },
          maxPrice: { $max: '$sellingPrice' },
          currencies: { $addToSet: '$currency' },
          sampleProducts: {
            $push: {
              id: '$_id',
              name: '$name',
              unit: '$unit',
              sellingPrice: '$sellingPrice',
              currency: '$currency',
              description: '$description',
            },
          },
        },
      },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [
            { $sort: { productCount: -1, _id: 1 } },
            { $limit: limit },
            {
              $project: {
                brand: '$_id',
                productCount: 1,
                categoryIds: 1,
                minPrice: 1,
                maxPrice: 1,
                currencies: 1,
                sampleProducts: { $slice: ['$sampleProducts', 3] },
              },
            },
          ],
        },
      },
    ]);

    const rows = (result?.data ?? []) as Array<{
      brand?: unknown;
      productCount?: unknown;
      categoryIds?: unknown[];
      minPrice?: unknown;
      maxPrice?: unknown;
      currencies?: unknown[];
      sampleProducts?: Array<{
        id?: unknown;
        name?: unknown;
        unit?: unknown;
        sellingPrice?: unknown;
        currency?: unknown;
        description?: unknown;
      }>;
    }>;

    /**
     * A brand can hold products in several currencies once `currency` is recorded,
     * and a single min/max across them would state a price range in no currency at
     * all. Mixed brands get one range per currency instead.
     */
    const currenciesOf = (row: (typeof rows)[number]) =>
      new Set(
        (row.currencies ?? []).filter(
          (code): code is string => typeof code === 'string' && /^[A-Z]{3}$/.test(code),
        ),
      );
    const mixedBrands = rows
      .filter((row) => currenciesOf(row).size > 1)
      .map((row) => String(row.brand));
    const rangesByBrand = new Map<string, Array<{ currency: string; min: number | null; max: number | null }>>();
    if (mixedBrands.length > 0) {
      const perCurrency = await Product.aggregate([
        {
          $match: {
            businessId: bizOid,
            status: 'ACTIVE',
            brand: { $in: mixedBrands },
          },
        },
        {
          $group: {
            _id: { brand: '$brand', currency: '$currency' },
            min: { $min: '$sellingPrice' },
            max: { $max: '$sellingPrice' },
          },
        },
        { $sort: { '_id.currency': 1 } },
      ]);
      for (const row of perCurrency as Array<{
        _id?: { brand?: unknown; currency?: unknown };
        min?: unknown;
        max?: unknown;
      }>) {
        const brand = String(row._id?.brand ?? '');
        if (!brand) continue;
        const bucket = rangesByBrand.get(brand) ?? [];
        bucket.push({
          currency:
            typeof row._id?.currency === 'string' && /^[A-Z]{3}$/.test(row._id.currency)
              ? row._id.currency
              : 'UNRECORDED',
          min: typeof row.min === 'number' ? row.min : null,
          max: typeof row.max === 'number' ? row.max : null,
        });
        rangesByBrand.set(brand, bucket);
      }
    }
    const categoryIds = rows
      .flatMap((row) => row.categoryIds ?? [])
      .filter(Boolean)
      .map((id) => String(id));
    const categoryDocs = categoryIds.length
      ? await Category.find({ _id: { $in: categoryIds }, businessId: bizOid }).lean()
      : [];
    const categoryNames = new Map(categoryDocs.map((cat) => [String(cat._id), String(cat.name)]));

    return {
      total: Number(result?.metadata?.[0]?.total ?? 0),
      items: rows.map((row) => {
        const brand = String(row.brand);
        const currencies = currenciesOf(row);
        const mixed = currencies.size > 1;
        return {
          brand,
          productCount: Number(row.productCount ?? 0),
          categories: (row.categoryIds ?? [])
            .map((id) => categoryNames.get(String(id)))
            .filter((name): name is string => Boolean(name)),
          priceRange: {
            min: mixed ? null : typeof row.minPrice === 'number' ? row.minPrice : null,
            max: mixed ? null : typeof row.maxPrice === 'number' ? row.maxPrice : null,
            currency: mixed ? null : ([...currencies][0] ?? null),
            ...(mixed ? { mixedCurrency: true } : {}),
          },
          ...(mixed ? { priceRanges: rangesByBrand.get(brand) ?? [] } : {}),
          sampleProducts: (row.sampleProducts ?? []).map((product) => {
            const description = typeof product.description === 'string' ? product.description : null;
            return {
              id: String(product.id),
              name: String(product.name),
              unit: product.unit ?? null,
              sellingPrice: product.sellingPrice ?? 0,
              currency:
                typeof product.currency === 'string' && /^[A-Z]{3}$/.test(product.currency)
                  ? product.currency
                  : null,
            // A brand page is a comparison page, so the recorded description travels
            // with each sample. Shortened for the same reason list rows are: three
            // descriptions must not push the brand rows out through the tool cap.
              description:
                description && description.length > BRAND_DESCRIPTION_MAX
                  ? `${description.slice(0, BRAND_DESCRIPTION_MAX - 1)}…`
                  : description,
            };
          }),
        };
      }),
    };
  },

  /** Chooses the right listing strategy depending on whether stock filters are used. */
  async list(businessId: IdLike, query: ProductListFilters) {
    const {
      q,
      terms,
      exactTerms,
      includeDescription,
      status,
      categoryId,
      maxSellingPrice,
      locationId,
      lowStock,
      outOfStock,
      inStockOnly,
      withStock,
      excludeIds,
      skip,
      limit,
    } = query;
    const needsStock = Boolean(locationId || lowStock || outOfStock || inStockOnly || withStock);
    if (needsStock) {
      return this.listWithStock(businessId, {
        q,
        terms,
        exactTerms,
        includeDescription,
        status,
        categoryId,
        maxSellingPrice,
        locationId,
        lowStock,
        outOfStock,
        inStockOnly,
        excludeIds,
        skip,
        limit,
      });
    }
    return this.listSimple(businessId, {
      q,
      terms,
      exactTerms,
      includeDescription,
      status,
      categoryId,
      maxSellingPrice,
      excludeIds,
      skip,
      limit,
    });
  },
};

export default productService;
