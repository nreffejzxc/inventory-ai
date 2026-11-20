// Pure policy for the scheduled integrity operations runner.
//
// The three commands keep their own exit-code contract (0 clean, 1 finding,
// 2 NOT CHECKED). This module does not replace those commands: it classifies
// their results for a scheduler, suppresses duplicate runs with a lock file,
// and decides when a GitHub issue should be opened, updated or closed.
//
// Nothing here connects to MongoDB or writes inventory.

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const OPS_COMMANDS = {
  'audit:failures': {
    script: 'audit-failures.mjs',
    label: 'audit-write failures',
    issueTitle: '[integrity-ops] Audit-write failures need review',
    historyName: 'audit-failures',
  },
  'audit:price-quality': {
    script: 'audit-price-quality.mjs',
    label: 'price-data quality',
    issueTitle: '[integrity-ops] Price-data quality needs review',
    historyName: 'price-quality',
  },
  'recover:integrity': {
    script: 'recover-integrity.mjs',
    label: 'transfer/PO recovery',
    issueTitle: '[integrity-ops] Integrity recovery needs attention',
    historyName: 'recover-integrity',
  },
};

export const OPS_STATUS = {
  OK: 'OK',
  FINDINGS: 'FINDINGS',
  NOT_CHECKED: 'NOT_CHECKED',
  ERROR: 'ERROR',
  SKIPPED_RUNNING: 'SKIPPED_RUNNING',
};

export const OPS_EXIT = {
  OK: 0,
  FINDINGS: 1,
  NOT_CHECKED: 2,
  ERROR: 2,
  SKIPPED_RUNNING: 0,
};

function valueOf(flag, argv) {
  const prefix = `${flag}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) return { repeated: true, value: values[0] };
  return values.length === 1 ? { repeated: false, value: values[0] } : null;
}

/** Parse the runner's own command line. Unknown flags are refused, not ignored. */
export function parseOpsArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];
  const command = valueOf('--command', args);
  const format = valueOf('--format', args);
  const historyDir = valueOf('--history-dir', args);
  const lockDir = valueOf('--lock-dir', args);
  const timeoutMs = valueOf('--timeout-ms', args);

  for (const [flag, seen] of [
    ['--command', command],
    ['--format', format],
    ['--history-dir', historyDir],
    ['--lock-dir', lockDir],
    ['--timeout-ms', timeoutMs],
  ]) {
    if (seen?.repeated) problems.push(`${flag} was given more than once.`);
  }

  if (!command?.value) {
    problems.push(`--command is required; choose one of ${Object.keys(OPS_COMMANDS).join(', ')}.`);
  } else if (!Object.prototype.hasOwnProperty.call(OPS_COMMANDS, command.value)) {
    problems.push(`unknown command "${command.value}"; choose one of ${Object.keys(OPS_COMMANDS).join(', ')}.`);
  }

  let output = 'text';
  if (format) {
    if (!['text', 'json'].includes(format.value)) problems.push('--format must be "text" or "json".');
    else output = format.value;
  }

  let timeout = 10 * 60_000;
  if (timeoutMs) {
    const parsed = Number(timeoutMs.value);
    if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 60 * 60_000) {
      problems.push('--timeout-ms must be an integer from 10000 to 3600000.');
    } else timeout = parsed;
  }

  const withProduction = args.includes('--with-production');
  const notify = args.includes('--notify');
  if (notify && !withProduction) {
    problems.push('--notify requires --with-production; a development result must not open an operational alert.');
  }

  for (const arg of args) {
    if (
      arg.startsWith('--') &&
      !/^--(help|with-production|notify|command=|format=|history-dir=|lock-dir=|timeout-ms=)/.test(arg)
    ) {
      problems.push(`Unknown argument: ${arg}`);
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      problems.push(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help: args.includes('--help') || args.includes('-h'),
    command: command?.value ?? null,
    withProduction,
    notify,
    format: output,
    historyDir: historyDir?.value ?? null,
    lockDir: lockDir?.value ?? null,
    timeoutMs: timeout,
    problems,
  };
}

/** Keep credentials, connection strings and newlines out of a local log or issue. */
export function sanitizeOpsDetail(value, maxLength = 600) {
  let text = String(value ?? '')
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, 'mongodb://[redacted]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

/** Read a JSON object from child output that may contain log lines around it. */
export function parseChildJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function countsFor(command, payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (command === 'audit:failures') {
    return {
      total: Number(payload.total) || 0,
      byAction: Array.isArray(payload.byAction)
        ? payload.byAction.slice(0, 10).map((row) => ({
            action: String(row.action ?? 'unknown'),
            count: Number(row.count) || 0,
          }))
        : [],
    };
  }
  if (command === 'audit:price-quality') {
    return {
      problemCount: Number(payload.problemCount) || 0,
      totalActiveProducts: Number(payload.totalActiveProducts) || 0,
      missingPrice: Number(payload.missingPrice) || 0,
      zeroPrice: Number(payload.zeroPrice) || 0,
      missingCurrency: Number(payload.missingCurrency) || 0,
      invalidCurrency: Number(payload.invalidCurrency) || 0,
    };
  }
  if (command === 'recover:integrity') {
    const transfers = payload.transfers ?? {};
    const claims = payload.claims ?? {};
    const movements = payload.movements ?? {};
    return {
      transfers: {
        scanned: Number(transfers.scanned) || 0,
        completed: Number(transfers.completed) || 0,
        compensated: Number(transfers.compensated) || 0,
        flagged: Number(transfers.flagged) || 0,
        failed: Number(transfers.failed) || 0,
      },
      claims: {
        scanned: Number(claims.scanned) || 0,
        released: Number(claims.released) || 0,
        undone: Number(claims.undone) || 0,
        receipted: Number(claims.receipted) || 0,
        flagged: Number(claims.flagged) || 0,
        failed: Number(claims.failed) || 0,
      },
      movements: {
        scanned: Number(movements.scanned) || 0,
        completed: Number(movements.completed) || 0,
        flagged: Number(movements.flagged) || 0,
        blocked: Number(movements.blocked) || 0,
        failed: Number(movements.failed) || 0,
      },
      leaseHeld: payload.skipped === 'lease-held',
    };
  }
  return {};
}

function problemCountFor(command, counts) {
  if (command === 'audit:failures') return counts.total ?? 0;
  if (command === 'audit:price-quality') return counts.problemCount ?? 0;
  if (command === 'recover:integrity') {
    return (counts.transfers?.failed ?? 0) + (counts.transfers?.flagged ?? 0) +
      (counts.claims?.failed ?? 0) + (counts.claims?.flagged ?? 0) +
      (counts.movements?.failed ?? 0) + (counts.movements?.flagged ?? 0) +
      (counts.movements?.blocked ?? 0);
  }
  return 0;
}

/**
 * A stable identity for "the same problem". A finding that stays identical is
 * not re-alerted every run; a changed count, action set or category is.
 */
export function opsSignature(command, status, counts) {
  if (status === OPS_STATUS.OK) return 'ok';
  if (status === OPS_STATUS.NOT_CHECKED || status === OPS_STATUS.ERROR) return status;
  if (command === 'audit:failures') {
    return `failures:${counts.total ?? 0}:${(counts.byAction ?? []).map((row) => `${row.action}=${row.count}`).join(',')}`;
  }
  if (command === 'audit:price-quality') {
    return [
      'price',
      counts.problemCount ?? 0,
      counts.missingPrice ?? 0,
      counts.zeroPrice ?? 0,
      counts.missingCurrency ?? 0,
      counts.invalidCurrency ?? 0,
    ].join(':');
  }
  if (command === 'recover:integrity') {
    return [
      'recovery',
      counts.transfers?.failed ?? 0,
      counts.transfers?.flagged ?? 0,
      counts.claims?.failed ?? 0,
      counts.claims?.flagged ?? 0,
      counts.movements?.failed ?? 0,
      counts.movements?.flagged ?? 0,
      counts.movements?.blocked ?? 0,
    ].join(':');
  }
  return status;
}

/**
 * Classify a child result. Exit 2 is NOT CHECKED, never a finding; an unexpected
 * exit or unreadable success payload is an operational ERROR. Recovery can exit
 * 0 while leaving REQUIRES_ATTENTION rows, so its JSON counts are consulted.
 */
export function classifyOpsResult({
  command,
  exitCode,
  payload = null,
  spawnError = null,
  timedOut = false,
  stdout = '',
  stderr = '',
}) {
  if (spawnError || timedOut || exitCode == null) {
    return {
      status: OPS_STATUS.NOT_CHECKED,
      detail: sanitizeOpsDetail(
        timedOut ? 'the command timed out' : spawnError?.message || 'the command could not start'
      ),
      payload: null,
      counts: {},
    };
  }
  if (exitCode === 2) {
    const lines = String(stderr || stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean);
    return {
      status: OPS_STATUS.NOT_CHECKED,
      detail: sanitizeOpsDetail(lines.at(-1) || 'the command reported NOT CHECKED'),
      payload: null,
      counts: {},
    };
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return {
      status: OPS_STATUS.ERROR,
      detail: sanitizeOpsDetail(`the command exited with unexpected status ${exitCode}`),
      payload: null,
      counts: {},
    };
  }

  const counts = countsFor(command, payload);
  const problemCount = problemCountFor(command, counts);
  if (exitCode === 1 || problemCount > 0) {
    return {
      status: OPS_STATUS.FINDINGS,
      detail:
        problemCount > 0
          ? `${problemCount} actionable item(s) reported`
          : 'the command reported a finding but its JSON report was unreadable',
      payload,
      counts,
      problemCount,
    };
  }
  if (!payload) {
    return {
      status: OPS_STATUS.ERROR,
      detail: 'the command exited 0 but its JSON report could not be read',
      payload: null,
      counts: {},
    };
  }
  if (command === 'recover:integrity' && payload.skipped === 'lease-held') {
    return {
      status: OPS_STATUS.OK,
      detail: 'another recovery pass held the lease; this run did nothing',
      payload,
      counts,
      problemCount: 0,
    };
  }
  return { status: OPS_STATUS.OK, detail: 'no actionable finding', payload, counts, problemCount: 0 };
}

/**
 * The alert this history still owes GitHub, if any.
 *
 * A failed `gh` action is persisted as `notification.undelivered`; the next run
 * must retry it even when the finding's signature has not changed. Histories
 * written before this field existed stored `action: 'failed'`, which is treated
 * as the same pending state for backward compatibility.
 */
export function pendingNotificationFor(previous) {
  if (previous?.notificationPending) return previous.notificationPending;
  const notification = previous?.notification;
  if (notification?.undelivered !== true && notification?.action !== 'failed') return null;
  return {
    intent:
      notification.intent ??
      (previous?.status === OPS_STATUS.OK ? 'recovery' : 'alert'),
    stage: notification.stage ?? null,
    issueNumber: notification.issueNumber ?? null,
    error: notification.error ?? null,
    attemptedAt: notification.attemptedAt ?? null,
  };
}

/** Run/update the issue only when the result is new, changed, or still undelivered. */
export function shouldNotifyOps(previous, current) {
  if (current?.status === OPS_STATUS.SKIPPED_RUNNING) return { action: 'none' };
  const pending = pendingNotificationFor(previous);
  if (current?.status === OPS_STATUS.OK) {
    return previous && (previous.status !== OPS_STATUS.OK || pending)
      ? { action: 'recovery' }
      : { action: 'none' };
  }
  if (
    previous?.status === current?.status &&
    previous?.signature === current?.signature &&
    !pending
  ) {
    return { action: 'none' };
  }
  return { action: 'alert' };
}

export function buildOpsSummary({
  command,
  checkedAt = new Date().toISOString(),
  database = null,
  result,
}) {
  const status = result.status;
  return {
    command,
    checkedAt,
    database,
    status,
    exitCode: OPS_EXIT[status] ?? 2,
    detail: result.detail,
    problemCount: result.problemCount ?? 0,
    counts: result.counts ?? {},
    signature: opsSignature(command, status, result.counts ?? {}),
  };
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatOpsMarkdown(summary) {
  const meta = OPS_COMMANDS[summary.command];
  const lines = [
    `# ${meta?.label ?? 'Integrity operations'}`,
    '',
    `- **Command:** \`${summary.command}\``,
    `- **Status:** ${summary.status}`,
    `- **Checked:** ${summary.checkedAt}`,
    `- **Database:** ${summary.database ?? 'not reported'}`,
    `- **Detail:** ${summary.detail}`,
    '',
  ];
  if (summary.status === OPS_STATUS.NOT_CHECKED) {
    lines.push(
      'No conclusion was drawn. The command could not complete, which is an operational',
      'failure — not evidence of a clean inventory, audit trail or price catalogue.'
    );
  } else if (summary.status === OPS_STATUS.ERROR) {
    lines.push('No conclusion was drawn: the runner could not read the command result.');
  } else if (summary.command === 'audit:failures') {
    lines.push(`- **Gaps in window:** ${grouped(summary.counts.total ?? 0)}`);
    if ((summary.counts.byAction ?? []).length > 0) {
      lines.push('', '## By action');
      for (const row of summary.counts.byAction) lines.push(`- ${row.action} — ${row.count}`);
    }
    lines.push('', 'A gap is not a lost business write: the write committed and its audit row did not.');
  } else if (summary.command === 'audit:price-quality') {
    lines.push(
      `- **Problems:** ${grouped(summary.counts.problemCount ?? 0)} of ` +
        `${grouped(summary.counts.totalActiveProducts ?? 0)} active products`,
      `- missing price: ${summary.counts.missingPrice ?? 0}`,
      `- zero price: ${summary.counts.zeroPrice ?? 0}`,
      `- missing currency: ${summary.counts.missingCurrency ?? 0}`,
      `- invalid currency: ${summary.counts.invalidCurrency ?? 0}`,
      '',
      'Nothing was repaired. The report identifies catalogue rows for an operator to fix.'
    );
  } else if (summary.command === 'recover:integrity') {
    lines.push(
      `- transfers: scanned ${summary.counts.transfers?.scanned ?? 0}, ` +
        `flagged ${summary.counts.transfers?.flagged ?? 0}, failed ${summary.counts.transfers?.failed ?? 0}`,
      `- PO claims: scanned ${summary.counts.claims?.scanned ?? 0}, ` +
        `flagged ${summary.counts.claims?.flagged ?? 0}, failed ${summary.counts.claims?.failed ?? 0}`,
      `- movement receipts: scanned ${summary.counts.movements?.scanned ?? 0}, ` +
        `flagged ${summary.counts.movements?.flagged ?? 0}, ` +
        `blocked ${summary.counts.movements?.blocked ?? 0}, ` +
        `failed ${summary.counts.movements?.failed ?? 0}`,
      '',
      'Anything flagged REQUIRES_ATTENTION must be reviewed by hand. Recovery never guesses.'
    );
  }
  lines.push('', `Signature: \`${summary.signature}\``);
  return lines.join('\n');
}

/**
 * Stable, hidden identity for one alert. It is derived from the same signature
 * that suppresses duplicate local runs, so every scheduler host computes the
 * same marker for the same finding. The hash keeps arbitrary action names out of
 * the HTML comment (an audit action cannot terminate the comment early).
 */
export function opsAlertMarker(summary) {
  const digest = createHash('sha256')
    .update(`${summary.command}:${summary.status}:${summary.signature}`)
    .digest('hex')
    .slice(0, 32);
  return `<!-- integrity-ops-alert:${summary.command}:${digest} -->`;
}

/** A recovery is one logical event per command, not one per run. */
export function opsRecoveryMarker(command) {
  return `<!-- integrity-ops-recovery:${command} -->`;
}

export function opsRecoveryComment(command) {
  return (
    'The previously reported integrity-operations problem is no longer reported. ' +
    `No data was modified by this alert path.\n\n${opsRecoveryMarker(command)}`
  );
}

/**
 * Whether an issue view already carries this marker in its body or comments.
 * Pure so the duplicate-comment decision is testable without GitHub.
 */
export function issueHasMarker(view, marker) {
  if (!view || typeof view !== 'object') return false;
  if (String(view.body ?? '').includes(marker)) return true;
  const comments = Array.isArray(view.comments) ? view.comments : [];
  return comments.some((comment) => String(comment?.body ?? '').includes(marker));
}

export function opsIssueBody(summary) {
  return (
    `${formatOpsMarkdown(summary)}\n\n` +
    'This alert is emitted by the scheduled integrity-operations runner. ' +
    'The read-only audits never repair data; recovery performs only exact, quantity-anchored actions.\n\n' +
    opsAlertMarker(summary)
  );
}

/**
 * A local, cross-process lock. Task Scheduler's IgnoreNew covers one machine's
 * task; this covers a manual run racing the scheduled one. A lock older than
 * `staleMs` is taken over so a crashed process cannot block operations forever.
 */
export function acquireRunLock(
  lockPath,
  { token = randomUUID(), now = Date.now(), staleMs = 30 * 60_000 } = {}
) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    token,
    pid: process.pid,
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
    acquiredAt: new Date(now).toISOString(),
  });

  const tryCreate = () => {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${payload}\n`);
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      return false;
    } finally {
      if (fd != null) closeSync(fd);
    }
  };

  if (!tryCreate()) {
    const stale = (() => {
      try {
        return now - statSync(lockPath).mtimeMs > staleMs;
      } catch {
        return true;
      }
    })();
    if (!stale) {
      const holder = (() => {
        try {
          return JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          return null;
        }
      })();
      return { acquired: false, token, holder };
    }
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') return { acquired: false, token, holder: null };
    }
    if (!tryCreate()) return { acquired: false, token, holder: null };
  }

  return {
    acquired: true,
    token,
    release() {
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current?.token === token) unlinkSync(lockPath);
      } catch {
        // The lock is already gone or unreadable; nothing else owns this token.
      }
    },
  };
}

export function lockPathFor(lockDir, command) {
  return path.join(lockDir, `${OPS_COMMANDS[command].historyName}.lock`);
}

export function historyPathFor(historyDir, command) {
  return path.join(historyDir, `${OPS_COMMANDS[command].historyName}.json`);
}

export function readOpsHistory(historyPath) {
  if (!existsSync(historyPath)) return null;
  try {
    return JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch {
    return null;
  }
}

function tmpSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function writeOpsHistory(historyPath, summary) {
  mkdirSync(path.dirname(historyPath), { recursive: true });
  const tmp = `${historyPath}.${tmpSuffix()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`);
  renameSync(tmp, historyPath);
  appendFileSync(
    path.join(path.dirname(historyPath), 'history.jsonl'),
    `${JSON.stringify({
      command: summary.command,
      checkedAt: summary.checkedAt,
      status: summary.status,
      signature: summary.signature,
      problemCount: summary.problemCount,
      database: summary.database,
    })}\n`
  );
}
