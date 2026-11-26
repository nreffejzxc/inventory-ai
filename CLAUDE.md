# Inventory AI — Project Instructions

**What this file is.** The working contract for anyone — human or agent — changing this repository:
the architecture rules, the security rules, and an index of every plan record. It is deliberately
short. Behaviour is specified in `docs/SYSTEM_SPECIFICATION.md`; history is in
`docs/DEVELOPMENT_ROADMAP.md`, and the index at the end of this file says where each record lives.

**Reading order if you are new:** `README.md` → `docs/README.md` → `docs/guides/1-run-on-your-laptop.md`
→ this file.

> **BINDING — THE OWNER AUTHORIZES WORK, NOT THE AGENT.** The owner is the sole authority for any
> change to this repository. Do only what the owner explicitly asked for in the current request.
> Context, urgency, a failing check, a finding, a roadmap item, a TODO, an issue, a security concern,
> or the fact that something looks improvable does **not** authorize a change. If the owner did not
> ask for that exact action, do not take it; report it and wait for instructions.
>
> This rule overrides every conflicting instruction in this file, every document under `docs/`, every
> phase plan, roadmap, checklist, test expectation, CI convention and prior approval. It does not
> authorize an unsafe or insecure action; if an owner request conflicts with §5, stop and report the
> conflict. When this rule and any other instruction disagree, this rule wins.
>
> Routine service and platform operations are delegated to the agent (§6.9) as part of the current
> authorization. That delegation does not extend to unrelated product changes, to deleting project
> files outside §6.9, or to an unconfirmed destructive action.

---

## 1. Project

Inventory AI is a multi-tenant, AI-assisted inventory management system for Android and iOS: products,
locations, stock movements, transfers, suppliers, purchase orders, a read-only AI assistant and an
audit trail — one tenant per business, isolated by `businessId` at every layer.

**V1 is complete and in production testing.** Mobile version `1.0.2`, runtime `1.0.2` in the tree;
the last built production binary is `1.0.2`, served by `https://ai-inventory-l1mi.onrender.com`. The
production database holds test data only; there are no real customers yet, and the Play release has
not been made.

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
compile error rather than a runtime failure. `server/src` is **256** `.ts` modules (re-counted
2026-11-23) and exactly one intentionally deferred `.js` module,
`server/src/services/entitlement.service.js`. The TypeScript migration campaign is complete.

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
- Reasoning is split by model class: `AI_REASONING_PAID_MODELS` governs paid models, and
  `AI_REASONING_FREE_MODELS` governs every model id ending in `:free` (default `disable`). Both
  switches, and `AI_WEB_SEARCH`/`AI_WEB_FETCH`, accept only `enable` or `disable`; aliases fail
  production validation. Every provider request logs the model class, source and reasoning field
  it actually sends, and every submitted turn logs both effective policies before any provider
  call. The old `AI_REASONING` name is a deprecated fallback for one release; the new name wins
  when both are set, so rename it at the next deploy.

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

# 6. Owner Authorization and Scope — Binding

## 6.1 The one rule

**Do only what the owner explicitly asked for in the current request. Nothing else.**

Do not add, remove, fix, improve, harden, simplify, refactor, optimize, document, test, clean up,
standardize, future-proof or "finish" anything merely because it is related to the request, visible
while inspecting, recommended by a document, required by a phase plan, or likely to be useful.

## 6.2 What counts as authorization

Authorization must be all four of these:

- **Explicit** — the owner names the action. A question, complaint, observation or expression of
  frustration is not authorization to change code.
- **Current** — it comes from the current request, not an earlier conversation, a prior approval, a
  roadmap entry, a commit message, a plan, or another agent's assumption.
- **Specific** — it identifies the feature, bug, file, behavior or outcome. Broad phrases such as
  "fix everything", "clean it up", "make it better", "do what you think is best" or "use your
  judgment" do **not** authorize a particular change; ask for the exact scope.
- **Scoped** — permission to fix X does not include fixing Y, even when X and Y share a file, a test,
  a service or a root cause.

If any of these is missing, stop and ask one precise question. Do not choose a reasonable default
that expands the work.

## 6.3 Never do these without an explicit request

The standing delegation in §6.9 is an explicit owner request for the service and platform operations
it names. It does not authorize unrelated work.

- Add or remove features, screens, routes, fields, options or user-visible behavior.
- Refactor, rename, reformat, reorganize, simplify, deduplicate or modernize code.
- Improve performance, accessibility, reliability, security, error handling or edge-case behavior.
- Add, modify, weaken, delete or expand tests, fixtures, test runners or coverage.
- Add or update documentation, comments, README files, guides, changelogs, roadmaps or logs.
- Add logging, metrics, monitoring, alerts, scripts, CI jobs, configuration, migrations or tooling.
- Install, upgrade, remove or replace dependencies; edit lockfiles; change build or deployment setup.
- Change `.env`, secrets, credentials, accounts, GitHub settings, branch protection or service plans.
- Create, commit, push, merge, rebase, tag, stash, pop, drop, reset, force-push or rewrite history.
- Deploy, publish, release, OTA-update, run migrations, seed data, or write to production or shared
  environments.
- Fix a problem found while inspecting, reviewing, testing or debugging unless the owner explicitly
  asked for that specific fix.
- Implement a "follow-up", "next step", "recommendation", "improvement" or "quick win" you identified.
- Make a "while I am here", "small", "safe", "obvious" or "low-risk" adjacent change.

If a requested action is impossible without one of the above, stop before doing it and ask the owner
to approve that additional work explicitly.

## 6.4 Read-only requests stay read-only

When the owner asks you to inspect, review, test, verify, audit, diagnose, explain, investigate or
answer a question, make **no changes**. Report findings, evidence and risks, then stop. Finding a bug
during a read-only task does not turn it into a repair task.

When asked to fix a specific bug, change only what is necessary to fix that bug. Do not fix nearby
warnings, add regression tests, update documentation or improve the surrounding module unless the
owner explicitly includes those actions.

## 6.5 Verification is part of the requested change, not a new project

Run the smallest check that confirms the exact requested change. Do not broaden verification into an
unrequested audit. Do not create tests or test infrastructure unless the owner explicitly asked for
them. Report every check not run and why; never describe an untested change as verified.

## 6.6 No self-assigned work

The following are **not** work queues and must never be acted on without a new, explicit owner
request: phase tables, roadmaps, development logs, TODO/FIXME comments, failing tests, lint warnings,
security advisories, monitoring signals, dependency updates, open issues, pull requests, code review
comments, metrics, documentation gaps and "best practice" recommendations. They may be read and
reported; they may not be executed.

## 6.7 When prior unrequested work is found

Do not silently revert, rewrite, hide or "clean up" it. List the affected files, commits or behavior
with evidence and ask the owner whether to keep, revert or replace each item. Never touch a stash,
branch or commit unless the owner explicitly names it.

## 6.8 Required reporting

Every final report must state:

- The exact owner request that authorized the work.
- Every file changed, and why that file was necessary for that request.
- The checks actually run and their results.
- Anything intentionally not changed, and anything found but left for the owner to decide.

If no change was requested, make no change and say so. A question gets an answer, not a modification.

## 6.9 Delegated service and platform authority

The owner delegates routine operation of these service accounts and platforms: GitHub, Firebase,
MongoDB Atlas, OpenRouter, Render, Brevo, Expo, UptimeRobot and the project's Gmail accounts. Within a
task the owner has already requested, the agent may act on them without asking again for each
reversible step:

- Inspect status, logs, metrics, configuration, indexes, deploys, builds, domains, billing state and
  quota through existing credentials, CLIs and APIs, including read-only production checks.
- Make routine, reversible configuration changes.
- Edit project files, and delete only disposable test data the requested task itself created — its
  own fixtures, temporary files, scratch collections or scratch rows.

Deleting any other file — source, test, documentation, configuration, migration or committed data —
still needs the owner's explicit request. The delegation is not a general permission to delete
project files, and it does not authorize unrelated product changes, refactors, monitoring layers or
key systems.

The service access matrix — which credential each service uses, where it is stored, and the status-only
command that proves every one of them — is `docs/AGENT_ACCESS.md`. Run `cd server && npm run
access:check` before blaming a service, and update that document when a credential moves.

Two limits are absolute:

- **Credentials and MFA codes are never handled as content.** Do not print, commit, paste into chat or
  store a credential, API key, TOTP secret or MFA backup code, and never create, copy or move MFA
  backup codes. Enrollment and recovery-code custody stay with the owner.
- **Destructive or irreversible actions need a fresh confirmation.** Deleting a database, collection
  or account, rotating or revoking a credential, changing billing, force-pushing or deploying to
  production requires the exact target and effect, stated and confirmed immediately beforehand.

## 6.10 Security-change notes

For every security configuration change, write a dated note with a descriptive filename in the
location the owner keeps such notes: what changed, which account or service was affected, when and how
it was verified. The note never contains a password, API key, TOTP secret or MFA backup code; record
only that codes were generated and where the owner stored them.

---

# 7. Delivery Workflow — Only After Authorization

This section replaces autonomous phase execution. A phase record, plan or roadmap may describe past
work, but it does not authorize future work.

1. **Identify the exact request.** Quote it to yourself. If it is ambiguous or broad, stop and ask.
2. **Inspect only what is needed** to understand that request. Do not survey unrelated code.
3. **Make the smallest change** that satisfies it. Do not add unrelated files, tests, docs, comments,
   dependencies, configuration or refactors.
4. **Verify only that change** with the smallest relevant existing check. Report the exact command and
   result. Do not run a broad suite or audit unless the owner asked for one.
5. **Stop.** Do not commit, push, merge, deploy, update the development log or roadmap, or begin a
   follow-up unless the owner explicitly asked for that separate action.

The phase overview is history, not a work list. Every increment is a numbered record in
`docs/DEVELOPMENT_ROADMAP.md` (§27…); the identifiers are listed at the end of this file, and
planned-but-unbuilt work lives in `docs/BACKLOG.md`. Do not infer a task from an incomplete phase, a
planned item or a numbered record.

## Documentation index — every plan record

`docs/DEVELOPMENT_ROADMAP.md` declares the identifiers below, in order. They are listed here so that
every record is reachable from the instruction file; read a record by searching its identifier in the
roadmap. Record titles are deliberately not repeated — that index grew to 320 copied rows and drifted
from the headings it duplicated.

**§27B**, **§27C**, **§27D**, **§27E**, **§27F**, **§27G**, **§27H**, **§27I**, **§27J**, **§27K**, **§27L**,
**§27M**, **§27N**, **§27O**, **§27P**, **§27Q**, **§27R**, **§27S**, **§27T**, **§27U**, **§27V**, **§27W**,
**§27X**, **§27Y**, **§27Z**, **§27AA**, **§27AB**, **§27AC**, **§27AD**, **§27AE**, **§27AF**, **§27AG**,
**§27AH**, **§27AI**, **§27AJ**, **§27AK**, **§27AL**, **§27AM**, **§27AN**, **§27AO**, **§27AP**, **§27AQ**,
**§27AR**, **§27AS**, **§27AT**, **§27AU**, **§27AV**, **§27AW**, **§27AX**, **§27AY**, **§27AZ**, **§27BA**,
**§27BB**, **§27BC**, **§27BD**, **§27BE**, **§27BF**, **§27BG**, **§27BH**, **§27BI**, **§27BJ**, **§27BK**,
**§27BL**, **§27BM**, **§27BN**, **§27BP**, **§27BQ**, **§27BR**, **§27BS**, **§27BT**, **§27BU**, **§27BV**,
**§27BW**, **§27BX**, **§27BY**, **§27BZ**, **§27CA**, **§27CB**, **§27CC**, **§27CD**, **§27CE**, **§27CF**,
**§27CG**, **§27CH**, **§27CI**, **§27CJ**, **§27CK**, **§27CL**, **§27CM**, **§27CN**, **§27CO**, **§27CP**,
**§27CQ**, **§27CR**, **§27CS**, **§27CT**, **§27CU**, **§27CV**, **§27CW**, **§27CX**, **§27CY**, **§27CZ**,
**§27DA**, **§27DB**, **§27DC**, **§27DD**, **§27DE**, **§27DF**, **§27DG**, **§27DH**, **§27DI**, **§27DJ**,
**§27DK**, **§27DL**, **§27DM**, **§27DN**, **§27DO**, **§27DP**, **§27DQ**, **§27DR**, **§27DS**, **§27DT**,
**§27DU**, **§27DV**, **§27DW**, **§27DX**, **§27DY**, **§27DZ**, **§27EA**, **§27EB**, **§27EC**, **§27ED**,
**§27EE**, **§27EF**, **§27EG**, **§27EH**, **§27EI**, **§27EJ**, **§27EK**, **§27EL**, **§27EM**, **§27EN**,
**§27EO**, **§27EP**, **§27EQ**, **§27ER**, **§27ES**, **§27ET**, **§27EU**, **§27EV**, **§27EW**, **§27EX**,
**§27EY**, **§27EZ**, **§27FA**, **§27FB**, **§27FC**, **§27FD**, **§27FE**, **§27FF**, **§27FG**, **§27FH**,
**§27FI**, **§27FJ**, **§27FK**, **§27FL**, **§27FM**, **§27FN**, **§27FO**, **§27FP**, **§27FQ**, **§27FR**,
**§27FS**, **§27FT**, **§27FU**, **§27FV**, **§27FW**, **§27FX**, **§27FY**, **§27FZ**, **§27GA**, **§27GB**,
**§27GC**, **§27GD**, **§27GE**, **§27GF**, **§27GG**, **§27GH**, **§27GI**, **§27GJ**, **§27GK**, **§27GL**,
**§27GM**, **§27GN**, **§27GO**, **§27GP**, **§27GQ**, **§27GR**, **§27GS**, **§27GT**, **§27GU**, **§27GV**,
**§27GW**, **§27GX**, **§27GY**, **§27GZ**, **§27HA**, **§27HB**, **§27HC**, **§27HD**, **§27HE**, **§27HF**,
**§27HG**, **§27HH**, **§27HI**, **§27HJ**, **§27HK**, **§27HL**, **§27HM**, **§27HN**, **§27HO**, **§27HP**,
**§27HQ**, **§27HR**, **§27HS**, **§27HT**, **§27HU**, **§27HV**, **§27HW**, **§27HX**, **§27HY**, **§27HZ**,
**§27IA**, **§27IB**, **§27IC**, **§27ID**, **§27IE**, **§27IF**, **§27IG**, **§27IH**, **§27II**, **§27IJ**,
**§27IK**, **§27IL**, **§27IM**, **§27IN**, **§27IO**, **§27IP**, **§27IQ**, **§27IR**, **§27IS**, **§27IT**,
**§27IU**, **§27IV**, **§27IW**, **§27IX**, **§27IY**, **§27IZ**, **§27JA**, **§27JB**, **§27JC**, **§27JD**,
**§27JE**, **§27JF**, **§27JG**, **§27JH**, **§27JI**, **§27JJ**, **§27JK**, **§27JL**, **§27JM**, **§27JN**,
**§27JO**, **§27JP**, **§27JQ**, **§27JR**, **§27JS**, **§27JT**, **§27JU**, **§27JV**, **§27JW**, **§27JX**,
**§27JY**, **§27KA**, **§27KB**, **§27KC**, **§27KD**, **§27KE**, **§27KF**, **§27KG**, **§27KH**, **§27KI**,
**§27KJ**, **§27KK**, **§27KL**, **§27KM**, **§27KN**, **§27KO**, **§27KP**, **§27KQ**, **§27KR**, **§27JZ**,
**§27KS**, **§27KT**, **§27KU**, **§27KV**, **§27KW**, **§27KX**, **§27KY**, **§27KZ**, **§27LA**, **§27LB**,
**§27LC**, **§27LD**, **§27LE**, **§27LF**, **§27LG**, **§27LH**, **§27LI**, **§27LJ**

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

The current read-only tools are:

```text
searchProducts
findProducts
getProduct
getInventory
getHighestStockProducts
getLowStockProducts
getOutOfStockProducts
getProductsNeverSold
getProductStockCoverage
getReorderNeededProducts
getStockValue
getCatalogOverview
filterPreviousResults
getInventorySummary
getLocationBreakdown
getInventoryHistory
getProductsByLocation
listLocations
listCategories
listBrands
researchInventoryProducts
researchMarketPrices
```

`listLocations`, `listCategories` and `listBrands` are reference lookups (AI-14):
the inventory tools take IDs, and these are the only way to turn a name a member
said into one. They read the same records as the locations, categories and brands
read routes, which are authentication-only, so they are gated on the read
permission of the capability they serve and can narrow nobody. `findProducts`
adds exact identity lookup (AI-91); `getStockValue` groups by recorded currency;
`getProductStockCoverage` is the one-product, windowed run-out read (AI-118);
the two research tools are the gated web-research fallback described in Guide 17.
No tool writes.

`filterPreviousResults` is offered only when the immediately previous answer left a bounded
product-id set and the member's question explicitly refers to it (`which of those`, `among them`).
It re-reads current stock for those products under the authenticated business and applies only a
category, location, low/out-of-stock filter; it cannot broaden the set. The first provider call of
such a follow-up names it as the required tool, so the narrowing read is not left to model choice.

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

The map is [`docs/README.md`](docs/README.md); the branch, documentation and pull-request loop is
[`CONTRIBUTING.md`](CONTRIBUTING.md). A new active document must be linked from the map; the root
`scripts/check-docs.mjs` guard fails otherwise.

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

The project identity belongs to nreffejzxc. Claude Code is only an implementation tool and must NOT be represented as a project author, contributor, co-author, or attribution identity.

Canonical project identity:

* Project: Inventory AI
* Owner: nreffejzxc
* GitHub display name: nreffejzxc
* GitHub username: nreffejzxc
* Git identity: nreffejzxc
* Commit email: jeffernmalinaoqwe@gmail.com
* Implementation: nreffejzxc
* Attribution: nreffejzxc only

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
   commit, branch, pull request, changelog or release note is nreffejzxc's own name and the commit email
   above.**

4. Do NOT identify Claude Code, Anthropic, Codebuff or any other tool as the author, co-author,
   contributor, implementer or owner of Inventory AI. Implementing, modifying, testing, debugging and
   documenting the project does not make a tool an author or contributor.

5. Git author **and** committer identity must be the repository's configured nreffejzxc
   identity. Verify with `git config user.name` / `git config user.email` before creating a commit; the
   two must be `nreffejzxc` and the commit email above. If either differs, **report the mismatch** —
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
   changelogs, release notes and project documentation, unless nreffejzxc explicitly overrides it for one
   specific case.

9. Rewriting history stays forbidden **except on nreffejzxc's explicit request.** nreffejzxc requested it once,
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

# 20. Resource Conservation and Repository Health

These are permanent operating rules, not a one-off checklist. The daily evidence lives in
[`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md); this section says what must be true before and
after the work that the log records.

## Session protocol

- **Start** by reading the log's *Current position*, its newest entry and the newest roadmap record.
  Continue unfinished work before starting something new unless a higher-priority issue is found.
- Do not redo anything the roadmap records as verified. If it must be re-checked, say why.
- **During** the session, note decisions, discoveries and failures as they happen. A later reader
  must be able to tell an assumption from a measurement.
- **End** by updating the log: what was completed and how it was verified, what is in progress, what
  was not done and why, findings, blockers, resource use and the next priority. Update the roadmap
  when a status, priority or milestone changes. Never record "complete" because code was written, a
  commit exists or a deploy was triggered — only because the check was run and its result seen.
- **Close** on `main` with no uncommitted files and no unpushed commits.
  `node scripts/check-repo-state.mjs` fetches `origin/main` and must report the worktree clean and
  `main` level with it. A docs-only change still needs its own pull request; it does not need a
  Render deploy.

## AI assistant testing

- **All questions in one conversation.** A multi-question AI evaluation — the 20-question phone
  matrix, a live prompt set, a regression run — starts one chat and asks every question there, in
  order. Do not open a new chat per question, and do not switch between conversation windows during
  the run. Record the conversation ID; a result gathered across multiple chats is invalid and must
  be rerun.
- **A clean context is a separate, labelled run.** If a question genuinely needs an empty history,
  run that as its own explicitly named evaluation, not as a reset in the middle of a matrix.

## Expo EAS builds — one allowance, spent deliberately

- **No build merely because code changed.** First ask: can the installed build test this? can an
  OTA carry it? does it touch native dependencies, native config, permissions or assets that need a
  binary? what does the current allowance say?
- If a build is genuinely needed, include every pending compatible change, run the reviews,
  typechecks, tests and config checks first, and confirm the profile, channel, environment and
  runtime. A build that has to be repeated the next day is the expensive option.
- A refused build can still consume a `versionCode`. Do not retry into an exhausted quota; wait for
  the reset or find another verification path, and say which one you chose.
- `mobile/scripts/check-ota-publish.mjs` is the gate. `--allow-native-change` is for a declared
  emergency, never for convenience.
- Do not delay a critical security or inventory-integrity fix to save a build. State why the build
  is necessary and spend the allowance.

## OTA updates

- JavaScript and assets only, and only to a runtime the installed binary actually has. Check the
  channel, branch, environment and runtime before publishing.
- Run the relevant tests and confirm the update cannot break installed builds.
- No repeated or speculative publications, and **no production OTA without the owner's
  authorisation**.

## GitHub Actions and Render

- CI runs per pull request and on `main`; batch small commits rather than pushing a cosmetic
  follow-up that reruns the whole suite. Do not add workflows, schedules or triggers without a need.
- Render deploys only when `server/` changes. A docs or mobile merge will not move the production
  commit — do not read that as a failed deploy. Verify with `GET /api/health` (`commit`).
- Report Actions minutes and build/OTA use when the APIs expose them; if a figure cannot be read,
  say so rather than guessing.

## GitHub security and repository health

- Periodically inspect Dependabot, code scanning, secret scanning, workflow permissions,
  collaborators, and stale branches or pull requests. For each finding: severity, real impact,
  whether a safe fix exists, and what needs approval.
- Fix what is safe, test it, and report the rest. Never print a secret value.
- Without explicit approval: do not rotate production credentials, change ownership or access,
  delete branches, discard unmerged work, close pull requests or force-push.
- Git identity stays `nreffejzxc` / `jeffernmalinaoqwe@gmail.com`. If either differs, report the
  mismatch; never silently change it.

## Priority order

1. Critical security vulnerabilities and data-integrity risks.
2. Bugs that can corrupt inventory or create duplicate transactions.
3. Broken production features and availability.
4. Reliability and performance.
5. Missing V1 functionality.
6. UX and operational workflows.
7. Maintenance and optional enhancements.

Weigh impact, risk, testing cost and resource use before choosing. Do not add unrelated features or
optional work that the request did not ask for.

---

# 21. Final Rule

When uncertain about implementation details, prioritize:

1. `docs/SYSTEM_SPECIFICATION.md`
2. Existing project architecture
3. Security
4. Data integrity
5. Maintainability
6. Simplicity

Never sacrifice security, authorization, business isolation, or inventory consistency for convenience.
