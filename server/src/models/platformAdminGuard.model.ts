import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * PLAT-8 — the single document that serialises administrator lifecycle writes.
 *
 * WHY THIS EXISTS. `assertNotLastActiveSuperadmin` is a read-then-write rule:
 * count the other ACTIVE SUPERADMINs, then disable or delete the target. Two
 * administrators acting at the same moment could both read "one other exists"
 * and both commit, leaving zero ACTIVE SUPERADMINs and locking the platform
 * plane out with no route back in.
 *
 * A MongoDB transaction does not fix this by itself: two transactions that read
 * the same set of administrator rows and write different ones hit write skew,
 * which snapshot isolation permits. Serialising on ONE shared document does fix
 * it — the conditional `findOneAndUpdate` below is atomic, so exactly one holder
 * can be inside the check-and-write section at a time.
 *
 * The lease carries an expiry so a crashed or paused process cannot hold the
 * plane forever: an expired lease is taken over, and the next holder re-reads
 * the administrator rows before acting. The row holds no personal data.
 */
const platformAdminGuardSchema = new Schema(
  {
    _id: { type: String, required: true },
    lockToken: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
  },
  { collection: 'platform_admin_guards', timestamps: false, versionKey: false },
);

const PlatformAdminGuard = mongoose.model('PlatformAdminGuard', platformAdminGuardSchema);

export default PlatformAdminGuard;
