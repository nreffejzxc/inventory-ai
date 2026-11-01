# Security Policy

Inventory AI is a multi-tenant inventory management system: a React Native app, an
Express/MongoDB API, and a read-only AI assistant. This file says how to report a
security problem in it, what is in scope, and what is already known and open.

---

## Supported versions

There are **no tagged releases or GitHub Releases yet**. The `main` branch is the
only supported version, and fixes land there. A report against an older commit
will be answered by checking whether that behaviour still exists on `main`.

---

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** — open the **Security** tab and choose
**Report a vulnerability**. The repository is **public**, so a normal issue is public;
do not put a vulnerability report in one. Private vulnerability reporting is enabled and
keeps the report visible only to the maintainer until a fix ships.

**If the form is unavailable**, contact the maintainer at the address recorded in this
repository's commit metadata, or through whatever channel you were already contacted by.

> **Why this is not a public issue.** The repository became public on 2026-10-30 to make
> branch protection and secret scanning available. That makes the code readable by anyone,
> so a vulnerability report must not be filed as an issue. Private vulnerability reporting
> was verified enabled on the same day.

**Do not disclose a vulnerability publicly** — no public fork, gist, blog post, social
post or package — before a fix has shipped.

### What a useful report contains

1. **What and where** — the component (`server/` or `mobile/`), the endpoint,
   screen or file, and the affected commit or branch.
2. **Reproduction** — the smallest sequence of steps or request that shows the
   problem.
3. **Impact** — what an attacker gains. Please say explicitly whether it crosses
   a tenant boundary, escalates a role, bypasses authentication, or exposes
   credentials or personal data.
4. **Evidence** — a request/response pair, a log excerpt, or a screenshot, with
   **your own secrets redacted**.

### What never to send

- Real credentials, API keys, tokens or password hashes.
- Production data, or data belonging to a business you do not own.
- Anything obtained by accessing another tenant's data.

Use an account and business **you own**, on a local or test environment where
possible.

---

## In scope

- **Server authentication and sessions** — Firebase ID-token exchange, the
  Inventory AI JWT and server-side session records, logout, per-session
  revocation, sign-out-everywhere and session renewal.
- **Authorization and RBAC** — role/permission enforcement, the server as the
  only security boundary, and any route that can be reached without the
  capability it requires.
- **Business (tenant) isolation** — any path that returns or mutates another
  business's data, or that trusts a client-supplied `businessId`.
- **Account recovery and verification** — password reset, email verification,
  token handling and the enumeration-resistance of those flows.
- **The AI boundary** — anything that lets the assistant read outside the
  caller's business, act as a write path, or reach the database other than
  through its server-side read-only tools.
- **Mobile client** — credentials reachable from the app bundle or device
  storage, session handling, and deep-link handling for reset and verification
  links.
- **Repository and CI** — secret exposure in workflow definitions, or a
  workflow that could be made to run untrusted code with credentials.

## Out of scope, or already known and open

The project keeps a full, candid security record at
[`docs/AUTH_SECURITY_MASTER_CHECKLIST.md`](docs/AUTH_SECURITY_MASTER_CHECKLIST.md).
The following are **already recorded, and are not withheld findings** — please
read them before reporting:

| Item | State |
| --- | --- |
| **B1** — a residual timing term on the password-reset request path (the outbound send is detached, but the database work remains) | **Accepted for V1 and deferred**; partially mitigated, explicitly **not** closed |
| **B2** and **E3** — shared-store work for rate limiting and related infrastructure | **Deferred to V4**; open |
| **OD-10** — deriving the credential-change marker server-side instead of from the device-local marker | **Deferred by owner decision**; not implemented |
| **L-17** — reset/verification email **delivery** has never been inspected end-to-end against a real mailbox | Open; a mail-provider delivery issue is not a code vulnerability |
| A dependency-level **PII logging** finding noted in that checklist — **ISS-02**, the `@react-native-firebase/auth` Auth-state log that printed the Firebase user object | **Closed.** Patched (§27AJ, 2026-10-10) and verified in the shipped dex and on a device (§27BA, 2026-10-12); the checklist's sensitive-logging row reads resolved |
| Two dependency advisories in the **mobile** lockfile — `zod` (GHSA-mrhx-c7xc-m3w5, **high**) and `deepmerge` (GHSA-gcqx-w48m-w2h4, **low**) | Open; **no applicable fix exists today**. Re-read from the alerts API on **2026-10-30**: **three** open on the then-current lockfile, down to **two** once the `node-forge` fix lands. `node-forge` (GHSA-86w9-cpqp-85rv) was **fixed in the lockfile on 2026-10-30** by a bump from `1.4.0` to `1.4.2` — a patched release the code-signing consumer's `^1.4.0` range already admits, so no override was needed; the GitHub alert closes when that lockfile reaches the default branch. The two remaining packages are build/test tooling, not shipped code: `zod@3.25.76` is reached only by `@expo/cli`'s DevTools-plugin schema, and `deepmerge@4.3.1` only by `@expo/config`'s config loader and `jest-config`, neither of which `expo-updates`' runtime JavaScript imports. Neither has an in-range fix: zod is patched only at **4.6.6+** while the CLI declares `^3.25.76`, and deepmerge has **no patched release** (4.3.1 is both the newest and inside `>= 4.2.0 <= 4.3.1`). Forcing either through an `overrides` entry would break a build tool's dependency contract to silence an alert about code that never runs in the app, so **no dismissal was applied**: both stay recorded here, and `node scripts/check-upgrade-watches.mjs` reports their gates — `DEFERRED` today, `READY` when the newest CLI the latest `expo` admits also admits the patched zod, and `CLOSED` once the installed tree is outside the vulnerable range. Evidence, reachability and the refused override are recorded in roadmap **§27FJ** and **§27GX** |

Also out of scope: reports that require a rooted or jailbroken device, physical
access to an unlocked device, or a modified client build, unless they
demonstrate a server-side impact. Missing security headers alone, and automated
scanner output without a demonstrated impact, will be closed with an explanation
rather than a fix.

---

## Rules for testing

Good-faith research is welcome on these terms:

- **Only against accounts you own.** Never test against another person's account,
  business or data.
- **If you reach data you do not own, stop.** Report it immediately instead of
  exploring further, and do not download, retain or share it.
- **No denial of service**, load or stress testing, or automated scanning that
  degrades the service for anyone.
- **No social engineering** of the maintainer, hosting provider or any third
  party, and no physical attacks.
- Work from your own fork or local environment where the issue can be shown
  there.

There is **no bug-bounty programme and no payment** for reports.

---

## What to expect

Reports are triaged on a **best-effort basis**. There is no guaranteed response
time and no service-level agreement; the target is an initial acknowledgement
**within five business days**.

You will be told whether the report is accepted, and updated when a fix ships.
Credit in the advisory is offered if you want it, and withheld if you prefer.

---

## Repository controls, for reference

These are verifiable settings on this repository, not claims:

- The repository is **public** (owner decision, 2026-10-30).
- **`main` is protected.** Required checks: `server`, `secret-guard`, `attribution-guard` and
  `mobile`; branches must be up to date; administrators are enforced; a pull request is required
  with **0** approvals; force pushes and deletions are blocked; conversation resolution is required.
- **GitHub secret scanning and push protection are enabled**, and
  **`scripts/check-secrets.mjs`** still scans every tracked file on each CI run. The local guard
  catches shapes the GitHub scanner may not, and both remain pattern matching rather than proof.
- **Private vulnerability reporting is enabled.**
- **Dependabot alerts and security updates** are enabled, with version-update configuration in
  [`.github/dependabot.yml`](.github/dependabot.yml).
- The full history scan found **no committed credential**; no `.env`, service-account JSON,
  keystore, `.pem`, `.p12`, `google-services.json` or `GoogleService-Info.plist` was ever tracked.

**Residual limitations, stated plainly:**

1. **The source is public.** Anyone can read, clone, fork, mirror and index it. Branch protection
   gates `main`; it does not make the code private.
2. **The owner can merge their own pull request** after the four checks pass, because the required
   approval count is **0**. That is deliberate for a single-maintainer repository; admin enforcement
   means the rule cannot be silently bypassed.
3. **Forking is allowed** by public visibility. A fork is outside this repository's controls.
4. **No automated check watches visibility or the access list.** `access-guard.yml` was removed on
   2026-10-09 to keep the workflow minimal; `node scripts/audit-access.mjs` is the manual check.
5. **Two owner-side settings are not API-verifiable:** account 2FA and which GitHub Apps can reach
   the repository. Check both in the GitHub UI.
6. **A service-account key was exposed outside the repository.** A local terminal transcript on
   2026-10-25 printed `FIREBASE_SERVICE_ACCOUNT_JSON`; it was never committed, but it should be
   rotated. See [`docs/SOURCE_PROTECTION.md`](docs/SOURCE_PROTECTION.md) §2.
