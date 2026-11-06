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

**Updated:** 2026-11-06
**Goal:** finish and harden Inventory AI **V1** through production testing. No Play Store or App
Store release is being prepared.

**Docs maintenance:** On 2026-11-06 the active guide set was consolidated, the device reference and
the specification's obsolete planning tail were trimmed, and a documentation-link guard was added;
see the documentation entries below. The auth checklist and account runbook now state current
decisions; Guides 9, 11, 12 and 13 keep their commands and safety rules, with the phrase matrix owned
by Guide 10 and dated measurements removed; the auth architecture and checklist keep one invariant
register and one status owner, with overlapping client-authority and email clauses narrowed to one row
each. The AI-48–AI-84 work is recorded in §27HQ and §27HS.

| | |
| --- | --- |
| **Working now** | AI-48–AI-84 is merged to `main` (`98a4282`) and deployed: production `/api/health` reports `98a4282`. The change delivered grounded answers, recorded currency and specifications, scoped stock/value/history reads, dead-stock routing, revenue qualification, keyless research, and the member-language policy. Phone verification is still pending. |
| **Just verified** | PRs #156–#159 passed all four required checks; documentation guards **39/39**; `git diff --check` clean. The deployed product commit remains `98a4282`: `/api/health` reports `status: ok`, `db: connected`. |
| **Blocked** | Phone observation of the deployed AI behavior and the 60 s research-budget check remain; no EAS build or OTA was spent. |
| **Next after this** | Exercise the assistant on the phone against the deployed commit, then decide whether the research budget needs an operator change. |

### Open items carried forward

| Item | State | Why it is open |
| --- | --- | --- |
| Single-location default, on a real device | Ready, phone pending | The production tenant `6ae6f1d8baa72cee39730240` now has exactly one ACTIVE location, and §27HF pins the late-arriving list for all three kinds; the visual check needs the owner to sign in on the phone |
| AI-42 live answer | Resolved 2026-11-02 | `getInventoryHistory` folds a transfer into one `from`/`to` event; the server reports `1c1734b` and the phone answered **From: Main Warehouse, To: Shop Front**, 2 units, once — [evidence](evidence/ai42-transfer-2026-11-02/README.md) |
| Brand and specification fields | Deployed; phone verification pending | The product records an optional `brand` (max 80) and, since AI-48, an optional `specifications` string (max 1,000). Both seeders write real sourced rows; the assistant searches and researches specifications. Production now runs the post-AI-48 schema; the phone check is still pending, and there is still no rating or review field. |
| `glob` and `minimatch` advisories | Deferred, D-10 | Patched `14.0.2` / `11.0.1` are majors outside every consumer's range; re-check the gates in `SECURITY_DEPENDENCY_DECISIONS.md` §4 |
| `zod` high advisory | Resolved 2026-11-02 | Cleared by `expo@58.0.22`; the nested `zod@3.25.76` is gone and the mobile audit reports **0 high** |
| `deepmerge` low advisory | Deferred | No fix inside the consumer's declared range; do not force versions |
| OTA code signing | Blocked by EAS plan | Free plan only; a signed binary would reject unsigned publishes |
| Play release | Not started, deliberately | V1 testing first |
| L-17 password-reset action URL | Open, console-only | Cannot be set from code |
| iOS device acceptance | External verification required | No macOS on the development host |
| GitHub contributor residue | Default branch clean; historical refs remain | The contributors API returns exactly **nreffejzxc 452** and **dependabot[bot] 7**. `main`'s five merge subjects were rewritten to `nreffejzxc`, and no merge subject names `jeffernqwerty`. Two non-merge documentation commit messages still quote the old login as historical context. PRs #99–#106 still show `jeffernqwerty` as author, and 18 Codebuff commits remain in 44 old PR refs; Git cannot rewrite either. The surgical rewrite preserved **38** of **42** commit signatures; **4** signed descendants lost theirs. Ticket #4936796 was closed without action because this account only has self-service resources. At the rewrite, local `main` matched `origin/main` (`d6bdbc35`); the old tip `afd7088` is preserved at `refs/backup/main-before-merge-subject-rewrite-afd7088` and in a verified bundle. The superseded `af44b60` pass is preserved at `refs/backup/main-before-signature-preserving-rewrite-af44b60` and in `main-af44b60.bundle`. The 16 identity-carrying local branches and four linked worktrees were retired after their tips and dirty states were saved under `refs/backup/local-branches-2026-11-02` and `refs/backup/worktree-wip-2026-11-02`. The 13 stale clean-identity branches were retired on 2026-11-02 after merged/ancestor/superseded checks, with each tip saved under `refs/backup/local-branches-retired-2026-11-02`; the merged work branches and the WIP backup remained locally at that point. On 2026-11-06, after their PRs were confirmed merged, 13 further local branches and 14 remote branches were retired; the #159 branch was deleted on merge. Only `main`, `wip/backup-working-tree` and the two open Dependabot refs remain; `main` is level with `origin/main`. |
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

## 2026-11-06 — Documentation queue merged and merged branches retired

| Item | Evidence |
| --- | --- |
| **Why** | The three documentation PRs were green but each edited the shared log block, and merged topic branches remained locally and on `origin`. |
| **Merged** | #156 `5021636` (AI-50–AI-84 register), #157 `dffa2da` (guide phrase and measurement trim), #158 `016326b` (auth invariant dedupe), and #159 `46397f9` (summary correction). The log conflicts kept every entry and the combined maintenance summary. |
| **Repository** | 13 pre-existing merged local branches and 14 merged remote branches were retired after their PRs were confirmed; the #159 branch was deleted on merge. `wip/backup-working-tree` was kept, and the only other remote refs are the two open Dependabot branches. |
| **Verified** | PRs #156–#159 passed `server`, `mobile`, `secret-guard` and `attribution-guard`; post-merge `main` CI `42291758396` passed all four jobs on `46397f9`; documentation guards **39/39**; `git diff --check` clean. |
| **Not done** | No product code, prompt, test, configuration or deployment change. Dependabot #132 remains green but behind; #133 still fails its deliberate Google Sign-In pin test. |

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
