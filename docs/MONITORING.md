# Monitoring and incident runbook

**What this is.** The operator's view of a running Inventory AI server: what the process publishes,
what it writes to the log, what to alert on, and what to do when a signal turns red. It covers the
API and the assistant; it does not replace the hosting dashboard, the database console or the
provider's own status page.

**Who reads it.** Whoever is on call. Every command and field below is read-only. Nothing here
prints a secret, a token, a prompt, an answer, a tenant id or a member's identity.

---

## 1. The health endpoints

| Endpoint | Answers | Status | Database |
| --- | --- | --- | --- |
| `GET /api/health` | Which process is answering, in which posture, with what response counters | Always `200` while the process is up | Reported, not required |
| `GET /api/health/live` | Is the process alive? | Always `200` | Never consulted |
| `GET /api/health/ready` | Can MongoDB be reached right now? | `200` ready, `503` not ready | Checked |
| Backup freshness | `GET /api/health/backup` | Was a verified off-machine backup made recently? | `200` fresh, `503` stale/missing/unreadable | Read (`backup_runs`) |

`GET /health` and `GET /ready` are backward-compatible aliases of the two `api` paths. They run
the **same handlers** and return the same bodies and status codes; they are not a second
implementation. There is deliberately no bare `/health/live` alias, so the compatibility surface is
exactly the two paths older monitors may already use. New monitoring should prefer the canonical
`/api/health*` paths. A readiness `503` on either path is counted as a server error; a stale
`/api/health/integrity` `503` remains monitoring-only.

`GET /api/health` also carries the build identity and the OPS-2 pulse:

```json
{
  "status": "ok",
  "db": "connected",
  "environment": "production",
  "commit": "<deployed commit>",
  "uptimeSeconds": 1234,
  "counters": {
    "uptimeSeconds": 1234,
    "responses": 1902,
    "byStatusClass": { "2xx": 1850, "3xx": 0, "4xx": 50, "5xx": 2, "other": 0 },
    "serverErrors": 2,
    "lastServerErrorAt": "2026-11-11T08:12:03.114Z"
  },
  "exchangeRates": {
    "status": "available",
    "requests": 12,
    "cacheHits": 7,
    "negativeCacheHits": 2,
    "coalescedRequests": 3,
    "verified": 4,
    "sameCurrency": 1,
    "stale": 0,
    "unavailable": 0,
    "lastVerifiedAt": "2026-11-11T08:15:00.000Z",
    "lastRateDate": "2026-11-10",
    "lastFailureAt": null,
    "lastFailure": null
  },
  "timestamp": "2026-11-11T08:20:00.000Z"
}
```

`exchangeRates` is the existing process-local `exchangeRateAvailability()` snapshot. It is
informational only: `/api/health/ready` and `/api/health/live` do not read it, and a stale or missing
ECB rate never becomes a guessed conversion. Its `status` is `unused`, `available`, `degraded` or
`unavailable`. `negativeCacheHits` counts lookups suppressed by the bounded failure cache, and
`coalescedRequests` counts callers that joined one in-flight provider request. It carries aggregate
counts and timestamps, not a pair, a URL, tenant data or a provider body. It resets on restart, like
the response counters.

Every response also carries `X-Instance-ID`, the per-boot identity the port guard uses. It is not a
credential and it changes on restart. It is how a stale process on the same port is detected.

**What is deliberately not published:** paths, request ids, user or tenant identifiers, durations,
error messages, integration configuration and credentials. Findings stay in the logs, behind the
hosting account.

**Monitoring-only 5xx.** `GET /api/health/integrity` answers `503` when the laptop heartbeat is
missing or stale. That is a monitoring state, not an API failure: the response is still counted in
`responses` and `byStatusClass['5xx']`, but it is excluded from `serverErrors` and
`lastServerErrorAt`, so a stopped laptop audit cannot look like a server incident in the OPS-2 pulse.
`/api/health/ready` is deliberately **not** excluded — a readiness `503` means the API cannot reach
MongoDB, which is a real availability failure. Durable `ops_error_events` is written by the error
handler, so a database-down readiness `503` cannot be stored while the database is unreachable; the
health endpoint is the signal for that case.

### Offsite backup freshness — `GET /api/health/backup`

`GET /api/health/backup` answers the one question the other probes cannot: **was a restorable,
off-machine backup actually made?** `/ready` proves the API can reach MongoDB right now and
`/integrity` proves the laptop audit ran; neither can see last night's encrypted archive. The
scheduled backup runs on GitHub's runners, so no process on the API host can inspect the file. This
endpoint reads the durable `backup_runs` collection the runner writes and turns that history into one
verdict.

It is public for the same reason as the other health probes: an uptime monitor must be able to poll
it without a token. It publishes the verdict, the newest verified archive's name and digest, its age
and the threshold in force — never a credential, connection string, passphrase, private key or tenant
value. The response is `Cache-Control: no-store`.

```json
{
  "state": "fresh",
  "fresh": true,
  "lastVerifiedAt": "2026-11-27T18:24:23.114Z",
  "ageHours": 0,
  "maxAgeHours": 30,
  "archive": "inventoryai_prod_db-20261127T182351Z.tar.gz.gpg",
  "sha256": "<64 lowercase hexadecimal characters>",
  "lastOutcome": "SUCCESS",
  "lastOutcomeAt": "2026-11-27T18:24:23.114Z",
  "detail": null,
  "scheduledAttested": false,
  "attestationReason": "no provenance was recorded for this run — the SCHEDULED label is unproved",
  "attestedAt": "2026-11-27T19:00:11.402Z",
  "scheduledRunId": "c23524d5-010d-44a9-b56d-136d22edbd18",
  "timestamp": "2026-11-27T18:24:43.295Z"
}
```

| Field | Meaning |
| --- | --- |
| `state` | `fresh`, `stale`, `missing` or `unreadable` |
| `fresh` | The boolean verdict a monitor should treat as health; `true` only for `fresh` |
| `lastVerifiedAt` | `finishedAt` of the newest run that qualifies as a verified backup, `null` otherwise |
| `ageHours` | Age of that run in hours to one decimal, `null` when it has no parsable time |
| `maxAgeHours` | The threshold that was applied to this verdict |
| `archive`, `sha256` | The qualifying archive's file name and digest, `null` when none qualifies |
| `lastOutcome`, `lastOutcomeAt` | The newest run of any kind, so a failing backup is visible even when an older archive is still fresh |
| `detail` | One sentence naming why the verdict is not `fresh` |
| `scheduledAttested` | Whether the newest run that **claims** `SCHEDULED` can be proved to be this repository's GitHub schedule (`backup-daily.yml` on `refs/heads/main`, `event: schedule`, numeric run id, 40-character SHA, Linux runner). Independent of `fresh`: a manual recovery run satisfies `fresh` but cannot attest the schedule |
| `attestationReason` | Why the claim is not attested, or `null` when it is. Every row written before provenance was captured reads `no provenance was recorded …` |
| `attestedAt`, `scheduledRunId` | When that claiming run finished, and its id — so the operator knows which execution was judged |

**HTTP 200** means `state: "fresh"`: the newest qualifying run is inside the threshold. **HTTP 503**
means the opposite, and the body separates the cases — `stale` (a verified archive exists but is
older than the threshold), `missing` (no run has ever recorded a verified archive, including a
history of runs that were `copied` locally, failed, or never written), and `unreadable` (the run
history could not be read at all). Unlike the integrity probe, a `503` here is **not** excluded from
`serverErrors`: a deployment with no recoverable backup is an operational failure, not a state
report.

**The threshold is 30 hours.** `BACKUP_MAX_AGE_HOURS` overrides it; the default
(`DEFAULT_BACKUP_MAX_AGE_HOURS`) is one daily schedule plus slack, so one late or skipped run alarms
and a runner that stops altogether alarms as soon as the newest verified archive ages out. A
non-positive or non-numeric value falls back to `30` rather than disabling the check.

**What counts as a backup.** Not a `SUCCESS` row on its own, and not an uploaded file on its own. A
run qualifies only when it carries all of: `outcome: "SUCCESS"`, `offsite: "verified"`, a non-empty
archive file name, a 64-character lowercase hexadecimal SHA-256, and a parsable `finishedAt`. The
runner sets `offsite: "verified"` only after re-downloading the archive from Google Drive and matching
its digest to the sidecar, so a run that encrypted and uploaded but could not prove the bytes stays
`copied` and never satisfies this probe. Runs that finished without a parsable timestamp fail closed.
The endpoint reads the **20 newest** rows, so a fresh verified run can never be masked by older
history.

**Why it depends on the database.** `backup_runs` is the only durable evidence of a backup once the
job's log has rotated. The runner writes a start row and updates it with the result; those writes are
deliberately best-effort, because an unreachable database must never prevent an archive from being
made. The consequence is stated rather than hidden: if the backup user lacks `insert` and `update` on
`backup_runs`, every run still produces a verified archive but leaves no record, and this endpoint
reports `missing`. That is exactly what it did on 2026-11-27 until the collection-scoped
`backupRunWriter` role was granted; the `SUCCESS` / `offsite: "copied"` run from 07:46Z that day
correctly answered **503 `missing`**, and the first verified run at 18:24Z answered **200 `fresh`**
with `ageHours: 0`.

## 1b. The Platform Operations console

The owner/support console is served by the API at **`/platform`**; production is
`https://ai-inventory-l1mi.onrender.com/platform` on commit `74e4b87` (the repository also keeps the
standalone `npm run platform-console` listener for isolated development). It is a static shell only;
every panel reads `/api/platform/*`, which requires a separate platform administrator session and
capability. A tenant login, tenant token or business role cannot open it. The shell has a strict CSP
with `connect-src 'self'`; the session is an HttpOnly, Secure, SameSite=Strict cookie scoped to
`/api/platform`, and each request carries a double-submit CSRF header. Cookie requests are accepted
only from the configured console origin, except a same-origin GET, which browsers send without
`Origin`; that case additionally requires `X-Platform-Console: 1` and `Sec-Fetch-Site: same-origin`.

The console groups its read-only and operational views as follows:

| View | Source | Operator use |
| --- | --- | --- |
| Overview | `GET /api/platform/operations?days=7` | Business/account counts, AI volume and success, open tickets, 5xx and provider-reported AI cost |
| Live status | `GET /api/platform/status` | Health-only process/build view; available to `platform.health.read` |
| Infrastructure & API | operations + `/status` | Process uptime/RSS/CPU, MongoDB state and `dbStats`, configured integrations and explicit unavailable sources |
| AI operations | operations | Model, outcome, token, latency and cost breakdowns from `ai_turn_metrics`; no prompt or answer body |
| Database & storage | operations | Read-only database size/collection/object counts; no Atlas cluster or backup telemetry |
| Mobile | operations | Honest unavailable panel; the Android app reports no crash, install or version telemetry |
| Background jobs | `/api/platform/jobs` | The four Windows Scheduled Tasks: state, trigger, next/last run, last result and the tail of each scheduler log, read from the machine that runs them. A host that is not that machine reports `unknown`, never an empty list. Enable/disable are SUPERADMIN with a step-up proof and never register a missing task; a daily reschedule writes `console-config.json` and re-runs the existing registration script |
| Integrity monitor | `/api/platform/integrity` | Database heartbeat plus the monitor's `latest.json`, `latest.md` and the last 14 `history.jsonl` runs, with NEW vs UNCHANGED findings and explicit host-file vs database provenance. Read-only |
| Readiness & outbox | `/api/platform/readiness`, `/api/platform/audit-outbox` | All six required indexes from the same cached verdict `/ready` uses, naming each failure; plus PENDING/SENDING/FAILED counts and oldest PENDING age from `audit_outbox`. Read-only: no index migration and no retry |
| Businesses / Inventory | operations | Cross-tenant counts and movement aggregates only; no tenant selector, names, emails or product ids |
| Support center | `/api/platform/tickets` | Internal ticket create, queue, status workflow, assignment and notes; tickets deliberately contain no tenant or member data |
| Errors & incidents | operations | Durable 5xx totals, codes, bounded route labels and recent events; no request body or raw message |
| Security & audit | `/api/platform/audit`, lifecycle routes | Sign-in/MFA/refusal/read events; SECURITY and SUPERADMIN only for the trail |
| Team management | `/api/platform/admins` | SUPERADMIN lifecycle: list, disable/enable, delete, remove WebAuthn key; no self-disable or last-SUPERADMIN removal |
| Deployments & releases | `/api/platform/deployments` | Boot-observed commit/environment/Node/start history; failed builds that never boot are not observable |
| Backups & restore | `/api/platform/backups` | Encrypted archives, their SHA-256 and off-machine copies, the daily schedule and the last recorded runs — read from the machine running the API, with run history from the durable `backup_runs` collection. Rescheduling and run-now are SUPERADMIN; deleting an archive also needs a step-up proof |
| System checks | `/api/platform/status` | Real configuration predicates and the list of sources that are unavailable |

**Request budget.** The whole console router answers under one limiter keyed on the client address — 120 requests a minute, `429 PLATFORM_RATE_LIMITED` beyond it. It is mounted before the routes, so the polling views and the operations that re-run a backup, reschedule a task or delete a recovery point share it. It adds to the guards rather than replacing them: a request still needs a valid admin session, the capability, and a step-up proof where the action is destructive.

**Backup failure alerts.** A `FAILED` backup run, and a run still `RUNNING` after two hours
(`INTERRUPTED`), sends one email to `BACKUP_ALERT_EMAIL` through the mail provider in §4 — the same
boundary and the same operator-only convention as `AI_HEALTH_ALERT_EMAIL`. The message carries the
`runId`, trigger, start/finish, archive name/size, off-machine result and the runner's failure text;
never a passphrase, key or archive content. It is sent by the runner (`scripts/backup-daily.mjs` →
`scripts/backup/alerts.mjs`) after the durable row is written, and every failure in the alert path
is swallowed: the backup's exit status and the row are unaffected. One alert per run is enforced by
an atomic claim on `backup_runs.alert.sentAt`. An `INTERRUPTED` alert is raised by the *next* run,
because the process that would have written the result is gone — so a host that stops running
backups altogether is still only visible through the external probes below.

**Alerting.** The console is an investigation surface, not a pager. The external UptimeRobot and
GitHub probes in §2 remain the automatic alert path. Alert on repeated `/api/health/ready` failure,
two or more new `5xx` responses, a missing production posture, or a failed platform login/MFA burst
that the audit trail records. The proposed platform-specific alert catalogue, thresholds, role
owners and response playbooks are in
06 — Security monitoring; they are planning
only and are not an active pipeline. The process-local counters reset on restart; durable `ops_error_events`
survive a restart and are what the overview's 5xx counts use for the selected window.

**Limits.** The console cannot show host CPU/memory pressure, Atlas cluster metrics or Atlas
backup/PITR status, mobile crash/install telemetry or background-job health because those sources are
not available to this service. Those panels say so. The Backups view reports the archive files and
scheduler of the machine running the API; a deployed instance has neither, and it says so instead of
inventing history. Run history is durable (`backup_runs`), so it survives scheduler-log rotation; a
run still marked `RUNNING` after two hours is shown as `INTERRUPTED`, not as a success, and a run
that could not reach the database leaves the log as its only record. AI cost is provider-reported only and unknown charges are not
estimated. Deployment history begins when the console is enabled; a failed build before process boot
is absent by design. See [04 — Production readiness](./platform-console/04-production-readiness.md) for
the edge, credential and residual-risk gates, and
05 — Access layer for the access-layer
evaluation.

---

## 2. What to alert on

These are the rules worth waking someone for. They are written for an outside uptime watcher
(UptimeRobot, Better Stack, a scheduled `curl`, or the hosting provider's own check). Production is
now watched by **UptimeRobot** with two five-minute monitors: readiness requires
`/api/health/ready` to return `200`, and the health keyword monitor alerts when `"db":"connected"` is
absent from `/api/health`. Both were **Up** after creation, and UptimeRobot accepted a test alert to
the account's email contact. The repository also ships a GitHub-hosted probe:
`.github/workflows/production-health-watch-v2.yml` runs the read-only
`scripts/check-production-health.mjs`; GitHub still has not emitted a `schedule` event, so its manual
dispatch and the GitHub issue path remain a fallback. The Windows task is disabled.

| Signal | Rule | Why it matters |
| --- | --- | --- |
| Readiness | `/api/health/ready` returns `503` twice, 20 s apart | The API cannot reach MongoDB, or one of the six required indexes is missing/incorrect; either way the process must not take traffic |
| Server errors | `counters.serverErrors` increases by 2 or more within 5 minutes | Two consecutive 5xx answers are a failure, not a blip; the monitoring-only integrity `503` is excluded |
| Posture | `environment` is not `production` on the production host | A deployment booted into the wrong posture and is probably using the wrong database |
| Build | `commit` is not the commit that was merged | A stale build or a failed deploy is serving traffic |
| AI failures | `failedTurns / turns > 0.10` over 15 minutes, with at least 5 turns | The assistant is failing more often than it answers |
| AI latency | `p95Ms` more than twice the last 7-day p95, sustained for 15 minutes | A model or upstream has slowed down |
| AI spend | `totals.cost.providerReportedUsd` for a UTC day exceeds the agreed daily allowance | Paid fallback or research is spending faster than expected |
| AI routing | `paidTurns` rises sharply while `freeTurns` falls to zero | A free allowance is spent or a free model is unavailable |
| AI watchdog | The deployment's own watchdog email or `AI watchdog` log line names an unavailable model | The provider has marked a configured model down |

`4xx` is not an incident. A `4xx` is the API refusing something it should refuse; a `5xx` is the API
failing. The counters separate them for exactly this reason.

**Thresholds are starting points, not law.** A single-instance deployment on the free tier can cold
start after a spin-down; one slow first request is not an incident. Two consecutive `503`s on
`/ready`, or two `5xx` answers, are.

### The external watch

```sh
cd C:/Users/jeffe/inventory-ai
node scripts/check-production-health.mjs --attempts=2 --delay-ms=20000
gh workflow run production-health-watch-v2.yml
```

The script exits **0** only when `/api/health/ready` is `200` and `/api/health` is `200` with
`status: ok` and `db: connected`; it exits **1** after the configured consecutive failures and **2**
on invalid configuration. It never prints a response body, a token or a tenant value. The workflow
uses the same command, creates one issue titled `[production-health] Production endpoint is
unhealthy`, does not duplicate an already-open alert, comments and closes the issue on recovery.
The workflow can be dispatched with `ready_url` and `health_url` inputs to test the alert path without
touching production; a manual run uses the production defaults unless inputs override them. GitHub
never emitted a scheduled run for v2, and its unused schedule trigger was removed during the
2026-11-11 cleanup. UptimeRobot is the primary automatic path; use
`gh workflow run production-health-watch-v2.yml` for a controlled manual probe or issue-path test.

### Post-deployment SHA verification (read-only)

`scripts/verify-production-deploy.mjs` is the read-only release check. It polls the public
`/api/health` until the deployed `commit` matches the expected merged `main` SHA, then requires
`/api/health/ready` to be `200` with `status: ready` and `db: connected`, and `/api/health/live` to
be `200`. It never authenticates, writes, deploys or prints a response body.

```sh
cd C:/Users/jeffe/inventory-ai
node scripts/verify-production-deploy.mjs --sha="$(git rev-parse HEAD)"
gh workflow run verify-production-deploy.yml -f sha="$(git rev-parse HEAD)"
```

The workflow runs automatically on every `server/`-scoped push to `main` (including a merge
commit) and can be dispatched for a specific SHA. It uses a ten-minute polling budget and fails with a distinct
`sha_mismatch`, `health_check_failed` or `timeout` reason. Exit `0` means the expected build is
serving and ready; exit `1` is a failed verification; exit `2` is invalid configuration. A failure
does not roll back or redeploy — Render's normal deploy and the protected release workflow remain the
only deployment paths.

The 2026-11-20 check verified production `7d112cc22f66a7c871d22e2c573313df1f493427` on the first
attempt: health `200`, readiness `200`, liveness `200`, database `connected`.

### 2026-11-20 startup 5xx review

The deploy of `7d112cc` exposed one 5xx and then no further failure:

- merge committed at **18:18:21Z**; the serving process's counters began at approximately
  **18:19:01Z**;
- the only 5xx was at **18:19:18.513Z**, about 17 seconds after that start;
- by **19:24Z** the same process had served **1,031** responses — **988 `2xx`**, **34 `3xx`**,
  **8 `4xx`** and **1 `5xx`** — and `/api/health/ready`, `/api/health/live` and `/api/health` were
  all healthy.

**Classification:** this is consistent with a transient readiness/startup probe, not a genuine
startup failure. A process that failed to start would not have served the next 1,000 requests; a
readiness `503` is intentionally counted in `serverErrors`, which is the exact signature observed.
The process counter publishes only the status and timestamp, not the path, and the Render log/API was
not available to this review (no Render API token; the local CLI is blocked), so the specific request
path is **not proven**. This limitation is recorded rather than converted into a claim.

The regression coverage is `server/test/POST-DEPLOY-verification.test.mjs`: it pins the startup
signature (a readiness `503` counted while `/api/health` and `/live` remain `200`) and the alias
equivalence. No startup code was changed: making `/ready` answer `200` before the database/index
checks pass would weaken the gate, and the observed process recovered without intervention.

### Windows fallback (disabled)

UptimeRobot is the primary automatic trigger. The Windows Task Scheduler job is retained as a
manual fallback and was **disabled** on 2026-11-11T19:32:14Z, after both UptimeRobot monitors were up.
Its last run at 19:31:36Z succeeded with task result `0`; no further dispatch is scheduled while the
task is disabled.

- **Task:** `InventoryAI Production Health Watch`
- **Wrapper:** `scripts/trigger-production-health-watch.ps1`
- **Registration:** `scripts/register-production-health-scheduler.ps1`
- **Log:** `%LOCALAPPDATA%\InventoryAI\production-health-scheduler.log`
- **Prior automatic run:** 2026-11-12 01:36:35 +08:00, task result `0`; workflow run
  [`43069829375`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43069829375)
  (`workflow_dispatch`) succeeded in 14 seconds. Evidence:
  [`production-health-scheduler-2026-11-11`](evidence/production-health-scheduler-2026-11-11/README.md).

The wrapper uses the operator's existing `gh` login and stores no token. Re-enable the task only if
UptimeRobot is unavailable; `gh workflow run production-health-watch-v2.yml` remains the manual
fallback.

### Inventory integrity watch (daily, read-only)

The health monitors above answer “is the process serving?”. They cannot see a ledger row that no
longer has its inventory row. The inventory-integrity monitor answers that separate question without
modifying anything.

- **Task:** `InventoryAI Inventory Integrity Audit`, daily at **07:30 local**, `StartWhenAvailable`.
- **Wrapper:** `scripts/run-integrity-audit.ps1`; **registration:**
  `scripts/register-integrity-audit-scheduler.ps1`.
- **Command:** `node server/scripts/monitor-inventory-integrity.mjs --with-production --notify`.
- **Baseline:** `docs/evidence/inventory-integrity-monitor/baseline.json` — the 2,517 triaged seed
  findings accepted on 2026-11-15. A normal run reports `UNCHANGED / 0 new`.
- **History:** `%LOCALAPPDATA%\InventoryAI\integrity-audit\latest.json`, `latest.md` and
  `history.jsonl`; the scheduler log is `%LOCALAPPDATA%\InventoryAI\integrity-audit-scheduler.log`.
- **Hosted freshness:** after a completed run, `write-integrity-heartbeat.mjs` upserts one document in
  `integrity_monitor_heartbeats`. `GET /api/health/integrity` returns **200** only for a completed
  heartbeat at most **26 hours** old, and **503** for missing, stale, malformed or `NOT CHECKED`.
  UptimeRobot `Inventory AI integrity freshness` (id 804681164) checks it every five minutes. This
  is the only write; it touches no inventory, ledger, PO, product, location, user or baseline row.
- **Writer environment (2026-11-18):** the writer resolves `server/.env` from its own module path
  rather than the wrapper's working directory and loads it quietly; the wrapper scopes PowerShell's
  error preference around native calls, so dotenv's stderr banner cannot abort the run. The registered
  task returned `0` on 2026-11-18, wrote `checkedAt=2026-11-18T05:49:03.828Z`, and
  `/api/health/integrity` answered `200 / fresh`.
- **Alert:** one GitHub issue titled `[inventory-integrity] New findings detected`; it is updated only
  when the new set changes and closed after recovery. A NOT CHECKED run also alerts. The hosted
  freshness endpoint is the independent alert for a monitor that stops running at all.
- **Exit codes:** `0` no new finding, `1` new finding, `2` NOT CHECKED. Task Scheduler records `1`/`2`
  as a non-zero last result, but the issue is the actionable signal.

**Limits.** The trigger is a current-user Windows task, not a hosted pager: it runs only while the
operator is signed in and the laptop is awake and online. GitHub's schedule trigger has never fired
for this repository, so no workflow cron is used. The baseline accepts known candidates; it does not
repair them. The audit itself and the installed-app transfer checks are documented in
[`INVENTORY_INTEGRITY.md`](INVENTORY_INTEGRITY.md); the baseline evidence is
[`inventory-integrity-monitor`](evidence/inventory-integrity-monitor/README.md).

### Integrity operations (daily, read-only audits plus exact recovery)

The integrity monitor above checks ledger-to-inventory shape. These three commands answer the
adjacent operational questions: whether committed writes left audit gaps, whether active products
have usable price data, and whether any transfer journal or PO receive claim needs exact recovery.

- **Task:** `InventoryAI Integrity Operations`, daily at **08:00 local**, `StartWhenAvailable`,
  `MultipleInstances IgnoreNew`.
- **Wrapper:** `scripts/run-integrity-ops.ps1`; **registration:**
  `scripts/register-integrity-ops-scheduler.ps1`. The task was **not registered** in this tranche.
- **Order:** `audit:failures`, `audit:price-quality`, `recover:integrity`. Each is a separate child
  process, so one failure does not stop the next. The wrapper exits `2` if any command was NOT
  CHECKED, otherwise `1` for any finding, otherwise `0`.
- **Runner:** `cd server && npm run ops:integrity -- --command=<name> --with-production --notify`.
  `ops:integrity` never reimplements a check; it preserves the child's `0/1/2` contract. A
  failed GitHub create, comment or close is persisted as an undelivered alert and retried on the
  next `--notify` run; a recovery close retry does not repost its comment.
- **Duplicate-run prevention:** one local lock per command under
  `%LOCALAPPDATA%\InventoryAI\integrity-ops\locks`. A duplicate exits `0` and does not touch the
  history or alert. A lock older than 30 minutes — or five minutes beyond a configured longer child
  timeout — is stale and may be taken over. The task has a 60-minute execution limit. The recovery
  command is additionally guarded by the MongoDB recovery lease, so two serving instances do not
  reconcile together.
- **History:** `%LOCALAPPDATA%\InventoryAI\integrity-ops\<command>.json` and `history.jsonl`; the
  wrapper log is `%LOCALAPPDATA%\InventoryAI\integrity-ops-scheduler.log`.
- **Alert:** with `--notify`, one GitHub issue per command:
  `[integrity-ops] Audit-write failures need review`,
  `[integrity-ops] Price-data quality needs review`, and
  `[integrity-ops] Integrity recovery needs attention`. The issue is created or commented only
  when the result signature changes, and closed when the command recovers. Exit `2` is reported as
  **NOT CHECKED**, never as a data fault. Raw child output and connection strings are sanitized out.
  The issue body and each alert/recovery comment carry a stable hidden marker. Before commenting,
  the runner reads the issue body and comments; a marker already present suppresses the comment, so
  a retry whose response was lost and a second scheduler host with its own history do not post it
  twice. An unreadable issue view is kept as a pending retry rather than posted blind; two hosts
  commenting at the exact same moment can still race, and issue creation still deduplicates by title.
- **Triage view:** `cd server && npm run triage:integrity -- --with-production` lists
  `REQUIRES_ATTENTION` journals, keyed movement receipts and `inventory_transaction_quarantine` rows
  with their reasons, snapshots and ledger evidence. It is read-only and exits `1` when rows need attention; it never
  repairs or unflags anything.
- **FAILED outbox triage:** `cd server && npm run triage:audit-outbox -- --with-production` lists
  only `FAILED` audit-outbox rows whose age is at least **15 minutes** or whose attempts reach **3**
  (both configurable), scoped and bounded. It prints the event identity, attempts, age and stored
  error class, never `metadata` or user ids, and never retries or deletes. Exit `1` means at least
  one row crossed a threshold; use `--min-age-minutes`/`--min-attempts` deliberately rather than
  treating a single fresh failure as permanent.
- **Movement receipt maintenance:** the scheduled recovery pass also completes abandoned keyed
  stock-in/out/adjustment receipts from a matching ledger row or an exact `INVENTORY_WRITTEN`
  snapshot. Its counters are `movements.completed`, `movements.flagged`, `movements.blocked` and
  `movements.failed` in the recovery log/JSON; a blocked or failed count is visible to the
  `recover:integrity` alert. The separate `cd server && npm run recover:movement-receipts --
  --with-production` is a **dry run by default**; `--apply` writes only proven recovery and prunes
  `COMPLETED` receipts older than 30 days. A dry run exits `1` when it finds work, and the command
  refuses the test database.
- **Writes:** the three audits and the triage view write nothing. `recover:integrity` performs only
  the exact, quantity-anchored actions in [`INTEGRITY_RECOVERY.md`](INTEGRITY_RECOVERY.md); an
  ambiguous row is flagged `REQUIRES_ATTENTION` for a human.
- **Required-index rollout:** `npm run migrate:required-indexes` is the readiness rollout for the
  six indexes readiness checks: the transfer-operation/location, DRAFT request-key and audit dedupe
  unique guards, the 30-day `DELIVERED` outbox TTL, and the movement/PO receive audit-repair
  indexes. It is read-only by default; `--apply` refuses duplicate key groups before creating a
  unique target and never deletes documents. `npm run migrate:transfer-ledger-index` remains the
  specialized transfer duplicate-quarantine migration. Run the rollout before deploying a server
  that expects the guards. Neither command was applied in any environment here.
- **Readiness:** `/api/health/ready` requires all six exact indexes. A missing, non-unique,
  non-TTL, reordered or differently-filtered index answers `503` with a short reason; the check
  only reads `listIndexes` and never repairs an index. Rely on this during the rollout.
- **Audit outbox and repair health:** the scheduled pass records cumulative movement, PO and import
  repair plus outbox totals, and reads a bounded `auditHealth` snapshot: outbox counts and oldest
  age per status, and unmarked completed receipts per producer (imports, movements, PO receipts).
  It logs one structured line plus a `logger.error` `[audit-health]` line for each alert. A
  `FAILED` row whose `updatedAt` is older than **15 minutes**, and an unmarked completed receipt
  whose row `updatedAt` is older than **10 minutes**, alert; the snapshot does not page and repair
  totals reset when the process restarts. The focused proof is `server/test/AUDIT-HEALTH.test.mjs`, and
  the four producer boundaries are exercised by `npm run test:audit-crash` against the test database
  only.

**Limits.** The task trigger is a current-user Windows task, not a hosted pager; it runs only while
this user is signed in and the laptop is awake and online. The file lock is per machine; the
read-only audits would be harmless if two machines ran them concurrently. The recovery lease is
MongoDB-backed but time-based, so a pass that loses it may finish beside a new owner; the unique
ledger index and quantity-anchored recovery still keep inventory safe.

### Hosted scheduler: UptimeRobot

UptimeRobot provides the five-minute automatic checks. The two monitors are:

| Check | Target | Rule | Interval | State at cutover |
| --- | --- | --- | --- | --- |
| Readiness | `https://ai-inventory-l1mi.onrender.com/api/health/ready` | HTTP `200` | 5 minutes | **Up** |
| Health keyword | `https://ai-inventory-l1mi.onrender.com/api/health` | incident when `"db":"connected"` is absent | 5 minutes | **Up** |

The UptimeRobot email contact was verified during onboarding; the account inbox received both the
built-in DOWN and UP test messages. The monitor IDs are `804639237` (readiness) and `804639270`
(health keyword). On 2026-11-12 a temporary `httpbin.org/status/500` monitor produced a real DOWN
email at 03:49 and an UP email at 03:51 after it was switched to `/200`; the incident lasted 2m09s
and the temporary monitor was then deleted. Only one email destination is configured; add a second
independent contact when one is available. No credential, token or account secret is stored in the
repository. The Windows task is disabled; see above.

GitHub's scheduler never fired for the experiments. The unused dispatcher was deleted, the separate
private watch repository was archived, the TypeScript watch is weekly-only again, and v2 is
manual-dispatch-only. The evidence remains:
[`production-health-scheduler-hosted-2026-11-12`](evidence/production-health-scheduler-hosted-2026-11-12/README.md).

---

## 3. The assistant's records

Every assistant turn writes a small set of lines, all joined by one eight-character `turn=` id. The
id is also returned to the mobile client and stored on the answer as `Ref: <id>`, so a member can
quote it in a support message.

| Line | What it states |
| --- | --- |
| `AI configuration` | The configured model chain, free/paid/legacy reasoning switches and their sources, and the web-tool switches. Written once at boot. |
| `AI request` | The turn's intent, route, starting model and tier, effective reasoning and web policy, and allowed tools. Written before the first provider call. |
| `AI model call` | One provider request: provider, model, tier, the reasoning field actually sent, its source, and the turn id. |
| `AI turn` | The closing record: outcome, status, duration in ms and seconds, provider/tool time, calls, attempts, empty completions, retries, failovers, re-asks, tools, tokens, provider-reported cost, quota, web use, upstream, model, tier, route, escalations, iterations and turn id. |
| `AI degraded turn` | The AI-2 warning for an answer that was completed from a degraded path; it carries the same turn id. |

A failed or abandoned turn still writes `AI turn`. That is the point: a turn that spent money before
it died must be countable.

### The durable aggregate

Text logs are for one turn. `GET /api/ai/metrics?days=7` is for the trend:

```http
GET /api/ai/metrics?days=7
Authorization: Bearer <OWNER or ADMIN session token>
```

The route binds the `ai.metrics.view` capability, held only by OWNER and ADMIN. The scope always
comes from the authenticated business, never from the query string. `days` is optional, defaults to
`7`, and must be an integer from `1` to `90`. The response is `Cache-Control: no-store`.

The report separates **turns** from **provider calls**:

- `totals.turns`, `freeTurns`, `paidTurns`, `unknownTierTurns`
- `totals.okTurns`, `degradedTurns`, `failedTurns`
- `totals.failoverTurns`, `failovers`, `retries`, `reasks`, `emptyResponses`
- `totals.simpleEscalationTurns`, `simpleEscalations`
- `totals.latency` — `avgMs`, `medianMs`, `p95Ms`, `minMs`, `maxMs` (approximate percentile)
- `totals.cost` — `providerReportedUsd`, `reportedCostTurns`, `completeCostTurns`,
  `partialCostTurns`, `unknownCostTurns`, `complete`, `estimatedUsd` (always `null`),
  `estimatedAvailable` (always `false`)
- `daily` — one UTC bucket per day in the window, including empty days as zeros

Cost is **provider-reported only**. A missing charge stays unknown; a partial sum is labelled
partial; no estimate is fabricated. If `totals.cost.complete` is false, do not treat the figure as
the month's bill.

The full field reference is Guide 16 §10. The route's implementation and tests are
`server/src/services/ai/aiMetrics.service.ts`, `server/src/models/aiTurnMetric.model.ts` and
`server/test/AI102-ai-metrics.test.mjs`.

### The Platform Operations report

`GET /api/platform/operations?days=7` is the INTERNAL operator report for the Inventory AI owner,
support team and developers. It is a separate identity plane: a `PlatformAdmin` session with
`platform.metrics.read`, never a business OWNER/ADMIN token and never a tenant role. `days` is `1`–`30`;
the report is cross-tenant by construction and has no `businessId` parameter; the response is
`Cache-Control: no-store`. It returns aggregate counts only — no business name, member name, email,
user id, feedback note or answer.

Two durable collections feed it:

| Collection | One row means | Deliberately absent | Retention |
| --- | --- | --- | --- |
| `ops_error_events` | one 5xx response | message, stack, body, query, header, token, user id | 90 days, TTL |
| `ops_feature_usage` | one member used one feature on one UTC day | path, method, request id, resource id, IP, account name | 90 days, TTL |

The feature row is written after the response finishes; it never delays a request. Both collections
are removed with their tenant. A 5xx that happens while MongoDB is unreachable cannot be written to
MongoDB — the log line is still emitted, and durable rows resume when the database is reachable. The
feature key `operations` was removed with the tenant screen; `/api/ai/metrics` counts as `ai`.

### The dedicated console and its audit trail

The console is a separate static listener (`cd server && npm run platform-console`), loopback on
`http://localhost:4100` by default. It holds no database credential and proxies no API call. It uses
an HttpOnly `platform_session` cookie plus a readable `platform_csrf` cookie; every cookie request
must come from the exact `PLATFORM_CONSOLE_ORIGIN` and carry a matching `X-Platform-CSRF` header.
The CSP allows only same-origin scripts/styles and the configured API origin. Production requires
HTTPS and an explicitly set console/API/WebAuthn origin.

**Outer gate and forced recovery.** On the deployed same-origin console, `PLATFORM_ACCESS_KEY` puts
an HTTP Basic gate in front of `/platform` and `/api/platform`; without it production validation
refuses to boot. Bearer API clients use `X-Platform-Access-Key`. The key is shared outer-door
protection, not an administrator identity. After MFA, an administrator with no unused recovery
codes is restricted by the server to `/auth/me`, `/auth/csrf`, `/auth/recovery-codes` and
`/auth/logout`; every other route answers `403 PLATFORM_RECOVERY_SETUP_REQUIRED` and the console
shows the forced ceremony. The recovery codes are shown once and must be saved before continuing.

**Break-glass drill.** `cd server && npm run platform-admin:break-glass` resets one administrator
after the password, MFA factors and recovery codes are all lost. It requires
`PLATFORM_BREAK_GLASS_CONFIRM`, `PLATFORM_BREAK_GLASS_DB` matching the resolved database, the target
email, a password from the environment, and the production phrase
`PLATFORM_BREAK_GLASS_PROD_CONFIRM=BREAK-GLASS-PLATFORM-ADMIN`. It clears every factor and session
and writes `ADMIN_BREAK_GLASS_RESET`; the administrator must enroll MFA and generate codes again.
Run the drill against a disposable administrator in the test database, never the production owner
row.

Login is password + mandatory TOTP (or a registered WebAuthn key). A password alone never creates a
session. The TOTP secret and WebAuthn public keys are encrypted with `PLATFORM_MFA_ENCRYPTION_KEY`;
a missing key makes platform login answer `503 PLATFORM_MFA_NOT_CONFIGURED` before the password is
checked. The first login enrolls TOTP; the secret is shown once. A code is single-use.

`platform_audit_events` records who signed in, who was refused, who read the operations report, who
read the audit trail, MFA/WebAuthn changes, renewal and logout. It has **no TTL**, and its Mongoose
model refuses update/replace/delete/save-existing operations. Only SECURITY and SUPERADMIN hold
`platform.audit.read`; SUPPORT and READ_ONLY are refused and the refusal is itself recorded. The
console shows the audit tab only when the signed-in role holds that capability.

**The model guard is not a database permission.** An operator with raw database access can still
alter rows. Grant the application a role that cannot drop the collection, and export/retain the
trail per the owner's retention decision. Back up the database per the existing restore guide.

**Browser WebAuthn proof.** `cd server && npm run test:webauthn-e2e` starts the API and console,
launches the installed Chrome/Edge headless with a CDP virtual authenticator, creates a disposable
SUPERADMIN in the test database, and drives the real console through TOTP enrollment, security-key
registration and security-key sign-in. It then replays the exact successful assertion and submits a
tampered signature, requiring both to be refused and the tampered attempt to leave no session. It
refuses to run without a browser and is deliberately **not** part of `npm test`; it needs MongoDB,
the normal test environment and unused ports 4400/4100/9333 (all configurable). The administrator,
its sessions and its audit rows are removed afterwards, and the run fails if any remain. The CI
`webauthn-e2e` job runs the same command with headless Chrome and a disposable MongoDB; the manual
command remains the fallback when a runner cannot provide a browser. A successful login redirect
alone would not be evidence: the script waits for the dashboard, inspects the returned assertion,
and asserts the replay and tamper status codes.

---

## 4. Daily and weekly checks

Run these from a machine that can reach the deployment. They need no credentials unless stated.

```sh
# 1. The process is alive and the posture is right.
curl -fsS https://<host>/api/health/live
curl -fsS https://<host>/api/health/ready

# 2. Which build is serving, and are there 5xx answers?
curl -fsS https://<host>/api/health

# 3. The assistant's aggregate, with an OWNER or ADMIN session token.
#    Never paste the token into a shell history you do not control.
curl -fsS -H "Authorization: Bearer $INVENTORY_TOKEN" \
  "https://<host>/api/ai/metrics?days=7"

# 4. The INTERNAL platform report. Password login returns only an MFA
#    challenge; complete it with the enrolled TOTP code (or use the console).
#    Keep the credential, challenge and token in a local secret store, never
#    in shell history. The sequence is:
#      POST /api/platform/auth/login            -> mfaToken
#      POST /api/platform/auth/mfa/verify       -> access token
#      GET  /api/platform/operations?days=7
#    The console at http://localhost:4100 performs this flow with an HttpOnly
#    cookie and is the supported operator path.
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"email":"<platform-admin>","password":"<from-secret-store>"}' \
  "https://<host>/api/platform/auth/login"
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"mfaToken":"<from-login>","code":"<six-digit>"}' \
  "https://<host>/api/platform/auth/mfa/verify"
curl -fsS -H "Authorization: Bearer $PLATFORM_TOKEN" \
  "https://<host>/api/platform/operations?days=7"
curl -fsS -H "Authorization: Bearer $PLATFORM_TOKEN" \
  "https://<host>/api/platform/audit?limit=50"
```

Weekly, compare the newest `AI configuration` boot line with what the deployment is supposed to
send: the model chain, the free and paid reasoning switches, and the web tools. A Render environment
change that did not reach the boot log is a change that did not happen.

On the server host, the assistant's records are greppable:

```sh
# Every turn from one member's support reference.
grep "turn=<ref>" <log>

# Failures and degradations, newest last.
grep -E "AI (turn|degraded turn)" <log> | grep -v "outcome=ok"

# Which models actually answered today.
grep "AI turn" <log> | grep -oE "model=[^ ]+ tier=[^ ]+" | sort | uniq -c
```

---

| Backup freshness verdict | `server/src/services/backupFreshness.service.ts` |
| Backup run history | `server/src/services/backupRuns.service.ts`, `server/src/models/backupRun.model.ts` |
## 5. Incident procedure

1. **Name the build.** `GET /api/health` reports `commit`, `environment` and `uptimeSeconds`. If the
   commit is not the one that was merged, stop here: the deploy is the incident, and the rollback is
   in the hosting dashboard.
2. **Separate the process from the database.** `/api/health/live` answers without MongoDB.
   `/api/health/ready` answers only with it. A live process and a not-ready probe is a database or
   network incident, not an API incident.
3. **Read the pulse.** `counters.serverErrors` and `lastServerErrorAt` say whether the API is
   failing, and when it started. `byStatusClass` separates refused requests from failed ones.
4. **Read the logs by turn.** A member's `Ref:` id joins the request, every model call and the
   closing record. Start at `turn=<id>`; do not search by answer text.
5. **Check the provider.** `npm run ai:check` proves the configured model is listed; add `--probe`
   only when a real completion is justified. `npm run ai:usage -- --provider-only` reads the free
   allowance without spending a request. The deployment's watchdog covers endpoint health on its
   own schedule.
6. **Check the aggregate.** `GET /api/ai/metrics?days=1` separates a routing change (free/paid mix),
   a reliability change (failed/degraded turns) and a latency change (p95). A sudden paid-only day is
   usually an exhausted free allowance or a free model marked down, not a code change.
7. **Roll back or fix forward.** The previous deploy is in the hosting dashboard. Do not redeploy a
   build whose `/api/health` commit was never verified; the project has paid for that assumption
   twice (§27CE).
8. **Write it down.** Add a dated entry to [`DEVELOPMENT_LOG.md`](DEVELOPMENT_LOG.md) with the
   signal, the measurement, the action and what remains unverified. A record is not a success
   message; it is what the next person reads at 02:00.

---

## 6. Limits, stated rather than discovered

- **The counters are process-local.** They reset on restart and are per instance. Production runs
  one instance today; with several, a watcher polling one sees one instance's traffic. A shared
  counter needs a shared store, which this project does not have (§29, B2/E3). Do not present the
  counters as cluster-wide.
- **The exchange-rate snapshot is process-local too.** It resets on restart and is not shared across
  instances. It is an observation aid, not a readiness signal or a historical rate record.
- **The metrics endpoint is per business and per UTC day.** It is not a billing export, and it does
  not see provider calls that never completed a turn.
- **The platform report is cross-tenant and aggregate-only.** `ops_error_events` covers 5xx
  responses, not 4xx refusals; `ops_feature_usage` is presence, not a request count. Neither claims
  to be a full activity log. A 5xx before authentication has no business id: it is counted in the
  platform total but not as an affected tenant. There is no tenant-detail read, no feedback inbox
  and no PII in this report; those need a separately approved support-access design.
- **A database-down 5xx cannot be stored in that database.** The response and log still occur; the
  durable event resumes only once MongoDB is reachable. Do not read an empty durable list as proof
  that no database outage happened.
- **Feature presence is eventual.** It is written after `finish`; a report requested at the same
  instant as another request may not yet count that request's feature row.
- **Cost is provider-reported.** Free-model turns report `$0.000000`; a missing report is `unknown`,
  never zero. The endpoint does not estimate.
- **Log retention is the host's.** A turn's text record can disappear before the aggregate does; the
  durable row is the reason the aggregate survives.
- **The console is internal and is not a hosted pager.** It is deployed on the API service at
  `/platform` and the platform API is an operator read, not a cluster-wide counter. The console and
  the platform audit trail are live at `74e4b87` behind the application outer gate and the separate
  platform login; PR-03 network isolation remains open. UptimeRobot's email contact
  remains the automatic delivery channel: two five-minute
  checks cover readiness and the `db: connected` keyword. The Windows fallback is disabled, and the
  GitHub workflow is a manual/fallback path. A dedicated pager or hosted dashboard is still absent;
  record the integration here if one is added.
- **`/api/health` is public.** It publishes a commit id, a posture name, counts and the aggregate
  exchange-rate availability snapshot. It never publishes a path, a tenant, a member, a duration, a
  message, a currency pair, a provider URL or a credential.
- **The SHA verifier proves the build and the current probes, not the deployment mechanism.** It
  cannot see a deploy that never started, and it does not roll back. It also cannot prove the request
  path of a past 5xx because the process pulse deliberately stores no path.

---

## 7. Where the pieces live

| Piece | File |
| --- | --- |
| Health endpoints | `server/src/routes/health.routes.ts` |
| Bare health aliases | `server/src/app.ts` (`GET /health`, `GET /ready`) |
| OPS-2 counters | `server/src/config/operationalCounters.ts` |
| Request ids and access log | `server/src/middlewares/` |
| AI turn formatters | `server/src/services/ai/aiMonitor.ts` |
| AI metrics store and aggregate | `server/src/services/ai/aiMetrics.service.ts`, `server/src/models/aiTurnMetric.model.ts` |
| AI metrics route | `server/src/routes/ai.routes.ts`, `server/src/controllers/ai.controller.ts` |
| Platform auth, MFA, audit and operations routes | `server/src/routes/platform.routes.ts`, `server/src/controllers/platformAuth.controller.ts`, `platformMfa.controller.ts`, `platformAudit.controller.ts`, `platformOperations.controller.ts` |
| Dedicated console listener and UI | `server/platform-console/server.ts`, `server/platform-console/public/` |
| Platform identity, sessions, MFA and capabilities | `server/src/models/platformAdmin.model.ts`, `server/src/models/platformAdminSession.model.ts`, `server/src/constants/platformRoles.ts`, `server/src/config/platformJwt.ts`, `server/src/config/platformSecurity.ts` |
| Platform audit | `server/src/models/platformAuditLog.model.ts`, `server/src/services/platformAudit.service.ts`, `server/src/constants/platformAudit.ts` |
| TOTP/WebAuthn/vault | `server/src/services/platformMfa/`, `server/src/services/platformMfa.service.ts`, `server/src/services/platformWebAuthn.service.ts` |
| Platform report and durable stores | `server/src/services/platformOperations.service.ts`, `server/src/services/operations.service.ts`, `server/src/models/opsErrorEvent.model.ts`, `server/src/models/opsFeatureUsage.model.ts` |
| Platform bootstrap | `server/scripts/create-platform-admin.mjs` |
| Operations error hook | `server/src/middlewares/errorHandler.ts` |
| Operations feature hook | `server/src/middlewares/featureUsage.ts` |
| Metrics DB tests | `server/test/AI102-ai-metrics.test.mjs` |
| Platform security and aggregation tests | `server/test/OPS7-platform-operations.test.mjs`, `server/test/PLAT2-platform-console.test.mjs`, `server/test/PLAT3-platform-security.test.mjs` |
| Counters tests | `server/test/OPS2-operational-counters.test.mjs` |
| Exchange-rate availability and health exposure tests | `server/test/currency-required-and-marketplace.test.mjs`, `server/test/phase07d-production-config.test.mjs` |
| External uptime probe | `scripts/check-production-health.mjs` |
| Post-deploy SHA verifier | `scripts/verify-production-deploy.mjs` |
| Post-deploy verification workflow | `.github/workflows/verify-production-deploy.yml` |
| External watch workflow | `.github/workflows/production-health-watch-v2.yml` |
| External scheduler wrapper | `scripts/trigger-production-health-watch.ps1` |
| External scheduler registration | `scripts/register-production-health-scheduler.ps1` |
| Hosted uptime monitor | UptimeRobot, two five-minute checks (monitor IDs `804639237`, `804639270`) |
| Archived scheduling experiments | Dispatcher removed; private watch repository archived; TypeScript watch weekly-only; v2 manual-only |
| Scheduler evidence | `docs/evidence/production-health-scheduler-2026-11-11/README.md` |
| Hosted scheduler evidence | `docs/evidence/production-health-scheduler-hosted-2026-11-12/README.md` |
| Inventory-integrity monitor | `server/scripts/monitor-inventory-integrity.mjs`; baseline and first run in `docs/evidence/inventory-integrity-monitor/` |
| Inventory-integrity task | `scripts/run-integrity-audit.ps1`, `scripts/register-integrity-audit-scheduler.ps1` |
| Integrity-operations runner | `server/scripts/ops-integrity.mjs`, `server/scripts/lib/ops-integrity.mjs` |
| Integrity-operations task | `scripts/run-integrity-ops.ps1`, `scripts/register-integrity-ops-scheduler.ps1` |
| Audit health snapshot | `server/src/services/auditHealth.service.ts`; logged by `recoveryScheduler.ts` |
| Crash-injection harness | `server/scripts/audit-crash-harness.mjs`; `npm run test:audit-crash` |
| Transfer-ledger migration | `server/scripts/migrate-transfer-ledger-index.mjs`, `server/src/services/transferLedgerMigration.service.ts` |
| Probe tests | `server/test/ops-production-health.test.mjs` |
| Alias and SHA-verifier tests | `server/test/POST-DEPLOY-verification.test.mjs` |
| Recorded design | `docs/DEVELOPMENT_ROADMAP.md` §27DI (the pulse), §27HU–§27HX (AI-99 through the external watch), §27IA (the integrity monitor) |
