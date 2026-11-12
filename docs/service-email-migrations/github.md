# GitHub — Verified

**Service:** GitHub
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Account:** `nreffejzxc`
**Repository:** `nreffejzxc/inventory-ai` (public)
**Status:** verified for account, repository, remote, merged documentation, local commit identity and email
settings.
**Last checked:** 2026-11-12

## What changed

- The repository is now under `nreffejzxc` at
  `https://github.com/nreffejzxc/inventory-ai.git`.
- The old `Jeffernzxc` profile returns **404**; the new profile and repository return **200**.
- `gh` is authenticated as `nreffejzxc`.
- Local and global Git author/committer identity are `nreffejzxc <jeffernmalinaoqwe@gmail.com>`; `git var`
  reports that identity for both author and committer.
- The new mailbox received GitHub's security notice: “A Google identity was just linked to your GitHub account”
  for `jeffernmalinaoqwe@gmail.com`.
- GitHub **Settings → Emails** showed `jeffernmalinaoqwe@gmail.com` as **Primary**, **Verified**, and
  **Connected to Google**. The old address was not listed.
- The public profile email was set to `jeffernmalinaoqwe@gmail.com`; “Keep my email addresses private” is
  currently off.
- The migration documentation and identity-reference edits were delivered through PR **#246**, merged at
  `2026-11-12T10:04:27Z` as merge commit `af70ab2bf283aa83d16db70fe7306b3c18c9564c`.
- All four required checks passed.

## Configurations updated

| Configuration | Current value |
| --- | --- |
| GitHub account | `nreffejzxc` |
| Repository remote | `https://github.com/nreffejzxc/inventory-ai.git` |
| Local Git author | `nreffejzxc <jeffernmalinaoqwe@gmail.com>` |
| Local Git committer | `nreffejzxc <jeffernmalinaoqwe@gmail.com>` |
| Primary email | `jeffernmalinaoqwe@gmail.com` — Primary, Verified, Connected to Google |
| Public profile email | `jeffernmalinaoqwe@gmail.com` |
| Email privacy setting | Off (profile email is public) |
| Branch state | `main` at `af70ab2`; PR #246 merged |

The `gh` token does not include the `user:email` scope, so `gh api user` still returns `email: null`; that is a
token-scope limitation, not evidence that the account lacks a verified email. GitHub's own Emails settings page
shows the new Gmail as primary and verified, and the new mailbox received the Google identity-linked notice.

## Keys, credentials and certificates

**None generated.** No GitHub personal access token, SSH key, deploy key, signing key or certificate was created,
rotated or deleted for this change.

## Remaining owner action

- No further GitHub email action is required.
- GitHub 2FA remains a separate owner decision; it is not required to finish the email migration.

## Rollback

The old GitHub profile is already unavailable (404); there is no separate old owner to remove. The new account
already owns the repository and is the commit identity.
