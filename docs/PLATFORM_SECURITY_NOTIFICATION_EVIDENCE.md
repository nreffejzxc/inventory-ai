# Platform security — two-contact notification evidence

**Status:** **NOT RUN. NO DELIVERY CONFIRMED. SECURITY ALERTS REMAIN INACTIVE.**
**Purpose:** record the evidence that a test notification reached both the primary and backup
security contacts before any security alert is activated.

This is an evidence record, not an alert channel. It contains **no email address, phone number,
password, recovery code or token**. The actual contact details remain in the owner's private record.

## 1. Record

| Field | Value |
| --- | --- |
| Test ID | **PENDING** |
| Test date/time (UTC) | **PENDING** |
| Tester | **PENDING** |
| Notification channel — primary | Owner email (address in private record); **not yet sent** |
| Notification channel — backup | Backup email and phone (values in private record); **not yet sent** |
| Primary delivery confirmation | **PENDING** — time, method and evidence required |
| Backup delivery confirmation | **PENDING** — time, method and evidence required |
| Backup acknowledgement of duty | **PENDING** — written acknowledgement required |
| Evidence artifact | **PENDING** — redacted message id/screenshot or issue link |
| Result | **NOT RUN** |

The record is not complete when a message is merely *sent*. A delivery is confirmed only when the
recipient acknowledges receipt, or an independent delivery receipt is captured and linked here.

## 2. Required evidence

| Requirement | Evidence to record |
| --- | --- |
| Notification channel | Email, phone/push, or another owner-controlled channel — **type only**, never the address/number |
| Delivery date and time | UTC timestamp for each recipient |
| Tester | Name/role of the person who sent the test |
| Primary delivery confirmation | Acknowledgement or delivery receipt, with redacted evidence link |
| Backup delivery confirmation | Acknowledgement or delivery receipt, with redacted evidence link |
| Acknowledgement | Cucumber's written acceptance of the backup duty |
| Privacy check | Confirmation that the evidence file contains no address, phone, token, code or tenant data |

A screenshot must have the address/number redacted before it is linked. Prefer a message id or a
redacted export over a full mailbox screenshot.

## 3. Activation gate

Security alerts may be activated only when **all** of these are true:

- [ ] Primary delivery confirmed.
- [ ] Backup delivery confirmed.
- [ ] Backup acknowledgement recorded.
- [ ] Evidence artifact linked and privacy-checked.
- [ ] The contact record and decision sheet are updated with the result.
- [ ] The owner signs the activation checklist.

If either delivery fails:

1. Do not activate any security alert.
2. Correct the contact path in the private owner record.
3. Re-run the test and add a new row/version; do not erase the failed attempt.
4. Record the failure and the retry in the evidence.

**A single successful send to one person is not two-contact coverage.**

## 4. What this does not authorize

- No alert evaluator, mailbox, pager, GitHub label or UptimeRobot contact is created.
- No production configuration or database operation.
- No paid service.
- No claim that security alerting is covered.

## 5. Related

- [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) — named primary/backup and the
  activation gate.
- [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md) — alert
  catalogue, channels and signed activation checklist.
- [`MONITORING.md`](MONITORING.md) — existing health watch.
