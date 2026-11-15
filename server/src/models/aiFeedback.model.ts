import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * AI-115 — one member's rating of one stored assistant answer.
 *
 * WHY IT IS NOT A FIELD ON THE MESSAGE. A rating belongs to a PERSON, not to the
 * answer: two members of the same business can read the same conversation only if
 * they own it, but a rating still needs an author, an update time and a review
 * state. Keeping it separate also keeps the immutable assistant message
 * immutable, and lets an owner/admin review reports without changing the thread.
 *
 * TENANT ISOLATION. `businessId` and `userId` are written from the authenticated
 * session and the conversation is ownership-checked before the upsert. The unique
 * key is (business, message, user), so a member can change a rating but cannot
 * create two opinions about one answer.
 */
const aiFeedbackSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
      index: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'AIConversation',
      required: [true, 'conversationId is required'],
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'AIMessage',
      required: [true, 'messageId is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      index: true,
    },
    rating: {
      type: String,
      enum: ['UP', 'DOWN'],
      required: [true, 'rating is required'],
    },
    /** A short category chosen by the member after a DOWN rating. */
    reason: {
      type: String,
      enum: ['INCORRECT_DATA', 'MISSING_INFORMATION', 'HARD_TO_UNDERSTAND', 'OTHER'],
      default: null,
    },
    /** The member's optional note, bounded at the HTTP boundary. */
    comment: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    /** Snapshot of the turn id, so support can find the logs even if a message is gone. */
    turnId: {
      type: String,
      trim: true,
      default: null,
    },
    /** OPEN until an owner/admin has read the report. */
    status: {
      type: String,
      enum: ['OPEN', 'REVIEWED'],
      default: 'OPEN',
      index: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { collection: 'ai_feedback', timestamps: true },
);

// One opinion per member per answer, while updates remain possible.
aiFeedbackSchema.index({ businessId: 1, messageId: 1, userId: 1 }, { unique: true });
// The review queue: newest first, optionally narrowed to open reports or a rating.
aiFeedbackSchema.index({ businessId: 1, status: 1, createdAt: -1 });
aiFeedbackSchema.index({ businessId: 1, rating: 1, createdAt: -1 });

const AiFeedback = mongoose.model('AiFeedback', aiFeedbackSchema);

export default AiFeedback;