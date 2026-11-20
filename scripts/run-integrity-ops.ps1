# Run the three scheduled integrity operations against production.
#
# Each command has its own lock in server/scripts/lib/ops-integrity.mjs, so a
# manual run cannot overlap the same command. The wrapper runs all three even if
# one fails, logs every line locally, and exits with the worst result:
#   2 = NOT CHECKED / runner error
#   1 = finding or row needing attention
#   0 = all clean
#
# The alert path is one GitHub issue per command. No credential is stored here:
# the child scripts read server/.env and gh uses the operator's existing login.

param(
    [switch]$NoNotify
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'InventoryAI'
$historyDir = Join-Path $logDir 'integrity-ops'
$lockDir = Join-Path $historyDir 'locks'
$logPath = Join-Path $logDir 'integrity-ops-scheduler.log'
New-Item -ItemType Directory -Force -Path $logDir, $historyDir, $lockDir | Out-Null

function Write-SchedulerLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line
}

# Native programs report failure through $LASTEXITCODE. Relax only around the
# node call so dotenv's informational stderr cannot become a PowerShell
# terminating NativeCommandError under $ErrorActionPreference = 'Stop'.
function Invoke-Node {
    param([string]$NodePath, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $NodePath @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ Output = @($output); ExitCode = $code }
}

$commands = @('audit:failures', 'audit:price-quality', 'recover:integrity')
$worst = 0

try {
    Set-Location -LiteralPath $repoRoot
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { throw 'node was not found; install Node.js or fix PATH for the task' }

    foreach ($command in $commands) {
        $arguments = @(
            'server/scripts/ops-integrity.mjs',
            "--command=$command",
            '--with-production',
            "--history-dir=$historyDir",
            "--lock-dir=$lockDir"
        )
        if (-not $NoNotify) { $arguments += '--notify' }

        Write-SchedulerLog "starting $command"
        $run = Invoke-Node -NodePath $node -Arguments $arguments
        foreach ($line in $run.Output) { Write-SchedulerLog "[$command] $line" }
        Write-SchedulerLog "[$command] exit $($run.ExitCode)"

        if ($run.ExitCode -eq 2) { $worst = 2 }
        elseif ($run.ExitCode -eq 1 -and $worst -eq 0) { $worst = 1 }
        elseif ($run.ExitCode -ne 0 -and $worst -eq 0) { $worst = 2 }
    }

    Write-SchedulerLog "finished with exit $worst"
    exit $worst
}
catch {
    Write-SchedulerLog "ERROR: $($_.Exception.Message)"
    exit 2
}
