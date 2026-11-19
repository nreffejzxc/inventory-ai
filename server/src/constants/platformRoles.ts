/**
 * Platform Operations — the internal authorization catalogue.
 *
 * WHY THIS IS NOT `constants/roles.ts`. That file is the tenant matrix: `OWNER`
 * is the highest authority INSIDE one business, and every decision it drives is
 * scoped by the authenticated `businessId`. A platform operator is a different
 * kind of principal — they have no tenant, they are not a `User`, and no tenant
 * role may ever reach the platform surface. Keeping the two catalogues in
 * separate files makes that separation structural: importing this module cannot
 * grant a tenant permission, and importing the tenant catalogue cannot grant a
 * platform capability.
 *
 * The names are `platform.*` on purpose. A tenant permission (`operations.view`,
 * `audit.view`) can never be mistaken for one of these values, and
 * `hasPermission()` from the tenant matrix is never consulted here.
 */

export const PLATFORM_ROLES = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  SUPPORT: 'SUPPORT',
  SECURITY: 'SECURITY',
  SUPERADMIN: 'SUPERADMIN',
});

export type PlatformRole = (typeof PLATFORM_ROLES)[keyof typeof PLATFORM_ROLES];

export const PLATFORM_ROLE_VALUES: readonly string[] = Object.freeze(
  Object.values(PLATFORM_ROLES),
);

/**
 * Capabilities the platform console can require.
 *
 * There is deliberately no TENANT-data write capability: no tenant data is
 * created, changed or deleted. Support tickets and administrator lifecycle are
 * platform-only writes. `platform.admin.manage` is bound to the administrator
 * list/status/delete/key-removal routes, not to any tenant route. No
 * tenant-detail support grant exists (see
 * docs/superpowers/specs/2026-11-16-platform-admin-architecture.md).
 */
export const PLATFORM_CAPABILITIES = Object.freeze({
  HEALTH_READ: 'platform.health.read',
  METRICS_READ: 'platform.metrics.read',
  AUDIT_READ: 'platform.audit.read',
  ADMIN_MANAGE: 'platform.admin.manage',
  SUPPORT_MANAGE: 'platform.support.manage',
  DEPLOYMENTS_READ: 'platform.deployments.read',
});

const ALL_PLATFORM_CAPABILITIES = Object.freeze(Object.values(PLATFORM_CAPABILITIES));

/**
 * Role -> capabilities. Least privilege:
 *   READ_ONLY  sees service health only.
 *   SUPPORT    sees aggregate platform metrics and manages support tickets.
 *   SECURITY   additionally sees the platform audit trail.
 *   SUPERADMIN is reserved for platform-administrator management.
 *
 * `platform.metrics.read` is the capability behind GET /api/platform/operations.
 * It is NOT held by READ_ONLY, so a health-only observer cannot read cross-tenant
 * usage or error aggregates.
 */
export const PLATFORM_ROLE_CAPABILITIES = Object.freeze({
  READ_ONLY: Object.freeze([PLATFORM_CAPABILITIES.HEALTH_READ]),
  SUPPORT: Object.freeze([
    PLATFORM_CAPABILITIES.HEALTH_READ,
    PLATFORM_CAPABILITIES.METRICS_READ,
    PLATFORM_CAPABILITIES.SUPPORT_MANAGE,
    PLATFORM_CAPABILITIES.DEPLOYMENTS_READ,
  ]),
  SECURITY: Object.freeze([
    PLATFORM_CAPABILITIES.HEALTH_READ,
    PLATFORM_CAPABILITIES.METRICS_READ,
    PLATFORM_CAPABILITIES.AUDIT_READ,
    PLATFORM_CAPABILITIES.DEPLOYMENTS_READ,
  ]),
  SUPERADMIN: ALL_PLATFORM_CAPABILITIES,
});

/** Capabilities held by a platform role. An unknown role holds none. */
export function platformCapabilitiesFor(role: string): readonly string[] {
  return (
    (PLATFORM_ROLE_CAPABILITIES as Record<string, readonly string[] | undefined>)[role] ?? []
  );
}

/**
 * Whether a platform role holds a capability.
 *
 * Both arguments stay `string`: `role` comes from a database row and
 * `capability` from a route declaration, and an unknown value must answer
 * `false` rather than throw.
 */
export function platformHasCapability(role: string, capability: string): boolean {
  return platformCapabilitiesFor(role).includes(capability);
}

/** Whether a value is a platform role this server recognises. */
export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && PLATFORM_ROLE_VALUES.includes(value);
}

export default {
  PLATFORM_ROLES,
  PLATFORM_ROLE_VALUES,
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  platformCapabilitiesFor,
  platformHasCapability,
  isPlatformRole,
};
