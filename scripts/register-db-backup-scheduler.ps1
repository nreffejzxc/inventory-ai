# Register the daily encrypted database backup as a current-user task.
#
# Daily at 03:00 Asia/Manila, running scripts/run-db-backup.ps1. Nothing secret is
# in the task: creation uses the GPG PUBLIC key only, and the database connection
# string comes from server/.env. That is what lets a backup run unattended —
# verification and restore still need the private key and the passphrase.
#
# The task runs with the signed-in user's token (the same model as the existing
# InventoryAI audit tasks): it needs that user's GPG keyring and PATH. It does NOT
# run while the user is signed out, and `-StartWhenAvailable` is what makes a
# missed 03:00 run happen at the next opportunity instead of silently skipping a
# day. The log line resumption is visible in
# %LOCALAPPDATA%\InventoryAI\db-backup-scheduler.log.
#
# Run from any directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-db-backup-scheduler.ps1

param(
    [string]$At = '',
    [string]$TaskName = 'InventoryAI Daily Encrypted Database Backup',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

# The console writes the schedule it manages; this is the same file the runner
# reads, so a time saved in the console is the time the task fires.
if (-not $ConfigPath) {
    $ConfigPath = $env:PLATFORM_BACKUP_CONFIG
    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $env:USERPROFILE 'inventory-ai-backups\console-config.json'
    }
}

if (-not $At) {
    $At = '03:00'
    $consoleConfig = $ConfigPath
    if (Test-Path -LiteralPath $consoleConfig) {
        try {
            $settings = Get-Content -LiteralPath $consoleConfig -Raw | ConvertFrom-Json
            if ([string]$settings.time -match '^([01]\d|2[0-3]):([0-5]\d)$') {
                $At = [string]$settings.time
            }
        }
        catch {
            Write-Warning "console-config.json could not be read; scheduling the default time."
        }
    }
}
if ($At -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') {
    throw "Invalid time '$At'; expected 24-hour HH:MM."
}

if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,120}$') {
    throw "Invalid task name '$TaskName'."
}
$taskName = $TaskName
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-db-backup.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "wrapper not found: $wrapper" }

# 03:00 Asia/Manila is UTC+8. Task Scheduler's -At is LOCAL time, so the machine
# timezone must be an exact UTC+8 zone or the task would fire at the wrong hour.
$zone = Get-TimeZone
if ($zone.BaseUtcOffset -ne [TimeSpan]::FromHours(8)) {
    throw "This machine is $($zone.Id) (UTC$($zone.BaseUtcOffset)); the backup is specified for 03:00 Asia/Manila (UTC+8). Set the machine timezone or schedule the UTC equivalent deliberately."
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$start = (Get-Date).Date.Add([TimeSpan]::Parse($At))
if ($start -le (Get-Date)) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 15)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Daily 03:00 Asia/Manila encrypted backup of inventoryai_prod_db, copied with its checksum to OneDrive; retention 14 daily / 4 weekly / 3 monthly.' `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $taskName
    State = $task.State
    StartBoundary = $task.Triggers[0].StartBoundary
    TimeZone = $zone.Id
    NextRunTime = $info.NextRunTime
    Action = $task.Actions[0].Execute + ' ' + $task.Actions[0].Arguments
} | Format-List
