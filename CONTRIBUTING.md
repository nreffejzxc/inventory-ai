# Contributing to Inventory AI

The repository is the record. A change is not finished when it works on this computer; it is
finished when the document that owns it is updated, the checks pass, the pull request is merged, and
`main` is clean and level with `origin/main`.

[`docs/README.md`](docs/README.md) is the documentation map. This file is the delivery loop around
it.

## 1. Start from a clean `main`

```sh
git switch main
git pull --ff-only
git status --short
```

`git status` must print nothing before a new branch starts. If it prints something, finish or park
that work first; do not mix it into the new change.

```sh
git switch -c docs/your-change
```

Use one branch per purpose. Useful prefixes are `feat/`, `fix/`, `test/`, `docs/` and `chore/`.
Never commit directly to `main`, force-push a shared branch, or rewrite a branch someone else is
reviewing.

## 2. Change the code and the document that owns it

The full ownership table is in [`docs/README.md`](docs/README.md). The short version:

| You changed | Update |
| --- | --- |
| A rule, API, data shape or user-visible behaviour | `docs/SYSTEM_SPECIFICATION.md` and the guide a reader follows |
| A command, script or CI job | Guide 6, plus the guide that uses the command |
| Authentication or a security invariant | the auth architecture or checklist, whichever owns that question |
| A decision with a trade-off | a new dated `docs/DEVELOPMENT_ROADMAP.md` record |
| Anything finished, blocked or next | `docs/DEVELOPMENT_LOG.md`, in the same branch |

Rules that keep the set maintainable:

- **Do not add a new document for a question an existing document already owns.** Edit the owner.
- **Do not rewrite a dated record.** Add a later record that supersedes it; the old measurement is
  evidence of what was true then.
- **A new active page must be linked from `docs/README.md`.** The root documentation guard fails
  otherwise. The map is the index, not a suggestion.
- **No documentation change is a decision, not an omission.** Say in the pull request why the change
  does not alter a document a reader relies on.

## 3. Run the checks

The documentation guard is dependency-free and is the first check in the required `server` CI job:

```sh
node scripts/check-docs.mjs
```

For a documentation-only change, also run the documentation tests from `server/`:

```sh
cd server
node --test \
  test/docs-links.test.mjs \
  test/phase-docs-fact-drift.test.mjs \
  test/phase-docs-section-integrity.test.mjs \
  test/phase-docs-route-inventory.test.mjs
```

For a code or configuration change, run the relevant workspace checks in full:

```sh
cd server
npm run typecheck
npm run lint
npm test

cd ../mobile
npm run typecheck
npm run lint
npm test
```

The full server suite needs `MONGODB_URI`; use `npm run test:unit` when no database is available and
say so in the pull request. Do not report a check as passed if it was skipped, blocked or not run.

Every pull request must pass the four required checks before merge:

- `server`
- `mobile`
- `secret-guard`
- `attribution-guard`

Do not bypass a failing check to make a branch mergeable. Fix the cause, or report the blocker.

## 4. Commit and open the pull request

```sh
git add <the files you changed>
git diff --cached --check
git diff --cached
git commit -m "docs: describe the change in one line"
git push -u origin HEAD
gh pr create --fill
```

A good commit subject is imperative and specific. The body explains *why* when the reason is not
obvious. Do not use `git add .` without reading the result, and do not add generated output, local
environment files or credentials.

This repository has a project-specific attribution policy: **no AI co-author trailer, no
generated-by footer, and no tool identity in commits, branches or pull requests.** The only identity
that may appear is the owner's. Commit as the configured `jeffernzxc` identity; if it differs, stop
and report the mismatch rather than changing it silently. See `CLAUDE.md` §16.

The pull-request template asks for the documentation impact, the verification commands and the
repository state. Fill it in; empty checkboxes are not a substitute for evidence.

## 5. Wait for the checks, then merge

```sh
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Squash merge is the repository convention. The pull request number lands in the resulting subject as
`(#N)`. A docs-only or mobile-only merge does **not** trigger Render, because Render deploys only
when a file under `server/` changes. A merge that touches `server/` is a production change; treat it
as such.

## 6. Close on a clean, synchronized `main`

```sh
git switch main
git pull --ff-only
node scripts/check-repo-state.mjs
```

The close-out script fetches `origin/main`, then fails if the worktree is dirty, if `main` is ahead
of or behind the remote, or if the checkout is not on `main`. Its success line is the definition of
a finished session:

```text
[repo] clean main at <sha>; level with origin/main (<sha>).
```

If work cannot be merged yet, **push the branch and open a pull request**. Do not leave it only in the
working tree. Say in the pull request what is blocked and what would unblock it; a pushed branch is
recoverable, an uncommitted folder is not.

## Definition of done

- [ ] The change is on a branch based on current `main`, with no unrelated edits.
- [ ] The document that owns the change is updated, and `docs/DEVELOPMENT_LOG.md` records the session.
- [ ] `node scripts/check-docs.mjs` passes; the relevant tests, typecheck and lint pass or are
      explicitly reported as blocked.
- [ ] The pull request is merged with all four required checks green.
- [ ] Local `main` is clean and level with `origin/main`; `node scripts/check-repo-state.mjs` passes.
