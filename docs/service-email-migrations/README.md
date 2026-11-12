# Inventory AI — Single Gmail Migration

**Canonical address:** `jeffernmalinaoqwe@gmail.com`
**Migration date:** 2026-11-12
**Status:** all seven services verified. The old Gmail has no Inventory AI administrative access, and production is healthy.

The goal is one Gmail address for all Inventory AI service accounts. This directory records what was actually
verified, what changed, what did not change, and what still needs the owner.

| Service | Status | Verified email/access | Document |
| --- | --- | --- | --- |
| GitHub | Verified | `nreffejzxc`; new Gmail identity linked; PR #246 merged; local Git identity set | [`github.md`](github.md) |
| Firebase | Verified | New Gmail Owner; old Gmail removed from Cloud IAM; old Firebase Authentication user disabled | [`firebase.md`](firebase.md) |
| MongoDB Atlas | Verified | New Gmail is sole Organization Owner; old owner removed; production project/cluster healthy | [`mongodb.md`](mongodb.md) |
| Render | Verified | Account email changed and confirmed; service untouched | [`render.md`](render.md) |
| Brevo | Verified | Login email changed, confirmed, and new Gmail Google sign-in tested | [`brevo.md`](brevo.md) |
| Expo / EAS | Verified — already correct | `jeffernqwe` / `jeffernmalinaoqwe@gmail.com` | [`expo.md`](expo.md) |
| UptimeRobot | Verified | Email and Android push confirmed; both monitors UP | [`uptimerobot.md`](uptimerobot.md) |

## Status meanings

- **Verified** — the provider showed the new identity and the relevant sign-in, confirmation or API check
  completed.
- **Blocked** — no authenticated account session was available, so no change was made.

## Completion record

- PR **#246** was merged at `2026-11-12T10:04:27Z`; merge commit
  `af70ab2bf283aa83d16db70fe7306b3c18c9564c`.
- All four required checks on PR #246 passed.
- The docs-only merge does not change the serving application; production still reports commit `c3bd692`.

## Safety rules followed

- No production service, repository, deployment, database connection string or certificate was deleted or
  rotated as part of this migration.
- The old Atlas Organization Owner and the old Firebase/Cloud IAM Owner were removed only after the new owner
  and the production database path were verified. The old Google account itself was retained.
- The old Gmail's Firebase Authentication user was disabled, not deleted, so app data is preserved while
  sign-in is blocked.
- No secret value, password, API key, OTP, MFA secret or recovery code is stored in these files.
- No existing database user, cluster, network rule or `MONGODB_URI` was changed.

## Security state

- Gmail 2-Step Verification is active for `jeffernmalinaoqwe@gmail.com`. The account has an authenticator,
  passkeys and a recovery phone, and **8 backup codes are available**. Google Security Checkup reports the
  account is protected; recent activity shows 2-Step Verification turned on at 2:47 PM and backup codes used
  successfully at 2:54 PM and 7:20 PM; a fresh Gmail login succeeded using a backup code, with a new Windows sign-in at 7:21 PM. The code values are not recorded here; they must stay in the owner's private password
  manager or offline safe.
- Atlas reports email MFA active for the new owner (`hasAccountMultiFactorAuth: true`). A second Atlas factor
  remains an optional hardening step and requires the owner's authenticator or security key.
- Android push was confirmed on the CPH1969 device: UptimeRobot's test produced **DOWN** then **UP**
  notifications at 10:09 UTC. Both monitors report UP.

## Highest-priority owner actions

1. Confirm the remaining 8 Gmail backup codes are stored in the owner's private password manager or offline safe. Do not
   paste them into the repository, chat or a public log.
2. Optionally add a second Atlas MFA factor and enable GitHub 2FA once the owner has a backup method and
   recovery codes.
3. No further provider-side migration action remains for GitHub, Firebase, Atlas, Render, Brevo, Expo/EAS or
   UptimeRobot; save the remaining 8 Gmail backup codes and decide on the optional second Atlas factor.
