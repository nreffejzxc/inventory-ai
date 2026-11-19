# Security Policy

Inventory AI is a multi-tenant inventory system: a React Native app, an Express/MongoDB
API and a read-only AI assistant. This page explains how to report a security issue and
which versions are supported.

## Supported versions

The `main` branch is the only supported version. There are no tagged releases or
backports; fixes land on `main`. A report against an older commit is checked against the
current `main` behaviour.

## Report a vulnerability privately

**Do not open a public issue, discussion, fork, gist or pull request for a vulnerability.**

Use GitHub's private vulnerability reporting:

<https://github.com/nreffejzxc/inventory-ai/security/advisories/new>

You can also open the repository's **Security** tab and choose **Report a vulnerability**.
The repository is public, so this private channel is the only safe way to send a report.
If the form is unavailable, contact the maintainer through the address in the repository's
commit metadata.

Do not disclose the issue publicly until a fix has shipped.

### What to include

- The component (`server/` or `mobile/`), endpoint, screen or file, and the affected
  commit or branch.
- The smallest reproduction: steps or a request that shows the problem.
- The impact, including whether it crosses a tenant boundary, escalates a role, bypasses
  authentication, or exposes credentials or personal data.
- Evidence such as a request/response pair, log excerpt or screenshot, with **your own
  secrets redacted**.

### Never send

- Real credentials, API keys, tokens or password hashes.
- Production data, or data belonging to a business you do not own.
- Anything obtained by accessing another tenant's data.

## Scope

In scope:

- Server authentication, sessions, logout, revocation and account recovery.
- Authorization and RBAC, including routes reachable without the required capability.
- Business (tenant) isolation, including any route that trusts a client-supplied
  `businessId`.
- The AI boundary: reading outside the caller's business, writing data, or reaching the
  database except through the server-side read-only tools.
- Mobile credential storage, session handling and reset/verification deep links.
- Repository and CI security, including exposed secrets or a workflow that could run
  untrusted code with credentials.

Out of scope: reports requiring a rooted or jailbroken device, physical access to an
unlocked device, or a modified client without server-side impact; missing security
headers alone; automated scanner output without a demonstrated impact; denial-of-service
or load testing; social engineering; and issues in third-party services.

Before reporting, check the maintained records for already-known and accepted items:

- [`docs/AUTH_SECURITY_MASTER_CHECKLIST.md`](docs/AUTH_SECURITY_MASTER_CHECKLIST.md)
- [`docs/SECURITY_DEPENDENCY_DECISIONS.md`](docs/SECURITY_DEPENDENCY_DECISIONS.md)

These are not withheld findings; they are the project's open security record.

## Testing rules

- Test only against accounts, businesses and data you own.
- If you reach data you do not own, stop and report it immediately. Do not download,
  retain or share it.
- No denial-of-service, load or stress testing, and no scanning that degrades the service.
- No social engineering or physical attacks.
- There is no bug-bounty programme and no payment for reports.

## What to expect

Reports are triaged on a best-effort basis. There is no guaranteed response time or SLA;
the target is an initial acknowledgement within five business days. You will be told
whether the report is accepted and updated when a fix ships. Credit is offered if you
want it and withheld if you prefer.

## Related controls

- [`docs/SOURCE_PROTECTION.md`](docs/SOURCE_PROTECTION.md) — what protects the source and
  what does not.
- [`docs/AUTH_SECURITY_MASTER_CHECKLIST.md`](docs/AUTH_SECURITY_MASTER_CHECKLIST.md) — the
  security invariants, control status and open decisions.
- [`.github/workflows/`](.github/workflows/) — the CI gates, including secret scanning,
  dependency review and the workflow invariant guard.
