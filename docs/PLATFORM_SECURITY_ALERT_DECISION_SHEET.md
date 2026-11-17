# Platform Security — alert decision sheet and ownership

**Status:** **DECISION SHEET ONLY. NO NEW SECURITY ALERT, CHANNEL OR ROTA IS LIVE.** The existing
UptimeRobot health email remains live; this page turns the alert catalogue in
[`PLATFORM_SECURITY_MONITORING_PLAN.md`](PLATFORM_SECURITY_MONITORING_PLAN.md) into a named
accountability record. It does not create a mailbox, pager, dashboard or notification.

**Reviewed:** 2026-11-17
**Scope:** Platform authentication, recovery, WebAuthn, access/audit events, service health, AI cost
and support SLA signals.
**Purpose:** answer “who acts, where do they see it first, and what must exist before this alert may
be switched on?”

## 1. The honest starting position

Inventory AI currently has **one operator**. The only verified automatic channel is UptimeRobot's
email for health/readiness. There is no security mailbox, no pager, no backup reviewer and no 24/7
rota. This sheet does not pretend otherwise.

Therefore:

- The **primary** is the account owner for every platform-security alert today.
- The **backup is unassigned** for every security alert. That is a stop condition for activation,
  not a role name we can invent.
- Alert activation is split into “can be tested now” and “may be relied on operationally.” No
  security alert may be treated as operationally covered until a named backup and contact method are
  recorded below.
- Health/readiness email is already live; it is not the same as platform-security alerting.

## 2. Named-owner record

Complete this table before activating any security alert. A GitHub handle is not a sufficient contact;
record a monitored address/phone and the time zone.

| Duty | Primary name | Primary contact | Backup name | Backup contact | Time zone |
| --- | --- | --- | --- | --- | --- |
| Platform security (auth, recovery, WebAuthn, admin, audit) | **Account owner — name to record** | Owner-controlled security mailbox (to create) | **UNASSIGNED — activation blocked** | — | Owner's local |
| Service/API health, deploys, 5xx, AI model health | **Account owner — name to record** | Owner-controlled mailbox + UptimeRobot | **UNASSIGNED** | — | Owner's local |
| Edge/DNS/Access policy (only if Cloudflare Access is adopted) | **Account owner — name to record** | Owner-controlled mailbox | **UNASSIGNED** | — | Owner's local |
| Support ticket SLA (only when support is staffed) | **UNASSIGNED — support not staffed** | — | — | — | — |

**Decision:** it is acceptable for one person to hold primary for all duties during the internal
single-owner phase. It is **not** acceptable to claim a backup exists because a role name appears in
a document. The backup column must contain a person's name and a tested contact path.

## 3. Channel decision

| Priority | First notification | Durable record | Escalation if unacknowledged |
| --- | --- | --- | --- |
| **SEV-1** | UptimeRobot email/mobile push for health; owner security mailbox for platform security | GitHub issue with alert id, time, bounded evidence and owner | Repeat to owner phone if configured; no paid pager today |
| **SEV-2** | Owner security mailbox; GitHub issue as fallback | GitHub issue | Re-notify after 1 hour during operating hours |
| **SEV-3** | GitHub issue or daily/weekly digest | GitHub issue/digest | Review at the next weekly triage |

“Owner security mailbox” is a **required new channel**; its address must be recorded in the owner's
secret store and this table. It is not created by this document, and no address is invented here.

Do not use the Platform Console itself as the pager: it depends on the same database/process it
monitors. The console is the investigation surface; UptimeRobot/GitHub/security mailbox are the
delivery surfaces.

## 4. Alert-to-owner matrix

Alert IDs and thresholds remain authoritative in
[`PLATFORM_SECURITY_MONITORING_PLAN.md`](PLATFORM_SECURITY_MONITORING_PLAN.md). This table assigns the
human response.

| Alert group | IDs | Primary | Backup | First channel | Acknowledge target |
| --- | --- | --- | --- | --- | --- |
| Password/MFA/recovery | AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-07 | Platform Owner | **UNASSIGNED** | Security mailbox; SEV-1 also UptimeRobot path | 15 min SEV-1 / 1 h SEV-2 |
| WebAuthn changes/failures | AUTH-05, AUTH-06 | Platform Owner | **UNASSIGNED** | Security mailbox; key removal also GitHub issue | 15 min SEV-1 / 1 h SEV-2 |
| Outer gate/CSRF/authorization | ACCESS-01, ACCESS-02, ACCESS-03 | Platform Owner | **UNASSIGNED** | Security mailbox + GitHub issue | 1 h |
| Access edge/direct-origin (if adopted) | ACCESS-04, ACCESS-05 | Edge/DNS owner | **UNASSIGNED** | Security mailbox; SEV-1 immediate | 15 min |
| Administrator/audit integrity | ADMIN-01, ADMIN-02, ADMIN-03, AUDIT-01, AUDIT-02 | Platform Owner | **UNASSIGNED** | Security mailbox + GitHub issue | 15 min SEV-1 / 1 h SEV-2 |
| Readiness | HEALTH-01 | Service Owner | **UNASSIGNED** | UptimeRobot email (live) | 15 min |
| 5xx/posture/commit | HEALTH-02, HEALTH-03 | Service Owner | **UNASSIGNED** | UptimeRobot/GitHub issue | 1 h |
| AI failure/latency/model | HEALTH-04, HEALTH-06 | Service Owner | **UNASSIGNED** | GitHub issue; SEV-2 mailbox if available | 1 h |
| AI budget/paid fallback | HEALTH-05 | Platform Owner | **UNASSIGNED** | Security mailbox + GitHub issue | 15 min at 100% |
| Backup/restore verification | DATA-01 | Platform Owner | **UNASSIGNED** | Security mailbox + GitHub issue | 15 min |
| Support SLA | TICKET-01 | Support Lead | **UNASSIGNED** | Ticket queue + digest | Next business day |

**Operational consequence:** until each backup and channel is filled, only HEALTH-01 has a verified
end-to-end recipient. Everything else is a planned alert, not a covered one.

## 5. Required instrumentation before activation

An alert cannot be activated just because a threshold sounds reasonable. The source must exist,
produce bounded events and be testable.

| Prerequisite | Needed by | Current state | Activation gate |
| --- | --- | --- | --- |
| Audit query/aggregate by action, outcome, reason, actor, IP, request id and time window | AUTH-01–07, ACCESS-02/03, ADMIN-01–03, AUDIT-02 | Audit rows exist; no alert evaluator | Query returns deterministic counts on seeded events |
| Outer-gate denial counter/event | ACCESS-01 | **Missing**: the gate returns 401 without an audit row | Bounded per-IP/global counter exists; no key/credential logged |
| Audit-write failure counter | AUDIT-01 | **Missing**: `recordPlatformAudit` logs to stderr and continues | A durable counter/event exists and is tested with a forced write failure |
| Administrator-creation audit event | ADMIN-03 | **Missing**: CLI creation has no platform audit action | Event exists with actor/time/target (no password/key) |
| CSRF refusal visibility | ACCESS-03 | Present as `platform.access.denied` with a bounded reason | Counts are queryable and alertable |
| Durable 5xx/readiness posture | HEALTH-01–03 | Present (`ops_error_events`, health endpoints, UptimeRobot) | Alert delivery and recovery close are tested |
| AI turn/cost/model records | HEALTH-04–06 | Present; cost is provider-reported only | Threshold uses observed fields; unknown cost stays unknown |
| Backup/restore verification signal | DATA-01 | No scheduled verification signal | Drill produces a recorded pass/fail with manifest hash and counts |
| Access edge logs | ACCESS-04/05 | Not applicable until Cloudflare Access is adopted | 24-hour retention limitation understood; evidence capture path exists |
| Ticket SLA timestamps | TICKET-01 | Ticket workflow exists; no SLA clock | Queue owner and due-time calculation exist |

**Do not activate an alert whose source is missing.** A threshold without a source creates a false
sense of coverage.

## 6. Activation checklist

Each item is signed and dated by the Platform Owner; the backup sign-off is mandatory for security
alerts.

- [ ] Primary name, contact and time zone recorded in §2.
- [ ] Backup name, contact and time zone recorded; backup has acknowledged the duty.
- [ ] Security mailbox exists, is monitored and has its own MFA/recovery path.
- [ ] UptimeRobot email/mobile path is tested to the primary; health alert recovery is tested.
- [ ] GitHub issue path is tested; labels/owner are correct.
- [ ] Every alert has an ID, source, threshold, severity, owner, channel and runbook link.
- [ ] Deduplication key, cooldown, reset-on-success and minimum sample are defined.
- [ ] Synthetic test for each rule produces exactly one notification and a durable record.
- [ ] A forced audit-write failure and a forced alert-send failure are visible.
- [ ] No alert body contains a password, token, TOTP/recovery code, WebAuthn assertion, Mongo URI,
      request body or tenant data.
- [ ] On-call coverage and the escalation limit are written; “best effort” is stated honestly.
- [ ] Alert disable/rollback is documented so noise can be stopped without deleting evidence.
- [ ] Quarterly review date is scheduled.

**If the backup or security mailbox is missing, the security alert set remains in “test only”
mode.** Health email may continue, but it must not be described as full platform-security coverage.

## 7. Response and review process

### Daily

- Triage new SEV-1/SEV-2 alerts first; acknowledge and assign an owner.
- Record the alert id, request id, bounded evidence and containment time.
- Close only after the cause is understood or a dated accepted risk is recorded.

### Weekly

- Review counts by rule, false positives, missed detections and time-to-acknowledge.
- Review open SEV-3 items and any alert that fired without a runbook step.
- Check that the backup/restore and AI budget signals are still reporting; missing data is a finding.

### Monthly

- Run one tabletop for a SEV-1 (recovery-code use or audit-write failure).
- Verify one channel end to end, including backup notification.
- Review access to the security mailbox and GitHub issues.

### Quarterly

- Owner/security review of thresholds, owners, backup coverage and retention.
- Confirm the Cloudflare Access log-retention choice if Access is adopted.
- Update this sheet and the monitoring plan; do not silently rewrite old measurements.

### Incident roles

| Role | Responsibility |
| --- | --- |
| **Incident lead** | Owns the timeline, decisions and communication; default Platform Owner |
| **Security reviewer** | Confirms containment and evidence preservation; **must be named** |
| **Service operator** | Executes health/rollback/AI cost controls |
| **Recorder** | Keeps the timeline and links request ids/evidence (can be the incident lead) |

One person may hold several roles during the internal phase; the record must say so. A SEV-1
containment action that disables an administrator, rotates a secret or changes Access policy needs a
second reviewer when one is available; if not, record the single-person risk and the reason.

## 8. Open decisions

| Decision | Why it blocks activation | Owner | Due |
| --- | --- | --- | --- |
| Name the security backup | No security alert has a second responder | Owner | Before security alerts go live |
| Create/record the security mailbox | No private first channel exists | Owner | Before SEV-2 activation |
| Enable UptimeRobot mobile push or accept email only | SEV-1 latency is otherwise unknown | Owner | Before go-live |
| Decide whether a paid pager is justified | No 24/7 coverage exists | Owner | Before external support |
| Approve alert source instrumentation | Some rules have no source | Owner + Service Owner | Before activation |
| Approve data retention for alert/audit evidence | 24-hour Access logs are not enough | Owner | Before Access adoption |

## 9. What is not being done

- No mailbox, pager, Slack/Telegram integration, GitHub label or UptimeRobot contact is created.
- No alert-evaluator code, cron, stream, database index or dashboard is added.
- No on-call rotation is claimed.
- No production configuration is changed.
- This sheet does not authorize monitoring implementation; it records the decisions required first.

## 10. Sources

- Alert catalogue and thresholds: [`PLATFORM_SECURITY_MONITORING_PLAN.md`](PLATFORM_SECURITY_MONITORING_PLAN.md).
- Current monitoring/runbook: [`MONITORING.md`](MONITORING.md).
- Access edge/log-retention context: [`PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md`](PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md).
- Production readiness: [`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md).
