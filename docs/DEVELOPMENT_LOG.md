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

**Updated:** 2026-11-13
**Goal:** finish and harden Inventory AI **V1** through production testing. No Play Store or App
Store release is being prepared.

**Current production server (2026-11-13):** `705d192` — the movement-detail and stock-status fix.
The AI-105 output-limit drill remains the last AI-specific deployment before it. `/api/health`
reports `status: ok`, `db: connected`, `environment: production`; `/api/health/ready` returns 200.
The current production OTA is `39f78213-cc77-45f6-8b1b-0b9232b44a62`, published from `8b99f46`;
local `main` is `e6629ab`, the docs-only release record.

**Hosted scheduler status (2026-11-11T19:56Z):** **UptimeRobot is live and alert delivery is
verified** with two five-minute monitors (readiness HTTP 200 and `/api/health` keyword
`"db":"connected"`; both Up). The account inbox received both built-in test messages and a real
synthetic-monitor DOWN at 03:49 and UP at 03:51 after switching the temporary monitor from `/500`
to `/200`; the monitor was deleted. Only the account email is configured. The Windows task is
**disabled** after its last successful run at 19:31:36Z. GitHub never emitted a scheduled run for
any attempted path; the dispatcher was removed, the private watch repository was archived, the
TypeScript watch is weekly-only, and v2 is manual-only. The 10K gate rerun remains **24/25 written,
25/25 semantically correct**, 0 errors, 0 degraded and $0; the later `705d192` deployment did not
re-run that gate, so the approved post-deploy rerun is still pending.

**Docs maintenance:** On 2026-11-06 the active guide set was consolidated, the device reference and
the specification's obsolete planning tail were trimmed, and a documentation-link guard was added;
see the documentation entries below. The auth checklist and account runbook now state current
decisions; Guides 9, 11, 12 and 13 keep their commands and safety rules, with the phrase matrix owned
by Guide 10 and dated measurements removed; the auth architecture and checklist keep one invariant
register and one status owner, with overlapping client-authority and email clauses narrowed to one row
each. On 2026-11-07 the account runbook's provider snapshot was re-measured: GitHub and Render remain on the current account, Render auto-deploy is limited to `server/`, and EAS is already on the target Gmail's Expo account. The AI-48–AI-84 work is recorded in §27HQ, §27HR and §27HS. On the same day the documentation map gained a maintenance loop: a root `check-docs` guard, a close-out `check-repo-state` script, [`CONTRIBUTING.md`](../CONTRIBUTING.md) and a pull-request template, delivered through PR #165. The living reference set now carries a review cadence enforced by the same guard, and the per-IP login limiter has a window-reset regression test, both delivered in PR #168. The server suite again carries the invariant-register guard after #166 was reopened, rebased and merged; the root guard remains the docs-only gate. `PHASE_HISTORY.md` now records AI-84 as delivered, the deployed AI-87/AI-88 work, and AI-91/AI-92 as then pending, and the dependency record was re-measured at 15 server / 35 mobile entries before the minimatch merge; it now records 5 / 27. The runbook's production anchor was corrected from `98a4282` to `e18264e` after the dependency-only PR #162 merged. On 2026-11-07 the minimatch investigation ended in the reviewed D-13 override: #173 (mobile) and #174 (server) merged, the minimatch alerts closed, production moved to `8fe6403`, and the security record now carries D-13 plus post-merge evidence. PR #177 adds a weekly TypeScript 7 readiness watch so the deferred upgrade no longer depends on a manual check. On the same day the Firebase Admin API confirmed the production authorized domain and closed L-17 as not applicable to the Brevo six-digit reset flow. A repository-wide documentation audit on 2026-11-09 reconciled the living references with the current tree: `PHASE_HISTORY.md` now records AI-84 as delivered, the deployed AI-87/AI-88 work, and AI-91/AI-92 as then pending; the specification lists all 19 read-only tools; the security policy names the current glob/deepmerge alerts rather than the cleared zod set; and the account runbook's production anchor has since advanced to `8b6353a`.

| | |
| --- | --- |
| **UptimeRobot hosted health watch (2026-11-11)** | **Complete.** UptimeRobot now provides two five-minute production checks: readiness at `/api/health/ready` (HTTP 200) and a keyword check at `/api/health` that alerts when `"db":"connected"` is absent. Both monitors were **Up** at cutover, and UptimeRobot accepted an email test alert. Monitor IDs `804639237` and `804639270`. The Windows task `InventoryAI Production Health Watch` was **disabled** at 19:32:14Z; its last run at 19:31:36Z succeeded with task result 0, and it remains on disk as a manual fallback. GitHub scheduled workflows still produced zero runs, so the code paths remain fallbacks rather than the active watch. Evidence: [`hosted-scheduler`](evidence/production-health-scheduler-hosted-2026-11-12/README.md). |
| **UptimeRobot alert verification + schedule cleanup (2026-11-11)** | **Complete.** The account inbox received the built-in test pair and a real synthetic-monitor pair: `httpbin.org/status/500` went **Down** at 03:49 local, then **Up** at 03:51 after the same monitor was switched to `/200`; the incident lasted 2m09s. The temporary monitor was deleted, leaving only the two production monitors. The failed GitHub scheduling experiments were retired: the dispatcher was removed, the private watch repository was archived, the TypeScript watch is weekly-only, and v2 is manual-dispatch-only. Evidence: [`hosted-scheduler`](evidence/production-health-scheduler-hosted-2026-11-12/README.md). |
| **10K gate rerun + hosted scheduler attempts (2026-11-11)** | **Gate complete; scheduler blocked.** The deployed 10K gate on `c3bd692` completed all 25 questions: **24/25 written, 25/25 semantically correct**, 25 free, 0 paid, 0 errors, 0 degraded, **$0.000000**; median 7,102 ms, p95 17,724 ms. The only written miss is the known absent-SKU checker false negative. The tenant was restored and re-read at 10,000 products / 20,006 rows / 1,535 low. For the hosted scheduler, v2's cron was corrected to `*/5` (`83a9f26`), a hosted dispatcher was added (`66b0929`), and a separate private watch repository was created; a five-minute dispatch guard was added to the working TypeScript watch (`8a89a53`), but all four paths produced no **`event=schedule`** run through 19:21Z. The Windows task remains enabled; no cutover is claimed. Evidence: [`deployed-gate`](evidence/deployed-gate-2026-11-12/README.md), [`hosted-scheduler-attempt`](evidence/production-health-scheduler-hosted-2026-11-12/README.md). |
| **AI-105 live trim + external scheduler (2026-11-11)** | **Complete.** The production drill on `c3bd692` used the owner-only `x-ai-output-limit-drill: retry` header against a 12-message conversation. Turn `2d856074` returned 201, logged `empty=1 retries=1`, and Render recorded **`AI output limit retry: trimmed 8 prior message(s), kept the current turn`**. The AI-106 low-stock share answer was live-verified at `47ad058` as **19 / 1,633,025 / 0.47%** (`Ref: cb84331e`). PR #236 merged `47ad058`; PR #237 merged `c3bd692`. A Windows Task Scheduler job (`InventoryAI Production Health Watch`) dispatches `production-health-watch-v2.yml` every five minutes; its first automatic run `43069829375` (`workflow_dispatch`) succeeded with task result 0. Evidence: [`ai105-output-limit`](evidence/ai105-output-limit-2026-11-11/README.md), [`ai106-low-stock-share`](evidence/ai106-low-stock-share-2026-11-11/README.md), [`production-health-scheduler`](evidence/production-health-scheduler-2026-11-11/README.md). |
| **AI-106 finalizer audit + reset-UX OTA (2026-11-11)** | **Task 2:** local finalizer fixes preserve compound count-plus-value answers, no longer read a bare “total” as a value request, and recognize hyphenated and preamble count questions; focused tests pass **91/91** and the full unit suite passes **408 suites / 1,984 tests / 0 fail / 62 skipped**. **Task 1:** production OTA group `58f75323-eeab-4aee-b48d-5f3c38e2396a` (update `01a1ca6c-b450-7def-ab6f-b013782918fe`, runtime 1.0.2) loaded on the OPPO; count turns `ffc1524a` and `6769b530` answered **19**, while `d8aadd1a` exposed the old bare-total value bug. **Deployed and live-verified:** PR #229 squash-merged as `26eb0d4`; Render served that commit with `status: ok` / `db: connected`. The exact count question answered **19** (`Ref: 4cef1383`) and the compound question answered **19 low-stock items / 1,633,025** (`Ref: 771dc31f`); both refs match Render `turn=` log records. The “Correcting the answer…” label remains unobserved live; a same-thread compound attempt hit the pre-existing output limit (`turn=c6d62a6a`) before a clean fresh-chat pass. |
| **Close-out: schedule, standalone APK, AI-105 staging (2026-11-11)** | **Scheduled watch not verified:** the v2 workflow (ID `414656117`) is active after #228 `1c7a1d8`; manual dispatch `43022962990` succeeded, but `event=schedule` stayed at **0** through 13:51Z despite a public repository, `main` as the default branch, Actions enabled, an active workflow, an owner-authored commit, a disable/enable cycle and a new workflow file. **Android:** the Reanimated long-path failure was cleared by building from a real short `C:\iab` copy and applying `CMAKE_OBJECT_PATH_MAX=250`; `BUILD SUCCESSFUL` in 4m41s. `mobile/build/standalone/app-release.apk` is `com.inventoryai` v1.0 (code 1), 38 MB, SHA-256 `c315d4e6…de3e`, debug-signed, and installed beside `com.inventoryai.app` v1.0.2 (code 10). It launches to the login screen; Google sign-in returned “Unable to sign in with Google. Please try again.”, so the Ref line and What's New card are **not verified**. **AI-105 staging:** the local-stub harness retried at 2,400 tokens with a 1,200-token reasoning budget and returned a readable answer; production AI was untouched. See `docs/evidence/closeout-2026-11-11/README.md`. |
| **Four-task close-out (2026-11-11)** | **Complete.** **Task 3:** the 2026-11-11 Dependabot read found 8 open alerts; lockfile-only fixes took `node-forge` to **1.4.3** (#20–#23) and `fast-xml-parser` to **5.12.0** (#24), with no `package.json` change. Audits are now 5 server / 27 mobile entries and only `glob` + `deepmerge`; Dependabot closed **#20–#24** after the lockfiles reached `main`, leaving #13/#14/#16 deferred. **Task 1:** `scripts/check-production-health.mjs` and the five-minute `production-health-watch.yml` are live; the deliberate bad-URL run opened issue **#223** and the production run commented on and closed it. **Task 2:** AI-105 reserves answer space on the one empty output-limit retry and AI-84 adds the direct Bisaya/Tagalog instruction; the Tagalog live retest now answers the low-stock count in Tagalog and the Bisaya retest answers in Bisaya, both **19** and matching the Restock screen. **Task 4:** the production OTA bundle shows **`Ref: 566f6d71`** on a fresh answer and its What's New card was dismissed with **Got it**; screenshots are linked below. |
| **Working now** | Current production is **`705d192`** (movement-detail and stock-status fix; the AI-105 output-limit drill remains the last AI-specific deployment before it; `/api/health` reports `status: ok`, `db: connected` and `/ready` 200); the current production OTA is **`39f78213-cc77-45f6-8b1b-0b9232b44a62`** (runtime 1.0.2, loaded on the OPPO; Profile shows the AI limits card — [evidence](evidence/ai-limits-profile-2026-11-13/README.md); the earlier “Correcting the answer…” label is recorded in [evidence](evidence/ai105-production-2026-11-11/README.md)). The spent-allowance sentence is now device-verified in an isolated dev-client run ([evidence](evidence/ai-quota-device-2026-11-13/README.md)). The deployed 10K gate rerun is **24/25 written, 25/25 semantically correct** (the only miss is the known absent-SKU checker false negative), all free, 0 errors and 0 degraded for **$0.000000**, and the synthetic tenant was restored and re-read. The long-thread production test did not trigger the compact-history trim organically; the owner-only drill later did (turn `2d856074`, eight messages). UptimeRobot now provides the automatic five-minute checks; email DOWN/UP delivery is verified, and the dead GitHub scheduling paths were removed/archived. On 2026-11-11, AI-103 fixed whole-set receipt and transfer totals in history answers and OPS-3 added the operator monitoring runbook; both were deployed as `e15136a` with the mongoose 9.12.0 bump, and the dependency queue has no open Dependabot PR. AI-101 assistant monitoring now writes one complete record per turn with a shared `turn=` id (model/tier, the free/paid/legacy reasoning switches and sources, web switches, intent, duration in ms and seconds, status, upstream provider, tools, tokens/credits, retries/failovers/re-asks), and the 25-question simple-inventory gate passed 25/25 for $0.003269; the same gate against the deployed Render URL scored 24/25 as written (25/25 semantically) for $0.002957; AI-101 monitoring, the AI-101 answer reference, AI-102 durable metrics and AI-99 routing were live as `eda08d0`; the AI-100 free-reasoning switch remains live in the same deployment, with OFF, ON and restored OFF verified. The aggregate question now uses the paid default route and reports the full 2,446,801 units. AI-99 is merged as `8b6353a`; Render later served `e15136a`, `47ad058` and `c3bd692`. OTA group `e38e07bf` remains the "AI answers now include a support reference" release; the newest production group is `39f78213-cc77-45f6-8b1b-0b9232b44a62` (runtime 1.0.2), and `0e4eca55` remains the "Clearer stock totals and restock counts" release. After the 2026-11-10 quota reset, three live simple turns were served by `nvidia/nemotron-3.5-lightning:free` (reasoning OFF, ON and restored OFF) for the correct 401-unit answer; the earlier pre-reset attempt had fallen forward to `openai/gpt-oss-20b`; the on-device What's New card was observed on 2026-11-10; the 20-question 10k phone matrix scored 15 PASS / 3 PARTIAL / 2 FAIL, with research grounding and language still open; the AI-99 aggregate-question false positive found during that audit is fixed in `87041c3`; three live free-served turns succeeded on 2026-11-10. AI-87 remains deployed: ordinary turns use `openai/gpt-oss-20b`; research turns try `openai/gpt-oss-120b` first, with the 20B primary as fallback and no promotion of the research model. PR #185 merged as `47353af` and Render deployed it. Two live turns verified 20B/120B routing, native search, exact costs and `failovers=0`. PR #187 then added and executed a controlled research failover drill (AI-88): one OWNER request forced a simulated 120B `503` and the real 20B fallback answered (`failovers=1`, `$0.016796`). Firebase sign-in is **restored**: the credential was rotated on 2026-11-07 and the old key deleted. PR #179 carries the runbook, the checker and this record. Minimatch alerts #18/#19 are closed; L-17 is closed as not applicable to AUTH-06. Phone verification of the deployed AI behavior passed on 2026-11-08: the app's ordinary turn used `openai/gpt-oss-20b` (`failovers=0`, 6,583 ms) and its research turn used `openai/gpt-oss-120b` with native search (`failovers=0`, 11,681 ms). After PR #190 merged as `04eb92c`, a fresh streamed phone turn (low-stock question) logged `cost=$0.000567` on `openai/gpt-oss-20b` with `getLowStockProducts` and `failovers=0`; streamed turns now preserve the provider-reported cost and native source URLs. A phone-rendered FALLBACK answer is still unobserved. On 2026-11-09, PR #193 merged as `6d95168`; PR #196 (`67e8dbc`), #197 (`787c2b3`), #198 (`72e225c`) and #199 (`162db9c`) closed the production assistant defects found in the same conversation. Production now serves `5b05307`; the production APK is 1.0.2 (versionCode 10), and OTA group `0e4eca55` is the newest group on the production channel. |
| **Just verified** | Post-merge, production serves **`3b275df`** with `status: ok` and `db: connected`; the deployed 10K gate passed **24/25 written, 25/25 semantically correct** (0 errors, 0 degraded, $0) with no output-limit log and a verified restore (10,000 / 20,006 / 1,535 low); the long-thread production test repeated the compound answer correctly but did not exercise `trimmed`; manual workflow dispatch `43060542900` succeeded while `event=schedule` stayed at 0; the exact same-thread AI-105 count/compound test returned **19** and **19 / 1,633,025** with Render-matched refs `bf777146` and `e4570da9`, the output-limit retry recovered, and the **“Correcting the answer…”** label was captured at `008a1583` ([evidence](evidence/ai105-production-2026-11-11/README.md)); earlier, the AI-106 count/compound turns returned **19** and **19 / 1,633,025** with refs `4cef1383` and `771dc31f`; the external watch opened and closed issue #223, Dependabot #20–#24 closed, and the live Tagalog/Bisaya count turns both answered **19** and matched the Restock screen. On 2026-11-11, `/api/health` served the merge commits and the runtime commit `e15136a` reported `status: ok`, `db: connected`, environment `production` and 0 server errors; `/api/health/ready` returned 200 and `/api/ai/metrics` returned 401 unauthenticated. PRs #217, #194 and #218 passed all four required checks; the unit suite passed 2,027 tests (1,965 pass, 62 skipped, 0 fail); the live simple-inventory smoke was 1/1 accurate and free-served for $0.000000. PR #214 passed all four required checks and squash-merged as `eda08d0`; Render reported `eda08d0` then, status `ok`, database `connected` and 0 server errors. The production metrics endpoint returned `401` unauthenticated and `200` for a real OWNER session with `Cache-Control: no-store`; the window was empty because no turn had completed after the deploy. OTA group `39f78213-cc77-45f6-8b1b-0b9232b44a62` is the newest production group; `58f75323` is the prior reset-label group and `e38e07bf` is the support-reference group. AI-99 aggregate routing is live as `87041c3`; the AI-100 free switch logged `field=disabled` with OFF, `field=omitted` with ON, and `field=disabled` again after restore; paid reasoning logged `field=omitted source=AI_REASONING_PAID_MODELS` on `openai/gpt-oss-20b`. At 08:41 UTC, `How many total units do we have?` logged `route=default`, used `getInventorySummary`, and answered 2,446,801 units on `openai/gpt-oss-20b` for `$0.001073`. On 2026-11-10 the same gate ran against the deployed Render URL at `6924c50`: 24/25 as scored (the one failure was a checker false negative — the answer correctly denied an absent SKU), 21 free / 4 paid, median 3,933 ms, p95 6,501 ms, $0.002957; see [the deployed-gate evidence](evidence/deployed-gate-2026-11-10/README.md). On 2026-11-10, two fresh 10,256-product gates recorded 24/25 each; the first exposed and fixed a false-negative absent-SKU check, and the corrected rerun passed that question but hit one real `AiOutputLimit`. With 0/1000 free requests left, all 24 answers were paid; median 4.5 s, p95 8.1 s. See [the 10k evidence](evidence/simple-10k-2026-11-09/README.md). The installed 1.0.2 app showed the "Clearer stock totals and restock counts" card, and [the 20-question phone matrix](evidence/paid20-2026-11-09/README.md) recorded 15 PASS / 3 PARTIAL / 2 FAIL in one 10k-tenant conversation. The merge auto-deployed as `5b05307`; `/api/health` reports `status: ok`, `db: connected` and 0 server errors. On 2026-11-10, PR #201 passed all four required checks in run `42674969198` and squash-merged as `8b6353a`; Render deploy `dep-dbp16ap42hec738c5b2g` reached `live`, and `/api/health` reports `8b6353a`, `status: ok`, `db: connected`, environment `production` and **0** server errors. Production OTA group `0e4eca55-0e4f-47fc-b2d6-507f91b529b8` (Android update `01a1c19d-06e8-79c9-9a46-7302c4be1c69`) was published from `8b6353a` and is the newest production group; `update:list` confirms it. On 2026-11-09, PRs #193 and #196–#199 passed all four required checks and merged. A 10,000-product production tenant was seeded and checked against DB totals; one continuous conversation verified 20B ordinary routing, 120B research with returned sources, SKU-bearing value answers, the no-sales-ranking limitation, and a clean 1,535-item restock answer. The final PR #199 check run was `42595929652`; Render serves `162db9c`. OTA group `58ab8e76` was published from that commit and applied on the installed APK. On 2026-11-08, PR #190 merged as `04eb92c`; all four required checks passed on run `42480189959`; Render deploy `dep-dbo6m2ks728c739rl40g` reached `live`; a post-deploy streamed phone turn logged `cost=$0.000567` on `openai/gpt-oss-20b`; the two `cost=unknown` phone turns described next predate this fix. On 2026-11-08, PR #187 merged as `c98d688`; all four required checks passed on run `42451318595`; Render serves `c98d688` with `status: ok`, `db: connected` and **0** server errors. One OWNER drill forced a simulated 120B `503` and the 20B fallback answered (`201`, 28,214 ms, `failovers=1`, `$0.016796`). Two phone turns then ran: ordinary `20B` (`failovers=0`, 6,583 ms, `cost=unknown`) and research `120B` with native search (`failovers=0`, 11,681 ms, `cost=unknown`). PR #185 merged as `47353af`; all four required checks passed on run `42448637562`; Render deploy `dep-dbo028ks728c739m8d20` reached `live`; `/api/health` reports `status: ok`, `db: connected`, `environment: production`, and **0** server errors. One ordinary turn used `openai/gpt-oss-20b` (`$0.001749`, `failovers=0`); one research turn used `openai/gpt-oss-120b` with native search (`$0.008803`, `failovers=0`); total **$0.010552**. Live failover was not triggered. PR #162 was rebased onto `d313620` and merged as `e18264e`; all four required checks passed, Render deployed the merge, and `/api/health` returns 200 with `status: ok`, `db: connected` and the expected commit. PR #165 merged as `d313620` at `2026-11-07T06:17:42Z`, and its final head `5941956` passed all four required checks in run `42346155717`; documentation guards **39/39**; the root map guard indexes **27/27** active documents with **30** unique invariants and **10** living reference documents within cadence; the four documentation test files pass **27/27**; `git diff --check` clean. PR #168 merged as `c99760d` at `2026-11-07T07:22:01Z` after head `d901a2a` passed all four required checks in run `42350783903`; Render redeployed and `/api/health` reports `c99760d`, `status: ok`, `db: connected`, **0** server errors. PR #166 was reopened, rebased onto `783daf3`, and merged as `ebafae3` at `2026-11-07T07:49:57Z` after head `03a7418` passed all four required checks in run `42352706388`; Render redeployed and `/api/health` reports `ebafae3`, `status: ok`, `db: connected`, **0** server errors. On 2026-11-07 the minimatch override merged: #173 head `e7cc2d3` passed run `42355968583` and merged as `0eca990`; #174 head `608d811` passed run `42356272906` and merged as `8fe6403`; mobile Jest passed **101 suites / 1,203 tests**, and the server CI job ran the full suite and boot smoke. Render deployed `8fe6403`; `/api/health` reports `status: ok`, `db: connected`, **0** server errors. Minimatch alerts #18/#19 are closed; `glob` and `deepmerge` remain. On 2026-11-07 the TypeScript 7 watch self-test passed **32/32**; the live row is **DEFERRED** with both parser chains at `8.72.1` and peer `<6.1.0`; the extracted gate matrix and stubbed issue creation/deduplication passed; `check-docs` and `git diff --check` are clean. On 2026-11-07 the Firebase Admin API returned authorized domains `localhost`, `inventoryai-d0d20.firebaseapp.com`, `inventoryai-d0d20.web.app` and `ai-inventory-l1mi.onrender.com`; the Password Reset template is Firebase's default with callback `https://inventoryai-d0d20.firebaseapp.com/__/auth/action`, not the custom server URL. The mobile reset path is AUTH-06 (`/api/auth/password-reset/code` → `/verify` → `/confirm`), and `sendPasswordResetEmail` is absent from the mobile Firebase boundary. | On 2026-11-07 `npm run verify:firebase` was added and, run against `server/.env`, returned `400 invalid_grant: Invalid JWT Signature` (exit 1), detecting the production outage locally; `check-docs` and `secret-guard` are clean. On 2026-11-07 the Firebase credential was rotated end to end: `npm run verify:firebase` returned `VERIFIED`, `/api/health` reported 200 with no unexplained server errors, and production created session rows at 13:06:29Z, 13:07:33Z, 13:09:49Z and 13:15:03Z, the last after the old key was deleted.
| **Blocked** | A phone-rendered fallback answer remains unobserved: the two phone turns needed no failover, so the AI-88 fallback answer was seen only in the server log and the terminal client. A live failover was not induced by a real upstream failure: the executed drill synthesised the 120B `503` inside the server, so a genuine outage is still unobserved, and the drill cannot fire when the research model is already cooling. The Render access review awaits the owner's plan and member list. No dependency decision is blocking; two Android builds were spent on 2026-11-09, and production OTAs were published on 2026-11-10 (`e38e07bf`), 2026-11-11 (`58f75323`) and 2026-11-13 (`39f78213`). The earlier same-thread compound attempt hit the 1,200-token output limit (`turn=c6d62a6a`); the deployed AI-105 retry now recovers the same thread's count/compound sequence (`bf777146`/`e4570da9`), so the user-visible reliability gap is closed. The compact-history trim is now exercised in production by the owner-only drill (turn `2d856074`, eight messages trimmed); the 20-message regression remains the focused proof. The v2 health workflow still has no `event=schedule` run despite the public repository, default `main`, active workflow, owner commit, disable/enable, replacement file and stepped cron; UptimeRobot now provides the hosted five-minute checks, and the Windows task is disabled. Free-served answers and the paid aggregate route are verified: three live free-model turns succeeded on 2026-11-10, and the aggregate question used `getInventorySummary` on `openai/gpt-oss-20b` for 2,446,801 units. The corrected 10k gate's one `AiOutputLimit` failure is closed by the 2026-11-11 rerun: **24/25 written, 25/25 semantically correct**, 0 errors, 0 degraded and no output-limit log. Render environment values were read successfully on 2026-11-13 through the Render API (the installed CLI v2.28.0 itself still could not read them); use the API or console for future reads. |
| **Next after this** | The on-device `Ref:` line, the e38 What's New card, the live Tagalog/Bisaya count turns, the AI-105 same-thread retry and the “Correcting the answer…” label are verified. The deployed 10K gate passed **24/25 written, 25/25 semantically correct** with no output-limit event, and the tenant restore re-read matches the pre-run shape. UptimeRobot now provides the automatic five-minute production checks; the Windows task is disabled; the GitHub scheduling experiments were removed/archived and v2 is manual-only. The compact-history trim is now live-exercised by the drill (turn `2d856074`). The local database suite should be rerun end-to-end after the test-isolation fix. No hosted pager or dashboard exists; the runbook documents the operator-side check. The free-served answer and the AI-99 aggregate fix are verified: three live free-model turns succeeded on 2026-11-10, and the aggregate question at 08:41 UTC answered 2,446,801 units on the paid default route. The 25-question gate has now run against the deployed URL. The installed 1.0.2 app showed the e38 support-reference What's New card; the 20-question 10k phone matrix is complete. The optional acceptance step remains installing the development APK on a spare device without replacing the production install. A genuine upstream 120B outage remains unobserved; the executed drill covers the deployment's failover route, not a provider-side failure. |

### Open items carried forward

| Item | State | Why it is open |
| --- | --- | --- |
| Single-location default, on a real device | Ready, phone pending | The production tenant `6ae6f1d8baa72cee39730240` now has exactly one ACTIVE location, and §27HF pins the late-arriving list for all three kinds; the visual check needs the owner to sign in on the phone |
| AI-42 live answer | Resolved 2026-11-02 | `getInventoryHistory` folds a transfer into one `from`/`to` event; the server reports `1c1734b` and the phone answered **From: Main Warehouse, To: Shop Front**, 2 units, once — [evidence](evidence/ai42-transfer-2026-11-02/README.md) |
| Brand and specification fields | Deployed; phone verification pending | The product records an optional `brand` (max 80) and, since AI-48, an optional `specifications` string (max 1,000). Both seeders write real sourced rows; the assistant searches and researches specifications. Production now runs the post-AI-48 schema; the phone check is still pending, and there is still no rating or review field. |
| `minimatch` advisory | Resolved 2026-11-07 | D-13 accepted the reviewed override; both lockfiles resolve `minimatch@11.0.5`, #173/#174 merged, and alerts #18/#19 are closed. |
| `glob` advisory | Deferred, D-10 | Patched `14.0.2` is a major outside every consumer's range; the installed chain still cannot reach it — see `SECURITY_DEPENDENCY_DECISIONS.md` §4 gate 6 |
| `zod` high advisory | Resolved 2026-11-02 | Cleared by `expo@58.0.22`; the nested `zod@3.25.76` is gone and the mobile audit reports **0 high** |
| `deepmerge` low advisory | Deferred | No fix inside the consumer's declared range; do not force versions |
| OTA code signing | Blocked by EAS plan | Free plan only; a signed binary would reject unsigned publishes |
| Play release | Not started, deliberately | V1 testing first |
| iOS device acceptance | External verification required | No macOS on the development host |
| GitHub contributor residue | Default branch clean; historical refs remain | The contributors API returns exactly **nreffejzxc 452** and **dependabot[bot] 7**. `main`'s five merge subjects were rewritten to `nreffejzxc`, and no merge subject names `jeffernqwerty`. Two non-merge documentation commit messages still quote the old login as historical context. PRs #99–#106 still show `jeffernqwerty` as author, and 18 Codebuff commits remain in 44 old PR refs; Git cannot rewrite either. The surgical rewrite preserved **38** of **42** commit signatures; **4** signed descendants lost theirs. Ticket #4936796 was closed without action because this account only has self-service resources. At the rewrite, local `main` matched `origin/main` (`d6bdbc35`); the old tip `afd7088` is preserved at `refs/backup/main-before-merge-subject-rewrite-afd7088` and in a verified bundle. The superseded `af44b60` pass is preserved at `refs/backup/main-before-signature-preserving-rewrite-af44b60` and in `main-af44b60.bundle`. The 16 identity-carrying local branches and four linked worktrees were retired after their tips and dirty states were saved under `refs/backup/local-branches-2026-11-02` and `refs/backup/worktree-wip-2026-11-02`. The 13 stale clean-identity branches were retired on 2026-11-02 after merged/ancestor/superseded checks, with each tip saved under `refs/backup/local-branches-retired-2026-11-02`; the merged work branches and the WIP backup remained locally at that point. On 2026-11-06, after their PRs were confirmed merged, 13 further local branches and 14 remote branches were retired; the #159 branch was deleted on merge. At that cleanup only `main` and the open server Dependabot ref remained; the two minimatch PR branches were deleted when #173/#174 merged, leaving `main` alone. |
| Current branch identity | Resolved 2026-11-01; PR #120 repaired 2026-11-02 | The three local commits were replayed onto `5d74f8e`; replayed head `ee7e710`, **3 ahead / 0 behind**, no retired email. The documentation commit follows on top, the branch was delivered through PR #119, and its local ref was retired on 2026-11-02 after backup. PR #120 now carries docs commit `d347b70`, replayed directly onto new `main`; its tree matches `ddc1474`, it is one commit ahead, and the branch no longer contains the old `main` ancestry. |

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

## 2026-11-13 — AI limits checked against production, an error-code reference, and the in-app AI card

**Status.** The three approved documentation/UX items are complete: production values reviewed,
error codes and Android messages documented, and a short AI limits card added to the profile
screen. The deprecated production reasoning alias was also removed. No AI behaviour or server code
changed.

**Production verification.** The live Render service `ai-inventory` was read through the Render API,
not from a local `.env` or a remembered value. It is on branch `main` at commit `705d192`, the same
commit as the local tree; the newest deploy is live. `/api/health` returned `status: ok`,
`db: connected`, `environment: production`, commit `705d192c9c39…`, and `/api/health/ready`
returned 200. The non-secret AI settings are:

- ordinary primary `openai/gpt-oss-20b`; research `openai/gpt-oss-120b`; one free fallback
  `nvidia/nemotron-3.5-lightning:free`;
- `AI_WEB_SEARCH=enable` and `AI_WEB_FETCH=enable`, so **native-web-first is active** in production;
- paid reasoning `enable`, free reasoning `disable`; the deprecated `AI_REASONING=enable` alias was
  present at the snapshot and is ignored because the new paid name wins;
- no timeout, rate-limit, context, output, iteration or budget override. The source defaults are
  therefore the production values: 60 s turn, 20 requests/60 s, 20 context messages, 4,000-character
  input, 1,200 output tokens, 6 ordinary/8 research iterations, $0.25 simple-paid daily budget.
- `TRUST_PROXY=1`; the AI limiter is user-keyed, so this affects only its no-user IP fallback.

**Production cleanup.** `AI_REASONING` was deleted from the production service through the Render
API. The list went from 25 to 24 variables; `AI_REASONING_PAID_MODELS=enable` and
`AI_REASONING_FREE_MODELS=disable` remain. The change was not applied to the running process until a
deploy, so the same server commit `705d192` was redeployed as `dep-dbr90j8u01pc73ai2pgg`. Render
reported it **live** at 04:22:29Z; `/api/health` then reported `status: ok`, `db: connected` and
commit `705d192c9c39…`, and `/api/health/ready` returned 200. `AI_REASONING` is absent from the
service's current environment list.

**Documentation.** Guide 18 gained §0, a dated production snapshot, production columns in the route
table, a production note in the web section, and a corrected short-version web line. Guide 19 is new
and maps every AI error code, transport outcome and drill-only code to the exact Android sentence or
screen behaviour, including the stop note and the truncated-answer marker. Both guides are linked
from `docs/README.md` and `docs/guides/README.md`; Guide 18 had been missing from the map.

**UI.** The profile screen now has an **AI assistant** section with four member-facing facts: up to
20 messages per minute, an answer can take up to a minute, stopping cancels the answer (a finished
answer appears on reopen), and an unavailable/limit-hit assistant leaves the rest of the app
working. It also states that the assistant is read-only. No token, model, tool, provider-quota or
fallback detail is shown.

**Quota wording.** The assistant's spent-allowance sentence now names **midnight UTC only**. The
previous `(8AM in Manila)` parenthetical was a city-specific local time shown to every member,
whether or not they were in that city. The client copy, both exact-copy tests, Guide 19 and this log
were updated together; UTC remains unambiguous without guessing the device's time zone.

**Verification.** `node scripts/check-docs.mjs` passed: 33 active documents indexed, 12 living
references within cadence. The four server documentation tests passed **27/27**. `mobile/npm run
typecheck` and `mobile/npm run lint` both exited 0. The full mobile suite passed **102 suites /
1,210 tests / 0 failures**. `git diff --check` passed. The production health check passed after the
Render redeploy.

**Delivery.** PR [#250](https://github.com/nreffejzxc/inventory-ai/pull/250) passed all four
required checks and was squash-merged as `8b99f46`. Android production OTA group
`39f78213-cc77-45f6-8b1b-0b9232b44a62` was published from that commit. After two cold starts, the
production phone loaded the dashboard with live stock and Profile showed the complete **AI
assistant** card with no clipped text or horizontal overflow. The device run and screenshot are in
[`evidence/ai-limits-profile-2026-11-13`](evidence/ai-limits-profile-2026-11-13/README.md). The
spent-allowance sentence was not triggered in that production-OTA run. It was subsequently
rendered on the phone in an isolated development-client run against a local OpenRouter-shaped
stub that returned `429` with `x-ratelimit-remaining: 0`; the app showed the exact UTC sentence,
the server logged `AI_QUOTA_EXCEEDED` with `quota=0/50`, and Products still loaded. No production
provider call or shared quota was used. The production APK was restored as 1.0.2 (versionCode 10)
and its dashboard and Profile were checked. See
[`evidence/ai-quota-device-2026-11-13`](evidence/ai-quota-device-2026-11-13/README.md).

**Regression coverage.** The streamed and pre-stream AI error paths are now pinned at the
transport-to-screen seam. `mobile/__tests__/ai40-assistant-streaming.test.tsx` feeds realistic
SSE `event: error` frames through the real `chatStream` transport for the six member-facing AI
codes (`AI_QUOTA_EXCEEDED`, `AI_RATE_LIMITED`, `AI_NOT_CONFIGURED`, `AI_UNAVAILABLE`,
`AI_OUTPUT_LIMIT` and `AI_TIMEOUT`); `AI_ABANDONED` is a server-side record and has no banner.
It also drives the ordinary JSON HTTP refusal for `AI_RATE_LIMITED` and `AI_NOT_CONFIGURED`, and
a retry test proves a rate-limit refusal restores the question and a second Send succeeds without
retyping. Each case asserts its own exact sentence, no JSON fallback, and composer recovery; the
quota and rate-limit cases also assert the other's sentence is absent. The full mobile suite
passed **102 suites / 1,219 tests**, with typecheck and lint clean.

---

## 2026-11-11 (late) — AI-105 live trim, AI-106 share answer, and the external health scheduler

**Status.** The three approved reliability tasks are complete and validated; no new AI feature was
introduced. Production serves `c3bd692` from PR #237 with `/api/health` healthy.

**AI-106.** The low-stock share question returned **19 products / 1,633,025 / 0.47% of
346,118,013** on the OPPO (`Ref: cb84331e`). The earlier 41-row answer counted paged stock rows as
products; the deterministic route now uses `getLowStockProducts(limit 50)` and `getStockValue` only
for the denominator. The screenshot is
[`low-stock-share.png`](evidence/ai106-low-stock-share-2026-11-11/low-stock-share.png). The focused
regression suite passed 11/11; the full unit suite passed 1,990 / 0 fail / 62 skipped.

**AI-105.** A request-scoped, owner-only `x-ai-output-limit-drill: retry` header makes the otherwise
intermittent path testable. On production `c3bd692`, against a 12-message conversation, turn
`2d856074` returned 201, logged `empty=1 retries=1`, and Render emitted
`AI output limit retry: trimmed 8 prior message(s), kept the current turn`. The empty completion was
simulated by the drill; the retry, larger cap, reasoning budget, trim, provider calls and persisted
answer were real. PR #237 passed all four required checks (run `43067882255`), merged as `c3bd692`.
Focused suite 15/15; full unit suite 1,991 / 0 fail / 62 skipped; typecheck and lint clean. Evidence:
[`ai105-output-limit`](evidence/ai105-output-limit-2026-11-11/README.md).

**Scheduler.** GitHub still emits no `event=schedule` for v2. The current-user Windows task
`InventoryAI Production Health Watch` now dispatches the workflow every five minutes through
`scripts/trigger-production-health-watch.ps1`; it uses the existing `gh` login and stores no token.
Its first automatic run fired at 2026-11-12 01:36:35 +08:00 with task result 0 and dispatched
[`43069829375`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43069829375)
(`workflow_dispatch`), which succeeded in 14 seconds. The task runs only while the operator is signed
in and the laptop is awake and online; this limitation is documented rather than presented as hosted
monitoring. Evidence:
[`production-health-scheduler`](evidence/production-health-scheduler-2026-11-11/README.md).

**Checks.** The wrapper was executed manually (`43069607155`) and by the task (`43069829375`); the
registration script created the task and reported `Ready`, with task result 0 and 0 missed runs. The
docs/scheduler delivery runs `node scripts/check-docs.mjs` and `git diff --check`; the required
four-check CI gate is recorded on its PR.

## 2026-11-11 — deployed 10K gate rerun, long-thread production test, and the schedule fallback

**10K gate.** The one-off deployed gate ran 25 sequential questions against production `3b275df` over the synthetic `PERF SEED` tenant (10,000 products / 20,006 rows, five low SKUs). Result: **25/25 accurate, 25 free-served, 0 errors, 0 degraded, $0.000000**; median 4,932 ms, p95 10,549 ms. Render logged **no output-limit event** in the run window, so the earlier intermittent `AiOutputLimit` occurrence is closed for this rerun. The 20,006-row snapshot was restored and a read-only re-read matched the pre-run shape: 10,000 ACTIVE products, 20,006 rows, 1,535 low-stock products, `SEEDSKU-0=401`, `SEEDSKU-5000=331`. See [`evidence/deployed-gate-2026-11-11/README.md`](evidence/deployed-gate-2026-11-11/README.md).

**Long-thread production test.** The same OPPO thread was extended past four prior messages and the compound question was repeated. It answered **19 / 1,633,025** correctly multiple times (`0d4bbbf4`, `283aaf89`, `9100219d`, `1c4e64c2`, `a5cc6da5`), with Render showing `retries=0` and `empty=0`. No `trimmed` line and no empty output-limit event appeared, so the compact-history trim was **not exercised live**; the 20-message regression remains its direct proof. See [`evidence/ai105-long-thread-2026-11-11/README.md`](evidence/ai105-long-thread-2026-11-11/README.md).

**Schedule.** PR #234 replaced the v2 workflow's comma-list cron with `2-59/5 * * * *` and documented manual dispatch. A manual run `43060542900` succeeded in 12 s; `event=schedule` remained **0** through the 16:42 UTC window. The repository is public, not a fork, active, and has a working scheduled TypeScript watch, so this is a GitHub schedule-registration limitation, not a cron or branch defect. The practical fallback is `gh workflow run production-health-watch-v2.yml`, documented in `MONITORING.md` and Guide 6.

## 2026-11-11 — AI-105 same-thread retry fixed and the reset label observed

**Status.** PR [#232](https://github.com/nreffejzxc/inventory-ai/pull/232) squash-merged as `3b275df` at 2026-11-11T15:48:49Z. Production `/api/health` reports that commit with `status: ok`, `db: connected`, environment `production` and 0 server errors; `/api/health/ready` returns 200. CI run `43051417184` passed all four required checks. No provider, token-limit or Render environment setting changed.

**Fix.** The empty output-limit retry now keeps at most the four most recent prior messages and the current turn's question, tool calls and tool results. The full 20-message thread is no longer replayed on retry. The normal 1,200-token cap is unchanged; the retry keeps the existing larger cap and paid reasoning budget.

**Exact same-thread production test.** In one new chat, `How many low-stock products are there in total?` answered **19 products need restocking** (`Ref: bf777146`), and `How many products are low on stock and what is their total value?` answered **19 / 1,633,025** (`Ref: e4570da9`). Render matched both refs. The compound turn hit `maxTokens=1200` on its first attempt and recovered on the retry, ending `outcome=ok calls=3 empty=1 retries=1 tools=getLowStockProducts out=879`; the app showed the answer, not the output-limit sentence. See [`evidence/ai105-production-2026-11-11/README.md`](evidence/ai105-production-2026-11-11/README.md).

**Label.** The “Correcting the answer…” label was observed live in a fresh count chat. The screen displayed **“Correcting the answer…”** and “The earlier draft was replaced with the final answer.”; the turn then completed with **19** at `Ref: 008a1583`. Render logged the matching reset: `AI simple route (restock_count) answered without its shortage read — asking again turn=008a1583`, followed by `outcome=ok calls=3 reasks=1 tools=getReorderNeededProducts`. Screenshot: [`correcting-answer.png`](evidence/ai105-production-2026-11-11/correcting-answer.png).

**Checks.** The focused AI-105 suite passes **3/3**, including the 20-message regression; the full server unit suite passes **2,047 tests (1,985 pass, 62 skipped, 0 fail)**; server `typecheck` and targeted ESLint pass. Android only; iOS remains untested.

**Scope note.** The live same-thread conversation had only the count exchange before the compound turn, so the four-message trim did not remove anything in that run (`trimmed` did not appear in Render); the 20-message regression test is the focused proof of the trim. The production turn did exercise the output-limit retry and proved the user-visible recovery.

## 2026-11-11 — AI-106 finalizer audit and the reset-UX OTA: detail preservation, a count misread as value, and an unobserved live label

**Status.** Task 2 is **fixed, deployed and live-verified** at Render commit `26eb0d4`; Task 1's OTA is **published and loaded** on the OPPO, but the new **“Correcting the answer…”** label was **not observed live**. The count and compound answers and their Render turn logs match. No Render environment value, OpenRouter setting or AI model changed.

**Task 2 — deterministic finalizer audit.** The audit found three ways a finalizer could discard requested detail. First, “How many products are low on stock and what is their total value?” matched the count finalizer because `asksForLowStockValue` only looked for “low stock”, not the common “low on stock”; a count replacement could therefore overwrite the value sentence. `asksForMultipleFacts`, `SECOND_REQUEST`, `SECOND_AVAILABILITY`, `RANKED_COUNT` and `ASKS_LOW_STOCK_LIST` now recognise the compound shape, and the single-fact replacement predicates for most-expensive, price-threshold, stock-out count, top-out, brand range, best-selling, product-location, product-total and highest-stock-value leave a compound draft alone. The value-plus-names path keeps the value and appends the names instead of replacing the value with a name-free sentence.

Second, the live phone exposed a count being answered with money. “You already told me. How many low-stock products are there in total” returned **“The total recorded value of the 19 low-stock items is 1,633,025.”** (`Ref: d8aadd1a`). `asksForLowStockValue` accepted a bare “total”; it now requires **value** or **worth**, so “in total” is a count. The count predicate also accepts a short preamble (“You already told me.”) and hyphenated “low-stock”, and the simple-route restock wording accepts the same hyphen. The exact phone sentence is now a regression case: it is not a value ask, it is a restock count, and `restockCountAnswer(19, 2000)` returns **“19 products need restocking.”**

Third, the audit's earlier compound guard still had a blind spot for a count question whose “how many” was not the first words. The broadened `ASKS_ONLY_FOR_A_COUNT` plus the existing list/which/show exclusions covers that wording without turning a deliberate list request into a count.

**Tests.** `server/test/AI106-finalizer-detail-preservation.test.mjs` adds six focused tests covering count-plus-value, the bare-total phone sentence, value-plus-names, compound and ranked questions, the single-fact replacement guards, and the combined total-plus-highest finalizer. The focused server suites pass **91/91**; server `typecheck` and `lint` pass. The full DB-independent unit suite passes **408 suites, 1,984 tests, 0 failures, 62 skipped** (`UNIT_EXIT=0`) after `AI106-finalizer-detail-preservation.test.mjs` was added to `server/scripts/run-tests.mjs`. Mobile `typecheck`/`lint` pass and the focused AI-40 Jest suites pass **18/18**; the mobile code was not changed in this phase.

**Task 1 — OTA publication.** `npx eas-cli@latest update --channel production --environment production --platform android --message "Show 'Correcting the answer...' when AI replaces a draft" --non-interactive` published group `58f75323-eeab-4aee-b48d-5f3c38e2396a`, Android update `01a1ca6c-b450-7def-ab6f-b013782918fe`, runtime `1.0.2`, from commit `7bfec39`. The EAS production channel points at that group. The installed `com.inventoryai.app` 1.0.2 (versionCode 10) downloaded the manifest and logcat reported `NEW_UPDATE_LOADED` for the same group; the chat UI opened at **New Chat**.

**Phone evidence.** The Tagalog count turn “Ilan ang low stock na produkto?” answered **“May 19 na produktong mababa ang stock.”** (`Ref: ffc1524a`), and “How many are those” answered **“May 19 mga produktong nababa ang stock.”** (`Ref: 6769b530`). The later “You already told me. How many low-stock products are there in total” answered with the **value** above (`Ref: d8aadd1a`), which is the finalizer bug this entry fixes locally. A question beginning “Without checking again…” returned the full restock list (`Ref: 5ee2cb23`), another sign that the old count rule did not see past a preamble. A controlled repeat prompt still performed a tool read and returned **19** products (`Ref: 128c30d7`); a controlled failure-notice prompt was refused (`Ref: 4f5571e9`). None of these turns invoked the server's reset/re-ask path, so **the “Correcting the answer…” label itself was not observed**. The handler is live code (`onReset` clears the draft and sets `correcting`; `ThinkingRow` renders the label only while `sending && !streamingText`), but a screenshot is required evidence and no such screenshot exists.

**Production deployment and live retest.** PR #229 squash-merged as `26eb0d4`; `/api/health` reported that commit with `status: ok`, `db: connected`, environment `production` and zero server errors; `/api/health/ready` returned 200. On the installed OPPO, `How many low-stock products are there in total?` answered **“19 products need restocking.”** (`Ref: 4cef1383`), and `How many products are low on stock and what is their total value?` answered **“The total recorded value of the 19 low-stock items is 1,633,025.”** (`Ref: 771dc31f`). Render's application logs for the same turn tokens show `getReorderNeededProducts` for the first and `getLowStockProducts` plus `AI low-stock value computed from the returned rows` for the second. The count is **19**, not the value; the compound answer retains both facts. A first compound attempt in the same conversation hit the existing output-budget path (`turn=c6d62a6a`, `AI_OUTPUT_LIMIT`, maxTokens=1200, tools=none) rather than returning either fact; a clean fresh-chat compound turn passed.

**Evidence.** [`docs/evidence/ai106-ota-2026-11-11/README.md`](evidence/ai106-ota-2026-11-11/README.md) records the OTA and its phone turns; [`docs/evidence/ai106-production-2026-11-11/README.md`](evidence/ai106-production-2026-11-11/README.md) records the deployment, the two production turns, the matching Render log excerpts and the output-limit observation. No credentials, tokens or personal data are included.

**Limits.** The server fix is deployed at `26eb0d4`; the count and compound answers and their Render `turn=` logs are verified. The reset label remains an unverified UI item, not a claimed pass. The same-thread compound attempt hit the pre-existing output-limit path before a clean fresh-chat turn passed. iOS was not tested; no standalone APK was built in this phase.

**Checks.** `node scripts/check-docs.mjs` and `git diff --check` are run with this record; the focused and full server results above are the actual command results.

## 2026-11-11 — Four-task close-out: dependency lockfiles, external health watch, AI language/output limit, and phone UI

**Status.** This entry records the work performed and the checks actually run before the post-merge
verification. It is deliberately not a completion claim: the external workflow's real failure and
recovery cycle, the live language turns after deployment, and Dependabot's alert closure are still
pending at the time of writing.

**Task 3 — Dependabot.** The 2026-11-11 API read showed **8 open alerts**, not the three previously
documented: #20–#23 `node-forge` (three medium, one low), #24 `fast-xml-parser` (low), #14/#16
`glob` (medium) and #13 `deepmerge` (low). The two packages with patched releases inside their
consumers' declared ranges were updated in the lockfiles only: mobile `node-forge` **1.4.3** and
server `fast-xml-parser` **5.12.0** (with its nested parser dependencies). `package.json` is unchanged.
Post-update audits report server **5 entries / 1 advisory** (`glob`) and mobile **27 entries / 2
advisories** (`glob`, `deepmerge`), 0 high or critical. `node-forge` and `fast-xml-parser` are absent
from their vulnerable ranges; their five alerts are expected to close when the lockfiles reach the
default branch. `glob` and `deepmerge` stay accepted under D-10/D-4 because no patched release exists
inside any installed consumer's range.

**Task 1 — external uptime.** `scripts/check-production-health.mjs` probes `/api/health/ready` and
`/api/health`, requires `status: ok` and `db: connected`, and exits 1 only after two consecutive
failures. `.github/workflows/production-health-watch.yml` runs every five minutes from GitHub and
opens one issue titled `[production-health] Production endpoint is unhealthy`; recovery comments and
closes it. GitHub issue notifications are the delivery channel; there is no hosted pager. The local
probe against production returned healthy (`e15136a`, `/ready` 200, `db: connected`), and the OPS-4
test covers healthy, readiness-down, degraded/database-down and transient-recovery decisions.
Post-merge, the bad-URL run `42997930724` created issue #223 and the production run `42998077450`
commented on and closed it.

**Task 2 — AI.** AI-105 adds optional per-call `maxOutputTokens`/`reasoningBudgetTokens` overrides. The
one retry after an empty `AiOutputLimit` now uses 2,400 max tokens and a 1,200-token reasoning budget
for a paid model, leaving the original cap for the answer; free models get the larger cap without a
reasoning field, and the normal configured cap is unchanged. AI-84 adds deterministic Bisaya/Tagalog
detection and a direct `LANGUAGE FOR THIS ANSWER` instruction in the system prompt, final answer
round and simple route; English turns get no directive. The focused AI-105/AI-84/OPS-4 suites pass
**12/12** plus the new localized-count cases; the server unit suite is **2,040 tests (1,978 pass, 62 skipped, 0 fail)**, including real-wire assertion of `max_tokens: 2400` and the reasoning field.

**Task 4 — phone.** The first `Ref: 74ef2707` observation came from the production OTA bundle; after
clearing local data the app fell back to the Nov 9 embedded 1.0.2 bundle, which predates the ref
feature. A force-stop/relaunch re-downloaded the OTA bundle, the dashboard showed the OTA
**What's new — AI answers now include a support reference** card, **Got it** dismissed it, and a
fresh answer rendered **`Ref: 566f6d71`**. The live Bisaya and Tagalog count turns rendered
**`Ref: 0d1ed88c`** and **`Ref: 9adeefa7`**. Evidence:
[`evidence/task4-2026-11-11/README.md`](evidence/task4-2026-11-11/README.md).

**Checks actually run.** Server `typecheck`, `lint`, `check:extensions` and `check:specifiers` exit
0; `npm run test:unit` is **2,040 tests: 1,978 pass, 62 skipped, 0 fail**. Mobile `typecheck` and
`lint` exit 0; Jest is **102 suites / 1,208 tests**, all pass. `check-docs` reports 31 active
documents; the upgrade-watch self-test is **32/32**; `git diff --check` is clean. The full server
database suite is left to CI because the local Mongo connection is not reliable at this hour.

**Streaming reset UX (2026-11-11).** A phone reproduction showed the sequence the owner reported:
a draft was streamed, then the bubble showed **“Analyzing your inventory…”**, then the shorter final
answer. The server had deliberately discarded the draft (`reset`) and replayed the stored answer;
the final Tagalog count was **19**, matching the Restock screen, so the response was not truncated.
The client now labels this state **“Correcting the answer…”** and says the earlier draft was
replaced. The focused AI-40 streaming suite passes **11/11**; mobile typecheck and lint pass. The
installed app needs the next OTA to show the new label.

---

## 2026-11-11 — Post-close-out verification status: scheduled watch, AI-105 live path, standalone APK

**Status.** These are verification results, not completion claims. No AI or monitoring feature work
was started in this phase.

**Scheduled production watch — PENDING.** The workflow is active on `main`, with cron
`*/5 * * * *`. After more than an hour, GitHub has emitted **no `schedule` event** for it. The only
runs listed are the two manual dispatches `42997930724` and `42998077450`; those are not evidence
for the automatic path. The next scheduled run remains the required check.

**AI-105 live retry — NOT REPRODUCED.** A live production turn on the physical OPPO (serial
`PV4DDMIZZLTCIVSK`) at 2026-11-11 11:04 UTC returned `Ref: d245d0e7`. The server log for that turn
is `outcome=ok calls=3 attempts=3 empty=0 retries=0` on `openai/gpt-oss-20b`; there was no
output-limit retry. The focused controlled suite passes **2/2** and proves the paid retry asks for
`max_tokens: 2400` with a 1,200-token reasoning budget, but that is not a live occurrence. No
Render environment variable was changed and no provider failure was forced.

**Standalone development APK — BLOCKED.** The local build initially failed because the Android
NDK was absent; NDK `27.1.12297006` is now installed. A separate release package
(`com.inventoryai`, distinct from the installed `com.inventoryai.app`) was built against
production. The first retry failed at `:react-native-firebase_auth:compileReleaseKotlin` because
Firebase Auth's metadata is Kotlin 2.4.0 while Gradle selected 2.2.10; selecting
`android.kotlinVersion=2.4.0` fixed that step. The `arm64-v8a` build then failed at
`:react-native-reanimated:buildCMakeRelWithDebInfo[arm64-v8a][reanimated]` with
`ninja: error: mkdir(CMakeFiles/reanimated.dir/C_/Users/jeffe/inventory-ai/mobile/node_modules/react-native-reanimated/Common/cpp/reanimated/CSS/common/transforms): No such file or directory`.
No APK was produced or installed. The installed production app remains `com.inventoryai.app`
1.0.2 (versionCode 10; last update 2026-11-09 17:20:27).

---

## 2026-11-11 — AI-103 history totals, OPS-3 monitoring runbook, and a cleared dependency queue

**Why.** A review of the assistant's tool layer found that `getInventoryHistory` built its
whole-set summary only when a stock-out existed. A question about receipts or transfers could
therefore return no `unitsReceived` and no `transferLegs`, leaving the model to add page rows —
the arithmetic AI-68 moved into MongoDB to prevent. The monitoring work from AI-101/AI-102 also
had no operator runbook: the health endpoints, the OPS-2 pulse, the turn records and the metrics
aggregate were documented in different places, and the auth checklist still recorded monitoring
as unaddressed.

**Changed.** `historyMovementSummary` now emits each whole-set total whenever its own movement
type has rows, independently; `getProduct` marks a partial stock page. `docs/MONITORING.md`
records the three health endpoints, the response pulse, the AI turn records, the metrics
aggregate, the alert thresholds, the incident procedure and the limits. The auth checklist and
the dated production anchors now point at it. Two test-isolation defects found by the local
database run were fixed: the full-catalogue provider suite no longer inherits a developer's
native-web switches, and the per-IP limiter boundary test uses a five-second window.

**Verified.** `npm run typecheck` exit 0; `npm run test:unit` **2,027 tests, 1,965 passed, 62
intentionally skipped, 0 failed**; the focused AI-103/AI-68 suite 6/6; lint and both module-graph
checks exit 0; `node scripts/check-docs.mjs` reports 31 active documents and 12 living references.
A live one-question simple-inventory evaluation was 1/1 accurate: the paid baseline answered in
7,132 ms for $0.000273, and the free-first turn was served by
`nvidia/nemotron-3.5-lightning:free` with 0 escalations, 3 calls, 4,542 ms and `$0.000000`; the
disposable tenant was removed. PRs #217, #194 and #218 each passed all four required checks.
Production `/api/health` served the merge commits; the final runtime commit is `e15136a` with
`status: ok`, `db: connected`, environment `production`, 0 server errors, and `/api/health/ready`
returned 200. `GET /api/ai/metrics` returned 401 unauthenticated, as designed.

**Delivery.** PR #217 → `c00365d`; PR #194 (mongoose 9.11.4 → 9.12.0) → `326730f`; PR #218
(test isolation) → `e15136a`. The docs-only close-out does not redeploy. The dependency queue now
has no open Dependabot PR; the remaining alerts are `glob` #14/#16 and `deepmerge` #13, and
TypeScript 7 is still the only deferred upgrade.

**Not done.** The `Ref:` line and the answer-reference What's New card have not been observed on
a phone. No hosted pager, dashboard or shared counter exists: the runbook documents an
operator-side uptime check, and the OPS-2 counters remain process-local. A genuine upstream 120B
outage remains unobserved. The local database suite was not rerun end-to-end after the two test
fixes; the required `server` CI job ran the full suite on #218 and passed.

**Evidence.** PRs #217, #194 and #218; [`MONITORING.md`](MONITORING.md);
`AI68-history-totals.test.mjs`; `server/.tmp-ai103-live-smoke.json` (git-ignored);
`GET /api/health`; `GET /api/health/ready`; `GET /api/ai/metrics` (401 unauthenticated).

---

## 2026-11-10 — Close-out: AI-102 deployed and the answer-reference OTA published

**Shipped.** PR #214 passed all four required checks and squash-merged as
`eda08d05209130b3290456ece092ee3e0d25bbd1`. Render auto-deployed it; `/api/health` reports
`eda08d0`, `status: ok`, database `connected`, environment `production` and 0 server errors. The
production metrics endpoint returned `401` without a session and `200` for a real OWNER session with
`Cache-Control: no-store`; the seven-day window was empty because no completed turn had yet written a
row after the deploy. Its response is `range`, `totals` (including `totals.cost`) and `daily`.

**Mobile.** Production OTA group `e38e07bf-6eab-4b71-be90-c3604cab5c3a` (Android update
`01a1c524-5ae0-71d8-af9e-6e6711da6ba6`) was published from `eda08d0` for runtime `1.0.2` with the
message "Release notes: AI answers now include a support reference". `update:list` confirms it is the
newest production group, and it carries the selectable `Ref:` answer reference and the matching
What's New card. The first publish attempt failed before upload on Windows (`spawn UNKNOWN` from the
Hermes compiler under Node 26); the retry under the repository's Node 24 succeeded and uploaded the
2.9 MB Hermes bundle.

**Docs and evidence.** The specification and Guide 16 now describe the answer reference and the
metrics contract, including the nested `totals.cost` fields. The deployed gate evidence and the
permission binding (`ai.metrics.view`, OWNER/ADMIN) are recorded. See
[the deployed-gate evidence](evidence/deployed-gate-2026-11-10/README.md).

**Not done.** The new What's New card and the `Ref:` line have not been observed on a phone. No live
turn has yet produced a production `ai_turn_metrics` row or provider cost after this deploy. A genuine
upstream 120B outage, the corrected 10k gate's remaining `AiOutputLimit`, and the phone matrix's
research-grounding/language findings remain open.

## 2026-11-10 — AI-101 answer reference merged and deployed

**Why.** A stored answer had no user-visible way to name its turn, so support could only search by
text and approximate time. The turn id already joined the server records; the missing piece was
carrying it to the mobile thread.

**Changed.** The assistant `AIMessage` stores the turn's id, both chat transports return it,
conversation reads include it, and `AiChat` renders a selectable `Ref: <id>` beneath the answer. User
messages and answers written before the field existed show nothing. PR #213 squash-merged as
`603a8e8` after all four required checks passed; the post-merge main run `42801486881` passed the
same four jobs. Render auto-deployed `603a8e8`; `/api/health` reported `production`, database
connected and 0 server errors.

**Not done.** The reference has not been observed on a phone; the installed production bundle
predates it. The production OTA that carries it is pending in this close-out. Verification used the
controller tests and repository checks, not a device.

## 2026-11-10 — AI-102: durable turn metrics and a protected metrics endpoint

**Why.** AI monitoring was text-only. The closing `AI turn` line is excellent for diagnosing one
request, but it cannot answer “how much did we spend today?” without scanning logs, and Render log
retention eventually removes the history. The approved scope was a secure endpoint and accurate
structured aggregation first; no dashboard or alerting.

**Built.** `AI-102` adds `ai_turn_metrics`, one row per completed assistant turn, written from
`reportTurn` on every exit path (success, degraded and failure). The unique key
`{ businessId, turnId, startedAt }` makes a retried report an upsert, so provider calls, retries and
re-asks never become extra turns; two real turns that collide on the short turn id remain two rows.
The row records counts, durations, model/tier, upstream, tokens, quota/web labels and provider cost
provenance. It never records a prompt, answer, tool argument or tool result.

`GET /api/ai/metrics?days=7` (permission `ai.metrics.view`, granted only to OWNER/ADMIN; `days` 1–90,
default 7) aggregates the caller's business in MongoDB with a `{ businessId, completedAt }`-indexed `$match` and a single `$facet`.
It reports free/paid/unknown turns, failover turns and total failovers separately from retries and
re-asks, latency mean/median/p95/min/max, and daily spend for every UTC day in the window. Cost is
**provider-reported only**: `providerReportedUsd` is `null` when nothing was reported, partial and
unknown coverage are explicit, `complete` is false unless every cost was reported, and
`estimatedUsd` is `null` with `estimatedAvailable:false` rather than a fabricated estimate.

**Also wired.** The model barrel exports/registers `AiTurnMetric`; tenant teardown removes
`ai_turn_metrics`; test cleanup does the same; the DEMO-2 teardown fixture now seeds and verifies a
distinct count for the collection; and the test runner registers the new suite.

**Verified.** `AI102` unit suite 4/4 and DB suite 7/7 (auth 401, MANAGER/STAFF 403, OWNER/ADMIN 200,
tenant isolation, invalid `days` 400, zero turns with null spend, duplicate-report and
same-id/different-start persistence, plus a real stubbed turn proving `reportTurn` writes the
provider cost and paid tier). The DEMO-2 teardown
suite passed 8/8, including the new `ai_turn_metrics` fixture and preview/delete counts. Server
typecheck, changed-file lint and docs checks pass. **Not deployed**, and no dashboard or alerting
was added.

## 2026-11-10 — 25-question simple-inventory gate run against the deployed Render URL

**Why.** Every previous 25-question gate called `runAiChat` in-process against a disposable
development tenant. The routing, free-first escalation and response path had not been measured over
the deployed HTTP surface with production authentication.

**Ran.** The same 25 question texts went to `https://ai-inventory-l1mi.onrender.com` (commit
`6924c50`, `/api/health` `status: ok`) as `POST /api/ai/chat`, one at a time with a 1,000 ms gap and
no `conversationId`. Authentication was the app's own production path — Firebase Admin custom token
→ Firebase ID token → `POST /api/auth/firebase/exchange`; no JWT secret was read and no token was
logged. The production `PERF SEED` tenant has 10,000 products and 20,006 inventory rows (the dev
gate has 10,256 and 20,539). Its 20,006 quantities were snapshotted, normalized to the gate's five
low-stock shape, and restored in `finally`; the tenant again reports 1,535 products at or below
minimum and `SEEDSKU-0` = 401.

**Result.** **24/25 as the gate scores it, 25/25 semantically**, 0 errors, 0 degraded, 21 served by
`nvidia/nemotron-3.5-lightning:free` and 4 by `openai/gpt-oss-20b`, median **3,933 ms**, p95
**6,501 ms**, mean 4,142.36 ms, min 2,749 ms, max 7,244 ms, estimated cost **$0.00295702**
(provider-reported paid delta **$0.00248445**), 127.7 s, free allowance 933 → 882 (51 requests).
Compared with the in-process run at 08:55Z (25/25, 20 free / 5 paid, median 5,132 ms, p95 8,284 ms,
$0.003269, 155.1 s), the deployed median was **−23.4%**, p95 **−21.5%**, estimated cost **−9.5%**
and wall-clock **−17.7%**. The one scored failure was `exists-absent`: the free model answered “No
product with SKU SEEDSKU-999999 is recorded in your inventory” after a `getProduct` read, which is
correct; the evaluator's `existenceCheck` does not recognise that denial wording. The datasets also
differ, so the latency and cost comparison is indicative rather than controlled.

**Not done.** Nothing was fixed or deployed. The scorer's absent-SKU wording gap is recorded, not
changed, so the artifact's 24/25 still matches the code that produced it. The one-off runner and
inventory snapshot were temporary and are not committed. Evidence and the full artifact:
[deployed-gate-2026-11-10](evidence/deployed-gate-2026-11-10/README.md).

## 2026-11-10 — AI monitoring deployed and verified with free and paid turns

**Shipped.** PR #211 passed all four required checks (attribution, secret guard, mobile and server)
and squash-merged as `6924c50`. Render auto-deployed it; `/api/health` reports commit `6924c50`,
status `ok`, database `connected`, environment `production`. The boot log wrote the new record:
`AI configuration models=openai/gpt-oss-20b->nvidia/nemotron-3.5-lightning:free
reasoning-free=disabled reasoning-free-source=AI_REASONING_FREE_MODELS reasoning-paid=enabled
reasoning-paid-source=AI_REASONING_PAID_MODELS reasoning-legacy=enable web-search=enabled
web-fetch=enabled`.

**Verified with real turns.** Two production turns on the synthetic perf-seed tenant:

- Free: `AI request intent=inventory:product_stock route=simple model=nvidia/nemotron-3.5-lightning:free
  tier=free … turn=f0dc8264`, three `AI model call` records with the same turn, and `AI turn
  outcome=ok status=ok duration=3.93s total=3928ms calls=3 … tools=getInventory toolRuns=1
  in=35894 out=85 cost=$0.000000 upstream=Nvidia tier=free turn=f0dc8264`.
- Paid: `AI request intent=inventory route=default model=openai/gpt-oss-20b tier=paid …
  turn=372dddfc`, two model calls with `reasoning=enabled field=omitted
  source=AI_REASONING_PAID_MODELS`, and `AI turn outcome=ok status=ok duration=5.69s total=5688ms
  calls=2 … tools=getInventorySummary toolRuns=1 in=19244 out=95 cost=$0.001033 upstream=Parasail
  model=openai/gpt-oss-20b tier=paid turn=372dddfc`.

In both, the request, every model call and the result carried the same turn id.

**Not done.** The records remain text logs: no metrics endpoint, dashboard, retention policy or
alerting. Verification used the synthetic perf-seed tenant and a Firebase custom-token session, not
real-member traffic.

## 2026-11-10 — AI-101 one `turn=` id joins a request to its model calls

**Why.** The monitoring records stated what happened but not which turn it belonged to. A
multi-call turn wrote one `AI request`, several `AI model call` lines and one `AI turn`; joining
them meant matching model ids and timestamps, and two concurrent turns on the same model were
indistinguishable.

**Changed.** `newTurnId()` mints an eight-character hex id once per `runAiChat` turn. It travels on
`AI request`, every `AI model call` (through `ProviderRequest.turnId`), the turn's web-tool,
empty-completion, output-limit and ignored-stream records, the simple-route warnings, and
`AI turn` / `AI degraded turn`. Direct provider calls print `turn=none`. The id is a label only:
no prompt, tenant or user data is derived from it, and `AI101-ai-monitor.test.mjs` pins its shape,
its presence on every record and the uniqueness of two turns.

**Verified.** `npm run typecheck` and changed-file ESLint passed. The focused suites passed 198
tests (194 passed, 4 intentionally skipped, 0 failed), including the wire, OpenRouter-provider,
usage-report, failover and simple-routing suites. The guide samples and the scripts' `AI turn`
anchors still match because `turn=` is appended at the end of each line.

**Not done.** Nothing was committed or deployed; the records remain text logs, not a metrics
endpoint.

## 2026-11-10 — AI-101 assistant monitoring records, and a 25/25 gate

**Why.** The assistant's operational facts were spread across four lines with two shapes — a turn
cost line, a per-request reasoning line, a web-tool line and three boot lines. Answering "which
model answered, was it free, did reasoning or the web run, which upstream served it, how long did it
take, what did it cost and did it retry" meant joining them by model id and time. This session also
ran the full 25-question simple-inventory gate after the AI-99 routing fix.

**Changed.** Added `server/src/services/ai/aiMonitor.ts` with one formatter per record:
`AI request` (intent, route, model tier, the free/paid/legacy reasoning switches and the variable
that supplied each, web switches, allowed tools), `AI model call` (provider, model, tier, reasoning
field actually sent), `AI turn` (outcome, status, duration in ms and seconds, provider/tool time,
calls, attempts, empty completions, retries, failovers, re-asks, tools, tokens, credits, quota, web
use, upstream provider, model, route, iterations) and one `AI configuration` boot record. The
provider contract now carries the upstream provider OpenRouter reports; a live probe answered
`provider=Groq`. The generic `[ai]` prefixes were replaced with descriptive `AI …` labels across the
service, providers, watchdog and CLI output, and `scripts/ai-usage.mjs` plus the focused tests were
updated to the new anchors.

**Verified.** `npm run typecheck` passed and changed-file ESLint passed. The 25-question gate ran to
completion with exit 0: **25/25 accurate, 0 errors, 0 degraded**, all 25 on `route=simple`, 20 served
free by `nvidia/nemotron-3.5-lightning:free` and 5 by `openai/gpt-oss-20b` (20% paid fallback), median
5,132 ms, p95 8,284 ms, estimated cost **$0.003269** (provider-reported paid delta $0.002579). The
seeded 10,256-product dev tenant was removed afterwards (0 seed tenants/users remain). The new
`AI101-ai-monitor.test.mjs` and the focused AI suites passed (178/180, 53/57 and 73/74, with the
remainder intentionally skipped); the full unit suite reported 2,017 tests, 1,955 passed, 61 skipped
and one failure — the documentation fact-drift guard, because the new module changed the stated
count from 171 to 172; the count is corrected here and the guard was rerun.

**Not done.** Nothing was deployed or committed; the gate ran the service in-process against the
disposable development tenant, not against the deployed Render URL, and no mobile, OTA or provider
configuration changed.

## 2026-11-10 — 25-question simple-inventory gate passed 25/25 after AI-99

**Why.** AI-99 widened the aggregate guard so whole-inventory questions stay on the paid route, and
its entry recorded that the full gate had not been rerun. The gate was then run against a disposable
10,256-product development tenant to measure the assistant end to end after that change.

**Ran.** `SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true NODE_ENV=development
AI_REASONING_FREE_MODELS=disable AI_REASONING_PAID_MODELS=enable npm run eval:simple-10k --
--phase=gate` — 25 requests, one per wave with a 1,000 ms gap, service transport, primary
`openai/gpt-oss-20b` and free start `nvidia/nemotron-3.5-lightning:free`. The run started at
08:55:10Z, finished at 08:57:45Z (155.1 s) and wrote
`server/.tmp-simple-inventory-scale-gate.json`.

**Result.** **25/25 answered and accurate (100%), 0 errors, 0 degraded**, exit 0. 20 turns were
served by the free model and 5 by the paid primary (20% paid fallback; free success 80%). Latency:
median **5,132 ms**, p95 **8,284 ms**, mean 5,235.72 ms, min 2,850 ms, max 10,647 ms. Estimated cost
**$0.003269** with complete cost reporting; the provider-reported paid-usage delta was **$0.002579**.
The free allowance moved 991 → 949 requests, so retries and the five paid fallbacks are included in
that spend. Dataset: 10,256 products, 20,539 inventory rows, 5 low-stock SKUs. The disposable seed
tenant was removed after the run.

**Not done.** This was an in-process gate against a development tenant, not the deployed Render URL,
and it did not exercise the mobile client. No mobile, OTA or provider-configuration change was made,
and nothing was committed or deployed for the run.

## 2026-11-10 — AI-99 aggregate totals stay on the paid route

**Why.** The AI-100 production audit found that "How many total units do we have?" matched the
simple/free route because the aggregate guard did not cover "total units". The free model answered
20,006 units from a 25-row page instead of the paid whole-inventory total.

**Changed.** Extended `AGGREGATE_NOUN` to cover a leading `total`, `units`, `pieces`, `pcs`,
inventory/stock units and "in total"/"of inventory|stock|merchandise". The negative lookahead keeps
named-product questions such as "How many units of the Logitech MX Master 3S are in stock?" on the
simple route. Added eight aggregate wordings and two named-product controls to
`AI99-simple-inventory-routing.test.mjs`.

**Verified.** `npm run typecheck` passed; changed-file ESLint passed; the focused suite passed
25/25; the full unit suite passed with 2,017 tests, 1,956 passed, 61 skipped, 0 failed. PR #209
passed all four required checks in run `42783935777` and squash-merged as
`87041c309ac0c94a118a28ec76c9fe9efb80ce39`. Render deploy `dep-dbpdgevavr4c73ej9djg` reached
`live`; `/api/health` reports `87041c3`, `status: ok`, `db: connected`, environment `production`
and 0 server errors. The live aggregate turn at 08:41 UTC logged `route=default`, used
`getInventorySummary`, answered **2,446,801 units**, and ran on `openai/gpt-oss-20b` with
`paid-model reasoning=enabled field=omitted source=AI_REASONING_PAID_MODELS` for `$0.001073`; no
free-model line was emitted for that turn.

**Not done.** No mobile, OTA or provider-config change was made. The 25-question gate that followed
is recorded in the entry above; it ran in-process against a disposable development tenant, not
production.

## 2026-11-10 — AI-100 free-model reasoning is a separate, observable switch

**Why.** AI-55 made `AI_REASONING` one value for the whole chain. The cost-balanced deployment
needs reasoning enabled for the paid gpt-oss models, but the simple route starts on a `:free`
fallback; inheriting the paid requirement can spend the free answer's output budget on hidden
reasoning. The operator also needs proof in Render that a free request actually disabled it. The
paid switch was renamed `AI_REASONING_PAID_MODELS` so the two controls cannot be mistaken for each
other.

**Changed.** Added `AI_REASONING_FREE_MODELS` (`enable`/`disable`) for every model id ending in
`:free`. It defaults to `disable`, takes precedence over the paid switch and the advanced rules for
those ids, and leaves paid models on `AI_REASONING_PAID_MODELS`. Tightened both reasoning switches
and `AI_WEB_SEARCH`/`AI_WEB_FETCH` to reject aliases such as `true`, `on` and `yes`; production
validation fails an invalid value. Every submitted turn logs the effective free and paid policy,
and each provider request logs the field sent (`field=disabled` for off, `field=omitted` for the
model's own default, `field=enabled` for an explicit budget) plus `source=` and `model=`. Updated
`.env.example`, README, Guides 16/17, the specification and `CLAUDE.md`.

**Verified.** `npm run typecheck` passed. The full unit suite passed: 2,016 tests, 1,955 passed,
61 intentionally skipped, 0 failed. The fallback test pins that the old name is used only when the
new name is absent, and that the new name wins when both are set. `AI99-simple-inventory-routing`
passed 24/24, including the new turn-line assertion. The request-body test confirms a free model receives
`thinking: { type: 'disabled' }` with `AI_REASONING_FREE_MODELS=disable` and no field with `enable`,
while a paid model in the same process follows `AI_REASONING_PAID_MODELS`. The old `AI_REASONING`
name remains a deprecated fallback for one release; the new name wins when both are set, and the
boot log warns while the old name is in use.

**Merged and deployed.** PR #207 passed all four required checks in run `42778340938` and squash-merged as `27873cabafdc000d64412c372d74598c25797098`; Render deploy `dep-dbpd1049v7es73bidck0` reached `live`, and `/api/health` reports `27873ca`, `status: ok`, `db: connected`, environment `production` and 0 server errors. Render's environment now
has `AI_REASONING_PAID_MODELS=enable` and `AI_REASONING_FREE_MODELS=disable`; the legacy `AI_REASONING` key remains as the one-release fallback, and the new paid key won.
**Production verification (2026-11-10).** With free reasoning OFF, a live simple turn at 08:03 UTC returned the correct 401 units on `nvidia/nemotron-3.5-lightning:free`; the turn line read `free-model reasoning=disabled source=AI_REASONING_FREE_MODELS` and both provider lines read `field=disabled ... source=AI_REASONING_FREE_MODELS` (cost `$0.000000`, `route=simple`, no escalation). After switching only the free key to `enable` (08:06 UTC boot), the same turn at 08:07 UTC returned 401 units; the provider lines read `reasoning=enabled field=omitted ... source=AI_REASONING_FREE_MODELS` and the paid key stayed `enabled`. The free key was restored to `disable` (08:09 UTC boot) and the same turn again logged `field=disabled`; a separate paid default-route turn at 08:10 UTC logged `paid-model reasoning=enabled field=omitted source=AI_REASONING_PAID_MODELS model=openai/gpt-oss-20b`, model `openai/gpt-oss-20b`, cost `$0.000465` and `route=default`. Separately, the audit found an AI-99 false positive: "How many total units do we have?" matched `route=simple` and was answered by the free model from a 25-row page, not the paid aggregate path.

## 2026-11-10 — 1.0.2 OTA card and 20-question phone matrix on the 10k tenant

**Why.** The published 1.0.2 OTA and the phone's actual assistant behavior had not been observed on
the 10k tenant.

**Verified.** The installed 1.0.2 app displayed the "Clearer stock totals and restock counts" card.
The one-conversation matrix (`6af22ae9df2d0cea08b4d596`) scored **15 PASS / 3 PARTIAL / 2 FAIL**:
18 final answers used `openai/gpt-oss-20b`, B7 and T7 used `openai/gpt-oss-120b`, and 21 attempts
include the T6 retry. B7 and T7 cited web prices but recorded only `findProducts`; B2 and E1 drifted
to Tagalog; T6 named a valid 2,499 product but misplaced its stock. Cost was **$0.043875745**; the
free allowance was **0/1000**, so every answer was paid.

**Not done.** No answer was served by the free model: the live simple turn selected it, was refused
at `0/1000`, and fell forward to a paid correct answer; the phone matrix was paid-only. A free-served
answer still awaits the reset at `2026-11-10T00:00:00Z`. No inventory record was written and no deploy
was made.

**Evidence.** [Phone matrix](evidence/paid20-2026-11-09/README.md), conversation
`6af22ae9df2d0cea08b4d596`, and OTA group `0e4eca55-0e4f-47fc-b2d6-507f91b529b8`.

---

## 2026-11-10 — 10k evidence merge deployed as 5b05307

**Why.** The evidence PR included the evaluator script under `server/scripts`, so Render auto-deployed
the merge commit even though the runtime imports no evaluator code.

**Verified.** Deploy `dep-dbp2cjt9el5s739r9o5g` is live and `/api/health` reports commit `5b05307`,
`status: ok`, `db: connected`, environment `production` and **0** server errors. The served
application code is unchanged from `8b6353a`; only the evaluator and documentation moved.

**Delivery.** PR #204 → `5b05307`. No production data migration.

---

## 2026-11-10 — 10k simple-inventory gate: 24/25, one real output-limit failure

**Why.** The AI-99 evaluator had checkpoint unit coverage but no production-scale gate record.
The owner asked for the resumable 10k gate to be run against the 10,256-product dataset and for
the result to be recorded.

**Changed.** `server/scripts/eval-simple-inventory-scale.mjs` now recognises "not present in our
inventory" as a denial in the absent-SKU check. The first gate produced that correct wording and
the older pattern scored it as a failure. The assistant route and production code are unchanged.

**Verified.** Two fresh `--phase=gate` runs created a disposable `inventoryai_dev_db` tenant
(10,256 products, 20,539 inventory rows, 20,593 transactions, seed 1), checkpointed each request
and removed the tenant afterwards. The first run (19:38 UTC) scored 24/25 with 25 paid answers,
0 errors; its only failure was the checker false negative. The corrected run (19:48 UTC) scored
**24/25**: 24 accurate, 0 free, 24 paid, 0 degraded, and **1 `AiOutputLimit`** on
`stock-SEEDSKU-0` after 23,374 ms; median 4,519.5 ms, p95 8,071 ms. The corrected check passed
`exists-absent`. OpenRouter reported **0/1000** free requests before and after both runs. The
corrected run moved provider paid usage $1.017035355 → $1.046629108 (**$0.029593753**); its
known per-row cost was $0.015825, but the failed row had no cost, so the artifact's total is
deliberately `unknown`. A pre-existing same-day 15:19 UTC artifact recorded 25/25 with **4 free /
21 paid** ($0.01413951) before the allowance reached zero; it is retained as context, not as a
fresh run.

**Not done.** No free-served request was possible in the fresh runs; the allowance resets at
`2026-11-10T00:00:00Z`. The `AiOutputLimit` is a real model reliability finding, not a parser
failure, and is not fixed here. The evaluator did not touch production data or the production
server.

**Delivery.** PR #204; evidence
[README](evidence/simple-10k-2026-11-09/README.md). Resource use: two fresh gate runs (50
requests) and **$0.029593753** provider-paid delta on the corrected run; the first run's delta
was $0.027882885.

---

## 2026-11-10 — AI-99 merged, deployed and the 1.0.2 OTA published

**Why.** The AI-99 branch had passed its local checks but existed only on the development copy;
production still served `162db9c` and the installed 1.0.2 APK had no note for the simple stock fixes.

**Changed.** PR #201 delivered the free-first simple-inventory route, deterministic stock totals and
restock counts, the bounded paid fallback and the resumable 10k evaluator. The squash merge is
`8b6353a`, and the production What's New note is "Clearer stock totals and restock counts".

**Verified.** All four required checks passed on run `42674969198` (server job 3m02s) and the PR
squash-merged. Render auto-deploy `dep-dbp16ap42hec738c5b2g` is `live`; `GET /api/health` reports
`status: ok`, `db: connected`, `environment: production`, commit `8b6353a` and **0** server errors.
`npx eas-cli update:list --branch production --limit 3 --non-interactive` shows group
`0e4eca55-0e4f-47fc-b2d6-507f91b529b8` (Android update `01a1c19d-06e8-79c9-9a46-7302c4be1c69`) as
the newest production update, published from `8b6353a`.

**Not done.** No live free or paid simple turn has been run; OpenRouter's free quota resets at
`2026-11-10T00:00:00Z`. The OTA was not installed or opened on the phone during this session, so
the new What's New card is unobserved. The 10k evaluator has not been run against live production
traffic.

**Delivery.** PR #201 → `8b6353a`; Render `dep-dbp16ap42hec738c5b2g`; OTA group
`0e4eca55-0e4f-47fc-b2d6-507f91b529b8`. Resource use: one production OTA and one final CI run.

---

## 2026-11-10 — AI-99 free-first simple inventory and resumable 10k evaluation

**Why.** Five narrow stock questions still spent the paid model even when a tool-capable free
fallback was configured, and a stalled free attempt could consume the share of the turn the paid
fallback needed. The 10k evaluator also began again at request zero after a transport fault.

**Changed.** Added the simple-inventory route in `server/src/services/ai/simpleInventory.ts` and the
budget in `simplePaidBudget.ts`. Those five shapes now start on the first tool-capable `:free`
fallback, keep the same business-scoped tools, re-ask once when a draft has no required read, and
escalate once to the paid primary on a timeout, empty completion, output limit, free-quota refusal,
or a second ungrounded draft. The server computes a single product's total only from a complete,
unambiguous read; a restock count uses the tool's own total; an explicit SKU is an exact identifier.
`AI_SIMPLE_FREE_ATTEMPT_MS`, `AI_SIMPLE_PAID_DAILY_BUDGET_USD` and
`AI_SIMPLE_PAID_TURN_RESERVE_USD` bound the route. Added `eval:simple-inventory` and
`eval:simple-10k`, with an atomic `<out>.checkpoint.json` that resumes only the same config and
dataset fingerprint. Updated the specification, README, Guides 6 and 16, `CLAUDE.md`, and the
production What's New note.

**Verified.** The AI-99 suites pass 28/28 (routing, totals, budget, checkpoint); the server unit
suite passes **2,008 tests: 1,947 pass, 0 fail, 61 skipped**; the isolated AI-12 empty-completion
route test passes against the test database; the docs guard and its 27 tests pass; mobile
typecheck, lint and 1,205 tests pass; scoped server lint passes over `src`, `scripts` and `test`.
The AI-18 paged-return guard caught the new exact-SKU `getInventory` path and was updated to
count it. The full suite was stopped after the shared test database repeatedly dropped; the
required `server` CI job will run it on the branch.

**Not done.** No live free or paid simple turn has been run: the OpenRouter free quota resets at
`2026-11-10T00:00:00Z`. Merge, Render verification and the production OTA are still pending.

**Delivery.** Branch `feat/ai-99-simple-inventory`; no pull request has been opened at the time of
this entry.

---

## 2026-11-09 — Production 10k sync, assistant cleanups, and OTA

**Why.** Development and production disagreed about the seeded catalogue and the assistant's grounded
answers. The production tenant needed a realistic multi-category account, matching Android artifacts,
and acceptance in one conversation rather than separate resets.

**Changed.** PR #193 merged AI-91/AI-92 exact identity and per-location answers. PR #196 kept the stock
total with the highest-value item, held ordinary comparisons on 20B, and added 24 cross-category seed
products; #197 normalised Unicode SKU punctuation and re-asked unsourced web URLs; #198 carried the
winning SKU into value answers, repaired malformed restock counts, and replaced the best-selling
fragment with an explicit no-sales-ranking answer; #199 removed a residual leading list marker and
normalised emitted SKU hyphens. A new What's New note announces the copyable details, and
`ota-native-runtime.json` records both 1.0.2 builds.

**Verified.** All four required checks passed on PRs #193 and #196–#199. Production tenant
`6af18628a9a409131a84235b` holds 10,000 products, 2,446,801 units, 1,535 low, 632 out, and value
46,922,439,210; the phone dashboard and API agree. `GET /api/health` at `162db9c` returns
`ok`/`connected`. In conversation `6af18cfa639a932cb2b678b0`, value used 20B/`getStockValue` and
returned SKU `SEEDSKU-344`; best-selling used 20B/`getInventoryHistory` and refused a ranking; restock
used 20B/`getReorderNeededProducts` and returned `1,535` with `SEEDSKU-9992`–`9979`; research used
120B/`findProducts` and cited three pages that were fetched and found relevant. The installed APK is
versionName 1.0.2 / versionCode 10; development `76440404` and production-apk `820251b4` share
fingerprint `f5a6fdde…`. OTA `58ab8e76` was published from `162db9c`; after two cold starts the
dashboard shows "Cleaner details you can copy".

**Not done.** The development APK was built and its metadata/fingerprint compared, but it was not
installed because doing so would replace the production install used for OTA acceptance. Render
environment values remain unreadable through CLI v2.28.0; no Render configuration was changed. A
genuine 120B outage remains unobserved.

**Delivery.** PRs #193 and #196–#199; final production commit `162db9c`; OTA group
`58ab8e76-0b18-4e73-8822-7766e6dad7e3`. Resource use: two Android builds and one production OTA.

---

## 2026-11-09 — Documentation audit: living references reconciled with the tree

**Why.** A repository-wide review compared every living guide and reference with the current code,
package manifests, environment templates, dependency alerts and production health. Several statements
had survived a feature change, and two living documents contradicted the auth and security records.

**Changed.** `mobile/AGENTS.md` now points at Expo SDK 58; `mobile/.env.example` no longer claims the
retired `com.inventoryai.app` scheme is still configured; `CLAUDE.md` corrects the source/runtime
distinction, lists all 19 read-only AI tools, records the deployed AI-87/AI-88 work and the pending
AI-91/AI-92 branch, and closes L-17 to match the auth records; `SYSTEM_SPECIFICATION.md` lists the
current tools and removes the stale SDK 57 config-plugin gate; `SECURITY.md` names the live glob and
deepmerge advisories; `SECURITY_DEPENDENCY_DECISIONS.md` records the 2026-11-09 re-measurement and the
current production commit; `ACCOUNT_MIGRATION_RUNBOOK.md` records production `04eb92c`; `README.md`
points current status at this log; `PHASE_HISTORY.md` and Guide 4 now carry the complete assistant and
demo-fixture history; and the guides index again distinguishes the roadmap record from the CLAUDE
working contract.

**Verified.** `node scripts/check-docs.mjs`: **30** active documents, **30** invariant rows, **30**
register rows and **11** living references within cadence. The four documentation test files:
**27/27 pass**. `git diff --check` clean. `npm audit`: server `{low:0, moderate:5, high:0,
critical:0, total:5}`; mobile `{low:1, moderate:26, high:0, critical:0, total:27}`. `GET
/api/health`: `status: ok`, `db: connected`, environment `production`, commit `04eb92c`, **0** server
errors.

**Not done.** No application behaviour, code, dependency, deployment, EAS build, OTA or phone run was
changed or performed. This entry records a documentation audit; the AI-91/AI-92 branch remains
unmerged and unverified on a phone.

**Delivery.** Branch `docs/seeding-fixture`, PR #193; the new head requires the four required checks.

---

## 2026-11-09 — AI-91/AI-92 exact identity and location answers; seeding docs aligned

**Why.** The 2026-11-08 phone matrix still exposed exact-product false negatives, category aliasing,
a lost numeric suffix, and unverified web answers. Follow-up phone observations on 2026-11-09 also
showed a top stock-out name and single-product location quantities drifting from the recorded rows.

**Changed.** The assistant now derives exact product identity and per-location quantities from tool
rows; `findProducts` has an exact name/SKU/barcode fallback; category lookup treats `and` and `&` as
equivalent; out-of-stock reads are ACTIVE-only; paged lists state when partial; stock value is grouped
by recorded currency; and an unsourced research answer is re-asked or refused instead of presenting
an unread price, review or URL. The seeding guides and seeder headers were aligned in the same branch.

**Verified.** `npm run test:unit`: **1,967 tests, 1,906 pass, 0 fail, 61 skipped**. `npm run typecheck`
and `npm run lint` exit 0. Documentation tests: **11/11**. `git diff --check` is clean. No production
seed, verification or cleanup command was executed.

**Not done.** No phone run, EAS build, OTA or Render deployment has exercised this branch. The next
phone matrix must re-check B4, T4, T6, B7, T7 and the AI-91/AI-92 cases after merge.

**Delivery.** Branch `docs/seeding-fixture`, PR #193. Counts are from the local unit suite; the PR
records the required-check status for the final head.

---

## 2026-11-08 — Streamed turns keep their provider cost; phone turn logs $0.000567

**Why.** Streamed phone turns logged `cost=unknown` even when the provider reported a charge,
while the non-streamed path logged the same provider's charge exactly. The provider sends the
cost on the final streamed event; the wire kept only earlier events that omitted it. The same
deployment also carried native citation extraction and the appended `Source URLs:` list.

**Delivery.** PR #190 merged as `04eb92cf3d56dbde36618d532fcfd24040b3dd18`; all four required
checks passed on run `42480189959`. Render deploy `dep-dbo6m2ks728c739rl40g` reached `live` at
`2026-11-08T12:29:57Z`. `GET /api/health` answers **200** with commit `04eb92c`, `status: ok`,
`db: connected` and `environment: production`; `/api/health/ready` reports `ready`.

**Fix.** The latest reported `costUsd` now wins, an event that omits it no longer erases an earlier
value, and the assembled response re-emits `cost` so the turn line can record it. Native
`web_search_tool_result` and `web_fetch_tool_result` blocks, text-block citations,
`citations_delta` and annotations are retained; the turn appends any omitted source URL once as a
Markdown-autolink list.

**Phone evidence.** At `2026-11-08T12:36:58Z` the installed app on the CPH1969, connected over USB,
sent “Which products are low on stock?” as a streamed request. It reached the answered state at
23 s with the correct low-stock list. The deployed log at `12:37:06` records:

```text
[ai] turn outcome=ok total=7194ms providerMs=6966ms calls=2 toolMs=222ms toolRuns=1 tools=getLowStockProducts empty=0 failovers=0 quota=unknown in=20337 out=327 cost=$0.000567 web=none model=openai/gpt-oss-20b iterations=2
```

This is the first post-fix streamed **phone** turn with an exact provider cost. The two earlier
phone turns from 2026-11-08 remain recorded as `cost=unknown`; they ran before this fix and are not
retroactively changed.

**What it proves, and what it does not.** It proves the deployed streamed path now carries the
provider's charge through to the turn log on a real phone turn, and that ordinary routing still
uses `openai/gpt-oss-20b` with `failovers=0`. The answer used no web tool (`web=none`), so it does
not verify native citations or the appended source list on the phone. A phone-rendered fallback
answer and a genuine upstream 120B outage remain unobserved.

**Checks before merge.** Server `npm run typecheck`, `npm run lint` and `npm run test:unit`
(**1,953 tests, 1,892 pass, 61 skipped, 0 fail**); mobile `npm run typecheck`, `npm run lint` and
`npm test -- --runInBand` (**101 suites / 1,205 tests**); `node scripts/check-docs.mjs`;
`git diff --check`. No EAS build or OTA was spent.

---

## 2026-11-08 — AI-88: controlled 120B → 20B failover drill executed in production

**Why.** AI-87's fallback was covered by the unit suite, and both live turns logged `failovers=0`,
so nothing showed the DEPLOYED failover path working. Waiting for a real upstream failure is not a
plan, and temporarily changing Render's research model would put ordinary traffic at risk and need
a revert nobody would verify.

**Delivery.** PR #187 merged as `c98d68851c35a85eedd55daf7eb86cb468cec59e`; all four required
checks passed on run `42451318595`; Render auto-deployed it and `GET /api/health` reports commit
`c98d688`, `status: ok`, `db: connected`, `environment: production`, **0** server errors.

**The drill.** `POST /api/ai/chat` with `x-ai-failover-drill: research` makes the research model
fail once, on purpose, before any provider request is built. It is OWNER-only; it requires
`AI_PROVIDER=openrouter` with `AI_RESEARCH_MODEL_OPENROUTER` different from
`AI_MODEL_OPENROUTER`; it accepts only a research question; and the simulated failure is skipped by
the model breaker, so the real 120B's health is untouched. `npm run drill:ai-failover` sends it,
requires `AI_DRILL_CONFIRM=ai-failover:production` for a non-loopback base, and reads
`AI_ACCESS_TOKEN` without printing it. Guide 16 §9 documents the header, script and expected lines.

**Executed drill.** One request, using a short-lived session for the existing OWNER comparison
fixture; the session was revoked with `POST /api/auth/logout` (200). No password, credential or
Render environment variable changed.

| Check | Evidence |
| --- | --- |
| HTTP result | `201` in 28,214 ms; `openai/gpt-oss-20b` answered; tool `findProducts` |
| Simulated failure | `[ai] failover drill: simulated HTTP 503 from openai/gpt-oss-120b; no provider request` |
| Real failover | `[ai] failover attempt=1 model=openai/gpt-oss-120b -> openai/gpt-oss-20b reason=HTTP 503 remaining=59999ms` |
| Turn line | `outcome=ok … calls=3 … failovers=1 … cost=$0.016796 web=search,fetch model=openai/gpt-oss-20b iterations=3` |
| Breaker | No `model cooling down` line; the suite proves one drill failure cannot cool a model at threshold 1 |

The drill attempt never reached OpenRouter, so `calls=3` counts the real 20B rounds (a tool round
and a re-ask), not the simulated attempt. The **$0.016796** is a real 20B turn with native search
and fetch, not a 120B call.

**What this proves.** The deployed research turn starts on `openai/gpt-oss-120b`; the model-level
failover path is the code that actually answered; and the fallback really served the turn, tools and
web research included. **What it does not prove.** The failure was synthesised inside the server, so
a genuine OpenRouter 120B outage, a revoked key or a withdrawn model remains a separate question.
A drill requested when the research model is already cooling or reported unavailable logs that it
could not fire instead of passing silently.

**Suite.** `npm run typecheck`, `npm run lint`,
`node --test test/phase-openrouter-provider.test.mjs` (**59/59**), `node scripts/check-docs.mjs` and
`git diff --check` all pass. The new cases prove the drill sends the research model nothing, the 20B
answers with `failovers=1 calls=1`, the breaker stays closed at threshold 1, an ordinary turn is
unaffected, and the route refuses a STAFF member (`403 AI_DRILL_FORBIDDEN`), a non-research message
(`400 AI_DRILL_REQUIRES_RESEARCH`) and an unknown drill name (`400 AI_DRILL_UNKNOWN`).

**Not done.** A phone-rendered fallback answer: on 2026-11-08 the phone ran the ordinary and research
prompts (20B, `failovers=0`, 6,583 ms; 120B with native search, `failovers=0`, 11,681 ms) and both
answers rendered, but neither turn needed the fallback. This entry proves the server's failover route,
not the mobile client's rendering of a fallback answer. The OWNER-only header is not exposed in the
app, by design.

---

## 2026-11-08 — AI-87: 20B ordinary / 120B research routing deployed and measured

**Why.** AI-87 keeps `openai/gpt-oss-20b` as the default for ordinary inventory work and
starts with `openai/gpt-oss-120b` only when the message asks for research-heavy work
(comparisons, market pricing, reviews, recommendations, explicit web research or a URL).
The research chain is `[120b, 20b, ...fallbacks]`; a research success never promotes 120B
into the persistent default slot. Native OpenRouter search/fetch remains primary when both
switches are enabled, and every turn logs the provider-reported cost.

**Delivery.** PR #185 merged as `47353af99c61e6cc25049bebc9fc6383f77308b4`. All four required
checks passed on run `42448637562`. Render auto-deploy `dep-dbo028ks728c739m8d20` reached
`live`; `/api/health` reports commit `47353af`, `status: ok`, `db: connected`,
`environment: production`, and **0** server errors. Startup logs show the ordinary chain
`openai/gpt-oss-20b -> nvidia/nemotron-3.5-lightning:free` and web tools
`enabled: search, fetch`.

**Live turns.** Two authenticated turns were sent through the deployed `POST /api/ai/chat`
route using an existing active comparison fixture; its short-lived session was revoked with
`POST /api/auth/logout`. No password or credential was changed. The fixture has no products,
so the ordinary question verifies model routing and tool use rather than inventory figures.

| Turn | Result | Model | Tools | Calls | Cost | Web | Failovers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ordinary: "How many products do I have, and how many are low stock?" | `201`, 6,699 ms | `openai/gpt-oss-20b` | `getInventorySummary`, `getCatalogOverview` | 3 | `$0.001749` | `none` | 0 |
| Research: "Search the web for current reviews of the Sony WH-1000XM5 and Bose QuietComfort Ultra, compare them, and recommend one." | `201`, 18,128 ms | `openai/gpt-oss-120b` | `findProducts` | 2 | `$0.008803` | `search` | 0 |

The ordinary turn logged `web tools enabled=search,fetch offered=none used=none
intent=inventory`; the research turn logged `offered=search,fetch used=search intent=web`.
Both turn lines carried `quota=unknown`, because the provider did not report remaining
allowance. The two exact turn costs sum to **$0.010552**.

**Fallback.** Both live turns logged `failovers=0`; neither needed a fallback, so this evidence
shows the field and the successful route but does **not** prove a live failover. The research
chain's `[120b, 20b, ...]` order, the 120B-to-20B fallback, the non-promotion rule, and the
native-tool refusal path are covered by the passing unit suite (**1,946 tests, 1,885 pass,
61 skipped, 0 fail**). A live failover drill would require an upstream failure or a temporary
production model change; it was not induced.

**Not done.** No phone observation. The research turn used native search but did not request
a page fetch, and the fixture's empty catalogue means the ordinary answer's inventory figures
were not checked against a populated tenant. No credentials were changed; the only writes
were the two verification conversations, one session and its audit rows, and that session was
revoked.

---

## 2026-11-08 — AI-86: native web tools are the primary research path

**Why.** AI-85 made the two OpenRouter server tools configurable, but the assistant still
reached for the local `researchInventoryProducts` / `researchMarketPrices` implementations
even when both native capabilities were enabled. The local path is slower, can spend the
research budget on its own search ladder, and duplicates capability the gateway already
provides.

**Changed.** `aiConfig.nativeWebPrimary` is true only for an OpenRouter deployment with
both switches enabled. In that mode the turn loop withholds the two local research tools,
adds prompt rule 39 (which supersedes rules 21, 23 and 35), and passes `nativeWeb: true` so
the wire sends `openrouter:web_search` and `openrouter:web_fetch`. The provider reports the
native tools it actually ran via content blocks or usage, and the turn treats that as a
real research read. A research answer with no native read is re-asked once for the native
tools; a second failure switches that turn to the local tools. An HTTP 400/403 refusal
falls back immediately. The provider also withholds native tools on a fallback turn. The
turn line now carries `web=...`, and no query, URL or page content is logged.

**Verified.** Typecheck and lint exit 0. Full unit suite: **1,939 tests, 1,878 pass, 61
skipped, 0 fail**. The OpenRouter unit suite: **49 tests, 48 pass, 1 skipped**. The
DB-backed provider suite also passes. Tests cover native-primary tool selection, the
blocked local-tool call, provider refusal fallback, usage-detail parsing, and prompt rule
39. No live OpenRouter search or fetch was made.

**Not done.** The change is uncommitted locally; no push or deployment. Production is
still on `f376ad5` until the branch is delivered.

## 2026-11-08 — AI-86: paid web tools are offered only for research intent

**Why.** AI-85 made the two OpenRouter server tools configurable, but an enabled switch was
attached to every tool-capable round. OpenRouter's server tools are model-invoked rather than
automatic, yet a model could still choose to search for a plain inventory question, and each
search costs about $0.007 and each fetched page about $0.001.

**Changed.** `asksForWebResearch` in `webCapabilities.ts` is a conservative gate over the
member's message: explicit web work, product reviews, quality or reliability, online or
marketplace prices, product recommendations, current news, or a named URL. Stock, movements,
locations, catalogue fields, recorded selling prices and “review my stock” do not pass.
`runAiChat` computes the intent once and sends it with every provider request; the Anthropic
wire withholds both server tools when it is false, so a failover request inherits the same
decision. That one boolean now also drives the existing extra-iteration budget and the
research-without-a-read re-ask, so the two rules cannot disagree. Each definition carries a
hard per-request cap: search `max_uses: 2` and `max_total_results: 10`; fetch `max_uses: 2`
and `max_content_tokens: 30000`. System prompt rule 36 keeps public research separate from
inventory facts and prefers the local research tools. Guide 17 documents the gate, the caps
and how to read the log.

**Verified.** Typecheck and lint exit 0. Full unit suite: **1,923 tests, 1,862 pass, 61
skipped, 0 fail**. The OpenRouter stub suite (45 tests, 44 pass, 1 skipped) proves both sides
end to end through `runAiChat`: with both switches on, a stock question carries no
`openrouter:*` tool on any request and logs `offered=none used=none intent=inventory`, while
a review question offers both tools. The wire suite also proves the caps, the per-request
log, and that no query, URL or page content reaches that log.

**Not done.** No live OpenRouter search or fetch was made. The change is uncommitted on
`main`; delivery needs a pull request because the branch is protected.

## 2026-11-08 — AI-85: OpenRouter web search and fetch are independent switches

**Why.** The assistant already had product and price research tools, but no operator-level
control over OpenRouter's built-in web tools. A deployment that wanted general web search or
page fetching had no `.env` switch, and enabling either for one model would have been a source
change.

**Changed.** `AI_WEB_SEARCH` and `AI_WEB_FETCH` accept `enable` or `disable` independently.
Both default to disabled; an invalid value also stays disabled and is reported. Enabled tools
are sent as OpenRouter server tools (`openrouter:web_search` / `openrouter:web_fetch`) in the
same `tools` array as the assistant's client tools. They are added only on tool-capable rounds,
so the AI-50 final answer round remains tool-free. The same switches travel with every fallback
model, while `AI_REASONING` still resolves per model. `npm run ai:check` prints the effective
state, and Guide 17 documents the two variables, copy-ready examples and verification.

**Verified.** Typecheck and lint exit 0. Full unit suite: **1,915 tests, 1,854 pass, 61
skipped, 0 fail**. The OpenRouter stub suite proves disabled tools are omitted, each switch
works alone, both coexist with `thinking: disabled`, a fallback request keeps the tools and its
own reasoning rule, an invalid value is rejected by production config, and a no-tools answer
round carries neither server tool. `check-docs`, `check-secrets` and `git diff --check` exit 0.

**Not done.** No live OpenRouter web-tool request was made; that would spend provider credits
and is left for the operator's verification. The full database-backed suite was not run because
this change is request construction, not data access.

## 2026-11-07 — AI-55: reasoning follows the model, with a simple switch

**Why.** AI-54 disabled reasoning globally. Models that require it, such as
`openai/gpt-oss-*`, then failed every turn with HTTP 400. One global value cannot
serve both mandatory-reasoning and free-chain models.

**Changed.** `AI_REASONING=enable` omits the reasoning field and lets the model use
its own default (required by `openai/gpt-oss-*`); `disable` sends
`thinking: { type: 'disabled' }` (the free-chain behaviour). It deliberately
overrides the advanced `AI_REASONING_DEFAULT` and
`AI_REASONING_MODELS_OPENROUTER` rules, which remain for deployments that need a
policy per model; `AI_THINKING_DISABLED=false` still means `auto` when the new
default is unset. The probe sends the same setting as the turn, and an invalid
`AI_REASONING` fails `npm run ai:check` with the accepted values. Guide 16 and the
README config table document the two-variable switch.

**Verified.** Typecheck and lint exit 0. Targeted reasoning tests: 15 tests,
15 pass, 0 skipped, 0 fail. Full unit suite: 1,908 tests, 1,847 pass, 61 skipped,
0 fail. `check-docs` and `check-secrets` exit 0; `git diff --check` clean.

**State.** Branch `fix/ai-55-per-model-reasoning`; PR #180. The separate
environment-template cleanup remains outside this branch.
## 2026-11-07 — Firebase credential rotated; production sign-in restored

| Item | Evidence |
| --- | --- |
| **Why** | Every real sign-in had returned `503 FIREBASE_UNAVAILABLE` since the deployed service-account key stopped being accepted by Google. |
| **Done** | New key `781cada95e09cfd634a6aaf754d8b879b692257e` written to `server/.env` and Render; `npm run verify:firebase` returned `VERIFIED`; the old key `3fd33d78d26453dd32ad96f45325fd6b9aca3174` was deleted in the Google Cloud console. |
| **Verified** | `/api/health` 200, `status: ok`, `db: connected`, commit `37c42e3`; new sessions at 13:06:29Z, 13:07:33Z, 13:09:49Z and **13:15:03Z (unrevoked, Android · CPH1969)**, the last created after the old key was deleted; `SESSION_CREATED` 13:15:03.685Z. PR #179 passed all four required checks on its first head. |
| **Limit** | The IAM API is disabled on the project, so the key inventory could only be checked in the console; after the `.env` backups were deleted there was no local copy of the old key to test rejection. The `aaa.bbb.ccc` probe answers 503 because it fails token parsing before the credential is used — it is not a credential test, and it produced the single server error at 13:09:13. |
| **Not done** | The Render access review (measure 1) still needs the owner's plan and member list. No other Render setting was changed. |
| **Delivery** | Branch `docs/firebase-credential-runbook`, PR #179. |

---

## 2026-11-07 — Firebase credential checker and runbook added; rotation awaiting a new key

| Item | Evidence |
| --- | --- |
| **Why** | Production sign-in returned `503 FIREBASE_UNAVAILABLE` for real users on 2026-11-07 while `/api/health` stayed green. The configured service-account key parses but Google rejects it (`400 invalid_grant: Invalid JWT Signature`), and nothing asked Google before a user did. |
| **Added** | `server/scripts/verify-firebase-credential.mjs` (`npm run verify:firebase`) signs its own RS256 assertion and makes one request to the token endpoint. Exit `0` verified, `1` rejected, `2` not verified — so "could not check" cannot read as "fine". |
| **Docs** | `docs/FIREBASE_CREDENTIAL_RUNBOOK.md` covers where each value comes from, the minified-JSON write, the Render steps, the rotation order, failure meanings and the security rules. The map links it with a 90-day cadence. |
| **Verified** | Against the current `server/.env` the checker printed `400 invalid_grant: Invalid JWT Signature` and exited 1, naming the outage without a user. `check-docs` exit 0 (28 active documents, 11 within cadence); `secret-guard` exit 0 (22/22 controls, no credential-shaped content); ESLint clean on the new script; `git diff --check` clean. |
| **Not done** | Production is **not** fixed. The credential has not been replaced, Render has not been touched, and no key has been deleted. Rotation waits on the owner creating a new Google Cloud key. |
| **Delivery** | Branch `docs/firebase-credential-runbook`. |

---

## 2026-11-07 — Firebase reset template and authorized domains verified; L-17 closed

| Item | Evidence |
| --- | --- |
| **Why** | The Firebase console settings were still listed as an open recovery gate after AUTH-06 replaced Firebase's reset link with a Brevo six-digit code. |
| **Verified** | The Firebase Admin API (`GET /admin/v2/projects/inventoryai-d0d20/config`) returned authorized domains `localhost`, `inventoryai-d0d20.firebaseapp.com`, `inventoryai-d0d20.web.app` and `ai-inventory-l1mi.onrender.com`. The Password Reset template is Firebase's default with callback `https://inventoryai-d0d20.firebaseapp.com/__/auth/action`; no custom action URL is set. |
| **Active path** | Mobile `forgot-password` calls `POST /api/auth/password-reset/code`, then `/verify`, then `/confirm`; the server sends its own six-digit template through Brevo. `sendPasswordResetEmail` is absent from the mobile Firebase boundary. |
| **Decision** | L-17 is **closed as not applicable**, not as a fixed Firebase template. The authorized domains are verified and unchanged. If the Firebase link path is reintroduced, L-17 reopens. |
| **Docs** | The checklist, authentication architecture, security policy and this log now agree. |
| **Not done** | No Firebase console write, code change, deployment, or new reset email was made. This is configuration verification; it does not claim the unused Firebase template was repaired. |

---

## 2026-11-07 — scheduled TypeScript 7 readiness watch added

| Item | Evidence |
| --- | --- |
| **Why** | TypeScript 7 readiness was a manual, deferred check, with issue #32 as the ledger. A weekly read-only check turns the upstream condition into one actionable issue without a false green from a parser that admits only one workspace. |
| **Added** | `.github/workflows/typescript-7-watch.yml` runs Monday **06:17 UTC** and on `workflow_dispatch`, only on `main`. It installs the server and mobile trees, runs `check-upgrade-watches`, and opens one issue only when the gate is `READY`, a workspace is below TypeScript 7, and no open issue has the exact title. It fails on `UNREADABLE`, `UNPARSED`, or a missing TypeScript row. |
| **Guard** | The job has `contents: read` and `issues: write` only. It does not upgrade TypeScript, change a lockfile, deploy, or spend an EAS build. Installing `mobile/` is required because the gate reads the SDK-pinned parser chain. |
| **Verified** | Watch self-tests **32/32**; the live row is **DEFERRED** with server and mobile parsers at `8.72.1` (peer `>=4.8.4 <6.1.0`); the extracted gate matrix (`DEFERRED`, `READY` with TypeScript 6 and 7, `UNREADABLE`, missing row) and stubbed `gh` issue creation/deduplication passed; `node scripts/check-docs.mjs` and `git diff --check` are clean. |
| **Delivery** | PR #177. The schedule becomes active only after merge to `main`. |
| **Not done** | No TypeScript 7 upgrade; issue #32 remains open. No EAS build or OTA was spent. |

---

## 2026-11-07 — minimatch fixed by reviewed override; alerts #18/#19 closed

| Item | Evidence |
| --- | --- |
| **Why** | The owner directed a full resolution of the remaining dependency and documentation state. The two tested override PRs were the only path to the patched minimatch release; D-10 was amended by D-13 rather than silently ignored. |
| **Merge** | #173 (mobile) rebased to `e7cc2d3`, passed all four checks in run `42355968583`, and squash-merged as `0eca990`. #174 (server) rebased to `608d811`, passed all four checks in run `42356272906`, and squash-merged as `8fe6403`. |
| **Deploy** | Render deployed `8fe6403` because `server/` changed. `/api/health` returns 200, `status: ok`, `db: connected`, `environment: production`, commit `8fe6403`, and **0** server errors. |
| **Alerts** | Minimatch alerts #18/#19 are closed. The remaining alerts are `glob` #14/#16 and `deepmerge` #13; both stay under D-10/D-4. |
| **Docs** | `SECURITY_DEPENDENCY_DECISIONS.md` now records the post-merge audit, D-13 and evidence rows 25–27; `CLAUDE.md` and the runbook production anchor are updated; this entry supersedes the draft-PR entry below. |
| **Not done** | No EAS build or OTA was spent. Phone verification of the AI behavior and the 60 s research-budget check remain; the new major upgrade is still to be planned. |

---

## 2026-11-07 — minimatch update triaged into green draft PRs; D-10 decision pending

| Item | Evidence |
| --- | --- |
| **Why** | Dependabot's minimatch security-update jobs for `/server` and `/mobile` failed without creating branches (for example runs `42347428202` and `42347426123`). The updater logged `security_update_not_possible`: the patched floor is `11.0.1`, every consumer declares `^3` or `^10`, and on mobile the only computed path downgraded Expo `58.0.22` to `52.0.49`. |
| **PRs** | [#173](https://github.com/nreffejzxc/inventory-ai/pull/173) (mobile, `ca97a96`) and [#174](https://github.com/nreffejzxc/inventory-ai/pull/174) (server, `2b269bf`) add a workspace `overrides.minimatch` of `^11.0.1`; each branch lock resolves one `minimatch@11.0.5`. Both are drafts, based on `36d70db`, and not merged. |
| **Checks** | Local mobile: typecheck, lint and **101 suites / 1,203 tests** pass; branch audit has no minimatch finding. Local server: typecheck and lint pass; branch audit has no minimatch finding, but the 167-file full suite was stopped after exceeding the local run window. CI: runs `42354522923` and `42354554146` pass all four required checks; the server job ran the full suite and boot smoke, and the mobile job ran `expo export`. |
| **Docs** | `SECURITY_DEPENDENCY_DECISIONS.md` adds D-12 and branch evidence rows 23–24; this entry and Current position record the drafts. No dependency, lockfile, runtime or provider state changed on `main`. |
| **Not done** | Not merged. D-10 remains in force; alerts #18/#19 stay open. No Render deploy, EAS build or OTA was spent. |

---

## 2026-11-07 — Invariant-register guard restored to the server suite (#166)

| Item | Evidence |
| --- | --- |
| **Why** | The owner asked to reopen and merge #166, reversing the earlier superseded closure. The root `check-docs` guard remains the docs-only gate; this adds the same single-register rule to `npm run test:unit` and `npm test`. |
| **Rebase** | #166 was closed on 2026-11-07T07:28:53Z with its branch deleted. The head was restored from `refs/pull/166/head`, replayed onto `783daf3` as `03a7418bbd3e5ed69ca4d0384c72ce768e90d1f4`, and force-pushed with lease after the PR was reopened. |
| **Checks** | Run `42352706388` on `03a7418`: `server` pass (2m42s), `mobile` pass (1m24s), `secret-guard` pass (7s), `attribution-guard` pass (8s). Local: the new guard file passes **4/4**, ESLint clean, docs guard exit 0. |
| **Merge** | Squash-merged at `2026-11-07T07:49:57Z` as `ebafae31d77f7931a05ed0ba7e15b367eacb48d1`. |
| **Deploy** | Render redeployed because `server/` changed. `GET /api/health` returned 200 with `status: ok`, `db: connected`, `environment: production`, commit `ebafae3`, and **0** server errors. The runtime is unchanged. |
| **Docs** | The runbook Production row moved from `c99760d` to `ebafae3`; Current position names the merge. Earlier entries were not rewritten; this entry supersedes the #165 rationale only as to the server-suite copy. |
| **Not done** | No dependency, provider, mobile build, OTA or application-code change. Phone verification of the AI behavior and the 60 s research-budget check remain open. |

---

## 2026-11-07 — Dependabot #132 closed as superseded by #162

| Item | Evidence |
| --- | --- |
| **Why** | The 2026-11-06 entries still said Dependabot #132 "remains green but behind" and that #162 "remains open". Both statements are now stale. |
| **#132** | `build(deps): bump the server-minor-and-patch group in /server with 2 updates` — state **CLOSED**, closed at `2026-11-06T21:18:19Z`, `mergedAt: null`, head `a4813f5`. It was not rebased or merged. |
| **Replacement** | #162 (`chore(deps): bump the server-minor-and-patch group across 1 directory with 4 updates`) merged at `2026-11-07T06:31:42Z` as `e18264ec95cdf5c0e41230eff976a0122a9bf4c3`. It is the refreshed group that supersedes #132. |
| **Recorded** | This entry is additive; the 2026-11-06 entries were not rewritten. No dependency, lockfile, runtime, deploy or pull-request state changed. |

---

## 2026-11-07 — Dependency record re-measured under the new cadence

| Item | Evidence |
| --- | --- |
| **Why** | The first review under the living-reference cadence checked every open advisory against the current trees and the published consumer ranges. |
| **Measured** | `server/` **15** entries, 2 advisories (0 high); `mobile/` **35** entries, 3 advisories (0 high, 1 low) — unchanged. `glob@14.0.4` and `minimatch@11.0.5` are the newest patches, but no installed consumer admits them. `rimraf@6.1.4` now declares `glob ^14.0.3`, yet `google-gax@5.0.8` and `gaxios@7.1.3` still declare `rimraf ^5.0.1`; `@google-cloud/firestore@9.4.0` still declares `firestore-api ^0.2.0`, which cannot reach the latest `0.7.1` (`google-gax ^6`). |
| **Updated** | `SECURITY_DEPENDENCY_DECISIONS.md`: gate 6 now requires a widening parent to be admitted by the installed chain, gate 7 names the current minimatch ranges, and evidence row 22 records the registry measurement. The review date remains 2026-11-07, the adoption date. |
| **Not done** | No dependency, lockfile, runtime, mobile build, OTA or deploy change. D-10 remains accepted; no override and no `npm audit fix`. |

---

## 2026-11-07 — Review-cadence guard and rate-limit reset test merged

| Item | Evidence |
| --- | --- |
| **Why** | Two guard gaps: the ten living reference documents had no review clock, and no test proved `skipSuccessfulRequests` survives a rate-limit window reset on the bucket a success cannot clear. |
| **Added** | `scripts/check-docs.mjs` parses the `### Review cadence` table in `docs/README.md` §2 and fails on a missing, duplicate, malformed or overdue row; nine documents use a 90-day cadence and `SECURITY_DEPENDENCY_DECISIONS.md` uses 30 days, with every clock starting at the 2026-11-07 adoption date. The auth suite adds a DB-backed window-reset test on the per-IP bucket. |
| **Merge** | PR #168 head `d901a2a28216fd69655e63fd33a52859b0fc713a` passed all four required checks in run `42350783903` (`server` 2m13s, `mobile` 1m40s, `secret-guard` 9s, `attribution-guard` 9s), then squash-merged at `2026-11-07T07:22:01Z` as `c99760d5bee9fe1ef0a60da59ff2f461e9bf4f6f`. |
| **Deploy** | Render redeployed because `server/test/` changed. `GET /api/health` returned 200 with `status: ok`, `db: connected`, `environment: production`, commit `c99760d`, and **0** server errors. The runtime is unchanged. |
| **Docs** | The runbook Production row moved from `e18264e` to `c99760d`; the log's Current position names the merge and its verification. The earlier entries were not rewritten. |
| **Not done** | No runtime, dependency, provider, mobile build or OTA change. Phone verification of the AI behavior and the 60 s research-budget check remain open. |

---

## 2026-11-07 — PR #165 merge commit and final CI run recorded

| Item | Evidence |
| --- | --- |
| **Why** | The PR #165 entry records the code-commit run `42345889077` but not the squash-merge commit or the final head's CI run, so the delivery was only half-linked to its evidence. |
| **Merge** | PR #165 (`docs: make the documentation map a checked workflow`) was squash-merged at `2026-11-07T06:17:42Z` as `d31362009dda17f598ffa018c818aad4900214d1`. Its final head was `5941956bf47b27a777c1fb601bfa4f3c17994fe9`. |
| **Final CI** | Run [`42346155717`](https://github.com/nreffejzxc/inventory-ai/actions/runs/42346155717), event `pull_request`, completed **success** on `5941956`: `server` pass (2m27s), `mobile` pass (1m14s), `secret-guard` pass (8s), `attribution-guard` pass (9s). |
| **Recorded** | This entry is additive; the earlier #165 entry and its `0f8472a`/`42345889077` evidence were not rewritten. Current position now names the merge commit and final run. |
| **Not done** | No code, runtime, dependency, provider, mobile or deployment change. The docs-only merge does not trigger Render. |

---

## 2026-11-07 — Production anchor corrected after the dependency merge

| Item | Evidence |
| --- | --- |
| **Why** | PR #162 merged after the runbook and the log's Current position were written; both still named `98a4282` while production had moved to `e18264e`. |
| **Merge** | PR #162 was rebased onto `d313620`; its head `a5babbe` passed all four required checks; squash-merged as `e18264ec95cdf5c0e41230eff976a0122a9bf4c3` at 2026-11-07T06:31:42Z. |
| **Deploy** | Render deployed the merge. `GET /api/health` returned 200 with `status: ok`, `db: connected`, `environment: production`, commit `e18264e`, and no 5xx/server errors. |
| **Docs** | The runbook Production row and the log's Current position/Just verified now name `e18264e`; historical entries were not rewritten. |
| **Not done** | No account, credential, access, history, mobile build or OTA change. |

---

## 2026-11-07 — Documentation map, guard and close-out workflow

| Item | Evidence |
| --- | --- |
| **Why** | The active set had outgrown the map: `PHASE_HISTORY.md` stopped at AI-25 and still called release engineering "the last records", the dependency record carried counts from 2026-11-02, and the AI language review sheet was not indexed. Separately, the new invariant-register guard was sitting uncommitted under `server/`, where merging it would trigger a Render deploy for a documentation check. |
| **Audit** | The audit covered **124** Markdown files before this change. The four categories in `docs/README.md` are sound; no active document was removed. The historical folders (`evidence/`, `freebuff/`, `superpowers/`) remain frozen, and the roadmap/records stay append-only. |
| **Added** | A dependency-free root guard, `scripts/check-docs.mjs`, checks that all **27** active pages are linked from the map, that map links resolve, and that the auth checklist is the only invariant register. It runs in the required `server` CI job before `npm ci`, so a docs-only PR needs no database or server install. `scripts/check-repo-state.mjs` fetches `origin/main` and fails on a dirty, ahead or behind `main`. [`CONTRIBUTING.md`](../CONTRIBUTING.md) records the branch, documentation, check, PR and clean-close loop; the pull-request template asks for documentation impact and deployment scope. |
| **Corrected** | `PHASE_HISTORY.md` now reaches AI-84, names the current records (`§27HQ`–`§27HS`) and no longer calls release engineering the newest work. `SECURITY_DEPENDENCY_DECISIONS.md` was re-measured at **15** server and **35** mobile entries; the same three advisories remain, and the record explains that the totals count dependents. The AI language review sheet is now indexed. |
| **Verified** | `node scripts/check-docs.mjs` passes: 27 active documents indexed, 30 invariant rows, checklist-only. The existing documentation tests pass **27/27** (links, fact drift, section integrity, route inventory); `git diff --check` is clean. PR #165's code commit `0f8472a` passed all four required checks in run `42345889077`; this log-only follow-up is the final PR commit. |
| **Not done** | No runtime, server, mobile, dependency, provider or deployment change. The docs-only PR does not trigger Render. |

---

## 2026-11-07 — WIP backup audited and retired

| Item | Evidence |
| --- | --- |
| **Why** | `wip/backup-working-tree` was the last local-only non-`main` branch: one 2026-09-28 commit, `d94bec2`, preserved because its working-tree snapshot existed in no other commit. |
| **Audit** | The commit changed six files from `a7baa72`. Each was compared with the first `main` commit that later touched it; the WIP commit is not an ancestor of `main`. |
| **Preserved** | `mobile/eas.json` and `server/src/services/ai/providers/http.ts` match `main` blob-for-blob in `168487b` and `9a210e6`. The test diagnostics were committed in `9a210e6`, whose only changes from the WIP version were the AgentRouter→OpenRouter retargeting; the checklist and both Phase 18 plans were committed in reconciled form in `372db91` and `976c49c`. No unique content remained. |
| **Retired** | Deleted the local branch after confirming it had no remote-tracking ref or `refs/backup/*` copy. The open server Dependabot branch is now the only non-`main` remote branch. |
| **Verified** | Every change is accounted for; `main` remains `26656ab`, level with `origin/main`. No product code, test, build, deployment or provider setting changed. |

---

## 2026-11-07 — Account runbook reconciled with GitHub, Render and EAS

| Item | Evidence |
| --- | --- |
| **Why** | The runbook's provider snapshot was dated 2026-11-06, still said no Render GitHub App was installed, and did not record that EAS is already controlled by the target Gmail. |
| **GitHub** | `nreffejzxc/inventory-ai` is public; `main` is clean at `26656ab`; the owner is the only direct collaborator, with 0 pending invitations; branch protection, secret scanning, push protection and private vulnerability reporting match the table; GitHub settings show 2FA still disabled and the primary email is `jefferndullamalinaozxc@gmail.com`; `scripts/audit-access.mjs` reports no policy violations. |
| **Render** | `ai-inventory` is live at `https://ai-inventory-l1mi.onrender.com`; source `nreffejzxc/inventory-ai`, branch `main`, root `server`; Auto-Deploy is **On Commit** but scoped to `server/`, so the docs-only merges after `98a4282` did not redeploy; the Render GitHub App is installed; `/api/health` returns 200, `status: ok`, `db: connected`, commit `98a4282`. |
| **EAS** | `eas project:info` resolves `@jeffernqwes-team/inventory-ai` at `607eca05-1175-43ed-86a0-1829e91c9531`; `eas whoami` is `jeffernqwe` (`jeffernmalinaoqwe@gmail.com`), the paused target, so EAS is already under that account while GitHub and Render are not. |
| **Correction** | The runbook now scopes auto-deploy, records the installed Render GitHub App, states the EAS account split, and updates the verification date. |
| **Verified** | Documentation guards **39/39**; `git diff --check` clean; `node scripts/audit-access.mjs` exited 0. No account, permission, deployment, build or OTA change. |
| **Not done** | No provider setting was changed. EAS ownership remains a decision for the owner. |

---

## 2026-11-06 — Auth architecture and checklist now own one copy of each rule

| Item | Evidence |
| --- | --- |
| **Why** | The architecture repeated the checklist's invariant register and implementation-status table; the checklist repeated the architecture's identity/session model and failure classification. A rule could be changed in one file and left stale in the other. |
| **Architecture** | `AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md` **287 → 266** lines. §11 now points to the checklist's single invariant register (30 unique rows); §12 points to checklist control status, decisions and gates. The duplicate 15-item invariant list and 11-row status table are gone. |
| **Checklist** | `AUTH_SECURITY_MASTER_CHECKLIST.md` **216 → 194** lines. §2 now points to architecture §§1–10 instead of repeating the model and failure table. I-25…I-30 add the six architecture invariants the register did not already carry: revoked credential, unverified identity, raw errors, retry timing, transient preservation and one mechanism for every role. |
| **Ownership map** | `docs/README.md` now sends auth design/session/recovery changes to the architecture and invariant/control/decision/gate changes to the checklist. |
| **Verified** | **30** invariants, all unique; no numbered invariant list remains in the architecture; documentation guards **39/39** pass; `git diff --check` clean. |
| **Not done** | No code, test or configuration change; no deployment. |

---

## 2026-11-06 — Guides 11 and 13 keep commands and refusals, not repeated proof

| Item | Evidence |
| --- | --- |
| **Why** | Both guides restated the database-first/identity-second rule and phrase mechanics that Guide 11 owns. Guide 11 repeated the witness and re-count proof in its verification section; Guide 13 repeated the self-service deletion explanation and split one boundary statement across three bullets. |
| **Guide 11** | `11-deleting-development.md` **234 → 218** lines. Removed the duplicate per-account proof, the witness restatement, the repeated fixture-rule paragraph and the long order explanation. All **21** command lines and **13** refusal rows remain. |
| **Guide 13** | `13-firebase-identities.md` **244 → 235** lines. Points phrase mechanics to Guide 11, condenses the role-cleanup and Profile warning, and folds the no-command boundary into one paragraph. All **7** command lines and **9** refusal rows remain. |
| **Verified** | Documentation guards **39/39** pass; command lists and refusal rows compare identical to `HEAD`; `git diff --check` clean. No code, test or configuration change. |
| **Not done** | No data, identity, credential or deployment change. |

---

## 2026-11-06 — Auth and account-migration docs reduced to current decisions

| Item | Evidence |
| --- | --- |
| **Why** | The account runbook still carried the full paused handover procedure, restored-account history and old definition of done; the auth checklist still carried a historical section map and separate resolved-decision rows. A reader had to separate current rules from procedure that no longer applies. |
| **Account runbook** | `ACCOUNT_MIGRATION_RUNBOOK.md` **571 → 136** lines. Keeps the current owner and repository, the pause decision, the single-email rule, hard rules, provider anchors, read-only verification, approval gates and current open items. Removes the per-provider transfer recipes, the restoration narrative, the paused completion checklist and the provider source list. |
| **Auth checklist** | `AUTH_SECURITY_MASTER_CHECKLIST.md` **239 → 216** lines. Removes the old-section map; folds resolved O-2/O-4/O-7/O-9 into one line while keeping open decisions; removes the paused `auth:import` migration gate; drops the superseded 2026-10-26 protected-path note. All 24 invariants, control status, remaining gates, production posture and protected hashes stay. |
| **Index** | `docs/README.md` now describes the runbook as current owner state, the paused decision, anchors, checks and gates, not a handover plan. |
| **Verified** | Documentation guards **39/39** pass; `git diff --check` clean. No code, test or configuration change. |
| **Not done** | No account, credential, repository-permission or history change; no deployment. A docs-only merge does not redeploy the server. |

---

## 2026-11-06 — Google Sign-In routine updates blocked at the P-2 native pin

| Item | Evidence |
| --- | --- |
| **Why** | Dependabot #133 proposed `@react-native-google-signin/google-signin` 16.1.5 → 16.2.0. P-2 (FB-D-125) freezes 16.1.5 and `phase1-rnfirebase-foundation.test.ts` rejects the move, so the PR could never be green and contradicted the dependency policy's normal queue. |
| **Config** | `.github/dependabot.yml` now lists the package in the `/mobile` version-update ignore rules, with the native-upgrade reason. Security updates remain outside the version-update ignore. |
| **PR** | #133 closed as a routine-update conflict; no dependency, lockfile, test, app or native change. |
| **Verified** | Documentation guards **39/39**; `git diff --check`; the focused Expo pin test passes; Dependabot YAML parses. |
| **Not done** | No mobile build, OTA, device verification or deployment. `16.1.5` remains installed. Dependabot #132 was closed by the refresh that opened #162; #162 remains open, and merging it would deploy the server. |

---

## 2026-11-06 — Documentation queue merged and merged branches retired

| Item | Evidence |
| --- | --- |
| **Why** | The three documentation PRs were green but each edited the shared log block, and merged topic branches remained locally and on `origin`. |
| **Merged** | #156 `5021636` (AI-50–AI-84 register), #157 `dffa2da` (guide phrase and measurement trim), #158 `016326b` (auth invariant dedupe), and #159 `46397f9` (summary correction). The log conflicts kept every entry and the combined maintenance summary. |
| **Repository** | 13 pre-existing merged local branches and 14 merged remote branches were retired after their PRs were confirmed; the #159 branch was deleted on merge. `wip/backup-working-tree` was kept; at that point the only other remote refs were the two Dependabot branches. |
| **Verified** | PRs #156–#159 passed `server`, `mobile`, `secret-guard` and `attribution-guard`; post-merge `main` CI `42291758396` passed all four jobs on `46397f9`; documentation guards **39/39**; `git diff --check` clean. |
| **Not done** | No product code, prompt, test or deployment change in this queue. Dependabot #132 remains green but behind; #133 is resolved separately in the newer entry. |

---

## 2026-11-06 — Auth invariants narrowed to one owner each

| Item | Evidence |
| --- | --- |
| **Why** | PR #155 made checklist §1 the single register, but I-5 still repeated I-4's business/role/status rule, I-14 repeated I-7's email rule, and architecture §8 repeated the checklist's dead `assertBusinessAccess` note. |
| **Consolidated** | I-4 owns server-derived request identity; I-5 now covers Firebase-linkage choice only. I-14 no longer restates the email rule. Architecture §8 points to I-19 instead of repeating the exception. |
| **Unchanged** | All 30 invariant IDs, control status, decisions, gates, production posture and protected paths. |
| **Verified** | Documentation guards **39/39**; `git diff --check` clean. |
| **Not done** | No code, test, prompt, configuration or deployment change. |

---

## 2026-11-06 — Guides 9, 11, 12 and 13 stop repeating phrases and dated measurements

| Item | Evidence |
| --- | --- |
| **Why** | Guides 9, 11 and 12 repeated command-to-confirmation-phrase tables that Guide 10 already owns as the one phrase and safety matrix. Guides 9, 12 and 13 also carried dated measurements that no longer help an operator. |
| **Phrase tables** | Guide 9 **481 → 467** lines, Guide 11 **218 → 207**, Guide 12 **278 → 260**. Each now points to Guide 10's [phrase and safety matrix](guides/10-seeding-production.md#phrase-and-safety-matrix); the command tables, code blocks and refusal rows stay. Guide 11's refusal row points at the same matrix instead of “the table above”. |
| **Guide 12 measurements** | Removed the 2026-10-25 80,006-document result and the 2026-10-27 index-space figures. Kept the rule that a delete frees documents but not index allocation, the `dropIndexes()` / `syncIndexes()` rebuild and `audit:indexes`. |
| **Guide 13 measurement** | Removed the 2026-10-26 stale-uid measurement; the both-link check and the refusal table stay. |
| **Guide 10** | Its matrix footer now names Guide 11 for development cleanup, so the one table points at the right owner. |
| **Verified** | Documentation guards **39/39**; `git diff --check` clean. No code, test, prompt, configuration or deployment change. |
| **Not done** | No deployment; a docs-only merge does not redeploy the server. |

---

## 2026-11-06 — AI-50–AI-84 itemised in one increment register

| Item | Evidence |
| --- | --- |
| **Why** | §27HQ records the AI-48–AI-84 delivery as one change, and §27HR records its merge; neither maps each AI-50–AI-84 number to the failure it closed or the test/source guard that keeps it closed. |
| **Recorded** | Roadmap §27HS: 35 increments in five groups, each with its measured symptom, change and pin. Record count 224 → 225; `CLAUDE.md` index updated. |
| **Boundary** | Documentation only: no server, mobile, prompt, test or deployment change. It records work already merged in `98a4282`; PR #151 remains the code review. |
| **Verified** | Documentation guards **39/39**; `git diff --check` clean. No server or mobile suite was re-run; the merge counts remain those in §27HQ/§27HR. |
| **Not done** | No EAS build, OTA, phone observation or research-budget measurement; those limits remain as §27HR states. |
| **Review** | The docs-only PR is the review gate for this register. |

---

## 2026-11-06 — AI-48–AI-84 merged and deployed

| Item | Evidence |
| --- | --- |
| **Merged** | PR #151 squash-merged as `98a4282`; 90 files, 12,543 insertions and 376 deletions. |
| **CI** | The PR's four required checks passed; the post-merge `main` CI run `42277471424` also passed all four jobs. |
| **Deployed** | Production `/api/health` reports `commit: 98a4282`, `status: ok`, `db: connected` (2026-11-06T19:16:04Z). |
| **Not done** | No EAS build, OTA or phone observation; the 60 s research budget and the phone behavior are still unverified. |
| **Recorded** | Roadmap §27HR; record count 223 → 224; `CLAUDE.md` index updated. |

---

## 2026-11-06 — AI-48–AI-84 recorded and delivered for review

| Item | Evidence |
| --- | --- |
| **Why** | The AI work existed only as uncommitted files; the log still described AI-49 as local, and the roadmap stopped at §27HP. A reviewer could not tell what the branch changed or what had been measured. |
| **Committed** | 88 files on `wip/ai-hardening-2026-11-06`, commit `da2ea80`. The change covers recorded specifications and currency, grounded answer completion, scoped stock/value/history reads, keyless research fallbacks, dead-stock routing, revenue qualification, and the member-language policy; the mobile branch carries the matching markdown, streaming, price and specification surfaces. |
| **Tests** | Server unit **1,832 pass, 0 fail, 61 skipped**; mobile **101 suites / 1,203 tests**; documentation guards **39/39**; `git diff --check` clean. CI on PR #151 at `da2ea80`: `server`, `mobile`, `secret-guard` and `attribution-guard` all pass. |
| **Documented** | Roadmap §27HQ; record count 222 → 223; `CLAUDE.md` index updated. PR [#151](https://github.com/nreffejzxc/inventory-ai/pull/151) is the review gate. |
| **Not done** | No deployment, EAS build, OTA or phone observation of this branch in this session. This entry records the branch, not a production result. |

---

## 2026-11-06 — Data guides keep the commands, not the repeated proof

| Item | Evidence |
| --- | --- |
| **Why** | Guide 9 printed three near-identical `seed:accounts` examples and a preview table whose rows repeated each command's section. Guide 12 restated Guide 11's verification reasoning and carried a dated per-collection cleanup measurement. |
| **Development seeding** | `9-seeding-development.md` **512 → 481** lines. One mixed `seed:accounts` preview replaces three repeated examples; the dry-run section now states the one distinction that matters — which previews read, which only plan. Every command and safety rule remains. |
| **Production deletion** | `12-deleting-production.md` **302 → 278** lines. The verification section keeps the read-back command and exit meanings, points to Guide 11 for the shared reasoning, and retains the witness check. The 2026-10-25 cleanup measurement is one line; the index-space measurements stay because Guide 12 owns them. |
| **Verified** | Documentation guards **39/39** pass; `git diff --check` clean. No code, test or configuration change. |
| **Not done** | No commit, push, deployment or production change. |

---

## 2026-11-06 — Wireless and production-seeding guides trimmed to current procedure

| Item | Evidence |
| --- | --- |
| **Why** | Guide 15 repeated its manual procedure in a "short version" and carried a machine-specific snapshot table and dated timings. Guide 10 repeated Guide 9's verifier semantics and printed a verification example whose sizes (1,000 each) did not match the seed example (1,000 / 2,000 / 3,000). |
| **Wireless guide** | `15-wireless-phone-session.md` **365 → 291** lines. Kept the one-command path, manual fallback, tunnel explanation, verification, stop behavior and wireless-specific failures. Removed the snapshot table, dated timings/excerpts and the duplicated short version. |
| **Production guide** | `10-seeding-production.md` **491 → 434** lines. Verification now shows the matching 1,000 / 2,000 / 3,000 addresses and points to Guide 9 for output and code-mode semantics; the role-fixture check keeps its production-only `--signin` reason. The dated cluster measurements are replaced by the shared-limit warning and a pointer to Guide 12. |
| **Verified** | Documentation guards **39/39** pass; `git diff --check` clean. No code, test or configuration change. |
| **Not done** | No commit, push, deployment or production change. |

---

## 2026-11-06 — OTA guide and account runbook shortened to current decisions

| Item | Evidence |
| --- | --- |
| **Why** | Both documents carried long dated snapshots that the log and roadmap already own: the OTA guide listed old update groups and build IDs, and the runbook repeated the history-rewrite measurement. A reader had to separate current rules from history to act. |
| **OTA guide** | `7-over-the-air-updates.md` **541 → 505** lines. The dated live-state table, the full paid-plan comparison, the evidence table and the historical build-record list are replaced by the current constraint, the code-signing decision, and pointers to the evidence directory and roadmap. Every command, release step, troubleshooting row and security rule remains. |
| **Account runbook** | `ACCOUNT_MIGRATION_RUNBOOK.md` **655 → 571** lines. §2.1's 17-commit narrative is now a six-row result table that points to the detailed log and roadmap records; the current state, hard rules, provider runbooks, approval gates and definition of done are unchanged. |
| **Verified** | Documentation guards **39/39** pass; `git diff --check` clean. No code, test or configuration change. |
| **Not done** | No commit, push, deployment or production change. The frozen `freebuff/` provenance trail and the dated roadmap records were left intact. |

---

## 2026-11-06 — Root workspace cleaned of capture and backup debris

| Item | Evidence |
| --- | --- |
| **Why** | Device runs and history rewrites had left screenshots, logs, XML dumps, APKs and scratch checkouts in the project root; none were referenced by the application or its documentation. |
| **Removed** | 183 ignored `.tmp-*` files (logs, screenshots, XML, HTML, three APKs), 19 untracked `phone-*.png` screenshots, two clean scratch worktrees, five temporary backup directories, `.scratch/`, `.cloud-attachments/` and `logs/`. |
| **Preserved** | Every commit tip the backup bundles held: `git show-ref` still lists **37** `refs/backup/*` refs. `.tmp-demo-tenant/password` is retained because the log cites it as the generated demo-account credential; it is one hidden 1 KB file, not a capture artifact. |
| **Result** | Workspace **2.6 GB → 1.5 GB**; `git worktree list` names only the main checkout; the 126 modified/untracked entries were unchanged by the cleanup. |
| **Not done** | No commit, push, deployment or source change. Older log entries that name the removed bundle paths remain as written; this entry records why those paths are gone. |

---

## 2026-11-06 — Documentation trimmed to the questions each document owns

| Item | Evidence |
| --- | --- |
| **Why** | A second pass found duplication, not gaps. The phone reference re-taught Guides 2 and 15, and the specification still carried its original fifteen-section build plan — including claims that contradicted shipped behaviour. |
| **Removed** | `DEVELOPING_ON_A_PHYSICAL_DEVICE.md` §§1–3 and §9 (install, dev build, stack start, routine) are taught in Guide 2; §10 is now a pointer to Guide 15; eight troubleshooting rows Guide 2 owns were removed. `SYSTEM_SPECIFICATION.md` §§41–55 retired: generic test lists, git strategy, proposed document types, V1 screen and flow sketches, scope summary, the V2–V4 wish list, cost control, deployment and store boilerplate, observability, backup, acceptance criteria and the phase sequence. |
| **Kept** | The authenticated walkthrough (§7), the failure table (§8), the headless-harness traps (§9b), the measured wireless note (§10), and every rule above §41. Section numbers stay stable so dated roadmap citations resolve; the retirement note names §44 and §48 for readers following old references. |
| **Maintenance rule** | `docs/README.md` now maps each kind of change to the one document that owns it, so an edit lands in the specification, a task guide, a dated decision or the log — not in all four. |
| **Verified** | Device reference **563 → 394** lines; specification **3,226 → 2,704**. The six documentation guards pass **39/39**: links, data-guide commands, fact drift, section integrity, route inventory and issue records. `git diff --check` clean. |
| **Not done** | No commit, push, deployment or production change. The historical records (`DEVELOPMENT_ROADMAP.md`, `freebuff/`, `evidence/`) were not rewritten; the frozen Freebuff audit trail and the closed GitHub-support record were kept as provenance. |
| **Next** | Keep §56 and §57 as the only planning principles; record a new decision in the roadmap rather than restoring a removed section. |

---

## 2026-11-06 — Documentation consolidated around the reader's task

| Item | Evidence |
| --- | --- |
| **Why** | The active guide set had two copies of the phone-session workflow and a 1,488-line command runbook that repeated Guides 9–13. The first check also exposed a stale mobile-version claim and evidence links written under the wrong root. |
| **What changed** | Guide 3's USB mirroring is now Step 10 of Guide 2 and Guide 3 is retired. Guide 14 is retired; Guides 9–13 keep the data rules and complete invocations, Guide 6 keeps backup/restore and the command index, and the duplicated test was removed. Indexes, `CLAUDE.md`'s `1.0.2` version, the spec's tree/shipped distinction, the CI summary and the README dependency wording were corrected. Evidence links and the CI repository-visibility comment were fixed. |
| **Guard added** | [`docs-links.test.mjs`](../server/test/docs-links.test.mjs) resolves every relative Markdown path under the root/docs tree and is registered in the pure-unit list. It skips temp clones and dependencies; it does not validate anchors or HTTP targets. |
| **Verified** | `node --test` on the link, data-guide, fact-drift, section-integrity, route-inventory and issue-record guards: **39 passed, 0 failed**. `node --check` and ESLint on the changed test files: clean. `git diff --check`: clean. |
| **Not done** | No commit, push, deployment, EAS build, OTA or production change. The full database suite and GitHub Actions were not run from this machine. |
| **Next** | Let CI run the link guard; keep historical roadmap/evidence records append-only and link-checked. |

---

## 2026-11-04 — Market prices from cited pages, and a faster research fan-out

| Item | Evidence |
| --- | --- |
| **Why** | AI-47 could research quality but had no price path. A model-written price is unverifiable; Shopee returned an anti-bot shell, Lazada JSON-LD carried no price, and Amazon’s target price block was empty. |
| **What shipped** | Read-only **researchMarketPrices**: one to three tenant-owned product ids, one OpenRouter web-plugin request per product (two at a time), exact price strings from cited page text only, brand + model token required, up to five listings per product and twelve total, with marketplace, URL, snippet and retrieval time. Prompt rules 23–24 keep recorded prices separate and handle price-threshold/multi-kind questions. Research fan-out is bounded at three brand groups; price subjects at two. |
| **Tests** | AI-49 **13 unit + 2 DB**; AI-47 **13 unit + 3 DB**; focused docs/AI-49 checks **30 pass / 1 skip**; server `tsc` and ESLint clean. Full unit suite **1,676 pass, 0 fail, 60 skipped** (1,736 tests). |
| **Live** | Disposable 14-product/22-row tenant, process-local Nemotron Ultra, 3,000 tokens and 120 s: Q1 23.1 s, Q2 26.3 s, Q3 60.7 s, Q4 59.8 s, Q5 76.3 s, Q6 49.1 s. Q4 cited Keychron PH ₱6,000, Game One ₱5,895, PriceMe ₱5,195–₱5,895, iTech ₱1,995–₱2,369 and Bermor ₱1,995–₱2,350, and stated no verified Shopee/Lazada/Amazon price. Q6 called its evidence professional-review snippets, not owner reviews. |
| **Cost audit** | The signed-in OpenRouter Logs view showed 31 generations in 24 h, all on free models; **15** rows cost **$0.007 each ($0.105)**, the paid web-search plugin, while every other row cost $0.00. `AI_ALLOW_PAID_WEB_SEARCH` now defaults false; both research tools use the keyless free path, and a live free price lookup found Keychron PH at **₱6,000.00** for the K8 Pro. The test harnesses also refuse non-`:free` models without approval. |
| **Remaining** | A second Q5 run spent six tool rounds and hit 120 s; broad value questions are not stable. The 60 s/1,200-token default cannot fit these research turns. Product has no currency field; Q1/Q4 inferred ₱ while Q5 omitted it. No direct marketplace price was verified. |
| **Not done** | No commit, deploy, OTA publication or production config change. |
| **Follow-up** | Four brand groups and three price products now run concurrently; the price result returns only source titles/URLs. Q4 after trim **47.5 s** (36.2 s provider, 11,001 input tokens); Q3 **60.0 s** with ultra research and **67.1 s** with default liquid research (56.9 s final generation). Phone: installed preview build lacks the new JS; Expo Go is blocked by native Firebase. |
| **Record** | Roadmap **§27HP**; indexed in `CLAUDE.md`; record count **221 → 222**. Evidence: [`docs/evidence/ai49-market-price-research-2026-11-04/`](evidence/ai49-market-price-research-2026-11-04/README.md). |

---

## 2026-11-04 — Recorded specifications, and a real seed catalogue

| Item | Evidence |
| --- | --- |
| **Why** | The assistant had no specification field, and the seeders wrote “Demo Coffee Beans 1kg” or “Premium Kettle 10001” with “Seeded row N” descriptions. A comparison could not be grounded in recorded facts. |
| **What shipped** | Optional `Product.specifications` (max 1,000), validated and carried through create/get/update; `findProducts` searches it and `getProduct` returns it in full; prompt rules 16/19/22 and the research prompt use it as recorded data. A shared 14-product catalogue (12 brands, four categories) now backs both demo and bulk seeders, with manufacturer/support sources and no placeholder names. Mobile form/detail support and a release note were added. |
| **Tests** | AI-48 **4 unit + 3 DB**; SEED-1 **2 unit + 1 DB**; AI-47 **12 unit + 3 DB**; DEMO-1 **22/22**; server and mobile `tsc`/ESLint clean. The full unit suite is **1,650 pass, 0 fail, 58 skipped** after fixing the issue-record guard, which had been scanning git-ignored local artifacts (a stale `.tmp-*` copy of the suite) and reporting their identifiers as citations. |
| **Live trial** | A disposable development tenant (14 products, 22 stock rows) was asked a keyboard comparison and a reliability/research recommendation. The configured `nvidia/nemotron-3.5-lightning:free` primary timed out at 60 s. The configured fallback `nvidia/nemotron-3-ultra-550b-a55b:free`, used as a process-local primary with an evaluation-only 3,000-token output budget and 120 s deadline, completed both: the comparison in **30.5 s** (`findProducts`, 1,102 output tokens) with the recorded RK61/K8 Pro layout, switch, battery and stock facts, an explicit “not recorded” for missing RK61 details, and a recommendation limited to the recorded small-desk case; research in **84.8 s** (`findProducts` + `researchInventoryProducts`, 2,045 output tokens) with four stocked keyboards, recorded facts kept separate from web snippets, the URLs the tool returned, an explicit “no snippets” for Keychron/ASUS, and a K8 Pro office recommendation grounded in recorded facts. At the default 60 s/1,200 tokens the research turn would not fit; no production config was changed. |
| **Not done** | No commit, deploy, OTA publication or phone observation. The production model/config was not changed; the evaluation override was process-local. |
| **Record** | Roadmap **§27HO**; indexed in `CLAUDE.md`; record count **220 → 221**. Evidence: [`docs/evidence/ai48-product-specifications-2026-11-04/`](evidence/ai48-product-specifications-2026-11-04/README.md). |

---

## 2026-11-04 — Research the web, recommend only what we stock

| Item | Evidence |
| --- | --- |
| **Why** | Product names and recorded prices cannot answer a reliability or value question, and a free-text web search would let an outside brand into a recommendation. |
| **What shipped** | The 16th read-only tool, `researchInventoryProducts`, takes up to eight product IDs, resolves them inside the session's business and searches each recorded brand separately through OpenRouter's web plugin. Findings are filtered back to the exact recorded subjects; no valid public citation means no research. A keyless DuckDuckGo HTML fallback supplies bounded titles, snippets and URLs when the free model is refused. Prompt rule 21 keeps recommendations inside the inventory and requires the source links. |
| **Live failure** | On preview OTA `1ac39b80` / `178cbe6`, the phone answered the keyboard-brand question with inventory-only ROG, RAK Gears and Royal Kludge findings, but named publications without URLs and left Royal Kludge unsourced. The last screenshot still showed the old **Research inventory products** label; the OTA carries **Web research**. |
| **Fix** | PR #147 appends every source URL the answer omits, once, including in the streamed suffix, and retries an empty fallback query once with the recorded brand alone. |
| **Tests** | AI-47 **12 unit + 3 DB**; recorded-names-only request, per-brand search, citation requirement, public URL parsing, snippet retention, append-once and the read-only cross-tenant refusals. Server `tsc` and ESLint clean. All four checks green on #145, #146 and #147. |
| **Production** | Health reports `f0eefb5`, database `connected`, **0** server errors. No EAS build; one preview OTA published. |
| **Phone** | The `178cbe6` run proves the inventory boundary and sourced snippets on the device, but not the URL list or new label. The final retest is blocked: on 2026-11-04 ADB and Windows USB enumerated no phone, and ADB mDNS was empty. |
| **Record** | Roadmap **§27HN**; indexed in `CLAUDE.md`; record count **219 → 220**. Evidence: [`docs/evidence/ai47-inventory-web-research-2026-11-04/`](evidence/ai47-inventory-web-research-2026-11-04/README.md). |

---

## 2026-11-03 — What the catalogue contains, in one read

| Item | Evidence |
| --- | --- |
| **Why** | The phone could say "no engine oils" honestly, but answering what the catalogue *does* contain took several category and brand reads. Brand rows also lacked the recorded descriptions and price range needed for a factual comparison. |
| **What shipped** | `getCatalogOverview` (15th read): total active products, per-category counts, distinct recorded brands, and how many products have a brand or description. `listBrands` now includes each sample's recorded description and a brand price range. Prompt rule 20 sends "what do we carry / how complete is our data" there; rule 18 uses the descriptions and price range for differences, never quality. |
| **Boundary** | The overview has no stock, price or quality data; `listBrands` still has no stock. Price range is the recorded selling price, not value; a count is not a quality ranking. Brand remains optional: no recorded brand is not no brand. |
| **Tests** | AI-46 **4/4** (2 unit + 2 DB), including category counts, brand/description coverage, price range and sample descriptions. AI-44 **7/7**, AI-45 **8/8**, phase06 **18/18**, AI-2/AI-18 guards, and the OpenRouter full-catalogue turn with all **15** tools. Server and mobile typecheck clean; mobile label suite **8/8**. |
| **CI** | The first full-suite run caught two integration mirrors: a stray prompt comma and the OpenRouter all-tools list missing the new read. Both were fixed; PR #141 merged as **`96bc659`** with all four checks green. |
| **Production** | Health reports `96bc659`, database `connected`, **0** server errors. Preview OTA `12c6435d` is published. |
| **Phone** | **Not run.** After the runner restart, `adb devices` was empty and Windows did not enumerate the phone; scrcpy was not running. No screenshot or UI claim is made. The OTA is ready for the next connected test. |
| **Record** | Roadmap **§27HM**; indexed in `CLAUDE.md`; record count **218 → 219**. Evidence: [`docs/evidence/ai46-catalog-overview-2026-11-03/`](evidence/ai46-catalog-overview-2026-11-03/README.md). |

---

## 2026-11-03 — A natural product question finishes

| Item | Evidence |
| --- | --- |
| **Why** | The owner wants everyday questions — *"Do we have engine oils suitable for cars and motorcycles? Recommend the best brands"* — answered without exact product names, from real inventory data. |
| **What shipped** | `findProducts` accepts several comma-separated everyday terms and searches name, recorded brand, recorded description, SKU and barcode; it returns stock and supports exact category and in-stock filters. Prompt rules 17 and 19 send use/task/kind questions there before absence and forbid a quality ranking without recorded evidence. |
| **First phone attempt failed** | On `aae32ea` the model called `findProducts`, then `listCategories`, then repeated one-word product searches and exhausted the six-step budget: *"I could not finish that request within the allowed number of steps."* The data was right; the turn never delivered it. [Screenshot](evidence/ai45-natural-search-2026-11-03/first-loop-failure.png). |
| **Fix** | PR #139: a no-match `findProducts` result carries the ACTIVE categories and an explicit stop instruction; rules 17 and 19 say the no-match result is terminal. No iteration cap was raised. |
| **Phone retest** | On `e1af99c`, the same question answered: searched *engine oil* and *motor oil*, no matching products, listed **Personal Care, Household, Snacks, Beverages**, and refused to recommend brands or report stock for a product type it does not hold. Provenance **Product discovery**. [Screenshot](evidence/ai45-natural-search-2026-11-03/natural-answer.png). |
| **Tests** | AI-45 **8/8** (3 unit + 5 DB: synonym, description-only match, multi-term/in-stock, no-match categories + guidance, category filter). AI-43 and AI-2 guards pass; AI-18 page guard passes; server `tsc` clean. All four checks green on #138 and #139. |
| **Production** | PR #138 merged as `aae32ea`; PR #139 as `e1af99c`. Health reports `e1af99c`, database `connected`, **0** server errors. Preview OTA `5d89b55b`. |
| **Boundary** | This tenant has 1,001 products, no brands, and no automotive/electronics/construction categories. The phone proves honest absence; the positive path is DB-tested. Recommendations compare only recorded brand, description, price, unit and stock. |
| **Record** | Roadmap **§27HL**; indexed in `CLAUDE.md`; record count **217 → 218**. Evidence: [`docs/evidence/ai45-natural-search-2026-11-03/`](evidence/ai45-natural-search-2026-11-03/README.md). |

---

## 2026-11-03 — Recorded brands, and the question they answer

### Completed and verified

| Item | Evidence |
| --- | --- |
| Why | AI-43 could only say the catalogue had no brand field. The next request asked for brand checking and recommendations; a prompt cannot invent a field, so this is the schema/API/mobile change §27HJ deferred. |
| Change | Product gains an optional `brand` (trimmed, max 80) through the model, DTO, create/update API, mobile form, detail and list. Product search `q` matches brand. New read-only `listBrands` aggregates ACTIVE products by brand with product count, categories and three sample names; optional exact category and brand text; stock is deliberately a separate read. Prompt rules 16 and 18 treat brand as recorded data, distinguish `null` from "no such brand", and route brand questions to `listBrands`. AI-43's grounding note now says brand is optional and a description is not a specification field. |
| Tests | `AI44-brand-lookup` **7/7** (2 unit + 5 DB): brand search, aggregation, category filter, no-match page, `getProduct` recorded/null brand. AI-43 **10/10**; AI-2 read-only guard passes; OpenRouter all-tools turn covers **13** tools. `tsc --noEmit`, ESLint, mobile typecheck and mobile lint clean. |
| Merged and deployed | PR #136, all four required checks green, merged as **`a99aed7`**. Production `/api/health` reports `a99aed7`, database `connected`, **0** server errors. |
| OTA | Preview update `ecff412c-1312-4901-9686-7cc8d397b7c7`, runtime `1.0.1`, commit `a99aed7`; `check-ota-publish --channel preview` was **ready** first. No build spent. |
| Phone | New chat: *"What brands do we carry?"* Answered *"No brands are currently recorded for the active products in your inventory — brand is an optional field…"*, provenance **Read: Brands**. Correct for a tenant with no brand values; the positive aggregation is DB-tested. Screenshot: [evidence](evidence/ai44-brand-lookup-2026-11-03/README.md). |
| Record | Roadmap §27HK; record count **216 → 217**; `CLAUDE.md` index updated. |

### Not completed

- The production tenant still has **no brand values**, so the phone proves the honest empty state, not a positive brand summary. The positive path is covered by the DB fixture and the UI field is shipped.
- `listBrands` does not report stock; the assistant must follow with `searchProducts`/`getProduct`/`getInventory`.
- The product list has no dedicated brand filter yet; search matches brand text.

### Next priority

- Record brands on the demo or real products, then re-ask the brand question on the phone to verify the positive answer. Keep the empty-state wording: *not recorded* is not *no such brand*.

---

## 2026-11-03 — A recommendation rests only on catalogue facts

### Completed and verified

| Item | Evidence |
| --- | --- |
| Baseline | On `1c1734b`, the phone answered the vehicle-repair, battery/charger and cleaning-brand questions honestly: no engine oil, only the four real categories, and brand names not stored. That was model compliance, not a boundary. |
| Gap | The product model has no brand, model, specification, rating or review field, and its names are adjective plus noun (**Ultra Detergent**, **Premium Battery**); `searchProducts` and `getProduct` also omitted `description`, the only free text that can record a brand or specification. |
| Change | Product rows now carry `description` — 160 characters in a list, full up to 500 in `getProduct` — and both tools attach a note: no separate brand/specification/rating field, recommend only returned products, never infer brand or quality from a name. Prompt rules 16–17 add the stock check, the honest gap statement, no outside brands, and the category-plus-words check for a kind-of-product question. |
| Tests | `AI43-recommendation-grounding` **10/10**; AI-42, AI-2, AI-16 and phase06 AI tools **45/45**; `tsc --noEmit` clean; ESLint clean on the changed source, test and runner. |
| Merged and deployed | PR #134, all four required checks green, merged as **`94ebe80`**. Production `/api/health` reports `94ebe80`, database `connected`, **0** server errors. |
| Phone retest | Against `94ebe80`: the vehicle-repairs question found no engine-oil or automotive-repair products and said the system stores no brand names, specifications or ratings; the cleaning question said *"Because brand data is not available, I cannot recommend specific effective or trusted brands from the catalogue"*; the detergent comparison named only the fields that exist. No invented brand or product. Screenshots: [evidence](evidence/ai43-recommendations-2026-11-03/README.md). |
| Ground truth | **Ultra Detergent 10990** is Household, box, ₱43.80, minimum 91 — exactly the fields the assistant quoted. |
| Record | Roadmap §27HJ; record count **215 → 216**; `CLAUDE.md` index updated. |

### Not completed

- The catalogue still has no brand or specification field, so this tenant cannot receive ranked brand recommendations from any assistant. The assistant now says so and uses a description when one carries a fact; adding the fields is a product-schema decision.
- Model compliance is not deterministic. One phone pass proves the boundary travels with the prompt and the rows; it does not prove every future answer.

### Next priority

- Decide whether the product catalog should record brand and specification fields. Until then, the honest gap statement is the correct answer, not a defect to be prompted away.

---

## 2026-11-02 — The transfer's direction, carried by the event itself

### Completed and verified

| Item | Evidence |
| --- | --- |
| Defect | After #128 deployed, a live answer counted the transfer once but said **From: Shop Front** and omitted the destination. The dashboard's activity row for the same movement shows **Main Warehouse → Shop Front**, 2 units at 2026-11-01 08:47 — so the direction was reversed, not merely unstated. A ledger leg has only its own location and before/after quantities. |
| Change | `getInventoryHistory` now classifies each TRANSFER leg with `direction` (`out` when the location lost stock, `in` when it gained) and folds a complete, directionally consistent pair into **one event** with explicit `from`, `to`, `reference`, `quantity`, product and time. A lone leg — location-filtered page, or a pair split by the page edge — stays a leg and keeps its `direction`. |
| Count | The logical total is `rows - transferRows + transferReferences` over the **whole filtered set**, via `transactionsService.transferStats`, which shares one `historyMatch` with `list`. A pair beyond the page boundary cannot inflate the count. The History screen still gets the raw total and both rows. |
| Guard | `AI42-transfer-event.test.mjs` **3/3**: the pair folds with correct `from`/`to`, quantity 4 and count 2; a location-filtered page keeps one leg with the correct direction; a stock-in page is unchanged. `AI2-ai-readonly-tools` first **failed** because the new service call was not allow-listed — the guard doing its job — then passed **10/10** after `transactionsService.transferStats` was added explicitly. |
| Neighbours | AI-18 paged results, AI-19 history shape, phase19 transfers and phase06 AI tools — **55/55**, including phase19's *history still shows BOTH ledger rows*. |
| Checks | Server `tsc --noEmit` clean; ESLint clean on the changed source, both tests and the allow-list. |
| Merged and deployed | PR #130, all four required checks green, merged as **`1c1734b`**. Production `/api/health` reports `1c1734b`, database `connected`, **0** server errors. |
| Device evidence | The phone is mirrored with `scrcpy` over USB. The app's dashboard was read on the device and shows the transfer as **Main Warehouse → Shop Front**, establishing the direction the old answer reversed. |
| Live answer | After the provider key was reset, the phone asked *"Show the latest transfer: which location sent it and which location received it?"* against `1c1734b`. The answer: **From: Main Warehouse**, **To: Shop Front**, 2 units of ZZ Sprint1 Verify at 2026-11-01 08:47 local — matching the dashboard, naming the destination, and reporting it once. Screenshot: [`docs/evidence/ai42-transfer-2026-11-02/answer.png`](evidence/ai42-transfer-2026-11-02/answer.png). |
| Record | Roadmap §27HI; record count **214 → 215**; `CLAUDE.md` index updated. |

### Not completed

- The one-location movement check on the production tenant still needs the owner at the device.

### Next priority

- Run the one-location movement check on the phone; the AI-42 half is now device-verified.

---

## 2026-11-02 — A transfer is one event to the assistant

### Completed and verified

| Item | Evidence |
| --- | --- |
| Why | A production answer counted one transfer as two movements. The ledger keeps two rows sharing one `reference` — phase19 pins that History shows both — and the assistant read those rows without being told they are one event. |
| Change | `getInventoryHistory` appends a `note` only when both legs of a transfer are on the page: report it once with source and destination, not as two movements. The tool description states the same rule. |
| Deliberately unchanged | `transactionsService.list` and the History screen still return both ledger rows; the dashboard's logical grouping is untouched. |
| Guard | `server/test/AI42-transfer-event.test.mjs` **3/3**: a transfer page has two rows with the shared reference **and** the note; a `STOCK_IN`-only page has no `note` key; a location-filtered page with one leg also has none. The first case was written first and failed on the missing note. |
| Merged | PR #128 → **`be28464`**, a merge commit. All four required checks green on `main`. |
| Deployed | `GET /api/health` reports commit **`be28464`**, environment `production`, database `connected`, **0** server errors. |
| Neighbours | AI-18 paged results, AI-19 history shape, phase19 transfers and phase06 AI tools — **54/54**, including phase19’s explicit *"history still shows BOTH ledger rows"* case. |
| Checks | Server `tsc --noEmit` clean; ESLint clean on `tools.ts`, the new test and `run-tests.mjs`; the new file is registered in the DB-backed list so the full suite runs it. |
| Record | Roadmap §27HH; record count **213 → 214**; `CLAUDE.md` index updated. |

### Not completed

- Not observed on hardware: model compliance is not deterministic, and no turn was spent on the installed preview APK.
- The one-location movement check on the production tenant still needs the owner at the device.

### Next priority

- Open the PR, let the four required checks run, merge, and confirm `main`.

---

## 2026-11-02 — The stock-in link keeps its product

### Completed and verified

| Item | Evidence |
| --- | --- |
| Defect | `MovementForm` seeded `initialProductId` once at mount. A cold link whose product params resolved after the first render left `productId` empty; the locked card drew the name from the prop, so the screen looked correct while the submit button stayed disabled. |
| Fix | The product now uses the same ref-tracked adoption as the location: a param that arrives or changes is adopted, and a manual choice is marked touched and never overwritten. Shared by Stock In, Stock Out and Adjust. |
| Guard | `stock-in-deep-link.test.tsx` now types a quantity, presses **Add stock**, and asserts the request payload carries `productId: 'p1'`; the second case chooses a different product first and asserts the link cannot replace it. |
| The guard can fail | With `HEAD`'s `MovementForm.tsx` restored, the adopt-and-submit case failed with **0** calls and the other five passed. The fixed file was restored and all six passed. |
| Checks | Deep-link suite **6/6**; the four movement suites together **17/17**; `tsc --noEmit` clean; ESLint clean on both changed files. |
| Merged | PR #124 → **`a8fbff5`**, a merge commit. All four required checks green on `main`; branch protection unchanged. |
| Record | Roadmap §27HG; record count **212 → 213**; `CLAUDE.md` index updated. The dated **Open items** snapshot was corrected from the 2026-10-30 state: five advisories remain, `zod` is closed, and the stale `zod`/`deepmerge` sentence was replaced. |

### Not completed

- Not observed on hardware: the installed preview APK predates this JavaScript-only change, and no build or OTA was spent for it.
- The one-location movement check on the production tenant still needs the owner at the device.

### Next priority

- Open the PR, let the four required checks run, merge, and confirm `main`.

---

## 2026-11-02 — Expo 58.0.22 preview APK built and exercised on the CPH1969

### Completed and verified

| Item | Evidence |
| --- | --- |
| Build | `eas build --profile preview --platform android`; build **`5500e6be-bc45-46f9-a334-f738f4bd1bea`**, status **FINISHED**; channel `preview`; runtime `1.0.1`; versionCode **8**; commit `6631d37`. |
| Artifact | 112 MB APK; SHA-256 `0e19095be18748f379347694bda217876b83ff2167f0536e7efe92c90c612486`; saved locally as `.tmp-expo-58.0.22-preview.apk` (untracked). |
| Quota | Free plan after the build: **Android 3/15**, iOS 0/15, **3/30 total**, $0 overage; cycle 2026-11-01 → 2026-12-01 UTC. |
| Install | `adb install -r` → **Success**; versionCode **7 → 8**; versionName `1.0.1`; `firstInstallTime` stayed 2026-10-17, so app data and session survived. |
| APK metadata | `aapt dump badging`: `com.inventoryai.app`, versionCode **8**, versionName **1.0.1**, minSdk **24**, targetSdk **36**, compileSdk **37**; native code `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`. Device ABI is `arm64-v8a`. |
| Device | OPPO CPH1969, serial `PV4DDMIZZLTCIVSK`, USB. |
| Mirror | `scrcpy 4.1 -s PV4DDMIZZLTCIVSK -m 1024 --no-audio`; `Texture: 472x1024`; window kept open for the run (process 18700). |
| Launch | `com.inventoryai.app/.MainActivity` resumed, PID 13731; `ReactNativeJS: Running "main"`; no `FATAL EXCEPTION`, ANR, `Unable to load script`, `TypeError` or `ReferenceError`. |
| Screens | Dashboard: 835 in stock, 166 low, 58 out, 1,001 active products, 233,451 on-hand. Products: live rows including `ZZ Sprint1 Verify` and `Deluxe Tape 10999`. Product detail: stock at Shop Front and Main Warehouse. Inventory: live stock rows. AI assistant: 6 stored conversations; stored answer rendered “We hold 233,451 units of stock across 1,001 active products.” Scan: permission-request screen rendered. |
| Scan camera | The in-app **Allow camera access** prompt opened the Android dialog; **Allow** set `android.permission.CAMERA: granted=true`. The live back-camera preview rendered, the reticle and hint stayed visible, and no crash or ANR followed. |
| Barcode decode | EAN-13 **2000053337540** decoded from a label in view; the authenticated lookup returned the **Product not found** state with the decoded code, and **Scan again** re-armed the camera. The intended product barcode **2221997960193** (`Deluxe Tape 10999`) was not captured because the phone was not aimed at that label. No stock was changed. |
| OTA | None published. `mobile/ota-native-runtime.json` now records build `5500e6be` (expo 58.0.22, expo-modules-core 58.0.29, React Native 0.88.1); `check-ota-publish --channel preview` and `--channel production` both exit **0** and report **ready**, with only branch/unpushed warnings. |

### Not completed

- The product barcode **2221997960193** was not captured; the scanner path was verified with **2000053337540** and the not-found state.
- The one-location movement check on the production tenant still needs the owner at the device.
- The APK is a temporary local artifact; it is not committed.

### Next priority

- After this documentation merge, run the one-location movement check on the phone. TypeScript 7 remains issue #32.

---

## 2026-11-02 — Thirteen stale local branches retired

### Completed and verified

| Item | Evidence |
| --- | --- |
| Candidates | 13 local branches, each scanned **0** retired-identity author/committer hits and **0** Codebuff trailers. |
| Merged work | 9 branches map to merged PRs **#74, #77, #78, #82, #83, #84, #85, #86, #87**. |
| Already in `main` | `chore/expo-sdk-58`, `fix/auth03-renewal-pacing` and `fix/script-environment-guards` are ancestors of `main`. |
| Superseded | `chore/server-dependency-minor-bumps` is closed PR **#75**; PR **#76** merged the same five server bumps and §27CB, and `main` contains the replacement work. |
| Backups | Every tip was written to `refs/backup/local-branches-retired-2026-11-02/<branch>` and asserted equal before deletion; all 13 refs verify. |
| Retired set | `chore/docs-section-guard`, `chore/expo-sdk-58`, `chore/server-dependency-minor-bumps`, `docs/ai27-request-count`, `docs/device-measurements-2026-10-15`, `feature/ai1-ai4-assistant-reliability-and-rendering`, `feature/ai10-output-limit-and-upgrade-watch`, `feature/ai27-allowance-preflight`, `fix/ai-turn-probe-ground-truth`, `fix/auth03-renewal-pacing`, `fix/dep-2-cold-start-budget`, `fix/dependabot-mobile-transitive`, `fix/script-environment-guards`. |
| Result | **3** local branches remain: `main`, `docs/contributor-cleanup-2026-11-02` and `wip/backup-working-tree`. The WIP branch was deliberately kept because it has one unique commit (`d94bec2`, "not for merge"). |
| Worktree | The current branch and its uncommitted log/Expo changes were untouched; no remote branch was deleted. |

### Not completed

- `wip/backup-working-tree` still holds its one unique WIP commit. It is intentionally not merged or deleted.
- The 13 retired tips are preserved locally only; they are not remote branches.

### Next priority

- Merge PR #120 (all four checks green), then confirm `main` and branch protection remain clean.

## 2026-11-02 — Five merge subjects rewritten; 38 signatures preserved

### Completed and verified

| Item | Evidence |
| --- | --- |
| Scope | The five merge commits `#99`–`#103` on `main` replaced `jeffernqwerty` with the canonical `nreffejzxc` in their subjects. No other commit message was changed. |
| Method | A separate clone rebuilt the range `0647187d..main` (50 commits) with `filter-branch`; the 409 earlier commits were untouched, including their signatures. Only merge subjects containing the retired login changed. An initial filter-repo pass that rebuilt all 459 commits was superseded because it dropped all 42 signatures. |
| Content parity | 459 commits before and after. The tree sequence, author/committer names, emails, raw dates and parent-count sequence are identical; `git diff afd7088 main` is empty. The 409 earlier commits kept their original IDs; the 50 rebuilt commits keep every tree. |
| Message result | `main` `d6bdbc35`: **0** merge subjects and **0** commit subjects name the old login. Two non-merge documentation commit messages still quote it (`7` occurrences before, `2` after; both are historical prose, not subjects). |
| Signatures | **42** signature-bearing commits before (**7** merges, **35** non-merges): **38 preserved** on the untouched ancestors, **4 lost** on rebuilt descendants. The five rewritten merge commits were not signed. The 4 signed descendants could not keep signatures once their parent changed; they cannot be restored locally. |
| Backup | `refs/backup/main-before-merge-subject-rewrite-afd7088` and `.tmp-merge-subject-rewrite-2026-11-02/main-before.bundle`; the bundle verifies. The superseded `af44b60` pass is at `refs/backup/main-before-signature-preserving-rewrite-af44b60` and in `main-af44b60.bundle` (also verified). |
| Guarded push | Branch protection was temporarily set to `allow_force_pushes=true` / `enforce_admins=false`. The first push (`afd7088`→`af44b60`) and the corrected push (`af44b60`→`d6bdbc35`) were both dry-run and `--force-with-lease` guarded; the corrected push is the final history. |
| Protection restored | `gh api` after the corrected push matches the saved original exactly: force pushes **off**, admins **enforced**, strict checks `secret-guard`, `attribution-guard`, `server`, `mobile`, PR review settings, conversation resolution and restrictions unchanged. |
| CI | The final `main` commit `d6bdbc35` has all four required checks green; PR #120 `d347b70` has all four green and `mergeStateStatus` **CLEAN**. |
| Deployment | `GET /api/health` reports commit `d6bdbc35`; the tree is identical to `afd7088`, so no application code changed. |
| PR #120 repair | The force update made the docs branch conflict on an add/add in `docs/DEVELOPMENT_LOG.md`. A first merge-based repair was discarded because it retained the old `main` ancestry and all five old subjects. The branch now replays `ddc1474` directly onto the final `main` as `d347b70`; the tree matches exactly (`git diff ddc1474 d347b70` empty), it is one commit ahead, the old ancestry is gone, and PR #120 is mergeable with all four checks green (`mergeStateStatus` **CLEAN**). |
| Contributor count | `GET /contributors` still returns exactly **nreffejzxc 452** and **dependabot[bot] 7**. |

### Not completed

- PRs #99–#106 still show `jeffernqwerty` as their author, and 18 Codebuff trailers remain reachable from 44 old PR refs. Those are GitHub metadata and immutable refs, not `main` history.
- The two non-merge documentation commit messages that mention the old login were left intact because the request scoped the rewrite to the five merge subjects.

### Next priority

- Merge PR #120 (all four checks green). Do not rewrite the remaining two historical prose references unless explicitly asked.

## 2026-11-02 — Expo 58.0.22 patch clears the zod high advisory

### Completed and verified

| Item | Evidence |
| --- | --- |
| Expo patch | `mobile/package.json` moves `expo` `~58.0.19 → ~58.0.22`. The install resolves `expo@58.0.22` and nested `@expo/cli@58.1.18`, which declares no `zod`. |
| Managed pins | The 58.0.22 SDK table moved 14 pins. `npx expo install --fix` aligned 12; the remaining three (`expo-constants ~58.0.14`, `expo-font ~58.0.11`, `jest-expo ~58.0.13`) were set to the table exactly. `npx expo install --check` now says "Dependencies are up to date." |
| Audit | `npm audit --json` in `mobile/`: `{low:1, moderate:46, high:0, critical:0, total:47}`. `zod` is absent; `@expo/cli` remains moderate via `glob`. The only `zod` is `4.6.7` via `eslint-config-expo → eslint-plugin-react-hooks → zod-validation-error`. |
| Watch | `node scripts/check-upgrade-watches.mjs`: `zod` **CLOSED**, `node-forge` **CLOSED**, `deepmerge` **DEFERRED**, `expo` and `jest-expo` **READY**. |
| Typecheck | `cd mobile && npm run typecheck` — exit **0**. |
| Tests | First run after the Expo bump: **1 suite / 3 tests failed** in `expo-sdk-pins.test.ts` because the SDK table had moved. After aligning all 14 pins: **101 suites, 1 191 tests, all pass**. |
| Decision record | `docs/SECURITY_DEPENDENCY_DECISIONS.md` marks the zod advisory **CLEARED 2026-11-02** (D-11), records the 0-high audit, and leaves `deepmerge` (D-4) plus `glob`/`minimatch` (D-10) as the accepted mobile advisories. |

### Not completed

- `expo install --fix` printed a dynamic-config warning for `expo-sharing`; the plugin's defaults are both disabled (`ios.enabled` and `android.enabled` are false), so no `app.config.js` change was made. The existing sharing behaviour is unchanged.
- No OTA publication was made. The patch is committed as `6631d37` on `chore/expo-58.0.22-zod-patch` and opened as PR #121, whose four checks are green; the separate contributor-cleanup documentation changes remain uncommitted.

### Next priority

- Review and merge PR #121. A native build is required before relying on the new managed native versions; do not publish an OTA across that native change.
- Re-run the mobile audit and tests after any further Expo-managed pin movement.

## 2026-11-02 — Contributor cache refreshed; historical PR refs remain immutable

### Completed and verified

| Item | Evidence |
| --- | --- |
| Stale contributor sidebar | The web sidebar still reported **4** contributors after the default branch was rewritten, while `GET /repos/nreffejzxc/inventory-ai/contributors` returned **2**. Switching the default branch to `chore/reconcile-main-2026-11-01` and back to `main` forced the refresh; signed-in and logged-out incognito loads both then showed **2**. |
| Current contributor list | `nreffejzxc` **452** and `dependabot[bot]` **7**. Neither `jeffernqwerty` nor `codebuff-team` is listed. |
| Default branch | `origin/main` `afd7088`: **0** commits with the retired email, **0** `Co-Authored-By: Codebuff` trailers. No branch-protection change was made in this session. |
| Merged branch | `chore/reconcile-main-2026-11-01` `cb1a52d` and PR #119 `refs/pull/119/head` are clean on both counts; PR #119 author is `nreffejzxc`; merge commit `afd7088`. |
| What still exposes the retired identity | PRs **#99–#106** were opened by `jeffernqwerty`; **18** distinct Codebuff-trailer commits remain reachable from **44** PR refs (**#7–#31**, **#33–#51**); **18** PR refs still contain the retired email (**#98**, **#100–#107**, **#110–#118**). These are immutable `refs/pull/*` objects and PR author metadata. |
| Stale remote branches retired | **Retired 2026-11-02.** `docs/one-location-tenant-record` (12 old-email commits), `fix/stock-in-deep-link` (10), `test/single-location-default` (11) were deleted from origin after tree- and patch-equivalence checks. Their exact tips remain at `refs/pull/116/head`, `refs/pull/117/head` and `refs/pull/118/head`, and in the local branches. |
| Local `main` aligned | Local `main` now points at `origin/main` (`afd7088`), **0 ahead / 0 behind**, with **0** retired-identity commits and **0** Codebuff trailers. The old tip `28ca110` is preserved in `refs/backup/local-main-28ca110` and a verified bundle at `.tmp-main-alignment-2026-11-02/local-main-28ca110.bundle`. |
| Support request | Submitted **2026-11-02 01:44 GMT+8** as ticket **#4936796**; GitHub Support closed it at **01:45** because the account's available resources are Community Discussions, Docs and Skills (self-service). No redaction was performed. The prepared wording remains at [`support/github-attribution-redaction-request.md`](support/github-attribution-redaction-request.md). |

### Support ticket

Ticket **#4936796** was opened on 2026-11-02 at 01:44 GMT+8 and closed at 01:45. GitHub Support (Ivy) replied that the account's available resources are GitHub Community Discussions, GitHub Docs and GitHub Skills. Because those are self-service resources, the ticket was closed. No redaction was performed, so the historical PR and commit attributions remain.

### Not completed

- The historical PR author and Codebuff co-author displays were not removed. GitHub pull refs are read-only and commit metadata is part of the object; no Git-side operation can change them.
- GitHub Support closed the request without action; no GitHub settings were changed.
- The local branch and worktree copies were retired on 2026-11-02 after backup; only the remote PR metadata remains outside Git's reach.

### Findings

- The contributor sidebar is a cached view. The REST API was already correct at 2 before the web view changed; the default-branch toggle invalidated the cache.
- PR #104 is the one closed-unmerged old PR; the other seven in #99–#106 were merged. Their PR pages still name the old author even though `main` no longer contains their commits.
- Counting identities across `--all` over-matches merge subjects such as `Merge pull request #101 from jeffernqwerty/...`; only the author/committer fields should be counted. The precise count is 30 commit objects with the retired email across all local refs; 11 were on the old local `main` before alignment and remain in the backup ref.
- This supersedes the 2026-11-01 contributor-residue measurement: the API now reports **2**, not **435 / 12 / 7**. The older entry is left unchanged as the record of what was observed before the cache refresh.

### Stale branch review

| Branch | Tip | Landed as | Tree parity | Decision |
| --- | --- | --- | --- | --- |
| `docs/one-location-tenant-record` | `48a4fe2` | `5d74f8e` (#118) | `git diff --quiet` equal | Retire |
| `fix/stock-in-deep-link` | `092c79a` | `a3b0240` (#116) | `git diff --quiet` equal | Retire |
| `test/single-location-default` | `143fa5c` | `95ae43b` (#117) | `git diff --quiet` equal | Retire |

All branch-only commits are patch-equivalent on `main` (`git cherry` all `-`); the three tip patches have the same patch IDs as `95e41da`, `68aa210` and `cdc9f0d`. The exact old commits remain at `refs/pull/116/head`, `refs/pull/117/head` and `refs/pull/118/head`, so deletion loses no work. Rewriting would only create new SHAs for already-merged history; retire instead. All three were deleted on 2026-11-02; `git ls-remote` confirmed the branch refs are gone, `git fetch --prune` removed the tracking refs, and the PR refs still resolve to `092c79a`, `143fa5c` and `48a4fe2`. The local copies were retired in the same cleanup; their tips, and the four worktree snapshots, are preserved under `refs/backup/`.

### Local branch and worktree cleanup

The 16 local branches whose reachable history contained the retired email or a Codebuff trailer were deleted after every tip was asserted equal to its `refs/backup/local-branches-2026-11-02/<branch>` ref; the merged `chore/reconcile-main-2026-11-01` (`cb1a52d`) was deleted with them. The four linked worktrees were removed only after their uncommitted states matched the `refs/backup/worktree-wip-2026-11-02/*` snapshots exactly; `.tmp-owner-access` was clean. `git worktree list` now names only the main checkout.

| Check | Result |
| --- | --- |
| Deleted branches | **17** — 16 identity-carrying plus the merged reconciliation branch |
| Worktrees | **4** removed; no linked worktree remains |
| Backup refs | **17** tips under `refs/backup/local-branches-2026-11-02`; **4** WIP snapshots under `refs/backup/worktree-wip-2026-11-02` |
| Bundle | `local-cleanup-complete-2026-11-02.bundle`; `git bundle verify` reports "records a complete history"; **22** backup refs in the bundle |
| Remaining local branches | **15**, all scanning **0/0** for the retired email and Codebuff trailers; 13 stale clean-identity branches and `wip/backup-working-tree` are left alone |
| PR refs | **118** remote `refs/pull/*/head` on `origin`; the 12 spot-checked (#99–#106 and #116–#119) all resolve. The local repository holds no `refs/pull/*`, so none were deleted locally. |

The uncommitted documentation edits (this log and `docs/support/github-attribution-redaction-request.md`) remain in the working tree on `main`; the exact state is also preserved at `refs/backup/worktree-wip-2026-11-02/main-docs` (`5b61f76`).

### Next priority

- Do not resubmit the support request unless the account's support tier changes; ticket #4936796 confirmed the historical metadata is not actionable through support.
- Keep local `main` pinned to `origin/main`; the stale tip is preserved only in the local backup ref.
- The remote and local branch retirement is complete. Keep the backup refs and bundle until the old PR metadata is no longer needed; do not re-create a branch from them.

## 2026-11-01 — GitHub identity cleanup: `main` rewritten to `5d74f8e`

### Completed and verified

| Item | Evidence |
| --- | --- |
| Targeted metadata rewrite | 454 commits: **433 unchanged**, **21 rebuilt**, **12** author/committer emails changed, **9** merge commits above them. No tree, message, name, date or parent-count changes; HEAD tree `1373a117f890386f8765b331fd6bd873e153f356`. |
| Signature cost | 50 signed commits before, 41 after: only the 9 rebuilt GitHub merge commits lost their web-flow signatures, which could not remain valid after their parents changed. |
| Force-push and CI | `git push --force-with-lease` moved `main` `e687184` → `5d74f8e`; run [41296545346](https://github.com/nreffejzxc/inventory-ai/actions/runs/41296545346) is **success** for `secret-guard`, `attribution-guard`, `server` and `mobile`. |
| Protection restored | Temporary `allow_force_pushes=true` / `enforce_admins=false`; the restore PUT verified against the saved original: force pushes **disabled**, admins **enforced**, four required checks, PR required. |
| Attribution at the commit API | `11fcefad15` (one of the 12) now reports `author.login = nreffejzxc`; the new `main` tree matches the pre-rewrite tree. |
| Backup | Verified bundle at `.tmp-attribution-rewrite-2026-11-01/pre-rewrite-main.bundle`; temporary branch `backup/main-before-attribution-rewrite-2026-11-01` was deleted after CI. |
| Contributor residue | After the 60-second cache window the contributors API still reports `nreffejzxc 435`, `jeffernqwerty 12`, `dependabot[bot] 7`. The 12 old commits remain reachable through `refs/pull/110`–`118` and the merged branches `docs/one-location-tenant-record`, `fix/stock-in-deep-link` and `test/single-location-default`; PRs #99–#106 still name the retired account as author. |
| Reconciliation branch | Replayed the three local commits onto `5d74f8e`; new head `ee7e710`. Both retired email fields changed; trees, messages, names and dates are identical to the backed-up branch; **3 ahead / 0 behind before this documentation commit**. The full map is in `.tmp-attribution-rewrite-2026-11-01/branch-splice-map.txt`. |
| Delivery | The three replayed commits plus this documentation commit are delivered through the branch PR; CI is the gate. |

### Not completed

- The contributor-list residue cannot be removed by rewriting the default branch alone. It needs the merged PR refs/branches deleted, or a GitHub support action; neither was approved.
- The reconciliation branch is delivered through its PR; the contributor-list residue remains open.

### Next priority

- Review and push the reconciliation branch through the normal PR and CI path, then decide whether the old merged branches and PRs should be deleted or retained as history.

## 2026-11-01 — Repository identity aligned to the restored account

### Planned

- Resolve the mismatch between the repository-local Git email and the account restored on 2026-10-31.
- Align `CLAUDE.md` and the attribution guard to the chosen account without rewriting history.

### Completed and verified

| Item | Evidence |
| --- | --- |
| Chosen account read from the live session. | `gh auth status` lists only `nreffejzxc`; `git remote -v` is `nreffejzxc/inventory-ai`; the runbook and the `CLAUDE.md` identity block agree. |
| Repository-local Git identity. | `user.name` is `jeffernzxc`; `user.email` is now `jefferndullamalinaozxc@gmail.com` (was the retired `jeffernmalinaoqwe@gmail.com`). |
| `CLAUDE.md` §20. | The stale Git-identity line now names the restored email; the canonical identity block already did. |
| Attribution guard. | No edit was needed: `ALLOWED_LINES` and the self-test already name the restored email. `BASE_SHA=origin/main node scripts/check-commit-attribution.mjs` reads both commits, self-test **17/17**, exit 0. |
| Existing commits. | `8aae1b3` and `f93327d` still carry the retired email. They were not rewritten: rule 9 requires an explicit request for a history rewrite. |

### Not completed

- Rewriting the two local commits' author and committer fields. They are unpushed; this needs explicit approval.
- Nothing was pushed.

### Findings

- `main` itself carries both identities: direct commits use the retired email and merge commits use `nreffejzxc`'s GitHub noreply address. The branch's two local commits add to that mix; they will carry the restored identity only after an approved rewrite.

### Attribution audit (Git and GitHub)

| Item | Result |
| --- | --- |
| GitHub access | `nreffejzxc` is the only owner and collaborator; no pending invitations; no other human PR author, reviewer or commenter. |
| Contributors API | 435 `nreffejzxc`, 12 `jeffernqwerty`, 7 `dependabot[bot]`; no unlinked authors. The 12 are the 1 November direct commits using the retired email. |
| Public commit trailers | None on `origin/main`: no AI co-author or generated-by line. The only trailers are 7 Dependabot lines. |
| Retired-account PRs | 8 PRs (#99–#106; seven merged, #104 closed unmerged) and one comment on #104 still display `jeffernqwerty`. GitHub does not allow a PR author to be changed. |
| Local-only attribution | 7 Codebuff co-author trailers in two backup refs; `.git/pre-rewrite-backup.bundle` (3.9 MB) holds 91 Claude Code and 5 Codebuff trailers. None is on a remote. |
| Rewrite gate | The 12 commits plus 9 merge commits (21 total) would get new SHAs. Branch protection forbids force pushes even for admins, so a metadata rewrite needs a temporary protection change and explicit approval. |
| Not done | No history rewrite, force-push, settings change, PR/comment deletion or backup deletion. |

### Next priority

- Decide the missing-`zod` gate, then push the reconciled branch through the normal PR and CI path; rewrite the two local commits first if that is wanted.
- Decide whether to approve the 21-commit metadata rewrite; the current branch's two retired-email commits must be rewritten before it is pushed.

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
- The identity question raised here was resolved later on 2026-11-01 in favor of the restored account; see the entry above. The two reconciliation commits still carry the retired email because they predate the fix.
- Nothing was pushed; the commit is local.
- Four registered `.tmp-*` worktrees and several untracked scratch files remain. They were left untouched because they may hold pending work; their copies of that comment are what the main-checkout guard reads.

### Findings

- The `zod` watch returns `UNPARSED` rather than a pass because the admitted CLI's `zod` dependency is absent, not because the registry was unreachable. The conservative rule treats a missing range as unreadable. Whether an absent dependency should mean the advisory is closed by removal is a decision for the next session.
- The verification ran on Node **26.10.0**, while the repository pins **24** in `.nvmrc`. The suite passed, but the runtime is outside the pin.

### Next priority

- Decide the missing-`zod` gate, then push the reconciled branch through the normal PR and CI path.

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
