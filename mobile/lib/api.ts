import { apiFetch, ApiError, REQUEST_CANCELLED, resolveRequestToken, unreachableMessage } from './client';
import type { QueryParams } from './client';
import { API_URL, AI_REQUEST_TIMEOUT_MS } from './config';
import { readSseStream, StreamIdleError } from './sse';
import type { SseEvent } from './sse';

/**
 * Typed endpoint wrappers over the backend REST API. Each function returns the
 * parsed JSON payload the server sends (pagination envelopes, DTOs, or
 * { token, user } etc.). Screens call these — they never call fetch directly.
 * All protected calls take the session `token` from auth state.
 */

/**
 * A parsed JSON response body.
 *
 * The API layer is the app's untrusted network boundary. Request shapes are
 * declared below because the app itself constructs them; response shapes are
 * deliberately NOT re-declared here. The server owns every DTO, and a second
 * copy of them in the client is exactly the kind of duplicate that drifts
 * silently — the project already rejects that pattern for the RBAC mirror
 * (lib/permissions.ts), which is pinned by a guard precisely because a mirror
 * that drifts is worse than no mirror. Screens consume responses structurally,
 * as they did before this migration, and the server remains authoritative.
 *
 * Where a response shape genuinely matters to a screen, that screen narrows it
 * at the point of use.
 */
export type ApiResponse = any;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * What DELETE /api/auth/me accepts. Exactly one re-authentication credential is sent:
 * `idToken` for an account that signs in through Firebase, `currentPassword` for a
 * legacy password account. The account deleted is the token's own, so there is no id
 * field — a client cannot express "delete somebody else".
 */
export interface DeleteAccountPayload {
  confirmation: string;
  currentPassword?: string;
  idToken?: string;
}

/**
 * DELETE /api/auth/me -> { deleted: true, changed }.
 *
 * The response deliberately carries no user object, so a caller cannot read back
 * what was stored. A refusal is a 400 (wrong word, wrong password, mismatched
 * Firebase identity), a 409 (last owner, or the identity does not match) or a 503
 * (the provider could not be reached) — never a 401, so a typo cannot end the
 * session.
 */
export function deleteAccount(token: string, payload: DeleteAccountPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/me', { token, method: 'DELETE', body: payload });
}

export interface RegisterPayload {
  /**
   * The new business's name — REQUIRED on the ordinary path.
   *
   * Optional here because an invited registration joins an existing business, and the
   * server then makes the field optional too. The legacy password route (taken only on a
   * build with no Firebase configuration) still requires it and answers a field error
   * naming it, which is the correct outcome: that route has no way to carry an invitation.
   */
  businessName?: string;
  name: string;
  email: string;
  password: string;
}

/** POST /api/auth/register -> { user, business } (201, no token issued). */
export function register({ businessName, name, email, password }: RegisterPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: { businessName, name, email, password },
  });
}

export interface LoginPayload {
  email: string;
  password: string;
  deviceLabel?: string;
}

/**
 * POST /api/auth/login -> { token, tokenType, expiresIn, user }.
 * `deviceLabel` is an optional, cosmetic hint ("Android · Pixel 7") the server
 * stores on the new session so the user can tell their devices apart; it is
 * coerced server-side and can never fail a login.
 */
export function login({ email, password, deviceLabel }: LoginPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: { email, password, deviceLabel },
  });
}

/** GET /api/auth/me -> { user }. Restores the session on app boot. */
export function me(token: string): Promise<ApiResponse> {
  return apiFetch('/api/auth/me', { token });
}

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/auth/change-password -> { message }. body: { currentPassword, newPassword }. 400 INVALID_CURRENT_PASSWORD / VALIDATION_ERROR; revokes every prior JWT (401 SESSION_INVALIDATED). */
export function changePassword(token: string, { currentPassword, newPassword }: ChangePasswordPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/change-password', {
    token,
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

/** PATCH /api/auth/me -> { user }. Updates ONLY the caller's name. 400 VALIDATION_ERROR for any other field. */
export function updateMe(token: string, { name }: { name: string }): Promise<ApiResponse> {
  return apiFetch('/api/auth/me', { token, method: 'PATCH', body: { name } });
}

export interface LogoutOptions {
  all?: boolean;
}

/**
 * POST /api/auth/logout -> { message } (Phase 26A). Ends the session this token
 * belongs to — the server identifies it from the token itself, so no session,
 * user or business is ever named by the client. Pass `{ all: true }` to sign out
 * everywhere: every session the user has open, this one included, in one call
 * (`-> { message, sessionsRevoked }`).
 *
 * Idempotent: ending an already-ended session still answers 200.
 */
export function logout(token: string, { all = false }: LogoutOptions = {}): Promise<ApiResponse> {
  return apiFetch('/api/auth/logout', {
    token,
    method: 'POST',
    body: all ? { all: true } : {},
  });
}

/**
 * GET /api/auth/sessions -> { sessions } (Phase 26A). Only the caller's own open
 * sessions, newest first. Each is
 * `{ id, current, deviceLabel, createdAt, lastUsedAt, expiresAt }` — a session id
 * the client can act on and nothing more: no token and no jti is ever sent.
 */
export function sessions(token: string): Promise<ApiResponse> {
  return apiFetch('/api/auth/sessions', { token });
}

/**
 * DELETE /api/auth/sessions/:id -> { message, id } (Phase 26A). Ends one of the
 * caller's own sessions. 404 for an unknown id and for another user's session
 * alike, so the response never reveals that someone else's session exists.
 */
export function revokeSession(token: string, id: string): Promise<ApiResponse> {
  return apiFetch(`/api/auth/sessions/${id}`, { token, method: 'DELETE' });
}

/**
 * POST /api/auth/forgot-password -> { message } (202). PUBLIC — the caller is
 * signed out by definition, so no session token is sent (and a tokenless call
 * can never trip the session-lost handler).
 *
 * The endpoint answers one identical 202 whether or not the address exists, so
 * nothing here is worth reading: callers must render their success state from a
 * fixed string rather than from this payload.
 */
export function forgotPassword(email: string): Promise<ApiResponse> {
  return apiFetch('/api/auth/forgot-password', { method: 'POST', body: { email } });
}

export interface ResetPasswordPayload {
  token: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * POST /api/auth/reset-password -> { message } (200). PUBLIC — no session token.
 *
 * The opaque reset token travels in the BODY, never in a URL, so it cannot reach
 * an access log or a Referer header; `token` here is that reset token, not a JWT.
 * `confirmPassword` is checked server-side before the token is spent, so the
 * field name must match the server's exactly or a mismatch could cost the user
 * their link. 400 INVALID_RESET_TOKEN for an unknown, expired or used token;
 * 400 VALIDATION_ERROR with `fields` when the password breaks the policy.
 */
export function resetPassword({ token, newPassword, confirmPassword }: ResetPasswordPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword, confirmPassword },
  });
}

// ---------------------------------------------------------------------------
// Password reset by emailed code (AUTH-06)
// ---------------------------------------------------------------------------
// BOTH WRAPPERS ARE SESSIONLESS BY DESIGN, like the two above: the person resetting a
// password has no usable one, which is why neither route requires auth and why neither
// wrapper passes a token.
//
// THE REQUEST WRAPPER'S OUTCOME IS NOT READ BY THE SCREEN. The server answers one 202 and
// one sentence whether or not the address exists, so rendering the body would be the one
// place the client could undo that guarantee — the screens use their own constant.
//
// The code and the new password travel in the BODY, never in a URL, so neither can reach
// an access log or a `Referer` header.

/**
 * POST /api/auth/password-reset/code -> { message } (202). PUBLIC.
 *
 * 503 `PASSWORD_RESET_CODE_NOT_CONFIGURED` when the deployment cannot run the flow (no
 * code pepper, or no mail transport).
 *
 * A RESEND INSIDE THE COOLDOWN IS ANOTHER 202, AND IT SENDS NOTHING — it is not a 429. A
 * 429 issued only when a challenge row exists would answer "this address has an account", so
 * the wait is silent by design (design §6.1). The 429 this call can still raise comes from the
 * route limiter (`PASSWORD_RESET_RATE_LIMITED`), which is the same for every address and does
 * carry `Retry-After`; the screen honours whichever number arrives.
 */
export function requestPasswordResetCode(email: string): Promise<ApiResponse> {
  return apiFetch('/api/auth/password-reset/code', { method: 'POST', body: { email } });
}

/**
 * POST /api/auth/password-reset/verify -> { message, resetToken, expiresInSeconds } (200). PUBLIC.
 *
 * STEP ONE OF TWO. A correct six-digit code buys a short-lived, single-use RESET AUTHORIZATION —
 * the only thing the server will accept as proof that a code was checked. The token is a
 * credential: it is kept in memory by `lib/passwordResetSession.ts`, never in a route param, never
 * persisted and never logged.
 *
 * 400 `INVALID_PASSWORD_RESET_CODE` for a wrong, expired, used or exhausted code — one code for
 * all four, deliberately; 400 `VALIDATION_ERROR` with `fields` when the code is not six digits;
 * 503 `PASSWORD_RESET_CODE_NOT_CONFIGURED` when the deployment cannot run the flow.
 */
export interface PasswordResetCodeVerifyPayload {
  email: string;
  code: string;
}

export interface PasswordResetCodeVerification {
  message?: string;
  /** Proof that the code was verified. Consumed by `confirmPasswordResetCode`. */
  resetToken: string;
  /** How long the authorization stays usable, in seconds. */
  expiresInSeconds: number;
}

export function verifyPasswordResetCode({
  email,
  code,
}: PasswordResetCodeVerifyPayload): Promise<PasswordResetCodeVerification> {
  return apiFetch<PasswordResetCodeVerification>('/api/auth/password-reset/verify', {
    method: 'POST',
    body: { email, code },
  });
}

export interface PasswordResetConfirmPayload {
  /** The authorization `verifyPasswordResetCode` returned. Never a code, never an address. */
  resetToken: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * POST /api/auth/password-reset/confirm -> { message } (200). PUBLIC.
 *
 * STEP TWO OF TWO, and the only route that writes the password. It carries NO code and no email:
 * the account is resolved from the authorization, so there is nothing here for a client to point
 * at a different account.
 *
 * `confirmPassword` is checked server-side BEFORE the authorization is spent, so the field name
 * must match the server's exactly or a mistyped confirmation could cost the person their
 * verification. 400 `INVALID_PASSWORD_RESET_AUTHORIZATION` for a missing, unknown, expired or
 * already-used authorization; 400 `VALIDATION_ERROR` with `fields` when the password breaks the
 * policy.
 *
 * A SUCCESSFUL RESET ISSUES NO SESSION. The server ends every existing one and the person
 * signs in with the password they just chose.
 */
export function confirmPasswordResetCode({
  resetToken,
  newPassword,
  confirmPassword,
}: PasswordResetConfirmPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { resetToken, newPassword, confirmPassword },
  });
}

// ---------------------------------------------------------------------------
// Firebase authentication (Phase 32C backend / 32E mobile)
// ---------------------------------------------------------------------------
// BOTH WRAPPERS ARE TOKENLESS, and that is structural rather than incidental.
// `lib/client.ts` reports session loss only for a request that CARRIED a token
// (`if (token && (res.status === 401 || res.status === 403))`), so a 401 or 403
// from either route here cannot reach the session-lost handler and clear a
// session that these routes never had. The caller is proving an identity with a
// Firebase credential precisely BECAUSE they hold no Inventory AI JWT yet, so
// passing one would make the endpoint able to mint only sessions that already
// exist.
//
// The response of `firebaseExchange` is byte-for-byte the shape `login` returns
// (token/tokenType/expiresIn/user), which is what lets `lib/auth.tsx` store it
// exactly as it stores a password-login token. The Firebase ID token is consumed
// server-side and is never a field of anything returned.

export interface FirebaseExchangePayload {
  /** A Firebase ID token from `lib/firebase-auth`. Consumed once, never stored. */
  idToken: string;
  /** Cosmetic device hint, exactly as `login` takes it. */
  deviceLabel?: string;
}

/**
 * POST /api/auth/firebase/exchange -> { token, tokenType, expiresIn, user } (200).
 * PUBLIC — no session token is sent.
 *
 * 403 `REGISTRATION_REQUIRED` when the verified identity has no Inventory AI
 * account yet; 403 `ACCOUNT_DISABLED` / `BUSINESS_NOT_ACTIVE`; 401
 * `FIREBASE_TOKEN_INVALID` for a token the server would not accept; 503
 * `FIREBASE_NOT_CONFIGURED` when the server has no service account.
 */
export function firebaseExchange({ idToken, deviceLabel }: FirebaseExchangePayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/firebase/exchange', {
    method: 'POST',
    body: { idToken, deviceLabel },
  });
}

export interface FirebaseRegisterPayload {
  idToken: string;
  /** Absent when an invitation supplies the business — the server makes the field optional then. */
  businessName?: string;
  name?: string;
  /**
   * The invitation being accepted, when there is one.
   *
   * It names no tenant and no role: the server resolves it, checks that the VERIFIED
   * identity's address is the invited one, and reads both from its own row. A wrong or
   * stale value can only be refused.
   */
  invitationToken?: string;
}

/**
 * POST /api/auth/firebase/register -> { user, business } (201, no token).
 * PUBLIC — no session token is sent.
 *
 * Issues no token, exactly like `register`: the caller exchanges next. 409
 * `EMAIL_IN_USE` when the verified identity's email already belongs to an
 * Inventory AI account — the server refuses to link the two rather than merging
 * them, so this is a real dead end and not a transient one.
 */
export function firebaseRegister({
  idToken,
  businessName,
  name,
  invitationToken,
}: FirebaseRegisterPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/firebase/register', {
    method: 'POST',
    // Absent keys are omitted by `JSON.stringify`, so an ordinary sign-up sends exactly
    // the body it always did.
    body: { idToken, businessName, name, invitationToken },
  });
}

// ---------------------------------------------------------------------------
// Invitations (2026-10-25)
// ---------------------------------------------------------------------------

/**
 * GET /api/auth/invitation?token=… -> { email, role, businessName, expiresAt }.
 *
 * PUBLIC, and the token travels in the QUERY STRING on purpose: the server's access log
 * records the path only, so a token in a path segment would sit in every log line. This is
 * a read — it redeems nothing, creates nothing and issues no session.
 *
 * 404 `INVITATION_INVALID` for unknown, expired, revoked or already-accepted alike, so the
 * client cannot tell those apart and neither can a caller probing for live links.
 */
export function previewInvitation(token: string): Promise<ApiResponse> {
  return apiFetch('/api/auth/invitation', { params: { token } });
}

/** The invitation management surface — OWNER/ADMIN (`users.manage`), never a client id. */
export const invitationsApi = {
  /** Live (unexpired, pending) invitations for the caller's business. */
  list: (token: string): Promise<ApiResponse> => apiFetch('/api/invitations', { token }),
  /** Invite an address at ADMIN/MANAGER/STAFF. 201; 409 already a member; 400 bad role. */
  create: (token: string, payload: { email: string; role: string }): Promise<ApiResponse> =>
    apiFetch('/api/invitations', { token, method: 'POST', body: payload }),
  /** Withdraw a pending invitation. 204. */
  revoke: (token: string, id: string): Promise<void> =>
    apiFetch(`/api/invitations/${id}`, { token, method: 'DELETE' }),
};

/**
 * AUTH-04-F — the custom 6-digit email-verification code flow. Both endpoints are
 * PRE-SESSION and Firebase-AUTHENTICATED, so neither sends an Inventory AI token:
 * the caller holds a Firebase ID token and no session at all, precisely because the
 * identity is not verified yet. `lib/client.ts` reports session loss only for a
 * request that CARRIED a token, so neither route here can be mistaken for a dead
 * session — the same reasoning `firebaseExchange`/`firebaseRegister` already carry.
 *
 * The Firebase ID token is consumed once, server-side, and is never stored.
 */
export interface EmailVerificationRequestPayload {
  /** A Firebase ID token from `lib/firebase-auth`. Consumed once, never stored. */
  idToken: string;
}

/**
 * POST /api/auth/email-verification/request -> { message } (200). PUBLIC — no session.
 *
 * Mints a six-digit code for the identity the token proves and emails it. Answers the
 * SAME `{ message }` for an already-verified identity (a no-op) — the caller never
 * learns which happened.
 *
 * 429 `EMAIL_VERIFICATION_RATE_LIMITED` carries a `Retry-After` header, which is both
 * the 60-second resend cooldown and the AD-19 per-IP limiter; 503
 * `EMAIL_VERIFICATION_NOT_CONFIGURED` / `EMAIL_VERIFICATION_MAIL_FAILED`; 400
 * `FIREBASE_TOKEN_INVALID` (a bad provider credential, deliberately NOT a 401).
 */
export function requestEmailVerification({
  idToken,
}: EmailVerificationRequestPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/email-verification/request', {
    method: 'POST',
    body: { idToken },
  });
}

export interface EmailVerificationConfirmPayload {
  /** A Firebase ID token from `lib/firebase-auth`. Consumed once, never stored. */
  idToken: string;
  /** The six-digit code the person was emailed. Never persisted by this app. */
  code: string;
}

/**
 * POST /api/auth/email-verification/confirm -> { message } (200). PUBLIC — no session.
 *
 * Verifies a submitted code and, only on success, sets Firebase's `emailVerified`
 * through the Admin bridge. A wrong, expired, exhausted, absent or already-used code
 * answers ONE indistinguishable 400 `INVALID_VERIFICATION_CODE`.
 *
 * 429 `EMAIL_VERIFICATION_RATE_LIMITED`; 503 `EMAIL_VERIFICATION_NOT_CONFIGURED`; 400
 * `VALIDATION_ERROR` with a `code` field problem for a missing/oversized value; 400
 * `FIREBASE_TOKEN_INVALID` for a bad provider credential. It issues NO session — the
 * Inventory AI JWT is still minted only by `firebaseExchange`.
 */
export function confirmEmailVerification({
  idToken,
  code,
}: EmailVerificationConfirmPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/email-verification/confirm', {
    method: 'POST',
    body: { idToken, code },
  });
}

export interface FirebaseLinkPayload {
  /** A Firebase ID token from `lib/firebase-auth`. Consumed once, never stored. */
  idToken: string;
}

/**
 * POST /api/auth/firebase/link -> { linked, user } (200, Phase 32H).
 * AUTHENTICATED — the caller's own session token is required.
 *
 * Records that the CALLER'S OWN account carries the identity the verified ID token
 * names. It is the explicit "connect a provider" operation, and the only way a
 * `firebaseUid` is ever attached to an existing account.
 *
 * THE ACCOUNT AND THE IDENTITY ARE BOTH SERVER-DERIVED, so the body below is the
 * WHOLE request: no id, uid, businessId or role is sent, and the server reads none
 * of them anyway. The caller's session is the ownership proof; the token is the
 * identity. Nothing here compares an email address to anything.
 *
 * `linked: false` is a SUCCESS, not a refusal — it is the idempotent answer when the
 * account already carries this identity. Every real refusal throws:
 *
 *   409 `FIREBASE_IDENTITY_CONFLICT` — the identity belongs to another account, or
 *       this account already carries a different one. One deliberately generic
 *       message covers both, so a screen relays it rather than explaining it.
 *   400 `FIREBASE_TOKEN_INVALID` — a bad provider credential. A 400 here is a bad
 *       REQUEST FIELD, not a dead session; the server moved it off 401 for exactly
 *       that reason, and `lib/client.ts` reports session loss only for 401/403, so
 *       this cannot sign the caller out.
 *   403 `BUSINESS_NOT_ACTIVE` / 503 `FIREBASE_NOT_CONFIGURED` — as on the other
 *       Firebase routes.
 */
export function firebaseLink(token: string, { idToken }: FirebaseLinkPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/firebase/link', {
    token,
    method: 'POST',
    body: { idToken },
  });
}

/**
 * The Firebase-unlink API wrapper was REMOVED in Phase A (F-1), together with the
 * `POST /api/auth/firebase/unlink` route it called.
 *
 * THE CAPABILITY IS GONE, NOT DISABLED: an account may no longer detach its Firebase
 * identity, so there is no endpoint left for a client to reach and nothing for a
 * wrapper to send. What replaced it is `changeFirebasePassword` in `lib/auth.tsx`,
 * which changes the credential Firebase owns rather than removing the identity
 * `firebaseUid` names. The removal is recorded here rather than composed silently
 * into a smaller diff, because a reader looking for the unlink call must be able to
 * find out where it went.
 */
export interface FirebaseCredentialsChangedPayload {
  /**
   * A Firebase ID token from the ACTUAL password sign-in that just happened, so its
   * signed `auth_time` is within the server's 300 s freshness window. A refreshed
   * token (`getIdToken(true)`) moves `iat` and leaves `auth_time` alone, so it is not
   * a substitute and the server refuses it — deliberately.
   */
  idToken: string;
}

/**
 * POST /api/auth/credentials-changed -> { changedAt } (200, N-4).
 *
 * Records that Firebase changed this account's password, so every Inventory AI session
 * minted against the previous one is revoked. It is the server half of the approved
 * recovery sequence and it is AUTHENTICATED: `token` here is the TEMPORARY session the
 * public exchange just minted for the recovery, not the app's session — the bridge
 * revokes every session including that one, and the caller then exchanges once more for
 * the session it actually keeps.
 *
 * `temporarySession: true` is set for exactly that reason: the caller is deliberately
 * holding a token that is not the app's session, so a 401 from this request must not be
 * reported as session loss — that report ends the durable Firebase session, which would
 * destroy the sign-in the recovery still needs. `lib/client.ts` carries the full argument.
 *
 * EXPECTED ANSWERS, and what each means to the caller:
 *
 *   200 — recorded. The revocation happened (or happened already; the operation is
 *         idempotent). Clear the recovery marker and take the final session.
 *   401 `SESSION_INVALIDATED` — the SUCCESS-EQUIVALENT answer: this exact revocation
 *         already happened, which is why the temporary token is no longer valid. Treat it
 *         as the 200 above. Other 401 codes mean the temporary session died for an
 *         unrelated reason; the revocation is still owed, so the marker stays.
 *   409 `FIREBASE_REAUTHENTICATION_REQUIRED` — the Firebase authentication is older than
 *         the 300 s window. The revocation is still owed, so the marker stays and the next
 *         sign-in retries.
 *   409 `FIREBASE_IDENTITY_CONFLICT` — the verified identity is not this account's, or the
 *         account carries none. TERMINAL, and the marker stays: a mismatch must never
 *         consume it.
 *   400 `FIREBASE_TOKEN_INVALID` — Firebase refused the token; a bad request field rather
 *         than a dead session, which is why the server keeps it off 401 here too.
 *   403 `ACCOUNT_DISABLED` / `BUSINESS_NOT_ACTIVE`, 503 `FIREBASE_NOT_CONFIGURED` —
 *         unchanged, and all of them leave the marker in place.
 */
export function credentialsChanged(
  { idToken }: FirebaseCredentialsChangedPayload,
  token: string
): Promise<ApiResponse> {
  return apiFetch('/api/auth/credentials-changed', {
    token,
    method: 'POST',
    temporarySession: true,
    body: { idToken },
  });
}

/**
 * POST /api/auth/renew -> { token, tokenType, expiresIn, tokenExpiresAt,
 * sessionExpiresAt, user } (200, AUTH-03). AUTHENTICATED — the caller's own
 * session token is required.
 *
 * Re-issues an access token for the CALLER'S OWN existing session: the server
 * keeps the same `jti`, reuses the same session row, and NEVER extends its 14-day
 * cap. The body carries only `{ idToken }`; the account is the session and the
 * identity is the verified token's uid, so no id, uid, businessId or role is sent
 * and none is read. The response restates login's shape plus the two absolute
 * instants, whose MINIMUM is the client's true authentication horizon.
 *
 * `temporarySession: true` — see the note on the call itself. It is NOT the N-4
 * "not the app's own session" case (this request DOES carry the app's own token); the
 * flag is set because the renewal must not run the transport's own renewal/recovery
 * hooks, and because `performRenewal` already applies this response's classification.
 * The refusals below are therefore handled by the caller, not by the generic path.
 * The server answers a rejected
 * Firebase credential as 400 (a bad request field), a uid mismatch as 409
 * `FIREBASE_IDENTITY_CONFLICT`, an unverified identity as 400 `EMAIL_NOT_VERIFIED`,
 * a spent/revoked session as 401 `SESSION_REVOKED`, and a throttled caller as 429
 * `SESSION_RENEW_RATE_LIMITED` — the last of which is TRANSIENT and must preserve
 * the still-valid session rather than be read as session loss.
 */
export function renew(token: string, { idToken }: FirebaseLinkPayload): Promise<ApiResponse> {
  return apiFetch('/api/auth/renew', {
    token,
    method: 'POST',
    // AUTH-03 FIX — `temporarySession: true`, FOR THE OPPOSITE REASON TO THE N-4
    // OPT-OUT ABOVE. The renewal request is ISSUED BY `performRenewal`, which is
    // itself the implementation of the transport's proactive/recovery hooks. Those
    // hooks are `await`ed before EVERY request that carries a token, so without this
    // flag the renewal would re-enter them, `renewIfDue` would resolve to the SAME
    // in-flight promise `performRenewal` is already awaiting, and the two would wait
    // on each other forever — a self-deadlock that settled nothing, threw nothing and
    // never cleared `renewalPromiseRef`, wedging every later request too.
    //
    // Suppressing the hooks here is correct on its own terms as well, not just to
    // break the cycle: `performRenewal` already classifies this response itself
    // (terminal codes end the session through `clearSession`; a 429 or a transient
    // failure preserves it and backs off). Letting the generic path ALSO act on it
    // would apply that decision twice, and its session-loss report would clear the
    // very session the recovery branch exists to preserve.
    temporarySession: true,
    body: { idToken },
  });
}

// ---------------------------------------------------------------------------
// Users (Phase 14A backend / 14B mobile)
// ---------------------------------------------------------------------------
// OWNER/ADMIN only (users.manage). Create/assign never includes OWNER; the
// server enforces no-self-change, OWNER immutability, and ADMIN<->ADMIN rules.

/** A user create/update body. The server validates every field. */
export interface UserInput {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  status?: string;
}

export const usersApi = {
  /** Paginated { items, page, limit, total, totalPages }. params: { q (name/email), status (ACTIVE|DISABLED), page, limit }. */
  list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/users', { token, params }),
  /** One business user (public shape: id, name, email, role, status, createdAt). */
  get: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/users/${id}`, { token }),
  /** Create ADMIN/MANAGER/STAFF. body: { name, email, password, role }. 409 EMAIL_IN_USE; 400 field problems. */
  create: (token: string, payload: UserInput): Promise<ApiResponse> =>
    apiFetch('/api/users', { token, method: 'POST', body: payload }),
  /** Change role and/or status — body has >=1 of { role, status }. */
  update: (token: string, id: string, payload: UserInput): Promise<ApiResponse> =>
    apiFetch(`/api/users/${id}`, { token, method: 'PATCH', body: payload }),
};

// ---------------------------------------------------------------------------
// Reference resources: categories & locations (shared CRUD + archive shape)
// ---------------------------------------------------------------------------

/**
 * A reference create/update body. The index signature carries the optional
 * extra writable columns a reference group declares (e.g. supplier
 * contactName/phone/email); `null` is accepted because callers build these
 * objects from form state, where a cleared field is often null.
 */
export interface ReferencePayload {
  name?: string;
  description?: string;
  [field: string]: string | null | undefined;
}

/**
 * Factory for the shared reference CRUD shape (categories, locations,
 * suppliers). `fields` are optional extra writable columns (e.g. supplier
 * contactName/phone/email) forwarded verbatim on create/update — blank/absent
 * values are dropped, keeping categories/locations (fields: []) unchanged.
 */
function referenceGroup(path: string, { fields = [] }: { fields?: string[] } = {}) {
  // Forward extra writable columns (e.g. supplier contact fields). Blanks are
  // dropped on create so nothing empty is stored; on update an empty string is
  // kept so the server clears a previously-set value (its PATCH applies any
  // field that differs from the stored one).
  const bodyWithExtras = (
    base: ReferencePayload,
    extras: ReferencePayload,
    { keepEmpty = false }: { keepEmpty?: boolean } = {},
  ): ReferencePayload => {
    const out: ReferencePayload = { ...base };
    for (const f of fields) {
      const raw = extras[f];
      if (raw === undefined || raw === null) continue;
      const v = String(raw);
      if (v === '' && !keepEmpty) continue;
      out[f] = v;
    }
    return out;
  };
  return {
    list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch(`${path}`, { token, params }),
    get: (token: string, id: string): Promise<ApiResponse> => apiFetch(`${path}/${id}`, { token }),
    create: (token: string, { name, description, ...extras }: ReferencePayload): Promise<ApiResponse> =>
      apiFetch(`${path}`, { token, method: 'POST', body: bodyWithExtras({ name, description }, extras) }),
    update: (token: string, id: string, { name, description, ...extras }: ReferencePayload): Promise<ApiResponse> =>
      apiFetch(`${path}/${id}`, { token, method: 'PATCH', body: bodyWithExtras({ name, description }, extras, { keepEmpty: true }) }),
    archive: (token: string, id: string): Promise<ApiResponse> => apiFetch(`${path}/${id}/archive`, { token, method: 'POST' }),
    restore: (token: string, id: string): Promise<ApiResponse> => apiFetch(`${path}/${id}/restore`, { token, method: 'POST' }),
  };
}

export const categoriesApi = referenceGroup('/api/categories');
export const locationsApi = referenceGroup('/api/locations');

// ---------------------------------------------------------------------------
// Suppliers (Phase 13A backend / 17 mobile)
// ---------------------------------------------------------------------------
// Writable by OWNER/ADMIN/MANAGER (suppliers.manage); viewable by every role
// (suppliers.view). Contact fields join the shared CRUD via `fields`.

export const suppliersApi = referenceGroup('/api/suppliers', {
  fields: ['contactName', 'phone', 'email'],
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * A product create/update body assembled by ProductForm. Field names are the
 * server's own DTO names — `costPrice` / `sellingPrice` / `minimumStock`, not
 * `cost` / `price` / `minimumQuantity` — because the body is sent verbatim.
 */
export interface ProductInput {
  name?: string;
  sku?: string;
  barcode?: string;
  categoryId?: string;
  description?: string;
  unit?: string;
  costPrice?: number | null;
  sellingPrice?: number | null;
  minimumStock?: number | null;
  imageUrl?: string;
}

export const productsApi = {
  /** Paginated { items, page, limit, total, totalPages }. */
  list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/products', { token, params }),
  /** Products needing restock (available ≤ minimum, worst first, each flagged OUT_OF_STOCK/LOW_STOCK). */
  reorder: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/products/reorder', { token, params }),
  get: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/products/${id}`, { token }),
  /** Look up one product by its exact barcode (business-scoped). 404 when unknown. */
  barcode: (token: string, barcode: string): Promise<ApiResponse> =>
    apiFetch('/api/products/barcode', { token, params: { barcode } }),
  create: (token: string, payload: ProductInput): Promise<ApiResponse> =>
    apiFetch('/api/products', { token, method: 'POST', body: payload }),
  update: (token: string, id: string, payload: ProductInput): Promise<ApiResponse> =>
    apiFetch(`/api/products/${id}`, { token, method: 'PATCH', body: payload }),
  archive: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/products/${id}/archive`, { token, method: 'POST' }),
  restore: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/products/${id}/restore`, { token, method: 'POST' }),
  /**
   * Issue an internal EAN-13 barcode for a product that has none (Phase 12D).
   * Returns the updated product DTO. PRODUCTS_MANAGE; 409 if the product already
   * has a barcode or is archived. Never overwrites an existing code.
   */
  generateBarcode: (token: string, id: string): Promise<ApiResponse> =>
    apiFetch(`/api/products/${id}/generate-barcode`, { token, method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** A stock-in / stock-out / adjust body, assembled by MovementForm. */
export interface MovementInput {
  productId: string;
  locationId: string;
  quantity: number | string;
  reason?: string;
  reference?: string;
}

/** A two-location transfer body (Phase 19), assembled by TransferForm. */
export interface TransferInput {
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number | string;
  reason?: string;
  reference?: string;
}

export const inventoryApi = {
  /** Inventory rows (paginated), each with authoritative quantity/available/status. */
  list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/inventory', { token, params }),
  get: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/inventory/${id}`, { token }),
  /**
   * Apply stock in. `idempotencyKey` names the operation attempt (see
   * `lib/idempotency.ts`): a retried delivery carrying the same key returns the
   * first delivery's answer instead of adding the stock twice.
   */
  stockIn: (token: string, { productId, locationId, quantity, reason, reference }: MovementInput, idempotencyKey?: string): Promise<ApiResponse> =>
    apiFetch('/api/inventory/stock-in', {
      token,
      method: 'POST',
      body: { productId, locationId, quantity, reason, reference },
      idempotencyKey,
    }),
  /** Apply stock out. Same idempotency contract as `stockIn`. */
  stockOut: (token: string, { productId, locationId, quantity, reason, reference }: MovementInput, idempotencyKey?: string): Promise<ApiResponse> =>
    apiFetch('/api/inventory/stock-out', {
      token,
      method: 'POST',
      body: { productId, locationId, quantity, reason, reference },
      idempotencyKey,
    }),
  /** quantity here is the absolute target (may be 0). MANAGER+ only. */
  adjust: (token: string, { productId, locationId, quantity, reason, reference }: MovementInput, idempotencyKey?: string): Promise<ApiResponse> =>
    apiFetch('/api/inventory/adjust', {
      token,
      method: 'POST',
      body: { productId, locationId, quantity, reason, reference },
      idempotencyKey,
    }),
  /** Transaction history, newest first (filters: productId, locationId, type, from, to). */
  history: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/inventory/history', { token, params }),
  /**
   * Move stock between two locations (Phase 19). MANAGER+ only.
   * 201 -> { reference, transaction, destinationTransaction, previousQuantity,
   * newQuantity, destinationPreviousQuantity, destinationNewQuantity }.
   * 409 TRANSFER_SAME_LOCATION / INSUFFICIENT_STOCK; 404 INVENTORY_NOT_FOUND;
   * 400 field problems (productId, fromLocationId, toLocationId, quantity).
   */
  transfer: (
    token: string,
    { productId, fromLocationId, toLocationId, quantity, reason, reference }: TransferInput,
    idempotencyKey?: string,
  ): Promise<ApiResponse> =>
    apiFetch('/api/inventory/transfer', {
      token,
      method: 'POST',
      body: { productId, fromLocationId, toLocationId, quantity, reason, reference },
      idempotencyKey,
    }),
};

// ---------------------------------------------------------------------------
// Purchase orders (Phase 13A–13C backend / 13D read+receive / 17 manage)
// ---------------------------------------------------------------------------
// Manage (create/update/issue/cancel) requires purchase-orders.manage
// (OWNER/ADMIN/MANAGER). Read + receive are open to every role.

/** One line of a PO create/edit body. */
export interface PurchaseOrderLineInput {
  productId: string;
  quantityOrdered?: number | string;
  unitCost?: number | string | null;
  [field: string]: unknown;
}

/** A PO create/edit body assembled by PoForm. */
export interface PurchaseOrderInput {
  supplierId?: string | null;
  locationId?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  items?: PurchaseOrderLineInput[];
  [field: string]: unknown;
}

/** A claim-first receive body (Phase 13C), assembled by the receive screen. */
export interface ReceiveInput {
  lines: { productId: string; quantity: number }[];
  reference?: string;
}

export const purchaseOrdersApi = {
  /** Paginated PO headers { items, total, ... }. params: { status, q (number), page, limit }. */
  list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/purchase-orders', { token, params }),
  /** Full detail: header + items + receipts + pendingClaims. */
  get: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/purchase-orders/${id}`, { token }),
  /**
   * Create a DRAFT. body: { supplierId, locationId, expectedAt?, notes?,
   * items: [{ productId, quantityOrdered, unitCost? }] }. 201 -> detail DTO.
   * 409 SUPPLIER_ARCHIVED / PO_NUMBER_CONFLICT; 400 field problems.
   */
  create: (token: string, payload: PurchaseOrderInput, idempotencyKey?: string): Promise<ApiResponse> =>
    apiFetch('/api/purchase-orders', { token, method: 'POST', body: payload, idempotencyKey }),
  /**
   * Edit a DRAFT only (PATCH). Any supplied reference is re-verified; a
   * supplied `items` array replaces the full line set. 409 PO_NOT_DRAFT /
   * PO_STATE_CONFLICT.
   */
  update: (token: string, id: string, payload: PurchaseOrderInput): Promise<ApiResponse> =>
    apiFetch(`/api/purchase-orders/${id}`, { token, method: 'PATCH', body: payload }),
  /** Issue a DRAFT -> OPEN. 409 PO_ALREADY_OPEN / PO_CANCELED / PO_ALREADY_RECEIVED. */
  issue: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/purchase-orders/${id}/issue`, { token, method: 'POST' }),
  /** Cancel a DRAFT or OPEN order -> CANCELED. 409 PO_ALREADY_CANCELED / PO_ALREADY_RECEIVED. */
  cancel: (token: string, id: string): Promise<ApiResponse> => apiFetch(`/api/purchase-orders/${id}/cancel`, { token, method: 'POST' }),
  /**
   * Claim-first receive (Phase 13C) against an OPEN order. body:
   * { lines: [{ productId, quantity }], reference? }. 200 -> { allReceived,
   * applied, po } (the fresh detail). 409 RECEIVE_CONFLICT carries `applied`
   * with the lines that landed — see ApiError.applied.
   */
  receive: (token: string, id: string, { lines, reference }: ReceiveInput, idempotencyKey?: string): Promise<ApiResponse> =>
    apiFetch(`/api/purchase-orders/${id}/receive`, {
      token,
      method: 'POST',
      body: { lines, reference: reference?.trim() || undefined },
      idempotencyKey,
    }),
};

// ---------------------------------------------------------------------------
// Audit trail (Phase 16)
// ---------------------------------------------------------------------------
// Read-only record of every recorded action, newest first. OWNER/ADMIN only
// (audit.view). Filters: action, entityType, userId, from, to, q.

export const auditApi = {
  /** Paginated { items, page, limit, total, totalPages }. */
  list: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/audit', { token, params }),
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const dashboardApi = {
  summary: (token: string): Promise<ApiResponse> => apiFetch('/api/dashboard', { token }),
};

// ---------------------------------------------------------------------------
// AI Assistant (Phase 06)
// ---------------------------------------------------------------------------
// Read-only assistant over inventory tools. Conversations and messages are
// scoped server-side to the signed-in user's business. Chat returns a 503
// (AI_NOT_CONFIGURED) when the backend has no provider enabled — the UI maps
// that onto a friendly "ask an administrator" message.

/**
 * The phone's IANA time zone, if the runtime can name one.
 *
 * WHY IT IS SENT. The assistant has no device to format with, so without this the
 * server answers in UTC: a member in Manila asking at 07:00 about "today" gets the
 * previous UTC day, and every quoted time is eight hours wrong. The server treats
 * it as a display hint only (unknown -> UTC), so a missing or odd value cannot
 * fail the turn.
 */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export const aiApi = {
  /** The user's conversations, newest first (paginated). */
  conversations: (token: string, params?: QueryParams): Promise<ApiResponse> => apiFetch('/api/ai/conversations', { token, params }),
  /** Start a (possibly empty) conversation with an optional title. */
  createConversation: (token: string, { title }: { title?: string } = {}): Promise<ApiResponse> =>
    apiFetch('/api/ai/conversations', { token, method: 'POST', body: { title } }),
  /** Messages in one conversation, oldest first (paginated). */
  messages: (token: string, id: string, params?: QueryParams): Promise<ApiResponse> =>
    apiFetch(`/api/ai/conversations/${id}/messages`, { token, params }),
  /**
   * Run one user message through the assistant. Omit conversationId to start a
   * new conversation (title is derived from the first message). Returns
   * { conversation, userMessage, assistantMessage }.
   *
   * AI-1 — the one route that opts out of the global 15 s budget. The server
   * allows a whole turn up to AI_TURN_DEADLINE_MS (60 s) because the model may
   * need several tool rounds, so a 15 s client abort killed answers the server
   * was still producing and then blamed the network (ISS-21).
   *
   * AI-9 — the one route whose caller may also STOP it. The signal is passed
   * straight through to the transport, which reports that abort as its own code
   * (`REQUEST_CANCELLED`) rather than as a timeout, so the screen can tell "the
   * member stopped" from "we gave up waiting". The server sees the closed
   * connection and ends the turn (`499 AI_ABANDONED`) instead of running it to
   * its deadline, so a stopped turn stops costing a model call.
   */
  chat: (
    token: string,
    { conversationId, message }: { conversationId?: string | null; message: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResponse> =>
    apiFetch('/api/ai/chat', {
      token,
      method: 'POST',
      body: { conversationId, message, timeZone: deviceTimeZone() },
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    }),

  /**
   * AI-40 — the same turn, streamed: text arrives through `onDelta` while it is being written,
   * and the resolved value is the SAME `{ conversation, userMessage, assistantMessage }` payload
   * the ordinary `chat` call returns.
   *
   * WHY IT DOES NOT GO THROUGH `apiFetch`. That client parses one JSON body and owns retry,
   * renewal and timeout in one place; a streaming body is consumed incrementally and cannot be
   * handed to `res.json()`. Everything that must behave identically — the refreshed token, the
   * turn's own budget, cancellation, the error envelope — is done here explicitly, against the
   * same constants, rather than being reimplemented by the caller.
   *
   * `expo/fetch` is imported lazily: it is a native streaming implementation, and the rest of
   * the app has no reason to load it (or its module) on every launch.
   */
  chatStream: async (
    token: string,
    { conversationId, message }: { conversationId?: string | null; message: string },
    options: {
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      /**
       * AI-40 — the streaming transport, injectable for the same reason `readModelHealth` takes
       * a `fetchImpl`: the failure this path must survive (a body that never settles) cannot be
       * produced by the real implementation on demand, so the only way to pin the recovery is to
       * hand it a fake. Production passes nothing and gets `expo/fetch`, lazily.
       */
      fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<StreamedResponse>;
    } = {},
  ): Promise<ApiResponse> => {
    const effectiveToken = await resolveRequestToken(token);
    const controller = new AbortController();
    let abortCause: 'timeout' | 'caller' | null = null;
    const timer = setTimeout(() => {
      abortCause = 'timeout';
      controller.abort();
    }, AI_REQUEST_TIMEOUT_MS);
    const callerSignal = options.signal ?? null;
    const onCallerAbort = () => {
      abortCause = 'caller';
      controller.abort();
    };
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort);
    }
    const release = (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };

    try {
      const streamingFetch = options.fetchImpl ?? (await import('expo/fetch')).fetch;
      const res = await streamingFetch(`${API_URL}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${effectiveToken ?? ''}`,
        },
        body: JSON.stringify({ conversationId, message, timeZone: deviceTimeZone() }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // The server refused before streaming (validation, auth, rate limit, not configured).
        // Its body is the ordinary error envelope, so the same ApiError reaches the screen and
        // every existing message mapping keeps working unchanged.
        const raw = await res.text().catch(() => '');
        let body: { error?: string; code?: string; fields?: { field: string; message: string }[] } = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        throw new ApiError(res.status, body.code ?? null, body.error || 'Your message could not be sent.', body.fields ?? []);
      }

      const stream = res.body;
      if (!stream) {
        // No body, and a body that ended before its `done` event, are both the same fact to the
        // caller: the connection did not deliver the answer. `status: 0` is the transport class
        // the rest of the client already uses (and the one the screen may retry over JSON).
        throw new ApiError(0, 'NETWORK_ERROR', 'The assistant could not start streaming.');
      }

      let done: ApiResponse = null;
      let failure: { status?: number; code?: string | null; message?: string } | null = null;

      /**
       * AI-40 — the budget must settle the CALL even if the body never delivers another byte.
       *
       * Measured on the phone, 2026-10-23: a stream cut after its headers left `reader.read()`
       * parked forever, so the 75 s timeout aborted a request whose promise never rejected and the
       * screen stayed on its spinner — no answer, no sentence, no way out but killing the app.
       * The read is therefore raced against the abort itself, and the loser is silenced so it
       * cannot surface as an unhandled rejection later.
       */
      const reading = readSseStream(stream, (event: SseEvent) => {
        if (event.event === 'delta') {
          const parsed = safeJson(event.data);
          const text = parsed && typeof parsed.text === 'string' ? parsed.text : '';
          if (text) options.onDelta?.(text);
          return;
        }
        if (event.event === 'done') {
          done = safeJson(event.data);
          return;
        }
        if (event.event === 'error') {
          failure = safeJson(event.data) ?? {};
        }
      }, controller.signal);
      reading.catch(() => {
        // The abort won the race; whatever the read does next is not the caller's business.
      });
      await Promise.race([
        reading,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error('stream aborted'));
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);

      if (failure) {
        const f = failure as { status?: number; code?: string | null; message?: string };
        throw new ApiError(
          typeof f.status === 'number' ? f.status : 0,
          f.code ?? 'AI_UNAVAILABLE',
          f.message || 'The assistant could not answer. Please try again.',
        );
      }
      if (!done) {
        throw new ApiError(0, 'NETWORK_ERROR', 'The assistant closed the connection before answering.');
      }
      return done;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // The stream went quiet past its heartbeat: the connection died without closing. Reported as
      // the transport failure it is, so the screen may retry a turn that showed no text.
      if (err instanceof StreamIdleError) {
        throw new ApiError(0, 'NETWORK_ERROR', 'The assistant stopped sending. Please try again.');
      }
      if (callerSignal?.aborted || abortCause === 'caller') {
        throw new ApiError(0, REQUEST_CANCELLED, 'The request was cancelled.');
      }
      if (abortCause === 'timeout') {
        throw new ApiError(0, 'NETWORK_TIMEOUT', 'The request timed out. Check your connection and try again.');
      }
      throw new ApiError(0, 'NETWORK_ERROR', unreachableMessage(API_URL, __DEV__));
    } finally {
      release();
    }
  },
};

/**
 * AI-40 — the part of a streaming `Response` this client uses.
 *
 * Narrowed here rather than reusing the DOM type: a test fake must be able to provide exactly
 * this much, and nothing in this file needs the rest of a `Response`.
 */
interface StreamedResponse {
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void>; releaseLock?(): void } } | null;
  text(): Promise<string>;
}

/** Parse an event payload without ever throwing on the way to the caller. */
function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default {
  register,
  login,
  me,
  changePassword,
  forgotPassword,
  resetPassword,
  firebaseExchange,
  renew,
  firebaseRegister,
  requestEmailVerification,
  confirmEmailVerification,
  firebaseLink,
  updateMe,
  logout,
  sessions,
  revokeSession,
  categoriesApi,
  locationsApi,
  suppliersApi,
  productsApi,
  inventoryApi,
  purchaseOrdersApi,
  usersApi,
  auditApi,
  dashboardApi,
  aiApi,
};
