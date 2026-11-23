import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Durable hand-off for an audit event that must survive a crash between the
 * business write and the audit insert. A normal `recordAuditOnce` is already
 * idempotent, but only while the request that calls it is alive. The outbox is
 * written first, then delivered by the same request or by a later recovery
 * pass, so a committed operation cannot lose its audit row permanently.
 *
 * STATES
 *   PENDING    enqueued and waiting for a delivery attempt
 *   SENDING    claimed by one worker; a crashed worker is reclaimed after a
 *              bounded stale window, not treated as permanent ownership
 *   DELIVERED  the AuditLog row exists (or already existed under the same key)
 *   FAILED     the last attempt failed; retained and retried after backoff, so
 *              this is a visible retry state rather than a terminal gap
 *
 * RETENTION. Only DELIVERED rows expire, through a partial TTL index on
 * `deliveredAt`. The AuditLog row is the durable governance record; the outbox
 * row is its delivery receipt and is no longer needed after the retention
 * window. FAILED rows deliberately have no `deliveredAt`, so they are never
 * expired: they are retried until an operator fixes the dependency, and deleting
 * one would destroy the only evidence that an audit is still missing.
 */
export const AUDIT_OUTBOX_DELIVERED_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The single definitions used by the schema, readiness and the rollout command.
 * Keeping them exported prevents a check from drifting away from the index the
 * model actually builds.
 */
export const AUDIT_OUTBOX_DELIVERED_TTL_INDEX = {
  name: 'audit_outbox_delivered_ttl',
  key: { deliveredAt: 1 },
  expireAfterSeconds: AUDIT_OUTBOX_DELIVERED_RETENTION_SECONDS,
  partialFilterExpression: { status: 'DELIVERED' },
} as const;

export const AUDIT_OUTBOX_STATUS_TRIAGE_INDEX = {
  name: 'audit_outbox_status_updated',
  key: { status: 1, updatedAt: 1 },
} as const;

const auditOutboxSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    dedupeKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    entityType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    entityId: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    status: {
      type: String,
      enum: ['PENDING', 'SENDING', 'DELIVERED', 'FAILED'],
      default: 'PENDING',
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    availableAt: {
      type: Date,
      default: () => new Date(),
      required: true,
    },
    claimedAt: Date,
    deliveredAt: Date,
    lastError: {
      type: String,
      trim: true,
      maxlength: 200,
    },
  },
  { collection: 'audit_outbox', timestamps: true },
);

// One durable event per tenant and key. A retry of the same business operation
// finds the existing row instead of enqueueing a second copy.
auditOutboxSchema.index({ businessId: 1, dedupeKey: 1 }, { unique: true });
// The flusher reads due work and reclaims abandoned SENDING rows.
auditOutboxSchema.index({ status: 1, availableAt: 1 });
auditOutboxSchema.index({ status: 1, claimedAt: 1 });
// Operator triage for a FAILED row whose retries have not converged. The index
// makes an age scan bounded; it does not expire anything.
// Unnamed for the same reason as the movement repair key: an existing database
// may already carry this key under Mongoose's generated name.
auditOutboxSchema.index(AUDIT_OUTBOX_STATUS_TRIAGE_INDEX.key);
// Bounded DELIVERED retention. The partial filter is explicit even though only
// delivered rows carry `deliveredAt`; it states that FAILED/PENDING/SENDING rows
// are outside the TTL boundary and cannot be removed by the TTL monitor.
auditOutboxSchema.index(AUDIT_OUTBOX_DELIVERED_TTL_INDEX.key, {
  name: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.name,
  expireAfterSeconds: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.expireAfterSeconds,
  partialFilterExpression: AUDIT_OUTBOX_DELIVERED_TTL_INDEX.partialFilterExpression,
});

const AuditOutbox = mongoose.model('AuditOutbox', auditOutboxSchema);

export default AuditOutbox;
