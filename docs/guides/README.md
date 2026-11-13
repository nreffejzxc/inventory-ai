# Inventory AI — simple guides

Plain-English instructions for running, testing and releasing the app. Nothing here replaces the
technical documents listed at the bottom; if they disagree with a guide, they win.

## Which guide do I need?

| I want to… | Read |
|---|---|
| Start the backend and the app on this laptop | [1. Running on a laptop](1-run-on-your-laptop.md) |
| Run the app on a real phone, and mirror it over USB | [2. Running and mirroring on a phone](2-run-on-your-phone.md) |
| Start the app and mirror it with no cable, in one command | [15. Wireless phone session](15-wireless-phone-session.md) |
| Use a free or paid OpenRouter model, and set its reasoning | [16. OpenRouter models](16-openrouter-models.md) |
| Enable or disable OpenRouter web search and web fetch | [17. Web Search and Web Fetch](17-web-search-and-fetch.md) |
| Look up every AI limit, timeout and safeguard | [18. AI Assistant limits and safeguards](18-ai-assistant-limits.md) |
| Look up an AI error code and what the app shows | [19. AI Assistant error codes and Android messages](19-ai-assistant-error-codes.md) |
| Understand test accounts and what data each one holds | [4. Test accounts and mock data](4-test-accounts-and-mock-data.md) |
| Put data into the development database | [9. Seeding data — development](9-seeding-development.md) |
| Put data into the production database | [10. Seeding data — production](10-seeding-production.md) |
| Delete data from the development database | [11. Deleting data — development](11-deleting-development.md) |
| Delete data from the production database | [12. Deleting data — production](12-deleting-production.md) |
| Work with Firebase logins | [13. Firebase identities](13-firebase-identities.md) |
| Look up any other command or script | [6. Scripts and commands](6-scripts-and-commands.md) |
| Update an installed app without reinstalling it | [7. Updating the app](7-over-the-air-updates.md) |
| Prepare the Google Play submission | [8. Preparing the Play submission](8-play-store-submission.md) |
| Look up a word | [5. Words explained](5-words-explained.md) |

Guides 5 and 6 are references — jump to the word or command you need. Guides 9–13 own the data commands
— one guide for each half in each environment (put it in, take it out), one for the logins — so Guide 6
does not repeat the rules. The complete invocations and the backup/restore procedure are in those guides
and Guide 6; there is no separate runbook.

The numbered filenames are stable links. Guides 3 and 14 were consolidated into Guide 2, Guides 9–13 and
Guide 6; no rule, command or safety procedure was removed.

## Five things to know first

1. **Two halves must both run.** The *backend* holds the rules and talks to the database; the *app*
   is the screen. The app does not work alone.
2. **The database is in the cloud** (MongoDB Atlas). "Database unreachable" is a network problem,
   not a broken install.
3. **The phone is a separate computer.** On the phone, `localhost` means *the phone*, so the laptop's
   backend is reached through a USB tunnel (Guide 2) or a wireless ADB reverse tunnel (Guide 15).
4. **Nothing here is destructive by default.** Dangerous commands are marked ⚠️ and require a
   confirmation phrase.
5. **Only sign-ins you know the password to can sign in.** Deleting a login while its database record
   exists locks that account out permanently (Guide 13).

## Command conventions

Commands are written for **Git Bash**. A `#` line is a comment; `cd` means "be in this folder first".
No output from `typecheck` or `lint` means clean. Settings written as `NAME=value command` apply to
one command only — in **PowerShell** set `$env:NAME="value"` first, then clear it with
`$env:NAME=$null`.

## Authoritative documentation

These guides do not replace: [CLAUDE.md](../../CLAUDE.md) (project rules),
[docs/SYSTEM_SPECIFICATION.md](../SYSTEM_SPECIFICATION.md) (behaviour),
[docs/DEVELOPING_ON_A_PHYSICAL_DEVICE.md](../DEVELOPING_ON_A_PHYSICAL_DEVICE.md) (verified phone
reference), [README.md](../../README.md) (project front door),
[docs/DEVELOPMENT_ROADMAP.md](../DEVELOPMENT_ROADMAP.md) (what shipped, with evidence) and
[docs/AUTH_SECURITY_MASTER_CHECKLIST.md](../AUTH_SECURITY_MASTER_CHECKLIST.md) (security record).

The roadmap is a **record**: dated, long because each entry carries its evidence, and append-only — a
later entry supersedes an earlier one rather than editing it. `CLAUDE.md` is the working contract and
is revised when a rule or index changes. Nothing in either is protected by a checksum, and the five
protected *paths* are listed in the security checklist §8.
`docs/superpowers/plans/` holds dated plans that keep saying what they said then. This folder is the
layer that summarises all of it for a reader who does not need the history.
