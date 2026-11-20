import type { HydratedDocument, Model, QueryFilter } from 'mongoose';

import Category from '../models/category.model.ts';
import Location from '../models/location.model.ts';
import Supplier from '../models/supplier.model.ts';
import Product from '../models/product.model.ts';
import { recordAudit } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import { notFound } from '../utils/errors.ts';
import ApiError from '../utils/ApiError.ts';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
} from '../constants/audit.ts';

/**
 * The document members this factory reads or writes, and nothing more. All three
 * reference models (Category, Location, Supplier) satisfy it. The supplier-only
 * contact fields are deliberately absent: they are reached through `fields`,
 * never named here, so adding one to a model needs no change to this type.
 */
type ReferenceDocShape = {
  businessId: unknown;
  name: string;
  description?: string | null;
  status?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
};

/** The reference lifecycle: ACTIVE <-> ARCHIVED, terminal at ARCHIVED. */
type ReferenceStatus = 'ACTIVE' | 'ARCHIVED';

/** The three audit action names a reference resource supplies. */
type ReferenceActions = {
  create: string;
  update: string;
  archive: string;
};

/**
 * A parsed write body. The index signature is the honest shape: the validator
 * returns `name`/`description` plus whatever extra fields the resource declares,
 * and the `fields` loop reads them by name.
 */
type ReferenceWritePayload = {
  name?: string;
  description?: string | null;
} & Record<string, unknown>;

/** The parsed list query the controller forwards, plus the resolved paging. */
type ReferenceListFilters = {
  q?: string;
  /**
   * AI-15 — an EXACT name, matched case- and surrounding-whitespace-insensitively.
   *
   * `q` is a substring search over name *and description*, so it cannot answer "which
   * record is called exactly this". The assistant needs that when a member names a
   * location: an unanchored search for "Main" returns every location whose description
   * mentions it, and truncating that list to a page could push the exact match out of
   * view entirely. Anchored here, in the service that owns the collection, rather than in
   * the AI tool, so the REST list and the assistant read the same records through the same
   * code path (the controller simply never passes it).
   */
  exactName?: string;
  status?: string;
  skip: number;
  limit: number;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reference creates/updates are committed before this audit write. A failed trail
 * insert must not turn a saved category/location/supplier into a 500 and invite a
 * duplicate retry; log the gap instead.
 */
async function safeRecordReferenceAudit(payload: Parameters<typeof recordAudit>[0]) {
  try {
    await recordAudit(payload);
  } catch (err) {
    console.error(`[reference] audit write failed after commit: ${String((err as { message?: unknown }).message)}`);
    await monitorAuditFailure({
      businessId: payload.businessId,
      action: payload.action,
      entityType: payload.entityType,
      entityId: payload.entityId,
      error: err,
    });
  }
}

/**
 * Factory for simple business-scoped "reference" resources (Category/Location).
 * All queries are scoped by the server-derived businessId — a client id alone
 * can never cross into another business. Write operations create audit logs.
 *
 * `Doc` is the model's document shape, inferred from the `Model` argument, so
 * each of the three instantiations keeps its own model's typing without the
 * factory naming any of them.
 */
export function createReferenceService<Doc extends ReferenceDocShape>({
  Model,
  entityType,
  actions,
  fields = [],
  beforeArchive,
}: {
  Model: Model<Doc>;
  entityType: string;
  actions: ReferenceActions;
  fields?: readonly string[];
  /** Optional dependency policy checked before ACTIVE -> ARCHIVED. */
  beforeArchive?: (businessId: string, id: string) => Promise<void>;
}) {
  function toPublic(doc: HydratedDocument<Doc>) {
    const out: Record<string, unknown> = {
      id: String(doc._id),
      businessId: String(doc.businessId),
      name: doc.name,
      description: doc.description ?? undefined,
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    // `doc` is only ever indexed by a name from `fields`, which no schema type
    // declares. The view is the SAME object, so every read below is the read the
    // untyped code performed.
    const view = doc as unknown as Record<string, unknown>;
    for (const field of fields) {
      if (view[field] != null) out[field] = view[field];
    }
    return out;
  }

  return {
    toPublic,

    async create(businessId: string, userId: string, payload: ReferenceWritePayload) {
      const data: Record<string, unknown> = { businessId, name: payload.name, description: payload.description };
      for (const field of fields) {
        if (payload[field] != null) data[field] = payload[field];
      }
      // `data` carries the resource's own extra fields by name, which no schema
      // type declares, so its static type is a record. It IS the object the
      // untyped code passed, and the schema casts and validates it identically.
      const doc = await Model.create(data as Partial<Doc>);
      await safeRecordReferenceAudit({
        businessId,
        userId,
        action: actions.create,
        entityType,
        entityId: doc._id,
        metadata: { name: doc.name },
      });
      return doc;
    },

    async get(businessId: string, id: string) {
      const doc = await Model.findOne({ _id: id, businessId });
      if (!doc) notFound();
      return doc;
    },

    async list(businessId: string, { q, exactName, status, skip, limit }: ReferenceListFilters) {
      const filter: QueryFilter<Doc> = { businessId };
      // Phase 20D: the controller validates `status` against the ACTIVE/ARCHIVED
      // enum, so an unrecognized value can no longer reach here. The guard is
      // unconditional because the old inline enum comparison silently DROPPED the
      // filter, answering with every row while appearing to be filtered.
      if (status) filter.status = status;
      if (exactName != null) {
        // Anchored and escaped, so a name containing a regex metacharacter is a name and
        // not a pattern, and `$` cannot be used to skip the end of the comparison.
        filter.name = { $regex: `^${escapeRegExp(exactName.trim())}$`, $options: 'i' };
      }
      if (q) {
        filter.$or = [
          { name: { $regex: escapeRegExp(q), $options: 'i' } },
          { description: { $regex: escapeRegExp(q), $options: 'i' } },
        ];
      }
      const total = await Model.countDocuments(filter);
      const docs = await Model.find(filter)
        // `_id` breaks createdAt ties in the same direction as the primary sort
        // so paging cannot repeat or skip a row.
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit);
      return { items: docs.map(toPublic), total };
    },

    async update(businessId: string, id: string, userId: string, payload: ReferenceWritePayload) {
      const doc = await Model.findOne({ _id: id, businessId });
      if (!doc) notFound();

      const updatedFields: string[] = [];
      if (payload.name !== undefined && payload.name !== doc.name) {
        doc.name = payload.name;
        updatedFields.push('name');
      }
      if (payload.description !== undefined && payload.description !== doc.description) {
        doc.description = payload.description;
        updatedFields.push('description');
      }
      // Same reason as `toPublic`: the loop's field names come from `fields` and
      // are declared by no schema type. `view` IS `doc`, so `view[field]` and
      // `view[field] = …` still run the schema getters and setters.
      const view = doc as unknown as Record<string, unknown>;
      for (const field of fields) {
        if (payload[field] !== undefined && payload[field] !== view[field]) {
          view[field] = payload[field];
          updatedFields.push(field);
        }
      }
      if (updatedFields.length > 0) {
        await doc.save();
        await safeRecordReferenceAudit({
          businessId,
          userId,
          action: actions.update,
          entityType,
          entityId: doc._id,
          metadata: { updated: updatedFields },
        });
      }
      return doc;
    },

    /** Set status ACTIVE or ARCHIVED. ARCHIVED -> actions.archive; else update. */
    async setStatus(businessId: string, id: string, userId: string, status: ReferenceStatus) {
      const doc = await Model.findOne({ _id: id, businessId });
      if (!doc) notFound();
      if (doc.status === status) return doc;

      if (status === 'ARCHIVED' && beforeArchive) {
        await beforeArchive(businessId, id);
      }

      doc.status = status;
      await doc.save();
      await safeRecordReferenceAudit({
        businessId,
        userId,
        action: status === 'ARCHIVED' ? actions.archive : actions.update,
        entityType,
        entityId: doc._id,
        metadata: { status },
      });
      return doc;
    },
  };
}

export const categoryService = createReferenceService({
  Model: Category,
  entityType: AUDIT_ENTITY_TYPES.CATEGORY,
  actions: {
    create: AUDIT_ACTIONS.CATEGORY_CREATED,
    update: AUDIT_ACTIONS.CATEGORY_UPDATED,
    archive: AUDIT_ACTIONS.CATEGORY_ARCHIVED,
  },
  /**
   * A category is a filing choice, not a delete switch. Archiving one that still
   * has ACTIVE products would hide the products' only grouping from every active
   * picker while leaving the products themselves active. Refuse and name the
   * dependency; the member can move or archive those products first. Products
   * already ARCHIVED keep their historical category, which is why they do not
   * block this transition.
   */
  async beforeArchive(businessId, id) {
    const activeProducts = await Product.countDocuments({
      businessId,
      categoryId: id,
      status: 'ACTIVE',
    });
    if (activeProducts > 0) {
      throw new ApiError(
        409,
        `This category still has ${activeProducts} active product${activeProducts === 1 ? '' : 's'}. Move or archive them before archiving the category.`,
        'CATEGORY_HAS_ACTIVE_PRODUCTS',
      );
    }
  },
});

export const locationService = createReferenceService({
  Model: Location,
  entityType: AUDIT_ENTITY_TYPES.LOCATION,
  actions: {
    create: AUDIT_ACTIONS.LOCATION_CREATED,
    update: AUDIT_ACTIONS.LOCATION_UPDATED,
    archive: AUDIT_ACTIONS.LOCATION_ARCHIVED,
  },
});

export const supplierService = createReferenceService({
  Model: Supplier,
  entityType: AUDIT_ENTITY_TYPES.SUPPLIER,
  fields: ['contactName', 'phone', 'email'],
  actions: {
    create: AUDIT_ACTIONS.SUPPLIER_CREATED,
    update: AUDIT_ACTIONS.SUPPLIER_UPDATED,
    archive: AUDIT_ACTIONS.SUPPLIER_ARCHIVED,
  },
});

export default {
  createReferenceService,
  categoryService,
  locationService,
  supplierService,
};
