# Monitoring and incident runbook

**What this is.** The operator's view of a running Inventory AI server: what the process publishes,
what it writes to the log, what to alert on, and what to do when a signal turns red. It covers the
API and the assistant; it does not replace the hosting dashboard, the database console or the
provider's own status page.

**Who reads it.** Whoever is on call. Every command and field below is read-only. Nothing here
prints a secret, a token, a prompt, an answer, a tenant id or a member's identity.

---

## 1. The three health endpoints

| Endpoint | Answers | Status | Database |
| --- | --- | --- | --- |
| `GET /api/health` | Which process is answering, in which posture, with what response counters | Always `200` while the process is up | Reported, not required |
| `GET /api/health/live` | Is the process alive? | Always `200` | Never consulted |
| `GET /api/health/ready` | Can MongoDB be reached right now? | `200` ready, `503` not ready | Checked |

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
  "timestamp": "2026-11-11T08:20:00.000Z"
}
```

Every response also carries `X-Instance-ID`, the per-boot identity the port guard uses. It is not a
credential and it changes on restart. It is how a stale process on the same port is detected.

**What is deliberately not published:** paths, request ids, user or tenant identifiers, durations,
error messages, integration configuration and credentials. Findings stay in the logs, behind the
hosting account.

---

## 2. What to alert on

These are the rules worth waking someone for. They are written for an outside uptime watcher
(UptimeRobot, Better Stack, a scheduled `curl`, or the hosting provider's own check). This repository
now ships one: `.github/workflows/production-health-watch-v2.yml` runs the read-only
`scripts/check-production-health.mjs` every five minutes from GitHub, outside Render and outside the
development laptop. It opens a GitHub issue after **two consecutive failures** and closes it when
both endpoints recover. GitHub's issue notifications are the delivery channel; there is still no
hosted pager or dashboard.

| Signal | Rule | Why it matters |
| --- | --- | --- |
| Readiness | `/api/health/ready` returns `503` twice, 20 s apart | The API cannot reach MongoDB; requests will fail even though the process is alive |
| Server errors | `counters.serverErrors` increases by 2 or more within 5 minutes | Two consecutive 5xx answers are a failure, not a blip |
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
touching production; the scheduled run always uses the production defaults. If GitHub has not emitted
a scheduled run, use `gh workflow run production-health-watch-v2.yml`; the probe and issue path are
identical, so the manual dispatch is the supported fallback.

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
- **The metrics endpoint is per business and per UTC day.** It is not a billing export, and it does
  not see provider calls that never completed a turn.
- **Cost is provider-reported.** Free-model turns report `$0.000000`; a missing report is `unknown`,
  never zero. The endpoint does not estimate.
- **Log retention is the host's.** A turn's text record can disappear before the aggregate does; the
  durable row is the reason the aggregate survives.
- **No hosted pager or dashboard.** The GitHub Actions watch is the external delivery channel; it
  opens and closes a GitHub issue. Its schedule is best-effort (GitHub can delay scheduled jobs), and
  delivery follows each watcher's GitHub notification settings. A dedicated pager can replace it
  later; record the integration here rather than assuming the next person knows.
- **`/api/health` is public.** It publishes a commit id, a posture name and counts. It never
  publishes a path, a tenant, a member, a duration or a message.

---

## 7. Where the pieces live

| Piece | File |
| --- | --- |
| Health endpoints | `server/src/routes/health.routes.ts` |
| OPS-2 counters | `server/src/config/operationalCounters.ts` |
| Request ids and access log | `server/src/middlewares/` |
| AI turn formatters | `server/src/services/ai/aiMonitor.ts` |
| AI metrics store and aggregate | `server/src/services/ai/aiMetrics.service.ts`, `server/src/models/aiTurnMetric.model.ts` |
| AI metrics route | `server/src/routes/ai.routes.ts`, `server/src/controllers/ai.controller.ts` |
| Metrics DB tests | `server/test/AI102-ai-metrics.test.mjs` |
| Counters tests | `server/test/OPS2-operational-counters.test.mjs` |
| External uptime probe | `scripts/check-production-health.mjs` |
| External watch workflow | `.github/workflows/production-health-watch-v2.yml` |
| Probe tests | `server/test/ops-production-health.test.mjs` |
| Recorded design | `docs/DEVELOPMENT_ROADMAP.md` §27DI (the pulse), §27HU–§27HX (AI-99 through the external watch) |
