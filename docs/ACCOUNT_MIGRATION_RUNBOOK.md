# Account Migration & Security Runbook

**Status:** planning and verification record. This document does **not** authorize a transfer, a
credential rotation, an account deletion, or a production change. Every action below still needs the
owner's explicit approval.

**Last verified:** 2026-10-30
**Owner:** Jeffern
**Target primary identity:** `jeffernmalinaoqwe@gmail.com`

No credential value — password, token, private key, service-account JSON, database URI, API key or
recovery code — belongs in this file. Record names and locations, never values.

---

## 1. Scope and hard rules

This runbook covers:

- the final verification of the GitHub repository migration;
- making `jeffernmalinaoqwe@gmail.com` the primary owner identity;
- the later handover of Firebase, MongoDB Atlas, Render and Expo/EAS;
- the credentials that must be rotated or reconfigured;
- the checks that must pass before the old accounts are removed.

The following rules apply throughout:

1. **Do not transfer ownership, rotate a credential, or change a production configuration without
   approval.** The approval gates are listed in section 11.
2. **Preserve identifiers.** Do not create a new Firebase project, Atlas cluster, EAS project or
   Render service unless the owner has approved a full cutover. New identifiers break installed apps,
   existing user records or the public API URL.
3. **Do not delete the old account or the old service** until the replacement has been verified and a
   rollback window has passed.
4. **Do not rewrite Git history.** Old commits keep their original metadata. A new identity applies to
   new commits only.
5. **Never put a secret in a document, issue, pull request, terminal transcript or log.** Use the
   provider dashboard or the local environment file.
6. **The repository is public.** The target Gmail already appears in public commit metadata. Treat its
   address as public information, not as a secret.

---

## 2. Verified GitHub state

At the 2026-10-30 review:

| Check | State |
| --- | --- |
| Repository | `jeffernqwerty/ai-inventory` |
| Visibility | Public; not a fork; default branch `main` |
| History | 415 commits on `main`; 492 across all refs; 911 tracked files |
| Integrity | `git fsck` reported no corruption; only unreachable dangling objects |
| Remote branches | 20 |
| Tags/releases | None existed, so none are missing |
| Issues/pull requests | Issue #32 and PRs #97/#98 open; PR #101 merged |
| Push/pull | Fetch returned `0 ahead / 0 behind`; a temporary verification ref was pushed and deleted |
| CI | Latest `main` run green: `server`, `mobile`, `secret-guard`, `attribution-guard` |
| Branch protection | Four required checks; strict up-to-date; administrators enforced; force pushes and deletions blocked; conversation resolution required; 0 required approvals |
| Collaborators | `jeffernqwerty` only (admin); the old write collaborator was removed on 2026-10-30 |
| Security scanning | Secret scanning enabled with 0 open alerts; push protection enabled |
| Dependabot | 2 accepted advisories: `zod` high, `deepmerge` low |
| Private vulnerability reporting | Enabled |
| Actions secrets/variables/environments | None; this is intentional for this CI |
| Deploy keys/webhooks/Pages | None |
| Production | `/api/health` 200, database connected, production posture, commit `98ba2bb` |

Production `98ba2bb` is the latest commit that changed `server/`. The commits after it are docs/mobile
only, so Render correctly did not redeploy.

### 2.1 GitHub work and status

These are cleanup and security items, not a reason to transfer the repository again.

1. **Verify the primary Gmail.** In GitHub **Settings → Emails**, confirm
   `jeffernmalinaoqwe@gmail.com` is present, verified and primary for `jeffernqwerty`. The API could not
   list account emails because the current token lacks the `user` scope. Web-merge commits already use
   that address, which is strong evidence but not proof of verification.
2. **Align the local Git identity.** The local configuration still uses the previous address. Future
   local commits would carry the old identity until it is changed.
3. **Current-state policy updated.** `CLAUDE.md`, `docs/SOURCE_PROTECTION.md` and
   `scripts/audit-access.mjs` now name the new account and no longer retain the old collaborator.
   Historical roadmap entries are records and remain unchanged.
4. **Old account removed.** `nreffejzxc` was removed as a write collaborator on 2026-10-30, and its
   local `gh` credential was removed. Only `jeffernqwerty` remains as admin. Review the old account's
   server-side OAuth authorization and SSH keys separately.
5. **Verify 2FA.** Account 2FA cannot be confirmed over the API. Check both accounts in
   **Settings → Password and authentication**.
6. **Close the red dependency PR.** PR #98 proposes `@react-native-firebase/app` 27.1.0 while the
   frozen Phase 1 test expects 27.0.0. This is a Dependabot grouping problem, not a migration failure.
7. **Decide what happens to local-only work.** The working tree has modified files and an untracked
   plan; `backup/pre-amend-4af737b` is local-only, and `chore/docs-section-guard` is one commit ahead
   of its remote counterpart. Commit and push only what the owner wants preserved.

### 2.2 Read-only verification commands

```bash
# Repository identity and visibility
gh repo view jeffernqwerty/ai-inventory \
  --json nameWithOwner,visibility,isPrivate,defaultBranchRef,isFork

# Remote synchronization; expect "0 0"
git fetch --prune origin
git rev-list --left-right --count origin/main...HEAD

# Access, protection and scanning audit
node scripts/audit-access.mjs

# Required checks and the latest run
gh api repos/jeffernqwerty/ai-inventory/branches/main/protection \
  --jq '.required_status_checks.contexts'
gh run list --repo jeffernqwerty/ai-inventory --limit 5

# Production build identity
curl -sS --max-time 90 https://ai-inventory-l1mi.onrender.com/api/health
```

The health endpoint is a liveness signal and publishes the deployed commit. The first request after
the free-tier service sleeps can take longer than 30 seconds; allow up to 90 seconds before treating a
timeout as a failure.

---

## 3. Single-email policy

The target is one primary Gmail for service ownership, billing, recovery and administrative contact:

```text
jeffernmalinaoqwe@gmail.com
```

GitHub's login remains `jeffernqwerty`; the Gmail is the account's primary contact and recovery
identity, not the login name. Other providers may use the Gmail as the account identifier or only as
the billing/contact address; verify each one individually.

### 3.1 Rules that follow from using one address

- **GitHub permits one account per email.** Do not add the new Gmail to the old `nreffejzxc` account.
  Retire the old account instead.
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

Perform these steps only after approval.

### 4.1 Make the Gmail primary

1. Open GitHub **Settings → Emails** for `jeffernqwerty`.
2. Add `jeffernmalinaoqwe@gmail.com` if it is not already listed.
3. Verify it through the message GitHub sends.
4. Set it as **Primary**.
5. Keep the old address only if it is needed for recovery; otherwise remove it after the old account is
   retired.

### 4.2 Choose the commit identity

Decide all three explicitly:

| Choice | Options | Consequence |
| --- | --- | --- |
| Git author name | `jeffernzxc` or `Jeffernqwerty` | Appears in future commit metadata |
| Commit email | Target Gmail or GitHub `noreply` | The Gmail is public if used directly |
| Policy text | Update `CLAUDE.md` to match | Removes the current contradiction |

Update the local configuration only after the owner chooses:

```bash
# Example only; do not run until the identity is approved.
# git config user.email "jeffernmalinaoqwe@gmail.com"
# git config user.name "jeffernzxc"
```

### 4.3 Old account removal — repository access completed 2026-10-30

1. Confirmed the new account can sign in and push.
2. Removed `nreffejzxc` from the repository collaborators.
3. Removed the old GitHub CLI credential from the local credential store and signed the CLI out of
   that account.
4. Re-ran `node scripts/audit-access.mjs` and confirmed it passes.
5. Still separately review the old account's server-side OAuth authorization and SSH keys; this
   cleanup did not revoke them.

### 4.4 Update current-state documentation

The three current-state references below were updated on 2026-10-30:

- `CLAUDE.md` — GitHub display name, username, attribution and commit email.
- `docs/SOURCE_PROTECTION.md` — the human-access row.
- `scripts/audit-access.mjs` — the trusted-collaborator set.

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

1. **GitHub closeout** — identity, access, documentation, 2FA.
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

GitHub Apps are not visible through the API. Verify in **GitHub → Settings → Applications** that the
Render app still has access to `jeffernqwerty/ai-inventory`, and verify the repository configured on
the Render service. The old repository URL redirects, but redirects are not a substitute for a valid
installation.

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
| Remove the old GitHub collaborator or revoke its local token | **Completed 2026-10-30** | Repository access and the local credential are removed; the server-side OAuth grant still needs separate review |
| Rotate the Firebase service-account key | Yes | Production environment change and backend restart |
| Add a Firebase Owner or change billing | Yes | Production ownership and billing |
| Move the Atlas project | Yes | Changes organization ownership and billing |
| Hand over or rebuild Render | Yes | Can change the public API host and mobile builds |
| Transfer the Expo project | Yes | Affects builds, credentials and OTA updates |
| Change Brevo or OpenRouter credentials | Yes | Can interrupt mail or AI |
| Delete an old account or service | Separate explicit approval | Only after verification and rollback window |

---

## 12. Open questions

- Is `jeffernmalinaoqwe@gmail.com` verified and primary on `jeffernqwerty`?
- Should future commits use the Gmail directly or GitHub's `noreply` address?
- Should the Git author name remain `jeffernzxc` or become `Jeffernqwerty`?
- Is the current Render workspace on Hobby or Pro, and will Render support a workspace handoff?
- What is the destination Expo organization name?
- Does an Atlas account already exist under the Gmail?
- Is the destination Brevo account's sender domain already verified?
- Which local-only branch and uncommitted work should be preserved?

---

## 13. Definition of done

The migration is complete only when all of these are true:

- [ ] `jeffernmalinaoqwe@gmail.com` is verified and primary on GitHub.
- [ ] Local Git identity matches the approved policy.
- [x] `CLAUDE.md`, `docs/SOURCE_PROTECTION.md` and `scripts/audit-access.mjs` no longer name the old
      account as current access.
- [x] The old GitHub collaborator is removed (2026-10-30).
- [x] The old GitHub CLI credential is removed from this machine (2026-10-30).
- [ ] The old account's server-side OAuth authorization and SSH keys are reviewed.
- [ ] GitHub 2FA is verified; CI and branch protection still pass.
- [ ] A real push and pull succeed after the changes.
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
