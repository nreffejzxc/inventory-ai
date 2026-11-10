/**
 * Client-side mirror of the server's RBAC matrix (server/src/constants/roles.js).
 *
 * The backend remains the security boundary — every protected route re-derives
 * role/businessId from the database and enforces these permissions server-side.
 * This mirror only decides what UI to show (buttons, screens, actions) so the
 * app never presents an action the server would reject.
 *
 * This file is also read at runtime by the server-side Phase 23 guard
 * (server/test/phase23-authorization-contract.test.mjs), which imports it
 * directly and diffs it against constants/roles.js. Keep it free of
 * transform-requiring TypeScript syntax (enums, namespaces, decorators): Node
 * loads it by stripping types, which only works on erasable syntax.
 */

export const ROLES = Object.freeze({
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
});

export const PERMISSIONS = Object.freeze({
  BUSINESS_MANAGE: 'business.manage',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  LOCATIONS_MANAGE: 'locations.manage',
  CATEGORIES_MANAGE: 'categories.manage',
  PRODUCTS_MANAGE: 'products.manage',
  PRODUCTS_VIEW: 'products.view',
  SUPPLIERS_MANAGE: 'suppliers.manage',
  SUPPLIERS_VIEW: 'suppliers.view',
  PURCHASE_ORDERS_MANAGE: 'purchase-orders.manage',
  PURCHASE_ORDERS_VIEW: 'purchase-orders.view',
  PURCHASE_ORDERS_RECEIVE: 'purchase-orders.receive',
  INVENTORY_MANAGE: 'inventory.manage',
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_STOCK_IN: 'inventory.stock-in',
  INVENTORY_STOCK_OUT: 'inventory.stock-out',
  INVENTORY_HISTORY_VIEW: 'inventory.history.view',
  TRANSACTIONS_VIEW: 'transactions.view',
  DASHBOARD_VIEW: 'dashboard.view',
  AI_USE: 'ai.use',
  AI_METRICS_VIEW: 'ai.metrics.view',
  AUDIT_VIEW: 'audit.view',
});

export type Role = (typeof ROLES)[keyof typeof ROLES];
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The minimum a value must expose for {@link can} to answer. */
export interface PermissionSubject {
  role?: string | null;
}

/** The minimum {@link canModifyUser} needs about the user being edited. */
export interface UserRef {
  id?: string | null;
  role?: string | null;
}

const ALL: readonly Permission[] = Object.freeze(Object.values(PERMISSIONS));

/** Keep in lock-step with the server ROLE_PERMISSIONS. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  OWNER: ALL,
  ADMIN: Object.freeze([
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.LOCATIONS_MANAGE,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.SUPPLIERS_MANAGE,
    PERMISSIONS.SUPPLIERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_MANAGE,
    PERMISSIONS.PURCHASE_ORDERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_RECEIVE,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_STOCK_IN,
    PERMISSIONS.INVENTORY_STOCK_OUT,
    PERMISSIONS.INVENTORY_HISTORY_VIEW,
    PERMISSIONS.TRANSACTIONS_VIEW,
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.AI_USE,
    PERMISSIONS.AI_METRICS_VIEW,
    PERMISSIONS.AUDIT_VIEW,
  ]),
  MANAGER: Object.freeze([
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.SUPPLIERS_MANAGE,
    PERMISSIONS.SUPPLIERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_MANAGE,
    PERMISSIONS.PURCHASE_ORDERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_RECEIVE,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_STOCK_IN,
    PERMISSIONS.INVENTORY_STOCK_OUT,
    PERMISSIONS.INVENTORY_HISTORY_VIEW,
    PERMISSIONS.TRANSACTIONS_VIEW,
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.AI_USE,
  ]),
  STAFF: Object.freeze([
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.SUPPLIERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_VIEW,
    PERMISSIONS.PURCHASE_ORDERS_RECEIVE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_STOCK_IN,
    PERMISSIONS.INVENTORY_STOCK_OUT,
    PERMISSIONS.INVENTORY_HISTORY_VIEW,
    PERMISSIONS.AI_USE,
  ]),
});

export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  const role = user?.role;
  if (!role) return false;
  // A role the mirror does not define grants nothing. The own-property check is
  // what keeps an inherited key ('toString', '__proto__', …) out of the lookup;
  // the cast is licensed by it.
  if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)) return false;
  const granted: readonly Permission[] | undefined = ROLE_PERMISSIONS[role as Role];
  return Array.isArray(granted) && granted.includes(permission);
}

// Convenience predicates used by screens/navigation.
export const canManageCategories = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.CATEGORIES_MANAGE);
export const canManageLocations = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.LOCATIONS_MANAGE);
export const canManageProducts = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.PRODUCTS_MANAGE);
export const canManageSuppliers = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.SUPPLIERS_MANAGE);
export const canViewSuppliers = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.SUPPLIERS_VIEW);
export const canViewDashboard = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.DASHBOARD_VIEW);
export const canAdjustStock = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.INVENTORY_MANAGE);
// A transfer moves stock between locations, so it needs the same managerial
// authority as an adjustment (Phase 19). Deliberately NO new permission — the
// mirror stays in lock-step with the server's unchanged RBAC matrix.
export const canTransferStock = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.INVENTORY_MANAGE);
export const canStockIn = (u: PermissionSubject | null | undefined): boolean => can(u, PERMISSIONS.INVENTORY_STOCK_IN);
export const canStockOut = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.INVENTORY_STOCK_OUT);
export const canUseAi = (u: PermissionSubject | null | undefined): boolean => can(u, PERMISSIONS.AI_USE);
export const canManagePurchaseOrders = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.PURCHASE_ORDERS_MANAGE);
export const canViewPurchaseOrders = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.PURCHASE_ORDERS_VIEW);
export const canReceivePurchaseOrders = (u: PermissionSubject | null | undefined): boolean =>
  can(u, PERMISSIONS.PURCHASE_ORDERS_RECEIVE);
export const canManageUsers = (u: PermissionSubject | null | undefined): boolean => can(u, PERMISSIONS.USERS_MANAGE);
export const canViewAudit = (u: PermissionSubject | null | undefined): boolean => can(u, PERMISSIONS.AUDIT_VIEW);

/**
 * Roles an actor may assign when creating/editing a user. OWNER may assign
 * any non-OWNER role; ADMIN only MANAGER/STAFF (never ADMIN). Mirrors the
 * server's NON_OWNER_ROLES + ADMIN_RESTRICTED rules — UI-only.
 */
export function assignableRoles(actor: PermissionSubject | null | undefined): Role[] {
  if (actor?.role === ROLES.OWNER) return [ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF];
  if (actor?.role === ROLES.ADMIN) return [ROLES.MANAGER, ROLES.STAFF];
  return [];
}

/**
 * Whether `actor` may edit `target`'s role/status. Mirrors the server rule
 * order in users.service.update: no self-change (CANNOT_MODIFY_SELF), OWNER
 * immutable (OWNER_IMMUTABLE), ADMIN cannot touch/assign ADMIN
 * (ADMIN_RESTRICTED). UI hides the Edit affordance; the backend stays
 * authoritative and rejects anyway.
 */
export function canModifyUser(
  actor: (PermissionSubject & UserRef) | null | undefined,
  target: UserRef | null | undefined,
): boolean {
  if (!canManageUsers(actor)) return false;
  if (!target) return false;
  if (String(actor?.id) === String(target.id)) return false;
  if (target.role === ROLES.OWNER) return false;
  if (actor?.role === ROLES.ADMIN && target.role === ROLES.ADMIN) return false;
  return true;
}

const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
});

/** Label used in the UI ("Profile" / headers). */
export function roleLabel(role: string | null | undefined): string {
  return ROLE_LABELS[role ?? ''] ?? role ?? 'User';
}

/**
 * First screen shown after sign-in. Dashboard needs MANAGER+; STAFF (and any
 * role without it) land on the inventory view instead.
 */
export function defaultHomePath(user: PermissionSubject | null | undefined): string {
  return canViewDashboard(user) ? '/dashboard' : '/inventory';
}

export default { ROLES, PERMISSIONS, ROLE_PERMISSIONS, can, roleLabel, canUseAi };
