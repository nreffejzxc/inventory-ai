/**
 * Phase 32H — the Firebase identity linking boundary.
 *
 * This module answers ONE question and nothing else:
 *
 *   "May THIS authenticated Inventory AI account adopt THIS verified Firebase
 *    identity?"
 *
 * It is deliberately not a provider-linking module. Firebase's own provider
 * linking (`linkWithCredential`, "Connect Google") is performed by the FIREBASE
 * CLIENT SDK, against the signed-in Firebase user, and the Inventory AI server
 * has no part in it and no API for it. What the server owns is the half the
 * client must never be trusted with: the decision that a MongoDB `User` document
 * may carry a given `firebaseUid`, and the conflict detection that stops one
 * Firebase account from silently taking over another person's tenant.
 *
 * THE TWO HALVES OF "LINKING", KEPT APART ON PURPOSE (Phase 32H §7):
 *
 *   1. Firebase credential/provider linking — moves a provider (google.com,
 *      facebook.com) onto a Firebase account. Owned by Firebase; the Firebase
 *      UID does not change; INVENTORY AI NEVER SEES IT and this module is not
 *      involved. Nothing here fakes it.
 *   2. Inventory AI identity association — records that a Firebase UID belongs
 *      to a MongoDB user. That is this module, and only this module.
 *
 * Because the Firebase UID represents the Firebase ACCOUNT rather than one
 * provider, a Firebase account holding several providers is one `firebaseUid`
 * and therefore one MongoDB user. There is no provider-specific column, no
 * provider-specific identity, and no provider-specific session or token
 * anywhere in this design — attaching a provider must never mint a second
 * Inventory AI account, and the schema is what prevents it rather than a rule.
 *
 * WHAT THE CALLER MAY NOT SAY. `userId` and `businessId` arrive as ARGUMENTS from
 * the authenticated request context (`req.user`), never from a body — the
 * controller passes them and `validateFirebaseLink` returns no field that could
 * carry them. The uid comes from `verifyFirebaseIdToken`, which narrows a token
 * Google's signature verified. So a body carrying `firebaseUid`, `userId`,
 * `businessId`, `role` or `status` is inert by construction: there is no variable
 * in this module holding a client-supplied value.
 *
 * THE OWNERSHIP PROOF IS THE SESSION, AND THE EMAIL IS NOT CONSULTED. An
 * authenticated Inventory AI session is the primary proof for an explicit
 * "Connect provider" operation (Phase 32F §14A.4), so a caller who holds one has
 * already established that they own the account being linked. The verified
 * identity's email is read for NOTHING here — not compared against the account's
 * email, not used to find the account, not used to resolve a conflict. That is
 * decision R-4/R-9 in force rather than restated: email is not an
 * account-linking join key, and a provider that supplies no address (Facebook,
 * per R-10) must link exactly as well as one that does.
 *
 * NOTHING HERE CHANGES A TENANT OR A ROLE. The only fields this module ever
 * writes are `firebaseUid` and `emailVerified`; `businessId`, `role` and `status`
 * are read for the audit row and are never assigned. A link cannot move an
 * account between businesses or promote it, because there is no code path that
 * writes either field.
 */

import type mongoose from 'mongoose';

import User from '../models/user.model.ts';
import ApiError from '../utils/ApiError.ts';
import { recordAudit } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';
import { error as logError } from '../utils/logger.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { verifyFirebaseIdToken } from './firebase/index.ts';
import { duplicateKeyField } from './firebaseAuth.service.ts';

/**
 * Local to this module, following `auth.service.ts`, `session.service.ts` and
 * `passwordReset.service.ts`: the controller passes the strings `req.user`
 * carries, and the model casts whichever arrives.
 */
type IdLike = string | mongoose.Types.ObjectId;

/** The linking operation's inputs. Both are server-derived — see the module doc. */
type LinkIdentityInput = {
  userId: IdLike;
  businessId: IdLike;
  idToken: unknown;
};

/**
 * The one code every refusal carries.
 *
 * ONE code for both conflict shapes — an identity that already belongs to another
 * account, and an account that already owns a different identity — because the
 * two are the same refusal from the caller's side and telling them apart would
 * describe a mapping they may not be entitled to see. The precise reason is
 * recorded in the audit row and the server log instead, where the reader is an
 * operator of the tenant rather than an unauthenticated caller.
 */
export const FIREBASE_IDENTITY_CONFLICT_CODE = 'FIREBASE_IDENTITY_CONFLICT';

/**
 * Deliberately generic, and deliberately not naming an account, a business, a
 * role or a Firebase UID (Phase 32H §18). A caller who owns the conflicting
 * identity learns only that some Inventory AI account already holds it; a caller
 * who does not learns nothing at all.
 */
const FIREBASE_IDENTITY_CONFLICT_MESSAGE =
  'This sign-in cannot be connected to this account. Please contact an administrator.';

/** The closed set of conflict reasons. Recorded in the audit row, never returned. */
const REASON_IDENTITY_ALREADY_OWNED = 'identity_already_owned';
const REASON_ACCOUNT_ALREADY_LINKED = 'account_already_linked';

function conflict() {
  return new ApiError(409, FIREBASE_IDENTITY_CONFLICT_MESSAGE, FIREBASE_IDENTITY_CONFLICT_CODE);
}

/**
 * Writes one linking audit row, best-effort.
 *
 * Best-effort for the reason `session.service.ts` and `passwordReset.service.ts`
 * give: on the success path the link is already durable and a failed audit write
 * cannot un-do it, so failing the request over it would be strictly worse. On the
 * CONFLICT path nothing durable happened at all, so failing a refusal over its own
 * audit row would turn a safe 409 into a 500 — the refusal is what protects the
 * account, and it must stand whether or not the trail could be written.
 *
 * `metadata` carries a `reason` and NOTHING ELSE. No Firebase UID is ever written
 * here: the audit viewer is readable by every ADMIN of the business, and when the
 * conflict is CASE B that uid identifies a person in a DIFFERENT tenant, so
 * recording it would leak a foreign identifier across the isolation boundary the
 * rest of this design is built to hold. The uid goes to the server-side log, which
 * no tenant can read.
 *
 * Deliberately NOT exported to `default` below: it is an implementation detail,
 * and `recordAudit` is the only thing that should ever write this trail.
 */
async function auditLinkEvent({
  businessId,
  userId,
  action,
  metadata,
}: {
  businessId: IdLike;
  userId: IdLike;
  action: string;
  metadata: unknown;
}) {
  try {
    await recordAudit({
      businessId,
      userId,
      action,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: userId,
      metadata,
    });
  } catch (err) {
    console.error(
      `[firebase-link] audit record failed for ${action} (the linking outcome is unaffected): ${(err as { message?: unknown }).message}`,
    );
    await monitorAuditFailure({
      businessId,
      action,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: userId,
      error: err,
    });
  }
}

/**
 * The operator's view of a refused link. Server-side only.
 *
 * The reason is a fixed string from the closed set above and the uid is an
 * identifier the operator needs to trace the collision — the same standing
 * `registerBusinessFromFirebase` gives its own `firebase_identity_collision`
 * log. No token material is in scope on any path that reaches here: the ID token
 * was consumed by the verifier and the verified identity carries no credential.
 */
function logLinkConflict({ reason, uid, businessId }: { reason: string; uid: string; businessId: IdLike }) {
  logError({
    type: 'firebase_identity_link_conflict',
    message: `[firebase-link] refused (${reason}): the verified identity (uid ${uid}) may not be attached to a user in business ${String(businessId)}`,
  });
}

/**
 * Attaches a verified Firebase identity to the authenticated Inventory AI account.
 *
 * The four lifecycle cases (Phase 32H §8) are handled in the order below, and the
 * order is load-bearing: CASE A and CASE D are decided from the ACCOUNT's own
 * `firebaseUid` before the identity is ever looked up, so an account that already
 * owns an identity can never have its own mapping queried, compared or replaced.
 *
 *   CASE A — the identity is already this account's. Idempotent: no write, no
 *            audit row (recording an event that did not happen is a false trail,
 *            the same reasoning `revokeSessionByJti` uses), and `linked: false`.
 *   CASE D — this account already owns a DIFFERENT identity. Refused. The
 *            existing mapping is never silently replaced: swapping it would hand
 *            a stranger's Firebase account the ability to sign in as this user,
 *            which is exactly the takeover this module exists to prevent.
 *            Decided BEFORE the lookup below, so this case costs no query and can
 *            never be reported as CASE B.
 *   CASE B — the identity already belongs to another MongoDB user. Refused and
 *            audited. NEVER merged, and the uid is NEVER transferred: the
 *            account it currently belongs to keeps it untouched.
 *   CASE C — the identity belongs to nobody. Attached — which is only safe
 *            because the caller has already proved they own THIS account.
 *
 * THE EMAIL IS NEVER A JOIN KEY, in any of the four. A verification whose email
 * matches the account's is not detected, preferred or treated specially; an email
 * that matches a different account is not a reason to look that account up. That
 * is what makes "no automatic linking on an address match" a property of the
 * code's shape rather than of a check someone could delete.
 *
 * Returns the account as it now stands plus whether this call changed anything.
 * `linked: false` is not a failure — it is the CASE A answer, and the caller
 * reports it as the success it is.
 */
export async function linkFirebaseIdentity({ userId, businessId, idToken }: LinkIdentityInput) {
  // The ONLY place this request's identity is established. Throws
  // FirebaseTokenError (rejected token) or FirebaseNotConfigured (no service
  // account); neither is an ApiError and the controller maps both.
  const identity = await verifyFirebaseIdToken(idToken);

  // `+passwordHash` is selected for ONE reason: the success audit row records
  // whether this account still carries a legacy password credential, because
  // that is the fact the recorded password-authority interaction turns on. The
  // hash is never read, compared, logged or returned — it is tested for presence
  // and the document stays inside this function. Selecting it here rather than in
  // a second query is what keeps the link at one read and one write.
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    // Unreachable in practice: `requireAuth` loaded this user for THIS request.
    // Handled rather than asserted because the account could have been removed
    // between the middleware and here, and a 401 is the honest answer to "there
    // is no longer an account to link to".
    throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  }

  // ---- CASE A: already this account's identity. Idempotent. ----
  if (user.firebaseUid && user.firebaseUid === identity.uid) {
    return { user, linked: false };
  }

  // ---- CASE D: this account already owns a different identity. ----
  if (user.firebaseUid) {
    await auditLinkEvent({
      businessId,
      userId: user._id,
      action: AUDIT_ACTIONS.FIREBASE_IDENTITY_LINK_CONFLICT,
      metadata: { reason: REASON_ACCOUNT_ALREADY_LINKED },
    });
    logLinkConflict({ reason: REASON_ACCOUNT_ALREADY_LINKED, uid: identity.uid, businessId });
    throw conflict();
  }

  // ---- CASE B: the identity belongs to another account. Hard conflict. ----
  // Phase 32A §7.4: "Treat as a hard error and audit it." Never merged, and the
  // uid is never moved off the account that holds it.
  const owner = await User.findOne({ firebaseUid: identity.uid }).select('_id');
  if (owner && String(owner._id) !== String(user._id)) {
    await auditLinkEvent({
      businessId,
      userId: user._id,
      action: AUDIT_ACTIONS.FIREBASE_IDENTITY_LINK_CONFLICT,
      metadata: { reason: REASON_IDENTITY_ALREADY_OWNED },
    });
    logLinkConflict({ reason: REASON_IDENTITY_ALREADY_OWNED, uid: identity.uid, businessId });
    throw conflict();
  }

  // ---- CASE C: attach. ----
  //
  // ONE conditional write, and the condition is the whole concurrency argument.
  // `firebaseUid: null` matches a document where the field is null OR absent, so
  // this update applies only if the account is STILL unlinked at the moment of
  // the write — a second link racing this one matches nothing instead of
  // replacing an identity that was set microseconds earlier. Nothing is read,
  // tested and then written: there is no window between the two.
  //
  // `emailVerified` moves with `firebaseUid`, exactly as it does in
  // `registerBusinessFromFirebase`, so the field describes the identity the
  // account actually carries rather than whatever a previous state left behind.
  // It is persisted and NOT enforced (Phase 32A §14.2) — nothing reads it to make
  // a decision, in this phase or in Phase 32.
  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { _id: user._id, firebaseUid: null },
      { $set: { firebaseUid: identity.uid, emailVerified: identity.emailVerified } },
      { returnDocument: 'after', runValidators: true }
    );
  } catch (err) {
    // The unique index on `firebaseUid` is the last line of defence behind the
    // CASE B lookup: two DIFFERENT accounts racing for one identity both pass the
    // pre-check above, and exactly one insert survives. The loser sees E11000 and
    // must read it as the same hard conflict — reporting it as anything else
    // would be the "auto-resolve a compromised mapping" behaviour §7.4 forbids.
    if (duplicateKeyField(err) === 'firebaseUid') {
      await auditLinkEvent({
        businessId,
        userId: user._id,
        action: AUDIT_ACTIONS.FIREBASE_IDENTITY_LINK_CONFLICT,
        metadata: { reason: REASON_IDENTITY_ALREADY_OWNED },
      });
      logLinkConflict({ reason: REASON_IDENTITY_ALREADY_OWNED, uid: identity.uid, businessId });
      throw conflict();
    }
    throw err;
  }

  if (!updated) {
    // The conditional write matched nothing: a concurrent request linked an
    // identity to this same account between the read above and here. Decided from
    // the fresh document rather than assumed, so the caller gets the true answer
    // — idempotent if the racer attached the same identity, a conflict if it
    // attached a different one.
    const current = await User.findById(user._id).select('+passwordHash');
    if (current?.firebaseUid === identity.uid) {
      return { user: current, linked: false };
    }
    await auditLinkEvent({
      businessId,
      userId: user._id,
      action: AUDIT_ACTIONS.FIREBASE_IDENTITY_LINK_CONFLICT,
      metadata: { reason: REASON_ACCOUNT_ALREADY_LINKED },
    });
    logLinkConflict({ reason: REASON_ACCOUNT_ALREADY_LINKED, uid: identity.uid, businessId });
    throw conflict();
  }

  await auditLinkEvent({
    businessId,
    userId: updated._id,
    action: AUDIT_ACTIONS.FIREBASE_IDENTITY_LINKED,
    // The one fact about this link worth recording beyond the event itself: this
    // account now carries a Firebase identity AND, if true, a retained legacy
    // password hash. That combination is precisely the state whose password-reset
    // / change-password disposition the specification records as OPEN and Phase
    // 32H deliberately does not decide — so the trail records when the state came
    // into existence, and an operator investigating it has a start point.
    metadata: { passwordCredentialRetained: Boolean(user.passwordHash) },
  });

  return { user: updated, linked: true };
}

export default { linkFirebaseIdentity, FIREBASE_IDENTITY_CONFLICT_CODE };
