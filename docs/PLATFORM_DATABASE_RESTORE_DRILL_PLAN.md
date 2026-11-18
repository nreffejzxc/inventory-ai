# Database restore drill — safety and acceptance plan

**Status:** **PLANNING ONLY. NO DATABASE OPERATION IS AUTHORIZED BY THIS DOCUMENT.** No backup was
taken, no restore was run, no Atlas setting was changed, and no production database was touched. The
commands below are a future procedure, not instructions to execute now.

**Reviewed:** 2026-11-17
**Scope:** The production MongoDB Atlas database used by Inventory AI and the `backup:db` /
`restore:db` scripts. This is a restore drill and recovery plan, not a migration or a repair.
**Funding constraint:** Use only free or already-owned resources. Do not create a paid Atlas tier,
paid backup add-on, paid object-store bucket or paid monitoring service for this drill.

## 1. Why this is required

The deployed Atlas tier is **M0**. MongoDB's own documentation says Atlas backups are not available on
free clusters; `backup:db` is the project's recoverable copy. The helper writes one gzipped
Extended-JSON file per collection plus a manifest with each file's SHA-256, and `restore:db` refuses
to target production by name.

What is still unproven:

- A full restore of a **production-sized** backup into a disposable database has never been observed.
- A previous 525,750-document restore hit the free tier's 512 MB quota partway through.
- The backup is data-only: it does **not** contain index definitions, collection validators or other
  collection options. A restored database is not complete until indexes are rebuilt and checked.
- The platform secrets and recovery material have no tested escrow path.

A backup that has never been restored is a hypothesis, not a recovery capability.

## 2. Objectives (provisional owner decisions)

These are proposed starting objectives, not promises. The drill must measure them; the owner must
accept or revise them after seeing the result.

| Objective | Proposed target | Meaning |
| --- | --- | --- |
| **RPO** — acceptable data loss | **≤ 24 hours** while there are no paying customers | The recovery point is the last verified off-host `backup:db` copy; a daily backup means up to a day of changes can be lost |
| **RPO after first paying customer** | **≤ 1 hour** or the owner purchases a backup tier | Free manual backups alone cannot honestly promise one hour; this is a future funding decision |
| **RTO** — database restored and validated | **≤ 4 hours** from the decision to restore | Includes retrieving the backup, verifying hashes, restoring into the target, rebuilding indexes and checking counts |
| **RTO** — full platform usable | **≤ 8 hours** | Includes secrets/configuration, console health, a read-only tenant smoke and the incident record |
| **Drill time box** | **4 hours** | Stop at the box, record the state and do not rush a destructive step |

The current internal, no-paying-user phase may accept **up to 24 hours of loss** for free. That is a
dated business decision, not a permanent recovery promise. Once payments begin, the owner must either
tighten the backup cadence or pay for a provider backup tier.

## 3. Safety principles

1. **Production is read-only in this drill.** `backup:db` may read production; nothing may write,
   drop, repair or index production.
2. **Restore only into a disposable target.** The allowed target names are
   `inventoryai_test_db` and `inventoryai_dev_db`; never the production database.
3. **Use a separate disposable cluster or a local MongoDB.** Prefer a local M0/Community instance or
   a separate free Atlas M0 project. The existing free cluster is shared with production; restoring
   there can consume the same 512 MB quota. The `restore:db` guard checks the **database name**, not
   the cluster identity, so the operator must verify the cluster separately before running it.
4. **Verify before dropping.** The manifest must exist, every file hash must match, and the target
   must be approved before the first drop. `--dry-run` is mandatory.
5. **No production credentials in the disposable environment.** Use a separate low-privilege database
   user/cluster. Never paste the production URI into a drill shell, document or chat.
6. **No backup inside the repository.** `backup:db` refuses a path inside the repo; keep that guard.
   Store the copy on an encrypted external drive or an owner-controlled location, not in Git.
7. **No raw tenant data in evidence.** Record counts, collection names, hashes and timing — not row
   contents, names, emails, product data or secrets.
8. **Two-person safety when possible.** The owner is the only operator today; a second reviewer is
   preferred. If no reviewer is available, record that fact and do not perform the destructive
   restore step without a fresh read-back of the target name.
9. **Stop on surprise.** A size, target, hash, index or privacy surprise is a stop condition, not an
   invitation to improvise.

## 4. Roles

| Role | Responsibility | Current assignment |
| --- | --- | --- |
| **Drill director** | Approves the window, owns stop/continue decisions and signs the evidence | Platform Owner |
| **Safety reviewer** | Independently reads back the target cluster/name, manifest hash and rollback plan | **UNASSIGNED — preferred; record if absent** |
| **Database operator** | Runs the read-only backup and the disposable restore | Platform Owner |
| **Recorder** | Captures timestamps, counts, errors and evidence links | Platform Owner (may be same person) |

A single-person drill is allowed only with the owner's written acceptance; it does not satisfy a
future two-person production recovery standard.

## 5. Preflight checklist

- [ ] Owner approves the drill window and the **provisional RPO/RTO** above.
- [ ] The latest production backup is available; the backup timestamp is recorded.
- [ ] A disposable target exists: local MongoDB or a separate free M0 cluster, with at least the
      estimated uncompressed size plus headroom. If free capacity is below the estimate, **stop**.
- [ ] The target database name is exactly `inventoryai_test_db` or `inventoryai_dev_db`.
- [ ] The target cluster/project is visibly different from production; record the cluster name/ID,
      not the URI.
- [ ] The `MONGODB_URI` in the drill shell points at the disposable cluster; no production URI is in
      the shell history or environment file.
- [ ] The backup directory is outside the repository and is encrypted at rest.
- [ ] The platform owner can retrieve the recovery codes, break-glass instructions and secret escrow.
- [ ] The current production `/api/health` is recorded (`status`, `db`, `environment`, `commit`) as a
      baseline; no production change is made.
- [ ] A stop contact and a rollback/cleanup owner are named.
- [ ] The evidence template is ready; it has fields for counts, hashes, timestamps and errors.

## 6. Procedure (future, not executed)

Use placeholders; never put real URIs, keys or codes in a command transcript.

### Step 0 — Baseline

Record the approved commit, production database name, Atlas tier, collection count, total document
count, uncompressed size estimate, time, operator and reviewer. Take a read-only `/api/health` sample.

### Step 1 — Create the off-host backup

```sh
# Run from server/ against the production environment, read-only.
BACKUP_DIR="<encrypted-external-path>" CONFIRM=backup-db npm run backup:db
```

Record the printed destination, manifest timestamp, collection count, document count and on-disk /
uncompressed sizes. Verify the manifest lists every expected collection and that no partial directory
was left behind. Copy the completed directory to the encrypted off-host location and record its
SHA-256 without printing any secret.

### Step 2 — Verify, do not restore yet

```sh
# Against the disposable environment only.
CONFIRM=restore-db npm run restore:db -- --from="<backup-dir>" --dry-run
```

This must verify every file against its manifest and write nothing. A hash mismatch, missing file or
empty manifest is a **stop**. Record the verified file count and total documents.

### Step 3 — Restore into the disposable target

```sh
# The URI must point at the separate disposable cluster; DB name must be test/dev.
CONFIRM=restore-db npm run restore:db -- --from="<backup-dir>"
```

Before pressing Enter, read back aloud/again:

1. target database name;
2. target cluster name/project;
3. backup manifest path/timestamp;
4. no production URI in the shell.

During the restore, record progress lines per collection and the elapsed time. A quota error,
connection failure or inserted-count mismatch is a stop; do not retry blindly.

### Step 4 — Validate completeness

- Compare every collection's restored count with the manifest; exact equality is required.
- Compare total documents and collection count with the manifest.
- Rebuild indexes through the application's normal model/index path or a separately reviewed
  index-rebuild procedure; do not assume the restore recreated them.
- Run the read-only index/integrity checks and record any missing/extra index. A restore without the
  expected indexes is **incomplete**.
- Start the API against the disposable database and verify `/api/health/ready` and a bounded read-only
  smoke (no writes, no tenant detail).
- Run the focused `OPS1-backup-restore` suite and the relevant index/integrity guards; record the
  exact pass/fail counts.
- Do not run a write/seed/cleanup command against the restored data unless the drill explicitly
  requires it and the target is disposable.

### Step 5 — Measure RPO/RTO

| Measurement | Start | End | Result |
| --- | --- | --- | --- |
| Backup availability | — | Backup manifest finished | |
| Restore start | Operator command | First collection inserted | |
| Data complete | Restore start | All collections match manifest | |
| App ready | Restore start | `/api/health/ready` 200 against disposable DB | |
| Full usable | Decision | Console/read-only smoke passes | |
| RPO | Last verified backup time | Simulated failure time | |
| Loss observed | Manifest timestamp | Latest production change visible | |

The drill is not “passed” because the command exited 0. It passes only when counts, hashes, indexes,
readiness and the read-only smoke all match.

### Step 6 — Cleanup and record

- Remove the disposable database/cluster only after evidence is copied and checked; never touch
  production.
- Remove the drill shell environment and any temporary credentials; rotate anything exposed.
- Record a dated evidence entry with the manifest hash, counts, timings, tests, unexpected findings
  and stop events. No secrets or tenant rows.
- Revise the RPO/RTO only from the measured result.

## 7. Index and collection-option gap

`backup:db` stores documents, not indexes or collection options. That means:

- A fresh restore can have every document and still fail an index-dependent integrity or performance
  check.
- The recovery runbook must include an explicit index rebuild and verification step.
- A future free improvement is to add a read-only index/collection-options manifest to the backup
  tooling and verify it during restore. This is **not implemented** by this plan.
- Until that exists, the drill must compare against the model/index inventory and record the result.

This is a real recovery gap, not a documentation detail. Do not report “restore complete” until it is
closed or explicitly accepted.

## 8. RPO/RTO decision rules

- If the measured RTO exceeds 4 hours for the database, the proposed target is **not met**; record
  the actual result and reduce scope (for example, restore only the platform plane) or accept the
  longer target explicitly.
- If the uncompressed backup cannot fit the free disposable target, **do not** delete production
  data or use the production cluster as the target. Use a local MongoDB instance with enough free
  disk, or defer until free capacity exists.
- If the only available recovery copy is older than 24 hours, the proposed RPO is not met; record the
  age and the data-loss window.
- After the first paying customer, the 24-hour free RPO is no longer acceptable without a signed
  business risk acceptance. The free-only answer is a more frequent manual backup, not a promise of
  zero loss.

## 9. Platform secret escrow

No secret value belongs in this document, the repository, a screenshot or a chat.

### 9.1 Inventory to escrow

- `MONGODB_URI` and the production database user credential.
- `PLATFORM_ADMIN_JWT_SECRET`.
- `PLATFORM_MFA_ENCRYPTION_KEY`.
- `PLATFORM_ACCESS_KEY`.
- `PLATFORM_WEBAUTHN_*` configuration values (not secret, but needed to restore the RP/origin).
- Render, Cloudflare/DNS (if adopted), GitHub, Firebase, Brevo and OpenRouter credentials needed to
  restore the service.
- The guarded break-glass procedure and a pointer to the offline recovery codes (codes themselves
  stay offline, separately from the escrow key).
- The owner's account-recovery methods for Render/Atlas/Cloudflare/GitHub/email.

### 9.2 Storage rules

- Use the owner's **existing** password manager/free vault and an offline sealed copy. Do not buy a
  new secret-management subscription for this drill.
- Restrict access to the owner and a named backup when one exists; record who can open it.
- Do not store the escrow password in the same place as the escrow, the repository, the Render
  environment or a chat.
- Record only the secret **name**, owner, location label, last verification date and rotation date.
- Verify retrieval quarterly by reading a non-destructive sentinel — do not print the secret.
- If a secret may have been exposed, rotate it; do not treat the escrow copy as a reason to delay.

## 10. Stop conditions

Stop immediately if any of these occurs:

- The target database is `inventoryai_prod_db`, looks production-like, or the cluster is not the
  approved disposable cluster.
- The shell `MONGODB_URI` or target name cannot be read back without exposing the URI.
- The backup path is inside the repository, unencrypted, incomplete or missing its manifest.
- Any hash, file count, collection count or document count differs from the manifest.
- The free target cannot hold the uncompressed size; do not delete production or use production as
  the target.
- The restore writes to production, or a production connection is observed.
- Unexpected tenant data, secrets or personal data appear in logs/evidence.
- Index verification fails and the owner has not explicitly accepted the gap.
- The time box is reached, the safety reviewer cannot confirm the target, or the owner is
  unavailable.
- Any command asks for a confirmation phrase that was not expected.

If a stop occurs after the disposable target has been partially written, leave it isolated, preserve
the logs and manifest, and record the exact step. Do not drop, repair or retry production. Cleanup of
the disposable target happens only after the record is captured.

## 11. Evidence template

| Field | Value |
| --- | --- |
| Drill date/time and time zone | |
| Approved commit / production health baseline | |
| Atlas tier and database name | |
| Backup directory label (outside repo) | |
| Manifest timestamp / SHA-256 | |
| Collections / documents / compressed and uncompressed size | |
| Disposable cluster label and target database | |
| Dry-run result (files verified, writes) | |
| Restore start/end and per-collection progress | |
| Restored counts vs manifest | |
| Index/collection-options verification | |
| Focused test results | |
| RPO observed / RTO observed | |
| Stop conditions or unexpected findings | |
| Owner/reviewer sign-off | |
| Follow-up actions and dates | |

## 12. Free-only boundary

This plan deliberately does **not** require:

- Atlas backup add-ons or a paid cluster tier;
- a paid object-storage bucket;
- a paid secret manager;
- a paid monitoring/pager service.

It relies on the existing `backup:db`/`restore:db` scripts, a local or separate free M0 database, an
encrypted external copy, free health checks and the owner's existing vault. If free capacity or a
verified off-host copy is unavailable, the drill is **blocked**, not silently converted to a paid
service. Paid backup/DR can be revisited when revenue exists.

## 13. Sources

- Backup/restore implementation: `server/scripts/backup-db.mjs`, `server/scripts/restore-db.mjs`,
  `server/scripts/backup/lib.mjs`.
- Restore guard tests: `server/test/OPS1-backup-restore.test.mjs`.
- Current acceptance status: [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md)
  and [04 — Production readiness](./platform-console/04-production-readiness.md).
- Atlas free-tier backup limitation: the comments and tests in the files above; verify the current
  Atlas tier in the console before the drill.
