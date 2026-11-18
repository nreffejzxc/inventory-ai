/**
 * Firebase ID-token verification (Phase 32B).
 *
 * This is the ONLY place in the server where a Firebase identity enters the
 * system, and therefore the only place a `uid` can be trusted. Everything
 * downstream — the exchange endpoint (Phase 32C), the MongoDB mapping, RBAC —
 * consumes the value this module returns and must never read a `uid`, a role or a
 * businessId from a request body.
 *
 * Two things make that guarantee hold:
 *
 *   NARROWING — the raw decoded token is never handed out. `verifyFirebaseIdToken`
 *     returns a five-field allowlisted shape, so a caller cannot accidentally
 *     depend on some other claim, and adding one becomes a deliberate edit here
 *     rather than a convenience read somewhere else. Narrowing runs on EVERY
 *     path, including the test seam (see below), which is what keeps it under
 *     test — it is security-relevant code that could otherwise only ever be
 *     exercised against a live Firebase project.
 *
 *   THE SEAM — verification is dispatched through a replaceable delegate, so the
 *     whole layer is testable with no Firebase project, no network and no
 *     credentials. This mirrors the mail provider registry
 *     (services/mail/providers/index.ts): the real implementation is the default,
 *     and a test substitutes through the same entry point production uses.
 *
 * `checkRevoked` is TRUE (Phase AUTH-01, approved target architecture §9/§10).
 * Revocation checking is a security boundary: a stale or revoked Firebase
 * credential must not be able to create a new Inventory AI session. The cost is a
 * Firebase user-record lookup per verification, which is exactly why a failure to
 * complete it is classified as TRANSIENT rather than as a rejected credential —
 * see the classification note below.
 *
 * THREE CLASSES OF OUTCOME, THREE DISTINCT ERRORS (AUTH-01). A verification
 * attempt can end in (a) a genuinely bad credential (`FirebaseTokenError`),
 * (b) a temporary inability to verify (`FirebaseUnavailableError`), or (c) the
 * server's own Firebase configuration being unusable (`FirebaseNotConfigured`).
 * The classes are derived from the installed `firebase-admin` 14.5.1 sources; see
 * `firebaseErrors.ts` for the code lists and why `auth/argument-error` is NOT
 * terminal (it is also emitted for a JWKS fetch failure).
 *
 * The real path also performs two defence-in-depth checks that the SDK already
 * performs internally, so they are belt-and-braces rather than the boundary:
 * a STRUCTURAL pre-check (a value that is not three dot-separated segments is not
 * a JWT at all) and an ENVIRONMENT assertion (the verified token's `aud`/`iss` must
 * name this project). Both live on the real Admin SDK path only; the test seam
 * substitutes a decoded payload, for which a token-shape check is meaningless.
 */

import { getAuth } from 'firebase-admin/auth';

import { firebaseConfig } from '../../config/firebase.ts';
import { getFirebaseAdminApp } from './adminApp.ts';
import {
  FirebaseNotConfigured,
  FirebaseTokenError,
  FirebaseUnavailableError,
  classifyFirebaseErrorCode,
  safeTokenReason,
} from './firebaseErrors.ts';

/**
 * The verified identity, and nothing else.
 *
 * `email` is nullable because the Firebase claim is: a phone-auth or
 * anonymous token carries no email. Both providers Phase 32 intends to offer
 * (email/password and Google) always supply one, so in practice this is non-null
 * — but the type states what the token can actually contain rather than what our
 * chosen providers happen to send, and deciding what to do about a null email is
 * the exchange endpoint's call (Phase 32C), not this layer's.
 *
 * `email` is lowercased to match the `users.email` field, which Mongoose stores
 * with `lowercase: true`. Normalizing here means the mapping cannot miss a match
 * because Google capitalized a letter.
 *
 * `authTime` is Phase 32L's addition, and it is the ONLY new claim the
 * credential-change security path needs: the credentials-changed bridge
 * (`services/credentialsChanged.service.ts`) is its live consumer, and the freshness
 * rule keyed on it is that bridge's. It is the signed `auth_time` — "when the user
 * authenticated", per Firebase's own token reference — as distinct from `iat`,
 * which is when THIS token was issued and moves on every hourly refresh. A
 * freshness rule keyed on `iat` would therefore accept an arbitrarily old
 * authentication, which is precisely the failure Phase 32L exists to avoid.
 *
 * It is surfaced as `number | null` rather than `number`. A token without a
 * usable `auth_time` is not an error here — the claim is absent from some token
 * shapes — so the field states what the token actually carried and leaves the
 * decision to the one consumer that needs it, which must treat `null` as "not
 * recent" and fail closed. Throwing instead would turn a claim-shape question
 * into a verification failure, which is a different statement to the caller.
 */
export interface VerifiedFirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  signInProvider: string | null;
  authTime: number | null;
}

/**
 * The seam a test substitutes through.
 *
 * It returns the SDK's DECODED TOKEN payload — the shape
 * `admin.auth().verifyIdToken()` resolves to — deliberately typed `unknown`,
 * because turning that into a `VerifiedFirebaseIdentity` is the security-relevant
 * step and it must run for a substituted verifier exactly as it does for the real
 * one. A delegate that returned an already-narrowed identity would take the
 * `uid`/`email`/`email_verified` handling out of test coverage entirely, and
 * nothing else in this codebase can exercise it.
 */
export type FirebaseIdTokenVerifier = (idToken: string) => Promise<unknown>;

let verifierDelegate: FirebaseIdTokenVerifier | null = null;

/**
 * Replaces the verifier. Returns the previous delegate so a test can restore it.
 * Passing null restores the real Firebase Admin implementation.
 */
export function setFirebaseIdTokenVerifier(
  delegate: FirebaseIdTokenVerifier | null
): FirebaseIdTokenVerifier | null {
  const previous = verifierDelegate;
  verifierDelegate = typeof delegate === 'function' ? delegate : null;
  return previous;
}

/** Restores the real Firebase Admin implementation. */
export function resetFirebaseIdTokenVerifier(): void {
  verifierDelegate = null;
}

export function hasCustomFirebaseIdTokenVerifier(): boolean {
  return verifierDelegate !== null;
}

/**
 * Narrows a decoded token to `VerifiedFirebaseIdentity`.
 *
 * A token with no usable `uid` is rejected rather than passed on with an empty
 * one: `uid` is the join key to the MongoDB user, so an identity without it could
 * only ever resolve to nothing, and failing here keeps that from looking like a
 * lookup miss downstream.
 *
 * `email_verified` is compared `=== true` so a missing, non-boolean or truthy
 * non-boolean claim reads as unverified. The field decides whether an account is
 * considered verified, so the failure direction must be "not verified".
 */
function toVerifiedIdentity(decoded: unknown): VerifiedFirebaseIdentity {
  const token = (decoded ?? {}) as Record<string, unknown>;

  const uid = typeof token.uid === 'string' ? token.uid.trim() : '';
  if (!uid) {
    throw new FirebaseTokenError('missing-uid');
  }

  const rawEmail = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';

  // `sign_in_provider` is nested one level down in the decoded token; both levels
  // are checked so a differently-shaped payload yields null rather than a throw.
  const firebaseClaim = (token.firebase ?? {}) as Record<string, unknown>;
  const provider =
    typeof firebaseClaim.sign_in_provider === 'string' ? firebaseClaim.sign_in_provider.trim() : '';

  // `auth_time` is a numeric Unix-seconds claim. Anything that is not a finite
  // number becomes `null` rather than a NaN or a string, so the freshness check
  // downstream has exactly one shape to reject. A string is refused deliberately:
  // coercing it would let a token shape the verifier has never seen choose a
  // number for the freshness rule.
  const rawAuthTime = token.auth_time;
  const authTime =
    typeof rawAuthTime === 'number' && Number.isFinite(rawAuthTime) ? rawAuthTime : null;

  return {
    uid,
    email: rawEmail || null,
    emailVerified: token.email_verified === true,
    signInProvider: provider || null,
    authTime,
  };
}

/**
 * The real implementation: Firebase Admin's verifier, returning the decoded token
 * for `toVerifiedIdentity` to narrow.
 *
 * Only the upstream CODE is read, and only through the allowlist in
 * firebaseErrors. The upstream message is discarded: it is produced by a library
 * that was handed the token, and relaying it is the one way a token could reach a
 * log line. The code is a fixed string, never an echo of the input.
 */
/**
 * True when `value` has the surface shape of a JWT: exactly three non-empty
 * dot-separated segments.
 *
 * This is a STRUCTURAL guard only, never a validation: it can say a value cannot
 * be a JWT, never that it is a valid one. Firebase remains the authority for
 * actual validation. It exists because `firebase-admin` 14.5.1 answers a malformed
 * value with the same overloaded `auth/argument-error` it also uses for a JWKS
 * fetch failure, so a token we can reject structurally must be rejected HERE, as
 * terminal, rather than reaching that ambiguity.
 */
export function isStructurallyJwtShaped(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Asserts the verified payload belongs to the configured Firebase project.
 *
 * `verifyIdToken` already enforces `aud`/`iss` against the app's project id, so
 * this is defence-in-depth: it makes the requirement explicit and testable as a
 * unit rather than an SDK implementation detail. A mismatch is TERMINAL — the
 * credential is for a different project, which is never a transient condition.
 */
export function assertFirebaseTokenEnvironment(decoded: unknown, projectId: string): void {
  const token = (decoded ?? {}) as Record<string, unknown>;
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (!projectId || token.aud !== projectId || token.iss !== expectedIssuer) {
    throw new FirebaseTokenError('token-environment-mismatch');
  }
}

/**
 * Turns an SDK verification failure into the correct one of our three errors.
 *
 * The class is decided by `classifyFirebaseErrorCode` (firebaseErrors.ts), which
 * defaults to `unavailable` for anything it does not recognise. `safeTokenReason`
 * is how the raw code becomes a safe label.
 */
function verificationErrorFrom(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code;
  const reason = safeTokenReason(code);
  const klass = classifyFirebaseErrorCode(code);

  if (klass === 'terminal') return new FirebaseTokenError(reason);
  if (klass === 'not-configured') {
    return new FirebaseNotConfigured(
      'Firebase authentication is not usable on this server (auth/invalid-credential).'
    );
  }
  return new FirebaseUnavailableError(reason);
}

/**
 * The real implementation: Firebase Admin's verifier, with revocation checking
 * enabled, returning the decoded token for `toVerifiedIdentity` to narrow.
 *
 * Only the upstream CODE is read, and only through the allowlist in
 * firebaseErrors. The upstream message is discarded: it is produced by a library
 * that was handed the token, and relaying it is the one way a token could reach a
 * log line. The code is a fixed string, never an echo of the input.
 */
async function verifyWithAdminSdk(idToken: string): Promise<unknown> {
  // STRUCTURAL GUARD FIRST — before the SDK is even initialized, so a value that
  // cannot be a JWT is rejected without spending a credential build, and without
  // reaching the overloaded `auth/argument-error` the SDK would answer with.
  if (!isStructurallyJwtShaped(idToken)) {
    throw new FirebaseTokenError('malformed-token');
  }

  const auth = getAuth(getFirebaseAdminApp());

  let decoded: unknown;
  try {
    // ★ checkRevoked TRUE (Phase AUTH-01).
    decoded = await auth.verifyIdToken(idToken, /* checkRevoked */ true);
  } catch (err) {
    throw verificationErrorFrom(err);
  }

  // OUTSIDE the try: the assertion throws its own terminal `FirebaseTokenError`,
  // and inside the catch it would be re-classified by its `code` (which is
  // `FIREBASE_TOKEN_INVALID`, not an SDK code) into the wrong class.
  assertFirebaseTokenEnvironment(decoded, firebaseConfig().projectId);
  return decoded;
}

/**
 * Verifies a Firebase ID token and returns the narrowed identity.
 *
 * Throws FirebaseTokenError when the token is rejected, and FirebaseNotConfigured
 * when the server has no usable Firebase service account. It never returns a
 * partial or unverified identity, and it never throws anything else — a caller
 * can handle this exhaustively without a catch-all.
 */
export async function verifyFirebaseIdToken(idToken: unknown): Promise<VerifiedFirebaseIdentity> {
  if (typeof idToken !== 'string' || idToken.trim() === '') {
    throw new FirebaseTokenError('missing-token');
  }

  const verify = verifierDelegate ?? verifyWithAdminSdk;
  return toVerifiedIdentity(await verify(idToken));
}

export default {
  verifyFirebaseIdToken,
  setFirebaseIdTokenVerifier,
  resetFirebaseIdTokenVerifier,
  hasCustomFirebaseIdTokenVerifier,
  isStructurallyJwtShaped,
  assertFirebaseTokenEnvironment,
};
