import mongoose from 'mongoose';

const { Schema } = mongoose;


const aiMessageRoles = ['USER', 'ASSISTANT', 'TOOL'];

/**
 * AI-111 — the catalogue ids behind the product names an assistant answer can open.
 * Stored on the message so a reopened thread keeps the same direct actions; absent on
 * every message written before this field existed.
 */
const productLinkSchema = new Schema(
  {
    productId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
  },
  { _id: false },
);

const answerListRowSchema = new Schema(
  {
    productId: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    detail: { type: String, trim: true },
  },
  { _id: false },
);

const answerListSchema = new Schema(
  {
    kind: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    path: { type: String, required: true, trim: true },
    total: { type: Number, required: true, min: 0 },
    rows: { type: [answerListRowSchema], default: [] },
  },
  { _id: false },
);

const answerScreenSchema = new Schema(
  {
    kind: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    path: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const answerActionsSchema = new Schema(
  {
    list: { type: answerListSchema },
    screens: { type: [answerScreenSchema], default: [] },
  },
  { _id: false },
);

const answerFilterSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const answerWebSourceSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/**
 * AI-116 — what an answer read, bounded to ids and provenance.
 *
 * The ids are MEMBERSHIP for a follow-up, not a stock snapshot. `retrievedAt` is
 * the last successful row read, and the follow-up tool re-reads current stock for
 * those ids, so nothing here can become a stale quantity in the next answer.
 */
const answerContextSchema = new Schema(
  {
    retrievedAt: { type: Date, required: true },
    tools: { type: [String], default: [] },
    sources: { type: [String], default: [] },
    productCount: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: null, min: 0 },
    hasMore: { type: Boolean, default: false },
    filters: { type: [answerFilterSchema], default: [] },
    resultTool: { type: String, trim: true },
    resultInput: { type: Schema.Types.Mixed },
    resultProductIds: { type: [String], default: [] },
    webSources: { type: [answerWebSourceSchema], default: [] },
  },
  { _id: false },
);

const aiMessageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'AIConversation',
      required: [true, 'conversationId is required'],
      index: true,
    },
    role: {
      type: String,
      enum: aiMessageRoles,
      required: [true, 'role is required'],
    },
    content: {
      type: String,
      required: [true, 'content is required'],
    },
    model: {
      type: String,
      trim: true,
    },
    /**
     * The per-turn correlation id (AI monitoring) this answer was produced under. It is
     * written on the ASSISTANT message so a conversation read back later can still name the
     * turn whose `AI request` / `AI model call` / `AI turn` lines are in the logs. Absent on
     * every message stored before the id was returned, exactly like `degraded`.
     */
    turnId: {
      type: String,
      trim: true,
    },
    toolsUsed: [
      {
        type: String,
        trim: true,
      },
    ],
    productLinks: {
      type: [productLinkSchema],
      default: undefined,
    },
    /** AI-112 — direct screen destinations and a bounded page of the rows behind the answer. */
    answerActions: {
      type: answerActionsSchema,
      default: undefined,
    },
    /** AI-116 — provenance and bounded membership behind this answer. */
    answerContext: {
      type: answerContextSchema,
      default: undefined,
    },
    usage: {
      type: Schema.Types.Mixed,
    },
    /**
     * AI-8 — set ONLY on an assistant turn that was marked degraded, and so absent on
     * every message written before this (and on every healthy turn).
     *
     * It is stored because the mark has to survive the round trip: a thread reopened
     * tomorrow must not look more trustworthy than the screen that produced it, and the
     * rate of each reason becomes countable from the database rather than only from a
     * log file that rotation will eat. A plain trimmed String, not an enum, because the
     * vocabulary belongs to the service that produces it (`DegradedReason`) and a second
     * copy here could silently disagree with the first.
     */
    degraded: {
      type: String,
      trim: true,
    },
  },
  { collection: 'ai_messages', timestamps: true }
);

aiMessageSchema.index({ conversationId: 1, createdAt: 1 });
// Phase 20C (H-1): conversation messages are read oldest-first with a deterministic
// tiebreaker — `sort({ createdAt: 1, _id: 1 })` (ai.controller.js). The index above
// matches the equality + `createdAt` prefix but not the `_id` key, so the sort was
// executed in memory. Declaring the full key shape makes it index-ordered.
aiMessageSchema.index({ conversationId: 1, createdAt: 1, _id: 1 });

const AIMessage = mongoose.model('AIMessage', aiMessageSchema);

export default AIMessage;
