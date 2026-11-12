# Inventory AI — Single Gmail Migration

**Canonical address:** `jeffernmalinaoqwe@gmail.com`
**Migration date:** 2026-11-12
**Status:** six services verified; MongoDB Atlas ownership is the only blocked item.

The goal is one Gmail address for all Inventory AI service accounts. This directory records what was actually
verified, what changed, what did not change, and what still needs the owner.

| Service | Status | Verified email/access | Document |
| --- | --- | --- | --- |
| GitHub | Verified | `nreffejzxc`; new Gmail identity linked; local Git identity set | [`github.md`](github.md) |
| Firebase | Verified | New Gmail accepted Owner invitation; console and all 3 apps open; support email changed | [`firebase.md`](firebase.md) |
| MongoDB Atlas | Blocked — no change | No account session or email change | [`mongodb.md`](mongodb.md) |
| Render | Verified | Account email changed and confirmed; service untouched | [`render.md`](render.md) |
| Brevo | Verified | Login email changed, confirmed, and new Gmail Google sign-in tested | [`brevo.md`](brevo.md) |
| Expo / EAS | Verified — already correct | `jeffernqwe` / `jeffernmalinaoqwe@gmail.com` | [`expo.md`](expo.md) |
| UptimeRobot | Verified | Email changed, activated, confirmed by the account API, and test email delivered; both monitors UP | [`uptimerobot.md`](uptimerobot.md) |

## Status meanings

- **Verified** — the provider showed the new identity and the relevant sign-in, confirmation or API check
  completed.
- **Blocked** — no authenticated account session was available, so no change was made.

## Safety rules followed

- No production service, repository, deployment, authentication flow, mail key, database connection string or
  certificate was deleted or rotated as part of this migration.
- Existing owners were retained wherever the provider allowed it, except where a provider itself removes the old
  login email as part of its email-change flow.
- No secret value, password, API key, OTP or confirmation token is stored in these files.
- No push was made. The migration documentation and the five identity-reference edits are in one local commit
  only.

## Highest-priority owner actions

1. Sign in to MongoDB Atlas with the old account and invite `jeffernmalinaoqwe@gmail.com` as an Organization Owner;
   accept it from the new Gmail and keep the old account for rollback.
2. Confirm the UptimeRobot test push arrived on the Android device; the test email delivery is confirmed.
3. Optionally harden Render by adding the new Gmail as a login method and enabling 2FA; GitHub 2FA remains the
   owner's separate decision.
4. Do not push the local migration commit until the owner completes the final verification.
