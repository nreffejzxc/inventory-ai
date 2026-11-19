# Security, reliability and documentation improvements beyond NY-07

**Status:** **BRAINSTORMING, EVALUATION AND RECOMMENDATIONS ONLY.** Nothing here authorizes code,
configuration, a notification, a drill, a database operation, a deployment or a paid service.

**Reviewed:** 2026-11-17
**Basis:** the full project conversation; IA-01–IA-45; TS-01–TS-06; SEC-01–SEC-12; RD-01–RD-06;
NX-01–NX-07; NY-01–NY-07; the current GitHub Actions, dependency-review, CodeQL, Android AAB and
Firebase state (reviewed 2026-11-17); and the current production state at `e218bb0`.
**Related:** [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md)
— the NY tranche this document follows; it is not repeated here.

## 1. Scope

This is the tranche **after NY-07**. It looks for controls that survive every earlier review: code-level
static analysis, dependency changes before merge, application rollback evidence, workflow logic,
Android manifest privacy, public-policy drift and app/device attestation.

The following adjacent items are excluded because an earlier record already owns them:

| Existing item | Why it is not proposed again |
| --- | --- |
| NY-01 | AI provider data-handling attestation. |
| NY-02 | Release-artifact secret and PII scan. |
| NY-03 | Operational runbook ownership and freshness. |
| NY-04 | Retention/TTL effectiveness. |
| NY-05 | Platform audit tamper-evidence. |
| NY-06 | External reference and provider-link freshness. |
| NY-07 | GitHub Actions dependency integrity and workflow lockfile. This document adds **workflow logic review**, not another pinning mechanism. |
| NX-01–NX-07 | Sensitive-data canary, remaining-write idempotency, cross-tenant route matrix, emergency switches, incident tabletop, dependency rollback and security-header drift. |
| IA-27 | SBOM and dependency provenance. NZ-02 reviews dependency **changes at pull-request time**; NZ-01 analyses **application code**, not the package graph. |
| IA-22 | AI conversation retention. NZ-06 checks **public-policy drift**, not the internal retention rule. |
| TS-03 | Tenant-isolation AI canary. NZ-07 is **app/device attestation**, not tenant isolation. |
| RD-01 / NX-06 | Dependency outage and dependency rollback. NZ-03 is **application-deploy rollback**. |
| SEC-05 / CI-06 | Audit retention, export and least privilege. NZ-06 is public-policy accuracy, not audit storage. |
| Existing `PRIVACY-page.test.mjs` / `TERMS-page.test.mjs` | They assert rendering, CSP, links and authentication. NZ-06 asserts the factual claims still match configuration. |
| Existing `check-aab.mjs` | It checks packaging, permissions and bundle strings. NZ-05 adds Android manifest privacy semantics. |

`SOURCE_PROTECTION.md` and `scripts/audit-access.mjs` **measure** the action-pinning state; NY-07 is
the enforcement item. NZ-04 reviews workflow **logic and token use**, which pinning does not answer.

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

Ties are broken by impact, then likelihood, then free feasibility. The order is a recommendation, not
an authorization. Every item is designed to cost **$0**; the paid alternatives in §5 are optional and
never a prerequisite.

## 3. Ranked recommendations

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **NZ-01** | CodeQL code scanning | 5 | 4 | 4 | 5 | 3 | 4 | **25** |
| 2 | **NZ-02** | Dependency-review pull-request gate | 4 | 3 | 3 | 5 | 3 | 5 | **23** |
| 3 | **NZ-03** | Production deploy rollback drill | 4 | 3 | 4 | 5 | 3 | 3 | **22** |
| 4 | **NZ-04** | GitHub Actions workflow security audit | 4 | 2 | 4 | 5 | 2 | 5 | **22** |
| 5 | **NZ-05** | Android manifest privacy guard | 3 | 3 | 3 | 5 | 3 | 4 | **21** |
| 6 | **NZ-06** | Privacy-policy drift guard | 3 | 2 | 2 | 5 | 3 | 4 | **19** |
| 7 | **NZ-07** | Firebase App Check | 3 | 3 | 3 | 4 | 2 | 3 | **18** |

The first four are the recommended order: code analysis, dependency prevention, rollback evidence and
workflow logic. NZ-05 is the release gate; NZ-06 is the public-claim guard; NZ-07 is conditional on
public release or observed abuse.

---

### Rank 1 — NZ-01 CodeQL code scanning

**What.** Enable GitHub's CodeQL **default setup** for the JavaScript/TypeScript code, starting with
the server package:

- scan on pull requests and pushes to the default branch, plus the weekly schedule;
- start with the default query suite, then evaluate `security-extended` after the initial noise is
  triaged;
- require the CodeQL check on `main`;
- triage every baseline alert: fix, dismiss with a reason, or record an accepted risk;
- prove the gate with one seeded finding or a deliberately vulnerable test branch, not merely a green
  run.

**Why it matters.** The server has authentication, tenant scoping, uploads, AI routes and database
access. Secret scanning, the docs guards and dependency review do not find tainted data flow or an
authorization mistake in application code. CodeQL's interfile taint tracking is the missing code-level
control.

**Benefit.** Earlier detection of injection, path, deserialization and authorization patterns; a
reviewable baseline; and a check that keeps new code from adding the same class of defect. **Risk:**
false positives and slow initial triage; scope the first run to the server, and keep tests/generated
files out of the first gate if they dominate the findings.

**Free approach.** The repository is public, and CodeQL is free for public repositories. Default setup
requires no build for JavaScript/TypeScript. GitHub Actions runs the scan; no paid plan is needed.

**Optional paid.** Only if the repository becomes private: **GitHub Code Security at $30 per active
committer/month** at current list pricing. A commercial SAST product is not needed for this control.

**Acceptance.**
- [ ] Default setup is enabled and scans the intended server paths.
- [ ] The CodeQL check is required on `main`.
- [ ] A seeded finding is caught; the negative control is recorded.
- [ ] Every baseline high/critical alert has an owner and a disposition.
- [ ] A pull request that introduces a known pattern is annotated or blocked.
- [ ] No application code or workflow secret is added by enabling the scan.

**Exclusions.** IA-27 (SBOM/provenance), dependency review (NZ-02), secret scanning, NX-01
(log/data handling) and any paid SAST subscription.

---

### Rank 2 — NZ-02 Dependency-review pull-request gate

**Implemented 2026-11-19 — §27JN.** The workflow uses `fail-on-severity: high` across the runtime,
development and unknown scopes and pins the action to the full `v5.0.1` SHA. It passed a clean run,
failed a scratch `lodash@4.17.20` pull request, and was then made a required `main` check. The
licence policy and the workflow lockfile remain open acceptance items.

**What.** Add a `pull_request` workflow using `actions/dependency-review-action` to compare manifest and
lockfile changes against the dependency graph and fail when a new vulnerable version is introduced:

- start with `fail-on-severity: high`;
- pin the action to a full commit SHA and add it to the NY-07 lockfile when that exists;
- require the check on `main`;
- add a license policy only after the noise level is measured;
- prove it with a scratch PR that bumps a package to a known-vulnerable version, then close the PR
  without merging.

**Why it matters.** Dependabot alerts are post-merge. They tell the owner that a vulnerable package is
already in the repository; they do not stop a pull request from adding one. Dependency review is the
pre-merge enforcement gate and also reports which dependencies changed, their age and their
dependents.

**Benefit.** Prevents the most common supply-chain regression before it reaches `main`, with a
reviewable diff on the PR. **Risk:** false positives or a noisy license policy; start with high
severity and runtime scope, then widen deliberately.

**Free approach.** The dependency-review action is available for all public repositories. It uses the
existing dependency graph and lockfiles; no paid service or scanner is needed.

**Optional paid.** A private repository needs GitHub Code Security or GitHub Advanced Security; the
same **$30 per active committer/month** licence. Commercial SCA is not required.

**Acceptance.**
- [ ] The workflow runs on pull requests and uses minimal permissions.
- [ ] The action is pinned to a full SHA and covered by the workflow lockfile.
- [ ] A known-vulnerable dependency PR fails; a clean dependency PR passes.
- [ ] The check is required on `main`.
- [ ] The failure message names the package, version and advisory.
- [ ] No automatic merge or dependency update is enabled by this control.

**Exclusions.** Dependabot alerts (post-merge), NX-06 (dependency rollback), IA-27 (SBOM) and any
automatic `npm audit fix`.

---

### Rank 3 — NZ-03 Production deploy rollback drill

**What.** Rehearse and measure an application rollback without touching production:

- use a disposable Render service or a local replica;
- deploy the current `main` and the previous known-good commit;
- verify `GET /api/health`, an authenticated read-only dashboard/API path and database connectivity;
- trigger Render rollback, confirm the previous commit is serving, record the recovery time and check
  schema compatibility;
- update `MONITORING.md` with the exact dashboard path, the Free-plan **two-most-recent-deploys**
  limit and the rule that a rollback is **not** a database rollback.

**Why it matters.** `MONITORING.md` already says “roll back or fix forward,” but there is no recorded
rehearsal. A bad deploy is a production incident, and the current Free plan can roll back only to the
two most recent deploys. Render's rollback restores the application artifact; it does not revert
database migrations, external writes or disk data.

**Benefit.** A measured recovery time, a tested runbook and an explicit boundary for what rollback
cannot fix. **Risk:** rehearsing on production would itself be a production change; use a disposable
service or local replica, and do not run destructive migrations.

**Free approach.** Render Free supports rollback to the two most recent previous deploys. A local
replica or disposable service exercises the same decision path. No paid plan is required.

**Optional paid.** A paid Render instance is roughly **$7–$25/month** for a small service and offers
longer artifact retention and zero-downtime behavior. It is not required for the drill.

**Acceptance.**
- [ ] The drill runs outside production.
- [ ] The previous commit is served after rollback.
- [ ] Health, DB connectivity and a read-only authenticated path pass.
- [ ] No write, migration or destructive operation is performed.
- [ ] Recovery time and the two-deploy retention limit are recorded.
- [ ] The runbook states that application rollback does not revert database state.

**Exclusions.** NX-06 (dependency rollback), RD-01 (dependency outage) and NX-05 (incident tabletop).
This is application-deploy rollback evidence.

---

### Rank 4 — NZ-04 GitHub Actions workflow security audit

**What.** Add a free static-analysis gate over `.github/workflows`:

- run **`zizmor`** (MIT) and **`actionlint`** in CI;
- start in report-only mode, fix or explicitly accept every finding, then make the job required;
- keep the job at `permissions: contents: read`; add only `security-events: write` if uploading SARIF;
- pin any SARIF upload action to a full SHA and add it to the workflow lockfile;
- add a deliberately bad fixture workflow to prove the check can fail.

**Why it matters.** NY-07 answers “which code ran?” by pinning the action graph. It does not answer
“what can that code do with the token, event and inputs?” `zizmor` finds template injection, credential
persistence, excessive permission scopes, impostor commits and unsafe trigger patterns. The repository
has only a few workflows, so a baseline is cheap now and prevents unsafe patterns later.

**Benefit.** Reviews workflow logic before it receives a token, and turns a manual security rule into a
repeatable check. **Risk:** static analysis can flag accepted patterns; record each acceptance with a
reason and review it when the workflow changes.

**Free approach.** Both tools are free/open source (`zizmor` is MIT). Run them locally and in an
existing CI job; no paid scanner is required.

**Optional paid.** Commercial CI/CD security platforms are quote-based; a small team should budget
roughly **$10–$30 per developer/month** only if runtime egress monitoring or managed remediation is
wanted. The free static checks cover the core control.

**Acceptance.**
- [ ] `zizmor` and `actionlint` run on every workflow change.
- [ ] The current workflows have a clean or explicitly accepted baseline.
- [ ] A bad fixture workflow fails the check.
- [ ] The job has read-only permissions unless SARIF upload is enabled.
- [ ] Any SARIF action is SHA-pinned and lockfile-covered.
- [ ] No workflow secret is added or printed.

**Exclusions.** NY-07 (pinning/lockfile), IA-27 (package SBOM) and any paid CI security subscription.

---

### Rank 5 — NZ-05 Android manifest privacy guard

**What.** Extend `mobile/scripts/check-aab.mjs` to assert Android manifest privacy properties in the
release AAB:

- `android:allowBackup` is `false`, **or** it is `true` with both `android:fullBackupContent` and
  `android:dataExtractionRules` present and their contents excluding SecureStore/auth material;
- `android:usesCleartextTraffic` is false or absent in release;
- `android:debuggable` is false;
- exported components are only those explicitly required, with reviewed intent filters;
- the check uses a synthetic bad-manifest fixture to prove it can fail.

**Current observation (2026-11-17).** `check-aab.mjs` checks package identity, SDK levels, signature,
channel, permissions and bundle strings, but not these manifest privacy properties. The inspected AAB
evidence shows `android:allowBackup="true"` with
`android:fullBackupContent="@xml/secure_store_backup_rules"` and
`android:dataExtractionRules="@xml/secure_store_data_extraction_rules"`. That may be correct, but the
current gate does not verify the rule contents or prevent a future config/plugin change from altering
them.

**Benefit.** A release gate for the manifest properties a store reviewer or attacker notices, without
forcing `allowBackup=false` when the SecureStore exclusion rules are correct. **Risk:** the AAB
manifest is binary/protobuf; use `bundletool dump manifest` or the existing parser, and keep the
fixture synthetic.

**Free approach.** Reuse the existing AAB checker and Android SDK/`bundletool`; no new service.

**Optional paid.** A commercial mobile scanner would overlap NY-02's artifact scanner; do not buy it
twice. The free guard is the missing control.

**Acceptance.**
- [ ] The current AAB passes with its SecureStore rules verified.
- [ ] A mutated manifest with backup enabled and no rules fails.
- [ ] Cleartext, debuggable and unexpected exported components fail.
- [ ] The check runs on every release AAB, not debug builds.
- [ ] No APK/AAB is uploaded or published by the check.

**Exclusions.** NY-02 (artifact secret/PII scan), existing permission checks and any commercial mobile
scanner.

---

### Rank 6 — NZ-06 Privacy-policy drift guard

**What.** Make the public privacy and terms pages prove that their factual claims still match the
system:

- keep subprocessors, retention periods and deletion behavior in one shared constant used by the page
  renderer and the tests;
- assert that every configured provider appears in the policy and every declared retention/deletion
  claim is present;
- fail the docs/test suite when a provider is added without a policy update;
- keep the existing `PRIVACY-page.test.mjs` and `TERMS-page.test.mjs` rendering, CSP, link and
  authentication checks.

**Why it matters.** The existing tests prove the pages render and link. They do not prove the policy's
subprocessor, retention and deletion statements still match the actual configuration. A provider
change, a retention change or a new AI route could leave a publicly served policy inaccurate.

**Benefit.** A public claim that cannot silently drift, plus a clear review trigger when a provider is
added. **Risk:** automation is not legal review; a human still approves the wording. Keep the shared
constant narrow and versioned.

**Free approach.** Existing page modules, tests and docs guards; no paid privacy platform.

**Optional paid.** A privacy-compliance platform is optional and typically several hundred dollars per
month; it is not required for this drift check.

**Acceptance.**
- [ ] The page and tests use one shared source for provider/retention facts.
- [ ] Adding a provider without updating the policy fails a test.
- [ ] The existing privacy/terms suites still pass.
- [ ] The policy contains no secret, token, private contact detail or tenant data.
- [ ] A human review date is recorded; the test does not claim legal sufficiency.

**Exclusions.** IA-22 (internal AI retention), NX-01 (log redaction), the existing page-rendering
tests and any paid GRC/privacy service.

---

### Rank 7 — NZ-07 Firebase App Check

**What.** Add app/device attestation and enforce it gradually:

- Android: **Play Integrity** provider;
- Apple, if iOS is added: **DeviceCheck** or **App Attest**;
- web/fallback: **reCAPTCHA Enterprise**;
- add the debug provider for local/CI builds;
- start in monitor mode, measure the rejection rate, then enforce on selected auth/registration/custom
  backend endpoints.

**Why it matters.** Firebase Authentication proves which user is calling. It does not prove the request
came from the real, untampered Inventory AI app. App Check reduces abuse of auth, registration and
custom backend endpoints by rejecting clients without a valid attestation.

**Benefit.** A stronger abuse boundary around the public auth surface. **Risk:** enforcement can break
debug builds, CI and old app versions; deploy the debug provider first, monitor before enforcing, and
treat Firebase Auth's App Check support as **Preview**.

**Free approach.** Play Integrity has **10,000 calls/day** on its standard tier; App Check itself is
no-cost within the provider quotas; reCAPTCHA Enterprise includes **10,000 assessments/month**.
DeviceCheck/App Attest are subject to Apple quotas.

**Optional paid.** reCAPTCHA Enterprise costs **$8 flat** for 10,001–100,000 assessments/month and
**$1 per 1,000** above 100,000. Play Integrity has its own paid usage tier above the daily quota. At
current low volume, the expected cost is **$0–$8/month**.

**Acceptance.**
- [ ] The debug provider works in local and CI builds.
- [ ] Monitor mode records a baseline without blocking users.
- [ ] Enforcement rejects an unauthorized client and accepts the real app.
- [ ] Old app versions and the Firebase Auth preview caveat are documented.
- [ ] No provider secret or attestation token is logged.

**Exclusions.** TS-03 (tenant/AI canary), AUTH-01–AUTH-06 (user identity/session) and any paid
attestation service beyond the provider quotas.

## 4. Recommended order

1. **NZ-01** — add code-level analysis before adding more security-sensitive routes.
2. **NZ-02** — stop vulnerable dependencies at the pull request.
3. **NZ-03** — measure application rollback before the next bad deploy.
4. **NZ-04** — review the logic of the workflows that run the first three.
5. **NZ-05** — guard the release AAB's manifest privacy.
6. **NZ-06** — keep the public policy aligned with the data flow.
7. **NZ-07** — add attestation only after public release or observed abuse.

The two-contact notification evidence remains **NOT RUN / PENDING** and is not replaced by any item
here. Security alerts remain inactive until that test is complete.

## 5. Paid-upgrade cost table (optional; no purchase authorized)

**No paid service is required for any recommendation.** The free-first control is the requirement;
the paid alternative is optional. Costs are indicative planning ranges, not vendor quotes; confirm
current pricing before any purchase.

| ID | Free-first control | Optional paid alternative | Indicative monthly cost | Additional benefit if paid |
| --- | --- | --- | --- | --- |
| **NZ-01** | CodeQL default setup on a public repository | GitHub Code Security if the repository becomes private, or commercial SAST | **$0**; **$30/active committer** for GitHub Code Security | Private-repo coverage, managed policy and autofix |
| **NZ-02** | `actions/dependency-review-action` on public pull requests | GitHub Code Security / commercial SCA | **$0**; **$30/active committer** for GitHub Code Security | Private-repo enforcement, broader SCA and licence policy |
| **NZ-03** | Render Free rollback and a disposable/local rehearsal | Paid Render instance for longer artifact retention and zero-downtime | **$0**; **~$7–$25** for a small paid instance | More retained deploys, faster cutover, more resources |
| **NZ-04** | `zizmor` + `actionlint` | Commercial CI/CD security platform | **$0**; **~$10–$30/developer** or quote | Runtime egress monitoring, managed remediation |
| **NZ-05** | Extend the existing AAB checker | Commercial mobile scanner (already considered in NY-02) | **$0**; **$100–$1,000+** if bought separately | Binary analysis and store-compliance reporting; do not double-buy |
| **NZ-06** | Shared policy facts plus tests | Privacy-compliance platform | **$0**; typically several hundred dollars | Policy templates, approvals, evidence portal |
| **NZ-07** | Play Integrity / DeviceCheck / App Attest / reCAPTCHA free quotas | reCAPTCHA Enterprise above 10,000 assessments; Play Integrity paid tier | **$0–$8** at low volume; **$1 per 1,000** above 100,000 reCAPTCHA assessments | Higher volume, advanced risk scoring |

**Mandatory versus optional.** The free-first control is the security requirement. The paid
alternative is never a substitute and is not approved by this document. No purchase, subscription,
trial, plan upgrade or paid API is authorized.

## 6. What is deliberately not proposed

- No implementation of NZ-01–NZ-07 in this document.
- No CodeQL workflow, dependency-review workflow, `zizmor` job, manifest check, policy-test change or
  App Check integration.
- No production deploy, rollback, database operation, OTA, Play upload, DNS/domain change or alert
  activation.
- No paid Code Security licence, Render upgrade, SAST/SCA subscription, mobile scanner, privacy
  platform or attestation overage.
- No repeat of IA-01–IA-45, TS-01–TS-06, SEC-01–SEC-12, RD-01–RD-06, NX-01–NX-07 or NY-01–NY-07;
  the exclusion table above is the duplicate check.
- No claim that a control is complete while its evidence is pending. **NOT RUN** and **UNVERIFIED**
  remain valid outcomes.

## 7. Related records

- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md) — the
  NY-01–NY-07 tranche this document follows.
- [`PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md`](PLATFORM_SENSITIVE_DATA_PROTECTION_DESIGN.md) —
  NX-01 sensitive-data design and canary.
- [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) — RD-01 dependency
  outage matrix and fact-check.
- [`PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md`](PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md) — RD-01–RD-06.
- [`MONITORING.md`](MONITORING.md) — health endpoints, incident procedure and the rollback sentence.
- [`SECURITY.md`](../SECURITY.md) — how to report a vulnerability.
