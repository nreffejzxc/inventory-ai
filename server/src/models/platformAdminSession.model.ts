import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A Platform Operations session — the server-side half of a platform token.
 *
 * SEPARATE FROM `sessions` ON PURPOSE. A tenant session names a `User` and is
 * accepted only by `requireAuth` on `/api/*`; this row names a `PlatformAdmin`
 * and is accepted only by `requirePlatformAdmin` on `/api/platform/*`. The two
 * collections are never queried by the other plane, so a stolen tenant `jti`
 * cannot resolve to a platform session and vice versa.
 *
 * The row carries NO capability or role. Authorization is read from the
 * `PlatformAdmin` row on every request, so a demotion or disable takes effect
 * immediately even on an already-issued token.
 *
 * Lifetimes:
 *   * absolute — 8 hours from creation, never extended;
 *   * idle — 15 minutes since `lastUsedAt`. `lastUsedAt` is written at creation,
 *     so a session that is never used ages out rather than passing the idle test
 *     by having a null timestamp.
 */
const platformAdminSessionSchema = new Schema(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'PlatformAdmin',
      required: [true, 'adminId is required'],
    },
    jti: {
      type: String,
      required: [true, 'jti is required'],
      unique: true,
      trim: true,
    },
    deviceLabel: {
      type: String,
      default: 'Unknown device',
      trim: true,
    },
    lastUsedAt: {
      type: Date,
      required: [true, 'lastUsedAt is required'],
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: [true, 'expiresAt is required'],
    },
  },
  { collection: 'platform_admin_sessions', timestamps: true },
);

platformAdminSessionSchema.index({ adminId: 1, revokedAt: 1 });
// Expired rows are garbage once the absolute cap passes.
platformAdminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PlatformAdminSession = mongoose.model(
  'PlatformAdminSession',
  platformAdminSessionSchema,
);

export default PlatformAdminSession;
