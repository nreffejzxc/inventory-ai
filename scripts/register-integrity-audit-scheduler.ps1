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

param(
    [string]$At = '',
    [string]$TaskName = 'InventoryAI Inventory Integrity Audit',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

# The console writes the schedule it manages; this is the same file the other
# registration scripts read, so a time saved in the console is the time the task
# fires. Without an override the historical 07:30 is kept.
if (-not $ConfigPath) {
    $ConfigPath = $env:PLATFORM_BACKUP_CONFIG
    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $env:USERPROFILE 'inventory-ai-backups\console-config.json'
    }
}
if (-not $At) {
    $At = '07:30'
    if (Test-Path -LiteralPath $ConfigPath) {
        try {
            $settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            $stored = $settings.jobs.integrityAudit.time
            if ([string]$stored -match '^([01]\d|2[0-3]):([0-5]\d)$') { $At = [string]$stored }
        }
        catch {
            Write-Warning 'console-config.json could not be read; scheduling the default time.'
        }
    }
}
if ($At -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') { throw "Invalid time '$At'; expected 24-hour HH:MM." }
if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,120}$') { throw "Invalid task name '$TaskName'." }

$taskName = $TaskName
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-integrity-audit.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$parts = $At.Split(':')
[int]$hour = $parts[0]
[int]$minute = $parts[1]
$start = (Get-Date).Date.AddHours($hour).AddMinutes($minute)
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