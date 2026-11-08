// Phase 23 — Authorization Contract Completion: Route Classification & RBAC Mirror Guards.
//
// DATABASE-FREE. Nothing here touches MongoDB, and — like Phase 22 — nothing
// here is a route inventory. There is deliberately no "the products router has
// exactly N routes" assertion and no total route count: a future phase that
// legitimately adds a route must be able to do so by declaring it, never by
// editing a number. What this suite pins is the CONTRACT.
//
// Phase 22 bound eight named read routes to their view permissions and made the
// permission catalogue self-checking. It left three authorization surfaces held
// by convention. This suite closes all three:
//
//   1. THE CROSS-LAYER RBAC MIRROR (23A). mobile/lib/permissions.js re-declares
//      the whole permission catalogue and all four role grants, because the
//      mobile UI needs to know what to show. The backend stays the security
//      boundary — but nothing tied the two copies together, so they were kept in
//      step by hand (Phases 13A, 17 and 19 each did so). A drift in either
//      direction is silent and user-visible: a grant removed on the server makes
//      the app offer a button the server 403s, and a grant added makes a role
//      never see an action it is allowed to perform. The guard COMPARES the two
//      modules and fails on any divergence.
//
//   2. ROUTE AUTHORIZATION CLASSIFICATION (23B). Phase 22 proved eight specific
//      routes are gated. It did not pin the complement — which routes are
//      deliberately NOT gated. So a new route added without a gate would pass
//      every test in the suite, which is the exact failure Phase 22 existed to
//      prevent. Every route reachable from app.js is now classified into exactly
//      one bucket, and the buckets are declared with reasons:
//
//        PERMISSION_GATED — carries a permission gate. The default.
//        AUTHENTICATED    — requireAuth + controller only (self-service routes).
//        PUBLIC           — no authentication at all (health, login/register,
//                           password recovery, Firebase exchange/registration).
//        ROLE_GATED       — a requireRole() gate. DECLARED LIST IS EMPTY: there
//                           are no role-name-gated routes, and adding one
//                           requires declaring it here and saying why.
//
//      A route that lands in no bucket FAILS. That is the whole point.
//
//   3. THE INERT requireRole GATE (23C). middlewares/authorize.js exports
//      requireRole(...roles), a role-name allowlist that bypasses the permission
//      catalogue entirely. It has no production call site — it is exercised only
//      by the Phase 03 suites — but it is also a BLIND SPOT in any scan that
//      looks only for requirePermission: a route written as
//      `requireAuth, requireRole('OWNER'), controller` carries no permission, so
//      the Phase 22 catalogue-coverage assertions would not see it and the route
//      classification in 23B would have accepted it as unclassified-by-omission.
//      The classifier above therefore RECOGNISES `requireRole(` explicitly and
//      routes it to the ROLE_GATED bucket, which is empty and must stay empty
//      unless an owner decision fills it. requireRole is deliberately NOT deleted
//      or modified: its inertness is pinned, not its removal.
//
//   4. THE CLIENT ERROR-CODE CONTRACT (23D). The mobile client branches on
//      server error codes (`ACCOUNT_DISABLED`, `AI_RATE_LIMITED`,
//      `RECEIVE_CONFLICT`, ...). Those codes are a client-facing contract with no
//      guard: renaming one server-side would silently turn a specific, friendly
//      client message into a generic failure. Every `code` literal the client
//      compares against must be a code the server can actually emit. Emitting
//      positions are the three real ones — the third argument of `new ApiError`,
//      a `this.code =` assignment, and a `code:` response-body property (the
//      rate limiters answer directly rather than through ApiError). A client
//      code that no server position produces is a failure.
//
// Every comparison is factored into a pure function so the guard can be
// NEGATIVE-TESTED in memory — a guard that cannot be shown to fail is not a
// guard. Those negative tests are at the bottom of this file: they perturb a
// clone of the real inputs and require the comparison to notice. No file on disk
// is written, and no mobile source is modified.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { unitSuite } from './testEnv.mjs';
import {
  COMPONENT_EXTENSIONS,
  SOURCE_EXTENSIONS,
  listSourceFiles,
  readSource,
  resolveSourcePath,
  walkSourceFiles,
} from './sourceFiles.mjs';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, ROLE_VALUES } from '../src/constants/roles.ts';
import requireAuth, { requireAuthForRenewal } from '../src/middlewares/authenticate.ts';

// ---------------------------------------------------------------------------
// Paths — every one resolved from this file, never from cwd.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ROUTES_DIR = path.join(SRC_DIR, 'routes');
const MOBILE_DIR = path.join(REPO_ROOT, 'mobile');

const readSrc = (relPath) => readSource(new URL(`../src/${relPath}`, import.meta.url));

/**
 * Directories under `mobile/` that are generated or ignored rather than application
 * source: dependencies, the Expo export output, Expo's own cache/types, and the local
 * smoke-test scratch directory. Skipping them keeps the RBAC-mirror and client-error-code
 * scans reading the app, not a build artifact or a generated `.d.ts`.
 */
const MOBILE_SKIP_DIRS = new Set(['node_modules', 'dist', '.expo', '.smoke']);

// ---------------------------------------------------------------------------
// 23A — the cross-layer RBAC mirror
// ---------------------------------------------------------------------------

const MIRROR_PATH = resolveSourcePath(path.join(MOBILE_DIR, 'lib', 'permissions.js'));
const mirror = await import(pathToFileURL(MIRROR_PATH).href);

/**
 * Compare the server matrix with the mobile mirror. Returns a list of
 * human-readable divergences; an empty list means lock-step.
 *
 * Pure, so the negative tests below can drive it with a perturbed clone.
 */
function mirrorDrift(server, client) {
  const problems = [];
  const list = (v) => [...(v ?? [])].sort();

  // Role names must agree, or `can()` in the client silently returns false for
  // every user of a role the client does not know about.
  const serverRoles = Object.keys(server.ROLES ?? {}).sort();
  const clientRoles = Object.keys(client.ROLES ?? {}).sort();
  if (serverRoles.join('|') !== clientRoles.join('|')) {
    problems.push(`ROLES keys differ: server [${serverRoles}] vs client [${clientRoles}]`);
  } else {
    for (const key of serverRoles) {
      if (server.ROLES[key] !== client.ROLES[key]) {
        problems.push(`ROLES.${key}: server "${server.ROLES[key]}" vs client "${client.ROLES[key]}"`);
      }
    }
  }
  if (list(server.ROLE_VALUES).join('|') !== list(client.ROLE_VALUES).join('|')) {
    problems.push(
      `ROLE_VALUES differ: server [${list(server.ROLE_VALUES)}] vs client [${list(client.ROLE_VALUES)}]`
    );
  }

  // The catalogue itself: same keys AND same values. A key that exists on one
  // side only, or a key whose value string differs, is drift.
  const serverKeys = Object.keys(server.PERMISSIONS ?? {}).sort();
  const clientKeys = Object.keys(client.PERMISSIONS ?? {}).sort();
  const missingOnClient = serverKeys.filter((k) => !clientKeys.includes(k));
  const extraOnClient = clientKeys.filter((k) => !serverKeys.includes(k));
  if (missingOnClient.length) problems.push(`PERMISSIONS missing from the mirror: ${missingOnClient}`);
  if (extraOnClient.length) problems.push(`PERMISSIONS present only in the mirror: ${extraOnClient}`);
  for (const key of serverKeys) {
    if (clientKeys.includes(key) && server.PERMISSIONS[key] !== client.PERMISSIONS[key]) {
      problems.push(
        `PERMISSIONS.${key}: server "${server.PERMISSIONS[key]}" vs client "${client.PERMISSIONS[key]}"`
      );
    }
  }

  // The grants. This is the half that actually decides what the UI offers.
  const serverGrantRoles = Object.keys(server.ROLE_PERMISSIONS ?? {}).sort();
  const clientGrantRoles = Object.keys(client.ROLE_PERMISSIONS ?? {}).sort();
  if (serverGrantRoles.join('|') !== clientGrantRoles.join('|')) {
    problems.push(
      `ROLE_PERMISSIONS roles differ: server [${serverGrantRoles}] vs client [${clientGrantRoles}]`
    );
  }
  for (const role of serverGrantRoles) {
    const a = list(server.ROLE_PERMISSIONS[role]);
    const b = list(client.ROLE_PERMISSIONS?.[role]);
    const onlyServer = a.filter((p) => !b.includes(p));
    const onlyClient = b.filter((p) => !a.includes(p));
    if (onlyServer.length) {
      problems.push(`${role}: granted on the server but not in the mirror: ${onlyServer}`);
    }
    if (onlyClient.length) {
      problems.push(`${role}: granted in the mirror but not on the server: ${onlyClient}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 23B / 23C — route authorization classification
// ---------------------------------------------------------------------------

const CLASS = {
  GATED: 'PERMISSION_GATED',
  AUTHENTICATED: 'AUTHENTICATED',
  PUBLIC: 'PUBLIC',
  ROLE_GATED: 'ROLE_GATED',
};

/**
 * A rate-limiter middleware factory call (`createSessionRenewLimiter(…)`). A
 * limiter decides how OFTEN a caller may reach the controller, never WHO may —
 * so it is not an authorization gate, and it must never be mistaken for one.
 */
const LIMITER_FACTORY = /\bcreate[A-Za-z0-9_]*Limiter\s*\(/g;

/**
 * Routes that are deliberately NOT behind a permission gate, with the reason.
 * A route in one of these lists is exempt from PERMISSION_GATED; a route in
 * neither list must be gated. Adding a route means declaring it — never
 * adjusting a number.
 *
 * PUBLIC (no authentication at all):
 *   health probes must answer before a token can exist; login/register are how
 *   a token is obtained; the two password-recovery routes are how a token is
 *   regained after the password is lost, so by definition the caller holds none.
 *   All are rate-limited.
 * AUTHENTICATED (requireAuth + controller, no permission):
 *   the seven self-service account routes operate only on the caller's own
 *   account (Phase 26A added the three session-lifecycle routes: they manage
 *   nothing but the caller's own sessions, and the owning userId comes from
 *   req.user, never from the request — so no permission applies; Phase 32H added
 *   POST /api/auth/firebase/link, which attaches a verified Firebase identity to
 *   the caller's own account for the same reason — the account is req.user.id and
 *   `firebaseUid` is not a capability any role could be granted (Phase 32L added
 *   POST /api/auth/firebase/unlink on the same terms, and PHASE A (F-1) REMOVED it
 *   again — the capability is gone, not re-bucketed, so it is declared nowhere); and
 *   N-4 added
 *   POST /api/auth/credentials-changed, which records a credential change and
 *   revokes sessions on the caller's OWN account — nothing but the account that
 *   authenticated the request can be affected, and a session is not a capability),
 *   and every other account route is permission-gated.
 *   The four categories/locations reads are Phase 22's explicit deferral: no
 *   categories.view / locations.view key exists in the catalogue, and inventing
 *   one was out of Phase 22 scope. They are pinned here so the deferral is
 *   visible and cannot be extended by accident.
 */
const PUBLIC_ROUTES = [
  { route: 'GET /', why: 'service info: name and status, no data, no auth' },
  { route: 'GET /api/health', why: 'liveness/readiness must answer without a token' },
  { route: 'GET /api/health/live', why: 'liveness probe' },
  { route: 'GET /api/health/ready', why: 'readiness probe' },
  { route: 'POST /api/auth/login', why: 'how a token is obtained; rate-limited' },
  { route: 'POST /api/auth/register', why: 'how a business is created; rate-limited' },
  {
    route: 'POST /api/auth/forgot-password',
    why: 'Phase 26B-3: how a reset link is requested — the caller is locked out and cannot hold a session; rate-limited per IP + account',
  },
  {
    route: 'POST /api/auth/reset-password',
    why: 'Phase 26B-3: spends a reset link — reachable only by a caller with no working password; rate-limited per IP',
  },
  {
    route: 'POST /api/auth/password-reset/code',
    why: 'AUTH-06: how a six-digit reset code is requested — the caller has forgotten their password and holds no session by definition, and the endpoint resolves nothing but one fixed 202 so it cannot enumerate accounts; rate-limited per address + IP',
  },
  {
    route: 'POST /api/auth/password-reset/verify',
    why: 'AUTH-06 (two-step): proves the emailed six-digit code and mints a short-lived single-use reset authorization — the caller has no working password by definition, so no session can be required; it writes no credential and issues no session, and it answers one generic 400 for a wrong code and an unknown address alike; rate-limited per IP on the same budget as /confirm',
  },
  {
    route: 'POST /api/auth/password-reset/confirm',
    why: 'AUTH-06: spends the reset authorization and replaces the password — reachable only by a caller with no working password, accepts no code and no address (the account comes from the challenge), and it ISSUES no session: a completed reset ends every session and asks the person to sign in again; rate-limited per IP on the same budget as /verify',
  },
  {
    route: 'POST /api/auth/firebase/exchange',
    why: 'Phase 32C: turns a verified Firebase ID token into an application session — the caller holds no Inventory AI JWT by definition, which is what the exchange exists to remedy; rate-limited per IP',
  },
  {
    route: 'POST /api/auth/firebase/register',
    why: 'Phase 32C: creates the Business + OWNER user for a Firebase-verified identity that has no tenant yet — the caller holds no Inventory AI JWT and no role, both of which are assigned server-side; rate-limited per IP',
  },
  {
    route: 'POST /api/auth/email-verification/request',
    why: 'AUTH-04-C: PRE-SESSION Firebase-authenticated — the caller presents a verified Firebase ID token, which the service verifies with checkRevoked, and holds NO Inventory AI session by definition (a session is minted only by the exchange above, and this flow exists precisely for an identity that is verified but has no tenant yet). That is why there is no requireAuth and no permission to name: every role in this application would be unknown here, and the identity is the uid of the VERIFIED token inside the service, never a body field. PUBLIC is the no-requireAuth classification, not a claim the endpoint is unauthenticated. Rate-limited per IP',
  },
  {
    route: 'GET /api/auth/invitation',
    why: 'invitation-based onboarding: reads ONE invitation by its emailed token, before the person has any account — that is what an invitation is for. It issues no session, writes nothing, and returns only the invited address, role, business name and expiry; the address is the invitee’s own, and holding the 256-bit token is the only way to read it. The token travels as a query parameter so the access log (which records the path only) never contains it. Rate-limited per IP',
  },
  {
    route: 'POST /api/auth/email-verification/confirm',
    why: 'AUTH-04-C: PRE-SESSION Firebase-authenticated — the same boundary as the request route (a verified Firebase ID token is checked inside the service with checkRevoked; no Inventory AI session exists and no requireAuth applies), and confirmation CREATES no session and issues no JWT: it sets Firebase emailVerified and nothing else, so the session is still created only by the exchange above. The submitted code is the only caller-supplied value the validator reads, and it is never shape-checked here. PUBLIC is the no-requireAuth classification, not a claim the endpoint is unauthenticated. Rate-limited per IP',
  },
];

const AUTHENTICATED_ROUTES = [
  { route: 'GET /api/auth/me', why: 'reads only the caller’s own account' },
  { route: 'PATCH /api/auth/me', why: 'writes only the caller’s own name' },
  { route: 'POST /api/auth/change-password', why: 'changes only the caller’s own password' },
  {
    route: 'DELETE /api/auth/me',
    why: 'account deletion: deletes only the CALLER’S OWN account — the subject is req.user.id with no id in the request that could aim it elsewhere, re-authentication is required first, and no permission key could express "may delete my own account" without inventing an authorization concept the catalogue does not have',
  },
  { route: 'POST /api/auth/logout', why: 'Phase 26A: ends only the caller’s own session' },
  { route: 'GET /api/auth/sessions', why: 'Phase 26A: lists only the caller’s own sessions' },
  { route: 'DELETE /api/auth/sessions/:id', why: 'Phase 26A: ends only a session the caller owns' },
  {
    route: 'POST /api/auth/renew',
    why: 'AUTH-03: re-issues a token for the CALLER’S OWN session — the account is req.user.id and the session is req.auth.jti, both from the request’s own token, so there is no other session the request could name, and no permission key could express "may renew my own session" without inventing an authorization concept the catalogue does not have; a session is not a capability that could be granted',
  },
  {
    route: 'POST /api/auth/firebase/link',
    why: 'Phase 32H: attaches a verified Firebase identity to the CALLER’S OWN account — the account is req.user.id, so there is no other account the request could name, and no permission key could express "may link an identity" without inventing an authorization concept the catalogue does not have',
  },
  {
    route: 'POST /api/auth/credentials-changed',
    why: 'N-4: records a credential change on the CALLER’S OWN account and revokes that account’s sessions — the account is req.user.id and the identity must equal the uid already on it, so the request can only ever affect the account that authenticated it; no permission key could express "may record a credential change on my own account" without inventing an authorization concept the catalogue does not have, and a session is not a capability that could be granted',
  },
  { route: 'GET /api/categories', why: 'Phase 22 deferral: no categories.view key exists' },
  { route: 'GET /api/categories/:id', why: 'Phase 22 deferral: no categories.view key exists' },
  { route: 'GET /api/locations', why: 'Phase 22 deferral: no locations.view key exists' },
  { route: 'GET /api/locations/:id', why: 'Phase 22 deferral: no locations.view key exists' },
];

/**
 * Routes gated by requireRole(...) instead of a permission. EMPTY BY DESIGN:
 * there are none, and an owner decision is required to add one, because a
 * role-name gate is invisible to the permission catalogue.
 */
const ROLE_GATED_ROUTES = [];

/**
 * The middlewares that establish an authenticated request.
 *
 * There are two, and the second exists for exactly one route: `/api/auth/renew` must
 * accept the token it is replacing, which the client presents AFTER a `SESSION_EXPIRED`
 * refusal (AUTH-03 fix, 2026-10-22 — under plain `requireAuth` recovery could never
 * succeed). It verifies the same signature, issuer, audience, `jti`, live session, account
 * status and password-change rule; only `exp` is relaxed. It is still AUTHENTICATION, so
 * classifying it as PUBLIC would be a false alarm — but the list is closed: any OTHER
 * first handler is PUBLIC and must be declared, which is what keeps a new gate from
 * riding in unnoticed.
 */
const AUTH_MIDDLEWARES = [requireAuth, requireAuthForRenewal];

/** Classify one route from its real handler chain and its source declaration. */
function classifyRoute({ handlers, declaration }) {
  if (!handlers.length) return { kind: 'MALFORMED', why: 'route has no handlers' };
  const auth = AUTH_MIDDLEWARES.includes(handlers[0]) ? handlers[0] : null;
  if (!auth) return { kind: CLASS.PUBLIC, why: 'no authentication middleware' };
  if (handlers.length === 2) return { kind: CLASS.AUTHENTICATED, why: 'requireAuth + controller only' };

  const gate = handlers[1];
  if (gate === auth) return { kind: 'MALFORMED', why: 'authentication applied twice' };
  if (gate.length !== 3) {
    return { kind: 'MALFORMED', why: 'second handler is not a (req, res, next) middleware' };
  }
  // The closure is identity-opaque (see Phase 22), so the declaration is the
  // only way to tell WHICH gate this is.
  if (declaration.includes('requireRole(')) {
    return { kind: CLASS.ROLE_GATED, why: 'role-name gate' };
  }
  if (declaration.includes('requirePermission(')) {
    return { kind: CLASS.GATED, why: 'permission gate' };
  }
  // A RATE LIMITER IS NOT AN AUTHORIZATION GATE. `requireAuth, create…Limiter(…),
  // controller` carries no permission and no role, so it is AUTHENTICATED
  // (AUTH-03's POST /api/auth/renew is the first such route). The count must match
  // EXACTLY: every non-auth, non-controller middleware in the chain has to be a
  // recognised limiter, so an unknown middleware smuggled in beside a limiter
  // still fails as UNGATED instead of riding along into an exempt bucket.
  const limiterCount = (declaration.match(LIMITER_FACTORY) ?? []).length;
  if (limiterCount === handlers.length - 2) {
    return { kind: CLASS.AUTHENTICATED, why: 'requireAuth + rate limiter only' };
  }
  return { kind: 'UNGATED', why: 'a middleware is present but no gate is named in the declaration' };
}

/** The declaration statement for one route, whitespace-normalised. */
function declarationOf(source, owner, method, routePath) {
  const text = source.replace(/\s+/g, ' ');
  const start = text.indexOf(`${owner}.${method.toLowerCase()}('${routePath}',`);
  if (start === -1) return null;
  const end = text.indexOf(';', start);
  return text.slice(start, end === -1 ? undefined : end);
}

const AUTH_LIMITS = { loginAccount: 5, loginIp: 20, register: 5 };

// The mount table is read from app.js rather than hard-coded, so a router added
// to the app is covered automatically — it cannot be mounted and forgotten.
const APP_SRC = readSrc('app.ts');

const ROUTE_FILE_BY_IDENT = new Map(
  [
    ...APP_SRC.matchAll(
      /import\s+(?:\{\s*([A-Za-z0-9_$]+)\s*\}|([A-Za-z0-9_$]+))\s+from\s+'\.\/routes\/([A-Za-z0-9_.-]+)'/g
    ),
  ].map((m) => [m[1] || m[2], m[3]])
);

const MOUNTS = [...APP_SRC.matchAll(/app\.use\('(\/api\/[^']*)',\s*([A-Za-z0-9_$]+)/g)].map((m) => ({
  prefix: m[1],
  ident: m[2],
  file: ROUTE_FILE_BY_IDENT.get(m[2]),
}));

/** Load a mounted router, invoking its factory when it is one (auth.routes.js). */
async function loadRouter(file) {
  const mod = await import(pathToFileURL(path.join(ROUTES_DIR, file)).href);
  const factory = Object.entries(mod).find(
    ([name, value]) => /^create[A-Za-z0-9]*Router$/.test(name) && typeof value === 'function'
  );
  return factory ? factory[1]({ limits: AUTH_LIMITS }) : mod.default;
}

/** Every route reachable through the app's mount table, with its handler chain. */
async function collectRoutes() {
  const routes = [];
  for (const { prefix, ident, file } of MOUNTS) {
    assert.ok(file, `app.js mounts ${prefix} via "${ident}", which no routes/ import provides`);
    const router = await loadRouter(file);
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const routePath = layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        const full = `${method.toUpperCase()} ${prefix}${routePath === '/' ? '' : routePath}`;
        routes.push({
          route: full,
          handlers: layer.route.stack.map((s) => s.handle),
          declaration: declarationOf(source, 'router', method, routePath),
        });
      }
    }
  }

  // Routes registered directly on the app (app.get('/'), and anything a future
  // phase adds the same way) are not behind a mount, so walk the app itself.
  const app = (await import('../src/app.ts')).createApp({ requestLogging: false, authLimits: AUTH_LIMITS });
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({
        route: `${method.toUpperCase()} ${routePath}`,
        handlers: layer.route.stack.map((s) => s.handle),
        declaration: declarationOf(APP_SRC, 'app', method, routePath),
      });
    }
  }

  return routes;
}

const ROUTES = await collectRoutes();
const BY_ROUTE = new Map(ROUTES.map((r) => [r.route, r]));

const declared = (list) => list.map((entry) => entry.route);

// ---------------------------------------------------------------------------
// 23D — the client error-code contract
// ---------------------------------------------------------------------------

/**
 * Codes the server can put on an error response. Three real emission positions:
 *   1. `new ApiError(status, message, CODE)` — the third argument;
 *   2. `this.code = CODE` — a custom error class (services/ai/aiErrors.js);
 *   3. `code: CODE` — a response body written directly (the rate limiters).
 * An IDENTIFIER argument is resolved through the module-level string constants;
 * an identifier that resolves to nothing is a pass-through (`this.code = code`
 * in the ApiError base class), not an emission, and is skipped.
 */
function serverErrorCodes(sources) {
  const constants = new Map();
  for (const { text } of sources) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/g)) {
      constants.set(m[1], m[2]);
    }
  }

  const resolve = (raw) => {
    const arg = raw.trim();
    if (/^'[^']*'$/.test(arg) || /^"[^"]*"$/.test(arg)) return arg.slice(1, -1);
    return constants.has(arg) ? constants.get(arg) : null;
  };

  /** Top-level arguments of every `new ApiError(` call (quote-aware paren scan). */
  const apiErrorArgs = (text) => {
    const out = [];
    const needle = 'new ApiError(';
    let i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
      let depth = 1;
      let j = i + needle.length;
      let current = '';
      let quote = null;
      const args = [];
      for (; j < text.length && depth > 0; j++) {
        const c = text[j];
        if (quote) {
          current += c;
          if (c === quote && text[j - 1] !== '\\') quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          quote = c;
          current += c;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
          depth--;
          if (!depth) break;
        }
        if (c === ',' && depth === 1) {
          args.push(current);
          current = '';
          continue;
        }
        current += c;
      }
      args.push(current);
      out.push(args);
      i = j;
    }
    return out;
  };

  const codes = new Set();
  const add = (value) => {
    if (value !== null && value !== '') codes.add(value);
  };

  for (const { text } of sources) {
    const flat = text.replace(/\s+/g, ' ');
    for (const args of apiErrorArgs(flat)) {
      if (args.length >= 3) add(resolve(args[2]));
    }
    for (const m of text.matchAll(/this\.code\s*=\s*([A-Za-z0-9_$.]+|'[^']*'|"[^"]*")/g)) {
      add(resolve(m[1]));
    }
    for (const m of text.matchAll(/\bcode:\s*([A-Za-z0-9_$.]+|'[^']*'|"[^"]*")/g)) {
      add(resolve(m[1]));
    }
  }

  return codes;
}

/** Every error code the mobile client compares against. */
function clientErrorCodes(sources) {
  const codes = new Map();
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\.code\s*[!=]==?\s*'([^']*)'/g)) {
      if (!codes.has(m[1])) codes.set(m[1], new Set());
      codes.get(m[1]).add(file);
    }
  }
  return codes;
}

/**
 * Every error code the mobile client constructs itself (`new ApiError(status, CODE)`).
 * A code the client invents — `NETWORK_TIMEOUT` when its own request budget expires — is
 * not a server code, so 23D must not require the server to emit it. The exemption is
 * measured from the source rather than listed here, so renaming a client code still
 * leaves it unmatched against a server code the client no longer branches on.
 */
function clientEmittedCodes(sources) {
  const codes = new Set();
  for (const { text } of sources) {
    for (const m of text.matchAll(/new ApiError\(\s*[^,()]+,\s*'([^']*)'/g)) {
      codes.add(m[1]);
    }
  }
  return codes;
}

/** Client codes the server cannot emit and the client does not construct itself. */
function unmatchedClientCodes(serverCodes, clientCodes, clientEmitted = new Set()) {
  return [...clientCodes.keys()]
    .filter((code) => !serverCodes.has(code) && !clientEmitted.has(code))
    .sort();
}

const SERVER_SOURCES = walkSourceFiles(SRC_DIR, { extensions: SOURCE_EXTENSIONS }).map((file) => ({
  file: path.relative(SRC_DIR, file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

const MOBILE_SOURCES = walkSourceFiles(MOBILE_DIR, {
  extensions: COMPONENT_EXTENSIONS,
  skipDirs: MOBILE_SKIP_DIRS,
})
  .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
  .concat(
    walkSourceFiles(MOBILE_DIR, { extensions: SOURCE_EXTENSIONS, skipDirs: MOBILE_SKIP_DIRS }).map((file) => ({
      file,
      text: fs.readFileSync(file, 'utf8'),
    }))
  )
  .map((entry) => ({ file: path.relative(REPO_ROOT, entry.file).split(path.sep).join('/'), text: entry.text }));

// ===========================================================================
// Guards
// ===========================================================================

unitSuite('Phase 23 — authorization contract completion', () => {
  // -------------------------------------------------------------------------
  describe('23A — the mobile RBAC mirror matches the server matrix', () => {
    it('exposes the same roles, catalogue and grants as constants/roles.js', () => {
      assert.ok(fs.existsSync(MIRROR_PATH), `the RBAC mirror is missing: ${MIRROR_PATH}`);
      const drift = mirrorDrift(
        { ROLES, PERMISSIONS, ROLE_PERMISSIONS, ROLE_VALUES },
        {
          ROLES: mirror.ROLES,
          PERMISSIONS: mirror.PERMISSIONS,
          ROLE_PERMISSIONS: mirror.ROLE_PERMISSIONS,
          ROLE_VALUES: Object.values(mirror.ROLES ?? {}),
        }
      );
      assert.deepEqual(
        drift,
        [],
        'mobile/lib/permissions.js has drifted from server/src/constants/roles.js. The backend is the ' +
          'security boundary, so the server matrix is authoritative — update the mirror to match it. ' +
          `Divergences: ${drift.join(' | ')}`
      );
    });

    it('keeps the mirror free of permissions the catalogue does not define', () => {
      const catalogue = new Set(Object.values(PERMISSIONS));
      const orphans = Object.entries(mirror.PERMISSIONS ?? {}).filter(([, v]) => !catalogue.has(v));
      assert.deepEqual(
        orphans,
        [],
        `the mirror declares permission value(s) absent from the catalogue: ${orphans.map(([k]) => k).join(', ')}`
      );
    });

    it('mirrors every role grant exactly, with no extra or missing capability', () => {
      for (const role of ROLE_VALUES) {
        const server = [...ROLE_PERMISSIONS[role]].sort();
        const client = [...(mirror.ROLE_PERMISSIONS?.[role] ?? [])].sort();
        assert.deepEqual(
          client,
          server,
          `${role} differs between the server matrix and the mobile mirror — a divergence here makes the ` +
            'app show or hide an action that the server disagrees about'
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('23B — every route is classified', () => {
    it('classifies each mounted route into exactly one declared bucket', () => {
      assert.ok(ROUTES.length > 0, 'no routes were discovered — the mount-table scan is broken');

      // Anchors: if discovery silently stops working these fail with an obvious
      // cause instead of every route passing by absence.
      for (const route of ['GET /api/health', 'POST /api/ai/chat', 'GET /api/products']) {
        assert.ok(BY_ROUTE.has(route), `route discovery missed ${route} — the scan is broken, not the route`);
      }
      // A degenerate classifier must not pass by classifying everything PUBLIC.
      // If the requireAuth identity check or the declaration scan broke, every
      // route would fall into PUBLIC and be reported as an undeclared exemption —
      // but only if PUBLIC classification is itself being reached honestly.
      const gatedCount = ROUTES.filter((r) => classifyRoute(r).kind === CLASS.GATED).length;
      assert.ok(
        gatedCount > 0,
        'no route classified as PERMISSION_GATED — the classifier is degenerate, so this test proves nothing'
      );

      const publicSet = new Set(declared(PUBLIC_ROUTES));
      const authSet = new Set(declared(AUTHENTICATED_ROUTES));
      const roleSet = new Set(declared(ROLE_GATED_ROUTES));

      const unclassified = [];
      const misdeclared = [];

      for (const entry of ROUTES) {
        const { kind, why } = classifyRoute(entry);

        if (kind === 'MALFORMED' || kind === 'UNGATED') {
          unclassified.push(`${entry.route} — ${why}`);
          continue;
        }

        const declaredAs =
          kind === CLASS.GATED
            ? null
            : { [CLASS.PUBLIC]: publicSet, [CLASS.AUTHENTICATED]: authSet, [CLASS.ROLE_GATED]: roleSet }[kind];

        if (kind === CLASS.GATED) {
          // Gated routes must not ALSO be declared as exemptions.
          if (publicSet.has(entry.route) || authSet.has(entry.route) || roleSet.has(entry.route)) {
            misdeclared.push(`${entry.route} is permission-gated but declared as an exemption`);
          }
          continue;
        }

        if (!declaredAs.has(entry.route)) {
          unclassified.push(
            `${entry.route} — ${kind} (${why}) but not declared. Add it to the matching list with a reason.`
          );
        }
      }

      assert.deepEqual(
        unclassified,
        [],
        'route(s) whose authorization is not accounted for. Either gate the route with a permission, or ' +
          `declare it as a public/authenticated/role-gated exemption with a reason: ${unclassified.join(' | ')}`
      );
      assert.deepEqual(misdeclared, [], misdeclared.join(' | '));
    });

    it('★ the expiry-relaxing renewal authentication is used by /renew and nowhere else', () => {
      const renewalAuthenticated = ROUTES.filter(
        (r) => Array.isArray(r.handlers) && r.handlers[0] === requireAuthForRenewal
      ).map((r) => r.route);

      assert.deepEqual(
        renewalAuthenticated,
        ['POST /api/auth/renew'],
        'only renewal may accept an expired token, and it must be classified as AUTHENTICATED'
      );
      assert.equal(
        classifyRoute(BY_ROUTE.get('POST /api/auth/renew')).kind,
        CLASS.AUTHENTICATED,
        'renewal is authentication, not a public route'
      );
      // Control: the list of accepted authentication middlewares did not become "anything",
      // so an unknown first handler is still PUBLIC and must be declared.
      const foreign = classifyRoute({
        handlers: [(req, res, next) => next(), () => {}],
        declaration: "router.post('/sneaky', mysteryGate, c.post)",
      });
      assert.equal(foreign.kind, CLASS.PUBLIC, 'control: an unknown first handler is still PUBLIC');
    });

    it('declares no exemption that has stopped being true', () => {
      for (const { route } of [...PUBLIC_ROUTES, ...AUTHENTICATED_ROUTES, ...ROLE_GATED_ROUTES]) {
        const entry = BY_ROUTE.get(route);
        assert.ok(entry, `declared exemption ${route} no longer exists — remove the stale declaration`);
        const { kind } = classifyRoute(entry);
        assert.notEqual(kind, CLASS.GATED, `${route} is now permission-gated — remove its exemption`);
      }
    });

    it('exposes no route that is entirely unauthenticated beyond the declared public set', () => {
      const publicSet = new Set(declared(PUBLIC_ROUTES));
      const stray = ROUTES.filter((r) => classifyRoute(r).kind === CLASS.PUBLIC)
        .map((r) => r.route)
        .filter((route) => !publicSet.has(route));
      assert.deepEqual(
        stray,
        [],
        `route(s) reachable with no authentication at all: ${stray.join(', ')}. If that is intended, ` +
          'declare them in PUBLIC_ROUTES with a reason.'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('23C — requireRole is inert and cannot bypass the contract', () => {
    it('is used by no route, and every gated route names requirePermission', () => {
      const roleGated = ROUTES.filter((r) => classifyRoute(r).kind === CLASS.ROLE_GATED).map((r) => r.route);
      assert.deepEqual(
        roleGated,
        [],
        `route(s) gated by requireRole() instead of the permission catalogue: ${roleGated.join(', ')}. ` +
          'A role-name gate is invisible to the catalogue, so add the capability to constants/roles.js ' +
          'and gate on it with requirePermission, or declare it in ROLE_GATED_ROUTES with an owner decision.'
      );

      for (const entry of ROUTES) {
        if (classifyRoute(entry).kind !== CLASS.GATED) continue;
        assert.ok(
          entry.declaration && entry.declaration.includes('requirePermission('),
          `${entry.route} has a gate but its declaration names no permission — the route would bypass the ` +
            `contract guard. Declaration reads: ${entry.declaration}`
        );
      }
    });

    it('is still exported from authorize.js but referenced by no route module', () => {
      // Phase 23 pins requireRole as inert rather than deleting it (owner
      // decision 2). The export is real and tested by the Phase 03 suites.
      const authorizeSrc = readSrc('middlewares/authorize.js');
      assert.ok(
        authorizeSrc.includes('export function requireRole('),
        'requireRole is expected to remain exported from middlewares/authorize.js'
      );

      const offenders = listSourceFiles(ROUTES_DIR)
        .filter((f) => fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8').includes('requireRole'));
      assert.deepEqual(
        offenders,
        [],
        `route module(s) importing requireRole: ${offenders.join(', ')}. Use requirePermission with a ` +
          'catalogue key instead — a role-name gate bypasses the permission contract entirely.'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('23D — client error codes are codes the server emits', () => {
    it('emits at least the codes the client is known to branch on', () => {
      const emitted = serverErrorCodes(SERVER_SOURCES);
      for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'VALIDATION_ERROR', 'INSUFFICIENT_STOCK']) {
        assert.ok(
          emitted.has(code),
          `the emission scan found no live source for ${code} — the scan is broken, not the code`
        );
      }
    });

    it('branches on no error code the server cannot produce', () => {
      const emitted = serverErrorCodes(SERVER_SOURCES);
      const clientCodes = clientErrorCodes(MOBILE_SOURCES);
      assert.ok(
        clientCodes.size > 0,
        `no client error-code branches were found under mobile/ — the scan is broken, not the client`
      );

      const unmatched = unmatchedClientCodes(emitted, clientCodes, clientEmittedCodes(MOBILE_SOURCES));
      assert.deepEqual(
        unmatched,
        [],
        `the mobile client branches on error code(s) the server never emits: ${unmatched
          .map((code) => `${code} (${[...clientCodes.get(code)].join(', ')})`)
          .join(' | ')}. Renaming a server code silently downgrades a specific client message to a ` +
          'generic failure — keep the code, or update the client branch.'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('the guards can actually fail — in-memory negative tests', () => {
    const SERVER_MATRIX = { ROLES, PERMISSIONS, ROLE_PERMISSIONS, ROLE_VALUES };
    const clone = () => ({
      ROLES: { ...mirror.ROLES },
      PERMISSIONS: { ...mirror.PERMISSIONS },
      ROLE_PERMISSIONS: Object.fromEntries(
        Object.entries(mirror.ROLE_PERMISSIONS).map(([r, ps]) => [r, [...ps]])
      ),
      ROLE_VALUES: Object.values(mirror.ROLES),
    });

    it('detects a grant removed from the mirror', () => {
      const broken = clone();
      broken.ROLE_PERMISSIONS.STAFF = broken.ROLE_PERMISSIONS.STAFF.filter(
        (p) => p !== PERMISSIONS.INVENTORY_STOCK_IN
      );
      const drift = mirrorDrift(SERVER_MATRIX, broken);
      assert.equal(drift.length > 0, true, 'removing a STAFF grant from the mirror must be detected');
      assert.match(drift.join(' '), /STAFF/);
    });

    it('detects a grant added to the mirror', () => {
      const broken = clone();
      broken.ROLE_PERMISSIONS.STAFF = [...broken.ROLE_PERMISSIONS.STAFF, PERMISSIONS.AUDIT_VIEW];
      const drift = mirrorDrift(SERVER_MATRIX, broken);
      assert.equal(drift.length > 0, true, 'a capability the server does not grant must be detected');
      assert.match(drift.join(' '), /STAFF/);
    });

    it('detects a renamed permission key and a changed permission value', () => {
      const renamed = clone();
      renamed.PERMISSIONS.PRODUCTS_VIEW = 'products.read';
      assert.equal(mirrorDrift(SERVER_MATRIX, renamed).length > 0, true, 'a changed value must be detected');

      const dropped = clone();
      delete dropped.PERMISSIONS.DASHBOARD_VIEW;
      assert.match(mirrorDrift(SERVER_MATRIX, dropped).join(' '), /DASHBOARD_VIEW/);
    });

    it('detects a role the mirror does not know about', () => {
      const broken = clone();
      delete broken.ROLE_PERMISSIONS.MANAGER;
      assert.match(mirrorDrift(SERVER_MATRIX, broken).join(' '), /ROLE_PERMISSIONS roles differ/);
    });

    it('reports no drift for the real mirror', () => {
      assert.deepEqual(mirrorDrift(SERVER_MATRIX, clone()), []);
    });

    it('makes the real guard assertion fire on a diverged mirror', () => {
      // The tests above prove mirrorDrift() NOTICES divergence. This one proves
      // the assertion the 23A guard is actually built from FAILS when it does —
      // the same `assert.deepEqual(drift, [])` shape, driven with a perturbed
      // clone, must throw. Without this, a guard whose assertion was wired up
      // wrongly could still look green.
      const broken = clone();
      broken.ROLE_PERMISSIONS.MANAGER = broken.ROLE_PERMISSIONS.MANAGER.filter(
        (p) => p !== PERMISSIONS.INVENTORY_VIEW
      );
      assert.throws(
        () => assert.deepEqual(mirrorDrift(SERVER_MATRIX, broken), []),
        /MANAGER/,
        'the 23A assertion must fail when the mirror and the server matrix diverge'
      );

      // And the unperturbed clone must NOT throw: the guard is not simply failing
      // everything.
      assert.doesNotThrow(() => assert.deepEqual(mirrorDrift(SERVER_MATRIX, clone()), []));
    });

    it('classifies an ungated route as unaccounted for', () => {
      const controller = () => {};
      // requireAuth + controller, with no declaration: an authenticated route
      // nobody declared must not be silently accepted.
      const authOnly = classifyRoute({ handlers: [requireAuth, controller], declaration: null });
      assert.equal(authOnly.kind, CLASS.AUTHENTICATED);

      // A gate whose declaration names no gate at all is the bypass this guard
      // exists to catch.
      const gate = (req, res, next) => next();
      const opaque = classifyRoute({
        handlers: [requireAuth, gate, controller],
        declaration: "router.get('/sneaky', requireAuth, mysteryGate, c.get)",
      });
      assert.equal(opaque.kind, 'UNGATED', 'a gate naming no gate must not be reported as gated');

      // requireRole must be recognised as a role gate, not accepted as a
      // permission gate.
      const roleGated = classifyRoute({
        handlers: [requireAuth, gate, controller],
        declaration: "router.get('/owners-only', requireAuth, requireRole(ROLES.OWNER), c.get)",
      });
      assert.equal(roleGated.kind, CLASS.ROLE_GATED);
    });

    it('treats a rate limiter as non-gating but refuses an unnamed middleware beside it', () => {
      const controller = () => {};
      const limiter = (req, res, next) => next();

      // requireAuth + limiter + controller carries no permission and no role, so
      // it is AUTHENTICATED — a limiter bounds frequency, not authority.
      const withLimiter = classifyRoute({
        handlers: [requireAuth, limiter, controller],
        declaration:
          "router.post('/renew', requireAuth, createSessionRenewLimiter(limits), renew)",
      });
      assert.equal(withLimiter.kind, CLASS.AUTHENTICATED);

      // A limiter must NOT launder an unknown middleware into the AUTHENTICATED
      // bucket: two middlewares, only one of which is a limiter, stays UNGATED.
      const smuggled = classifyRoute({
        handlers: [requireAuth, limiter, limiter, controller],
        declaration:
          "router.post('/sneaky', requireAuth, createSessionRenewLimiter(limits), mysteryGate, c.post)",
      });
      assert.equal(smuggled.kind, 'UNGATED');
    });

    it('refuses a role-gated route that is not declared', () => {
      const gate = (req, res, next) => next();
      const entry = {
        route: 'GET /api/example',
        handlers: [requireAuth, gate, () => {}],
        declaration: "router.get('/example', requireAuth, requireRole('OWNER'), c.get)",
      };
      const { kind } = classifyRoute(entry);
      assert.equal(kind, CLASS.ROLE_GATED);
      // ROLE_GATED_ROUTES is empty, so this route would be reported unclassified.
      assert.equal(declared(ROLE_GATED_ROUTES).includes(entry.route), false);
    });

    it('detects a client error code neither the server nor the client emits', () => {
      const emitted = serverErrorCodes(SERVER_SOURCES);
      const selfEmitted = clientEmittedCodes(MOBILE_SOURCES);
      const fake = new Map([['NO_SUCH_CODE', new Set(['mobile/lib/example.js'])]]);
      assert.deepEqual(unmatchedClientCodes(emitted, fake, selfEmitted), ['NO_SUCH_CODE']);

      // The client's own transport budget code needs no server emission — but the
      // exemption must be seen in the source, not assumed.
      assert.ok(
        selfEmitted.has('NETWORK_TIMEOUT'),
        'the client is expected to construct NETWORK_TIMEOUT when its own budget expires'
      );
      const ownCode = new Map([['NETWORK_TIMEOUT', new Set(['mobile/components/AiChat.tsx'])]]);
      assert.deepEqual(unmatchedClientCodes(emitted, ownCode, selfEmitted), []);
      assert.deepEqual(
        unmatchedClientCodes(emitted, ownCode),
        ['NETWORK_TIMEOUT'],
        'without a client construction, the same code must still be required from the server'
      );

      const real = clientErrorCodes(MOBILE_SOURCES);
      assert.deepEqual(unmatchedClientCodes(emitted, real, selfEmitted), []);
    });
  });
});
