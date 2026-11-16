/**
 * Explicit CORS allow-list (Phase 07C / M3).
 *
 * This API is consumed by native mobile clients, which send NO Origin header
 * and never need CORS. Browser-based web clients would need a CORS grant, but
 * none exist in V1 — so the default is to allow no browser origin at all.
 *
 * When an operator later adds a web admin/app, they configure the exact origins
 * in CORS_ORIGINS (comma-separated) and ONLY those origins receive a grant:
 *
 *   - No Origin header (native mobile, curl, same-origin)   -> passes through,
 *     no CORS headers applied.
 *   - Allow-listed Origin (browser)                          -> ACAO set to that
 *     exact origin (never '*').
 *   - Any other Origin                                       -> no CORS grant
 *     (browser preflight/simple requests are not permitted to read responses).
 *
 * CORS is a browser-enforcement mechanism, NOT authentication: an unlisted
 * origin's request still reaches the server (it simply cannot read the
 * response). JWT + RBAC + business isolation on every protected route remain
 * the real security boundary (see CLAUDE.md §4/§5).
 */

import cors from 'cors';

/** Case-sensitive exact compare, ignoring a single trailing slash. */
function normalizeOrigin(origin: string) {
  return String(origin).trim().replace(/\/+$/, '');
}

/**
 * Build the CORS middleware for a fixed allow-list of origins.
 *
 * `origins` is declared `readonly string[]` rather than left to inference: the
 * default `[]` used to infer `never[]`, so this function's public contract said
 * "an empty array and nothing else". Its one real caller passes the configured
 * allow-list — `createCors(corsOrigins)` in `app.ts` — and that call is
 * type-checked, so the declared parameter type is load-bearing rather than
 * merely documentation. Typing it states the contract the runtime already has;
 * nothing about the behaviour changes, and `readonly` is the honest modifier
 * because the function only ever maps over the list.
 */
export function createCors(origins: readonly string[] = []) {
  const allowed = new Set(origins.map(normalizeOrigin));

  return cors({
    // The dedicated platform console authenticates with an HttpOnly cookie, so
    // credentialed CORS is required for the exact allow-listed origins. Allowing
    // credentials does not widen the allow-list: an unlisted Origin still gets
    // no grant at all, and the platform cookie is additionally Origin+CSRF gated.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // No fixed `allowedHeaders`: the cors package reflects the headers the
    // browser actually requests (including X-Platform-CSRF and
    // X-Platform-Console) for an allow-listed origin. A fixed list would send
    // the whole list on every preflight instead of the requested subset and
    // changed the established response contract.
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
    optionsSuccessStatus: 204,
    origin(requestOrigin, callback) {
      // Native mobile / no-Origin or disallowed: grant nothing. cors then calls
      // next() WITHOUT applying any Access-Control-* header, so no-Origin flows
      // keep working and browsers from unlisted origins are blocked.
      if (!requestOrigin || !allowed.has(normalizeOrigin(requestOrigin))) {
        return callback(null, false);
      }
      // Reflect ONLY the allow-listed origin that is actually making the
      // request (cors resolves origin === true to the request's own Origin).
      return callback(null, true);
    },
  });
}

export default createCors;
