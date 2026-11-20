import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One durable audit-write failure.
 *
 * Audit rows are intentionally best-effort after a business write has committed:
 * failing the request would invite a retry that repeats the committed write.
 * The gap that leaves is real, though, and until now it existed only as a
 * console line. This collection makes the gap countable by action, tenant and
 * day without copying an error message, a request body, an address or a secret
 * into a second store.
 *
 * `errorCode` is a short, sanitized classification (for example
 * `AUDIT_WRITE_FAILED`), never an upstream message. A TTL keeps the collection
 * bounded; the status endpoint and audit report command read the window.
 */
const auditFailureSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
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
    errorCode: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      default: 'AUDIT_WRITE_FAILED',
    },
    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { collection: 'audit_failures' }
);

auditFailureSchema.index({ businessId: 1, occurredAt: -1 });
auditFailureSchema.index({ occurredAt: -1 });
auditFailureSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AuditFailure = mongoose.model('AuditFailure', auditFailureSchema);

export default AuditFailure;
