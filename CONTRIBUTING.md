# Contributing to Inventory AI

The repository is the record. A requested change is finished when the owner-authorized scope is
complete and verified. When the owner explicitly requests a full delivery, the owning document (only
if that documentation work was requested) is updated, the required checks pass, the pull request is
merged, and `main` is clean and level with `origin/main`.

[`docs/README.md`](docs/README.md) is the documentation map. This file is the delivery loop around
it.

> **BINDING OWNER-AUTHORIZATION GATE.** The owner's current request defines the entire scope. Nothing
> in this file authorizes work: not a clean tree, a failing check, a stale doc, a roadmap item, a TODO,
> a review comment or an obvious improvement. Do not start a branch, edit a file, add a test, update a
> document, commit, open a pull request, merge or deploy unless the owner explicitly asked for that
> specific action, except for the service/platform operations delegated in `CLAUDE.md` §6.9. When the
> owner asks only to inspect, review, test or verify, make no changes. See `CLAUDE.md` §6; if this
> file conflicts with it, `CLAUDE.md` wins.

### Delegated platform operations

Routine operations on GitHub, Firebase, MongoDB Atlas, OpenRouter, Render, Brevo, Expo, UptimeRobot
and the project's Gmail accounts are delegated; `CLAUDE.md` §6.9 defines that scope and its limits,
including the narrow deletion allowance for disposable test data. Report every service changed, keep
secrets out of the repository and chat, confirm the exact target and effect before anything
destructive or irreversible, and never create, copy or store MFA backup codes.

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

## 2. Change only what the owner requested

The owner's request defines the files that may change. Do not add a test, document, refactor, cleanup,
comment, dependency or configuration change merely because it is related. If the owner did not ask for
a documentation update, do not make one. If an adjacent change is necessary, stop and ask before making
it.

The full ownership table is in [`docs/README.md`](docs/README.md). When the owner explicitly requests a
change that alters one of these areas, update the owning document:

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

## 3. Run the checks required for the requested change

Run the smallest relevant checks for the exact change the owner requested. Do not expand into a broad
audit, add tests or test infrastructure, or fix unrelated failures unless the owner asked for that
work. A check run is evidence for the requested change, not permission to change more files.

When a pull request is explicitly requested, the documentation guard is dependency-free and is the
first check in the required `server` CI job:

```sh
node scripts/check-docs.mjs
```

It also fails when a living reference document is past its review cadence in `docs/README.md`;
update that row's date only after reviewing the document.

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

Every pull request must pass the seven required checks before merge:

- `server`
- `mobile`
- `secret-guard`
- `attribution-guard`
- `webauthn-e2e` — the real-browser MFA proof
- `dependency-review` — fails on a newly introduced high or critical advisory
- `compose-mongo` — boots `compose.yaml`, waits for healthy and pings MongoDB

The `dependency-review` gate compares the pull request with its base; it does not replace
Dependabot alerts, edit a dependency or run `npm audit fix`. A browser limitation in
`webauthn-e2e` is reported, never silently skipped.

Do not bypass a failing check to make a branch mergeable. Fix the cause, or report the blocker.

## 4. Commit and open the pull request — only when explicitly requested

Do not commit, push or open a pull request on your own initiative. When the owner asks for that
separate delivery step, use this sequence:

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
that may appear is the owner's. Commit as the configured `nreffejzxc` identity; if it differs, stop
and report the mismatch rather than changing it silently. See `CLAUDE.md` §16.

The pull-request template asks for the documentation impact, the verification commands and the
repository state. Fill it in; empty checkboxes are not a substitute for evidence.

## 5. Wait for the checks, then merge — only when explicitly requested

Do not merge, delete a branch or deploy on your own initiative. When the owner explicitly asks for the
merge, use this sequence:

```sh
gh pr checks --watch
gh pr merge --squash --delete-branch
```

There is no merge queue. GitHub offers one only to organization-owned repositories, and this
repository stays on the personal account. Because the required checks are strict, update the branch
when `main` moves; then squash-merge. Review is the owner's review: no GitHub approval is required
because the sole owner cannot approve their own pull request.

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

## Definition of done — only for an explicitly requested full delivery

This checklist applies only when the owner asked for the complete branch → pull request → merge
delivery. It does not authorize any step by itself.

- [ ] The change is on a branch based on current `main`, with no unrelated edits.
- [ ] The document that owns the change is updated, and `docs/DEVELOPMENT_LOG.md` records the session.
- [ ] `node scripts/check-docs.mjs` passes; the relevant tests, typecheck and lint pass or are
      explicitly reported as blocked.
- [ ] The pull request is merged with all seven required checks green.
- [ ] Local `main` is clean and level with `origin/main`; `node scripts/check-repo-state.mjs` passes.
