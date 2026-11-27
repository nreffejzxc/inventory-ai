# Backup and recovery options — what Inventory AI can have for $0, and what the money buys

**Written 2026-11-27.** This record exists because the production cluster has **no backups and no
point-in-time recovery**, and the owner asked for the free options first and a priced comparison of
the paid ones, without buying anything.

Nothing in this document has been purchased, enabled or scheduled. It is an assessment, and every
figure below was read from the vendors' own published pricing on 2026-11-27.

---

## 1. The current position, measured

| Fact | Value | Where it was read |
| --- | --- | --- |
| Cluster | `inventoryaidbcluster`, M0 **free** tier, AWS `ap-east-1` | Atlas cluster API |
| Cloud backups | **disabled** (`backupEnabled: false`) | Atlas cluster API |
| Point-in-time recovery | **disabled** (`pitEnabled: false`) | Atlas cluster API |
| Snapshots | none — `restoreJobIds: []`, no schedule | Atlas backup API |
| Data at risk | 12 users, 7 businesses, 10,129 products, 13,639 inventory transactions | read-only count on `inventoryai_prod_db` |
| Volume | 64.29 MB of 512 MB | Atlas cluster API |

M0 has no backup product at all: the Backup page in Atlas is an upgrade prompt, not a disabled
feature. The exposure is therefore "a mistaken write or a bad migration is unrecoverable", not "a
restore is merely slow".

## 2. Free options, evaluated

### 2.1 `mongodump` through the existing tooling — **the only free option that works today**

The repository already carries the tooling: `server/scripts/backup-db.mjs` (plus the
`backup:db`/`backup:db:encrypted` scripts), the wrapper and verification procedure in
[`BACKUP_ENCRYPTED_RUNBOOK.md`](BACKUP_ENCRYPTED_RUNBOOK.md), and a restore path guarded by
`RESTORE_CONFIRM_PHRASE='restore-db'` that refuses any database outside the test/dev allowlist.

- **Cost:** $0. `mongodump` is part of the MongoDB Database Tools.
- **What it needs:** a host that runs the command on a schedule. Today that is a person with a
  terminal; nothing schedules it.
- **What it gives:** a logical dump you can restore into a fresh database, encrypted at rest with GPG
  if the encrypted wrapper is used.
- **What it does not give:** point-in-time recovery. The best recovery point is the last dump.
- **Retention:** whatever you keep on disk. The runbook's cadence/owner/storage fields are still
  blank, which is why this has not been treated as a real backup.
- **Honest limitation:** a dump stored on the same laptop as the repository is not a backup of
  anything except that laptop's disk.

### 2.2 Scheduled GitHub Actions dump → workflow artifact

The same `mongodump`, run by a scheduled workflow, with the dump uploaded as an encrypted artifact.

- **Cost:** $0 within the public-repository Actions allowance; artifacts are retained **90 days** by
  default.
- **Why it is not the default recommendation:** it requires putting the production `MONGODB_URI` into
  GitHub Actions secrets, which moves a production credential into a second platform and widens the
  blast radius the Atlas access-list work just narrowed. It also writes production data into
  GitHub-managed storage. Both are defensible, neither is free of cost in risk.
- **Verdict:** technically free, security-costly. Worth doing only with an encrypted artifact and a
  dedicated read-only database user.

### 2.3 A free object-storage target (Cloudflare R2 free tier)

- **Free allowance:** 10 GB-month of storage, 1 million Class A operations, 10 million Class B,
  **zero egress fees**. Inventory AI's whole database is 64 MB, so the free allowance covers roughly
  150 copies before storage matters.
- **What it would take:** the existing dump script plus an upload step, and an R2 token stored
  somewhere the owner controls.
- **Verdict:** the best free *destination*. It still needs a scheduler (2.2, or a cron on any host).

### 2.4 Free "backup" claims that do not hold up

- **Atlas M0/Flex snapshots:** M0 has none. Flex has **one daily snapshot and no point-in-time
  restore** (see §3).
- **Free domain/hosting bundles advertising "daily backups":** they back up their own platform, not
  a database you connect to from elsewhere.

## 3. Paid options, priced

All figures are AWS list prices read from MongoDB's pricing page on 2026-11-27, excluding tax and
support plans. `ap-east-1` (Hong Kong) carries a regional premium over the US list rate quoted here,
so treat these as a floor.

| Option | Monthly | What you get | Recovery capability | Retention |
| --- | --- | --- | --- | --- |
| **Atlas Flex** | $8–30 (capped) | 5 GB, shared; **one daily snapshot** | Restore from the daily snapshot only; **no PITR** | 2 days |
| **Atlas M10 (Dedicated)** | **$56.94** ($0.08/hr) | 10 GB–128 GB, 2 GB RAM, 2 vCPU; cloud backups included; continuous backup available | Restore whole cluster, or selected databases/collections; PITR to any point in the oplog window (RPO ~1 min) | Default policy: hourly (every 6 h) 7 days, daily 7 days, weekly 4 weeks, monthly 12 months, yearly 1 year |
| **M10 + Continuous Cloud Backup** | $56.94 + storage-based backup cost | Snapshots plus oplog streaming | **True PITR**; window bounded by the hourly snapshot retention | As above, oplog window configurable |
| **Atlas M20** | ~$146 ($0.20/hr) | 20–256 GB, 4 GB RAM | Same backup features as M10, more headroom | Same |

**Weekly equivalent of the recommended step:** M10 is about **$13.11/week**; Flex's $30 ceiling is
about $6.92/week and buys a daily snapshot with no PITR.

**Additional infrastructure costs:** none for Atlas-managed backups — snapshot storage is billed by
size (roughly cents per month at 64 MB) and is included in the tier's backup allowance. A paid tier
also unlocks private endpoints/VPC peering, which would let the Atlas access list be narrowed from
`0.0.0.0/0` to a real network boundary — a second, non-obvious benefit of the same upgrade.

**Why M10 rather than Flex, if one paid step is ever taken:** Flex's single daily snapshot with 2-day
retention still cannot answer "restore to 10:42, before that bad import" — the exact failure mode
this application's write paths can produce. M10 is the first tier whose retention and PITR actually
match the risk. It is also the entry point for private networking.

## 4. Recommendation, in priority order

1. **Now, at $0:** run `backup:db:encrypted` on the existing schedule, keep the encrypted archive
   **off the machine that holds the repository**, and fill in the runbook's cadence/owner/storage
   fields so the procedure has an owner. This converts "no backup" into "a backup as old as the last
   run" — a large improvement for no money.
2. **Before the first real customer:** Atlas **M10** with Continuous Cloud Backup. This is the only
   option that provides point-in-time recovery, and it is the same upgrade that makes a real network
   boundary possible.
3. **Do not** buy Flex for backups alone: one snapshot per day with 2-day retention does not change
   the failure mode that matters here.

## 5. What this document does not claim

No backup has been taken as part of writing it, no schedule exists yet, and no restore has been
rehearsed against a dump. A backup you have never restored is a guess; the runbook's dry-run restore
path exists precisely so that this can be proven before it is needed.
