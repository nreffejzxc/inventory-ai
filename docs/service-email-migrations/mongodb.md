# MongoDB Atlas — Verified

**Service:** MongoDB Atlas
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Organization:** `Jeffern's Org - 2025-07-31` (`688b0d813387ea02660bdbaa`)
**Project:** `inventoryaidb` (`6abc7a41d9b5664366642022`)
**Cluster:** `inventoryaidbcluster` — ACTIVE
**Production database:** `inventoryai_prod_db`
**Status:** verified — the new Gmail is the sole Organization Owner; the old owner was removed; production is healthy.
**Last checked:** 2026-11-12

## What changed

- The old owner account invited `jeffernmalinaoqwe@gmail.com` as **Organization Owner**. Atlas created the
  invitation at 09:32 UTC on 2026-11-12.
- The new Gmail accepted the invitation through Google sign-in. Atlas marked the user **CONFIRMED** with role
  **Organization Owner** and verified the email at 09:44 UTC.
- The new owner opened the organization and the `inventoryaidb` project. The project overview shows
  `inventoryaidbcluster` as **ACTIVE**, tier **FREE**, MongoDB **8.0.37**, and 50.91 MB of 512 MB used.
- After the new owner was confirmed with MFA and a recent sign-in, the old owner
  `jefferndullamalinaozxc@gmail.com` was removed from the organization on 2026-11-12.
- The authoritative organization users response now lists only the new owner and the internal
  `charts+6abc7a41d9b5664366642022@mongodb.com` user. The old address is absent.
- The old owner's project access was inherited from its Organization Owner grant; removing that grant removed
  its organization and project access.
- The application continues to connect through `MONGODB_URI` as a database user. No application connection
  path was changed.

## What did not change

- `MONGODB_URI` was not changed.
- The production database, cluster, database users, network access rules and project identifier were not
  changed.
- No production data was modified.
- No Atlas API key, database password, connection string or X.509 certificate was generated, rotated or
  deleted.
- No project or cluster was recreated.

## Atlas onboarding side effect

- Creating the new Atlas user account also created a separate personal organization,
  `Jeffern's Org - 2026-11-12`, containing `Project 0` (`6af58a976512c84140c4d2c4`).
- This was not the production organization. Before deletion it had 0 clusters, 0 database users, 0 network
  entries, 0 processes, 0 apps, no project or organization API keys, and only the owner. It was deleted on
  2026-11-12.
- The production organization and `inventoryaidb` project remain the only production resources.

## Verification

| Check | Result |
| --- | --- |
| New owner | `jeffernmalinaoqwe@gmail.com`; **CONFIRMED**, **Organization Owner**, MFA active |
| New owner last authentication | `2026-11-12T10:37:01Z`; Google sign-in completed |
| Old owner | Removed from the organization; absent from the users response |
| Old owner project access | Revoked with the organization membership |
| Organization access | `Jeffern's Org - 2025-07-31` opens |
| Production project access | `inventoryaidb` overview opens |
| Cluster | `inventoryaidbcluster` is **ACTIVE** |
| Production health | `/api/health` returned 200 with `db: connected` at 10:47 UTC |
| Application database path | `MONGODB_URI`, unchanged |

## Keys, credentials and certificates

**No Atlas API key, database user password, connection string or X.509 certificate was generated, rotated or
deleted.** The new Atlas user account is linked to Google; a sign-in password was set during acceptance, but its
value is not stored in this repository. The existing database credentials and `MONGODB_URI` are unchanged.

## Remaining owner actions

1. The new Gmail is the sole Organization Owner; there is no old-owner rollback grant to remove.
2. Atlas email MFA is active. A second factor is optional; adding it requires the owner's authenticator or
   security key.
3. Keep the Gmail backup codes in the owner's private password manager or offline safe.
4. Do not change `MONGODB_URI`, the production database users, the cluster or network access as part of this
   email migration.

## Rollback

The old owner was removed with explicit approval after the new owner and production path were verified. The
database credentials and `MONGODB_URI` were not changed. Do not re-add the old Gmail to the production
organization.
