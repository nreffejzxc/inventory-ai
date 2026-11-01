# Development Log

**What this file is.** The living state of Inventory AI: what is being worked on now, what each
session actually finished and verified, what is blocked, and what should happen next. It is updated
at the end of every development session, newest entry first.

**What this file is not.** It is not the roadmap, the specification, or a release note.

| Question | Document |
| --- | --- |
| What is true today, what is half-done, what is next? | **this file** |
| What happened in a phase, with its measurements? | [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) — append-only §27 records |
| Has this already been built, in one line? | [`PHASE_HISTORY.md`](PHASE_HISTORY.md) |
| What must the system do? | [`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md) |
| What are the architecture, security and phase rules? | [`../CLAUDE.md`](../CLAUDE.md) |

## How to maintain this log

1. **One entry per development session**, newest first. Same-day sessions may be merged if they
   share a plan; otherwise give each its own dated heading with a short purpose.
2. **"Completed" means executed and observed.** A file written, a commit made, a test written or a
   deploy triggered is not completion. State the command and the result, or leave the item under
   *In progress* / *Not completed*. A passing build is not a passing feature.
3. **Record what failed and why.** An abandoned approach that cost an hour is worth two lines; it
   is how the next session avoids repeating it.
4. **Never rewrite an old entry.** If a later session proves an earlier statement wrong, add a new
   entry that names the correction. The roadmap's append-only rule applies here too.
5. **Update *Current position* in the same edit** as the new entry. If it no longer matches the newest
   entry, the log is wrong at the top, which is where people read.
6. **Link evidence** to the roadmap record, test file, commit or evidence directory rather than
   pasting long output.
7. **No secrets, no credentials, no personal data.** Environment variable *names* only.
8. **Start the next session here.** Read *Current position*, the newest entry and the newest roadmap
   record before choosing work. Continue unfinished work unless a higher-priority issue is found.
9. **Record resource use in the entry** — EAS builds, OTA publications, noteworthy CI runs and
   deploys — and update *Resource budgets* when a limit or reset changes. The full operating rules
   are `CLAUDE.md` §20.

---

## Current position

**Updated:** 2026-11-01
**Goal:** finish and harden Inventory AI **V1** through production testing. No Play Store or App
Store release is being prepared.

| | |
| --- | --- |
| **Working now** | A one-location tenant exists in production, ready to be signed into on the phone; the default itself has not yet been seen there |
| **Just verified** | The tenant (`6ae6f1d8baa72cee39730240`) holds 11 products and exactly one ACTIVE location (`Main Warehouse`); the app's own `status=ACTIVE` query returns 1; the seeded login completed Firebase sign-in and the exchange. Earlier today: `single-location-default` **4/4** with a mutation check, the movement group **15/15**, and the stock-in link fix **4/4** |
| **Blocked** | Nothing. The phone check needs the owner at the device, because switching accounts signs out the current session |
| **Next after this** | Sign in on the phone as the seeded login and confirm a movement opens with Main Warehouse chosen; remove the tenant afterwards or keep it as a demo; decide the assistant's transfer grouping |

### Open items carried forward

| Item | State | Why it is open |
| --- | --- | --- |
| Single-location default, on a real device | Ready, phone pending | The production tenant `6ae6f1d8baa72cee39730240` now has exactly one ACTIVE location, and §27HF pins the late-arriving list for all three kinds; the visual check needs the owner to sign in on the phone |
| Late product param on a cold link | Known, same class as §27HE | `initialProductId` is still seeded once at mount; a link whose product param resolves after the first render would leave the product unset. The location now arrives; the product picker is visible and required, so it is recorded rather than changed |
| A transfer is two movements to the assistant | Known representation | The AI lists both ledger legs; Recent Activity renders one card. Decide whether the assistant should group legs in future |
| `glob` and `minimatch` advisories | Deferred, D-10 | Patched `14.0.2` / `11.0.1` are majors outside every consumer's range; re-check the gates in `SECURITY_DEPENDENCY_DECISIONS.md` §4 |
| Two mobile Dependabot advisories (`zod`, `deepmerge`) | Deferred | No fix inside the consumer's declared range; do not force versions |
| OTA code signing | Blocked by EAS plan | Free plan only; a signed binary would reject unsigned publishes |
| Play release | Not started, deliberately | V1 testing first |
| L-17 password-reset action URL | Open, console-only | Cannot be set from code |
| iOS device acceptance | External verification required | No macOS on the development host |

### Resource budgets

Known limits, checked before spending one of them:

- **EAS Android builds** — free plan, monthly cap. The October quota was exhausted; the reset was
  used for **one** build on 2026-11-01 (`64958ea2`, versionCode 7), which carried AI-41 and the
  Sprint 1 mobile fixes together on purpose. The attempt the quota refused still incremented
  `versionCode` 5 → 6 without producing an artifact; the successful build took it to 7. Do not retry
  a build while the quota message is present, and prefer an OTA when the change is JavaScript-only *and*
  `mobile/scripts/check-ota-publish.mjs` passes.
- **OTA updates** — free, but not unconditional. Runtime is `appVersion`; a native dependency or
  config that moved after the installed binary makes an OTA unsafe even when the change is JS-only.
  `check-ota-publish.mjs` is the gate; `--allow-native-change` is for a declared emergency only.
  On 2026-11-01 it correctly refused an OTA to the installed `1.0.0`, which is why a build was spent.
- **GitHub Actions** — free minutes. CI runs per pull request and on `main`. Batch small changes
  into one push rather than re-running the suite for each tweak.
- **Render** — one production service; it deploys only when `server/` changes. A docs or mobile
  merge will not move the serving commit, so verify at `GET /api/health` (`commit` field) instead of
  expecting every push to redeploy.
- **MongoDB Atlas** — the free tier has a storage and connection ceiling (measured at 512 MB,
  §27GE). Seeding and cleanup follow the phrase-gated commands in
  [`guides/9-seeding-development.md`](guides/9-seeding-development.md) and
  [`guides/10-seeding-production.md`](guides/10-seeding-production.md); never delete data to free
  space that a backup or an index change would explain.
- **Brevo** — used for verification codes, reset codes and invitations. Do not send test mail in
  bulk; a delivery failure is not a code regression until the provider log says so.

---

## 2026-11-01 — The reconciliation: work `main` documented but did not contain

### Planned

- Reconcile the pre-rewrite checkout with `origin/main` without losing unique work, then retire the old branch.
- Recover §27HA and §27GY, which `main`'s roadmap and policy documents describe as shipped but whose code was absent from its tree.

### Completed and verified

| Item | Evidence |
| --- | --- |
| Checkout preserved before any reset. | `archive/runbook-verification-updates-2026-11-01` points at the old HEAD `a7ff713`; `.tmp-reconcile-backup/` holds the tracked patch and every untracked file. |
| Unique work identified, not guessed. | The pre-rewrite tree was compared file by file with `origin/main`: the duplicate audit, its test, the npm script, the test registration, the zod published-CLI gate and the implementation plan §27GY cites were the only missing pieces. Older dependency versions and superseded documents were not carried. |
| Recovered files. | `8aae1b3`: `server/scripts/audit-duplicate-ledger.mjs`, `server/scripts/lib/duplicate-ledger.mjs`, `server/test/audit-duplicate-ledger.test.mjs`, `audit:duplicates` in `server/package.json`, the MIXED registration in `server/scripts/run-tests.mjs`, `scripts/check-upgrade-watches.mjs`, and matching `SECURITY.md` / `docs/SECURITY_DEPENDENCY_DECISIONS.md` text. |
| §27GY's cited plan. | `docs/superpowers/plans/2026-10-30-expo-cli-zod4.md` is restored so the roadmap's link resolves; its Gate Z describes the same published-CLI gate the watch now measures. |
| Duplicate audit tested against MongoDB. | `TEST_MODE=full node --test test/audit-duplicate-ledger.test.mjs` → **30/30 pass, 0 fail**, including the real-MongoDB pairs, the hour-boundary case and the planted-write control. |
| Zod gate controls. | `node scripts/check-upgrade-watches.mjs --self-test` → **32 controls passed** (6 must-fire, 24 must-not-fire, 2 range), exit 0. |
| Live watch. | `node scripts/check-upgrade-watches.mjs` exits 0. `node-forge` **CLOSED**, `deepmerge` **DEFERRED**, `zod` **UNPARSED**: latest `expo` 58.0.22 admits `@expo/cli` 58.1.18, whose manifest declares no `zod`; the installed tree still resolves 3.25.76. |
| Old branch retired. | `chore/reconcile-main-2026-11-01` is based directly on `origin/main`; the old branch is deleted and retained only as the archive ref. |
| Documentation guards. | The four doc suites pass **28/28** in a clean worktree at this commit. In the main checkout the issue-record scan also reads the stale `.tmp-*` worktrees and reports the fabricated identifier in the guard's own comment, so that reading is environmental, not a record. |

### Not completed

- The full server and mobile suites were not re-run. No application source, dependency or lockfile was carried, so the recovered scripts are the only executable change.
- The identity block in this checkout's `CLAUDE.md` was **not** carried: it names `jeffernqwerty` / `jeffernmalinaoqwe@gmail.com`, while `main`'s 2026-10-31 restoration record names `nreffejzxc` / `jefferndullamalinaozxc@gmail.com`. This needs the owner's decision.
- Nothing was pushed; the commit is local.
- Four registered `.tmp-*` worktrees and several untracked scratch files remain. They were left untouched because they may hold pending work; their copies of that comment are what the main-checkout guard reads.

### Findings

- The `zod` watch returns `UNPARSED` rather than a pass because the admitted CLI's `zod` dependency is absent, not because the registry was unreachable. The conservative rule treats a missing range as unreadable. Whether an absent dependency should mean the advisory is closed by removal is a decision for the next session.
- The verification ran on Node **26.10.0**, while the repository pins **24** in `.nvmrc`. The suite passed, but the runtime is outside the pin.

### Next priority

- Decide the identity mismatch and the missing-`zod` gate, then push the reconciled branch through the normal PR and CI path.

## 2026-11-01 — minimatch/glob advisories: no safe in-range fix, deferred with evidence

### Planned

- Triage the four medium Dependabot alerts: two advisories (`minimatch`, `glob`) across the server and
  mobile lockfiles.
- Fix them if a safe in-range release exists; otherwise record the disposition and the exact gate.

### Completed and verified

| Item | Evidence |
| --- | --- |
| Advisory records read. | `minimatch` GHSA-g3hv-75wg-m249, `< 11.0.1`; `glob` GHSA-3g3m-2fjr-6pw4, `>= 9.0.0 <= 14.0.1`; both medium, DoS/traversal class. |
| Dependency paths traced in both trees. | Server: `firebase-admin → google-gax → rimraf → glob@10.5.0 → minimatch@9.0.9` in production, plus `eslint`/`typescript-eslint` `minimatch@10.2.6` in development. Mobile: `glob@13.0.6` through Expo CLI/config/Metro/Jest, `glob@10.5.0` through `test-exclude`, and `minimatch@10.2.6 / 9.0.9 / 3.1.5` through ESLint and the same chains. |
| Patch floors measured against every consumer. | `glob` consumers declare `^7`, `^10` or `^13`; `minimatch` consumers declare `^3` or `^10`. The patched releases are `14.0.2+` and `11.0.1+` — majors no parent admits. `npm view` confirms the newest are `14.0.3` and `11.0.3`. |
| The "fix" was checked rather than assumed. | `npm audit fix --dry-run` on the server changes 14 packages including a `google-gax` **downgrade** `5.0.8 → 5.0.4` and still leaves the `glob` advisory. `--force` proposes `eslint@4.0.0` or `expo-updates@0.27.5`. Not taken. |
| Reachability measured, not inferred. | No `glob`/`minimatch` import in `server/src`, `mobile/app`, `mobile/lib`, `mobile/components` or `mobile/hooks`. Server path is google-gax/rimraf temp-file cleanup; mobile path is build/test tooling. Neither is in a shipped bundle. |
| Disposition recorded. | `docs/SECURITY_DEPENDENCY_DECISIONS.md` D-10: accepted and documented, no override, no forced audit fix; §4 lists the gates that end it. |
| Documentation guards. | `phase-docs-section-integrity` + `phase-docs-fact-drift` **14/14** on the clean tree. |

### Not completed

- No dependency was changed. There is no patched release inside any consumer's declared range, and an
  override would be an unreviewed major upgrade of build tooling for a non-reachable advisory.

### Findings

- `npm audit` counts dependents: the server's 16 entries are 2 distinct advisories; mobile's 48 are 4.
- Dependabot's six open alerts are four advisories across two manifests, not six separate defects.
- The existing upgrade-watch script cannot model these two: each has several consumers with different
  ranges, so a single-consumer watch would report `READY` when only one parent had widened. The gates
  are therefore explicit prose in the decision record, not a misleading machine status.

### Blockers

- Upstream only: `glob`/`minimatch` need a release inside `^7`/`^10`/`^13` and `^3`/`^10`, or the
  parents (`expo-updates`, `@expo/cli`, `rimraf`, `test-exclude`, `eslint`, `@typescript-eslint`) must
  widen. Nothing in this repository can close them without an override.

### Next priority

1. The stock-in deep-link bug that ignored `locationId`.
2. The single-location default on a real one-location tenant.
3. Re-run this triage when a parent widens or `firebase-admin` moves; then a normal bump should close
   both alerts.

**Resource use:** no EAS build, no OTA, one CI run.

---

## 2026-11-01 — A one-location tenant in production, for the default to be seen

### Planned

1. Check whether production already holds a one-location tenant.
2. If not, create one through the sanctioned seeder rather than a hand-written record.
3. Leave exactly one ACTIVE location through the app's own audited route.
4. Record the login, the ids and how to remove it.

### Completed and verified

| Item | Evidence |
| --- | --- |
| The three real test tenants were read only. | `check:accounts --with-production` → **3/3 READY**; each holds a multi-location seeded business |
| The seeder's plan was checked before writing. | `seed:perf-tenant --size=50 --dry-run` → "would be CREATED (no seed tenant exists yet)", so no existing tenant would be replaced |
| A new tenant was created. | `seed:perf-tenant --size=50` → business `6ae6f1d8baa72cee39730240`, login `perf-seed-ai@example.invalid`, **11 products / 2 locations / 19 inventory rows / 12 ledger movements**; the seeder re-counted every collection and checked all 12 movements |
| Exactly one location is left. | `Main Warehouse` (`6ae6f1d9baa72cee39730246`) **ACTIVE**; `Shop Front` (`…247`) **ARCHIVED** — through `POST /api/locations/:id/archive` as the tenant's OWNER, which writes an audit row |
| The app's own query returns one. | `GET /api/locations?status=ACTIVE&page=1&limit=100`, the exact query `useActiveRef` sends → **1 — Main Warehouse** |
| The login works through the production path. | Firebase REST password sign-in → `POST /api/auth/firebase/exchange` both succeeded; the script prints no token |
| No build, OTA or deploy. | The installed `1.0.1` already carries the default; switching tenants needs no new binary |

### Not completed

| Item | Reason |
| --- | --- |
| Signed in on the phone | The app is still in `jaffy royal kludge`; switching accounts signs that session out, so the owner has to do it at the device. The generated password is in `.tmp-demo-tenant/password`, deliberately untracked |
| A presentable tenant name | The seeder fixes it as "PERF SEED — AI assistant stress test (do not use)"; there is no business-rename route, and a raw database rename was not taken |

### Bugs and findings

- **"One location" is not a seeder option.** The generator always makes 2–6
  (`scale(0.0001, 2, 6)`), so a one-location tenant is reached by archiving the extras through the
  location lifecycle, not by a seed flag.
- **Archiving keeps the inventory rows.** `Shop Front` still holds its stock but disappears from every
  picker, because the pickers read `status=ACTIVE`. For a default-to-one demo that is the intended
  effect; it is not a data deletion.
- **The tenant's name is a fixture name.** A demo-shaped seeder (name, location count) would need code
  and tests; it was not built for this check.

### Blockers

- None. The remaining step needs the phone and the owner's sign-in.

### Next priority

1. Sign in on the phone as `perf-seed-ai@example.invalid` and open Stock In: the location should
   already read **Main Warehouse**, with no picker interaction.
2. Remove the tenant with `cleanup:perf-tenant` once the check is done (three phrases in production),
   or keep it as a standing one-location demo.
3. Decide whether a demo-specific tenant shape deserves a seeder flag.

---

## 2026-11-01 — The single-location default, timed the way a phone loads it

### Planned

1. Choose between a device run and a focused test, and spend the cheaper honest one.
2. Test the default at the timing a phone produces: list in flight at mount, arriving after.
3. Cover all three movement kinds, plus the two-location control.
4. Prove the guard can fail before trusting its green.

### Completed and verified

| Item | Evidence |
| --- | --- |
| Chose the test, not a build. | No one-location tenant exists in production, and the logic is JavaScript; the EAS cap stayed untouched |
| Found the gap in the existing proof. | `movement-workflow-guards` hands the form a **loaded** list; the default is applied by an effect on the `loading → loaded` transition, which no test exercised |
| New focused suite. | `single-location-default` **4/4**: stock-in, stock-out and adjust each fill the only location when it arrives after mount |
| Visibility, not just payload. | Each kind shows the location's name and no placeholder; the submitted payload carries the same id |
| The control. | With two locations the field stays on "Choose a location…", submit stays disabled after a quantity, and nothing is sent |
| The guard can fail. | With the default line commented out, the three one-location tests failed and the control passed; file restored, suite green again |
| The movement group. | `single-location-default`, `movement-workflow-guards`, `inventory-submit-once`, `stock-in-deep-link` **15/15** |
| Static checks. | `tsc --noEmit` clean; ESLint clean on the new file |
| Recorded. | Roadmap §27HF; record count 211 → 212; `CLAUDE.md` index updated |

### Not completed

| Item | Reason |
| --- | --- |
| The same check on hardware | The production test tenant has two locations, so a device would show the two-location control; a one-location tenant would have to be created, and neither a build nor an OTA was spent |
| An OTA carrying §27HE | Not published: production publishing needs authorization, a clean tree and the `check:ota` preflight, none of which this verification session had |

### Bugs and findings

- **"Covered by Jest" was narrower than it read.** The guard mounted the form with the reference list
  already resolved, so the effect that applies the default on a phone never ran in it. A test can exist,
  pass, and still miss the timing that matters.
- **A test-only increment still costs a CI run.** It was sent as one purpose-built pull request rather
  than appended to an unrelated push later.

### Blockers

- None.

### Next priority

1. Decide whether the assistant should group a transfer's two ledger legs.
2. Ship §27HE and §27HF with the next authorized OTA or build, together with anything else pending.
3. Re-check `glob`/`minimatch` when a parent widens (D-10 §4 gates).

---

## 2026-11-01 — The stock-in link keeps its location

### Planned

1. Reproduce the stock-in entry that opened on "Choose a location…" while carrying `locationId`.
2. Fix the cause in the shared movement form, not the screen's presentation.
3. Cover the prefill through the screen with a test that fails before the change.
4. Record it without spending a build, an OTA or a deploy.

### Completed and verified

| Item | Evidence |
| --- | --- |
| Reproduced through the screen, so the param plumbing is under test. | `mobile/__tests__/stock-in-deep-link.test.tsx` mounts `StockInScreen` with `useLocalSearchParams` mocked |
| The first theory was half wrong, and the test said so. | Immediate params already prefilled: named-before-list and id-only both passed on `main`. The only failing case was a param that resolves **after** mount |
| The cause: state seeded once. | `MovementForm` copied `initialLocationId` into `useState`; a late or changed param never reached the field, which kept the placeholder while the payload named the location |
| The fix. | `MovementForm` adopts a supplied location that arrives or changes, unless the member has chosen one on this screen (`locationTouched`); the single-location default and caller precedence are unchanged |
| The regression suite. | `stock-in-deep-link` **4/4**: named prefill before the list answers, id-only resolution, late-param adoption (failed before the fix), and a manual choice that survives a changed link |
| Neighbouring movement behaviour. | `movement-workflow-guards`, `inventory-submit-once`, `screen-focus-load` **16/16** |
| Static checks. | `tsc --noEmit` clean; ESLint clean on `components/MovementForm.tsx` and the new test |
| Recorded. | Roadmap §27HE; the roadmap's record count moved 210 → 211; `CLAUDE.md` index updated |

### Not completed

| Item | Reason |
| --- | --- |
| Re-run on the phone | The installed `1.0.1` predates the change and a JavaScript-only fix does not justify spending the build cap; the failing mechanism is covered by a test, not re-observed on hardware |
| The late product param | `initialProductId` still seeds once; the same class, but the product picker is visible and required, so it is recorded instead of bundled into this fix |

### Bugs and findings

- **"From a row" could not have been the failing path.** A push from a stock row sends `locationId`
  synchronously and the test proves that case already worked. The entry point that legitimately asks
  is the product screen's Stock In, which names no location because a product can sit at several; a
  late-resolving deep link is the other way to see the symptom. §27HD's note is narrowed, not edited.
- **A shown placeholder can hide a set value.** `SelectField` renders "Choose a location…" whenever no
  option matches the value, even if the value is non-empty, so the form can look unset while it would
  submit a location. The adoption fix removes the case seen here; an id that matches no location still
  reads as unset, which is a presentation question rather than this defect.

### Blockers

- None.

### Next priority

1. Verify the single-location default on a one-location tenant (focused test or a device run).
2. Decide whether the assistant should group the two ledger legs of one transfer.
3. Re-check `glob`/`minimatch` when a parent widens its range (D-10 §4 gates).
4. Ship this fix with the next authorized build or OTA, together with anything else pending.

---

## 2026-11-01 — AI-41 local time and the Sprint 1 movement fixes, shipped and measured on the phone

### Planned

1. Ship the timezone-aware assistant to production (server change + a phone build that sends the
   device zone).
2. Ask "what moved today?" on the production app and compare the answer with the phone clock and
   the ledger.
3. Capture the same question on the old build first, so the fix has a measured contrast.
4. Build and install the same APK with the Sprint 1 movement changes, then verify the adjustment
   confirmation and the row-level transfer on the phone.
5. Record both increments and leave the repository, the log and the evidence in agreement.

### Completed and verified

| Item | Evidence |
| --- | --- |
| AI-41 implemented: the client sends the phone's IANA zone; the server validates it, states the local date/time/offset in the prompt, and adds `localTime` to history and dashboard rows. Absent or unknown zone falls back to UTC, never a 400. | Commit `792f7d4`; `server/src/utils/timeZone.ts`; `server/test/AI41-local-time.test.mjs` |
| Merged to `main` and deployed. | PR #111 → `28840f9`; `GET /api/health` reported that commit, environment `production`, database connected |
| Local suite green after the deploy. | `TEST_MODE=1 node --test test/AI41-local-time.test.mjs` → **8/8 pass** (2 suites) |
| **Before** measurement on the installed `1.0.0`, phone in `Asia/Manila`, local clock 2026-11-01 07:29. | Answer: "15 movements recorded today (2026-10-31)", and a movement logged at 06:17 local was quoted as "2026-10-31 22:17" — the UTC instant, labelled "Local time". The defect reproduced end to end. |
| OTA ruled out honestly, not worked around. | `check-ota-publish.mjs` refused a publish to runtime `1.0.0` because native dependencies moved after the installed binary. The guard was correct, so the path became a new production-channel APK rather than `--allow-native-change`. |
| One APK carried both changes. | `production-apk` profile (temporary, not merged) on `deploy/ai-local-time`; mobile `tsc` clean; EAS build **`64958ea2`**, version/runtime `1.0.1`, versionCode 7, commit `452c329`. |
| Installed over `1.0.0` with data preserved. | `adb install -r` → **Success**; `versionName=1.0.1`, `versionCode=7`; the session, tenant and ledger survived, so no sign-in was needed. |
| Adjustment confirmation, cancelled first. | Confirmation named the product, `Main Warehouse`, `from 10 to 7 (-3)` and the reason. **CANCEL** left the form open, wrote **no** `ADJUSTMENT` row and left on-hand at 10. |
| Adjustment confirmation, then confirmed. | **ADJUST** → "Done. … 10 → 7"; exactly **one** `ADJUSTMENT` row (previous 10, new 7, reason `ZZ sprint1 adjust`); on-hand 7. |
| Transfer from the inventory row. | The row screen offered **Transfer to another location**; the form opened with product and source **Main Warehouse** prefilled, available 7. Moved 2 to **Shop Front** → "7 → 5", "0 → 2"; **two** ledger legs under one reference; inventory rows 5 and 2. |
| Recent Activity had no duplicates. | Three cards: transfer 08:47, adjustment 08:45 (−3), stock-in 08:42 (+10). The transfer renders **once** although the ledger has two legs. |
| **After** answer matched the phone clock. | "Four stock movements were recorded today (**2026-11-01**)", at `08:47`, `08:47`, `08:45`, `08:42` — the same instants as the Manila ledger (`00:42Z` → `08:42`). |
| Sprint 1 merged and deployed. | PR #112 (`5ac95e1`, merged **`ad8426e`**); CI green (server, mobile, secret and attribution guards); production `/api/health` moved to `ad8426e`, so the server-side reason gate is live. |
| Both increments recorded. | Roadmap §27HC and §27HD; `CLAUDE.md` index updated to 210 records; evidence in [`evidence/production-device-2026-11-01/`](evidence/production-device-2026-11-01/README.md). |
| Fresh local runs of the affected suites. | `phase04-inventory` **20/20**; mobile `movement-workflow-guards`, `inventory-submit-once`, `screen-focus-load` **16/16**; documentation guards **14/14**. |
| Permanent operating rules recorded, without a second document. | `CLAUDE.md` §20: session protocol, EAS/OTA conservation, Actions and Render facts, GitHub security and repository health, priority order. The log gained a session-start checklist and a resource-use rule; the dated roadmap remains the evidence. The Render bullet here was corrected: a docs-only merge does not move the production commit. |

**Resource use this session:** one EAS Android build (`64958ea2`); four CI runs — PR #112 once,
PR #113 three times, two of them failing on the scratch-copy identifier before the wording fix; one
Render deploy (the server merge `ad8426e`); zero OTA publications.

### Not completed

| Item | Reason |
| --- | --- |
| Single-location default observed on a phone | The production test tenant has two locations; the behaviour is only covered by Jest |
| Server reason gate exercised with a raw production request | No production credential was used for a direct `POST`; the refusal is proven in the test database and the gate is deployed |
| A same-tenant before/after for the clock | The new APK restored a different stored session (`jaffy` / royal kludge) than the one used for the before reading (`jeffy` / inplay). The clock comparison is against the phone and the ledger, and stands; a same-tenant pair would be cleaner |

### Bugs and findings

- **The defect was bigger than a date.** The old answer rendered the UTC instant under the label
  "Local time", so a member could not tell it was eight hours off without checking the clock.
- **A refused EAS build is not free.** The attempt refused by the quota incremented `versionCode`
  5 → 6 before failing; the successful build then took it to 7. The installed APK therefore reports
  versionCode 7.
- **Installing over the app restored a different session than expected.** The phone was signed in as
  `jeffy inplay` before the install and `jaffy royal kludge` after it. Data and session survived, but
  the "after" half ran in a clean tenant with no movements that day; the test records were created
  there deliberately.
- **A stock-in deep link ignored its `locationId`.** `/stock-in?...&locationId=<Main>` opened with
  "Choose a location…", while the row-level transfer prefilled its source from the same params. Not
  fixed here; recorded as the first follow-up.
- **The assistant counts a transfer twice.** Its answer lists both ledger legs as separate
  movements; Recent Activity shows one card. Accurate to the ledger, but a member may read it as a
  duplicate. Candidate for a future prompt or tool-shape change.
- **The lock screen blocked adb.** The six-digit passcode cannot be supplied over adb; the run paused
  until the owner unlocked the phone. Plan for that in future device sessions.
- **`TZ=Asia/Manila` does not work in this Git Bash.** The host's `date` ignored it and printed UTC.
  Read the phone's own zone (`getprop persist.sys.timezone`) and clock instead.

### Blockers

- None for the work above. The next EAS build is bounded by the monthly quota; the OTA path remains
  gated by the native-runtime check.

### Next priority

1. Remove the temporary build worktrees and scratch scripts, keeping the evidence directory.
2. Reproduce and fix the stock-in deep link's ignored `locationId`; add a guard that a supplied
   location is shown, not silently dropped.
3. Verify the single-location default on a one-location tenant (device or a focused test).
4. Decide whether the assistant should group the two legs of one transfer before more members see
   the current wording.
5. Keep this log's *Current position* updated at the start and end of the next session.
