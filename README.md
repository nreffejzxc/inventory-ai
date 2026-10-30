# Inventory AI

An AI-assisted inventory management system for Android and iOS: products, stock movements, locations,
suppliers, purchase orders, transfers, an audit trail and a **read-only** assistant.

| Layer | Technology |
| --- | --- |
| Mobile | React Native + Expo + Expo Router (TypeScript) |
| Backend | Node.js + Express (TypeScript, ES Modules, **no build step**) |
| Database | MongoDB Atlas + Mongoose |
| Identity | Firebase Authentication (ID token exchanged once for an Inventory AI JWT) |
| Mail | Brevo, behind a provider-agnostic server boundary (verification + reset codes) |
| AI | OpenRouter, one shipped provider, server-side only |

`docs/SYSTEM_SPECIFICATION.md` is the source of truth. Work is organised in phases —
`docs/DEVELOPMENT_ROADMAP.md` is the record. **Not a programmer?** Read
[`docs/guides/`](docs/guides/README.md) instead; those guides explain every command and term.

## Repository layout

```text
/
├── CLAUDE.md      project rules for AI assistants
├── docs/          specification, roadmap, security records, evidence, guides
├── mobile/        Expo app (own package.json + lockfile)
└── server/        Express API (own package.json + lockfile)
```

`mobile/` and `server/` are independent workspaces. There is intentionally no root `package.json`.

## Prerequisites

- **Node.js ≥ 24** (`.nvmrc` pins it). The server runs its `.ts` sources directly through Node's
  type stripping; an older runtime cannot start it.
- npm, Git. `adb` and an Android device for on-phone work.

```sh
node --version && npm --version && git --version
```

## Backend

```sh
cd server
npm install
cp .env.example .env      # then fill in the values
npm start                 # http://localhost:4000
npm run dev               # same, with --watch
```

`NODE_ENV` must be exactly `development`, `test` or `production`. An unset or misspelled value
(`prod`, `staging`) **refuses the boot** — it would otherwise select the development database and skip
the production checks. `GET /api/health` reports the resolved environment and the commit id.

```sh
npm run typecheck         # tsc --noEmit (the checker; nothing is emitted)
npm run lint
npm test                  # full suite (unit + database)
npm run test:unit         # no database needed
npm run test:db           # database-backed suites only
npm run check:extensions  # module-graph guards
npm run check:specifiers
```

Database-backed suites need `MONGODB_URI`. They run against `inventoryai_test_db` only; the runner
refuses any other database.

### Production configuration (Render)

The service is `ai-inventory`, `rootDir: server`, Auto-Deploy **On Commit**. Render receives every
push but deploys **only when a file under `server/` changed** — a docs- or mobile-only push skipping
the deploy is correct behaviour, not a broken connection.

Values live in the Render dashboard and the EAS dashboard; the repository holds the **names**
(`server/.env.example`). A missing variable in the repo is not evidence it is unset.

| Variable | Requirement |
| --- | --- |
| `MONGODB_URI`, `JWT_SECRET` (≥ 32 chars) | **required** — boot exits without them |
| `JWT_EXPIRES_IN`, `JWT_ISSUER`, `JWT_AUDIENCE` | optional; `1h`, `inventory-ai`, `inventory-ai-api` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` (preferred) or `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | **all-or-nothing**; none = Firebase disabled, partial = boot fails |
| `EMAIL_VERIFICATION_CODE_PEPPER` | required for the six-digit verification and in-app reset-code flows; those routes answer 503 without it |
| `AI_PROVIDER` + `OPENROUTER_API_KEY` + `OPENROUTER_BASE_URL` + `AI_MODEL_OPENROUTER` | AI is disabled when unset; the model has **no default** |
| `AI_FALLBACK_MODELS_OPENROUTER`, `AI_MODEL_FAILURE_THRESHOLD`, `AI_MODEL_COOLDOWN_MS`, `AI_MODEL_HEALTH_TTL_MS`, `AI_QUOTA_BLOCK_MS`, `AI_ATTEMPT_MAX_MS`, `AI_HEALTH_ALERT_EMAIL` (+ `AI_HEALTH_WATCH_*`) | optional failover, health and alerting tuning |
| `MAIL_PROVIDER`, `MAIL_FROM`, `BREVO_API_KEY`, `PASSWORD_RESET_URL` | optional; missing mail config disables recovery (503); `PASSWORD_RESET_URL` is only for the emailed-link path |
| `AUTH_*_RATE_LIMIT_*` (36 variables, 18 pairs) | optional; the documented defaults are the production values |
| `TRUST_PROXY` | **effectively required** — set `1` |
| `CORS_ORIGINS`, `JSON_BODY_LIMIT`, `SHUTDOWN_TIMEOUT_MS`, `LOG_REQUESTS` | optional; defaults are the production values |

**`TRUST_PROXY=1` is not cosmetic.** Render terminates TLS at a proxy; without it every request
carries the proxy address and all per-IP limiters collapse into one bucket — 60 failed logins
anywhere would answer 429 to every member. Set the exact hop count; never `true` (an unbounded
forwarded chain lets anyone spoof `X-Forwarded-For`). A production boot that omits it logs a
`[config] warning:` naming the consequence.

### Data posture

Never hard-delete products: the lifecycle is `ACTIVE` ↔ `ARCHIVED`, with `ARCHIVED` terminal and its
history retained. Inventory never goes negative; every movement writes its transaction, atomically.
Every business-owned row is filtered by the `businessId` of the authenticated user, never by one a
client sends.

## Mobile

```sh
cd mobile
npm install
cp .env.example .env      # optional: set EXPO_PUBLIC_API_URL
npx expo start            # needs a DEVELOPMENT BUILD — Expo Go cannot run this app
```

- `EXPO_PUBLIC_API_URL` defaults to `http://10.0.2.2:4000` on Android and `http://localhost:4000`
  elsewhere. Point it at the deployed API for a real build.
- Install React Native packages with `npx expo install`, not `npm install`.
- The app is client-only: it never reaches MongoDB and holds no database or AI credential. Only the
  JWT is persisted (Expo SecureStore); role and status are re-read from the server.
- Client-side role gating only hides actions — the server enforces every permission.

```sh
npm run typecheck && npm run lint && npm test
npm run check:build-env -- --profile production --live   # EAS variables + native pins
npm run check:aab -- <path/to.aab>                       # store-artifact gate
npm run check:ota                                        # publish preflight
```

**Over-the-air updates.** `runtimeVersion` follows `expo.version`, so JavaScript-only changes publish
and native changes need a build plus a version bump. Publishing:

```sh
npx eas-cli update --channel production --environment production --platform android -m "what changed"
```

Run `npm run check:ota` first — it refuses a dirty tree, a moved native module, or a runtime with no
binary. Full procedure, rollback and troubleshooting:
[`docs/guides/7-over-the-air-updates.md`](docs/guides/7-over-the-air-updates.md).

## Environment and secrets

- `server/.env` and `mobile/.env` are git-ignored; the tracked `.env.example` files carry **names
  only**. `dotenv` reads from `server/`, so a root-level `.env` is read by nothing.
- `mobile/google-services.json` and `GoogleService-Info.plist` are **not committed**. An EAS build
  receives them as file environment variables (`GOOGLE_SERVICES_JSON`, `GOOGLE_SERVICE_INFO_PLIST`).
- `mobile/.easignore` is the union of `mobile/.gitignore` and the relevant root rules — EAS uses it
  **instead of** `.gitignore`. Keep the two in step.
- `mobile/android/` and `mobile/ios/` are not committed (Expo Continuous Native Generation).
- `.freebuff/`, `.claude/settings.local.json`, `.smoke/` and `.scratch/` are local-only.
- CI runs `scripts/check-secrets.mjs` on every change; GitHub secret scanning and push protection
  are also enabled on this public repository.
- Two Dependabot advisories remain on `mobile/package-lock.json` — `zod` (high) and `deepmerge`
  (low) — and have **no safe upgrade**: neither reaches a shipped bundle and no patched release is
  reachable inside its consumer's declared range. The third, `node-forge` (high), was fixed in the
  lockfile on 2026-10-30 by an in-range bump to 1.4.2. `node scripts/check-upgrade-watches.mjs` is the
  read-only report that says whether a gate has opened since; the reasoning is in
  [`docs/SECURITY_DEPENDENCY_DECISIONS.md`](docs/SECURITY_DEPENDENCY_DECISIONS.md). Do not force
  versions with `overrides`.

## Documentation

| Read this | For |
| --- | --- |
| [`docs/guides/`](docs/guides/README.md) | everyday tasks: run it, use the phone, test accounts, every command, OTA, Play submission |
| [`docs/SYSTEM_SPECIFICATION.md`](docs/SYSTEM_SPECIFICATION.md) | what the system must do |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | tokens, components, theme rules |
| [`docs/AUTH_SECURITY_MASTER_CHECKLIST.md`](docs/AUTH_SECURITY_MASTER_CHECKLIST.md) | authentication and authorization guarantees |
| [`docs/SECURITY_DEPENDENCY_DECISIONS.md`](docs/SECURITY_DEPENDENCY_DECISIONS.md) | accepted dependency advisories and why |
| [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md) | **the archive**: one dated record per increment |
| [`docs/evidence/`](docs/evidence) | device and production measurements |

**You do not need to read the roadmap to work on this project.** It is the historical record, written
for audits. Current state, open items and the next step are what the newest roadmap section and the
guides describe; start there.

## Status

V1 is feature-complete and running in production testing. Known open items — iOS verification and the
Play release — are tracked in the roadmap's latest section; push notifications and export/reporting
are future scope, not built. Nothing in this README is a promise about a date.
