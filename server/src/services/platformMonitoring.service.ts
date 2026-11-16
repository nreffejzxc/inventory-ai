import Business from '../models/business.model.ts';
import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import PlatformAuditLog from '../models/platformAuditLog.model.ts';
import PlatformTicket from '../models/platformTicket.model.ts';
import { PLATFORM_AUDIT_ACTIONS } from '../constants/platformAudit.ts';

function rangeStart(now: Date, days: number): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/**
 * PLAT-6 — the aggregate facts the core operations report did not include.
 *
 * Every query is still cross-tenant and aggregate-only: no business id, name,
 * user id, email, product name or inventory row is returned. Support tickets
 * are platform-only records and carry no tenant reference. "Security" here is
 * the platform audit trail; tenant login failures are not stored in a durable
 * security store, so they are reported as unavailable rather than estimated.
 */
export async function getPlatformMonitoringExtras({
  days,
  now = new Date(),
}: {
  days: number;
  now?: Date;
}) {
  const boundedDays = Math.min(30, Math.max(1, Math.trunc(days)));
  const from = rangeStart(now, boundedDays);
  const to = now;

  const [newBusinesses, ticketRows, inventoryRows, movementRows, auditRows] = await Promise.all([
    Business.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    PlatformTicket.aggregate([
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
          unresolved: [
            { $match: { status: { $nin: ['RESOLVED', 'CLOSED'] } } },
            { $count: 'count' },
          ],
        },
      },
    ]),
    Inventory.aggregate([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                records: { $sum: 1 },
                zeroQuantity: { $sum: { $cond: [{ $lte: ['$quantity', 0] }, 1, 0] } },
                totalQuantity: { $sum: '$quantity' },
                reservedQuantity: { $sum: '$reservedQuantity' },
              },
            },
          ],
        },
      },
    ]),
    InventoryTransaction.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$type', count: { $sum: 1 }, quantity: { $sum: '$quantity' } } },
      { $sort: { count: -1, _id: 1 } },
    ]),
    PlatformAuditLog.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $facet: {
          byAction: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 20 },
          ],
          failedLogins: [
            { $match: { action: PLATFORM_AUDIT_ACTIONS.LOGIN_FAILED } },
            { $count: 'count' },
          ],
          denied: [
            { $match: { outcome: 'DENIED' } },
            { $count: 'count' },
          ],
          mfaFailures: [
            {
              $match: {
                action: {
                  $in: [
                    PLATFORM_AUDIT_ACTIONS.MFA_FAILED,
                    PLATFORM_AUDIT_ACTIONS.RECOVERY_CODE_FAILED,
                    PLATFORM_AUDIT_ACTIONS.WEBAUTHN_LOGIN_FAILED,
                  ],
                },
              },
            },
            { $count: 'count' },
          ],
          latest: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, createdAt: 1, action: 1, outcome: 1 } },
          ],
        },
      },
    ]),
  ]);

  const tickets = (ticketRows[0] ?? {}) as {
    byStatus?: Array<{ _id?: unknown; count?: unknown }>;
    byPriority?: Array<{ _id?: unknown; count?: unknown }>;
    unresolved?: Array<{ count?: unknown }>;
  };
  const ticketStatus: Record<string, number> = {};
  for (const row of tickets.byStatus ?? []) {
    if (typeof row._id === 'string') ticketStatus[row._id] = integer(row.count);
  }
  const ticketPriority: Record<string, number> = {};
  for (const row of tickets.byPriority ?? []) {
    if (typeof row._id === 'string') ticketPriority[row._id] = integer(row.count);
  }

  const inventory = ((inventoryRows[0]?.totals ?? [])[0] ?? {}) as Record<string, unknown>;
  const movements: Record<string, { count: number; quantity: number }> = {};
  for (const row of movementRows as Array<{ _id?: unknown; count?: unknown; quantity?: unknown }>) {
    if (typeof row._id === 'string') {
      movements[row._id] = { count: integer(row.count), quantity: integer(row.quantity) };
    }
  }

  const audit = (auditRows[0] ?? {}) as {
    byAction?: Array<{ _id?: unknown; count?: unknown }>;
    failedLogins?: Array<{ count?: unknown }>;
    denied?: Array<{ count?: unknown }>;
    mfaFailures?: Array<{ count?: unknown }>;
    latest?: Array<Record<string, unknown>>;
  };
  const platformActions: Record<string, number> = {};
  for (const row of audit.byAction ?? []) {
    if (typeof row._id === 'string') platformActions[row._id] = integer(row.count);
  }
  const latest = (audit.latest ?? [])[0] ?? {};

  return {
    range: { from: from.toISOString(), to: to.toISOString(), days: boundedDays, timeZone: 'UTC' },
    businesses: {
      newInWindow: integer(newBusinesses),
    },
    support: {
      total: Object.values(ticketStatus).reduce((sum, value) => sum + value, 0),
      unresolved: integer((tickets.unresolved ?? [])[0]?.count),
      byStatus: ticketStatus,
      byPriority: ticketPriority,
    },
    inventory: {
      records: integer(inventory.records),
      zeroQuantityRecords: integer(inventory.zeroQuantity),
      totalQuantity: integer(inventory.totalQuantity),
      reservedQuantity: integer(inventory.reservedQuantity),
      movements,
      lowStock: {
        available: false,
        note: 'Product minimum-stock levels live on products and are not aggregated in this read; no low-stock number is inferred.',
      },
    },
    security: {
      platformAuditEvents: Object.values(platformActions).reduce((sum, value) => sum + value, 0),
      failedAdminLogins: integer((audit.failedLogins ?? [])[0]?.count),
      deniedCapabilityChecks: integer((audit.denied ?? [])[0]?.count),
      mfaFailures: integer((audit.mfaFailures ?? [])[0]?.count),
      byAction: platformActions,
      latest: latest.createdAt instanceof Date ? {
        action: String(latest.action ?? ''),
        outcome: String(latest.outcome ?? ''),
        at: latest.createdAt.toISOString(),
      } : null,
      tenantAuthFailures: {
        available: false,
        note: 'Tenant login/OTP failures are not stored in a durable security aggregate; no count is inferred.',
      },
    },
  };
}

export default { getPlatformMonitoringExtras };