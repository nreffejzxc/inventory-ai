# MongoDB Atlas — Verified

**Service:** MongoDB Atlas
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Organization:** `Jeffern's Org - 2025-07-31` (`688b0d813387ea02660bdbaa`)
**Project:** `inventoryaidb` (`6abc7a41d9b5664366642022`)
**Cluster:** `inventoryaidbcluster` — ACTIVE
**Production database:** `inventoryai_prod_db`
**Status:** verified — the new Gmail is a confirmed Organization Owner; the old owner remains for rollback.
**Last checked:** 2026-11-12

## What changed

- The old owner account invited `jeffernmalinaoqwe@gmail.com` as **Organization Owner**. Atlas created the pending
  invitation at 09:32 UTC on 2026-11-12.
- The new Gmail accepted the invitation through Google sign-in. Atlas shows the user as **CONFIRMED**, with role
  **Organization Owner**, and the email verified at 09:44 UTC on 2026-11-12.
- The new owner opened the organization and the `inventoryaidb` project. The project overview shows
  `inventoryaidbcluster` as **ACTIVE**, tier **FREE**, MongoDB **8.0.37**, and 50.91 MB of 512 MB used.
- The old owner, `jefferndullamalinaozxc@gmail.com`, remains a confirmed **Organization Owner** and still has
  project access. It was intentionally retained for rollback.
- The application continues to connect through `MONGODB_URI` as a database user. No application connection path
  was changed.

## What did not change

- `MONGODB_URI` was not changed.
- The production database, cluster, database users, network access rules and project identifier were not changed.
- No production data was modified.
- No Atlas API key, database password, connection string or X.509 certificate was generated, rotated or deleted.
- No project or cluster was recreated.

## Atlas onboarding side effect

- Creating the new Atlas user account also created a separate personal organization,
  `Jeffern's Org - 2026-11-12`, containing `Project 0` (`6af58a976512c84140c4d2c4`).
- This is not the production organization. The production organization and `inventoryaidb` project remain the
  only production resources. The migration did not create a cluster, database user or data in the onboarding
  project.
- The onboarding organization has been left in place. Review it and delete it only after confirming it is empty
  and after a separate approval.

## Verification

| Check | Result |
| --- | --- |
| New owner invitation | Accepted; user confirmed |
| New owner email | `jeffernmalinaoqwe@gmail.com`; verified |
| New owner organization role | **Organization Owner** |
| Old owner | `jefferndullamalinaozxc@gmail.com`; confirmed **Organization Owner** |
| Organization access | `Jeffern's Org - 2025-07-31` opens |
| Production project access | `inventoryaidb` overview opens |
| Cluster | `inventoryaidbcluster` is **ACTIVE** |
| Application database path | `MONGODB_URI`, unchanged |

## Keys, credentials and certificates

**No Atlas API key, database user password, connection string or X.509 certificate was generated, rotated or
deleted.** The new Atlas user account is linked to Google; a sign-in password was set during acceptance, but its
value is not stored in this repository. The existing database credentials and `MONGODB_URI` are unchanged.

## Remaining owner actions

1. Keep the old owner account until the rollback window has passed. Remove it only after a separate approval and
   after confirming the new owner can sign in independently.
2. Continue using Google sign-in for the new Atlas owner; use the password-reset flow if a password is needed.
3. Do not change `MONGODB_URI`, the production database users, the cluster or network access as part of this email
   migration.
4. Review Atlas multi-factor authentication for the new owner separately; it is not a prerequisite for this
   completed email change.
5. Review the auto-created `Jeffern's Org - 2026-11-12` / `Project 0`; delete it only after confirming it is empty
   and after a separate approval.

## Rollback

The old owner is still active and still has project access, so no new account is the sole access path. Do not
remove the old owner until the rollback window ends.
