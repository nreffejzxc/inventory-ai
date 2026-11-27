import { spawn } from 'node:child_process';

/**
 * Bounded PowerShell execution for host-local operations.
 *
 * The platform console reads Windows Scheduled Tasks and runs the repository's
 * registration scripts. Everything here is deliberately small and shared, so the
 * jobs surface does not grow a second process convention: one timeout, one
 * captured exit status, one REST-flattening rule.
 *
 * A timeout kills the child and resolves with a null code — callers must treat
 * that as "the host did not answer", never as success.
 */

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const MAX_STDERR = 4_000;

export function runProcess(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
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

/** Run a short inline script without a profile or an interactive prompt. */
export function runPowerShell(script: string, timeoutMs = 15_000): Promise<ProcessResult> {
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
}

/** Run a repository script file; arguments are passed as separate argv entries. */
export function runPowerShellFile(
  scriptPath: string,
  args: string[] = [],
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  return runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    timeoutMs,
  );
}

/**
 * A single-quoted PowerShell literal. The task names and times this module
 * interpolates are validated first; quoting is the second line of defence, not
 * the only one.
 */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * PowerShell's ConvertTo-Json renders dates as `/Date(ms)/` when a value came
 * through a COM-ish path, and as an ISO string otherwise. Normalise both.
 */
export function psDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const epoch = /^\/Date\((-?\d+)\)\/$/.exec(raw);
  if (epoch) return new Date(Number(epoch[1])).toISOString();
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** ConvertTo-Json writes a single-element array as an object; normalise. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

/** One line of stderr/stdout, so an error message stays readable in the console. */
export function firstLine(result: ProcessResult, fallback: string): string {
  const detail = (result.stderr || result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  return detail || fallback;
}
