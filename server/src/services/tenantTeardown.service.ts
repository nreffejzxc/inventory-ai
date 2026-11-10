/**
 * Removing a whole tenant — every row a business owns, then its people, then the
 * business itself.
 *
 * WHY THIS LIVES IN `src/` AND NOT ONLY IN `scripts/`. It was written for the seed and
 * cleanup tooling, and that is still its main caller. Account deletion needs exactly the
 * same knowledge: when the only member of a business closes their account, the business
 * has nobody left to serve, so its products, stock, movements, purchase orders, audit
 * trail and assistant history must go with it — and the list of collections that means
 * must be THE SAME list the tooling uses. A second copy in the service would eventually
 * delete less than the tooling does, or more, and only a data-integrity test would ever
 * notice.
 *
 * THE ONE DEFINITION OF "THE TENANT'S ROWS" IS `TENANT_TEARDOWN_PLAN` BELOW. Data steps
 * filter by `businessId`; messages and account rows are reached only through ids resolved
 * from that same `businessId`, so a wrong id matches nothing and no other tenant's data
 * can be reached from here. Steps run child-before-parent, and the assistant's messages
 * are resolved through their conversations because a message carries only
 * `conversationId`.
 *
 * ACCOUNT-SCOPED ROWS ARE RESOLVED BEFORE THE USERS GO. Sessions, password-reset tokens
 * and reset challenges carry only `userId`, so a businessId filter cannot see them and
 * deleting the users first would strand them as rows nothing can ever tie to a tenant
 * again (AI-40, 2026-10-23).
 *
 * NOTHING HERE RUNS ON IMPORT and nothing here decides whether deleting is allowed —
 * the caller does that first, and hands over business ids it has already established.
 */

import mongoose from 'mongoose';

import AIConversation from '../models/aiConversation.model.ts';
import AIMessage from '../models/aiMessage.model.ts';
import AiTurnMetric from '../models/aiTurnMetric.model.ts';
import AuditLog from '../models/auditLog.model.ts';
import Business from '../models/business.model.ts';
import Category from '../models/category.model.ts';
import Inventory from '../models/inventory.model.ts';
import InventoryTransaction from '../models/inventoryTransaction.model.ts';
import Invitation from '../models/invitation.model.ts';
import Location from '../models/location.model.ts';
import PasswordResetChallenge from '../models/passwordResetChallenge.model.ts';
import PasswordResetToken from '../models/passwordResetToken.model.ts';
import Product from '../models/product.model.ts';
import PurchaseOrder from '../models/purchaseOrder.model.ts';
import Session from '../models/session.model.ts';
import Supplier from '../models/supplier.model.ts';
import User from '../models/user.model.ts';

/** A document id, as the models accept it. */
type IdLike = string | mongoose.Types.ObjectId;

/**
 * Every collection whose rows carry `businessId`, with the name used in the counts.
 *
 * The history of this list is the reason it is a constant and not an inline loop:
 * `suppliers` and `purchase_orders` were missing from an earlier version, harmless only
 * because the seeder that used it never wrote those two collections, and `audit_logs`
 * was missing until AI-40 found a tenant teardown reporting a clean result while leaving
 * its governance trail behind.
 */
/**
 * The two Mongoose calls this module needs from a model. Stated as a narrow structural
 * type rather than `any`, so a model that cannot be queried this way is a compile error.
 */
type TenantModel = {
  deleteMany(filter: object): Promise<{ deletedCount?: number }>;
  countDocuments(filter: object): Promise<number>;
};

export const TENANT_DATA_COLLECTIONS: Array<[string, TenantModel]> = [
  ['inventory', Inventory],
  ['inventory_transactions', InventoryTransaction],
  ['purchase_orders', PurchaseOrder],
  ['products', Product],
  ['categories', Category],
  ['locations', Location],
  ['suppliers', Supplier],
  ['audit_logs', AuditLog],
  // AI-102 — one operational row per assistant turn. It carries businessId, so a tenant
  // teardown must remove it with the rest of that tenant's data rather than leave metrics
  // that can no longer be tied to a business.
  ['ai_turn_metrics', AiTurnMetric],
  // Invitation-based onboarding (2026-10-25). An invitation carries a real address and a
  // working token, so it is data, not history: closing a tenant without removing its
  // pending invitations would leave emails that promise a business that no longer exists.
  ['invitations', Invitation],
];

/**
 * How a plan step finds the rows it owns.
 *
 * `business`             — the row carries `businessId`.
 * `conversationMessages` — a message carries only `conversationId`; its ids are resolved
 *                          from the tenant's conversations before anything is deleted.
 * `user`                 — the row carries only `userId`; its ids are resolved before the
 *                          users are deleted.
 * `businessRow`          — the business document itself (`_id`).
 */
type TenantPlanMatch = 'business' | 'conversationMessages' | 'user' | 'businessRow';

/** `data` is the tenant's business data; `account` is its logins and business row. */
type TenantPlanScope = 'data' | 'account';

type TenantPlanStep = {
  name: string;
  model: TenantModel;
  scope: TenantPlanScope;
  match: TenantPlanMatch;
};

/**
 * ONE ordered plan for counting and deleting a tenant.
 *
 * `removeTenant` / `countTenantRemoval` walk all of it; `clearTenantData` /
 * `countTenantDataRemoval` walk only the `data` steps. The dry run and the deletion
 * therefore cannot describe different collections or a different order — the executor
 * below is the only place a plan step becomes a query.
 */
export const TENANT_TEARDOWN_PLAN: TenantPlanStep[] = [
  { name: 'ai_messages', model: AIMessage, scope: 'data', match: 'conversationMessages' },
  { name: 'ai_conversations', model: AIConversation, scope: 'data', match: 'business' },
  ...TENANT_DATA_COLLECTIONS.map(([name, model]): TenantPlanStep => ({
    name,
    model,
    scope: 'data',
    match: 'business',
  })),
  { name: 'sessions', model: Session, scope: 'account', match: 'user' },
  { name: 'password_reset_tokens', model: PasswordResetToken, scope: 'account', match: 'user' },
  { name: 'password_reset_challenges', model: PasswordResetChallenge, scope: 'account', match: 'user' },
  { name: 'users', model: User, scope: 'account', match: 'business' },
  { name: 'businesses', model: Business, scope: 'account', match: 'businessRow' },
];

function toIds(businessIds: Array<IdLike>): mongoose.Types.ObjectId[] {
  return businessIds.map((id) => new mongoose.Types.ObjectId(String(id)));
}

type TenantPlanContext = {
  ids: mongoose.Types.ObjectId[];
  businessFilter: { businessId: { $in: mongoose.Types.ObjectId[] } };
  conversationIds: mongoose.Types.ObjectId[];
  userIds: mongoose.Types.ObjectId[];
};

async function resolveTenantPlanContext(
  ids: mongoose.Types.ObjectId[],
  { withAccounts }: { withAccounts: boolean },
): Promise<TenantPlanContext> {
  const businessFilter = { businessId: { $in: ids } };
  const conversationIds = await AIConversation.find(businessFilter).distinct('_id');
  // Only the account half needs user ids. Resolving them before the first delete is
  // what keeps sessions and reset rows reachable after their users are gone.
  const userIds = withAccounts ? await User.find(businessFilter).distinct('_id') : [];
  return { ids, businessFilter, conversationIds, userIds };
}

function tenantPlanFilter(step: TenantPlanStep, context: TenantPlanContext): object {
  switch (step.match) {
    case 'conversationMessages':
      return { conversationId: { $in: context.conversationIds } };
    case 'user':
      return { userId: { $in: context.userIds } };
    case 'businessRow':
      return { _id: { $in: context.ids } };
    case 'business':
    default:
      return context.businessFilter;
  }
}

type TenantPlanMode = 'count' | 'delete';
type TenantPlanSelection = 'data' | 'all';

/**
 * The only executor. It resolves the ids once, then walks the plan in order and either
 * counts or deletes exactly the rows the plan names. A dry run and a real run differ only
 * in `mode`, so their per-collection keys and totals cannot drift.
 */
async function executeTenantTeardownPlan(
  businessIds: Array<IdLike>,
  { mode, selection }: { mode: TenantPlanMode; selection: TenantPlanSelection },
): Promise<{ total: number; counts: Record<string, number> }> {
  const ids = toIds(businessIds);
  const context = await resolveTenantPlanContext(ids, { withAccounts: selection === 'all' });
  const counts: Record<string, number> = {};
  let total = 0;

  for (const step of TENANT_TEARDOWN_PLAN) {
    if (selection === 'data' && step.scope !== 'data') continue;
    const filter = tenantPlanFilter(step, context);
    const count =
      mode === 'delete'
        ? (await step.model.deleteMany(filter)).deletedCount ?? 0
        : await step.model.countDocuments(filter);
    counts[step.name] = count;
    total += count;
  }

  return { total, counts };
}

/**
 * Delete every DATA document belonging to the given tenants, and NOTHING else.
 *
 * The account rows (`users`, `businesses`) are deliberately not touched: `removeTenant`
 * does that, and a caller that only wants the tenant's data reset (the demo and role
 * seeders) must not lose the accounts.
 */
export async function clearTenantData(
  businessIds: Array<IdLike>
): Promise<{ removed: number; counts: Record<string, number> }> {
  const { total, counts } = await executeTenantTeardownPlan(businessIds, {
    mode: 'delete',
    selection: 'data',
  });
  return { removed: total, counts };
}

/**
 * Delete a WHOLE tenant: its data, then its users, then the business row itself.
 *
 * Returns per-collection counts so a caller can prove the tenant is gone rather than
 * assume it.
 */
export async function removeTenant(
  businessIds: Array<IdLike>
): Promise<{ removed: number; counts: Record<string, number> }> {
  const { total, counts } = await executeTenantTeardownPlan(businessIds, {
    mode: 'delete',
    selection: 'all',
  });
  return { removed: total, counts };
}

/**
 * Count every row `removeTenant` would delete, without deleting any.
 *
 * Walks the SAME plan as `removeTenant`, so a cleanup dry run cannot describe a different
 * set from the removal it previews. The counts are keyed the same way as `removeTenant`'s,
 * which is what lets a caller compare a preview with the real run.
 */
export async function countTenantRemoval(
  businessIds: Array<IdLike>
): Promise<{ total: number; counts: Record<string, number> }> {
  return executeTenantTeardownPlan(businessIds, { mode: 'count', selection: 'all' });
}

/**
 * Count every DATA row `clearTenantData` would delete, without deleting any.
 *
 * The data-only dry run, for `cleanup:demo`: the same plan and the same filters, with the
 * account steps left out. Its counts are directly comparable with `clearTenantData`'s.
 */
export async function countTenantDataRemoval(
  businessIds: Array<IdLike>
): Promise<{ total: number; counts: Record<string, number> }> {
  return executeTenantTeardownPlan(businessIds, { mode: 'count', selection: 'data' });
}

/**
 * Count anything still carrying the given tenant ids — the verification half of a
 * removal, over the SAME plan the removal uses, so a collection that is deleted is
 * necessarily also verified. Includes the account rows and the business row itself.
 */
export async function countTenantLeftovers(businessIds: Array<IdLike>): Promise<number> {
  const { total } = await executeTenantTeardownPlan(businessIds, {
    mode: 'count',
    selection: 'all',
  });
  return total;
}

export default {
  TENANT_DATA_COLLECTIONS,
  TENANT_TEARDOWN_PLAN,
  clearTenantData,
  removeTenant,
  countTenantRemoval,
  countTenantDataRemoval,
  countTenantLeftovers,
};
