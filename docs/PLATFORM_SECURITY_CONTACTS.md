# Platform security contacts — primary and backup

**Status:** **PRIMARY AND BACKUP NAMED; CONTACT DETAILS PRIVATE; TEST NOTIFICATION PENDING; SECURITY
ALERTS NOT ACTIVE.** This is the single role/name record for platform-security responsibilities. It
does not contain the backup's email address or phone number, activate an alert, create a mailbox, page
anyone or change production.

**Reviewed:** 2026-11-17
**Cost:** $0 — the existing owner email and GitHub/UptimeRobot channels are sufficient.

## 1. Contact record

| Role | Person | Contact | Status |
| --- | --- | --- | --- |
| **Primary security contact / incident lead** | **`nreffejzxc` — account owner** | The owner's monitored email in the owner's private record; the account-runbook entry is the public pointer. GitHub notifications | **Recorded** |
| **Backup security contact / reviewer** | **Cucumber** | **Held only in the owner's private record; deliberately not committed** | **Name and role recorded; test notification pending** |
| Service/API health backup | **Cucumber** | Private owner record | Named; test pending |
| Edge/DNS/Access backup (only if Cloudflare is adopted) | **Cucumber** | Private owner record | Named; deferred with the access migration |
| Support SLA owner | **UNASSIGNED** | — | Support is not staffed |

The primary is a named account identity. The backup is a **real person named by the owner**, not a
role-only placeholder. The actual email address and phone number are intentionally absent from this
repository and from chat; they live in the owner's private record.

**What is still unproven:** Cucumber has not yet acknowledged the duty in this record, and no test
notification has been shown to reach both contacts. The owner states the contact is actively
monitored; that statement is not the same as a delivered test.

## 2. Activation gate

Security alerts must remain **inactive** until all of the following are true:

- [x] The backup column names a real person.
- [x] The backup's monitored contact path exists and is held in the owner's private record.
- [ ] The backup has acknowledged the duty in writing.
- [ ] A test notification reaches the primary **and** the backup.
- [ ] The backup can access the alert history and the incident runbook.
- [ ] The owner has signed the activation checklist in
      [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).

Until then:

- The existing **UptimeRobot health email** may continue (it is already live), but it is not a
  platform-security alert pipeline.
- No new security alert, pager, mailbox or on-call claim is active.
- A SEV-1 security event is handled best-effort by the owner and the named backup; that limitation is
  recorded rather than hidden.
- The backup is a second person, not “the same person under a different role.”

## 3. Responsibilities

| Duty | Primary | Backup |
| --- | --- | --- |
| Triage authentication/recovery/WebAuthn alerts | `nreffejzxc` | **Cucumber** |
| Approve/contain administrator changes and audit incidents | `nreffejzxc` | **Cucumber** |
| Own service/5xx/deploy/AI health response | `nreffejzxc` | **Cucumber** |
| Preserve evidence and open the incident record | `nreffejzxc` | **Cucumber** |
| Decide to disable/rotate a credential | `nreffejzxc` | **Cucumber** (second reviewer preferred) |
| Communicate with a future customer | Not staffed | — |

The owner may delegate a specific incident, but the delegation must be recorded with a name, time and
scope; a verbal “someone will look” is not a backup. The backup's authority is to review and escalate,
not to use the owner's password, recovery codes or private key.

## 4. Contact hygiene

- **Do not add the backup's email address or phone number to this document, an issue, a PR or chat.**
  The private owner record is the only location.
- Do not publish a personal phone number, recovery code, password or private key here.
- Use a monitored owner email and GitHub notifications. A free email alias is sufficient; no paid
  mailbox is needed.
- If either contact's address changes, update the private owner record and this role/name record.
- Review access to the mailbox and GitHub account quarterly.
- Keep recovery codes in the existing offline store, separate from this document.
- If the primary is unreachable, the backup must be able to open the incident record without the
  primary's device. That is why the contact path must be tested, not merely known.

## 5. Review cadence

| Review | What is checked |
| --- | --- |
| Monthly | Primary and backup contacts still monitored; backup still willing/available |
| Quarterly | Both contacts complete; test notification succeeds; access to runbook/alert history |
| On change | Owner email, backup contact, GitHub access, mailbox or on-call arrangement changes |
| Before wider access | Backup has acknowledged and the test notification has passed |

## 6. What to do now

1. **Owner:** keep Cucumber's actual email/phone only in the private owner record.
2. **Backup:** acknowledge the duty in writing (a GitHub issue or signed note is sufficient).
3. **Owner + backup:** send a test notification to both contacts and record the delivery time and
   channel in the decision sheet.
4. **Owner:** complete the activation checklist in the decision sheet.
5. Only then may a security alert be described as covered.

No paid service is required. The remaining gap is **verification**, not a subscription.

## 7. Related

- [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md) — alert
  ownership, channels, thresholds and activation checklist.
- [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) — current owner/provider contacts.
- [`MONITORING.md`](MONITORING.md) — existing health watch and incident procedure.
