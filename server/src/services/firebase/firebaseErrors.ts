/**
 * Firebase error layer, mirroring services/mail/mailErrors.ts (Phase 32B).
 *
 * Three distinct conditions, three distinct codes (the third added by AUTH-01):
 *
 *   FIREBASE_NOT_CONFIGURED — an operator problem. No Firebase service account
 *     is configured (or the SDK reports `auth/invalid-credential`), so no ID token
 *     can be verified. Nothing was attempted.
 *   FIREBASE_TOKEN_INVALID — a caller problem. The ID token was rejected by
 *     verification: expired, revoked, the user is disabled or gone, or it is
 *     structurally not a JWT.
 *   FIREBASE_UNAVAILABLE — a TRANSIENT infrastructure problem. Verification could
 *     not be completed (network, Google-side service failure, unknown code), so
 *     the credential was neither accepted nor judged. This must never be answered
 *     as a terminal token error: a valid Inventory AI session survives it.
 *
 *   The three codes stay DISJOINT and namespaced, so a client can branch on the
 *   code rather than on a status.
 *
 * Both codes are namespaced FIREBASE_* on purpose, and deliberately share no
 * spelling with any authentication or session code (AUTH_REQUIRED, INVALID_TOKEN,
 * SESSION_REVOKED, ...). An ID token rejected here is NOT a refused session, and
 * nothing downstream may treat the two alike — in particular, a caller must never
 * let FIREBASE_* reach the client's session-loss handler, which clears a session
 * on 401/403. `isFirebaseError()` is the check that boundary uses.
 *
 * Like the mail layer, neither class carries an HTTP status. Turning one into a
 * status is the controller's job (Phase 32C), which keeps this layer free of any
 * decision about how a caller is answered.
 */

export const FIREBASE_NOT_CONFIGURED = 'FIREBASE_NOT_CONFIGURED';
export const FIREBASE_TOKEN_INVALID = 'FIREBASE_TOKEN_INVALID';
export const FIREBASE_UNAVAILABLE = 'FIREBASE_UNAVAILABLE';

export class FirebaseNotConfigured extends Error {
  declare code: string;

  constructor(message = 'Firebase is not configured on this server.') {
    super(message);
    this.name = 'FirebaseNotConfigured';
    this.code = FIREBASE_NOT_CONFIGURED;
  }
}

/**
 * A rejected Firebase ID token.
 *
 * `reason` is a coarse, ALLOWLISTED label derived from the SDK's error code, for
 * server-side logging and diagnosis. It is the only detail this error carries,
 * and it exists because the raw upstream error must not be relayed: the same
 * reasoning that makes the mail layer discard a provider's free-text message applies
 * here — an upstream error is an exfiltration surface, and the value being
 * handled is a live credential.
 *
 * The label can never carry a TOKEN. `safeTokenReason` admits only lowercase
 * letters, digits, `/`, `_` and `-`, up to 64 characters. That excludes the `.`
 * that separates a token's segments, so a whole token can never match; and any
 * real token is far past the length bound anyway, so the two barriers are
 * independent. Both are asserted in the Phase 32B suite.
 *
 * Stated precisely, because the looser version of this claim is false: a SINGLE
 * base64url segment DOES satisfy the shape rule — the allowlist excludes `.`, not
 * the base64url alphabet. That is not a credential and cannot be replayed as one
 * (a segment carries no signature), and the only call site passes an SDK error
 * code such as `auth/id-token-expired`, never a token or part of one. The
 * guarantee this class needs — that no live credential reaches a log line — holds
 * regardless.
 */
export class FirebaseTokenError extends Error {
  declare code: string;
  declare reason: string;

  constructor(reason = 'unknown', message = 'The Firebase ID token could not be verified.') {
    super(message);
    this.name = 'FirebaseTokenError';
    this.code = FIREBASE_TOKEN_INVALID;
    this.reason = reason;
  }
}

/**
 * A TRANSIENT Firebase/Google failure: the credential was not judged, because the
 * verification could not be completed. Phase AUTH-01.
 *
 * This is deliberately NOT a `FirebaseTokenError`. The two answer different
 * questions — "your credential is bad" versus "we could not reach the authority" —
 * and the target architecture (§19/§35) requires that a transient failure never
 * be presented as a terminal one: a valid Inventory AI session must survive a
 * Firebase outage rather than be signed out over it.
 *
 * It carries no HTTP status, exactly like the other two classes; the controller
 * turns it into a 503.
 */
export class FirebaseUnavailableError extends Error {
  declare code: string;
  declare reason: string;

  constructor(reason = 'unknown', message = 'Firebase could not be reached to verify this sign-in.') {
    super(message);
    this.name = 'FirebaseUnavailableError';
    this.code = FIREBASE_UNAVAILABLE;
    this.reason = reason;
  }
}

/**
 * The three ways a Firebase ID-token verification request can fail, as a closed
 * vocabulary: a rejected credential, a temporary inability to verify, or the
 * server's own Firebase configuration being unusable.
 */
export type FirebaseFailureClass = 'terminal' | 'unavailable' | 'not-configured';

/**
 * The ONLY SDK codes that mean "this credential is genuinely not acceptable".
 *
 * Derived from the installed `firebase-admin` 14.5.1 sources
 * (`lib/auth/base-auth.js`, `lib/auth/token-verifier.js`), NOT from generic
 * documentation. The list is intentionally SHORT: everything else falls through to
 * `unavailable`, because treating an unclassifiable failure as terminal is the
 * error the target architecture forbids (§19), while treating a genuinely bad
 * token as transient only delays a refusal that grants nothing.
 */
export const TERMINAL_FIREBASE_AUTH_CODES = [
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/user-disabled',
  'auth/user-not-found',
] as const;

/**
 * The SDK's own "this app has no usable credential/project" code. Kept DISTINCT
 * from generic unavailability (Phase AUTH-01) because it is an operator
 * configuration fault, not a Google outage, and an operator needs to see the two
 * apart. Mapped to `FirebaseNotConfigured` so the distinction survives to the
 * response as `FIREBASE_NOT_CONFIGURED` rather than `FIREBASE_UNAVAILABLE`.
 */
export const NOT_CONFIGURED_FIREBASE_AUTH_CODES = ['auth/invalid-credential'] as const;

/**
 * The service/transport codes we EXPECT to be transient. Listing them is
 * documentation rather than the mechanism — `classifyFirebaseErrorCode` defaults
 * to `unavailable`, so this array is not load-bearing and a new code the SDK
 * introduces is handled correctly without an edit here.
 *
 * ★ `auth/argument-error` IS IN THIS LIST ON PURPOSE AND MUST NOT BE MOVED TO
 *   `TERMINAL_FIREBASE_AUTH_CODES`. In firebase-admin 14.5.1 that code is
 *   OVERLOADED: `token-verifier.js`'s `mapJwtErrorToAuthError` falls through to
 *   `INVALID_ARGUMENT` for `JwtErrorCode.KEY_FETCH_ERROR` — a public-key (JWKS)
 *   fetch failure, i.e. a transient Google outage — so a malformed token and a
 *   JWKS outage are indistinguishable by code. A malformed token is caught 
 *   earlier and terminally by the structural guard in `tokenVerifier.ts`; what
 *   reaches this classifier as `auth/argument-error` is therefore the ambiguous
 *   remainder, and ambiguity must resolve to "do not destroy a valid session".
 */
export const TRANSIENT_FIREBASE_AUTH_CODES = [
  'auth/argument-error',
  'auth/internal-error',
  'app/network-error',
  'app/network-timeout',
  'app/internal-error',
  'auth/quota-exceeded',
  'auth/insufficient-permission',
  'auth/project-not-found',
  'auth/configuration-not-found',
  'auth/billing-not-enabled',
] as const;

/**
 * Classifies an SDK error code. Terminal codes are matched explicitly; the
 * `not-configured` code is matched explicitly; EVERYTHING ELSE — including a
 * missing, non-string or unknown/future code — is `unavailable`.
 *
 * Verified against the installed `firebase-admin` 14.5.1. If that version
 * changes, this mapping must be re-derived rather than assumed.
 */
export function classifyFirebaseErrorCode(code: unknown): FirebaseFailureClass {
  if (typeof code !== 'string') return 'unavailable';
  if ((TERMINAL_FIREBASE_AUTH_CODES as readonly string[]).includes(code)) return 'terminal';
  if ((NOT_CONFIGURED_FIREBASE_AUTH_CODES as readonly string[]).includes(code)) {
    return 'not-configured';
  }
  return 'unavailable';
}

/**
 * Coerces an upstream error code into a safe label.
 *
 * Anything that is not a short, plainly-shaped string becomes 'unknown' rather
 * than being passed through. This is the property the class comment above
 * depends on: it is not that today's codes happen to be safe, but that no code
 * which is not safely shaped can survive this function.
 */
export function safeTokenReason(raw: unknown): string {
  return typeof raw === 'string' && /^[a-z0-9/_-]{1,64}$/i.test(raw) ? raw : 'unknown';
}

/**
 * The one domain error that represents an SDK error CODE.
 *
 * This is the single place a Firebase error CLASS is chosen from an upstream code,
 * so a second Admin operation does not need a second copy of the decision. It was
 * added by AUTH-04-B2 for the `updateUser` write bridge; the token-verification
 * path deliberately keeps its own private dispatch for now, and AUTH-04-B2 does
 * not refactor it — adopting this helper there is a later, optional tidy-up.
 *
 * PURE, and it reads the code and NOTHING else. No message is inspected, nothing
 * upstream is relayed, and the label goes through `safeTokenReason`, so a value
 * that is not a short, plainly-shaped code cannot survive. `classifyFirebaseErrorCode`
 * supplies the class, whose DEFAULT is `unavailable` — an unrecognised, missing or
 * future code is treated as a transient outage rather than as a rejected
 * credential, the direction the target architecture requires (§19).
 *
 * The returned error carries no HTTP status: a controller decides that.
 */
export function firebaseErrorFromSdkCode(
  code: unknown,
  notConfiguredMessage = 'Firebase authentication is not usable on this server (auth/invalid-credential).'
): FirebaseNotConfigured | FirebaseTokenError | FirebaseUnavailableError {
  const reason = safeTokenReason(code);
  const klass = classifyFirebaseErrorCode(code);

  if (klass === 'terminal') return new FirebaseTokenError(reason);
  if (klass === 'not-configured') return new FirebaseNotConfigured(notConfiguredMessage);
  return new FirebaseUnavailableError(reason);
}

export function isFirebaseError(err: unknown): boolean {
  return (
    err instanceof FirebaseNotConfigured ||
    err instanceof FirebaseTokenError ||
    err instanceof FirebaseUnavailableError
  );
}

export default {
  FirebaseNotConfigured,
  FirebaseTokenError,
  FirebaseUnavailableError,
  FIREBASE_NOT_CONFIGURED,
  FIREBASE_TOKEN_INVALID,
  FIREBASE_UNAVAILABLE,
  TERMINAL_FIREBASE_AUTH_CODES,
  NOT_CONFIGURED_FIREBASE_AUTH_CODES,
  TRANSIENT_FIREBASE_AUTH_CODES,
  classifyFirebaseErrorCode,
  safeTokenReason,
  firebaseErrorFromSdkCode,
  isFirebaseError,
};
