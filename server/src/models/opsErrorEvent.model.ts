import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * OPS-8 — one durable record of a request that failed with a 5xx.
 *
 * WHY THIS EXISTS. The OPS-2 counters are process-local: a restart resets them,
 * and a 5xx that happened before the restart leaves no queryable trace at all.
 * The request log still has it, but a log is not a store an operator can read
 * after Render rotates it. This row is the durable half — enough to say WHAT
 * failed, WHEN, and WHICH BROAD ROUTE, without copying the sensitive parts of a
 * request into a second place.
 *
 * WHAT IS DELIBERATELY ABSENT.
 *   * No error message or stack. Either can contain a connection string, an
 *     internal path, or a provider response.
 *   * No request body, query string, header, token, email, user id or tenant
 *     name. `businessId` is present only when an authenticated request already
 *     carried one; it is never accepted from a client.
 *   * No raw path. Dynamic ObjectId/numeric segments are collapsed to `:id`, so
 *     the row can be grouped without storing someone's resource identifier.
 *
 * A row is tenant data when `businessId` is present and platform-only otherwise.
 * Tenant teardown removes the former; a TTL removes both after 90 days so this
 * collection cannot grow forever.
 */
const opsErrorEventSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
    },
    occurredAt: {
      type: Date,
      required: [true, 'occurredAt is required'],
      default: Date.now,
    },
    status: {
      type: Number,
      required: [true, 'status is required'],
      min: 500,
      max: 599,
    },
    code: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },
    method: {
      type: String,
      trim: true,
      maxlength: 12,
      default: null,
    },
    route: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '/',
    },
    expiresAt: {
      type: Date,
      required: [true, 'expiresAt is required'],
    },
  },
  { collection: 'ops_error_events', timestamps: false },
);

// A tenant-scoped read (support detail or a future tenant view) reads one
// business's window, newest first. The removed tenant draft used this shape.
opsErrorEventSchema.index({ businessId: 1, occurredAt: -1 });
// The platform report reads every event in a window.
opsErrorEventSchema.index({ occurredAt: -1 });
// Retention is enforced by MongoDB's TTL monitor.
opsErrorEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OpsErrorEvent = mongoose.model('OpsErrorEvent', opsErrorEventSchema);

export default OpsErrorEvent;
