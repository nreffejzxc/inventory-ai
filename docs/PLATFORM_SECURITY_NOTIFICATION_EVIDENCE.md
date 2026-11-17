# Platform security — two-contact notification evidence

**Status:** **NOT RUN. NO DELIVERY CONFIRMED. SECURITY ALERTS REMAIN INACTIVE.**
**Purpose:** record the evidence that a test notification reached both the primary and backup
security contacts before any security alert is activated.

This is an evidence record, not an alert channel. It contains **no email address, phone number,
password, recovery code or token**. The actual contact details remain in the owner's private record.

## 1. Procedure

**Who sends:** the account owner. The backup may receive and acknowledge, but does not send the test
on the owner's behalf.

**Channels:** use the existing owner-controlled email as the default. A phone call/message is
acceptable only when it is already part of the owner's existing plan and creates no incremental
charge. Do not create a paid mailbox, SMS service or pager.

**Before sending:** open the private owner record for the actual addresses/numbers. Do not paste them
into the repository, a commit, an issue, a pull request or chat.

1. **Create the test record.** Assign a test ID and record the start time in UTC. Leave every
delivery field **PENDING**.
2. **Write the minimal message.** Subject: `Inventory AI security notification test`. Body: state
   that this is a test, no action is required, and ask the recipient to reply `received`. Include no
   password, API key, token, recovery code, customer data or link that requires a login.
3. **Send to the primary.** Use the existing owner-controlled email. Record only the channel type
   (email), not the address.
4. **Send to the backup.** Use the backup's monitored email; use the phone path too only if it is
   already available at no incremental cost. Record the channel type(s), not the values.
5. **Do not count a send as delivery.** Wait for a reply, read receipt or independent delivery
   receipt from each recipient. Record the UTC confirmation time for each.
6. **Collect the acknowledgement.** Ask Cucumber to confirm the backup duty in writing (a reply or a
   GitHub issue without private details is sufficient). This is separate from receiving the test.
7. **Capture redacted evidence.** Prefer a message id or a screenshot with the address/number
   redacted. Link it from the record; never attach a full mailbox export.
8. **Privacy check.** Confirm the evidence has no address, phone number, password, key, token,
   recovery code or tenant data.
9. **Stop if either delivery fails.** Do not activate an alert. Correct the private contact path,
   record the failed attempt, and repeat from step 1 with a new test ID.
10. **Only after both confirmations and the acknowledgement** update the contact/decision records and
    ask the owner to sign the activation checklist.

**Message template:**

```text
Subject: Inventory AI security notification test

This is a test of the security notification path. No action is required.
Please reply "received" so I can record that this channel reached you.
Do not include passwords, keys, tokens, recovery codes or customer data in your reply.
```

Do not send this test as part of this documentation change. Sending it is a separate owner action.

## 2. Record

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

## 3. Required evidence

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

## 4. Activation gate

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

## 5. What this does not authorize

- No alert evaluator, mailbox, pager, GitHub label or UptimeRobot contact is created.
- No production configuration or database operation.
- No paid service.
- No claim that security alerting is covered.

## 6. Related

- [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) — named primary/backup and the
  activation gate.
- [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md) — alert
  catalogue, channels and signed activation checklist.
- [`MONITORING.md`](MONITORING.md) — existing health watch.
