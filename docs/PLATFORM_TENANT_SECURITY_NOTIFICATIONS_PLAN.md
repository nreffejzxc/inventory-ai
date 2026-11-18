# TS-01 - tenant security notifications implementation plan

**Status:** **PLANNING ONLY. NO IMPLEMENTATION, NOTIFICATION OR ALERT ACTIVATION.**
**Reviewed:** 2026-11-17
**Scope:** notify a tenant's affected member and active OWNER(s) about security-relevant account
changes, using the existing Brevo mail boundary. No new paid service.

## 1. Why this exists

The platform has an append-only platform audit trail and a tenant audit trail, but neither pushes a
message. A tenant password reset, role change or new session is silent until someone opens the app.
TS-01 turns the relevant events into a short, privacy-safe notice. It is not a marketing preference
centre and it is not the platform/operator alerting in IA-02 or SEC-09.

## 2. What already exists

| Existing piece | Use in TS-01 |
| --- | --- |
| `server/src/services/mail/index.ts` | The only mail boundary; add a tenant-security send there, do not call Brevo from a route |
| Brevo transport (`MAIL_PROVIDER`, `BREVO_API_KEY`) | Existing free provider path; no new vendor or API key in the app |
| `audit_logs` (`businessId`, actor, action, entity, timestamp) | Evidence and event catalogue; **not** the trigger bus |
| `sessions` (`userId`, `deviceLabel`, timestamps) | Session lifecycle facts; no stable device identity |
| `User` (`businessId`, `email`, `role`, `status`) | Server-derived recipient resolution |
| Existing rate-limit patterns | Per-account/tenant budgets and cooldowns |
| `sendOperationalAlertEmail` | Operator-mail precedent; tenant mail needs its own template and recipient rules |

### Two constraints that shape the design

1. **Do not tail the audit log to send mail.** Audit writes are deliberately best-effort in several
   paths, and `USER_CREATED` metadata already includes a name and email. A notification must be
   emitted after the durable domain action, with its own minimal payload.
2. **There is no trustworthy new-device identifier.** `deviceLabel` is client-supplied and cosmetic.
   Phase 1 must not call an alert “new device” based on that string. Use a session-created notice for
   OWNER/ADMIN (and make the wording “a new sign-in”), or defer device-specific alerts until a
   privacy-reviewed identifier exists.

## 3. Event matrix

Events are emitted by the service that performs the action, after the action is durable. The audit
row, when present, remains the evidence; it is not the notification trigger.

| Event | Trigger | Affected member | Active OWNER(s) | Priority |
| --- | --- | --- | --- | --- |
| Password/reset completed | Password change or reset completion | Yes | Yes | Critical |
| Firebase identity linked / conflict | Link outcome | Yes | Yes | High |
| Role or status changed | `USER_UPDATED` after save | Target user | Yes | Critical |
| Invitation sent / accepted / revoked | Invitation transition | No additional notice (invitation mail already carries it) | Yes | High |
| Session created | New session after login | Yes | Yes for OWNER/ADMIN; no for STAFF by default | High |
| All sessions revoked | Sign-out-everywhere | Yes | Yes | High |
| Account deleted | Account deletion | No (identity is tombstoned) | Yes | High |
| Export requested | Future export path (TS-01 dependency) | Yes | Yes | High |

The event payload is a closed shape: `eventId`, `businessId`, `eventType`, `entityId`, `occurredAt`,
`actorDisplayName` (optional), `targetUserId` (optional), and a safe label. It never carries a token,
`jti`, password, email HMAC, IP address, product name, supplier, quantity or free-form request body.

## 4. Recipient rules

Recipients are resolved server-side from the authenticated business and the event's target:

1. Load the target `User` only by `_id` **and** `businessId`.
2. Load active OWNERs with `User.find({ businessId, role: 'OWNER', status: 'ACTIVE' })`.
3. Send to the target if active and not deleted; send to each active OWNER; de-duplicate the list.
4. Never accept a recipient, `businessId`, role or email from the request body.
5. Never send to a DISABLED or DELETED account, another tenant, a platform administrator, or an
   arbitrary address from audit metadata.
6. Do not add a second invitation email: the invitation path already sends its own message.
7. If no active recipient remains, record a suppressed notification with the reason; do not fall
   back to an operator address.

A user email is used as the envelope recipient only. It is not rendered in the body or added to the
event metadata.

## 5. Privacy and content

- **No secrets:** no password, API key, token, `jti`, recovery code, reset link, invitation token or
  session cookie.
- **No business data:** no product, supplier, price, quantity, customer or tenant name.
- **No unnecessary identifiers:** no email address, phone number, IP address or raw `deviceLabel` in
  the body. A safe event type and UTC time are enough.
- **No open redirects or tokenised links:** link to the app's normal sign-in/home surface; the user
  authenticates separately.
- **HTML escaping:** the template library escapes every interpolated value, as the operational-alert
  template does. The text body is the authoritative version.
- **Logs:** log event id, event type, recipient role, outcome and provider status only. Never log the
  recipient address, body, token or provider request payload.
- **Retention:** notification delivery records are operational evidence; define a short retention
  (for example 30 days) and do not copy audit metadata into them. No raw email body is retained.
- **Preferences:** transactional security notices are not marketing. A user may not unsubscribe from
  password/role/session notices; only non-critical categories may be opt-out if that is approved.

## 6. Rate limits and deduplication

These are proposed defaults for the plan, not implemented values:

| Guard | Proposed limit | Reason |
| --- | --- | --- |
| Exact-event dedupe | One per `(businessId, eventType, entityId, recipient)` per 10 minutes | Retries and duplicate triggers must not duplicate mail |
| Per recipient | 10 per hour / 30 per day | Bounds spam and provider cost |
| Per tenant | 50 per hour | Bounds a busy or malicious tenant |
| Critical-event burst | Aggregate into one "multiple security changes" notice above the cap | Do not silently drop a critical event; preserve the audit evidence |
| Send attempts | 3 attempts with backoff, then a dead-letter record | A provider blip must not become an infinite loop |
| Provider pacing | Bounded sequential/limited concurrency | Respect Brevo's free-tier limits |

A suppressed notification is recorded with its reason. The underlying security action is never
rolled back because mail failed.

## 7. Delivery and failure behaviour

1. The domain action commits first.
2. The notification service writes a pending delivery record (or an outbox row) with the redacted
   event and recipient role.
3. A worker/sender calls the existing mail boundary; success records the provider message id only if
   it is non-sensitive.
4. Failure is retried a bounded number of times. A permanent failure is a visible dead-letter state.
5. The action still succeeds if mail is unconfigured or unavailable. The audit/action path must not
   depend on Brevo uptime.
6. A feature flag (`TENANT_SECURITY_NOTIFICATIONS`) defaults **off**. Enabling it is a separate
   production decision after the acceptance checks pass.

The exact outbox implementation is a separate reliability item (RD-02 in the companion review); this
plan can use a simple delivery record first, but must not claim at-least-once delivery without it.

## 8. Acceptance checks

These are checks to write when implementation is approved; none is run by this plan.

### Event and recipient matrix

- [ ] A password/reset completion notifies the target and each active OWNER.
- [ ] A role change notifies the target and each active OWNER; a STAFF target is included.
- [ ] An invitation transition notifies the OWNER and does not send a duplicate invitation.
- [ ] A session-created event notifies the member; OWNER/ADMIN owners are notified; STAFF owners are
      not notified by default.
- [ ] A DISABLED or DELETED target gets no mail; no active OWNER produces a suppressed record.
- [ ] An event in tenant A never reaches tenant B, including when both have the same email domain.

### Privacy

- [ ] The rendered body contains no email address, phone number, token, `jti`, recovery code,
      product/supplier data or IP address.
- [ ] The subject contains only the fixed event label.
- [ ] Logs contain no recipient address or body.
- [ ] A payload with an attempted free-form field is rejected by the closed schema.

### Rate, dedupe and failure

- [ ] Replaying the same event within 10 minutes sends one message and records one suppression.
- [ ] The 11th message to one recipient in an hour is suppressed or aggregated, not silently lost.
- [ ] A simulated Brevo failure leaves the domain action successful and creates a bounded retry.
- [ ] Three failed attempts produce a dead-letter record; no infinite retry loop.
- [ ] The feature flag off sends nothing and writes no pending delivery.

### Operational

- [ ] A local fake mail transport captures the exact recipient list and body for inspection.
- [ ] The template is a pure function and has a fixed snapshot test.
- [ ] Notification delivery does not block a login, password reset, role change or invitation.
- [ ] The plan's open decisions are resolved before implementation starts.

## 9. Rollout order

1. **Phase 0 (this plan):** approve event names, recipients, rate limits and privacy rules.
2. **Phase 1:** credential changes, role/status changes and OWNER/ADMIN session notices with a local
   fake transport.
3. **Phase 2:** invitation/session lifecycle and optional in-app notices; resolve the device-label
   question first.
4. **Phase 3:** production feature flag, owner communication and delivery monitoring. Separate
   approval is required; no production send in this phase.

## 10. Open decisions

- Is the first release email-only, or email plus an in-app notice?
- Should staff sign-ins notify the OWNER by default, or only OWNER/ADMIN sign-ins?
- What privacy-safe device identity, if any, is acceptable for a “new device” claim?
- What retention is appropriate for delivery records?
- Which non-critical categories may be opt-out, and where is that preference stored?
- Should the OWNER receive a daily digest instead of individual notices for high-volume events?

## 11. Free-cost statement

The plan uses the existing Brevo integration, existing MongoDB records, existing session/audit data
and repository documentation. It introduces no paid plan, domain, SMS service, pager or third-party
identity product. If a proposed path requires a paid tier, it is out of scope.

## 12. Related records

- [`PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md`](PLATFORM_SECURITY_IMPROVEMENTS_BEYOND_IA45.md) - TS-01 row.
- [06 — Security monitoring](./platform-console/06-security-monitoring.md) - platform-plane alerts.
- [`PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md`](PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md) - the
  separate two-contact platform test; this plan does not satisfy that gate.
- [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md) - deferred MFA/notifications.
