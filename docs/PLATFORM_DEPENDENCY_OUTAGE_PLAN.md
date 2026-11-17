# Dependency outage behaviour matrix and local drill

**Status:** **PLANNING AND LOCAL DRILL DESIGN ONLY.** No implementation, no production fault
injection, no notification, no alert activation, no DNS or deployment change and no paid service.

**Reviewed:** 2026-11-17
**Scope:** MongoDB Atlas, Firebase Admin/Auth, Brevo and the AI provider (OpenRouter).
**Related:** RD-01 in [`PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md`](PLATFORM_RELIABILITY_DOCS_IMPROVEMENTS.md).

## 1. Why this exists

The current health surface answers two narrow questions:

| Endpoint | Question | Current behaviour |
| --- | --- | --- |
| `GET /api/health` | Is the process alive, and what does it believe the database state is? | Always HTTP 200; `db` is `connected`, `connecting`, `disconnected` or similar |
| `GET /api/health/live` | Is the process alive? | Always HTTP 200; never consults MongoDB |
| `GET /api/health/ready` | Is MongoDB reachable right now? | 200 when ready; 503 otherwise |

Those are correct liveness/readiness signals. They are **not** a claim that sign-in, mail or the
assistant works. A process can be green while Firebase, Brevo or OpenRouter is unavailable. This
plan defines the product behaviour for each dependency, then a free local drill that proves the
behaviour without touching production.

IA-40 remains the separate provider-readiness probe. This plan does not add a probe; it defines what
the application does while a dependency is down.

## 2. Principles

1. **Fail closed on authority.** If a request cannot establish tenant, role or session state, it is
   refused. No in-memory authorization fallback and no cached user record.
2. **Do not claim success.** A write that did not commit, a mail that was not accepted by the
   provider, or an answer that was not produced is not reported as successful.
3. **Optional services stay optional.** A Brevo or AI outage must not stop inventory reads/writes or
   invalidate an existing session.
4. **Bounded waits.** Every dependency call has a deadline; no request retries forever.
5. **Stable, safe errors.** Clients receive an application code and fixed copy, never a driver,
   provider, token, address or upstream body.
6. **No automatic replay after recovery.** A user or operator retries explicitly unless the write
   is already covered by an idempotency contract.
7. **Health is layered.** `/ready` is a MongoDB gate; optional dependency failures are reported by
   the flow that needs them, the AI watchdog and structured logs, not by `/ready`.

## 3. Dependency outage matrix

### 3.1 MongoDB Atlas

| Question | Behaviour |
| --- | --- |
| **How it is detected** | Mongoose connection events; `/api/health` reports the driver state; `/api/health/ready` returns 503; a DB operation rejects with a driver/buffering error. |
| **At boot** | Production is fail-fast: one connect attempt bounded at 5 s, then the process exits and the platform restarts it. Development uses three attempts at 30 s; tests use one bounded attempt. A process that cannot reach the DB at boot is not a running API. |
| **After a running process loses the DB** | The process stays alive; `/live` remains 200; `/ready` becomes 503; DB-dependent requests are answered **503 `DB_UNAVAILABLE`** after the 1.5 s buffering bound, not left hanging. |
| **What still works** | `/api/health`, `/api/health/live` and static/public pages that do not read the database. Nothing that needs a user, tenant, session, inventory, audit or AI conversation can be served truthfully. |
| **What must stop** | Every read/write that needs MongoDB, including sign-in/exchange (session write), authenticated routes (user/session lookup), inventory movements, exports and AI turns. No process-local queue of writes and no optimistic "will save later" response. |
| **Recovery** | Mongoose reconnects automatically; `/ready` returns 200; a known read succeeds. Failed requests are not replayed. A retry uses the caller's existing idempotency key where one exists (stock movements and purchase-order create/receive today); otherwise the user must decide whether the action is safe to repeat. |
| **Operator action** | Confirm the provider incident, do not rotate credentials during the outage, preserve request ids, and verify `/ready` plus one authenticated read after recovery. Record whether any ambiguous write may need reconciliation. |
| **Do not do** | Do not switch to a different database, disable readiness, bypass authentication, or retry non-idempotent writes blindly. |

The ambiguous case is important: a request can commit and then lose the connection before the
response. The drill records this as **outcome unknown**, not as a success or a failure. Existing
idempotency covers the stock and purchase-order writes listed above; other writes need an explicit
retry decision (see NX-02 in the next-tranche plan).

### 3.2 Firebase Admin / Firebase Authentication

Firebase is the identity authority for new sign-ins and identity mutations. It is **not** consulted
on every ordinary authenticated request: `requireAuth` verifies the local JWT and loads the user,
session and business from MongoDB.

| Question | Behaviour |
| --- | --- |
| **How it is detected** | The verifier classifies an SDK failure. Terminal credential codes stay terminal; an unrecognised, network, timeout, quota or configuration-style failure becomes `FirebaseUnavailableError`; an unusable service account becomes `FirebaseNotConfigured`. |
| **What users see** | A new exchange, renewal, email-verification check, identity link or account deletion that needs Firebase answers **503 `FIREBASE_UNAVAILABLE`** with fixed copy. A genuinely bad token remains a terminal rejection (401 at exchange, 400 at the verification screen); a missing credential is **503 `FIREBASE_NOT_CONFIGURED`**. |
| **What still works** | An existing Inventory AI session continues to use the API normally. A Firebase outage must not sign anyone out, revoke a session or turn a valid local session into a 401. |
| **What must stop** | Creating a new Firebase-backed session, renewing through Firebase, verifying an email-verification ID token, linking an identity and deleting the Firebase identity. No fallback to password-only or another provider, and no "try the other door" path. |
| **Recovery** | Retry after the outage. The Admin app is memoized and is not rebuilt on every request. Verify one real exchange/renewal and one already-authenticated request; the two paths are different. |
| **Operator action** | Distinguish `FIREBASE_UNAVAILABLE` from `FIREBASE_NOT_CONFIGURED`. A configuration fault is not an outage; check the service account only when the code says so. Preserve the safe `reason` field, never the token. |
| **Do not do** | Do not treat a transient failure as a revoked credential, do not clear sessions, and do not log the ID token or uid. |

### 3.3 Brevo

Mail is a transport, not a source of authorization. The mail layer distinguishes
`MailNotConfigured` (operator configuration) from `MailDeliveryError` (provider unreachable,
timeout, rejection or unusable response).

| Flow | Behaviour during a Brevo outage |
| --- | --- |
| **Email-verification request** | The challenge is kept; the send is awaited; the caller receives **503 `EMAIL_VERIFICATION_MAIL_FAILED`** with fixed copy. The resend cooldown still applies. The code is never logged. |
| **Password-reset link request** | The send is detached so the response cannot reveal whether an address exists. The public response remains the same anti-enumeration **202** answer; the failure is recorded server-side without the address or account id. This is an accepted trade-off, not a delivered-email claim. |
| **Password-reset code request** | Same anti-enumeration shape as the link flow: the response does not become a delivery oracle. The failure is logged safely. |
| **Invitation** | The send is awaited; a failure propagates and the invitation row is withdrawn so an admin is not told an invitation was sent when it was not. The admin can retry after recovery. |
| **Operational alert** | The watchdog falls back to an error log when the provider or recipient is unavailable. A failed alert is still recorded, but it is not a paging guarantee. |

**What must stop:** no in-request retry loop, no second provider fallback, no console/file "provider"
that would print a reset link or code, and no log line containing the recipient, code, reset URL or
provider free-text message.

**Recovery:** a subsequent user action after the cooldown, or an admin re-invite, is the retry. Until
RD-02's outbox exists, there is no durable promise that a detached reset mail will eventually be
delivered. That limitation is stated in TS-01's plan and must not be hidden by a success message.

### 3.4 AI provider (OpenRouter)

The assistant is optional. Its outage must not affect inventory, auth or the rest of the API.

| Failure | User-visible result | Retry behaviour |
| --- | --- | --- |
| No provider/model/key configured | **503 `AI_NOT_CONFIGURED`** | Member cannot fix it; operator action |
| Upstream 5xx, refused connection or unusable body | **502 `AI_UNAVAILABLE`** | Bounded retry by the user; no unbounded loop |
| A model-specific 404/410/5xx/529 | The turn may fail over to another configured model; otherwise **502 `AI_UNAVAILABLE`** | One in-turn failover, not a retry storm |
| Network/timeout/invalid response with no model-specific status | No model failover; the availability breaker counts it | After five availability failures the model cools down (30 s, then growing to 5 min) |
| The turn exceeds its wall-clock deadline | **504 `AI_TIMEOUT`** | User may retry; the abandoned work is not silently repeated |
| The provider reports a spent allowance (402/429) | **429 `AI_QUOTA_EXCEEDED`** | No retry that spends the refusal again; the allowance is shared across models |
| The model spends its output budget | **502 `AI_OUTPUT_LIMIT`** | Ask a shorter question; the same question would spend the same budget |

**What still works:** every non-AI route and every already-authenticated session.

**What must stop:** unbounded retries, paid escalation caused by a free-tier refusal, logging the key
or raw upstream body, and reporting a provider outage as success with an empty answer. The existing
turn deadline and breaker are the bounds; the plan does not add a second retry mechanism.

**Recovery:** the breaker's half-open trial, the health watchdog and a normal user turn. A healthy
watchdog reading is not proof that a completion works; the two checks are separate.

## 4. Cross-dependency ordering

The order matters, and the drill must prove it:

1. **MongoDB first.** `requireAuth` needs MongoDB before an AI, mail or Firebase controller runs. With
   the DB down, an authenticated request is `503 DB_UNAVAILABLE` even if another dependency is also
   down. `/ready` reflects the DB only.
2. **Firebase second for new identity work.** An existing session does not need Firebase; a new
   exchange or renewal does.
3. **Brevo and AI last.** They are optional to the rest of the product. Their failures must not be
   promoted to a global "service down" claim.
4. **Health is not a dependency dashboard.** `/api/health` staying 200 during a Brevo outage is
   correct. The operator looks at the flow's error code, the AI watchdog and logs, or at RD-01's
   future matrix, not at `/ready`.

## 5. User-visible message contract

The drill asserts codes, not just prose. Fixed copy may change; these codes may not silently change
meaning:

| Code | Status | Meaning |
| --- | --- | --- |
| `DB_UNAVAILABLE` | 503 | MongoDB could not serve the request |
| `FIREBASE_UNAVAILABLE` | 503 | Firebase could not be reached to verify or mutate an identity |
| `FIREBASE_NOT_CONFIGURED` | 503 | The server has no usable Firebase credential |
| `MAIL_NOT_CONFIGURED` | 503 | Mail is disabled or misconfigured |
| `MAIL_UNAVAILABLE` | 503 where the flow can report it | Brevo could not accept the message |
| `EMAIL_VERIFICATION_MAIL_FAILED` | 503 | The verification challenge exists but its mail did not send |
| `AI_NOT_CONFIGURED` | 503 | No usable provider/model/key |
| `AI_UNAVAILABLE` | 502 | The provider failed upstream |
| `AI_TIMEOUT` | 504 | The turn outlived its deadline |
| `AI_QUOTA_EXCEEDED` | 429 | The provider allowance is spent |
| `AI_OUTPUT_LIMIT` | 502 | The model spent its output budget before answering |

No response may include a stack, a Mongo URI, a Firebase token/uid, a Brevo body, an OpenRouter key
or raw provider text.

## 6. Local drill design

### 6.1 Safety envelope

- Run only on the developer machine, against a disposable local database or the existing test
  harness. `NODE_ENV=test` or an explicit local profile; never a production URL.
- Use the repository's fake provider seams:
  `setFirebaseIdTokenVerifier`, `setFirebaseUserDeleter`, `registerProvider` for mail, and the AI
  provider registry. No live Firebase project, Brevo key or OpenRouter key is required.
- No outbound email, no real message, no real AI completion, no production fault injection.
- Use synthetic tenants and data only; do not copy production records.
- Stop immediately if a command would contact a real provider, send mail or write outside the
  disposable database.

### 6.2 Scenarios

| ID | Dependency | Local action | Expected observation |
| --- | --- | --- | --- |
| **D1** | MongoDB | Start the API against a disposable local DB, confirm `/ready` 200 and one authenticated read; stop the DB while the process stays up. | `/live` 200; `/ready` 503; a DB-backed request returns `503 DB_UNAVAILABLE` within the 1.5 s bound; no write is reported as saved. |
| **D2** | MongoDB recovery | Restart the disposable DB; poll `/ready`; retry one read and one idempotent write with the same key. | `/ready` 200; read succeeds; the idempotent write does not duplicate; an ambiguous non-idempotent write is recorded as unknown, not replayed automatically. |
| **D3** | Firebase verification | Install a fake verifier that throws `FirebaseUnavailableError`; call exchange and renewal; call an ordinary route with an already-issued session. | Exchange/renewal return `503 FIREBASE_UNAVAILABLE`; the ordinary route still succeeds; the session is not revoked. |
| **D4** | Firebase terminal/config | Fake a terminal token error, then an unconfigured verifier. | Terminal error remains a rejection (401/400 by route); configuration gives `503 FIREBASE_NOT_CONFIGURED`; the copy does not name a variable or token. |
| **D5** | Brevo verification | Register a fake mail provider that throws `MailDeliveryError`; request a verification code. | `503 EMAIL_VERIFICATION_MAIL_FAILED`; the challenge remains; the cooldown applies; logs contain no code or address. |
| **D6** | Brevo invitation/reset | Fake failure for an invitation and a reset request. | Invitation is withdrawn and the admin sees a failure; the reset response keeps its anti-enumeration shape; no reset URL/token appears in logs. |
| **D7** | AI upstream | Register a fake AI provider returning a 503, then a timeout. | 503 becomes `502 AI_UNAVAILABLE`; timeout becomes `504 AI_TIMEOUT` or the bounded provider error; no unbounded retry; non-AI routes still work. |
| **D8** | AI recovery/breaker | Feed five availability failures, then one success after the cooldown. | Breaker opens, the model is skipped, a half-open success closes it; no permanent state is written. |
| **D9** | Health semantics | With Brevo or AI unavailable but MongoDB healthy, read `/api/health` and `/ready`. | Both still report the DB honestly; the optional failure is visible in the flow response/log/watchdog, not misreported as a DB outage. |

### 6.3 Evidence record

For each scenario record:

| Field | Value |
| --- | --- |
| Date/time (UTC) | |
| Commit under test | |
| Environment | local/test only |
| Scenario ID | D1-D9 |
| Exact command or test name | |
| Expected | |
| Actual status/code | |
| Elapsed time (for the DB bound) | |
| Pass / fail / blocked | |
| Redacted log or test-output reference | |
| Follow-up defect (if any) | |

No email address, phone number, token, uid, key, database URI, tenant name or customer data belongs
in the record. Use commit ids and test names.

## 7. Acceptance checks

- [ ] The matrix names a user-visible result and a stop condition for each of the four dependencies.
- [ ] MongoDB down after boot produces `/ready` 503 and `DB_UNAVAILABLE`, not a hang or a false save.
- [ ] `/api/health` is understood as liveness, not a complete dependency claim.
- [ ] An existing session survives a Firebase outage; only new identity work is refused.
- [ ] A Firebase transient failure never revokes a session or becomes a terminal rejection.
- [ ] Brevo failures do not print a code, reset URL or recipient; the verification challenge survives.
- [ ] The reset path's anti-enumeration response is not turned into a delivery oracle.
- [ ] AI failures use the existing 502/504/429/503 contract and do not retry without bound.
- [ ] The drill uses fake seams and a disposable local database, and makes no outbound call.
- [ ] Each scenario has a redacted evidence row and a pass/fail result.
- [ ] The drill records ambiguous writes as unknown; it does not invent a replay.
- [ ] No production fault injection, notification, alert, deploy or paid service is performed.

## 8. Not in scope

- New health probes or dashboards (IA-40 and the monitoring plan own those).
- A notification outbox (RD-02) or a notification event (TS-01).
- Automatic reconciliation of ambiguous writes (NX-02 in the next-tranche plan).
- Multi-instance breaker/limiter coordination (IA-16).
- A live-provider outage drill, a production Chaos test, or any paid observability/chaos service.

## 9. Recommended follow-up

If the local drill passes, keep its evidence with the date and commit. If a scenario exposes a
mismatch between this matrix and the code, fix the documentation or open a focused defect; do not
change production behaviour under the cover of a documentation task.
