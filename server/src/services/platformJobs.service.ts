import { existsSync, mkdirSync, readFileSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  asArray,
  firstLine,
  psDate,
  psQuote,
  runPowerShell,
  runPowerShellFile,
} from './hostPowerShell.ts';

/**
 * Background jobs: the four Windows Scheduled Tasks that operate Inventory AI.
 *
 * The view is deliberately split into two halves:
 *
 *   * **monitoring** — task state, triggers, last result and the tail of each
 *     scheduler log, read from Task Scheduler and %LOCALAPPDATA% on this host;
 *   * **management** — enable/disable and a daily reschedule, each an explicit
 *     operator action that runs the repository's *existing* registration script.
 *
 * Nothing here registers a task on its own. The audit found two inactive tasks
 * (`Production Health Watch` disabled, `Integrity Operations` unregistered); this
 * surface reports that state and explains it, and an operator has to say so
 * explicitly before either changes. Enabling a task that does not exist is an
 * error, not an implicit registration.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TASK_NAME_PATTERN = /^[A-Za-z0-9 ._-]{1,120}$/;
const LOG_TAIL_LINES = 8;
const LOG_TAIL_BYTES = 16 * 1024;

export type JobId = 'backup' | 'integrityAudit' | 'integrityOps' | 'healthWatch';

export type JobDefinition = {
  id: JobId;
  label: string;
  /** The production task name; the verification prefix is applied on top. */
  taskName: string;
  description: string;
  wrapper: string;
  registerScript: string | null;
  logFile: string;
  scheduleKind: 'daily' | 'interval';
  defaultTime: string | null;
  /** Where the operator-editable time lives inside console-config.json. */
  configKey: readonly string[];
  notes: readonly string[];
};

export class PlatformJobError extends Error {
  status: number;
  code: string;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'PlatformJobError';
    this.status = status;
    this.code = code;
  }
}

const serverRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(serverRoot, '..');

export const JOB_DEFINITIONS: readonly JobDefinition[] = Object.freeze([
  {
    id: 'backup',
    label: 'Daily encrypted database backup',
    taskName: 'InventoryAI Daily Encrypted Database Backup',
    description: 'Encrypts the production database, copies it off the machine and applies retention.',
    wrapper: 'scripts/run-db-backup.ps1',
    registerScript: 'scripts/register-db-backup-scheduler.ps1',
    logFile: 'db-backup-scheduler.log',
    scheduleKind: 'daily',
    defaultTime: '03:00',
    configKey: ['time'],
    notes: [],
  },
  {
    id: 'integrityAudit',
    label: 'Inventory integrity audit',
    taskName: 'InventoryAI Inventory Integrity Audit',
    description: 'Runs the read-only integrity monitor, records local history and alerts on new findings.',
    wrapper: 'scripts/run-integrity-audit.ps1',
    registerScript: 'scripts/register-integrity-audit-scheduler.ps1',
    logFile: 'integrity-audit-scheduler.log',
    scheduleKind: 'daily',
    defaultTime: '07:30',
    configKey: ['jobs', 'integrityAudit', 'time'],
    notes: [],
  },
  {
    id: 'integrityOps',
    label: 'Integrity operations',
    taskName: 'InventoryAI Integrity Operations',
    description: 'Runs audit:failures, audit:price-quality and recover:integrity with per-command locks.',
    wrapper: 'scripts/run-integrity-ops.ps1',
    registerScript: 'scripts/register-integrity-ops-scheduler.ps1',
    logFile: 'integrity-ops-scheduler.log',
    scheduleKind: 'daily',
    defaultTime: '08:00',
    configKey: ['jobs', 'integrityOps', 'time'],
    notes: [
      'Not registered by this console. Validate the wrapper (a manual run of each of its three commands) before registering it — registration is an explicit operator action.',
    ],
  },
  {
    id: 'healthWatch',
    label: 'Production health watch',
    taskName: 'InventoryAI Production Health Watch',
    description: 'Dispatches the production-health workflow every five minutes while the operator is signed in.',
    wrapper: 'scripts/trigger-production-health-watch.ps1',
    registerScript: 'scripts/register-production-health-scheduler.ps1',
    logFile: 'production-health-scheduler.log',
    scheduleKind: 'interval',
    defaultTime: null,
    configKey: [],
    notes: [
      'Currently disabled. It is the fallback for the repository schedule that does not fire; the external uptime monitor is the primary trigger. Enabling it dispatches a GitHub workflow every five minutes.',
    ],
  },
]);

/** The production task name, or the verification-prefixed one on an isolated host. */
export function jobTaskName(definition: JobDefinition): string {
  const prefix = String(process.env.PLATFORM_JOBS_TASK_PREFIX ?? '');
  if (prefix && !/^[A-Za-z0-9 ._-]{1,60}$/.test(prefix)) {
    throw new PlatformJobError(
      'PLATFORM_JOBS_TASK_PREFIX contains characters a scheduled task name cannot carry.',
      'PLATFORM_JOBS_TASK_PREFIX_INVALID',
      500,
    );
  }
  const name = `${prefix}${definition.taskName}`;
  if (!TASK_NAME_PATTERN.test(name)) {
    throw new PlatformJobError('The scheduled task name is not usable.', 'PLATFORM_JOBS_TASK_NAME_INVALID', 500);
  }
  return name;
}

export function configPath(): string {
  const override = String(process.env.PLATFORM_BACKUP_CONFIG ?? '').trim();
  if (override) return override;
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, 'inventory-ai-backups', 'console-config.json');
}

function schedulerLogPath(file: string): string {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
  return path.join(base, 'InventoryAI', file);
}

type RawConfig = Record<string, unknown>;

function readConfig(): { config: RawConfig; warnings: string[] } {
  const file = configPath();
  if (!existsSync(file)) {
    return { config: {}, warnings: [`No console configuration at ${file}; defaults are shown.`] };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, warnings: [`The console configuration at ${file} is not an object; defaults are shown.`] };
    }
    return { config: parsed as RawConfig, warnings: [] };
  } catch (error) {
    return {
      config: {},
      warnings: [`The console configuration could not be read (${(error as Error).message}); defaults are shown.`],
    };
  }
}

function readAtPath(source: RawConfig, keys: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function writeAtPath(target: RawConfig, keys: readonly string[], value: unknown): void {
  let cursor: RawConfig = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as RawConfig;
  }
  cursor[keys[keys.length - 1]!] = value;
}

/** The configured daily time for one job, and whether it came from the file. */
export function configuredTime(
  definition: JobDefinition,
  config: RawConfig,
): { time: string | null; fromConfig: boolean } {
  if (definition.scheduleKind !== 'daily') return { time: null, fromConfig: false };
  const stored = readAtPath(config, definition.configKey);
  if (typeof stored === 'string' && TIME_PATTERN.test(stored)) return { time: stored, fromConfig: true };
  return { time: definition.defaultTime, fromConfig: false };
}

/** Read the last `count` non-empty lines of a file, bounded to `maxBytes`. */
function tailLines(file: string, count: number, maxBytes: number): { lines: string[]; note: string | null } {
  if (!existsSync(file)) {
    return { lines: [], note: `No scheduler log at ${file} yet.` };
  }
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const handle = openSync(file, 'r');
    try {
      readSync(handle, buffer, 0, length, start);
    } finally {
      closeSync(handle);
    }
    const lines = buffer
      .toString('utf8')
      .split(/\r?\n/)
      .slice(start > 0 ? 1 : 0)
      .filter((line) => line.trim() !== '')
      .slice(-count)
      .map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
    return { lines, note: lines.length ? null : 'The scheduler log is empty.' };
  } catch (error) {
    return { lines: [], note: `The scheduler log could not be read: ${(error as Error).message}` };
  }
}

type RawTaskState = {
  name: string;
  found: boolean;
  state: string | null;
  startBoundary: unknown;
  nextRunTime: unknown;
  lastRunTime: unknown;
  lastResult: unknown;
  repetition: string | null;
} | null;

/**
 * One Task Scheduler query for all four tasks.
 *
 * A missing task is `found: false`, not an exception: three of the four states the
 * audit asked this view to show are "not registered", "disabled" and "ready", and
 * only the first two are unusual.
 */
async function readTaskStates(names: string[]): Promise<{ states: Map<string, RawTaskState>; error: string | null }> {
  const states = new Map<string, RawTaskState>();
  if (process.platform !== 'win32') {
    return {
      states,
      error: 'The scheduled tasks are Windows Scheduled Tasks; this host is not Windows, so their state cannot be read here.',
    };
  }
  const list = names.map((name) => psQuote(name)).join(',');
  // Joined with newlines, not '; '. A braced block joined with a semicolon
  // becomes `foreach (...) {;` which PowerShell accepts and then runs as
  // nothing: exit 0, empty output, every task looking unregistered.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$names = @(${list})`,
    '$out = foreach ($n in $names) {',
    '  $t = Get-ScheduledTask -TaskName $n',
    '  if ($null -eq $t) { [pscustomobject]@{ name = $n; found = $false } }',
    '  else {',
    '    $i = Get-ScheduledTaskInfo -TaskName $n',
    '    [pscustomobject]@{ name = $n; found = $true; state = $t.State.ToString(); startBoundary = $t.Triggers[0].StartBoundary; nextRunTime = $i.NextRunTime; lastRunTime = $i.LastRunTime; lastResult = $i.LastTaskResult; repetition = $t.Triggers[0].Repetition.Interval }',
    '  }',
    '}',
    '$out | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const result = await runPowerShell(script, 15_000);
  if (result.code !== 0) {
    return { states, error: `Task Scheduler could not be queried: ${firstLine(result, 'no output')}` };
  }
  const text = result.stdout.trim();
  if (!text) return { states, error: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    for (const entry of asArray(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const name = String(row.name ?? '');
      if (!name) continue;
      states.set(name, {
        name,
        found: row.found === true,
        state: row.state ? String(row.state) : null,
        startBoundary: row.startBoundary,
        nextRunTime: row.nextRunTime,
        lastRunTime: row.lastRunTime,
        lastResult: row.lastResult,
        repetition: row.repetition ? String(row.repetition) : null,
      });
    }
    return { states, error: null };
  } catch {
    return { states, error: 'Task Scheduler returned an unreadable state.' };
  }
}

const RESULT_LABELS: Record<number, string> = {
  0: 'Success (0)',
  1: 'Incorrect function (1)',
  2: 'File not found (2)',
  267008: 'Task is currently running',
  267009: 'Task is currently running',
  267010: 'Task was terminated by the user',
  267011: 'Task has not run yet',
  267012: 'The operator or administrator refused the request',
  2147942402: 'File not found (0x80070002)',
  3221225786: 'Terminated (0xC000013A)',
};

function resultLabel(value: number | null): string | null {
  if (value == null) return null;
  if (RESULT_LABELS[value]) return RESULT_LABELS[value];
  if (value < 0) return `Failed (${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')})`;
  return `Exit ${value}`;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalLabel(interval: string | null): string | null {
  if (!interval) return null;
  // PT5M / PT1H — enough to describe a repetition honestly without a library.
  const match = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?/.exec(interval);
  if (!match) return interval;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  if (hours && minutes) return `every ${hours}h ${minutes}m`;
  if (hours) return `every ${hours}h`;
  if (minutes) return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return interval;
}

export type JobState = 'READY' | 'RUNNING' | 'DISABLED' | 'MISSING' | 'UNKNOWN';

export type JobView = {
  id: JobId;
  label: string;
  description: string;
  taskName: string;
  state: JobState;
  stateLabel: string;
  stateDetail: string | null;
  schedule: {
    kind: 'daily' | 'interval';
    time: string | null;
    timeFromConfig: boolean;
    registeredTime: string | null;
    description: string;
    startBoundary: string | null;
    nextRunTime: string | null;
  };
  lastRunTime: string | null;
  lastResult: number | null;
  lastResultLabel: string | null;
  lastRunOk: boolean | null;
  log: { path: string; available: boolean; lines: string[]; note: string | null };
  reschedulable: boolean;
  notes: string[];
  error: string | null;
};

export type JobsReport = {
  asOf: string;
  host: {
    available: boolean;
    platform: string;
    configPath: string;
    taskPrefix: string | null;
    note: string;
  };
  jobs: JobView[];
  summary: { total: number; ready: number; running: number; disabled: number; missing: number; unknown: number };
  warnings: string[];
};

/** The wall-clock time a task actually fires, in the operator timezone. */
function timeInManila(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
    return /^\d{2}:\d{2}$/.test(parts) ? parts : null;
  } catch {
    return null;
  }
}

function stateOf(raw: RawTaskState, available: boolean): { state: JobState; label: string; detail: string | null } {
  if (!available) {
    return {
      state: 'UNKNOWN',
      label: 'Unknown on this host',
      detail: 'This API host is not the machine that runs the task, so its state cannot be verified here.',
    };
  }
  if (!raw || raw.found !== true) {
    return {
      state: 'MISSING',
      label: 'Not registered',
      detail: 'No Windows Scheduled Task with this name exists on this host.',
    };
  }
  switch ((raw.state || '').toLowerCase()) {
    case 'ready':
      return { state: 'READY', label: 'Ready', detail: null };
    case 'running':
      return { state: 'RUNNING', label: 'Running', detail: null };
    case 'disabled':
      return {
        state: 'DISABLED',
        label: 'Disabled',
        detail: 'The task exists but will not run until it is enabled.',
      };
    case 'queued':
      return { state: 'READY', label: 'Queued', detail: 'The task is queued to start.' };
    default:
      return { state: 'UNKNOWN', label: raw.state || 'Unknown', detail: 'Task Scheduler reported a state this view does not recognise.' };
  }
}

export async function getJobsReport(): Promise<JobsReport> {
  const available = process.platform === 'win32';
  const definitions = JOB_DEFINITIONS;
  const names: string[] = [];
  const nameErrors = new Map<JobId, string>();
  for (const definition of definitions) {
    try {
      names.push(jobTaskName(definition));
    } catch (error) {
      nameErrors.set(definition.id, (error as Error).message);
    }
  }

  const { config, warnings: configWarnings } = readConfig();
  const { states, error: taskError } = await readTaskStates(names);
  const warnings: string[] = [...configWarnings];
  if (taskError) warnings.push(taskError);
  const prefix = String(process.env.PLATFORM_JOBS_TASK_PREFIX ?? '').trim();

  const jobs = definitions.map((definition): JobView => {
    const name = nameErrors.has(definition.id) ? definition.taskName : jobTaskName(definition);
    const raw = nameErrors.has(definition.id) ? null : (states.get(name) ?? null);
    const resolved = stateOf(raw, available && !nameErrors.has(definition.id));
    const { time, fromConfig } = configuredTime(definition, config);
    const repeat = intervalLabel(raw?.repetition ?? null);
    const scheduleDescription = definition.scheduleKind === 'interval'
      ? (repeat ? `${repeat} while this user is signed in` : 'Every five minutes while this user is signed in')
      : (time ? `Daily at ${time} ${String(config.timeZone ?? 'Asia/Manila')}` : 'Daily');

    const log = tailLines(schedulerLogPath(definition.logFile), LOG_TAIL_LINES, LOG_TAIL_BYTES);
    const lastResult = finiteNumber(raw?.lastResult);
    const notes = [...definition.notes];
    if (!fromConfig && definition.scheduleKind === 'daily') {
      notes.push(`No console configuration holds this schedule; the registration default (${definition.defaultTime}) is shown.`);
    }
    // A saved time and the task's own trigger can disagree — the file is written
    // before re-registration, and a registration can also be changed outside this
    // console. Reporting the saved time alone would claim a run that will not happen.
    const registeredTime = timeInManila(psDate(raw?.startBoundary));
    if (definition.scheduleKind === 'daily' && time && registeredTime && time !== registeredTime) {
      notes.push(
        `The saved time (${time}) differs from the task's registered start time (${registeredTime}). The task fires at its registered time until it is re-registered.`,
      );
    }

    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      taskName: name,
      state: resolved.state,
      stateLabel: resolved.label,
      stateDetail: nameErrors.get(definition.id) ?? resolved.detail,
      schedule: {
        kind: definition.scheduleKind,
        time,
        timeFromConfig: fromConfig,
        description: scheduleDescription,
        startBoundary: psDate(raw?.startBoundary),
          registeredTime,
          // Task Scheduler keeps reporting a next run for a disabled task. Showing
          // it would claim a run that will not happen.
          nextRunTime: resolved.state === 'DISABLED' ? null : psDate(raw?.nextRunTime),
      },
      lastRunTime: psDate(raw?.lastRunTime),
      lastResult,
      lastResultLabel: resultLabel(lastResult),
      lastRunOk: lastResult == null ? null : lastResult === 0,
      log: { path: schedulerLogPath(definition.logFile), available: log.lines.length > 0, lines: log.lines, note: log.note },
      reschedulable: definition.scheduleKind === 'daily' && definition.registerScript !== null,
      notes,
      error: nameErrors.get(definition.id) ?? null,
    };
  });

  if (!available) {
    warnings.push(
      'Task state, triggers, results and scheduler logs are local to the machine that runs them. This API host cannot read them, so the table below reports every task as unknown — that is not evidence that a task is missing.',
    );
  }
  if (prefix) {
    warnings.push(`Task names use the verification prefix "${prefix}"; the production tasks are not shown.`);
  }

  const summary = { total: jobs.length, ready: 0, running: 0, disabled: 0, missing: 0, unknown: 0 };
  for (const job of jobs) {
    if (job.state === 'READY') summary.ready += 1;
    else if (job.state === 'RUNNING') summary.running += 1;
    else if (job.state === 'DISABLED') summary.disabled += 1;
    else if (job.state === 'MISSING') summary.missing += 1;
    else summary.unknown += 1;
  }

  return {
    asOf: new Date().toISOString(),
    host: {
      available,
      platform: process.platform,
      configPath: configPath(),
      taskPrefix: prefix || null,
      note: available
        ? 'Windows Scheduled Tasks on this host. Read from Task Scheduler on every load.'
        : 'Scheduled tasks run on the operator machine, not on this API host.',
    },
    jobs,
    summary,
    warnings,
  };
}

function findDefinition(id: string): JobDefinition {
  const definition = JOB_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new PlatformJobError('Unknown job.', 'PLATFORM_JOB_UNKNOWN', 404);
  }
  return definition;
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new PlatformJobError(
      'Scheduled tasks live on the Windows machine that runs them; this host cannot change them.',
      'PLATFORM_JOBS_HOST_UNSUPPORTED',
      501,
    );
  }
}

/** Enable or disable one existing task. Never registers a missing one. */
export async function setJobEnabled(id: string, enabled: boolean): Promise<JobsReport> {
  const definition = findDefinition(id);
  assertWindows();
  const name = jobTaskName(definition);
  const script = [
    "$ErrorActionPreference='Stop'",
    `$t = Get-ScheduledTask -TaskName ${psQuote(name)} -ErrorAction Stop`,
    `if ($null -eq $t) { throw 'not found' }`,
    `$${enabled ? 'null = Enable-ScheduledTask' : 'null = Disable-ScheduledTask'} -TaskName ${psQuote(name)}`,
    `(Get-ScheduledTask -TaskName ${psQuote(name)}).State.ToString()`,
  ].join('\n');
  const result = await runPowerShell(script, 20_000);
  if (result.code !== 0) {
    const detail = firstLine(result, 'the task did not answer');
    throw new PlatformJobError(
      `"${name}" could not be ${enabled ? 'enabled' : 'disabled'}: ${detail}. A task that is not registered must be registered deliberately with its own script; this console does not create it.`,
      'PLATFORM_JOB_TASK_FAILED',
      502,
    );
  }
  return getJobsReport();
}

/**
 * Reschedule a daily task by writing the same configuration the runner reads and
 * re-running the repository's registration script — the same convention the
 * backup schedule already uses, so a time saved here is the time the task fires.
 */
export async function rescheduleJob(id: string, time: string, actorEmail: string): Promise<JobsReport> {
  const definition = findDefinition(id);
  if (definition.scheduleKind !== 'daily' || !definition.registerScript) {
    throw new PlatformJobError(
      `"${definition.label}" does not run on a daily schedule, so there is no time to change.`,
      'PLATFORM_JOB_NOT_RESCHEDULABLE',
      400,
    );
  }
  const value = String(time ?? '').trim();
  if (!TIME_PATTERN.test(value)) {
    throw new PlatformJobError('time must be a 24-hour HH:MM value.', 'PLATFORM_JOB_TIME_INVALID', 400);
  }
  assertWindows();

  const file = configPath();
  const { config, warnings } = readConfig();
  if (warnings.length && config && Object.keys(config).length === 0 && existsSync(file)) {
    // A configuration that exists but cannot be parsed must not be silently
    // replaced: it holds directories and retention for the backup runner.
    throw new PlatformJobError(
      'The console configuration exists but could not be parsed, so it was not overwritten.',
      'PLATFORM_JOB_CONFIG_UNREADABLE',
      409,
    );
  }
  writeAtPath(config, definition.configKey, value);
  const payload = { ...config, updatedAt: new Date().toISOString(), updatedBy: actorEmail };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new PlatformJobError(
      `The configuration could not be written: ${(error as Error).message}`,
      'PLATFORM_JOB_CONFIG_UNWRITABLE',
      500,
    );
  }

  const scriptPath = path.join(repoRoot, definition.registerScript);
  if (!existsSync(scriptPath)) {
    throw new PlatformJobError(
      `The registration script is missing on this host (${definition.registerScript}); the schedule was saved but no task was re-registered.`,
      'PLATFORM_JOB_REGISTER_MISSING',
      502,
    );
  }

  const result = await runPowerShellFile(
    scriptPath,
    ['-At', value, '-TaskName', jobTaskName(definition), '-ConfigPath', file],
    60_000,
  );
  if (result.code !== 0) {
    throw new PlatformJobError(
      `The schedule was saved, but the Windows task could not be re-registered: ${firstLine(result, `exit ${result.code}`)}`,
      'PLATFORM_JOB_TASK_FAILED',
      502,
    );
  }
  return getJobsReport();
}
