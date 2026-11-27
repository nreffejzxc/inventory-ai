# 21. Backups — find, create, verify, decrypt and restore

This is the owner's own copy of the backup procedure. It is written so you can work alone, including
during an incident. Every command here was run against this machine and this database; anything that
is **not** working is marked as such rather than described as if it were.

Two deeper documents sit behind this one and still win if they disagree:
[`BACKUP_ENCRYPTED_RUNBOOK.md`](../BACKUP_ENCRYPTED_RUNBOOK.md) (the wrapper's contract) and
[`BACKUP_AND_RECOVERY_OPTIONS.md`](../BACKUP_AND_RECOVERY_OPTIONS.md) (what the paid Atlas tiers buy).
The dated record of the work is in [`SECURITY_CHANGE_2026-11-27.md`](../SECURITY_CHANGE_2026-11-27.md) §6–§7.

## What exists right now — status at a glance

| Thing | State |
| --- | --- |
| Backup program | **Implemented and working** — `server/scripts/backup-db.mjs` plus the encrypting wrapper `backup-db-encrypted.mjs` |
| Encryption | **Working** — GPG, one key pair, archive encrypted to the public key |
| Automatic schedule | **Installed** — Windows task `InventoryAI Daily Encrypted Database Backup`, daily 03:00 `Asia/Manila` (§9) |
| Off-machine copy | **Automatic** — the same run copies the archive and its sidecar to OneDrive and re-checks the SHA-256 there |
| Atlas's own backups | **Unavailable on this plan.** M0 has no snapshots and no point-in-time recovery |
| Restore of production | **Not supported by the shipped tools.** `restore:db` refuses any production target by design |
| Restore of a disposable database | **Working and drilled** — verified on 2026-11-23 with a 16-document synthetic database |

**The one sentence to remember:** a backup only exists when you run the command, and the copy on this
laptop is only half a backup until it is in OneDrive as well.

---

## 1. What is inside a backup

`backup:db` reads **the whole database** and writes **one gzipped file per collection**, plus a
`manifest.json` that records each file's document count and SHA-256. Then the wrapper packs those
files into one archive and encrypts it.

- **Which database:** whatever `MONGODB_DB_NAME` resolves to. Both archives on disk are
  **`inventoryai_prod_db`**. Nothing backs up the development database unless you ask for it.
- **How much:** every document of every collection, with no filter, no sample and no exclusion. Only
  MongoDB's own `system.*` collections are skipped — the application has none.
- **Last verified backup (2026-11-27 05:45 UTC):** 36 collections, 47,089 documents, 2.5 MB gzipped,
  25.2 MB when restored, from MongoDB `8.0.39`.

The 36 collections actually present, with their document counts in that backup:

| Collection | Docs | Collection | Docs | Collection | Docs |
| --- | --- | --- | --- | --- | --- |
| `ai_conversations` | 224 | `integrity_monitor_heartbeats` | 1 | `platform_admins` | 1 |
| `ai_feedback` | 6 | `integrity_recovery_leases` | 0 | `platform_audit_events` | 363 |
| `ai_messages` | 728 | `inventory` | 20,191 | `platform_deployments` | 27 |
| `ai_turn_metrics` | 214 | `inventory_transactions` | 13,639 | `platform_support_tickets` | 1 |
| `audit_alert_deliveries` | 0 | `invitations` | 0 | `product_imports` | 0 |
| `audit_failures` | 0 | `locations` | 15 | `products` | 10,129 |
| `audit_logs` | 298 | `ops_error_events` | 0 | `purchase_orders` | 902 |
| `audit_outbox` | 0 | `ops_feature_usage` | 62 | `sessions` | 34 |
| `businesses` | 7 | `password_reset_challenges` | 0 | `stock_movement_operations` | 7 |
| `categories` | 43 | `password_reset_tokens` | 0 | `stock_transfer_operations` | 0 |
| `email_verification_challenges` | 0 | `platform_admin_guards` | 0 | `suppliers` | 185 |
| `idempotency_records` | 0 | `platform_admin_sessions` | 0 | `users` | 12 |

So yes: products, stock, transactions, purchase orders, suppliers, users, locations, categories, AI
conversations, audit history and the platform tables are all in there — everything the application
writes, in one archive.

**A v2 backup carries the structure as well as the documents.** Since 2026-11-27 the manifest is
`inventory-ai-backup/2`: each collection entry also records

- its **collection options** — `validator`, `validationLevel`, `validationAction`, `capped`, `size`,
  `max`, `collation`, `changeStreamPreAndPostImages`, `timeseries` (only these, from a fixed
  whitelist, so a future MongoDB option cannot be captured by accident); and
- its **index definitions** — key, name, `unique`, `sparse`, `expireAfterSeconds`
  (the TTL indexes), `partialFilterExpression`, `collation`, text-index weights/language, geo and
  wildcard options. `_id_` is excluded: every collection has it and it cannot be created.

A restore then reapplies both: options first (a validator is a creation-time property and applies to
the inserts that follow), documents next, indexes **last**, so a unique index is built over the
restored data and therefore proves it rather than being bypassed by it.

**v1 archives are still readable, but they never captured any of this.** An archive written before
2026-11-27 restores documents only; `restore:db` prints a `WARNING` block saying exactly that, and its
final `structure:` line reads `NOT restored` instead of a count. Do not read a successful v1 restore
as proof that indexes or validators came back.

**What a backup still cannot contain:** anything written after it. It is a *snapshot of one moment*.
A backup whose shape could not be read records the reason in that collection's `shapeError`, and the
restore prints it as a `WARNING` rather than quietly rebuilding nothing.

> **A backup is a full copy of your credentials.** `users` holds password hashes, `sessions` holds
> live session rows, `platform_admins` holds the platform operator record. That is exactly why the
> archive is encrypted and why the passphrase must never sit next to it. Never share an archive,
> never put one in the repository, and never upload a *decrypted* copy anywhere.

---

## 2. Where the files are

```text
C:\Users\jeffe\inventory-ai-backups\
├── archives\                                  ← encrypted backups (the real thing)
│   ├── inventoryai_prod_db-20261127T064400Z.tar.gz.gpg          2,226,804 bytes
│   └── inventoryai_prod_db-20261127T064400Z.tar.gz.gpg.sha256          114 bytes
└── keys\                                      ← now EMPTY (the passphrase was moved out)

C:\Users\jeffe\OneDrive\Inventory-AI-Backups\  ← the off-machine copies (same four files)

C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi   ← the passphrase, protected (620 bytes)
C:\Users\jeffe\.gnupg\                                ← the GPG key pair itself
```

In Git Bash those are `/c/Users/jeffe/inventory-ai-backups/...` and so on.

**How to identify an archive:** the name is
`<database>-<YYYYMMDD>T<HHMMSS>Z.tar.gz.gpg`, where the timestamp is **UTC**. `20261127T054513Z` is
27 November 2026, 05:45:13 UTC — about 13:45 in Manila. **The newest timestamp is the newest backup.**
Every archive must have its `.sha256` file beside it; a `.gpg` without its sidecar is treated as
untrustworthy.

To see what you have, newest last:

```bash
ls -lh /c/Users/jeffe/inventory-ai-backups/archives/
ls -lh /c/Users/jeffe/OneDrive/Inventory-AI-Backups/
```

**OneDrive:** every scheduled run copies the new archive and its sidecar there and re-checks the
SHA-256. What that proves is that the local copy is intact and OneDrive has taken the file; it is
not an independent read-back from the cloud. **Retention is in force** — 14 daily / 4 weekly /
3 monthly, applied to both folders (§9).

---

## 3. Create a backup (manual — this is the only way today)

You do **not** need the MongoDB Atlas website. The script connects with the connection string already
in `server/.env` (`MONGODB_URI`) and reads whatever database the environment names. You need: this
laptop, internet, and the commands below in **Git Bash**. The read of the production database took about
7 seconds for 47,089 documents (05:45:14 → 05:45:21 UTC); encryption adds a second or two.

### Production backup (the one you actually want)

```bash
cd /c/Users/jeffe/inventory-ai/server

CONFIRM=backup-db NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  node scripts/backup-db-encrypted.mjs \
  --out="C:\Users\jeffe\inventory-ai-backups\archives" \
  --recipient=24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26
```

Why each part is there:

- `CONFIRM=backup-db` — the script refuses to run without the exact phrase. It is a speed bump, not
  a security control.
- `NODE_ENV=production` + `MONGODB_DB_NAME=inventoryai_prod_db` — the configuration layer **refuses
  to open the production database from a non-production process**. Both are required; without them
  you would silently back up the development database.
- `--recipient=<40 hex characters>` — the public key fingerprint. Encryption needs **only** this;
  the private key and the passphrase are not needed to create a backup.
- `--out=...` — must be outside the repository; the script refuses a path inside it.

### Development backup (rehearsal, or if you ever need it)

```bash
cd /c/Users/jeffe/inventory-ai/server
CONFIRM=backup-db node scripts/backup-db-encrypted.mjs \
  --out="C:\Users\jeffe\inventory-ai-backups\archives" \
  --recipient=24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26
```

### What success looks like

The last lines must be:

```text
[backup:db:encrypted] checksums: 36 file(s) matched the manifest before encryption
[backup:db:encrypted] archive  : ...\archives\inventoryai_prod_db-<UTC stamp>.tar.gz.gpg
[backup:db:encrypted] sha256   : 753b978f...
[backup:db:encrypted] OK — encrypted backup is ready.
```

If the run fails, it **deletes its own half-written output** — a surviving archive is a complete one.
No plaintext `.json`/`.jsonl.gz` should ever be left in `archives\`.

> **Do not interrupt it once encryption starts**, and do not copy the `.gpg` file while it is still
> being written. Wait for `OK — encrypted backup is ready.`

### Then copy it off the machine (30 seconds, and it is your real protection)

```bash
cd /c/Users/jeffe/inventory-ai-backups/archives
cp -p inventoryai_prod_db-<UTC stamp>.tar.gz.gpg \
      inventoryai_prod_db-<UTC stamp>.tar.gz.gpg.sha256 \
      /c/Users/jeffe/OneDrive/Inventory-AI-Backups/
cd /c/Users/jeffe/OneDrive/Inventory-AI-Backups
sha256sum -c inventoryai_prod_db-<UTC stamp>.tar.gz.gpg.sha256
```

The last command must print `... OK`. Do not delete the local copy afterwards.

---

## 4. Check that a backup is good — three levels

| Level | Command | What it proves | Needs private key? |
| --- | --- | --- | --- |
| 1. File integrity | `sha256sum -c <archive>.sha256` | The file is exactly the file that was written (no corruption in transit or on disk) | No |
| 2. Contents | `--verify=<archive>` | The archive decrypts, and every file inside matches the SHA-256 recorded in its manifest | **Yes** |
| 3. Restore rehearsal | `--verify=<archive> --dry-run-restore` | All of the above, plus the restore path accepts the contents without writing anything | **Yes** |

Level 2 is the one that matters, because level 1 cannot tell you the archive is readable:

```bash
cd /c/Users/jeffe/inventory-ai/server
```

Run this **in an interactive Git Bash window** so the pinentry dialog can ask for the passphrase. The
final line must be:

```text
[backup:db:encrypted] OK — archive, checksum and manifest all verified.
```

and it prints the manifest totals above it (`36 collection(s), 47089 document(s)`, `36 file(s) inside
the archive`). That is your proof the archive contains all 36 collections and the expected records.

**A run without a terminal cannot ask for a passphrase.** If you start `--verify` from a script, a
scheduled job or a pipe, it fails in under a second with `No pinentry` — that is the designed
behaviour, not a broken backup. For a non-interactive check, read the passphrase out of its protected
store and feed it to gpg on **stdin** with `gpg --pinentry-mode loopback --passphrase-fd 0`; the
exact commands are in the runbook’s **Verification on this Windows host** section. The
`PRESET_PASSPHRASE` route does not work on this host (gpg-agent answers
`ERR 67108933 Not implemented`).

If a check ever fails — wrong digest, `Backup is corrupt`, `Backup is incomplete`, a missing sidecar —
**stop**. Do not restore that copy, do not "fix" its hash, and do not overwrite it. Use the previous
archive and make a fresh backup.

---

## 5. Keys and the passphrase

There is exactly one key pair, made for backups on 2026-11-27:

| | Value / location |
| --- | --- |
| Fingerprint | `24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26` |
| Identity | `Inventory AI DB Backup <backup@inventory-ai.local>` |
| Public key | In this machine's keyring (`C:\Users\jeffe\.gnupg`) — **encrypts**. Not needed for anything else |
| Private key | Same keyring (`C:\Users\jeffe\.gnupg\private-keys-v1.d`) — **decrypts**. Protected by the passphrase |
| Passphrase | `C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi`, 44 characters, readable only by this Windows account |

- **Public key** = the padlock. The backup command uses it. Keep it on any machine that creates
  backups. It is safe to share.
- **Private key** = the key to the padlock. Only decryption and restore use it. If it is lost, every
  archive ever made becomes unreadable. If it leaks *and* the passphrase leaks, someone can read your
  customer data.
- **Passphrase** = what unlocks the private key. It is stored encrypted by Windows (DPAPI), bound to
  your Windows login, in a folder only your account can read. It was moved out of
  `inventory-ai-backups\keys\` on 2026-11-27 and the plaintext file was deleted.

### Reading the passphrase when a restore needs it

At **this** machine, in PowerShell:

```powershell
$s = ConvertTo-SecureString ([IO.File]::ReadAllText('C:\Users\jeffe\.backup-secrets\gpg-passphrase.dpapi'))
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
```

It prints the passphrase to that window; type it into the pinentry dialog, then clear the window.
Only your Windows account can do this — copying the file elsewhere yields nothing.

### Using it, rule by rule

- Type it **only** into the pinentry window that gpg opens. Never into a command, an environment
  variable, a `.env` file, a chat, a screenshot or a document.
- Creating a backup never needs it. Only `--verify`, `--dry-run-restore` and decryption do.
- Do **not** create a second, unprotected key to make unattended verification easier. The passphrase
  is what makes the archive useless to a thief.

### Two gaps you should fix

1. **The passphrase has no second copy.** DPAPI ties it to this Windows profile: reinstall Windows, or
   lose the profile, and the passphrase — and therefore every archive — is gone. Put it in your
   password manager. That is a one-minute job and it is the single most important thing on this page.
2. **The public key is not exported anywhere.** A second backup machine would need
   `gpg --armor --export 24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26 > inventory-ai-backup-pubkey.asc`
   first. That file is safe to store and safe to share.

---

## 6. Decrypt and look inside a backup (by hand)

Only needed if you want to inspect an archive, or if the wrapper's `--verify` is unavailable. Do this
in a temporary folder **outside** the repository and delete it afterwards.

```bash
mkdir -p /c/Users/jeffe/AppData/Local/Temp/inv-open
cd /c/Users/jeffe/AppData/Local/Temp/inv-open

gpg --output backup.tar.gz \

tar -xzf backup.tar.gz -C .
ls
```

Enter the passphrase in the pinentry window when it appears. You should get a folder named
`inventoryai_prod_db-<UTC stamp>` containing:

```text
manifest.json            ← database name, collection list, document counts, SHA-256 of every file
products.jsonl.gz        ← one gzipped line-per-document file per collection
inventory.jsonl.gz
inventory_transactions.jsonl.gz
... (36 in total)
```

`manifest.json` is the authoritative statement of what the archive holds — open it in any editor and
read `totals.collections`, `totals.documents` and the `collections` list. One record looks like:

```json
{ "name": "products", "file": "products.jsonl.gz", "count": 10129,
  "bytes": 1694580, "sha256": "…" }
```

Each record also carries `uncompressedBytes` — the space that collection will occupy once restored —
because a restore that does not fit is the failure this repository has actually hit. A v2 record adds
`options` and `indexes` (the structures described in §1), and `manifest.totals.indexes` is their total
across the archive. A v1 record has neither field, and that absence is the difference the restore
warns about.

To read a collection without any tooling, the file is gzip-compressed text with one Extended JSON
document per line:

```bash
gunzip -c products.jsonl.gz | head -3
```

> **Delete the temporary folder when you are done**, with the plaintext inside it:
> `rm -rf /c/Users/jeffe/AppData/Local/Temp/inv-open`. A decrypted copy of the database on a desktop
> is precisely what the encryption existed to prevent.

**Never `tar -x` an archive from someone else.** These archives come from a process you control; the
wrapper guards its own extraction, but tar itself is not a sandbox for hostile files.

---

## 7. Restore — what is possible, and the hard limit

There are two very different situations.

### A. Rehearsal / inspecting a restore (supported, safe, do this monthly)

`restore:db` will only ever touch **`inventoryai_test_db`** or **`inventoryai_dev_db`**. It refuses
production *before it even connects*. Every file is verified against the manifest **before** the
first collection is dropped, and it drops and rewrites **every collection the backup lists**.

⚠️ **Restoring into `inventoryai_dev_db` destroys the development data in those 36 collections.** Do
rehearsals into `inventoryai_test_db`.

```bash
cd /c/Users/jeffe/inventory-ai/server
export MONGODB_DB_NAME=inventoryai_test_db

# 1. Prove it first — verifies every file, writes nothing.
CONFIRM=restore-db node scripts/restore-db.mjs \
  --dry-run
```

Expected last line: `[restore:db] OK — verified N file(s) against the manifest; nothing was written.`

```bash
# 2. Only after the dry run passes: the real restore into the disposable database.
CONFIRM=restore-db node scripts/restore-db.mjs \
```

Success prints a per-collection `inserted` count and ends with `OK — … restored …`, followed by a
`structure:` line. For a v2 archive that line is
`structure: N index(es) recreated, M collection option set(s) applied.`; for v1 it is
`structure: NOT restored — this v1 archive predates structure capture; no index or collection option
was available to rebuild.` If the run says `inserted N document(s) but the manifest recorded M`, or
names an index it could not recreate, the restore stopped in an incomplete state — restore again from
a verified copy.

**A v2 archive rebuilds its indexes and collection options.** The indexes are created after the
documents, so a duplicate row or an unsupported option fails the restore loudly instead of being
skipped; the message names the collection and the index. `_id_` is not recreated (MongoDB owns it).

**A v1 archive cannot.** It predates structure capture, so it restores documents only, and the CLI
says so before the first drop and again in its final `structure:` line. On a disposable database that
is harmless for a rehearsal, but it is not a faithful reconstruction. A database you intend to *use*
afterwards needs its indexes created some other way — `npm run migrate:required-indexes` covers the six
required guards, but it has **not** been exercised as part of a restore drill, so treat it as
unverified until someone does. For a collection whose shape the backup could not read, the restore
prints a `WARNING` naming `shapeError`; that archive has no proof of that collection's structure.

The easier route for a rehearsal is the wrapper's own dry run, which decrypts, verifies and calls
`restore:db --dry-run` in one step:

```bash
cd /c/Users/jeffe/inventory-ai/server
export MONGODB_DB_NAME=inventoryai_test_db
node scripts/backup-db-encrypted.mjs \
  --dry-run-restore
```

It must print `DRY RUN — nothing will be written`.

### Index names when a backup crosses environments

Index names are **per collection** and a restore **drops each collection before rebuilding it**, so
a name recorded in a manifest can never collide with whatever the target database held. Manifests
therefore need no normalisation: the restore is name-faithful, and a cross-environment run restores
the names the archive recorded. Verified 2026-11-28 by restoring a 35-collection, 144-index archive
into a second database: the canonical index came back with its `unique` and partial filter intact,
and re-declaring it produced no error.

One divergence was real, though, and worth knowing about. `purchase_orders` carries the DRAFT-replay
guard on `(businessId, requestKey)`; development and test had it as `businessId_1_requestKey_1`
(MongoDB's generated name) while production had `uniq_purchase_order_request_key`. The key, the
`unique` flag and the partial filter were identical — the difference was **naming only**. The cause
was a split declaration: `PURCHASE_ORDER_REQUEST_KEY_INDEX` named the index, but `schema.index()` did
not pass that name on, so a boot created the generated name while `migrate:required-indexes` created
the explicit one. `evaluateRequiredIndex` matches on keys, so both environments reported *ready*
while MongoDB refuses to create the second name over the same key (`IndexOptionsConflict`, code 85) —
which is what a boot or a restore-then-boot would hit.

It is corrected at the source: the model now declares `name`, development and test were rebuilt under
`uniq_purchase_order_request_key`, and production already had it. `npm run audit:indexes` reports
**0 declaration/database disagreements** over 144 declared indexes.

⚠️ An archive written **before 2026-11-28** from development or test records the old generated name,
so restoring it reproduces that name. Rebuild the index afterwards (drop the generated one, create
`uniq_purchase_order_request_key` with the same key, `unique` and partial filter) before the API
boots against the restored database; otherwise the boot logs `IndexOptionsConflict` for that index.

### B. Production lost data — the honest answer

**There is no button, script or command that restores production.** The restore tool refuses a
production target on purpose, so it cannot be misused, and Atlas M0 gives you no snapshots and no
point-in-time recovery to fall back on. Getting production data back currently means a developer
writing a one-off import (the files are gzipped Extended JSON, which `mongorestore` cannot read) —
that is a manual, unverified-until-done operation.

What that means in practice:

- **Recovery point:** the newest backup. If backups are daily, up to 24 hours of work is gone. If the
  last backup is a week old, up to a week is gone.
- **Recovery time:** unknown for production size. The only measured drill was 16 documents / 7
  collections: **16/16 documents in 3.0 s**, 5.1 s end-to-end. That proves the code path and that
  Decimal128/Date/ObjectId survive — it does not prove a 47,089-document production restore.
- **The only real fix** is either an automated daily backup you actually keep, or a paid Atlas tier
  with snapshots (§[`BACKUP_AND_RECOVERY_OPTIONS.md`](../BACKUP_AND_RECOVERY_OPTIONS.md)). Until one
  of those exists, this is a best-effort copy, not a disaster-recovery plan.

---

## 8. Emergency playbook — production data lost or damaged

Read this **before** you need it.

**First: stop the damage, and do not improvise.**

1. **Stop writes.** Ask a developer to pause the Render service (or take the app out of use). Every
   extra write makes the gap between the backup and now bigger.
2. **Do not run `cleanup`, `seed`, `restore:db` or any script with `CONFIRM=` against production.**
   `restore:db` cannot target production; the cleanup and seeding tools can, and they delete data.
3. **Do not overwrite or delete the newest archive or its `.sha256`.** It is your only recovery point.
   Do not re-encrypt, rename or edit it.
4. **Write down what happened and when** (time, what was run, what disappeared). This is what decides
   which backup is the right one to use.

**Then, in this order:**

5. **Check what you have.** `ls -lh /c/Users/jeffe/inventory-ai-backups/archives/` — note the newest
   timestamp, then confirm the OneDrive copy exists too.
6. **Verify the newest archive** (§4, level 2). If it fails, step back to the previous one. Never
   restore an archive that failed verification.
7. **Contact a developer with three facts:** the archive filename (with its UTC timestamp), the result
   of the verification, and the time window of lost data. Production recovery needs a custom import —
   this is the step that cannot be done alone today.
8. **Meanwhile, rehearse the restore** into `inventoryai_test_db` (§7 A) so the outcome is known
   before anyone touches production, and so the data is proven readable.
9. **After recovery:** take a fresh backup immediately, then establish why it happened and whether the
   backup cadence was the limiting factor.

**If the machine itself dies:** you still need (a) the archives — they are in OneDrive, so they
survive; (b) the **passphrase** — *only* in the DPAPI store on this laptop, which is precisely why it
must also be in your password manager; (c) the **private key** — only in `C:\Users\jeffe\.gnupg`,
which is **not** backed up anywhere. Without the private key, the archives cannot be opened even with
the passphrase. Export it to offline storage (`gpg --armor --export-secret-keys <fingerprint>`,
protected by the same passphrase) and keep it somewhere other than this laptop.

---

## 9. Schedule and retention — installed

A Windows task named **`InventoryAI Daily Encrypted Database Backup`** runs the whole cycle daily at
**03:00 Asia/Manila** (this machine is `Singapore Standard Time`, UTC+8). It is registered by
`scripts/register-db-backup-scheduler.ps1` and runs `scripts/run-db-backup.ps1`, which calls
`server/scripts/backup-daily.mjs`.

Each run, in order:

1. creates the encrypted archive exactly as §3 describes — public key only, no passphrase;
2. copies the `.gpg` and its `.sha256` to `C:\Users\jeffe\OneDrive\Inventory-AI-Backups`, checks the
   copy’s SHA-256, and only then renames the pair into place;
3. applies retention in both folders;
4. records the run as **`MANUAL`**, not `SCHEDULED` (`scripts/run-db-backup.ps1`). `SCHEDULED` means the
   GitHub Actions schedule, the only execution the server can attest. Until 2026-11-28 this wrapper
   said `SCHEDULED`, which produced rows the attestation reader could not prove *and* masked the
   genuine GitHub run, because the newest `SCHEDULED` claim is the one judged. The backup itself is
   unchanged by the label.

**Retention — 14 daily, 4 weekly, 3 monthly** keeps the newest archive of:

- each of the 14 most recent UTC days,
- each of the 4 most recent ISO weeks,
- each of the 3 most recent calendar months,

and unions those sets with the newest archive and the one the run just created. A `.gpg` is only ever
deleted together with its `.sha256`, and unrecognised files are never touched. The practical effect is
**one archive per UTC day**: a second backup on the same day replaces the earlier one at the next
retention pass. The first retention run on 2026-11-27 did exactly that and removed the two same-day
archives from 05:17 and 05:45 UTC.

What the schedule does **not** do:

- it does not verify archive *contents* — that needs the private key and the passphrase, so it stays
  manual (weekly `--verify`, §4 and §5);
- it does not run while this Windows account is signed out. A missed run happens at the next sign-in
  (`-StartWhenAvailable`), so a laptop that is off for days has no backups for those days;
- it is not point-in-time recovery: the newest copy can be up to 24 hours old.

Check it, or run a day by hand:

```bash
cd /c/Users/jeffe/inventory-ai
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-db-backup.ps1
powershell -NoProfile -Command 'Get-ScheduledTaskInfo -TaskName "InventoryAI Daily Encrypted Database Backup" | Format-List LastRunTime,LastTaskResult,NextRunTime'
tail -30 "$LOCALAPPDATA/InventoryAI/db-backup-scheduler.log"
```

`LastTaskResult : 0` plus a final `SUCCESS` line means the day’s copy exists in both places.

At ~2.2 MB per archive, the retained set is a few tens of megabytes — storage is not the constraint,
recovery options are.

### When a run fails, you get an email

A `FAILED` run — and a run still marked `RUNNING` after two hours, which the console shows as
`INTERRUPTED` — sends one alert to `BACKUP_ALERT_EMAIL` through the existing mail provider. The
message names the run id, what triggered it, when it started and finished, which archive (if any) it
produced, and the runner's own failure text, so the console row and the email describe the same
execution.

It contains no passphrase, no key and no archive content. It is sent *after* the durable row is
written, and one alert per run is enforced in the database, so a retried or repeated check cannot
mail the same failure twice. With `BACKUP_ALERT_EMAIL` empty nothing is sent: the run record and the
scheduler log are the only record, and the alarm line is written at error level instead.

An `INTERRUPTED` alert is raised by the **next** run — the process that would have reported the
result is gone — so if this machine stops running backups entirely, the email cannot say so. The
offsite schedule below and `GET /api/health/backup` are the watcher for that case.

To see the state of the alert for a run, open Backups & Restore in the platform console; the run row
keeps its claim, its sent time and the last delivery error.

### The offsite schedule — GitHub Actions, Google Drive, no laptop required

The Windows task above only runs while this account is signed in. The **offsite** schedule is the
copy that does not depend on this machine: `.github/workflows/backup-daily.yml` runs the same
`server/scripts/backup-daily.mjs` daily on GitHub's own runners and uploads the encrypted archive to
Google Drive.

| What | How |
| --- | --- |
| When | `schedule: '40 2 * * *'` (02:40 UTC daily), plus `workflow_dispatch` for a manual run |
| Trigger delay | GitHub fires scheduled workflows late — measured **9.5–12 h** on this repository's own `typescript-7-watch`. A daily backup with a 30-hour freshness alarm tolerates that; a strict 03:00 promise would not |
| Dump | the existing `backup:db` (driver-based, no `mongodump`), verified against its manifest before encryption |
| Encryption | `backup:db:encrypted`, public key only, fingerprint `24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26` |
| Upload | `rclone` to `gdrive:InventoryAI-Backups`, `drive.file` scope, token supplied through the environment |
| Proof | the archive is **re-downloaded** from Drive and its SHA-256 compared with the `.sha256` sidecar before the run may report `offsite: 'verified'` |
| Retention | the same 14/4/3 planner, applied to the remote; the newest archive is always kept |
| Idempotency | `--skip-if-today` reads the date out of the archive's own name, so a second delivery the same UTC day exits 0 without a second archive, run row or email |
| Alarm | `GET /api/health/backup` answers **200** only when the newest `SUCCESS` run carries a verified offsite archive no older than `BACKUP_MAX_AGE_HOURS` (default 30); otherwise **503** |

The GPG **private** key and its passphrase are not in Actions, in Drive, or in any secret: the job
holds only the public key, so it can encrypt but never decrypt. A decryption still happens on this
machine, with the offline key (§5).

`offsite: 'verified'` therefore means something specific and narrow: *the bytes were read back from
Drive and matched*. It does not mean the archive was decrypted and restored — that is the manual
rehearsal in §4 and §7A, and it remains the only proof of a **restorable** backup.

Add one UptimeRobot monitor so a missed run is not silent: keyword monitor on
`https://ai-inventory-l1mi.onrender.com/api/health/backup`, keyword `"fresh":true`, alert when the
keyword is **not** found. The free plan covers this (50 monitors, 5-minute checks, keyword type).

### What `/api/health/backup` publishes about the *schedule*

`fresh` answers "is there a restorable recent archive". It does not answer "did the automated pipeline
make it" — a legitimate manual recovery run satisfies `fresh` too. Two fields answer the second
question, and they are judged on the newest run that **claims** `SCHEDULED`, not on the newest run
overall:

| Field | Meaning |
| --- | --- |
| `scheduledAttested` | `true` only when that claim is proved: `source: github-actions`, `event: schedule`, a numeric run id, a 40-character SHA, `workflowRef` naming `.github/workflows/backup-daily.yml` on `refs/heads/main`, and `platform: linux` |
| `attestationReason` | Why it is `false` — no claim yet, no provenance recorded, not from GitHub Actions, the event was `workflow_dispatch`, a malformed run id or SHA, a different workflow file or branch, or a non-Linux platform. `null` when attested |
| `scheduledRunId`, `attestedAt` | Which run was judged, and when it finished |

Every older row has `attestationReason: "no provenance was recorded for this run …"` and cannot
become attested retroactively. The laptop task deliberately records `MANUAL` for that reason; `SCHEDULED`
is reserved for the GitHub schedule, and a local run that claimed it would also shadow the genuine
GitHub run, because the newest claim is the one judged.

### Healthchecks.io — the dead-man switch

The freshness endpoint is still a proxy: it reads a row the runner writes, so a broken row write, a
paused monitor or a deleted monitor all look like silence. The heartbeat inverts that — the runner
pings an outside service **after** the archive exists and its record is written, and the service alerts
on the *absence* of the ping.

| What | How |
| --- | --- |
| Service | healthchecks.io, free plan, account `jeffernmalinaoqwe@gmail.com` |
| Check | one check named for the backup, period **24 hours**, grace **6 hours**, email notifications enabled |
| Success signal | `POST` to the check's ping URL, sent only after `closeRunRecord` reports the record was written |
| Failure signal | `POST <ping-url>/fail` when a run that already knows it failed ends |
| Where the URL lives | GitHub Actions secret **`BACKUP_HEARTBEAT_URL`**; read from the environment by `server/scripts/backup/heartbeat.mjs`, never logged, never in a run record |
| If unset | the runner prints `heartbeat: NOT delivered (not-configured)` and carries on — no ping, no failure, and **no monitoring** |

A 24-hour period with 6-hour grace alarms about 30 hours after the last ping, which is the same
window `BACKUP_MAX_AGE_HOURS` (30) uses, so the two signals do not disagree about what "late" means.

**`BACKUP_HEARTBEAT_URL` is set (2026-11-28).** A real run through `scripts/run-db-backup.ps1` logged `heartbeat: heartbeat delivered (HTTP 200)` and the check read `up`. With the secret absent the pipeline
still backs up and still records runs; there is simply no out-of-band alarm if it stops. Check it with
`gh secret list --repo nreffejzxc/inventory-ai`, which prints names and update times only — never a
value. Set or rotate it from a **file**, so the URL never enters a shell history, a chat or a log:

```bash
gh secret set BACKUP_HEARTBEAT_URL --repo nreffejzxc/inventory-ai \
  < C:/Users/jeffe/.backup-secrets/healthchecks-ping-url
```

The ping URL is a write capability: anyone holding it can report a backup that never happened. Keep it
in that file, not in the repository, not in `server/.env`. An ordinary laptop run stays silent because
the workflow supplies the variable from that secret; only a deliberate local export satisfies the monitor.

Secrets the workflow needs are listed at the top of the workflow file. Set them in
**Settings → Secrets and variables → Actions**; the Drive token comes from `rclone authorize "drive"`
on a machine with a browser, and it is the only credential in this design that can act on your Drive.

## 10. Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `Refusing to back up: no output directory was given` | `--out`/`BACKUP_DIR` missing | Pass `--out=` with a path outside the repository |
| `Refusing to back up: "…" is inside the repository` | Dump path inside the project | Use `C:\Users\jeffe\inventory-ai-backups\archives` |
| `Refusing to configure the database: … production database … while NODE_ENV=development` | Missing `NODE_ENV=production` for a production backup | Add both `NODE_ENV=production` and `MONGODB_DB_NAME=inventoryai_prod_db` |
| `confirmation phrase did not match` | `CONFIRM=` missing or wrong | Use the exact phrase (`backup-db` / `restore-db`) |
| `Refusing to encrypt: the recipient must be a full 40-character GPG fingerprint` | Short key id used | Use `24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26` |
| `No pinentry` / `public key decryption failed` | No terminal for the passphrase prompt, or the agent has no cached passphrase | Re-run in an interactive Git Bash window; or read the passphrase per §5 |
| `ERR 67108933 Not implemented` from `gpg-connect-agent` | The host's agent rejects `PRESET_PASSPHRASE` even with `allow-preset-passphrase` | Use the loopback method in §5; do not fight the agent |
| `no manifest.json in "…" — this is not a backup directory` | Pointed `--from` at the extracted folder's parent | Pass the folder that contains `manifest.json` |
| `Backup is corrupt: "<file>" has SHA-256 …` | Archive damaged or tampered with | Do not restore it; use an older verified archive |
| `Refusing to restore: "inventoryai_prod_db" looks like a production database` | You asked for a production restore | Expected. Production restore is not supported (§7 B) |
| `MONGODB_URI names the database "…", but this run targets "…"` | Connection string and target disagree | Fix the URI or the target; nothing was written |
| Restore stops: `over your space quota` | The Atlas free tier is full | Free space or restore into a smaller target; the backup is fine |

---

## 11. Rules that keep this safe

1. **Never** put an archive, a decrypted dump or the passphrase inside the repository.
2. **Never** create an unprotected GPG key to make automation easier.
3. **Never** delete the private key while any archive encrypted to it still exists.
4. **Never** delete the last archive, or a `.gpg` without also deleting its `.sha256` (they travel
   together).
5. **Never** restore into `inventoryai_dev_db` or production by hand-editing a guard.
6. **Always** verify before restoring, and always rehearse before trusting.
7. Password hashes, session rows and the platform admin record are inside these archives — treat an
   archive exactly like the production database itself.
