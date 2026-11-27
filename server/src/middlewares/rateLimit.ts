/**
 * Public auth-endpoint rate limiting (Phase 07B / H1, extended by Phase 26B-3).
 *
 * login, register and the password-recovery routes are the unauthenticated write
 * endpoints, so they are the vectors for credential stuffing, password spraying,
 * brute force, mass account creation, reset-mail flooding and reset-token
 * guessing. They get dedicated limiters (stricter than the rest of the API, which
 * has none).
 *
 * Since the 2026-10-23 security audit, three AUTHENTICATED operations are limited
 * as well — change-password, firebase/link and credentials-changed — because each
 * one spends a credential comparison or a Firebase verification per call, and
 * change-password's comparison is the only re-authentication that endpoint
 * performs. Those are keyed on `req.user.id` (the server-derived account), not on
 * anything the caller supplies, and are mounted AFTER requireAuth.
 *
 *   login   -> two stacked limiters:
 *               1) per IP + normalized-email bucket, strict (targeted brute
 *                  force against one account). Only FAILED attempts consume
 *                  the budget (`skipSuccessfulRequests`), so legitimate users
 *                  are never locked out by their own successes.
 *               2) per-IP bucket with a higher cap (password spraying across
 *                  many accounts from one source).
 *   register -> per-IP bucket, counting every attempt. Keying registration by
 *               the unique email would let bots bypass it by cycling emails.
 *
 * Limits are read from the environment at limiter-creation time (same lazy
 * pattern as services/ai/aiConfig.js) so operators can tune them without code
 * changes, and each factory returns a FRESH limiter with its own in-memory
 * store — mounting a new router (see createAuthRouter in routes/auth.routes.js)
 * gives isolated stores, which tests use to keep runs deterministic.
 *
 * Responses follow the project's error shape ({ error, code }) and never
 * include passwords, hashes, tokens, or internal details. In-memory stores are
 * process-local: a multi-instance / serverless deployment needs a shared store
 * (e.g. Redis) — out of scope for V1, documented in the wiki of this library.
 */

import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { EMAIL_VERIFICATION_RATE_LIMITED } from '../constants/emailVerification.ts';
import {
  INVITATION_PREVIEW_RATE_LIMITED,
  INVITATION_SEND_RATE_LIMITED,
} from '../constants/invitations.ts';
import { normalizeEmail } from '../utils/validate.ts';

/**
 * The tunable limits every auth limiter is built from. Declared explicitly
 * because `authRateConfig` both accepts a PARTIAL override of it and returns a
 * COMPLETE one — a shape TypeScript cannot infer from the function itself.
 */
export type AuthRateConfig = {
  loginWindowMs: number;
  loginMax: number;
  loginIpWindowMs: number;
  loginIpMax: number;
  registerWindowMs: number;
  registerMax: number;
  passwordResetWindowMs: number;
  passwordResetMax: number;
  passwordResetIpWindowMs: number;
  passwordResetIpMax: number;
  passwordResetConfirmWindowMs: number;
  passwordResetConfirmMax: number;
  firebaseExchangeWindowMs: number;
  firebaseExchangeMax: number;
  firebaseRegisterWindowMs: number;
  firebaseRegisterMax: number;
  renewWindowMs: number;
  renewMax: number;
  emailVerificationRequestWindowMs: number;
  emailVerificationRequestMax: number;
  emailVerificationConfirmWindowMs: number;
  emailVerificationConfirmMax: number;
  changePasswordWindowMs: number;
  changePasswordMax: number;
  changePasswordIpWindowMs: number;
  changePasswordIpMax: number;
  firebaseLinkWindowMs: number;
  firebaseLinkMax: number;
  credentialsChangedWindowMs: number;
  credentialsChangedMax: number;
  accountDeletionWindowMs: number;
  accountDeletionMax: number;
  invitationSendWindowMs: number;
  invitationSendMax: number;
  invitationPreviewWindowMs: number;
  invitationPreviewMax: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  // `?? ''` parses to NaN, which the guard below turns into the fallback — the
  // same result the untyped version produced for a missing variable.
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The client address the limiters key on. Express types `req.ip` as possibly
 * undefined, but it is always populated for a request that reached a limiter
 * (it falls back to the socket address). `ipKeyGenerator` would throw on an
 * undefined address in the original code too, so this assertion states an
 * existing assumption rather than introducing a fallback that would change
 * behaviour under the `trust proxy` settings documented below.
 */
function clientIp(request: Request): string {
  return request.ip as string;
}

/** Base limits; individual keys can be overridden per router (tests/tuning). */
export function authRateConfig(overrides: Partial<AuthRateConfig> = {}): AuthRateConfig {
  return {
    loginWindowMs: positiveInt(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    loginMax: positiveInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX, 10),
    loginIpWindowMs: positiveInt(process.env.AUTH_LOGIN_IP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    loginIpMax: positiveInt(process.env.AUTH_LOGIN_IP_RATE_LIMIT_MAX, 60),
    registerWindowMs: positiveInt(process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    registerMax: positiveInt(process.env.AUTH_REGISTER_RATE_LIMIT_MAX, 30),
    // Password recovery (Phase 26B-3). Longer windows than login: a recovery
    // link is valid for 30 minutes and a user who needs one needs it once, so
    // there is no legitimate burst to protect.
    passwordResetWindowMs: positiveInt(
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    passwordResetMax: positiveInt(process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX, 5),
    passwordResetIpWindowMs: positiveInt(
      process.env.AUTH_PASSWORD_RESET_IP_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    passwordResetIpMax: positiveInt(process.env.AUTH_PASSWORD_RESET_IP_RATE_LIMIT_MAX, 20),
    passwordResetConfirmWindowMs: positiveInt(
      process.env.AUTH_PASSWORD_RESET_CONFIRM_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    passwordResetConfirmMax: positiveInt(process.env.AUTH_PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX, 20),
    // Firebase authentication (Phase 32C). The exchange window is the same length
    // as login's and its cap is STRICTER (30 vs 60), because each accepted request
    // costs a signature verification against Google's keys while a login attempt
    // that fails early costs a bcrypt comparison. A legitimate client exchanges
    // once per sign-in and again only when its application JWT expires or is
    // revoked, so 30 per 15 minutes per address is far above real use and well
    // below what makes an unthrottled verification endpoint worth abusing.
    firebaseExchangeWindowMs: positiveInt(
      process.env.AUTH_FIREBASE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    firebaseExchangeMax: positiveInt(process.env.AUTH_FIREBASE_EXCHANGE_RATE_LIMIT_MAX, 30),
    // Registration mirrors the password register limiter: mass account creation is
    // the same attack whichever route performs it, so the limits match (30/hour).
    firebaseRegisterWindowMs: positiveInt(
      process.env.AUTH_FIREBASE_REGISTER_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    firebaseRegisterMax: positiveInt(process.env.AUTH_FIREBASE_REGISTER_RATE_LIMIT_MAX, 30),
    // AUTH-03 — session renewal (per IP, 120 / 15 min by default). The window
    // matches login's and the cap is DELIBERATELY GENEROUS (120 vs login's 60):
    // renewal is a routine, proactive operation a legitimate client performs about
    // once per JWT lifetime, and several devices behind one office NAT share the
    // single per-IP bucket, so a tight cap would throttle honest users. It is
    // still bounded well below what makes an endpoint that costs a Firebase
    // `checkRevoked` verification worth abusing.
    renewWindowMs: positiveInt(
      process.env.AUTH_SESSION_RENEW_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    renewMax: positiveInt(process.env.AUTH_SESSION_RENEW_RATE_LIMIT_MAX, 120),
    // AUTH-04 — the email-verification code flow (design §14C.10, AD-19). Both routes
    // are pre-session and Firebase-authenticated, and both are limited PER IP ONLY.
    // No stable pre-verification identity exists to key on — the identity is only
    // known AFTER verification, and the one key a caller supplies before that is the
    // Firebase ID token, which rotates — so an identity-keyed bucket is impossible
    // here rather than merely omitted. The single-identity control is the 60-second
    // per-UID resend cooldown enforced in the B3 service's write predicate: a
    // different control with a different budget, deliberately NOT duplicated as a
    // limiter (and, on the confirm route, absent altogether).
    //
    // `skipSuccessfulRequests` is OMITTED on both, like every non-login limiter: a
    // successful request is a 2xx, so skipping successes would exempt precisely the
    // traffic these exist to bound. Each accepted request costs a Firebase signature
    // verification, and the request route additionally costs a database write plus one
    // outbound email — which is why the cap is not merely about CPU.
    emailVerificationRequestWindowMs: positiveInt(
      process.env.AUTH_EMAIL_VERIFICATION_REQUEST_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    emailVerificationRequestMax: positiveInt(
      process.env.AUTH_EMAIL_VERIFICATION_REQUEST_RATE_LIMIT_MAX,
      30
    ),
    emailVerificationConfirmWindowMs: positiveInt(
      process.env.AUTH_EMAIL_VERIFICATION_CONFIRM_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    emailVerificationConfirmMax: positiveInt(
      process.env.AUTH_EMAIL_VERIFICATION_CONFIRM_RATE_LIMIT_MAX,
      30
    ),
    // 2026-10-23 security audit — the AUTHENTICATED credential and identity operations.
    //
    // These are not guesses at a public credential, so their budgets are about WORK and
    // about re-authentication rather than about a code space:
    //
    //   change-password -> one bcrypt comparison per attempt and a second hash on success,
    //                      against a signed-in caller who already holds a session token. The
    //                      comparison IS the only re-authentication this endpoint performs,
    //                      so an unlimited endpoint is an unlimited guess at the account's
    //                      current password (and, for any legacy password account, a path to
    //                      a durable takeover: guess it once, set a new one).
    //   firebase/link   -> one Firebase checkRevoked verification (an outbound key fetch and
    //                      a signed-token verification) plus an audit write, per call.
    //   credentials-changed -> the same verification plus a stamped account and a
    //                      revokeAllSessions update, per call.
    //
    // Every one of them counts ALL attempts rather than only failures. `skipSuccessfulRequests`
    // is what keeps a legitimate login from spending its own budget, and it has no analogue
    // here: a successful credential change or link is exactly the expensive operation this
    // bounds, and a correct guess is the one an attacker wants. Ten changes, ten links and
    // twenty bridge calls per fifteen minutes are far above any real use — a person changes
    // one password, links one identity and completes one recovery — while still bounding the
    // work a single authenticated account can demand.
    changePasswordWindowMs: positiveInt(
      process.env.AUTH_CHANGE_PASSWORD_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    changePasswordMax: positiveInt(process.env.AUTH_CHANGE_PASSWORD_RATE_LIMIT_MAX, 10),
    changePasswordIpWindowMs: positiveInt(
      process.env.AUTH_CHANGE_PASSWORD_IP_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    changePasswordIpMax: positiveInt(process.env.AUTH_CHANGE_PASSWORD_IP_RATE_LIMIT_MAX, 30),
    firebaseLinkWindowMs: positiveInt(
      process.env.AUTH_FIREBASE_LINK_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    firebaseLinkMax: positiveInt(process.env.AUTH_FIREBASE_LINK_RATE_LIMIT_MAX, 10),
    credentialsChangedWindowMs: positiveInt(
      process.env.AUTH_CREDENTIALS_CHANGED_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    credentialsChangedMax: positiveInt(process.env.AUTH_CREDENTIALS_CHANGED_RATE_LIMIT_MAX, 20),
    // Account deletion is irreversible and a person performs it ONCE, so the budget
    // is deliberately tiny. It is not a brute-force surface like change-password —
    // the credential is verified either by bcrypt against the stored hash or by a
    // verified Firebase token — but every accepted request deletes a Firebase
    // identity and a set of records. Five per hour per account leaves room for a
    // mistyped confirmation and a retry after a transient failure, and nothing more.
    accountDeletionWindowMs: positiveInt(
      process.env.AUTH_ACCOUNT_DELETION_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    accountDeletionMax: positiveInt(process.env.AUTH_ACCOUNT_DELETION_RATE_LIMIT_MAX, 5),
    // Invitation-based onboarding (2026-10-25). Sending is AUTHENTICATED and gated by
    // users.manage, but each request posts mail to an address the caller chooses, so the
    // endpoint is a mail amplifier if it is unbounded. Twenty an hour leaves room for a
    // real onboarding batch and makes bulk use uninteresting.
    invitationSendWindowMs: positiveInt(
      process.env.AUTH_INVITATION_SEND_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    invitationSendMax: positiveInt(process.env.AUTH_INVITATION_SEND_RATE_LIMIT_MAX, 20),
    // Previewing is PUBLIC and keyed per IP: the caller has not signed in yet. Sixty an
    // hour is far above what a person needs (a link is opened a handful of times) and
    // stops a caller sweeping the token space — which is already infeasible at 256 bits.
    invitationPreviewWindowMs: positiveInt(
      process.env.AUTH_INVITATION_PREVIEW_RATE_LIMIT_WINDOW_MS,
      60 * 60 * 1000
    ),
    invitationPreviewMax: positiveInt(process.env.AUTH_INVITATION_PREVIEW_RATE_LIMIT_MAX, 60),
    ...overrides,
  };
}

/** Shared response conventions for every auth rate-limit block. */
function limitResponse(code: string, message: string) {
  return {
    // IETF draft-7 RateLimit / RateLimit-Policy + Retry-After headers.
    // `as const` keeps the literal: the library types this option as a union of
    // three header dialects, and a widened `string` matches none of them.
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => res.status(429).json({ error: message, code }),
  };
}

/**
 * The exact bucket key createLoginAccountLimiter counts against: the client
 * address (IPv6 masked to /56 so one host cannot fan out 2^64 keys) joined with
 * the NORMALIZED email — normalization identical to auth.service's login, so
 * case and surrounding whitespace cannot address a second bucket.
 *
 * Exported so the successful-login reset below addresses the SAME bucket rather
 * than re-deriving the key and drifting from it.
 */
export function loginAccountKey(request: Request): string {
  const ip = ipKeyGenerator(clientIp(request));
  const email = normalizeEmail(request.body?.email);
  return `${ip}|${email || '(no-email)'}`;
}

/**
 * Login limiter #1 — per IP + normalized email (strict). Only non-2xx
 * responses count, so failed password attempts accumulate and lock the
 * ip+account until the window elapses, while correct logins pass through.
 */
export function createLoginAccountLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { loginWindowMs, loginMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: loginWindowMs,
    limit: loginMax,
    skipSuccessfulRequests: true,
    keyGenerator: loginAccountKey,
    ...limitResponse(
      'LOGIN_RATE_LIMITED',
      'Too many login attempts. Please wait a moment and try again.'
    ),
  });
}

/**
 * Clears the per-IP+email login bucket once the request finishes 2xx.
 *
 * WHY THIS IS SEPARATE FROM `skipSuccessfulRequests`. That option only undoes
 * the SUCCESSFUL request's own increment — deliberately, so a legitimate user is
 * never locked out by their own correct password. It does NOT clear failures the
 * same account had already accumulated, so a person who mistypes a few times and
 * then gets in still starts their next attempt part-way to the lock. This
 * middleware closes that gap for the ACCOUNT bucket only: a proven-correct
 * sign-in is evidence the account's owner is present, so the failures are spent.
 *
 * IT MUST NOT BE MOUNTED FOR THE IP BUCKET. The IP bucket defends against one
 * SOURCE spraying many ACCOUNTS, and one account's correct password is no
 * evidence about the source — resetting it would let an attacker accumulate
 * per-account bucket budget for free by logging into an account they own
 * between sprays. Only the account bucket is cleared; the IP bucket keeps
 * `skipSuccessfulRequests` and nothing more.
 *
 * Registered on `res.on('finish')` rather than as a call the controller makes,
 * because the decision depends on the OUTCOME and every route answer here is
 * produced by the controller. It is mounted after the account limiter (so it can
 * address that limiter) and before the controller, and it can only ever DELETE a
 * bucket — it grants no request an outcome it would not otherwise have had.
 */
export function resetLoginAccountBucketOnSuccess(accountLimiter: {
  resetKey: (key: string) => void;
}) {
  return (request: Request, response: Response, next: NextFunction): void => {
    response.on('finish', () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        accountLimiter.resetKey(loginAccountKey(request));
      }
    });
    next();
  };
}

/**
 * Login limiter #2 — per IP, higher cap. Stops password spraying (many
 * accounts, one source) that would otherwise hop between per-account buckets.
 *
 * Keyed explicitly on request.ip (not the library default keyGenerator):
 * express-rate-limit's default keyGenerator throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 * whenever a request carries X-Forwarded-For while `trust proxy` is off —
 * turning a spoofed header into a 500. Deliberately keying on request.ip keeps
 * the same behavior in the common case while IGNORING forwarded headers until
 * the operator explicitly sets TRUST_PROXY (see config/env.js): under trust 0,
 * request.ip is always the direct peer, so spoofed headers cannot create fresh
 * buckets; under trust N, request.ip resolves to the forwarded client IP and
 * the limiter keys on the real client, exactly as configured.
 */
export function createLoginIpLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { loginIpWindowMs, loginIpMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: loginIpWindowMs,
    limit: loginIpMax,
    skipSuccessfulRequests: true,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      'LOGIN_RATE_LIMITED',
      'Too many login attempts. Please wait a moment and try again.'
    ),
  });
}

/**
 * Platform console limiter — per IP, every request counted.
 *
 * WHY THIS EXISTS. The console's routes are MFA-gated and capability-checked, and
 * until now that was their only bound: the rest of the API has no general limiter
 * either. The platform routes are the ones that can re-run a backup, reschedule a
 * scheduled task or DELETE a recovery point, so a session driven in a loop (a
 * stolen session, a stuck console, a retry storm) could start overlapping backup
 * runs and spend the host's disk on archives nobody asked for. One budget per
 * client address bounds that without touching any guard: the route still needs a
 * valid admin session, the capability and — for the destructive ones — a step-up
 * proof. 120 requests a minute is far above a person clicking through the console
 * and far below a loop that could hurt the host.
 *
 * It is a whole-router limiter on purpose: the console's read views poll, and a
 * view that polls hard is the same pressure as a view that writes hard.
 */
export function createPlatformConsoleLimiter(overrides: { windowMs?: number; limit?: number } = {}) {
  return rateLimit({
    windowMs: overrides.windowMs ?? 60_000,
    limit: overrides.limit ?? 120,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      'PLATFORM_RATE_LIMITED',
      'Too many platform console requests. Please wait a moment and try again.'
    ),
  });
}

/**
 * Registration limiter — per IP, counting every attempt (mass signups). Same
 * explicit request.ip keying rationale as createLoginIpLimiter above.
 */
export function createRegisterLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { registerWindowMs, registerMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: registerWindowMs,
    limit: registerMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      'REGISTER_RATE_LIMITED',
      'Too many registration attempts. Please wait a while and try again.'
    ),
  });
}

// ---------------------------------------------------------------------------
// Password recovery (Phase 26B-3)
// ---------------------------------------------------------------------------
//
// OWASP treats password-recovery endpoints as authentication endpoints, so these
// follow the login/register pattern rather than inventing anything.
//
// THE ONE DELIBERATE DIVERGENCE from createLoginAccountLimiter:
// `skipSuccessfulRequests` is OMITTED — every attempt counts. On login that
// option is what stops legitimate users locking themselves out with their own
// correct passwords. Here it would silently DISABLE the limiter: the success
// path and the silent no-op are deliberately indistinguishable (both answer the
// same 202), so there is no failure to count and the budget would never be spent.
// Counting every attempt is also what makes the limiter enumeration-neutral —
// a known address and an unknown one consume it identically.
//
// SHARED CODE: all three answer PASSWORD_RESET_RATE_LIMITED, the way
// LOGIN_RATE_LIMITED already spans the two login limiters. A client needs to
// know "you are being throttled on recovery", not which bucket caught it.
const PASSWORD_RESET_RATE_LIMITED = 'PASSWORD_RESET_RATE_LIMITED';

/**
 * Recovery limiter #1 — per IP + normalized email (strict). Bounds how often one
 * account can be mailed, so the endpoint cannot be used to flood a victim's inbox
 * or to burn this server's provider quota against a single address.
 *
 * The key is a CLIENT-SUPPLIED EMAIL, exactly as createLoginAccountLimiter
 * already keys. That is not the forbidden "trust a client identity" case: a
 * userId/businessId is an AUTHORIZATION identity and must never be taken from a
 * request, whereas the address here is the SUBJECT of the request. Keying on it
 * grants nothing — a forged address only spends that address's own budget, and a
 * correct-but-unknown address spends it identically.
 */
export function createPasswordResetRequestAccountLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { passwordResetWindowMs, passwordResetMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: passwordResetWindowMs,
    limit: passwordResetMax,
    keyGenerator(request) {
      const ip = ipKeyGenerator(clientIp(request));
      const email = normalizeEmail(request.body?.email);
      return `${ip}|${email || '(no-email)'}`;
    },
    ...limitResponse(
      PASSWORD_RESET_RATE_LIMITED,
      'Too many password reset requests. Please wait and try again.'
    ),
  });
}

/**
 * Recovery limiter #2 — per IP, higher cap. The backstop for the account bucket:
 * an attacker rotating addresses would otherwise get a fresh budget per address,
 * while a legitimate user sharing an office NAT is unaffected at this cap.
 * Same explicit request.ip keying rationale as createLoginIpLimiter — never the
 * library default, which turns a spoofed X-Forwarded-For into a 500.
 */
export function createPasswordResetRequestIpLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { passwordResetIpWindowMs, passwordResetIpMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: passwordResetIpWindowMs,
    limit: passwordResetIpMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      PASSWORD_RESET_RATE_LIMITED,
      'Too many password reset requests. Please wait and try again.'
    ),
  });
}

/**
 * Confirmation limiter — per IP. reset-password carries no address to key on,
 * and keying on the token would be pointless (an attacker simply rotates it), so
 * the cap is per source. It matters because each accepted attempt costs a SHA-256
 * lookup, an atomic claim and a bcrypt hash on an unauthenticated endpoint.
 */
export function createPasswordResetConfirmLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { passwordResetConfirmWindowMs, passwordResetConfirmMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: passwordResetConfirmWindowMs,
    limit: passwordResetConfirmMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      PASSWORD_RESET_RATE_LIMITED,
      'Too many password reset attempts. Please wait and try again.'
    ),
  });
}

// ---------------------------------------------------------------------------
// Firebase authentication (Phase 32C)
// ---------------------------------------------------------------------------
//
// The exchange route MINTS SESSIONS on an unauthenticated endpoint, which makes it
// the highest-value target Phase 32 introduces, so it is limited from the day it
// ships (Phase 32A §15) using the existing factories' mechanism and nothing new.
//
// `skipSuccessfulRequests` is OMITTED, and on this route that is the whole point
// rather than a detail: a successful exchange is a 2xx, so counting only failures
// would exempt precisely the traffic the limiter exists to bound — an attacker
// with a pile of valid tokens. The option appears on the two Phase 07B login
// limiters (where it stops users locking themselves out with their own correct
// passwords) and on nothing else; both facts are asserted in the suites.
//
// TWO THINGS PHASE 32A §15 ASKED FOR ARE DELIBERATELY NOT HERE, and the reason is
// structural rather than an omission:
//
//   * AN IDENTITY-KEYED BUCKET. The spec says "if a stable key exists". At the
//     middleware layer none does: the identity is only known AFTER verification,
//     and the only pre-verification key the caller supplies is the ID token
//     itself — which an attacker rotates freely and a legitimate client replaces
//     every hour, so keying on it would bound nothing while giving every rotation
//     a fresh budget. A per-identity cap therefore needs a counter written AFTER
//     verification, inside the request, which is new mechanism rather than the
//     reuse §15 asks for. It is left out rather than faked, and the per-IP buckets
//     below are the address-rotation backstop the same section names.
//   * `REGISTRATION_REQUIRED` IS COUNTED, NOT SKIPPED — which is why the omission
//     above matters here too. It is a legitimate outcome and a 403, so a limiter
//     that skipped 4xx, or that counted only successes, would leave the
//     "which Firebase identities exist" surface §15 names unbounded.
//
// SHARED CODE: both answer FIREBASE_RATE_LIMITED, the way LOGIN_RATE_LIMITED
// already spans the two login limiters. A client needs to know "you are being
// throttled signing in with Firebase", not which bucket caught it.
const FIREBASE_RATE_LIMITED = 'FIREBASE_RATE_LIMITED';
const FIREBASE_RATE_LIMITED_MESSAGE =
  'Too many sign-in attempts. Please wait a moment and try again.';

/**
 * Exchange limiter — per IP.
 *
 * Same explicit `request.ip` keying rationale as createLoginIpLimiter: never the
 * library default, which turns a spoofed X-Forwarded-For into a 500 until the
 * operator sets TRUST_PROXY.
 */
export function createFirebaseExchangeLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { firebaseExchangeWindowMs, firebaseExchangeMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: firebaseExchangeWindowMs,
    limit: firebaseExchangeMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(FIREBASE_RATE_LIMITED, FIREBASE_RATE_LIMITED_MESSAGE),
  });
}

/**
 * Registration limiter — per IP, counting every attempt, mirroring
 * createRegisterLimiter. Keying on the email would let bots bypass it by cycling
 * addresses, which for federated signup is even easier than for the password path
 * because a throwaway Firebase account is cheap.
 */
export function createFirebaseRegisterLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { firebaseRegisterWindowMs, firebaseRegisterMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: firebaseRegisterWindowMs,
    limit: firebaseRegisterMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(FIREBASE_RATE_LIMITED, FIREBASE_RATE_LIMITED_MESSAGE),
  });
}

// AUTH-03 — session renewal. A STABLE, route-specific code rather than a shared
// FIREBASE_* one: unlike those, this rate limit is not about a credential being
// guessed, it is the server declining to spend more Firebase verification work on
// this address for now, and the client must treat it as TRANSIENT (preserve the
// still-valid session, honor Retry-After, back off) rather than as session loss.
// The `Retry-After` header is emitted by `limitResponse`'s draft-7 standard
// headers, exactly as for every other auth limiter.
const SESSION_RENEW_RATE_LIMITED = 'SESSION_RENEW_RATE_LIMITED';
const SESSION_RENEW_RATE_LIMITED_MESSAGE =
  'Too many renewal attempts. Please wait a moment and try again.';

/**
 * Renewal limiter — per IP, counting every attempt.
 *
 * `skipSuccessfulRequests` is OMITTED, as on every other count-every-attempt
 * limiter here: a renewal is cheap to count and a burst of successful ones is
 * precisely the load this guards (each accepted request costs a Firebase
 * `checkRevoked` verification). Keyed on `request.ip` with the same explicit
 * `ipKeyGenerator` rationale as the other per-IP limiters — never the library
 * default, which would turn a spoofed X-Forwarded-For into a 500 until the
 * operator sets TRUST_PROXY.
 */
export function createSessionRenewLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { renewWindowMs, renewMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: renewWindowMs,
    limit: renewMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(SESSION_RENEW_RATE_LIMITED, SESSION_RENEW_RATE_LIMITED_MESSAGE),
  });
}

// ---------------------------------------------------------------------------
// Email verification (AUTH-04, AD-19)
// ---------------------------------------------------------------------------
//
// Two factories, one per endpoint, because the two endpoints spend different things
// and must have independent budgets: `request` mints a challenge, writes it and sends
// an email; `confirm` reserves an attempt, compares a digest and may perform an Admin
// write. Sharing one bucket would let a burst of confirmations exhaust the budget that
// bounds outbound mail — the resource abuse of this surface actually costs.
//
// SHARED CODE: both answer `EMAIL_VERIFICATION_RATE_LIMITED`, the way
// `LOGIN_RATE_LIMITED` already spans the two login limiters and
// `PASSWORD_RESET_RATE_LIMITED` spans the three recovery ones. A client needs to know
// "you are being throttled on verification", not which bucket caught it.
//
// THE CODE IS IMPORTED, NOT RE-DECLARED. The other limiter codes in this file are local
// string constants, but `EMAIL_VERIFICATION_RATE_LIMITED` already exists in
// `constants/emailVerification.ts` (declared there in AUTH-04-A, before these endpoints
// existed). Typing it a second time here would create a second source of truth for a
// client-facing code, which is exactly the drift the Phase 23 client error-code contract
// exists to catch.

/**
 * Request limiter — per IP.
 *
 * Bounds how often ONE ADDRESS can make this server mint challenges, write rows and
 * send mail. Same explicit `request.ip` keying rationale as `createLoginIpLimiter`:
 * never the library default, which turns a spoofed X-Forwarded-For into a 500 until the
 * operator sets TRUST_PROXY.
 */
export function createEmailVerificationRequestLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { emailVerificationRequestWindowMs, emailVerificationRequestMax } =
    authRateConfig(overrides);
  return rateLimit({
    windowMs: emailVerificationRequestWindowMs,
    limit: emailVerificationRequestMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      EMAIL_VERIFICATION_RATE_LIMITED,
      'Too many verification requests. Please wait a moment and try again.'
    ),
  });
}

/**
 * Confirmation limiter — per IP.
 *
 * Bounds code guessing from one address. Each accepted attempt costs a conditional
 * reservation, an HMAC comparison and possibly a Firebase Admin write, and the code
 * space is only 10^6 — so this is the backstop that keeps an unauthenticated caller
 * from spending that budget at machine speed. Keyed on `request.ip` with the same
 * explicit `ipKeyGenerator` rationale as the other per-IP limiters.
 */
export function createEmailVerificationConfirmLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { emailVerificationConfirmWindowMs, emailVerificationConfirmMax } =
    authRateConfig(overrides);
  return rateLimit({
    windowMs: emailVerificationConfirmWindowMs,
    limit: emailVerificationConfirmMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(
      EMAIL_VERIFICATION_RATE_LIMITED,
      'Too many verification attempts. Please wait a moment and try again.'
    ),
  });
}

// ---------------------------------------------------------------------------
// Authenticated credential and identity operations (2026-10-23 security audit)
// ---------------------------------------------------------------------------
//
// Everything above this line protects a route a caller reaches WITHOUT a session, which is why
// every key in it is derived from something the caller supplies. The three inline limiters below
// are the other half: they sit behind `requireAuth`, so the account is already established and
// `req.user.id` is a server-derived fact rather than a claim. Keying on it is what makes the
// budget belong to the ACCOUNT, so rotating addresses buys no fresh budget on the two per-account
// limiters. The change-password strict bucket is the ONE exception: it joins the account with the
// client address, so a different address does buy a fresh ten there. That is deliberate — an
// account-wide bucket would let anyone already holding a session for the account keep the victim's
// OWN password change refused for the window — and the per-address bucket below still bounds a
// single source (thirty per fifteen minutes). Checklist §52 records the N×10 consequence.
//
// THEY ARE DELIBERATELY NOT ENFORCED BEFORE AUTHENTICATION. Each is mounted after requireAuth, so
// an anonymous caller is answered 401 and never spends (or is refused by) a bucket it has no
// identity to own. That is the same ordering AUTH-03's `/renew` uses, and the Phase 23 classifier
// treats "requireAuth + limiter + controller" as AUTHENTICATED rather than gated.
//
// THE CODES ARE DISTINCT PER OPERATION rather than one shared `*_RATE_LIMITED`, because the
// remedies differ in wording for a human reading the sentence: "too many password changes" and
// "too many attempts to connect this sign-in" are different things to say, and the mobile client
// displays `error.message` for a 429 on every one of these screens.
const CHANGE_PASSWORD_RATE_LIMITED = 'CHANGE_PASSWORD_RATE_LIMITED';
const CHANGE_PASSWORD_RATE_LIMITED_MESSAGE =
  'Too many password change attempts. Please wait a moment and try again.';

const FIREBASE_LINK_RATE_LIMITED = 'FIREBASE_LINK_RATE_LIMITED';
const FIREBASE_LINK_RATE_LIMITED_MESSAGE =
  'Too many attempts to connect this sign-in. Please wait a moment and try again.';

const ACCOUNT_DELETION_RATE_LIMITED = 'ACCOUNT_DELETION_RATE_LIMITED';
const ACCOUNT_DELETION_RATE_LIMITED_MESSAGE =
  'Too many account deletion attempts. Please wait a moment and try again.';

const CREDENTIALS_CHANGED_RATE_LIMITED = 'CREDENTIALS_CHANGED_RATE_LIMITED';
const CREDENTIALS_CHANGED_RATE_LIMITED_MESSAGE =
  'Too many attempts to record this credential change. Please wait a moment and try again.';

/**
 * The request shape these limiters key on. Structural and local, following the rest of this
 * project: `user` exists only because `requireAuth` ran, so declaring it globally would let any
 * module read an authoritative-looking identity on a public route.
 */
type AuthenticatedRequest = Request & { user?: { id?: unknown } };

/**
 * The account a limiter is charging: `req.user.id`, and nothing else.
 *
 * The IP fallback is not an alternative identity — it keeps the key finite if a future route mounts
 * one of these factories ahead of `requireAuth`, which no route does today. It never lets a
 * caller CHOOSE which bucket is charged: reaching the fallback means there is no authenticated
 * account at all, and the request is about to be refused by a controller or an earlier gate.
 */
function authenticatedAccountKey(request: Request): string {
  const userId = (request as AuthenticatedRequest).user?.id;
  if (typeof userId === 'string' && userId.length > 0) return `user:${userId}`;
  return `ip:${ipKeyGenerator(clientIp(request))}`;
}

/**
 * The same account joined with the client address, for change-password's strict bucket.
 *
 * Deliberately NOT used by the two Firebase routes: their cost is the same wherever it comes from,
 * and a person who links an identity from a phone and then from a laptop should not have two
 * independent budgets for one account.
 */
function authenticatedAccountIpKey(request: Request): string {
  return `${ipKeyGenerator(clientIp(request))}|${authenticatedAccountKey(request)}`;
}

/**
 * Change-password limiter #1 — per account + client address (strict).
 *
 * The strict bucket exists because this endpoint verifies the CURRENT password: an attacker who
 * holds a stolen session tries the victim's password here, and a success hands them a durable
 * credential. Ten attempts per quarter hour is generous for the legitimate flow (one change ends
 * the session and asks for a fresh sign-in) and useless for guessing.
 */
export function createChangePasswordLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { changePasswordWindowMs, changePasswordMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: changePasswordWindowMs,
    limit: changePasswordMax,
    keyGenerator: authenticatedAccountIpKey,
    ...limitResponse(CHANGE_PASSWORD_RATE_LIMITED, CHANGE_PASSWORD_RATE_LIMITED_MESSAGE),
  });
}

/**
 * Change-password limiter #2 — per client address (looser).
 *
 * The backstop for one source that rotates ACCOUNTS rather than attempts: each account bucket is
 * fresh, but every bcrypt comparison still costs this server CPU. Same explicit `request.ip`
 * keying rationale as createLoginIpLimiter — never the library default, which turns a spoofed
 * X-Forwarded-For into a 500 until the operator sets TRUST_PROXY.
 */
export function createChangePasswordIpLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { changePasswordIpWindowMs, changePasswordIpMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: changePasswordIpWindowMs,
    limit: changePasswordIpMax,
    keyGenerator(request) {
      return ipKeyGenerator(clientIp(request));
    },
    ...limitResponse(CHANGE_PASSWORD_RATE_LIMITED, CHANGE_PASSWORD_RATE_LIMITED_MESSAGE),
  });
}

/**
 * Firebase-link limiter — per account.
 *
 * Linking is idempotent and a person performs it once, so ten authenticated attempts per quarter
 * hour bounds the Firebase verification work an account can demand without touching any
 * legitimate flow. Keyed on the account rather than the address: rotating addresses must not buy
 * a fresh budget for the same identity.
 */
export function createFirebaseLinkLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { firebaseLinkWindowMs, firebaseLinkMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: firebaseLinkWindowMs,
    limit: firebaseLinkMax,
    keyGenerator: authenticatedAccountKey,
    ...limitResponse(FIREBASE_LINK_RATE_LIMITED, FIREBASE_LINK_RATE_LIMITED_MESSAGE),
  });
}

/**
 * Credential-change bridge limiter — per account.
 *
 * The bridge revokes every session for the account, so its cost is a write-heavy update and its
 * abuse value is a self-inflicted sign-out loop. Twenty per quarter hour covers the recovery
 * handoff's retries (the client repeats the call while a revocation is still owed) and stops a
 * caller turning the bridge into a write amplifier.
 */
export function createCredentialsChangedLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { credentialsChangedWindowMs, credentialsChangedMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: credentialsChangedWindowMs,
    limit: credentialsChangedMax,
    keyGenerator: authenticatedAccountKey,
    ...limitResponse(
      CREDENTIALS_CHANGED_RATE_LIMITED,
      CREDENTIALS_CHANGED_RATE_LIMITED_MESSAGE
    ),
  });
}

/**
 * Invitation-send limiter — per account.
 *
 * Mounted AFTER `requireAuth` and `requirePermission(users.manage)`, so an anonymous or
 * unprivileged caller is refused before a bucket is touched. Keyed on the account for the
 * same reason the other authenticated limiters are: rotating addresses must not buy a
 * fresh mail budget for the same admin.
 */
export function createInvitationSendLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { invitationSendWindowMs, invitationSendMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: invitationSendWindowMs,
    limit: invitationSendMax,
    keyGenerator: authenticatedAccountKey,
    ...limitResponse(
      INVITATION_SEND_RATE_LIMITED,
      'Too many invitations have been sent from this account. Please wait before sending more.'
    ),
  });
}

/**
 * Invitation-preview limiter — per IP, for the PUBLIC `GET /api/auth/invitations/:token`.
 *
 * The token is 256 bits, so guessing is not a realistic attack; the budget exists so the
 * public lookup cannot be used as a cheap database probe or as a way to enumerate
 * responses at volume. It counts every attempt, including misses, because a miss is the
 * request an enumeration would make.
 */
export function createInvitationPreviewLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { invitationPreviewWindowMs, invitationPreviewMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: invitationPreviewWindowMs,
    limit: invitationPreviewMax,
    keyGenerator: (request: Request) => ipKeyGenerator(clientIp(request)),
    ...limitResponse(
      INVITATION_PREVIEW_RATE_LIMITED,
      'Too many requests. Please wait a moment and try again.'
    ),
  });
}

/**
 * Account-deletion limiter — per account.
 *
 * Mounted AFTER `requireAuth`, so an anonymous caller is refused with 401 and never
 * charged a bucket it has no identity to own. Keyed on the account for the same
 * reason the credential-change limiter is: rotating addresses must not buy a fresh
 * budget for the same identity.
 */
export function createAccountDeletionLimiter(overrides: Partial<AuthRateConfig> = {}) {
  const { accountDeletionWindowMs, accountDeletionMax } = authRateConfig(overrides);
  return rateLimit({
    windowMs: accountDeletionWindowMs,
    limit: accountDeletionMax,
    keyGenerator: authenticatedAccountKey,
    ...limitResponse(ACCOUNT_DELETION_RATE_LIMITED, ACCOUNT_DELETION_RATE_LIMITED_MESSAGE),
  });
}

export default {
  authRateConfig,
  createChangePasswordLimiter,
  createAccountDeletionLimiter,
  createInvitationSendLimiter,
  createInvitationPreviewLimiter,
  createChangePasswordIpLimiter,
  createFirebaseLinkLimiter,
  createCredentialsChangedLimiter,
  createLoginAccountLimiter,
  createLoginIpLimiter,
  createRegisterLimiter,
  createPasswordResetRequestAccountLimiter,
  createPasswordResetRequestIpLimiter,
  createPasswordResetConfirmLimiter,
  createFirebaseExchangeLimiter,
  createFirebaseRegisterLimiter,
  createSessionRenewLimiter,
  createEmailVerificationRequestLimiter,
  createEmailVerificationConfirmLimiter,
};
