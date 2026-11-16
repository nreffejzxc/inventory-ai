import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * PLAT-6 — an internal support ticket.
 *
 * This collection is platform-only. It deliberately carries NO tenant id and
 * no customer inventory, credential or conversation content: support staff can
 * describe a concern, but the console is not a back door into a tenant. A future
 * tenant-link feature needs its own authorized, audited scope.
 *
 * The workflow is a closed state machine (see platformSupport.service.ts).
 * Notes and status changes are append-only history so a ticket's investigation
 * can be reconstructed without rewriting earlier facts.
 */
export const TICKET_CATEGORIES = Object.freeze([
  'BUG',
  'FEATURE_REQUEST',
  'INVENTORY',
  'AUTHENTICATION',
  'AI_ASSISTANT',
  'DATA_SYNC',
  'OTHER',
] as const);

export const TICKET_PRIORITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const);
export const TICKET_SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const);
export const TICKET_STATUSES = Object.freeze([
  'NEW',
  'UNDER_INVESTIGATION',
  'ESCALATED',
  'FIX_IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
] as const);

const ticketNoteSchema = new Schema(
  {
    body: {
      type: String,
      required: [true, 'note body is required'],
      trim: true,
      maxlength: 4000,
    },
    authorAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'PlatformAdmin',
      required: true,
    },
    authorEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    createdAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const ticketTransitionSchema = new Schema(
  {
    from: { type: String, enum: [...TICKET_STATUSES, null], default: null },
    to: { type: String, enum: TICKET_STATUSES, required: true },
    actorAdminId: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', required: true },
    actorEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    at: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const platformTicketSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true, maxlength: 32 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'MEDIUM' },
    severity: { type: String, enum: TICKET_SEVERITIES, default: 'MEDIUM' },
    status: { type: String, enum: TICKET_STATUSES, default: 'NEW', index: true },
    assignedAdminId: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', default: null },
    assignedEmail: { type: String, default: null, trim: true, lowercase: true, maxlength: 254 },
    createdByAdminId: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', required: true },
    createdByEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    notes: { type: [ticketNoteSchema], default: [] },
    transitions: { type: [ticketTransitionSchema], default: [] },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { collection: 'platform_support_tickets', timestamps: true },
);

platformTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
platformTicketSchema.index({ assignedAdminId: 1, status: 1, createdAt: -1 });
platformTicketSchema.index({ createdAt: -1, _id: -1 });

const PlatformTicket = mongoose.model('PlatformTicket', platformTicketSchema);

export default PlatformTicket;