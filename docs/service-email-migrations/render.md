# Render — Verified

**Service:** Render
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Render account:** `usr-d2avg9mmcj7s73e251u0`
**Service:** `ai-inventory`
**Status:** account email changed and confirmed; service and deployment configuration untouched.
**Last checked:** 2026-11-12

## What changed

- Render account settings previously showed
  `jefferndullamalinaozxc@gmail.com`. The email field was changed to
  `jeffernmalinaoqwe@gmail.com`.
- Render required recent reauthentication. The account was reauthenticated through its existing GitHub login
  method, `nreffejzxc`; no password was created.
- Render sent a confirmation link to the new Gmail, and the Render page confirmed the change. A direct read of the
  account email field then showed **`jeffernmalinaoqwe@gmail.com`**.
- The old email was removed by Render's email-change flow. The GitHub login method `nreffejzxc` remains.

## Configurations and service state

| Item | State |
| --- | --- |
| Account email | `jeffernmalinaoqwe@gmail.com` |
| Login methods shown after change | GitHub `nreffejzxc` |
| Password | Not set (unchanged) |
| Two-factor authentication | Disabled (unchanged) |
| Render API keys | None (unchanged) |
| CLI token | Existing Windows token retained; not rotated |
| Service | `ai-inventory` active, Node, Singapore |
| Service URL | `https://ai-inventory-l1mi.onrender.com` |
| Service/deploy config | Not edited |

The Render dashboard showed `ai-inventory` active after the change. No deploy, environment variable, build command,
health check, repository connection or auto-deploy setting was changed. A fresh external `/api/health` request on
2026-11-12 returned HTTP 200 with `status: ok`, `db: connected`, `environment: production`, and commit
`c3bd692`; the production service remained healthy.

## Keys and credentials

**None generated.** No Render API key, password, SSH key, CLI token or service credential was created or rotated.
The email change does not change the authentication method, as Render stated in its own confirmation dialog.

## Remaining owner action

- The account now has GitHub as its only listed login method. If direct Gmail login is desired, add the new Gmail
  as a login method in Render; otherwise keep the working GitHub login.
- Enabling 2FA remains a separate security decision; it was already disabled before this change.

## Rollback

The old email is no longer listed. The GitHub login remains the recovery path, and the Render account ID and
service were preserved. Do not change the service repository or environment variables as part of the email work.
