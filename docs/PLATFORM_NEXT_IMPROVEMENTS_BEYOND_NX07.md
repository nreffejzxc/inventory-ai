# Security, reliability and documentation improvements beyond NX-07

**Status:** **BRAINSTORMING, EVALUATION AND RECOMMENDATIONS ONLY.** Nothing here authorizes code,
configuration, a notification, a drill, a database operation, a deployment or a paid service.

**Reviewed:** 2026-11-17
**Basis:** the full project conversation; IA-01–IA-45; TS-01–TS-06; SEC-01–SEC-12; RD-01–RD-06;
NX-01–NX-07; the monitoring, restore, Firebase-recovery, notification and platform-readiness
records; the current GitHub Actions workflow and action-pinning state (reviewed 2026-11-17); and the
current production state at `e218bb0`.
**Related:** [`PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md`](PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md)
— the NX-01 design, including the cache-policy finding that is deliberately **not** repeated here.

## 1. Scope

This is the tranche **after NX-07**. It looks for gaps that survive every earlier review: how the
workflow's action graph is locked and verified, what the AI provider does with tenant data after it
receives it, what actually ships inside a mobile or console artifact, whether an operational runbook
is still owned and current, whether retention indexes are really deleting rows, whether the audit
trail can prove it was not rewritten, and whether the external references a runbook depends on still
resolve.

It is deliberately not a second version of NX-01. The following adjacent items are excluded because
an earlier record already owns them:

| Existing item | Why it is not proposed again |
| --- | --- |
| NX-01 | Sensitive-data map, log/error redaction, audit metadata, Firebase uid logging and the authenticated-response cache policy are in the NX-01 design. |
| NX-02 | Remaining-write idempotency. |
| NX-03 | Cross-tenant authorization matrix. |
| NX-04 | Feature-flag and emergency-switch registry. |
| NX-05 | Incident tabletop and postmortem template. |
| NX-06 | Dependency rollback rehearsal. |
| NX-07 | Security-header and cookie drift probe. |
| IA-01–IA-03 | Access layer, platform alerting, audit export/retention/least privilege. |
| IA-04 / IA-19 / IA-35 | Restore/index drill, backup fidelity, recovery freshness. |
| IA-08 / IA-31 / IA-37 | SLOs, performance budgets, query-plan watch. |
| IA-15 / TS-03 | AI evaluation and the tenant-isolation canary. |
| IA-16 | Multi-instance shared rate-limit/lockout store. |
| IA-22 | AI conversation retention/redaction (this tranche adds the **provider-side** question, not the internal retention rule). |
| IA-27 | SBOM and dependency provenance (this tranche scans the **artifact content**, not the dependency graph). |
| IA-34 / IA-38 | API contract drift and minimum client version. |
| IA-39 / IA-41 / IA-44 | Tenant export, support bundle, owner activity log. |
| IA-40 | Provider readiness probe. |
| SEC-05 / CI-06 | Audit retention, export, least privilege and an external immutable sink (this tranche adds **tamper evidence inside the trail**). |
| SEC-12 | Periodic access review, offboarding and rotation drills. |
| TS-01–TS-06 | Tenant security notifications, recertification, AI canary, posture scorecard, tenant MFA, mail anti-spoofing. |
| RD-01–RD-06 | Dependency outage matrix/drill, notification outbox, route/tool review gate, tenant fairness budgets, configuration drift, command index/verification. |

`SOURCE_PROTECTION.md` records the current action-pinning state and `scripts/audit-access.mjs`
reports the repository policy. That is the **measurement**; NY-07 is the **enforcement** item, not a
duplicate of the audit or of IA-27's package SBOM.

## 2. Method

Each item is scored **1–5** on six equally weighted criteria, maximum **30**:

1. **Impact** — how much a real exposure, failure or repeated operational error is reduced.
2. **Likelihood** — how likely the problem is with the current system.
3. **Blast radius** — how many tenants, users, records or decisions are affected.
4. **Free feasibility** — existing resources, local tools and documentation score 5; a new paid
   dependency scores 1.
5. **Business value** — customer trust, support quality, contractual readiness or operational
   confidence.
6. **Time to value** — 5 means usable in days, 3 means weeks, 1 means a project.

Ties are broken by impact, then likelihood, then free feasibility. The order is a recommendation,
not an authorization. Every item below is designed to cost **$0** and to reuse an existing resource.
The free-first control is the actual requirement; the paid alternatives in §5 are optional and never
a prerequisite. Each item is labelled **Required** or **Recommended** so a commercial upgrade cannot
be mistaken for a mandatory control.

## 3. Ranked recommendations

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **NY-01** | AI provider data-handling attestation | 4 | 3 | 5 | 5 | 5 | 4 | **26** |
| 2 | **NY-07** | GitHub Actions dependency integrity and workflow lockfile | 5 | 3 | 5 | 5 | 4 | 3 | **25** |
| 3 | **NY-02** | Release-artifact secret and PII scan | 5 | 3 | 4 | 4 | 4 | 4 | **24** |
| 4 | **NY-03** | Operational runbook ownership and freshness register | 4 | 3 | 4 | 5 | 3 | 5 | **24** |
| 5 | **NY-04** | Retention/TTL effectiveness monitor | 3 | 3 | 3 | 5 | 3 | 5 | **22** |
| 6 | **NY-05** | Platform audit tamper-evidence chain | 4 | 2 | 4 | 3 | 4 | 3 | **20** |
| 7 | **NY-06** | External reference and provider-link freshness check | 2 | 4 | 2 | 5 | 2 | 3 | **18** |

The first three are the recommended order: provider privacy, workflow supply-chain integrity and
release-artifact scanning. NY-03 and NY-04 make operational ownership and retention measurable;
NY-05 and NY-06 add audit and reference guards. NY-07 is ranked second because one workflow still
uses a mutable action tag and the repository's SHA-pinning policy is not enforced.

---

### Rank 1 — NY-01 AI provider data-handling attestation

**What.** Maintain one dated record of what happens to tenant data **after** it leaves the server for
the AI provider:

- which data categories are sent: the member's prompt, the selected tool results, product names,
  quantities, prices, supplier names, feedback text and any conversation context;
- the OpenRouter account's data-retention/privacy setting, as actually displayed, not as remembered;
- the upstream model providers reachable through the configured model ids, their training/retention
  policies and subprocessors;
- the region or routing constraint, if any, and whether it is enforceable on the current plan;
- deletion/expiry behaviour, incident-notice path and the owner's review date;
- what is deliberately **not** sent: email, Firebase uid, user id, session token, API key or an
  unrelated tenant record.

Record the evidence with links and a date, not a screenshot containing a personal account address.
If a setting cannot be verified, write **UNVERIFIED** and name the consequence; do not infer it from
marketing copy.

**Why it matters.** IA-22 decides how long Inventory AI keeps an AI conversation. NX-01 decides what
must not enter a log or an error. Neither answers the vendor-side question a customer or a reviewer
will eventually ask: *what does the model provider retain, train on or share?* The project sends real
inventory and pricing content to a free gateway; that is a legitimate design choice, but it should be
a recorded one with a current setting and a named owner.

**Benefit.** A defensible privacy answer, a faster security questionnaire and a concrete input to the
Play/data-safety and customer conversations. **Risk:** a policy page changes without notice; record
the review date and re-check on the existing 90-day cadence, or sooner if the provider changes terms.

**Free approach.** OpenRouter's account/privacy pages, the upstream providers' public policies, the
existing AI configuration and the documentation guards. No paid DPA, privacy tool or data-discovery
service.

**Acceptance.**
- [ ] The data-flow table names every category sent and every category deliberately withheld.
- [ ] The account setting is recorded with the date and the plan it applies to.
- [ ] Each upstream provider in the active model list has a policy link and a retention/training
      statement, or an explicit **UNVERIFIED** note.
- [ ] The record contains no API key, account password, private contact detail or tenant data.
- [ ] An owner and a next-review date are named.
- [ ] If the provider offers a no-training/zero-retention setting on the current plan, it is either
      enabled with evidence or the residual risk is accepted in writing.

**Exclusions.** IA-22 (internal retention), NX-01 (log redaction), IA-40 (readiness probe), TS-06
(mail anti-spoofing) and any paid privacy/GRC service.

---

### Rank 2 — NY-07 GitHub Actions dependency integrity and workflow lockfile

**Control class:** **Required** free control. The paid option in §5 is optional and is not a
prerequisite.

**What.** Make the workflow action graph reproducible and enforced:

- generate `.github/workflows/actions.lock` with `gh actions-lock` for every workflow, including the
  manual production health watch;
- run `gh actions-lock --verify` as a required pull-request check, so a stale lockfile fails before
  merge;
- after a pilot, enable the repository-level **Require lockfile** policy;
- keep **Require actions to be pinned to a full-length commit SHA** as defence-in-depth for reusable
  workflows, container images and any workflow not yet onboarded;
- reference reusable workflows (`jobs.<job_id>.uses`) by full commit SHA, because lockfiles do not
  cover them; use `@sha256:` digests for container images;
- add `.github/workflows/actions.lock` to `CODEOWNERS` and require review of changes to `commit`,
  `owner_id` and `repo_id`;
- keep Dependabot managing GitHub Actions so an action bump and its lockfile entry move together.

**Current observation (2026-11-17).** `ci.yml` and `typescript-7-watch.yml` pin `actions/checkout`
and `actions/setup-node` to full commit SHAs, but the manual-dispatch
`production-health-watch-v2.yml` still uses `actions/checkout@v4`, a mutable tag. That workflow sets
`persist-credentials: false` and has only `contents: read` and `issues: write`, so its current blast
radius is limited; the tag is still not reproducible. `SOURCE_PROTECTION.md` records that SHA
pinning is not enforced, and `scripts/audit-access.mjs` can report the policy; neither closes the
gap. No workflow lockfile exists yet.

**Why it matters.** A moved tag or compromised action runs with the workflow's token and whatever
secrets that workflow receives. This health watcher is limited to `contents: read` and
`issues: write` and uses no secrets, but the same pattern in a release or deploy workflow would
carry more. Pinning one direct action fixes one line. A lockfile pins every direct and transitive
action, records the source repository's numeric identity, and rejects a commit that is not
reachable from the recorded ref.
GitHub's secure-use guidance calls the lockfile the strongest available control and says it
supersedes SHA pinning for repositories that adopt it. The lockfile is available on the Free plan;
it is not a paid feature.

**Benefit.** Reproducible CI, reviewable action updates, an auditable action inventory, and
protection against tag repointing and transitive action changes. **Risk:** a stale lockfile or an
un-onboarded workflow can block CI; the verify check and gradual onboarding manage that. A lockfile
freezes reviewed code; it does not prove the action is safe, so the lockfile diff still needs review.

**Free approach.** Install the MIT-licensed `gh actions-lock` extension, run it at the repository
root, review the rewritten `uses:` references, and commit `.github/workflows/actions.lock`. Add a
`verify-lockfile.yml`-style required check that runs `gh actions-lock --verify` on pull requests that
touch workflows. Enable Dependabot for GitHub Actions. Add the lockfile to `CODEOWNERS`. Enable the
repository-level **Require lockfile** policy after the pilot; keep SHA pinning for reusable
workflows, container images and non-onboarded workflows. Pin the remaining `actions/checkout@v4`
reference to a full SHA (or let the lockfile rewrite it) before enforcement. No paid plan is needed.

**Acceptance.**
- [ ] `.github/workflows/actions.lock` exists and covers every workflow, including the manual health
      watch.
- [ ] `gh actions-lock --verify` passes locally and as a required pull-request check.
- [ ] A deliberately stale lockfile fails the verifier.
- [ ] Every reusable workflow is referenced by full commit SHA; every container image uses a digest.
- [ ] The **Require lockfile** policy is active, or the reason it is not active is recorded with a
      date.
- [ ] **Require actions to be pinned to a full-length commit SHA** is active as defence-in-depth, or
      the lockfile's coverage is documented and accepted.
- [ ] Dependabot updates an action and its lockfile entry in one pull request.
- [ ] No workflow uses a mutable tag outside the lockfile; no secret or token is added by this
      control.
- [ ] No paid plan, subscription or service is purchased.

**Exclusions.** IA-27 (package SBOM and provenance), NX-06 (dependency rollback), the existing secret
guard, and `SOURCE_PROTECTION.md`/`audit-access.mjs` (measurement, not enforcement). It does not
re-propose a general CI hardening programme; least-privilege token permissions and untrusted-input
review remain existing repository rules.

**Sources (reviewed 2026-11-17).** [Workflow dependency lockfiles](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles),
[locking action dependencies](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies),
[enforcing lockfiles](https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles)
and the [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).

---

### Rank 3 — NY-02 Release-artifact secret and PII scan

**What.** Before an OTA publication or a Play upload, scan the **artifact that will actually ship**,
not just the repository:

- the exported JavaScript bundle and any source map;
- the Android APK/AAB contents (unzip the archive and inspect the JS/assets);
- the Platform Operations console's static assets;
- the public HTML pages if they gain a build step.

Look for secret-shaped strings (`sk-`, `sk-or-v1-`, `AIza`, `ghp_`, PEM private-key headers,
`mongodb+srv://`), real email addresses, fixture tenant names, internal hostnames, absolute build
paths and source-map references. Keep a synthetic allowlist for test fixtures and prove the scanner
finds a planted canary.

**Why it matters.** Repository secret scanning and IA-27's SBOM prove what is in the source and the
dependency graph. They do not prove what the bundler inlined, what an EAS build copied into
`assets/`, or whether a source map shipped beside the bundle. The next release should be scanned
before it is uploaded, not after a store reviewer or a customer finds the string.

**Benefit.** A release gate that catches the most damaging class of mobile mistake before it leaves
the machine. **Risk:** a scanner that reports every fixture email is noisy; keep the allowlist
narrow, versioned and reviewed, and treat a high-confidence secret as a stop.

**Free approach.** The existing export/build commands, `unzip`, Node or `grep`, and the repository's
test fixtures. No paid scanner, no upload and no external service.

**Acceptance.**
- [ ] The scan runs against a locally built artifact, not the source tree alone.
- [ ] A planted canary token/email in a test artifact is detected; the negative control fails when
      the scanner is disabled.
- [ ] The current release artifact has zero unallowlisted high-confidence secrets and no source map.
- [ ] The allowlist names each fixture and why it is safe; it contains no real credential.
- [ ] The exact command, artifact hash and result are recorded with the release evidence.
- [ ] The scan does not upload, install or publish the artifact.

**Exclusions.** IA-27 (SBOM/provenance), NX-06 (dependency rollback), the repository's existing
secret-scanning rules, and a paid mobile-app-security or store scanner.

---

### Rank 4 — NY-03 Operational runbook ownership and freshness register

**What.** Give every operational runbook a small, machine-readable header or index row:

```text
owner | last verified | next review | dependencies | evidence status
```

Cover at least: `MONITORING.md`, `FIREBASE_CREDENTIAL_RUNBOOK.md`, the database restore drill, the
Firebase recovery drill, the notification evidence/checklist, the integrity audit, the platform
production-readiness checklist and the release/OTA guides. Add a free repository script that reports
a missing owner, a past review date, a runbook with no evidence date, or a dependency that no longer
exists. The two-contact notification evidence stays visibly **NOT RUN / PENDING** until it is run.

**Why it matters.** The docs guards already catch broken links, stale figures and some invariants.
RD-06 catches a renamed command or flag. Neither answers the question a responder asks at 2 a.m.:
*is this the runbook we last proved, who owns it, and what is still untested?* A dated procedure with
no owner is a document, not an operational control.

**Benefit.** Faster incident starts, fewer “which guide is current?” detours and a visible home for
pending evidence. **Risk:** the register becomes another table to update; keep it to one line per
runbook and make the check fail on a stale date rather than trusting a memory.

**Free approach.** Existing Markdown, `docs/README.md` cadence and a dependency-free Node check. No
wiki, no paid documentation platform and no new service.

**Acceptance.**
- [ ] Every listed operational runbook has an owner, last-verified date, next review and evidence
      status.
- [ ] The check fails on a missing owner, an overdue review or a runbook whose evidence is still
      marked pending.
- [ ] The notification evidence remains **NOT RUN / PENDING**; the register does not turn it into a
      pass.
- [ ] Dependencies resolve to an existing file, script, provider page or named owner.
- [ ] The register contains no private contact detail, token, key or tenant data.
- [ ] The check is local and read-only; it does not execute a destructive command or contact a
      provider.

**Exclusions.** RD-06 (command index/verification), the existing docs-link and cadence guards, and
any paid runbook/GRC/workflow product.

---

### Rank 5 — NY-04 Retention/TTL effectiveness monitor

**What.** Prove that the retention rules already declared are actually enforced by MongoDB:

- list the TTL indexes on sessions, verification/reset challenges, invitations, idempotency
  records, operations error/feature rows, platform sessions/deployments and any AI record that IA-22
  later gives a TTL, with their `expireAfterSeconds`;
- report documents whose expiry is materially in the past, grouped by collection (counts only, no
  content);
- distinguish “TTL monitor has not run yet” from “the index is missing or wrong”;
- run the proof against a disposable local database with a short TTL first, then optionally a
  read-only aggregate check in production.

AI conversations currently have **no TTL**. The monitor must report that as a declared-retention
question owned by IA-22, not as a broken index. Do not delete rows, change an index or shorten a
declared retention period from this monitor.

**Why it matters.** IA-03/IA-18/SEC-05 decide how long data should live. The TTL index is the
mechanism, but a missing or misdeclared index leaves expired personal data in place indefinitely
while the documentation says it is gone. A count-only monitor turns the promise into a measurement
and gives the operator a safe signal.

**Benefit.** An enforceable privacy claim, earlier detection of a retention regression and a
smaller data-at-rest footprint. **Risk:** MongoDB's TTL monitor is approximate (roughly a minute,
and slower under load); use a material tolerance and never report a race as a breach.

**Free approach.** Existing Mongoose models, `getIndexes()`, a disposable local MongoDB and a
read-only count. No paid data-governance tool and no production write.

**Acceptance.**
- [ ] Every collection with a declared retention period has a TTL index in the report.
- [ ] A deliberately removed or misdeclared TTL index is detected in the local test.
- [ ] A short-TTL disposable database actually expires a test row, proving the monitor runs.
- [ ] The report contains counts and collection names only; no document content, email, token or
      tenant identifier.
- [ ] A stale-row result is classified as “monitor not run yet” or “index problem”, not guessed.
- [ ] The monitor never deletes, updates or re-indexes data.

**Exclusions.** IA-03/IA-18/SEC-05 (retention policy/export), IA-04/IA-19/IA-35 (restore/index
drill), and any paid database-observability service.

---

### Rank 6 — NY-05 Platform audit tamper-evidence chain

**What.** Make the append-only audit trail **detectably** append-only:

- add a per-event `prevHash` and `eventHash` (HMAC with a dedicated server-side key held outside the
  database), covering the action, outcome, actor, route, request id, IP/user-agent, metadata and
  timestamp;
- verify the chain on read or in a read-only job; report the first break, not every later row;
- keep a key-id/rotation boundary so an old segment remains verifiable after a key change;
- define the backfill boundary for existing rows; do not rewrite history to make the chain pass.

The model's update/delete hooks and the export/least-privilege controls remain; this is a
cryptographic **detector**, not a replacement for database permissions.

**Why it matters.** SEC-05/CI-06 can export the trail and constrain the database role, but a raw
database operator can still edit or delete a row and leave a plausible-looking trail. A hash chain
with a key outside the database makes that tampering evident and gives an investigation a concrete
answer. It is especially relevant to break-glass, recovery-code and MFA events.

**Benefit.** Tamper evidence for the highest-value platform decisions and a stronger audit answer
for a future customer or reviewer. **Risk:** key management and backfill complexity; a lost key must
fail closed and be documented, and a chain that cannot be verified must not be reported as valid.

**Free approach.** Node `crypto`, the existing append-only model and the existing audit read path.
No paid KMS, blockchain, immutable-log or SIEM service.

**Acceptance.**
- [ ] A normal append verifies; a modified row, a deleted row and a reordered pair are each detected
      at the first break.
- [ ] The key is read from an environment secret, never stored in the database or returned by an API.
- [ ] A key rotation boundary is recorded; an old segment verifies with its old key id.
- [ ] Existing rows are handled by an explicit boundary, not silently rewritten.
- [ ] The verifier is read-only and does not expose event contents in its failure detail.
- [ ] SEC-05/CI-06 controls remain in place; the chain is not presented as a substitute.

**Exclusions.** SEC-05/CI-06 (retention, export, least privilege, external sink), IA-03 (audit
export), NX-05 (tabletop/postmortem) and any paid audit-ledger/SIEM service.

---

### Rank 7 — NY-06 External reference and provider-link freshness check

**What.** Keep a small canonical list of external references the runbooks depend on — Firebase
Admin/Auth, OpenRouter model/status pages, Brevo, Render, MongoDB Atlas, Google Play, Expo/EAS,
GitHub Actions — and check that each URL still resolves and still points at the expected topic.
Report redirects, 404s and pages whose title no longer matches. Treat a network failure as
**inconclusive**, not as a pass.

Do not authenticate, scrape tenant data, follow an untrusted redirect chain indefinitely or store a
provider response body.

**Why it matters.** RD-06 checks the repository's own commands. A runbook's external link can rot
silently, and a responder follows it at the worst possible time. This is low-cost maintenance that
keeps the dependency-outage and recovery procedures connected to the current provider docs.

**Benefit.** Fewer dead ends during an incident and an earlier warning when a provider reorganises
its documentation. **Risk:** provider sites are dynamic and may block automated requests; pin the
canonical URLs, cap redirects and report a block as inconclusive rather than a failure of the
runbook.

**Free approach.** `fetch`/`curl`, the existing documentation cadence and a local report. No paid
link-monitoring service, crawler or browser fleet.

**Acceptance.**
- [ ] The list names the provider, the canonical URL and the runbook that uses it.
- [ ] A deliberately broken test URL is reported; a simulated network failure is **inconclusive**.
- [ ] Redirects are bounded and the final host is recorded.
- [ ] No credential, token, tenant data or private contact detail is sent or printed.
- [ ] The check is read-only and its report has a review date.

**Exclusions.** RD-06 (internal commands), the docs-link checker, NX-07 (deployed headers), and any
paid uptime/link-monitoring service.

## 4. Recommended order

1. **NY-01** — settle the provider-side privacy answer before adding more AI data.
2. **NY-07** — lock the workflow action graph and pin the last mutable reference; it is a prerequisite
   for trusting any CI evidence.
3. **NY-02** — scan the next artifact before it is uploaded; this is the cheapest release gate.
4. **NY-03** — make the operational runbooks owned and visibly current.
5. **NY-04** — prove the retention promises the product already makes.
6. **NY-05** — add tamper evidence to the platform trail before a real investigation needs it.
7. **NY-06** — keep the external references alive; it is maintenance, not a blocker.

The two-contact notification test remains the prerequisite for security-alert activation and is not
replaced by any item here.

## 5. Paid-upgrade cost table (optional; no purchase authorized)

**No paid service is required for any recommendation.** The free-first control is the requirement;
the paid alternative is an optional operational convenience. Costs are indicative planning ranges,
not vendor quotes; confirm current pricing before any purchase.

| ID | Control class | Free-first control | Optional paid alternative | Indicative monthly cost | Additional benefit if paid |
| --- | --- | --- | --- | --- | --- |
| **NY-01** | Required before a paying customer | Dated provider data-handling attestation | Privacy/GRC platform or DPA workflow | **$0–$1,000+**; a DPA is often included at no fee | Policy templates, vendor-risk workflow, evidence portal |
| **NY-07** | Required | Workflow lockfile, verify check, SHA policy and Dependabot | GitHub Enterprise Cloud for Evaluate-mode policy insights, or a commercial CI supply-chain monitor | **$0–$50 per user** or quote; lockfiles work on the Free plan | Central policy insights, managed remediation, runtime egress monitoring |
| **NY-02** | Required before each store upload | Local artifact unpack and secret/PII scan | Commercial mobile artifact scanner | **$100–$1,000+** | Managed rules, binary analysis, store-compliance reports |
| **NY-03** | Required | Runbook register plus a local freshness check | Wiki/GRC platform | **$0–$500** | Ownership reminders, approvals, audit trail |
| **NY-04** | Required before a retention claim | TTL-index and count-only effectiveness monitor | Managed database observability or a dedicated backup tier | **$0–$100+**; dedicated Atlas tiers are usage-priced | Historical metrics, alerting, longer retention |
| **NY-05** | Required before high-value audit reliance | HMAC hash chain over the existing audit model | KMS plus SIEM or immutable-log service | **$1–$5 per key plus request charges; SIEM $200–$1,000+** | Managed key rotation, retention, correlation |
| **NY-06** | Recommended | Local external-link check with inconclusive network handling | Commercial link monitor | **$0–$20** | Multi-region checks, alerting, history |

**Mandatory versus optional.** The **Free-first control** column is the security requirement. The
**Optional paid alternative** column is never a substitute and is not approved by this document. No
purchase, subscription, trial, plan upgrade or paid API is authorized.

## 6. What is deliberately not proposed

- No paid privacy/GRC, DLP, artifact scanner, immutable-log, SIEM, link-monitoring or database
  observability service.
- No GitHub Enterprise upgrade, commercial CI supply-chain subscription or paid lockfile service;
  workflow lockfiles are available on the Free plan.
- No implementation of NY-07 in this document: the current `actions/checkout@v4` reference is
  recorded, not changed.
- No notification, alert activation, production fault injection, database write, deployment, OTA,
  Play upload, domain or DNS change.
- No repeat of NX-01–NX-07, IA-01–IA-45, TS-01–TS-06, SEC-01–SEC-12 or RD-01–RD-06; the exclusion
  table above is the duplicate check.
- No promise that a plan is complete when its evidence is still pending; **NOT RUN** and
  **UNVERIFIED** are valid outcomes and must be recorded as such.

## 7. Related records

- [`PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md`](PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md) —
  NX-01, including the sensitive-data map and canary.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md) — the
  NX-01–NX-07 tranche.
- [`PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md`](PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md) — RD-01–RD-06.
- [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) — the RD-01 matrix and
  its code fact-check.
- [`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md) — SEC-05/PR-09 audit
  retention and database least privilege.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NY07.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NY07.md) — the
  follow-on NZ-01–NZ-07 tranche.
- [`MONITORING.md`](MONITORING.md) — the durable stores and their retention.
- [`SECURITY.md`](../SECURITY.md) — how to report a vulnerability.
