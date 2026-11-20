import mongoose from 'mongoose';

import { INSTANCE_ID } from '../config/instanceIdentity.ts';
import { recoverStaleTransferOperations } from './stockTransferRecovery.service.ts';
import { recoverStalePurchaseOrderClaims } from './purchaseOrderClaimRecovery.service.ts';
import { recoverStaleMovementReceipts } from './stockMovementReceiptRecovery.service.ts';
import {
  acquireIntegrityRecoveryLease,
  DEFAULT_INTEGRITY_RECOVERY_LEASE_MS,
} from './integrityRecoveryLease.service.ts';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;

export type IntegrityRecoveryHandle = {
  stop: () => void;
  runNow: () => Promise<IntegrityRecoveryTotals | null>;
};

export type IntegrityRecoveryTotals = {
  transfers: Awaited<ReturnType<typeof recoverStaleTransferOperations>> | null;
  claims: Awaited<ReturnType<typeof recoverStalePurchaseOrderClaims>> | null;
  movements: Awaited<ReturnType<typeof recoverStaleMovementReceipts>> | null;
  lease: { acquired: boolean; owner?: string; expiresAt?: string } | null;
  /** Set when the pass deliberately did nothing; never a claim that recovery is clean. */
  skipped?: 'not-connected' | 'lease-held';
};

/**
 * One reconciliation pass. Both reapers are independently bounded and
 * idempotent, so a failure in one never prevents the other from running. Only
 * meaningful activity is logged; an empty pass stays silent.
 *
 * The pass owns a Mongo-backed lease for its whole duration. Two serving
 * instances therefore cannot scan the same rows together, and a process that
 * dies leaves only a lease that expires. The reapers and the unique ledger
 * guard remain safe even if a lease is lost mid-pass; the lease prevents waste
 * and duplicate recovery audits, it is not the correctness boundary.
 */
export async function runIntegrityRecoveryPass({
  owner = INSTANCE_ID,
  leaseTtlMs = DEFAULT_INTEGRITY_RECOVERY_LEASE_MS,
  recoverTransfers = recoverStaleTransferOperations,
  recoverClaims = recoverStalePurchaseOrderClaims,
  recoverMovements = recoverStaleMovementReceipts,
}: {
  owner?: string;
  leaseTtlMs?: number;
  recoverTransfers?: typeof recoverStaleTransferOperations;
  recoverClaims?: typeof recoverStalePurchaseOrderClaims;
  recoverMovements?: typeof recoverStaleMovementReceipts;
} = {}): Promise<IntegrityRecoveryTotals> {
  if (mongoose.connection.readyState !== 1) {
    return { transfers: null, claims: null, movements: null, lease: null, skipped: 'not-connected' };
  }

  const lease = await acquireIntegrityRecoveryLease({ owner, ttlMs: leaseTtlMs });
  if (!lease) {
    return { transfers: null, claims: null, movements: null, lease: { acquired: false }, skipped: 'lease-held' };
  }

  const heartbeat = setInterval(() => {
    void lease.renew().then(
      (stillOwner) => {
        if (!stillOwner) {
          console.error('[integrity-recovery] the lease was taken over; the current pass will finish on guarded writes');
        }
      },
      (err: unknown) => {
        console.error(
          `[integrity-recovery] could not renew the lease: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      },
    );
  }, Math.max(30_000, Math.floor(leaseTtlMs / 3)));
  heartbeat.unref?.();

  let transfers: IntegrityRecoveryTotals['transfers'] = null;
  let claims: IntegrityRecoveryTotals['claims'] = null;
  let movements: IntegrityRecoveryTotals['movements'] = null;
  try {
    try {
      transfers = await recoverTransfers();
    } catch (err) {
      console.error(
        `[integrity-recovery] transfer pass failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    try {
      claims = await recoverClaims();
    } catch (err) {
      console.error(
        `[integrity-recovery] PO claim pass failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    try {
      movements = await recoverMovements();
    } catch (err) {
      console.error(
        `[integrity-recovery] movement receipt pass failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    const transferWork =
      (transfers?.completed ?? 0) +
      (transfers?.compensated ?? 0) +
      (transfers?.flagged ?? 0) +
      (transfers?.failed ?? 0);
    const claimWork =
      (claims?.released ?? 0) +
      (claims?.undone ?? 0) +
      (claims?.receipted ?? 0) +
      (claims?.flagged ?? 0) +
      (claims?.failed ?? 0);
    const movementWork =
      (movements?.completed ?? 0) +
      (movements?.flagged ?? 0) +
      (movements?.blocked ?? 0) +
      (movements?.failed ?? 0);
    if (transferWork > 0) {
      console.log(
        `[integrity-recovery] transfers scanned=${transfers?.scanned ?? 0} completed=${transfers?.completed ?? 0} compensated=${transfers?.compensated ?? 0} flagged=${transfers?.flagged ?? 0} failed=${transfers?.failed ?? 0}`,
      );
    }
    if (claimWork > 0) {
      console.log(
        `[integrity-recovery] PO claims scanned=${claims?.scanned ?? 0} released=${claims?.released ?? 0} undone=${claims?.undone ?? 0} receipted=${claims?.receipted ?? 0} flagged=${claims?.flagged ?? 0} failed=${claims?.failed ?? 0}`,
      );
    }
    if (movementWork > 0) {
      console.log(
        `[integrity-recovery] movement receipts scanned=${movements?.scanned ?? 0} completed=${movements?.completed ?? 0} flagged=${movements?.flagged ?? 0} blocked=${movements?.blocked ?? 0} failed=${movements?.failed ?? 0}`,
      );
    }
    return {
      transfers,
      claims,
      movements,
      lease: { acquired: true, owner: lease.owner, expiresAt: lease.expiresAt.toISOString() },
    };
  } finally {
    clearInterval(heartbeat);
    try {
      await lease.release();
    } catch (err) {
      console.error(
        `[integrity-recovery] could not release the lease: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}

/**
 * Schedule recovery in a serving process. Timers are unref'd: recovery never
 * keeps a process alive, and a shutdown that closes the database simply makes
 * the next pass a no-op. Passes never overlap, so a slow database cannot stack
 * scans on top of one another.
 */
export function startIntegrityRecovery({
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  logger = console,
}: {
  intervalMs?: number;
  initialDelayMs?: number;
  logger?: { log: (message: string) => void; error: (message: string) => void };
} = {}): IntegrityRecoveryHandle {
  let running = false;
  let stopped = false;

  const runNow = async (): Promise<IntegrityRecoveryTotals | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      return await runIntegrityRecoveryPass();
    } catch (err) {
      logger.error(
        `[integrity-recovery] unexpected pass failure: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return null;
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => {
    void runNow();
  }, Math.max(0, initialDelayMs));
  initial.unref?.();

  const interval = setInterval(() => {
    void runNow();
  }, Math.max(1000, intervalMs));
  interval.unref?.();

  logger.log(
    `Integrity recovery scheduled every ${Math.max(1, Math.round(intervalMs / 60_000))}m; first pass in ${Math.max(0, Math.round(initialDelayMs / 1000))}s.`,
  );

  return {
    stop: () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
    },
    runNow,
  };
}
