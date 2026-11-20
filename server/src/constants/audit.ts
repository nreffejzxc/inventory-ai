/**
 * Audit action + entity constants. Actions follow SYSTEM_SPECIFICATION.md §17
 * (PRODUCT_CREATED, INVENTORY_STOCK_IN, ...). Kept in one place so services and
 * tests share exact strings.
 */

export const AUDIT_ACTIONS = Object.freeze({
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  CATEGORY_ARCHIVED: 'CATEGORY_ARCHIVED',
  LOCATION_CREATED: 'LOCATION_CREATED',
  LOCATION_UPDATED: 'LOCATION_UPDATED',
  LOCATION_ARCHIVED: 'LOCATION_ARCHIVED',
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_ARCHIVED: 'PRODUCT_ARCHIVED',
  SUPPLIER_CREATED: 'SUPPLIER_CREATED',
  SUPPLIER_UPDATED: 'SUPPLIER_UPDATED',
  SUPPLIER_ARCHIVED: 'SUPPLIER_ARCHIVED',
  PURCHASE_ORDER_CREATED: 'PURCHASE_ORDER_CREATED',
  PURCHASE_ORDER_UPDATED: 'PURCHASE_ORDER_UPDATED',
  PURCHASE_ORDER_ISSUED: 'PURCHASE_ORDER_ISSUED',
  PURCHASE_ORDER_CANCELED: 'PURCHASE_ORDER_CANCELED',
  PURCHASE_ORDER_RECEIVED: 'PURCHASE_ORDER_RECEIVED',
  // A reaper proved an abandoned receive claim and either released it or
  // removed its exact stock-in. Recorded as a first-class business event so an
  // operator can see that stock moved backwards without a user action.
  PURCHASE_ORDER_CLAIM_RECOVERED: 'PURCHASE_ORDER_CLAIM_RECOVERED',
  INVENTORY_STOCK_IN: 'INVENTORY_STOCK_IN',
  INVENTORY_STOCK_OUT: 'INVENTORY_STOCK_OUT',
  INVENTORY_ADJUSTED: 'INVENTORY_ADJUSTED',
  INVENTORY_TRANSFERRED: 'INVENTORY_TRANSFERRED',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  // Phase 26A — session lifecycle. Four distinct events rather than one, so the
  // trail distinguishes "signed in", "signed out on this device", "ended another
  // device" and "signed out everywhere".
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_LOGGED_OUT: 'SESSION_LOGGED_OUT',
  SESSION_REVOKED: 'SESSION_REVOKED',
  SESSIONS_REVOKED_ALL: 'SESSIONS_REVOKED_ALL',
  // Phase 26B-2 — password recovery. Two events, not one: a link was issued,
  // and a password was actually replaced through one. They are different facts
  // about the account and an investigator needs to tell them apart (a request
  // that was never completed is the shape of a probe; a completion with no
  // request is impossible). Both use AUDIT_ENTITY_TYPES.USER, so no entity type
  // was added.
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  // Phase 32H — Firebase identity linking. TWO events, not four, and the
  // omission is deliberate rather than an oversight.
  //
  // LINKED records the one durable outcome: the caller's own account adopted a
  // verified Firebase identity. LINK_CONFLICT records the refusal — a verified
  // identity that already belongs to another account, or an account that
  // already owns a different identity. They are the two facts an investigator
  // needs to tell apart: an adoption, and a blocked adoption.
  //
  // The brief's other candidates are absent for a structural reason rather than
  // a policy one. "Attempted cross-business linking" and "attempted role
  // manipulation" cannot be observed here at all: `validateFirebaseLink` returns
  // only `idToken`, so a body carrying `businessId` or `role` is indistinguishable
  // from a body carrying any other unknown key, and there is no value to detect.
  // "Unauthenticated linking" is refused by `requireAuth` before any handler runs,
  // so no `businessId` exists to attribute a row to — and `recordAudit` requires
  // one. The control for all three is structural, and an audit row is not what
  // makes it hold.
  FIREBASE_IDENTITY_LINKED: 'FIREBASE_IDENTITY_LINKED',
  FIREBASE_IDENTITY_LINK_CONFLICT: 'FIREBASE_IDENTITY_LINK_CONFLICT',
  // Account deletion (2026-10-24). ONE event, recorded with `userId: null` because
  // naming the caller would immediately re-point the trail at the account whose
  // identifiers the same transaction removes. `entityId` is the tombstone's id, so the
  // business's governance record still shows that an account was closed, when, and
  // under which role, without identifying the person afterwards.
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',
  // Invitation-based onboarding (2026-10-25). Three events, one per transition the
  // admin or the invitee can cause. They are separate rather than a single
  // INVITATION_UPDATED because the trail's value here is telling a grant that was
  // declined from one that was used: a REVOKED row is somebody withdrawing an offer,
  // an ACCEPTED row is a new member. The address is NOT in any metadata — the same
  // rule the account-deletion work established, so a later deletion cannot leave a
  // readable address in the trail.
  INVITATION_SENT: 'INVITATION_SENT',
  INVITATION_REVOKED: 'INVITATION_REVOKED',
  INVITATION_ACCEPTED: 'INVITATION_ACCEPTED',
});

export const AUDIT_ENTITY_TYPES = Object.freeze({
  CATEGORY: 'CATEGORY',
  LOCATION: 'LOCATION',
  PRODUCT: 'PRODUCT',
  SUPPLIER: 'SUPPLIER',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  INVENTORY: 'INVENTORY',
  INVENTORY_TRANSACTION: 'INVENTORY_TRANSACTION',
  USER: 'USER',
  SESSION: 'SESSION',
  // The invitation itself — the entityId is the Invitation row, which is why this is
  // not filed under USER: the invitation exists before any user does.
  INVITATION: 'INVITATION',
});

export default { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES };
