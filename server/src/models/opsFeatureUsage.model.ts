import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * OPS-8 — one member's use of one feature on one UTC day.
 *
 * WHY THIS SHAPE. "Active members" and "feature usage" are set questions, not
 * volume questions: one row per (business, day, feature, member) answers both
 * without storing a request log. A repeat visit updates `lastSeenAt`; it does
 * not add a document or increment a counter, so a busy reader cannot make this
 * collection grow.
 *
 * WHAT IS DELIBERATELY ABSENT. No path, method, request id, body, query, token,
 * resource id, IP or account name. The only identifiers are the owning business
 * and the member — both derived from the authenticated session — plus the
 * feature key this server chose.
 *
 * A row is deleted with its tenant and expires after 90 days. The unique key is
 * what makes the upsert safe when two requests for the same member arrive at
 * once.
 */
const opsFeatureUsageSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
    },
    date: {
      type: String,
      required: [true, 'date is required'],
      match: [/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'],
    },
    feature: {
      type: String,
      required: [true, 'feature is required'],
      trim: true,
      maxlength: 40,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    firstSeenAt: {
      type: Date,
      required: [true, 'firstSeenAt is required'],
    },
    lastSeenAt: {
      type: Date,
      required: [true, 'lastSeenAt is required'],
    },
    expiresAt: {
      type: Date,
      required: [true, 'expiresAt is required'],
    },
  },
  { collection: 'ops_feature_usage', timestamps: false },
);

// The platform report reads one date window across every tenant.
opsFeatureUsageSchema.index({ date: 1 });
// A tenant-scoped read (support detail or a future tenant view) answers the
// distinct-member count by feature.
opsFeatureUsageSchema.index({ businessId: 1, date: 1, feature: 1 });
// One member sees a feature once per day, however many requests made it.
opsFeatureUsageSchema.index(
  { businessId: 1, date: 1, feature: 1, userId: 1 },
  { unique: true },
);
// Retention is enforced by MongoDB's TTL monitor.
opsFeatureUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OpsFeatureUsage = mongoose.model('OpsFeatureUsage', opsFeatureUsageSchema);

export default OpsFeatureUsage;
