# Register the read-only inventory-integrity audit as a current-user task.
#
# GitHub's schedule trigger has never fired for this repository, so this is an
# explicit Windows Task Scheduler trigger rather than a workflow cron. It runs
# only while this user is signed in and the laptop is awake and online. The
# monitor still records its own history and opens a GitHub issue for new
# findings; the task is the trigger, not the auditor.
#
# Run from any directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-integrity-audit-scheduler.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'InventoryAI Inventory Integrity Audit'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-integrity-audit.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$start = (Get-Date).Date.AddHours(7).AddMinutes(30)
if ($start -le (Get-Date)) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs the read-only inventory-integrity monitor daily, records local history and alerts on new findings.' `
    -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $taskName
    FirstRun = $start
    NextRunTime = $info.NextRunTime
    State = (Get-ScheduledTask -TaskName $taskName).State
} | Format-List