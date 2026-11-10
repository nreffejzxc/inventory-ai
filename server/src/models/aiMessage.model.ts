import mongoose from 'mongoose';

const { Schema } = mongoose;


const aiMessageRoles = ['USER', 'ASSISTANT', 'TOOL'];

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
