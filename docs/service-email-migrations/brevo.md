# Brevo — Verified

**Service:** Brevo
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Status:** login email changed, confirmed and tested with the new Gmail Google sign-in.
**Last checked:** 2026-11-12

## What changed

- Signed in to Brevo with the old Google account, `jefferndullamalinaozxc@gmail.com`.
- Opened **Settings → Profile → Information** (the working URL is
  `https://app.brevo.com/profile/information`) and confirmed the old login email.
- Changed the email field to `jeffernmalinaoqwe@gmail.com` and selected **Update my profile**.
- Brevo required identity verification and sent a six-digit code to the **old** mailbox. The code was entered and
  accepted.
- Brevo then sent a confirmation link to the **new** mailbox. The link was opened and Brevo reported:
  “Your login email has been successfully modified.”
- Signed out, selected **Sign in with Google**, chose `jeffernmalinaoqwe@gmail.com`, allowed the requested basic
  profile scope, and reached the same Brevo workspace (`inventoryai`, same plan usage and existing navigation).
- The profile page then showed `jeffernmalinaoqwe@gmail.com` in the email field. Brevo's profile does not
  display a separate old-account link; the old email is no longer the login address.

## Configurations updated

| Configuration | State |
| --- | --- |
| Brevo login email | `jeffernmalinaoqwe@gmail.com` |
| Old email session | Used only for the identity-verification step |
| New Gmail Google sign-in | Tested successfully against the same workspace |
| Plan | Existing 300-email allowance retained |
| SMTP/API keys | Not created, rotated or edited |
| Senders/domains/automations | Not edited |
| Password | Not changed |

## Keys, credentials and certificates

**None generated or rotated.** No Brevo SMTP key, API key, sender, domain, DKIM/SPF record, password or
transactional-mail credential was changed. The existing `BREVO_API_KEY` in the production environment was not
touched or printed.

## Remaining owner action

- No further email-ownership action is required. The old email is no longer the login address and no old
  linked-account entry is displayed in Brevo.
- Do not remove or rebind the new Google sign-in without first confirming transactional email and the existing
  `BREVO_API_KEY` integration still work.
