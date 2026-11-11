import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * AI-102 — one durable record per completed assistant turn.
 *
 * WHY THIS EXISTS. AI-101 made each turn readable as a text line, but a log line is not a
 * queryable store: counting free vs paid usage, failover rate, latency percentiles and daily
 * spend meant reading and parsing the whole log history, and Render's retention eventually
 * removes it. This collection is the structured source for the metrics endpoint. It stores
 * only operational facts — counts, durations, model ids and provider-reported charges — never
 * a prompt, an answer, a tool result, a URL or a credential.
 *
 * ONE TURN, ONE DOCUMENT. `turnId` alone is an 8-hex correlation id, not a database key; a
 * collision is possible over a long history. The unique key includes `businessId` and
 * `startedAt`, so two different turns that happen to share a turn id are both retained, while a
 * retried write for the SAME turn updates its one row. The endpoint counts documents, not
 * provider calls.
 *
 * COST IS NOT INVENTED. `providerCostUsd` is the sum of the charges the provider actually
 * reported. It is null when no call reported a charge, and `costStatus = 'partial'` when some
 * calls did and others did not. An unknown cost is never stored as zero; the aggregation
 * reports how many turns are unknown instead.
 */
const aiTurnMetricSchema = new Schema(
  {
    turnId: {
      type: String,
      required: [true, 'turnId is required'],
      trim: true,
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'businessId is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    startedAt: {
      type: Date,
      required: [true, 'startedAt is required'],
    },
    completedAt: {
      type: Date,
      required: [true, 'completedAt is required'],
    },
    /** The precise turn outcome (`ok`, `degraded`, `AI_TIMEOUT`, ...). */
    outcome: {
      type: String,
      required: [true, 'outcome is required'],
      trim: true,
    },
    /** The readable status derived from `outcome`, kept so grouping needs no string parsing. */
    status: {
      type: String,
      enum: ['ok', 'degraded', 'failed'],
      required: [true, 'status is required'],
    },
    route: {
      type: String,
      trim: true,
    },
    model: {
      type: String,
      trim: true,
      default: null,
    },
    /** `free` for a `:free` model id, `paid` for every other id, `unknown` when none answered. */
    tier: {
      type: String,
      enum: ['free', 'paid', 'unknown'],
      required: [true, 'tier is required'],
    },
    upstream: {
      type: String,
      trim: true,
      default: null,
    },
    durationMs: {
      type: Number,
      required: true,
      min: 0,
    },
    providerMs: {
      type: Number,
      required: true,
      min: 0,
    },
    toolMs: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Provider calls. A turn with tool rounds makes several; this is not a turn count. */
    calls: {
      type: Number,
      required: true,
      min: 0,
    },
    emptyResponses: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Empty-completion retries plus grounding re-asks. NOT model failovers. */
    retries: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Actual switches to another model. Deliberately separate from `retries` and `reasks`. */
    failovers: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Simple-route re-asks that asked the free model to perform its required read. */
    reasks: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Simple-route escalations from the free start model to the paid primary. */
    escalations: {
      type: Number,
      required: true,
      min: 0,
    },
    iterations: {
      type: Number,
      required: true,
      min: 0,
    },
    toolRuns: {
      type: Number,
      required: true,
      min: 0,
    },
    tools: [
      {
        type: String,
        trim: true,
      },
    ],
    inputTokens: {
      type: Number,
      required: true,
      min: 0,
    },
    outputTokens: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Sum of provider-reported charges, or null when no call reported one. */
    providerCostUsd: {
      type: Number,
      default: null,
      min: 0,
    },
    /** True only when every provider call in the turn reported a charge. */
    providerCostComplete: {
      type: Boolean,
      required: true,
    },
    /** Provider calls whose response omitted a charge. */
    unknownCostCalls: {
      type: Number,
      required: true,
      min: 0,
    },
    costStatus: {
      type: String,
      enum: ['provider', 'partial', 'unknown'],
      required: [true, 'costStatus is required'],
    },
    /** The allowance reading exactly as the turn line prints it (`0/50`, `unknown`). */
    quota: {
      type: String,
      trim: true,
    },
    /** `web_search`, `web_fetch`, a combination, or `none`. */
    web: {
      type: String,
      trim: true,
    },
  },
  { collection: 'ai_turn_metrics', timestamps: false }
);

// The metrics query is always tenant-scoped and time-windowed. This is the index it uses.
aiTurnMetricSchema.index({ businessId: 1, completedAt: -1 });
// One row per turn. `startedAt` makes a turn-id collision between two real turns harmless.
aiTurnMetricSchema.index({ businessId: 1, turnId: 1, startedAt: 1 }, { unique: true });

const AiTurnMetric = mongoose.model('AiTurnMetric', aiTurnMetricSchema);

export default AiTurnMetric;
