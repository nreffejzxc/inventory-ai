# Platform security monitoring and alerting plan

**Status:** **PLANNING ONLY.** This is the proposed alert catalogue, detection design, ownership model
and response procedure for the Platform Operations console. It does not add an alert, change a
production setting or implement a notification channel.

**Free-first constraint (2026-11-17):** use the existing UptimeRobot email, owner-controlled email
and GitHub issues. Do **not** start a paid pager, paid chat plan or paid log-retention tier while
Inventory AI has no paying users. The named-owner decisions and free activation gates are in
[`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).

**Reviewed:** 2026-11-17
**Scope:** `/platform`, `/api/platform`, the platform audit trail, the API health/error signals and the
AI operational signals that affect the console. Tenant application monitoring remains in
[`MONITORING.md`](MONITORING.md).

## 1. What exists today

| Signal | Where it lives | What it can answer | What it cannot do today |
| --- | --- | --- | --- |
| Platform audit events | `platform_audit_events`, append-only at the model layer | Who signed in, MFA/WebAuthn result, recovery use, capability denial, administrator changes, audit/support reads, route/IP/request id | It is a pull-only trail; nobody is notified. Outer-gate 401s are not audited; CSRF refusals are already audited as `platform.access.denied` with a bounded reason. |
| API health | `/api/health`, `/api/health/ready`, `/api/health/integrity` | Process, database, production posture, commit, integrity heartbeat | The health probe is liveness/readiness, not security detection. |
| UptimeRobot | Two five-minute monitors plus the integrity monitor | Readiness and database-posture alert to the owner's email; test delivery was verified | It does not read platform security events or AI spend. |
| Durable 5xx events | `ops_error_events` | Counts, status, bounded route and recent error events | No alert rule or owned recipient is attached to the collection. |
| Process counters | `/api/platform/operations` and health | 5xx counts and process observations | Reset on restart; host CPU/memory and Atlas metrics are unavailable. |
| AI turn records | `ai_turn_metrics` and aggregate report | Model, outcome, tokens, cost, latency, fallback and quota facts | No budget alert or human-owned delivery path; unknown cost stays unknown. |
| Platform console | Security & audit, Errors & incidents views | Manual investigation | The console is not a pager and shares the same database/service as the thing it observes. |

**Current gap in one sentence:** the platform can record a security event, but it cannot reliably wake
the right person, deduplicate the signal or prove that someone responded.

## 2. Operating model

### 2.1 Severity

| Severity | Meaning | Target acknowledgement | Notification |
| --- | --- | --- | --- |
| **SEV-1** | Active compromise, confirmed destructive administrator action, total console unavailability or audit-integrity failure | 15 minutes during the owner's operating hours; immediate best effort otherwise | UptimeRobot email/mobile push if configured, owner security mailbox, GitHub issue |
| **SEV-2** | Likely attack, repeated authentication failure, suspicious recovery/WebAuthn activity, server degradation or a failed control | 1 hour during operating hours; next morning otherwise | Owner security mailbox and GitHub issue |
| **SEV-3** | Anomaly worth reviewing, no immediate evidence of compromise | Next business day | Daily/weekly digest and GitHub issue |

The project is currently a single-owner operation. These targets are **best-effort operating hours**,
not a claim of 24/7 coverage. Before a wider operator group or customer support use, the owner must
name a primary and backup. A paid pager is **deferred** until there is revenue; free channels are the
current boundary.

### 2.2 Roles and ownership

| Role | Responsibility | Current assignment |
| --- | --- | --- |
| **Platform Owner** | Primary owner of platform authentication, recovery, administrator changes and audit alerts; approves containment | The account owner |
| **Security Reviewer** | Backup reviewer for SEV-1 administrator/audit events and second approver for destructive changes | **To be named before wider access** |
| **Service Owner / Developer** | API health, deployment, 5xx, performance and rollback | The account owner/developer |
| **Support Lead** | Ticket SLA and escalation signals | **To be named when support is staffed** |
| **Edge/DNS owner** | Cloudflare/Access policy, DNS and service-token rotation if the access-layer pilot proceeds | The account owner initially |

Every alert row below names one accountable role. If one person holds several roles today, that is an
accepted interim risk and must be stated in the runbook; it is not evidence that four people are on
call.

### 2.3 Channels

| Channel | Use | Status |
| --- | --- | --- |
| UptimeRobot email | Existing health/readiness alerts; test delivery was observed | **Live** for health only |
| UptimeRobot mobile push | Optional faster SEV-1 delivery if enabled on the owner's device | To be confirmed |
| Owner security mailbox | Security event delivery and durable human inbox; an existing owner email/alias is sufficient | **To be created/recorded**; no address is invented here and no paid mailbox is required |
| GitHub issue | Durable, linkable incident record and fallback when email is missed | Existing pattern for health; extend to security; free |
| Free chat channel (Slack/Telegram) | Optional team visibility if a free workspace already exists | Not required; do not buy a plan |
| Paid pager (PagerDuty/Opsgenie) | True 24/7 escalation | **Deferred** until revenue and a named rota exist; not approved |

No alert body may contain a password, token, TOTP code, recovery code, WebAuthn response, Mongo URI,
full request body or tenant data. IP addresses and user-agent are security evidence but are personal
data: restrict access and retention.

## 3. Alert catalogue

These are **starting thresholds**, not proof that the current audit data can emit every count today.
The "Source/gap" column says what must exist before activation. Counts are per rolling window and
deduplicated by the stated key.

### 3.1 Authentication and recovery

| ID | Alert | Starting threshold | Source / gap | Severity | First response owner |
| --- | --- | --- | --- | --- | --- |
| AUTH-01 | Repeated password failures for a known administrator | 5 failures for one account in 15 min, or 10 from one IP in 15 min | `platform.login.failed`; current audit has actor/email/IP | SEV-2 | Platform Owner |
| AUTH-02 | MFA failure burst or account lockout | 5 TOTP/WebAuthn/recovery failures in 15 min, or any `PLATFORM_MFA_RATE_LIMITED` | `platform.mfa.failed`; lockout log/response; confirm the audit metadata carries the reason | SEV-2 | Platform Owner |
| AUTH-03 | Recovery code used successfully | **Any** success; escalate to SEV-1 if outside an expected recovery window, from a new IP/country, or more than once in 24 h | `platform.mfa.recovery_code_succeeded`; no geo/ASN exists yet | SEV-1 at the exceptional threshold; otherwise SEV-2 | Platform Owner + Security Reviewer |
| AUTH-04 | Repeated recovery-code failures | 3 failures in 15 min, or any failure immediately after a success | `platform.mfa.recovery_code_failed` | SEV-2 | Platform Owner |
| AUTH-05 | WebAuthn key registered or removed | Any registration/removal; **SEV-1** for removal of the last key or a break-glass reset | `platform.webauthn.registered`, `platform.webauthn.key_removed`, `platform.admin.break_glass_reset` | SEV-2 / SEV-1 | Platform Owner |
| AUTH-06 | WebAuthn login failure burst | 5 failures in 15 min for one account or 10 from one IP | `platform.webauthn.login_failed` | SEV-2 | Platform Owner |
| AUTH-07 | Administrator password changed | Any change outside an announced maintenance window | `platform.account.password_changed` | SEV-2 | Platform Owner + Security Reviewer |

### 3.2 Access and authorization

| ID | Alert | Starting threshold | Source / gap | Severity | First response owner |
| --- | --- | --- | --- | --- | --- |
| ACCESS-01 | Outer access-gate denials | 20 responses in 5 min from one IP, or 100 in 15 min globally | **Gap:** `platformAccessGate` currently returns 401 without an audit row or durable counter. Add a bounded counter/event before relying on this alert. | SEV-2 | Platform Owner |
| ACCESS-02 | Capability or route denial | 5 `platform.access.denied` in 15 min, or any denial on an audit/administrator route | `platform.access.denied`; high-capability route names are already bounded | SEV-2 | Platform Owner |
| ACCESS-03 | Foreign-Origin or CSRF refusal | **Any** `platform.access.denied` whose bounded reason is `platform_csrf_origin` or `platform_csrf_invalid` on a cookie request | Already audited by `platformAuthenticate` with a bounded reason; the remaining work is alert delivery and count visibility, not the event itself | SEV-2 | Platform Owner + Service Owner |
| ACCESS-04 | Direct-origin bypass attempt (after Access is adopted) | Any request to `onrender.com` for a platform path without a valid Access token, or an Access denial spike | Requires the access-layer origin check and edge logs; see [`PLATFORM_ACCESS_LAYER_ASSESSMENT.md`](PLATFORM_ACCESS_LAYER_ASSESSMENT.md) | SEV-1 | Edge/DNS owner + Platform Owner |
| ACCESS-05 | New or changed access policy | Any Access policy/identity-provider change | Cloudflare audit/configuration log; no local source today | SEV-1 | Edge/DNS owner |

### 3.3 Administrator and audit integrity

| ID | Alert | Starting threshold | Source / gap | Severity | First response owner |
| --- | --- | --- | --- | --- | --- |
| ADMIN-01 | Administrator disabled, deleted, re-enabled or key removed | Any; **SEV-1** for deleting/disabling the last SUPERADMIN or a break-glass reset | `platform.admin.status_changed`, `platform.admin.deleted`, `platform.webauthn.key_removed`, `platform.admin.break_glass_reset` | SEV-1 / SEV-2 | Platform Owner + Security Reviewer |
| ADMIN-02 | Recovery-code set generated or rotated | Any | `platform.mfa.recovery_codes_generated` | SEV-2 | Platform Owner |
| ADMIN-03 | New administrator created | Any | **Gap:** administrator creation is CLI-only and currently has no platform audit action. Record the creation in the operator runbook and add an audit event before widening the team. | SEV-2 | Platform Owner |
| AUDIT-01 | Audit write failure | Any `[platform-audit] append failed` or missing expected event | **Gap:** `recordPlatformAudit` currently logs to stderr and continues; no durable counter/alert. Add a counter and test the failure path. | SEV-1 | Service Owner + Platform Owner |
| AUDIT-02 | Audit read by an unexpected role | Any successful audit read outside SUPERADMIN/SECURITY | `platform.audit.read` already records actor/role | SEV-2 | Security Reviewer |

### 3.4 Service health, reliability and AI

| ID | Alert | Starting threshold | Source / gap | Severity | First response owner |
| --- | --- | --- | --- | --- | --- |
| HEALTH-01 | Readiness failure | `/api/health/ready` returns 503 twice, 20 s apart | UptimeRobot, already live | SEV-1 | Service Owner |
| HEALTH-02 | Server 5xx burst | 2 or more new 5xx responses in 5 min | `ops_error_events` and process counters | SEV-2 | Service Owner |
| HEALTH-03 | Wrong deployed commit or posture | Served commit differs from the approved release, or `environment` is not `production` | `/api/health`; deployment/release record | SEV-2 | Service Owner |
| HEALTH-04 | AI failure-rate or latency degradation | Failure rate >10% over 15 min with at least 5 turns, or p95 >2× the 7-day p95 for 15 min | AI turn metrics; existing monitoring thresholds | SEV-2 | Service Owner + AI owner |
| HEALTH-05 | AI spend or paid fallback crossing a budget | 80% of the agreed daily/monthly budget warns; 100% is SEV-1 if paid fallback is not already disabled; unknown cost is a separate warning | AI turn cost reports; **process-local** simple paid budget; provider-reported values only | SEV-2 / SEV-1 at 100% | Platform Owner |
| HEALTH-06 | AI model cooling/unavailable | Any configured model unavailable or a failover event outside the approved drill | AI health/watchdog records | SEV-3 | Service Owner |
| DATA-01 | Backup/restore verification failure | Any failed scheduled restore verification, or missing backup beyond the RPO | **Gap:** no tested restore evidence in the platform runbook; see CI-15 | SEV-1 | Platform Owner + Service Owner |
| TICKET-01 | Support SLA breach | An open ticket passes its response/resolve target | Platform ticket timestamps; **no SLA object or clock exists yet** | SEV-3 | Support Lead (when staffed) |

## 4. Threshold behaviour and noise control

1. **Use both account and source.** A per-account rule catches a targeted attempt; a per-IP rule
   catches spraying. Do not key on a client-supplied email or administrator id alone.
2. **Reset on success where appropriate.** A successful MFA after a failure burst should close the
   transient alert; a recovery-code success never closes automatically.
3. **Deduplicate.** Key an alert by `rule + actor/account + source`, suppress repeats for 30 minutes,
   and increment a count rather than opening a new issue for every event.
4. **Never alert on a single tenant `4xx`.** A `4xx` is an expected refusal; a `5xx` is a failure.
   Platform-denial events are different because they are security signals.
5. **Keep a minimum sample.** Percentage thresholds require a minimum number of events so one failure
   in one turn is not a 100% outage.
6. **Tune after two weeks.** Record the observed baseline, false positives and missing detections;
   change one threshold at a time.
7. **Preserve evidence before containment.** Do not delete audit rows, rotate the only key or reset
   the database until the relevant request ids and bounded event rows are copied to the incident
   record.
8. **Do not send credentials or tenant data.** Link to the authenticated console/audit record instead.
9. **Alert tests are synthetic.** Use a test administrator/route or an injected audit event in a
   non-production environment; do not deliberately attack the production administrator.

## 5. Response playbooks

### AUTH-01/AUTH-02/AUTH-06 — credential attack or lockout

1. Confirm whether the source is the owner's known device/IP; check the account's recent successful
   login and session list.
2. If suspicious: disable the account or revoke its sessions, rotate the password, and verify MFA
   factors. Do not break-glass a working account.
3. If the account is locked: follow the documented wait window; use a recovery code only from the
   offline store; rotate the code set after use.
4. Record the request ids, IP/user-agent, action/outcome and the containment time in the incident
   record. Check whether the outer gate also recorded denials.

### AUTH-03/AUTH-04/AUTH-05 — recovery or WebAuthn anomaly

1. Treat a successful recovery code as a potential account takeover until the operator confirms it.
2. Revoke all platform sessions, generate a new recovery-code set, and review the WebAuthn key list
   for unknown credentials.
3. If the last key was removed or break-glass ran, require a new MFA enrollment and confirm the owner
   approved the reset.
4. Preserve the audit rows before rotating factors.

### ACCESS-01..05 — edge/access anomaly

1. Block the source at the edge if the platform is behind Cloudflare; otherwise use the existing
   access-gate/rate-limit controls.
2. Confirm the direct Render URL rejects platform requests without the origin token.
3. Rotate `PLATFORM_ACCESS_KEY` only if it may be exposed; update every legitimate client and record
   the rollout.
4. Check Access policy/IdP changes and the Cloudflare account's own MFA/session activity.

### ADMIN-01..03/AUDIT-01..02 — administrator or audit event

1. Confirm the actor and change ticket; if not expected, revoke the actor's sessions and disable the
   account.
2. Verify the last-SUPERADMIN and recovery path before making another change.
3. If audit writes are failing, treat the interval as a gap in the record; preserve application logs,
   stop destructive changes and restore the writer before continuing.
4. For an unexpected audit read, review the accessed records and rotate any credential that was
   exposed.

### HEALTH-01..06/DATA-01/TICKET-01 — service and support

1. Follow the existing monitoring/incident procedure for health and 5xx.
2. Use the AI cost/model runbook; disable paid fallback if spend is the risk.
3. If backup verification fails, stop assuming recoverability and open a restore task against a
   disposable database.
4. For a support SLA breach, escalate to the named support owner; do not grant tenant detail to
   resolve it before the support-grant gate exists.

## 6. Implementation slices (not authorized here)

| Slice | Work | Prerequisite |
| --- | --- | --- |
| 1. Catalogue and ownership | Approve this document, name the backup reviewer, create the security mailbox, record the alert destinations | Owner decision |
| 2. Instrumentation | Add bounded audit/counter events for outer-gate denials, CSRF/origin refusals and audit-write failures; expose the counts without credentials or tenant data | Code and tests |
| 3. Evaluator | A scheduled/streaming evaluator reads audit/error/AI aggregates, applies dedupe/cooldown, writes an alert record and sends to the approved channel | Durable storage and retry policy |
| 4. Channel integration | Existing UptimeRobot email/push, owner email alias, GitHub issue; no paid pager or chat plan | Owner decision |
| 5. Test and tune | Synthetic events for every rule, a tabletop for SEV-1, two-week noise review | Alert history |
| 6. Operationalize | Link to the incident runbook, add an alert-on/alert-off change record, review quarterly | Named owners |

### Acceptance criteria

- Every active alert has an ID, threshold, owner, channel, severity and runbook link.
- A synthetic event for each rule produces exactly one deduplicated notification and a durable record.
- No alert contains a secret, a session token, a recovery code, a full request body or tenant data.
- A failed audit writer and a failed alert sender are themselves visible; neither fails silently.
- The direct-origin bypass check exists if Cloudflare Access is adopted.
- The owner can state who is on call, the escalation path and the maximum acceptable detection time.
- The alert catalogue is tested against the actual deployed event names, not names invented in this
  document.

## 7. Known gaps this plan deliberately exposes

- Outer-gate 401s are not currently audited, so ACCESS-01 cannot be implemented as written without
  instrumentation.
- CSRF/origin refusals are already written as `platform.access.denied` with a bounded reason; the
  missing part is delivery/deduplication, not the event source.
- Audit write failure is a stderr log, not a durable counter; AUDIT-01 is a real gap.
- Administrator creation is CLI-only and has no audit action; ADMIN-03 needs an event before it can
  alert.
- The console has no host CPU/memory, Atlas cluster, backup-status or mobile crash telemetry; those
  alerts require a source that does not exist in this service.
- Cloudflare Access's free plan retains standard logs for up to 24 hours; an incident review needs
  export or a paid retention decision.
- There is no owned pager or 24/7 rota today. Email/GitHub issue delivery is the honest starting
  point; a paid pager is deferred until revenue and a named rota exist.

## 8. Sources

- Existing health/alert procedure: [`MONITORING.md`](MONITORING.md).
- Existing platform security recommendations: [`PLATFORM_SECURITY_RECOMMENDATIONS.md`](PLATFORM_SECURITY_RECOMMENDATIONS.md) (SEC-09).
- Existing console roadmap: [`PLATFORM_CONSOLE_IMPROVEMENTS.md`](PLATFORM_CONSOLE_IMPROVEMENTS.md) (CI-05, CI-11–CI-15).
- Production readiness gates: [`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md).
- Free ownership/channel decisions: [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).
- Platform audit model and actions: `server/src/models/platformAuditLog.model.ts`,
  `server/src/constants/platformAudit.ts`.
- Cloudflare Access log retention: <https://www.cloudflare.com/plans/zero-trust-services/>.
