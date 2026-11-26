import mongoose from 'mongoose';

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import StockMovementOperation from '../models/stockMovementOperation.model.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import { recordAuditOnce } from './audit.service.ts';
import {
  assessMovementReceiptById,
  recoverMovementReceiptById,
  type MovementReceiptAssessment,
  type MovementReceiptRecord,
} from './inventory.service.ts';

export const MOVEMENT_RECEIPT_STALE_MS = 60_000;
export const MOVEMENT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type MovementReceiptRecoverySummary = {
  scanned: number;
  completed: number;
  flagged: number;
  blocked: number;
  failed: number;
};

export type MovementReceiptMaintenanceItem = {
  receiptId: string;
  businessId: string;
  kind: string;
  state: string;
  action: 'recover' | 'flag' | 'blocked' | 'prune';
  evidence: MovementReceiptAssessment['evidence'] | 'retention';
  ledgerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MovementReceiptMaintenanceReport = {
  dryRun: boolean;
  scanned: number;
  recovered: number;
  flagged: number;
  pruned: number;
  blocked: number;
  failed: number;
  items: MovementReceiptMaintenanceItem[];
};

function iso(value: Date | undefined): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

function itemOf(
  assessment: MovementReceiptAssessment,
  action: MovementReceiptMaintenanceItem['action'],
  evidence: MovementReceiptMaintenanceItem['evidence'] = assessment.evidence,
): MovementReceiptMaintenanceItem {
  const receipt = assessment.receipt;
  return {
    receiptId: String(receipt._id),
    businessId: String(receipt.businessId),
    kind: receipt.kind,
    state: receipt.state,
    action,
    evidence,
    ledgerId: assessment.ledgerId,
    createdAt: iso(receipt.createdAt),
    updatedAt: iso(receipt.updatedAt),
  };
}

function pruneItem(receipt: MovementReceiptRecord): MovementReceiptMaintenanceItem {
  return {
    receiptId: String(receipt._id),
    businessId: String(receipt.businessId),
    kind: receipt.kind,
    state: receipt.state,
    action: 'prune',
    evidence: 'retention',
    ledgerId: receipt.inventoryTransactionId ? String(receipt.inventoryTransactionId) : null,
    createdAt: iso(receipt.createdAt),
    updatedAt: iso(receipt.updatedAt),
  };
}

async function auditRecovery(
  receipt: MovementReceiptRecord,
  result: { transactionId?: string; evidence: MovementReceiptAssessment['evidence'] | 'already-completed' },
): Promise<void> {
  try {
    await recordAuditOnce({
      businessId: receipt.businessId,
      // A recovery is a system action, not the member's action.
      userId: null,
      action: AUDIT_ACTIONS.MOVEMENT_RECEIPT_RECOVERED,
      entityType: AUDIT_ENTITY_TYPES.STOCK_MOVEMENT_OPERATION,
      entityId: receipt._id,
      metadata: {
        kind: receipt.kind,
        inventoryTransactionId: result.transactionId ?? null,
        evidence: result.evidence,
        recoveredBy: 'integrity-recovery',
      },
      // One recovered event per receipt, even when two recovery passes saw the
      // same unfinished row and both proved the same ledger outcome.
      dedupeKey: `movement-receipt:${String(receipt._id)}:recovered`,
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: receipt.businessId,
      action: AUDIT_ACTIONS.MOVEMENT_RECEIPT_RECOVERED,
      entityType: AUDIT_ENTITY_TYPES.STOCK_MOVEMENT_OPERATION,
      entityId: receipt._id,
      error: err,
    });
  }
}

async function auditPrune(receipt: MovementReceiptRecord): Promise<void> {
  try {
    await recordAuditOnce({
      businessId: receipt.businessId,
      userId: null,
      action: AUDIT_ACTIONS.MOVEMENT_RECEIPT_PRUNED,
      entityType: AUDIT_ENTITY_TYPES.STOCK_MOVEMENT_OPERATION,
      entityId: receipt._id,
      metadata: {
        kind: receipt.kind,
        reason: 'completed receipt retention',
        inventoryTransactionId: receipt.inventoryTransactionId
          ? String(receipt.inventoryTransactionId)
          : null,
        completedAt: iso(receipt.updatedAt),
      },
      dedupeKey: `movement-receipt:${String(receipt._id)}:pruned`,
    });
  } catch (err) {
    await monitorAuditFailure({
      businessId: receipt.businessId,
      action: AUDIT_ACTIONS.MOVEMENT_RECEIPT_PRUNED,
      entityType: AUDIT_ENTITY_TYPES.STOCK_MOVEMENT_OPERATION,
      entityId: receipt._id,
      error: err,
    });
  }
}

function scopeFilter(businessId?: string) {
  return businessId ? { businessId: new mongoose.Types.ObjectId(businessId) } : {};
}

function staleUnfinishedFilter(now: Date, olderThanMs: number, businessId?: string) {
  return {
    ...scopeFilter(businessId),
    state: { $in: ['IN_PROGRESS', 'INVENTORY_WRITTEN'] as const },
    updatedAt: { $lte: new Date(now.getTime() - olderThanMs) },
  };
}

function attentionFilter(businessId?: string) {
  return {
    ...scopeFilter(businessId),
    state: 'REQUIRES_ATTENTION' as const,
  };
}

type ReceiptIdRow = { _id: mongoose.Types.ObjectId };

/**
 * Select a bounded batch without letting attention rows consume all of it.
 *
 * Attention has no age requirement, so a large old backlog sorted ahead of
 * newer unfinished receipts would starve every newer receipt forever. Stale
 * unfinished rows are therefore selected first, and attention only fills the
 * remaining budget. Attention remains resolvable whenever there is room, but it
 * can never prevent a newer stale receipt from being assessed.
 */
async function selectReceiptIds({
  now,
  olderThanMs,
  limit,
  businessId,
}: {
  now: Date;
  olderThanMs: number;
  limit: number;
  businessId?: string;
}): Promise<ReceiptIdRow[]> {
  const batch = Math.max(0, limit);
  if (batch === 0) return [];
  const unfinished = (await StockMovementOperation.find(
    staleUnfinishedFilter(now, olderThanMs, businessId),
  )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(batch)
    .select('_id')
    .lean()) as unknown as ReceiptIdRow[];
  const attentionBudget = batch - unfinished.length;
  if (attentionBudget === 0) return unfinished;
  const attention = (await StockMovementOperation.find(attentionFilter(businessId))
    .sort({ updatedAt: 1, _id: 1 })
    .limit(attentionBudget)
    .select('_id')
    .lean()) as unknown as ReceiptIdRow[];
  return [...unfinished, ...attention];
}

/**
 * Recover abandoned receipts that are old enough that their request cannot still
 * be healthy. A row is completed only after the same proof hierarchy a retry
 * uses. Anything ambiguous is surfaced as REQUIRES_ATTENTION, never deleted.
 */
export async function recoverStaleMovementReceipts({
  olderThanMs = MOVEMENT_RECEIPT_STALE_MS,
  now = new Date(),
  limit = 50,
  businessId,
}: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  businessId?: string;
} = {}): Promise<MovementReceiptRecoverySummary> {
  const rows = await selectReceiptIds({ now, olderThanMs, limit, businessId });
  const summary: MovementReceiptRecoverySummary = {
    scanned: rows.length,
    completed: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      const assessment = await assessMovementReceiptById(row._id);
      if (!assessment) continue;
      if (assessment.action === 'blocked') {
        summary.blocked += 1;
        continue;
      }
      const result = await recoverMovementReceiptById(row._id);
      if (!result) continue;
      if (result.action === 'completed') {
        await auditRecovery(assessment.receipt, result);
        summary.completed += 1;
      } else if (result.action === 'flagged') {
        summary.flagged += 1;
      }
      // `noop` means the row changed or was already complete between the
      // assessment and the recovery. It is not a completion of this pass.
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[movement-receipt-recovery] ${String(row._id)} could not be reconciled: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
  return summary;
}

/**
 * Operator maintenance, dry-run first by default. Retention only removes
 * COMPLETED receipts: the ledger is authoritative, and the receipt's replay
 * window has passed. Unfinished and attention rows are never deleted.
 */
export async function runMovementReceiptMaintenance({
  dryRun = true,
  olderThanMs = MOVEMENT_RECEIPT_STALE_MS,
  retentionMs = MOVEMENT_RECEIPT_RETENTION_MS,
  now = new Date(),
  limit = 200,
  businessId,
}: {
  dryRun?: boolean;
  olderThanMs?: number;
  retentionMs?: number;
  now?: Date;
  limit?: number;
  businessId?: string;
} = {}): Promise<MovementReceiptMaintenanceReport> {
  const unfinished = await selectReceiptIds({ now, olderThanMs, limit, businessId });
  const completed = (await StockMovementOperation.find({
    state: 'COMPLETED',
    updatedAt: { $lte: new Date(now.getTime() - retentionMs) },
    ...(businessId ? { businessId: new mongoose.Types.ObjectId(businessId) } : {}),
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .select('_id')
    .lean()) as unknown as ReceiptIdRow[];

  const report: MovementReceiptMaintenanceReport = {
    dryRun,
    scanned: unfinished.length + completed.length,
    recovered: 0,
    flagged: 0,
    pruned: 0,
    blocked: 0,
    failed: 0,
    items: [],
  };

  for (const row of unfinished) {
    try {
      const assessment = await assessMovementReceiptById(row._id);
      if (!assessment) continue;
      if (assessment.action === 'blocked') {
        report.blocked += 1;
        report.items.push(itemOf(assessment, 'blocked'));
        continue;
      }
      if (dryRun) {
        const action = assessment.action === 'complete' || assessment.action === 'recover' ? 'recover' : 'flag';
        if (action === 'recover') report.recovered += 1;
        else report.flagged += 1;
        report.items.push(itemOf(assessment, action));
        continue;
      }

      const result = await recoverMovementReceiptById(row._id);
      if (!result) continue;
      if (result.action === 'completed') {
        await auditRecovery(assessment.receipt, result);
        report.recovered += 1;
        report.items.push(itemOf(assessment, 'recover'));
      } else if (result.action === 'flagged') {
        report.flagged += 1;
        report.items.push(itemOf(assessment, 'flag'));
      } else if (result.state === 'REQUIRES_ATTENTION') {
        report.blocked += 1;
        report.items.push(itemOf(assessment, 'blocked'));
      }
    } catch (err) {
      report.failed += 1;
      console.error(
        `[movement-receipt-maintenance] ${String(row._id)} failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  for (const row of completed) {
    const assessment = await assessMovementReceiptById(row._id);
    if (!assessment || assessment.receipt.state !== 'COMPLETED') continue;
    const record = assessment.receipt;
    if (assessment.action !== 'complete') {
      // A completed handle is prunable only while its ledger row still proves the
      // movement. A missing or contradictory row is evidence, so keep it.
      report.blocked += 1;
      report.items.push(itemOf(assessment, 'blocked', 'retention'));
      continue;
    }
    if (dryRun) {
      report.pruned += 1;
      report.items.push(pruneItem(record));
      continue;
    }

    // Delete only a still-COMPLETED row, so a late replay/update cannot lose a
    // receipt that is no longer a pure retention candidate.
    const deleted = await StockMovementOperation.deleteOne({ _id: record._id, state: 'COMPLETED' });
    if (deleted.deletedCount === 1) {
      await auditPrune(record);
      report.pruned += 1;
      report.items.push(pruneItem(record));
    }
  }

  return report;
}