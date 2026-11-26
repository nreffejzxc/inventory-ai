# Agent service access

What the agent can check on its own, where each credential lives, and the one command that proves it.
This is the permanent record of the service authentications below; when a credential moves or is
rotated, this file and the matrix date change with it.

**The rule, in three lines.** Credentials never enter chat, a commit, a log or a shell argument. The
server keys live in `server/.env` (untracked) and the CLIs keep their own sessions in the operating
system keyring; the agent uses them, never copies them. MFA codes and backup codes are entered by the
owner only, and are never handled by the agent.

## 1. The one command

```bash
cd server
npm run access:check
```

It makes one read-only call per service and prints a status line — never a key, token, password,
connection string or account email. It is safe to paste its output into an issue.

| Exit | Meaning |
| --- | --- |
| `0` | every configured service answered and the two environments agree on variable names |
| `1` | a configured service failed, or the local and Render variable **names** differ |
| `2` | nothing was configured to check |

The script is `scripts/check-agent-access.mjs`. Each check is deliberately the cheapest read the
service offers: OpenRouter reads the key's own metadata (spends nothing), Brevo reads the account
(sends nothing), Firebase asks Google for a token (no Firebase user, no quota), MongoDB pings the
database.

## 2. The matrix

Status recorded **2026-11-26**: 8 of 9 services answer, 1 is not configured.

| Service | Used for | Credential lives in | Verification | Status |
| --- | --- | --- | --- | --- |
| GitHub | Repository, pull requests, Actions, releases | `gh` CLI session (OS keyring) | `gh auth status` | OK — `nreffejzxc` |
| Render | Production API, deploy status, logs, environment | `render` CLI session (OS keyring); `RENDER_API_KEY` for the variable-name comparison | `render whoami` | OK |
| Render env names | Name drift between `server/.env` and the production service | `RENDER_API_KEY` in `server/.env` (the CLI has no env-var command) | `GET /v1/services/{id}/env-vars`, names only | **Not configured** |
| Expo / EAS | Android builds, OTA update channels | `eas` CLI session (OS keyring) | `eas whoami` | OK — `jeffernqwe` |
| MongoDB Atlas | Database reads, index and readiness checks | `MONGODB_URI`, `MONGODB_DB_NAME` in `server/.env` | read-only `ping` | OK |
| OpenRouter | AI assistant provider, model catalogue, spend | `OPENROUTER_API_KEY` in `server/.env` | `GET /api/v1/key` | OK — paid credits |
| Brevo | Transactional mail, deliverability | `BREVO_API_KEY` in `server/.env` | `GET /v3/account` | OK — free plan |
| Firebase | Sign-in, identities, email verification | `FIREBASE_SERVICE_ACCOUNT_JSON` in `server/.env` | RS256 token exchange; also `npm run verify:firebase` | OK — `inventoryai-d0d20` |
| UptimeRobot | Uptime monitors and alert contacts | `UPTIMEROBOT_API_KEY` in `server/.env` | `getMonitors` (get methods only) | OK — read-only key, 3 monitors |
| Gmail (monitoring) | Reading alert and audit mailboxes | `GMAIL_*` variables in `server/.env` | presence only — see §4 | **Not configured** |

### The Render environment-variable name comparison

The command also compares the **names** configured on the production Render service with the names in
`server/.env`, because a name set in one place and not the other is how a deployment quietly runs on a
default. It prints one extra line:

```text
Render env names    OK    32 names match between server/.env and ai-inventory
Render env names    DRIFT 34 local / 30 on ai-inventory — local-only: JWT_EXPIRES_IN, ROLE_TEST_PASSWORD; Render-only: NODE_VERSION
Render env names    SKIP  RENDER_API_KEY is not set — add a Render API key to server/.env to compare variable names
```

`DRIFT` exits 1, like a failed check, so a script notices. `SKIP` is not a pass: it means the comparison
did not run. The Render CLI (v2.28) has no environment-variable command, so this uses
`GET /v1/services/{id}/env-vars` with `RENDER_API_KEY`; the service is `RENDER_SERVICE_ID` when set,
otherwise the CLI's own list narrowed to this repository. **Values never enter the program**: the names
are parsed at the `=` locally, and the API response is mapped to `envVar.key` on the line it is read, so
no later line can print or compare a value. A refused key reports its HTTP status and nothing else.

## 3. Adding a credential

Every key goes into `server/.env` on this machine, never into a message. A value pasted into chat is
treated as compromised and must be rotated.

| Service | What to do | What to use |
| --- | --- | --- |
| GitHub | `gh auth login` (already done) | Scopes `repo`, `workflow`, `read:org` |
| Render | `render login` (already done) | — |
| Render env names | Add `RENDER_API_KEY=<read access key>` to `server/.env` | Account Settings → API Keys on Render. The key is read-only in effect here: the check only lists names and never reads a value. `RENDER_SERVICE_ID` optionally pins the service instead of resolving it from the CLI's service list |
| Expo / EAS | `eas login` (already done) | — |
| MongoDB Atlas | Already in `server/.env` | Prefer a database user with `read` on the project's databases; the app's own user stays for application writes |
| OpenRouter | Already in `server/.env` | A key named for this purpose with a credit limit at `openrouter.ai/keys` |
| Brevo | Already in `server/.env` | Brevo v3 keys are account-wide, so treat it as full access |
| Firebase | Already in `server/.env`; see `FIREBASE_CREDENTIAL_RUNBOOK.md` | The existing Admin service account |
| UptimeRobot | Add `UPTIMEROBOT_API_KEY=<read-only monitor key>` to `server/.env` | A **read-only** API key from the UptimeRobot account's API settings. A read-only key may call only the `get*` methods: `getMonitors` answers `stat: ok`, while `getAccountDetails` answers `not_authorized` for the same valid key. A `not_authorized` reply therefore means the method is wrong, not the credential. |
| Gmail | Add one pair per mailbox (below) to `server/.env` | An app password, which requires 2-step verification and IMAP enabled |

Gmail variables, one numbered pair per monitoring mailbox:

```
GMAIL_MONITOR_1_USER=<address>
GMAIL_MONITOR_1_APP_PASSWORD=<app password>
```

An app password grants full mailbox access to any local process, so add these only for mailboxes that
exist for monitoring — not for the owner's personal mail. The agent reads them to check that an alert
arrived; it never sends from them.

## 4. What each service authorizes

Within a task the owner has already requested, an `OK` line above means the agent may inspect status,
logs, configuration, indexes, deploys, monitors and quota directly instead of asking the owner to look.
It does not authorize the two things §6.9 keeps with the owner:

- **MFA and credential custody** — enrollment, codes, and the decision to rotate or revoke. A rotation
  is performed by the owner; afterwards the agent re-runs the check to prove the new value works.
- **Destructive or irreversible actions** — deleting a database, bucket, account or mailbox, changing
  billing, force-pushing, or deploying to production. These are stated with their exact target and
  confirmed immediately beforehand, whatever the credential allows.

Gmail's `SKIP`/presence-only line is intentional: a mailbox has no read-only credential, so the check
can record that one exists but must not sign in, fetch a message or print the address.

## 5. Standing workflow

1. **After any credential change** — a rotation, a new project, a revoked key — run
   `cd server && npm run access:check`. A service that fails there is the cause, not a guess.
2. **Before blaming a service** for a failing check or deploy, run the same command; on `OK`, the
   problem is in the project, not the credential.
3. **This document is reviewed every 90 days** (row in `docs/README.md` §2). A review re-runs the
   command, updates the matrix date and status column, and records any service whose credential moved.

Related: `FIREBASE_CREDENTIAL_RUNBOOK.md` (the one credential with its own runbook),
`MONITORING.md` (health endpoints and alerting), `../CLAUDE.md` §6.9 (the delegation itself).
