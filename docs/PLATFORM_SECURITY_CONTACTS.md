# Platform security contacts — primary and backup

**Status:** **PRIMARY RECORDED; BACKUP UNASSIGNED; SECURITY ALERTS NOT ACTIVE.** This is the single
contact record for platform-security responsibilities. It does not activate an alert, create a
mailbox, page anyone or change production.

**Reviewed:** 2026-11-17
**Cost:** $0 — the existing owner email and GitHub/UptimeRobot channels are sufficient.

## 1. Contact record

| Role | Person | Contact | Status |
| --- | --- | --- | --- |
| **Primary security contact / incident lead** | **`nreffejzxc` — account owner** | The owner's monitored email recorded in [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md); GitHub notifications | **Recorded** |
| **Backup security contact / reviewer** | **UNASSIGNED** | — | **Blocked: no backup named** |
| Service/API health backup | **UNASSIGNED** | — | Secondary gap; primary is the owner |
| Edge/DNS/Access backup (only if Cloudflare is adopted) | **UNASSIGNED** | — | Deferred with the access migration |
| Support SLA owner | **UNASSIGNED** | — | Support is not staffed |

The primary is a named account identity, not a role-only placeholder. The **backup is deliberately not
invented**: a role name without a person and a tested contact path is not a backup.

## 2. Activation gate

Security alerts must remain **inactive** until all of the following are true:

- [ ] The backup column names a real person.
- [ ] The backup has a monitored contact path (email and, if available, a phone/push path).
- [ ] The backup has acknowledged the duty in writing.
- [ ] A test notification reaches the primary **and** the backup.
- [ ] The backup can access the alert history and the incident runbook.
- [ ] The owner has signed the activation checklist in
      [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).

Until then:

- The existing **UptimeRobot health email** may continue (it is already live), but it is not a
  platform-security alert pipeline.
- No new security alert, pager, mailbox or on-call claim is active.
- A SEV-1 security event is handled best-effort by the owner; that limitation is recorded rather than
  hidden.
- The backup cannot be “the same person under a different role.” A single-owner operation may accept
  that risk explicitly, but it does not create a second responder.

## 3. Responsibilities

| Duty | Primary | Backup |
| --- | --- | --- |
| Triage authentication/recovery/WebAuthn alerts | `nreffejzxc` | **UNASSIGNED** |
| Approve/contain administrator changes and audit incidents | `nreffejzxc` | **UNASSIGNED** |
| Own service/5xx/deploy/AI health response | `nreffejzxc` | **UNASSIGNED** |
| Preserve evidence and open the incident record | `nreffejzxc` | **UNASSIGNED** |
| Decide to disable/rotate a credential | `nreffejzxc` | **UNASSIGNED** (second reviewer preferred) |
| Communicate with a future customer | Not staffed | — |

The owner may delegate a specific incident, but the delegation must be recorded with a name, time and
scope; a verbal “someone will look” is not a backup.

## 4. Contact hygiene

- Do not publish a personal phone number, recovery code, password or private key here.
- Use a monitored owner email and GitHub notifications. A free email alias is sufficient; no paid
  mailbox is needed.
- If the owner email changes, update the account runbook and this record in the same change.
- Review access to the mailbox and GitHub account quarterly.
- Keep recovery codes in the existing offline store, separate from this document.
- If the primary is unreachable, the backup must be able to open the incident record without the
  primary's device. That is why a real second person and a tested contact path are required.

## 5. Review cadence

| Review | What is checked |
| --- | --- |
| Monthly | Primary contact still monitored; backup still willing/available |
| Quarterly | Both contacts complete; test notification succeeds; access to runbook/alert history |
| On change | Owner email, GitHub access, mailbox or on-call arrangement changes |
| Before wider access | A named backup exists and has accepted the duty |

## 6. What to do now

1. The owner supplies the backup person's name and monitored contact.
2. The backup accepts the duty and receives a test notification.
3. The owner completes the activation checklist in the decision sheet.
4. Only then may a security alert be described as covered.

No paid service is required. The gap is a **person**, not a subscription.

## 7. Related

- [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md) — alert
  ownership, channels, thresholds and activation checklist.
- [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) — current owner/provider contacts.
- [`MONITORING.md`](MONITORING.md) — existing health watch and incident procedure.
