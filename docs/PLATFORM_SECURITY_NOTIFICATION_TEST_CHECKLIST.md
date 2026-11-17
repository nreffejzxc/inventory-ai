# Inventory AI - two-contact notification test checklist

**Print this page and keep it with the private evidence. Do not activate security alerts until every box is checked.**
**Status:** **NOT RUN - security alerts remain inactive.** This checklist does not send anything.

**Printable PDF:** [`PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf`](PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf)

**Test ID:** ______________________  **Test date (UTC):** ______________________  **Tester:** ______________________

## 1. Before sending

- [ ] The private owner record is open. Actual email addresses and phone numbers are **not** written on this sheet or copied into the repository.
- [ ] Both channels already exist and are owner-controlled. No paid mailbox, SMS service or pager is being created.
- [ ] The message uses the approved template and contains no password, API key, token, recovery code, customer data or login-required link.
- [ ] A redacted evidence location is ready (message id or screenshot with address/number hidden).

## 2. Send and confirm receipt

| Contact | Channel type (not address/number) | Sent (UTC) | Received - confirmed (UTC) | Confirmation method |
| --- | --- | --- | --- | --- |
| Primary contact | | | | |
| Cucumber - backup | | | | |

- [ ] Primary contact confirmed receipt at the UTC time above.
- [ ] Cucumber confirmed receipt at the UTC time above.
- [ ] Neither confirmation relies only on "message sent"; there is a reply, read receipt or independent delivery receipt.

## 3. Acknowledgement and evidence

- [ ] Cucumber gave **written acknowledgement** of the backup security-contact duty (reply or issue link).
- [ ] Every evidence record is redacted: no email address, phone number, password, API key, token, recovery code or tenant/customer data.
- [ ] The redacted evidence artifact is linked from the evidence record.
- [ ] A failed attempt, if any, is preserved; any retry has a new test ID.

## 4. Final activation gate - all required

- [ ] Both delivery confirmations and UTC timestamps are recorded.
- [ ] Cucumber's written acknowledgement is recorded.
- [ ] Evidence is redacted and privacy-checked.
- [ ] The contact record and alert decision sheet are updated with the result.
- [ ] The owner has signed the activation checklist in the evidence record.

**Owner signature:** ______________________  **Date (UTC):** ______________________

> **STOP** if any box is blank or either delivery failed. Do not activate. Fix the private contact path, record the failure, and retry with a new test ID. A send to one person is not two-contact coverage.

**Related:** [`PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md`](PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md) | [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) | [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md)
