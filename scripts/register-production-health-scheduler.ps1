# Register the external production-health scheduler.
#
# This is the fallback for the repository's non-firing GitHub `schedule` trigger. It creates a
# current-user task that runs the wrapper every five minutes. The task runs only while this user
# is signed in; the laptop must be awake and online. Document that limitation rather than treating
# the task as a hosted pager.
#
# Run from any directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-production-health-scheduler.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'InventoryAI Production Health Watch'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\trigger-production-health-watch.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$start = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Dispatches production-health-watch-v2.yml every five minutes because the GitHub schedule is not firing.' `
    -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $taskName
    FirstRun = $start
    NextRunTime = $info.NextRunTime
    State = (Get-ScheduledTask -TaskName $taskName).State
} | Format-List
