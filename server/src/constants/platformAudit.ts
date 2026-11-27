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
  RECOVERY_CODES_GENERATED: 'platform.mfa.recovery_codes_generated',
  RECOVERY_CODE_SUCCEEDED: 'platform.mfa.recovery_code_succeeded',
  RECOVERY_CODE_FAILED: 'platform.mfa.recovery_code_failed',
  WEBAUTHN_REGISTRATION_STARTED: 'platform.webauthn.registration_started',
  WEBAUTHN_REGISTERED: 'platform.webauthn.registered',
  WEBAUTHN_REGISTRATION_FAILED: 'platform.webauthn.registration_failed',
  WEBAUTHN_LOGIN_STARTED: 'platform.webauthn.login_started',
  WEBAUTHN_LOGIN_SUCCEEDED: 'platform.webauthn.login_succeeded',
  WEBAUTHN_LOGIN_FAILED: 'platform.webauthn.login_failed',
  ACCESS_DENIED: 'platform.access.denied',
  ACCESS_GATE_DENIED: 'platform.access.gate_denied',
  OPERATIONS_READ: 'platform.operations.read',
  AUDIT_READ: 'platform.audit.read',
  SESSION_RENEWED: 'platform.session.renewed',
  LOGOUT: 'platform.session.logout',
  PASSWORD_CHANGED: 'platform.account.password_changed',
  STEP_UP_SUCCEEDED: 'platform.auth.step_up_succeeded',
  STEP_UP_FAILED: 'platform.auth.step_up_failed',
  STEP_UP_REQUIRED: 'platform.auth.step_up_required',
  STEP_UP_USED: 'platform.auth.step_up_used',
  ADMIN_CREATED: 'platform.admin.created',
  ADMIN_LISTED: 'platform.admin.listed',
  ADMIN_STATUS_CHANGED: 'platform.admin.status_changed',
  ADMIN_DELETED: 'platform.admin.deleted',
  ADMIN_BREAK_GLASS_RESET: 'platform.admin.break_glass_reset',
  WEBAUTHN_KEY_REMOVED: 'platform.webauthn.key_removed',
  SUPPORT_TICKET_CREATED: 'platform.support.ticket_created',
  SUPPORT_TICKET_UPDATED: 'platform.support.ticket_updated',
  SUPPORT_TICKET_NOTE_ADDED: 'platform.support.ticket_note_added',
  SUPPORT_TICKETS_READ: 'platform.support.tickets_read',
  DEPLOYMENTS_READ: 'platform.deployments.read',
  BACKUPS_READ: 'platform.backups.read',
  BACKUP_RUN_STARTED: 'platform.backups.run_started',
  BACKUP_SCHEDULE_UPDATED: 'platform.backups.schedule_updated',
  BACKUP_DELETED: 'platform.backups.deleted',
  JOBS_READ: 'platform.jobs.read',
  JOB_ENABLED: 'platform.jobs.enabled',
  JOB_DISABLED: 'platform.jobs.disabled',
  JOB_RESCHEDULED: 'platform.jobs.rescheduled',
  INTEGRITY_READ: 'platform.integrity.read',
  READINESS_READ: 'platform.readiness.read',
  OUTBOX_READ: 'platform.outbox.read',
});

export const PLATFORM_AUDIT_ACTION_VALUES: readonly string[] = Object.freeze(
  Object.values(PLATFORM_AUDIT_ACTIONS),
);
