/**
 * The fixed catalogue of platform audit actions.
 *
 * A closed vocabulary keeps the trail queryable and prevents a caller from
 * writing an arbitrary action string into an append-only record. Adding an
 * action is a code change with a test, not a data change.
 */

export const PLATFORM_AUDIT_OUTCOMES = Object.freeze({
  SUCCESS: 'SUCCESS',
  DENIED: 'DENIED',
  FAILURE: 'FAILURE',
});

export type PlatformAuditOutcome =
  (typeof PLATFORM_AUDIT_OUTCOMES)[keyof typeof PLATFORM_AUDIT_OUTCOMES];

export const PLATFORM_AUDIT_ACTIONS = Object.freeze({
  LOGIN_SUCCEEDED: 'platform.login.succeeded',
  LOGIN_FAILED: 'platform.login.failed',
  LOGIN_MFA_CHALLENGED: 'platform.login.mfa_challenged',
  MFA_ENROLLMENT_STARTED: 'platform.mfa.enrollment_started',
  MFA_ENROLLMENT_FAILED: 'platform.mfa.enrollment_failed',
  MFA_ENROLLED: 'platform.mfa.enrolled',
  MFA_VERIFIED: 'platform.mfa.verified',
  MFA_FAILED: 'platform.mfa.failed',
  WEBAUTHN_REGISTRATION_STARTED: 'platform.webauthn.registration_started',
  WEBAUTHN_REGISTERED: 'platform.webauthn.registered',
  WEBAUTHN_REGISTRATION_FAILED: 'platform.webauthn.registration_failed',
  WEBAUTHN_LOGIN_STARTED: 'platform.webauthn.login_started',
  WEBAUTHN_LOGIN_SUCCEEDED: 'platform.webauthn.login_succeeded',
  WEBAUTHN_LOGIN_FAILED: 'platform.webauthn.login_failed',
  ACCESS_DENIED: 'platform.access.denied',
  OPERATIONS_READ: 'platform.operations.read',
  AUDIT_READ: 'platform.audit.read',
  SESSION_RENEWED: 'platform.session.renewed',
  LOGOUT: 'platform.session.logout',
});

export const PLATFORM_AUDIT_ACTION_VALUES: readonly string[] = Object.freeze(
  Object.values(PLATFORM_AUDIT_ACTIONS),
);
