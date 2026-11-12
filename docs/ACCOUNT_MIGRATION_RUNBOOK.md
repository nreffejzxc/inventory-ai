# Account Migration & Security Runbook

**Status:** **paused** for the separate GitHub/Render account move. The single-Gmail email migration is complete.

**Last verified:** 2026-11-12 for the GitHub/Git identity, final MongoDB organization access, Firebase IAM and
Authentication state, Gmail 2-Step Verification and a fresh login, Android push delivery and production health; access settings
were last verified 2026-11-07.
**Current GitHub/Render owner:** `nreffejzxc` (`jeffernmalinaoqwe@gmail.com`).
**Current repository:** [`nreffejzxc/inventory-ai`](https://github.com/nreffejzxc/inventory-ai), public.
**Paused target:** `jeffernqwerty` (historical; the former target Gmail is now the current owner email).
**EAS account:** `jeffernqwe` (`jeffernmalinaoqwe@gmail.com`), owner of `jeffernqwes-team`.
**Decision:** the current GitHub/Render account remains the authoritative owner until the owner
explicitly resumes the migration. The repository restoration is complete; the migration is paused,
not cancelled.

**Email migration note (2026-11-12):** the service-specific records in
[`docs/service-email-migrations/`](service-email-migrations/README.md) are authoritative for email state.
All seven services now use `jeffernmalinaoqwe@gmail.com`, including MongoDB Atlas. The new Gmail is the sole
Atlas Organization Owner; the old Atlas owner and old Firebase Cloud IAM Owner were removed, and the old
Firebase Authentication user is disabled. The “paused” language above describes the earlier account-move plan,
not the completed email changes.

---

## 1. Current state

| Item | State |
| --- | --- |
| Repository | `nreffejzxc/inventory-ai`, public; `main` at `af70ab2`; PR #246 merged |
| Access | `nreffejzxc` is the only human with access; pending invitations: 0 |
| Branch protection | Pull request required; four required checks; strict; admins enforced; force pushes and deletions blocked; conversation resolution required |
| Scanning | Secret scanning and push protection enabled; private vulnerability reporting enabled |
| Git identity | `nreffejzxc` / `jeffernmalinaoqwe@gmail.com` |
| Production | `/api/health` returned 200 with `status: ok`, `db: connected` and `environment: production` at 10:47 UTC. The serving commit is `c3bd692`; a docs-only merge does not redeploy. Free instance, so a cold start can delay the first response by 50 s or more. |
| EAS | Project `@jeffernqwes-team/inventory-ai` (ID `607eca05-1175-43ed-86a0-1829e91c9531`) is under the current owner Gmail's Expo account, not the GitHub/Render account |
| History | The approved metadata-only attribution rewrite is complete; no further rewrite is approved |
| GitHub 2FA | Disabled by owner decision on 2026-10-31; deferred until a backup method and offline recovery codes exist |
| Gmail 2-Step Verification | Active on the new Gmail since 2:47 PM; authenticator, passkeys and recovery phone configured; 8 backup codes available after a successful backup-code sign-in. Code values are not stored here |

The GitHub account is both the recovery root and the commit identity. EAS is a known exception: its
project already belongs to the current Gmail's Expo account. Do not add a second
GitHub owner; any resume starts from this split state, not a clean single-account
move.

---

## 2. Hard rules

1. **No transfer, rotation, removal or deletion without the approval gates in §6.**
2. **Preserve identifiers.** Keep the GitHub repository, Firebase project, Atlas project/cluster,
   Render service and EAS project; do not create replacements just to change ownership.
3. **For the paused account-move plan, the old owner and old credentials stay in place** until the replacement
   is verified and the rollback window has passed. For the completed email migration, the approved Atlas and
   Firebase removals are recorded in §7.
4. **No Git history rewrite.** The 2026-10-31 rewrite was a one-off, metadata-only exception; it
   preserved every tree and message but changed every descendant SHA.
5. **No secret value in this document, the repository, a public log or chat.** Environment-variable
   names only.
6. **Do not treat an outage as a reason to switch identity or credential paths.** A failed provider
   is not evidence that a move is safe.

---

## 3. Provider anchors

These are the current objects. A future ownership move changes who controls them, not what they are.

| Provider | Current anchor |
| --- | --- |
| Firebase | Project `inventoryai-d0d20`; Admin credential in `FIREBASE_SERVICE_ACCOUNT_JSON`; production auth flows and authorized domains depend on it |
| MongoDB Atlas | Production database `inventoryai_prod_db`; the application connects through `MONGODB_URI` as a database user, not an Atlas API key |
| Render | Service `ai-inventory`, root directory `server`, Auto-Deploy On Commit scoped to `server/` (docs-only merges do not redeploy), GitHub App installed, host `https://ai-inventory-l1mi.onrender.com` |
| Expo / EAS | Project `@jeffernqwes-team/inventory-ai`, project ID `607eca05-1175-43ed-86a0-1829e91c9531`, owner `jeffernqwes-team` in `mobile/app.json`; the signed-in account is `jeffernqwe` (`jeffernmalinaoqwe@gmail.com`), the paused target |

Installed mobile builds are permanently pointed at the EAS project ID. The Render host is compiled
into `EXPO_PUBLIC_API_URL`. A replacement project or host therefore requires new mobile builds; an
ownership transfer that preserves both does not.

The Firebase service-account value was printed in a local terminal transcript on 2026-10-25. It was
never committed, but it is treated as exposed. **It was rotated on 2026-11-07** — the old key was
deleted after the new one was verified in production. Future rotations remain subject to the
approval gates below.

---

## 4. If the owner resumes the migration

These are constraints, not a procedure. Write and approve the provider-specific steps when a resume
date exists; do not follow the removed historical handover sequence.

1. Harden the destination Gmail first: 2FA, recovery method, offline codes and a tested sign-in.
2. Move each object in place and preserve its identifiers: GitHub repository, Firebase project,
   Atlas project, Render service and EAS project.
3. Update the identity references in `CLAUDE.md`, `docs/SOURCE_PROTECTION.md` and
   `scripts/audit-access.mjs`, then re-verify branch protection and a real push/pull.
4. Rotate credentials one at a time, verifying the dependent flow after each change.
5. Remove the old owner's access, credentials and accounts only after the replacement works, the
   rollback window has passed and a separate approval is recorded.

---

## 5. Read-only verification

Run these before changing ownership or access. They read state; they do not move anything.

```bash
git status --short --branch
git log -1 --format='%H %an <%ae> %s'
gh auth status
gh repo view nreffejzxc/inventory-ai --json nameWithOwner,visibility,defaultBranchRef
gh api repos/nreffejzxc/inventory-ai/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, checks: [.required_status_checks.contexts[]], admins: .enforce_admins.enabled, force: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
gh api 'repos/nreffejzxc/inventory-ai/collaborators?affiliation=direct' --jq '.[].login'
node scripts/audit-access.mjs
curl -fsS https://ai-inventory-l1mi.onrender.com/api/health
```

Expected: a clean `main`; local identity `nreffejzxc` / `jeffernmalinaoqwe@gmail.com`; one
authenticated GitHub account; one direct collaborator; four required checks; health `status: ok` with
`db: connected`.

---

## 6. Approval gates

| Action | Approval needed | Reason |
| --- | --- | --- |
| Change the GitHub primary email or local Git identity | Yes | Changes future commit metadata and account recovery |
| Remove the current owner's GitHub access or revoke its local token | Separate explicit approval | It is the current owner; removal only after a resumed migration is verified |
| Change branch protection, repository access or scanning | Yes | The current rules are verified; changing them is a separate security decision |
| Rewrite Git history | Separate explicit approval; metadata-only, every tree and message preserved | Changes every descendant SHA; the 2026-10-31 exception is closed |
| Rotate the Firebase service-account key | Yes | Production environment change and backend restart |
| Add a Firebase Owner or change billing | Yes | Production ownership and billing |
| Move the Atlas project | Yes | Changes organisation ownership and billing |
| Hand over or rebuild Render | Yes | Can change the public API host and require new mobile builds |
| Transfer the EAS project | Yes | Affects builds, credentials and OTA updates |
| Change Brevo or OpenRouter credentials | Yes | Can interrupt mail or AI |
| Delete an old account or service | Separate explicit approval | Only after verification and the rollback window |

---

## 7. Open items

- **MongoDB Atlas:** `jeffernmalinaoqwe@gmail.com` is the sole confirmed Organization Owner with email MFA.
  The old owner was removed on 2026-11-12 after the new owner and production path were verified; the old address
  is absent from the organization users response. `/api/health` returned 200 with `db: connected` at 10:47 UTC.
  No database user, cluster, network rule or `MONGODB_URI` was changed. See
  [`docs/service-email-migrations/mongodb.md`](service-email-migrations/mongodb.md).
- **Atlas onboarding org:** the separate `Jeffern's Org - 2026-11-12` / `Project 0` was audited as empty
  (0 clusters, database users, network entries, processes, apps or API keys) and deleted. Production was not
  affected.
- **UptimeRobot:** test email delivery was confirmed at 5:22 PM. Android push delivery was confirmed on the
  CPH1969 device via ADB at 10:09 UTC (DOWN and UP); both monitors report UP.
- **Gmail and Atlas MFA:** Gmail 2-Step Verification is active, with an authenticator, passkeys and a recovery
  phone; 8 backup codes are available and their values are not stored here. Security Checkup reports the
  account is protected; recent activity shows 2-Step Verification turned on at 2:47 PM and backup codes used at
  2:54 PM and 7:20 PM; a fresh Gmail login succeeded using a backup code, with a new Windows sign-in recorded at 7:21 PM. Atlas email MFA is active. A second Atlas factor is optional and requires the owner's authenticator or
  security key. GitHub 2FA remains disabled by a separate owner decision.
- **Firebase:** the old Cloud IAM Owner grant was removed and the old Firebase Authentication user was disabled
  (retained without data loss). The new owner remains Owner. The Admin key was rotated on 2026-11-07; any future
  rotation follows the credential runbook.
- **Render connection:** the Render GitHub App is installed and the service is connected to
  `nreffejzxc/inventory-ai` on `main`; auto-deploy is limited to `server/` by the root directory.
  Re-confirm repository access before changing permissions.
- **EAS ownership:** the project already belongs to the target Gmail's Expo account, not the current
  GitHub/Render account. Decide how to handle that before resuming, removing either account or
  transferring the project.

No further provider-side migration action remains; store the remaining Gmail backup codes and decide on the optional
second Atlas factor. The old Google account itself was retained, but it no longer has Atlas organization access,
Firebase Cloud IAM access or Firebase Authentication access.
