# Source Protection & Intellectual Property

How the Inventory AI source is protected, what that actually prevents, and what it does not.
"Nobody can copy my code" is not a state a software project reaches; the achievable goal is to raise
the cost, narrow the audience, and make the remaining exposure visible rather than assumed.

Measured against the live repository and the GitHub API on **2026-10-30**. The earlier measurements
are kept as history in [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) §27AE and §27AF.

---

## 1. Posture, measured

| Property | State |
| --- | --- |
| Visibility | **Public** — owner decision, 2026-10-30 |
| Who can read it | Anyone, including anonymous visitors and search engines |
| Branch protection | **Enabled on `main`** — required checks `server`, `secret-guard`, `attribution-guard`, `mobile`; strict up-to-date enforcement; administrators enforced; pull request required with **0** approvals; force pushes and deletions blocked; conversation resolution required |
| Secret scanning | **Enabled**, including push protection |
| Private vulnerability reporting | **Enabled** |
| Human access | `jeffernqwerty` (owner, admin); no other collaborators |
| Deploy keys / webhooks / Actions secrets / environments | **None** — no credential exists inside GitHub for this repository |
| Forks | **0** at publication; public forking is allowed |
| Credentials in history | **None found** — no `.env`, keystore, `.pem`, `.p12`, `google-services.json` or service-account file was ever committed; the full 485-commit scan found only deliberate test fixtures |
| Licence | Proprietary, all rights reserved ([`LICENSE`](../LICENSE)) |
| Default `GITHUB_TOKEN` | Read-only; workflows cannot create or approve pull requests |
| Actions | Pinned to full commit SHAs, so an upstream tag move cannot change what CI runs |

`.env`, `server/.env` and `mobile/.env` hold real credentials and are all git-ignored and untracked.

### Two things the API would not answer

Both are owner-side, and both remain the weakest links until checked in the UI:

1. **Two-factor authentication.** `GET /user` returned `two_factor_authentication: null` for the
   token used, so it could not be confirmed. If 2FA is off, nothing else on this page matters — the
   account is the single door.
2. **Which GitHub Apps can reach this repository.** `GET /user/installations` needs an App token
   (`403`), and `GET /repos/…/installation` needs an App JWT. A hosting or CI app with this
   repository selected holds its own credential and is not a collaborator. Read it in **Settings →
   Applications**, and narrow the Render integration to the repositories it needs.

### The audit is manual, by decision

A scheduled `access-guard` workflow was written, ran green, and was removed on 2026-10-09 along with
`main-guard`, to keep the workflow set minimal. Branch protection now gates `main`; it does not watch
the repository's visibility or its access list. What remains is
[`scripts/audit-access.mjs`](../scripts/audit-access.mjs):

```bash
node scripts/audit-access.mjs     # PASS / FAIL / INFO against the live API
```

One dependency-free command, non-zero exit on any violation, names only and never a secret value, and
it lists the settings it could not read so their absence stays visible. **Nothing schedules it, so
when it runs is a habit, not a control.**

---

## 2. Public since 2026-10-30

The repository is public by the owner's decision. The reason was enforcement: on a **private**
repository at this plan level, branch protection and rulesets answer `403 Upgrade to GitHub Pro or
make this repository public`, so CI could report a failure but could not prevent a merge or a direct
push. Public visibility makes branch protection and GitHub's secret scanning available at no cost.

**What public means, stated plainly.** Anyone can read, clone, fork, mirror, index and copy the
source, history, branches, issues and pull requests. The repository was public for roughly 90
minutes on 2026-10-09 as well; the traffic API lags and a clone leaves no permanent record, so **it
cannot be established that no copy was taken**. Publication is a business decision, not a technical
control, and it cannot be recalled by switching back to private.

**Before publication** the current tree, all reachable commits, every branch, every issue and pull
request body, all issue comments and all commit messages were scanned for credential-shaped content.
The only matches were deliberate test fixtures and one quoted dummy PEM header in a pull request
body. No `.env`, service-account JSON, keystore, `.pem`, `.p12`, `google-services.json` or
`GoogleService-Info.plist` was ever committed.

**One exposure is separate from the repository.** On 2026-10-25 a verification command printed
`FIREBASE_SERVICE_ACCOUNT_JSON` into a local terminal transcript. That credential lives in
`server/.env` and the deployment environment; it has never been in the repository, so publication
does not expose it. It should still be rotated (Google Cloud → IAM → the Firebase Admin service
account → new key → replace it in Render and `server/.env` → delete the old key).

---

## 3. What protects it

| Lever | Strength |
| --- | --- |
| **Branch protection on `main`** — four required checks, strict up-to-date, admins enforced, pull request required, force pushes and deletions blocked | **High**; the merge gate |
| **Server-side secrets only** — AI keys, Mongo credentials, mail keys and Firebase admin credentials never reach a client | **High**; enforced by architecture |
| **Server-side tenant isolation and RBAC** — a stolen client cannot read another business's data | **High** |
| **GitHub secret scanning and push protection** | **High** for the shapes they recognise |
| **`scripts/check-secrets.mjs` in CI** — fails a credential-shaped string; every rule carries a canary, so a rule that stopped matching fails the job instead of passing silently | Medium; pattern matching, not proof |
| **`scripts/audit-access.mjs`** | Medium; manual, so only as current as its last run |
| **Pinned action SHAs** | Medium; supply chain only |
| **The protected-file register** — five paths whose contents must not change by accident | **Manual.** The register and its git blob hashes are in [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) §8; **no script verifies them**, so the check happens only when someone runs it |
| **Proprietary licence** — copying is a licence breach, not a grey area | Legal, not technical |

### Deliberately not done

- **No obfuscation of the mobile bundle.** Release builds are minified and use Hermes bytecode
  already; an obfuscator raises the bar marginally, costs build reliability, and creates false
  confidence. **Anything shipped to a device can be read.** The durable answer is to keep valuable
  logic on the server.
- **No repository splitting.** Real overhead, worth doing when the first external collaborator
  appears, not before.

---

## 4. What cannot be prevented

1. **A distributed client can be reverse-engineered** — assume the client's logic is public.
2. **A copy taken while the repository is public cannot be recalled.** Switching back to private
   does not un-publish content that has been cloned, forked or indexed.
3. **Owners and insiders are inside the trust boundary** — least privilege and revocation are the
   only controls.
4. **A compromised machine or token is not a repository problem** — the ignored `.env` files hold
   live credentials.
5. **Public is not encrypted** — anyone can read the source and its history.
6. **No technical measure enforces a licence.**
7. **Branch protection gates the branch, not the review.** With **0** required approvals, the owner
   can merge their own pull request after the four checks pass. `enforce_admins: true` removes the
   silent bypass; changing the settings is now an explicit act.
8. **Forking is allowed by public visibility.** A fork is outside this repository's controls, and
   personal-account repositories have a limited ability to restrict it.
9. **Nothing notices on its own.** A changed visibility, a new collaborator, a deploy key or a
   webhook is discovered only when the audit is run.
10. **GitHub Apps are outside every CLI check.** Reviewing that list in the UI is the single most
    likely way access is granted without the audit noticing.

---

## 5. What to do, in order

**Now**

1. **Turn on 2FA with a hardware key** for GitHub, Render, MongoDB Atlas, Firebase, Brevo and the app
   stores; keep recovery codes offline. This protects more than everything else here.
2. **Review the Render and any CI integration's repository access** (§1).
3. **Keep the four required checks and admin enforcement on `main`.** Do not relax a check to make a
   pull request merge; fix the check or the change.
4. **Keep three backups that are not the same account**: the working clone, an encrypted offline
   `git bundle`, and a second private remote. A bundle *is* the source code — encrypt it.
5. **Rotate the Firebase service-account key exposed in the local terminal transcript.** It is not
   in the repository, but it is a live production credential.
6. **Treat the source as disclosed.** Never put a credential, private key or customer datum in the
   tree; public history is permanent.

**Before the first external collaborator**

7. Put the access terms in writing (NDA + IP assignment), grant the minimum role with an end date,
   and rotate everything that person could see when the engagement ends.
8. Move the work into a GitHub Organization: org-owned private repos can disable forking, teams give
   least privilege, and the audit log records access changes.

**As it scales**

9. Keep the valuable logic server-side and the client a thin shell.
10. Trademark the name; keep dated authorship evidence.
11. Review access quarterly — `node scripts/audit-access.mjs`, plus the two things it cannot read
    (GitHub Apps, account tokens and SSH keys) and the Dependabot queue.
12. Assume compromise and design for recovery: scheduled rotation, monitored audit trail, and the
    ability to rebuild without the original account.

---

## 6. Related

- [`SECURITY.md`](../SECURITY.md) — reporting a vulnerability and what is in scope.
- [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) §8 — protected
  working-tree entries and the project's git change-safety rules.
- [`LICENSE`](../LICENSE) — the proprietary terms.
