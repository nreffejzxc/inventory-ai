// `npm run audit:integrity:monitor -- --with-production [--notify]`
//
// The scheduled, READ-ONLY inventory-integrity monitor. It runs the existing
// audit, compares its findings with an explicitly accepted baseline, records a
// local history, and (with --notify) opens or updates one GitHub issue when a NEW
// candidate appears. It never deletes or repairs a row and never connects to
// MongoDB itself; the audit child process is the only database reader.
//
// WHY A BASELINE. The production audit has 2,517 known findings in two synthetic
// seed tenants. Re-alerting on all of them every day would train a reader to
// ignore the alert. The baseline names those rows; anything not in it is new.
// Accepting a baseline is a separate, explicit action:
//   node scripts/monitor-inventory-integrity.mjs --with-production --accept-baseline
// It writes only the baseline file. It does not touch inventory.
//
// EXIT CODES
//   0  the audit ran and there are no findings outside the accepted baseline
//   1  the audit ran and at least one NEW finding is outside the baseline
//   2  NOT CHECKED — the audit could not run, or its JSON could not be read
//
// The history is local to the machine that runs the monitor:
//   %LOCALAPPDATA%\InventoryAI\integrity-audit\ on Windows, or
//   ~/.local/state/inventoryai/integrity-audit/ elsewhere.
// `latest.json`, `latest.md` and `history.jsonl` are written there; the repository
// keeps only the accepted baseline and its README.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MONITOR_ISSUE_TITLE,
  baselineProblems,
  buildMonitorSummary,
  compareWithBaseline,
  createBaseline,
  formatMonitorMarkdown,
  parseMonitorArgs,
  shouldNotify,
} from './lib/inventory-integrity-monitor.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(serverRoot, '..');
const auditScript = path.join(serverRoot, 'scripts', 'audit-inventory-integrity.mjs');
const defaultBaseline = path.join(repoRoot, 'docs', 'evidence', 'inventory-integrity-monitor', 'baseline.json');
const GH_FALLBACK = process.env.GH_PATH || 'C:\\Program Files\\GitHub CLI\\gh.exe';
let activeHistoryDir = null;

const USAGE = `Run the read-only inventory-integrity audit and compare it with an accepted baseline.

Usage:
  npm run audit:integrity:monitor -- --with-production [options]

Options:
  --with-production       read production (required for this monitor)
  --notify                open/update one GitHub issue for new findings
  --accept-baseline       accept every current finding as the baseline and write it
  --baseline=<path>       baseline file (default docs/evidence/inventory-integrity-monitor/baseline.json)
  --history-dir=<path>    local history directory (default under LOCALAPPDATA or ~/.local/state)
  --format=<text|json>    stdout shape (default text)
  --help                  this text

The monitor is READ-ONLY: it never writes inventory, ledger, PO or index data. It
does write its own local history and, with --accept-baseline, the baseline file.

EXIT CODES
  0  no finding outside the accepted baseline
  1  at least one new finding outside the baseline
  2  NOT CHECKED (audit failed or output was unreadable)
`;

class NotChecked extends Error {}

function defaultHistoryDir() {
  const base = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'state');
  return path.join(base, 'InventoryAI', 'integrity-audit');
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new NotChecked(`could not read ${file}: ${err.message}`);
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function runAudit() {
  const run = spawnSync(process.execPath, [auditScript, '--with-production', '--format=json'], {
    cwd: serverRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = run.status ?? 2;
  if (run.error) {
    throw new NotChecked(`could not start the audit: ${run.error.message}`);
  }
  if (status === 2) {
    const detail = String(run.stderr || run.stdout || 'the audit reported NOT CHECKED').trim();
    throw new NotChecked(detail.split('\n').slice(-3).join(' | '));
  }
  if (status !== 0 && status !== 1) {
    throw new NotChecked(`the audit exited with an unexpected status ${status}`);
  }
  try {
    return { audit: JSON.parse(run.stdout), auditExitCode: status };
  } catch (err) {
    throw new NotChecked(`the audit output was not JSON: ${err.message}`);
  }
}

function gh(args) {
  let run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Task Scheduler can have a narrower PATH than an interactive shell. Retry the
  // standard GitHub CLI location rather than silently losing the alert path.
  if (run.error?.code === 'ENOENT' && existsSync(GH_FALLBACK)) {
    run = spawnSync(GH_FALLBACK, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (run.error) throw new Error(`gh could not start: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(String(run.stderr || run.stdout || `gh exited ${run.status}`).trim());
  }
  return run.stdout;
}

function openIssue() {
  const out = gh(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url']);
  const issues = JSON.parse(out);
  return issues.find((issue) => String(issue.title || '').startsWith('[inventory-integrity]')) ?? null;
}

function issueBody(summary) {
  return (
    `${formatMonitorMarkdown(summary, { maxNewRows: 25 })}\n\n` +
    'The audit is read-only. A finding is a candidate for review, not proof of intent.\n' +
    'The accepted baseline and the full local history are on the operator machine; this issue is the alert path.'
  );
}

function notify(summary, previous) {
  const decision = shouldNotify(previous, summary);
  if (decision.action === 'none') return { requested: true, action: 'none', issueNumber: null, error: null };

  try {
    const existing = openIssue();
    if (decision.action === 'alert') {
      const body = issueBody(summary);
      const bodyFile = path.join(historyDirForNotify(), 'issue-body.md');
      mkdirSync(path.dirname(bodyFile), { recursive: true });
      writeFileSync(bodyFile, `${body}\n`);
      if (existing) {
        gh(['issue', 'comment', String(existing.number), '--body-file', bodyFile]);
        return { requested: true, action: 'updated', issueNumber: existing.number, error: null };
      }
      const out = gh(['issue', 'create', '--title', MONITOR_ISSUE_TITLE, '--body-file', bodyFile]);
      const match = out.match(/\/issues\/(\d+)/);
      return { requested: true, action: 'created', issueNumber: match ? Number(match[1]) : null, error: null };
    }

    if (existing) {
      gh([
        'issue',
        'comment',
        String(existing.number),
        '--body',
        'The previously new inventory-integrity findings are no longer reported. The accepted baseline remains; no inventory was modified.',
      ]);
      gh(['issue', 'close', String(existing.number)]);
      return { requested: true, action: 'recovered', issueNumber: existing.number, error: null };
    }
    return { requested: true, action: 'none', issueNumber: null, error: null };
  } catch (err) {
    return { requested: true, action: 'failed', issueNumber: null, error: String(err.message || err) };
  }
}

function historyDirForNotify() {
  return activeHistoryDir ?? defaultHistoryDir();
}

function record(historyDir, summary) {
  mkdirSync(historyDir, { recursive: true });
  const latestJson = path.join(historyDir, 'latest.json');
  const latestMarkdown = path.join(historyDir, 'latest.md');
  const history = path.join(historyDir, 'history.jsonl');
  writeJsonAtomic(latestJson, summary);
  writeFileSync(latestMarkdown, `${formatMonitorMarkdown(summary)}\n`);
  appendFileSync(
    history,
    `${JSON.stringify({
      checkedAt: summary.checkedAt,
      status: summary.status,
      database: summary.database,
      auditExitCode: summary.audit.exitCode,
      scannedStockIns: summary.audit.scannedStockIns,
      totals: summary.audit.totals,
      baselineKnown: summary.baseline.knownCount,
      newCount: summary.comparison.newCount,
      newFindingIds: summary.comparison.newFindingIds,
      resolvedCount: summary.comparison.resolvedCount,
      notification: summary.notification,
    })}\n`
  );
  return { latestJson, latestMarkdown, history };
}

function main() {
  const args = parseMonitorArgs();
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.problems.length > 0) {
    throw new NotChecked(`invalid arguments:\n  ${args.problems.join('\n  ')}`);
  }

  const baselinePath = path.resolve(repoRoot, args.baselinePath ?? defaultBaseline);
  const historyDir = path.resolve(args.historyDir ?? defaultHistoryDir());
  activeHistoryDir = historyDir;
  const checkedAt = new Date().toISOString();
  const { audit, auditExitCode } = runAudit();

  if (args.acceptBaseline) {
    const baseline = createBaseline(audit, {
      acceptedAt: checkedAt,
      note:
        'Accepted after the read-only triage of 2026-11-15. These are known synthetic seed findings in two demo/perf tenants; no inventory was changed. New findings are anything not in findingIds.',
    });
    writeJsonAtomic(baselinePath, baseline);
    console.log(`[integrity-monitor] baseline accepted: ${baseline.findingIds.length} known finding(s) -> ${baselinePath}`);
    console.log('[integrity-monitor] READ-ONLY: no inventory, ledger, PO or index was modified.');
    return 0;
  }

  const baseline = readJsonIfExists(baselinePath);
  if (baseline) {
    const problems = baselineProblems(baseline);
    if (problems.length) throw new NotChecked(`baseline is unusable: ${problems.join('; ')}`);
  }

  const comparison = compareWithBaseline(audit, baseline);
  const summary = buildMonitorSummary({
    checkedAt,
    audit,
    baseline,
    comparison,
    auditExitCode,
  });

  const previous = readJsonIfExists(path.join(historyDir, 'latest.json'));
  summary.notification = args.notify
    ? notify(summary, previous)
    : { requested: false, action: 'none', issueNumber: null, error: null };

  const paths = record(historyDir, summary);
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(formatMonitorMarkdown(summary));
    console.log(`\n[integrity-monitor] latest: ${paths.latestJson}`);
    console.log(`[integrity-monitor] history: ${paths.history}`);
    if (summary.notification.error) {
      console.log(`[integrity-monitor] notification failed: ${summary.notification.error}`);
    }
  }

  return summary.comparison.newCount > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof NotChecked) {
    const message = err.message;
    console.error(`[integrity-monitor] NOT CHECKED (exit 2) — ${message}`);
    // A NOT CHECKED result is itself worth an alert when the monitor is scheduled.
    const args = parseMonitorArgs();
    if (args.notify && args.withProduction && !args.problems.length) {
      const historyDir = activeHistoryDir ?? defaultHistoryDir();
      const summary = buildMonitorSummary({
        checkedAt: new Date().toISOString(),
        audit: { database: 'inventoryai_prod_db' },
        baseline: null,
        comparison: { knownCount: 0, currentCount: 0, newCount: 0, resolvedCount: 0, newKeys: [], resolvedKeys: [], newFindings: [] },
        auditExitCode: 2,
        error: message,
      });
      let previous = null;
      try {
        previous = readJsonIfExists(path.join(historyDir, 'latest.json'));
      } catch (readError) {
        console.error(`[integrity-monitor] could not read the previous result: ${readError?.message ?? readError}`);
      }
      summary.notification = notify(summary, previous);
      try {
        record(historyDir, summary);
      } catch (recordError) {
        console.error(`[integrity-monitor] could not record the failed run: ${recordError?.message ?? recordError}`);
      }
      if (summary.notification.error) {
        console.error(`[integrity-monitor] notification failed: ${summary.notification.error}`);
      }
    }
  } else {
    console.error(`[integrity-monitor] NOT CHECKED (exit 2) — ${err?.message ?? err}`);
  }
  process.exitCode = 2;
}