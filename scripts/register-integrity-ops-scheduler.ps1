# Register the three integrity operations as one current-user daily task.
#
# This is a trigger only: the checks, locks, history and GitHub issue alerts
# live in server/scripts/ops-integrity.mjs and its lib. The task runs only while
# this user is signed in and the laptop is awake and online.
#
# Run from any directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-integrity-ops-scheduler.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'InventoryAI Integrity Operations'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-integrity-ops.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$start = (Get-Date).Date.AddHours(8)
if ($start -le (Get-Date)) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 60) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs audit:failures, audit:price-quality and recover:integrity with per-command locks and GitHub issue alerts.' `
    -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $taskName
    FirstRun = $start
    NextRunTime = $info.NextRunTime
    State = (Get-ScheduledTask -TaskName $taskName).State
} | Format-List
