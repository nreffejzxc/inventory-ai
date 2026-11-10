/**
 * Roles and role permissions, per SYSTEM_SPECIFICATION.md §7.
 *
 * Roles: OWNER, ADMIN, MANAGER, STAFF.
 * These values are stored in the User.role field and are the ONLY source of
 * truth for authorization — role claims from clients/tokens are never trusted.
 */

export const ROLES = Object.freeze({
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

/**
 * Roles that can be assigned through the user-management API (Phase 14A).
 * OWNER is deliberately excluded: an OWNER user is only ever created by
 * registration, never created or assigned by the API.
 */
export const NON_OWNER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF]);

/**
 * Permission catalogue. Coarse, resource-level capabilities used by protected
 * routes (Phases 04+). Explicit here so the spec's capability matrix is
 * encoded in one place.
 */
export const PERMISSIONS = Object.freeze({
  BUSINESS_MANAGE: 'business.manage', // OWNER only
  USERS_MANAGE: 'users.manage', // OWNER + ADMIN (Phase 14A)
  ROLES_MANAGE: 'roles.manage', // OWNER only
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
  AI_METRICS_VIEW: 'ai.metrics.view', // OWNER + ADMIN (AI-102)
  AUDIT_VIEW: 'audit.view', // OWNER + ADMIN (Phase 16)
});

const ALL = Object.freeze(Object.values(PERMISSIONS));

/**
 * Phase 22 — permission values that are declared in the catalogue above but
 * have NO enforcement point yet: no route, and no AI tool, references them.
 *
 * This is METADATA ONLY. It exists so the authorization-contract regression
 * guard (test/phase22-authorization-contract.test.mjs) can require every
 * catalogue entry to be either enforced or listed here, instead of letting an
 * unwired capability sit in the matrix unnoticed. Nothing at runtime reads it:
 * it is not imported by middlewares/authorize.js and it does NOT participate in
 * any authorization decision. Listing a permission here does not grant it,
 * revoke it, or weaken it.
 *
 * The grants in ROLE_PERMISSIONS are deliberately unchanged — these keys are
 * still held by the roles that hold them today. A future phase that wires one
 * up moves it out of this list, and the guard fails until it does.
 *
 * - business.manage  — spec §7 reserves business-level settings for OWNER; no
 *                      business-settings endpoint exists.
 * - roles.manage     — spec §7 reserves role administration for OWNER; roles
 *                      are fixed in code, so there is nothing to administer.
 * - transactions.view — the ledger read is served by GET /api/inventory/history
 *                      under inventory.history.view (all four roles hold it,
 *                      while only three hold transactions.view — wiring this
 *                      key there would silently revoke STAFF history access).
 */
export const CATALOGUE_ONLY_PERMISSIONS = Object.freeze([
  PERMISSIONS.BUSINESS_MANAGE,
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.TRANSACTIONS_VIEW,
]);

/** Capabilities granted to each role, per SYSTEM_SPECIFICATION.md §7. */
export const ROLE_PERMISSIONS = Object.freeze({
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

/**
 * Whether a role holds a given permission.
 *
 * Both arguments stay `string`: `role` reaches this from a database-loaded user
 * and `permission` from a route's declared key, and an unknown role must answer
 * `false` rather than throw. The index is widened to a string lookup so that
 * "no such role" is a value (`undefined`) the existing `Array.isArray` guard
 * can reject, not a compile-time impossibility.
 */
export function hasPermission(role: string, permission: string) {
  const granted = (ROLE_PERMISSIONS as Record<string, readonly string[] | undefined>)[
    role
  ];
  return Array.isArray(granted) && granted.includes(permission);
}

export default {
  ROLES,
  ROLE_VALUES,
  NON_OWNER_ROLES,
  PERMISSIONS,
  CATALOGUE_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
};
