# Hosted production-health watch — UptimeRobot cutover

## Outcome

**Complete.** Production is now watched by an independent UptimeRobot account with two five-minute
monitors. The Windows Task Scheduler fallback was disabled only after both monitors were up and
UptimeRobot accepted an email test alert.

| Field | Value |
| --- | --- |
| Cutover | 2026-11-11T19:32:14Z |
| UptimeRobot monitor 1 | Readiness URL `/api/health/ready`, HTTP 200, 5-minute interval, **Up** |
| UptimeRobot monitor 2 | Keyword `/api/health`, incident when `"db":"connected"` is absent, 5-minute interval, **Up** |
| Monitor IDs | `804639237` (readiness), `804639270` (health keyword) |
| Alert channel | UptimeRobot email contact; **test alert accepted** during onboarding |
| Windows task | `InventoryAI Production Health Watch`, state **Disabled** |
| Last Windows run | 2026-11-11T19:31:36Z, task result `0` |

The two monitors were both **Up** when the task was disabled. The readiness check covers an
unreachable MongoDB, and the keyword check covers a health response that no longer reports
`db: connected` even if the HTTP status is 200. The test alert exercises the delivery path; no
production outage was induced.

## What this replaces

The previous scheduler was a Windows Task Scheduler job that dispatched
`production-health-watch-v2.yml` every five minutes from the operator laptop. It has been disabled;
the task definition and wrapper remain on disk for a deliberate manual fallback. Re-enable it only if
UptimeRobot is unavailable. `gh workflow run production-health-watch-v2.yml` is the manual fallback.

## GitHub schedule attempts

GitHub never emitted an `event=schedule` run for any of these paths through 2026-11-11T19:21Z:

- v2 with the corrected `*/5` cron (PR #239, `83a9f26`)
- the token-free dispatcher (PR #240, `66b0929`)
- the separate private watch repository (`nreffejzxc/inventory-ai-health-watch`, `1d627de`)
- the guarded `*/5` dispatch added to the TypeScript watch (PR #242, `8a89a53`)

Manual runs of the first three paths succeeded; the scheduled trigger did not. UptimeRobot is the
primary path now, not these workflows. Their code remains as a manual/fallback path.

## Limits

- UptimeRobot's free plan checks every five minutes; a faster interval requires a paid plan.
- The email contact and account are external to the repository; no credential, token or email address
  is stored here.
- The Windows fallback is disabled, not deleted. Its next-run value is stale while disabled.

No credentials, tokens, account secrets, tenant data, prompts or answers are included in this record.
