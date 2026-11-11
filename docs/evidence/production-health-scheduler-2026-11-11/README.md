# External production-health scheduler — 2026-11-11

## Why this exists

GitHub Actions still emits no `event=schedule` run for
`.github/workflows/production-health-watch-v2.yml` on this repository. The workflow's probe and
issue path work, but without a trigger they never run. On 2026-11-12 (local), a Windows Task
Scheduler job became the independent trigger.

The workflow itself still runs on GitHub's infrastructure, outside Render. Only the trigger is on
the operator laptop. The task uses the operator's existing `gh` login; **no token is stored in the
repository or in the task.**

## Installed task

| Field | Value |
| --- | --- |
| Task name | `InventoryAI Production Health Watch` |
| Wrapper | `scripts/trigger-production-health-watch.ps1` |
| Registration | `scripts/register-production-health-scheduler.ps1` |
| Schedule | Every 5 minutes |
| First run | 2026-11-12 01:36:35 +08:00 |
| First task result | `0` |
| Next run | 2026-11-12 01:41:35 +08:00 |
| Missed runs | 0 |
| Log | `%LOCALAPPDATA%\InventoryAI\production-health-scheduler.log` |

The wrapper refuses to dispatch while a v2 run is already queued or active, so a slow run does not
create a dispatch pile-up.

## First automatic run

The Windows task started at **01:36:35** and the wrapper logged a dispatch at **01:36:41**. GitHub
accepted:

- **Workflow run:** [`43069829375`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43069829375)
- **Event:** `workflow_dispatch` (not `schedule`)
- **Created:** 2026-11-11T17:36:40Z
- **Completed:** 2026-11-11T17:36:54Z
- **Conclusion:** `success`

A manual wrapper test before task registration, run `43069607155`, also succeeded. The first wrapper
invocation actually failed with `gh run list exited 1` because its original `--jq` expression was
parsed incorrectly under PowerShell; the wrapper was changed to parse the JSON directly, then the
manual and automatic runs above succeeded. The log preserves that first error rather than hiding it.

## What this proves — and what it does not

**Proved:** the installed scheduled task fires on its five-minute schedule, invokes the wrapper with
the existing `gh` authentication, dispatches the v2 workflow, and the workflow probe completes
successfully.

**Not proved:** GitHub's own `schedule` event is still not emitted; the run event is
`workflow_dispatch`. The task is not hosted monitoring. It runs only while the operator is signed in
and the laptop is awake and online. If the laptop is asleep, signed out or offline, no check is
dispatched. There is no independent alert if the dispatch itself fails; the task log is the local
record.

A hosted scheduler with a scoped `workflow` token is the durable replacement. Do not commit that
token; add it through the hosting provider's secret store and record the integration in
`docs/MONITORING.md`.

## Register or inspect

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-production-health-scheduler.ps1
Get-ScheduledTask -TaskName 'InventoryAI Production Health Watch'
Get-ScheduledTaskInfo -TaskName 'InventoryAI Production Health Watch'
Get-Content "$env:LOCALAPPDATA\InventoryAI\production-health-scheduler.log" -Tail 20
```

## Evidence files

- [`workflow-run.json`](workflow-run.json) — the automatic run's id, event, timestamps, conclusion and URL.
- [`scheduler-info.txt`](scheduler-info.txt) — task name, last run, result, next run and missed-run count.
- [`scheduler-log.txt`](scheduler-log.txt) — the wrapper log, including the initial parse failure and both successful dispatches.
