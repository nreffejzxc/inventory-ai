/**
 * PLAT-1 — the durable monitoring writers (formerly OPS-7/OPS-8).
 *
 * The tenant-facing operations READ that lived here was removed: it exposed
 * platform reliability data to business OWNER/ADMIN accounts. The read now lives
 * in `services/platformOperations.service.ts`, behind the separate platform-admin
 * plane and `platform.metrics.read`.
 *
 * What remains is the half that should be preserved, unchanged in storage shape
 * and retention:
 *   * a 5xx event written by the error handler; and
 *   * a member's feature presence after a successful response.
 *
 * Both writers are fire-and-forget: monitoring must never delay, fail or alter
 * the request it observes. Neither accepts a business id, user id, route or
 * feature from a request body — the values come from the authenticated request or
 * from this server's own path table.
 *
 * WHY THERE IS NO MESSAGE OR USER ID IN AN ERROR ROW. An operations view needs to
 * name the failing surface and the time, not reproduce the exception. Keeping the
 * message out means a database URI, a provider response or a person's data cannot
 * leak into a second collection, and keeping the user id out means the view cannot
 * become an activity log for a member.
 */

import mongoose from 'mongoose';

import OpsErrorEvent from '../models/opsErrorEvent.model.ts';
import OpsFeatureUsage from '../models/opsFeatureUsage.model.ts';

export const DEFAULT_OPERATIONS_DAYS = 7;
export const MAX_OPERATIONS_DAYS = 30;
export const OPERATIONS_RETENTION_DAYS = 90;

/** The only feature keys this server writes. A new screen must add one here. */
export const FEATURE_KEYS = Object.freeze({
  DASHBOARD: 'dashboard',
  PRODUCTS: 'products',
  INVENTORY: 'inventory',
  AI: 'ai',
  FEEDBACK: 'feedback',
  PURCHASE_ORDERS: 'purchase_orders',
  SUPPLIERS: 'suppliers',
  LOCATIONS: 'locations',
  CATEGORIES: 'categories',
  TEAM: 'team',
  AUDIT: 'audit',
});

const FEATURE_VALUES: ReadonlySet<string> = new Set(Object.values(FEATURE_KEYS));

/**
 * Prefix -> feature. Longest and most specific prefixes first: `/api/ai/feedback`
 * must not be counted as a chat, and AI metrics stays in the AI bucket now that
 * there is no tenant operations screen of its own.
 */
const FEATURE_PREFIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['/api/ai/feedback', FEATURE_KEYS.FEEDBACK],
  ['/api/ai/metrics', FEATURE_KEYS.AI],
  ['/api/ai/chat', FEATURE_KEYS.AI],
  ['/api/ai/conversations', FEATURE_KEYS.AI],
  ['/api/ai', FEATURE_KEYS.AI],
  ['/api/dashboard', FEATURE_KEYS.DASHBOARD],
  ['/api/products', FEATURE_KEYS.PRODUCTS],
  ['/api/inventory', FEATURE_KEYS.INVENTORY],
  ['/api/purchase-orders', FEATURE_KEYS.PURCHASE_ORDERS],
  ['/api/suppliers', FEATURE_KEYS.SUPPLIERS],
  ['/api/locations', FEATURE_KEYS.LOCATIONS],
  ['/api/categories', FEATURE_KEYS.CATEGORIES],
  ['/api/users', FEATURE_KEYS.TEAM],
  ['/api/invitations', FEATURE_KEYS.TEAM],
  ['/api/audit', FEATURE_KEYS.AUDIT],
]);

/** Parse `?days=` without trusting the query value's type. */
export function parseOperationsDays(raw: unknown): { days: number; problem: string | null } {
  if (raw === undefined || raw === null || raw === '') {
    return { days: DEFAULT_OPERATIONS_DAYS, problem: null };
  }
  const value = Array.isArray(raw) ? '' : String(raw).trim();
  if (!value || !/^\d+$/.test(value)) {
    return {
      days: DEFAULT_OPERATIONS_DAYS,
      problem: `days must be an integer from 1 to ${MAX_OPERATIONS_DAYS}`,
    };
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_OPERATIONS_DAYS) {
    return {
      days: DEFAULT_OPERATIONS_DAYS,
      problem: `days must be an integer from 1 to ${MAX_OPERATIONS_DAYS}`,
    };
  }
  return { days, problem: null };
}

/** The feature a successful request belongs to, or null if it is not tracked. */
export function featureForPath(rawPath: unknown): string | null {
  const path = typeof rawPath === 'string' ? (rawPath.split('?')[0] ?? '').trim() : '';
  if (!path) return null;
  for (const [prefix, feature] of FEATURE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return feature;
  }
  return null;
}

/**
 * A safe route label: no query string, no raw ObjectId or numeric identifier.
 * The bound is deliberate — a hostile or malformed path must not become an
 * unbounded string in a durable row.
 */
export function normalizeErrorPath(rawPath: unknown): string {
  const raw = typeof rawPath === 'string' ? rawPath.split('?')[0] : '';
  const value = raw || '/';
  return (
    value
      .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:id')
      .slice(0, 200) || '/'
  );
}

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type OpsErrorEventInput = {
  businessId?: string | null;
  status: number;
  code?: string | null;
  method?: string | null;
  path?: string | null;
  now?: Date;
};

export type OpsErrorEventDocument = {
  businessId: mongoose.Types.ObjectId | null;
  occurredAt: Date;
  status: number;
  code: string | null;
  method: string | null;
  route: string;
  expiresAt: Date;
};

/** Build the bounded, secret-free row. Exported so its shape is pinned without a database. */
export function buildOpsErrorEvent(input: OpsErrorEventInput): OpsErrorEventDocument {
  const now = input.now instanceof Date ? input.now : new Date();
  const status =
    Number.isInteger(input.status) && input.status >= 500 && input.status <= 599
      ? input.status
      : 500;
  const code =
    typeof input.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(input.code.trim())
      ? input.code.trim()
      : 'INTERNAL_ERROR';
  const method =
    typeof input.method === 'string' && SAFE_METHODS.has(input.method.toUpperCase())
      ? input.method.toUpperCase()
      : null;
  const businessId =
    typeof input.businessId === 'string' && mongoose.Types.ObjectId.isValid(input.businessId)
      ? new mongoose.Types.ObjectId(input.businessId)
      : null;

  return {
    businessId,
    occurredAt: now,
    status,
    code,
    method,
    route: normalizeErrorPath(input.path),
    expiresAt: new Date(now.getTime() + OPERATIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Record one 5xx. Best-effort and never awaited by the error handler: a
 * monitoring write must not turn a response failure into a different failure.
 * A write attempted before the database is connected is skipped rather than
 * buffered; the log line is still the immediate signal, and the TTL store is
 * only useful once the database it lives in is reachable.
 */
export async function recordOperationalError(input: OpsErrorEventInput): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await OpsErrorEvent.create(buildOpsErrorEvent(input));
    return true;
  } catch (err) {
    console.error(
      `Operations error event not stored: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return false;
  }
}

export type FeatureUseInput = {
  businessId: string;
  userId: string;
  feature: string;
  at?: Date;
};

function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 11000);
}

/**
 * In-process throttle for the upsert, not the source of truth. One request per
 * member/feature/10 minutes is enough to establish presence and `lastSeenAt`;
 * a restart loses only the throttle and the next successful request writes the
 * same unique row again without double-counting.
 */
const recentFeatureWrites = new Map<string, number>();
const FEATURE_DEDUPE_MS = 10 * 60 * 1000;
const MAX_FEATURE_DEDUPE_KEYS = 5000;

/**
 * Record that a member used a feature today. Returns false only when the input
 * is invalid or the store is unavailable; it never throws to its caller.
 */
export async function recordFeatureUse(input: FeatureUseInput): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  if (!FEATURE_VALUES.has(input.feature)) return false;
  if (
    !mongoose.Types.ObjectId.isValid(input.businessId) ||
    !mongoose.Types.ObjectId.isValid(input.userId)
  ) {
    return false;
  }

  const at = input.at instanceof Date ? input.at : new Date();
  const date = at.toISOString().slice(0, 10);
  const key = `${input.businessId}:${input.userId}:${input.feature}:${date}`;
  const nowMs = Date.now();
  const last = recentFeatureWrites.get(key);
  if (last !== undefined && nowMs - last < FEATURE_DEDUPE_MS) return true;

  const filter = {
    businessId: new mongoose.Types.ObjectId(input.businessId),
    date,
    feature: input.feature,
    userId: new mongoose.Types.ObjectId(input.userId),
  };
  const update = {
    $set: { lastSeenAt: at },
    $setOnInsert: {
      firstSeenAt: at,
      expiresAt: new Date(at.getTime() + OPERATIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    },
  };

  try {
    await OpsFeatureUsage.updateOne(filter, update, { upsert: true });
  } catch (err) {
    if (!isDuplicateKey(err)) {
      console.error(
        `Operations feature use not stored: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return false;
    }
    try {
      await OpsFeatureUsage.updateOne(filter, { $set: { lastSeenAt: at } });
    } catch (retryErr) {
      console.error(
        `Operations feature use retry failed: ${
          retryErr instanceof Error ? retryErr.message : 'unknown error'
        }`,
      );
      return false;
    }
  }

  if (recentFeatureWrites.size > MAX_FEATURE_DEDUPE_KEYS) recentFeatureWrites.clear();
  recentFeatureWrites.set(key, nowMs);
  return true;
}


export default {
  DEFAULT_OPERATIONS_DAYS,
  MAX_OPERATIONS_DAYS,
  FEATURE_KEYS,
  parseOperationsDays,
  featureForPath,
  normalizeErrorPath,
  buildOpsErrorEvent,
  recordOperationalError,
  recordFeatureUse,
};
