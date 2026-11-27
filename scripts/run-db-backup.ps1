# One unattended production database backup, for the Windows Scheduled Task.
#
# Creates the encrypted archive, copies it and its sidecar to OneDrive, verifies
# the copy's SHA-256 and applies 14 daily / 4 weekly / 3 monthly retention. All
# of that is server/scripts/backup-daily.mjs; this wrapper only supplies the
# environment and the log, so the task definition stays one line and the same
# command can be run by hand.
#
# No passphrase, private key or database credential is stored here: encryption
# uses the public key only, and the connection string comes from server/.env.
#
# Run by hand:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-db-backup.ps1
# Exit codes:   0 = archive created, copied and verified; anything else = failed.

param(
    [string]$ArchiveDir = 'C:\Users\jeffe\inventory-ai-backups\archives',
    [string]$CopyDir = 'C:\Users\jeffe\OneDrive\Inventory-AI-Backups',
    [string]$Recipient = '24BBDA0C3A6D6273C9A8C3B1DAA4DB67BAC14E26',
    [int]$Daily = 14,
    [int]$Weekly = 4,
    [int]$Monthly = 3
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $repoRoot 'server'
$logDir = Join-Path $env:LOCALAPPDATA 'InventoryAI'
$logPath = Join-Path $logDir 'db-backup-scheduler.log'
New-Item -ItemType Directory -Force -Path $logDir, $CopyDir | Out-Null

# A scheduled job writes to this file forever; cap it so it cannot grow without
# bound. The previous log is kept as .1 — enough to see two consecutive runs.
if ((Test-Path -LiteralPath $logPath) -and ((Get-Item -LiteralPath $logPath).Length -gt 2MB)) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
}

function Write-SchedulerLog {
    param([string]$Message)
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message"
}

# Native tools report failure through $LASTEXITCODE, and their stderr is
# diagnostic text to log. Under `$ErrorActionPreference = 'Stop'`, `2>&1` turns
# the first stderr line into a terminating NativeCommandError. Keep the strict
# preference for PowerShell cmdlets and relax it only around the node call.
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

try {
    # The console owns the schedule. When it has written a configuration file, that
    # file decides the directories, recipient and retention for this run; an
    # explicitly passed parameter still wins, so a manual invocation can override.
    $consoleConfig = $env:PLATFORM_BACKUP_CONFIG
    if (-not $consoleConfig) {
        $consoleConfig = Join-Path $env:USERPROFILE 'inventory-ai-backups\console-config.json'
    }
    if (Test-Path -LiteralPath $consoleConfig) {
        try {
            $settings = Get-Content -LiteralPath $consoleConfig -Raw | ConvertFrom-Json
            if (-not $PSBoundParameters.ContainsKey('ArchiveDir') -and $settings.archiveDir) {
                $ArchiveDir = [string]$settings.archiveDir
            }
            if (-not $PSBoundParameters.ContainsKey('CopyDir') -and $settings.copyDir) {
                $CopyDir = [string]$settings.copyDir
            }
            if (-not $PSBoundParameters.ContainsKey('Recipient') -and $settings.recipient) {
                $Recipient = [string]$settings.recipient
            }
            if ($settings.retention) {
                if (-not $PSBoundParameters.ContainsKey('Daily') -and $settings.retention.daily) {
                    $Daily = [int]$settings.retention.daily
                }
                if (-not $PSBoundParameters.ContainsKey('Weekly') -and $settings.retention.weekly) {
                    $Weekly = [int]$settings.retention.weekly
                }
                if (-not $PSBoundParameters.ContainsKey('Monthly') -and $settings.retention.monthly) {
                    $Monthly = [int]$settings.retention.monthly
                }
            }
        }
        catch {
            Write-SchedulerLog "WARNING: console-config.json could not be read ($($_.Exception.Message)); using defaults"
        }
    }

    Write-SchedulerLog "target    : $ArchiveDir -> $CopyDir (retention $Daily/$Weekly/$Monthly)"

    # The production target is named explicitly. `NODE_ENV=production` is what
    # env.ts requires before it will resolve inventoryai_prod_db at all, and
    # CONFIRM is the backup command's own confirmation phrase.
    #
    # The two BACKUP_TARGET_* variables exist only for a declared isolated run
    # (a verification against the test database). They are opt-in and explicit:
    # the default remains production, so a normal task run cannot drift onto
    # another database by inheriting a shell.
    if ($env:BACKUP_TARGET_NODE_ENV) {
        $env:NODE_ENV = $env:BACKUP_TARGET_NODE_ENV
    }
    else {
        $env:NODE_ENV = 'production'
    }
    if ($env:BACKUP_TARGET_DB_NAME) {
        $env:MONGODB_DB_NAME = $env:BACKUP_TARGET_DB_NAME
    }
    else {
        $env:MONGODB_DB_NAME = 'inventoryai_prod_db'
    }
    $env:CONFIRM = 'backup-db'

    # WHICH GPG, AND WHY IT IS PINNED. This host has two GnuPG installations and
    # they do not share a keyring: Gpg4win (2.5.x, home %APPDATA%\gnupg, NO backup
    # key) and Git-for-Windows' MSYS build (2.4.x, home C:\Users\jeffe\.gnupg,
    # where the key was created). A task inherits the machine/user PATH, which puts
    # Gpg4win first, so an unpinned run would refuse with "recipient ... is not
    # present". The MSYS build is also the one the wrapper's `C:\...` → `/c/...`
    # argument translation is written for.
    $gitBin = $null
    foreach ($candidate in @('C:\Program Files\Git\usr\bin', 'C:\Program Files (x86)\Git\usr\bin')) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'gpg.exe')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'tar.exe'))) {
            $gitBin = $candidate
            break
        }
    }
    if (-not $gitBin) {
        throw 'Git for Windows (which provides the MSYS gpg and tar this backup uses) was not found in Program Files.'
    }
    $env:PATH = "$gitBin;$env:PATH"

    # Prove the recipient key is in the keyring this gpg resolves to, before any
    # archive work. A wrong GnuPG installation must fail loudly here, not halfway
    # through a backup.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & (Join-Path $gitBin 'gpg.exe') --batch --list-keys --with-colons $Recipient 2>&1
        $keyCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($keyCode -ne 0) {
        throw "public key $Recipient is not present in the keyring gpg resolves to ($gitBin). Refusing to start."
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { throw 'node was not found; install Node.js or fix PATH for the task' }

    # WORKING DIRECTORY IS PART OF THE CONTRACT. `backup-db.mjs` loads `.env` with
    # `dotenv/config`, which reads it from the CURRENT directory — and a scheduled
    # task starts in C:\WINDOWS\system32. Run from server/ exactly as the runbook's
    # manual command does, and pass an absolute script path.
    Set-Location -LiteralPath $serverRoot
    $scriptPath = Join-Path $serverRoot 'scripts\backup-daily.mjs'
    if (-not (Test-Path -LiteralPath (Join-Path $serverRoot '.env'))) {
        throw "server\.env not found at $serverRoot; the database connection string is read from it"
    }

    Write-SchedulerLog "starting encrypted production backup (task run)"
    $nodeArgs = @(
        $scriptPath,
        "--out=$ArchiveDir",
        "--copy-to=$CopyDir",
        "--recipient=$Recipient",
        "--daily=$Daily",
        "--weekly=$Weekly",
        "--monthly=$Monthly"
    )
    # The trigger is stated, never guessed. The console sets CONSOLE before it starts
    # this wrapper; a locally scheduled run is MANUAL, NOT SCHEDULED. `SCHEDULED` names
    # the GitHub Actions schedule specifically — the only execution the server can
    # attest (`attestScheduledRun`). A task run cannot be attested, and while it claimed
    # SCHEDULED it also shadowed the genuine GitHub run in `/api/health/backup`, because
    # the newest SCHEDULED claim is the one judged. It still backs up the database; it
    # just no longer makes a claim it cannot prove.
    if ($env:BACKUP_TRIGGER) {
        $nodeArgs += "--trigger=$($env:BACKUP_TRIGGER)"
    }
    else {
        $nodeArgs += '--trigger=MANUAL'
    }
    $run = Invoke-Node -NodePath $node -Arguments $nodeArgs
    foreach ($line in $run.Output) { Write-SchedulerLog "$line" }

    if ($run.ExitCode -ne 0) {
        Write-SchedulerLog "FAILED with exit $($run.ExitCode)"
        exit $run.ExitCode
    }
    Write-SchedulerLog 'SUCCESS'
    exit 0
}
catch {
    Write-SchedulerLog "ERROR: $($_.Exception.Message)"
    exit 2
}
