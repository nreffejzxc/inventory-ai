# Register the three integrity operations as one current-user daily task.
#
# This is a trigger only: the checks, locks, history and GitHub issue alerts
# live in server/scripts/ops-integrity.mjs and its lib. The task runs only while
# this user is signed in and the laptop is awake and online.
#
# Run from any directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-integrity-ops-scheduler.ps1

param(
    [string]$At = '',
    [string]$TaskName = 'InventoryAI Integrity Operations',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

# The console writes the schedule it manages; without an override the historical
# 08:00 is kept.
if (-not $ConfigPath) {
    $ConfigPath = $env:PLATFORM_BACKUP_CONFIG
    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $env:USERPROFILE 'inventory-ai-backups\console-config.json'
    }
}
if (-not $At) {
    $At = '08:00'
    if (Test-Path -LiteralPath $ConfigPath) {
        try {
            $settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            $stored = $settings.jobs.integrityOps.time
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
$wrapper = Join-Path $repoRoot 'scripts\run-integrity-ops.ps1'
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
