# Encrypted backup runbook

**Scope:** the local, zero-budget wrapper around the existing `backup:db` and
`restore:db` commands. It encrypts a completed dump with GPG, records a checksum
for the encrypted archive, and can prove the archive by decrypting and running the
existing read-only restore verification.

**This runbook does not authorize production work.** Do not point a backup or a
dry-run at production during an unapproved drill. The commands below use a
disposable `inventoryai_test_db` or `inventoryai_dev_db` target. No cloud
service, paid plan, Render hook or Brevo setting is involved.

## What it preserves

- `backup:db` already writes one gzipped Extended-JSON file per collection and a
  `manifest.json` with each file’s length and SHA-256.
- The wrapper verifies every file against that manifest **before** encryption.
- The archive is encrypted to a GPG public key; the private key is not needed to
  create a backup.
- A `.tar.gz.gpg.sha256` sidecar records the SHA-256 of the encrypted archive.
- With `--dry-run-restore`, the wrapper decrypts the archive to a temporary
  directory, verifies the manifest and every extracted file again, and invokes
  `restore:db --dry-run`. The separate `--verify` mode performs the same
  decryption/manifest verification without a database.
- A passphrase-protected private key is unlocked by `gpg-agent`/pinentry, not by
  the wrapper. The wrapper has no passphrase flag, environment variable or file;
  creation still needs only the public key.
- Plaintext staging and decrypted verification files are removed on success and
  on failure. A crash can leave an OS-temporary directory behind; remove it after
  checking that it is the wrapper’s own `inventory-ai-encrypted-*` or
  `inventory-ai-verify-*` directory.

## Prerequisites

1. Node at the repository version, plus `gpg` and `tar` on `PATH` — the only two
   programs the wrapper runs, and the two it refuses to start without. The
   verification workflow and the suites also use `gpgconf` and
   `gpg-connect-agent`; see **GPG host prerequisite** below for the exact versions
   and which tool does what.
2. A GPG key pair. Keep the private key offline or in the password manager; only
   the public key is needed to create a backup. `--verify` and
   `--dry-run-restore` need the private key. Use the full 40-character
   fingerprint, verified out of band; the wrapper refuses short ids and emails.
   The private key **must have a passphrase**. Do not create an unprotected key
   merely to make unattended verification easier.
3. The output directory must be **outside the repository**, on an encrypted or
   otherwise controlled volume.
4. A disposable database target for the dry-run. The existing restore guard only
   accepts `inventoryai_test_db` and `inventoryai_dev_db`.

Check the public key by fingerprint before using it:

```bash
gpg --fingerprint <recipient>
```

The wrapper uses `--trust-model always` because a backup host often has only the
public key and no local trust path. That makes the **fingerprint itself** the
trust decision: confirm it through a separate channel before the first run, and
reconfirm it after any key import or rotation.

Do not paste a private key, passphrase, database URI or recovery code into a chat,
a shell transcript or this repository.

## GPG host prerequisite

The wrapper itself runs exactly two external programs: `gpg` (encrypt, decrypt) and
`tar` (gzip, list, extract). GnuPG's agent is what unlocks a protected private key,
so the host must have a full GnuPG 2.x installation, not a cut-down `gpg` binary.

| Requirement | Exact form | Needed by |
| --- | --- | --- |
| `gpg` | **GnuPG ≥ 2.1** (2.2 or newer recommended; verified here on **2.4.9**). It must support `--pinentry-mode`, `--quick-generate-key` and `--with-keygrip`, and it must be able to start `gpg-agent`. | Every create and verify |
| `tar` | GNU tar or bsdtar with gzip support (`-czf`, `-tzf`, `-xvzf`). | Every create and verify |
| `gpgconf` | Ships with GnuPG ≥ 2.1. Used by the operator workflow (`--kill`/`--launch gpg-agent`) and by the test suite's cache-clearing control. | Verify workflow, tests |
| `gpg-connect-agent` | Ships with GnuPG ≥ 2.1. Needed only for a non-interactive `PRESET_PASSPHRASE`, which additionally requires `allow-preset-passphrase` in `$GNUPGHOME/gpg-agent.conf`. | Tests; unattended verification |
| Writable `GNUPGHOME` | The agent's own home (`~/.gnupg` or `$GNUPGHOME`). No root, service account or system package is required. | Agent start, tests |

`server/scripts/backup/tools.mjs` checks a program list before a run with a harmless
`--version`, so a missing tool is one clear refusal instead of a failure halfway
through archive creation. The wrapper checks the two programs it runs, `gpg` and
`tar`; `gpgconf` and `gpg-connect-agent` are a separate `AGENT_TOOLS` list that only
the verification workflow and the suites ask for. A backup host therefore needs
only `gpg` and `tar`, and a host without the agent tools still gets an actionable
message the moment a verification step needs them.

Windows note: in this repository's MSYS environment `tar` and `gpg` are MSYS
programs, so the wrapper converts `C:\…` arguments to `/c/…` for those two commands
only. A native Windows `gpg` (Gpg4win) also works, but then `gpgconf` and
`gpg-connect-agent` must come from the same installation.

Check the host before the first run:

```bash
gpg --version                 # first line must say GnuPG 2.1 or newer
gpgconf --list-dirs agent-socket   # proves gpgconf sees the same GNUPGHOME
tar --version
```

If `gpg --version` prints GnuPG 1.x, stop: nothing below works, because there is no
`gpgconf`, no agent preset and no `--pinentry-mode`. Install GnuPG 2.x from your
platform's package manager (Linux: `gnupg`; macOS: `brew install gnupg pinentry-mac`;
Windows: Gpg4win, or the MSYS `gnupg` package) and re-run the three commands.

## Create and verify a backup

From `server/`:

```bash
export BACKUP_GPG_RECIPIENT="<40-character-public-key-fingerprint>"
export BACKUP_DIR="<external-encrypted-directory>"

npm run backup:db:encrypted -- \
  --out="$BACKUP_DIR" \
  --recipient="$BACKUP_GPG_RECIPIENT" \
  --dry-run-restore
```

The `--dry-run-restore` form uses the current `MONGODB_URI` and
`MONGODB_DB_NAME`. Point them at the disposable target first. A
passphrase-protected key can be used here: `gpg-agent` will ask pinentry for the
passphrase. Read the next section before the first run.

```bash
export MONGODB_DB_NAME="inventoryai_test_db"
export MONGODB_URI="<local-or-disposable-test-uri>"
```

The wrapper prints:

- the existing `backup:db` collection progress and document counts;
- the manifest’s collection/document counts and plaintext checksum result;
- the archive path and its SHA-256;
- the number of files verified inside the encrypted archive (when
  `--dry-run-restore` is used);
- the existing `restore:db` dry-run output, which must say `DRY RUN — nothing was
  written`.

Without `--dry-run-restore`, creation needs only the public key and prints a
reminder to run `--verify` later. A successful run leaves exactly two new files in
the output directory:

```text
inventoryai_test_db-YYYYMMDDTHHMMSSZ.tar.gz.gpg
inventoryai_test_db-YYYYMMDDTHHMMSSZ.tar.gz.gpg.sha256
```

No plaintext `manifest.json` or `.jsonl.gz` may remain in the output directory. If
one does, stop and investigate; do not copy the directory anywhere.

## Passphrase-protected private keys

The wrapper deliberately has **no** `--passphrase`, `--passphrase-file` or
`GPG_PASSPHRASE` interface. It invokes `gpg` without `--batch`, inherits the
terminal on stdin, and captures only gpg’s output. That lets `gpg-agent` and
pinentry unlock a protected key without the passphrase appearing in the command
line, an environment variable, a file the wrapper reads, or a transcript. Do not
add such an interface or use one as a workaround.

### Interactive verify (recommended)

From `server/` in a real terminal:

```bash
export GPG_TTY="$(tty)"       # POSIX shell; on Windows omit this and use the pinentry dialog
gpgconf --launch gpg-agent   # starts the agent if it is not already running
gpg --fingerprint "$BACKUP_GPG_RECIPIENT"   # must print the exact 40-hex fingerprint
npm run backup:db:encrypted -- --verify="$BACKUP_DIR/<archive>.tar.gz.gpg"
```

Enter the passphrase **only in the pinentry window/prompt**. The wrapper does not
see it. The expected final line is `OK — archive, checksum and manifest all
verified.`

If pinentry does not appear, or gpg reports `No pinentry`, `Inappropriate ioctl
for device` or a cancelled operation, stop and fix the terminal/agent first;
do not put the passphrase on the command line. Typical recovery is:

```bash
gpgconf --kill gpg-agent
gpgconf --launch gpg-agent
export GPG_TTY="$(tty)"
```

Then retry the same `--verify` command. A passphrase is cached by `gpg-agent`
for its configured TTL; an unattended run works only while that cache is live.
If it has expired, run interactively again. Never create an unprotected key or
store the passphrase in a file just to make a scheduled job work.

### Prove the key is actually protected (optional negative control)

Run this once on the backup host, using a temporary path **outside the
repository**. Clear the agent cache first: a cached passphrase would let the
decrypt succeed even though the key is protected, defeating the control.

```bash
rm -f "${TMPDIR:-/tmp}/inventory-ai-must-not-exist"
gpgconf --kill gpg-agent
gpg --batch --pinentry-mode error --decrypt \
  --output "${TMPDIR:-/tmp}/inventory-ai-must-not-exist" \
  "$BACKUP_DIR/<archive>.tar.gz.gpg"
```

`gpgconf --kill gpg-agent` is mandatory here, not cleanup. With no cached
passphrase, the command must exit non-zero and print a pinentry/passphrase
error. Delete any partial output. If it succeeds after the cache was cleared,
the private key is unprotected: stop and create/import a protected key before
producing backups. Never use that command’s output as a restore copy. The
regression test performs the same cache clear before its negative control and
pins the wrapper’s no-`--batch` decrypt path in a source guard. The DB-independent
`BACKUP-ENCRYPTED-SECURITY.test.mjs` suite also proves temporary-key generation
from stdin, stdin passphrase preset, agent cache clearing, hostile archive member
rejection and the four prerequisite error messages without a database.

### Protected-key dry-run

After the interactive verify succeeds, run the disposable-target rehearsal in
the same terminal:

```bash
export MONGODB_DB_NAME="inventoryai_test_db"
export MONGODB_URI="<local-or-disposable-test-uri>"
npm run backup:db:encrypted -- \
  --verify="$BACKUP_DIR/<archive>.tar.gz.gpg" \
  --dry-run-restore
```

The agent may reuse its cached passphrase or ask pinentry again. The final lines
must include `DRY RUN — nothing will be written` and
`nothing was written.`

## Verify later without a database

```bash
cd server
export GPG_TTY="$(tty)"   # POSIX terminal; omit on Windows
npm run backup:db:encrypted -- --verify="$BACKUP_DIR/<archive>.tar.gz.gpg"
```

This checks the sidecar before opening the archive, decrypts into a temporary
directory, and verifies every manifest SHA-256. A protected key prompts through
pinentry; see the section above. Add `--dry-run-restore` only when
`MONGODB_URI`/`MONGODB_DB_NAME` name a disposable target.

**Trust boundary.** `--verify` proves that the archive matches its sidecar and
that its contents match the manifest; it is not a signature or a proof of who
produced the files. A sidecar can be replaced together with an archive. Verify
only copies from controlled storage, and never open an archive supplied by an
untrusted party with this wrapper. The wrapper rejects absolute paths, path
traversal, backslash-separated member names and link/special-file members before
extraction, but it is not a general-purpose sandbox for hostile tar archives.

The sidecar can also be checked with standard tools:

```bash
cd "$BACKUP_DIR"
sha256sum -c <archive>.tar.gz.gpg.sha256
```

A missing sidecar, a mismatched digest, a missing collection file or a manifest
mismatch is a **stop**. Do not restore that copy and do not try to “repair” its
hash. Use another verified copy.

## Restore rehearsal

The wrapper’s `--dry-run-restore` already performs this check. To repeat it
manually, decrypt and extract outside the repository:

```bash
mkdir -p /tmp/inventory-ai-restore-check
gpg --decrypt --output /tmp/inventory-ai-restore-check/backup.tar.gz \
  "$BACKUP_DIR/<archive>.tar.gz.gpg"
tar -xzf /tmp/inventory-ai-restore-check/backup.tar.gz \
  -C /tmp/inventory-ai-restore-check
```

Then run the existing verifier, which drops nothing:

```bash
cd server
export MONGODB_DB_NAME="inventoryai_test_db"
export MONGODB_URI="<disposable-test-uri>"
CONFIRM=restore-db npm run restore:db -- \
  --from=/tmp/inventory-ai-restore-check/<backup-directory> \
  --dry-run
```

The expected final line is similar to:

```text
[restore:db] OK — verified N file(s) against the manifest; nothing was written.
```

Only after that may an owner-approved restore use the same directory without
`--dry-run`. A real restore is destructive and is **not** part of this runbook’s
approved scope. The restore guard refuses a database whose name is not
`inventoryai_test_db` or `inventoryai_dev_db`.

## Failure handling

| Symptom | Action |
| --- | --- |
| `Missing prerequisite: gpg` / `tar` / `gpgconf` / `gpg-connect-agent` | Install the named tool and put it on `PATH`; no cloud service is needed. The wrapper prints the exact command it tried and the GnuPG 2.x install hint before doing any work. |
| `recipient ... is not present` | Import the public key and verify its fingerprint. |
| `No pinentry`, `Inappropriate ioctl for device`, or a cancelled pinentry | Run in a real terminal with `GPG_TTY="$(tty)"`; restart the agent (`gpgconf --kill gpg-agent`, `gpgconf --launch gpg-agent`) and retry. Do not add a passphrase flag, file or environment variable. |
| `No secret key` / `public key decryption failed` | The private key is missing from this keyring, or the wrong keyring/home is selected. Stop; verify the fingerprint and key custody. Do not weaken the key to continue. |
| Passphrase rejected | Stop after the retry; confirm the passphrase through the documented custody route. Do not keep guessing or reset the key while archives depend on it. |
| `archive ... already exists` | Do not overwrite; choose another output directory or remove the old copy only after confirming retention policy. |
| `checksum sidecar ... missing` | Stop. The archive bytes are not proven. Find the matching sidecar or another copy. |
| `Archive checksum mismatch` | Stop. Do not decrypt or restore. Treat the file as corrupt. |
| `verified ...` fails after decryption | Stop. The encrypted bytes may be intact but the backup contents are inconsistent. |
| dry-run fails | The archive remains available; fix the disposable database/URI and verify again. Do not delete the archive solely because the rehearsal failed. |
| `backup:db: ... inside the repository` | Move `BACKUP_DIR` outside the repository. |
| leftover `inventory-ai-encrypted-*` / `inventory-ai-verify-*` temp directory | Inspect, then remove only that directory. Plaintext may have been staged there. |

## Key custody and retention

- Keep the **public** key on the machine that creates backups; keep the private
  key offline.
- Losing the private key makes every archive unreadable. Losing the passphrase
  has the same effect.
- Copy the encrypted archive and its `.sha256` sidecar together to a second
  controlled location. A backup on one disk is not a backup.
- Do not rotate or delete the only private key while archives encrypted to it are
  still within the retention window.
- This wrapper deletes the plaintext staging copy; it does not delete older
  archives. Retention is a human decision.

## Before the first real backup — exact inputs and decisions

**Do not execute this section now.** It is the form to complete before a later,
separately approved first real backup. A blank is a stop, not a default. Fill in
every value below and keep this copy with the backup record; do not put a private
key, passphrase, database password or full connection URI in it.

### A. Recipient key and custody

- [ ] **Verified recipient fingerprint (exactly 40 hexadecimal characters):**
      `________________________________________`
- [ ] Fingerprint verified on `________________` by `________________` through
      `________________` (a separate channel from the machine that supplied it).
- [ ] `gpg --fingerprint "$BACKUP_GPG_RECIPIENT"` on the backup host prints that
      exact fingerprint; output saved at `________________`.
- [ ] The private key is **passphrase-protected**. The negative control in this
      runbook failed on `________________` (date); it was not skipped.
- [ ] Private-key location/custodian: `________________`; it is offline or in the
      named password manager, not on the backup host.
- [ ] Passphrase storage and recovery owner: `________________`. It is not in a
      shell history, repository file, chat or environment variable.
- [ ] If the backup host is public-key-only,
      `gpg --batch --list-secret-keys` printed nothing; checked on
      `________________`.
- [ ] Key expiry and rotation owner/date: `________________`; old private keys
      remain available while archives encrypted to them are retained.

### B. External destination and copies

- [ ] **External backup directory (absolute path outside the repository):**
      `________________________________________________`
- [ ] The volume is encrypted/controlled, mounted on the backup host, and has at
      least `________` free space; checked on `________________`.
- [ ] **Second controlled off-host location:**
      `________________________________________________`
- [ ] Copy method (archive and `.sha256` sidecar together):
      `________________`; copy verified on `________________`.
- [ ] Access list for both locations: `________________`.

### C. Cadence, retention and ownership

- [ ] **Backup cadence:** `________________` (for example, daily at 02:00
      `Asia/Manila`), timezone `________________`.
- [ ] Who runs it / who is alerted if it is missed: `________________`.
- [ ] Missed-run and failed-run escalation: `________________`.
- [ ] **Retention policy:** `________________` (exact count of copies or number
      of days; not “as long as possible”).
- [ ] Who may approve deletion of an expired copy: `________________`.
- [ ] How often a restore rehearsal is repeated: `________________`.

### D. Rehearsal, approval and scope

- [ ] Disposable database for the dry-run: `inventoryai_test_db` or
      `inventoryai_dev_db`; selected value `________________`.
- [ ] Where its `MONGODB_URI` comes from (do not write the URI here):
      `________________`.
- [ ] The dry-run was completed with `nothing was written` on
      `________________` by `________________`.
- [ ] **First real backup approved by:** `________________`; approved window:
      `________________`; target environment/database: `________________`.
- [ ] This approval is for a read-only `backup:db` run plus encryption only; it
      does **not** authorize a restore, a drop, Render or Brevo work.
- [ ] A real restore has a separate owner, approval and window:
      `________________`.
- [ ] No paid service, cloud plan, Render hook or Brevo setting is required:
      confirmed by `________________` on `________________`.

### Sign-off

| Decision | Value | Owner | Date |
| --- | --- | --- | --- |
| Recipient fingerprint | | | |
| External storage path | | | |
| Second copy location | | | |
| Backup cadence | | | |
| Retention policy | | | |
| Private-key custodian | | | |
| Disposable dry-run database | | | |
| First-backup approver/window | | | |

## Verification checklist

- [ ] `MONGODB_DB_NAME` is the disposable `inventoryai_test_db` (or `inventoryai_dev_db`) for the rehearsal.
- [ ] The output directory is outside the repository and controlled.
- [ ] Only the `.tar.gz.gpg` and `.sha256` files are in the output directory.
- [ ] `sha256sum -c` or `--verify` succeeds.
- [ ] The manifest names the expected database, collections and document total.
- [ ] A passphrase-protected key was unlocked through pinentry; no passphrase was passed to the wrapper.
- [ ] The protected-key negative control failed after `gpgconf --kill gpg-agent` cleared the cache (the key is not unprotected).
- [ ] `--dry-run-restore` finishes with `nothing was written`.
- [ ] The archive and sidecar are copied off-host.
- [ ] No URI, passphrase, private key, Render hook or Brevo recovery code appears in the transcript.
