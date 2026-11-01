# Inventory AI — Project Instructions

**What this file is.** The working contract for anyone — human or agent — changing this repository:
the architecture rules, the security rules, and an index of every plan record. It is deliberately
short. Behaviour is specified in `docs/SYSTEM_SPECIFICATION.md`; history is in
`docs/DEVELOPMENT_ROADMAP.md`, and the index at the end of this file says where each record lives.

**Reading order if you are new:** `README.md` → `docs/README.md` → `docs/guides/1-run-on-your-laptop.md`
→ this file.

---

## 1. Project

Inventory AI is a multi-tenant, AI-assisted inventory management system for Android and iOS: products,
locations, stock movements, transfers, suppliers, purchase orders, a read-only AI assistant and an
audit trail — one tenant per business, isolated by `businessId` at every layer.

**V1 is complete and in production testing.** Mobile version `1.0.1`, runtime `1.0.1`, served by
`https://ai-inventory-l1mi.onrender.com`. The production database holds test data only; there are no
real customers yet, and the Play release has not been made.

`docs/SYSTEM_SPECIFICATION.md` is the primary source of truth for behaviour. Do not silently
contradict it. If an intentional change is needed: explain the conflict, propose the change, get
approval.

---

## 2. Technology Stack

### Mobile

React Native 0.88 · Expo SDK 58 · Expo Router · TypeScript. EAS builds (`development`,
`ios-simulator`, `preview`, `production`), `expo-updates` for over-the-air JavaScript, and continuous
native generation — `mobile/ios/` and `mobile/android/` do not exist and are not committed.

### Backend

Node.js **24** (pinned by `.nvmrc` and `engines.node`) · Express · TypeScript · REST API.

TypeScript-first, **no build step**: the server runs its `.ts` sources through Node's native type
stripping (`npm start` is `node src/index.ts`), so an older runtime cannot start it. `tsconfig.json`
sets `noEmit` and `erasableSyntaxOnly`, so `tsc` is purely a checker and non-strippable syntax is a
compile error rather than a runtime failure. `server/src` is **163** `.ts` modules (re-counted
2026-11-01) and exactly one intentionally deferred `.js` module,
`server/src/services/entitlement.service.js`; `docs/TS-MIGRATION-MANIFEST.md` records the migration
campaign.

### Database

MongoDB Atlas · Mongoose. Indexes are declared in the models and guarded by `phase-index-integrity`.

### Email

**Brevo only**, behind the provider-agnostic boundary in `server/src/services/mail/`
(`MAIL_PROVIDER`, `BREVO_API_KEY`). It sends the AUTH-04 six-digit verification codes, the AUTH-06
password-reset codes and invitations. Mail is server-side only; no provider credential reaches the
app.

### Authentication

- **Firebase Authentication** — the identity provider ("who is this person?"). Native email/password
  and **Google Sign-In** are implemented; **Facebook Login and Apple Sign-In are not**, and each needs
  an owner-approved phase.
- **JWT + server-side session records named by `jti`** — the Inventory AI application session.
- **bcrypt** — legacy password hashes for accounts that predate Firebase, on a retirement path.

Firebase identity and Inventory AI authorization are **separate systems**. A verified Firebase ID
token is exchanged **once** at `POST /api/auth/firebase/exchange` for an ordinary Inventory AI access
token; it never becomes the API bearer credential. `firebaseUid` is an **identity linkage field, not
an authorization source** — `businessId`, `role`, `status` and permissions always come from the
MongoDB `User`, loaded per request, and the exchange resolves a user by **`firebaseUid` only** (never
by email). `requireAuth` is deliberately unmodified by the registration flow: the gate is the
**registration ordering** — no `User`, no `Business`, no JWT and no session exist until the email is
verified.

Account linking exists (`POST /api/auth/firebase/link`); **unlinking does not** — it was removed
(Phase A / F-1, `6e2252f`) and Firebase disconnect was re-scoped into a password change. The locked
direction — Firebase as sole authentication authority while MongoDB keeps authorization — is recorded
in `docs/superpowers/specs/2026-09-18-firebase-auth-design.md` §14C. Nothing in the
application-owned password path has been removed yet; **invitation-based onboarding** (the hard
prerequisite) shipped, and existing admin-created password accounts still have to be migrated before
legacy login can be retired.

### AI

- Provider abstraction (the interface and the shared Anthropic wire layer) — **one shipped provider:
  OpenRouter**, selected by `AI_PROVIDER`, requiring `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` and
  `AI_MODEL_OPENROUTER`, with **no default model**. Claude and Gemini models are reachable through it
  by changing the model variable; their **direct provider implementations were removed** (AI-25), so
  `AI_PROVIDER=claude|gemini` is refused as unsupported. The retired AgentRouter gateway must not be
  reintroduced.
- AI credentials stay server-side.

---

## 3. Repository Structure

```text
/
├── CLAUDE.md
├── docs/
├── mobile/
├── server/
└── README.md
```

Backend code never goes in `mobile/`; mobile code never goes in `server/`. Keep concerns separated.

---

# 4. Mandatory Architecture Rules

These rules must always be respected.

### Database

MongoDB is the source of truth. The mobile application must NEVER connect directly to MongoDB.

```text
Correct:    Mobile → Backend → MongoDB
Incorrect:  Mobile → MongoDB
```

### AI

The AI must NEVER connect directly to MongoDB.

```text
Mobile → Backend → AI Service → Controlled Tool → MongoDB
```

Never provide MongoDB credentials or unrestricted database access to an AI provider.

### Authorization

The backend is the security boundary. Always enforce **authentication**, **authorization**, **role
permissions** and **business isolation** on the server. Do not rely on the mobile UI to enforce
security.

### Business Isolation

Every business-owned resource must be isolated by `businessId`. Never trust a client-provided
`businessId`: determine business context from the authenticated user/session.

### Inventory

Inventory changes follow the rules in `docs/SYSTEM_SPECIFICATION.md` and must create appropriate
inventory transactions. Do not allow negative inventory unless explicitly specified.

Products follow an archive-only lifecycle: `ACTIVE` ↔ `ARCHIVED`, with `ARCHIVED` terminal. Products
are never hard-deleted by the application — no delete route, service method or cascade exists, and
none may be added without explicit specification. Archiving retains the product's inventory records
and its full transaction history.

Referential integrity between inventory and products is a responsibility of application lifecycle
rules and write-path validation, not of MongoDB. Mongoose `ref` enforces nothing; read-path filters
are defensive query hygiene, not integrity enforcement.

### AI V1

The AI assistant is READ-ONLY. It may retrieve, summarize, explain and analyze authorized inventory
information. It must NOT modify products, inventory, transactions, users or roles unless a future
specification explicitly enables these capabilities.

---

# 5. Security Rules

Never:

- Hardcode secrets
- Commit `.env`
- Expose API keys to the mobile application
- Expose MongoDB credentials
- Trust client authorization
- Trust AI authorization
- Return sensitive internal errors to clients

Use environment variables for secrets, and maintain an `.env.example` containing variable names but
never real credentials.

---

# 6. Development Rules

Before implementing a feature:

1. Read the relevant specification.
2. Inspect the existing implementation.
3. Understand the current architecture.
4. Create a short implementation plan.
5. Implement only the requested scope.

Do not blindly rewrite existing code. Do not introduce unnecessary dependencies. Prefer simple and
maintainable solutions.

---

# 7. Phase Discipline

The project is built in phases: one phase, one purpose, one verification record.

## How to work a phase

- Implement that phase only. Do not jump ahead, do not implement future features without explicit
  approval, and do not silently expand scope.
- If a future feature is required to implement the current phase, explain the dependency before
  making major changes.
- Verify before claiming: the phase's tests, `tsc`, `eslint`, and the behaviour itself. A passing
  build is not a passing feature.
- Record the phase in `docs/DEVELOPMENT_ROADMAP.md` with a number in the `27…` series, and cite that
  number from here. The numbering is guarded: no record may claim a number twice, every `§27…`
  citation must resolve, and every declared record must be reachable from this file.
- End every session by updating `docs/DEVELOPMENT_LOG.md`: what was completed and how it was verified,
  what is still in progress, what is blocked, and the next priority. The roadmap records what shipped;
  the log records what is true today. Never mark an item complete there because code was written or a
  commit exists — only because the check was run and its result seen.

## Phase overview

| Phase | Delivered |
| --- | --- |
| 00–03 | Planning, project foundation, backend + database, authentication and authorization |
| 04 | Inventory core: stock in/out/adjust, transactions, no negative stock |
| 05 | Mobile application |
| 06 | Read-only AI assistant |
| 07 | Testing and production hardening (headers, CORS, logging, error hygiene, rate limits) |
| 08A/08B | Structured request logging + correlation IDs; backend ESLint baseline |
| 10A/10B | SaaS plan state and centralized entitlement checks |
| 11A/11B | Inventory health, reorder list and a read-only restock tool |
| 14A | User management API (OWNER/ADMIN: list, create, role + status) |
| 16 | Audit trail viewer — read-only, OWNER/ADMIN |
| 17 | Mobile suppliers and purchase orders |
| 19 | Stock transfers between locations (two-leg movement + compensation) |
| 21 | Product archive-only lifecycle, documented and guarded |
| 22–24 | Authorization contract enforcement, route classification, runtime role × route matrix |
| 25 | Design-token contrast to WCAG AA, measured |
| 26A | Server-side sessions named by `jti`: real logout, per-session revocation, sign out everywhere |
| 26B | Password recovery by emailed reset token (public routes, uniform 202) |
| 27 | Mobile password-recovery screens |
| 28 | Reset-mail send detached from the request path (partially mitigated; residual term accepted) |
| 29 | Residual security-risk decision record |
| 30A | EAS foundation: profiles, identifiers, `expo-dev-client` |
| 30B | Native and device acceptance (defined; items closed piecemeal, iOS environment-blocked) |
| 32B–32E | Firebase Admin boundary, session exchange, native SDK boundary, email/password flow |
| 32H | Server-side account-linking boundary |
| 32J / 32K | Registration onboarding; Firebase password authority and timing-equalizer fix |
| 32L | Firebase unlink — **superseded and removed** (Phase A / F-1) |
| F1 / F2 / F2.9 | Retire the Firebase JS SDK and browser OAuth; retire browser deps, plugin and second scheme; verify on a device |
| AUTH-01…AUTH-06 | Revocation checking, short-lived JWT + 14-day cap, renewal, verification codes, two-step recovery |
| AI-1…AI-25 | Turn deadline, retries, answer rendering, cost line, quota, failover, streaming, one provider |

Letter-numbered increments are roadmap records, not phases; the index below is complete.

## Operational traps worth knowing

Each of these cost a real debugging session or a real incident. Here they are one line; the record
below has the measurement.

- **`eas update` needs `--platform android`** in this project; without it the web export fails.
- **Every EAS profile has its own channel.** `preview` cannot receive a `production` update — that is
  the isolation working, not a failure. Verify by the manifest, not by the tagline.
- **`runtimeVersion` is `{ policy: "appVersion" }`.** The `fingerprint` policy failed a real build
  because `app.config.js` resolves Firebase file paths that exist only on the builder. Before
  publishing a store build whose JS-only version changed, run `mobile/scripts/check-ota-publish.mjs`.
- **A local `server` process must be the one answering port 4000.** A stale listener from an older
  checkout answers 404 and looks exactly like a network fault; the port-ownership guard exists for
  this.
- **A dev build resolves the API base to `http://localhost:4000`.** On a phone, `adb reverse
  tcp:4000 tcp:4000` must be up, and `adb reverse --list` being empty is the diagnosis.
- **`TRUST_PROXY` unset behind a proxy** collapses every per-IP rate-limit bucket into one global
  bucket — 60 failed logins would lock out every member. Production sets it.
- **Firebase cannot mail a link to a custom scheme** (`auth/unauthorized-domain`). AUTH-06 replaced
  the browser reset with a six-digit code for that reason; the `GET /auth/reset` page remains only
  because Firebase's own API and console can still compose that mail, and our page is the only
  destination at which such a reset revokes sessions.
- **The Firebase console refuses email-template writes** (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`), so no
  flow may depend on a template we configure.
- **A failed `api.me` is not "signed out".** Sign out only when the server *refuses* the session; a
  network failure must degrade, not discard the token.
- **`npm run seed` is the one seeding command, and production costs three phrases.** The target is
  always named (`--database=` must equal what `MONGODB_DB_NAME` resolves); development needs
  `SEED_CONFIRM` (the plan) plus `SEED_DB_CONFIRM` (the database), and production adds
  `SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA`. **`npm run cleanup -- --target=database|firebase` is the
  one destructive command and costs the same two or three phrases** (`CLEANUP_CONFIRM`,
  `CLEANUP_DB_CONFIRM`, plus `CLEANUP_PROD_CONFIRM=DELETE-PRODUCTION-DATA` for production) — the
  per-selector `cleanup:*-mongodb` scripts and `cleanup:firebase-accounts` no longer exist. Read the
  refusal rather than working around it — it names every phrase that is missing and how many the
  target requires.
- **A plan is counted in PRODUCTS; a `--total` is DOCUMENTS.** `npm run seed:three` and
  `npm run seed:accounts --accounts="a@x.com:30000"` size each tenant by its **product** count (the
  generator prints the derived document figure beside it; `address:400000d` asks in documents instead),
  while `seed --plan=demo --total` and `seed:perf-tenant --size` stay documents. `npm run check:accounts
  [--with-production]` is the read-only pre-flight that says which accounts exist and how many documents
  a seed would reset — **one database per run**: development by default, production *instead* with
  `--with-production`, so a row missing in the other environment cannot fail the check. It is a fixed
  choice rather than a `--database=` flag, and needs no phrase because it changes nothing. `cleanup:account` / `cleanup:three` remove that data again and keep every
  login, business row and Firebase identity. **The Firebase project is pinned, not inherited**: a seed
  creates its login in the approved project (`inventoryai-d0d20`) or refuses, because a login created
  in another project could never be joined to the tenant (the app resolves a user by `firebaseUid`).
- **OTA code signing is plan-gated**, not a config switch: Expo allows it on the Production ($199/mo)
  or Enterprise plans only. A binary carrying a certificate **rejects** any unsigned publish, so
  enabling `codeSigningCertificate` before the plan exists would freeze every install on its old
  bundle while the channel claims a newer one. See Guide 7 §11.
- **A build id is a pointer, not a copy.** Two production builds were deleted from EAS and their
  artifacts now answer 400. Record an id only after `eas build:view <id>` resolves, and treat a
  published AAB that is not downloaded and kept as gone. See §27FN.

## Open items (2026-10-30)

This is a dated snapshot of the project's open work. The **living** version — updated every session,
with what is in progress, verified or blocked — is [`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md).

- **Two Dependabot advisories remain on `mobile/package-lock.json`** — `zod` (high, via `@expo/cli`)
  and `deepmerge` (low, via `@expo/config` and `jest-config`). Neither reaches a shipped bundle and
  neither has a fix inside its consumer's declared range: zod is patched only at 4.6.6+ while the CLI
  declares `^3.25.76`, and deepmerge 4.3.1 is both the newest release and inside the advisory range.
  An override would be an unreviewed upgrade of build tooling; do not "fix" them by forcing versions.
  The third alert, `node-forge`, was **fixed in the lockfile on 2026-10-30** by an in-range bump to
  1.4.2 (§27GX); the GitHub alert closes when that change reaches the default branch.
  `scripts/check-upgrade-watches.mjs` reports `zod` and `deepmerge` `DEFERRED`, `node-forge` `CLOSED`.
- **L-17 is OPEN**: the Firebase console's password-reset *Customize action URL* must point at
  `https://ai-inventory-l1mi.onrender.com/auth/reset`. No code can set it, and it gates only the
  AUTH-05 hosted-link path.
- **The Play release has not been made.** The AAB exists and was inspected; nothing has been uploaded,
  so Play App Signing and the store-installed build are unproven. **Both production build records
  (`09d77d3d…`, `4b133d62…`) were later deleted from EAS and their artifacts are gone** (§27FN), so the
  next build, not those, is the authoritative store artifact.
- **OTA code signing is blocked by plan, not by code** (§27FN). Channels are `Unprotected`; enabling
  signing needs EAS Production ($199/mo). Do not enable it on the free plan.
- **iOS is `[EXTERNAL VERIFICATION REQUIRED]`** — no macOS on the development host.
- **Legacy login cannot be retired yet**: existing admin-created accounts hold a password hash and no
  `firebaseUid`.

## Documentation index — every plan record

Every record declared in `docs/DEVELOPMENT_ROADMAP.md`, by the title that record gives itself. The
list is generated from the roadmap's own headings, so it cannot drift from them; find a record by its
anchor (`§27…`) in that file.

- **§27B** — Phase 26B — Password Recovery (Email Reset)
- **§27C** — Phase 27 — Mobile Password Recovery
- **§27D** — Phase 28 — Password Reset Mail Delivery Timing Hardening
- **§27E** — Phase 29 — Residual Security-Risk Decision Record & Documentation Reconciliation
- **§27F** — Phase 30A — EAS Development Build & iOS Readiness Foundation
- **§27G** — Phase 32A — Firebase Authentication Architecture & Console Runbook
- **§27H** — Phases 32B–32E — Firebase Implementation (server boundary, client boundary, email/password auth)
- **§27I** — Phase 32F — Firebase Multi-Provider Authentication Architecture (decision record & documentation close-out)
- **§27J** — Phase 32G — First EAS Development Build / Native Runtime Validation
- **§27K** — Phase 32H — Server-Side Account Linking Boundary & Authentication Ownership
- **§27L** — Phase 32J — Mobile Firebase Registration Onboarding (Google → register → exchange → session)
- **§27M** — Phase 32K — Firebase Password Authority Boundary & Timing-Equalizer Credential Fix
- **§27N** — Phase F1 — Retire the Firebase JS SDK and the Browser OAuth Path
- **§27O** — Phase F2 — Retire the Browser Dependencies, the Plugin, the Second Scheme and the Native-Intent Hook
- **§27P** — Phase F2.9 — EAS Development Build & Android Runtime/Native Verification
- **§27Q** — Phase 32L — Firebase Identity Unlink (32L-A / 32L-B) and Its Documentation Close-out
- **§27R** — Registration Form Required-Field Validation (Preview-Validation Finding "F-1")
- **§27S** — Phase 31 — AI Provider Wire Diagnostics, the AgentRouter → OpenRouter Migration, and the OpenRouter Wire-Suite Test Isolation
- **§27T** — Deployment-Configuration Reconciliation (Phases 4A–4B)
- **§27U** — Phase 32N — Firebase-Only Authentication Architecture & the Credential-Change Revocation Bridge (design record only)
- **§27V** — Phase 32O — Registration & Email-Verification Decisions (documentation only)
- **§27W** — Phase 32P — N-4 D2 (the recovery-context bridge caller) decision record (documentation only)
- **§27X** — Phase 32Q — OD-9 LOCKED: the automatic recovery marker (documentation only)
- **§27Y** — AUTH-04 — the custom 6-digit email-verification code flow (documentation supersession)
- **§27Z** — Phase C3 — the mobile sign-in vocabulary standard and the widened local-password gate (presentation only)
- **§27AA** — Phase A / F-1 — removal and re-scope of the Firebase unlink capability (retrospective record)
- **§27AB** — AUTH-01 — Firebase revocation checking and verification-failure classification
- **§27AC** — AUTH-02 — short-lived JWT, enforced issuer/audience, and the 14-day absolute session cap
- **§27AD** — AUTH-03 — inventory session renewal (server boundary and mobile client)
- **§27AE** — CI quality gate — `.github/workflows/ci.yml` (and the defect its first run caught)
- **§27AF** — Owner-only access — audited, monitored and pinned (2026-10-09)
- **§27AG** — Workflow simplification — fewer moving parts, dependency policy, and a leaner instruction file (2026-10-09)
- **§27AH** — Current status, known issues and the next-step order (2026-10-10, revised 2026-10-14)
- **§27AI** — Expo SDK 58 upgrade — the approved procedure (2026-10-10)
- **§27AJ** — ISS-02 — the RNFirebase Auth PII log, remediated (2026-10-10, PR #40)
- **§27AK** — Dependency advisories — the per-alert disposition (2026-10-10)
- **§27AL** — Dependabot scope completed — every Expo-pinned package is excluded (2026-10-11)
- **§27AM** — ISS-13 — the Phase 30A "F-1" PDF-sharing finding, resolved as far as it can be (2026-10-11)
- **§27AN** — ISS-16's detection gap closed — the Expo pin set is now held in CI (2026-10-11)
- **§27AO** — The workflow actions re-pinned to v7 — ISS-12 cleared early (2026-10-11)
- **§27AP** — The server-side queue items taken — and one row's premise was wrong (2026-10-11)
- **§27AQ** — The deferred queue's remaining rows, measured — and the drift a script caught (2026-10-11)
- **§27AR** — The secret guard can now fail on purpose — controls for every rule (2026-10-11)
- **§27AS** — The attribution cleanup — a message-only rewrite, measured three times (2026-10-11)
- **§27AT** — Real-device Android run — what the phone proved, and what it did not (2026-10-11)
- **§27AU** — An upgrade watch reported a gate as OPEN that was shut — corrected, with controls (2026-10-11)
- **§27AV** — The local backend was serving the TEST database — and the "empty database" measurement read a different one (2026-10-11)
- **§27AW** — Phase 30B defined — Native & Device Acceptance (2026-10-11)
- **§27AX** — Documentation truth pass, the invalidated citations, and a guard on the route inventory (2026-10-12)
- **§27AY** — The native pairing nothing was checking, and the four packages the doctor wanted (2026-10-12)
- **§27AZ** — The Phase 30B build — ISS-06 closed, ISS-02 verified at the artifact level, and the dependency fix proved natively (2026-10-12)
- **§27BA** — The Phase 30B device run — ISS-02 closed on hardware (2026-10-12)
- **§27BB** — The test-data reset, and the orphaned-identity finding it exposed (2026-10-12)
- **§27BC** — The authenticated device walkthrough (2026-10-12)
- **§27BD** — AI-1 — the AI turn's time budget, and telling the truth about it (2026-10-12)
- **§27BE** — AI-1 verified on the device (2026-10-12)
- **§27BF** — AI-2 — the empty-completion retry, a degraded turn made visible, and the read-only invariant made provable (2026-10-13)
- **§27BG** — AI-3 — the assistant's queries at catalogue scale: a measured fan-out, four pipelines turned around, and an answer-equivalence harness (2026-10-13)
- **§27BH** — AI-4 — the assistant's answer, rendered: a dependency-free parser for the structures the model already writes, and a word boundary that stops it deleting characters from arithmetic (2026-10-13)
- **§27BI** — AI-5 — the turn's own cost: one line per turn on every exit, because a healthy turn recorded nothing about itself (2026-10-13)
- **§27BJ** — Index integrity (IDX-1) — the guards proved the index was DECLARED and nothing anywhere could tell whether it was BUILT (2026-10-14)
- **§27BK** — The owner's account seeded at 80 000 records, and the Firebase cleanup that was refused (2026-10-14)
- **§27BL** — AI-6 — the assistant's limit, named (2026-10-14)
- **§27BM** — One seeding core instead of two, and the three-account comparison setup (2026-10-14)
- **§27BN** — The sign-in form's silence, and five places the auth copy failed (2026-10-14)
- **§27BP** — A deploy gate that lied, and a measurement that reported a call it never made (2026-10-14)
- **§27BQ** — ISS-26 — the assistant's LaTeX maths reached the screen as source (2026-10-13, recorded retrospectively 2026-10-14)
- **§27BR** — The attribution trailers that came back, and the check that refuses them (2026-10-14)
- **§27BS** — ISS-26's device half: the decoder was right, and it was still hiding a different number (2026-10-14)
- **§27BT** — ISS-27 — the narrow table collapsed, and the screen looked empty (2026-10-14)
- **§27BU** — AI-7 — the conversation list ordered by creation, fixed and device-measured (2026-10-14)
- **§27BV** — AI-8 — the truncated answer is marked, not served as complete (2026-10-15)
- **§27BW** — The keyboard stops covering the focused field (2026-10-15)
- **§27BX** — The dashboard summary at 50 625 products — the catalogue stops crossing the wire (2026-10-15)
- **§27BY** — The output cap is not the constraint — the deadline is (2026-10-15)
- **§27BZ** — The assistant's tools at 50 000 products — linear, and still not the bottleneck (2026-10-15)
- **§27CA** — The dependency review — three tracks, and the one available fix that is not safe to take (2026-10-15)
- **§27CB** — The guard that was blind to the defect it was written for (2026-10-15)
- **§27CC** — The server minor-and-patch group taken — five patches, and mobile deliberately held (2026-10-15)
- **§27CD** — The section numbering gets the guard everything else already had (2026-10-15)
- **§27CE** — The device path restored, the six-column answer measured, and the label's page box read from the file (2026-10-15)
- **§27CF** — AI-9 — the turn can be stopped, and a stop is not a failure (2026-10-15)
- **§27CG** — The instruction file had 29 records it could not find, and nothing said so (2026-10-15)
- **§27CH** — The deployment that was legal, silent and unusable — what this deployment is, and what it is missing (2026-10-15)
- **§27CI** — The first request of every session was aborted before the server could answer it — and the app blamed the network for it (2026-10-16)
- **§27CJ** — The fixed version that is not a fix, and the one the updater said it could not reach (2026-10-16)
- **§27CK** — AI-10 — The answer the model could not fit, and the harness that hid the fix (2026-10-16)
- **§27CL** — The advisory that stays open is now watched, and the gate the watch says has opened (2026-10-16)
- **§27CM** — AI-10 and AI-9 on the phone — and the cost line that called a spent output budget nothing (2026-10-17)
- **§27CN** — AI-11 — The assistant's own usage report, and what the allowance actually says (2026-10-17)
- **§27CO** — AI-11, part two — the durable half, and the row the TTL sweep had already deleted (2026-10-17)
- **§27CP** — AI-12 — The empty completion made diagnosable, and the model the record must name (2026-10-17)
- **§27CQ** — The 50 000-product phone pass — a real answer on the member's own account, and the first naturally capped turn (2026-10-17)
- **§27CR** — The restock list that existed only five rows deep (2026-10-17)
- **§27CS** — The restock page's cost, measured to the mechanism — and the fix that is a design decision (2026-10-17)
- **§27CT** — The role-boundary fixture — four working logins in one tenant, and the 96-cell matrix that proves them (2026-10-17)
- **§27CU** — The four-role phone walkthrough — a door with no handle, and a trail that showed its own enums (2026-10-17)
- **§27CV** — The MANAGER walk — the writes verified against the ledger, and two screens that agree (2026-10-17)
- **§27CW** — The Stop, measured again — two stale claims corrected, and the stale server that answered instead (2026-10-17)
- **§27CX** — The purchase-order write chain as MANAGER — create, issue, receive, and the ledger after each step (2026-10-18)
- **§27CY** — The port proves which process answered — the stale-server trap made impossible instead of documented (2026-10-18)
- **§27CZ** — Where a new draft lands — and the first test `PoForm` has ever had (2026-10-18)
- **§27DA** — An escaped pipe made data, and a tilde removed — two parser defects found by probing (2026-10-18)
- **§27DB** — The whole stored corpus replayed — and the one leak it found (2026-10-18)
- **§27DC** — The tool result the model reads, capped without breaking it (2026-10-18)
- **§27DD** — The filtered inventory page, resolved product-first — 15–29 s to 0.5–1.6 s (2026-10-18)
- **§27DE** — The join itself was the cost — 9× from a `$lookup` shape (2026-10-18)
- **§27DF** — Five tools broke at 131 000 products — the `$group` payload, not the row count (2026-10-18)
- **§27DG** — The location page's plan made unambiguous — an index for a defect that cannot be re-measured (2026-10-18)
- **§27DH** — There was no backup — and the drill found the tier's ceiling (2026-10-18)
- **§27DI** — The pulse an outside watcher can read (2026-10-18)
- **§27DJ** — The reference data the assistant could not see — and the ids two tools required (2026-10-19)
- **§27DK** — The instrument that measured the provider could crash, and the test threw away why (2026-10-19)
- **§27DL** — The location a member named — one provider call instead of two (2026-10-19)
- **§27DM** — The assistant on the owner's phone — six questions, five defects, one device run (2026-10-19)
- **§27DN** — The chip a member can read — and the assistant at 50 000 products (2026-10-19)
- **§27DO** — One round-trip per set of lookups — the compare-two-locations turn (2026-10-19)
- **§27DP** — The comparison a single lookup can answer (2026-10-19)
- **§27DQ** — The question's own clock — and the four copies a blip exposed (2026-10-19)
- **§27DR** — One provider, on purpose — the direct Claude and Gemini implementations removed (2026-10-19)
- **§27DS** — The answer a member can finish reading (2026-10-19)
- **§27DT** — The allowance is read before it is spent (2026-10-19)
- **§27DU** — A boot that survives a slow cluster (2026-10-20)
- **§27DV** — The preview build, against the production API (2026-10-20)
- **§27DW** — The demo tenant a preview build can be checked against (2026-10-20)
- **§27DX** — The reset email's link comes back into the app (2026-10-20)
- **§27DY** — Password reset by six-digit code, inside the app (2026-10-20)
- **§27DZ** — The assistant's model is checked, not assumed (2026-10-21)
- **§27EA** — A fallback chain that is verified, bounded, and never spends a refusal twice (2026-10-21)
- **§27EB** — A model that just failed five times is not tried first on the next turn (2026-10-21)
- **§27EC** — The model that answers becomes the model the deployment uses (2026-10-21)
- **§27ED** — The model list carries live evidence, not a remembered measurement (2026-10-21)
- **§27EE** — The comparison is measured, and the measuring instrument is fixed (2026-10-21)
- **§27EF** — Large tenants and dependency alerts: measured, not assumed (2026-10-21)
- **§27EG** — A dead model is found by a timer, not by a member's failed question (2026-10-21)
- **§27EH** — Expo SDK 58 runs on the phone (2026-10-21)
- **§27EI** — Password recovery, split into two steps (2026-10-22)
- **§27EJ** — The audit that found three open doors, and closed them (2026-10-23)
- **§27EK** — The Firebase verification email had no sender left (2026-10-23)
- **§27EL** — The deployment learns from the provider before it spends a request (2026-10-23)
- **§27EM** — The answer arrives while it is being written (2026-10-23)
- **§27EN** — The auth screens stop making people guess (2026-10-23)
- **§27EO** — The rule is stated while it is typed, and six digits verify themselves (2026-10-23)
- **§27EP** — The installed app updates itself, and a launch without a network stays signed in (2026-10-24)
- **§27EQ** — The preview build against production: channel isolation, and every account journey on the installed app (2026-10-24)
- **§27ER** — The production profile on the phone: build, journeys, OTA and a measured rollback (2026-10-24)
- **§27ES** — The production AAB: built with store packaging, inspected before any upload (2026-10-24)
- **§27ET** — The permission review: one unnecessary permission removed, the other eleven attributed (2026-10-24)
- **§27EU** — The Play submission pack, and the two things that block it (2026-10-24)
- **§27EV** — The privacy policy, served by the server that creates the obligation (2026-10-24)
- **§27EW** — Account deletion — in the app and on the web (2026-10-24)
- **§27EX** — A business whose only member leaves closes with them (2026-10-24)
- **§27EY** — The Google button, on a real Google account (2026-10-24)
- **§27EZ** — The store artifact was the wrong commit — a parity gate, and no upload (2026-10-24)
- **§27FA** — The Terms of Use — and the personal data that outlived the tombstone (2026-10-25)
- **§27FB** — Invitations — the first way to join a business you did not create (2026-10-25)
- **§27FC** — The invitation flow, on production and on the phone (2026-10-25)
- **§27FD** — The invitation, sent by an admin and received in a real inbox (2026-10-25)
- **§27FE** — Release notes: a card that says what changed, and a version to quote (2026-10-25)
- **§27FF** — A publish that no commit described, and a dismissal that was not final (2026-10-25)
- **§27FG** — A large tenant in production, and the assistant measured there (2026-10-25)
- **§27FH** — Production seeding through the same commands (2026-10-25)
- **§27FI** — Emptying a tenant without deleting its login, and a repeat at 80,000 (2026-10-25)
- **§27FJ** — Two advisories that cannot be fixed here, and the watch that says when they can (2026-10-25)
- **§27FK** — The runtime boundary made mechanical, and the build that could not run (2026-10-25)
- **§27FL** — The session cap the roadmap had twice recommended and never built (2026-10-25)
- **§27FM** — The whole V1 surface re-verified, and the front door cut to a page (2026-10-25)
- **§27FN** — Three EAS questions answered: the vanished production builds, the quota, and the plan gate on signing (2026-10-26)
- **§27FO** — The documentation set, measured and cut — and four documents that were confidently wrong (2026-10-26)
- **§27FP** — The advisories re-measured, and no published release can close either (2026-10-26)
- **§27FQ** — The empty state the harness could not read, and the production walk it was hiding (2026-10-26)
- **§27FR** — The journeys stopped needing an id, and four false verdicts fell out of it (2026-10-26)
- **§27FS** — Two phrases that were both required and only one documented, and the cleanup guard that could not see its own trap (2026-10-26)
- **§27FT** — One seeding command, and a production target that costs a third phrase (2026-10-26)
- **§27FU** — One cleanup command, and a Firebase check that reads both databases (2026-10-26)
- **§27FV** — The seeding scripts reviewed — four defects, and a read-back that makes OK a measurement (2026-10-26)
- **§27FW** — The scoped cleanup that was cheaper than the rule (2026-10-26)
- **§27FX** — The fixture cleanups take the rule, and the dry run counts (2026-10-27)
- **§27FY** — The preview and the delete share one plan (2026-10-27)
- **§27FZ** — Each topic gets one guide, and the data commands move into theirs (2026-10-27)
- **§27GA** — The command audit — one false pass, one bad message, and four flags that were ignored (2026-10-27)
- **§27GB** — The three accounts by address — a products-sized plan, a pre-flight check, and a cleanup that keeps every login (2026-10-27)
- **§27GC** — The three accounts registered, and the whole workflow run against them (2026-10-27)
- **§27GD** — The preset seeded for real in development — and the 27-minute estimate corrected (2026-10-27)
- **§27GE** — The 512 MB ceiling was the real constraint, and the index allocation was hiding in it (2026-10-27)
- **§27GF** — The data guides split by environment — four files where two stood, and the Firebase guide renumbered (2026-10-27)
- **§27GG** — The guides audited for misfiled content, and the data guides' commands put under a guard (2026-10-27)
- **§27GH** — The reference documents measured against the tree — three stale sentences, four undocumented variables, and the tables that were already right (2026-10-27)
- **§27GI** — The production dry run checked nothing, and said the run would go ahead (2026-10-28)
- **§27GJ** — The production check was judged by the development database, and every command's boundary re-measured (2026-10-28)
- **§27GK** — Production seed and delete at 10 000 products — and a connection failure that read like a partial write (2026-10-28)
- **§27GL** — A production hint that named the database but not the environment — and 20 000 products proven in production (2026-10-28)
- **§27GM** — Each account chooses whether its products carry a SKU and barcode (2026-10-29)
- **§27GN** — Seeded barcodes are valid, unique EAN-13 — printable and scannable (2026-10-29)
- **§27GO** — `--include-sku` is replaced by `--codes=`, and refused rather than ignored (2026-10-29)
- **§27GP** — The seeding documentation measured against the scripts — six stale statements (2026-10-29)
- **§27GQ** — A typed tenant id is a claim, and it is checked in every environment (2026-10-29)
- **§27GR** — The seeding commands run against a database — four code modes, 1 000 products, and a corrupted tenant caught (2026-10-29)
- **§27GS** — One verification command for the accounts workflow — and the expected size made checkable (2026-10-29)
- **§27GT** — The unrelated-tenant witness for `cleanup:account` (2026-10-29)
- **§27GU** — The seed's SKU/barcode mode becomes verifiable — from the products, not the plan (2026-10-30)
- **§27GV** — The empty-tenant CLI verdict becomes an executed test (2026-10-30)
- **§27GW** — The barcode report checks the value, not just the field (2026-10-30)
- **§27GX** — The one Dependabot alert that could be closed, and the two that cannot (2026-10-30)
- **§27GY** — The zod gate is read from the published CLI, not the installed one (2026-10-30)
- **§27GZ** — One operation, one movement — inventory writes deduplicated (2026-11-01)
- **§27HA** — The ledger's past duplicates, read and not touched (2026-11-01)
- **§27HB** — The duplicate ledger audit, exact across the clock hour (2026-11-01)
- **§27HC** — AI-41 — the assistant answers in the member's local time zone (2026-11-01)
- **§27HD** — Sprint 1 — a confirmed adjustment and a transfer from the row (2026-11-01)

---

# 8. Code Quality

Prefer:

- Clear naming
- Small focused modules
- Reusable services
- Separation of concerns
- Consistent error handling
- Input validation
- Appropriate logging
- Testable business logic

Avoid:

- Duplicate logic
- Giant files
- Unnecessary abstractions
- Dead code
- Hardcoded configuration
- Magic values
- Unused dependencies

---

# 9. Backend Rules

Backend responsibilities include:

- Authentication
- Authorization
- Validation
- Business logic
- Inventory calculations
- Database operations
- Audit logging
- AI tool execution

Controllers should not contain excessive business logic.

Keep business logic in appropriate services/modules.

Database access should remain organized and maintainable.

---

# 10. Mobile Rules

The mobile application communicates with the backend through the API.

Do not place business-critical authorization logic only in the mobile app.

The mobile application should:

- Handle loading states
- Handle errors
- Handle empty states
- Validate basic user input
- Provide clear feedback
- Avoid unnecessary API calls
- Use efficient list rendering

Mobile UX should remain simple and practical.

---

# 11. AI Rules

The AI assistant must use controlled tools.

Initial tools may include:

```text
searchProducts
getProduct
getInventory
getLowStockProducts
getOutOfStockProducts
getInventorySummary
getInventoryHistory
getProductsByLocation
getReorderNeededProducts
listLocations
listCategories
```

The last two are reference lookups (AI-14): `getProductsByLocation` and the
category filters take IDs, and these are the only way to turn a name a member
said into one. They read the same records as `GET /api/locations` and
`GET /api/categories`, which are authentication-only, so they are gated on the
read permission of the capability they serve and can narrow nobody.

AI tools must receive authenticated user context.

Every tool must enforce:

```text
User
 ↓
Authentication
 ↓
Role Authorization
 ↓
Business Isolation
 ↓
Database Query
```

Never allow the AI model to generate arbitrary MongoDB queries.

Never trust an AI-supplied `businessId`.

Never allow AI-generated text to override backend authorization.

---

# 12. AI Accuracy

The AI must not invent database facts.

For inventory quantities, products, stock levels, locations, and history:

- Retrieve authoritative information from backend tools.
- Base the response on tool results.
- Clearly state when information is unavailable.
- Do not guess missing inventory information.

---

# 13. Testing

After implementing a feature, run appropriate checks and tests.

Critical areas include:

- Authentication
- Authorization
- Business isolation
- Product operations
- Inventory operations
- Stock-in
- Stock-out
- Negative stock prevention
- Transaction creation
- Dashboard calculations
- AI tool authorization

Do not claim a feature works without verifying it.

---

# 14. Verification Requirement

After implementation:

1. Run relevant tests.
2. Run lint/type/syntax checks when available.
3. Verify the affected functionality.
4. Review for security issues.
5. Check that unrelated functionality was not unnecessarily changed.
6. Fix problems introduced by the current task.

If something cannot be verified, explicitly report it.

---

# 15. Documentation

Update documentation when implementation changes an architectural or functional decision.

Primary specification:

`docs/SYSTEM_SPECIFICATION.md`

Do not silently contradict the specification.

If an intentional architecture change is required:

1. Explain the conflict.
2. Propose the change.
3. Obtain approval before making a major architectural change.

---

# 16. Git

Use meaningful commits.

Examples:

```text
feat: add product model
feat: implement stock in
feat: implement stock out
fix: prevent negative inventory
feat: add inventory history
feat: add read-only AI tools
test: add inventory authorization tests
```

Never commit:

```text
.env
API keys
MongoDB credentials
Private certificates
```

### Inventory AI — Project Identity & Git Attribution

The project identity belongs to Jeffern. Claude Code is only an implementation tool and must NOT be represented as a project author, contributor, co-author, or attribution identity.

Canonical project identity:

* Project: Inventory AI
* Owner: Jeffern
* GitHub display name: Jeffernzxc
* GitHub username: nreffejzxc
* Git identity: jeffernzxc
* Commit email: jefferndullamalinaozxc@gmail.com
* Implementation: Jeffern
* Attribution: Jeffern / Jeffernzxc only

#### Git commit rules

These rules are **tool-agnostic and forward-binding**: they name Claude Code and Codebuff only as
instances. Any AI agent, coding tool, bot or automation is covered, and so is any tool introduced later.

1. Do NOT add a co-author trailer for an AI agent, a coding tool, a bot or automation. Forbidden
   examples, by name:
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`,
   `Co-Authored-By: Codebuff <noreply@codebuff.com>`.

2. Do NOT add a generated-by tag, signature line or automated footer to a commit body or trailer.
   Forbidden examples, by name: `🤖 Generated with Codebuff`, `Generated with Codebuff`,
   `Generated with Claude Code`, `Generated by Claude`, `Made with …`, and any emoji-prefixed
   attribution line.

3. A normal commit message is the Inventory AI change and nothing else — subject, optional body
   explaining *why*, and no attribution of any kind. **The only identity that may appear anywhere in a
   commit, branch, pull request, changelog or release note is Jeffern's own name and the commit email
   above.**

4. Do NOT identify Claude Code, Anthropic, Codebuff or any other tool as the author, co-author,
   contributor, implementer or owner of Inventory AI. Implementing, modifying, testing, debugging and
   documenting the project does not make a tool an author or contributor.

5. Git author **and** committer identity must be the repository's configured Jeffern/jeffernzxc
   identity. Verify with `git config user.name` / `git config user.email` before creating a commit; the
   two must be `jeffernzxc` and the commit email above. If either differs, **report the mismatch** —
   never silently change Git identity.

6. Before creating any commit, read back what you are about to record —
   `git log -1 --format=%B` on the staged commit, or the message you are about to pass — and confirm it
   carries no trailer other than the owner's own. A trailer that was never added cannot be reviewed
   away later.

7. **Nothing in this repository may add a trailer automatically.** No `commit-msg` or
   `prepare-commit-msg` hook, no commit template (`commit.template`), no alias and no script may append
   one. The unwanted trailers found in pre-2026-10-11 history came from a coding agent's own
   commit-message template — not from Git — so that template must not be reintroduced.

8. This rule applies to all future commits, branches, pull requests, pull request descriptions, reviews,
   changelogs, release notes and project documentation, unless Jeffern explicitly overrides it for one
   specific case.

9. Rewriting history stays forbidden **except on Jeffern's explicit request.** Jeffern requested it once,
   on 2026-10-11, to remove the already-published attribution described in rule 1 and rule 2; that rewrite
   is recorded in `docs/DEVELOPMENT_ROADMAP.md` §27AS. That single request does not stand as standing
   permission, and no further history rewrite may be started without a new, explicit request.

10. When a history rewrite is authorised, it must be **message-only** (file contents and trees untouched,
    proved by comparing tree hashes before and after), must preserve every commit's work, must be
    reported with its impact on branches, pull requests and deployments, and must use
    `--force-with-lease` — never an unguarded force push.

---

# 17. Scope Protection

Do NOT implement the following unless explicitly requested:

- Payments
- Subscriptions
- SaaS billing
- Full offline synchronization
- AI write actions
- AI forecasting
- Demand prediction
- RAG
- Vector Search
- Advanced supplier management
- Automated purchasing
- Advanced analytics

These belong to future versions.

---

# 18. Working Style

When given a task, follow this sequence:

```text
READ
  ↓
INSPECT
  ↓
PLAN
  ↓
IMPLEMENT
  ↓
TEST
  ↓
VERIFY
  ↓
DOCUMENT
  ↓
REPORT
```

Do not rush directly into implementation.

Before making substantial changes, understand the existing project.

---

# 19. Completion Report

After completing a task, report:

### Implemented

What was changed.

### Files Changed

Important files created or modified.

### Verification

Tests/checks that were executed and their results.

### Issues

Any remaining problems or limitations.

### Next Step

The recommended next development step.

Keep reports concise and factual.

---

# 20. Final Rule

When uncertain about implementation details, prioritize:

1. `docs/SYSTEM_SPECIFICATION.md`
2. Existing project architecture
3. Security
4. Data integrity
5. Maintainability
6. Simplicity

Never sacrifice security, authorization, business isolation, or inventory consistency for convenience.