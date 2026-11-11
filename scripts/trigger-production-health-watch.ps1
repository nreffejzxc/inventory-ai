# External scheduler trigger for production-health-watch-v2.
#
# GitHub Actions still does not emit a schedule event for the v2 workflow on this repository,
# so Windows Task Scheduler runs this wrapper every five minutes. It uses the operator's
# existing `gh` login; no token is stored in the repository or the task.
#
# The wrapper refuses to queue another dispatch while a v2 run is queued or in progress, and it
# appends a small operational log under %LOCALAPPDATA%\InventoryAI. It never prints a credential.
#
# Register with:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-production-health-scheduler.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'InventoryAI'
$logPath = Join-Path $logDir 'production-health-scheduler.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-SchedulerLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line
}

try {
    Set-Location -LiteralPath $repoRoot

    $gh = (Get-Command gh -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $gh) {
        $fallback = 'C:\Program Files\GitHub CLI\gh.exe'
        if (Test-Path -LiteralPath $fallback) { $gh = $fallback }
    }
    if (-not $gh) { throw 'gh was not found; install GitHub CLI or fix PATH for the task' }

    $jsonLines = & $gh run list --workflow production-health-watch-v2.yml --limit 20 --json status 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh run list exited $LASTEXITCODE : $($jsonLines -join ' ')"
    }
    $runs = @(($jsonLines -join "`n") | ConvertFrom-Json)
    $active = @($runs | Where-Object {
        $_.status -in @('queued', 'in_progress', 'requested', 'waiting', 'pending')
    }).Count
    if ($active -gt 0) {
        Write-SchedulerLog "skip: $active production-health-watch-v2 run(s) already queued or active"
        exit 0
    }

    & $gh workflow run production-health-watch-v2.yml
    if ($LASTEXITCODE -ne 0) { throw "gh workflow run exited $LASTEXITCODE" }
    Write-SchedulerLog 'dispatched production-health-watch-v2.yml'
    exit 0
}
catch {
    Write-SchedulerLog "ERROR: $($_.Exception.Message)"
    exit 1
}
