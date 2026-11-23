import type mongoose from 'mongoose';

import AuditLog from '../models/auditLog.model.ts';

/**
 * Local to this module, following `inventory.service.ts` and `product.service.ts`:
 * every caller passes an ObjectId or the string it was built from, and the model
 * casts whichever arrives. Declared here rather than in a shared module so that
 * audit.service stays free of a cycle back through inventory.service.
 */
type IdLike = string | mongoose.Types.ObjectId;

/**
 * The event `recordAudit` accepts — the "who/what/which entity/when" shape of
 * AuditLog. `entityId` is stringified on the way in, so either form is accepted;
 * `userId` is null for system-initiated events.
 */
type AuditEvent = {
  businessId: IdLike;
  userId?: IdLike | null;
  action: string;
  entityType: string;
  entityId?: IdLike | null;
  metadata?: unknown;
  /** Present only on a replayable event; unique within its business. */
  dedupeKey?: string;
};

/**
 * The audit fields `toPublicAudit` reads. They are `unknown` because this is the
 * boundary where a stored document — including a populated `userId` — is narrowed
 * into the public shape: the whitelist is enforced by what is read here, not by
 * what the model happens to hold.
 */
type AuditRow = {
  _id: unknown;
  action: unknown;
  entityType: unknown;
  entityId?: unknown;
  userId?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
};

/**
 * The filter `listAudit` builds. Derived from the model itself rather than
 * declared as a structural shape: `QueryFilter<Doc>` maps each field to that
 * field's own condition type, so the filter is checked against the real schema at
 * the `.countDocuments()`/`.find()` call instead of drifting from it. The model
 * exports only the model, so its document type is taken from it here and
 * `auditLog.model.ts` is left untouched.
 */
type AuditFilter = mongoose.QueryFilter<mongoose.HydratedDocFromModel<typeof AuditLog>>;

/** The validated filters `listAudit` receives from the controller. */
type AuditListFilters = {
  action?: string;
  entityType?: string;
  userId?: IdLike;
  from?: Date;
  to?: Date;
  q?: string;
  skip: number;
  limit: number;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Records an audit event. Keeps the "who/what/which entity/when" shape of
 * AuditLog. Must never include sensitive values (no credentials, no prices of
 * unrelated data, no internal errors).
 */
export async function recordAudit({ businessId, userId, action, entityType, entityId, metadata, dedupeKey }: AuditEvent) {
  return AuditLog.create({
    businessId,
    userId: userId || null,
    action,
    entityType,
    entityId: entityId == null ? undefined : String(entityId),
    metadata,
    dedupeKey: dedupeKey?.trim() || undefined,
  });
}

/**
 * Records a replayable event at most once per business. The unique partial index
 * on `{ businessId, dedupeKey }` is the arbiter, so two concurrent deliveries
 * cannot both append: the loser reads and returns the winner's row. A duplicate
 * error whose row cannot be found is rethrown rather than hidden, because that
 * means the index refused something this helper does not understand.
 */
export async function recordAuditOnce(event: AuditEvent & { dedupeKey: string }) {
  const dedupeKey = event.dedupeKey.trim();
  if (!dedupeKey) throw new Error('recordAuditOnce requires a non-empty dedupeKey');
  try {
    return await recordAudit({ ...event, dedupeKey });
  } catch (err) {
    if ((err as { code?: unknown } | null | undefined)?.code !== 11000) throw err;
    const existing = await AuditLog.findOne({ businessId: event.businessId, dedupeKey }).lean();
    if (!existing) throw err;
    return existing;
  }
}

/**
 * Public shape of one audit row (Phase 16) — a strict whitelist, never the raw
 * document. `actor` is null for system-initiated events (no authenticated
 * user). metadata passes through as-is because recordAudit's contract already
 * guarantees secret-free content.
 */
export function toPublicAudit(log: AuditRow) {
  const actor = log.userId
    ? { id: String((log.userId as { _id?: unknown })._id ?? log.userId), name: (log.userId as { name?: unknown }).name ?? null }
    : null;
  return {
    id: String(log._id),
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId ?? null,
    actor,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt,
  };
}

/**
 * Business-scoped audit trail query (Phase 16). businessId always comes from
 * the authenticated session — cross-business rows are never reachable. Filters
 * are validated by the caller (validateAuditList); here they are only
 * translated into a Mongo filter. Newest first.
 */
export async function listAudit(businessId: string, { action, entityType, userId, from, to, q, skip, limit }: AuditListFilters) {
  const filter: AuditFilter = { businessId };
  if (action) filter.action = action;
  if (entityType) filter.entityType = entityType;
  if (userId) filter.userId = userId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  if (q) {
    filter.$or = [
      { action: { $regex: escapeRegExp(q), $options: 'i' } },
      { entityId: { $regex: escapeRegExp(q), $options: 'i' } },
    ];
  }

  const total = await AuditLog.countDocuments(filter);
  const docs = await AuditLog.find(filter)
    // The `_id` tiebreaker matches History: rows written in the same
    // millisecond still have a stable order, so paging cannot repeat or skip
    // one. Without it, tied rows come back oldest-first.
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .populate('userId', 'name');

  return { items: docs.map(toPublicAudit), total };
}

export default { recordAudit, recordAuditOnce, listAudit, toPublicAudit };
