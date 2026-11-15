/**
 * Self-service account deletion (Google Play account-deletion requirement).
 *
 * WHAT DELETION MEANS HERE. The person's account is closed and their personal
 * information is removed, but the row that their business's records already point
 * at is NOT hard-deleted: audit rows, inventory transactions, purchase orders and
 * the AI usage history all carry a `userId`/`entityId`, and erasing the row would
 * turn those into dangling references — which would falsify an inventory history
 * that other members of the same business still rely on. So the user row becomes a
 * TOMBSTONE:
 *
 *   - `status: 'DELETED'` and `deletedAt` — every authentication path already
 *     refuses a status that is not ACTIVE, so the account can never be signed into
 *     again, and `users.service` never lists or edits it;
 *   - `name: 'Deleted user'` — the only human-readable personal field;
 *   - `email` replaced by a unique, non-routable placeholder
 *     (`deleted+<id>@deleted.invalid`), which frees the real address AND keeps the
 *     unique index intact. It is deliberately in the reserved `.invalid` TLD, so it
 *     can never be delivered to;
 *   - `firebaseUid` and `passwordHash` UNSET — no identity linkage and no credential
 *     survives;
 *   - `emailVerified: false`, `passwordChangedAt: now` — a belt-and-braces
 *     invalidation of any token minted before this moment.
 *
 * The Firebase identity itself is deleted BEFORE the tombstone is written. That
 * order matters: Firebase is the identity provider, so leaving the identity alive
 * would keep accepting the person's password and land them on
 * `REGISTRATION_REQUIRED` — a deleted account that is still a usable identity.
 * A crash after the Firebase delete leaves an ACTIVE row that a second request can
 * still tombstone, and the second Firebase delete is answered as already-gone.
 *
 * THAT RECOVERY HAS ONE NARROW HOLE, stated rather than papered over: a
 * Firebase-ONLY account (no `passwordHash`) whose identity was deleted by a request
 * that then failed before the tombstone cannot re-authenticate, because the only
 * credential it has is the token the provider will no longer mint. The account is
 * then still ACTIVE with its data, and closing it needs an operator. The window is
 * two writes wide (Firebase delete, then the tombstone update); nothing in the
 * application can shrink it further without either weakening the re-authentication
 * requirement or deferring the provider delete, and both were rejected for reasons
 * this comment already gives.
 *
 * WHAT IS DELETED OUTRIGHT. Everything that holds personal content and is not part
 * of the business's inventory record: the person's sessions (all devices), their
 * password-reset tokens and reset challenges, their email-verification challenge,
 * their AI conversations and the messages inside them. Audit rows are KEPT but
 * ANONYMIZED (`userId: null`), because the trail is a governance record of the
 * business and the deletion itself must be visible in it; one `ACCOUNT_DELETED`
 * row is written with `userId: null` so the deletion does not re-introduce a
 * reference to the row it just anonymized.
 *
 * TENANT ISOLATION. Every filter below is derived from the loaded `User` document —
 * `_id`, `businessId`, `firebaseUid` — never from the request body. The caller is
 * `requireAuth`'s own `req.user.id`, so a request cannot name another account, and
 * the AI message deletion is scoped by conversation ids that were themselves
 * selected by this user.
 *
 * A BUSINESS WITH NOBODY ELSE LEFT IS CLOSED TOO (owner decision, 2026-10-24). The
 * inventory history argument above is about OTHER PEOPLE: rows are kept because
 * somebody else in the business still relies on them. When the caller is the only
 * active member AND its OWNER, there is nobody — so keeping the tenant would retain
 * personal data for no one's benefit, and, worse, would leave a person permanently
 * unable to close their account (there was no invitation or ownership-transfer path
 * to satisfy a refusal). A non-owner who is the only active member is NOT that case:
 * the business still has an owner by construction (the role rules keep one), so the
 * tenant survives with its owner. In that one case the whole tenant is removed with the account: products,
 * stock, movements, purchase orders, suppliers, locations, categories, the audit
 * trail, the assistant's history, every user row and the business row itself. THE
 * LIST OF WHAT THAT MEANS IS NOT DEFINED HERE — `tenantTeardown.service` owns it, so
 * the application and the cleanup tooling cannot drift apart.
 *
 * THE LAST-OWNER RULE, WHEN SOMEBODY REMAINS. If another active member exists, the
 * business must keep an active OWNER, so an OWNER who is the only active one is
 * refused (409 `LAST_OWNER_TRANSFER_REQUIRED`) and must transfer ownership first.
 * Another active OWNER existing is what unlocks the account-only deletion in that
 * case. Every count is scoped by `businessId` and `status: 'ACTIVE'`, so a tombstoned
 * or disabled second owner does not satisfy it.
 *
 * IDEMPOTENCY. The tombstone update is CONDITIONAL on `status: 'ACTIVE'`; when it
 * matches nothing — a concurrent or repeated request — the destructive work is not
 * repeated and the caller is told the account is deleted. A retry therefore cannot
 * delete a second Firebase identity, count a business's owners twice, or write a
 * second audit row.
 *
 * This module decides no HTTP status. The controller maps its errors, following the
 * same split the password-reset and Firebase services use.
 */

import type mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import User from '../models/user.model.ts';
import Session from '../models/session.model.ts';
import AuditLog from '../models/auditLog.model.ts';
import PasswordResetToken from '../models/passwordResetToken.model.ts';
import PasswordResetChallenge from '../models/passwordResetChallenge.model.ts';
import EmailVerificationChallenge from '../models/emailVerificationChallenge.model.ts';
import Invitation from '../models/invitation.model.ts';
import AIConversation from '../models/aiConversation.model.ts';
import AIMessage from '../models/aiMessage.model.ts';
import AiFeedback from '../models/aiFeedback.model.ts';
import { recordAudit } from './audit.service.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { deleteFirebaseUser, verifyFirebaseIdToken } from './firebase/index.ts';
import { removeTenant } from './tenantTeardown.service.ts';
import type { FirebaseTokenError, FirebaseUnavailableError, FirebaseNotConfigured } from './firebase/index.ts';
import { ApiError } from '../utils/ApiError.ts';
import {
  DELETE_CONFIRMATION_PHRASE,
  DELETED_USER_NAME,
  DELETED_EMAIL_DOMAIN,
} from '../constants/accountDeletion.ts';

/** A document id, as the models accept it. Local, following the other services. */
type IdLike = string | mongoose.Types.ObjectId;

// Re-exported so a caller that already imports this service does not need a second
// import for the values it enforces. The definitions live in constants/.
export { DELETE_CONFIRMATION_PHRASE, DELETED_USER_NAME, DELETED_EMAIL_DOMAIN };

export const LAST_OWNER_TRANSFER_REQUIRED = 'LAST_OWNER_TRANSFER_REQUIRED';
export const INVALID_CURRENT_PASSWORD = 'INVALID_CURRENT_PASSWORD';
export const FIREBASE_REAUTHENTICATION_REQUIRED = 'FIREBASE_REAUTHENTICATION_REQUIRED';
export const FIREBASE_IDENTITY_CONFLICT = 'FIREBASE_IDENTITY_CONFLICT';

export interface DeleteAccountInput {
  /** `req.user.id` — the caller, never a request-supplied id. */
  userId: string;
  /** The typed confirmation word, already trimmed by the validator. */
  confirmation: string;
  /** Present when the person re-authenticated with their password (legacy account). */
  currentPassword?: string;
  /** Present when the person re-authenticated with a Firebase ID token. */
  idToken?: string;
}

export interface DeleteAccountResult {
  deleted: true;
  /** True when this request performed the deletion; false when it was already done. */
  changed: boolean;
  /** True when a Firebase identity was removed by this request. */
  firebaseIdentityDeleted: boolean;
  /**
   * True when the caller was the business's only active member and the whole tenant
   * was removed with the account. False for an ordinary person-only deletion.
   */
  businessDeleted: boolean;
}

/**
 * Verifies the caller's re-authentication credential.
 *
 * A Firebase-linked account proves itself with a Firebase ID token, and the token's
 * uid must be the caller's own — otherwise a valid token for a DIFFERENT identity
 * could authorize deleting this one, which is the whole attack this check exists to
 * stop. A legacy account proves itself with its current password.
 *
 * Both are refused with a 400-level code rather than a 401: the caller's session is
 * valid and must not be ended by a mistyped confirmation. `FIREBASE_*` errors are
 * rethrown untouched for the controller to map as it does on every other Firebase
 * route.
 */
async function verifyReauthentication(
  user: { firebaseUid?: string | null; passwordHash?: string | null },
  input: DeleteAccountInput,
  passwordHash: string | null
): Promise<void> {
  const wantsFirebase = typeof input.idToken === 'string' && input.idToken.trim() !== '';

  if (wantsFirebase) {
    if (!user.firebaseUid) {
      // No Firebase identity is linked to this account, so no Firebase token can
      // speak for it.
      throw new ApiError(
        400,
        'This account does not sign in with Firebase. Confirm with your current password instead.',
        FIREBASE_REAUTHENTICATION_REQUIRED
      );
    }

    const identity = await verifyFirebaseIdToken(input.idToken);
    if (identity.uid !== user.firebaseUid) {
      // ONE 409 that names nothing: not the account, not the tenant, not a uid.
      throw new ApiError(
        409,
        'That sign-in does not belong to this account.',
        FIREBASE_IDENTITY_CONFLICT
      );
    }
    return;
  }

  if (user.firebaseUid && !passwordHash) {
    // A Firebase-only account has no password this server can check. Asking for an
    // ID token is the only re-authentication it has.
    throw new ApiError(
      400,
      'Confirm this deletion by signing in again.',
      FIREBASE_REAUTHENTICATION_REQUIRED
    );
  }

  if (typeof input.currentPassword !== 'string' || input.currentPassword === '') {
    throw new ApiError(400, 'Your current password is required.', 'VALIDATION_ERROR');
  }

  if (!passwordHash) {
    throw new ApiError(400, 'Your current password is incorrect.', INVALID_CURRENT_PASSWORD);
  }

  const matches = await bcrypt.compare(input.currentPassword, passwordHash);
  if (!matches) {
    throw new ApiError(400, 'Your current password is incorrect.', INVALID_CURRENT_PASSWORD);
  }
}

/** What happens to the business when this person's account goes. */
type BusinessFate = 'keep' | 'close';

/**
 * Decides whether the tenant survives the caller's deletion, and refuses the one case
 * that is neither safe nor satisfiable.
 *
 * Four outcomes, decided in this order:
 *
 *   1. the caller is not an OWNER — the person goes, the business stays (it still has
 *      its owner, which the role rules guarantee, so nothing is left unowned);
 *   2. another active OWNER exists — the person goes, the business stays with them;
 *   3. nobody else is an active member — the business goes with the person, because
 *      there is nobody left to own it and no history that concerns anybody else;
 *   4. somebody else IS an active member but is not an OWNER — refused with 409, since
 *      deleting this person would leave the business ownerless. This is the only
 *      refusal, and it is satisfiable: promote that member first.
 *
 * `$ne` against the caller's own id rather than counting and comparing: the caller is
 * an active user by the time this runs, so "another ACTIVE row exists in this business"
 * is exactly the question.
 */
async function decideBusinessFate(user: {
  _id: IdLike;
  businessId: IdLike;
  role: string;
}): Promise<BusinessFate> {
  if (user.role !== 'OWNER') return 'keep';

  const anotherOwner = await User.exists({
    _id: { $ne: user._id },
    businessId: user.businessId,
    role: 'OWNER',
    status: 'ACTIVE',
  });
  if (anotherOwner) return 'keep';

  const anotherMember = await User.exists({
    _id: { $ne: user._id },
    businessId: user.businessId,
    status: 'ACTIVE',
  });
  if (!anotherMember) return 'close';

  throw new ApiError(
    409,
    'Other people still use this business. Make another member an owner before deleting your account.',
    LAST_OWNER_TRANSFER_REQUIRED
  );
}

/**
 * Removes everything that holds the person's content or grants them access.
 *
 * Ordered from the most security-relevant to the least, and each step is scoped by
 * the loaded document's own ids. Failures here, once the tombstone is written, are
 * allowed to surface: the account is already unusable, and a retry converges
 * because the tombstone step reports `changed: false` and does not repeat the
 * Firebase delete, while these deletes are idempotent themselves.
 */
async function deleteOwnedRecords(user: {
  _id: IdLike;
  businessId: IdLike;
  email?: string | null;
  firebaseUid?: string | null;
}): Promise<void> {
  await Session.deleteMany({ userId: user._id });

  // ★ AN INVITATION TO THIS ADDRESS IS PERSONAL DATA AND A LIVE TOKEN. It holds the address
  //   in the clear and can create an account, so it must not outlive the person it names —
  //   the tombstone frees the address for reuse, and a leftover pending invitation would
  //   then be addressed to whoever takes that address next. Invitations the person SENT are
  //   deliberately left alone: they belong to the business's onboarding, name somebody
  //   else, and the `invitedBy` reference now points at a tombstone, which is fine.
  if (user.email) {
    await Invitation.deleteMany({ email: user.email });
  }
  await PasswordResetToken.deleteMany({ userId: user._id });
  await PasswordResetChallenge.deleteMany({ userId: user._id });
  await AuditLog.updateMany({ userId: user._id }, { $set: { userId: null } });

  // ★ ANONYMISING THE ACTOR IS NOT ENOUGH. `users.service.create` records a USER_CREATED row
  //   whose `metadata` holds the created person's NAME and EMAIL. Clearing `userId` leaves
  //   that row readable by every owner and admin of the business — a real deletion that still
  //   shows the deleted address in the audit viewer. Measured on 2026-10-25: the tombstone
  //   test could not see it because its own audit fixture carried no metadata.
  //
  //   Scoped twice, deliberately: `entityType: 'USER'` and `entityId: this account` mean only
  //   rows ABOUT this person are touched. Rows they merely PERFORMED carry no personal fields
  //   in metadata and are only dereferenced above; a product or supplier name is never read
  //   here, so nothing that is not this person's can be removed.
  await AuditLog.updateMany(
    { entityType: AUDIT_ENTITY_TYPES.USER, entityId: String(user._id) },
    { $unset: { 'metadata.name': '', 'metadata.email': '' } }
  );

  if (user.firebaseUid) {
    await EmailVerificationChallenge.deleteMany({ uid: user.firebaseUid });
  }

  const conversations = await AIConversation.find({ userId: user._id }).select('_id').lean();
  const conversationIds = conversations.map((row) => row._id);
  // AI-115 — a rating may carry the member's own note, so it is personal data too.
  // Delete it by author before the messages it points at, so no orphan row survives.
  await AiFeedback.deleteMany({ userId: user._id });
  if (conversationIds.length > 0) {
    await AIMessage.deleteMany({ conversationId: { $in: conversationIds } });
  }
  await AIConversation.deleteMany({ userId: user._id });
}

/**
 * Deletes the caller's own account.
 *
 * Throws `ApiError` for every refusal this layer decides (400/404/409) and the
 * Firebase domain errors for a provider failure. Never returns a tombstone-shaped
 * user: the only thing a caller may learn is that the account is gone.
 */
export async function deleteOwnAccount(input: DeleteAccountInput): Promise<DeleteAccountResult> {
  if (input.confirmation !== DELETE_CONFIRMATION_PHRASE) {
    throw new ApiError(
      400,
      `Type ${DELETE_CONFIRMATION_PHRASE} to confirm.`,
      'VALIDATION_ERROR'
    );
  }

  // `passwordHash` is `select: false`, so it is asked for explicitly — and only
  // here, where it is compared and immediately discarded.
  const user = await User.findById(input.userId).select('+passwordHash').lean();
  if (!user) {
    throw new ApiError(404, 'User not found', 'NOT_FOUND');
  }

  // Already tombstoned: answer as success without repeating any destructive work.
  if (user.status === 'DELETED') {
    return { deleted: true, changed: false, firebaseIdentityDeleted: false, businessDeleted: false };
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(403, 'This account is not active.', 'ACCOUNT_DISABLED');
  }

  await verifyReauthentication(user, input, user.passwordHash ?? null);
  const fate = await decideBusinessFate(user as { _id: IdLike; businessId: IdLike; role: string });

  // ★ FIREBASE FIRST. A deleted Inventory AI account must not remain a usable
  //   Firebase identity; see the module comment for why this precedes the write.
  let firebaseIdentityDeleted = false;
  if (user.firebaseUid) {
    const removal = await deleteFirebaseUser(user.firebaseUid);
    firebaseIdentityDeleted = removal.deleted;
  }

  // ★ THE WHOLE TENANT, WHEN NOBODY ELSE IS LEFT. Checked again here, immediately
  //   before the irreversible step: a member created between the decision above and
  //   this line means the business now has somebody to serve, so it must survive and
  //   this person's deletion has to be the ordinary account-only kind.
  if (fate === 'close') {
    const stillAlone = !(await User.exists({
      _id: { $ne: user._id },
      businessId: user.businessId,
      status: 'ACTIVE',
    }));
    if (!stillAlone) {
      throw new ApiError(
        409,
        'Other people still use this business. Make another member an owner before deleting your account.',
        LAST_OWNER_TRANSFER_REQUIRED
      );
    }

    // No tombstone and no audit row in this branch, deliberately: the collection that
    // would hold them is part of what is being removed, and a row left pointing at a
    // business that no longer exists is worse than no row. The request itself is
    // recorded by the structured access log.
    await removeTenant([user.businessId]);
    return {
      deleted: true,
      changed: true,
      firebaseIdentityDeleted,
      businessDeleted: true,
    };
  }

  const now = new Date();
  const tombstone = await User.findOneAndUpdate(
    { _id: user._id, status: 'ACTIVE' },
    {
      $set: {
        status: 'DELETED',
        deletedAt: now,
        name: DELETED_USER_NAME,
        email: `deleted+${String(user._id)}@${DELETED_EMAIL_DOMAIN}`,
        emailVerified: false,
        // Invalidates every token minted before this instant, independently of the
        // status check, so an already-issued JWT cannot outlive the deletion.
        passwordChangedAt: now,
      },
      $unset: { firebaseUid: '', passwordHash: '' },
    },
    // `returnDocument` rather than the deprecated `new: true`, which Mongoose warns
    // about on every deletion.
    { returnDocument: 'after' }
  );

  if (!tombstone) {
    // A concurrent request wrote the tombstone between the read and this update. It
    // owns the cleanup; this one only reports the outcome.
    return { deleted: true, changed: false, firebaseIdentityDeleted: false, businessDeleted: false };
  }

  await deleteOwnedRecords(
    user as {
      _id: IdLike;
      businessId: IdLike;
      email?: string | null;
      firebaseUid?: string | null;
    }
  );

  // `userId: null` ON PURPOSE: naming the caller would immediately re-point the
  // trail at the account whose identifiers this operation just removed.
  await recordAudit({
    businessId: user.businessId,
    userId: null,
    action: AUDIT_ACTIONS.ACCOUNT_DELETED,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: user._id,
    metadata: { role: user.role },
  });

  return { deleted: true, changed: true, firebaseIdentityDeleted, businessDeleted: false };
}

export type AccountDeletionFirebaseError =
  | FirebaseNotConfigured
  | FirebaseTokenError
  | FirebaseUnavailableError;

export default { deleteOwnAccount, DELETE_CONFIRMATION_PHRASE, DELETED_USER_NAME };
