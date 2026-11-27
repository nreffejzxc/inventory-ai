# Security change note — 2026-11-27

Per the project's security-change rule, every security configuration change gets a dated note: what
changed, which account or service, and how it was verified. No credential value, key, token or MFA
code appears here, by design.

## 1. MongoDB Atlas — database user reduced from `atlasAdmin` to `readWriteAnyDatabase`

- **Service:** MongoDB Atlas, project `inventoryaidb`, cluster `inventoryaidbcluster` (M0, AWS
  `ap-east-1`).
- **What changed:** the single database user used by both the production service and local
  development held **`atlasAdmin@admin`** — full cluster administration, including creating users,
  changing roles and dropping databases. It now holds **`readWriteAnyDatabase@admin`**.
- **What was explicitly NOT changed:** the username, the password, and the connection string. This is
  deliberate: no credential was rotated, so no Render environment variable changed, no service
  restarted and nothing redeployed. The change takes effect on the next command each connection
  issues.
- **Why this level rather than per-database roles:** the Atlas console's built-in role selector offers
  cluster-scoped roles for this account. Restricting further would require a custom role; the gain
  over `readWriteAnyDatabase` is negligible on a cluster that holds only this application's three
  databases, while the risk of mistyping a database name and breaking production is not.
- **Verified, in this order:**
  1. Production stayed up: `/api/health`, `/api/health/ready` and `/api/health/integrity` all
     returned 200 with `environment: production` immediately after the change.
  2. The application's real write path still works: against `inventoryai_dev_db` with the same
     credentials, an insert, an index creation, a read and a collection drop all succeeded.
  3. Privileged operations are now refused: `createUser`, `dropAllUsersFromDatabase`, `dropDatabase`
     and `hostInfo` each returned an Atlas authorization error.
  4. `dbStats` — the only privileged call the code makes, in
     `platformInfrastructure.service.ts` — still succeeds, and its failure path was already handled.
- **Residual risk:** the IP access list is still **`0.0.0.0/0`**. Narrowing it is not possible while
  the Render service is on the free tier, whose outbound IPs are not static; allowlisting today would
  cut production off from its database. This remains the single largest open item on Atlas.

## 2. What was deliberately not changed

- **No credential was rotated** and no MFA material was created, copied or moved.
- **No Render environment variable was changed.** The AI daily budget is an environment variable
  (`AI_PAID_DAILY_BUDGET_USD`) and therefore needs a Render env write, which the available credentials
  cannot perform (see the audit report for that blocker).
- **No Atlas tier, billing setting or backup policy was changed.**

## 3. Evidence of the change

The Atlas console shows one database user, `readWriteAnyDatabase@admin`, on all resources of the
cluster. The role change was written through the console's own authenticated session on 2026-11-27 and
re-read from `/nds/<project>/users` afterwards.

## 4. AI paid-spend guard — verified locally, NOT yet active in production

- **What the mechanism is:** `AI_PAID_DAILY_BUDGET_USD` (0 = unlimited, the shipped default) plus
  `AI_PAID_SPEND_ENABLED` (only the literal `false` withholds paid models). One UTC-day accumulator
  in `server/src/services/ai/paidSpendGuard.ts` meters every provider call to a model that is not a
  `:free` endpoint; reaching the ceiling withholds paid models exactly as the kill switch does, so a
  configured free candidate keeps serving the turn.
- **Verified on 2026-11-27 against the REAL provider** (not a double), from a local process reading
  the existing development `.env`:
  1. Under a `$1.00` ceiling one paid call was made to `openai/gpt-oss-20b` and the charge the
     provider reported was metered: `spentUsd = 0.0006589`, `unreportedCalls = 0`.
  2. With the ceiling already reached (`AI_PAID_DAILY_BUDGET_USD=0.000001`), the log line
     `AI paid models withheld — the daily paid-spend budget is exhausted` appeared and the turn was
     answered by `nvidia/nemotron-3.5-lightning:free`; no paid request was sent.
  3. With the ceiling reached and **no** free candidate configured, the turn failed after
     `calls=0` with `AiSpendLimitExceeded`; no paid request was sent and no HTTP 500 path was taken.
  4. With `AI_PAID_SPEND_ENABLED=false`, the free model answered and metered spend stayed `0`.
  Total real spend for the whole verification: **$0.0006589**, one paid call.
- **One code change was needed for the required wording to reach a member.** `mapAiFailure()` in
  `server/src/controllers/ai.controller.ts` replaced every quota message with the generic allowance
  sentence, so the guard's specific "daily AI spending limit" text never left the server. The guard
  now throws `AiSpendLimitExceeded` (a subclass of `AiQuotaExceeded`, so no retry or failover
  behaviour changed) and the mapper returns its own sentence with the same HTTP 429 and the same
  client-visible code `AI_QUOTA_EXCEEDED`. A provider's own 429 keeps the generic sentence.
- **Pinned by tests:** `server/test/AI120-paid-spend-guard.test.mjs` (arithmetic, mid-turn
  withholding, the 429 mapping) and the new `server/test/SEC-codeql-triage.test.mjs`.
- **KNOWN LIMITATION, unchanged:** the counter is process-local. A restart resets the day, and two
  instances each get their own ceiling. It is a runaway-spend bound, not an accounting ledger; the
  provider account limit remains the boundary above it.
- **NOT active in production.** Setting the variable requires a Render environment write and the
  available `RENDER_API_KEY` is read-only (403). Until an owner sets it, production remains on the
  shipped default of unlimited.

## 5. CodeQL triage — 22 alerts in four categories, no production vulnerability found

Read site by site on 2026-11-27; none of the four categories contained a genuinely exploitable
defect. Nothing was suppressed, dismissed or archived: dismissing them would hide the next real
finding in the same rule, so each became a property in `server/test/SEC-codeql-triage.test.mjs`.

| Rule | Alerts | Where | Classification |
| --- | --- | --- | --- |
| `js/clear-text-logging` | 4 | `platformAudit.service.ts:110`, `passwordReset.service.ts:240`, `scripts/audit-indexes.mjs:179`, `scripts/check-agent-access.mjs:381` | False positive. The logs interpolate an **action name** (`PASSWORD_CHANGED`, `MFA_ENROLLED`) or an index name, never the row's email, IP, metadata, token, code or password. |
| `js/http-to-file-access` | 8 | `scripts/perf/*`, `scripts/measure-ai-turns.mjs`, `scripts/eval-*.mjs` | Context-dependent, not reachable in production. Developer-run measurement scripts writing an eval report to an operator-chosen path from a body the script itself requested; no runtime module imports `scripts/`. |
| `js/incomplete-url-substring-sanitization` | 6 | `test/AUTH05-reset-link-page.test.mjs`, `test/AI53-real-world-research.test.mjs` | False positive. All six are inside test ASSERTIONS that a crafted host is not reflected. |
| `js/insufficient-password-hash` | 4 | `passwordResetCode/code.ts:117`, `passwordReset.service.ts:178`, `emailVerification/code.ts:147`, `AUTH05-reset-link-page.test.mjs:61` | False positive. These are keyed HMAC-SHA256 digests of a 32-byte random token or a 6-digit code under a server-side pepper, or a CSP `sha256-` hash of an inline script. User passwords use bcrypt, cost 10, in `auth.service.ts`. |

**Rescan (2026-11-27, branch `sec/codeql-triage-rescan`, draft pull request #378).** The branch carries
only the reviewed changes — `aiErrors.ts`, `ai.controller.ts`, `SEC-codeql-triage.test.mjs` and its one
`run-tests.mjs` registration — so the in-progress work in the working tree is deliberately outside the
scan. Analysis of the pull-request ref (run `45948024659`, commit `de869747`) reported **zero findings
in the four triaged categories** and **one new alert in the branch's own new file**:
`js/file-system-race` at `SEC-codeql-triage.test.mjs:102`, a `readdirSync` → `statSync` walk. That was a
real check-then-use pattern introduced by new code, so it was fixed at the source (directory entries
now carry their own type, no second lookup) rather than annotated, suppressed or dismissed; the re-run
analysis (run `45948327813`, commit `4df0c31`) reports **0 results**. Nothing was dismissed, and no
alert was archived. Note that a pull-request analysis reports alerts **in the changed files**; the full
repository picture remains `main`'s own analysis below.

`main` did not move: its analysis at `501fcaa` still holds **195 open alerts**. The four triaged
categories are unchanged at 4 / 8 / 6 / 4 (clear-text logging / HTTP-to-file / URL substring /
insufficient password hash) — 22, as triaged above — because none of those files is in this change.

Deliberately **not** changed: the `js/missing-rate-limiting` findings stay visible and
undecided — **127** of them, not the 93 earlier drafts quoted (that figure counted only the first page
of a paginated list). The existing limiters are auth-only by architecture; adding blanket limiting to the AI
and write routes is an owner decision, not a triage fix. The implication worth naming: an
authenticated member can call the AI chat route up to the existing `aiRateLimiter` budget, and each
such turn can cost money — which is why §4's ceiling matters more than the alert count.

## 6. First encrypted production database backup — created and verified

- **Target:** `inventoryai_prod_db` on the existing Atlas cluster, read-only (`backup:db` only
  reads and writes files). No document, index or user was modified.
- **Archive:** `inventoryai_prod_db-20261127T051751Z.tar.gz.gpg`, 2,226,804 bytes, in
  `/c/Users/jeffe/inventory-ai-backups/archives/` (outside the repository) with its
  `.sha256` sidecar. SHA-256 `ab0377c51f82bb0c6f460cf01712b057d384f37a98e7ee48545558bbf607fe7b`.
- **Contents:** 36 collections, 47,089 documents, 25.2 MB to restore (10,129 products, 13,639
  inventory transactions, 902 purchase orders, 185 suppliers, 12 users).
- **Verified:** the existing run re-checked all 36 plaintext files against the manifest before
  encryption; `--verify` then decrypted the archive, re-verified all 36 files inside it, and
  `sha256sum -c` confirmed the sidecar. No plaintext `.json`/`.jsonl.gz` remains in the output
  directory.
- **Recipient:** a new GPG key, fingerprint `24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26`, generated
  with a passphrase. The negative control (agent cache cleared, decrypt attempted) failed with
  `No pinentry` and produced no plaintext, proving the private key is genuinely protected.
- **Key custody and off-machine storage** were outstanding at the time of that first run; both are
  resolved in §7 below (passphrase moved out of the archive folder, first archive copied to
  OneDrive).

## 7. Backup schedule and retention (procedure only — nothing is scheduled yet)

**Off-machine copy IS established** for this first archive: it was copied with its sidecar to
`C:\Users\jeffe\OneDrive\Inventory-AI-Backups\`, byte-verified there with `sha256sum -c`, and the
running OneDrive client has marked it as a cloud-backed reparse point. That uses the existing
OneDrive account, so no service was purchased. The limit of that check: it proves the local copy is
intact and that OneDrive has taken the file; it is not an independent read-back from OneDrive.

**A daily backup needs only the PUBLIC key.** Encryption is the only step in `backup:db:encrypted`,
so the passphrase (and the private key) is needed solely by `--verify` and `--dry-run-restore`. That
is what makes the custody problem tractable: the daily job can run unattended with no secret on the
host, and the private key can live offline.

### Key custody — passphrase moved off the archive folder (2026-11-27)

- **Where the passphrase now lives:** a Windows DPAPI (current-user) protected blob,
  `C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi` (620 bytes), in a directory whose inherited
  permissions were removed and which now grants only `EWQ\jeffe`, `SYSTEM` and
  `BUILTIN\Administrators`. The plaintext file that used to sit beside the archives
  (`C:\Users\jeffe\inventory-ai-backups\keys\passphrase.txt`) was **deleted**, and that directory is
  now empty. It is outside the repository, outside the archive directory and outside the OneDrive
  folder, so copying the backups no longer copies the key to read them.
- **Limits, stated plainly:** (1) DPAPI protects the blob from other Windows accounts and from the
  file being read after it leaves this computer; it does not stop a process already running as this
  user. (2) The blob is bound to this Windows profile — losing the profile would destroy the only
  copy, so the passphrase should also be recorded in the owner's password manager; that entry is the
  owner's action, not something this note or the agent can perform. (3) The private key itself still
  sits in `C:\Users\jeffe\.gnupg`, so a full host compromise still reaches key and passphrase alike.
- **Retrieval verified before the plaintext copy was removed:** a DPAPI round-trip in a separate
  process reproduced the passphrase byte-for-byte (`roundtrip_match=True`, 44 characters), and the
  value read from that store decrypted the existing archive with all 36 collection files matching
  the manifest (47,089 documents, 2,226,176 decrypted bytes) — so the ability to decrypt and restore
  is intact, not assumed.
- **Backup host needs no passphrase, verified:** with gpg-agent killed and no cached passphrase (a
  decrypt attempt failed with `No pinentry`, exit 2) and with the plaintext copy already deleted, a
  fresh backup succeeded on the public key alone: `inventoryai_prod_db-20261127T054513Z.tar.gz.gpg`,
  36 collections / 47,089 documents, SHA-256
  `753b978ffdca53b8ee09e2731a352fd4e12755b32bda4e4c41bb52a3b674e68c`. Encrypting never needed the
  passphrase, because only the recipient's PUBLIC key is used.
- **Reading the passphrase when a restore needs it:** at this machine, from an ordinary PowerShell
  prompt (the value is printed to the terminal it runs in, so run it only here):
  ```powershell
  $s = ConvertTo-SecureString ([IO.File]::ReadAllText('C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi'))
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  ```
  Only this Windows account can do that: the blob is DPAPI current-user material, so copying it to
  another machine or another profile yields nothing.
- **How verification is run on this host, and why it changed:** `gpg-agent` here answers
  `ERR 67108933 Not implemented` to `PRESET_PASSPHRASE` even with `allow-preset-passphrase` set in
  `gpg-agent.conf`, so the previously documented preset path cannot prime the agent. Verification is
  therefore done with `gpg --pinentry-mode loopback --passphrase-fd 0`, feeding the passphrase from
  the DPAPI store on **stdin** (never a command-line argument, never a file in the repository), then
  checking the extracted files against the archive's own manifest. `--verify` at an interactive
  terminal still works through pinentry; nothing in the wrapper was changed.

| Step | When | Command (from `server/`) | Needs private key? |
| --- | --- | --- | --- |
| Create | Daily, 03:00 `Asia/Manila` (off-peak) | `CONFIRM=backup-db NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db node scripts/backup-db-encrypted.mjs --out="C:\Users\jeffe\inventory-ai-backups\archives" --recipient=24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26` | No |
| Copy off-machine | Immediately after a successful create | copy the `.tar.gz.gpg` **and** its `.sha256` into the OneDrive folder, then `sha256sum -c` there | No |
| Verify contents | Weekly | `--verify=<archive>` | Yes (interactive) |
| Restore rehearsal | Monthly | `--verify=<archive> --dry-run-restore` against `inventoryai_test_db` | Yes (interactive) |

**Retention proposal** (each archive is ~2.2 MB, so 30 copies are ~66 MB — storage is not the
constraint; recovery options are):
- 14 daily copies (covers "the bad change was noticed within two weeks").
- 4 weekly copies, kept from Sundays (covers a month).
- 3 monthly copies (covers a quarter).
- Delete an expired copy only after the newest copy and its sidecar have verified. Never delete the
  last copy, and never delete the private key while any archive encrypted to it is retained.

**What this does and does not protect.** It protects against data loss from a bad migration, a
deleted collection or an Atlas incident, with a recovery point of up to 24 hours and a recovery time
of one restore run. It does not give point-in-time recovery: Atlas M0 has backups and PITR switched
off, so anything written between two backups is gone if the database is lost. That is the trade the
owner accepted by staying on M0; `docs/BACKUP_AND_RECOVERY_OPTIONS.md` prices the tiers that close it.

**Superseded on 2026-11-27:** a Windows Scheduled Task was installed later the same day — see §8.
No old archive was deleted by hand; the first retention pass removed two same-day duplicates.


## 8. Scheduled backups installed, with retention (2026-11-27)

- **What exists now:** Windows Scheduled Task `InventoryAI Daily Encrypted Database Backup`, daily
  03:00 Asia/Manila, running `scripts/run-db-backup.ps1` → `server/scripts/backup-daily.mjs` → the
  unchanged `backup:db:encrypted`.
- **One run:** create (public key only) → copy `.gpg` and `.sha256` to
  `C:\Users\jeffe\OneDrive\Inventory-AI-Backups` under `.incoming` names → verify the copy’s
  SHA-256 → rename both into place → prune both directories.
- **Retention:** 14 daily (newest per UTC day), 4 weekly (newest per ISO week), 3 monthly (newest per
  calendar month), unioned; the newest archive and the current run’s archive are always kept; a `.gpg`
  is deleted only with its `.sha256`.
- **Never automated:** content verification (`--verify`) and restore rehearsals, which need the private
  key and the passphrase. Creating a backup still needs neither.
- **Deliberate binary pin:** the runner puts `C:\Program Files\Git\usr\bin` first on PATH. This host
  also has Gpg4win, whose keyring (`%APPDATA%\gnupg`) does not hold the backup key; the MSYS build
  (`C:\Users\jeffe\.gnupg`) is the one that does, and the one the wrapper’s `C:\…` → `/c/…` argument
  translation assumes.
- **Verified on 2026-11-27:** a real scheduled execution returned `LastTaskResult 0`; the archive it
  produced, `inventoryai_prod_db-20261127T064400Z.tar.gz.gpg` (2,226,804 bytes, SHA-256
  `77b4501279128db384cb4481470a07d8914eb50bf63fe18787d7c608b0e42615`), decrypted with the DPAPI
  passphrase over `--pinentry-mode loopback`, extracted to 36 collections / 47,089 documents, matched
  all 36 manifest hashes, and `sha256sum -c` passed in both directories. No passphrase value was
  printed, logged or stored in plaintext.
- **First-run consequence:** the retention pass removed the two earlier archives of the same UTC day
  (`051751Z`, `054513Z`), because the daily rule keeps one archive per UTC day.
## 9. Off-site backup OAuth client — created, cut over, and verified in production (2026-11-27)

**Why.** rclone's shared Google client is being retired "during 2026", and the daily workflow reaches
Drive through it with `RCLONE_DRIVE_TOKEN`. This section records the replacement client, the evidence
that it works, the cutover as it was actually applied, and the rollback.

**Status: APPLIED and verified in production.** The scheduled workflow now uploads with the dedicated
client (`4b8970f`, `3a1bac5`) and one real run proved the archive reached Drive, was read back and
matched its digest (§9.4). The old `gdrive` remote, its shared-client token and the
`RCLONE_DRIVE_TOKEN` secret were **not** edited: they remain the fallback until the owner revokes the
old grant as a separate, confirmed action. **The cutover is not the two env lines originally
predicted** — §9.4 states what it actually took, and why.

### 9.1 What was created (Backup 1, `watermelonfreebuff98171@gmail.com`)

| Item | Value |
| --- | --- |
| Google Cloud project | `inventoryai-backup-drive` ("InventoryAI Backup Drive"), no organization, **no billing account** |
| API enabled | Google Drive API (`drive.googleapis.com`) |
| Consent screen | External, published **In production** (not Testing — a Testing app expires refresh tokens after 7 days) |
| Scopes | `https://www.googleapis.com/auth/drive.file` only — non-sensitive, so no verification review and no logo |
| Branding | home `https://ai-inventory-l1mi.onrender.com/`, privacy `/privacy`, terms `/terms`; authorized domain `ai-inventory-l1mi.onrender.com` |
| OAuth client | Desktop app, display name `rclone backup` |
| Client credentials file | `C:\Users\jeffe\.backup-secrets\rclone-client.json`, ACL limited to `EWQ\jeffe`, `SYSTEM` and `BUILTIN\Administrators` |
| Local remote | `[gdrive2]` in `%APPDATA%\rclone\rclone.conf` — `type=drive`, `scope=drive.file`, its own client id/secret, its own token |

**A first client was deleted.** The console's "OAuth client created" dialog rendered the secret into the
accessibility tree the agent reads, so that secret was treated as exposed and that client (named
`rclone`) was deleted. The replacement was created and its JSON downloaded
without the secret ever being read into a log or the conversation. Google does not treat Desktop-app
secrets as confidential (an installed app cannot keep one), but the exposed client no longer exists.

### 9.2 Identity consequence of `drive.file`

`drive.file` is scoped per OAuth client: the new client cannot see files the old client created. This
was observed, not assumed — `rclone lsf "gdrive2:InventoryAI-Backups"` returned *directory not found*
before the folder was re-created. The two same-named folders are distinct:

| Folder | ID | Created by |
| --- | --- | --- |
| `InventoryAI-Backups` (old, empty, left untouched) | `1kWKtd2WBfwkXHb_wv9M1Fr95DfHASi9N` | rclone's shared client (`gdrive`) |
| `InventoryAI-Backups` (new, used by `gdrive2`) | `1t8NZk2eguSfQm4HV6HKGLgdqP0kUoiAv` | the `rclone backup` client |

### 9.3 Verification performed

1. `rclone about gdrive2:` → `Total: 15 GiB, Used: 1.311 MiB, Free: 14.999 GiB` — same Drive account,
   authenticated by the new client rather than the shared one.
2. `rclone mkdir gdrive2:InventoryAI-Backups` → rc 0; the folder came back with its own ID
   (`1t8NZk2eguSfQm4HV6HKGLgdqP0kUoiAv`).
3. A 1 MiB random payload uploaded with `rclone copy` (rc 0) and appeared in `rclone lsl` as `1048576`
   bytes.
4. Read back into a **different** directory and hashed on both sides —
   `local_sha256 = 1ffaff4be183fc13f91cfd8a49082f2be1eacad14af686191d4c0409b984ad83`, and the
   downloaded copy hashed identically, so the two match.
5. `rclone check <dir> gdrive2:InventoryAI-Backups` → *0 differences found, 2 matching files*, rc 0.
6. Test artifacts deleted (`rclone delete` / `deletefile`, rc 0); `rclone lsf` then reported 0 files.
7. The old remote still works and is unchanged: `rclone lsf gdrive:InventoryAI-Backups` returned rc 0
   with no error, and its token was never edited.

8. The cutover mechanism itself was tested. With `RCLONE_DRIVE_CLIENT_ID` and
   `RCLONE_DRIVE_CLIENT_SECRET` set and **no config file at all**, rclone listed the folder with rc 0
   and printed no deprecation notice. The control run, identical but with those two variables
   omitted, printed *"This remote uses rclone's shared Google Drive client_id, which is being retired"*.
   Those two variables alone are what switch the app identity.

### 9.4 Cutover — as applied: three secrets and three `env:` lines

**It is three secrets, not two, and the extra one is the reason the first attempt failed.**

1. **Three repository secrets** were added, each value read from its file or token and never echoed:

   ```bash
   gh secret set RCLONE_DRIVE_CLIENT_ID \
     --body "$(node -p "require('C:/Users/jeffe/.backup-secrets/rclone-client.json').installed.client_id")"
   gh secret set RCLONE_DRIVE_CLIENT_SECRET \
     --body "$(node -p "require('C:/Users/jeffe/.backup-secrets/rclone-client.json').installed.client_secret")"
   gh secret set RCLONE_DRIVE_TOKEN_DEDICATED --body "$(node -p "…refresh_token of the gdrive2 token…")"
   ```

   `RCLONE_DRIVE_TOKEN` still exists and was **not** modified or removed.

2. **The workflow's `env:` block** for the step **"Run the encrypted backup and verify the offsite
   copy"** now carries five `RCLONE_*` entries:

   ```yaml
             RCLONE_CONFIG_GDRIVE_TYPE: drive
             RCLONE_CONFIG_GDRIVE_SCOPE: drive.file
             RCLONE_CONFIG_GDRIVE_TOKEN: ${{ secrets.RCLONE_DRIVE_TOKEN_DEDICATED }}
             RCLONE_DRIVE_CLIENT_ID: ${{ secrets.RCLONE_DRIVE_CLIENT_ID }}
             RCLONE_DRIVE_CLIENT_SECRET: ${{ secrets.RCLONE_DRIVE_CLIENT_SECRET }}
   ```

   The workflow's own comment states the same, and names `RCLONE_DRIVE_TOKEN` only as the retained
   rollback secret.

**The finding that made the third secret necessary.** A Google refresh token is **bound to the OAuth
client that issued it**. Applying only the two client variables — as §9.4 originally instructed —
leaves the remote holding the *shared client's* refresh token, and the dedicated client refuses to
refresh it:

- run `45998224472` (the first cutover attempt) failed with `oauth2: "unauthorized_client"` /
  `"Unauthorized"` on the very first Drive call;
- a forced-refresh probe on this host reproduced it deterministically: shared token + dedicated
  client → exit `1` (`unauthorized_client`), dedicated token + dedicated client → exit `0`.

A **valid one-hour access token masks this**, because no refresh is attempted while it is live — so
any probe must check the token's `expiry` first, and a green `rclone lsf` is only evidence once the
stored access token is expired or force-refreshed.

**Verified after the token line was repointed (`3a1bac5`, run `45999116600`, 47 s, exit 0):**

1. The job log shows `uploaded … (2.1 MB)`, `verified … re-downloaded from gdrive:InventoryAI-Backups
   and matched its SHA-256`, and `retain … 1 archive(s) kept on the remote` — upload, read-back and
   digest comparison all happened in CI.
2. An independent read-back on this host used the `gdrive2` remote (the dedicated client) to download
   the archive and its sidecar; `sha256sum -c` passed, digest
   `f6ceab69895703eed85108c6616501aa0913101f02939f5fa87e8fe384f7658c`, archive 2,228,089 bytes,
   sidecar 114 bytes.
3. `rclone lsf gdrive:InventoryAI-Backups` still answers rc 0 (with the shared-client retirement
   NOTICE) and the old folder still holds 0 files: the fallback path was left working and nothing was
   migrated into it.

**Not yet proven, and therefore not claimed:** the durable run record could not be written (the
backup Atlas user holds `read@inventoryai_prod_db` only — see §9.6), so `offsite: 'verified'` is in
the job log and the archive, not yet in `backup_runs`; and no *scheduled* run has exercised the new
token yet.

4. Only after one *scheduled* run also succeeds, revoke the old grant (Google Account → Data & privacy →
   Third-party apps) as a separate, explicitly confirmed action. Until then the fallback stays.

### 9.5 Rollback — revert both commits, not just the token line

The cutover is two commits, and a rollback must revert both; reverting only the token line leaves the
dedicated client configured and the shared-client token in place, which is exactly the
`unauthorized_client` combination above.

1. Revert `4b8970f` **and** `3a1bac5` (or remove the three `env:` lines and restore
   `RCLONE_CONFIG_GDRIVE_TOKEN: ${{ secrets.RCLONE_DRIVE_TOKEN }}` and the old
   `BACKUP_CLOUD_REMOTE` value, i.e. `gdrive:InventoryAI-Backups` under the shared client).
2. `RCLONE_DRIVE_TOKEN` was never edited, so the old remote behaves exactly as it did before the
   cutover once the dedicated client's variables are gone.
3. The project, the client and the `gdrive2` remote can stay configured; they are inert while the
   revert is in place.
4. The new folder holds nothing the old one holds, and the old one is empty, so a rollback loses no
   archive — but note the new folder is the one with the archive in it, so re-running after a revert
   re-uploads to the old folder rather than restoring the file.

### 9.6 Run record — blocked on the backup database user's role (finding; change NOT applied)

- **What the runner needs.** `backup-daily.mjs` opens one `backup_runs` row per execution and closes
  it at the end; `finishBackupRunRecord` is what writes `offsite: 'verified'`. Both writes are
  best-effort by design — a database failure must never fail the archive itself.
- **What the credential holds.** The workflow's `MONGODB_URI` is the least-privilege backup user. The
  copy of that credential this host holds (`BACKUP_MONGODB_URI`) reads back through
  `connectionStatus` as exactly **`read@inventoryai_prod_db`**. Probed against `backup_runs` with it:
  `find` and `listIndexes` succeed; `insert`, `update`, `createIndex` and `remove` are each refused.
- **The symptom.** A run that uploaded its archive and read it back still logged
  `[backup:run-record] could not record the run result: user is not allowed to do action [update] on
  [inventoryai_prod_db.backup_runs]`. The archive, the Drive upload and the digest comparison are
  unaffected; only the durable row is missing. `/api/health/backup` therefore answers `503 missing` —
  correctly, because the newest stored row (written by the Windows scheduled task) is
  `offsite: 'copied'`, which is not an offsite verification.
- **Proposed, awaiting owner approval — NOT applied.** One custom role in the Atlas project, scoped to
  the collection only:
  `{ resource: { db: 'inventoryai_prod_db', collection: 'backup_runs' }, actions: ['insert', 'update'] }`,
  assigned to that user alongside the existing `read@inventoryai_prod_db`. That is the whole change:
  no other database, no other collection, no `remove`, no `dropIndex`, no `createIndex` (`runId_1`,
  `startedAt_-1` and `outcome_1_startedAt_-1` already exist), and reads keep coming from the existing
  `read` role. Custom roles are available on Free clusters as well as dedicated ones.
- **How it will be verified once approved.** Re-run the workflow, then read the row it wrote and
  `GET /api/health/backup`: a SUCCESS row carrying `offsite: 'verified'`, an archive name and a digest
  is the only thing that turns that endpoint from `503 missing` to `200 fresh`.

## 10. GPG private key — offline export (procedure; the copy has NOT been made yet)

The private key still exists **only** in `C:\Users\jeffe\.gnupg` (secret key file
`private-keys-v1.d\E3D7678CF84C0B844F8B59FD1F52688FAB449ECB.key`), and the passphrase **only** as the
DPAPI blob `C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi`. Losing this Windows profile loses
both. No step below generates a new key, and no key material is ever written into the repository.

### 10.1 What the owner must provide (the agent cannot do these)

1. An **encrypted** removable medium — BitLocker To Go, or a VeraCrypt container — mounted with a drive
   letter (written as `D:` below). A plain USB stick is not acceptable: the exported file is protected by
   the passphrase, but the medium is the second line of defence.
2. The passphrase recorded in the owner's **password manager**. The agent will never type it into any
   service, and it must not be stored on the same medium as the key.
3. Explicit go-ahead to run the export.

### 10.2 Export (one command, straight to the mounted medium)

```bash
# armor keeps it text; the file stays protected by the existing passphrase.
# gpg asks for that passphrase (pinentry) before it will export — expected, not a new password.
gpg --armor --export-secret-keys 24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26 > /d/inventory-ai-backup-secret-key.asc
cp "$HOME/.gnupg/openpgp-revocs.d/24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26.rev" /d/
```

The revocation certificate belongs with the key: it is useless to an attacker without the key, and
without it a future compromise cannot be revoked. Then unmount or eject the medium.

### 10.3 Proof that the copy is complete and usable

Run against the medium with a throwaway keyring, so the laptop's own keyring is never the thing being
tested:

```bash
export GNUPGHOME=$(mktemp -d)
gpg --batch --import /d/inventory-ai-backup-secret-key.asc
gpg --list-secret-keys --with-colons | grep -c '^sec'      # expect 1
# decrypt the newest real archive with the passphrase read from the DPAPI store, then
# compare against its .sha256 sidecar and the archive's own manifest
server/scripts/backup-db-encrypted.mjs --verify=<archive>   # or the sha256sum -c path in guide 21 §4/§5
rm -rf "$GNUPGHOME"                                         # destroys the temporary keyring
```

Success criterion: the archive decrypts, its `sha256sum -c` passes and the inner manifest matches —
all without the laptop's `~/.gnupg` being involved.

**Already proven on 2026-11-27, with the medium step still outstanding.** The same export was piped
into a throwaway `GNUPGHOME` (no key file was written anywhere): the throwaway keyring held exactly
1 secret key with fingerprint `24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26`, it decrypted the newest
archive in about a second, the plaintext was 2,226,638 bytes containing 39 entries (37 `.jsonl.gz`
collections), the sidecar `sha256sum -c` passed, and the throwaway keyring was then destroyed. That
run also exposed two details now reflected above: the export needs the passphrase, and a fresh
`GNUPGHOME` needs `allow-loopback-pinentry` in its own `gpg-agent.conf` or gpg waits on a pinentry
dialog that never appears.

### 10.4 Related fix made the same day

`~/.gnupg/gpg-agent.conf` gained `allow-loopback-pinentry` alongside the existing
`allow-preset-passphrase`, and the agent was restarted. Scripted decryption with
`--pinentry-mode loopback --passphrase-fd` now completes in about a second with no pinentry dialog,
which is what makes the §10.3 check and `--verify` automatable. Verified with a fresh 8 KiB
encrypt→decrypt round trip whose SHA-256 matched.
