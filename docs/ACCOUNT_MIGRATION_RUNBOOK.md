# Account Migration & Security Runbook

**Status:** **paused.** The repository was restored to the original GitHub account `nreffejzxc` on
2026-10-31 after the newer Gmail became unavailable. This document records the partial migration and
the future plan; it does **not** authorize a transfer, a credential rotation, an account deletion, or a
production change. Every action below still needs the owner's explicit approval.

**Last verified:** 2026-10-31, with the owner/admin session and the Phase 1 rewrite evidence
**Current owner:** `nreffejzxc` (original GitHub account)
**Current repository:** `nreffejzxc/inventory-ai`
**Paused migration target:** `jeffernmalinaoqwe@gmail.com` / `jeffernqwerty`

> **Restoration 2026-10-31.** The newer Gmail became unavailable, so the repository was moved back to
the original account. GitHub had permanently retired `nreffejzxc/ai-inventory` after the earlier
transfer, so the restored repository is named `inventory-ai`. History, branches, issues and pull
requests moved intact. The owner/admin session then verified branch protection, secret scanning,
private vulnerability reporting and the Actions policy; `jeffernqwerty` was removed as a collaborator,
leaving `nreffejzxc` as the only human with access. The owner then deleted the stale
`jeffernqwerty` keyring entry, revoked that account's GitHub CLI authorization, and removed the
Railway App; 2FA remains deliberately deferred. A metadata-only history-attribution rewrite approved
the same day replaced `main` at `93844e9` with `c9c9c1a`, removing `jeffernqwerty` from the commit
authors while preserving every file and message. The measurements are in §2.

No credential value — password, token, private key, service-account JSON, database URI, API key or
recovery code — belongs in this file. Record names and locations, never values.

---

## 1. Scope and hard rules

This runbook covers:

- the restored GitHub repository and the paused migration;
- the future plan to make `jeffernmalinaoqwe@gmail.com` the primary owner identity;
- the later handover of Firebase, MongoDB Atlas, Render and Expo/EAS;
- the credentials that must be rotated or reconfigured;
- the checks that must pass before any future account removal.

The following rules apply throughout:

1. **Do not transfer ownership, rotate a credential, or change a production configuration without
   approval.** The approval gates are listed in section 11.
2. **Preserve identifiers.** Do not create a new Firebase project, Atlas cluster, EAS project or
   Render service unless the owner has approved a full cutover. New identifiers break installed apps,
   existing user records or the public API URL.
3. **Do not delete the old account or the old service** until the replacement has been verified and a
   rollback window has passed.
4. **Do not rewrite Git history without the owner's explicit, scoped approval.** The default is that
   old commits keep their original metadata and a new identity applies to new commits only. The one
   approved exception is the metadata-only rewrite of `0647187dc9..93844e9` on 2026-10-31
   (`CLAUDE.md` §16 rules 9–10, as an owner-approved metadata-only exception), recorded in §2.1; it
   preserved every tree and message and dropped seven web-flow signatures. No further rewrite is
   authorized.
5. **Never put a secret in a document, issue, pull request, terminal transcript or log.** Use the
   provider dashboard or the local environment file.
6. **The repository is public.** The target Gmail already appears in public commit metadata. Treat its
   address as public information, not as a secret.

---

## 2. Verified GitHub state

After the 2026-10-31 restoration and rewrite:

| Check | State |
| --- | --- |
| Repository | `nreffejzxc/inventory-ai` |
| Visibility | Public; not a fork; default branch `main` |
| History | 426 commits; 912 tracked files; the approved rewrite replaced the 17-commit range ending at `93844e9`; new `main` tip `c9c9c1a`; the old tip is in the backup bundle |
| Integrity | **Approved metadata-only rewrite (2026-10-31)** — every tree and message byte-identical (tip tree `b88d175e`); 11 commits reattributed; seven web-flow signatures dropped; `git fsck --strict` clean |
| Remote branches | 27 remote branches; seven still carry pre-rewrite commits (listed in §2.1); no branch was deleted |
| Tags/releases | None existed, so none are missing |
| Issues/pull requests | Issue #32; PRs #97/#98 remain open; #104 was closed as superseded by #105 |
| Push/pull | Owner push and fetch verified; PR #107 merged on 2026-10-31; the rewrite was the only force push and used `--force-with-lease` |
| CI | Post-rewrite `main` run `41176229274` green on `c9c9c1a`; `server`, `secret-guard`, `attribution-guard`, `mobile` all success; the guard rerun read all 17 rewritten commits |
| Branch protection | **Verified** — required checks `server`, `secret-guard`, `attribution-guard`, `mobile`; strict; admins enforced; pull request required with 0 approvals; force pushes and deletions blocked; conversation resolution required |
| Collaborators | `nreffejzxc` (owner, admin) only; no pending invitations |
| Local GitHub CLI | `gh auth status` lists only `nreffejzxc`; the stale `jeffernqwerty` keyring entry was deleted and that account's GitHub CLI OAuth authorization was revoked on 2026-10-31 (owner-confirmed in the UI; not API-readable) |
| GitHub Apps | Railway App **removed** on 2026-10-31 (owner-confirmed in the UI); no Codebuff or Render GitHub App is installed. The installation list is still UI-only. |
| Account 2FA | **Disabled — deliberately deferred by the owner** until a reliable backup method and recovery-code storage are ready. |
| Security scanning | Secret scanning **enabled**; push protection **enabled**; non-provider patterns and validity checks disabled |
| Dependabot | 2 accepted advisories: `zod` high, `deepmerge` low |
| Private vulnerability reporting | **Enabled** |
| Default `GITHUB_TOKEN` | Read-only; cannot approve pull request reviews |
| Actions | All actions allowed; SHA pinning is not enforced, but workflows pin to full commit SHAs |
| Actions secrets/variables/environments | None |
| Deploy keys/webhooks/Pages | None |
| Production | `/api/health` 200, database connected, production posture, commit `98ba2bb` |

### 2.1 The approved history-attribution rewrite (2026-10-31)

`jeffernqwerty` was a historical commit author, not a collaborator: eight commits were authored under
that account's email during the temporary migration, and 11 commits carried it in
an author or committer field. The landing page's **Contributors** list is commit attribution; it is
not an access list. The owner approved a **metadata-only** rewrite as an explicit exception to
`CLAUDE.md` §16 rules 9–10, executed in a disposable clone and pushed once with `--force-with-lease`.

| Item | Result |
| --- | --- |
| Old `main` tip | `93844e9224bcef8b3fe4573ef907e4117ecbd650` |
| Earliest affected commit | `78c92472ce3f68b1759b673b33dc583e91b96419`; first parent `0647187dc9287e7990cdcc4131fccaed1b1299a4` |
| Range | 17 commits; 16 new SHAs (`dcb0368a3e9780cdca78c08ce7e30f4a6c9038ce` unchanged) |
| Metadata changed | 11 commits: 8 author fields, 5 committer fields, 2 commits carrying both |
| Preserved | Every tree, blob, message, author date, committer date and parent order; tip tree `b88d175eb000e942f9f2049bbbd2b58568ec8c5b` equals the old tip's tree; `git diff 93844e9 c9c9c1a` is empty; `git fsck --strict` is clean |
| Signatures | Seven GitHub web-flow `gpgsig` entries dropped on `78c9247`, `fdee8b54`, `4582bfd0`, `2694b857`, `eb92050`, `e99f0010` and `93844e9`; `required_signatures` remains `false` |
| New `main` tip | `c9c9c1a6f162b9cd4b80e1b9bbfbedc882c855d0` |
| Backup | `pre-rewrite-2026-10-31.bundle` outside the repository, plus `.git/pre-rewrite-backup.bundle`; both retained |

**CI and protection.** Push run `41176229274` is green on `c9c9c1a`: `server`, `secret-guard`,
`attribution-guard` and `mobile` all completed successfully. `attribution-guard` first failed because
the force push had removed its base commit from the checkout; it refused to verify rather than pass.
A temporary ref restored the base, the rerun read all 17 rewritten commits and passed, and the ref was
deleted. Protection is back to the exact baseline: four required checks, strict up-to-date,
administrators enforced, pull request required with 0 approvals, force pushes and deletions blocked,
conversation resolution required, and `allow_force_pushes` **false**.

**Contributors, measured.** `/graphs/contributors-data` returns only `nreffejzxc` (396) and
`dependabot[bot]` (6); `jeffernqwerty` and `codebuff-team` are absent. The REST contributors endpoint
and the repository sidebar still served their pre-rewrite cache on 2026-10-31 (`jeffernqwerty`, 8;
`codebuff-team`), and GitHub documents up to about 24 hours of cache lag. This is not an access
problem: **Settings → Collaborators & teams** still lists `nreffejzxc` only. Do not start Phase 2
(rewriting the non-`main` branches) before that window passes; if the sidebar is still stale after 24
hours, report it to GitHub Support rather than rewriting more refs.

**Not rewritten.** Seven non-`main` remote branches still contain pre-rewrite commits:
`docs/runbook-verification-updates` (`a7ff713`), `docs/restore-status-final` (`8e8a3e4`),
`docs/restore-original-github-account` (`47cb1c1`), `docs/owner-access-verified` (`068ae51`),
`dependabot/npm_and_yarn/mobile/mobile-minor-and-patch-4f21d3e467` (`153b9b3`),
`docs/account-migration-runbook` (`eb92050`) and `chore/current-state-access-policy` (`3b0d910`).
The eighth branch in the pre-push list, the server Dependabot branch, was rebased onto the new `main`
during cleanup and no longer carries old-email commits. No branch was deleted. PR #97's branch was
rebased and is `CLEAN` with all four checks green. PR #98 remains `CONFLICTING`, its `mobile` check
fails on the pre-existing RNFirebase version mismatch, and it must not be merged. Merged PRs #99–#103
and #105–#107 have merge commits in the rewritten range; their old merge SHAs are no longer on `main`,
so a PR page may say the old commit is not on a branch. That is expected and is not edited.

Production `98ba2bb` is the latest commit that changed `server/`. The commits after it are docs/mobile
only, so Render correctly did not redeploy.

### 2.2 Restoration work and status

1. **Ownership restored.** On 2026-10-31 the repository was transferred back from `jeffernqwerty` to
   `nreffejzxc`. GitHub accepted the transfer after the repository was renamed off the retired path.
2. **The old path is retired.** GitHub permanently retired `nreffejzxc/ai-inventory`; the restored
   repository is `nreffejzxc/inventory-ai`. Do not try to recreate the retired path.
3. **History and collaboration objects moved intact.** All 23 pre-transfer remote branches still
   exist under the original owner (four later branches bring the remote total to 27); PRs #97/#98
   remain open, #104 was closed as superseded, and #105 was merged. No tags existed. The transfer
   itself did not rewrite history; the separately approved metadata-only rewrite is §2.1.
4. **Branch protection verified.** The owner/admin read returned `protected: true` with all four
   required checks, strict up-to-date enforcement, administrator enforcement, pull request required,
   force pushes and deletions blocked, and conversation resolution required.
5. **Rollback collaborator removed.** `jeffernqwerty` was removed on 2026-10-31 after the owner
   session could push. The collaborator endpoint now returns only `nreffejzxc` (admin), and pending
   invitations are empty. `node scripts/audit-access.mjs` reports no violations.
6. **Local identity restored.** Local `user.email` is `jefferndullamalinaozxc@gmail.com` and
   `user.name` is `jeffernzxc`; `origin` points at `nreffejzxc/inventory-ai`.
7. **Migration paused.** The newer Gmail and the other services were not changed. Do not resume the
   account migration until the Gmail problem is resolved and the owner explicitly approves it.
8. **2FA is disabled and deliberately deferred.** The owner checked the original account on
   2026-10-31 and deferred enabling it until a reliable backup method and offline recovery codes are
   ready. The API cannot confirm the field.
9. **Account cleanup is complete.** On 2026-10-31 the owner deleted the stale `jeffernqwerty` keyring
   entry, revoked that account's GitHub CLI OAuth authorization (leaving its other OAuth apps alone),
   and removed the Railway App. `gh auth status` lists only `nreffejzxc`. GitHub returns neither the
   OAuth grants nor App installations through this token, so both are recorded as owner-confirmed UI
   checks, not API measurements.
10. **The rewrite is recorded in §2.1.** It was metadata-only and is the only authorized history
    rewrite. The old commits remain in the backup bundle and on seven non-`main` branches.
11. **The dependency PRs remain open.** PR #97 was rebased onto the new `main` and is `CLEAN`; PR #98
    proposes `@react-native-firebase/app` 27.1.0 while the frozen Phase 1 test expects 27.0.0, is
    `CONFLICTING`, and fails `mobile`. Do not merge #98 while that check fails.
12. **Local-only work is untouched.** The working tree still has modified files and an untracked plan;
    `backup/pre-amend-4af737b` is local-only, and `chore/docs-section-guard` is one commit ahead of its
    remote counterpart. Commit and push only what the owner wants preserved.

### 2.3 Read-only verification commands

```bash
# Repository identity and visibility
gh repo view nreffejzxc/inventory-ai \
  --json nameWithOwner,visibility,isPrivate,defaultBranchRef,isFork

# Remote synchronization; expect "0 0"
git fetch --prune origin
git rev-list --left-right --count origin/main...HEAD

# Access, protection and scanning audit
node scripts/audit-access.mjs

# Required checks and the latest run
gh api repos/nreffejzxc/inventory-ai/branches/main/protection \
  --jq '.required_status_checks.contexts'
gh run list --repo nreffejzxc/inventory-ai --limit 5

# Production build identity
curl -sS --max-time 90 https://ai-inventory-l1mi.onrender.com/api/health
```

The health endpoint is a liveness signal and publishes the deployed commit. The first request after
the free-tier service sleeps can take longer than 30 seconds; allow up to 90 seconds before treating a
timeout as a failure.

---

## 3. Single-email policy (paused)

**This policy applies only when the migration resumes.** The current GitHub owner remains
`nreffejzxc` with `jefferndullamalinaozxc@gmail.com`. The target is one primary Gmail for service
ownership, billing, recovery and administrative contact:

```text
jeffernmalinaoqwe@gmail.com
```

When the migration resumes, GitHub's login would remain `jeffernqwerty`; the Gmail is the account's
primary contact and recovery identity, not the login name. Other providers may use the Gmail as the
account identifier or only as the billing/contact address; verify each one individually.

### 3.1 Rules that follow from using one address

- **GitHub permits one account per email.** Do not add the new Gmail to the old `nreffejzxc` account.
  If the migration resumes, move the repository to the new account instead of mixing identities.
- **The Gmail is the root of every recovery path.** Compromise or loss of the Gmail is a compromise of
  every service.
- **Public commit exposure.** The Gmail already appears in public merge-commit metadata. If that is not
  wanted, keep the Gmail as the account primary but use GitHub's `noreply` address for commit
  authorship. The `CLAUDE.md` identity policy must then say so explicitly.
- **A recovery address is not a second owner.** A separate recovery email or phone may be used only to
  recover the Gmail; it does not need access to any Inventory AI service.

### 3.2 Gmail security baseline

Before moving any production ownership to the Gmail:

- [ ] Turn on two-step verification with a hardware key or passkey. SMS alone is not sufficient.
- [ ] Store recovery codes offline, not in the repository.
- [ ] Use a unique password that is not reused on any service.
- [ ] Add a recovery email and phone that are not the same Gmail.
- [ ] Review third-party access and active sessions.
- [ ] Enable login alerts.
- [ ] Store service passwords in a password manager.
- [ ] Consider a break-glass second Owner on Firebase and Atlas, even if day-to-day management stays
      with the Gmail.

---

## 4. GitHub closeout

**Paused 2026-10-31.** The repository is back under the original account. The steps in 4.1 and 4.3–4.4
were either reversed or must not be repeated until the migration resumes. They remain below as the
future plan and as the record of what the earlier attempt did.

### 4.1 Make the Gmail primary (paused)

These steps apply only when the migration resumes. The original account remains primary for now.

1. Open GitHub **Settings → Emails** for `jeffernqwerty`.
2. Add `jeffernmalinaoqwe@gmail.com` if it is not already listed.
3. Verify it through the message GitHub sends.
4. Set it as **Primary**.
5. Keep the old address only if it is needed for recovery; otherwise remove it after the old account is
   retired.

### 4.2 Commit identity — restored 2026-10-31

The current identity is the original account. The 2026-10-30 change to the newer Gmail was reverted
because that Gmail became unavailable.

| Choice | Current | Consequence |
| --- | --- | --- |
| Git author name | `jeffernzxc` | Appears in future commit metadata |
| Commit email | `jefferndullamalinaozxc@gmail.com` | The original account address |
| Policy text | `CLAUDE.md` names the original email | Matches the current repository owner |

The restored local configuration is:

```bash
git config --local user.email "jefferndullamalinaozxc@gmail.com"
git config --local user.name "jeffernzxc"
```

Existing commits on `main` were rewritten once, metadata-only, on 2026-10-31 (§2.1). No further
rewrite is authorized. The old commits remain in the backup bundle and on seven non-`main` branches;
changing those would need a second explicit approval.

### 4.3 Old account removal — completed 2026-10-30, reversed 2026-10-31

1. Confirmed the new account can sign in and push.
2. Removed `nreffejzxc` from the repository collaborators.
3. Removed the old GitHub CLI credential from the local credential store and signed the CLI out of
   that account.
4. Re-ran `node scripts/audit-access.mjs` and confirmed it passes.
5. The old account's OAuth apps, PATs and sessions were revoked. The owner confirmed completion on
   2026-10-30; the old account's GitHub security log is the evidence. The log entries are not
   reproduced or independently verified here because this workspace cannot read that account. The old
   account publishes **no SSH keys** (`https://github.com/nreffejzxc.keys` returned none), so no
   SSH-key removal was possible or needed.
6. Repository-level path check on 2026-10-30: direct collaborator lookup 404; collaborator count 1
   (owner); invitations 0; deploy keys 0; webhooks 0; Actions secrets 0; environments 0; forks 0;
   rulesets 0; branch-protection bypass list null. **At that time** the old account retained only the
   public `read` baseline that any GitHub visitor has; it had no `push`, `maintain`, `triage` or
   `admin` permission.
7. **Reversed 2026-10-31.** The newer Gmail became unavailable, so the repository was transferred back
   to `nreffejzxc`. GitHub retired `nreffejzxc/ai-inventory`; the restored name is
   `nreffejzxc/inventory-ai`.
8. **Restored and verified 2026-10-31.** `nreffejzxc` is owner/admin again. The owner/admin session
   read branch protection and the security settings, re-enabled secret scanning and push protection,
   and removed `jeffernqwerty` as a collaborator. The newer account reports `push: false`; its stale
   local keyring entry was deleted, its GitHub CLI OAuth authorization was revoked, and
   `gh auth status` lists only `nreffejzxc`. No pending invitation remains.

### 4.4 Update current-state documentation

Restored on 2026-10-31:

- `CLAUDE.md` — GitHub display name, username, attribution and commit email are back to `Jeffernzxc`,
  `nreffejzxc` and `jefferndullamalinaozxc@gmail.com`.
- `docs/SOURCE_PROTECTION.md` — owner and human-access rows reflect `nreffejzxc` only, with verified
  branch protection, secret scanning, push protection, private vulnerability reporting and the
  read-only default `GITHUB_TOKEN`.
- `scripts/check-commit-attribution.mjs` — the allowed identity examples use the original email.
- `scripts/audit-access.mjs` derives the owner from `origin`; it needs no account-specific edit, and it
  passes with no access or protection violation. The remaining unverified field is account 2FA,
  which the API returns as `null`; GitHub App installations also need an owner-side UI check and were
  confirmed empty on 2026-10-31.
- The history-attribution rewrite (§2.1) and the removal of the Railway App and the old GitHub CLI
  authorization are recorded here and in `docs/SOURCE_PROTECTION.md`; no application code changed.

Do not change the historical references in `docs/DEVELOPMENT_ROADMAP.md`; they record what was true at
their dates.

### 4.5 Close the dependency PR

Close PR #98 rather than merging a version that the frozen RNFirebase test refuses. If the project does
not intend to track RNFirebase minor versions, exclude `@react-native-firebase/app` and
`@react-native-firebase/auth` from the mobile Dependabot group, or split them into a separate,
deliberately reviewed update.

---

## 5. Migration order

The order minimizes identifier changes and avoids entering the same credentials twice.

1. **GitHub closeout (paused)** — resume only after the Gmail is available; identity, access, documentation, 2FA.
2. **Gmail hardening** — 2FA, recovery, password manager.
3. **Firebase** — ownership, billing, service-account key.
4. **MongoDB Atlas** — project move into the Gmail-owned organization.
5. **Render** — decide between workspace handover and rebuild. If rebuilding, settle the hostname
   before the final mobile build.
6. **Expo/EAS** — transfer the existing project and verify credentials/OTA.
7. **Brevo and OpenRouter** — replace their keys in Render last, one at a time.

If Render keeps the current host, Expo can move before the final Render billing handoff. If Render will
be rebuilt on a new host, finish Render first so `EXPO_PUBLIC_API_URL` changes only once.

---

## 6. Firebase

**Current anchor:** project `inventoryai-d0d20`; server credential in
`FIREBASE_SERVICE_ACCOUNT_JSON`; mobile native files supplied through the EAS file variables
`GOOGLE_SERVICES_JSON` and `GOOGLE_SERVICE_INFO_PLIST`.

### 6.1 Ownership

1. Add `jeffernmalinaoqwe@gmail.com` as a Google Cloud **Owner** on the project. Use the Cloud Console
   for an external personal account, not `gcloud`.
2. Confirm the account can open both the Cloud Console and the Firebase Console.
3. Create a new Cloud Billing account under the Gmail and change the project's billing link. Billing
   accounts cannot be transferred between payments profiles.
4. Do not remove the old Owner until the new Owner has verified console access, billing and deploys.

Do not create a new Firebase project. Inventory AI stores `firebaseUid` on MongoDB users; a new project
would issue new UIDs and break those links. Keeping the project ID preserves Auth users, API keys,
OAuth clients, authorized domains, App Check configuration and mobile client configuration.

### 6.2 Service-account key

1. Create a new key for the Firebase Admin service account.
2. Update `FIREBASE_SERVICE_ACCOUNT_JSON` in Render and local `server/.env`.
3. Restart and verify Firebase-backed flows.
4. Delete the old key in Google Cloud only after the new one is proven.

This rotation is already required independently: a local terminal transcript printed the service
account value on 2026-10-25. It was never committed to Git, but it must be treated as exposed.

### 6.3 Verification

- [ ] Email/password sign-in works.
- [ ] Google Sign-In works on a device.
- [ ] Six-digit email verification works.
- [ ] Password-reset code flow works.
- [ ] Authorized domains and OAuth consent screen are correct.
- [ ] Android SHA-1 restrictions still match the signing certificate.
- [ ] The Firebase reset action URL still points at the Render `/auth/reset` page.

### 6.4 Rollback

Keep the old Owner and the old service-account key until the new ones have been verified. If the new
key fails, restore the previous Render environment value and restart. No user data or Firebase Auth
records move during this process.

---

## 7. MongoDB Atlas

**Current anchor:** the Inventory AI Atlas project; `MONGODB_URI` in Render and local `server/.env`;
production database `inventoryai_prod_db`.

Use a project move, not a new cluster.

1. Create or use an Atlas account under the Gmail; enable MFA.
2. Create a destination organization with the Gmail as Organization Owner.
3. Add a payment method to the destination organization.
4. Check the destination's MFA requirement, UI/API IP access lists and resource policies.
5. As Organization Owner of both source and destination, move the Inventory AI project with
   **All Projects → project menu → Move Project**.
6. Take an on-demand snapshot or export before the move; test a restore after it.
7. Recreate project API keys or service accounts. Atlas removes project API keys during a project move.
8. Verify billing, alerts, integrations and network configuration.

Keep the project ID, cluster, database users, IP access list and connection string unchanged. The
application connects with a database user through `MONGODB_URI`, not an Atlas API key, so the app
connection should not change.

Do not create a new cluster solely to change ownership. A new cluster changes the connection string
and requires a Render environment update and backend restart.

### 7.1 Verification

- [ ] `MONGODB_URI` still resolves to the intended database.
- [ ] `MONGODB_DB_NAME` matches the environment.
- [ ] A read and a write succeed against the moved project.
- [ ] The backup policy is intact and a restore test passes.
- [ ] Project alerts and integrations still fire.
- [ ] The destination organization is billed from the next hour boundary.

### 7.2 Rollback

Keep the source organization and a recent export until the destination is verified. A project can be
moved back by an Organization Owner. Do not delete the source organization or any snapshot during the
rollback window.

---

## 8. Render

**Current anchor:** service `ai-inventory`, `rootDir: server`, Auto-Deploy On Commit, public host
`https://ai-inventory-l1mi.onrender.com`.

Render does not support transferring an individual service between workspaces. There are two realistic
routes.

### 8.1 Option A — hand over the existing workspace

Add the Gmail account as an Admin, transfer billing, verify the service, then remove the old Admin.

- Preserves the service ID, environment variables, secret files, domain, deploy history and hooks.
- Hobby workspaces allow only one member; adding a second Admin may require Pro.
- Render does not clearly document a full personal-account ownership handoff. Confirm with Render
  support before relying on this route.

### 8.2 Option B — rebuild in the new workspace

This creates a new service and a new `onrender.com` hostname.

Required work:

- recreate build/start commands, health check and auto-deploy settings;
- re-enter every environment variable and secret file;
- reconnect the GitHub App and repository;
- recreate custom domains and DNS;
- update `EXPO_PUBLIC_API_URL` in `mobile/eas.json` and the EAS environment;
- update `PASSWORD_RESET_URL`, CORS settings, privacy/terms/account-deletion URLs, documentation and
  the Play listing;
- produce new mobile builds because the API URL is compiled into the app.

Do not rebuild unless the existing workspace cannot be handed over. If a rebuild is unavoidable, put a
stable custom domain in front of the service first so future ownership changes do not require another
mobile release.

### 8.3 GitHub integration

GitHub Apps are not visible through the API. On 2026-10-31 the owner removed the Railway App and
confirmed that no Codebuff or Render GitHub App was installed, so no App currently has repository
access. Re-check **GitHub → Settings → Applications → Installed GitHub Apps** before connecting any
future integration, and verify the repository configured on the Render service separately. The old
repository URL redirects, but redirects are not a substitute for a valid installation.

### 8.4 Verification

- [ ] `/api/health` returns 200 and reports the expected commit.
- [ ] `/api/health/ready` returns 200.
- [ ] MongoDB and Firebase-backed routes work.
- [ ] Mail delivery works.
- [ ] The AI assistant works.
- [ ] The mobile app reaches the API.
- [ ] Auto-deploy still triggers on a `server/` change.

### 8.5 Rollback

Keep the old service running until the new one has passed the health checks and one full DNS TTL. Do
not delete the old workspace, service or environment variables during the rollback window.

---

## 9. Expo / EAS

**Current anchor:** `@jeffernqwes-team/inventory-ai`, project ID
`607eca05-1175-43ed-86a0-1829e91c9531`, owner `jeffernqwes-team` in `mobile/app.json`.

Transfer the existing EAS project; do not create a new one.

1. Confirm the destination is an Expo organization owned by the Gmail, or create one. Personal Expo
   accounts do not support shared roles well.
2. Ensure the Gmail is Owner/Admin on both source and destination.
3. Use **Project settings → General → Transfer project** in the EAS dashboard.
4. Change only the `owner` field in `mobile/app.json` to the destination organization.
5. Keep the slug, project ID, `updates.url`, runtime version, bundle identifiers, channels and build
   profiles unchanged.
6. Export the Android keystore and iOS credentials before the transfer; inspect `eas credentials`
   afterward.
7. Verify EAS environment variables, file variables, build history and update branch/channel mappings.
8. Publish a harmless preview update and test an installed build before touching production.

Installed builds are permanently pointed at the current project ID. A new EAS project would orphan
them from future OTA updates.

### 9.1 Verification

- [ ] `eas project:info` shows the same project ID.
- [ ] `eas channel:list` and `eas branch:list` show the expected mappings.
- [ ] Android and iOS credentials are present and owned by the destination.
- [ ] A preview build installs.
- [ ] A preview OTA update downloads and applies.
- [ ] `runtimeVersion`, channel names and bundle identifiers did not change.

### 9.2 Rollback

Keep the old organization's access and the exported credentials until the preview build and update
succeed. Do not delete the old Expo project or its build history.

---

## 10. Brevo and OpenRouter

These are credentials in the Render environment, not GitHub dependencies.

- Create or use the Gmail account for each service.
- Generate new API keys under the Gmail account.
- Update one Render variable at a time.
- Verify mail delivery or an AI turn.
- Revoke the old key only after the new one is proven.
- Re-verify the Brevo sender domain if the account changes.
- Check whether OpenRouter credits or usage survive the account change before switching.

Do these after Render is stable, because both keys live in its environment.

---

## 11. Approval gates

| Action | Approval needed | Reason |
| --- | --- | --- |
| Change GitHub primary email or local Git identity | Yes | Changes future commit metadata and account recovery |
| Remove the original account's GitHub access or revoke its local token | Separate explicit approval | It is the current owner; removal only after a future migration is verified |
| Change branch protection, repository access or scanning | Yes | The current rules are verified; changing them is a separate security decision |
| Rewrite Git history | Separate explicit approval; metadata-only, every tree and message preserved | Rule 9/10 exception; changes every descendant SHA |
| Rotate the Firebase service-account key | Yes | Production environment change and backend restart |
| Add a Firebase Owner or change billing | Yes | Production ownership and billing |
| Move the Atlas project | Yes | Changes organization ownership and billing |
| Hand over or rebuild Render | Yes | Can change the public API host and mobile builds |
| Transfer the Expo project | Yes | Affects builds, credentials and OTA updates |
| Change Brevo or OpenRouter credentials | Yes | Can interrupt mail or AI |
| Delete an old account or service | Separate explicit approval | Only after verification and rollback window |

---

## 12. Open questions

- Is the newer Gmail still unavailable, and when can the migration resume?
- When will GitHub's contributors cache drop `jeffernqwerty` and `codebuff-team`? The live graph is
  clean; the REST list and the landing-page sidebar may lag up to 24 hours.
- Should the restored repository keep the name `inventory-ai`, since `ai-inventory` is retired?
- Should the seven non-`main` branches be rewritten (Phase 2), or kept as historical refs? No Phase 2
  without a second explicit approval.
- How is Render connected to `nreffejzxc/inventory-ai` now that no GitHub App is installed?
- When will 2FA be enabled? It is disabled by owner decision (2026-10-31), pending a reliable backup
  method and offline recovery codes.
- Is the current Render workspace on Hobby or Pro, and will Render support a workspace handoff?
- What is the destination Expo organization name?
- Does an Atlas account already exist under the Gmail?
- Is the destination Brevo account's sender domain already verified?
- Which local-only branch and uncommitted work should be preserved?

---

## 13. Definition of done

### Restoration (2026-10-31)

- [x] Repository owned by `nreffejzxc` at `nreffejzxc/inventory-ai`.
- [x] History, branches, tags, issues and pull requests preserved; the approved metadata-only rewrite is recorded in §2.1.
- [x] Local `origin`, `user.name` and `user.email` point at the original account.
- [x] Current-state identity documentation reverted to the original account.
- [x] Branch protection verified: four required checks, strict, admins enforced, pull request required, force pushes/deletions blocked, conversation resolution required.
- [x] `jeffernqwerty` collaborator removed; owner is the only human with access; pending invitations 0.
- [x] Secret scanning and push protection enabled; private vulnerability reporting enabled.
- [x] A push and a pull succeed with the original account's own credential; the rewrite was the only force push and used `--force-with-lease`.
- [x] `gh auth status` lists only `nreffejzxc`; the stale keyring entry was deleted and the old account's GitHub CLI authorization was revoked.
- [x] CI runs green on the rewritten `main` (run `41176229274`; four required checks).
- [x] GitHub App installations checked; Railway App removed and no Codebuff or Render App installed.
- [x] Contributors graph no longer lists `jeffernqwerty`; REST and sidebar cache may lag up to 24 hours.
- [x] Production `/api/health` 200 on commit `98ba2bb`; the rewritten tree is identical.
- [ ] Account 2FA enabled; currently disabled and deliberately deferred by the owner.

### Migration (paused)

The migration is complete only when all of these are true, and only after the owner resumes it:

- [ ] `jeffernmalinaoqwe@gmail.com` is verified and primary on GitHub.
- [ ] Local Git identity matches the resumed policy.
- [ ] `CLAUDE.md`, `docs/SOURCE_PROTECTION.md` and `scripts/audit-access.mjs` name the new account.
- [ ] The original GitHub account is removed after the replacement is verified.
- [ ] The original GitHub CLI credential is removed again from this machine.
- [ ] GitHub 2FA is verified; CI and branch protection still pass.
- [ ] A real push and pull succeed after the resumed changes.
- [ ] Firebase is owned and billed under the Gmail; the new service-account key works.
- [ ] Atlas is owned by the Gmail organization; the connection string and restore are verified.
- [ ] Render ownership is settled; the production health check reports the expected commit.
- [ ] Expo is owned by the destination organization; preview build and OTA update pass.
- [ ] Brevo and OpenRouter use the new credentials and their flows are verified.
- [ ] No secret value appears in this document, the repository or a public log.

---

## 14. Sources

- [Firebase IAM overview](https://firebase.google.com/docs/projects/iam/overview)
- [Google Cloud: migrate projects between organizations](https://cloud.google.com/resource-manager/docs/project-migration)
- [Google Cloud: change billing for a project](https://cloud.google.com/billing/docs/how-to/modify-project)
- [MongoDB Atlas: manage project access and move a project](https://www.mongodb.com/docs/atlas/tutorial/manage-projects/)
- [MongoDB Atlas: manage organization users](https://www.mongodb.com/docs/atlas/access/manage-org-users/)
- [Render FAQ: service transfer between workspaces](https://render.com/docs/faq)
- [Render: team members and workspaces](https://render.com/docs/team-members)
- [Expo: account types and project transfer](https://docs.expo.dev/accounts/account-types/)
- [Expo: app transfers](https://docs.expo.dev/distribution/app-transfers/)
