import mongoose from 'mongoose';

const { Schema } = mongoose;

// How long a claimed key is remembered. Long enough to cover a member retrying a
// form they were told had failed, and far shorter than any audit requirement: the
// record is a de-duplication receipt, not history. The ledger remains the truth.
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * One claimed `Idempotency-Key` and the answer the request that claimed it gave.
 *
 * WHY THIS EXISTS. The movement itself is written exactly once, but the request
 * that carries it is not guaranteed to be delivered exactly once. The client has a
 * request budget (15 s, longer on a cold instance), and the measured Render cold
 * start outlasts it: the member is told the stock-in failed, taps again, and the
 * server — which had in fact applied the first attempt — applies it a second time.
 * The result is two ledger rows for one tap: two Recent Activity entries, and a
 * quantity that is wrong by the whole movement. An earlier investigation of the
 * same symptom found no duplicate write anywhere in the services; the duplicate
 * only appears when the same operation is SENT twice.
 *
 * The client mints one key per operation attempt and re-sends it when it retries
 * that attempt. This row is what lets the second delivery REPLAY the first answer
 * instead of re-applying it.
 *
 * `fingerprint` is the SHA-256 of the request body. It is what keeps a key from
 * answering a different operation: a replay must describe the same movement, or it
 * is refused rather than silently returning somebody else's quantities.
 */
const idempotencyRecordSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
    },
    key: {
      type: String,
      required: [true, 'key is required'],
      trim: true,
    },
    fingerprint: {
      type: String,
      required: [true, 'fingerprint is required'],
    },
    /**
     * `IN_PROGRESS` while the request that owns the key is running, `COMPLETED`
     * once its answer exists. Only a COMPLETED record can be replayed.
     */
    state: {
      type: String,
      enum: ['IN_PROGRESS', 'COMPLETED'],
      default: 'IN_PROGRESS',
      required: true,
    },
    /** Status the owning request answered with, replayed verbatim. */
    responseStatus: {
      type: Number,
    },
    /** Body the owning request answered with, replayed verbatim. */
    responseBody: {
      type: Schema.Types.Mixed,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { collection: 'idempotency_records' }
);

// The claim itself. Unique, so two deliveries of one key cannot both own it: the
// loser reads the winner's row and either replays its answer or is told to wait.
idempotencyRecordSchema.index({ businessId: 1, key: 1 }, { unique: true });
// Expiry, so the collection cannot grow without bound. Declared here rather than
// set by an operator, so `phase-index-integrity` can prove the TTL was built.
idempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_SECONDS });

const IdempotencyRecord = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);

export default IdempotencyRecord;
