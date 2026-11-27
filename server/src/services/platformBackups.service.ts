/**
 * Backups as an internal operations surface for the platform console.
 *
 * WHY THIS IS SERVER-SIDE AND NOT A BROWSER FEATURE. A backup is a set of files
 * on the machine that RUNS the API. The console cannot read a filesystem, and a
 * tenant-facing endpoint must never expose one, so every read and every mutation
 * here happens in this process, behind the platform identity.
 *
 * THE HONEST LIMIT. The archives live beside the owner's backup scheduler, not
 * beside a deployed API instance. When this process cannot see the configured
 * directory (the Render service, a different machine, a fresh host), the report
 * says so with a reason and returns no invented history. It never reports an
 * empty list as "no backups exist".
 *
 * WHAT IT WILL NOT DO. It never decrypts an archive (that needs the private key
 * and passphrase, which must not live on an API host), never reads the GPG
 * keyring, never prints a connection string, and never deletes anything outside
 * the two configured directories. Deletion is restricted to files that match the
 * archive name pattern, and each archive is removed only with its own `.sha256`
 * sidecar.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listBackupRunRecords } from './backupRuns.service.ts';

/** Refusals carry their own status so the controller can answer without a translation table. */
export class PlatformBackupError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = 'PLATFORM_BACKUP_INVALID', status = 400) {
    super(message);
    this.name = 'PlatformBackupError';
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TASK_NAME = 'InventoryAI Daily Encrypted Database Backup';
const RETENTION = Object.freeze({ daily: 14, weekly: 4, monthly: 3 });
const ARCHIVE_NAME = /^[A-Za-z0-9_.]+-\d{8}T\d{6}Z\.tar\.gz\.gpg$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const serverRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(serverRoot, '..');
const registerScript = path.join(repoRoot, 'scripts', 'register-db-backup-scheduler.ps1');
const runScript = path.join(repoRoot, 'scripts', 'run-db-backup.ps1');

function homeDir(): string {
  return process.env.USERPROFILE || os.homedir();
}

export function configPath(): string {
  return process.env.PLATFORM_BACKUP_CONFIG || path.join(homeDir(), 'inventory-ai-backups', 'console-config.json');
}

/**
 * The Windows task this surface owns.
 *
 * `PLATFORM_BACKUP_TASK_NAME` exists for one reason: an isolated verification run
 * must be able to register and inspect its own task instead of restating the
 * production one. A value that is not a plausible task name is refused rather
 * than interpolated into PowerShell.
 */
export function taskName(): string {
  const value = String(process.env.PLATFORM_BACKUP_TASK_NAME ?? '').trim();
  if (!value) return DEFAULT_TASK_NAME;
  if (!/^[A-Za-z0-9 ._-]{1,120}$/.test(value)) {
    throw new PlatformBackupError(
      'PLATFORM_BACKUP_TASK_NAME contains characters a scheduled task name cannot carry.',
      'PLATFORM_BACKUP_TASK_NAME_INVALID',
    );
  }
  return value;
}

export function schedulerLogPath(): string {
  const base = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
  return path.join(base, 'InventoryAI', 'db-backup-scheduler.log');
}

export type BackupConfig = {
  time: string;
  timeZone: string;
  archiveDir: string;
  copyDir: string;
  retention: { daily: number; weekly: number; monthly: number };
};

export function defaultConfig(): BackupConfig {
  return {
    time: '03:00',
    timeZone: 'Asia/Manila',
    archiveDir: path.join(homeDir(), 'inventory-ai-backups', 'archives'),
    copyDir: path.join(homeDir(), 'OneDrive', 'Inventory-AI-Backups'),
    retention: { ...RETENTION },
  };
}

/**
 * A directory this surface may read and delete in.
 *
 * Absolute, not a drive root, not the repository, and not a Windows system
 * directory. The repository check matters as much as the others: a backup inside
 * the project is one `git add -A` away from being committed.
 */
function assertDirectory(value: unknown, field: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new PlatformBackupError(`${field} is required.`, 'PLATFORM_BACKUP_DIR_INVALID');
  }
  if (raw.includes('\0')) {
    throw new PlatformBackupError(`${field} contains an invalid character.`, 'PLATFORM_BACKUP_DIR_INVALID');
  }
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(resolved)) {
    throw new PlatformBackupError(`${field} must be an absolute path.`, 'PLATFORM_BACKUP_DIR_INVALID');
  }
  if (resolved === path.parse(resolved).root) {
    throw new PlatformBackupError(`${field} must not be a drive root.`, 'PLATFORM_BACKUP_DIR_INVALID');
  }
  const relative = path.relative(repoRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new PlatformBackupError(
      `${field} must be outside the repository — an archive holds customer data and must never be committable.`,
      'PLATFORM_BACKUP_DIR_INVALID',
    );
  }
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const fromSystem = path.relative(windows, resolved);
  if (fromSystem === '' || (!fromSystem.startsWith('..') && !path.isAbsolute(fromSystem))) {
    throw new PlatformBackupError(`${field} must not be inside the Windows system directory.`, 'PLATFORM_BACKUP_DIR_INVALID');
  }
  return resolved;
}

function readConfigFile(): { config: BackupConfig; warnings: string[] } {
  const base = defaultConfig();
  const file = configPath();
  if (!existsSync(file)) {
    return { config: base, warnings: [`No console configuration at ${file}; defaults are shown.`] };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackupConfig>;
    const time = TIME_PATTERN.test(String(parsed.time ?? '')) ? String(parsed.time) : base.time;
    return {
      config: {
        time,
        timeZone: String(parsed.timeZone ?? base.timeZone),
        archiveDir: String(parsed.archiveDir ?? base.archiveDir),
        copyDir: String(parsed.copyDir ?? base.copyDir),
        retention: { ...base.retention },
      },
      warnings: [],
    };
  } catch (error) {
    return {
      config: base,
      warnings: [`The console configuration could not be read (${(error as Error).message}); defaults are shown.`],
    };
  }
}

function run(command: string, args: string[], timeoutMs = 15_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type TaskState = {
  state: string | null;
  startBoundary: string | null;
  nextRunTime: string | null;
  lastRunTime: string | null;
  lastResult: number | null;
  error: string | null;
};

/** The Windows task's own view of itself; null when this host is not Windows. */
/** PowerShell's ConvertTo-Json writes dates as `/Date(ms)/`; normalise to ISO. */
function taskDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const epoch = /^\/Date\((-?\d+)\)\/$/.exec(raw);
  if (epoch) return new Date(Number(epoch[1])).toISOString();
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function readTaskState(): Promise<TaskState> {
  const empty: TaskState = {
    state: null,
    startBoundary: null,
    nextRunTime: null,
    lastRunTime: null,
    lastResult: null,
    error: null,
  };
  if (process.platform !== 'win32') {
    return { ...empty, error: 'The backup scheduler is a Windows Scheduled Task; this host is not Windows.' };
  }
  let name: string;
  try {
    name = taskName();
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }
  const script = [
    `$ErrorActionPreference='Stop'`,
    `$t = Get-ScheduledTask -TaskName '${name}'`,
    `$i = Get-ScheduledTaskInfo -TaskName '${name}'`,
    `[pscustomobject]@{ state = $t.State.ToString(); startBoundary = $t.Triggers[0].StartBoundary; nextRunTime = $i.NextRunTime; lastRunTime = $i.LastRunTime; lastResult = $i.LastTaskResult } | ConvertTo-Json -Compress`,
  ].join('; ');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8_000);
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n')[0] || 'the scheduled task could not be read';
    return { ...empty, error: `Scheduled task "${name}" is not readable on this host: ${reason}` };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return {
      state: parsed.state ? String(parsed.state) : null,
      startBoundary: parsed.startBoundary ? String(parsed.startBoundary) : null,
      nextRunTime: taskDate(parsed.nextRunTime),
      lastRunTime: taskDate(parsed.lastRunTime),
      lastResult: Number.isFinite(Number(parsed.lastResult)) ? Number(parsed.lastResult) : null,
      error: null,
    };
  } catch {
    return { ...empty, error: 'The scheduled task returned an unreadable state.' };
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sidecarDigest(archive: string): Promise<string | null> {
  try {
    const raw = readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export type BackupArchive = {
  name: string;
  database: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string | null;
  checksumValid: boolean;
  sidecarPresent: boolean;
  offsite: 'missing' | 'identical' | 'differs';
};

async function listArchives(
  directory: string,
  copyDirectory: string,
  copyExists: boolean,
  warnings: string[] = [],
): Promise<BackupArchive[]> {
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && ARCHIVE_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const rows: BackupArchive[] = [];
  for (const name of names) {
    // An archive can disappear between the directory read and the hash — the
    // retention pass runs on its own schedule. One unreadable file must not turn
    // the whole report into a 500, and it must not be silently dropped either.
    try {
      const file = path.join(directory, name);
      const info = await stat(file);
      const digest = await sha256(file);
      const recorded = await sidecarDigest(file);
      let offsite: BackupArchive['offsite'] = 'missing';
      if (copyExists) {
        const copy = path.join(copyDirectory, name);
        if (existsSync(copy)) offsite = (await sha256(copy)) === digest ? 'identical' : 'differs';
      }
      rows.push({
        name,
        database: name.slice(0, name.indexOf('-')),
        createdAt: new Date(info.mtime).toISOString(),
        sizeBytes: info.size,
        sha256: recorded ?? digest,
        checksumValid: recorded === digest,
        sidecarPresent: recorded !== null,
        offsite,
      });
    } catch (error) {
      warnings.push(`"${name}" could not be read (${(error as Error).message}); it is not counted below.`);
    }
  }
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}

export type BackupRun = {
  startedAt: string;
  finishedAt: string | null;
  outcome: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'INTERRUPTED' | 'UNKNOWN';
  archive: string | null;
  detail: string | null;
  /** Durable records carry these; log-parsed runs leave them blank. */
  runId?: string;
  trigger?: string;
  sha256?: string | null;
  offsite?: string;
  sizeBytes?: number | null;
  pruned?: string[];
};

/** Runs recorded by the scheduler wrapper's log, newest first. */
export function parseRuns(logText: string, limit = 20): BackupRun[] {
  const runs: BackupRun[] = [];
  let current: BackupRun | null = null;
  for (const line of logText.split(/\r?\n/)) {
    const match = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const stamp = match[1] ?? '';
    const message = match[2] ?? '';
    if (/starting encrypted production backup/i.test(message)) {
      const started: BackupRun = {
        startedAt: stamp,
        finishedAt: null,
        outcome: 'RUNNING',
        archive: null,
        detail: null,
      };
      runs.push(started);
      current = started;
      continue;
    }
    const run = current;
    if (!run) continue;
    const created = /\[backup:daily\]\s+created\s+:\s+(\S+)/.exec(message);
    if (created) {
      run.archive = created[1] ?? null;
      continue;
    }
    if (/^SUCCESS$/.test(message.trim())) {
      run.outcome = 'SUCCESS';
      run.finishedAt = stamp;
      current = null;
      continue;
    }
    const failed = /^FAILED with exit (\d+)$/.exec(message.trim());
    if (failed) {
      run.outcome = 'FAILED';
      run.finishedAt = stamp;
      run.detail = `exit ${failed[1] ?? 'unknown'}`;
      current = null;
      continue;
    }
    if (/^ERROR:\s*/.test(message.trim())) {
      run.outcome = 'FAILED';
      run.finishedAt = stamp;
      run.detail = message.trim().slice(0, 300);
    }
  }
  return runs.reverse().slice(0, limit);
}

let lastRunStartedAt = 0;

export type BackupHistory = {
  /** Where the `runs` array below came from, stated rather than inferred. */
  source: 'durable' | 'log';
  durableAvailable: boolean;
  durableCount: number;
  note: string | null;
};

export type BackupReport = {
  host: {
    available: boolean;
    platform: string;
    warnings: string[];
    archiveDir: string;
    copyDir: string;
    archiveDirExists: boolean;
    copyDirExists: boolean;
    configFile: string;
    schedulerLog: string;
    taskName: string;
  };
  schedule: {
    time: string;
    timeZone: string;
    retention: { daily: number; weekly: number; monthly: number };
    task: TaskState;
  };
  archives: BackupArchive[];
  runs: BackupRun[];
  history: BackupHistory;
  asOf: string;
};

export async function getBackupReport(): Promise<BackupReport> {
  const { config, warnings } = readConfigFile();
  const archiveDirExists = existsSync(config.archiveDir);
  const copyDirExists = existsSync(config.copyDir);
  const [archives, task] = await Promise.all([
    archiveDirExists
      ? listArchives(config.archiveDir, config.copyDir, copyDirExists, warnings)
      : Promise.resolve([] as BackupArchive[]),
    readTaskState(),
  ]);

  const log = schedulerLogPath();
  let logRuns: BackupRun[] = [];
  if (existsSync(log)) {
    try {
      logRuns = parseRuns(readFileSync(log, 'utf8'));
    } catch (error) {
      warnings.push(`The scheduler log could not be read (${(error as Error).message}).`);
    }
  } else {
    warnings.push('No scheduler log on this host yet; only durable run records are available.');
  }

  // Durable history is the primary source because it survives log rotation and
  // is visible from any API instance. The log stays as the fallback for runs
  // recorded before this collection existed, or while the database is unreachable.
  let durableRuns: BackupRun[] = [];
  let durableError: string | null = null;
  try {
    durableRuns = (await listBackupRunRecords(25)).map((record) => ({
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      outcome: record.outcome,
      archive: record.archive,
      detail: record.detail,
      runId: record.runId,
      trigger: record.trigger,
      sha256: record.sha256,
      offsite: record.offsite,
      sizeBytes: record.sizeBytes,
      pruned: record.pruned,
    }));
  } catch (error) {
    durableError = (error as Error).message;
  }

  const useDurable = durableRuns.length > 0;
  const runs = useDurable ? durableRuns : logRuns;
  const history: BackupHistory = {
    source: useDurable ? 'durable' : 'log',
    durableAvailable: durableError === null,
    durableCount: durableRuns.length,
    note: useDurable
      ? 'Durable records from the backup_runs collection; they survive scheduler-log rotation.'
      : durableError
        ? `The durable run history could not be read (${durableError}); showing the scheduler log on this host.`
        : 'No durable run record exists yet; showing the scheduler log on this host.',
  };

  if (!archiveDirExists) {
    warnings.push(
      `The archive directory does not exist on this host (${config.archiveDir}). Backups are created on the machine that runs the scheduler, not on a deployed API instance.`,
    );
  }
  if (!copyDirExists) {
    warnings.push(
      `The off-machine copy directory does not exist on this host (${config.copyDir}); archive copies cannot be verified here.`,
    );
  }

  let name = DEFAULT_TASK_NAME;
  try {
    name = taskName();
  } catch {
    // readTaskState() already reported the invalid name; the report still loads.
  }

  return {
    host: {
      available: archiveDirExists,
      platform: process.platform,
      warnings,
      archiveDir: config.archiveDir,
      copyDir: config.copyDir,
      archiveDirExists,
      copyDirExists,
      configFile: configPath(),
      schedulerLog: log,
      taskName: name,
    },
    schedule: { time: config.time, timeZone: config.timeZone, retention: config.retention, task },
    archives,
    runs,
    history,
    asOf: new Date().toISOString(),
  };
}

export type ScheduleUpdate = {
  time: string;
  archiveDir: string;
  copyDir: string;
};

export async function updateSchedule(input: ScheduleUpdate, actorEmail: string): Promise<BackupReport> {
  const time = String(input.time ?? '').trim();
  if (!TIME_PATTERN.test(time)) {
    throw new PlatformBackupError('time must be a 24-hour HH:MM value.', 'PLATFORM_BACKUP_TIME_INVALID');
  }
  const archiveDir = assertDirectory(input.archiveDir, 'Archive directory');
  const copyDir = assertDirectory(input.copyDir, 'Off-machine copy directory');
  if (archiveDir === copyDir) {
    throw new PlatformBackupError(
      'The archive and copy directories must differ; a single directory is not an off-machine copy.',
      'PLATFORM_BACKUP_DIR_INVALID',
    );
  }

  // Create both directories now. A saved destination that the run cannot write to
  // would fail at 03:00 with nobody watching.
  for (const directory of [archiveDir, copyDir]) {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw new PlatformBackupError(
        `Cannot create or open "${directory}": ${(error as Error).message}`,
        'PLATFORM_BACKUP_DIR_UNAVAILABLE',
      );
    }
  }

  await mkdir(path.dirname(configPath()), { recursive: true });
  const config: BackupConfig = { time, timeZone: 'Asia/Manila', archiveDir, copyDir, retention: { ...RETENTION } };
  const payload = { ...config, updatedAt: new Date().toISOString(), updatedBy: actorEmail };
  await writeFile(configPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (process.platform === 'win32') {
    const result = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        registerScript,
        '-At',
        time,
        '-TaskName',
        taskName(),
        '-ConfigPath',
        configPath(),
      ],
      60_000,
    );
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' ');
      // The configuration file IS written at this point. The message says so, and
      // the console reloads the report on this code, so the operator sees the
      // saved schedule beside the registration failure instead of a bare error.
      throw new PlatformBackupError(
        `The configuration was saved, but the Windows task could not be re-registered: ${detail || `exit ${result.code}`}`,
        'PLATFORM_BACKUP_TASK_FAILED',
        502,
      );
    }
  }

  return getBackupReport();
}

/** Start one backup run and return immediately; the log carries the result. */
export async function startBackupRun(): Promise<{ started: boolean; alreadyRunning: boolean }> {
  if (process.platform !== 'win32') {
    throw new PlatformBackupError(
      'The backup scheduler is a Windows Scheduled Task; this host cannot run it.',
      'PLATFORM_BACKUP_HOST_UNSUPPORTED',
      501,
    );
  }
  if (Date.now() - lastRunStartedAt < 60_000) {
    return { started: false, alreadyRunning: true };
  }
  if (!existsSync(runScript)) {
    throw new PlatformBackupError(
      'The backup runner script is not present on this host.',
      'PLATFORM_BACKUP_HOST_UNSUPPORTED',
      501,
    );
  }
  lastRunStartedAt = Date.now();

  // WHY Start-Process RATHER THAN A DETACHED SPAWN.
  //
  // On this host a powershell.exe started with `detached: true` (or with its
  // stdio ignored) exits immediately and silently: spawn reports success, the
  // wrapper never runs, and no log line is ever written. That was a real defect
  // — the console reported "backup started" while nothing happened. Launching
  // through Start-Process gives the run its own process, keeps this child's
  // pipes for the launcher's (instant) exit status, and was verified to produce
  // the scheduler log line the previous shape never produced.
  const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const launcher = [
    `$env:BACKUP_TRIGGER='CONSOLE';`,
    'Start-Process',
    '-FilePath',
    psQuote('powershell.exe'),
    '-ArgumentList',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runScript,
    ]
      .map(psQuote)
      .join(','),
    '-WindowStyle',
    'Hidden',
  ].join(' ');

  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], 20_000);
  if (result.code !== 0) {
    lastRunStartedAt = 0;
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' ');
    throw new PlatformBackupError(
      `The backup runner could not be started: ${detail || `exit ${result.code}`}`,
      'PLATFORM_BACKUP_RUN_FAILED',
      502,
    );
  }
  return { started: true, alreadyRunning: false };
}

export type DeleteResult = {
  name: string;
  removedLocal: boolean;
  removedOffsite: boolean;
  /** Set when the local copy went but the off-machine copy did not. */
  offsiteError?: string;
};

/** Delete one archive and its sidecar, locally and in the copy directory. */
export async function deleteArchive(name: string): Promise<DeleteResult> {
  const fileName = String(name ?? '').trim();
  if (!ARCHIVE_NAME.test(fileName)) {
    throw new PlatformBackupError('That is not a backup archive name.', 'PLATFORM_BACKUP_NAME_INVALID');
  }
  const { config } = readConfigFile();
  const local = path.join(config.archiveDir, fileName);
  if (path.dirname(local) !== path.resolve(config.archiveDir)) {
    throw new PlatformBackupError('That path escapes the archive directory.', 'PLATFORM_BACKUP_NAME_INVALID');
  }
  if (!existsSync(local)) {
    throw new PlatformBackupError('That archive is not present on this host.', 'PLATFORM_BACKUP_NOT_FOUND', 404);
  }

  // Never leave the owner with zero copies: the newest archive is protected.
  const archives = await listArchives(config.archiveDir, config.copyDir, existsSync(config.copyDir));
  if (archives.length > 0 && archives[0]!.name === fileName) {
    throw new PlatformBackupError(
      'The newest archive is protected. Delete an older copy, or let retention remove it after a newer backup exists.',
      'PLATFORM_BACKUP_NEWEST_PROTECTED',
    );
  }

  // The local copy is removed first and its failure is fatal: nothing else has
  // happened, and reporting success would be a lie about a recovery point.
  try {
    await rm(local, { force: true });
    await rm(`${local}.sha256`, { force: true });
  } catch (error) {
    throw new PlatformBackupError(
      `"${fileName}" could not be removed from the archive directory: ${(error as Error).message}`,
      'PLATFORM_BACKUP_DELETE_FAILED',
      500,
    );
  }

  // The off-machine copy is removed second. A failure here is a real partial
  // state — the local archive is gone, the copy is not — so it is returned as
  // part of the result rather than swallowed or dressed up as total success.
  let removedOffsite = false;
  let offsiteError: string | undefined;
  if (existsSync(config.copyDir)) {
    const offsite = path.join(config.copyDir, fileName);
    if (existsSync(offsite)) {
      try {
        await rm(offsite, { force: true });
        await rm(`${offsite}.sha256`, { force: true });
        removedOffsite = true;
      } catch (error) {
        offsiteError = (error as Error).message;
      }
    }
  }
  return { name: fileName, removedLocal: true, removedOffsite, ...(offsiteError ? { offsiteError } : {}) };
}

export default {
  PlatformBackupError,
  configPath,
  defaultConfig,
  deleteArchive,
  getBackupReport,
  parseRuns,
  schedulerLogPath,
  startBackupRun,
  updateSchedule,
};
