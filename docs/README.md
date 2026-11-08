# The `docs/` folder

Four kinds of writing live here. Knowing which is which saves time:

- **Guides** — written to be *followed*. They say what to type and what you should see.
- **Reference** — written to be *consulted*. They state what the system is and must stay true.
- **Records** — written *once*, dated, with evidence. They say what happened. They are long on
  purpose, and **you never need to read them to use or change the project.**
- **Status** — written to be *current*. It says what is being worked on, what is half-done, and
  what comes next. It is the one document here that is edited every session.

---

## 1. Start here — the plain-English guides

[`guides/`](guides/README.md) is a small self-contained set for readers with limited technical
background; terms are explained where they appear, and nothing there contradicts the reference
documents.

| Guide | For |
| --- | --- |
| [guides/README.md](guides/README.md) | Which guide do I need? |
| [1-run-on-your-laptop.md](guides/1-run-on-your-laptop.md) | Starting the backend and the app, and proving they work |
| [2-run-on-your-phone.md](guides/2-run-on-your-phone.md) | Getting the app onto a real Android phone and mirroring it over USB |
| [4-test-accounts-and-mock-data.md](guides/4-test-accounts-and-mock-data.md) | Which accounts exist, what data each one holds, and what the sample data contains |
| [5-words-explained.md](guides/5-words-explained.md) | Glossary, A–Z |
| [6-scripts-and-commands.md](guides/6-scripts-and-commands.md) | Every command that is not about data: start, check, measure, maintain |
| [7-over-the-air-updates.md](guides/7-over-the-air-updates.md) | Publishing an update without a rebuild, and rolling one back |
| [8-play-store-submission.md](guides/8-play-store-submission.md) | Building and submitting the Android release |
| [9-seeding-development.md](guides/9-seeding-development.md) | Putting data into the development database: the commands, the database rule, the two phrases, verification |
| [10-seeding-production.md](guides/10-seeding-production.md) | Putting data into the production database: the three phrases, the named tenants, what is refused |
| [11-deleting-development.md](guides/11-deleting-development.md) | Taking data out of the development database: wipes and tenant cleanups, what is verified |
| [12-deleting-production.md](guides/12-deleting-production.md) | Taking data out of the production database: the same rules, and the space a delete does not free |
| [13-firebase-identities.md](guides/13-firebase-identities.md) | Which commands create logins, and how to delete one without locking an account out |
| [15-wireless-phone-session.md](guides/15-wireless-phone-session.md) | Starting the app and mirroring it over Wi-Fi, including the one-command helper |
| [16-openrouter-models.md](guides/16-openrouter-models.md) | Choosing a free or paid OpenRouter model, setting its reasoning, and proving it works |
| [17-web-search-and-fetch.md](guides/17-web-search-and-fetch.md) | Enabling or disabling OpenRouter web search and web fetch independently, and proving the setting |

The numbered filenames are stable links. Guides 3 and 14 were consolidated into Guide 2, Guides 9–13 and
Guide 6; no rule, command or safety procedure was removed.

## 2. What the system is — reference

| Document | Answers |
| --- | --- |
| [`../CLAUDE.md`](../CLAUDE.md) | The project's working contract: architecture rules, security rules, phase index |
| [`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md) | **The primary source of truth** for behaviour — data, rules, roles, APIs |
| [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md) | How identity, sessions, verification and recovery are meant to work |
| [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) | The security invariants, control status, open decisions and gates |
| [`SECURITY_DEPENDENCY_DECISIONS.md`](SECURITY_DEPENDENCY_DECISIONS.md) | Advisories accepted rather than patched, and when that ends |
| [`SOURCE_PROTECTION.md`](SOURCE_PROTECTION.md) | What protects the source, what does not, and the public-window caveat |
| [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) | The current owner and repository, the paused migration decision, provider anchors, read-only checks and approval gates |
| [`FIREBASE_CREDENTIAL_RUNBOOK.md`](FIREBASE_CREDENTIAL_RUNBOOK.md) | The Firebase Admin credential: where it comes from, how it is stored, verified and rotated |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | The mobile visual language: tokens, type, primitives, accessibility rules |
| [`DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](DEVELOPING_ON_A_PHYSICAL_DEVICE.md) | The deep phone reference: verified commands, log reading, failure → fix |
| [`../README.md`](../README.md) | The front door: stack, layout, how to run each half, deployment |

### Review cadence

Reference documents are consulted rather than read once, so they are reviewed on a clock.
`node scripts/check-docs.mjs` fails when one is overdue; this table is the only place its date lives.

| Document | Cadence | Last reviewed |
| --- | --- | --- |
| [`../CLAUDE.md`](../CLAUDE.md) | 90 days | 2026-11-07 |
| [`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md) | 90 days | 2026-11-07 |
| [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md) | 90 days | 2026-11-07 |
| [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) | 90 days | 2026-11-07 |
| [`SECURITY_DEPENDENCY_DECISIONS.md`](SECURITY_DEPENDENCY_DECISIONS.md) | 30 days | 2026-11-07 |
| [`SOURCE_PROTECTION.md`](SOURCE_PROTECTION.md) | 90 days | 2026-11-07 |
| [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) | 90 days | 2026-11-07 |
| [`FIREBASE_CREDENTIAL_RUNBOOK.md`](FIREBASE_CREDENTIAL_RUNBOOK.md) | 90 days | 2026-11-07 |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | 90 days | 2026-11-07 |
| [`DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](DEVELOPING_ON_A_PHYSICAL_DEVICE.md) | 90 days | 2026-11-07 |
| [`../README.md`](../README.md) | 90 days | 2026-11-07 |

The 2026-11-07 date starts each clock at adoption: it records when the cadence began, not that every
document was re-read that day. A review updates the date; a change that materially rewrites a document
counts as its review. `SECURITY_DEPENDENCY_DECISIONS.md` is the one tighter row because advisories
move weekly; the rest are quarterly.

## 3. What happened — records

Written once and then left alone, because their value is that they still say what was true on the
date they were written. **Read them for an audit, not for orientation.**

| Document | Records |
| --- | --- |
| [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) | Every increment, in order, with its evidence — over 20,000 lines. Find a record by number; `CLAUDE.md` indexes all of them by title |
| [`PHASE_HISTORY.md`](PHASE_HISTORY.md) | One line per phase, with the roadmap record it points to |
| [`TS-MIGRATION-MANIFEST.md`](TS-MIGRATION-MANIFEST.md) | The completed TypeScript migration and the one module left in JavaScript |
| [`AI_LANGUAGE_REVIEW_14_2026-11-06.md`](AI_LANGUAGE_REVIEW_14_2026-11-06.md) | The dated native-speaker review sheet for 14 assistant answers; scores stay blank until a reviewer fills them |
| [`superpowers/`](superpowers/) | Dated plans and design specs written before work began |
| [`evidence/`](evidence/device-runs/README.md) | Device runs, scale measurements and captured output |
| [`freebuff/`](freebuff/README.md) | An older agent-activity log. Forensic only — not architecture, history or specification, and its status statements are frozen at their dates |

At the repository root: [`../SECURITY.md`](../SECURITY.md) — how to report a vulnerability and what is
in scope.

## 4. Where we are now — the living log

| Document | Answers |
| --- | --- |
| [`DEVELOPMENT_LOG.md`](DEVELOPMENT_LOG.md) | What is being worked on now, what each session finished and verified, what is blocked, what is next — plus the resource budgets (EAS builds, OTA, CI minutes) |

It is newest-first and is updated at the end of every development session. It does **not** replace
the roadmap: the roadmap records what shipped, with measurements; the log records what is true
today. When the two disagree, the roadmap's newest record is the evidence and the log is corrected
in a new entry.

---

## Keeping this map true

A change should update the document that owns the question, not every document that mentions it:

| You changed | Update |
| --- | --- |
| A rule, API, data shape or user-visible behaviour | `SYSTEM_SPECIFICATION.md`, and the guide a reader follows for that task |
| A command, script or CI job | Guide 6, plus the task guide that uses it |
| The phone workflow | Guides 2 and 15; `DEVELOPING_ON_A_PHYSICAL_DEVICE.md` only for depth they do not carry |
| Authentication design, a session or recovery rule | `AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md` |
| A security invariant, control status, decision or gate | `AUTH_SECURITY_MASTER_CHECKLIST.md` |
| A credential, key or provider secret | `FIREBASE_CREDENTIAL_RUNBOOK.md` |
| A release, OTA or store step | Guides 7 and 8 |
| A decision with a trade-off | a dated `DEVELOPMENT_ROADMAP.md` record; `CLAUDE.md` only if it binds future work |
| Anything finished, blocked or next | `DEVELOPMENT_LOG.md`, in the same session |

The test for an edit: could a reader acting on this document be misled? If yes, fix it now. Delete a
section when another document answers its question better; keep the **why** even when the code makes
the **how** obvious.

## The maintenance loop

`node scripts/check-docs.mjs` is the map guard. It fails when a top-level `docs/*.md` page or a
guide is not linked here, when a map link points at a missing file, or when an invariant row is
declared outside the one register. It runs in the required `server` CI job before dependencies are
installed, so a documentation-only change is checked without a database or a server install. It also
fails when a living reference document is past the review cadence in §2.

At the close of every session:

1. Update `DEVELOPMENT_LOG.md` and the document that owns the change.
2. Commit, push, open the pull request and wait for all four required checks.
3. Squash-merge, then `git switch main && git pull --ff-only`.
4. Run `node scripts/check-repo-state.mjs`; it must report a clean `main` level with `origin/main`.

The full branch, commit, check and merge loop is [`../CONTRIBUTING.md`](../CONTRIBUTING.md). The pull
request template asks for the documentation impact, so "no docs change" is a decision, not an
omission.

## Two rules before you edit here

1. **Five paths are protected and must not be edited**: `mobile/eas.json`,
   `server/src/services/ai/providers/http.ts`, `server/test/phase06-ai-wire.test.mjs` and two dated
   plans under `superpowers/`. The list, with its git blob hashes, is in
   [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) §8. **The check is
   manual** — no script verifies them — so re-check them yourself before and after meaningful work.
2. **Dated records are append-only.** When reality changes, add a new entry; do not rewrite an old
   measurement. A later entry saying "superseded, see §27X" preserves the history; editing the
   earlier text destroys it. The guides and the reference documents are ordinary prose and should be
   reworded whenever they stop being clear — that is what this revision did.

## Reading rule

Start with [`../README.md`](../README.md) for the shape of the system and the guides for a task. When
a record and the code disagree, the code and the specification win, and the old record is corrected
by a new entry rather than by editing it.
