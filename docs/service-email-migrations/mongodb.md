# MongoDB Atlas — Blocked; no account change

**Service:** MongoDB Atlas
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Production database:** `inventoryai_prod_db`
**Status:** no authenticated account session; no email, owner, database or credential change.
**Last checked:** 2026-11-12

## What was attempted

- Opened `https://account.mongodb.com/account/login` and selected Google sign-in with the old account
  `jefferndullamalinaozxc@gmail.com`.
- The Google OAuth callback completed the redirect to MongoDB, but MongoDB returned to the signed-out login page
  instead of establishing a session. A repeat attempt reached a blank Okta `auth.mongodb.com` callback page.
- Entering the old email directly reached a password challenge. No password was available in the session, and no
  password reset was submitted.
- No user, organization, project, cluster, database user, network rule, API key or connection string was changed.

## Why this is blocked

The migration needs an authenticated owner session. Without it, the new Gmail cannot be added to the Atlas
organization, and there is no verified way to confirm that the existing production database is still governed by
the correct owner.

The application connects through `MONGODB_URI` as a database user, not through an Atlas management API key. That
connection path was not touched and must not be changed as part of this email migration.

## Keys, credentials and certificates

**None generated, rotated or deleted.** No Atlas API key, database password, connection string, X.509 certificate
or project/cluster identifier was altered.

## Remaining owner actions

1. Sign in to MongoDB Atlas with the old account using its password (or explicitly authorize a password reset).
   Complete any 2FA prompt if Atlas requests it.
2. In Atlas **Organization Access Manager**, invite `jeffernmalinaoqwe@gmail.com` as an **Organization Owner**.
3. Accept the invitation from the new Gmail and verify it can see the organization and the production project.
4. Keep the old account as a rollback owner until the new one is verified.
5. Do not change `MONGODB_URI`, the production database users or the cluster while doing the ownership change.

## Rollback

No change has been made, so the existing Atlas access remains the only access path. Do not remove the old account
until the new account is verified.
