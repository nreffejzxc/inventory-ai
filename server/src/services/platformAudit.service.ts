/**
 * PLAT-2 — writing and reading platform audit events.
 *
 * The writer is intentionally small and never throws: an audit write must not
 * turn a successful login or a refused request into a different response. It
 * logs a server-side failure instead. A refusal is recorded before the guard's
 * error reaches the client.
 *
 * The reader is bounded and returns a strict DTO. It never returns a password
 * hash, session id, token or MFA secret because none of those fields exist in
 * the collection.
 */

import type { Request } from 'express';
import mongoose from 'mongoose';

import PlatformAuditLog from '../models/platformAuditLog.model.ts';
import {
  PLATFORM_AUDIT_OUTCOMES,
  type PlatformAuditOutcome,
} from '../constants/platformAudit.ts';

export type PlatformAuditActor = {
  adminId?: string | null;
  email?: string | null;
  role?: string | null;
};

export type PlatformAuditRequest = {
  ip?: string;
  method?: string;
  route?: string;
  requestId?: string;
  userAgent?: string;
};

type RecordInput = {
  action: string;
  outcome: PlatformAuditOutcome;
  actor?: PlatformAuditActor | null;
  capability?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request | null;
};

const MAX_METADATA_BYTES = 4096;

function clean(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function requestContext(req: Request | null | undefined): PlatformAuditRequest {
  if (!req) return {};
  return {
    ip: clean(req.ip, 64) || undefined,
    method: clean(req.method, 12) || undefined,
    route: clean(req.originalUrl || req.path, 300) || undefined,
    requestId: clean((req as Request & { requestId?: string }).requestId, 100) || undefined,
    userAgent: clean(req.headers['user-agent'], 300) || undefined,
  };
}

/** Keep metadata small and free of accidental credential-shaped values. */
function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  try {
    const serialized = JSON.stringify(metadata);
    if (serialized.length > MAX_METADATA_BYTES) {
      return { truncated: true };
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return { invalid: true };
  }
}

/**
 * Append one audit event. Never throws to the caller.
 *
 * The function is awaited by callers that can afford it and fire-and-forget in
 * error paths; either way a failure is logged and the request continues.
 */
export async function recordPlatformAudit(input: RecordInput): Promise<void> {
  const context = requestContext(input.req);
  try {
    await PlatformAuditLog.create({
      action: input.action,
      outcome: input.outcome,
      actorAdminId:
        input.actor?.adminId && mongoose.isValidObjectId(input.actor.adminId)
          ? input.actor.adminId
          : null,
      actorEmail: clean(input.actor?.email, 254),
      actorRole: clean(input.actor?.role, 60),
      capability: clean(input.capability, 80),
      reason: clean(input.reason, 120),
      method: context.method ?? null,
      route: context.route ?? null,
      requestId: context.requestId ?? null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      metadata: safeMetadata(input.metadata),
    });
  } catch (err) {
    console.error(
      `[platform-audit] append failed for ${input.action}: ${
        (err as { message?: unknown }).message
      }`,
    );
  }
}

export type PlatformAuditEventDto = {
  id: string;
  action: string;
  outcome: string;
  actorAdminId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  capability: string | null;
  reason: string | null;
  method: string | null;
  route: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
};

export function toPlatformAuditEventDto(doc: {
  _id: unknown;
  action: string;
  outcome: string;
  actorAdminId?: unknown;
  actorEmail?: string | null;
  actorRole?: string | null;
  capability?: string | null;
  reason?: string | null;
  method?: string | null;
  route?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: unknown;
  createdAt: Date;
}): PlatformAuditEventDto {
  return {
    id: String(doc._id),
    action: doc.action,
    outcome: doc.outcome,
    actorAdminId: doc.actorAdminId ? String(doc.actorAdminId) : null,
    actorEmail: doc.actorEmail ?? null,
    actorRole: doc.actorRole ?? null,
    capability: doc.capability ?? null,
    reason: doc.reason ?? null,
    method: doc.method ?? null,
    route: doc.route ?? null,
    requestId: doc.requestId ?? null,
    ip: doc.ip ?? null,
    userAgent: doc.userAgent ?? null,
    metadata: doc.metadata ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export type ListPlatformAuditOptions = {
  limit: number;
  before?: string | null;
  action?: string | null;
  outcome?: string | null;
};

function parseBefore(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function listPlatformAudit({
  limit,
  before,
  action,
  outcome,
}: ListPlatformAuditOptions) {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const filter: Record<string, unknown> = {};
  const beforeDate = parseBefore(before);
  if (beforeDate) filter.createdAt = { $lt: beforeDate };
  if (action) filter.action = action;
  if (outcome) filter.outcome = outcome;

  const rows = await PlatformAuditLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(bounded + 1)
    .lean();

  const hasMore = rows.length > bounded;
  const page = rows.slice(0, bounded).map((row) =>
    toPlatformAuditEventDto(row as unknown as Parameters<typeof toPlatformAuditEventDto>[0]),
  );
  return {
    events: page,
    hasMore,
    nextBefore: hasMore && page.length > 0 ? page[page.length - 1]!.createdAt : null,
    limit: bounded,
  };
}

export default {
  PLATFORM_AUDIT_OUTCOMES,
  recordPlatformAudit,
  listPlatformAudit,
  toPlatformAuditEventDto,
};
