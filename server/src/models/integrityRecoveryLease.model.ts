import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One short-lived lease for the integrity recovery pass. The `_id` is fixed, so
 * MongoDB's primary-key uniqueness is the mutex: only one owner can hold it.
 * `expiresAt` is a TTL key and is also checked explicitly on acquisition, so a
 * crashed owner does not block recovery until the TTL monitor happens to run.
 */
const integrityRecoveryLeaseSchema = new Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    token: { type: String, required: true },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'integrity_recovery_leases', versionKey: false }
);

integrityRecoveryLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IntegrityRecoveryLease = mongoose.model(
  'IntegrityRecoveryLease',
  integrityRecoveryLeaseSchema
);

export default IntegrityRecoveryLease;
