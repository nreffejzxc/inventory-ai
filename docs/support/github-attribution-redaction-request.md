# GitHub Support request — historical contributor attribution redaction

**Prepared:** 2026-11-02
**Status:** Submitted as ticket **#4936796**; closed by GitHub Support on 2026-11-02 without action.
**Repository:** https://github.com/nreffejzxc/inventory-ai (public)
**Canonical owner:** `nreffejzxc` <jefferndullamalinaozxc@gmail.com>

## Purpose

Ask GitHub Support to remove two retired contributor identities from historical pull-request and commit displays:

- Login `jeffernqwerty` (also displayed as `Jeffernqwerty` and `Jeffern Malinao`, email `jeffernmalinaoqwe@gmail.com`)
- Login `codebuff-team` (displayed as `Codebuff`, trailer `Co-Authored-By: Codebuff <noreply@codebuff.com>`)

This is an attribution-only request. No code, file contents, commit contents, pull-request discussion, or branch protection should change.

## Submission result

- **Ticket:** #4936796
- **Opened:** 2026-11-02 01:44 GMT+8
- **Closed:** 2026-11-02 01:45 GMT+8
- **Response:** GitHub Support (Ivy) said the account's available resources are GitHub Community Discussions, GitHub Docs and GitHub Skills. Because those are self-service resources, the ticket was closed.
- **Outcome:** No redaction was performed; the historical PR and commit attributions remain.

## Current state

| Surface | State |
| --- | --- |
| Default branch `main` (`afd7088`) | Clean — no retired email, no Codebuff trailer |
| Merged branch `chore/reconcile-main-2026-11-01` (`cb1a52d`) | Clean — no retired email, no Codebuff trailer |
| PR #119 (merged as `afd7088`) | Clean; author `nreffejzxc` |
| Contributors API | Exactly 2: `nreffejzxc` (452), `dependabot[bot]` (7) |
| Historical PR refs | Still contain the retired identity and/or Codebuff trailers |

The default branch was rewritten so its history no longer contains either identity. The contributor sidebar was refreshed and now shows only the canonical owner and Dependabot. The remaining displays come from immutable `refs/pull/*` refs and pull-request author metadata, which cannot be edited from the repository settings or by pushing.

## Evidence

### PRs opened by `jeffernqwerty`

| PR | State | Retired-email commits in PR head |
| --- | --- | --- |
| [#99](https://github.com/nreffejzxc/inventory-ai/pull/99) | Merged | 0 (author metadata only) |
| [#100](https://github.com/nreffejzxc/inventory-ai/pull/100) | Merged | 1 |
| [#101](https://github.com/nreffejzxc/inventory-ai/pull/101) | Merged | 2 |
| [#102](https://github.com/nreffejzxc/inventory-ai/pull/102) | Merged | 7 |
| [#103](https://github.com/nreffejzxc/inventory-ai/pull/103) | Merged | 4 |
| [#104](https://github.com/nreffejzxc/inventory-ai/pull/104) | Closed, unmerged | 11 |
| [#105](https://github.com/nreffejzxc/inventory-ai/pull/105) | Merged | 8 |
| [#106](https://github.com/nreffejzxc/inventory-ai/pull/106) | Merged | 10 |

The counts include commits carried in the PR head from the pre-rewrite base history. They are visible on the PR's **Commits** tab and on individual commit pages.

### Codebuff co-author trailers

`Co-Authored-By: Codebuff <noreply@codebuff.com>` remains in **18 distinct commits**, reachable from **44 historical pull-request refs**:

- PR **#7–#31**
- PR **#33–#51**

The full set of affected commits:

| Commit | Subject |
| --- | --- |
| `0c546130c05a408fbcd627de5df0a30872b6c268` | docs: record AUTH-01/02/03, the CI quality gate and the merged state |
| `12633e9a9a6b9e164e67541f21bd008d5a0adced` | fix(verify): give verify:demo an exit-code contract that separates "broken" from "could not look" |
| `1bbecdc0fab2e5a9dce34bb1b6bf271f0d4b9299` | docs: record the verifier's exit-code contract in §27BK |
| `33ab09cdac60933ea16198dc9ec30fd0e5088f7e` | Record the owner-only access audit, its measurements, and what it cannot cover (#31) |
| `3686cb96bc8de84b870880582151f4c85b623183` | feat(ai): AI-1..AI-4 — turn budget, degraded turns, query scale, rendered answers |
| `4af737babe729f1143ef53091aa93b12dfb03b94` | feat(ai): answers a member can finish reading, and the assistant measured on the phone |
| `4b4f93962942f4d36d266cce23a707ed420bb3b6` | feat(ai): AI-5 — a turn reports its own cost, so latency is legible per turn |
| `562107bdd009c2fad01678be71cbf9e136d4b082` | feat(seed): a reusable 80 000-record demo seeder, and a verifier that checks it |
| `7386da4a1523c1defbc6c6510973fa5321293e55` | test(indexes): prove the declared indexes are BUILT, and close an unguarded one |
| `99e1eac985609047e2b21141b55b0c06c027b42d` | Add an owner-only access monitor, pin workflow actions, deepen the audit trail (#28) |
| `a32c609d24f101733af067cd48fd54419fc87650` | chore(server): refresh the lockfile's firebase-admin dependency tree |
| `a530282e6ddcc7949677b9119b141293cc8b7840` | Add an owner-only access monitor, pin workflow actions, deepen the audit trail |
| `b7aa4acb86629d7426e492835a45f60eefa9ca28` | Simplify the workflow: weekly dependency policy, two fewer workflows, leaner instructions |
| `b7ad25b37b1dd21c91f56667e46ed7f5cac5740f` | Record the owner-only access audit, its measurements, and what it cannot cover |
| `c2a4406747e383505294c32623d85e843b91f248` | docs: record the public visibility change and the applied branch protection |
| `d2d6bcf9d9e628ce28389572a0bcc737c6aeca4e` | ci: detect a push to main that bypassed the pull-request flow |
| `d4153350fe6205c1d202587c02f26ad6c42376f6` | ci: provide the test JWT_SECRET the server suite requires |
| `e00ba97e581a2125e26c6a1e2e360a3fd455dc63` | Simplify the workflow: weekly dependency policy, two fewer workflows, leaner instructions (#33) |

None of these commits is reachable from `main`.

## What we request

1. **Historical PR author metadata:** remove, redact, or disassociate the `jeffernqwerty` author attribution from PRs **#99–#106** without deleting or altering the PRs, their diffs, discussions, or merged code.
2. **Historical co-author metadata:** remove the `Co-Authored-By: Codebuff <noreply@codebuff.com>` attribution from the commit and PR displays listed above, so `codebuff-team` / `Codebuff` no longer appears as a co-author or contributor.
3. **Durable contributor list:** ensure the repository's contributor data continues to list only `nreffejzxc` and `dependabot[bot]`, and cannot be repopulated from the archived PR refs.
4. **If the exact redaction is not possible:** please state which GitHub-supported mechanism is available — for example account disassociation, display redaction, ref deletion, or a repository-level metadata correction — and what it would affect. If none exists, please say so explicitly so we can record the limitation.

## What we are not asking for

- No changes to source code, file trees, commit contents, or build artifacts.
- No deletion of commits, pull requests, discussions, or branches.
- No force-push and no branch-protection changes.
- No change to `dependabot[bot]`, which is a legitimate bot contributor.
- No disclosure or rotation of credentials; this request contains no secrets.

## Why this cannot be done self-service

- Pull-request refs (`refs/pull/*/head`) are read-only and cannot be force-pushed.
- Commit author and co-author fields are part of the commit object; changing them creates new SHAs and does not update existing PR refs.
- The pull-request author is account metadata, not a Git field; there is no repository setting to reassign or redact it.
- The earlier history rewrite changed `main` only. It did not and cannot change archived PR refs.

## Acceptance criteria

- PRs #99–#106 no longer display `jeffernqwerty`, `Jeffernqwerty`, `Jeffern Malinao`, or `jeffernmalinaoqwe@gmail.com` as author or contributor.
- The 18 listed commits no longer display `codebuff-team` / `Codebuff` as a co-author.
- `GET /repos/nreffejzxc/inventory-ai/contributors` continues to return exactly `nreffejzxc` and `dependabot[bot]`.
- Every file tree and commit diff remains byte-for-byte unchanged.

## Submission path

Submitted on 2026-11-02; the ticket is closed. The steps below are retained for reference only.

1. Sign in to GitHub as `nreffejzxc`.
2. Open https://support.github.com/contact and choose the repository-related category.
3. Paste the ticket body below. If the form prompts for the repository, enter `nreffejzxc/inventory-ai`.
4. Attach the evidence appendix only if Support asks for it. Do not attach credentials or `.env` files.

## Copy-ready ticket body

> Hello GitHub Support,
>
> I own the public repository `nreffejzxc/inventory-ai`. I have rewritten the default branch so it no longer contains two retired contributor identities, and the contributor sidebar now correctly shows only `nreffejzxc` and `dependabot[bot]`.
>
> Two historical surfaces still display the retired identities, and I cannot change them from the repository:
>
> 1. Pull requests #99–#106 were opened by the login `jeffernqwerty` (display names `Jeffernqwerty` / `Jeffern Malinao`, email `jeffernmalinaoqwe@gmail.com`). I am asking to remove, redact, or disassociate that author attribution without deleting the PRs or changing any code.
> 2. Eighteen historical commits reachable from pull-request refs #7–#31 and #33–#51 still contain `Co-Authored-By: Codebuff <noreply@codebuff.com>`, so `codebuff-team` / `Codebuff` still appears as a co-author. I am asking to remove that co-author attribution from the commit and PR displays.
>
> These refs are not on `main`; the default branch at `afd7088` is clean, and the merged branch `chore/reconcile-main-2026-11-01` at `cb1a52d` is clean. I am not asking to change source code, file trees, commit contents, PR discussions, branch protection, or Dependabot.
>
> If GitHub cannot rewrite or redact archived PR refs, please tell me the supported option and its impact, or confirm that no mechanism exists. I would rather record the correct limitation than attempt an unsupported history rewrite.
>
> Thank you.

## Suggested attachment or follow-up

If Support asks for a machine-readable list, attach a text file containing:

- the eight PR URLs;
- the 18 commit SHAs and subjects listed above;
- the 44 PR numbers;
- the output of `GET /repos/nreffejzxc/inventory-ai/contributors`;
- the SHAs `afd7088` (`main`) and `cb1a52d` (merged branch).

Do not attach `.env` files, tokens, or private account credentials.
