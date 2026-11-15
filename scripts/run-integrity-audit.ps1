# Run the read-only inventory-integrity monitor and append its output to a local log.
#
# The monitor writes its own latest.json/latest.md/history.jsonl under
# %LOCALAPPDATA%\InventoryAI\integrity-audit. It uses the existing server/.env
# connection string; no credential is copied into the task or the repository.
#
# Exit codes are the monitor's contract: 0 = no new findings, 1 = new findings,
# 2 = NOT CHECKED. The task is allowed to report 1 so a new finding is visible in
# Task Scheduler; the GitHub issue is the actionable alert.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'InventoryAI'
$historyDir = Join-Path $logDir 'integrity-audit'
$logPath = Join-Path $logDir 'integrity-audit-scheduler.log'
New-Item -ItemType Directory -Force -Path $logDir, $historyDir | Out-Null

function Write-SchedulerLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line
}

try {
    Set-Location -LiteralPath $repoRoot
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { throw 'node was not found; install Node.js or fix PATH for the task' }

    Write-SchedulerLog 'starting read-only inventory integrity monitor'
    $output = & $node server/scripts/monitor-inventory-integrity.mjs `
        --with-production `
        --notify `
        --history-dir="$historyDir" 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in @($output)) { Write-SchedulerLog "$line" }

    # Publish the hosted freshness signal after every attempt. A NOT CHECKED
    # result is intentional: it makes the endpoint 503 now instead of leaving a
    # previous fresh heartbeat in place. The writer touches one operational
    # document; it never writes inventory, ledger, purchase-order or baseline data.
    $heartbeatOutput = & $node server/scripts/write-integrity-heartbeat.mjs `
        --with-production `
        --history-dir="$historyDir" 2>&1
    $heartbeatExit = $LASTEXITCODE
    foreach ($line in @($heartbeatOutput)) { Write-SchedulerLog "$line" }
    if ($heartbeatExit -ne 0) {
        Write-SchedulerLog "ERROR: heartbeat writer exited $heartbeatExit; the hosted freshness endpoint will go stale"
        if ($exitCode -eq 0) { $exitCode = 2 }
    }
    Write-SchedulerLog "finished with exit $exitCode"
    exit $exitCode
}
catch {
    Write-SchedulerLog "ERROR: $($_.Exception.Message)"
    exit 2
}