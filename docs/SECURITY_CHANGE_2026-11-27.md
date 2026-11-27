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
