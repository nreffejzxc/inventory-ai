# Development Log

**What this file is.** The living state of Inventory AI: what is being worked on now, what each
session actually finished and verified, what is blocked, and what should happen next. It is updated
at the end of every development session, newest entry first.

**What this file is not.** It is not the roadmap, the specification, or a release note.

| Question | Document |
| --- | --- |
| What is true today, what is half-done, what is next? | **this file** |
| What happened in a phase, with its measurements? | [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) — append-only §27 records |
| Has this already been built, in one line? | [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) — one record per increment |
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

**Updated:** 2026-11-26
**Goal:** finish and harden Inventory AI **V1** through production testing. No Play Store or App
Store release is being prepared.

**Where the code is (2026-11-26).** Branch `fix/overview-stock-filters` at `d495c1d`; that branch is
**PR #364** (`feat(products): align Overview filters and add resumable CSV import`), open, mergeable,
**7/7 required checks green**, 193 files, +22,385 / −839. It is **21 commits ahead of `origin/main`**
and 23 ahead of the deployed commit.

**What is deployed.** Production is `https://ai-inventory-l1mi.onrender.com` on `fe646c1`: `/api/health`
reports `status: ok`, `db: connected`; `/api/health/ready` answers **200 `ready`**; the integrity
heartbeat is fresh. Production holds test data only.

**Uncommitted in this tree.** A documentation consolidation (this log, `CLAUDE.md`'s phase index, the
new `docs/BACKLOG.md` and the retirement of the stale planning set) and the §6.9/§6.10 rule revision.
Nothing is committed, pushed, merged or deployed. Two stashes are parked and untouched:
`stash@{0}` (the audit/recovery hardening layer, preserved on branch
`recovery/parked-audit-layer-2026-11-26` as `e958ffe`) and `stash@{1}` (an `.env.example` cleanup).

**Blocked or deliberately not started**

| Item | State | Why |
| --- | --- | --- |
| Play release | Not started, deliberately | V1 testing first; the store artifact is still unproven |
| iOS device acceptance | External verification required | No macOS on the development host |
| OTA code signing | Blocked by EAS plan | Free plan only; a signed binary would reject unsigned publishes |
| Legacy login retirement | Blocked on migration | Admin-created accounts hold a password hash and no `firebaseUid` |
| Platform restores | Unproven on the deployed tier | Only a synthetic 16-document drill is measured (5.1 s RTO) |

**What is next.** `docs/BACKLOG.md` is now the single register of unshipped work; it is grouped by
area and carries the identifier each item had in the retired documents. The immediate candidates are
still: merge PR #364 after confirming the six required indexes on production, then the restore proof,
owner-routed security alerts and an AI spend ceiling.

### Resource budgets

Known limits, checked before spending one of them:

- **EAS builds** — free plan: **15 Android + 15 iOS per monthly cycle** (30 total). Read with
  `eas account:usage jeffernqwes-team --non-interactive` on 2026-11-02: **Android 3/15, iOS 0/15,
  3 of 30 total, overage $0**; the cycle is **2026-11-01 → 2026-12-01 UTC**, with 30 days remaining.
  The October quota was exhausted; the reset was used for **one** build on 2026-11-01 (`64958ea2`,
  versionCode 7), which carried AI-41 and the Sprint 1 mobile fixes together on purpose. The attempt
  the quota refused still incremented `versionCode` 5 → 6 without producing an artifact; the
  successful build took it to 7. The 2026-11-02 preview build (`5500e6be`, versionCode 8) took the
  cycle to **3/15 Android, 3/30 total**. Do not retry a build while the quota message is present,
  and prefer
  an OTA when the change is JavaScript-only *and* `mobile/scripts/check-ota-publish.mjs` passes.
- **EAS Update allowance** — free plan: **100 GiB bandwidth** and **1 000 unique updaters** per
  monthly cycle. Read with the same command on 2026-11-01: **3,069 bytes (0.00 MiB) of 100 GiB
  used** and **0 of 1 000 updaters**, with **$0 overage**; the cycle is the same 2026-11-01 →
  2026-12-01 UTC window as the build quota. A publication itself is free — bandwidth is counted
  when a device downloads a bundle, and unique updaters counts distinct devices that download an
  update.
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

## 2026-11-22 — Overview stock filters: review, route tests and PR #364

**Purpose.** Review the committed-but-unmerged Overview stock-count fix across the dashboard, product
filters and mobile navigation, simplify it where it repeats itself, fix issues without weakening the
mutually exclusive classification, and prepare a focused PR. No merge, deployment or production data
change.

**Review changes.**

- Extracted `productListRoute()` so the four product cards share one ACTIVE-pinned route builder, and
  corrected the Total on-hand tile's hint (it opens Inventory, not a product list).
- The Products screen parses `stockStatus` through one label map. While a canonical status is active
  the list is pinned to ACTIVE and the All/Active/Archived chips are replaced by an "Active products"
  scope label; the legacy broad `lowStock`/`outOfStock` flags are ignored. Previously a member could
  switch a Low-stock view to Archived and see a count that was no longer the Overview card's count.
- The dashboard aggregation computes `available = quantity - reserved` once per product instead of
  repeating the expression in both stock conditions. OUT stays `<= 0`, LOW stays
  `0 < available <= minimum`; no classification was broadened or collapsed.
- Added `mobile/__tests__/overview-stock-filters.test.tsx`: all four product cards push the exact
  product route, the three statuses send the matching `stockStatus` with `status=ACTIVE`, Active sends
  none, and the pinned-ACTIVE/legacy-flag regression is covered.

**Verification.** Server and mobile typecheck pass. Focused DB suites (`SCALE-dashboard-counts`,
`phase04-inventory`, `phase11-intelligence`) are **33 pass / 0 fail / 1 mode-skip**. Focused mobile
Jest (`overview-stock-filters`, `profile-reachability`, `screen-focus-load`) is **20/20**. Server lint
on the touched files is clean; mobile lint reports only the three pre-existing
`set-state-in-effect` resolver errors (`products/index.tsx:89,99`, `inventory.tsx:61`). CI ran the
complete server suite: **3,335 tests / 538 suites — 3,334 pass, 1 fail, 0 skipped**. The only
failure is the inherited Q68 assertion (`ai-stress-assertions.test.mjs:61`, `false !== true`); that
test file and its fixtures are unchanged from `main`, so it is pre-existing and was not weakened.
The other six PR checks pass (mobile, compose-mongo, webauthn-e2e, secret-guard, attribution-guard,
dependency-review); the server check stays red only on Q68.

**PR.** [#364](https://github.com/nreffejzxc/inventory-ai/pull/364), `fix/overview-stock-filters` →
`main`, commits `ad0b874`, `5593854`, `9d6b819` plus this documentation. Open only; not merged or
deployed.

**Ranked follow-ups (planning only; none implemented).**

1. **Import progress/status for large files** — the earlier 3.5-minute apply still outlives the mobile
   timeout. A status endpoint keyed by the existing operation id would turn a timeout into progress
   or a safe resume; highest user impact from the recent device work.
2. **Rename or tighten the Inventory Low filter** — it is a row-level `available <= minimum` filter
   that includes zero-stock rows, so "Low stock" means a broader set than the product-level LOW card.
   Either exclude zero rows (canonical 0 < available <= minimum) or label it "At or below minimum".
   This is the largest remaining consistency trap in the same surface.
3. **Combined "Needs attention" product filter** — add one product-level low-or-out filter with a
   count, so triage does not require switching between two cards; the API currently exposes only the
   two disjoint statuses.
4. **Visible canonical stock filter on Products** — today the exact In/Low/Out status arrives only
   from an Overview deep link, and the only other control is Clear. Expose it as a chip or select so
   members can change the filter without going back to the Dashboard; this also makes the ACTIVE pin
   explicit instead of an invisible rule.
5. **Zero-row bridge on Inventory** — when the Out chip finds no rows but products are out of stock,
   show "N products have no stock row" with a link to Products → Out of stock. The demo tenant
   already demonstrates this mismatch and the current empty copy only partly explains it.
6. **Persist all product filters in the URL** — category, location, search and status currently
   initialize from params but are not written back, so back/refresh/share loses the working context.
7. **Per-chip counts** — return low/out facet counts with the inventory list so the chips show 11/0
   before a tap and an empty result is predictable.
8. **Share the stock classifier with the aggregation** — the product list and dashboard use the same
   rules but express them separately. A tested pipeline/expression helper (or a parity fixture) would
   stop future drift without changing the classification.
9. **Router test helper for query-string navigation** — Expo Router's test navigator kept its location
   after a push and did not unwind with back/replace in this suite. A documented helper would make
   future route tests less brittle; this suite avoids the issue by testing the route contract and the
   Products API payload separately.

## 2026-11-22 — Inventory and Overview action clarity

**Purpose.** Review whether Scan and Purchase Orders belong in the Dashboard Overview or beside the
Low/Out filters, evaluate the Low/Out actions themselves, and make only the changes that improve
everyday stock work. No server, deployment or production change.

**Decisions and changes.**

| Area | Change | Why |
| --- | --- | --- |
| Dashboard Overview | Kept the five count tiles as drill-downs; added a chevron and an accessibility hint, plus "Review products" / "Restock products" subtitles on Low and Out. | Scan and New PO already sit in Quick actions and Purchase orders has Procurement; adding them to Overview would duplicate actions and crowd the counts. The hint makes the existing drill-down discoverable. |
| Inventory actions | Removed the top Scan + Purchase Orders button row. Scan is now the barcode action inside the search field; Restock list and Purchase orders are shortcut rows with subtitles and chevrons. | Search-first layout, one obvious way to scan, and both STAFF-needed routes preserved — STAFF cannot open the Dashboard, so removing them entirely would strand them. |
| Inventory filters | Added an **All** choice, a live "N stock rows …" count with **Clear**, and made Low/Out mutually exclusive. | The row flags cannot both be true (low is 0 < available ≤ minimum; out is 0), so selecting both previously returned an empty list. The Restock list remains the combined product-level view. |
| Inventory out empty state | Explains that a product with no stock at any location has no inventory row, and points to Products → Out of stock. | The demo tenant has one out-of-stock product but no out-of-stock row; the old "Nothing is out of stock" message contradicted the Dashboard. |
| Products | Replaced the standalone "Scan a barcode" button with the same in-search action. | Consistency with Inventory and less vertical chrome. |
| Shared search field | Optional `onScanPress` action with a 44 px target and accessibility label. | One reusable control; no new screen or route. |

**Verification.** Mobile typecheck passes. Jest screen suites **11/11** (`profile-reachability`,
`screen-focus-load`). On the CPH1969 development build: Dashboard Low → **4 products low stock**;
Out → **1 product out of stock**; Inventory Low → **11 stock rows low on stock**; Out → **0 rows**
with the explanatory empty state; the search barcode action opens **Scan Barcode**. ESLint reports
only the three pre-existing `set-state-in-effect` resolver errors (`inventory.tsx:61`,
`products/index.tsx:89/99`); none was introduced here. Evidence:
[`evidence/ui-review-2026-11-22/`](evidence/ui-review-2026-11-22/README.md).

**Not completed / follow-ups.** No combined row-level "low or out" filter: the API exposes two
mutually exclusive row flags, so it would need a new `needsAttention` query parameter; the Restock
list is the combined view today. The filter summary is text, not per-chip counts. No server, merge,
deploy or production change was made.

## 2026-11-21 — server dependency patch and production verification

**Dependabot PR #362, merged as `fe646c1f3714ffc0a9b6087df0946a279d4a4df5`.** The server-minor-and-patch
group moved Mongoose **9.12.1 → 9.12.2** and typescript-eslint **8.72.2 → 8.73.0**. Mongoose 9.12.2
includes query sanitizer/projection hardening and connection-retry fixes; typescript-eslint is
development tooling only. No application source changed.

**Verification.** All seven required checks passed. `node scripts/verify-production-deploy.mjs
--sha=fe646c1…` returned `verified: true` after **7** attempts and **61.3 s**: health/readiness/liveness
**200**, database `connected`, exact commit. The installed Android app loaded the authenticated
dashboard through the updated backend with **113** active products and **26,975** on-hand quantity.
No mobile or native change was made, so the existing OTA remains current and no APK rebuild was needed.

---

## 2026-11-21 — repository audit and DEV-10 completion

**Complete locally; CI is the merge gate.** The repository had one genuinely unfinished delivery:
PR #355 (DEV-10) was open and `DIRTY`, with approved CI fixture proof, Dependabot security grouping
and a future roadmap. Its branch was based on the 2026-11-19 tree and conflicted with later records.
The changes were reconstructed on current `main` — code, workflow configuration, the new roadmap page
and the documentation references — rather than merging the stale branch or rewriting history.

**Branch audit.** Thirty remote branches were verified as merged by PR (or, for
`docs/plat8-assessment`, identical to the merged #322 content) and deleted. The open #355 branch is
superseded by the rebuilt branch; the closed scratch #319 remains because its diff is the deliberate
WebAuthn negative-control edit, not work to ship. Local refs with no upstream were checked against
`main`: their evidence directories, the centavo fix and the product-form tests are already present.
Several earlier evidence branches remain recoverable from Git history but had no unmerged code.

**Verification.** `node scripts/test-workflow-invariants.mjs` — **PASS, 5 fixture repositories**;
`node scripts/check-workflow-invariants.mjs` — **PASS**, 9 controls, 4 workflows, 15 action refs,
9 jobs, 2 Mongo image refs, Node 24; `node scripts/check-docs.mjs` passes with the new page linked;
`git diff --check` clean. The change touches no server or mobile runtime, so no Render deploy or OTA
is required. No production data, account or configuration was changed.

---

## 2026-11-21 — release delivered, deployed and production-tested

**Complete and observed in production.** This session closed the four remaining follow-ups and
delivered the working tree rather than adding another review round.

**The four follow-ups.**
1. **Stale-reporting regression.** Added a dashboard test that keeps earlier figures on screen after
a failed refresh, shows `Showing earlier data — pull to retry.`, keeps the What's New card reachable
below the warning, and clears the warning after retry. The release-notes suite passes **32/32**.
2. **Documentation and release note.** Added a new top `RELEASE_NOTES` entry describing the currency
correction, mixed-currency price scope and stock-cover behaviour, and recorded the release outcome
here and in [`PRODUCT_CURRENCY.md`](PRODUCT_CURRENCY.md) §5.
3. **Warning investigation.** The complete-suite log's only recurring notices were **107** transient
`MongoDB connection lost` fixture messages with zero server-selection failures. A focused phase07b
unit run produced no Mongoose deprecation warning, so no model or runtime change was made.
4. **Deployment verification.** The §27KP verifier, health aliases and ranked refresh were already
implemented; the deploy/health contract tests passed **26/26**.

**Delivery.** The working tree moved from `feat/product-currency-resolution` to `main` without
conflict. A direct push was rejected (`GH006`, PR-only, seven required checks), so commit `1f7e94c`
was pushed on `release/2026-11-21-currency-deploy` and merged as PR #359 at
`ae6ec297d8f39f425f17dc95d4b04590635c2f4c`. The first CI run failed `attribution-guard` because the
commit carried a generated-by footer; the footer was removed and the amended commit passed all
seven checks.

**Production proof.**
- `node scripts/verify-production-deploy.mjs --sha=ae6ec29…` returned `verified: true` after **5**
  attempts and **60.9 s**: health/readiness/liveness **200**, database `connected`, exact commit.
- OTA `eas update --channel production --environment production --platform android` published
  group `095457c2-e427-4805-b17d-0f945812e701` for runtime **1.0.2** at commit `1f7e94c`. The
  installed app on the CPH1969 device showed the new note, the three points, and the acknowledged
  state after `Done` (the card did not return).
- The demo-tenant product `DEMOSKU-112` opened with `Select a currency…`; choosing **PHP**, entering a
  reason and checking the reconfirmation saved successfully. The detail page then showed
  `PHP 4,700.00` and `PHP 6,290.00` with an updated timestamp.
- The assistant answered a production stock-cover question with **149** units at Main Warehouse, a
  **30-day** window, **no** stock-out rate, no days-of-cover estimate, and the explicit statement
  that stock-out is a movement proxy rather than confirmed sales.

**Resource and data note.** One OTA publication, one successful seven-check CI run, one Render deploy
and one intentional write in the demo test tenant. No migration, seed, deletion or real-tenant write
was made. A scratch screenshot and UI dump remain untracked and are not part of the release.

## 2026-11-21 — currency code review and complete-suite verification

**Scope.** Reviewed all uncommitted currency changes — product service/controller/routes, validation,
audit action, mobile form/API/labels, the AI price-comparison tool and the FX service — and
simplified or corrected only what was provably wrong or duplicated. No server safeguard, audit
field, currency scope rule or no-fallback FX rule changed, and no recommendation was implemented.

**Review findings and corrections.**
1. The mobile edit form sent `currencyCorrection: { reason, priceReconfirmed }` while the endpoint
   reads top-level fields, so a real correction from the app would have failed validation. The form
   and API wrapper now send top-level `reason` and `priceReconfirmed: true`, matching
   [`PRODUCT_CURRENCY.md`](PRODUCT_CURRENCY.md) and the server tests; the focused test asserts it.
2. A legacy row holding a non-canonical code such as `php` was normalised to `PHP` by the form, so
   the UI hid the correction the server requires for the raw value. The comparison now uses the
   exact stored code, and a new mobile test proves the reason/reconfirmation fields appear.
3. `findProducts` returned a currency-ambiguity note when a price-ranked search simply matched no
   products. It now returns a plain “No products matched this search” page, and AI45 covers the
   empty case. AI-18's page-return count guard was updated (17 → 18) for the third `findProducts`
   page path.
4. Create, ordinary edit and currency correction built the same 13-field product payload three
   times. They now share `productWritePayload(v)`; no field or validation changed.

**Verification.** Server `npm run typecheck` and mobile `npm run typecheck` pass; the focused mobile
form suite passes **6/6**. The first complete run reported **3,334 tests / 538 suites, 3,333 passed,
1 failed, 0 skipped**, exit **1**, **1,921,771.2591 ms**; the sole failure was the stale AI-18 count
guard, not a product regression. After updating it, AI-18 unit passed **3 pass / 1 DB-suite skip**,
and the complete suite was rerun on the final tree: **3,334/3,334 passed across 538 suites, 0 failed,
0 skipped, 0 cancelled**, exit **0**, **1,877,787.3521 ms**. The log recorded **107** transient fixture
`MongoDB connection lost` notices and **0** `MongooseServerSelectionError` entries; all currency and
FX suites passed. `check-docs` reports **71 active / 48 living**, the five documentation suites pass
**31/31**, and `git diff --check` is clean.

**Recommendations and limits.** Six new and six existing candidates are ranked in
[`PRODUCT_CURRENCY.md`](PRODUCT_CURRENCY.md) §6 (2026-11-21): immutable currency/price snapshots,
dependency-aware correction, FX age bands, correction evidence, rounding policy and opt-in converted
comparison are new. Only the focused mobile form suite was run, not all mobile Jest; no live FX or
provider call was made. No production data, migration, model configuration, commit, push, merge or
deployment was touched.

## 2026-11-21 — stock-coverage suite proof and ranked remaining candidates

**Scope.** Ran the complete server unit and DB suites on the current stock-coverage tree (§27KQ),
without editing source while they ran, then reviewed `getProductStockCoverage`, its tests and the
earlier live audit. No genuine regression was found, and no runtime source or model, fallback or
reasoning configuration was changed.

**Unit suite.** `cd server && npm run test:unit` → **2,321 tests across 472 suites: 2,244 passed,
77 deliberately skipped, 0 failed**, exit **0**, **59,565.0832 ms**. The 77 skips are the DB-backed
suites inside mixed files, skipped visibly by `TEST_MODE=unit`.

**DB suite.** `npm run test:db` → **1,231 tests across 271 suites: 1,110 passed, 120 skipped,
1 failed**, exit **1**, **817,686.5622 ms**. The failure was
`phase07b-auth-security.test.mjs` → “skipSuccessfulRequests survives a window reset on the per-IP
bucket”: the final relock returned 401 instead of 429 because the 5-second per-IP window expired
between the two post-reset failures on the loaded machine. Rerun alone with `TEST_MODE=db` it
passed **27/27**, exit **0**, **66,690.5835 ms**. No coverage suite failed: AI-118 and the semantic
metrics suite passed in both applicable modes, and the Phase 06 turn regressions passed in DB mode.
The DB log also carries the expected fixture `MongoDB connection lost` notices; they produced no
failed assertion. Unit and DB modes both include the mixed files, so their sums are not comparable
to a one-pass full-suite total.

**Coverage review and ranked candidates.** `getProductStockCoverage` remains a one-product,
one-window estimate over `STOCK_OUT`, using current available quantity and returning a null
estimate with no movement; it is a movement proxy, not confirmed sales. The ten remaining
candidates and their order are recorded in
[`BACKLOG.md`](BACKLOG.md) §5 (2026-11-21
refresh): an evidence/confidence gate, days-to-minimum, catalogue-wide run-out ranking,
stockout-censored demand correction, outlier-resistant estimation, intermittent-demand handling,
transfer-aware location coverage, a coverage outcome ledger, supplier/PO-aware restock and
controlled stock-out reason codes. Ranks 1, 2, 4, 5, 6, 7 and 8 are new; 3, 9 and 10 were already
recorded. Nothing was implemented.

**Documentation and checks.** Added the ranked section to the follow-up assessment, added the
pointer in [`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) §6 and
recorded this session here. `node scripts/check-docs.mjs` reported **71 active / 48 living** and
the five documentation suites passed **31/31**. `git diff --check` is clean.

**Limits and remaining work.** The six-question live coverage evaluation was not rerun, so the
current live selection/use rate is still unproven; a repeat ledger remains necessary. The phase07b
per-IP window test is still timing-sensitive under a fully loaded DB suite and should be stabilised
separately if it recurs. No production data, migration, model configuration, commit, push, merge or
deployment was touched.

## 2026-11-20 — currency correction, mixed-currency comparisons and bounded FX retry

**Currency hardening, server/mobile/tests/docs.** Completed the three requested follow-ups without
changing the unrelated AI-118, release or reliability work.

**Currency edit guard.** `product.service.update()` now separates the stored exact code from the
requested code. An ordinary PATCH can omit `currency` while a valid code exists or repeat that exact
code; a different code is refused with `CURRENCY_CORRECTION_REQUIRED`. Clearing and a legacy row
with no valid code are refused as before. The new correction controller validates a partial product
payload plus a 3–500-character reason and literal `priceReconfirmed: true`, then calls the same
service with a `ProductCurrencyCorrection`. The service independently re-checks reason/reconfirmation
(for direct callers), refuses a same-code correction with `CURRENCY_CORRECTION_NOT_APPLICABLE`, and
records `PRODUCT_CURRENCY_CORRECTED` with `previousCurrency`, `currency`, `reason`, `priceReconfirmed`
and changed fields. The route is `POST /api/products/:id/currency-correction`, requires
`products.manage` and is tenant-scoped.

**Mobile correction flow.** `ProductForm` compares the selected code with the initial product. An
ordinary edit still calls `productsApi.update`; a changed code reveals a reason field and a
reconfirmation chip, refuses to submit without both, then calls `productsApi.correctCurrency` with
the edited fields and correction metadata. The legacy product with no code follows the same
correction path. `ProductInput.currencyCorrection` and the API wrapper were added; the existing form
test mock and expectation were updated.

**Mixed-currency ranking and filtering.** `productService.priceCurrencies()` groups the whole
matching set by exact stored code, including `null`. `findProducts` uses the named ISO code when the
member supplied one; otherwise it uses the single unambiguous code or blocks the comparison,
returning `priceRankBlocked` / `priceFilterBlocked`, the groups and no items. `productService.list()`
also refuses a price ceiling or ranking without exactly one recorded currency, so direct service
callers cannot bypass it. Unrecorded prices stay `null`, are excluded from rankings and never match
a ceiling. An explicit code scopes both the ceiling and the ranking and returns
`priceFilterCurrency`/`priceFilterNote`.

**FX retry.** `exchangeRates.ts` adds a per-pair in-flight map, a 256-entry negative cache starting
at 30 seconds and doubling to a 5-minute cap, and counters `negativeCacheHits` and
`coalescedRequests`. A successful quote deletes the negative entry; a failure returns `null` and
never a guessed number. The existing six-hour positive cache, seven-day rate-age check, structured
warning and `/api/health.exchangeRates` publication are intact; `/ready` and `/live` do not depend on
FX state.

**Tests and verification.** Currency unit mode passed **17/18 with the DB suite skipped** (0 failed);
DB mode passed **8/11 with the unit suite skipped** (0 failed). AI-45 DB passed **14/15 with the unit
suite skipped**; the mixed-currency case proves a PHP/USD/unrecorded set blocks both a ceiling and a
ranking, while an explicit PHP or USD code returns only that currency. Phase 23 and documentation
guards passed **41/41**, including the route inventory's **127 = 70 + 24 + 33 + 0** split and the
record-count/index checks. INTEGRITY-RECOVERY passed **17/17**; phase04 catalog plus phase20
filter/pagination passed **47/47**. Audit-label parity passed **8/8** after
`mobile/lib/auditLabels.json` gained "Currency corrected"; the mobile audit-label suite passed
**4/4**. Server `tsc --noEmit` and focused ESLint pass. Mobile typecheck, the focused product-form
Jest suite **5/5** and focused ESLint pass. `check-docs` reports **71 active / 48 living**, and
`git diff --check` is clean. Documentation was updated in
`PRODUCT_CURRENCY.md`, `INTEGRITY_RECOVERY.md`, `SYSTEM_SPECIFICATION.md`, the Firebase auth design
§2.6 and `CLAUDE.md`.

**Limitations.** No full server suite was run in this session. Mixed-currency blocking deliberately
ignores `inStockOnly`, so an out-of-stock other-currency row can still block; an explicit code scopes
around it. The ordinary product list has no price sort, so a future list-level price control must
reuse the same single-currency guard. FX failure state remains process-local, with no durable alert
or second provider. No production data, migration, live FX outage, commit, push, merge or deployment
was touched.

## 2026-11-20 — run-out regressions and live coverage audit

**AI-118 follow-up, tests/docs/live evaluation.** Added **Q7b** (no tool call on the first draft) and
**Q7c** (a second failed coverage attempt) to `phase06-ai-behavior.test.mjs`. Q7b asserts the one
corrective re-ask, the coverage call and the 6-unit/4-unit/15-day stored answer with only
`getProductStockCoverage` used. Q7c asserts the correction is issued once, the turn stops after the
second draft, and the stored text is exactly the existing ungrounded sentence with no quantity or
forecast. Q7 and Q8 were not edited. The focused suite passed **16/16**.

**Live run.** `AI_TEST_ALLOW_PAID_MODELS=true npm run eval:stock-coverage` ran the six fixed
paraphrases against the current OpenRouter configuration (`openai/gpt-oss-20b`, two fallbacks) and a
disposable development tenant seeded with 14 products, 22 stock rows and 30 movements. The tenant
was removed in `finally`; no model, fallback, reasoning or web setting was changed and no production
data was read. The script exited **1 by design** because coverage was not selected in every turn;
there were **0 errors** and no infinite-cover claims.

| Question | First tool | All tools | Coverage | Corrected | Outcome |
| --- | --- | --- | --- | --- | --- |
| `how-long` | `searchProducts` | `searchProducts` | not selected | yes | ungrounded after one correction |
| `days-of-cover` | `findProducts` | `findProducts`, `getProductStockCoverage` | later | no | 45 days |
| `run-out-soon` | `findProducts` | `findProducts`, `getInventory`, `getProductStockCoverage` | later | no | about 100 days |
| `stock-coverage` | `searchProducts` | `searchProducts`, `getProductStockCoverage`, `getInventory` | later | no | quantity only; estimate and caveat omitted |
| `until-runs-out` | `searchProducts` | `searchProducts`, `getProductStockCoverage` | later | no | about 120 days |
| `longer-at-rate` | `findProducts` | `findProducts`, `getProductStockCoverage` | later | no | about 120 days; explicit stock-out caveat |

Summary: **0/6 first-read coverage, 5/6 coverage anywhere, 1 correction, 0 errors, 0 exact
proxy-caveat phrases, 0 infinite claims**. Manual reading found **1/5 grounded answers** explicitly
saying stock-out includes sales, usage, damage or write-offs; three named the stock-out/outflow
basis without that boundary, and `stock-coverage` omitted the estimate entirely. The run used 3–5
calls per turn, 5.6–45.8 seconds, and recorded about **$0.007846** of turn cost. It is one sample,
not a selection-rate guarantee.

**Findings.** First-choice selection is structurally unlikely for name questions because the tool
accepts only id/SKU/barcode; the model must search first. A successful coverage read does not
guarantee the answer uses it (`stock-coverage`). The one correction can fail (`how-long`) and then
correctly degrades. The proxy caveat is not reliably repeated by the model. These are ranked as
recommendations in §27KO and in
[`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) §6; none is
implemented in this pass.

**Verification and limitations.** Phase 06 **16/16**; AI-118 unit **5 pass / 1 skipped** and DB
**8 pass / 1 skipped**, both 0 failed; `npm run typecheck`; focused ESLint; documentation tests
**31/31**; `check-docs` **71 active / 48 living**; `git diff --check`. The complete server suite was
not rerun. The six-question run is evidence from one configured model and one development seed; it
does not prove production selection, reliability under other phrasings or answer quality in every
language. No production data, migration, commit, push, merge or deployment was performed.

## 2026-11-20 — run-out correction and bounded live selection evaluation

**AI-118 follow-up, server/tests/scripts/docs.** Completed the three requested follow-ups without
touching the unrelated currency or reliability work.

**Selection enforcement.** Added `asksForStockCoverage()` to `answerCompletion.ts`: it recognises the
run-out/stock-cover/“how long” family but deliberately not ordinary stock counts, low-stock lists or
delivery-duration questions. In `ai.service.ts`, a run-out answer that did not successfully use
`getProductStockCoverage` is discarded; one corrective re-ask names the exact-one-identifier rule,
the optional location and the bounded window. A second miss ships the existing
`UNGROUNDED_ANSWER` sentence, so a plausible forecast from a stock quantity cannot pass. The tool's
movement-proxy caveat and null `daysOfCover` behaviour are unchanged.

**Q7 proof.** The DB-backed turn now starts with the common wrong choice (`getProduct`), tries to
answer from its quantity, then receives the corrective re-ask and calls coverage. The test asserts
`toolsUsed = getProduct,getProductStockCoverage`, the 6-unit/4-unit/15-day figures, the proxy caveat
and Inventory records provenance. Q8 still proves no stock-out history returns null cover.

**Review.** The coverage executor keeps the whole-set `productAvailability` aggregate, one
exact-identifier resolution, the business-scoped location check and the ledger totals; each is
needed for accuracy or isolation. The paraphrase predicate is now shared by the turn loop and the
evaluator. No distinct schema, isolation, whole-set, null-rate, archive or identifier regression was
removed.

**Live evaluation.** `server/scripts/eval-stock-coverage.mjs` and the `eval:stock-coverage` script run
at most six paraphrases against the CURRENT configured model on a disposable development tenant.
They record first/all tools, whether the correction fired, model, route, calls and a bounded answer
excerpt to `.tmp-stock-coverage-live.json`. The harness refuses a non-development database and a
run without `AI_TEST_ALLOW_PAID_MODELS=true`; it does not change model, fallback, reasoning or web
configuration and is not registered in the test runner or CI. `--validate-only` proves all six
questions classify and makes no provider or database call.

**Verification.** `npm run typecheck` and focused ESLint passed. `AI118-stock-coverage.test.mjs`
unit mode passed **5/6 with the DB suite skipped**; DB mode passed **8/9 with the unit suite
skipped**. Phase 06 behavior passed **14/14**, including Q7 and Q8. `eval:stock-coverage
--validate-only` passed for **6/6** paraphrases with no provider call. Documentation guards passed
**31/31**. The complete server suite passed **3,311/3,311 tests across 538 suites**, with **0 failures, 0 skips and 0 cancelled** (exit 0, `--test-concurrency=2`, 1,840,452.9 ms).

**Limitations.** No live-model run was executed at that point, so the harness proved its bounded
setup and the scripted correction path, not the configured model's real selection rate. A live run
spends quota and needs separate approval. The disposable tenant is removed in `finally`; a hard kill
can leave it for inspection. No production data, migration, commit, push, merge or deployment was
performed. The approved live run and the new Q7b/Q7c regressions are recorded in §27KO.


## Earlier sessions

This log keeps the current position and the ten newest sessions. Older, session-by-session detail is
not lost: every increment has a numbered record with its measurements in
[`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md), indexed by identifier at the end of
[`../CLAUDE.md`](../CLAUDE.md).

