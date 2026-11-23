import mongoose from 'mongoose';

import AuditOutbox from '../models/auditOutbox.model.ts';
import { recordAuditOnce } from './audit.service.ts';

/** A crashed worker's claim is reclaimable after this window. */
export const AUDIT_OUTBOX_CLAIM_STALE_MS = 60_000;
export const AUDIT_OUTBOX_MAX_BACKOFF_MS = 5 * 60_000;

type IdLike = string | mongoose.Types.ObjectId;

export type AuditOutboxEvent = {
  businessId: IdLike;
  userId?: IdLike | null;
  action: string;
  entityType: string;
  entityId?: IdLike | null;
  metadata?: unknown;
  dedupeKey: string;
};

type OutboxRow = {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  dedupeKey: string;
  action: string;
  entityType: string;
  entityId?: string;
  userId?: mongoose.Types.ObjectId;
  metadata?: unknown;
  status: string;
  attempts: number;
  availableAt: Date;
  claimedAt?: Date;
};

type DeliveryResult = 'delivered' | 'failed' | 'pending' | 'missing';
type EnqueuedOutboxRow = Pick<OutboxRow, '_id' | 'status'>;

function oid(value: IdLike): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 11000;
}

function errorCode(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name ? name.slice(0, 200) : 'Error';
}

function backoffFor(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1), 8);
  return Math.min(AUDIT_OUTBOX_MAX_BACKOFF_MS, 1_000 * 2 ** exponent);
}

/**
 * Persist one event before attempting delivery. The unique `(businessId,
 * dedupeKey)` index is the arbiter: a concurrent enqueue returns the winner's
 * row instead of creating a second copy. This function never overwrites a
 * DELIVERED row, and a FAILED row remains eligible for the flusher.
 */
export async function enqueueAuditOnce(event: AuditOutboxEvent) {
  const dedupeKey = event.dedupeKey.trim();
  if (!dedupeKey) throw new Error('enqueueAuditOnce requires a non-empty dedupeKey');
  try {
    return await AuditOutbox.create({
      businessId: oid(event.businessId),
      dedupeKey,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId == null ? undefined : String(event.entityId),
      userId: event.userId == null ? undefined : oid(event.userId),
      metadata: event.metadata,
      status: 'PENDING',
      attempts: 0,
      availableAt: new Date(),
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const existing = await AuditOutbox.findOne({
      businessId: oid(event.businessId),
      dedupeKey,
    });
    if (!existing) throw err;
    return existing;
  }
}

function claimFilter({
  id,
  businessId,
  dedupeKey,
  now,
  staleSendingMs,
}: {
  id?: IdLike;
  businessId?: IdLike;
  dedupeKey?: string;
  now: Date;
  staleSendingMs: number;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: [
      { status: { $in: ['PENDING', 'FAILED'] }, availableAt: { $lte: now } },
      {
        status: 'SENDING',
        claimedAt: { $lte: new Date(now.getTime() - staleSendingMs) },
      },
    ],
  };
  if (id) filter._id = oid(id);
  if (businessId) filter.businessId = oid(businessId);
  if (dedupeKey) filter.dedupeKey = dedupeKey.trim();
  return filter;
}

async function claimOne(options: {
  id?: IdLike;
  businessId?: IdLike;
  dedupeKey?: string;
  now: Date;
  staleSendingMs: number;
}): Promise<OutboxRow | null> {
  return AuditOutbox.findOneAndUpdate(
    claimFilter(options),
    { $set: { status: 'SENDING', claimedAt: options.now }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean<OutboxRow>();
}

/**
 * Deliver one claimed row. `recordAuditOnce` makes the audit insert itself
 * idempotent, so a crash after the AuditLog write but before this status update
 * is harmless: the reclaim repeats the insert as a no-op and then stores
 * DELIVERED. Only the error class is retained; upstream messages can contain
 * connection strings or customer data.
 */
async function deliverClaimed(row: OutboxRow, now: Date): Promise<DeliveryResult> {
  try {
    await recordAuditOnce({
      businessId: row.businessId,
      userId: row.userId ?? null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: row.metadata,
      dedupeKey: row.dedupeKey,
    });
    await AuditOutbox.updateOne(
      { _id: row._id, status: 'SENDING' },
      {
        $set: { status: 'DELIVERED', deliveredAt: now },
        $unset: { lastError: 1 },
      },
    );
    return 'delivered';
  } catch (err) {
    const availableAt = new Date(Date.now() + backoffFor(row.attempts));
    await AuditOutbox.updateOne(
      { _id: row._id, status: 'SENDING' },
      {
        $set: {
          status: 'FAILED',
          lastError: errorCode(err),
          availableAt,
        },
      },
    ).catch(() => undefined);
    console.error(`[audit-outbox] ${row.action} could not be delivered (${errorCode(err)})`);
    return 'failed';
  }
}

/**
 * Attempt one event by its natural key. Used by the operation that just wrote
 * the business row; the caller has already enqueued it, so this only claims and
 * delivers. A missing or currently-claimed row is not an error: the flusher
 * owns it.
 */
export async function deliverAuditOutbox({
  id,
  businessId,
  dedupeKey,
  now = new Date(),
  staleSendingMs = AUDIT_OUTBOX_CLAIM_STALE_MS,
}: {
  id?: IdLike;
  businessId?: IdLike;
  dedupeKey?: string;
  now?: Date;
  staleSendingMs?: number;
} = {}): Promise<DeliveryResult> {
  if (!id && !dedupeKey) throw new Error('deliverAuditOutbox requires an id or dedupeKey');
  const claimed = await claimOne({ id, businessId, dedupeKey, now, staleSendingMs });
  if (claimed) return deliverClaimed(claimed, now);

  const existing = await AuditOutbox.findOne({
    ...(id ? { _id: oid(id) } : {}),
    ...(businessId ? { businessId: oid(businessId) } : {}),
    ...(dedupeKey ? { dedupeKey: dedupeKey.trim() } : {}),
  })
    .select('status')
    .lean<{ status?: string }>();
  if (!existing) return 'missing';
  return existing.status === 'DELIVERED' ? 'delivered' : 'pending';
}

/**
 * Enqueue, run an optional post-enqueue marker, then try delivery once. The
 * marker runs only after the outbox row is durable, which is the ordering every
 * producer's repair fence depends on. A marker failure is thrown: the row is
 * already durable, so the caller reports the hand-off as failed and recovery
 * marks the receipt on its next pass.
 */
export async function enqueueAndDeliverAudit(
  event: AuditOutboxEvent,
  options: { staleSendingMs?: number; onEnqueued?: (row: EnqueuedOutboxRow) => Promise<void> } = {},
): Promise<DeliveryResult> {
  const row = await enqueueAuditOnce(event);
  if (options.onEnqueued) await options.onEnqueued(row);
  if (row.status === 'DELIVERED') return 'delivered';
  // The row's availableAt is written during enqueue, after any caller-supplied
  // clock was captured. Attempt it on the current clock so a just-created row is
  // eligible immediately.
  return deliverAuditOutbox({
    id: row._id,
    businessId: event.businessId,
    dedupeKey: event.dedupeKey,
    now: new Date(),
    staleSendingMs: options.staleSendingMs,
  });
}

/**
 * Retry due work, including rows whose last attempt failed and claims left by a
 * crashed process. Bounded by `limit`; every row is claimed atomically so two
 * serving instances cannot deliver the same event concurrently.
 */
export async function flushAuditOutbox({
  limit = 50,
  businessId,
  now = new Date(),
  staleSendingMs = AUDIT_OUTBOX_CLAIM_STALE_MS,
}: {
  limit?: number;
  businessId?: IdLike;
  now?: Date;
  staleSendingMs?: number;
} = {}): Promise<{ scanned: number; delivered: number; failed: number }> {
  const candidates = await AuditOutbox.find(
    claimFilter({ businessId, now, staleSendingMs }),
  )
    .sort({ availableAt: 1, _id: 1 })
    .limit(Math.max(0, limit))
    .select('_id')
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

  let delivered = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimed = await claimOne({
      id: candidate._id,
      businessId,
      now,
      staleSendingMs,
    });
    if (!claimed) continue;
    const result = await deliverClaimed(claimed, now);
    if (result === 'delivered') delivered += 1;
    else failed += 1;
  }
  return { scanned: candidates.length, delivered, failed };
}
