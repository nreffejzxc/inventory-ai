# Inventory AI — Single Gmail Migration

**Canonical address:** `jeffernmalinaoqwe@gmail.com`
**Migration date:** 2026-11-12
**Status:** all seven services verified.

The goal is one Gmail address for all Inventory AI service accounts. This directory records what was actually
verified, what changed, what did not change, and what still needs the owner.

| Service | Status | Verified email/access | Document |
| --- | --- | --- | --- |
| GitHub | Verified | `nreffejzxc`; new Gmail identity linked; local Git identity set | [`github.md`](github.md) |
| Firebase | Verified | New Gmail accepted Owner invitation; console and all 3 apps open; support email changed | [`firebase.md`](firebase.md) |
| MongoDB Atlas | Verified | New Gmail accepted Organization Owner; organization and production project open; old owner retained | [`mongodb.md`](mongodb.md) |
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
- No push was made. The migration documentation and identity-reference edits are in three local commits only.

## Highest-priority owner actions

1. Confirm the UptimeRobot test push arrived on the Android device; the test email delivery is confirmed.
2. Keep both Atlas owners until the rollback window ends; remove the old owner only with separate approval.
3. Review the auto-created Atlas onboarding organization `Jeffern's Org - 2026-11-12` and `Project 0`; delete
   them only after confirming they are empty and after a separate approval.
4. Optionally harden Render by adding the new Gmail as a login method and enabling 2FA; GitHub 2FA remains the
   owner's separate decision.
5. Do not push the local migration commits until the owner completes the final verification.
