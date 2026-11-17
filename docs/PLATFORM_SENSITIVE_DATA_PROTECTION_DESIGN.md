# Sensitive-data protection design (NX-01)

**Status:** **DESIGN ONLY.** Nothing here authorizes code, configuration, a notification, a
deployment or a paid service.

**Reviewed:** 2026-11-17
**Basis:** the current server source and tests at `c43c5c2`; the full project conversation;
IA-22, IA-41, ISS-02, SEC-05 and NX-01 in
[`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md).
**Related:** [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) — the
RD-01 matrix and its error-code contract.

## 1. Purpose and scope

The project already has strong individual controls: the mail layer discards provider text, the AI
provider boundary uses safe error types, the request logger omits the query string, the durable
5xx store omits the message, and the mobile app writes its JWT to SecureStore. What it does not have
is **one map that proves those controls agree across every sink**, or a test that fails when a new
log line, audit field or error mapper starts carrying a value it should not.

NX-01 is that map and that enforcement design. It covers:

- credentials, tokens and keys;
- identity and contact data;
- tenant business content;
- internal operational detail that is sensitive even when it is not personal data;
- every place those values can be stored, logged, returned or copied;
- a synthetic redaction canary that proves absence, not merely intent.

It is **not** a data-loss-prevention product, a log-export project, a retention rewrite or a
replacement for IA-22 (AI retention), IA-41 (support bundle), ISS-02 (the mobile PII log) or SEC-05
(audit retention and database least privilege).

## 2. Classification

Four classes keep the rules short enough to apply.

| Class | Meaning | Examples | Default rule |
| --- | --- | --- | --- |
| **S1 — Credential** | A value that grants access or proves possession | password, legacy bcrypt hash, access JWT, session `jti`, renewal token, password-reset token, reset/verification six-digit code, code/email HMAC, pepper, Firebase ID token, MFA secret, recovery code, WebAuthn challenge, service-account private key, `JWT_SECRET`, `PLATFORM_ADMIN_JWT_SECRET`, `PLATFORM_MFA_ENCRYPTION_KEY`, `PLATFORM_ACCESS_KEY`, `OPENROUTER_API_KEY`, `BREVO_API_KEY`, MongoDB URI with credentials | Never log, never return, never store outside its designed server-side field; redact every representation |
| **S2 — Identity / contact** | Data that identifies a person or device | name, email address, Firebase uid, user id, IP address, user-agent, device label, invitation address, platform administrator email, recovery-contact details | Log only where the map explicitly approves it; mask or omit in errors, docs and evidence |
| **S3 — Tenant content** | Business data whose disclosure crosses a tenant boundary or reveals commercial information | inventory quantities and costs, prices, suppliers, purchase orders, product specifications, AI prompts/answers, feedback comments, support-ticket free text, audit metadata, exports and backups | Tenant-scoped access only; no cross-tenant logs, aggregates or evidence; no raw prompt/answer in logs |
| **S4 — Internal operational detail** | Detail useful to an attacker or embarrassing to expose, but not a credential | stack traces, absolute paths, database topology, hostnames, environment-variable names, upstream response bodies/prefixes, request ids linked to a person, feature flags and deployment internals | Server logs only where needed; never in a client response; withhold from docs unless already public |

A value can belong to more than one class. An email address in a mail-provider error is S2; the same
address inside a reset URL is part of an S1 credential. The stricter rule wins.

### 2.1 The approved-appearance rule

“Never log S1” is absolute. S2 and S4 are not absolute: an operator needs a request id, an
authenticated user id and a route to diagnose a failure, and the platform audit deliberately records
an administrator email, IP and user-agent. The design therefore keeps an **approved-appearance
list**. A value may appear only in the sink, field and purpose named there; any other appearance is a
defect, even if the same value is approved somewhere else.

| Value | Approved sink | Purpose | Limit |
| --- | --- | --- | --- |
| Authenticated tenant user id | Structured request log; error log `userId`; audit actor fields | Trace one request to one actor | No email, name or token beside it |
| Route / method | Request log; error log; ops error event; platform audit | Locate the failing surface | Path only in the request/error/ops paths; no query string |
| Request id | Request log; error log; platform audit | Correlate one request | Random, not derived from a person |
| Platform administrator email | Platform audit `actorEmail`; platform support-ticket actor fields | Accountability for a privileged action | Platform plane only; no tenant email |
| Platform administrator IP / user-agent | Platform audit `ip`, `userAgent` | Investigate a privileged session | Bounded length; no forwarding chain |
| Firebase uid | **No approved log sink**; the database linkage field only | Identity linkage | The collision logs deliberately include it as an operator identifier; this design requires an explicit decision, not an accidental default. See G1. |
| Tenant `businessId` | Ops error event; platform aggregate reads; audit scope | Tenant-scoped operations | Never paired with a person's email in a log |

This table is the review checklist for every new log field. If a field is not on it, the default is
“do not log it”.

## 3. Where sensitive values can appear

### 3.1 Persistence

| Store | S1 | S2 | S3 | Current control / gap |
| --- | --- | --- | --- | --- |
| `users` | bcrypt hash, Firebase linkage | name, email, `firebaseUid` | role, status | Password hash never selected for a response; the model's DTO is a whitelist. Validate every new projection. |
| `sessions` | JWT is not stored; `jti` and expiry are | user id, IP, user-agent, device label | — | `jti` is a server-side session name, not a bearer credential; still never log the full token. TTL and revocation are separate controls. |
| `password_reset_challenges`, `email_verification_challenges`, `password_reset_codes` | code/email HMACs, peppers, attempts, authorization HMAC | email HMAC (not the address) | — | Codes are stored hashed/HMACed, never in clear; logs must not carry the code or the address. |
| `invitations` | token hash | invited email, inviter | role | The token is returned only at creation; preview returns safe facts. Check logs and audit metadata for the raw token. |
| `audit_logs` | — | user id, actor name (populated) | `metadata` is free-form `Mixed` and is returned to OWNER/ADMIN as-is | **G3:** the model and `toPublicAudit` trust every caller to keep `metadata` secret-free. A single future `metadata: { token }` would publish it to the tenant. |
| `platform_audit_events` | — | actor email, IP, user-agent, request id | `metadata` is free-form `Mixed` | **G2:** `safeMetadata` only enforces a 4 KB size; it does not redact keys or values. `route` uses `req.originalUrl`, which includes the query string. |
| `ops_error_events` | — | optional `businessId` (not a person) | — | Strong: no message, stack, body, query, header, token, user id or raw path; ids collapse to `:id`; 90-day TTL. Keep as the reference pattern. |
| `ops_feature_usage` | — | user id, business id | feature key | Presence only; no request content. |
| `platform_support_tickets` | — | administrator emails, assignee | free-text title, description and notes | Platform-only and deliberately has no tenant id, but free text can still copy a customer's data or a credential. Add an explicit “do not paste secrets or tenant records” rule and a redaction step before any future tenant link. |
| `ai_conversations`, messages, feedback | — | user id | prompts, answers, comments | IA-22 owns retention/redaction. NX-01 adds the rule that no prompt/answer is copied into a log, audit row or support ticket. |
| Backups / exports | all classes | all classes | all classes | IA-04/IA-39/SEC-05 own the control. NX-01 requires the inventory to name the backup/export as a sink so a redaction test cannot claim “not logged” while a copy exists elsewhere. |

### 3.2 Logs and errors

| Path | What it receives | Current behaviour | Design requirement |
| --- | --- | --- | --- |
| `middlewares/httpLogger.ts` | request id, method, `req.path`, status, user id, duration | **Good.** Path captured at entry; no query, headers or body. | Keep. Add a canary proving `?token=…` never appears. |
| `middlewares/errorHandler.ts` | request context, `err.message` for 5xx, fixed client body, stack only in development/test | **Partial.** Client bodies are safe and the DB branch is fixed. The generic 5xx branch logs `err.message` verbatim; a future error carrying a token or address leaks S1/S2 into the host log. | Replace raw message logging with a classified error record; log `name`/`code`/`status`/request id/route, and a message only for an allowlisted error class. |
| `config/db.ts` | connection state, sanitized DB error | **Good for URIs.** `safeErrorDetail` strips `mongodb://` and `mongodb+srv://`; `sanitizeMongoMessage` is used by the 503 branch. It does not redact other credential shapes. | Keep the URI rule; route through the shared classifier when one exists. |
| `utils/logger.ts` | every explicit field a caller passes | **No redaction by construction.** It serializes fields; safety depends on each caller. | Add one `redactForLog` boundary and require callers to pass event/field allowlists. |
| `services/mail/*` | none | **Good.** The layer logs nothing, and errors carry safe facts only. | Keep; canary the caller logs that receive the error. |
| `services/ai/providers/http.ts` | status, content type, length, `location`, sanitized body prefix | **Partial.** Bounded prefix and a `SECRET_LIKE` regex (`sk-`, `bearer`, `eyJ`, `mongodb`, `api_key`, `token`, `authorization`); the regex is not exhaustive and a short email/code/URL can survive. | Default to metadata only; make any body prefix a local diagnostic opt-in, or withhold the whole prefix on a broader detector. |
| `services/ai/*` | tool name, model id, error message | **Mixed.** Safe for normal provider errors; `tools.ts` logs `err.message`, and several AI service branches log raw errors. | Same classified-error rule as the global handler. Never include prompt text or tool results. |
| `services/firebaseAuth.service.ts`, `services/firebaseLink.service.ts` | collision/refusal reason | **G1.** Both log the **Firebase uid** (and link conflicts also log `businessId`) in the message. The code comments explicitly justify the uid as an operator identifier, not a credential; the design classifies it as S2 and requires an explicit approved-appearance decision. | Keep the event and reason; either record the uid/business id as an approved appearance with purpose, access and retention, or replace them with a non-reversible correlation value. |
| `controllers/passwordReset*.ts`, `emailVerification*`, `firebaseAuth*` | event type, safe reason | **Mostly good.** No code, address or token in the normal paths; the reset path deliberately omits the account. | Add these paths to the canary matrix; do not regress the `reason` allowlists. |
| `services/operations.service.ts` | 5xx event fields | **Good.** Message/stack/body/query are absent; route is normalized. | Keep. |
| `services/platformAudit.service.ts` | action, outcome, actor, email, route, request id, IP, user-agent, metadata | **G2.** `route` is `req.originalUrl` (query included); `metadata` is size-bounded only. | Use `req.path` for the route, or strip the query; allowlist metadata per action. |
| Background jobs / watchdog | model ids, endpoint statuses, counts, alert subject | **Mostly safe.** No prompts or credentials in the alert body. | Add watchdog logs to the map; never include the recipient address or a provider key. |

### 3.3 Responses and headers

| Surface | Current behaviour | Design requirement |
| --- | --- | --- |
| `/api/auth` | `Cache-Control: no-store`, `Pragma: no-cache` at the mount point | Keep; this is the model for the rest. |
| Other authenticated `/api` routes | No global cache directive; some AI/platform routes set `no-store` individually | **G6.** A compliant shared cache does **not** automatically store or reuse a response to an `Authorization`-bearing request without explicit permission in the response. The remaining risk is private/browser caching, an intermediary that ignores that rule, and a future route that moves the credential into a cookie or query where the rule differs. Explicit `no-store` is defense in depth and makes the intent testable. Add one policy at the authenticated API boundary, with explicit exceptions only for public, non-personal responses. |
| Error bodies | Fixed `DB_UNAVAILABLE`; generic `Internal Server Error`; validation fields; no stack outside development/test | Keep. The canary asserts the planted value is absent from `error`, `code`, `fields`, `applied` and `stack`. |
| DTOs | Whitelisted per feature; password hash omitted | Keep. A DTO is the only thing that may serialize a stored document. |
| Public HTML pages | `no-store`, `Referrer-Policy: no-referrer`, CSP, `X-Content-Type-Options` | Keep. Invitation/reset URLs carry S1; never weaken these headers. |

### 3.4 Outbound providers and evidence

- **Brevo** receives the recipient address and the rendered message. That is the purpose of the
  service. It must not receive a password, session token, Firebase ID token or unrelated tenant
  data.
- **OpenRouter and the upstream model provider** receive the member's prompt, the selected tool
  results and the conversation context needed to answer. That is the product. The design must state
  what is sent (inventory snippets, product names, prices, supplier names, feedback text) and must
  not add a user's email, uid, token or unrelated tenant record.
- **Support tickets and incident evidence** are S2/S3 sinks even when they live in a platform-only
  collection. A screenshot or pasted log can carry a token that the application logs never did.
- **Documentation** is a sink. No real email, phone number, uid, token, key, database URI or
  customer record belongs in a plan, checklist or evidence row. Use synthetic values and commit ids.

## 4. Findings from the code review

These are design findings, not authorizations to edit code. Severity reflects exposure if the path
is reached.

| ID | Finding | Evidence | Severity | Design response |
| --- | --- | --- | --- | --- |
| **G1** | Firebase uid (and link-conflict `businessId`) is written into structured error logs. The code deliberately includes it as an operator identifier; this is a **policy conflict** with the S2 default, not an accidental credential leak | `server/src/services/firebaseAuth.service.ts` (`firebase_identity_collision`); `server/src/services/firebaseLink.service.ts` (`firebase_identity_link_conflict`) | Medium for S2 (deliberate) | Make the appearance explicit with purpose, access and retention, or replace it with a one-way correlation value; add a canary that enforces whichever decision is made |
| **G2** | Platform audit `route` uses `originalUrl` (query included); `metadata` is arbitrary JSON with only a size bound | `server/src/services/platformAudit.service.ts` (`requestContext`, `safeMetadata`) | High for S1/S2 | Store the path, not the query; allowlist metadata by action; reject/redact unknown keys |
| **G3** | Tenant audit `metadata` is `Mixed`, written by any caller and returned to OWNER/ADMIN unchanged | `server/src/models/auditLog.model.ts`; `server/src/services/audit.service.ts` (`recordAudit`, `toPublicAudit`) | High for S1/S2/S3 | Define a per-action metadata allowlist; redact at write and at read; never publish a free-form object |
| **G4** | Several server paths log raw `err.message`; a future error can carry an address, token or tenant value | `middlewares/errorHandler.ts`; `services/inventory.service.ts`; `services/purchase-orders.service.ts`; `services/session.service.ts`; `services/platformAudit.service.ts`; `services/operations.service.ts`; `services/ai/tools.ts` | High for S1/S2 | One classified-error boundary; allowlist messages; never log arbitrary thrown values |
| **G5** | AI upstream body prefix is protected by a token-name regex, not by a complete detector | `server/src/services/ai/providers/http.ts` (`SECRET_LIKE`, `sanitizeBodyPrefix`, `logUpstreamDiagnostics`) | Medium for S1/S2 | Default to metadata only; broad detector or local-only opt-in for a prefix |
| **G6** | Only `/api/auth` has a mount-level `no-store`; other authenticated API responses rely on individual handlers. This is a defense-in-depth gap, not a claim that a compliant shared cache would store an `Authorization`-bearing response | `server/src/app.ts`; `controllers/ai.controller.ts` has local `no-store`; other routes do not | Medium for S3/S2 | One authenticated-API cache policy, tested on representative routes; document the private-cache and misconfigured-intermediary residual risk |
| **G7** | No field registry or cross-sink canary; controls are proven feature-by-feature | Existing suites cover their own boundaries; no test drives a sentinel through all sinks | High for assurance | Add the inventory and canary suite described below |
| **G8** | Platform audit intentionally stores actor email, IP and user-agent; request logs intentionally store a tenant user id | `platformAudit.service.ts`; `middlewares/httpLogger.ts`; `errorHandler.ts` | Accepted, but undocumented as an approved appearance | Put it in the approved-appearance table with retention/access limits |
| **G9** | Support-ticket free text can contain customer data or a credential | `server/src/models/platformTicket.model.ts` | Medium for S2/S3 | Explicit content rule, redaction before save, and a retention decision; no tenant link without its own scope |

The review also confirmed controls that must not be weakened:

- `ops_error_events` has no message, stack, body, query, header, token, user id or raw path; dynamic
  ids collapse to `:id`.
- `httpLogger` captures `req.path` at entry and never the query string.
- The global error handler returns fixed DB/body-parser errors, a generic 500, and a stack only when
  the environment is explicitly development or test.
- `safeErrorDetail` strips MongoDB URIs.
- The mail layer logs nothing and does not carry request content in its errors.
- AI provider errors carry safe client copy; the raw upstream body is never returned to a member.
- The mobile app stores the JWT in SecureStore (Android Keystore / iOS Keychain), not in a plain
  key-value store, and the existing PII log remediation (ISS-02) remains in force.

## 5. Redaction design

### 5.1 Log redaction and response allowlists

These are two separate controls, not two symmetric functions.

1. **Log redaction (`redactForLog`)** — a log-only boundary that takes a structured field or string
   and returns a safe representation. It is applied at the logger, the error boundary, the platform
   audit writer and the AI diagnostic writer. It never mutates the value used for business logic.

2. **Response safety (per-route DTO allowlists)** — each handler serializes only the fields its
   response schema names. There is **no generic `redactForResponse` scrubber**, and this design does
   not propose one. A generic “remove bad keys” pass can miss nested objects or fields whose names it
   does not know; the allowlist is enforced by the route that owns the response.

The distinction matters: log redaction is a boundary that can withhold a value and still be useful,
while response safety is a construction rule — a response must be correct by the fields it chooses to
serialize, not by a cleanup pass after serialization.

### 5.2 Key rules

| Key pattern (case-insensitive) | Treatment |
| --- | --- |
| `password`, `currentPassword`, `newPassword`, `confirmPassword`, `passwordHash` | `[REDACTED]`; never include length or prefix |
| `token`, `accessToken`, `idToken`, `resetToken`, `authorizationToken`, `renewalToken` | `[REDACTED]` |
| `authorization`, `cookie`, `set-cookie` | `[REDACTED]`; headers are not logged at all |
| `secret`, `apiKey`, `api_key`, `privateKey`, `private_key`, `clientSecret` | `[REDACTED]` |
| `code`, `otp`, `verificationCode`, `resetCode` | `[REDACTED]`; a generic six-digit number in a code context is a credential |
| `jti`, `sessionId`, `sid` | `[REDACTED]` or a one-way short correlation value; never the raw bearer token |
| `uid`, `firebaseUid` | Omit from logs; if correlation is essential, use a keyed one-way value, not the raw uid |
| `email`, `to`, `recipient`, `address` | Mask (`a***@example.com`) only where the map approves it; otherwise omit |
| `ip`, `userAgent`, `device` | Allowed only in the platform audit and other approved sinks; bound the length |
| `metadata`, `details`, `context`, `payload`, `body`, `query`, `headers` | Do not log the object; log an allowlisted projection |

### 5.3 Value rules

Detect and withhold regardless of the key:

- JWT-shaped strings (`eyJ…` with two dot-separated segments) and `Bearer …`;
- MongoDB URIs (`mongodb://`, `mongodb+srv://`) including user-info;
- common provider key prefixes (`sk-`, `sk-or-v1-`, `AIza`, `ghp_`, `github_pat_`, `xoxb-`,
  `xapp-`) and PEM private-key blocks;
- reset/verification URLs containing a token or code;
- email addresses in a non-approved field;
- six-digit codes in a code/reset/verification context;
- long high-entropy strings in a field that should hold an id, name or message.

The detector is a **backstop**, not the primary control. The primary control is not passing the
object to the logger in the first place. A regex that misses a new provider prefix must not be the
only reason a secret reaches a log.

### 5.4 Error handling

The safe record for an unexpected error is:

```text
type, name, code, status, requestId, method, route, userId (approved), duration, outcome
```

The message is included only when the error is an instance of an allowlisted application error
class whose constructor is known not to embed input. An unrecognised error records
`message: '[withheld: unclassified error]'`. The stack is kept only in development/test, where a
developer already has the request and the database; production records the class, code and request
id. If an operator needs more, the request id is the bridge to a local reproduction, not a reason to
copy the message into the log.

This is stricter than today's generic 5xx branch and intentionally so: the cost is a little
diagnostic convenience; the benefit is that a new thrown error cannot silently publish a secret.

### 5.5 Audit metadata

- **Tenant audit:** each `action` gets a small schema of allowed metadata keys and types. Unknown
  keys are rejected in development/test or dropped with a counter in production. Values are
  classified; an S1 key is never allowed. The read DTO applies the same schema, so historical rows
  cannot bypass it.
- **Platform audit:** same allowlist, plus `route` is `req.path` (query stripped), and `metadata` is
  built by the caller from named fields rather than accepted as an arbitrary object.
- **Support tickets:** a save-time check for S1 patterns and an operator instruction not to paste
  tenant records; no automatic tenant linkage.

### 5.6 Cache and provider boundaries

- Authenticated API responses carry `Cache-Control: no-store` (and `Pragma: no-cache` for HTTP/1.0
  intermediaries) at one boundary. Public, non-personal pages may opt out explicitly; an
  authenticated route may not.
- The AI provider request is assembled from the minimum context the turn needs. The prompt builder
  must not add email, uid, session id, API key or unrelated tenant rows. The provider body is never
  logged in full; diagnostics default to metadata only.
- Mail templates contain the minimum: the code or link, the expiry, the product name. No uid, user
  id, business id or session token.

## 6. Redaction canary

### 6.1 What it proves

A canary is a **synthetic sentinel** planted in a field that a path handles, followed by an assertion
that the sentinel is absent from every sink that must not receive it. It catches the leak that a
unit test of a mapper misses: a later `console.error`, a new audit field, a copied response object or
a diagnostic prefix.

The canary is not a scanner of production logs. It runs locally, with fake providers and a
disposable database, and it never prints a real value.

### 6.2 Sentinel format

Use a per-run random suffix so a stale log from an earlier run cannot produce a false pass:

| Field | Synthetic value |
| --- | --- |
| Email | `canary+<runId>@example.invalid` |
| Firebase uid | `canary-uid-<runId>` |
| Password | `canary-password-<runId>` |
| Access JWT | a JWT-shaped `eyJ...` sentinel signed with a test-only key, or a clearly fake three-part string |
| Reset/verification token | `canary-reset-token-<runId>` |
| Six-digit code | a fixed test-only value such as `604213`, paired with the run id in the surrounding record |
| Provider key | `sk-or-v1-canary-<runId>` |
| Mongo URI | `mongodb+srv://<redacted>@example.invalid/db`, assembled at run time with a disposable local database name; no password literal is committed |
| Tenant content | `canary-tenant-<runId>` in a product name, supplier note or feedback comment |

`example.invalid` is reserved and cannot receive mail. The values are deliberately not realistic
credentials; the point is exact-string detection, not phishing resistance.

### 6.3 Matrix

Each row exercises a path and names the sinks checked. “Response” means status, headers and body.

| ID | Path | Planted in | Sinks checked |
| --- | --- | --- | --- |
| **C1** | Authenticated request with `?token=<canary>` | query string | request log, error log, ops error event, platform audit (if reached), response |
| **C2** | Generic 500 from a route that throws an error whose message contains the email and token sentinel | thrown error | error log, response, ops error event |
| **C3** | DB-unavailable mapping | DB error containing a Mongo URI sentinel and a tenant name | error log, response, ops error event |
| **C4** | Firebase transient failure on exchange/renewal | ID token sentinel and uid sentinel | error log, response, session/audit rows created by the path |
| **C5** | Firebase terminal failure on exchange vs authenticated route | token and uid sentinels | error log, response; assert 401 vs 400 and no session loss |
| **C6** | Email-verification delivery failure | code, email, provider key sentinels | error log, response, challenge row (code must be absent/hashed), mail fake outbox (code is expected only there) |
| **C7** | Password-reset link and code requests | email, reset token/code sentinels | error log, response (must stay 202), challenge row, fake outbox |
| **C8** | Invitation delivery failure | email, token, provider key sentinels | error log, response, invitation row (withdrawn), fake outbox |
| **C9** | AI upstream 5xx/non-JSON | provider key, email, tenant sentinel in an upstream body prefix | error log, response, turn record, AI metrics |
| **C10** | Tenant audit write with a deliberately bad metadata object | token/email sentinels | `audit_logs` row, audit read DTO, error log |
| **C11** | Platform audit write with query string and bad metadata | token/email sentinels | `platform_audit_events` row, platform audit read DTO, error log |
| **C12** | Support-ticket note containing a canary credential | token sentinel | `platform_support_tickets` row, ticket list/detail response |
| **C13** | Authenticated tenant GET | tenant sentinel in a product/supplier field | response `Cache-Control`, response body; ensure no-store where required |
| **C14** | Negative control | canary deliberately written to a test log sink | the scanner must report a finding; a green run with no detection is a broken canary |

### 6.4 Capture and assertion

Prefer a **child-process capture** over monkeypatching a single logger. Start the test server with a
fake provider registry and a disposable database, drive the HTTP request, then inspect:

- the child's stdout and stderr, which catches every `console.*` path, including one added after the
  logger wrapper;
- the HTTP response status, headers and body;
- the test database collections named in the matrix;
- the fake mail outbox (for expected content, not as a prohibited sink);
- the fake AI provider's recorded request (to assert what was sent, not to print it).

A canary result is tri-state:

- **absent** — pass;
- **present only in an approved sink/field** — pass with the appearance recorded (for example, the
  tenant user id in the request log);
- **present anywhere else** — fail, with the sink and field named but the sentinel redacted in the
  report.

The test must never print the full sentinel in a failure message that itself goes to a shared log;
print a hash or the run id and the field name instead.

### 6.5 What the canary does not cover

- It does not prove a provider did not retain data; that is a contract/privacy question.
- It does not inspect the host's historical logs, Render's log retention or a production database.
- It does not replace the mobile log review (ISS-02) or the dependency/secret scans.
- It does not detect a value that is transformed beyond exact-string recognition (for example,
  base64 of a token). Add a base64/URL-decoded variant to the detector for the S1 rows.

## 7. Acceptance checks

NX-01 is complete only when all of these are true and their evidence is recorded:

- [ ] The inventory names every S1/S2/S3/S4 field, its storage, retention, access path, approved
      log appearances and prohibited sinks.
- [ ] Every log call site passes an allowlisted event or a field object; no call site passes a
      request body, query object, headers, full error object or arbitrary `metadata`.
- [ ] The global error boundary logs a classified error record, not `err.message`; an unclassified
      error's message is withheld.
- [ ] Firebase uid and link-conflict `businessId` have an explicit approved-appearance decision; if retained, their purpose, access and retention are documented, and if not, they are removed.
- [ ] Platform audit stores the path, not `originalUrl`; metadata is allowlisted by action.
- [ ] Tenant audit metadata has a per-action allowlist, and the read DTO cannot publish an unlisted
      key.
- [ ] AI upstream diagnostics default to metadata only; any body prefix is local-only or protected
      by a detector broader than the current `SECRET_LIKE` regex.
- [ ] Authenticated API responses carry `no-store` (and `Pragma: no-cache`) at one boundary;
      representative routes are tested.
- [ ] The canary matrix C1–C14 passes, and the negative control C14 fails when it should.
- [ ] No canary value appears in an HTTP response, a captured server log, an ops error event, a
      tenant audit row, a platform audit row or a support-ticket row.
- [ ] The approved appearances (tenant user id, platform actor email, IP, user-agent) are documented
      with purpose, access and retention limits.
- [ ] The design and the tests use synthetic data only; no real address, token, key, tenant record
      or private contact detail is committed.
- [ ] No production fault injection, notification, alert, deployment, database write or paid service
      is performed by this phase.

## 8. Implementation sequence (future, separately authorized)

1. **Freeze the map.** Add the inventory and approved-appearance table to the docs index; assign an
   owner to each row. No code change.
2. **Add the boundary.** Implement `redactForLog` and the classified-error record; migrate the
   global handler, the logger, platform audit and AI diagnostics. Keep response DTOs as allowlists.
3. **Fix the concrete leaks.** G1 (uid), G2 (route/metadata), G3 (tenant metadata) and G6 (cache)
   are small, testable changes and should precede the broader refactor.
4. **Build the canary.** Add C1–C14 with child-process capture and a disposable database; wire it
   into the existing focused test command, not a new service.
5. **Review and ratchet.** Add a check that a new logger call cannot pass a raw object; review the
   map with the existing 90-day cadence and after any new route, tool or provider.

Each step is a separate authorization. This document authorizes none of them.

## 9. Residual risks and decisions

| Risk | Why it remains | Decision needed |
| --- | --- | --- |
| Host log retention and access | Render's logs are outside the application; a redacted app can still write a safe line to a host with broad access | Record who can read production logs and for how long; do not add a paid log service |
| Unexpected error messages | A third-party library can throw a message containing input | Withhold unclassified messages; accept slower diagnosis in exchange for a hard boundary |
| AI provider body prefix | A bounded prefix is useful for diagnosing a provider fault | Default off in production; local-only opt-in is the safer default |
| AI prompt content | The provider must receive the prompt to answer | Document the data categories sent; IA-22 owns retention/redaction; do not add email/uid/token |
| Platform audit PII | Actor email, IP and user-agent are the accountability record | Keep, restrict access, state retention; do not add tenant data |
| Support-ticket free text | An operator can paste anything | Content rule plus save-time S1 detection; no tenant linkage without a scoped feature |
| Audit metadata | Historical rows may already contain values that would fail the new schema | Read-side allowlist first; a bounded migration/redaction decision only if evidence shows a leak |
| Mobile logs and screenshots | The app and the OS can capture a screen; the server cannot control that | ISS-02 and the mobile release checklist remain the control; the canary covers server sinks only |

## 10. Related records

- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_RD06.md) — NX-01
  and the rest of the NX tranche.
- [`PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md`](PLATFORM_NEXT_IMPROVEMENTS_BEYOND_NX07.md) — the
  follow-on NY-01–NY-06 tranche.
- [`PLATFORM_DEPENDENCY_OUTAGE_PLAN.md`](PLATFORM_DEPENDENCY_OUTAGE_PLAN.md) — RD-01 and its
  fact-checked error contract.
- [`INVENTORY_AI_FOLLOWUP_ASSESSMENT.md`](INVENTORY_AI_FOLLOWUP_ASSESSMENT.md) — IA-22, IA-41 and
  the related privacy items.
- [`PLATFORM_PRODUCTION_READINESS.md`](PLATFORM_PRODUCTION_READINESS.md) — PR-09 audit retention and
  database least privilege.
- [`MONITORING.md`](MONITORING.md) — the durable stores, their absent fields and retention.
- [`../SECURITY.md`](../SECURITY.md) — the existing security controls and reporting path.
