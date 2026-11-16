import express from 'express';
import helmet from 'helmet';

import env from './config/env.ts';
import { INSTANCE_ID, INSTANCE_ID_HEADER } from './config/instanceIdentity.ts';
import { recordResponse } from './config/operationalCounters.ts';
import { createCors } from './middlewares/cors.ts';
import { isPlatformAuthConfigured } from './config/platformJwt.ts';
import { platformConsoleOrigin } from './config/platformSecurity.ts';
import requestId from './middlewares/requestId.ts';
import requestLogger from './middlewares/httpLogger.ts';
import recordFeatureUsage from './middlewares/featureUsage.ts';
import healthRoutes from './routes/health.routes.ts';
import { createAuthRouter } from './routes/auth.routes.ts';
import authActionRoutes from './routes/authAction.routes.ts';
import privacyRoutes from './routes/privacy.routes.ts';
import termsRoutes from './routes/terms.routes.ts';
import inviteRoutes from './routes/invite.routes.ts';
import accountDeletionRoutes from './routes/accountDeletion.routes.ts';
import userRoutes from './routes/users.routes.ts';
import invitationRoutes from './routes/invitations.routes.ts';
import categoryRoutes from './routes/categories.routes.ts';
import locationRoutes from './routes/locations.routes.ts';
import supplierRoutes from './routes/suppliers.routes.ts';
import purchaseOrderRoutes from './routes/purchase-orders.routes.ts';
import productRoutes from './routes/products.routes.ts';
import inventoryRoutes from './routes/inventory.routes.ts';
import dashboardRoutes from './routes/dashboard.routes.ts';
import platformRoutes from './routes/platform.routes.ts';
import platformConsoleRoutes from './routes/platformConsole.routes.ts';
import platformAccessGate from './middlewares/platformAccessGate.ts';
import aiRoutes from './routes/ai.routes.ts';
import auditRoutes from './routes/audit.routes.ts';
import notFound from './middlewares/notFound.ts';
import errorHandler from './middlewares/errorHandler.ts';
import type { AuthRateConfig } from './middlewares/rateLimit.ts';

/**
 * The knobs `createApp` can be built with. Every one has a production default
 * read from `env` (or, for `requestLogging`, from `LOG_REQUESTS`), so the
 * shipped call is `createApp()` and tests override only what they must.
 *
 * `authLimits` names the EXISTING `AuthRateConfig` contract rather than
 * restating it: `createAuthRouter` already accepts exactly `Partial` of that
 * type, so this is the same shape the auth router validates against — not a
 * second copy that could drift.
 */
type AppOptions = {
  trustProxy?: number;
  corsOrigins?: readonly string[];
  jsonBodyLimit?: string;
  authLimits?: Partial<AuthRateConfig>;
  requestLogging?: boolean;
};

/**
 * Build a fully wired Express app. Exported as a factory so tests can exercise
 * the real middleware chain (headers, CORS, body limit, trust proxy, auth rate
 * limiters) deterministically, without mutating process.env. The module's
 * default export is the singleton the server boots (see index.ts).
 *
 * @param {object}  [options]
 * @param {number}  [options.trustProxy]    Reverse-proxy hops (Phase 07B/M4).
 * @param {string[]} [options.corsOrigins]  Explicit CORS allow-list (M3).
 * @param {string}  [options.jsonBodyLimit] express.json() body limit (L2).
 * @param {object}  [options.authLimits]    Auth rate-limiter overrides (tests).
 * @param {boolean} [options.requestLogging] Structured per-request access log
 *                                            (Phase 08A). Default: on unless
 *                                            LOG_REQUESTS=0.
 */
export function createApp({
  trustProxy = env.trustProxy,
  corsOrigins = env.corsOrigins,
  jsonBodyLimit = env.jsonBodyLimit,
  authLimits,
  requestLogging = process.env.LOG_REQUESTS !== '0',
}: AppOptions = {}) {
  const app = express();

  // H6: never advertise the framework. Express-level config, not per-route
  // header deletion (which Express would re-add on the next response anyway).
  app.disable('x-powered-by');

  // Phase 08A: correlation id FIRST so every downstream layer (rate limiters,
  // body parser, routes, error handler) runs under a stable req.requestId, and
  // every response — success or error — echoes X-Request-ID. The request access
  // log then records one structured line per completed request.
  app.use(requestId);
  app.use(requestLogger({ enabled: requestLogging }));

  // 2026-10-18: every response names the process that wrote it. This is what makes a stale server on the same
  // port detectable at all (see config/portGuard.ts) — a readiness probe answers identically from either process,
  // so the boot asks the port to say its own instance id and compares it with its own. It is an identity, not a
  // credential: nothing authorizes on it and it changes on every restart. Registered before any route so error
  // and 404 responses carry it too.
  app.use((_req, res, next) => {
    res.setHeader(INSTANCE_ID_HEADER, INSTANCE_ID);
    next();
  });

  // OPS-2: count every finished response, including the ones the error handler and
  // `notFound` produce. `finish` fires after the response is sent, so this can never delay
  // a response or change one — and it is the reason the counter sees 5xx answers at all,
  // which is the signal an outside watcher polls `/api/health` for. See
  // config/operationalCounters.ts for what is deliberately NOT published.
  app.use((_req, res, next) => {
    res.on('finish', () => recordResponse(res.statusCode));
    next();
  });

  // OPS-8 — durable feature presence, recorded after a successful response. It is
  // mounted before the routes so its `finish` listener is attached to every request;
  // the authenticated `req.user` it reads is filled in by `requireAuth` inside the
  // route, and a public or refused request records nothing.
  app.use(recordFeatureUsage);

  // M4: only trust a known number of reverse-proxy hops when explicitly
  // configured (TRUST_PROXY, numeric hop count). Default 0 = trust no proxy:
  // forwarded headers are ignored, so spoofed X-Forwarded-For cannot bypass
  // the IP-based auth rate limiters. See config/env.ts parseTrustProxy.
  if (trustProxy > 0) {
    app.set('trust proxy', trustProxy);
  }

  // H6: defense-in-depth security headers. This is a JSON API for native mobile
  // clients — no HTML documents are served, so the document-oriented controls
  // (Content-Security-Policy, Cross-Origin-Embedder-Policy) are disabled. The
  // remaining headers (nosniff, frame/opener isolation, HSTS, etc.) apply to
  // every response, health and auth included.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // M3: explicit browser CORS allow-list (see middlewares/cors.ts). Native
  // mobile sends no Origin and is unaffected; browsers only get a grant for
  // allow-listed origins — never '*'.
  //
  // PLAT-2: include the dedicated console origin only when the platform plane
  // is configured. The default is loopback; adding it to a deployment that has
  // no platform secret would widen the CORS allow-list for a console that
  // cannot authenticate. `createCors` grants credentials only to exact origins;
  // the platform middleware separately requires the console Origin AND CSRF.
  const platformCorsOrigins = isPlatformAuthConfigured() ? [platformConsoleOrigin()] : [];
  const resolvedCorsOrigins = [...new Set([...corsOrigins, ...platformCorsOrigins])];
  app.use(createCors(resolvedCorsOrigins));

  // L2: explicit JSON body-size cap. Oversized bodies are rejected with a
  // clean 413 before any route logic runs (see errorHandler bodyError mapping).
  app.use(express.json({ limit: jsonBodyLimit }));

  // Service info
  app.get('/', (req, res) => {
    res.json({ service: 'inventory-ai-server', status: 'ok' });
  });

  // PLAT-6 — the INTERNAL console shell. Every data request behind it still
  // requires the dedicated platform identity and capability. Keeping it on this
  // origin avoids a second paid service and the cross-origin cookie path
  // entirely. PLAT-7 adds the outer access gate that Render's free plan cannot
  // provide at the edge.
  app.use('/platform', platformAccessGate, platformConsoleRoutes);

  // API routes
  app.use('/api/health', healthRoutes);
  // The landing page for Firebase password-reset emails. Deliberately outside `/api`:
  // it is a browser-facing HTML page (2026-10-20, see pages/resetPasswordLink.ts), not
  // a JSON endpoint, and its path is the one configured in the Firebase console.
  app.use('/auth', authActionRoutes);
  // The public privacy policy (2026-10-24), also outside `/api` and for the same reason: it is an
  // HTML page a person or a store reviewer opens in a browser, at the address the Play listing
  // points to. Public by requirement — a policy behind a login cannot be read by someone deciding
  // whether to create an account.
  app.use('/privacy', privacyRoutes);
  // The public account-deletion page (2026-10-24), the web address Google Play's data-deletion
  // policy requires. Outside `/api` for the same reason: it is an HTML page, and it is public
  // because somebody who cannot sign in is exactly one of the people who needs to read it.
  app.use('/account-deletion', accountDeletionRoutes);
  // The public Terms of Use (2026-10-25). Same rules as the two pages above: outside `/api`, an
  // HTML page rather than JSON, and public because the terms that govern an account have to be
  // readable before one exists.
  app.use('/terms', termsRoutes);
  // The landing page an invitation email opens (2026-10-25). Outside `/api` and public for
  // the same reasons as the three pages above, with one of its own: the person following an
  // invitation does not have an account yet. It forwards the token to the app and redeems
  // nothing, so opening this URL on the wrong device costs nothing.
  app.use('/invite', inviteRoutes);

  // 2026-10-23 security audit — NO AUTH RESPONSE MAY BE STORED BY AN INTERMEDIARY.
  //
  // Bodies under this prefix carry credentials (an access token, a reset
  // authorization) or facts about an account (a 202 for a recovery request, a
  // 401 that names an invalidation). The reset LINK page already sets this for
  // itself (pages/resetPasswordLink.ts); this is the same rule for the JSON API,
  // applied once at the mount point so a new auth route inherits it instead of
  // having to remember it.
  //
  // `no-store` rather than `no-cache`: no-cache PERMITS storage and requires
  // revalidation, which still leaves a token written somewhere between this
  // process and the phone. `Pragma` is the HTTP/1.0 spelling, carried for
  // intermediaries that still read it. It is mounted before the router and
  // matches by prefix, so it runs for auth 404s and 429s as well as 2xxs.
  app.use('/api/auth', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  app.use('/api/auth', createAuthRouter({ limits: authLimits }));
  app.use('/api/users', userRoutes);
  // Invitation management (2026-10-25). A separate mount rather than a sub-path of
  // `/api/users` because an invitation is not a user yet: it has its own lifecycle, its
  // own collection and its own list. Bound to the same `users.manage` permission.
  app.use('/api/invitations', invitationRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/locations', locationRoutes);
  app.use('/api/suppliers', supplierRoutes);
  app.use('/api/purchase-orders', purchaseOrderRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  // PLAT-1 — Platform Operations is a SEPARATE access plane, not a tenant route.
  // It has its own credential store, signing secret, issuer/audience and session
  // collection; `requirePlatformAdmin` never reads a tenant `User` or session, and
  // `requireAuth` refuses every platform token. No customer-facing Operations
  // route or screen exists: the rejected pre-commit tenant draft was removed.
  app.use('/api/platform', platformAccessGate, platformRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/audit', auditRoutes);

  // Unknown routes -> structured 404
  app.use(notFound);

  // Centralized error handler (must be registered last)
  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;
