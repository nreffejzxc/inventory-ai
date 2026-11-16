import mongoose from 'mongoose';

import {
  PLATFORM_AUDIT_ACTION_VALUES,
  PLATFORM_AUDIT_OUTCOMES,
} from '../constants/platformAudit.ts';

const { Schema } = mongoose;

/**
 * PLAT-2 — the platform audit trail.
 *
 * APPEND-ONLY AT THE MODEL LAYER. There is no route that updates or deletes an
 * event, and every Mongoose update/delete/query-update hook throws. A record is
 * written once and then read. This is a guard against application mistakes, not
 * a substitute for database permissions: an operator with raw database access
 * can still alter rows, so production should grant the application a role that
 * cannot drop the collection and the collection should be exported/retained per
 * the monitoring runbook. The model guard is what makes an accidental `updateOne`
 * fail loudly instead of silently rewriting history.
 *
 * NO TTL. Unlike sessions, audit events never expire by index. Retention is an
 * explicit operator decision, not an automatic deletion.
 *
 * NO TENANT SCOPE. This collection describes the platform plane itself. It never
 * carries a tenant `businessId`, a tenant user id or tenant data. Failed logins
 * may carry the submitted address so an operator can investigate an attack, but
 * never a password, token, TOTP code or WebAuthn response.
 */
const platformAuditLogSchema = new Schema(
  {
    action: {
      type: String,
      required: [true, 'action is required'],
      enum: PLATFORM_AUDIT_ACTION_VALUES,
      index: true,
    },
    outcome: {
      type: String,
      required: [true, 'outcome is required'],
      enum: Object.values(PLATFORM_AUDIT_OUTCOMES),
      index: true,
    },
    // Null for a failed login whose address is not a platform administrator, or
    // for a rejected token with no resolvable principal.
    actorAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'PlatformAdmin',
      default: null,
      index: true,
    },
    actorEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: 254,
      index: true,
    },
    actorRole: {
      type: String,
      default: null,
      trim: true,
    },
    capability: {
      type: String,
      default: null,
      trim: true,
    },
    reason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },
    method: {
      type: String,
      default: null,
      trim: true,
      maxlength: 12,
    },
    route: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    requestId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    ip: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    userAgent: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
  },
  { collection: 'platform_audit_events', versionKey: false },
);

platformAuditLogSchema.index({ createdAt: -1, _id: -1 });
platformAuditLogSchema.index({ actorAdminId: 1, createdAt: -1 });
platformAuditLogSchema.index({ action: 1, createdAt: -1 });

const APPEND_ONLY_ERROR = 'Platform audit events are append-only';

function rejectImmutableOperation(): never {
  throw new Error(APPEND_ONLY_ERROR);
}

// Query middleware. These are the operations that could rewrite or remove an
// existing event. `create`/`insertMany` stay available because they append.
platformAuditLogSchema.pre('updateOne', rejectImmutableOperation);
platformAuditLogSchema.pre('updateMany', rejectImmutableOperation);
platformAuditLogSchema.pre('findOneAndUpdate', rejectImmutableOperation);
platformAuditLogSchema.pre('findOneAndDelete', rejectImmutableOperation);
platformAuditLogSchema.pre('findOneAndReplace', rejectImmutableOperation);
platformAuditLogSchema.pre('replaceOne', rejectImmutableOperation);
platformAuditLogSchema.pre('deleteOne', rejectImmutableOperation);
platformAuditLogSchema.pre('deleteMany', rejectImmutableOperation);

// Document middleware: a loaded document cannot be saved again or removed.
platformAuditLogSchema.pre('save', function (this: { isNew?: boolean }) {
  if (!this.isNew) rejectImmutableOperation();
});

export const PLATFORM_AUDIT_APPEND_ONLY_ERROR = APPEND_ONLY_ERROR;

const PlatformAuditLog = mongoose.model('PlatformAuditLog', platformAuditLogSchema);

export default PlatformAuditLog;
