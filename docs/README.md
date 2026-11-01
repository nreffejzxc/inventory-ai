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
| [2-run-on-your-phone.md](guides/2-run-on-your-phone.md) | Getting the app onto a real Android phone |
| [3-see-your-phone-on-your-laptop.md](guides/3-see-your-phone-on-your-laptop.md) | Mirroring the phone into a laptop window |
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
| [14-command-runbook.md](guides/14-command-runbook.md) | Every complete development and production invocation in one sheet: seed, verify, clean up, back up |

## 2. What the system is — reference

| Document | Answers |
| --- | --- |
| [`../CLAUDE.md`](../CLAUDE.md) | The project's working contract: architecture rules, security rules, phase index |
| [`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md) | **The primary source of truth** for behaviour — data, rules, roles, APIs |
| [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md) | How identity, sessions, verification and recovery are meant to work |
| [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) | The security invariants, control status, open decisions and gates |
| [`SECURITY_DEPENDENCY_DECISIONS.md`](SECURITY_DEPENDENCY_DECISIONS.md) | Advisories accepted rather than patched, and when that ends |
| [`SOURCE_PROTECTION.md`](SOURCE_PROTECTION.md) | What protects the source, what does not, and the public-window caveat |
| [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) | The verified GitHub state, the single-email policy, and the approval-gated handover plan for Firebase, Atlas, Render and Expo |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | The mobile visual language: tokens, type, primitives, accessibility rules |
| [`DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](DEVELOPING_ON_A_PHYSICAL_DEVICE.md) | The deep phone reference: verified commands, log reading, failure → fix |
| [`../README.md`](../README.md) | The front door: stack, layout, how to run each half, deployment |

## 3. What happened — records

Written once and then left alone, because their value is that they still say what was true on the
date they were written. **Read them for an audit, not for orientation.**

| Document | Records |
| --- | --- |
| [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) | Every increment, in order, with its evidence — over 20,000 lines. Find a record by number; `CLAUDE.md` indexes all of them by title |
| [`PHASE_HISTORY.md`](PHASE_HISTORY.md) | One line per phase, with the roadmap record it points to |
| [`TS-MIGRATION-MANIFEST.md`](TS-MIGRATION-MANIFEST.md) | The completed TypeScript migration and the one module left in JavaScript |
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
