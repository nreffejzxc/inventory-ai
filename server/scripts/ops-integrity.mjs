// `npm run ops:integrity -- --command=<name> [--with-production] [--notify]`
//
// The scheduler-facing runner for the three integrity operations. It does not
// reimplement any check: each command remains its own child process with its
// own exit-code contract (0 clean, 1 finding, 2 NOT CHECKED). This runner adds:
//   * one local lock per command, so a manual run and the scheduled run cannot
//     execute the same command together (stale locks are taken over);
//   * local latest/history state per command;
//   * one GitHub issue per command, opened/updated only when the result or its
//     signature changes and closed on recovery;
//   * a persisted undelivered-alert state: a failed create, comment or close is
//     retried by the next `--notify` run even when the finding is unchanged;
//   * a truthful failure alert: exit 2 is "NOT CHECKED", never a data finding.
//
// `audit:failures` and `audit:price-quality` are read-only. `recover:integrity`
// performs only the exact recovery actions already documented in
// INTEGRITY_RECOVERY.md; it never guesses and never repairs an ambiguous row.
//
// EXIT CODES
//   0  command clean (or another process already owns this command's lock)
//   1  command ran and reported a finding or attention row
//   2  NOT CHECKED / runner error — no conclusion about the database

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPS_COMMANDS,
  OPS_EXIT,
  OPS_STATUS,
  acquireRunLock,
  buildOpsSummary,
  classifyOpsResult,
  formatOpsMarkdown,
  historyPathFor,
  issueHasMarker,
  lockPathFor,
  opsAlertMarker,
  opsIssueBody,
  opsRecoveryComment,
  opsRecoveryMarker,
  parseChildJson,
  parseOpsArgs,
  pendingNotificationFor,
  readOpsHistory,
  sanitizeOpsDetail,
  shouldNotifyOps,
  writeOpsHistory,
} from './lib/ops-integrity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const GH_FALLBACK = process.env.GH_PATH || 'C:\\Program Files\\GitHub CLI\\gh.exe';

const USAGE = `Run one integrity operation safely, with duplicate-run prevention and alerting.

Usage:
  npm run ops:integrity -- --command=<name> [options]

Commands:
  audit:failures        read-only audit-write gap report
  audit:price-quality   read-only price-data quality report
  recover:integrity     exact transfer-journal and PO-claim recovery

Options:
  --with-production     run against production (required with --notify)
  --notify              open/update one GitHub issue for a finding or NOT CHECKED
  --format=<text|json>  stdout shape (default text)
  --history-dir=<path>  local latest/history directory
  --lock-dir=<path>     directory for per-command lock files
  --timeout-ms=<n>      child timeout, 10000..3600000 (default 600000)
  --help                this text

Duplicate-run prevention is one lock file per command. A lock older than
30 minutes is stale and may be taken over. A skipped duplicate exits 0 without
touching the history or alert state.

A failed GitHub create, comment or close is stored as an undelivered alert and
retried on the next --notify run. A close failure after a successful recovery
comment resumes at the close instead of posting the comment twice.

EXIT CODES
  0  clean, or another process already owns this command's lock
  1  completed with a finding / row needing attention
  2  NOT CHECKED or runner error; nothing is known about the database
`;

function defaultHistoryDir() {
  const base = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'state');
  return path.join(base, 'InventoryAI', 'integrity-ops');
}

function gh(args) {
  // A hung gh process must not hold the scheduler task until its execution
  // limit; the data check has already finished by the time notify runs.
  let run = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (run.error?.code === 'ENOENT' && existsSync(GH_FALLBACK)) {
    run = spawnSync(GH_FALLBACK, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
  }
  if (run.error) throw new Error(`gh could not start: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(String(run.stderr || run.stdout || `gh exited ${run.status}`).trim());
  }
  return run.stdout;
}

function findOpenIssue(title, ghCommand) {
  const out = ghCommand(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url']);
  const issues = JSON.parse(out);
  return issues.find((issue) => issue.title === title) ?? null;
}

/**
 * Read the issue's body and comments so a retry can prove whether its marker
 * already landed. A failed read is thrown, not treated as "no marker": posting
 * blind is exactly the duplicate this guard exists to prevent.
 */
function readIssueView(number, ghCommand) {
  const out = ghCommand([
    'issue',
    'view',
    String(number),
    '--json',
    'body,comments',
  ]);
  const view = JSON.parse(out);
  if (!view || typeof view !== 'object') throw new Error('gh returned an unreadable issue view');
  return view;
}

function failedNotification({ intent, stage, issueNumber = null, error, now }) {
  return {
    requested: true,
    action: 'failed',
    issueNumber,
    error: sanitizeOpsDetail(error),
    undelivered: true,
    intent,
    stage,
    attemptedAt: now().toISOString(),
  };
}

function deliveredNotification({ action, issueNumber = null, now }) {
  return {
    requested: true,
    action,
    issueNumber,
    error: null,
    undelivered: false,
    intent: null,
    stage: null,
    attemptedAt: now().toISOString(),
  };
}

/**
 * Deliver the one decision `shouldNotifyOps` made. Every failure returns a
 * durable pending record that the caller writes to history; the next run sees
 * it and retries even when the child's status and signature are unchanged.
 */
function notify(summary, previous, historyDir, { gh: ghCommand, now }) {
  const decision = shouldNotifyOps(previous, summary);
  if (decision.action === 'none') {
    return {
      requested: true,
      action: 'none',
      issueNumber: null,
      error: null,
      undelivered: false,
      intent: null,
      stage: null,
      attemptedAt: now().toISOString(),
    };
  }
  const title = OPS_COMMANDS[summary.command].issueTitle;
  const pending = pendingNotificationFor(previous);
  let stage = 'lookup';
  let issueNumber = null;
  try {
    const existing = findOpenIssue(title, ghCommand);
    if (existing) issueNumber = Number(existing.number);

    if (decision.action === 'recovery') {
      if (!existing) {
        return deliveredNotification({ action: 'none', now });
      }
      // The comment already reached GitHub on the failed run; retry only the
      // close. This is what keeps a close retry from duplicating its comment.
      const resumeAtClose =
        pending?.intent === 'recovery' &&
        pending?.stage === 'close' &&
        Number(pending?.issueNumber) === Number(existing.number);
      if (!resumeAtClose) {
        stage = 'comment';
        const marker = opsRecoveryMarker(summary.command);
        const view = readIssueView(existing.number, ghCommand);
        if (!issueHasMarker(view, marker)) {
          ghCommand([
            'issue',
            'comment',
            String(existing.number),
            '--body',
            opsRecoveryComment(summary.command),
          ]);
        }
      }
      stage = 'close';
      ghCommand(['issue', 'close', String(existing.number)]);
      return deliveredNotification({ action: 'recovered', issueNumber: existing.number, now });
    }

    const bodyFile = path.join(historyDir, 'issue-body.md');
    mkdirSync(path.dirname(bodyFile), { recursive: true });
    writeFileSync(bodyFile, `${opsIssueBody(summary)}\n`);
    if (existing) {
      stage = 'comment';
      const marker = opsAlertMarker(summary);
      const view = readIssueView(existing.number, ghCommand);
      if (!issueHasMarker(view, marker)) {
        ghCommand(['issue', 'comment', String(existing.number), '--body-file', bodyFile]);
      }
      return deliveredNotification({ action: 'updated', issueNumber: existing.number, now });
    }
    stage = 'create';
    const out = ghCommand(['issue', 'create', '--title', title, '--body-file', bodyFile]);
    const match = out.match(/\/issues\/(\d+)/);
    return deliveredNotification({
      action: 'created',
      issueNumber: match ? Number(match[1]) : null,
      now,
    });
  } catch (err) {
    return failedNotification({
      intent: decision.action,
      stage,
      issueNumber,
      error: err?.message ?? err,
      now,
    });
  }
}

function textSummary(summary, historyPath) {
  const lines = [
    `[integrity-ops] command=${summary.command} status=${summary.status} exit=${summary.exitCode}`,
    `[integrity-ops] database=${summary.database ?? 'not reported'} checkedAt=${summary.checkedAt}`,
    `[integrity-ops] ${summary.detail}`,
  ];
  if (summary.notificationPending) {
    lines.push(
      `[integrity-ops] alert delivery pending (${summary.notificationPending.intent}): ` +
        `${summary.notificationPending.error ?? 'not delivered'}`
    );
  } else if (summary.notification?.error) {
    lines.push(`[integrity-ops] notification failed: ${summary.notification.error}`);
  } else if (summary.notification?.requested) {
    lines.push(`[integrity-ops] alert ${summary.notification.action}${summary.notification.issueNumber ? ` #${summary.notification.issueNumber}` : ''}`);
  }
  if (historyPath) lines.push(`[integrity-ops] latest: ${historyPath}`);
  return lines.join('\n');
}

function defaultRunChild({ args: childArgs, timeoutMs }) {
  return spawnSync(process.execPath, childArgs, {
    cwd: serverRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

/**
 * Run one command. Exported so the CLI path — lock, child, history, `gh`
 * delivery and retry — is exercised with controlled dependencies, not only the
 * pure policy helpers.
 */
export function runOps({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  runChild = defaultRunChild,
  gh: ghCommand = gh,
  now = () => new Date(),
} = {}) {
  const args = parseOpsArgs(argv);
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.problems.length > 0) {
    stderr.write(`[integrity-ops] NOT CHECKED (exit 2) — invalid arguments:\n  ${args.problems.join('\n  ')}\n`);
    return 2;
  }

  const meta = OPS_COMMANDS[args.command];
  const historyDir = path.resolve(args.historyDir ?? defaultHistoryDir());
  const lockDir = path.resolve(args.lockDir ?? path.join(historyDir, 'locks'));
  // The lock must outlive the longest child this invocation allows; otherwise
  // a slow run could have its lock taken over while it is still writing.
  const lock = acquireRunLock(lockPathFor(lockDir, args.command), {
    staleMs: Math.max(30 * 60_000, args.timeoutMs + 5 * 60_000),
  });
  if (!lock.acquired) {
    const summary = {
      command: args.command,
      checkedAt: now().toISOString(),
      database: null,
      status: OPS_STATUS.SKIPPED_RUNNING,
      exitCode: 0,
      detail: 'another process owns this command lock; the duplicate run did nothing',
      problemCount: 0,
      counts: {},
      signature: 'skipped-running',
      notification: { requested: args.notify, action: 'none', issueNumber: null, error: null },
    };
    if (args.format === 'json') stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else stdout.write(`${textSummary(summary, null)}\n`);
    return 0;
  }

  try {
    const childArgs = [path.join(serverRoot, 'scripts', meta.script), '--format=json'];
    if (args.withProduction) childArgs.push('--with-production');
    const run = runChild({ args: childArgs, timeoutMs: args.timeoutMs });
    const timedOut = run.error?.code === 'ETIMEDOUT';
    const payload = run.status === 0 || run.status === 1 ? parseChildJson(run.stdout) : null;
    const result = classifyOpsResult({
      command: args.command,
      exitCode: run.status,
      payload,
      spawnError: run.error && !timedOut ? run.error : null,
      timedOut,
      stdout: run.stdout,
      stderr: run.stderr,
    });
    const summary = buildOpsSummary({
      command: args.command,
      checkedAt: now().toISOString(),
      database: payload?.database ?? null,
      result,
    });
    const historyPath = historyPathFor(historyDir, args.command);
    const previous = readOpsHistory(historyPath);
    summary.notification = args.notify
      ? notify(summary, previous, historyDir, { gh: ghCommand, now })
      : { requested: false, action: 'none', issueNumber: null, error: null };
    // A run without --notify must not erase an alert a previous run still owes.
    summary.notificationPending = args.notify
      ? pendingNotificationFor(summary)
      : pendingNotificationFor(previous);

    try {
      writeOpsHistory(historyPath, summary);
    } catch (err) {
      stderr.write(
        `[integrity-ops] could not write local history: ${sanitizeOpsDetail(err?.message ?? err)}\n`
      );
    }

    if (args.format === 'json') stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      stdout.write(`${formatOpsMarkdown(summary)}\n`);
      stdout.write('\n');
      stdout.write(`${textSummary(summary, historyPath)}\n`);
    }
    return OPS_EXIT[summary.status] ?? 2;
  } finally {
    lock.release();
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = runOps();
  } catch (err) {
    console.error(
      `[integrity-ops] NOT CHECKED (exit 2) — ${sanitizeOpsDetail(err?.message ?? err)}`
    );
    process.exitCode = 2;
  }
}
