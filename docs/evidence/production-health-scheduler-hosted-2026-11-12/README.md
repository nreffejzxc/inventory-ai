# Hosted production-health watch — UptimeRobot cutover

## Outcome

**Complete.** Production is watched by an independent UptimeRobot account with two five-minute
monitors. The Windows Task Scheduler fallback was disabled only after both monitors were up. The
email alert channel has been verified end to end, including a real synthetic failure and recovery.

| Field | Value |
| --- | --- |
| Cutover | 2026-11-11T19:32:14Z |
| UptimeRobot monitor 1 | Readiness URL `/api/health/ready`, HTTP 200, 5-minute interval, **Up** |
| UptimeRobot monitor 2 | Keyword `/api/health`, incident when `"db":"connected"` is absent, 5-minute interval, **Up** |
| Monitor IDs | `804639237` (readiness), `804639270` (health keyword) |
| Alert channel | UptimeRobot email; built-in test and live synthetic DOWN/UP messages delivered |
| Windows task | `InventoryAI Production Health Watch`, state **Disabled** |
| Last Windows run | 2026-11-11T19:31:36Z, task result `0` |

The two monitors were both **Up** when the task was disabled. The readiness check covers an
unreachable MongoDB, and the keyword check covers a health response that no longer reports
`db: connected` even if the HTTP status is 200. No production outage was induced.

## Email delivery verified

The account inbox received UptimeRobot's built-in test pair at about 03:28 local time on
2026-11-12:

- `TEST: Monitor is DOWN`
- `TEST: Monitor is UP`

This confirms actual delivery to the destination, not merely that UptimeRobot accepted a contact.
The account has one email destination. No second independent destination is configured, so a
second contact remains a recommendation rather than a completed redundancy check.

## Controlled failure and recovery

A temporary HTTP monitor (`804639432`) was created against `https://httpbin.org/status/500` with
the same five-minute interval and email contact. This isolated monitor keeps the production
service untouched.

- **Failure proven:** the first check returned `500`, UptimeRobot opened an incident at
  `2026-11-12 03:49:23 GMT+8` (`19:49:23Z`), the monitor showed **Down**, and the inbox received
  `Monitor is DOWN: httpbin.org/status/500` at 03:49 local. The incident root cause was
  `500 Internal Server Error`.
- **Recovery proven:** at about 03:51 local (`19:51Z`) the same monitor was edited to
  `https://httpbin.org/status/200` and the dashboard showed `Monitor saved!`. Its next check
  reported **Up**; the incident lasted 2m09s, and the inbox received
  `Monitor is UP: httpbin.org/status/500` at 03:51 local.
- **Cleanup:** the temporary monitor `804639432` was deleted after the UP message. The Monitors page
  shows only `804639237` and `804639270`, both **Up**. The synthetic endpoint and monitor never
  touched or paged on the production service.

## GitHub schedule cleanup

GitHub never emitted an `event=schedule` run for any of the attempted paths through
2026-11-11T19:21Z:

- v2 with the corrected `*/5` cron (PR #239, `83a9f26`)
- the token-free dispatcher (PR #240, `66b0929`)
- the separate private watch repository (`nreffejzxc/inventory-ai-health-watch`, `1d627de`)
- the guarded `*/5` dispatch added to the TypeScript watch (PR #242, `8a89a53`)

The failed scheduling paths have now been retired while the useful manual fallback remains:

- `.github/workflows/production-health-dispatch.yml` was removed.
- `.github/workflows/typescript-7-watch.yml` is back to its weekly `17 6 * * 1` schedule; the
  five-minute dispatch job and cron were removed.
- `.github/workflows/production-health-watch-v2.yml` is manual-dispatch-only; its unused schedule
  trigger was removed.
- The private watch repository is archived, not deleted.
- `production-health-watch-v2.yml` still provides the manual health probe and GitHub issue path;
  the Windows task remains a disabled manual fallback.

The archived repository and the removed dispatcher are historical evidence. They are no longer
part of the active monitoring path.

## Post-deploy 10K gate

Production still reports commit `c3bd6924a0a83d4d147270a869fccc3ba920ee07`; no deployment has
occurred since the last 25-question gate. The approved post-deploy gate rerun is therefore still
pending. Run it against the deployed URL after the next production deployment and update
[`deployed-gate-2026-11-12`](../deployed-gate-2026-11-12/README.md) with the result.

## Limits

- UptimeRobot's free plan checks every five minutes; a faster interval requires a paid plan.
- The email contact and account are external to the repository; no credential, token, email
  address, tenant data, prompt or answer is stored here.
- The Windows fallback is disabled, not deleted. Its next-run value is stale while disabled.
- Only one alert destination is configured; adding a second independent contact requires another
  destination, not a duplicate of the same inbox.
