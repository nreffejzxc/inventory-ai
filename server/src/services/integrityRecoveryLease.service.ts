import { randomUUID } from 'node:crypto';

import IntegrityRecoveryLease from '../models/integrityRecoveryLease.model.ts';

export const INTEGRITY_RECOVERY_LEASE_ID = 'integrity-recovery';
export const DEFAULT_INTEGRITY_RECOVERY_LEASE_MS = 10 * 60_000;

export type IntegrityRecoveryLeaseHandle = {
  owner: string;
  token: string;
  acquiredAt: Date;
  expiresAt: Date;
  renew: (ttlMs?: number) => Promise<boolean>;
  release: () => Promise<boolean>;
};

function leaseExpiry(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + Math.max(30_000, Math.min(ttlMs, 60 * 60_000)));
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 11000;
}

/**
 * Acquire the single recovery lease.
 *
 * The filter only matches a lease that has expired (or this exact token), so an
 * active owner is never overwritten. A concurrent insert loses on `_id` and is
 * reported as "not acquired", not as an error. An expired lease is taken over
 * immediately rather than waiting for MongoDB's TTL monitor.
 */
export async function acquireIntegrityRecoveryLease({
  owner,
  ttlMs = DEFAULT_INTEGRITY_RECOVERY_LEASE_MS,
  now = new Date(),
  token = randomUUID(),
}: {
  owner: string;
  ttlMs?: number;
  now?: Date;
  token?: string;
}): Promise<IntegrityRecoveryLeaseHandle | null> {
  const expiresAt = leaseExpiry(now, ttlMs);
  let document;
  try {
    document = await IntegrityRecoveryLease.findOneAndUpdate(
      {
        _id: INTEGRITY_RECOVERY_LEASE_ID,
        $or: [{ expiresAt: { $lte: now } }, { token }],
      },
      {
        $set: { owner, token, acquiredAt: now, expiresAt },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
  if (!document) return null;

  const handle: IntegrityRecoveryLeaseHandle = {
    owner,
    token,
    acquiredAt: now,
    expiresAt,
    async renew(ttl) {
      const refreshed = leaseExpiry(new Date(), ttl ?? ttlMs);
      const result = await IntegrityRecoveryLease.updateOne(
        { _id: INTEGRITY_RECOVERY_LEASE_ID, token },
        { $set: { expiresAt: refreshed } }
      );
      if (result.modifiedCount === 1) {
        handle.expiresAt = refreshed;
        return true;
      }
      return false;
    },
    async release() {
      // Owner-scoped: a stale process that wakes up after a takeover cannot
      // release the new owner's lease.
      const result = await IntegrityRecoveryLease.deleteOne({
        _id: INTEGRITY_RECOVERY_LEASE_ID,
        token,
      });
      return result.deletedCount === 1;
    },
  };
  return handle;
}
