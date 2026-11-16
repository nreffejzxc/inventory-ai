/**
 * PLAT-1 — the cross-tenant operations report behind GET /api/platform/operations.
 *
 * This is the replacement for the customer-facing OPS-7 read. The durable stores
 * it reads are unchanged: `ai_turn_metrics`, `ai_feedback`, `ops_error_events`,
 * `ops_feature_usage`, the catalogue and the ledger. What changed is the SCOPE
 * and the CALLER:
 *
 *   * the caller is a PlatformAdmin holding `platform.metrics.read`, never a
 *     tenant OWNER/ADMIN and never a tenant token;
 *   * the scope is the whole platform. There is no `businessId` filter and no
 *     `businessId` parameter — a client cannot aim this read at one tenant, which
 *     is why a routing or parameter mistake cannot turn it into a tenant-detail
 *     endpoint;
 *   * the response contains aggregate counts only. No business name, member
 *     name, email, user id, product row, feedback text or assistant message is
 *     returned. Tenant detail is a future capability behind a support grant (see
 *     the platform architecture document) and is deliberately absent.
 *
 * Every query is bounded by the same 1–30 day UTC window used across the
 * platform report, and every collection is read with one aggregation.
 */

import AiFeedback from '../models/aiFeedback.model.ts';
import Business from '../models/business.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import Location from '../models/location.model.ts';
import OpsErrorEvent from '../models/opsErrorEvent.model.ts';
import OpsFeatureUsage from '../models/opsFeatureUsage.model.ts';
import Product from '../models/product.model.ts';
import PurchaseOrder from '../models/purchaseOrder.model.ts';
import Supplier from '../models/supplier.model.ts';
import User from '../models/user.model.ts';
import { getPlatformAiMetrics } from './ai/aiMetrics.service.ts';

function rangeStart(now: Date, days: number): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function dateOrNull(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

const FEEDBACK_REASONS = [
  'INCORRECT_DATA',
  'MISSING_INFORMATION',
  'HARD_TO_UNDERSTAND',
  'OTHER',
] as const;

export type PlatformOperationsSummary = Awaited<ReturnType<typeof getPlatformOperationsSummary>>;

/**
 * The platform operations report.
 *
 * `days` is bounded by the caller (see `parseOperationsDays`); it is re-clamped
 * here so the service is safe even when invoked directly. A `now` is accepted for
 * deterministic tests.
 */
export async function getPlatformOperationsSummary({
  days,
  now = new Date(),
}: {
  days: number;
  now?: Date;
}) {
  const boundedDays = Math.min(30, Math.max(1, Math.trunc(days)));
  const from = rangeStart(now, boundedDays);
  const to = now;
  const fromDay = dayKey(from);
  const toDay = dayKey(to);

  const [
    ai,
    feedbackRows,
    featureRows,
    productRows,
    businessRows,
    totalAccounts,
    activeAccounts,
    activeLocations,
    activeSuppliers,
    openPurchaseOrders,
    stockMovements,
    errorRows,
  ] = await Promise.all([
    getPlatformAiMetrics({ days: boundedDays, now }),
    AiFeedback.aggregate([
      {
        $facet: {
          all: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                open: { $sum: { $cond: [{ $eq: ['$status', 'OPEN'] }, 1, 0] } },
                reviewed: { $sum: { $cond: [{ $eq: ['$status', 'REVIEWED'] }, 1, 0] } },
                up: { $sum: { $cond: [{ $eq: ['$rating', 'UP'] }, 1, 0] } },
                down: { $sum: { $cond: [{ $eq: ['$rating', 'DOWN'] }, 1, 0] } },
              },
            },
          ],
          window: [
            { $match: { createdAt: { $gte: from, $lte: to } } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                up: { $sum: { $cond: [{ $eq: ['$rating', 'UP'] }, 1, 0] } },
                down: { $sum: { $cond: [{ $eq: ['$rating', 'DOWN'] }, 1, 0] } },
              },
            },
          ],
          reasons: [
            { $match: { createdAt: { $gte: from, $lte: to }, rating: 'DOWN' } },
            { $group: { _id: '$reason', count: { $sum: 1 } } },
          ],
        },
      },
    ]),
    OpsFeatureUsage.aggregate([
      { $match: { date: { $gte: fromDay, $lte: toDay } } },
      {
        $facet: {
          features: [
            { $group: { _id: '$feature', users: { $addToSet: '$userId' } } },
            { $project: { _id: 0, feature: '$_id', members: { $size: '$users' } } },
          ],
          active: [
            { $group: { _id: null, users: { $addToSet: '$userId' } } },
            { $project: { _id: 0, members: { $size: '$users' } } },
          ],
          tenants: [
            { $group: { _id: null, businesses: { $addToSet: '$businessId' } } },
            { $project: { _id: 0, count: { $size: '$businesses' } } },
          ],
        },
      },
    ]),
    Product.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Business.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    User.countDocuments({}),
    User.countDocuments({ status: 'ACTIVE' }),
    Location.countDocuments({ status: 'ACTIVE' }),
    Supplier.countDocuments({ status: 'ACTIVE' }),
    PurchaseOrder.countDocuments({ status: 'OPEN' }),
    InventoryTransaction.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    OpsErrorEvent.aggregate([
      { $match: { occurredAt: { $gte: from, $lte: to } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                latestAt: { $max: '$occurredAt' },
                businesses: { $addToSet: '$businessId' },
              },
            },
            {
              // A pre-authentication 5xx has no businessId. It belongs in the
              // platform count but must not be counted as an affected tenant.
              $project: {
                _id: 0,
                count: 1,
                latestAt: 1,
                affectedTenants: {
                  $size: { $setDifference: ['$businesses', [null]] },
                },
              },
            },
          ],
          byCode: [
            { $group: { _id: { status: '$status', code: '$code' }, count: { $sum: 1 } } },
            { $sort: { count: -1, '_id.status': 1, '_id.code': 1 } },
            { $limit: 8 },
          ],
          byRoute: [
            {
              $group: {
                _id: { method: '$method', route: '$route' },
                count: { $sum: 1 },
                businesses: { $addToSet: '$businessId' },
              },
            },
            {
              $project: {
                count: 1,
                affectedTenants: {
                  $size: { $setDifference: ['$businesses', [null]] },
                },
              },
            },
            { $sort: { count: -1, '_id.route': 1 } },
            { $limit: 8 },
          ],
          recent: [
            { $sort: { occurredAt: -1, _id: -1 } },
            { $limit: 8 },
            {
              $project: {
                _id: 1,
                occurredAt: 1,
                status: 1,
                code: 1,
                method: 1,
                route: 1,
              },
            },
          ],
        },
      },
    ]),
  ]);

  const feedbackFacet = (feedbackRows[0] ?? {}) as {
    all?: Array<Record<string, unknown>>;
    window?: Array<Record<string, unknown>>;
    reasons?: Array<{ _id?: unknown; count?: unknown }>;
  };
  const allFeedback = feedbackFacet.all?.[0] ?? {};
  const windowFeedback = feedbackFacet.window?.[0] ?? {};
  const reasonCounts = new Map<string, number>();
  for (const row of feedbackFacet.reasons ?? []) {
    if (typeof row._id === 'string' && row._id.trim()) {
      reasonCounts.set(row._id, integer(row.count));
    }
  }
  const reasons = FEEDBACK_REASONS.map((reason) => ({
    reason,
    count: reasonCounts.get(reason) ?? 0,
  }));

  const featureFacet = (featureRows[0] ?? {}) as {
    features?: Array<{ feature?: unknown; members?: unknown }>;
    active?: Array<{ members?: unknown }>;
    tenants?: Array<{ count?: unknown }>;
  };
  const features = (featureFacet.features ?? [])
    .filter((row) => typeof row.feature === 'string')
    .map((row) => ({ feature: row.feature as string, members: integer(row.members) }))
    .sort((a, b) => a.feature.localeCompare(b.feature));

  const productCounts = new Map<string, number>();
  for (const row of productRows as Array<{ _id?: unknown; count?: unknown }>) {
    if (typeof row._id === 'string') productCounts.set(row._id, integer(row.count));
  }

  const businessCounts = new Map<string, number>();
  for (const row of businessRows as Array<{ _id?: unknown; count?: unknown }>) {
    if (typeof row._id === 'string') businessCounts.set(row._id, integer(row.count));
  }

  const errorsFacet = (errorRows[0] ?? {}) as {
    totals?: Array<{ count?: unknown; latestAt?: unknown; affectedTenants?: unknown }>;
    byCode?: Array<{ _id?: { status?: unknown; code?: unknown }; count?: unknown }>;
    byRoute?: Array<{
      _id?: { method?: unknown; route?: unknown };
      count?: unknown;
      affectedTenants?: unknown;
    }>;
    recent?: Array<{
      _id?: unknown;
      occurredAt?: unknown;
      status?: unknown;
      code?: unknown;
      method?: unknown;
      route?: unknown;
    }>;
  };
  const errorTotal = errorsFacet.totals?.[0] ?? {};
  const errorByCode = (errorsFacet.byCode ?? []).map((row) => ({
    status: integer(row._id?.status),
    code: typeof row._id?.code === 'string' ? row._id.code : null,
    count: integer(row.count),
  }));
  const errorByRoute = (errorsFacet.byRoute ?? []).map((row) => ({
    method: typeof row._id?.method === 'string' ? row._id.method : null,
    route: typeof row._id?.route === 'string' ? row._id.route : '/',
    count: integer(row.count),
    affectedTenants: integer(row.affectedTenants),
  }));
  const recentIssues = (errorsFacet.recent ?? []).map((row) => ({
    id: row._id === undefined ? '' : String(row._id),
    occurredAt: dateOrNull(row.occurredAt),
    status: integer(row.status),
    code: typeof row.code === 'string' ? row.code : null,
    method: typeof row.method === 'string' ? row.method : null,
    route: typeof row.route === 'string' ? row.route : '/',
  }));

  const totals = ai.totals;
  const active = integer(businessCounts.get('ACTIVE'));
  const suspended = integer(businessCounts.get('SUSPENDED'));
  const archived = integer(businessCounts.get('ARCHIVED'));

  return {
    asOf: to.toISOString(),
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: boundedDays,
      timeZone: 'UTC' as const,
    },
    platform: {
      businesses: {
        total: active + suspended + archived,
        active,
        suspended,
        archived,
      },
      accounts: {
        total: integer(totalAccounts),
        active: integer(activeAccounts),
      },
      tenantsActiveInWindow: integer(featureFacet.tenants?.[0]?.count),
    },
    ai: {
      turns: totals.turns,
      okTurns: totals.okTurns,
      degradedTurns: totals.degradedTurns,
      failedTurns: totals.failedTurns,
      successRate: ratio(totals.okTurns, totals.turns),
      failoverRate: totals.failoverRate,
      failovers: totals.failovers,
      retries: totals.retries,
      freeTurns: totals.freeTurns,
      paidTurns: totals.paidTurns,
      p95Ms: totals.latency.p95Ms,
      cost: totals.cost,
      daily: ai.daily.map((day) => ({
        date: day.date,
        turns: day.turns,
        failedTurns: day.failedTurns,
        p95Ms: day.p95Ms,
      })),
    },
    feedback: {
      total: integer(allFeedback.total),
      open: integer(allFeedback.open),
      reviewed: integer(allFeedback.reviewed),
      up: integer(allFeedback.up),
      down: integer(allFeedback.down),
      window: {
        total: integer(windowFeedback.total),
        up: integer(windowFeedback.up),
        down: integer(windowFeedback.down),
        byReason: reasons,
      },
    },
    usage: {
      activeMembers: {
        inWindow: integer(featureFacet.active?.[0]?.members),
        totalAccounts: integer(activeAccounts),
      },
      features,
      products: {
        active: productCounts.get('ACTIVE') ?? 0,
        archived: productCounts.get('ARCHIVED') ?? 0,
      },
      locations: integer(activeLocations),
      suppliers: integer(activeSuppliers),
      openPurchaseOrders: integer(openPurchaseOrders),
      stockMovements: integer(stockMovements),
    },
    issues: {
      count: integer(errorTotal.count),
      latestAt: dateOrNull(errorTotal.latestAt),
      affectedTenants: integer(errorTotal.affectedTenants),
      byCode: errorByCode,
      byRoute: errorByRoute,
      recent: recentIssues,
    },
  };
}

export default {
  getPlatformOperationsSummary,
};
