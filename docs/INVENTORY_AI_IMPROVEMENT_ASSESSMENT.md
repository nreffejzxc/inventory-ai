# Inventory AI — whole-product improvement assessment

**Status:** **ASSESSMENT AND RECOMMENDATIONS ONLY.** Nothing in this document authorizes
implementation, a production change, a deployment or a new paid service. It ranks the next work; it
does not start it.

**Free-first constraint (2026-11-17):** Inventory AI has no paying users and no budget for new
recurring services. Free/existing tiers are the default; any paid item is deferred until revenue or a
contractual requirement. See
[`INVENTORY_AI_FOLLOWUP_ASSESSMENT.md`](INVENTORY_AI_FOLLOWUP_ASSESSMENT.md) for the additive,
free-first shortlist.

**Reviewed:** 2026-11-17
**Basis:** the complete project conversation and decision history, the live Platform Operations
console at `e218bb0`, the current security/monitoring/release records, the AI assistant roadmap, and
the public product state. The detailed evidence remains in the linked records; this page is the
whole-product view.

## 1. Executive judgment

Inventory AI is **not short of features**. It is short of the operational controls that make the
existing features safe to run for real customers:

1. **The public console still has a shared outer gate, not an identity-aware edge.** Cloudflare Access
   is the strongest low-cost candidate, but it is not sufficient without origin-token validation
   because the Render `onrender.com` URL remains reachable.
2. **Security events are recorded but not delivered.** The platform audit trail is pull-only; the
   outer gate and audit-writer failures are not alertable today. A record nobody reads is not
   detection.
3. **The audit trail is append-only at the model layer, not durable against raw database access.**
   Retention, export and least-privilege database permissions are still open.
4. **Disaster recovery is documented more than demonstrated.** A backup/restore helper exists, but a
   full restore on the real tier has never been observed, and platform signing/MFA/access secrets
   have no escrow procedure.
5. **AI cost and model health are visible only after a human opens the report.** The simple route has
   a small process-local paid budget; there is no global daily/monthly budget, spend alert or
   paid-fallback kill switch.
6. **Support and release operations are intentionally incomplete.** The ticket store has no SLA or
   ownership model, tenant detail is correctly blocked behind a support grant, mobile crash/install
   telemetry is unavailable, and the Play release has not been made.

The right next move is not another assistant feature. It is to close the access, detection, evidence
and recovery gaps before widening the operator group or onboarding real customers.

## 2. Current state

### 2.1 Product and business

- V1 is complete and in production testing. Mobile `1.0.2` is deployed; the last production binary is
  `1.0.2`. There are **no real customers** yet.
- The **Play release has not been made**; Play App Signing and a store-installed build are unproven.
- **iOS remains externally blocked** — there is no macOS host.
- Legacy admin-created password accounts still need migration before legacy login can be retired.
- The assistant is read-only and has a permanent eight-item improvement roadmap, with most of the
  highest-value interaction work already implemented and production-verified.

### 2.2 Platform Operations

- The internal console is live at `/platform` on `e218bb0`: forced recovery-code ceremony, guarded
  break-glass, application-level Basic/key gate, mandatory TOTP enrollment and optional WebAuthn, HttpOnly session, CSRF,
  strict CSP, append-only audit model, support tickets, deployment history and aggregate operational
  views.
- `main` requires `secret-guard`, `attribution-guard`, `server`, `mobile` and `webauthn-e2e`, with
  strict and enforce-admins.
- The console is **aggregate-only**. Tenant-detail reads and support grants remain blocked by design.
- The audit trail has action/outcome/actor/capability/reason/route/request id/IP/user agent/metadata,
  but no alert delivery, no external immutable sink and no database-role least-privilege proof.
- The outer access gate is a shared secret; the public Render URL remains reachable.

### 2.3 Monitoring and reliability

- UptimeRobot watches readiness and the database posture every five minutes and can email the owner;
  alert delivery was tested.
- The GitHub health workflow is a manual/fallback path because scheduled runs have not fired.
- The console shows durable 5xx events and an audit view. It is an investigation surface, not a pager.
- There is no host CPU/memory, Atlas cluster, backup-status, mobile crash/install or background-job
  telemetry in the service.
- The API runs on a single free 512 MB Render instance; the process-local limiter is sufficient only
  while there is one process.

### 2.4 AI

- OpenRouter is the only shipped provider; credentials remain server-side; free/paid reasoning and web
  tools are separately controlled.
- Turn records include model, outcome, tokens, latency, cost, fallback and quota facts. The console
  reports them.
- The simple route has a per-UTC-day paid budget and per-turn reserve; it is **process-local**. Other
  paid paths, global spend, model health alerts and a kill switch are not implemented.
- The AI is read-only; there is no write tool. Quality is still shape-by-shape: some answers are
  deterministically finalised, others are model-composed and rely on tests/guardrails.

## 3. Assessment method

Recommendations were ranked with five questions:

1. **Does it prevent an irreversible outcome?** Permanent lockout, credential compromise, audit loss,
   data loss or uncontrolled spend outrank convenience.
2. **Does it improve detection or recovery?** A control that fails silently is not a control.
3. **Is it a prerequisite for real customers or a wider operator group?** Support detail, SLAs and
   release readiness matter when those groups exist.
4. **What is the effort and dependency?** A small change with a large architectural prerequisite is
   ranked below a smaller control that closes the same risk.
5. **Is the cost justified now?** Free/existing infrastructure first. Before revenue, paid Render
   Scale, a pager, a domain purchase or a dedicated identity provider are **deferred**, not assumed.

Labels: **Security impact** H/M/L; **Business value** H/M/L; **Effort** S/M/L; **Cost** $0 / low /
medium. The ranking is a recommendation order, not a commitment.

## 4. Ranked follow-up roadmap

| Rank | ID | Improvement | Area | Security | Business | Effort | Cost | Existing map | Why this rank |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **IA-01** | Identity-aware access layer with origin-token enforcement | Access / security | H | H | M | $0 only if a domain already exists; otherwise deferred | CI-07, PR-03 | The console is still public and the shared key is not per-person. Cloudflare Access is the best free-tier design, but it requires a controlled domain and origin validation; no domain is purchased under the current budget. |
| 2 | **IA-02** | Security alerting, ownership and delivery | Detection | H | H | M | $0 | SEC-09, CI-05 | Audit events exist but nobody is notified. Without this, an attack, recovery-code use or administrator change is invisible until someone opens the console. |
| 3 | **IA-03** | Audit retention, export and database least privilege | Evidence | H | M | M | Low/medium | SEC-05, CI-06, PR-09 | The model refuses mutations, but raw database access can rewrite or drop the trail. The recovery/break-glass events are exactly what an investigation needs. |
| 4 | **IA-04** | Restore drill, RPO/RTO and platform secret escrow | Continuity | H | H | M | Existing DB + storage decision | CI-15 | A backup that has not been restored is a hope. A full restore on the real tier has never been observed, and platform keys have no escrow path. |
| 5 | **IA-05** | AI budget, model-health alerts and paid-fallback kill switch | AI cost / availability | M/H | H | M | $0 | CI-11 | AI spend is provider-reported and paid fallback can run without a global cap. A model outage or runaway spend is currently found only by reading the report. |
| 6 | **IA-06** | Step-up authentication and dual control for destructive admin actions | Admin security | H | M | M | $0 | SEC-08, CI-02 | A stolen live session can disable/delete administrators or remove keys. A fresh factor and second approval make the highest-impact actions two-person. |
| 7 | **IA-07** | Time-bound support grants and the tenant-detail gate | Support boundary | H | H at support use | L | $0 | SEC-06, CI-04, PR-11 | Support cannot answer “what happened to this tenant?” without a reason-bound, expiring read. Never add a standing tenant selector first. |
| 8 | **IA-08** | API/console SLOs, saturation alerts and degraded-mode drill | Reliability | M | H | M | $0 | CI-12 | Health proves the process is alive, not that it can answer in time. The console shares the same small Render instance it monitors. |
| 9 | **IA-09** | Release readiness: Play Store, iOS and legacy-auth migration | Business / release | M | H | L | Existing | Release records, AUTH migration | No real customers can arrive without a store release and a supportable identity path. This is a business blocker, but it does not displace the P0 security work; it should run in parallel. |
| 10 | **IA-10** | Incident routing, on-call ownership, timeline and status communication | Incident operations | M | H | M | $0 initially | CI-14 | Detection without a recipient is still an outage. The existing health watch can open an issue, but there is no owned pager, incident object or customer status path. |
| 11 | **IA-11** | Mobile crash/install telemetry and support diagnostics | Mobile operations | L/M | H | M | Free tier possible | New; console says unavailable | The console cannot see mobile crashes or installs, so support is blind to the most common customer failure mode. |
| 12 | **IA-12** | Support ticket SLAs, queue ownership and escalation | Support operations | L | H when staffed | M | $0 | CI-13 | The ticket store is a notebook without ownership, response targets or escalation. Priority rises when support is staffed; it is not a first-customer gate while tickets are aggregate-only. |
| 13 | **IA-13** | Administrator provisioning, role change and offboarding UI | Admin scale | M | M | M | $0 | SEC-10, CI-08 | CLI-only administration is acceptable for one operator but becomes an audit/operational gap as the group grows. Lower now because the team is one person. |
| 14 | **IA-14** | Dedicated platform identity provider and passkey-first policy | Identity | M | M | L | Vendor decision | SEC-07, CI-03 | The local realm is isolated but temporary. Cloudflare Access may cover the outer identity layer first; this remains the long-term app-realm target, not an immediate build. |
| 15 | **IA-15** | AI quality evaluation, prompt-injection review and regression corpus | AI quality | M | H | M | $0 | AI roadmap / AI-60 | More answer shapes are model-composed. Web research adds untrusted content; read-only limits damage but not wrong recommendations. Evaluation must precede new answer features. |
| 16 | **IA-16** | Shared rate limiter and lockout state for multiple instances | Scale security | M | L now | M | Depends on store | CI-09 | Only matters when the API is horizontally scaled. The account MFA lock is already durable; the IP limiter is process-local. |
| 17 | **IA-17** | Expanded browser automation for recovery and lifecycle flows | Verification | L | M | S/M | $0 | CI-10 | The current E2E found a real race. Recovery/lifecycle clicks deserve the same executable proof, but they are regression protection, not a new control. |
| 18 | **IA-18** | Data retention/export and account-deletion verification | Data lifecycle | M | M | M | Existing storage | Account deletion / audit records | Deletion exists, but retention of audit/feedback/operations data and export expectations need a written owner decision and a verification pass. |

### 4.1 How to read the ranking

- **1–8 are the “safe to widen operations” set.** They close public access, detection, evidence,
  recovery, cost, administrative containment and support-boundary gaps. Several are already in the
  console/security roadmaps; this assessment orders them by irreversible-risk value.
- **9–12 are the “real customer operations” set.** They matter as soon as the business starts
  onboarding users and support staff. Release readiness and mobile diagnostics should run in parallel
  with the security work, not after it.
- **13–18 are “scale and optimization” items.** They are valuable, but building them before the team
  or customer base exists would spend effort on controls nobody uses yet.

## 5. What is strongest today

- Tenant isolation is server-derived and covered by behavioural tests; the mobile permission mirror is
  presentation only.
- Authentication is backend-authoritative, with Firebase identity exchange, JWT/session revocation,
  password recovery, invitation onboarding and no client-trusted business id.
- Inventory is ledger-based, archive-only for products, and refuses negative stock; the duplicate
  ledger audit exists.
- The AI is read-only, server-side, provider-abstracted and tool-scoped; prompt text cannot grant
  database access.
- The platform plane is separate from tenant identity, with its own sessions, capabilities, MFA,
  audit trail, recovery ceremony and required browser WebAuthn check.
- The test and documentation discipline is unusually strong for this stage: full server suite,
  browser E2E, docs guards, route inventory and a recorded residual-risk process.

These strengths are why the recommendation is to **harden and observe**, not to rebuild.

## 6. Risk register

| Risk | Current evidence | Why it matters | Primary response |
| --- | --- | --- | --- |
| Public console / shared outer key | Render free; Basic/key gate; `onrender.com` public | A leaked shared key plus a stolen platform credential is a path in; no per-person edge identity | IA-01 |
| Silent security events | Audit is pull-only; outer gate/CSRF gaps | An attack can complete before anyone looks | IA-02 |
| Audit can be rewritten by raw DB access | Model guard, no DB-role proof/export | Recovery and break-glass evidence can be lost | IA-03 |
| Restore unproven | Backup helper tested on scratch; full real-tier restore never observed | A database loss may exceed the recovery objective | IA-04 |
| AI spend/model outage | Provider-reported cost; process-local simple budget | Paid fallback or a model change can spend/break without a global stop | IA-05 |
| Stolen admin session | Capability checks, but no step-up/dual control | Delete/disable/key removal are irreversible | IA-06 |
| Support pressure vs privacy | Aggregate-only console; tenant detail blocked | Adding detail first would repeat the tenant-Operations mistake | IA-07 |
| Single free instance | 512 MB, process-local limiter, no host metrics | Slowdown becomes an outage, and the console monitors from the same process | IA-08 |
| Release/migration | Play not released, iOS blocked, legacy passwords | No real customer can complete the supported lifecycle | IA-09 |
| Mobile blind spot | No crash/install telemetry | Support cannot see the most common failure | IA-11 |
| Single owner/on-call | No backup reviewer or 24/7 rota | The owner is a single point of failure for every SEV-1 | IA-02/IA-10 |
| Residual advisories | `glob` medium; `deepmerge` low; not reachable from runtime | Low current risk, but not zero; forcing versions is not safe | Existing dependency decisions |

## 7. New improvements beyond the existing roadmaps

These are the gaps this assessment adds or sharpens; the existing CI/SEC/AI records remain the
authoritative item detail.

1. **Concrete Cloudflare Access decision and origin-token validation.** CI-07 says “deployment-boundary
   attestation”; this assessment names the candidate, its free-tier limit, the custom-domain
   prerequisite and the direct-origin bypass that makes app validation mandatory. See
   [05 — Access layer](./platform-console/05-access-layer.md).
2. **An owned alert catalogue and delivery model.** SEC-09/CI-05 name monitoring, but this assessment
   supplies alert thresholds, channels, role ownership, coverage gaps and acceptance criteria. See
   [06 — Security monitoring](./platform-console/06-security-monitoring.md).
3. **Mobile crash/install telemetry and support diagnostics.** The console explicitly says this source
   is unavailable. A free-tier crash/install integration and a support-safe diagnostic bundle are
   missing from the current roadmaps.
4. **Release readiness as a first-class track.** The Play release, iOS verification and legacy-auth
   migration are recorded as open items but not ranked against the console work. They are a business
   gate, not a console feature.
5. **AI prompt-injection and evaluation review.** Web research and model-composed answer shapes need a
   repeatable question corpus and an injection/quality review before new answer types ship.
6. **Platform secret escrow and restore ownership.** CI-15 mentions secrets; this assessment makes
   escrow and a tested restore an explicit continuity gate.
7. **Data retention/export and deletion verification.** Account deletion exists, but the owner still
   needs retention periods and export expectations for audit, feedback and operational rows.

## 8. Dependencies and decision gates

| Gate | Decision needed | Blocks |
| --- | --- | --- |
| G1 — access design | Cloudflare Access pilot vs private-service/Tailscale architecture vs no change | IA-01; Cloudflare requires a controlled domain, origin JWT code and WebAuthn/origin migration |
| G2 — alert ownership | Name a primary and backup; approve security mailbox/channel; accept best-effort hours or buy a pager | IA-02, IA-10 |
| G3 — retention/RPO | Choose audit retention, export destination and recovery objectives | IA-03, IA-04, IA-18 |
| G4 — AI budget | Set global daily/monthly limits and the paid-fallback policy | IA-05 |
| G5 — support model | Decide when support staff and tenant detail are needed; approve grant rules first | IA-07, IA-12 |
| G6 — release | Set the Play/iOS/legacy-auth order and the support owner | IA-09, IA-11 |
| G7 — scale | Decide whether the API will run more than one instance | IA-08, IA-16 |

No gate is approved by this document. The access and monitoring documents are decision briefs for
G1/G2; they do not implement them.

## 9. Recommended sequence

### First 30 days (planning and prerequisites only)

- Approve the access assessment and choose the Cloudflare pilot or reject it.
- Name the security backup, create the security mailbox and approve the alert destinations.
- Record audit retention/export and RPO/RTO decisions.
- Run a restore drill against a disposable database and record the observed result.
- Design the AI budget/kill-switch behavior; do not spend on new AI features until it exists.

### Days 31–60 (only after explicit implementation approval)

- Implement origin-token validation and the hostname/WebAuthn migration for the access pilot.
- Instrument outer-gate/CSRF/audit-write events and deliver the first alert set.
- Implement audit export/least privilege and the AI budget/model-health guard.
- Add step-up for destructive administrator actions.

### Days 61–90 (operations and customer readiness)

- Add support grants before any tenant-detail read.
- Add incident routing, SLOs and degraded-mode drills.
- Start mobile crash/install telemetry and the Play/iOS release track.
- Add ticket SLAs only when support is staffed; add admin UI only when the operator group grows.

## 10. What not to do now

- Do not add tenant-detail reads or a support selector before the grant gate exists.
- Do not implement Cloudflare Access or Tailscale as a DNS-only change; origin validation and a real
  test are required for either to be a boundary.
- Do not use Tailscale's free Personal plan for commercial administration.
- Do not upgrade Render to Scale only for inbound IP rules; the $499/month workspace fee needs a
  broader justification.
- Do not add a paid pager before there is a named on-call/backup and a customer need.
- Do not build an administrator-management UI for a single administrator before the lifecycle
  operations and recovery path are stable.
- Do not add more AI answer shapes before a cost guard, model-health alert and evaluation corpus.
- Do not treat the append-only Mongoose guard as storage immutability or a backup.

## 11. Source map

- Platform access: [05 — Access layer](./platform-console/05-access-layer.md).
- Monitoring and alert ownership: [06 — Security monitoring](./platform-console/06-security-monitoring.md).
- Console improvements: [03 — Console improvements](./platform-console/03-console-improvements.md).
- Platform security recommendations: [07 — Security recommendations](./platform-console/07-security-recommendations.md).
- Production readiness gates: [04 — Production readiness](./platform-console/04-production-readiness.md).
- Operator monitoring: [`MONITORING.md`](MONITORING.md).
- AI roadmap: [`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md).
- Auth/security invariants: [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md).
- Dependency decisions: [`SECURITY_DEPENDENCY_DECISIONS.md`](SECURITY_DEPENDENCY_DECISIONS.md).
- Inventory integrity: [`INVENTORY_INTEGRITY.md`](INVENTORY_INTEGRITY.md).
- Current state and evidence: [`DEVELOPMENT_LOG.md`](DEVELOPMENT_LOG.md) and
  [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) §27IQ–§27IR.

## 12. Approval state

- **Assessment complete.** The three requested areas are covered: access-layer options, security
  monitoring/alerting, and a whole-product ranked improvement plan.
- **No implementation approved by this document.** Every ranked item requires a separate owner
  decision and, for anything touching production, separate implementation verification.
- **Owner decision requested:** G1 (access design) and G2 (alert ownership/channel) are the two
  prerequisites that unlock the top of the ranking. The rest can remain planned until those decisions
  are recorded.
