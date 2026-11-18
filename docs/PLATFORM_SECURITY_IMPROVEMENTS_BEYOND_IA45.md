# Platform security - future improvements beyond IA-45

**Status:** **BRAINSTORMING, EVALUATION AND RECOMMENDATIONS ONLY.** Nothing here authorizes an
implementation, a production change, a deployment, a notification or a new paid service.

**Reviewed:** 2026-11-17
**Basis:** the complete project conversation and roadmap, the current production state at `e218bb0`,
`INVENTORY_AI_MULTI_CRITERIA_RANKING.md` through IA-45, `PLATFORM_SECURITY_RECOMMENDATIONS.md`
(SEC-01-SEC-12), the auth security checklist, the monitoring/alert decision records, and the
platform production-readiness gates.

## 1. What this review adds

The existing security work is strong on the **platform plane**: platform administrator recovery,
MFA, lifecycle, audit, support grants, access-layer options, alert ownership and platform access
review. The remaining customer-facing gaps are different:

- A tenant member can have a credential or session compromised without the business owner receiving
  a security notification.
- Tenant roles and invitations drift after onboarding, but there is no periodic recertification.
- The assistant's tenant isolation is tested, but there is no standing adversarial canary through the
  real tool layer.
- Security controls age, yet there is no single free posture view for the owner.
- Tenant accounts have no MFA policy, and Firebase MFA has a cost/architecture gate that must be
  proven before it is proposed as a $0 build.
- The mail domain has no stated anti-spoofing posture; this is conditional on owning and controlling
  the sending domain.

This page adds **TS-01-TS-06** and ranks them. It does not replace or re-open the IA or SEC records.

## 2. Exclusions - already covered

| Existing item | Why it is not repeated here |
| --- | --- |
| IA-01 | Identity-aware platform access/origin enforcement |
| IA-02 | Platform security-event monitoring and alert delivery |
| IA-03 | Audit retention, export and database least privilege |
| IA-06 / SEC-08 | Platform-admin step-up and dual control |
| IA-07 / SEC-06 | Time-bound, reason-bound support grants and tenant-detail gating |
| IA-15 | AI quality evaluation and prompt-injection review |
| IA-35 / SEC-12 | Recovery/rotation freshness and **platform** access review |
| IA-42 | Customer business ownership transfer, including re-authentication |
| IA-43 | Tenant large-adjustment approval |
| IA-44 | Owner-facing tenant activity log (passive history) |
| SEC-09 | Platform security alerting and owned recipients |
| SEC-10 / SEC-11 | Platform admin management UI and CI/browser proof |

## 3. Method

Each idea is scored **1-5** on six equally weighted criteria, maximum **30**:

1. **Impact** - how much a successful attack or failure is reduced.
2. **Likelihood** - how plausible the failure is now, not in a hypothetical future.
3. **Blast radius** - how much tenant, business or platform data is exposed.
4. **Free feasibility** - 5 means existing resources, a free tier and modest owner effort; 2 means a
   cost or architecture gate must be resolved first.
5. **Business value** - trust, contract readiness, retention or customer confidence.
6. **Time to value** - 5 means a useful result in days, 2 means a multi-phase build.

Ties are broken by **impact**, then **likelihood**, then **free feasibility**. A high score is not an
authorization; it is the recommended review order.

## 4. Ranked recommendations

| Rank | ID | Recommendation | Impact | Likelihood | Blast | Free | Business | Speed | Total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **TS-01** | Tenant security notifications | 5 | 4 | 4 | 5 | 4 | 5 | **27** |
| 2 | **TS-02** | Tenant access recertification | 4 | 3 | 4 | 5 | 4 | 5 | **25** |
| 3 | **TS-03** | AI tenant-isolation canary | 5 | 2 | 5 | 4 | 3 | 4 | **23** |
| 4 | **TS-04** | Owner security posture scorecard | 4 | 3 | 3 | 5 | 4 | 4 | **23** |
| 5 | **TS-05** | Tenant MFA / step-up for OWNER and ADMIN | 5 | 4 | 5 | 2 | 4 | 2 | **22** |
| 6 | **TS-06** | Mail-domain anti-spoofing posture | 4 | 3 | 3 | 3 | 3 | 3 | **19** |

### Rank 1 - TS-01 Tenant security notifications

**Opportunity.** Send a short email or in-app notice to the affected member and the business OWNER
when a new device/session signs in, a password or email changes, a role or invitation changes, a
recovery code is used, or an export is requested. Keep the message free of tokens, addresses and tenant
data; link to the authenticated session/activity view. Deduplicate bursts and let the owner choose the
non-critical categories.

**Why it matters.** The platform has audit events and an Active Sessions screen, but a tenant
security event is silent unless someone opens the app. The auth security checklist explicitly lists
security notifications as deferred. A stolen password or session can therefore persist until the
owner notices a change manually. This is the highest-value customer-facing security control because it
turns a passive audit record into timely detection.

**Benefit.** Faster containment, earlier password/role-change confirmation and a visible security
commitment for future business customers. **Risk:** alert fatigue and deliverability; make security
alerts transactional, rate-limited and separate from marketing, and reuse IA-21's bounce watch.

**Acceptance.** A seeded new-device event produces one notice to the affected member and the OWNER;
a role change and password change do the same; a second tenant's event never appears; no token,
address, phone number or product data is in the message; disabling a non-critical category does not
disable password/role alerts.

**Implementation plan:** [`PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md`](PLATFORM_TENANT_SECURITY_NOTIFICATIONS_PLAN.md)
- planning only, including event triggers, recipient rules, privacy, rate limits and acceptance checks.

**Free/existing resources.** Existing Brevo mail, audit/session records and tenant membership data.
No new vendor.

### Rank 2 - TS-02 Tenant access recertification

**Opportunity.** A quarterly owner-run review of the tenant's OWNER/ADMIN/STAFF members, pending
invitations, inactive accounts, the last OWNER and open sessions. Produce a compact report, require
the owner to confirm or remove each role, and audit the result. Use the existing member/session APIs
and a repository checklist; no new identity product.

**Why it matters.** Invitations and role changes are easy to add and easy to forget. A departed STAFF
member or an extra ADMIN is a standing access grant. SEC-12 covers **platform administrators**, not
customer tenant roles; IA-44 shows activity but does not force a periodic decision. Recertification
turns least privilege into an owned routine.

**Benefit.** Smaller stale-access surface, evidence for customer security reviews and a clear
offboarding habit. **Risk:** manual burden and false confidence; make it short, dated and exception-
based, and require a second look at the last OWNER.

**Acceptance.** The report lists every member, role, pending invite and last activity; an owner signs
a dated attestation; a deliberately stale account is removed or explicitly retained with a reason;
the decision is audited; no password, token or private contact detail is included.

**Free/existing resources.** Existing member/session records, GitHub issue/calendar reminder and the
owner's time. No paid governance product.

### Rank 3 - TS-03 AI tenant-isolation canary

**Opportunity.** Maintain two synthetic canary tenants with unmistakable markers in products,
locations and stock records, and run a fixed set of assistant tool calls against them in CI and before
a release. Assert that every result contains only the authenticated tenant's marker. Include a
negative control where a crafted cross-tenant id or prompt is supplied and must be refused.

**Why it matters.** The assistant is read-only and tenant-scoped, and the server tests cover isolation.
A future tool, cache or query change could still leak another tenant's data; a fixed unit test can
miss the actual tool path. IA-15 evaluates answer quality and prompt injection, not a standing
cross-tenant data-canary. This is the highest-blast-radius failure in the product, even if its current
likelihood is low.

**Benefit.** A continuous, cheap guard against the worst customer-trust failure and reusable evidence
for a security review. **Risk:** a canary that only tests one tool creates false confidence; cover
every tool and both directions, and never put real tenant data in the fixture.

**Acceptance.** The canary fails when a tool is deliberately made to ignore tenant scope; it passes
when scoping is correct; a crafted id/prompt cannot retrieve the other canary; the run uses synthetic
data only and makes no paid AI call when testing the tool layer directly.

**Free/existing resources.** Existing local MongoDB fixtures, tool tests and CI. No paid synthetic
monitoring or model calls required for the tool-layer canary.

### Rank 4 - TS-04 Owner security posture scorecard

**Opportunity.** A monthly, free report for the owner showing a small set of actionable facts: tenant
OWNER/ADMIN count, pending invitations, inactive members, last access recertification, last
notification-path test, last successful restore/Firebase drill, platform MFA/recovery readiness,
open dependency advisories and any stale credential/rotation age. Link each red item to its record;
do not invent a composite "security score" that hides the underlying fact.

**Why it matters.** The platform console reports operations, not whether security controls are
current. Recovery codes, contacts, keys and admin counts decay silently. IA-35 checks one path; SEC-12
reviews platform admins; no single view tells the owner what needs attention this month.

**Benefit.** A repeatable management review, faster identification of stale controls and a ready
answer for customer due-diligence questions. **Risk:** vanity metrics and alert fatigue; show only
facts with an owner/action/date, and suppress an item when its underlying record is current.

**Acceptance.** The report is generated from existing records; each red item names the source record
and next action; a deliberately stale contact/recovery item appears; no tenant data, secret or private
contact detail is included; the owner can mark a review date.

**Free/existing resources.** Existing platform console/audit data, repository records, GitHub
Dependabot and a local report. No paid GRC or dashboard service.

### Rank 5 - TS-05 Tenant MFA / step-up for OWNER and ADMIN

**Opportunity.** Add a second factor or fresh re-authentication for tenant OWNER/ADMIN sign-in and
sensitive actions (role changes, exports, ownership transfer). Prefer a phishing-resistant factor; keep
recovery codes/backup enrollment. This is deliberately ranked below the free items because the current
Firebase MFA path may require Identity Platform/billing and a mobile enrollment flow; **do not build it
until a no-cost path is confirmed**.

**Why it matters.** Platform administrators have mandatory TOTP enrollment and optional WebAuthn; tenant OWNER/ADMIN accounts
do not. Those accounts can change roles, export data and approve large adjustments. A stolen password
or Google session is therefore a direct business-data risk. The auth checklist marks MFA as future
scope.

**Benefit.** Materially reduces account-takeover impact and supports future customer security
requirements. **Risk:** lockout, support burden and cost; require a tested recovery path, a staged
opt-in, and an explicit $0 decision before implementation.

**Acceptance.** A test tenant can enroll and use the factor; a lost factor follows a documented
recovery path; a sensitive action requires the fresh factor; an account without enrollment follows the
approved policy; no paid plan is assumed. **Cost gate:** if the only supported path requires a paid
identity tier, the item remains deferred.

**Free/existing resources.** Firebase identity and the existing platform MFA design are the starting
point, but the tenant path is not assumed free. No purchase is authorized by this review.

### Rank 6 - TS-06 Mail-domain anti-spoofing posture

**Opportunity.** Publish and monitor SPF, DKIM and DMARC for the domain used by Brevo and the product,
starting at `p=none` for visibility, then move to quarantine/reject only after reports are understood.
Keep the records and the owner in the repository; do not include DNS credentials. This is conditional:
the project has no purchased domain today, so it becomes actionable only when an owner-controlled
domain exists.

**Why it matters.** Verification, reset and invitation mail is a phishing target. Without an
anti-spoofing posture, an attacker can trade on the product's name and customers cannot distinguish a
real message. IA-21 watches delivery/bounces, not domain authentication. The migration note records
that no DKIM/SPF record was generated or rotated.

**Benefit.** Better deliverability, lower phishing risk and a concrete trust signal for business
customers. **Risk:** a misconfigured DMARC policy can block legitimate mail; start in monitor mode,
verify Brevo's DKIM/SPF alignment and keep a rollback note.

**Acceptance.** SPF and DKIM align with the sending provider; DMARC exists in monitor mode with a
reported aggregate path; a test message passes authentication; no DNS credential or private key is
committed; the owner records the review date. **Gate:** no domain purchase and no paid DNS service.

**Free/existing resources.** Existing DNS control (when a domain exists), Brevo's domain settings and
free DMARC aggregate reporting. No paid deliverability vendor.

## 5. Recommended order

The two-contact notification test remains the prerequisite for any security-alert activation; this
list does not change that gate. After the checklist is completed and the contact path is proven:

1. **TS-01** - make security events visible to the tenant.
2. **TS-02** - review who still has access.
3. **TS-03** - prove the highest-blast-radius AI isolation on every change.
4. **TS-04** - make the remaining controls reviewable each month.
5. **TS-05** - only after a verified no-cost tenant MFA path exists.
6. **TS-06** - only when an owner-controlled domain and DNS path exist.

TS-01 and TS-02 are the best first customer-facing security investments because they use existing
resources and produce visible value quickly. TS-03 and TS-04 are engineering/operations controls that
prevent silent decay. TS-05 and TS-06 are important but have explicit cost/domain gates.

## 6. What remains out of scope

No implementation, code change, notification, alert activation, Firebase project, domain purchase,
DNS change, database operation, deployment or paid service is authorized. No tenant or contact data
is included. The existing IA and SEC items remain the authority for their subjects.

## 7. Related records

- [`INVENTORY_AI_MULTI_CRITERIA_RANKING.md`](INVENTORY_AI_MULTI_CRITERIA_RANKING.md) - IA-01-IA-45.
- [07 — Security recommendations](./platform-console/07-security-recommendations.md) - SEC-01-SEC-12.
- [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) - deferred MFA/notifications.
- [`PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md`](PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md) - the
  prerequisite two-contact test.
- [06 — Security monitoring](./platform-console/06-security-monitoring.md) - platform alerts.
- [`MONITORING.md`](MONITORING.md) - current health watch and incident procedure.
- [`PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md`](PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md) - the next
  ranked security/reliability/documentation tranche beyond TS-06.
